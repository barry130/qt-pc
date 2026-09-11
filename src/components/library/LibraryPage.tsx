import { useCallback, useEffect, useState } from "react";
import { errMsg } from "@/lib/utils";
import type { Track } from "@/types";
import * as ipc from "@/services/ipc";
import { TrackList } from "../discovery/TrackList";

/**
 * 本地音乐（路由 /library，DESIGN §5.2 / §13）。
 *
 * 扫描目录持久化在 Rust 侧（scan_dirs 表），扫描结果入库（tracks 表，platform=local）。
 * 本地曲目的 Track.id 即文件绝对路径，播放由 Rust 引擎特判本地源解码。
 */
export function LibraryPage(): React.JSX.Element {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [dirs, setDirs] = useState<string[]>([]);
  const [newDir, setNewDir] = useState("");
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [t, d] = await Promise.all([
        ipc.getLocalTracks().catch(() => [] as Track[]),
        ipc.getScanDirs().catch(() => [] as string[]),
      ]);
      setTracks(Array.isArray(t) ? t : []);
      setDirs(Array.isArray(d) ? d : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const scan = useCallback(async (): Promise<void> => {
    if (dirs.length === 0) return;
    setScanning(true);
    setError(null);
    try {
      const list = await ipc.scanLibrary(dirs);
      setTracks(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setScanning(false);
    }
  }, [dirs]);

  const addDir = async (): Promise<void> => {
    const p = newDir.trim();
    if (!p) return;
    setError(null);
    try {
      await ipc.addScanDir(p);
      setNewDir("");
      await load();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const removeDir = async (p: string): Promise<void> => {
    setError(null);
    try {
      await ipc.removeScanDir(p);
      await load();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-base font-medium">本地音乐</h1>
          <button
            type="button"
            onClick={() => void scan()}
            disabled={scanning || dirs.length === 0}
            className="h-8 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {scanning ? "扫描中…" : "扫描"}
          </button>
        </div>

        <div className="mt-2 flex gap-2">
          <input
            value={newDir}
            onChange={(e) => setNewDir(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addDir();
            }}
            placeholder="添加音乐文件夹路径，如 D:\Music"
            className="h-8 flex-1 rounded-md border border-input bg-background px-3 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="button"
            onClick={() => void addDir()}
            disabled={!newDir.trim()}
            className="h-8 shrink-0 rounded-md border border-border px-3 text-xs transition-colors hover:bg-secondary disabled:opacity-50"
          >
            添加
          </button>
        </div>

        {dirs.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {dirs.map((d) => (
              <li
                key={d}
                className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
              >
                <span className="truncate">{d}</span>
                <button
                  type="button"
                  onClick={() => void removeDir(d)}
                  className="shrink-0 text-xs transition-colors hover:text-destructive"
                >
                  移除
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            还没有扫描目录，添加一个后即可扫描本地歌曲
          </p>
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
            暂无本地歌曲
          </div>
        ) : (
          <TrackList tracks={tracks} showAddToPlaylist />
        )}
      </div>
    </div>
  );
}
