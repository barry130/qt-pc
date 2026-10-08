import { useEffect, useRef, useState } from "react";
import { errMsg } from "@/lib/utils";
import { findCrossSourceDup } from "@/lib/collect-dup";
import { useSourceLabelFn } from "@/stores/sourceRegistry";
import type { MyPlaylistSummary, Track } from "@/types";
import * as ipc from "@/services/ipc";

/**
 * 把一首歌加入「我的歌单」（DESIGN §5.3）。
 * 自包含组件：菜单开关、歌单拉取、加入结果提示都在内部，调用方只需给一首 Track。
 */
export function AddToPlaylistButton(props: {
  track: Track;
}): React.JSX.Element {
  const { track } = props;
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<MyPlaylistSummary[]>([]);
  const [tip, setTip] = useState<string | null>(null);
  /** 「同名不同源」待确认（与播放条收藏同一个口径，见 lib/collect-dup） */
  const [pending, setPending] = useState<{
    playlist: MyPlaylistSummary;
    dups: Track[];
  } | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const sourceLabel = useSourceLabelFn();

  // 展开时才拉取歌单列表，避免列表页首屏就发一堆请求
  useEffect(() => {
    if (!open) return;
    setPending(null);
    void ipc
      .listMyPlaylists()
      // 在线歌单的曲目归音源管，本地加不进去 —— 只列本地歌单
      .then((l) => setList(Array.isArray(l) ? l.filter((p) => p.platform === ipc.LOCAL_PLATFORM) : []))
      .catch(() => setList([]));
  }, [open]);

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
    setTip(null);
    try {
      await ipc.addTracksToPlaylist(p.pid, [track]);
      // 提示行在弹层内（open 为 false 就不渲染），所以先留着弹层把它显示完再收
      setPending(null);
      setTip(`已加入「${p.name}」`);
      window.setTimeout(() => {
        setTip(null);
        setOpen(false);
      }, 800);
    } catch (err) {
      setTip(errMsg(err));
    }
  };

  /** 加入前查一次「同名不同源」：命中就先问一句，确认才真的写入 */
  const add = async (p: MyPlaylistSummary): Promise<void> => {
    setTip(null);
    try {
      const existing = await ipc.getPlaylistTracks(p.pid);
      const dups = findCrossSourceDup(track, existing);
      if (dups.length > 0) {
        setPending({ playlist: p, dups });
        return;
      }
    } catch {
      // 查重失败不拦加入：重复顶多两行，拦住是功能不可用
    }
    await addTo(p);
  };

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        ＋歌单
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 max-h-56 w-44 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md">
          {list.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              还没有歌单，先到「我的歌单」新建一个
            </div>
          ) : (
            list.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void add(p);
                }}
                className="block w-full truncate px-2 py-1 text-left text-xs transition-colors hover:bg-secondary"
              >
                {p.name}
              </button>
            ))
          )}
          {/* 同名不同源确认条：替换掉歌单列表，避免用户在下面又点一个歌单把提示顶掉 */}
          {pending !== null ? (
            <div
              data-testid="addto-dup-confirm"
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
              <div className="mt-1.5 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void addTo(pending.playlist);
                  }}
                  className="flex-1 rounded border border-border px-2 py-1 text-[11px] transition-colors hover:bg-secondary"
                >
                  继续收藏
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPending(null);
                  }}
                  className="flex-1 rounded border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-secondary"
                >
                  取消
                </button>
              </div>
            </div>
          ) : null}
          {tip && (
            <div className="px-2 py-1 text-xs text-muted-foreground">{tip}</div>
          )}
        </div>
      )}
    </div>
  );
}
