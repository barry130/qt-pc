import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearch } from "@tanstack/react-router";
import { Play, Search, X } from "lucide-react";
import type { SourceId, Track } from "@/types";
import * as sourceApi from "@/source-scripts";
import { usePlayerStore } from "@/stores/player";
import { useSearchPageMax } from "@/stores/sourceRegistry";
import { usePagedList, type PageResult } from "@/hooks/usePagedList";
import { resolveArtistId } from "@/lib/artist-id";
import { qtresCoverUrl } from "@/lib/lrc";
import { filterTracks, retainTrackSelection, trackSelectionKey } from "@/lib/track-selection";
import { TrackList } from "./TrackList";
import { BatchBar } from "./BatchBar";
import { ErrorRetry, TrackRowsSkeleton } from "./Skeletons";
import { BackButton } from "@/components/layout/BackButton";
import { IconButton } from "@/components/common/IconButton";

/**
 * 歌手页（路由 /artist/$platform/$id）。
 *
 * 2026-10-06：新跳转把**歌手真实 id** 放 search 参数 `?id=`，名字放 `?name=`；
 * 有 id 时包里走按 id 取作品（wyy/kw/kg/qq 都有端点），不再把同名歌手的歌混进来。
 *
 * 没有 `?id=` 时（老书签、从列表/播放条/常听歌手点歌手名进来，URL 上只有名字）
 * 先经 `resolveArtistId` 按名字查一次歌手补上 id 再取作品 —— 包里拿不到 id 会
 * 退回「把歌手名当关键词全局搜索」，那是无过滤的搜索结果，第 1 页最相关、
 * 越往后越跑偏（翻唱 / 合作 / 同名歌手），用户看到的就是「后面的歌跟歌手没关系」。
 * 补不到 id（接口没实现 / 风控）就按老路走名字搜索，两条路都不会白屏。
 * 头像取包内 artistSongs 第一页顺带返回的 picUrl，拿不到再退到首曲封面。
 *
 * **进页一次拉完**（usePagedList 的 `all` 模式）：早先是滚动续页，短歌手页还行，
 * 长歌手要一直下拉；现在并发把所有页取完再一次性列出，滚动条即全量。
 *
 * 每页条数走数据包声明的 `searchPageMax`（useSearchPageMax）：上游上限各不相同
 * （qq 要 100 会返回 0 条、酷狗恒给 30），传超限值会让「满页 = 还有下一页」
 * 的推断失效。宿主不再内置这张表。
 *
 * ---------------------------------------------------------------------------
 * 页头：与歌单 / 榜单详情页同一套 hero（用户 m05156，每日新歌页 m02747 同款）
 * ---------------------------------------------------------------------------
 * 原页头是圆形头像 + 一行小字，播放键单独摆在行尾。现改为与
 * `PlaylistDetailPage` 同构的 hero：模糊封面铺底 + 方形封面 + 小标签
 * + 大标题 + 曲数 + 大号「播放全部」，批量条贴在右端、与「播放全部」
 * 同一行底线对齐。头像取包内 artistSongs 第一页的 picUrl，回退首曲封面 /
 * 首字占位不变。
 *
 * 注意 hero 外层**不能**加 `overflow-hidden`：批量条的歌单面板是 absolute
 * 展开的，一裁就只剩一条缝，裁切只加在铺底图那一层（详情页已踩过同一个坑）。
 *
 * 歌手页没有歌单级收藏（歌手不是可收藏实体），按钮行只有「播放全部」；
 * 曲级收藏 / 下载走右端批量条与行内按钮。
 */
export function ArtistPage(): React.JSX.Element {
  const { platform, id } = useParams({ strict: false }) as {
    platform: SourceId;
    id: string;
  };
  const search = useSearch({ strict: false }) as { name?: string; id?: string };
  const rawName = typeof search.name === "string" ? search.name : "";
  const artistId = typeof search.id === "string" && search.id.length > 0 ? search.id : "";
  // 没有 ?name= 说明是老链接：$id 位置放的是名字，解码后当名字用，且没有真 id。
  const name = rawName.length > 0 ? rawName : safeDecode(id);
  // 路由复用组件时，检索与勾选随歌手身份一起复位。
  return <ArtistPageContent key={JSON.stringify([platform, id, name, artistId])} platform={platform} name={name} artistId={artistId} />;
}

function ArtistPageContent({ platform, name, artistId }: {
  platform: SourceId;
  name: string;
  artistId: string;
}): React.JSX.Element {
  const playQueue = usePlayerStore((s) => s.playQueue);
  const [avatar, setAvatar] = useState("");
  const pageSize = useSearchPageMax(platform);

  const fetchPage = useCallback(
    async (page: number): Promise<PageResult<Track>> => {
      // 没带真 id（从列表点歌手名 / 播放条歌手按钮 / 常听歌手进来）时先补一次：
      // 包里拿不到 id 会退回「把歌手名当关键词全局搜索」，越往后越跑偏。
      const id =
        artistId.length > 0 ? artistId : await resolveArtistId(platform, name);
      const res = await sourceApi.getArtistSongs(platform, name, page, pageSize, id);
      // 头像只有第一页带（包内行为），顺路存下来
      if (page <= 1) setAvatar(res.picUrl);
      // 把包给的 hasMore 原样交给任务：歌手作品是过滤型列表，逐页条数不齐，
      // 按「不满一页 = 到底」推断会在中途收尾（详见 source-scripts 的 hasMoreOf）
      return { list: res.songs, hasMore: res.hasMore };
    },
    [platform, name, pageSize, artistId],
  );

  // 缓存键：与 resetKey 同口径（音源 + 歌手名 + 每页条数 + 歌手 id）。
  // 命中缓存任务时不再发请求；即使中途离开页面，后台也继续跑完并留在缓存里。
  const cacheKey = `artist:${platform}:${name}:${pageSize}:${artistId}`;

  const { items: songs, loading, error, finished, reload } = usePagedList<Track>({
    fetchPage,
    keyOf: (t) => `${t.platform}:${t.id}`,
    // pageSize 也进 resetKey：注册表是异步到达的，首帧可能还是兜底值 50，
    // 包声明的真实上限到位后必须整页重拉，否则第一页条数与后续页不一致。
    resetKey: `${platform}:${name}:${pageSize}:${artistId}`,
    pageSize,
    mode: "all",
    cacheKey,
    // 歌手歌曲最多几千首（100/页 → 几十页），上限只是防上游 total 撒谎时打转
    maxPages: 60,
  });

  // 头像只有第 1 页带回来：命中缓存时根本不会再调 fetchPage，
  // 所以按同一个键另存一份，第二次进页头像不能丢。
  useEffect(() => {
    const cached = AVATAR_CACHE.get(cacheKey);
    if (cached !== undefined && cached.length > 0) setAvatar(cached);
    else setAvatar("");
  }, [cacheKey]);

  useEffect(() => {
    if (avatar.length > 0) rememberAvatar(cacheKey, avatar);
  }, [cacheKey, avatar]);

  // 批量管理的已勾选曲目 id 集合（见 BatchBar）
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const visibleSongs = useMemo(() => filterTracks(songs, query), [songs, query]);
  const visibleSelected = useMemo(() => retainTrackSelection(visibleSongs, selected), [visibleSongs, selected]);
  const changeQuery = (value: string): void => {
    setQuery(value);
    // 隐藏的歌曲退出批量范围，清空搜索也不恢复它们的勾选。
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

  const cover = avatar || songs.find((t) => t.picUrl)?.picUrl || "";
  const coverUrl = cover ? qtresCoverUrl(cover) : null;
  // 收尾前才显示进度（以前只看 progress !== null，拉完也永远停不掉）
  const loadingAll = !finished;

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* 页头 hero：与歌单 / 榜单详情页同一套（模糊封面铺底 + 方形封面 + 小标签
          + 大标题 + 曲数 + 大号「播放全部」+ 右端批量条），详见文件头。
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
                {name.slice(0, 1)}
              </span>
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col justify-end pb-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
              歌手
            </p>
            <h1 className="mt-1 truncate text-2xl font-bold tracking-tight">{name}</h1>
            {/* 全量拉取时如实报进度，拉完才说「共 N 首歌」（与详情页同口径） */}
            <p role="status" className="mt-1 text-xs text-muted-foreground">
              {loading
                ? "加载中…"
                : query.trim()
                  ? `显示 ${visibleSongs.length} / ${songs.length} 首${loadingAll ? "，正在取完其余…" : ""}`
                  : loadingAll
                    ? `已加载 ${songs.length} 首，正在取完其余…`
                    : `共 ${songs.length} 首歌`}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
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
          </div>

          {/* 搜索框沿用歌单详情页的位置，放在右侧批量条上方，不另占列表行。
              歌手页没有宿主歌单；播放与批量操作共用当前可见歌曲。 */}
          {!loading && !error && songs.length > 0 ? (
            <div className="relative flex shrink-0 flex-col items-end justify-end gap-2 pb-1">
              <div className="flex h-8 w-44 items-center gap-2 rounded-lg border border-input bg-background/80 px-2 focus-within:ring-1 focus-within:ring-ring">
                <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <input
                  type="search"
                  aria-label="歌手歌曲内搜索"
                  placeholder="歌手歌曲内搜索"
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

        {/* 全量拉取进度：歌手页是「进页即全部」，拉完前顶部显示一条进度带 */}
        {loadingAll && !loading ? <LoadBar /> : null}
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
            没有找到该歌手的歌曲
          </div>
        ) : (
          <>
            {visibleSongs.length === 0 ? (
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
            {loadingAll ? (
              <div className="py-4 text-center text-xs text-muted-foreground">
                正在加载其余歌曲… 已加载 {songs.length} 首
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 全量拉取进度带：分母未知（搜索接口不回总数），所以是不定长流动条，
 * 已有条数由头部/底部文字给出，不做假百分比。
 */
function LoadBar(): React.JSX.Element {
  return (
    <div
      role="progressbar"
      aria-label="正在加载全部歌曲"
      aria-valuetext="加载中"
      className="relative h-0.5 w-full overflow-hidden bg-secondary"
    >
      <div className="qm-progress-bar absolute inset-y-0 w-1/3 bg-primary" />
    </div>
  );
}

/**
 * 歌手头像缓存（进程内，随退出回收）：头像只跟着第 1 页回来，
 * 而歌曲命中缓存后不会再取第 1 页 —— 不另存一份的话，第二次进页头像就没了。
 */
const AVATAR_CACHE = new Map<string, string>();
const AVATAR_CACHE_CAP = 64;

function rememberAvatar(key: string, url: string): void {
  AVATAR_CACHE.delete(key);
  AVATAR_CACHE.set(key, url);
  while (AVATAR_CACHE.size > AVATAR_CACHE_CAP) {
    const oldest = AVATAR_CACHE.keys().next().value;
    if (oldest === undefined) break;
    AVATAR_CACHE.delete(oldest);
  }
}

/** URL 里可能不是合法百分号编码，解码失败就按原样用 */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
