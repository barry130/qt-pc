import { useCallback, useEffect, useState } from "react";
import { errMsg } from "@/lib/utils";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { Track } from "@/types";
import * as ipc from "@/services/ipc";
import { usePlayerStore } from "@/stores/player";
import { TrackList } from "../discovery/TrackList";

/**
 * 本地歌单详情（路由 /my/playlist/$id，DESIGN §5.3）。
 *
 * 曲目 = 挂在这个歌单 pid 下的收藏（liked_songs.pid，见 store 模块头的
 * (platform, pid) 约定），顺序即加入顺序；整列表播放走 playQueue。
 * 从歌单里移除 = 摘掉它在这个歌单下的收藏归属。
 */
export function MyPlaylistDetailPage(): React.JSX.Element {
  const navigate = useNavigate();
  // 与 router.tsx 现有写法保持一致（code-based 路由，宽松取参）
  const { id } = useParams({ strict: false }) as { id: string };
  const playQueue = usePlayerStore((s) => s.playQueue);

  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const t = await ipc.getPlaylistTracks(id).catch(() => [] as Track[]);
      setTracks(Array.isArray(t) ? t : []);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (t: Track): Promise<void> => {
    setError(null);
    try {
      await ipc.removeTrackFromPlaylist(id, t);
      await load();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-baseline justify-between border-b border-border px-4 py-3">
        <div>
          <button
            type="button"
            onClick={() => void navigate({ to: "/my/playlists" })}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            ← 我的歌单
          </button>
          <p className="mt-1 text-xs text-muted-foreground">
            共 {tracks.length} 首
          </p>
        </div>
        {tracks.length > 0 && (
          <button
            type="button"
            onClick={() => void playQueue(tracks, 0)}
            className="h-8 rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            播放全部
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <div className="p-6 text-center text-sm text-destructive">
            操作失败：{error}
          </div>
        )}
        {loading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            加载中…
          </div>
        ) : !error && tracks.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            歌单里还没有歌曲，在其它列表里用「添加到歌单」加进来
          </div>
        ) : (
          <TrackList tracks={tracks} onRemove={(t) => void remove(t)} />
        )}
      </div>
    </div>
  );
}
