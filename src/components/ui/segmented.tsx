import { cn } from "@/lib/utils";

/**
 * 分段选择器（互斥的少量选项：背景模式、对齐方式、行数、排序）。
 *
 * 与 `Select` 的分工：选项 ≤ 4 个且用户会频繁切换 → 分段器（一次点击、能看到全集）；
 * 更多选项或需要搜索 → `Select`。与「标签页」的分工：分段器切换的是**同一内容的视图**，
 * 标签页切换的是**不同内容**。
 *
 * 语义上用 `role="radiogroup"` + `role="radio"`（不是 tablist）：读屏会念「第 2 项，
 * 共 3 项，已选中」，而 tab 会念成「标签页」，但这里并不存在与之配套的 tabpanel 关系。
 */
export function Segmented<T extends string | number>(props: {
  value: T;
  options: { value: T; label: React.ReactNode; title?: string }[];
  onChange: (value: T) => void;
  /** 无障碍名称（这一组选项在选什么） */
  label?: string;
  /** 撑满容器宽度（选项等分） */
  block?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={props.label}
      className={cn(
        "inline-flex rounded-md border border-border p-0.5",
        props.block === true && "flex w-full",
        props.className,
      )}
    >
      {props.options.map((option) => {
        const active = props.value === option.value;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.title}
            onClick={() => props.onChange(option.value)}
            className={cn(
              "rounded px-2.5 py-1 text-xs transition-colors",
              props.block === true && "min-w-0 flex-1",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
