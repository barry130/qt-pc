import { useCallback, useRef } from "react";
import { useParams } from "@tanstack/react-router";
import { Play } from "lucide-react";
import type { SourceId, Track } from "@/types";
import * as sourceApi from "@/source-scripts";
import { usePlayerStore } from "@/stores/player";
import { useSearchPageMax } from "@/stores/sourceRegistry";
import { usePagedList } from "@/hooks/usePagedList";
import { qtresCoverUrl } from "@/lib/lrc";
import { TrackList } from "./TrackList";
import { ErrorRetry, TrackRowsSkeleton } from "./Skeletons";
import { BackButton } from "@/components/layout/BackButton";

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
 */
export function AlbumPage(): React.JSX.Element {
  const { platform, id } = useParams({ strict: false }) as {
    platform: SourceId;
    id: string;
  };
  const name = safeDecode(id);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const pageSize = useSearchPageMax(platform);

  // 是否按专辑名过滤在**第一页**定一次，后续页沿用同一判断：
  // 否则会出现「第 1 页全是搜索结果、第 2 页只剩匹配项」的前后不一致。
  const useFilterRef = useRef<boolean | null>(null);

  const fetchPage = useCallback(
    async (page: number): Promise<Track[]> => {
      const list = await sourceApi.searchMusic(name, platform, page, pageSize);
      const arr = Array.isArray(list) ? list : [];
      if (page <= 1) {
        useFilterRef.current = arr.some((t) => sameAlbum(t.album, name));
      }
      return useFilterRef.current === true
        ? arr.filter((t) => sameAlbum(t.album, name))
        : arr;
    },
    [name, platform, pageSize],
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

  const cover = songs.find((t) => t.picUrl)?.picUrl;
  const coverUrl = cover ? qtresCoverUrl(cover) : null;

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
              专辑
            </p>
            <h1 className="mt-1 truncate text-2xl font-bold tracking-tight">{name}</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {loading
                ? "加载中…"
                : `${songs.length} 首歌曲${hasMore ? "（继续下拉加载更多）" : ""}`}
            </p>
            {songs.length > 0 && (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => void playQueue(songs, 0)}
                  className="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/25 transition-opacity hover:opacity-90"
                >
                  <Play className="h-4 w-4 fill-current" />
                  播放全部
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <ErrorRetry message={`加载失败：${error}`} onRetry={reload} />
        ) : loading ? (
          <TrackRowsSkeleton rows={8} />
        ) : songs.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            没有找到该专辑的歌曲
          </div>
        ) : (
          <>
            <TrackList tracks={songs} showIndex showAddToPlaylist showDownload />
            {/* 哨兵：进入视口就拉下一页 */}
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
