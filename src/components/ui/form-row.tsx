import { cn } from "@/lib/utils";

/**
 * 设置项行：左侧「标题 + 说明」，右侧控件。
 *
 * 这是全仓出现最多的布局（71 处，原先叫 `SettingRow`，只活在 `settings/controls.tsx`
 * 里，于是账号页、下载页又把同样的三行结构抄了一遍）。统一后：
 * - 左列 `min-w-0 flex-1` 自动截断，长文案不会把右列挤成竖排；
 * - 右列封顶 60% 宽（否则「方案单选列表」这类宽控件会把左列压成一字一行）；
 * - 上下 `py-3` 与 `divide-y` 的分节容器配合，不用每处再写间距。
 *
 * 需要分组时套 `<div className="divide-y divide-border">`（设置页的惯例）。
 */
export function FormRow(props: {
  /** 主标题（一句话说清这一行是什么开关） */
  title: React.ReactNode;
  /** 说明（可选，一句话说清代价或后果） */
  description?: React.ReactNode;
  children?: React.ReactNode;
  /** 右侧控件的额外类名（例如固定宽度） */
  controlClassName?: string;
  /** 纵向对齐：多行控件（单选项列表、颜色选择器）用 `start` */
  align?: "center" | "start";
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex justify-between gap-6 py-3",
        props.align === "start" ? "items-start" : "items-center",
        props.className,
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm">{props.title}</p>
        {props.description !== undefined && (
          <p className="mt-0.5 text-xs text-muted-foreground">{props.description}</p>
        )}
      </div>
      {/* 右侧封顶 60%：否则长内容（如方案单选列表）会把左列压到一字一行 */}
      <div className={cn("min-w-0 max-w-[60%] shrink-0", props.controlClassName)}>
        {props.children}
      </div>
    </div>
  );
}
