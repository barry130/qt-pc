import { useEffect, useRef, useState } from "react";
import { usePlayerStore } from "@/stores/player";

/**
 * rAF 插值：Rust 每 250ms 推一次 tick，前端每帧
 * position ≈ anchor + (now - anchorTime) 补齐间隙，让进度条与歌词平滑推进。
 *
 * 量化（帧率优化，仿 LyricWindow 的量化范式）：裸插值每帧 setValue 会把所有
 * 消费端（进度条 / 播放页 / 迷你播放器）拖进 60fps 重渲染。这里先把插值结果
 * 量化到 100ms 步长再进 state——渲染频率降到 ~10 次/秒，而取整误差上界
 * ±50ms，仍落在播放页「歌词同步误差 ≤ 50ms」的口径内。rAF 循环照旧每帧
 * 跑，seek / 切歌的突变下一帧就会进新桶，不需要额外的突变检测。
 */
const QUANTUM_MS = 100;
const quantizePosition = (ms: number): number => Math.round(ms / QUANTUM_MS) * QUANTUM_MS;

export function useInterpolatedPosition(): number {
  const interpolated = usePlayerStore((s) => s.interpolatedPositionMs);
  const status = usePlayerStore((s) => s.state?.status);
  // 非播放态跟随锚点：暂停时 seek 也要即时反映，否则会停在旧位置
  const anchorValue = usePlayerStore((s) => s.positionAnchorValue);
  const [value, setValue] = useState(0);
  const rafRef = useRef(0);

  useEffect(() => {
    if (status !== "playing") {
      // 暂停/停止时直接显示锚点值，不开 rAF
      setValue(anchorValue);
      return;
    }
    let lastQuantized = quantizePosition(interpolated());
    const loop = (): void => {
      const next = quantizePosition(interpolated());
      // 量化值没跨过步长就不 setState：这是渲染次数从 60fps 降下来的全部机关
      if (next !== lastQuantized) {
        lastQuantized = next;
        setValue(next);
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [status, interpolated, anchorValue]);

  return value;
}
