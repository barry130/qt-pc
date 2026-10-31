import { useEffect } from "react";
import { useNowPlayingCover } from "@/hooks/useNowPlayingLocalMedia";
import {
  DARK_BACKDROP,
  LIGHT_BACKDROP,
  extractCoverAccent,
  extractCoverColor,
  readableOnBackdrop,
} from "@/lib/skins";

/**
 * 播放页背景映射：把当前播放封面映射为整窗背景素材。
 * - --playing-cover       封面图 url（提供极淡纹理与曲目辨识度）
 * - --playing-cover-color 封面平均主色 rgb()（保留，供其他用途）
 * - --playing-cover-accent 封面醒目主色 hsl()（背景色调的真正来源）
 * - --lyric-hl-light / --lyric-hl-dark 歌词高亮色（同一醒目色按各自底色校过对比度，
 *   由 index.css 按 .dark 分流，所以切主题不需要重算）
 * 与 useCoverColor 解耦：即使「跟随封面取色」关闭，播放页背景仍然映射封面。
 */
export function usePlayingCoverBg(): void {
  // 在播封面口径与播放页一致：本地文件有内嵌封面时用它（useNowPlayingCover），
  // 否则背景色调与页面上的封面会是两张不同的图。
  const cover = useNowPlayingCover();
  const picUrl = cover;

  useEffect(() => {
    const root = document.documentElement;
    if (!picUrl) {
      root.style.removeProperty("--playing-cover");
      root.style.removeProperty("--playing-cover-color");
      root.style.removeProperty("--playing-cover-accent");
      root.style.removeProperty("--lyric-hl-light");
      root.style.removeProperty("--lyric-hl-dark");
      return;
    }

    // useNowPlayingCover 已产出最终 URL（内嵌封面是 data URL，在线封面已过 qtres 代理）
    const url = picUrl;
    if (!url) return;

    let cancelled = false;
    root.style.setProperty("--playing-cover", `url(${url})`);

    void extractCoverColor(url).then((color) => {
      if (!cancelled && color) {
        root.style.setProperty("--playing-cover-color", color);
      }
    });

    void extractCoverAccent(url).then((accent) => {
      if (cancelled || !accent) return;
      root.style.setProperty("--playing-cover-accent", accent);
      // 歌词高亮跟随醒目色，与背景同一色源（否则皮肤红与封面色调打架）。
      // 但不能把 accent 直接当字色：extractCoverAccent 恒输出 hsl(h, 72%, 50%)，
      // 金/黄/青/亮绿这类高亮度色相的 L50 相对亮度高达 0.5 以上，压在浅色主题
      // 的近白底上只有 ~1.8:1（用户 2026-10-30 反馈「正在播放的歌词看不清」，
      // 截图是金黄色封面 + 浅色主题）。这里保留色相与饱和度、只沿明度轴推到
      // 对比度达标，两种主题各算一份交给 CSS 分流。
      const light = readableOnBackdrop(accent, LIGHT_BACKDROP);
      const dark = readableOnBackdrop(accent, DARK_BACKDROP);
      if (light) root.style.setProperty("--lyric-hl-light", light);
      if (dark) root.style.setProperty("--lyric-hl-dark", dark);
    });

    return () => {
      cancelled = true;
      root.style.removeProperty("--playing-cover");
      root.style.removeProperty("--playing-cover-color");
      root.style.removeProperty("--playing-cover-accent");
      root.style.removeProperty("--lyric-hl-light");
      root.style.removeProperty("--lyric-hl-dark");
    };
  }, [picUrl]);
}
