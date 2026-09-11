import { useEffect, useRef, useState } from "react";
import { errMsg } from "@/lib/utils";
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
  const ref = useRef<HTMLDivElement | null>(null);

  // 展开时才拉取歌单列表，避免列表页首屏就发一堆请求
  useEffect(() => {
    if (!open) return;
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

  const add = async (p: MyPlaylistSummary): Promise<void> => {
    setTip(null);
    try {
      await ipc.addTracksToPlaylist(p.pid, [track]);
      setTip(`已加入「${p.name}」`);
      window.setTimeout(() => {
        setTip(null);
        setOpen(false);
      }, 800);
    } catch (err) {
      setTip(errMsg(err));
    }
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
          {tip && (
            <div className="px-2 py-1 text-xs text-muted-foreground">{tip}</div>
          )}
        </div>
      )}
    </div>
  );
}
