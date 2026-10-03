import { useEffect, useRef } from "react";
import { useAppearanceStore } from "@/stores/appearance";
import { usePlayerStore } from "@/stores/player";
import { qtresCoverUrl } from "@/lib/lrc";
import { extractCoverColor, isLightColor } from "@/lib/skins";
import { applySkinPrimaryForeground } from "@/hooks/useAppearanceEffect";

/**
 * 跟随封面取色（R7 followCoverColor）：
 * 当 followCoverColor 开启且有播放曲目时，提取封面主色，
 * 设置为 --cover-primary CSS 变量。
 * useAppearanceEffect 在 followCoverColor 模式下会引用该变量作为 --primary。
 * 同时根据颜色明暗自动调整 --primary-foreground。
 */
export function useCoverColor(): void {
  const followCoverColor = useAppearanceStore(
    (s) => s.preference.followCoverColor,
  );
  const picUrl = usePlayerStore((s) => s.state?.track?.picUrl ?? null);
  // 上一轮是否处于「跟随封面」态：离开跟随态时才需要交还 --primary-foreground
  // 的管理权（按皮肤主色明度重算），首次挂载/本就未跟随时绝不能动它 ——
  // 本 effect 在 useAppearanceEffect 之后注册执行，无条件写 #ffffff 会把
  // 皮肤亮主色配深色前景的可读性修复（森林/暖阳等 1.7~2.3:1）永远覆盖掉。
  const wasFollowingRef = useRef(false);

  useEffect(() => {
    if (!followCoverColor || !picUrl) {
      document.documentElement.style.removeProperty("--cover-primary");
      if (wasFollowingRef.current) {
        // 刚离开跟随态：useAppearanceEffect 不会重跑（其依赖没变），上一轮按
        // 封面明度可能设了深色前景，须按皮肤口径恢复
        applySkinPrimaryForeground(useAppearanceStore.getState().preference);
      }
      wasFollowingRef.current = false;
      return;
    }
    wasFollowingRef.current = true;

    let cancelled = false;
    // picUrl 已由上方 early return 保证非 null
    const currentUrl = qtresCoverUrl(picUrl!);
    if (!currentUrl) return;

    extractCoverColor(currentUrl).then((color) => {
      if (cancelled || !color) return;
      document.documentElement.style.setProperty("--cover-primary", color);

      // 根据颜色明暗自动调整前景色，保证按钮文字可读
      const match = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
      if (match) {
        const r = parseInt(match[1]);
        const g = parseInt(match[2]);
        const b = parseInt(match[3]);
        document.documentElement.style.setProperty(
          "--primary-foreground",
          isLightColor(r, g, b) ? "#1a1a1a" : "#ffffff",
        );
      }
    });

    return () => {
      cancelled = true;
    };
  }, [followCoverColor, picUrl]);
}
