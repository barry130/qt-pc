import type { ComponentType, ReactNode } from "react";

import { Play } from "lucide-react";

import { cn } from "@/lib/utils";
import { IconButton } from "@/components/common/IconButton";

/**
 * 详情页 / 曲库页页头（hero）的共享零件。
 *
 * 为什么要收这一套：专辑、歌手、每日新歌、每日推荐、歌单/榜单详情五页的页头是
 * **同一套设计**（模糊封面铺底 + 渐变 + 方形封面 + 小标签 + 大标题 + 计数 +
 * 大号「播放全部」+ 右端批量条），之前是逐字复制了五份。复制带来的问题不是冗长，
 * 而是**改一处忘四处**：换封面圆角、调铺底透明度、改「播放全部」的阴影，都要记得
 * 五个文件；漏一个页头就与其它页不一致。
 *
 * 这里只抽「结构完全一样」的零件，各页自己的内容（简介、口味画像、风格线、
 * 批量条、右端排序控件）留在页面里 —— 那部分本来就不该统一。
 *
 * 两条硬约束（来自于用户 2026-10-24 的明确要求，改动前先读）：
 * 1. **hero 高度由封面定死**：右侧内容不许把页头撑得比封面高，所以信息列都是
 *    `justify-end` + 受控行数（`line-clamp-*` / `truncate`）。
 * 2. **hero 本身不能 `overflow-hidden`**：右端批量条的歌单面板是 `absolute` 展开的，
 *    整块裁切会把面板挡在页头里。裁切只加在铺底图那一层（`HeroBackdrop`）。
 */

/** 铺底：放大 125% 的封面 + 往页面底色过渡的渐变。裁切落在这一层。 */
export function HeroBackdrop(props: { src: string }): React.JSX.Element {
  return (
    <div className="absolute inset-0 overflow-hidden">
      <img
        src={props.src}
        alt=""
        aria-hidden
        draggable={false}
        className="absolute inset-0 h-full w-full scale-125 select-none object-cover opacity-45 blur-3xl saturate-150"
      />
      <div className="absolute inset-0 bg-gradient-to-b from-background/10 to-[color:var(--page-fade)]" />
    </div>
  );
}

/**
 * 方形封面。`size` 跟着页头信息量走：
 * - `md`（h-36 / 144px）专辑、歌手这类只有标题+曲数的页；
 * - `lg`（h-44 / 176px）每日推荐、歌单详情这类右侧信息更多的页。
 *
 * 没封面时退化成首字方块（不是空白灰块）：列表里认封面，详情页认字更快。
 */
export function HeroCover(props: {
  src?: string | null;
  fallback: string;
  size?: "md" | "lg";
}): React.JSX.Element {
  const size = props.size ?? "md";
  return (
    <div
      className={cn(
        "shrink-0 overflow-hidden rounded-2xl bg-secondary shadow-surface ring-1 ring-border",
        size === "lg" ? "h-44 w-44" : "h-36 w-36",
      )}
    >
      {props.src ? (
        <img
          src={props.src}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-4xl font-bold text-muted-foreground/50">
          {props.fallback.slice(0, 1)}
        </span>
      )}
    </div>
  );
}

/** 标题上方的小标签（「专辑」「歌手」「歌单」「榜单」…）。 */
export function HeroEyebrow(props: {
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <p
      className={cn(
        "text-2xs font-medium uppercase tracking-[0.2em] text-muted-foreground",
        props.className,
      )}
    >
      {props.children}
    </p>
  );
}

/** 页头大标题：两行以内截断，不换行把封面比下去。 */
export function HeroTitle(props: {
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <h1 className={cn("mt-1 truncate text-2xl font-bold tracking-tight", props.className)}>
      {props.children}
    </h1>
  );
}

/** 标题下的一行统计（「共 120 首歌」/「显示 30 / 120 首」）。 */
export function HeroMeta(props: {
  children: ReactNode;
  /** 结果集随筛选变化时传，让读屏播报条数变化。 */
  live?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <p
      role={props.live ? "status" : undefined}
      className={cn("mt-1 text-xs text-muted-foreground", props.className)}
    >
      {props.children}
    </p>
  );
}

/** 页头左侧的大号「播放全部」。五页同尺寸同阴影，抽出来防止各页改歪。 */
export function HeroPlayButton(props: {
  onClick: () => void;
  disabled?: boolean;
  icon?: ComponentType<{ className?: string }>;
}): React.JSX.Element {
  const Icon = props.icon ?? Play;
  return (
    <IconButton
      label="播放全部"
      variant="primary"
      size="lg"
      disabled={props.disabled}
      className="h-9 w-9 rounded-lg shadow-lg shadow-primary/25"
      onClick={props.onClick}
    >
      <Icon className="h-4 w-4 fill-current" />
    </IconButton>
  );
}

/**
 * 页头外壳：统一的 `relative shrink-0 border-b border-border` 容器。
 * 传了 `coverUrl` 就自动铺底。**不要在外面再加 overflow-hidden**。
 */
export function DetailHero(props: {
  coverUrl?: string | null;
  children: ReactNode;
  className?: string;
  /** 有些页（每日新歌）不是被推进来的详情页，语义上用 div 更合适。 */
  as?: "header" | "div";
}): React.JSX.Element {
  const Tag = props.as ?? "header";
  return (
    <Tag className={cn("relative shrink-0 border-b border-border", props.className)}>
      {props.coverUrl ? <HeroBackdrop src={props.coverUrl} /> : null}
      {props.children}
    </Tag>
  );
}
