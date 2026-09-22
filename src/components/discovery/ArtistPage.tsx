import { useCallback, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { Play } from "lucide-react";
import type { SourceId, Track } from "@/types";
import * as sourceApi from "@/source-scripts";
import { usePlayerStore } from "@/stores/player";
import { usePagedList } from "@/hooks/usePagedList";
import { qtresCoverUrl } from "@/lib/lrc";
import { TrackList } from "./TrackList";
import { ErrorRetry, TrackRowsSkeleton } from "./Skeletons";
import { BackButton } from "@/components/layout/BackButton";

/**
 * 歌手页（路由 /artist/$platform/$id）。
 *
 * 音源侧没有「按歌手 id 取歌曲」的免费接口，所以这里用**歌手名搜索**来闭环：
 * URL 的 `$id` 位置放的是歌手名（encodeURIComponent 过），头像取包内 artistSongs
 * 第一页顺带返回的 picUrl，拿不到再退到首曲封面。
 *
 * **进页一次拉完**（usePagedList 的 `all` 模式）：早先是滚动续页，短歌手页还行，
 * 长歌手要一直下拉；现在并发把所有页取完再一次性列出，滚动条即全量。
 *
 * 每页条数必须走 `SEARCH_PAGE_MAX`：上游上限各不相同（qq 要 100 会返回 0 条、
 * 酷狗恒给 30），传超限值会让「满页 = 还有下一页」的推断失效。
 */
export function ArtistPage(): React.JSX.Element {
  const { platform, id } = useParams({ strict: false }) as {
    platform: SourceId;
    id: string;
  };
  const name = safeDecode(id);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const [avatar, setAvatar] = useState("");
  const pageSize = sourceApi.SEARCH_PAGE_MAX[platform] ?? 50;

  const fetchPage = useCallback(
    async (page: number): Promise<Track[]> => {
      const res = await sourceApi.getArtistSongs(platform, name, page, pageSize);
      // 头像只有第一页带（包内行为），顺路存下来
      if (page <= 1) setAvatar(res.picUrl);
      return res.songs;
    },
    [platform, name, pageSize],
  );

  const { items: songs, loading, error, progress, reload } = usePagedList<Track>({
    fetchPage,
    keyOf: (t) => `${t.platform}:${t.id}`,
    resetKey: `${platform}:${name}`,
    pageSize,
    mode: "all",
    // 歌手歌曲最多几千首（100/页 → 几十页），上限只是防上游 total 撒谎时打转
    maxPages: 60,
  });

  const cover = avatar || songs.find((t) => t.picUrl)?.picUrl || "";
  const coverUrl = cover ? qtresCoverUrl(cover) : null;
  const loadingAll = progress !== null;

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

/** URL 里可能不是合法百分号编码，解码失败就按原样用 */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
