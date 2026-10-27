import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * 空态（UX 审查 No Results 规范）：一个图标 + 一句主文案 + 可选的解释与出口。
 *
 * 为什么要统一：此前 50 多处空态各写各的 `<div className="py-10 text-center
 * text-sm text-muted-foreground">暂无歌曲</div>`，只有灰字、没有视觉锚点，用户
 * 也分不清「还没加载」「真的是空的」「被筛选筛空了」这三种情况。统一后：
 * - 每个空态都有形状（图标 + 主文案），一眼能与「加载中」区分；
 * - 能用 `action` 给出口（去搜索 / 换数据源 / 重新扫描），不再走进死胡同；
 * - `role="status"` 可传，`aria-live` 让读屏在筛选变化后能听到结果条数。
 *
 * 两档外观：
 * - `plain` 纯居中文字，嵌在列表 / 表格内部（不额外画框，避免行内出现套框）；
 * - `block` 虚线卡片，占据卡片位或整页留白（首页推荐位、详情页空列表）。
 */
type EmptyStateProps = {
  /** 可选的图标（lucide 组件），不带则只渲染文字。 */
  icon?: ComponentType<{ className?: string }>;
  /** 主文案，一句话说清「空的是什么」。 */
  title: string;
  /** 解释或下一步提示（可选）。 */
  description?: string;
  /** 出口操作（按钮 / 链接），可选。 */
  action?: ReactNode;
  variant?: "plain" | "block";
  /** 排版尺寸：sm 用于行内小区域，md 用于整页留白。 */
  size?: "sm" | "md";
  /** 错误态用 destructive 着色（与「空」区分开）。 */
  tone?: "muted" | "destructive";
  /** 传 "status" 让读屏播报（筛选后结果数变化时有用）。 */
  role?: "status";
  className?: string;
};

export function EmptyState(props: EmptyStateProps): React.JSX.Element {
  const Icon = props.icon;
  const variant = props.variant ?? "plain";
  const size = props.size ?? "md";
  const tone = props.tone ?? "muted";

  return (
    <div
      role={props.role}
      className={cn(
        "flex flex-col items-center justify-center text-center",
        size === "sm" ? "gap-1.5 py-6" : "gap-2 py-10",
        variant === "block" &&
          "rounded-xl border border-dashed border-border/80 px-4",
        tone === "destructive" ? "text-destructive" : "text-muted-foreground",
        props.className,
      )}
    >
      {Icon ? (
        <Icon
          className={cn(
            "opacity-45",
            size === "sm" ? "h-5 w-5" : "h-7 w-7",
          )}
          aria-hidden
        />
      ) : null}
      <span
        className={cn(
          "font-medium",
          size === "sm" ? "text-xs" : "text-sm",
          // 主文案比说明亮一档：空态里最该被读到的是「空的是什么」。
          tone === "destructive" ? "" : "text-foreground/75",
        )}
      >
        {props.title}
      </span>
      {props.description ? (
        <span className="max-w-sm text-xs text-muted-foreground/80">
          {props.description}
        </span>
      ) : null}
      {props.action ? <div className="pt-1">{props.action}</div> : null}
    </div>
  );
}
