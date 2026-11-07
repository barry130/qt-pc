import { useEffect } from "react";
import { currentLiveRevision, usePlayerStore } from "@/stores/player";
import * as ipc from "@/services/ipc";
import { log } from "@/lib/logger";

/** 订阅播放事件；附属窗口只拉实时快照，主窗口负责启动时恢复会话。 */
export function usePlaybackEvents(
  options: { restoreSession?: boolean } = {},
): void {
  const restoreSession = options.restoreSession ?? true;
  const applySnapshot = usePlayerStore((s) => s.applySnapshot);
  const applyTick = usePlayerStore((s) => s.applyTick);
  const applyQueue = usePlayerStore((s) => s.applyQueue);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let disposed = false;
    let stateEventApplied = false;
    let queueEventApplied = false;
    const subscribe = async (pending: Promise<() => void>): Promise<boolean> => {
      const unlisten = await pending;
      if (disposed) {
        unlisten();
        return false;
      }
      unlisteners.push(unlisten);
      return true;
    };

    const track = async (): Promise<void> => {
      // 四个监听互不依赖，一次并发注册（此前逐个 await，首帧多付三次 IPC 往返）
      const registered = await Promise.all([
        subscribe(ipc.onPlaybackStateChanged((s) => {
          stateEventApplied = true;
          if (!disposed) applySnapshot(s);
        })),
        subscribe(ipc.onPositionChanged((t) => {
          if (!disposed) applyTick(t);
        })),
        subscribe(ipc.onQueueChanged((q) => {
          queueEventApplied = true;
          if (!disposed) applyQueue(q);
        })),
        subscribe(ipc.onAudioError((e) => {
          const detail = `[audio-error] ${e.kind} ${e.trackId ?? "-"}：${e.message}`;
          if (e.stalled) log.warn(detail);
          else log.error(detail);
        })),
      ]);
      if (disposed || registered.some((ok) => !ok)) return;
      try {
        // 恢复只是 fallback：请求发出后只要收到过实时事件（快照 / tick / 队列），
        // 迟到的恢复响应就是旧值。纯原生路径（SMTC / 热键 / 自动切歌）不经过
        // JS 的播放动作代次，所以这里用实时事件版本号而不是 id 比较（ABA 也安全）。
        const revisionAtRequest = currentLiveRevision();
        const restored = restoreSession ? await ipc.restoreLastSession() : null;
        if (disposed) return;
        const snap = restored?.track ? restored : await ipc.getPlaybackState();
        // 事件是真值，不能被请求发出后才返回的旧快照覆盖。
        if (
          !disposed &&
          !stateEventApplied &&
          currentLiveRevision() === revisionAtRequest
        ) {
          applySnapshot(snap);
        }
      } catch (err) {
        log.warn(restoreSession ? "restore_last_session failed" : "get_playback_state failed", err);
      }
      if (disposed || queueEventApplied) return;
      try {
        const queue = await ipc.getQueue();
        if (!disposed && !queueEventApplied) applyQueue(queue);
      } catch (err) {
        log.warn("get_queue failed", err);
      }
    };
    void track().catch((err: unknown) => log.warn("playback event subscription failed", err));
    return () => {
      disposed = true;
      for (const u of unlisteners) u();
    };
  }, [applySnapshot, applyTick, applyQueue, restoreSession]);
}
