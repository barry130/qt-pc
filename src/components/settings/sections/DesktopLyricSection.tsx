import { useCallback, useEffect, useState } from "react";
import { LYRICS_WINDOW_LABEL } from "@/lib/window-labels";
import * as ipc from "@/services/ipc";
import { getDesktopLyricState, hideDesktopLyric, onLyricWindowChanged, resetDesktopLyric, setDesktopLyricLocked, setDesktopLyricStyle, showDesktopLyric } from "@/services/ipc";
import { type DesktopLyricState, type DesktopLyricStylePatch } from "@/types";
import { Segmented, SettingRow, Switch, cssToHex } from "../controls";
import { getAllWindows } from "@tauri-apps/api/window";
import { buttonClass } from "@/components/ui";

export function DesktopLyricSection(): React.JSX.Element {
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
    <div className="max-w-4xl divide-y divide-border pb-8">
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
        description="锁定后不能拖动窗口、鼠标点击穿透到下层窗口（歌词只读展示），并隐藏歌词工具条防止误触；解锁走托盘菜单勾选、这里或快捷键 Ctrl+Alt+K（无托盘的环境走这里或快捷键）"
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
                const win = windows.find((candidate) => candidate.label === LYRICS_WINDOW_LABEL);
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
          className={buttonClass({ variant: "primary" })}
        >
          复位到屏幕中心
        </button>
      </SettingRow>
    </div>
  );
}

/** 把 css 颜色归一成 <input type="color"> 需要的 #rrggbb。
 * 带透明的 rgba（如默认的 rgba(255,255,255,0.65)）取 RGB 部分，解析失败回退白色 */
