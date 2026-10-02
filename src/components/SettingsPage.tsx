import { useCallback, useEffect, useRef, useState } from "react";
import { errMsg, stripErrorUrls } from "@/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import { getAllWindows } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
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
import {
  activateSourcePack,
  applySourceUpdate,
  discoverSourceUpdates,
  getSourceState,
  installSourceLabel,
  installStagedSource,
  isPackLinkUrl,
  kindLabel,
  lastErrorSummary,
  offerLabel,
  packDisplayName,
  packVersionLabel,
  shortUpdateDate,
  stageSourceFromFile,
  stageSourceFromUrl,
  uninstallSourcePack,
  type PackPreviewVo,
  type SourcePackVo,
} from "@/source-scripts/source-update";
import { SKINS, getSkin } from "@/lib/skins";
import { QUALITY_OPTIONS } from "@/lib/quality";
import {
  EQ_BANDS,
  EQ_GAIN_LIMIT_DB,
  EQ_PRESETS,
  FADE_DURATION_OPTIONS,
  SPEED_OPTIONS,
  eqBandLabel,
  speedLabel,
} from "@/lib/fx";
import type {
  AppearancePreference,
  AppVersion,
  AudioCacheClearResult,
  AudioCacheStats,
  DesktopLyricState,
  DesktopLyricStylePatch,
  EqParams,
  FxState,
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

      <SettingRow
        title={`歌词窗口宽度（${state.width}px）`}
        description="调窄后长行歌词会自动横向滚动（歌词滚动）；在歌词上悬停工具条里也有 窄/宽 按钮，拖动窗口边缘同样可调"
      >
        <input
          type="range"
          min={480}
          max={1280}
          step={20}
          value={state.width}
          onChange={(e) => {
            const w = Number(e.target.value);
            void (async () => {
              try {
                const windows = await getAllWindows();
                const win = windows.find((candidate) => candidate.label === "lyrics");
                if (!win) return;
                const pos = await win.outerPosition();
                const size = await win.outerSize();
                const next = await ipc.setDesktopLyricBounds(pos.x, pos.y, w, size.height);
                setState(next);
              } catch {
                /* 窗口暂不可用时忽略，下一次交互会重试 */
              }
            })();
          }}
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
  const saveError = useAppearanceStore((s) => s.saveError);
  const retrySave = useAppearanceStore((s) => s.retrySave);
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
      {/* 写库失败必须看得见：以前是「界面已生效、重启却回滚」而用户无从察觉（P2-8）。
          role="alert" 让读屏器也念出来（P2-10）。 */}
      {saveError !== null && (
        <div
          role="alert"
          className="mb-4 flex items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <span>{saveError}</span>
          <button
            type="button"
            onClick={() => void retrySave()}
            className="shrink-0 rounded border border-destructive/40 px-2 py-0.5 transition-colors hover:bg-destructive/10"
          >
            重试
          </button>
        </div>
      )}
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
  const [speed, setSpeedState] = useState(1);
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
      if (snap?.speed) setSpeedState(snap.speed);
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

  const chooseSpeed = async (v: number): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await ipc.setSpeed(v);
      setSpeedState(v);
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
      <SettingRow
        title="默认倍速"
        description={`当前 ${speedLabel(speed)}。播放条上的倍速菜单与本处相同：立即生效并记忆，所有歌曲通用。`}
      >
        <select
          value={speed}
          disabled={busy}
          aria-label="默认倍速"
          onChange={(e) => void chooseSpeed(Number(e.target.value))}
          className="rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {SPEED_OPTIONS.map((v) => (
            <option key={v} value={v}>
              {speedLabel(v)}
            </option>
          ))}
        </select>
      </SettingRow>
      {error && <p className="py-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** 音效设置：均衡器 / 响度归一化 / 淡入淡出（引擎侧 DSP，立即生效） */
function SoundSection(): React.JSX.Element {
  const [fx, setFx] = useState<FxState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 滑条拖动会高频触发，统一走本地状态 + 120ms 防抖下发
  const eqTimerRef = useRef<number | null>(null);

  useEffect(() => {
    void ipc
      .getFxState()
      .then(setFx)
      .catch((err) => setError(errMsg(err)));
    return () => {
      if (eqTimerRef.current !== null) window.clearTimeout(eqTimerRef.current);
    };
  }, []);

  const pushEq = useCallback((next: EqParams): void => {
    setFx((f) => (f ? { ...f, eq: next } : f));
    if (eqTimerRef.current !== null) window.clearTimeout(eqTimerRef.current);
    eqTimerRef.current = window.setTimeout(() => {
      void ipc.setEq(next).catch((err) => setError(errMsg(err)));
    }, 120);
  }, []);

  if (!fx) {
    return (
      <div className="max-w-xl">
        {error ? (
          <p className="py-4 text-xs text-destructive">{error}</p>
        ) : (
          <p className="py-4 text-xs text-muted-foreground">正在读取音效设置…</p>
        )}
      </div>
    );
  }

  const eq = fx.eq;
  const activePreset = EQ_PRESETS.find(
    (p) => p.gains.every((g, i) => Math.abs(g - (eq.gainsDb[i] ?? 0)) < 0.5),
  );

  return (
    <div className="max-w-xl divide-y divide-border">
      <SettingRow
        title="响度归一化"
        description="不同音源的响度标准不一致，切歌忽大忽小？开启后按曲目实际响度自动调节增益（±12dB 内），音量更平稳。"
      >
        <Switch
          checked={fx.loudnorm}
          onToggle={() => {
            const next = !fx.loudnorm;
            setFx({ ...fx, loudnorm: next });
            void ipc.setLoudnorm(next).catch((err) => setError(errMsg(err)));
          }}
        />
      </SettingRow>
      <SettingRow
        title="淡入淡出"
        description="暂停时声音缓缓淡出，恢复播放时缓缓淡入，听感更柔和。"
      >
        <div className="flex items-center gap-2">
          {fx.fade.enabled && (
            <Segmented
              value={String(fx.fade.durationMs)}
              options={FADE_DURATION_OPTIONS.map((ms) => ({
                value: String(ms),
                label: `${ms}ms`,
              }))}
              onChange={(v) => {
                const next = { ...fx.fade, durationMs: Number(v) };
                setFx({ ...fx, fade: next });
                void ipc.setFade(next).catch((err) => setError(errMsg(err)));
              }}
            />
          )}
          <Switch
            checked={fx.fade.enabled}
            onToggle={() => {
              const next = { ...fx.fade, enabled: !fx.fade.enabled };
              setFx({ ...fx, fade: next });
              void ipc.setFade(next).catch((err) => setError(errMsg(err)));
            }}
          />
        </div>
      </SettingRow>

      <SettingRow
        title="频谱背景"
        description="播放条底部随音乐频率跳动的方块（实时频谱）。关闭时引擎不做任何频谱计算，无额外开销。"
      >
        <Switch
          checked={fx.spectrum}
          onToggle={() => {
            const next = !fx.spectrum;
            setFx({ ...fx, spectrum: next });
            void ipc.setSpectrum(next).catch((err) => setError(errMsg(err)));
          }}
        />
      </SettingRow>

      <div className="py-3">
        <div className="flex items-center justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-sm">均衡器</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              十段图示均衡器（±12dB）；开启时自动压低前置放大防削波
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <select
              value={activePreset?.name ?? "自定义"}
              disabled={!eq.enabled}
              aria-label="均衡器预设"
              onChange={(e) => {
                const preset = EQ_PRESETS.find((p) => p.name === e.target.value);
                if (preset) pushEq({ ...eq, gainsDb: [...preset.gains] });
              }}
              className="rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {EQ_PRESETS.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
              {!activePreset && <option value="自定义">自定义</option>}
            </select>
            <Switch
              checked={eq.enabled}
              onToggle={() => pushEq({ ...eq, enabled: !eq.enabled })}
            />
          </div>
        </div>

        {eq.enabled && (
          <div className="mt-4">
            <div className="flex items-center justify-between gap-4 text-xs">
              <span className="shrink-0 text-muted-foreground">前置放大</span>
              <input
                type="range"
                min={-EQ_GAIN_LIMIT_DB}
                max={EQ_GAIN_LIMIT_DB}
                step={0.5}
                value={eq.preampDb}
                onChange={(e) => pushEq({ ...eq, preampDb: Number(e.target.value) })}
                className="w-48 accent-[var(--primary)]"
                aria-label="前置放大"
              />
              <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
                {eq.preampDb > 0 ? "+" : ""}
                {eq.preampDb.toFixed(1)}dB
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-2.5">
              {EQ_BANDS.map((hz, i) => (
                <div key={hz} className="flex items-center gap-2 text-xs">
                  <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">
                    {eqBandLabel(hz)}
                  </span>
                  <input
                    type="range"
                    min={-EQ_GAIN_LIMIT_DB}
                    max={EQ_GAIN_LIMIT_DB}
                    step={1}
                    value={eq.gainsDb[i] ?? 0}
                    onChange={(e) => {
                      const gainsDb = [...eq.gainsDb];
                      gainsDb[i] = Number(e.target.value);
                      pushEq({ ...eq, gainsDb });
                    }}
                    className="min-w-0 flex-1 accent-[var(--primary)]"
                    aria-label={`${eqBandLabel(hz)}Hz 增益`}
                  />
                  <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
                    {(eq.gainsDb[i] ?? 0) > 0 ? "+" : ""}
                    {eq.gainsDb[i] ?? 0}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {error && <p className="py-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** 通用设置：开机自启 / 缓存管理（播放缓存上限 + 分项清理） */

/** 播放缓存上限档位（MB；"0" = 不限）。与 cache.rs 的语义一致 */
const CACHE_LIMIT_OPTIONS: { value: string; label: string }[] = [
  { value: "256", label: "256M" },
  { value: "512", label: "512M" },
  { value: "1024", label: "1G" },
  { value: "2048", label: "2G" },
  { value: "0", label: "不限" },
];
/** settings 里没有上限记录时的默认档（cache.rs DEFAULT_AUDIO_CACHE_LIMIT_MB） */
const CACHE_LIMIT_DEFAULT = "512";

function GeneralSection(): React.JSX.Element {
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  const [cache, setCache] = useState<AudioCacheStats | null>(null);
  const [limit, setLimit] = useState<string | null>(null);
  // 分项清理：勾选要清的内容（默认两项都清）
  const [clearAudio, setClearAudio] = useState(true);
  const [clearWeb, setClearWeb] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void ipc
      .autostartState()
      .then(setAutostartState)
      .catch(() => setAutostartState(false));
    void refreshCache();
    // 上限档回显：脏数据/缺项都回落默认档（与引擎侧 parse 口径一致）
    void ipc
      .getSetting("cache.audioLimitMb")
      .then((raw) => setLimit(raw && raw.trim() ? raw.trim() : CACHE_LIMIT_DEFAULT))
      .catch(() => setLimit(CACHE_LIMIT_DEFAULT));
  }, []);

  const refreshCache = async (): Promise<void> => {
    try {
      setCache(await ipc.audioCacheStats());
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const toggleAutostart = async (): Promise<void> => {
    if (autostart === null) return;
    setError(null);
    try {
      await ipc.setAutostart(!autostart);
      setAutostartState(!autostart);
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const changeLimit = async (v: string): Promise<void> => {
    const prev = limit;
    setLimit(v); // 乐观更新，失败回滚
    setError(null);
    try {
      await ipc.setAudioCacheLimit(Number(v));
    } catch (err) {
      setLimit(prev);
      setError(errMsg(err));
    }
  };

  const clearCache = async (): Promise<void> => {
    setClearing(true);
    setError(null);
    try {
      const tasks: Promise<AudioCacheClearResult>[] = [];
      if (clearAudio) tasks.push(ipc.clearAudioCache());
      if (clearWeb) tasks.push(ipc.clearWebCache());
      const results = await Promise.all(tasks);
      const freed = results.reduce((sum, r) => sum + r.freedBytes, 0);
      const failed = results.reduce((sum, r) => sum + r.failedCount, 0);
      setMessage(
        freed === 0 && failed === 0
          ? "没有可清理的内容"
          : failed > 0
            ? `已清理 ${formatBytes(freed)}；${failed} 个文件被占用跳过（正在播放的不会删）`
            : `已清理 ${formatBytes(freed)}`,
      );
      await refreshCache();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setClearing(false);
    }
  };

  const nothingSelected = !clearAudio && !clearWeb;

  const openLogs = async (): Promise<void> => {
    setError(null);
    try {
      await ipc.revealLogs();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  return (
    <div className="max-w-xl divide-y divide-border">
      <SettingRow title="开机自启" description="登录 Windows 后自动启动轻听（收起在托盘）">
        {autostart === null ? (
          <span className="text-xs text-muted-foreground">…</span>
        ) : (
          <Switch checked={autostart} onToggle={() => void toggleAutostart()} />
        )}
      </SettingRow>
      <SettingRow
        title="播放缓存上限"
        description={
          cache
            ? `在线播放的音频会先缓冲到磁盘（边下边播）。超过上限自动清理最旧的缓存文件，正在播放的不受影响。当前 ${formatBytes(cache.totalBytes)} · ${cache.fileCount} 个文件`
            : "在线播放的音频会先缓冲到磁盘（边下边播）。超过上限自动清理最旧的缓存文件，正在播放的不受影响。"
        }
      >
        {limit === null ? (
          <span className="text-xs text-muted-foreground">…</span>
        ) : (
          <Segmented
            value={limit}
            options={CACHE_LIMIT_OPTIONS}
            onChange={(v) => void changeLimit(v)}
          />
        )}
      </SettingRow>
      <SettingRow
        title="清理缓存"
        description={
          cache
            ? `勾选要清理的内容：播放缓存 ${formatBytes(cache.totalBytes)} / 图片缓存 ${formatBytes(cache.webBytes)}（封面等图片，清了会自动重新加载）。不影响已下载的音乐、登录状态与界面设置`
            : "勾选要清理的内容。不影响已下载的音乐、登录状态与界面设置"
        }
      >
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={clearAudio}
              onChange={(e) => setClearAudio(e.target.checked)}
              className="h-3.5 w-3.5 accent-primary"
            />
            播放
          </label>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={clearWeb}
              onChange={(e) => setClearWeb(e.target.checked)}
              className="h-3.5 w-3.5 accent-primary"
            />
            图片
          </label>
          <button
            type="button"
            onClick={() => void clearCache()}
            disabled={clearing || nothingSelected}
            className="rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50"
          >
            {clearing ? "清理中…" : "清理"}
          </button>
        </div>
      </SettingRow>
      <SettingRow
        title="诊断日志"
        description="应用与播放的运行日志保存在本机（%APPDATA%/QuietMusic/logs），反馈问题时可一并附上"
      >
        <button
          type="button"
          onClick={() => void openLogs()}
          className="rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent"
        >
          打开日志文件夹
        </button>
      </SettingRow>
      {message && <p className="py-2 text-xs text-muted-foreground">{message}</p>}
      {error && <p className="py-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** 字节量人话显示（缓存统计用） */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 音质下拉（设置页两处共用：默认播放 / 默认下载） */function QualitySelect(props: {
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

/** 包列表单行文案：包名 · 版本 · code */
function packLabel(p: SourcePackVo): string {
  return `${packDisplayName(p)} · ${packVersionLabel(p)} (code ${p.versionCode})`;
}

/** 卸载按钮的「两击确认」状态：null = 未武装；否则记录包 id 与计时器 */
type ArmedUninstall = { packId: string; timer: number };

/** 本会话已提示过的剪贴板链接（同一链接只提示一次，忽略/安装都算） */
const PROMPTED_CLIPBOARD_LINKS = new Set<string>();

/** 音源包设置（v3 统一包模型，与 uniappx 设置面板同口径）：
 *  - 数据包/播放包同构：单文件 js、首行 __QT_PACK__ 包头自描述身份；
 *  - 数据槽 = 内置基线 + 可选安装的数据包覆盖（单选，随时切回基线）；
 *  - 播放槽 = 用户安装的播放包（不随应用分发，多包共存其一生效）；
 *  - 更新发现三通道合一（每包 updateUrl / 基线 / 官方 manifest），
 *    只提示不自动装，这里可以逐条应用；
 *  - 安装入口：https 直链 / 本地文件（系统选择框），先预览确认再落盘
 *    （包头 id 自称官方包时显著警示），剪贴板有包链接时主动询问；
 *    卸载两击确认。
 *  状态事实来源是 Rust state.json（v3）；安装/切换/卸载后 Rust 广播
 *  source-pack-changed / source-meta-changed，引擎页热切换生效——
 *  不重启应用、不打断播放。 */
function SourcePackageSection(): React.JSX.Element {
  const local = useSourceUpdateStore((s) => s.local);
  const offers = useSourceUpdateStore((s) => s.offers);
  const baselineMeta = useSourceUpdateStore((s) => s.baselineMeta);
  const message = useSourceUpdateStore((s) => s.message);
  const busy = useSourceUpdateStore((s) => s.busy);
  const setBusy = useSourceUpdateStore((s) => s.setBusy);
  const setMessage = useSourceUpdateStore((s) => s.setMessage);
  const setLocal = useSourceUpdateStore((s) => s.setLocal);
  const setOffers = useSourceUpdateStore((s) => s.setOffers);
  const setBaselineMeta = useSourceUpdateStore((s) => s.setBaselineMeta);
  const dropOffer = useSourceUpdateStore((s) => s.dropOffer);
  const [url, setUrl] = useState("");
  const [installing, setInstalling] = useState(false);
  const [armed, setArmed] = useState<ArmedUninstall | null>(null);
  /** 安装预览现场（非 null = 预览确认弹窗开着） */
  const [preview, setPreview] = useState<PackPreviewVo | null>(null);
  /** 预览确认后的落盘安装中 */
  const [confirming, setConfirming] = useState(false);
  /** 剪贴板检测到的音源包链接（非 null = 询问弹窗开着） */
  const [clipTip, setClipTip] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLocal(await getSourceState());
    } catch {
      // 状态读取失败保持旧值（设置页其余操作仍可用）
    }
  }, [setLocal]);

  useEffect(() => {
    void refresh();
    // Rust 侧包变化（安装/切换/卸载/回滚，含引擎 describe 回填）时同步列表
    const unlisteners: (() => void)[] = [];
    void listen("source-pack-changed", () => void refresh()).then((u) =>
      unlisteners.push(u),
    );
    void listen("source-meta-changed", () => void refresh()).then((u) =>
      unlisteners.push(u),
    );
    return () => unlisteners.forEach((u) => u());
  }, [refresh]);

  // 武装态在组件卸载时清理计时器（3 秒自动解除在事件回调里做）
  useEffect(
    () => () => {
      if (armed?.timer) window.clearTimeout(armed.timer);
    },
    [armed],
  );

  // 剪贴板链接检测：设置页音源包区挂载 / 窗口重新聚焦时读一次剪贴板，
  // 是「https … .js」直链且本会话没提示过 → 询问是否安装（确认后仍走预览）。
  // WebView2 未聚焦/无权限时 readText 会 reject，静默降级不打扰。
  const clipboardBusy = installing || confirming || busy;
  useEffect(() => {
    let disposed = false;
    const checkClipboard = (): void => {
      if (disposed || clipboardBusy || preview || clipTip !== null) return;
      void (async () => {
        let text = "";
        try {
          text = await navigator.clipboard.readText();
        } catch {
          return; // 读不到（未聚焦/权限）就当没有
        }
        const link = text.trim();
        if (
          disposed ||
          clipboardBusy ||
          preview ||
          clipTip !== null ||
          !isPackLinkUrl(link) ||
          PROMPTED_CLIPBOARD_LINKS.has(link)
        ) {
          return;
        }
        PROMPTED_CLIPBOARD_LINKS.add(link);
        if (!disposed) setClipTip(link);
      })();
    };
    checkClipboard();
    window.addEventListener("focus", checkClipboard);
    return () => {
      disposed = true;
      window.removeEventListener("focus", checkClipboard);
    };
  }, [clipboardBusy, preview, clipTip]);

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

  /** 手动检查（force=true 越过 4h/包 探测节流；发现不自动安装） */
  const check = async (): Promise<string> => {
    const result = await discoverSourceUpdates(true);
    setOffers(result.offers);
    setBaselineMeta(result.baselineMeta);
    await refresh();
    if (!result.offers.length) return "已是最新（没有可用更新）";
    return `发现 ${result.offers.length} 个可用更新，逐条确认后应用`;
  };

  /** 应用单条更新 offer（失败 Rust 自动回滚并拉黑该版本，这里只需提示） */
  const apply = async (index: number): Promise<string> => {
    const offer = offers[index];
    if (!offer) return "没有可用更新";
    const outcome = await applySourceUpdate(offer);
    dropOffer(offer.targetId, offer.kind);
    await refresh();
    return `${kindLabel(outcome.kind)}已更新到 v${outcome.pack.versionCode}（${outcome.pack.name}）`;
  };

  /** 启用包 / 切回内置基线（packId 空串 + kind=meta） */
  const activate = async (
    packId: string,
    kind: "meta" | "play",
  ): Promise<string> => {
    await activateSourcePack(packId, kind);
    await refresh();
    if (kind === "meta") {
      return packId ? "已切换生效数据包" : "已切回内置基线数据包";
    }
    return "已切换生效播放包";
  };

  /** 两击确认的卸载：第一击武装（3 秒内再点确认），第二击执行 */
  const uninstall = async (pack: SourcePackVo): Promise<string> => {
    if (armed?.packId !== pack.id) {
      if (armed?.timer) window.clearTimeout(armed.timer);
      setArmed({
        packId: pack.id,
        timer: window.setTimeout(() => setArmed(null), 3000),
      });
      return "再点一次确认卸载";
    }
    if (armed.timer) window.clearTimeout(armed.timer);
    setArmed(null);
    const wasActivePlay = pack.kind === "play" && local?.activeId === pack.id;
    await uninstallSourcePack(pack.id);
    await refresh();
    return wasActivePlay
      ? "已卸载播放包（在线播放将不可用，可重新安装）"
      : `已卸载${kindLabel(pack.kind)}`;
  };

  /** 预览安装第一步：拉全文+静态校验，把预览信息交给确认弹窗（不落盘） */
  const stageFromLink = (link: string): void => {
    if (busy || installing || confirming || preview) return;
    setInstalling(true);
    void (async () => {
      try {
        setPreview(await stageSourceFromUrl(link));
      } catch (e) {
        setMessage(`获取包信息失败：${stripErrorUrls(String(e))}`);
      } finally {
        setInstalling(false);
      }
    })();
  };

  const installUrl = (): void => {
    const trimmed = url.trim();
    if (!trimmed) {
      setMessage("请先粘贴音源包 .js 直链");
      return;
    }
    stageFromLink(trimmed);
  };

  const installLocal = (): void => {
    if (busy || installing || confirming || preview) return;
    setInstalling(true);
    void (async () => {
      try {
        const staged = await stageSourceFromFile();
        if (!staged) {
          setMessage(""); // 用户取消选择，不打扰
          return;
        }
        setPreview(staged);
      } catch (e) {
        setMessage(`获取包信息失败：${stripErrorUrls(String(e))}`);
      } finally {
        setInstalling(false);
      }
    })();
  };

  /** 预览确认：按一次性 token 落盘安装（官方 id 冒充警示已在弹窗给过） */
  const confirmInstall = (): void => {
    const staged = preview;
    if (!staged || confirming) return;
    setConfirming(true);
    void (async () => {
      try {
        const outcome = await installStagedSource(staged.token);
        setPreview(null);
        setUrl("");
        await refresh();
        setMessage(
          `${kindLabel(outcome.kind)}已安装${outcome.activated ? "并生效" : "，列表中可启用"}`,
        );
      } catch (e) {
        setPreview(null);
        setMessage(`安装失败：${stripErrorUrls(String(e))}`);
      } finally {
        setConfirming(false);
      }
    })();
  };

  const packs = local?.packs ?? [];
  const metaPacks = packs.filter((p) => p.kind === "meta");
  const playPacks = packs.filter((p) => p.kind === "play");
  const activeMeta = metaPacks.find((p) => p.id === local?.activeMetaId) ?? null;
  const activePlay = playPacks.find((p) => p.id === local?.activeId) ?? null;
  const metaStatus = activeMeta
    ? packLabel(activeMeta)
    : `内置基线${baselineMeta ? ` · ${baselineMeta.name} ${baselineMeta.versionName} (code ${baselineMeta.code})` : ""}`;
  const playStatus = activePlay
    ? packLabel(activePlay)
    : "未安装（在线播放不可用）";

  return (
    <div className="max-w-xl divide-y divide-border">
      <SettingRow
        title="数据包"
        description="搜索/歌单/歌词/封面等数据源。内置基线随应用发版，可另装数据包覆盖。"
      >
        <span className="font-mono text-xs text-muted-foreground">{metaStatus}</span>
      </SettingRow>
      <SettingRow
        title="播放包"
        description="在线播放（取链）必需；高风险源不随应用分发，由用户自行安装。"
      >
        <span className="font-mono text-xs text-muted-foreground">{playStatus}</span>
      </SettingRow>
      <SettingRow
        title="已安装的音源包"
        description={`共 ${packs.length} 个（数据 ${metaPacks.length} / 播放 ${playPacks.length}）。启用即热切换；卸载两击确认。`}
      >
        <div className="flex w-full flex-col gap-2">
          {packs.length === 0 && (
            <span className="text-xs text-muted-foreground">
              还没有安装任何音源包（数据接口使用内置基线，正常可用）
            </span>
          )}
          {metaPacks.length > 0 && (
            <span className="text-[11px] font-medium text-muted-foreground">数据包</span>
          )}
          {metaPacks.map((p) => (
            <PackRow
              key={p.id}
              pack={p}
              radioName="active-meta-pack"
              checked={local?.activeMetaId === p.id}
              busy={busy}
              armed={armed?.packId === p.id}
              onActivate={() => void run(() => activate(p.id, "meta"))}
              onUninstall={() => void run(() => uninstall(p))}
            />
          ))}
          {metaPacks.length > 0 && (
            <div className="flex items-center gap-2 text-xs">
              <input
                type="radio"
                name="active-meta-pack"
                aria-label="启用内置基线数据包"
                checked={!local?.activeMetaId}
                onChange={() => void run(() => activate("", "meta"))}
                disabled={busy}
              />
              <span className="flex-1 font-mono text-muted-foreground">
                内置基线（随应用分发）
              </span>
            </div>
          )}
          {playPacks.length > 0 && (
            <span className="mt-1 text-[11px] font-medium text-muted-foreground">
              播放包
            </span>
          )}
          {playPacks.map((p) => (
            <PackRow
              key={p.id}
              pack={p}
              radioName="active-play-pack"
              checked={local?.activeId === p.id}
              busy={busy}
              armed={armed?.packId === p.id}
              onActivate={() => void run(() => activate(p.id, "play"))}
              onUninstall={() => void run(() => uninstall(p))}
            />
          ))}
        </div>
      </SettingRow>
      <SettingRow
        title="可用更新"
        description="更新只提示不自动安装；应用失败会自动回滚到原版本并跳过该版本。"
      >
        <div className="flex w-full flex-col items-end gap-2">
          {offers.length === 0 ? (
            <span className="text-xs text-muted-foreground">暂无可用更新</span>
          ) : (
            offers.map((o, i) => (
              <div
                key={`${o.kind}:${o.targetId}`}
                className="flex w-full items-center gap-2"
              >
                <span className="flex-1 text-xs text-muted-foreground">
                  {offerLabel(o)}
                </span>
                <button
                  type="button"
                  onClick={() => void run(() => apply(i))}
                  disabled={busy}
                  className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                >
                  更新
                </button>
              </div>
            ))
          )}
          <button
            type="button"
            onClick={() => void run(check)}
            disabled={busy}
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
          >
            {busy ? "处理中…" : "检查更新"}
          </button>
        </div>
      </SettingRow>
      <SettingRow
        title="从链接安装"
        description="粘贴音源包 .js 直链（https）安装；数据包/播放包自动识别。"
      >
        <div className="flex w-full flex-col gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…/play-bundle.js"
            className="w-full rounded-md border border-border px-3 py-1.5 text-xs"
          />
          <button
            type="button"
            onClick={installUrl}
            disabled={busy || installing || confirming || !url.trim()}
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
          >
            {installing ? "获取包信息…" : "安装"}
          </button>
        </div>
      </SettingRow>
      <SettingRow
        title="从本地文件安装"
        description="选择本地 .js 音源包文件安装（适合手动下载/离线分发）。"
      >
        <button
          type="button"
          onClick={installLocal}
          disabled={busy || installing || confirming}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
        >
          {installing ? "获取包信息…" : "选择文件…"}
        </button>
      </SettingRow>
      {clipTip !== null && !preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl border border-border bg-card p-4 shadow-lg">
            <div className="text-sm font-medium text-foreground">
              检测到剪贴板有音源包链接
            </div>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {clipTip}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">是否安装？</p>
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setClipTip(null)}
                className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  const link = clipTip;
                  setClipTip(null);
                  if (link) stageFromLink(link);
                }}
                className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
              >
                安装
              </button>
            </div>
          </div>
        </div>
      )}
      {preview && (
        <InstallPreviewDialog
          preview={preview}
          busy={confirming}
          onConfirm={confirmInstall}
          onCancel={() => setPreview(null)}
        />
      )}
      {message && <div className="py-3 text-xs text-muted-foreground">{message}</div>}
    </div>
  );
}

/**
 * 安装预览确认弹窗（URL/本地文件安装的必经一步；manifest 通道的更新确认
 * 已含版本信息，不走这里）。官方 id 包在预览前已通过 ed25519 签名硬校验
 * （假包到不了这里），弹窗里直接展示「官方 · 已验签」。
 */
function InstallPreviewDialog(props: {
  preview: PackPreviewVo;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const p = props.preview;
  const rows: Array<[string, React.ReactNode]> = [
    ["类型", kindLabel(p.kind)],
    ["名称", p.name.trim() || kindLabel(p.kind)],
    [
      "版本",
      p.versionName.trim() ? `${p.versionName} (code ${p.versionCode})` : `v${p.versionCode}`,
    ],
    ["包 id", <span key="id" className="font-mono">{p.id}</span>],
    [
      "来源",
      p.channel === "file"
        ? `本地文件 ${p.reference}`
        : p.reference || "—",
    ],
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-4 shadow-lg">
        <div className="text-sm font-medium text-foreground">安装音源包</div>
        <div className="mt-2 flex flex-col gap-1 text-xs">
          {rows.map(([key, value]) => (
            <div key={key} className="flex gap-2">
              <span className="w-10 shrink-0 text-muted-foreground">{key}</span>
              <span className="min-w-0 flex-1 break-all">{value}</span>
            </div>
          ))}
        </div>
        {p.installedCode > 0 ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            将替换已安装的 v{p.installedCode}（同 id 原位更新）
          </p>
        ) : null}
        {p.signatureVerified ? (
          <div className="mt-2 rounded-lg bg-primary/10 px-3 py-2 text-[11px] leading-relaxed text-primary">
            ✓ 官方签名校验通过（ed25519，与官方发布密钥匹配）
          </div>
        ) : null}
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={props.onCancel}
            disabled={props.busy}
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={props.onConfirm}
            disabled={props.busy}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {props.busy ? "安装中…" : "安装"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 包列表单行：单选启用 + 卸载（两击确认，武装态变红） */
function PackRow(props: {
  pack: SourcePackVo;
  radioName: string;
  checked: boolean;
  busy: boolean;
  armed: boolean;
  onActivate: () => void;
  onUninstall: () => void;
}): React.JSX.Element {
  const activePlayWarn =
    props.pack.kind === "play" && props.checked && props.armed
      ? "卸载后在线播放将不可用"
      : "";
  // 次级信息行：安装来源 · 更新日期 ·（可选）上次失败摘要
  const metaBits = [
    installSourceLabel(props.pack.installSource),
    shortUpdateDate(props.pack.updatedAt),
  ].filter(Boolean);
  const errSummary = lastErrorSummary(props.pack.lastError);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs">
        <input
          type="radio"
          name={props.radioName}
          aria-label={`启用 ${packLabel(props.pack)}`}
          checked={props.checked}
          onChange={props.onActivate}
          disabled={props.busy}
        />
        <span className="flex-1 font-mono text-muted-foreground">
          {packLabel(props.pack)}
        </span>
        <button
          type="button"
          onClick={props.onUninstall}
          disabled={props.busy}
          className={`rounded-md border px-2 py-1 text-xs transition-colors disabled:opacity-50 ${
            props.armed
              ? "border-destructive/60 bg-destructive/10 text-destructive hover:bg-destructive/20"
              : "border-border text-destructive/80 hover:bg-accent"
          }`}
        >
          {props.armed ? "确认卸载" : "卸载"}
        </button>
      </div>
      {metaBits.length > 0 ? (
        <span className="pl-5 text-[11px] text-muted-foreground">
          {metaBits.join(" · ")}
          {errSummary ? ` · 上次失败：${errSummary}` : ""}
        </span>
      ) : null}
      {activePlayWarn ? (
        <span className="pl-5 text-[11px] text-destructive">{activePlayWarn}</span>
      ) : null}
    </div>
  );
}

function AboutSection(): React.JSX.Element {
  const [version, setVersion] = useState<AppVersion | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<string>("");
  const setUpdate = useUpdateStore((s) => s.setUpdate);

  useEffect(() => {
    void getAppVersion().then(setVersion).catch(() => {});
  }, []);

  const checkUpdate = async (): Promise<void> => {
    setChecking(true);
    setResult("");
    try {
      // 手动检查：无条件查一次。复用 runCheck：把结果写入全局 update store
      // → UpdateDialog 会弹出。
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

  return (
    <div className="max-w-xl divide-y divide-border">
      <SettingRow title="当前版本" description="轻听 PC 版">
        <span className="font-mono text-xs text-muted-foreground">
          {version ? `${version.versionName} (versionCode ${version.versionCode})` : "…"}
        </span>
      </SettingRow>
      <SettingRow title="检查更新" description="启动时自动检查一次，也可手动立即检查">
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

/** 快捷键动作 id → 中文名（模块级常量：原先定义在组件体内，每次渲染都重建一遍） */
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
      // Esc = 取消录制。必须放在 preventDefault 之前单独处理：
      // 这个监听挂在 capture 阶段并且会 stopPropagation，输入框自身的
      // onKeyDown 永远收不到事件；何况下面"排除修饰键"的列表里没有 Escape，
      // 漏掉这一行就会把 Esc 本身存成该动作的快捷键。
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setListening(null);
        return;
      }
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
      // draft 必须跟着后端返回值重建（与 reset() 一致）：若返回列表里出现了
      // draft 中不存在的 id，下面开关的 setter 就会读到 undefined 而抛错。
      const next: Record<string, { key: string; enabled: boolean }> = {};
      for (const e of list) next[e.id] = { key: e.accelerator, enabled: e.enabled };
      setDraft(next);
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
                  setDraft((prev) => {
                    // 与渲染处 `draft[e.id] ?? {…}` 同样的兜底：缺项时用 entries 的值，
                    // 否则展开 undefined 会抛 TypeError（再撞上未处理拒绝就整窗报错）
                    const cur = prev[e.id] ?? { key: e.accelerator, enabled: e.enabled };
                    return { ...prev, [e.id]: { ...cur, enabled: !cur.enabled } };
                  })
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
  const [nameFormat, setNameFormat] = useState<"artist" | "song">("artist");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [d, q, f] = await Promise.all([
        ipc.getDownloadDir(),
        ipc.getDownloadQuality(),
        ipc.getDownloadNameFormat(),
      ]);
      setDir(d);
      setQuality(q);
      setNameFormat(f);
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

  const chooseNameFormat = async (f: "artist" | "song"): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await ipc.setDownloadNameFormat(f);
      setNameFormat(f);
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
      <SettingRow
        title="下载文件名格式"
        description="下载歌曲的存盘文件名顺序：歌手-歌名 或 歌名-歌手。仅影响设置变更后新开始的下载。"
      >
        <select
          value={nameFormat}
          disabled={busy}
          aria-label="下载文件名格式"
          onChange={(e) => void chooseNameFormat(e.target.value as "artist" | "song")}
          className="rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <option value="artist">歌手 - 歌名</option>
          <option value="song">歌名 - 歌手</option>
        </select>
      </SettingRow>
      {error && <p className="py-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

const SECTION_TITLES: Record<string, string> = {
  general: "通用",
  appearance: "外观",
  "desktop-lyric": "桌面歌词",
  playback: "播放",
  sound: "音效",
  download: "下载",
  "source-package": "音源包",
  shortcut: "快捷键",
  about: "关于",
};

function SettingsTabs(props: { active: string }): React.JSX.Element {
  const navigate = useNavigate();
  // 音源包有可用更新时标签亮红点（发现只提示，进设置页逐条应用）
  const offers = useSourceUpdateStore((s) => s.offers);
  const sourceDot = offers.length > 0;
  return (
    <div className="mb-4 flex gap-1 border-b border-border">
      {Object.entries(SECTION_TITLES).map(([key, label]) => (
        <button
          key={key}
          type="button"
          onClick={() =>
            void navigate({ to: "/settings/$section", params: { section: key } })
          }
          className={`relative px-3 py-2 text-xs transition-colors ${
            props.active === key
              ? "border-b-2 border-[var(--primary)] font-medium text-[var(--primary)]"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {label}
          {key === "source-package" && sourceDot && (
            <span
              aria-label="有可用更新"
              className="absolute right-0.5 top-1.5 inline-block h-1.5 w-1.5 rounded-full bg-destructive"
            />
          )}
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
      {props.section === "general" ? (
        <GeneralSection />
      ) : props.section === "appearance" ? (
        <AppearanceSection />
      ) : props.section === "desktop-lyric" ? (
        // 桌面歌词独立成一个标签页（配置够多，塞在外观里太挤）
        <DesktopLyricSection />
      ) : props.section === "playback" ? (
        <PlaybackSection />
      ) : props.section === "sound" ? (
        <SoundSection />
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
