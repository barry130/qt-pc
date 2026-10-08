import { useCallback, useEffect, useState } from "react";
import { useParams, useSearch } from "@tanstack/react-router";
import { Play } from "lucide-react";
import type { SourceId, Track } from "@/types";
import * as sourceApi from "@/source-scripts";
import { usePlayerStore } from "@/stores/player";
import { useSearchPageMax } from "@/stores/sourceRegistry";
import { usePagedList, type PageResult } from "@/hooks/usePagedList";
import { resolveArtistId } from "@/lib/artist-id";
import { qtresCoverUrl } from "@/lib/lrc";
import { TrackList } from "./TrackList";
import { ErrorRetry, TrackRowsSkeleton } from "./Skeletons";
import { BackButton } from "@/components/layout/BackButton";

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

  const cover = avatar || songs.find((t) => t.picUrl)?.picUrl || "";
  const coverUrl = cover ? qtresCoverUrl(cover) : null;
  // 收尾前才显示进度（以前只看 progress !== null，拉完也永远停不掉）
  const loadingAll = !finished;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="relative shrink-0 overflow-hidden border-b border-border">
        {coverUrl ? (
          <>
            <img
              src={coverUrl}
              alt=""
              aria-hidden
              draggable={false}
              className="absolute inset-0 h-full w-full scale-125 select-none object-cover opacity-45 blur-3xl saturate-150"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-background/10 to-background" />
          </>
        ) : null}

        <div className="relative flex items-center px-6 pt-5">
          <BackButton />
        </div>

        <div className="relative flex items-center gap-5 px-6 pb-5 pt-4">
          <div className="h-24 w-24 shrink-0 overflow-hidden rounded-full bg-secondary shadow-xl ring-1 ring-border">
            {coverUrl ? (
              <img
                src={coverUrl}
                alt=""
                className="h-full w-full object-cover"
                loading="lazy"
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-3xl font-bold text-muted-foreground/50">
                {name.slice(0, 1)}
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
              歌手
            </p>
            <h1 className="mt-0.5 truncate text-2xl font-bold tracking-tight">{name}</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {loading
                ? "加载中…"
                : loadingAll
                  ? `已加载 ${songs.length} 首，正在取完其余…`
                  : `全部 ${songs.length} 首歌曲`}
            </p>
          </div>
          {songs.length > 0 && (
            <button
              type="button"
              onClick={() => void playQueue(songs, 0)}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/25 transition-opacity hover:opacity-90"
            >
              <Play className="h-4 w-4 fill-current" />
              播放全部
            </button>
          )}
        </div>

        {/* 全量拉取进度：歌手页是「进页即全部」，拉完前顶部显示一条进度带 */}
        {loadingAll && !loading ? <LoadBar /> : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
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
            <TrackList tracks={songs} showIndex showAddToPlaylist showDownload />
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
