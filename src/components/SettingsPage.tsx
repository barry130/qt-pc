import { useCallback, useEffect, useState } from "react";
import { errMsg, stripErrorUrls } from "@/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import { PageContainer } from "@/components/layout/PageContainer";
import * as ipc from "@/services/ipc";
import {
  getAppVersion,
  getDesktopLyricState,
  hideDesktopLyric,
  onLyricWindowChanged,
  resetDesktopLyric,
  setDesktopLyricLocked,
  setDesktopLyricStyle,
  showDesktopLyric,
} from "@/services/ipc";
import { useAppearanceStore } from "@/stores/appearance";
import { useUpdateStore } from "@/stores/update";
import { useSourceUpdateStore } from "@/stores/source-update";
import { runCheck } from "@/hooks/useUpdateCheck";
import { checkAndDownload } from "@/hooks/useSourceUpdateCheck";
import {
  applySourceRelease,
  BUILTIN_SOURCE_VERSION,
  rollbackSourceBuiltin,
} from "@/source-scripts/source-update";
import { SKINS, getSkin } from "@/lib/skins";
import { QUALITY_OPTIONS } from "@/lib/quality";
import type {
  AppearancePreference,
  AppVersion,
  DesktopLyricState,
  DesktopLyricStylePatch,
  Quality,
} from "@/types";

/**
 * 设置页（DESIGN §9）。外观区为真实实现（§9.2 AppearancePreference），
 * 其余分区在后续里程碑逐个落地。
 */

const MODE_OPTIONS: { value: AppearancePreference["mode"]; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

function SettingRow(props: {
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

function Switch(props: { checked: boolean; onToggle: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      onClick={props.onToggle}
      className={`relative h-5 w-9 rounded-full transition-colors ${
        props.checked ? "bg-primary" : "bg-muted-foreground/30"
      }`}
    >
      <span
        className={`absolute top-[0.125rem] h-4 w-4 rounded-full bg-background shadow transition-all ${
          props.checked ? "left-[1.125rem]" : "left-[0.125rem]"
        }`}
      />
    </button>
  );
}

/** 桌面歌词设置（DESIGN §10）：窗口开关 + 样式全量自定义；歌词工具条上的
 * 「歌词设置」按钮会唤起主窗口并跳到本页 */
function DesktopLyricSection(): React.JSX.Element {
  const [state, setState] = useState<DesktopLyricState | null>(null);

  useEffect(() => {
    let off: (() => void) | null = null;
    let disposed = false;
    void getDesktopLyricState()
      .then((s) => {
        if (!disposed) setState(s);
      })
      .catch(() => {});
    void onLyricWindowChanged((s) => setState(s)).then((u) => {
      if (disposed) u();
      else off = u;
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  const patch = useCallback((p: DesktopLyricStylePatch): void => {
    void setDesktopLyricStyle(p)
      .then(setState)
      .catch(() => {});
  }, []);

  const visible = state?.visible ?? false;

  if (!state) {
    return <p className="py-6 text-xs text-muted-foreground">正在读取歌词设置…</p>;
  }

  return (
    <div className="max-w-xl divide-y divide-border pb-8">
      <SettingRow title="显示桌面歌词" description="在桌面置顶显示逐行歌词，鼠标悬停歌词上方会出现工具条">
        <Switch
          checked={visible}
          onToggle={() =>
            void (visible ? hideDesktopLyric() : showDesktopLyric())
              .then(setState)
              .catch(() => {})
          }
        />
      </SettingRow>
      <SettingRow title="总在最前" description="歌词窗口始终悬浮在所有窗口上层；关闭后可被其他窗口遮住">
        <Switch
          checked={state.alwaysOnTop}
          onToggle={() => patch({ alwaysOnTop: !state.alwaysOnTop })}
        />
      </SettingRow>
      <SettingRow
        title="锁定歌词位置"
        description="锁定后不能拖动窗口、鼠标点击穿透到下层窗口（歌词只读展示），并隐藏歌词工具条防止误触；解锁走托盘菜单勾选、这里或快捷键 Ctrl+Alt+K"
      >
        <Switch
          checked={state.locked}
          onToggle={() =>
            void setDesktopLyricLocked(!state.locked).then(setState).catch(() => {})
          }
        />
      </SettingRow>

      <SettingRow title="字体">
        <select
          value={state.fontFamily}
          onChange={(e) => patch({ fontFamily: e.target.value })}
          className="w-36 rounded-md border border-border bg-background px-2 py-1 text-xs"
        >
          <option value="">系统默认</option>
          <option value="Microsoft YaHei">微软雅黑</option>
          <option value="SimSun">宋体</option>
          <option value="SimHei">黑体</option>
          <option value="KaiTi">楷体</option>
          <option value="STXingkai">行楷（华文行楷）</option>
          <option value="FangSong">仿宋</option>
          <option value="Arial">Arial</option>
          <option value="Georgia">Georgia</option>
          <option value="Consolas">Consolas</option>
        </select>
      </SettingRow>
      <SettingRow title={`字号（${state.fontSize}px）`} description="在歌词上滚动滚轮也可以调">
        <input
          type="range"
          min={12}
          max={96}
          step={1}
          value={state.fontSize}
          onChange={(e) => patch({ fontSize: Number(e.target.value) })}
          className="w-40 accent-[var(--primary)]"
        />
      </SettingRow>
      <SettingRow title={`字间距（${state.letterSpacing.toFixed(1)}px）`}>
        <input
          type="range"
          min={0}
          max={20}
          step={0.5}
          value={state.letterSpacing}
          onChange={(e) => patch({ letterSpacing: Number(e.target.value) })}
          className="w-40 accent-[var(--primary)]"
        />
      </SettingRow>
      <SettingRow title={`行间距（${state.lineGap.toFixed(2)} 倍）`}>
        <input
          type="range"
          min={1}
          max={2.5}
          step={0.05}
          value={state.lineGap}
          onChange={(e) => patch({ lineGap: Number(e.target.value) })}
          className="w-40 accent-[var(--primary)]"
        />
      </SettingRow>

      <SettingRow title="当前行配色" description="当前歌词行的渐变高亮色（两端）">
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label="当前行渐变起始色"
            value={state.gradient[0]}
            onChange={(e) => patch({ gradient: [e.target.value, state.gradient[1]] })}
            className="h-6 w-8 cursor-pointer rounded border border-border bg-transparent p-0"
          />
          <span className="text-xs text-muted-foreground">→</span>
          <input
            type="color"
            aria-label="当前行渐变结束色"
            value={state.gradient[1]}
            onChange={(e) => patch({ gradient: [state.gradient[0], e.target.value] })}
            className="h-6 w-8 cursor-pointer rounded border border-border bg-transparent p-0"
          />
        </div>
      </SettingRow>
      <SettingRow title="非当前行颜色" description="上一句 / 下一句与翻译行的文字颜色">
        <input
          type="color"
          aria-label="非当前行文字颜色"
          value={cssToHex(state.inactiveColor)}
          onChange={(e) => patch({ inactiveColor: e.target.value })}
          className="h-6 w-8 cursor-pointer rounded border border-border bg-transparent p-0"
        />
      </SettingRow>
      <SettingRow title="文字描边" description="给歌词加一圈深色描边，防止被亮色壁纸盖住（桌面歌词刚需）">
        <div className="flex items-center gap-3">
          {state.stroke && (
            <input
              type="range"
              min={0.5}
              max={4}
              step={0.5}
              value={state.strokeWidth}
              onChange={(e) => patch({ strokeWidth: Number(e.target.value) })}
              className="w-24 accent-[var(--primary)]"
              aria-label="描边宽度"
            />
          )}
          <Switch checked={state.stroke} onToggle={() => patch({ stroke: !state.stroke })} />
        </div>
      </SettingRow>
      <SettingRow title="文字阴影">
        <Switch checked={state.shadow} onToggle={() => patch({ shadow: !state.shadow })} />
      </SettingRow>

      <SettingRow title="背景" description="透明 / 半透明圆角蒙版 / 纯色">
        <Segmented
          value={state.backgroundMode}
          options={[
            { value: "none", label: "无" },
            { value: "mask", label: "蒙版" },
            { value: "solid", label: "纯色" },
          ]}
          onChange={(v) => patch({ backgroundMode: v })}
        />
      </SettingRow>
      {state.backgroundMode === "mask" && (
        <SettingRow title={`蒙版浓度（${Math.round(state.backgroundOpacity * 100)}%）`}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={state.backgroundOpacity}
            onChange={(e) => patch({ backgroundOpacity: Number(e.target.value) })}
            className="w-40 accent-[var(--primary)]"
          />
        </SettingRow>
      )}
      {state.backgroundMode === "solid" && (
        <SettingRow title="背景颜色">
          <input
            type="color"
            aria-label="背景颜色"
            value={cssToHex(state.backgroundColor)}
            onChange={(e) => patch({ backgroundColor: e.target.value })}
            className="h-6 w-8 cursor-pointer rounded border border-border bg-transparent p-0"
          />
        </SettingRow>
      )}
      <SettingRow title={`窗口圆角（${state.borderRadius}px）`}>
        <input
          type="range"
          min={0}
          max={40}
          step={1}
          value={state.borderRadius}
          onChange={(e) => patch({ borderRadius: Number(e.target.value) })}
          className="w-40 accent-[var(--primary)]"
        />
      </SettingRow>

      <SettingRow title="对齐方式">
        <Segmented
          value={state.align}
          options={[
            { value: "left", label: "左" },
            { value: "center", label: "中" },
            { value: "right", label: "右" },
          ]}
          onChange={(v) => patch({ align: v })}
        />
      </SettingRow>
      <SettingRow title="歌词行数" description="三行 = 上一句 + 当前行 + 下一句">
        <Segmented
          value={state.lineMode}
          options={[
            { value: "single", label: "单行" },
            { value: "two-lines", label: "双行" },
            { value: "three-lines", label: "三行" },
          ]}
          onChange={(v) => patch({ lineMode: v })}
        />
      </SettingRow>

      <SettingRow
        title="重置歌词位置"
        description="窗口拖丢（拖到屏幕外）时一键复位到主屏底部居中；位置与样式会自动记忆，重启后恢复"
      >
        <button
          type="button"
          onClick={() => void resetDesktopLyric().then(setState).catch(() => {})}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          复位到屏幕中心
        </button>
      </SettingRow>
    </div>
  );
}

/** 把 css 颜色归一成 <input type="color"> 需要的 #rrggbb。
 * 带透明的 rgba（如默认的 rgba(255,255,255,0.65)）取 RGB 部分，解析失败回退白色 */
function cssToHex(color: string): string {
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
function Segmented<T extends string>(props: {
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

function AppearanceSection(): React.JSX.Element {
  const preference = useAppearanceStore((s) => s.preference);
  const update = useAppearanceStore((s) => s.update);
  const followCover = preference.followCoverColor;
  const activeSkin = getSkin(preference.skinId, preference.customColor);
  const [bgError, setBgError] = useState<string | null>(null);

  const handleBgImage = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setBgError("图片过大，请选择 5MB 以内的图片");
      return;
    }
    setBgError(null);
    const reader = new FileReader();
    reader.onload = () => {
      void update({ bgImage: reader.result as string });
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="max-w-[576px]">
      <SettingRow title="亮暗模式" description="深色 / 浅色，或跟随 Windows 系统设置">
        <div className="flex overflow-hidden rounded-md border border-border">
          {MODE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => void update({ mode: opt.value })}
              className={`px-3 py-1.5 text-xs transition-colors ${
                preference.mode === opt.value
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-accent"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </SettingRow>

      <SettingRow
        title="字体缩放"
        description={`当前 ${(preference.fontScale * 100).toFixed(0)}%（85%–125%）`}
      >
        <div className="flex w-[200px] shrink-0 items-center gap-[12px]">
          <input
            type="range"
            min={0.85}
            max={1.25}
            step={0.05}
            value={preference.fontScale}
            onChange={(e) => void update({ fontScale: Number(e.target.value) })}
            className="w-full accent-[var(--primary)]"
            aria-label="字体缩放"
          />
          <span className="w-[46px] shrink-0 text-right text-xs tabular-nums text-muted-foreground">
            {Math.round(preference.fontScale * 100)}%
          </span>
        </div>
      </SettingRow>

      <SettingRow title="减弱动效" description="禁用界面过渡与关键帧动画">
        <Switch
          checked={preference.reduceMotion}
          onToggle={() => void update({ reduceMotion: !preference.reduceMotion })}
        />
      </SettingRow>

      <SettingRow
        title="跟随封面取色"
        description="播放时按专辑封面调整界面主色"
      >
        <Switch
          checked={preference.followCoverColor}
          onToggle={() => void update({ followCoverColor: !preference.followCoverColor })}
        />
      </SettingRow>

      <div className="border-t border-border py-4">
        <h3 className="text-sm font-medium">皮肤</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {followCover
            ? "跟随封面取色已开启，皮肤暂不生效"
            : "选择界面主题配色方案"}
        </p>

        <div
          className={`mt-3 flex flex-wrap gap-2 ${
            followCover ? "pointer-events-none opacity-40" : ""
          }`}
        >
          {SKINS.map((skin) => {
            const active = preference.skinId === skin.id;
            return (
              <button
                key={skin.id}
                type="button"
                onClick={() => void update({ skinId: skin.id })}
                className={`flex items-center gap-2 rounded-xl border-2 p-2 pr-3 transition-all ${
                  active
                    ? "border-primary shadow-sm"
                    : "border-border/60 hover:border-border"
                }`}
                style={{ backgroundColor: skin.bgLight }}
              >
                <div
                  className="h-7 w-7 rounded-lg"
                  style={{ backgroundColor: skin.primaryLight }}
                />
                <div
                  className="h-7 w-1.5 rounded-full"
                  style={{ backgroundColor: skin.sidebarLight }}
                />
                <span className="text-xs font-medium">{skin.name}</span>
              </button>
            );
          })}

          {/* 自定义皮肤 */}
          <div
            className="flex items-center gap-2 rounded-xl border-2 border-dashed border-border/80 p-2 pr-3 transition-all hover:border-border"
            style={{
              backgroundColor: preference.skinId === "custom" ? activeSkin.bgLight : "#fafafa",
            }}
          >
            <label className="relative cursor-pointer">
              <input
                type="color"
                value={preference.customColor}
                onChange={(e) =>
                  void update({ skinId: "custom", customColor: e.target.value })
                }
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                aria-label="自定义主色"
              />
              <div
                className="h-7 w-7 rounded-lg"
                style={{ backgroundColor: preference.customColor }}
              />
            </label>
            <span className="text-xs font-medium">自定义</span>
          </div>
        </div>
      </div>

      <div className="border-t border-border py-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium">背景图片</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              自定义窗口背景图片，覆盖内容区、侧边栏与标题栏（最大 5MB）
            </p>
          </div>
          {preference.bgImage && (
            <button
              type="button"
              onClick={() => void update({ bgImage: "" })}
              className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            >
              清除
            </button>
          )}
        </div>

        {preference.bgImage ? (
          <div className="mt-3 overflow-hidden rounded-lg border border-border">
            <img
              src={preference.bgImage}
              alt="背景预览"
              className="h-32 w-full object-cover"
            />
          </div>
        ) : (
          <label className="mt-3 flex h-24 cursor-pointer items-center justify-center rounded-lg border-2 border-dashed border-border transition-colors hover:border-primary/40">
            <input
              type="file"
              accept="image/*"
              onChange={handleBgImage}
              className="hidden"
            />
            <div className="text-center text-xs text-muted-foreground">
              <p>点击选择图片</p>
              <p className="mt-1 text-[10px]">支持 JPG / PNG / WebP</p>
            </div>
          </label>
        )}

        {bgError && (
          <p className="mt-2 text-xs text-destructive">{bgError}</p>
        )}
      </div>
    </div>
  );
}

function GenericSection(props: { hint: string }): React.JSX.Element {
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
function PlaybackSection(): React.JSX.Element {
  const [devices, setDevices] = useState<string[]>([]);
  const [current, setCurrent] = useState<string>("");
  const [quality, setQuality] = useState<Quality>("320");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [list, snap, savedQuality] = await Promise.all([
        ipc.listOutputDevices(),
        ipc.getPlaybackState(),
        ipc.getSetting("quality"),
      ]);
      setDevices(list);
      setCurrent(snap?.outputDevice ?? "");
      if (savedQuality === "128" || savedQuality === "320" || savedQuality === "flac") {
        setQuality(savedQuality);
      }
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const choose = async (name: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      // 空串 = 跟随系统默认
      await ipc.setOutputDevice(name || undefined);
      await load();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const chooseQuality = async (q: Quality): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await ipc.setDefaultQuality(q);
      setQuality(q);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-xl divide-y divide-border">
      <SettingRow
        title="音频输出设备"
        description="连蓝牙耳机后自动无声？选「跟随系统默认」即可插拔自动切换；固定设备适合挂多套输出。切换时当前曲目从原进度无缝续播。"
      >
        <select
          value={current}
          disabled={busy}
          onChange={(e) => void choose(e.target.value)}
          className="max-w-52 rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          aria-label="音频输出设备"
        >
          <option value="">跟随系统默认</option>
          {devices.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow
        title="默认播放音质"
        description="新播放的歌曲按这个音质取址。播放条上的音质按钮只改当前那一首，不会动这里的默认值。"
      >
        <QualitySelect
          value={quality}
          disabled={busy}
          onChange={(q) => void chooseQuality(q)}
        />
      </SettingRow>
      {error && <p className="py-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** 音质下拉（设置页两处共用：默认播放 / 默认下载） */
function QualitySelect(props: {
  value: Quality;
  disabled?: boolean;
  onChange: (q: Quality) => void;
}): React.JSX.Element {
  return (
    <select
      value={props.value}
      disabled={props.disabled}
      aria-label="音质"
      onChange={(e) => props.onChange(e.target.value as Quality)}
      className="rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      {QUALITY_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}（{o.short}）
        </option>
      ))}
    </select>
  );
}

/** 应用成功提示：冒烟通过后引擎页会请求重启，所以提示里带上重启口径 */
const APPLY_OK_MESSAGE = "应用成功，正在重启应用…";

/** 音源包设置（音源包热更新方案 P2）：当前/远端版本 + 立即检查/应用/回滚。
 *  状态事实来源是 Rust state.json；「已就绪」= 下载完成待应用。 */
function SourcePackageSection(): React.JSX.Element {
  const local = useSourceUpdateStore((s) => s.local);
  const remote = useSourceUpdateStore((s) => s.remote);
  const ready = useSourceUpdateStore((s) => s.ready);
  const message = useSourceUpdateStore((s) => s.message);
  const busy = useSourceUpdateStore((s) => s.busy);
  const setBusy = useSourceUpdateStore((s) => s.setBusy);
  const setMessage = useSourceUpdateStore((s) => s.setMessage);
  const setReady = useSourceUpdateStore((s) => s.setReady);

  const run = async (action: () => Promise<string>): Promise<void> => {
    setBusy(true);
    try {
      setMessage(await action());
    } catch (e) {
      setMessage(`操作失败：${stripErrorUrls(String(e))}`);
    } finally {
      setBusy(false);
    }
  };

  const check = (): Promise<string> => checkAndDownload();

  // 应用成功后提示「应用成功」，随即收起应用按钮与更新说明（已装上就不占版面）。
  // 真实冒烟由引擎页执行，通过后引擎页会请求重启应用，所以这里的提示带上重启口径。
  const apply = async (): Promise<void> => {
    setBusy(true);
    try {
      await applySourceRelease(true);
      setReady(null);
      setMessage(APPLY_OK_MESSAGE);
      window.setTimeout(() => {
        if (useSourceUpdateStore.getState().message === APPLY_OK_MESSAGE) {
          setMessage("");
        }
      }, 15000);
    } catch (e) {
      setMessage(`操作失败：${stripErrorUrls(String(e))}`);
    } finally {
      setBusy(false);
    }
  };

  const rollback = async (): Promise<string> => {
    await rollbackSourceBuiltin();
    return "已回滚到内置版：引擎重启后生效";
  };

  const installed = local?.installed ?? null;
  const installedCode = installed?.sourceVersionCode ?? BUILTIN_SOURCE_VERSION.code;
  const pendingNotes =
    remote?.notes && (ready !== null || remote.sourceVersionCode > installedCode);
  return (
    <div className="max-w-xl divide-y divide-border">
      <SettingRow title="当前音源包" description="未安装远程包时使用随应用发布的内置版">
        <span className="font-mono text-xs text-muted-foreground">
          {installed
            ? `${installed.sourceVersionName} (code ${installed.sourceVersionCode})`
            : `内置版 ${BUILTIN_SOURCE_VERSION.name} (code ${BUILTIN_SOURCE_VERSION.code})`}
        </span>
      </SettingRow>
      <SettingRow title="远端最新" description="检查后显示远端发布的音源包版本">
        <span className="font-mono text-xs text-muted-foreground">
          {remote ? `${remote.sourceVersionName} (code ${remote.sourceVersionCode})` : "未检查"}
        </span>
      </SettingRow>
      <SettingRow title="更新检查" description="启动时也会静默检查（4 小时节流），只下载不自动生效">
        <button
          type="button"
          onClick={() => void run(check)}
          disabled={busy}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
        >
          {busy ? "处理中…" : "立即检查"}
        </button>
      </SettingRow>
      {installed && (
        <SettingRow
          title="回滚到内置版"
          description="远程包出问题时先回内置版保播放可用（安装目录保留便于排查）"
        >
          <button
            type="button"
            onClick={() => void run(rollback)}
            disabled={busy}
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
          >
            回滚
          </button>
        </SettingRow>
      )}
      {(ready !== null || message) && (
        <div className="py-3 text-xs text-muted-foreground">
          {ready !== null && (
            <div className="mb-1">
              <button
                type="button"
                onClick={() => void apply()}
                disabled={busy}
                className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
              >
                立即应用
              </button>
              <span className="ml-2">音源包已就绪，应用后自动重启应用生效</span>
            </div>
          )}
          {message && <div>{message}</div>}
        </div>
      )}
      {pendingNotes && (
        <div className="py-3 text-xs text-muted-foreground">
          <p className="mb-1 font-medium text-foreground">更新说明</p>
          <p className="whitespace-pre-wrap">{remote?.notes}</p>
        </div>
      )}
    </div>
  );
}

function AboutSection(): React.JSX.Element {
  const [version, setVersion] = useState<AppVersion | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<string>("");
  const [channel, setChannel] = useState("stable");
  const setUpdate = useUpdateStore((s) => s.setUpdate);

  useEffect(() => {
    void getAppVersion().then(setVersion).catch(() => {});
    void ipc.getSetting("update_channel").then((c) => {
      if (c === "beta" || c === "stable") setChannel(c);
    });
  }, []);

  const checkUpdate = async (): Promise<void> => {
    setChecking(true);
    setResult("");
    try {
      // 手动检查：不受启动自动检查的 4 小时节流限制，无条件查一次。
      // 复用 runCheck：把结果写入全局 update store → UpdateDialog 会弹出。
      const update = await runCheck(setUpdate);
      if (update && update.versionName) {
        const sizeStr =
          update.fileSize > 0
            ? ` · ${(update.fileSize / 1024 / 1024).toFixed(1)} MB`
            : "";
        setResult(
          `发现新版本 ${update.versionName}${sizeStr}：${update.versionInfo || "暂无更新说明"}`,
        );
      } else {
        setResult("当前已是最新版本");
      }
    } catch (e) {
      setResult(`检查失败：${stripErrorUrls(String(e))}`);
      setUpdate(null);
    } finally {
      setChecking(false);
    }
  };

  const switchChannel = async (c: string): Promise<void> => {
    setChannel(c);
    await ipc.setSetting("update_channel", c);
  };

  return (
    <div className="max-w-xl divide-y divide-border">
      <SettingRow title="当前版本" description="轻听 PC 版">
        <span className="font-mono text-xs text-muted-foreground">
          {version ? `${version.versionName} (versionCode ${version.versionCode})` : "…"}
        </span>
      </SettingRow>
      <SettingRow
        title="更新渠道"
        description="正式版只收稳定推送；测试版额外收 beta，正式版更高时也能收到"
      >
        <div className="flex gap-1">
          {(["stable", "beta"] as const).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => void switchChannel(c)}
              className={`rounded px-3 py-1.5 text-xs transition-colors ${
                channel === c
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-accent"
              }`}
            >
              {c === "stable" ? "正式版" : "测试版"}
            </button>
          ))}
        </div>
      </SettingRow>
      <SettingRow title="检查更新" description="手动检查不受 4 小时节流限制">
        <button
          type="button"
          onClick={() => void checkUpdate()}
          disabled={checking}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
        >
          {checking ? "检查中…" : "检查更新"}
        </button>
      </SettingRow>
      {result && (
        <div className="py-3 text-xs text-muted-foreground">{result}</div>
      )}
    </div>
  );
}

/** 播放设置：全局快捷键（可改键 / 可禁用，保存即热重载） */
function ShortcutSection(): React.JSX.Element {
  const [entries, setEntries] = useState<ipc.ShortcutEntry[]>([]);
  const [draft, setDraft] = useState<
    Record<string, { key: string; enabled: boolean }>
  >({});
  const [listening, setListening] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const list = await ipc.listShortcuts();
      setEntries(list);
      const next: Record<string, { key: string; enabled: boolean }> = {};
      for (const e of list) next[e.id] = { key: e.accelerator, enabled: e.enabled };
      setDraft(next);
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 录制模式：下一次按键即设为该动作的加速键
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      // 单独的修饰键不构成快捷键
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const parts: string[] = [];
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.shiftKey) parts.push("Shift");
      if (e.altKey) parts.push("Alt");
      const keyName = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      parts.push(keyName);
      setDraft((d) => ({ ...d, [listening]: { ...d[listening], key: parts.join("+") } }));
      setListening(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listening]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const list = await ipc.saveShortcuts(draft);
      setEntries(list);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  const reset = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      // 全部恢复默认（key 清空 = 沿用默认，全部启用）
      const back: Record<string, { key: string; enabled: boolean }> = {};
      for (const e of entries) back[e.id] = { key: "", enabled: true };
      const list = await ipc.saveShortcuts(back);
      setEntries(list);
      const next: Record<string, { key: string; enabled: boolean }> = {};
      for (const e of list) next[e.id] = { key: e.accelerator, enabled: e.enabled };
      setDraft(next);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  const LABELS: Record<string, string> = {
    play_pause: "播放 / 暂停",
    previous: "上一首",
    next: "下一首",
    volume_up: "音量加",
    volume_down: "音量减",
    mute: "静音",
    desktop_lyric: "桌面歌词开关",
    lock_lyric: "锁定 / 解锁桌面歌词",
  };

  return (
    <div className="max-w-xl divide-y divide-border">
      {entries.length === 0 && !error && (
        <p className="py-4 text-sm text-muted-foreground">加载中…</p>
      )}
      {entries.map((e) => {
        const d = draft[e.id] ?? { key: e.accelerator, enabled: e.enabled };
        const changed = d.key !== e.accelerator || d.enabled !== e.enabled;
        return (
          <div key={e.id} className="flex items-center justify-between gap-6 py-3">
            <div className="min-w-0">
              <p className="text-sm">{LABELS[e.id] ?? e.id}</p>
              {listening === e.id && (
                <p className="mt-0.5 text-xs text-[var(--primary)]">
                  按下新的快捷键组合（Esc 取消）…
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <input
                readOnly
                value={listening === e.id ? "按下新组合…" : d.key}
                onFocus={() => setListening(e.id)}
                onClick={() => setListening(e.id)}
                onKeyDown={(ev) => {
                  if (ev.key === "Escape") setListening(null);
                }}
                aria-label={`${LABELS[e.id] ?? e.id} 快捷键`}
                className={`w-36 rounded-md border px-2 py-1.5 text-center text-xs outline-none transition-colors ${
                  listening === e.id
                    ? "border-[var(--primary)] ring-2 ring-ring"
                    : "border-input bg-background"
                }`}
              />
              <Switch
                checked={d.enabled}
                onToggle={() =>
                  setDraft((prev) => ({
                    ...prev,
                    [e.id]: { ...prev[e.id], enabled: !prev[e.id].enabled },
                  }))
                }
              />
              {changed && (
                <button
                  type="button"
                  onClick={() =>
                    setDraft((prev) => ({
                      ...prev,
                      [e.id]: { key: e.accelerator, enabled: e.enabled },
                    }))
                  }
                  className="rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  还原
                </button>
              )}
            </div>
          </div>
        );
      })}

      {error && <p className="py-2 text-xs text-destructive">{error}</p>}

      <div className="flex items-center justify-end gap-2 py-3">
        <button
          type="button"
          onClick={() => void reset()}
          disabled={saving}
          className="rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50"
        >
          恢复默认
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !entries.some((e) => {
            const d = draft[e.id];
            return d && (d.key !== e.accelerator || d.enabled !== e.enabled);
          })}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存并生效"}
        </button>
      </div>
    </div>
  );
}

/** 下载设置：保存位置（默认安装目录/Download，可选任意位置） */
function DownloadSection(): React.JSX.Element {
  const [dir, setDir] = useState("");
  const [quality, setQuality] = useState<Quality>("320");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [d, q] = await Promise.all([
        ipc.getDownloadDir(),
        ipc.getDownloadQuality(),
      ]);
      setDir(d);
      setQuality(q);
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const choose = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const picked = await ipc.chooseDownloadDir();
      if (picked) setDir(picked);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setDir(await ipc.resetDownloadDir());
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const chooseQuality = async (q: Quality): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await ipc.setDownloadQuality(q);
      setQuality(q);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-xl divide-y divide-border">
      <SettingRow
        title="下载保存位置"
        description="默认为安装目录下的 Download 文件夹；重名歌曲自动加序号，不会互相覆盖。"
      >
        <div className="flex items-center gap-2">
          <span
            className="max-w-52 truncate rounded border border-input bg-background px-2 py-1.5 text-xs text-muted-foreground"
            title={dir}
          >
            {dir || "…"}
          </span>
          <button
            type="button"
            onClick={() => void choose()}
            disabled={busy}
            className="rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50"
          >
            更改位置
          </button>
          <button
            type="button"
            onClick={() => void reset()}
            disabled={busy}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            恢复默认
          </button>
        </div>
      </SettingRow>
      <SettingRow
        title="默认下载音质"
        description="列表里和播放条上的下载按钮都按这个音质下载，与播放音质互不影响。"
      >
        <QualitySelect
          value={quality}
          disabled={busy}
          onChange={(q) => void chooseQuality(q)}
        />
      </SettingRow>
      {error && <p className="py-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

const SECTION_TITLES: Record<string, string> = {
  appearance: "外观",
  "desktop-lyric": "桌面歌词",
  playback: "播放",
  download: "下载",
  "source-package": "音源包",
  shortcut: "快捷键",
  about: "关于",
};

function SettingsTabs(props: { active: string }): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <div className="mb-4 flex gap-1 border-b border-border">
      {Object.entries(SECTION_TITLES).map(([key, label]) => (
        <button
          key={key}
          type="button"
          onClick={() =>
            void navigate({ to: "/settings/$section", params: { section: key } })
          }
          className={`px-3 py-2 text-xs transition-colors ${
            props.active === key
              ? "border-b-2 border-[var(--primary)] font-medium text-[var(--primary)]"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function SettingsPage(props: { section: string }): React.JSX.Element {
  const title = SECTION_TITLES[props.section] ?? "设置";
  return (
    // 分节标签固定在顶部（滚动区外），内容滚动时始终可见
    <PageContainer
      title={`设置 · ${title}`}
      stickyHeader={<SettingsTabs active={props.section} />}
    >
      {props.section === "appearance" ? (
        <AppearanceSection />
      ) : props.section === "desktop-lyric" ? (
        // 桌面歌词独立成一个标签页（配置够多，塞在外观里太挤）
        <DesktopLyricSection />
      ) : props.section === "playback" ? (
        <PlaybackSection />
      ) : props.section === "download" ? (
        <DownloadSection />
      ) : props.section === "source-package" ? (
        <SourcePackageSection />
      ) : props.section === "shortcut" ? (
        <ShortcutSection />
      ) : props.section === "about" ? (
        <AboutSection />
      ) : (
        <GenericSection hint={title} />
      )}
    </PageContainer>
  );
}
