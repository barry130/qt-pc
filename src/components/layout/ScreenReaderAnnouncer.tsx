import { usePlayerStore } from "@/stores/player";

/**
 * 读屏播报（B7 无障碍）：切歌 / 暂停时把「现在在放什么」说出来。
 *
 * 播放条上的歌名是视觉信息，读屏用户停在别处时完全不知道换歌了。
 * 这里挂一条 `role="status"` 的礼貌播报（`aria-live="polite"`）：
 * 只有曲目或播放状态真的变了才改文案，否则读屏会被每秒的心跳快照刷屏
 * （依赖只取 track / status，不取 positionMs）。
 */
export function ScreenReaderAnnouncer(): React.JSX.Element {
  const track = usePlayerStore((s) => s.state?.track ?? null);
  const status = usePlayerStore((s) => s.state?.status ?? "stopped");

  let message = "";
  if (track) {
    const name = track.singer ? `${track.title} - ${track.singer}` : track.title;
    if (status === "playing") message = `正在播放：${name}`;
    else if (status === "paused") message = `已暂停：${name}`;
    else if (status === "loading" || status === "buffering") message = `正在加载：${name}`;
    else if (status === "error") message = `播放失败：${name}`;
  }

  return (
    <div role="status" aria-live="polite" className="sr-only">
      {message}
    </div>
  );
}
