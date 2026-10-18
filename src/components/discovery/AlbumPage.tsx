import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { Play, Search, X } from "lucide-react";
import type { SourceId, Track } from "@/types";
import * as sourceApi from "@/source-scripts";
import { usePlayerStore } from "@/stores/player";
import { useSearchPageMax } from "@/stores/sourceRegistry";
import { usePagedList, type PageResult } from "@/hooks/usePagedList";
import { qtresCoverUrl } from "@/lib/lrc";
import { filterTracks, retainTrackSelection, trackSelectionKey } from "@/lib/track-selection";
import { TrackList } from "./TrackList";
import { BatchBar } from "./BatchBar";
import { ErrorRetry, TrackRowsSkeleton } from "./Skeletons";
import { BackButton } from "@/components/layout/BackButton";
import { IconButton } from "@/components/common/IconButton";

/**
 * 专辑页（路由 /album/$platform/$id）。
 *
 * 与歌手页同理：音源没有「按专辑 id 取歌曲」的免费接口，改用**专辑名搜索**，
 * 再把结果里 album 字段同名的挑出来。若一条都匹配不上（各源专辑名写法有差异），
 * 就退回展示搜索结果，不至于整页空白。
 *
 * **必须翻页**：接口一次只给一页，早先写死 page=1 + size=50，专辑永远只有 50 首。
 * 每页条数走数据包声明的 `searchPageMax`（useSearchPageMax；上游上限各不相同：
 * qq 要 100 会返回 0 条、酷狗恒给 30），传超限值会让「满页 = 还有下一页」的
 * 推断在第 1 页就误判到底。宿主不再内置这张表。
 *
 * 页头右侧挂 `BatchBar`（用户 m06865，与歌手页 / 歌单详情 / 每日新歌同位置）：
 * 全选 + 批量下载 + 批量收藏，曲目行带勾选。专辑不是可收藏实体，所以
 * 没有歌单级红心，收藏 / 下载只作用于曲目。专辑页是**滚动续页**，
 * 搜索放在批量条上方；播放 / 全选 / 批量只作用于当前已加载的可见歌曲，
 * 搜索隐藏的勾选会丢弃，往下翻页是追加、新曲目不会自动勾选。
 *
 * 注意 hero 外层**不能**加 `overflow-hidden`：批量条的歌单面板是 absolute
 * 展开的，一裁就只剩一条缝（歌手页 / 详情页已踩过同一个坑），裁切只加在
 * 铺底图那一层里。
 */
export function AlbumPage(): React.JSX.Element {
  const { platform, id } = useParams({ strict: false }) as {
    platform: SourceId;
    id: string;
  };
  const name = safeDecode(id);
  const pageSize = useSearchPageMax(platform);
  return (
    <AlbumPageContent
      key={JSON.stringify([platform, id, pageSize])}
      platform={platform}
      id={id}
      name={name}
      pageSize={pageSize}
    />
  );
}

function AlbumPageContent({
  platform,
  id,
  name,
  pageSize,
}: {
  platform: SourceId;
  id: string;
  name: string;
  pageSize: number;
}): React.JSX.Element {
  const playQueue = usePlayerStore((s) => s.playQueue);

  // 是否按专辑名过滤在**第一页**定一次，后续页沿用同一判断：
  // 否则会出现「第 1 页全是搜索结果、第 2 页只剩匹配项」的前后不一致。
  const useFilterRef = useRef<boolean | null>(null);

  // 上游偶尔忽略 page 参数；记录原始搜索页的 key，整页重复时立即收尾。
  const seenRef = useRef<Set<string>>(new Set());

  /** 命中专辑 id 后拿到的全量曲目；null = 还没确认，走名字搜索那条老路 */
  const directRef = useRef<Track[] | null>(null);
  /** 按 id 取到的专辑名与封面（页头展示，避免只显示一串 mid） */
  const [albumMeta, setAlbumMeta] = useState<{ name: string; picUrl: string; artist: string } | null>(
    null,
  );

  const fetchPage = useCallback(
    async (page: number): Promise<PageResult<Track>> => {
      // 路由第二段可能是**专辑 id**（搜索结果给的 albumMid / albumId），也可能是
      // 用户从曲目行点进来的**专辑名**（路由只有一段、没有区分标记）。
      // 先按 id 问一次真接口：成功就直接用上游的分页，不再靠名字搜索回来过滤 ——
      // 名字搜索会漏掉别的歌手同专辑名、也会因各源专辑名写法差异整页丢掉。
      // 失败或返回空（说明这段不是 id）时，静默退回原来的名字搜索。
      if (page <= 1) {
        directRef.current = null;
        seenRef.current = new Set();
        if (looksLikeAlbumId(name, platform)) {
          try {
            const detail = await sourceApi.getAlbumDetail(platform, id);
            const tracks = Array.isArray(detail.tracks) ? detail.tracks : [];
            if (tracks.length > 0) {
              directRef.current = tracks;
              setAlbumMeta({ name: detail.name, picUrl: detail.picUrl, artist: "" });
            }
          } catch {
            // 不是 id，或上游没这个专辑 —— 走下面的名字搜索兜底
          }
        }
      }
      // 专辑详情是一次取全量：本地切页，不再打源站（也不存在「满页 = 还有下一页」
      // 那套推断，到底就是到底）。
      if (directRef.current !== null) {
        const all = directRef.current;
        const start = (page - 1) * pageSize;
        return { list: all.slice(start, start + pageSize), hasMore: start + pageSize < all.length };
      }
      const list = await sourceApi.searchMusic(name, platform, page, pageSize);
      const arr = Array.isArray(list) ? list : [];
      if (page <= 1) {
        useFilterRef.current = arr.some((t) => sameAlbum(t.album, name));
      }
      const fresh = arr.filter((t) => !seenRef.current.has(trackSelectionKey(t)));
      for (const track of arr) seenRef.current.add(trackSelectionKey(track));
      return {
        list:
          useFilterRef.current === true
            ? arr.filter((t) => sameAlbum(t.album, name))
            : arr,
        // 专辑过滤可能把一页裁成少量歌曲，续页判断必须看上游原始页；
        // 整页重复则视为分页失效，避免哨兵无限请求。
        hasMore: arr.length >= pageSize && fresh.length > 0,
      };
    },
    [id, name, platform, pageSize],
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
    // pageSize 也进 resetKey：注册表异步到达，首帧可能是兜底值 50，
    // 包声明的真实上限到位后必须整页重拉（否则首页条数与后续页不一致，
    // 且 useFilterRef 的「第一页定一次」判断会基于错误的分页粒度）。
    resetKey: `${platform}:${name}:${pageSize}`,
    pageSize,
  });

  // 批量管理的已勾选曲目 id 集合（见 BatchBar）
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const visibleSongs = useMemo(() => filterTracks(songs, query), [songs, query]);
  const visibleSelected = useMemo(
    () => retainTrackSelection(visibleSongs, selected),
    [visibleSongs, selected],
  );
  const changeQuery = (value: string): void => {
    setQuery(value);
    // 隐藏的歌曲退出批量范围；清空搜索也不会恢复曾隐藏的勾选。
    setSelected((prev) => retainTrackSelection(filterTracks(songs, value), prev));
  };
  /** 批量操作的失败提示：与整页加载失败分开，别把已加载的列表顶掉 */
  const [actionError, setActionError] = useState<string | null>(null);

  const toggleSelect = useCallback((trackId: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });
  }, []);

  // 重载 / 筛选后只保留可见选择；追加页不会自动勾上新来的歌曲。
  useEffect(() => {
    setSelected((prev) => retainTrackSelection(visibleSongs, prev));
  }, [visibleSongs]);

  const cover = albumMeta?.picUrl ? albumMeta.picUrl : songs.find((t) => t.picUrl)?.picUrl;
  const coverUrl = cover ? qtresCoverUrl(cover) : null;
  /** 页头标题：命中专辑 id 时用上游真名，否则就是路由里那段（可能是专辑名） */
  const title = albumMeta?.name?.trim() ? albumMeta.name : name;

  return (
    <div className="flex h-full min-w-0 flex-col">
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

        <div className="relative flex items-center px-6 pt-5">
          <BackButton />
        </div>

        <div className="relative flex gap-5 px-6 pb-6 pt-4">
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
                {title.slice(0, 1)}
              </span>
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col justify-end pb-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
              专辑
            </p>
            <h1 className="mt-1 truncate text-2xl font-bold tracking-tight">{title}</h1>
            <p role="status" className="mt-1 text-xs text-muted-foreground">
              {loading
                ? "加载中…"
                : query.trim()
                  ? `显示 ${visibleSongs.length} / ${songs.length} 首`
                  : `${songs.length} 首歌曲${hasMore ? "（继续下拉加载更多）" : ""}`}
            </p>
            {songs.length > 0 && (
              <div className="mt-3">
                <IconButton
                  label="播放全部"
                  variant="primary"
                  size="lg"
                  disabled={loading || visibleSongs.length === 0}
                  className="h-9 w-9 rounded-lg shadow-lg shadow-primary/25"
                  onClick={() => void playQueue(visibleSongs, 0)}
                >
                  <Play className="h-4 w-4 fill-current" />
                </IconButton>
              </div>
            )}
          </div>

          {/* 搜索框放在页头右侧批量条上方，不另占列表行；批量操作只接收可见结果。 */}
          {!loading && !error && songs.length > 0 ? (
            <div className="relative flex shrink-0 flex-col items-end justify-end gap-2 pb-1">
              <div className="flex h-8 w-44 items-center gap-2 rounded-lg border border-input bg-background/80 px-2 focus-within:ring-1 focus-within:ring-ring">
                <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <input
                  type="search"
                  aria-label="专辑内搜索"
                  placeholder="专辑内搜索"
                  title="搜索标题、歌手、专辑"
                  value={query}
                  onChange={(e) => changeQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      changeQuery("");
                    }
                  }}
                  className="h-full min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
                />
                {query ? (
                  <button
                    type="button"
                    title="清空搜索"
                    onClick={() => changeQuery("")}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                    <span className="sr-only">清空搜索</span>
                  </button>
                ) : null}
              </div>
              <BatchBar
                embedded
                tracks={visibleSongs}
                selected={visibleSelected}
                selectionKey={trackSelectionKey}
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
        ) : (
          <>
            {songs.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                没有找到该专辑的歌曲
              </div>
            ) : visibleSongs.length === 0 ? (
              <div role="status" className="py-10 text-center text-sm text-muted-foreground">
                没有匹配的歌曲，试试其它标题、歌手或专辑
              </div>
            ) : (
              <TrackList
                tracks={visibleSongs}
                showIndex
                showCollect
                showDownload
                selection={{ ids: visibleSelected, onToggle: toggleSelect, onChange: setSelected }}
              />
            )}
            {/* 与检索结果共用同一个哨兵：无匹配项时仍能继续拉取后续页。 */}
            <div ref={sentinelRef} className="h-1" />
            <div className="py-4 text-center text-xs text-muted-foreground">
              {loadingMore ? "加载中…" : hasMore ? "继续下拉加载更多" : "已经到底了"}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** URL 里可能不是合法百分号编码，解码失败就按原样用 */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 专辑名归一化比较：忽略大小写、全半角空格、常见括号后缀差异 */
function sameAlbum(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const norm = (s: string): string =>
    s.toLowerCase().replace(/[\s\u3000()（）[\]【】·・-]/g, "");
  const x = norm(a);
  const y = norm(b);
  return x.length > 0 && (x === y || x.includes(y) || y.includes(x));
}

/**
 * 路由第二段**看起来像不像一个专辑 id**。
 *
 * 只有具备「按 id 取专辑」能力的源才有意义（qq 的 albumMid、wyy/kw/kg 的数字 id）；
 * bili / migu 的实现是空壳，试了也是白跑一次请求。
 * 判定刻意宽松 —— 猜错只是多发一次请求，失败就静默退回名字搜索，不会更坏。
 */
function looksLikeAlbumId(raw: string, platform: SourceId): boolean {
  if (biliOrMiguNoAlbumApi(platform)) return false;
  if (platform === "qq") {
    // qq 的 albumMid 是 14 位左右的 base62；纯中文/带空格的必然不是
    return /^[0-9A-Za-z]{8,20}$/.test(raw);
  }
  // wyy / kw / kg：纯数字
  return /^\d{3,}$/.test(raw);
}

/** bili / migu 的 albumDetail 是空壳实现，不必为它们发这一次请求 */
function biliOrMiguNoAlbumApi(platform: SourceId): boolean {
  return platform === "bili" || platform === "migu";
}
