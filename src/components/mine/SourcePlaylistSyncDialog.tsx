import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  accountSyncPreview,
  collectAccountPlaylists,
  isAccountSyncNeedsMetaLoginError,
  uncollectAccountPlaylists,
  type AccountSyncRow,
} from "@/lib/source-playlist-sync";
import { setSourceAuthToggle } from "@/lib/source-auth";
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
 *
 * 2026-10-27 增：用户报「bili 明明登录了，点同步歌单报未登录」——根因是账号页
 * 的「数据请求使用登录态」开关关着，宿主没把凭据灌进数据包 meta 面，包侧因此
 * 回「未登录」。此时不把误导文案直接摊出来，而是给可操作面板
 * 「开启并使用登录态同步」：一键开开关（setSourceAuthToggle）→ 自动重试预览。
 */
export function SourcePlaylistSyncDialog(props: {
  source: string;
  sourceName: string;
  onClose: () => void;
  /** 收藏/取消收藏动作完成（含部分失败）后回调：页面借此刷新 */
  onDone: () => void;
  /** 弹窗内把「数据请求使用登录态」开关打开后回调：页面借此同步开关态 */
  onMetaLoginEnabled?: (source: string) => void;
}): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 已登录但「数据请求使用登录态」关着 —— 可一键开启后重试 */
  const [metaLoginOff, setMetaLoginOff] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [rows, setRows] = useState<AccountSyncRow[]>([]);
  /** 勾选集合（下标 = rows 下标；打开期间 rows 是不变快照）。初值 = 全部勾上 */
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);
  /** 预览请求序号：一键开启重试 / 换源时丢弃过期应答 */
  const loadSeq = useRef(0);

  const load = useCallback((): void => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    setMetaLoginOff(false);
    accountSyncPreview(props.source)
      .then((p) => {
        if (seq !== loadSeq.current) return;
        setRows(p.rows);
        // 勾选语义 = 「希望它在本地我的歌单里」：默认全勾（未收藏的会被收进来，
        // 已收藏的保持不变）；用户把已收藏的取消勾选即表示要取消收藏。
        setChecked(new Set(p.rows.map((_, i) => i)));
        setLoading(false);
      })
      .catch((e) => {
        if (seq !== loadSeq.current) return;
        if (isAccountSyncNeedsMetaLoginError(e)) setMetaLoginOff(true);
        else setError(errMsg(e));
        setLoading(false);
      });
  }, [props.source]);

  useEffect(() => {
    load();
    return () => {
      loadSeq.current += 1;
    };
  }, [load]);

  /** 一键开启「数据请求使用登录态」并重试预览 */
  const enableMetaAndRetry = (): void => {
    if (enabling) return;
    setEnabling(true);
    setSourceAuthToggle(props.source, "meta", true)
      .then(() => {
        setEnabling(false);
        props.onMetaLoginEnabled?.(props.source);
        load();
      })
      .catch((e) => {
        setEnabling(false);
        toastError(`开启失败：${errMsg(e)}`);
      });
  };

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
      <div className="w-[30rem] rounded-2xl border border-white/20 bg-white/70 p-5 text-card-foreground shadow-overlay backdrop-blur-xl dark:border-white/10 dark:bg-black/40">
        <div className="text-sm font-medium">{props.sourceName} · 同步歌单</div>
        <p className="mt-1 text-2xs text-muted-foreground">
          拉取该账户在平台侧的全部收藏歌单：勾选 = 收藏到本地「我的歌单」，把「已收藏」的取消勾选
          即从本地移除（只改本地收藏，不影响平台侧）。
        </p>

        {loading ? (
          <p className="mt-4 text-xs text-muted-foreground">正在获取平台侧歌单…</p>
        ) : metaLoginOff ? (
          <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
            <p className="text-xs text-amber-800 dark:text-amber-200">
              该账户已登录，但「数据请求使用登录态」是关闭的——读取平台侧歌单需要用它把凭证交给数据请求，关闭时只会报「未登录」。
            </p>
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={enableMetaAndRetry}
                disabled={enabling}
                className="h-8 rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {enabling ? "开启中…" : "开启并使用登录态同步"}
              </button>
            </div>
          </div>
        ) : error !== null ? (
          <>
            <p className="mt-4 break-all text-xs text-destructive">{error}</p>
            {/未登录|未登陆/.test(error) ? (
              <p className="mt-2 text-2xs text-muted-foreground">
                账号卡显示「已登录」却仍报未登录，通常是登录态已失效：请在账号卡上重新登录后再试。
              </p>
            ) : null}
          </>
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
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted text-3xs text-muted-foreground">
                      歌单
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-xs">{row.playlist.name}</span>
                  {row.playlist.trackCount !== undefined ? (
                    <span className="shrink-0 text-2xs text-muted-foreground">
                      {row.playlist.trackCount} 首
                    </span>
                  ) : null}
                  {row.favorited ? (
                    <span className="shrink-0 rounded border border-primary/40 px-1.5 py-0.5 text-3xs leading-none text-primary">
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
            {loading || error !== null || metaLoginOff ? "关闭" : "取消"}
          </button>
          {!loading && error === null && !metaLoginOff && total > 0 ? (
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
