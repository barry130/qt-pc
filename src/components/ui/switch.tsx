import { cn } from "@/lib/utils";

/**
 * 开关（`role="switch"`）。
 *
 * 原先定义在 `settings/controls.tsx`，于是设置页之外的开关（桌面歌词、音源账号、
 * 下载设置）各写了一遍，尺寸与轨道颜色都不统一。这里作为唯一实现：
 * 轨道 36×20、滑块 16、开启用 `bg-primary`、关闭用 `bg-muted-foreground/30`，
 * 位移用 `duration-base`（关掉动效时全局 `.reduce-motion *` 会兜住）。
 *
 * 只有「立即生效的开关」才用它；需要提交后生效的用 `Checkbox` 或 `Button` 更诚实。
 */
export function Switch(props: {
  checked: boolean;
  onToggle: () => void;
  /** 置灰停用（如名额满了的「开启」动作）；停用时点按无效 */
  disabled?: boolean;
  /** 读屏名称（没有可见文字时必填） */
  label?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      aria-disabled={props.disabled}
      disabled={props.disabled}
      onClick={() => {
        if (props.disabled !== true) props.onToggle();
      }}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40 disabled:hover:cursor-not-allowed",
        props.checked ? "bg-primary" : "bg-muted-foreground/30",
        props.className,
      )}
    >
      <span
        className={cn(
          "absolute top-[0.125rem] h-4 w-4 rounded-full bg-background shadow transition-[left,transform] duration-base",
          props.checked ? "left-[1.125rem]" : "left-[0.125rem]",
        )}
      />
    </button>
  );
}
