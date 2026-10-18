import { useEffect, useState } from "react";
import { resolveArtistPic, peekArtistPic } from "@/lib/artist-pic";
import { qtresCoverUrl } from "@/lib/lrc";
import { cn } from "@/lib/utils";

/**
 * 歌手名 → 头像 URL 的响应式读取。
 *
 * 首帧优先用同步缓存（`peekArtistPic`）：报告页一进去就有一批歌手，先查缓存能避免
 * 首帧闪一下首字占位；缓存没有才发请求，结果落定后重渲染。
 */
export function useArtistPic(platform: string, name: string): string {
  const [url, setUrl] = useState<string>(() => peekArtistPic(platform, name) ?? "");

  useEffect(() => {
    const cached = peekArtistPic(platform, name);
    if (cached !== null) {
      setUrl(cached);
      return;
    }
    setUrl("");
    let cancelled = false;
    void resolveArtistPic(platform, name).then((next) => {
      if (!cancelled) setUrl(next);
    });
    return () => {
      cancelled = true;
    };
  }, [platform, name]);

  return url;
}

/**
 * 圆形歌手头像：拿到真图就显示，拿不到（或图片 404）回退名字首字。
 *
 * 参考移动端 qt-uniappx pages/stats/index.uvue 的 `artistPic` / `artistImageError`：
 * 加载失败要记住，否则每次重渲染都会再试一次坏链接，控制台一直报错。
 */
export function ArtistAvatar(props: {
  platform: string;
  name: string;
  size?: number;
  className?: string;
}): React.JSX.Element {
  const { platform, name, size = 36 } = props;
  const url = useArtistPic(platform, name);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    setBroken(false);
  }, [url]);

  const initial = Array.from(name.trim())[0] ?? "?";
  // 头像和封面一样走 Rust 的 qtres 代理：CSP 只放开 'self'/qtres，直接把上游
  // https 地址塞进 <img> 会被拦掉（封面早就这么做了，见 lib/lrc.ts qtresCoverUrl）。
  const proxied = qtresCoverUrl(url, Math.round(size * 2)) ?? "";
  const showImage = proxied.length > 0 && !broken;

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10 text-primary",
        props.className,
      )}
      style={{ width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.38)) }}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          src={proxied}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
          onError={() => setBroken(true)}
        />
      ) : (
        initial
      )}
    </span>
  );
}
