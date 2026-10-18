import { useCallback, useEffect, useMemo, useState } from "react";
import { Trash2, X } from "lucide-react";
import { errMsg } from "@/lib/utils";
import { retainTrackSelection, trackSelectionKey } from "@/lib/track-selection";
import type { HistoryItem, Track } from "@/types";
import * as ipc from "@/services/ipc";
import { TrackList } from "../discovery/TrackList";
import { IconButton } from "../common/IconButton";
import { useKeepAliveActive } from "@/components/layout/keepAliveActive";

/**
 * 最近播放（路由 /history，DESIGN §5.3）。
 *
 * 历史由 Rust 侧在播放开始时自动写入（同一首歌去重、保留最近一次），
 * 前端负责读取、单条移除、多选删除与清空。
 *
 * 另有一类「看不见的记录」：指向已丢失文件的条目在 Rust 侧被 `missing = 1` 过滤掉了
 * （文件被删/移走后不该还能点播），但它们仍留在库里。页面上单独给条数 +
 * 一键清理，否则用户清空后仍会看到「历史里还有东西」却无从下手。
 */
export function HistoryPage(): React.JSX.Element {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 多选删除：与 TrackList 的选择态同口径（key 用 `platform:id`）。 */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 指向已丢失文件的历史条数（列表里看不到这部分） */
  const [missing, setMissing] = useState(0);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [list, gone] = await Promise.all([
        ipc.listHistory(200).catch(() => [] as HistoryItem[]),
        ipc.countMissingHistory().catch(() => 0),
      ]);
      setItems(Array.isArray(list) ? list : []);
      setMissing(typeof gone === "number" ? gone : 0);
    } finally {
      setLoading(false);
    }
  }, []);

  // 本页常驻缓存（挂载后不再卸载）：历史由播放自动写入，只在首次挂载拉一次的话
// 刚听过的歌不会出现。改为每次切回本页时重拉。
  const active = useKeepAliveActive();

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load]);

  const toggleSelect = useCallback((trackId: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });
  }, []);

  /** 单条移除：× 按钮与多选态一起清，避免删完还留着一个选不中的 id */
  const removeOne = async (track: Track): Promise<void> => {
    setError(null);
    try {
      await ipc.removeHistory(track);
      setSelected((prev) => {
        const key = trackSelectionKey(track);
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      await load();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const removeSelected = async (): Promise<void> => {
    const picked = items
      .filter((it) => selected.has(trackSelectionKey(it.track)))
      .map((it) => it.track);
    if (picked.length === 0) return;
    setError(null);
    try {
      await ipc.removeHistoryMany(picked);
      setSelected(new Set());
      await load();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const clear = async (): Promise<void> => {
    setError(null);
    try {
      await ipc.clearHistory();
      setSelected(new Set());
      await load();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const purgeMissing = async (): Promise<void> => {
    setError(null);
    try {
      await ipc.purgeMissingHistory();
      await load();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const tracks = useMemo(() => items.map((it) => it.track), [items]);
  useEffect(() => {
    setSelected((prev) => retainTrackSelection(tracks, prev));
  }, [tracks]);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-base font-medium">最近播放</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            共 {tracks.length} 首
            {missing > 0 && (
              <>
                <span className="mx-2 text-border">|</span>
                <span>另有 {missing} 条记录指向的文件已不在</span>
                <button
                  type="button"
                  className="ml-2 underline hover:text-foreground"
                  onClick={() => void purgeMissing()}
                >
                  清理
                </button>
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {selected.size > 0 && (
            <>
              <span className="text-xs text-muted-foreground">
                已选 {selected.size} 首
              </span>
              <IconButton
                label={`删除选中的 ${selected.size} 首播放记录`}
                variant="outline"
                size="lg"
                hover="secondary"
                danger
                onClick={() => void removeSelected()}
              >
                <X />
              </IconButton>
            </>
          )}
          {tracks.length > 0 && (
            <IconButton
              label="清空播放记录"
              variant="outline"
              size="lg"
              hover="secondary"
              danger
              onClick={() => void clear()}
            >
              <Trash2 />
            </IconButton>
          )}
        </div>
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
          <TrackList
            tracks={tracks}
            showCollect
            showDownload
            onRemove={(t) => void removeOne(t)}
            removeLabel="从播放记录移除"
            selection={{ ids: selected, onToggle: toggleSelect, onChange: setSelected }}
          />
        )}
      </div>
    </div>
  );
}
