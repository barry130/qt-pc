import { useCallback, useEffect, useState } from "react";
import { Play } from "lucide-react";
import type { Track } from "@/types";
import * as sourceApi from "@/source-scripts";
import { useMusicSourceStore } from "@/stores/musicSource";
import { usePlayerStore } from "@/stores/player";
import {
  useLatestUsesOffset,
  useSourceLabel,
  useSourceRegistryStore,
} from "@/stores/sourceRegistry";
import { qtresCoverUrl } from "@/lib/lrc";
import { usePagedList, type PageResult } from "@/hooks/usePagedList";
import { TrackList } from "./TrackList";
import { BatchBar } from "./BatchBar";
import { ErrorRetry, TrackRowsSkeleton } from "./Skeletons";
import { IconButton } from "@/components/common/IconButton";

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
 *    （hasMore = false，列表底部不再挂任何提示）。它们不支持翻页，就不该
 *    无限上拉 —— 继续传 offset 只会反复拿回同一批第一页数据，既浪费请求
 *    又让用户以为列表卡住了。这类平台保持“进页即第一页”的原行为；
 *    底部那句「当前音源的新歌接口不支持翻页」是给开发看的实现细节，对用户
 *    没有可用信息（用户 m02747 明确去掉），因此整条页脚只在**真会翻页**的源上渲染；
 * 4. 能力自述异步到达（注册表是引擎加载后才有的），所以 `canPage` 进了
 *    resetKey：注册表到位后若结论翻转，整页重拉，不会停在旧的翻页口径上。
 *
 * ---------------------------------------------------------------------------
 * 页头：与歌单 / 榜单详情页同一套 hero（用户 m02747）
 * ---------------------------------------------------------------------------
 * 原页头是一行「标题 + 一行小字」，右侧直接摆按钮，和歌单详情页差一截。
 * 现改为与 `PlaylistDetailPage` 同构的 hero：模糊封面铺底 + 封面方图 + 小标签
 * + 大标题 + 共 N 首 + 大号「播放全部」，批量条贴在右端、与「播放全部」同一行
 * 底线对齐。封面没有页面自己的来源（本页是「一个源的新歌流」，不是某个实体），
 * 就沿用列表里**第一张有图的曲目封面**当门面 —— 与专辑页同款回退：
 * 一张图都取不到时落回首字占位。
 *
 * 注意 hero 外层**不能**加 `overflow-hidden`：批量条的歌单面板是 absolute
 * 展开的，一裁就只剩一条缝（`PlaylistDetailPage` 已踩过同一个坑，裁切只加在
 * 铺底图那一层上）。
 *
 * **页内没有返回键**：每日新歌是侧栏一级页面（与歌单广场、首页同级），不是
 * 「被推进来的」详情页，标题栏里已经有全局返回。
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
  /** hero 小标签：本页是「哪个源的新歌流」，标出音源名（与详情页 hero 的层级一致） */
  const sourceLabel = useSourceLabel(activeSourceId);

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

  // 批量管理的已勾选曲目 id 集合（见 BatchBar）
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 批量操作的失败提示：与整页加载失败分开，别把已加载的列表顶掉 */
  const [actionError, setActionError] = useState<string | null>(null);

  // hero 的门面封面：本页不是某个实体（没有歌单封面 / 榜单配图可拿），
  // 沿用列表里**第一张有图的曲目封面**，与专辑页同款回退 —— 一张都取不到
  // （还没加载完 / 当前源的新歌不带图）就落回首字占位。
  const cover = songs.find((t) => t.picUrl)?.picUrl;
  const coverUrl = cover ? qtresCoverUrl(cover) : null;

  const toggleSelect = useCallback((trackId: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });
  }, []);

  // 换源 / 重载后列表整体作废，勾选集里若还留着这些 id，「已选 N 首」就虚高；
  // 往下翻页时列表是**追加**的，已勾选的不会消失，所以这里只做收窄、不清空。
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const ids = new Set(songs.map((t) => t.id));
      const next = new Set([...prev].filter((x) => ids.has(x)));
      return next.size === prev.size ? prev : next;
    });
  }, [songs]);

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* 页头 hero：与歌单 / 榜单详情页同一套（模糊封面铺底 + 封面方图 + 小标签
          + 大标题 + 共 N 首 + 大号「播放全部」+ 右端批量条），详见文件头。
          **不能加 overflow-hidden**：批量条的歌单面板是 absolute 展开的，
          裁切只加在铺底图那一层里。 */}
      <header className="relative shrink-0 border-b border-border">
        {coverUrl ? (
          <div className="absolute inset-0 overflow-hidden">
            <img
              src={coverUrl}
              alt=""
              aria-hidden
              draggable={false}
              className="absolute inset-0 h-full w-full scale-125 select-none object-cover opacity-45 blur-3xl saturate-150"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-background/10 to-[color:var(--page-fade)]" />
          </div>
        ) : null}

        {/* 页内不摆返回键：每日新歌是侧栏一级页面（同级：歌单广场 / 首页），
            不是被推进来的详情页；标题栏里已经有全局返回。所以这里省掉详情页
            那条 `BackButton` 行，hero 直接从封面 + 信息开始。 */}
        <div className="relative flex gap-5 px-6 pb-6 pt-6">
          <div className="h-36 w-36 shrink-0 overflow-hidden rounded-2xl bg-secondary shadow-xl ring-1 ring-border">
            {coverUrl ? (
              <img
                src={coverUrl}
                alt=""
                className="h-full w-full object-cover"
                loading="lazy"
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-4xl font-bold text-muted-foreground/50">
                新
              </span>
            )}
          </div>

          <div className="flex min-w-0 flex-1 flex-col justify-end pb-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
              {sourceLabel}
            </p>
            <h1 className="mt-1 truncate text-2xl font-bold tracking-tight">每日新歌</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {loading ? "加载中…" : `共 ${songs.length} 首`}
            </p>
            <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">
              跟随当前音源，切换音源会自动重取
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <IconButton
                label="播放全部"
                variant="primary"
                size="lg"
                disabled={songs.length === 0}
                className="h-9 w-9 rounded-lg shadow-lg shadow-primary/25"
                onClick={() => void playQueue(songs, 0)}
              >
                <Play className="h-4 w-4 fill-current" />
              </IconButton>
            </div>
          </div>

          {/* 批量条摆在页头右侧，与左边那颗「播放全部」同一行（用户口径：批量
              操作属于页头，不该在列表上方再占一行；与歌单 / 榜单详情页同位置）。
              每日新歌是分页流，全选 / 批量只作用于**当前已加载**的 songs ——
              继续下拉会追加新页，已勾选的保持不动（见上面收窄勾选的副作用）。
              收藏 / 取消收藏都在条子的歌单面板里选（与单曲红心同逻辑），
              这里没有宿主歌单，所以不传 hostPlaylistId。
              `items-end` + `pb-1` 与信息列底线对齐（同详情页）。 */}
          {!loading && !error && songs.length > 0 ? (
            <div className="relative flex shrink-0 items-end pb-1">
              <BatchBar
                embedded
                tracks={songs}
                selected={selected}
                onSelectedChange={setSelected}
                onError={setActionError}
              />
            </div>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {actionError && (
          <div className="px-6 pt-4 text-center text-sm text-destructive">{actionError}</div>
        )}
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
            <TrackList
              tracks={songs}
              showIndex
              showCollect
              showDownload
              selection={{ ids: selected, onToggle: toggleSelect }}
            />
            {/* 哨兵：进入视口就拉下一页。不支持翻页的源没有下一页，不挂哨兵 */}
            {hasMore ? <div ref={sentinelRef} className="h-1" /> : null}
            {/* 页脚只在**真会翻页**的源上出现：不支持翻页的源整页就是全部内容，
                「不支持翻页」是实现细节，对用户没有可用信息（用户 m02747）。 */}
            {canPage ? (
              <div className="py-4 text-center text-xs text-muted-foreground">
                {loadingMore ? "加载中…" : hasMore ? "继续下拉加载更多" : "已经到底了"}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
