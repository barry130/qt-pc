import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 加载指示器。
 *
 * 此前全仓 9 处自己写 `<Loader2 className="h-3.5 w-3.5 animate-spin" />`，
 * 尺寸各写各的（3.0 / 3.5 / 4.0），读屏也没有可读文案。这里统一成四档尺寸 +
 * `role="status"`：按钮里的加载（`xs`/`sm`）、面板与空态里的加载（`md`/`lg`）。
 *
 * 用法：
 * - 按钮内加载别自己塞图标，用 `<Button loading>`；
 * - 整块区域加载用 `EmptyState` 或 `Skeleton`，本组件只表示「这一点在转圈」。
 */
const SIZE_CLASS = {
  xs: "h-3 w-3",
  sm: "h-3.5 w-3.5",
  md: "h-4 w-4",
  lg: "h-5 w-5",
} as const;

export type SpinnerSize = keyof typeof SIZE_CLASS;

export function Spinner(props: {
  size?: SpinnerSize;
  /** 读屏播报的文案，默认「加载中」 */
  label?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <Loader2
      role="status"
      aria-label={props.label ?? "加载中"}
      className={cn("shrink-0 animate-spin", SIZE_CLASS[props.size ?? "sm"], props.className)}
    />
  );
}

/**
 * 列表/区块的「加载中」占位：一个小转圈 + 一行灰字，居中。
 *
 * 为什么要独立于 EmptyState：用户必须能一眼区分「还没加载完」和「真的没有数据」。
 * 以前两者都是同样的灰字 `py-10 text-center`，看起来一模一样。
 */
export function LoadingState(props: {
  label?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground",
        props.className,
      )}
    >
      <Spinner size="sm" label={props.label ?? "加载中"} />
      <span>{props.label ?? "加载中…"}</span>
    </div>
  );
}
