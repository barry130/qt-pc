import { useCallback, useEffect } from "react";
import { Play } from "lucide-react";
import type { Track } from "@/types";
import * as sourceApi from "@/source-scripts";
import { useMusicSourceStore } from "@/stores/musicSource";
import { usePlayerStore } from "@/stores/player";
import { useLatestUsesOffset, useSourceRegistryStore } from "@/stores/sourceRegistry";
import { usePagedList, type PageResult } from "@/hooks/usePagedList";
import { TrackList } from "./TrackList";
import { ErrorRetry, TrackRowsSkeleton } from "./Skeletons";

/**
 * 每页条数：沿用原实现的 50。
 *
 * 这是个安全值——wyy 的 latest 实测 limit=200 会返回 0 条（被上游当参数错误），
 * 50 在 wyy/kg/bili 都能给满页，「本页条数 === 请求条数 ⇒ 可能还有下一页」
 * 的推断才成立；且 offset 与它同口径递增，翻页才不会漏条或重条。
 */
const LATEST_PAGE_SIZE = 50;

/**
 * 每日新歌（路由 /daily）。
 *
 * 只展示当前音源的最新歌曲，列表形式（带序号 / 加歌单 / 下载），
 * 滚到底自动续页（usePagedList 的 scroll 模式）。
 *
 * ---------------------------------------------------------------------------
 * 原 bug：offset 恒为 0，「翻页」根本不存在
 * ---------------------------------------------------------------------------
 * 修改前本页是一次性取数：
 *
 *   const s = await sourceApi
 *     .getLatestSongs(activeSourceId, 50, 0)   // ← offset 写死 0
 *     .catch(() => [] as Track[]);
 *
 * 三处问题叠在一起：
 * 1. offset 写死 0，且 **没有任何翻页入口**（文件头注释声称「『换一批』走
 *    getLatestSongs 的 offset 翻页」，但页面上根本没有「换一批」按钮），
 *    页面永远只有第一页；
 * 2. offset 与页码的关系也没定义过 —— 一旦照注释去补“翻页”，最容易写出的
 *    就是把页码直接当 offset（`getLatestSongs(id, 50, page)`），第 2 页只
 *    往后挪 1 条，前 49 条与第 1 页完全重复；
 * 3. 更隐蔽的是：**不是所有平台的 latest 都有分页语义**。包侧按平台自述
 *    `latestUsesOffset` 决定 offset 透不传（qt-sources registry.ts 的
 *    sourceCapsOf / actions/aggregate.ts 的 allLatestBatches 里只有
 *    `module.latestUsesOffset === true` 才透传 offset；wyy/kg/bili/migu 为 true，
 *    qq/kw 为 false，后者的 latest 恒取第一页）。给一个
 *    `latestUsesOffset = false` 的平台传递增的 offset，它每次都回同一批数据
 *    —— 翻页看起来“一直在加载”，列表却一条都不增长。
 *
 * ---------------------------------------------------------------------------
 * 怎么修的
 * ---------------------------------------------------------------------------
 * 1. 改用 usePagedList（与 AlbumPage 同款 scroll 模式）：滚到底追加下一页，
 *    按 `platform:id` 去重（上游偶有重复项，去重后列表才不会越翻越重）；
 * 2. offset 按**记录偏移**算，`(page - 1) * PAGE_SIZE`，与包侧 wyy
 *    （`limit` + `offset` 查询参数）、bili（`pn = floor(offset / size) + 1`）
 *    的口径一致 —— 页码从 1 起、offset 从 0 起，不再混用；
 * 3. `latestUsesOffset = false` 的平台：**第 2 页起直接返回空数组**
 *    （hasMore = false，列表底部提示“不支持翻页”）。它们不支持翻页，就不该
 *    无限上拉 —— 继续传 offset 只会反复拿回同一批第一页数据，既浪费请求
 *    又让用户以为列表卡住了。这类平台保持“进页即第一页”的原行为；
 * 4. 能力自述异步到达（注册表是引擎加载后才有的），所以 `canPage` 进了
 *    resetKey：注册表到位后若结论翻转，整页重拉，不会停在旧的翻页口径上。
 *
 * 注意：包侧 kg 的 latest 把 offset 当 **页号** 用（`page = offset + 1`），
 * 与 wyy/bili 的“记录偏移”口径不一致；kg 因此在本页会“跳页”（第 2 页请求
 * 到 kg 的第 51 页，基本是空页 → 列表停在第一页）。这是包侧口径问题
 * （已另报，不在本页硬编码源 id 规避——本仓库的约定就是宿主不认识源 id）。
 */
export function DailyPage(): React.JSX.Element {
  const activeSourceId = useMusicSourceStore((s) => s.activeSourceId);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const ensureRegistry = useSourceRegistryStore((s) => s.ensure);
  /** 该源 latest() 的 offset 有没有分页语义（包侧自述，宿主不硬编码源 id） */
  const canPage = useLatestUsesOffset(activeSourceId);
  /** 注册表世代：装/卸/换数据包后 +1——keep-alive 常驻页靠它清掉旧包残留的列表 */
  const metaGeneration = useSourceRegistryStore((s) => s.generation);

  // 能力自述来自注册表快照，注册表是异步的：没拿到之前 canPage 是兜底值，
  // 拿不到就等于“永远不支持翻页”。AppShell 挂载时已 ensure 过，这里补一次
  // 兜住 keep-alive 页面先于注册表到位的情况（幂等，成功过就不再请求）。
  useEffect(() => {
    void ensureRegistry();
  }, [ensureRegistry]);

  const fetchPage = useCallback(
    async (page: number): Promise<PageResult<Track>> => {
      // local 源没有在线新歌流：直接给空页，别把「local 源不支持该动作」
      // 当成错误弹到页面上（侧栏 /daily 入口对 local 未做门控）
      if (activeSourceId === "local") return { list: [], hasMore: false };
      // 不支持翻页的平台：第一页取完就是全部，显式 hasMore=false，
      // 第 2 页起不再请求。传递增 offset 拿不到新数据，只会白打请求。
      if (!canPage && page > 1) return { list: [], hasMore: false };
      const offset = (page - 1) * LATEST_PAGE_SIZE;
      const list = await sourceApi.getLatestSongs(activeSourceId, LATEST_PAGE_SIZE, offset);
      const items = Array.isArray(list) ? list : [];
      // 显式回 hasMore，而不走「满页 = 还有下一页」的数组推断：不支持翻页的
      // 平台第一页往往正好给满 50 条，按满页推断会多挂一次哨兵、多打一次空页。
      return { list: items, hasMore: canPage && items.length >= LATEST_PAGE_SIZE };
    },
    [activeSourceId, canPage],
  );

  const {
    items: songs,
    loading,
    loadingMore,
    error,
    hasMore,
    sentinelRef,
    reload,
  } = usePagedList<Track>({
    fetchPage,
    keyOf: (t) => `${t.platform}:${t.id}`,
    // canPage/metaGeneration 也进 resetKey：注册表异步到位后翻页口径可能翻转、
    // 数据包装卸后旧列表必须作废，都要整页重拉——否则第一页按“不支持翻页”取、
    // 后续页却按 offset 翻（或反之），条数对不上；卸载包后旧数据一直挂在页上。
    resetKey: `${activeSourceId}:${canPage}:${metaGeneration}`,
    pageSize: LATEST_PAGE_SIZE,
    mode: "scroll",
  });

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-baseline justify-between border-b border-border px-4 py-3">
        <div>
          <h1 className="text-base font-medium">每日新歌</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            共 {songs.length} 首 · 跟随当前音源，切换音源会自动重取
          </p>
        </div>
        {songs.length > 0 && (
          <button
            type="button"
            onClick={() => void playQueue(songs, 0)}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            <Play className="h-3.5 w-3.5 fill-current" />
            播放全部
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <ErrorRetry message={`加载失败：${error}`} onRetry={reload} />
        ) : loading ? (
          <TrackRowsSkeleton rows={8} />
        ) : songs.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            暂无新歌
          </div>
        ) : (
          <>
            <TrackList tracks={songs} showIndex showAddToPlaylist showDownload />
            {/* 哨兵：进入视口就拉下一页。不支持翻页的源没有下一页，不挂哨兵 */}
            {hasMore ? <div ref={sentinelRef} className="h-1" /> : null}
            <div className="py-4 text-center text-xs text-muted-foreground">
              {loadingMore
                ? "加载中…"
                : hasMore
                  ? "继续下拉加载更多"
                  : canPage
                    ? "已经到底了"
                    : "当前音源的新歌接口不支持翻页"}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
