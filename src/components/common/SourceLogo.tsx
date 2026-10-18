import { useSourceColor, useSourceLabel } from "@/stores/sourceRegistry";
import { cn } from "@/lib/utils";

/**
 * 音源平台 id → 官方 logo。
 *
 * 图片是随应用打包的静态资源（`public/static/source/*.png`），运行时不请求图标服务 ——
 * 与移动端 qt-uniappx `static/source/` 同一套文件、同一口径（见该目录 README：
 * wyy / qq / kw / kg / bili 五个平台用各自官方图标，本地与未知音源用应用统一图标占位）。
 *
 * 为什么不能只画个彩色字母：听歌报告的「音源分布」是让用户一眼认出「我主要在哪个
 * 平台听歌」，字母圆片区分度太低（qq 和 kg 都是 q/k 开头）。
 */
const SOURCE_LOGO: Record<string, string> = {
  wyy: "/static/source/wyy.png",
  qq: "/static/source/qq.png",
  kw: "/static/source/kw.png",
  kg: "/static/source/kg.png",
  bili: "/static/source/bili.png",
};

/** 本地曲目与未知音源统一用应用图标占位（与移动端一致） */
const FALLBACK_LOGO = "/app-icon.png";

/** 该音源是否有真实官方 logo（没有的走占位，调用方可据此换文案） */
export function hasSourceLogo(id: string): boolean {
  return SOURCE_LOGO[id] !== undefined;
}

export function sourceLogoUrl(id: string): string {
  return SOURCE_LOGO[id] ?? FALLBACK_LOGO;
}

/**
 * 音源 logo 徽标：真图按 `object-contain` 塞进圆角方块（各家 logo 长宽比不同，
 * cover 会把 kubao 的方 K 裁掉、把 bilibili 的宽标压扁）。
 */
export function SourceLogo(props: {
  platform: string;
  size?: number;
  /** 方形还是圆形：音源分布行用方形，和歌手头像的圆形区分开 */
  shape?: "square" | "circle";
  className?: string;
}): React.JSX.Element {
  const { platform, size = 36, shape = "square" } = props;
  const color = useSourceColor(platform);
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden bg-secondary/60 p-1",
        shape === "circle" ? "rounded-full" : "rounded-lg",
        props.className,
      )}
      style={{
        width: size,
        height: size,
        // 底色取注册表里的音源色，logo 透明背景时不至于糊在白底上
        backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
      }}
      aria-hidden="true"
    >
      <img
        src={sourceLogoUrl(platform)}
        alt=""
        loading="lazy"
        draggable={false}
        className="h-full w-full object-contain"
      />
    </span>
  );
}

/** 音源名 + logo 的组合（报告里「音源分布」的标题位用），带 title 便于长名截断后查看 */
export function SourceLogoLabel(props: { platform: string; size?: number }): React.JSX.Element {
  const label = useSourceLabel(props.platform);
  return (
    <span className="flex min-w-0 items-center gap-2" title={label}>
      <SourceLogo platform={props.platform} size={props.size ?? 20} />
      <span className="truncate">{label}</span>
    </span>
  );
}
