import { useEffect, useRef, useState } from "react";
import { usePlayerStore } from "@/stores/player";

/**
 * rAF 插值：Rust 每 250ms 推一次 tick，前端每帧
 * position ≈ anchor + (now - anchorTime) 补齐间隙，让进度条与歌词平滑推进。
 */
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
    const loop = (): void => {
      setValue(interpolated());
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [status, interpolated, anchorValue]);

  return value;
}
