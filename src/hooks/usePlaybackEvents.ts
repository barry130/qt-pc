import { useEffect } from "react";
import { usePlayerStore } from "@/stores/player";
import * as ipc from "@/services/ipc";

/**
 * 订阅 Rust 侧播放事件：
 * - playback-state-changed：全量快照（语义变化才推送）
 * - position-changed：250ms tick，配合 rAF 插值
 * - queue-changed：队列列表与当前下标
 * - audio-error：播放失败提示
 */
export function usePlaybackEvents(): void {
  const applySnapshot = usePlayerStore((s) => s.applySnapshot);
  const applyTick = usePlayerStore((s) => s.applyTick);
  const applyQueue = usePlayerStore((s) => s.applyQueue);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let disposed = false;

    const track = async (): Promise<void> => {
      // 监听器就位后引擎是否已推过 queue-changed：推过就信任事件流，
      // 不再用启动时的一次性 getQueue 快照覆盖（那份快照可能更旧）
      let queueEventApplied = false;
      const u1 = await ipc.onPlaybackStateChanged((s) => applySnapshot(s));
      const u2 = await ipc.onPositionChanged((t) => applyTick(t));
      const u3 = await ipc.onQueueChanged((q) => {
        queueEventApplied = true;
        applyQueue(q);
      });
      const u4 = await ipc.onAudioError((e) => {
        console.error("[audio-error]", e.message);
      });
      if (disposed) {
        u1();
        u2();
        u3();
        u4();
        return;
      }
      unlisteners.push(u1, u2, u3, u4);
      // 启动时恢复上次播放现场（队列 + 暂停加载当前曲 + 定位进度）；
      // 无存档则拉默认状态。引擎会随后推送 state/queue 事件，这里先落地快照。
      try {
        const restored = await ipc.restoreLastSession();
        // restored 快照可能取在引擎装曲之前（竞态）：没带曲目就再拉一次实时状态
        const snap =
          restored && restored.track ? restored : await ipc.getPlaybackState();
        applySnapshot(snap);
        if (!queueEventApplied) applyQueue(await ipc.getQueue());
      } catch (err) {
        console.error("restore_last_session failed", err);
      }
    };
    void track();

    return () => {
      disposed = true;
      for (const u of unlisteners) u();
    };
  }, [applySnapshot, applyTick, applyQueue]);
}
