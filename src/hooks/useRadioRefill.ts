import { useEffect } from "react";
import { useRadioStore } from "@/stores/radio";

/**
 * 私人 FM 的补歌心跳（A7）：挂在 AppShell，与 FM 页是否可见无关。
 *
 * 页面 effect 只在 FM 页可见时轮询 —— 页面一关，FM 队列放完就会按普通
 * 队列的规矩绕回旧批次。补歌必须绑定「FM 还持有队列」（`active` +
 * `queueClaimed`），而不是绑定页面，所以心跳挂在这里：每秒调一次
 * `tick()`，由它读播放器余量并按需补歌；队列被换走（用户双击别的歌单/
 * 清空队列）时 tick 会先让位停止，不会往别人的队列里追加。
 */
export function useRadioRefill(): void {
  const active = useRadioStore((s) => s.active);
  const queueClaimed = useRadioStore((s) => s.queueClaimed);
  useEffect(() => {
    if (!active || !queueClaimed) return;
    const timer = window.setInterval(() => {
      void useRadioStore.getState().tick();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active, queueClaimed]);
}
