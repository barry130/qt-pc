import { useCallback, useEffect, useState } from "react";
import { errMsg } from "@/lib/utils";
import type { HistoryItem } from "@/types";
import * as ipc from "@/services/ipc";
import { TrackList } from "../discovery/TrackList";

/**
 * 最近播放（路由 /history，DESIGN §5.3）。
 *
 * 历史由 Rust 侧在播放开始时自动写入（同一首歌去重、保留最近一次），
 * 前端只负责读取与清空。
 */
export function HistoryPage(): React.JSX.Element {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const list = await ipc.listHistory(200).catch(() => [] as HistoryItem[]);
      setItems(Array.isArray(list) ? list : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const clear = async (): Promise<void> => {
    setError(null);
    try {
      await ipc.clearHistory();
      await load();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const tracks = items.map((it) => it.track);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-baseline justify-between border-b border-border px-4 py-3">
        <div>
          <h1 className="text-base font-medium">最近播放</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            共 {tracks.length} 首
          </p>
        </div>
        {tracks.length > 0 && (
          <button
            type="button"
            onClick={() => void clear()}
            className="h-8 rounded-md border border-border px-3 text-xs transition-colors hover:bg-secondary"
          >
            清空
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
            还没有播放记录
          </div>
        ) : (
          <TrackList tracks={tracks} showAddToPlaylist showDownload />
        )}
      </div>
    </div>
  );
}
