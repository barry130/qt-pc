import { useEffect } from "react";
import { usePlayerStore } from "@/stores/player";
import { qtresCoverUrl } from "@/lib/lrc";
import { extractCoverAccent, extractCoverColor } from "@/lib/skins";

/**
 * 播放页背景映射：把当前播放封面映射为整窗背景素材。
 * - --playing-cover       封面图 url（提供极淡纹理与曲目辨识度）
 * - --playing-cover-color 封面平均主色 rgb()（保留，供其他用途）
 * - --playing-cover-accent 封面醒目主色 hsl()（背景色调的真正来源）
 * 与 useCoverColor 解耦：即使「跟随封面取色」关闭，播放页背景仍然映射封面。
 */
export function usePlayingCoverBg(): void {
  const picUrl = usePlayerStore((s) => s.state?.track?.picUrl ?? null);

  useEffect(() => {
    const root = document.documentElement;
    if (!picUrl) {
      root.style.removeProperty("--playing-cover");
      root.style.removeProperty("--playing-cover-color");
      root.style.removeProperty("--playing-cover-accent");
      return;
    }

    const url = qtresCoverUrl(picUrl);
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
      // 歌词高亮跟随醒目色，与背景同一色源（否则皮肤红与封面色调打架）
      root.style.setProperty("--lyric-highlight", accent);
    });

    return () => {
      cancelled = true;
      root.style.removeProperty("--playing-cover");
      root.style.removeProperty("--playing-cover-color");
      root.style.removeProperty("--playing-cover-accent");
      root.style.removeProperty("--lyric-highlight");
    };
  }, [picUrl]);
}
