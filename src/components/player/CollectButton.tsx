import { useCallback, useEffect, useRef, useState } from "react";
import { errMsg } from "@/lib/utils";
import { Check, Heart, Plus } from "lucide-react";
import { findCrossSourceDup } from "@/lib/collect-dup";
import { useSourceLabelFn } from "@/stores/sourceRegistry";
import type { MyPlaylistSummary, Track } from "@/types";
import * as ipc from "@/services/ipc";

/**
 * 收藏选择器（播放条上的红心）。
 *
 * 收藏不能脱离歌单：点开是**本地歌单清单**（含「我喜欢的歌曲」），
 * 每点一行即在「收藏 / 取消收藏」之间切换 —— 与 qt-uniappx 的
 * `pickerPlaylists()` + `applyPickerSelection()` 同口径。
 * 一首歌只属于一个歌单（后端 `UNIQUE(uid, platform, sid)`），
 * 所以勾上新的会把旧的放开。
 */
export function CollectButton(props: { track: Track | null }): React.JSX.Element {
  const { track } = props;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<MyPlaylistSummary[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  /**
   * 「同名不同源」待确认：目标歌单里已经有另一平台的同一首歌时先拦一下，
   * 用户点「继续收藏」才真的写入（收藏表按 platform+id 唯一，两首能共存，
   * 界面上就是重复的两行 —— 加入前提示比加完再删轻松得多）。
   */
  const [pending, setPending] = useState<{
    playlist: MyPlaylistSummary;
    dups: Track[];
  } | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const sourceLabel = useSourceLabelFn();

  // 当前曲目是否已被收藏（面板没开时也要能点亮红心）
  const [liked, setLiked] = useState(false);
  useEffect(() => {
    if (!track) {
      setLiked(false);
      return;
    }
    let cancelled = false;
    void ipc
      .isFavorite(track)
      .then((v) => {
        if (!cancelled) setLiked(v);
      })
      .catch(() => {
        if (!cancelled) setLiked(false);
      });
    return () => {
      cancelled = true;
    };
  }, [track]);

  const reload = useCallback(async (): Promise<void> => {
    if (!track) return;
    const [all, inLists] = await Promise.all([
      ipc.listMyPlaylists(),
      ipc.listTrackPlaylists(track),
    ]);
    // 可作为收藏目标：本地自建歌单 + 云端 local 卡片（「我喜欢的歌曲」等，
    // 曲目落本地 liked_songs）；在线音源歌单的曲目归音源管，加不进去
    setItems(all.filter((p) => p.platform === ipc.LOCAL_PLATFORM));
    setSelected(inLists);
  }, [track]);

  // 展开才拉数据：播放条常驻，别在首屏就发请求
  useEffect(() => {
    if (!open || !track) return;
    setError(null);
    void reload().catch((err: unknown) => {
      setError(errMsg(err));
    });
  }, [open, track, reload]);

  // 曲目切了就把面板收起，避免对着上一首歌操作
  // （pending 也必须一起清：待确认的是上一首歌的重名，留着会确认错对象）
  useEffect(() => {
    setOpen(false);
    setPending(null);
  }, [track]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const addTo = async (p: MyPlaylistSummary): Promise<void> => {
    if (!track || busy) return;
    setBusy(true);
    setError(null);
    try {
      await ipc.addFavorite(track, p.pid);
      await reload();
      // 归属变了，红心状态以库里的为准
      setLiked(await ipc.isFavorite(track).catch(() => false));
      setPending(null);
      setOpen(false);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (p: MyPlaylistSummary): Promise<void> => {
    if (!track || busy) return;
    // 取消收藏不需要查重：那是减操作，不会造成重复
    if (selected.includes(p.pid)) {
      setBusy(true);
      setError(null);
      try {
        await ipc.removeFavorite(track, p.pid);
        await reload();
        setLiked(await ipc.isFavorite(track).catch(() => false));
      } catch (err) {
        setError(errMsg(err));
      } finally {
        setBusy(false);
      }
      return;
    }
    // 加入前查一次重：歌单里已有别的音源的同一首歌就先问一句
    setBusy(true);
    setError(null);
    try {
      const existing = await ipc.getPlaylistTracks(p.pid);
      const dups = findCrossSourceDup(track, existing);
      if (dups.length > 0) {
        setPending({ playlist: p, dups });
        return;
      }
    } catch {
      // 查重失败不拦收藏：重复顶多是两行，拦住是功能不可用。按没查到处理
    } finally {
      setBusy(false);
    }
    await addTo(p);
  };

  const createAndCollect = async (): Promise<void> => {
    const n = newName.trim();
    if (!track || !n || busy) return;
    // 新建的歌单必然是空的，不需要查重
    setBusy(true);
    setError(null);
    try {
      // createPlaylist 返回的就是新歌单的永久 pid（已上送云端登记）
      const pid = await ipc.createPlaylist(n);
      setNewName("");
      await ipc.addFavorite(track, pid);
      await reload();
      setLiked(true);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="收藏到歌单"
        title="收藏到歌单"
        disabled={!track}
        onClick={() => setOpen((v) => !v)}
        className={[
          "flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-secondary/50",
          liked ? "text-primary" : "text-foreground/80",
          !track && "cursor-not-allowed opacity-40",
        ].join(" ")}
      >
        <Heart className={liked ? "h-4 w-4 fill-current" : "h-4 w-4"} />
      </button>

      {open && (
        <div className="absolute bottom-full left-1/2 z-30 mb-2 w-56 -translate-x-1/2 rounded-xl border border-border bg-popover/95 p-1 text-popover-foreground shadow-2xl backdrop-blur-xl">
          <div className="px-2 py-1 text-xs text-muted-foreground">
            收藏到歌单
          </div>
          <div className="max-h-56 overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-2 py-2 text-xs text-muted-foreground">
                还没有本地歌单，下面新建一个
              </div>
            ) : (
              items.map((p) => {
                // 打勾按 pid 对（selected 里存的是歌单的永久 pid）
                const on = selected.includes(p.pid);
                return (
                  <button
                    key={p.pid}
                    type="button"
                    disabled={busy}
                    onClick={() => void toggle(p)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary disabled:opacity-50"
                  >
                    <Check
                      className={[
                        "h-3.5 w-3.5 shrink-0",
                        on ? "text-primary" : "text-transparent",
                      ].join(" ")}
                    />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {p.trackCount}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {/* 同名不同源确认条：替换掉歌单列表，避免用户在下面又点另一个歌单
              把这个提示顶掉（确认错对象） */}
          {pending !== null ? (
            <div
              data-testid="collect-dup-confirm"
              className="border-t border-border px-2 py-2"
            >
              <p className="text-[11px] leading-snug text-foreground/90">
                「{pending.playlist.name}」里已经有了
                {pending.dups.length > 1 ? ` ${pending.dups.length} 首` : ""}同名的
                {sourceLabel(pending.dups[0].platform)}版本
                {pending.dups.length === 1 ? (
                  <span className="text-muted-foreground">
                    （{pending.dups[0].singer}）
                  </span>
                ) : null}
                ，仍要收藏？
              </p>
              <div className="mt-2 flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void addTo(pending.playlist)}
                  className="flex-1 rounded border border-border px-2 py-1 text-[11px] transition-colors hover:bg-secondary disabled:opacity-50"
                >
                  继续收藏
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPending(null)}
                  className="flex-1 rounded border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-secondary disabled:opacity-50"
                >
                  取消
                </button>
              </div>
            </div>
          ) : null}

          <div className="mt-1 flex items-center gap-1 border-t border-border pt-1">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void createAndCollect();
              }}
              placeholder="新建歌单并收藏"
              className="h-7 min-w-0 flex-1 rounded border border-input bg-background px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            <button
              type="button"
              disabled={!newName.trim() || busy}
              onClick={() => void createAndCollect()}
              aria-label="新建歌单并收藏"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border transition-colors hover:bg-secondary disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>

          {error && (
            <div className="px-2 py-1 text-[11px] text-destructive">{error}</div>
          )}
        </div>
      )}
    </div>
  );
}
