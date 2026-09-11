import { useEffect } from "react";
import { useAppearanceStore } from "@/stores/appearance";
import { usePlayerStore } from "@/stores/player";
import { qtresCoverUrl } from "@/lib/lrc";
import { extractCoverColor, isLightColor } from "@/lib/skins";

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

  useEffect(() => {
    if (!followCoverColor || !picUrl) {
      document.documentElement.style.removeProperty("--cover-primary");
      document.documentElement.style.setProperty("--primary-foreground", "#ffffff");
      return;
    }

    let cancelled = false;
    // picUrl 已由上方 early return 保证非 null
    const currentUrl = qtresCoverUrl(picUrl!);
    void import("@tauri-apps/api/core")
      .then(({ invoke }) =>
        invoke("debug_log", {
          message: `useCoverColor: follow=${followCoverColor} picLen=${picUrl!.length} url=${currentUrl ?? "null"}`,
        }),
      )
      .catch(() => {});
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
