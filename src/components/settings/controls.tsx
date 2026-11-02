import { useEffect, useState } from "react";
import * as ipc from "@/services/ipc";
import { type AppearancePreference } from "@/types";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { useT } from "@/lib/i18n";

/** 外观模式的选项。文案随语言变，所以是函数而不是常量（组件里传 `useT()` 进来）。 */
export function modeOptions(tr: (key: "appearance.mode.light" | "appearance.mode.dark" | "appearance.mode.system") => string): {
  value: AppearancePreference["mode"];
  label: string;
}[] {
  return [
    { value: "light", label: tr("appearance.mode.light") },
    { value: "dark", label: tr("appearance.mode.dark") },
    { value: "system", label: tr("appearance.mode.system") },
  ];
}

// 这三个原语已迁到 ui 层（`src/components/ui/`）。设置页内的相对导入保持不变，
// 新代码请直接从 `@/components/ui` 引用，别再在这里加一份。
export { FormRow as SettingRow } from "@/components/ui/form-row";
export { Switch } from "@/components/ui/switch";
export { Segmented } from "@/components/ui/segmented";

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

export function GenericSection(props: { hint: string }): React.JSX.Element {
  const tr = useT();
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center">
      <div className="text-center text-sm text-muted-foreground">
        <p>{tr("common.notDeveloped", { hint: props.hint })}</p>
        <p className="mt-1 text-xs">{tr("common.comingSoon")}</p>
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
  const tr = useT();
  return (
    <div className="flex items-center gap-2">
      <span
        className="max-w-52 truncate rounded border border-input bg-background px-2 py-1.5 text-xs text-muted-foreground"
        title={props.path}
      >
        {props.path || "…"}
      </span>
      <Button variant="outline" onClick={props.onChoose} disabled={props.busy || props.disabled}>
        {tr("common.changeLocation")}
      </Button>
      <Button
        variant="ghost"
        onClick={props.onReset}
        disabled={props.busy || props.disabled}
      >
        {tr("common.restoreDefault")}
      </Button>
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
      <Input
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
        controlSize="xs"
        className="w-20"
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
    <Button
      variant="outline"
      onClick={() => void ipc.openExternalUrl(props.url).catch(() => undefined)}
      iconRight={<ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />}
    >
      {props.label}
    </Button>
  );
}
