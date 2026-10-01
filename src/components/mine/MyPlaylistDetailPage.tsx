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
 *
 * 批量管理：行首复选框勾选（TrackList 顶层 selection），全选 / 批量删除
 * 走 remove_tracks_from_playlist 一次移除，成功后重载并清空选择。
 */
export function MyPlaylistDetailPage(): React.JSX.Element {
  const navigate = useNavigate();
  // 与 router.tsx 现有写法保持一致（code-based 路由，宽松取参）
  const { id } = useParams({ strict: false }) as { id: string };
  const playQueue = usePlayerStore((s) => s.playQueue);

  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 批量管理：已勾选的曲目 id 集合
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

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

  // 切换歌单后清掉勾选，避免残留已不属于这个歌单的曲目 id
  useEffect(() => {
    setSelected(new Set());
  }, [id]);

  const toggleSelect = useCallback((trackId: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });
  }, []);

  const allSelected =
    tracks.length > 0 && tracks.every((t) => selected.has(t.id));

  const remove = async (t: Track): Promise<void> => {
    setError(null);
    try {
      await ipc.removeTrackFromPlaylist(id, t);
      await load();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const batchRemove = async (): Promise<void> => {
    // 按当前列表把勾选的 id 还原成完整 Track（后端按曲目归属摘收藏）
    const targets = tracks.filter((t) => selected.has(t.id));
    if (targets.length === 0) return;
    setDeleting(true);
    setError(null);
    try {
      await ipc.removeTracksFromPlaylist(id, targets);
      await load();
      setSelected(new Set());
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setDeleting(false);
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
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() =>
                  setSelected(
                    allSelected ? new Set() : new Set(tracks.map((t) => t.id)),
                  )
                }
                className="h-3.5 w-3.5 accent-primary"
              />
              全选
            </label>
            <button
              type="button"
              onClick={() => void batchRemove()}
              disabled={deleting || selected.size === 0}
              className="h-8 rounded-md border border-border px-3 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
            >
              {deleting
                ? "删除中…"
                : `批量删除${selected.size > 0 ? `（${selected.size}）` : ""}`}
            </button>
            <button
              type="button"
              onClick={() => void playQueue(tracks, 0)}
              className="h-8 rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              播放全部
            </button>
          </div>
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
          <TrackList
            tracks={tracks}
            onRemove={(t) => void remove(t)}
            selection={{ ids: selected, onToggle: toggleSelect }}
          />
        )}
      </div>
    </div>
  );
}
