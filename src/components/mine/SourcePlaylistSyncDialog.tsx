import { useEffect, useMemo, useState } from "react";
import {
  accountSyncPreview,
  collectAccountPlaylists,
  uncollectAccountPlaylists,
  type AccountSyncRow,
} from "@/lib/source-playlist-sync";
import type { SourceAccountPlaylist } from "@/source-scripts";
import { toast, toastError } from "@/stores/toast";
import { errMsg } from "@/lib/utils";

/**
 * 账户歌单同步弹窗（2026-10-26 需求；2026-10-27 改版）：
 * 打开即拉「平台侧**全部**收藏歌单 + 本地是否已收藏」（accountSyncPreview），
 * 每行一个勾选框，勾上 = 希望它在本地「我的歌单」里：
 * - 本地没有的（未勾）→ 勾上即收藏（collectAccountPlaylists）
 * - 本地已收藏的（默认勾上、行尾标「已收藏」）→ 取消勾选即从本地取消收藏
 *   （uncollectAccountPlaylists，只动本地收藏关系，不碰平台侧）
 * 点「应用更改」一次性提交两边的差异。包旧/未登录/平台不支持的错误文案原样
 * 展示（版本提示由 source-scripts 包装层给出）。遮罩/面板样式与
 * ImportPlaylistDialog 同款。
 */
export function SourcePlaylistSyncDialog(props: {
  source: string;
  sourceName: string;
  onClose: () => void;
  /** 收藏/取消收藏动作完成（含部分失败）后回调：页面借此刷新 */
  onDone: () => void;
}): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<AccountSyncRow[]>([]);
  /** 勾选集合（下标 = rows 下标；打开期间 rows 是不变快照）。初值 = 全部勾上 */
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    accountSyncPreview(props.source)
      .then((p) => {
        if (cancelled) return;
        setRows(p.rows);
        // 勾选语义 = 「希望它在本地我的歌单里」：默认全勾（未收藏的会被收进来，
        // 已收藏的保持不变）；用户把已收藏的取消勾选即表示要取消收藏。
        setChecked(new Set(p.rows.map((_, i) => i)));
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(errMsg(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.source]);

  /** 待收藏 / 待取消收藏（按勾选态与原始收藏态求差） */
  const { toCollect, toRemove } = useMemo(() => {
    const collect: SourceAccountPlaylist[] = [];
    const remove: SourceAccountPlaylist[] = [];
    rows.forEach((row, i) => {
      const want = checked.has(i);
      if (want && !row.favorited) collect.push(row.playlist);
      if (!want && row.favorited) remove.push(row.playlist);
    });
    return { toCollect: collect, toRemove: remove };
  }, [rows, checked]);

  const toggleOne = (index: number): void => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const toggleAll = (): void => {
    setChecked((prev) =>
      prev.size === rows.length ? new Set<number>() : new Set(rows.map((_, i) => i)),
    );
  };

  const apply = (): void => {
    if (busy) return;
    if (toCollect.length === 0 && toRemove.length === 0) return;
    setBusy(true);
    const parts: string[] = [];
    let failed = 0;
    const runCollect = (): Promise<void> =>
      toCollect.length === 0
        ? Promise.resolve()
        : collectAccountPlaylists(props.source, toCollect).then((r) => {
            failed += r.failed;
            if (r.collected > 0) parts.push(`已收藏 ${r.collected} 个`);
            return;
          });
    const runRemove = (): Promise<void> =>
      toRemove.length === 0
        ? Promise.resolve()
        : uncollectAccountPlaylists(props.source, toRemove).then((r) => {
            failed += r.failed;
            if (r.removed > 0) parts.push(`已取消收藏 ${r.removed} 个`);
            return;
          });
    runCollect()
      .then(runRemove)
      .then(() => {
        const summary = parts.length > 0 ? `${parts.join("，")}歌单` : "没有变化";
        if (failed > 0) {
          toastError(`${summary}，${failed} 个失败，可稍后重开同步重试`);
        } else {
          toast(summary);
        }
        props.onDone();
        props.onClose();
      })
      .catch((e) => {
        setBusy(false);
        toastError(`同步失败：${errMsg(e)}`);
      });
  };

  const total = rows.length;
  const favoritedCount = rows.filter((row) => row.favorited).length;
  const changeCount = toCollect.length + toRemove.length;
  const allChecked = total > 0 && checked.size === total;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) props.onClose();
      }}
    >
      <div className="w-[30rem] rounded-2xl border border-white/20 bg-white/70 p-5 text-card-foreground shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-black/40">
        <div className="text-sm font-medium">{props.sourceName} · 同步歌单</div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          拉取该账户在平台侧的全部收藏歌单：勾选 = 收藏到本地「我的歌单」，把「已收藏」的取消勾选
          即从本地移除（只改本地收藏，不影响平台侧）。
        </p>

        {loading ? (
          <p className="mt-4 text-xs text-muted-foreground">正在获取平台侧歌单…</p>
        ) : error !== null ? (
          <p className="mt-4 break-all text-xs text-destructive">{error}</p>
        ) : total === 0 ? (
          <p className="mt-4 text-xs text-muted-foreground">平台侧没有歌单</p>
        ) : (
          <>
            <div className="mt-3 flex items-center justify-between border-b border-border/60 pb-2">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={allChecked}
                  onChange={toggleAll}
                />
                全选（平台侧 {total} 个，已收藏 {favoritedCount} 个）
              </label>
            </div>
            <div className="mt-1 max-h-64 overflow-y-auto">
              {rows.map((row, i) => (
                <label
                  key={row.playlist.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 hover:bg-accent/40"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 shrink-0 accent-primary"
                    checked={checked.has(i)}
                    onChange={() => toggleOne(i)}
                  />
                  {row.playlist.picUrl ? (
                    <img
                      src={row.playlist.picUrl}
                      alt=""
                      referrerPolicy="no-referrer"
                      className="h-8 w-8 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted text-[10px] text-muted-foreground">
                      歌单
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-xs">{row.playlist.name}</span>
                  {row.playlist.trackCount !== undefined ? (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {row.playlist.trackCount} 首
                    </span>
                  ) : null}
                  {row.favorited ? (
                    <span className="shrink-0 rounded border border-primary/40 px-1.5 py-0.5 text-[10px] leading-none text-primary">
                      已收藏
                    </span>
                  ) : null}
                </label>
              ))}
            </div>
          </>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={props.onClose}
            disabled={busy}
            className="h-8 rounded-md border border-border px-3 text-xs hover:bg-accent disabled:opacity-50"
          >
            {loading || error !== null ? "关闭" : "取消"}
          </button>
          {!loading && error === null && total > 0 ? (
            <button
              type="button"
              onClick={apply}
              disabled={busy || changeCount === 0}
              className="h-8 rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "同步中…" : `应用更改（${changeCount}）`}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
