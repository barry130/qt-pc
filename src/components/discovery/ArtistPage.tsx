import { useEffect, useState } from "react";
import { errMsg } from "@/lib/utils";
import { useParams } from "@tanstack/react-router";
import { Play } from "lucide-react";
import type { SourceId, Track } from "@/types";
import * as ipc from "@/services/ipc";
import { usePlayerStore } from "@/stores/player";
import { qtresCoverUrl } from "@/lib/lrc";
import { TrackList } from "./TrackList";
import { ErrorRetry, TrackRowsSkeleton } from "./Skeletons";
import { BackButton } from "@/components/layout/BackButton";

/**
 * 歌手页（路由 /artist/$platform/$id）。
 *
 * 音源侧没有「按歌手 id 取歌曲」的免费接口，所以这里用**歌手名搜索**来闭环：
 * URL 的 `$id` 位置放的是歌手名（encodeURIComponent 过），封面取列表首曲的封面近似。
 */
export function ArtistPage(): React.JSX.Element {
  const { platform, id } = useParams({ strict: false }) as {
    platform: SourceId;
    id: string;
  };
  const name = safeDecode(id);
  const playQueue = usePlayerStore((s) => s.playQueue);

  const [songs, setSongs] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const list = await ipc.searchMusic(name, platform, 1, 50);
        if (!cancelled) setSongs(Array.isArray(list) ? list : []);
      } catch (err) {
        if (!cancelled) {
          setError(errMsg(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [name, platform, reload]);

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
              {songs.length} 首歌曲
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
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <ErrorRetry
            message={`加载失败：${error}`}
            onRetry={() => setReload((r) => r + 1)}
          />
        ) : loading ? (
          <TrackRowsSkeleton rows={8} />
        ) : songs.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            没有找到该歌手的歌曲
          </div>
        ) : (
          <TrackList tracks={songs} showIndex showAddToPlaylist showDownload />
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
