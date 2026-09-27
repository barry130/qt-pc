import type React from "react";
import { Check, Eye, EyeOff, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 认证类页面共用的表面件（登录/注册、找回密码）。
 *
 * 抽出来的原因：这几页是同一套「居中窄卡」语言，字段、按钮、报错位置完全一致，
 * 分散写会慢慢走样。改资料页不在壳内用（它是应用内的正常页面，见 ProfileEditPage）。
 */

/** 居中窄卡外壳 */
export function AuthShell(props: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-center text-lg font-semibold">{props.title}</h1>
        <p className="mt-1 text-center text-xs text-muted-foreground">{props.subtitle}</p>
        <div className="mt-5 space-y-3">{props.children}</div>
      </div>
    </div>
  );
}

/** 单行输入；action 位放内嵌动作（密码显隐等） */
export function AuthInput(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  type?: string;
  autoComplete?: string;
  maxLength?: number;
  /** 回车提交（表单里最后一个输入框之外，各处都该能回车） */
  onEnter?: () => void;
  /** 输入框内右侧的动作按钮 */
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="relative">
      <input
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        type={props.type ?? "text"}
        placeholder={props.placeholder}
        autoComplete={props.autoComplete}
        maxLength={props.maxLength}
        onKeyDown={(e) => {
          if (e.key === "Enter") props.onEnter?.();
        }}
        className={cn(
          "h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring",
          props.action ? "pr-10" : "",
        )}
      />
      {props.action ? (
        <div className="absolute inset-y-0 right-0 flex items-center pr-1.5">
          {props.action}
        </div>
      ) : null}
    </div>
  );
}

/** 密码显隐（放 AuthInput 的 action 位） */
export function EyeToggle(props: {
  shown: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const Icon = props.shown ? EyeOff : Eye;
  const label = props.shown ? "隐藏密码" : "显示密码";
  return (
    <button
      type="button"
      onClick={props.onToggle}
      aria-label={label}
      title={label}
      className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

/** 主/次按钮；busy 时禁用并显示转圈 */
export function AuthButton(props: {
  label: string;
  busyLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
  variant?: "primary" | "ghost";
}): React.JSX.Element {
  const busy = props.busy === true;
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={busy || props.disabled === true}
      className={cn(
        "flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50",
        props.variant === "ghost"
          ? "border border-border text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
          : "bg-primary text-primary-foreground hover:opacity-90",
      )}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
      {busy && props.busyLabel ? props.busyLabel : props.label}
    </button>
  );
}

/** 一行状态提示：错误（默认）或成功 */
export function AuthTip(props: {
  tip: string | null;
  kind?: "error" | "ok";
}): React.JSX.Element | null {
  if (!props.tip) return null;
  if (props.kind === "ok") {
    return (
      <p className="flex items-center justify-center gap-1 text-center text-xs text-primary">
        <Check className="h-3 w-3" />
        {props.tip}
      </p>
    );
  }
  return <p className="text-center text-xs text-destructive">{props.tip}</p>;
}

/** 登录/注册的模式切换（两段式胶囊） */
export function AuthTabs<T extends string>(props: {
  value: T;
  items: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}): React.JSX.Element {
  return (
    <div className="flex rounded-md bg-secondary p-1">
      {props.items.map((item) => (
        <button
          key={item.value}
          type="button"
          onClick={() => props.onChange(item.value)}
          className={cn(
            "flex-1 cursor-pointer rounded px-3 py-1.5 text-xs transition-colors",
            props.value === item.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
