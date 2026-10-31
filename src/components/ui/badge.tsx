import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * 徽标 / 标签：列表行上的「公告 · 反馈 · 需求」、账号状态「已登录」、
 * 版本号、音质等**一两个词的元信息**。
 *
 * 与 `SourceTag` 的区别：那个是音源平台的品牌标（带 logo 与固定配色），
 * 这个是通用语义标签。与纯文字的 `text-xs text-muted-foreground` 的区别：
 * 徽标有底、有边、有圆角，用户一眼能看出「这是分类」而不是正文。
 *
 * 五档语义：`neutral`（默认，分类）/ `primary`（进行中、自有）/
 * `success`（已通过、已连接）/ `danger`（失败、已删除）/ `outline`（弱化到只剩描边）。
 */
export const badgeVariants = cva(
  "inline-flex max-w-full shrink-0 items-center gap-1 truncate rounded-full border px-2 py-0.5 text-2xs font-medium leading-none",
  {
    variants: {
      tone: {
        neutral: "border-transparent bg-secondary text-secondary-foreground",
        primary: "border-primary/20 bg-primary/10 text-primary",
        success: "border-transparent bg-success/12 text-success",
        danger: "border-transparent bg-destructive/12 text-destructive",
        outline: "border-border bg-transparent text-muted-foreground",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeVariants> & {
    /** 左侧图标（lucide 组件） */
    icon?: React.ReactNode;
  };

export function Badge(props: BadgeProps): React.JSX.Element {
  const { tone, icon, className, children, ...rest } = props;
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...rest}>
      {icon}
      {children}
    </span>
  );
}
