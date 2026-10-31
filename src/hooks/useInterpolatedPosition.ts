import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePlayerStore } from "@/stores/player";

/**
 * rAF 插值：Rust 每 250ms 推一次 tick，前端每帧
 * position ≈ anchor + (now - anchorTime) 补齐间隙，让进度条与歌词平滑推进。
 *
 * 量化（帧率优化，仿 LyricWindow 的量化范式）：裸插值每帧 setValue 会把所有
 * 消费端（进度条 / 播放页 / 迷你播放器）拖进 60fps 重渲染。这里先把插值结果
 * 量化到 100ms 步长再进 state——渲染频率降到 ~10 次/秒，而取整误差上界
 * ±50ms，仍落在播放页「歌词同步误差 ≤ 50ms」的口径内。
 */
const QUANTUM_MS = 100;
const quantizePosition = (ms: number): number => Math.round(ms / QUANTUM_MS) * QUANTUM_MS;

export function useInterpolatedPosition(): number {
  const interpolated = usePlayerStore((s) => s.interpolatedPositionMs);
  const status = usePlayerStore((s) => s.state?.status);
  // 锚点：seek / 切歌 / 每次 tick 都会改写它
  const anchorValue = usePlayerStore((s) => s.positionAnchorValue);
  const [value, setValue] = useState(0);
  // 上一次真正进 state 的量化值。用 ref 而不是 effect 局部变量：rAF 循环与
  // 锚点同步是两处写入，必须共享同一个「已提交值」，否则会各自记账。
  const lastRef = useRef(0);

  /**
   * 锚点突变必须**立刻**落到 state 里，不能只把循环的记账基准改掉。
   *
   * 否则：拖动进度条松手时 seekTo 同步把锚点写到目标（2:00），上层用
   * `pendingSeekMs` 覆盖展示，看起来是对的；但 state 里的 value 还停在旧位置
   * （1:00），rAF 要等量化值跨过下一个 100ms 桶才会 setValue。一旦引擎的确认
   * tick 先到、`pendingSeekMs` 被清掉，展示就退回那个陈旧的 value —— 进度条
   * 瞬间掉回 1:00，几十毫秒后再跳回 2:00，也就是「2 分 → 1 分 → 2 分」。
   *
   * 用 layout effect：在浏览器绘制前就纠正，用户看不到那一帧陈旧值。
   */
  useLayoutEffect(() => {
    const q = quantizePosition(interpolated());
    lastRef.current = q;
    setValue(q);
  }, [interpolated, anchorValue, status]);

  useEffect(() => {
    // 暂停 / 停止态不需要推进（value 由上面的锚点同步负责）
    if (status !== "playing") return;
    const loop = (): void => {
      const next = quantizePosition(interpolated());
      // 量化值没跨过步长就不 setState：这是渲染次数从 60fps 降下来的全部机关
      if (next !== lastRef.current) {
        lastRef.current = next;
        setValue(next);
      }
    };
    // 资源优化（2026-10-30）：原来是 60fps 的 rAF，只为了每 16ms 比对一次
    // 「量化值有没有跨过 100ms 桶」—— 真正落 state 的步长本来就是 QUANTUM_MS，
    // 等于每秒白醒 50 次，而播放条/播放页/迷你窗各有一份。直接按量子步长定时，
    // 唤醒次数降到 1/6；窗口隐藏时浏览器本来就会节流定时器，回来时下一次触发
    // 自然对齐到新位置，不会积累漂移。
    const timer = window.setInterval(loop, QUANTUM_MS);
    return () => window.clearInterval(timer);
  }, [status, interpolated]);

  return value;
}
