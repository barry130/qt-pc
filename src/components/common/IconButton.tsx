import { cn } from "@/lib/utils";

/**
 * 图标按钮：列表行 / 工具条 / 页头的统一操作外观。
 *
 * 全应用的操作入口统一走图标（文字进 title + aria-label），不再让
 * 「下载 / ＋歌单 / 移除 / 批量删除」这类词把行撑宽。三档外观：
 * - ghost   无边框，列表行与面板工具条；
 * - outline 带边框的次级操作（工具条上的全局动作）；
 * - primary 页头主操作，保留实心主色。
 *
 * label 是图标按钮唯一的可读文本，必填：同时写进 title 与 aria-label，
 * 保证鼠标悬停与读屏都能知道这个图标是干什么的。
 */
export function IconButton(props: {
  /** 无障碍名称 + 悬浮提示（图标按钮唯一可读文本） */
  label: string;
  children: React.ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  variant?: "ghost" | "outline" | "primary";
  /** sm = 列表行（22px，对齐 RowActions）；md = 工具条（28px）；lg = 页头（32px） */
  size?: "sm" | "md" | "lg";
  /** 悬停底色：列表行用 background，面板 / 工具条用 secondary */
  hover?: "background" | "secondary";
  /** 危险操作（删除类）悬停变红 */
  danger?: boolean;
  className?: string;
  ariaExpanded?: boolean;
  ariaHasPopup?: "menu" | "listbox" | "dialog";
}): React.JSX.Element {
  const {
    variant = "ghost",
    size = "sm",
    hover = "background",
    danger = false,
  } = props;

  const sizeClass =
    size === "sm"
      ? "p-1 [&_svg]:h-3.5 [&_svg]:w-3.5"
      : size === "md"
        ? "h-7 w-7 [&_svg]:h-3.5 [&_svg]:w-3.5"
        : "h-8 w-8 [&_svg]:h-4 [&_svg]:w-4";

  const hoverClass = hover === "background" ? "hover:bg-background" : "hover:bg-secondary";

  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      aria-expanded={props.ariaExpanded}
      aria-haspopup={props.ariaHasPopup}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        "flex shrink-0 items-center justify-center transition-colors disabled:opacity-50",
        sizeClass,
        variant === "primary"
          ? "rounded-md bg-primary font-medium text-primary-foreground hover:opacity-90"
          : variant === "outline"
            ? cn(
                "rounded-md border border-border text-muted-foreground",
                hoverClass,
                danger ? "hover:text-destructive" : "hover:text-foreground",
              )
            : cn(
                "rounded text-muted-foreground",
                hoverClass,
                danger ? "hover:text-destructive" : "hover:text-foreground",
              ),
        props.className,
      )}
    >
      {props.children}
    </button>
  );
}
