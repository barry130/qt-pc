import { useEffect } from "react";

/**
 * 弹出层通用收起逻辑：点外面 / Esc 收起。
 *
 * 换源、歌词搜索、播放条的音质 / 倍速 / 睡眠定时等弹出层共用这一份——
 * 从 PlayerBar 里提出来就是为了让「新弹层」不用再抄一遍监听，也不会出现
 * 「换源点外面能关、歌词搜索点外面关不掉」这类不一致。
 *
 * 用法：`ref` 要同时包住触发按钮与弹出面板（面板是按钮的子节点时天然满足），
 * 否则点面板自己也会被当成「点在外面」。
 */
export function useDismissOnOutside(
  ref: React.RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [ref, open, onClose]);
}
