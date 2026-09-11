import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import type { Track } from "@/types";
import * as ipc from "@/services/ipc";
import { useMusicSourceStore } from "@/stores/musicSource";
import { usePlayerStore } from "@/stores/player";
import { TrackList } from "./TrackList";

/**
 * 每日新歌（路由 /daily）。
 *
 * 只展示当前音源的最新歌曲，列表形式（带序号 / 加歌单 / 下载）。
 * 「换一批」走 getLatestSongs 的 offset 翻页，不引入新接口。
 */
export function DailyPage(): React.JSX.Element {
  const activeSourceId = useMusicSourceStore((s) => s.activeSourceId);
  const playQueue = usePlayerStore((s) => s.playQueue);

  const [songs, setSongs] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const s = await ipc
        .getLatestSongs(activeSourceId, 50, 0)
        .catch(() => [] as Track[]);
      if (cancelled) return;
      setSongs(Array.isArray(s) ? s : []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSourceId]);

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
        {loading && songs.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            加载中…
          </div>
        ) : songs.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            暂无新歌
          </div>
        ) : (
          <TrackList tracks={songs} showIndex showAddToPlaylist showDownload />
        )}
      </div>
    </div>
  );
}
