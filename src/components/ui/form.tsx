import { cloneElement, useId } from "react";
import { cn } from "@/lib/utils";

/**
 * 表单控件：`Field` 负责「标签 + 说明 + 错误」三行式结构，`Input` / `Textarea` /
 * `Select` / `Checkbox` 负责控件本身的外观。
 *
 * 为什么收口：全仓 35 处自己拼 `border-input` 的输入框，高度长出 24 / 28 / 32 三种，
 * 圆角有 `rounded` 与 `rounded-lg`，聚焦态有的用 `focus:ring-1`、有的用
 * `focus-visible:ring-2`、还有的靠外层 `focus-within`。搜索框、改歌名、加歌单、
 * 登录表单在同一屏里能同时出现三种。这里统一成：
 * - 高 32px（`sm`）/ 36px（`md`）两档，行内小输入用 `xs`（26px）；
 * - 圆角 `rounded-md`，聚焦统一 `focus-visible:ring-2 ring-ring`；
 * - 错误态由 `Field` 传入 `aria-invalid` 与红描边，不再各自判断。
 */

const CONTROL_BASE = [
  "w-full border border-input bg-background text-foreground outline-none",
  "placeholder:text-muted-foreground/70",
  "transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
  "disabled:cursor-not-allowed disabled:opacity-50",
  "aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive/40",
].join(" ");

const CONTROL_SIZE = {
  xs: "h-[1.625rem] rounded-md px-2 text-xs",
  sm: "h-8 rounded-md px-2.5 text-xs",
  md: "h-9 rounded-lg px-3 text-sm",
} as const;

export type ControlSize = keyof typeof CONTROL_SIZE;

export type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> & {
  controlSize?: ControlSize;
};

export function Input(props: InputProps): React.JSX.Element {
  const { controlSize = "sm", className, ...rest } = props;
  return <input className={cn(CONTROL_BASE, CONTROL_SIZE[controlSize], className)} {...rest} />;
}

export function Textarea(
  props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { className?: string },
): React.JSX.Element {
  return (
    <textarea
      className={cn(CONTROL_BASE, "min-h-20 rounded-md px-2.5 py-2 text-xs leading-relaxed", props.className)}
      {...props}
    />
  );
}

export function Select(
  props: React.SelectHTMLAttributes<HTMLSelectElement> & { controlSize?: ControlSize },
): React.JSX.Element {
  const { controlSize = "sm", className, ...rest } = props;
  return (
    <select
      className={cn(CONTROL_BASE, CONTROL_SIZE[controlSize], "cursor-pointer pr-6", className)}
      {...rest}
    />
  );
}

/**
 * 复选框：`accent-primary` 是让原生方块跟着主题走的最小代价（不引第三方）。
 * 文本作为 label 一起点，命中区比只包 `<input>` 大一倍。
 */
export function Checkbox(
  props: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & {
    /** 复选框右侧的文字（可选，纯图标行不需要） */
    label?: React.ReactNode;
    className?: string;
    labelClassName?: string;
  },
): React.JSX.Element {
  const { label, className, labelClassName, ...rest } = props;
  const input = (
    <input
      type="checkbox"
      className={cn("h-3.5 w-3.5 shrink-0 accent-primary disabled:opacity-50", className)}
      {...rest}
    />
  );
  if (label === undefined) return input;
  return (
    <label className={cn("inline-flex cursor-pointer items-center gap-1.5 text-xs text-foreground", labelClassName)}>
      {input}
      {label}
    </label>
  );
}

/**
 * 字段容器：标签 / 说明 / 错误三行 + 控件。
 *
 * 标签用 `<label htmlFor>`；`hint` 是常在的说明（灰字），`error` 是出错才出现的红字，
 * 两者都挂在控件的 `aria-describedby` 上。控件本身用 `children` 传入（可以是
 * `Input`，也可以是自定义组合控件）。
 */
export function Field(props: {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  /** 覆盖自动生成的 id（已有 id 的控件传进来，标签才能正确关联） */
  htmlFor?: string;
  required?: boolean;
  className?: string;
  children: React.ReactElement;
}): React.JSX.Element {
  const autoId = useId();
  const controlId = props.htmlFor ?? autoId;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;

  const describedBy = [
    props.hint !== undefined ? hintId : null,
    props.error !== undefined && props.error !== "" ? errorId : null,
  ]
    .filter((v): v is string => v !== null)
    .join(" ");

  const child = props.children as React.ReactElement<{
    id?: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean;
  }>;
  const control: { id: string; "aria-describedby"?: string; "aria-invalid"?: true } = {
    id: child.props.id ?? controlId,
    ...(describedBy.length > 0 ? { "aria-describedby": describedBy } : {}),
    ...(props.error !== undefined && props.error !== ""
      ? { "aria-invalid": true as const }
      : {}),
  };

  return (
    <div className={cn("flex flex-col gap-1", props.className)}>
      {props.label !== undefined && (
        <label htmlFor={control.id} className="text-xs font-medium text-foreground">
          {props.label}
          {props.required === true && <span className="ml-0.5 text-destructive">*</span>}
        </label>
      )}
      {cloneElement(child, control)}
      {props.hint !== undefined && (
        <p id={hintId} className="text-2xs text-muted-foreground">
          {props.hint}
        </p>
      )}
      {props.error !== undefined && props.error !== "" && (
        <p id={errorId} role="alert" className="text-2xs text-destructive">
          {props.error}
        </p>
      )}
    </div>
  );
}
