import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Spinner, type SpinnerSize } from "./spinner";

/**
 * 文字按钮（本仓唯一的按钮外观来源）。
 *
 * 为什么要有它：审计时全仓有 **66 种**互不相同的 `<button className="...">`，
 * 其中「次级操作」这一类就长出了 9 种写法（`px-3 py-1.5 text-xs` 与
 * `h-8 px-3 text-xs` 混用、`rounded-md` 与 `rounded-full` 混用、有的带
 * `transition-colors` 有的不带）。同一排按钮在设置页与账号页里高度都不一样。
 *
 * 六档语义（不是六种颜色，是六个「这句话有多重要」）：
 * - `primary`   页面/弹窗里的主操作，一屏最多一个；
 * - `secondary` 常规操作（默认档），实心浅底，成组出现时也不喧宾夺主；
 * - `outline`   次级操作，描边 + 透明底，适合与 `primary` 并排；
 * - `ghost`     无底无边，工具条、行内「取消/更多」这类；
 * - `danger`    破坏性操作（删除、清空、退出登录）；
 * - `link`      文字链接（「查看全部」「去设置」），不占高度。
 *
 * 尺寸四档：`xs` 26px（表格行内）、`sm` 32px（默认）、`md` 36px、`lg` 40px（表单主按钮）。
 *
 * 图标只用 `icon` / `iconRight` 传，别在 children 里混 `<svg>`——那样按钮的
 * gap 与图标尺寸会各写各的。纯图标按钮请用 `IconButton`（带 label 便于读屏）。
 */
export const buttonVariants = cva(
  [
    "inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap font-medium",
    "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
    "disabled:pointer-events-none disabled:opacity-50",
  ].join(" "),
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:bg-primary/90",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        outline:
          "border border-border bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground",
        ghost: "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        danger: "bg-destructive/10 text-destructive hover:bg-destructive/20",
        link: "h-auto p-0 text-primary underline-offset-2 hover:underline",
      },
      size: {
        xs: "h-[1.625rem] rounded-md px-2 text-2xs",
        sm: "h-8 rounded-md px-3 text-xs",
        md: "h-9 rounded-lg px-4 text-sm",
        lg: "h-10 rounded-lg px-5 text-sm",
      },
      shape: {
        rect: "",
        /** 胶囊形（更新提示、公告条这类浮层里的按钮） */
        pill: "rounded-full",
        /** 撑满容器（表单底部、「登录」这类单按钮布局） */
        block: "w-full",
      },
    },
    defaultVariants: { variant: "secondary", size: "sm", shape: "rect" },
  },
);

/** 需要给原生元素（如 `<a>`、路由 `<Link>`）套按钮样式时用它 */
export function buttonClass(
  options?: VariantProps<typeof buttonVariants> & { className?: string },
): string {
  const { className, ...variants } = options ?? {};
  return cn(buttonVariants(variants), className);
}

const LOADING_SPINNER: Record<string, SpinnerSize> = {
  xs: "xs",
  sm: "sm",
  md: "md",
  lg: "md",
};

export type ButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> &
  VariantProps<typeof buttonVariants> & {
    /** 加载中：自动禁用并替换左侧图标 */
    loading?: boolean;
    /** 左侧图标（lucide 组件，尺寸由按钮托管） */
    icon?: React.ReactNode;
    /** 右侧图标（如「更多」的 ChevronRight） */
    iconRight?: React.ReactNode;
    children?: React.ReactNode;
  };

export function Button(props: ButtonProps): React.JSX.Element {
  const {
    variant,
    size = "sm",
    shape,
    loading = false,
    icon,
    iconRight,
    className,
    disabled,
    type = "button",
    children,
    ...rest
  } = props;

  return (
    <button
      type={type}
      disabled={disabled === true || loading}
      className={cn(buttonVariants({ variant, size, shape }), className)}
      {...rest}
    >
      {loading ? <Spinner size={LOADING_SPINNER[size ?? "sm"]} label="处理中" /> : icon}
      {children}
      {iconRight}
    </button>
  );
}
