import { useEffect, useState } from "react";
import { accountSyncPreview, collectAccountPlaylists } from "@/lib/source-playlist-sync";
import type { SourceAccountPlaylist } from "@/source-scripts";
import { toast, toastError } from "@/stores/toast";
import { errMsg } from "@/lib/utils";

/**
 * 账户歌单同步弹窗（2026-10-26 需求）：打开即拉「平台侧收藏歌单 vs 本地已
 * 收藏在线歌单」差集（accountSyncPreview），缺失项勾选后一键收藏
 * （collectAccountPlaylists）。包旧/未登录/平台不支持的错误文案原样展示
 * （版本提示由 source-scripts 包装层给出）。遮罩/面板样式与
 * ImportPlaylistDialog 同款。
 */
export function SourcePlaylistSyncDialog(props: {
  source: string;
  sourceName: string;
  onClose: () => void;
  /** 收藏动作完成（含部分失败）后回调：页面借此刷新 */
  onDone: () => void;
}): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ missing: SourceAccountPlaylist[]; total: number } | null>(
    null,
  );
  /** 勾选的行下标（missing 是打开期间不变的快照，下标即可当勾选键） */
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    accountSyncPreview(props.source)
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
        setSelected(new Set(p.missing.map((_, i) => i)));
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

  const toggleOne = (index: number): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const toggleAll = (): void => {
    if (preview === null) return;
    setSelected((prev) =>
      prev.size === preview.missing.length
        ? new Set<number>()
        : new Set(preview.missing.map((_, i) => i)),
    );
  };

  const collect = (): void => {
    if (preview === null || busy) return;
    const picks = preview.missing.filter((_, i) => selected.has(i));
    if (picks.length === 0) return;
    setBusy(true);
    collectAccountPlaylists(props.source, picks)
      .then((r) => {
        if (r.failed > 0) {
          toastError(`已收藏 ${r.collected} 个歌单，${r.failed} 个失败，可稍后重开同步重试`);
        } else {
          toast(`已收藏 ${r.collected} 个歌单`);
        }
        props.onDone();
        props.onClose();
      })
      .catch((e) => {
        setBusy(false);
        toastError(`同步失败：${errMsg(e)}`);
      });
  };

  const missing = preview?.missing ?? [];
  const pickCount = selected.size;

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
          拉取该账户在平台侧的收藏歌单，与本地已收藏的在线歌单对比，勾选补收藏缺失项。
        </p>

        {loading ? (
          <p className="mt-4 text-xs text-muted-foreground">正在获取平台侧歌单…</p>
        ) : error !== null ? (
          <p className="mt-4 break-all text-xs text-destructive">{error}</p>
        ) : missing.length === 0 ? (
          <p className="mt-4 text-xs text-muted-foreground">
            {preview !== null && preview.total === 0 ? "平台侧没有歌单" : "平台侧歌单都已在本地收藏"}
          </p>
        ) : (
          <>
            <div className="mt-3 flex items-center justify-between border-b border-border/60 pb-2">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={pickCount === missing.length}
                  onChange={toggleAll}
                />
                全选（缺失 {missing.length} / 平台侧 {preview?.total ?? 0}）
              </label>
            </div>
            <div className="mt-1 max-h-64 overflow-y-auto">
              {missing.map((p, i) => (
                <label
                  key={p.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 hover:bg-accent/40"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 shrink-0 accent-primary"
                    checked={selected.has(i)}
                    onChange={() => toggleOne(i)}
                  />
                  {p.picUrl ? (
                    <img
                      src={p.picUrl}
                      alt=""
                      referrerPolicy="no-referrer"
                      className="h-8 w-8 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted text-[10px] text-muted-foreground">
                      歌单
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-xs">{p.name}</span>
                  {p.trackCount !== undefined ? (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {p.trackCount} 首
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
          {!loading && error === null && missing.length > 0 ? (
            <button
              type="button"
              onClick={collect}
              disabled={busy || pickCount === 0}
              className="h-8 rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "收藏中…" : `收藏所选（${pickCount}）`}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
