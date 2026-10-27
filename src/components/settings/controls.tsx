import { useEffect, useState } from "react";
import * as ipc from "@/services/ipc";
import { type AppearancePreference } from "@/types";
import { ExternalLink } from "lucide-react";

export const MODE_OPTIONS: { value: AppearancePreference["mode"]; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

export function SettingRow(props: {
  title: string;
  description?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm">{props.title}</p>
        {props.description && (
          <p className="mt-0.5 text-xs text-muted-foreground">{props.description}</p>
        )}
      </div>
      {/* 右侧封顶 60%：否则长内容（如方案单选列表）会把左列压到一字一行 */}
      <div className="min-w-0 max-w-[60%] shrink-0">{props.children}</div>
    </div>
  );
}


export function Switch(props: {
  checked: boolean;
  onToggle: () => void;
  /** 置灰停用（如名额满了的「开启」动作）；停用时点按无效 */
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-disabled={props.disabled}
      disabled={props.disabled}
      onClick={() => {
        if (!props.disabled) props.onToggle();
      }}
      className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-40 disabled:hover:cursor-not-allowed ${
        props.checked ? "bg-primary" : "bg-muted-foreground/30"
      }`}
    >
      <span
        className={`absolute top-[0.125rem] h-4 w-4 rounded-full bg-background shadow transition-[left,transform] duration-200 ${
          props.checked ? "left-[1.125rem]" : "left-[0.125rem]"
        }`}
      />
    </button>
  );
}

/** 桌面歌词设置（DESIGN §10）：窗口开关 + 样式全量自定义；歌词工具条上的
 * 「歌词设置」按钮会唤起主窗口并跳到本页 */

export function cssToHex(color: string): string {
  const nums = color.match(/\d+(\.\d+)?/g);
  if (nums && nums.length >= 3) {
    const [r, g, b] = nums.slice(0, 3).map((n) => Math.min(255, Number(n)));
    const hex = (v: number): string => v.toString(16).padStart(2, "0");
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = color;
    const m = /^#([0-9a-f]{6})$/i.exec(ctx.fillStyle);
    if (m) return `#${m[1]}`;
  }
  return "#ffffff";
}

/** 分段选择器（背景模式 / 对齐 / 行数等互斥小选项） */

export function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}): React.JSX.Element {
  return (
    <div className="flex rounded-md border border-border p-0.5">
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => props.onChange(o.value)}
          className={`rounded px-2.5 py-1 text-xs transition-colors ${
            props.value === o.value
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}


export function GenericSection(props: { hint: string }): React.JSX.Element {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center">
      <div className="text-center text-sm text-muted-foreground">
        <p>「{props.hint}」还没开发</p>
        <p className="mt-1 text-xs">将在后续里程碑交付</p>
      </div>
    </div>
  );
}

/** 播放设置：音频输出设备（蓝牙耳机 / HDMI 插拔场景） */

export function DirPicker(props: {
  path: string;
  busy: boolean;
  /** 置灰（如日志目录当前不可用时不允许再换） */
  disabled?: boolean;
  onChoose: () => void;
  onReset: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span
        className="max-w-52 truncate rounded border border-input bg-background px-2 py-1.5 text-xs text-muted-foreground"
        title={props.path}
      >
        {props.path || "…"}
      </span>
      <button
        type="button"
        onClick={props.onChoose}
        disabled={props.busy || props.disabled}
        className="rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50"
      >
        更改位置
      </button>
      <button
        type="button"
        onClick={props.onReset}
        disabled={props.busy || props.disabled}
        className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        恢复默认
      </button>
    </div>
  );
}

/** 数字输入（失焦 / 回车提交）。越界值不在这里拦：后端夹紧后回传真实值，
 *  useEffect 跟着把草稿改回来 —— 用户填 999 份会立刻看到变成 50，而不是
 *  留一个「我填了 999」的假象。非法（空 / 负 / 非数字）直接还原不报错。 */

export function NumberField(props: {
  value: number;
  min: number;
  max: number;
  suffix: string;
  onCommit: (n: number) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(props.value));
  useEffect(() => {
    setDraft(String(props.value));
  }, [props.value]);

  const commit = (): void => {
    const raw = draft.trim();
    if (!/^\d+$/.test(raw)) {
      setDraft(String(props.value));
      return;
    }
    const n = Number(raw);
    if (n !== props.value) props.onCommit(n);
  };

  return (
    <span className="flex items-center gap-1">
      <input
        type="number"
        inputMode="numeric"
        min={props.min}
        max={props.max}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        onBlur={commit}
        className="w-20 rounded-md border border-border bg-transparent px-2 py-1 text-xs outline-none focus:border-primary"
      />
      <span className="text-xs text-muted-foreground">{props.suffix}</span>
    </span>
  );
}


export function ExternalLinkButton(props: {
  label: string;
  url: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => void ipc.openExternalUrl(props.url).catch(() => undefined)}
      className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
    >
      {props.label}
      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
    </button>
  );
}
