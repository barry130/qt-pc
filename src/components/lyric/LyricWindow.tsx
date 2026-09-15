import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  LocateFixed,
  Lock,
  LockOpen,
  Minus,
  Pause,
  Pin,
  PinOff,
  Play,
  Plus,
  Rows3,
  Settings,
  SkipBack,
  SkipForward,
  X,
} from "lucide-react";
import type { DesktopLyricState, Track } from "@/types";
import {
  getDesktopLyricState,
  getPlaybackState,
  getQueue,
  hideDesktopLyric,
  next,
  openLyricSettings,
  pause,
  previous,
  resetDesktopLyric,
  resume,
  onLyricWindowChanged,
  onPlaybackStateChanged,
  onPositionChanged,
  onQueueChanged,
  setDesktopLyricBounds,
  setDesktopLyricLocked,
  setDesktopLyricStyle,
} from "@/services/ipc";
import { findActiveIndex, mergeTranslation, parseLrc, type LyricLine } from "@/lib/lrc";
import { getPlaybackLyric } from "@/lib/localOnline";

/**
 * 桌面歌词窗口视图（DESIGN §10.2 R4）：
 * - Rust 引擎是唯一状态源：本窗口直接订阅 position-changed（250ms），
 *   以本地单调时钟为基准自行插值，不依赖主窗口转发；
 * - 整篇歌词在曲目变化时一次性拉取，逐帧只做二分查找当前行；
 * - 鼠标悬停（或右键固定）时在歌词正上方展示一行图标工具条
 *   （播放控制 / 字号 / 行数 / 配色 / 对齐 / 锁定 / 置顶 / 复位 / 设置 / 关闭），
 *   平时不显示任何按钮，样式与网易云音乐桌面歌词一致；
 * - 拖动 / 滚轮字号 / 双击换行数，落盘由 Rust 命令完成。
 */

interface InterpBase {
  positionMs: number;
  /** performance.now() 基准 */
  receivedAt: number;
}

const DEFAULT_STATE: DesktopLyricState = {
  visible: true,
  locked: false,
  x: 120,
  y: 940,
  width: 900,
  height: 180,
  alwaysOnTop: true,
  fontFamily: "",
  fontSize: 24,
  fontWeight: 700,
  letterSpacing: 0,
  lineGap: 1.35,
  gradient: ["#5b8cff", "#b18cff"],
  inactiveColor: "rgba(255,255,255,0.65)",
  opacity: 0.9,
  stroke: false,
  strokeWidth: 1,
  shadow: true,
  backgroundMode: "none",
  backgroundColor: "#000000",
  backgroundOpacity: 0,
  borderRadius: 12,
  align: "center",
  lineMode: "two-lines",
};

const LINE_MODES: DesktopLyricState["lineMode"][] = [
  "single",
  "two-lines",
  "three-lines",
];

const LINE_MODE_LABEL: Record<DesktopLyricState["lineMode"], string> = {
  single: "单行",
  "two-lines": "双行",
  "three-lines": "三行",
};

const ALIGN_ORDER: DesktopLyricState["align"][] = ["left", "center", "right"];

/** 工具条配色弹层里的预设渐变（当前行高亮色） */
const GRADIENT_PRESETS: Array<{ name: string; colors: [string, string] }> = [
  { name: "星云", colors: ["#5b8cff", "#b18cff"] },
  { name: "晴空", colors: ["#4facfe", "#00f2fe"] },
  { name: "薄荷", colors: ["#43e97b", "#38f9d7"] },
  { name: "蜜桃", colors: ["#ff9a9e", "#fecfef"] },
  { name: "暖阳", colors: ["#f6d365", "#fda085"] },
  { name: "樱桃", colors: ["#ff5f6d", "#ffc371"] },
];

const FONT_STACK = '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';

export function LyricWindow(): React.JSX.Element {
  const [ui, setUi] = useState<DesktopLyricState>(DEFAULT_STATE);
  const [lines, setLines] = useState<LyricLine[]>([]);
  const [hasTrack, setHasTrack] = useState(false);
  const [paused, setPaused] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  // 工具条：悬停即现；右键可固定（再次右键收起）
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const baseRef = useRef<InterpBase>({ positionMs: 0, receivedAt: 0 });
  const playingRef = useRef(false);
  const linesRef = useRef<LyricLine[]>([]);
  const activeIdxRef = useRef(-1);
  const rafRef = useRef(0);
  const lyricAreaRef = useRef<HTMLDivElement | null>(null);

  // 工具条：悬停即现；右键可固定（再次右键收起）；锁定时整体隐藏（防误触，
  // 解锁走托盘勾选 / 设置页 / Ctrl+Alt+K）
  const toolbarVisible = (hovered || pinned) && !ui.locked;

  // 桌面歌词是透明窗口：html/body 只要带着背景色，窗口就会显示成一块纯白板。
  // 这里在本视图挂载期间清掉，卸载时还原（主窗口同进程共用 document）。
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prevHtml = html.style.background;
    const prevBody = body.style.background;
    html.style.background = "transparent";
    body.style.background = "transparent";
    return () => {
      html.style.background = prevHtml;
      body.style.background = prevBody;
    };
  }, []);

  // 曲目变化 → 一次性拉整篇歌词
  const loadLyricFor = useCallback(async (track: Track | null): Promise<void> => {
    if (!track) {
      setHasTrack(false);
      linesRef.current = [];
      setLines([]);
      return;
    }
    setHasTrack(true);
    try {
      const lyric = await getPlaybackLyric(track);
      const merged = mergeTranslation(parseLrc(lyric.lrc), lyric.translation);
      linesRef.current = merged;
      setLines(merged);
    } catch {
      linesRef.current = [];
      setLines([]);
    }
  }, []);

  const trackKey = (t: Track | null | undefined): string =>
    t ? `${t.platform}:${t.id}` : "";
  const loadedTrackKey = useRef("");

  // —— 订阅与初始化（一次） ——
  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];

    void (async () => {
      // 初始状态（Rust setup 已对 visible 的窗口做过 show）
      try {
        const s = await getDesktopLyricState();
        if (!disposed) setUi(s);
      } catch {
        /* 状态读取失败按默认值渲染 */
      }

      // 初始曲目 + 播放状态
      try {
        const q = await getQueue();
        const track = q.index !== null ? (q.tracks[q.index] ?? null) : null;
        loadedTrackKey.current = trackKey(track);
        void loadLyricFor(track);
        const st = await getPlaybackState();
        playingRef.current = st.status === "playing";
        setPaused(st.status !== "playing");
        baseRef.current = { positionMs: st.positionMs, receivedAt: performance.now() };
      } catch {
        /* 主窗口尚未就绪时事件订阅会兜底 */
      }

      unlisten.push(
        await onQueueChanged((payload) => {
          const track =
            payload.index !== null ? (payload.tracks[payload.index] ?? null) : null;
          const key = trackKey(track);
          if (key === loadedTrackKey.current) return;
          loadedTrackKey.current = key;
          void loadLyricFor(track);
        }),
      );
      unlisten.push(
        await onPositionChanged((payload) => {
          baseRef.current = {
            positionMs: payload.positionMs,
            receivedAt: performance.now(),
          };
        }),
      );
      unlisten.push(
        await onPlaybackStateChanged((payload) => {
          playingRef.current = payload.status === "playing";
          setPaused(payload.status !== "playing");
          baseRef.current = {
            positionMs: payload.positionMs,
            receivedAt: performance.now(),
          };
        }),
      );
      unlisten.push(
        await onLyricWindowChanged((payload) => {
          setUi(payload);
        }),
      );
    })();

    return () => {
      disposed = true;
      for (const off of unlisten) off();
    };
  }, [loadLyricFor]);

  // —— rAF 插值：仅可见时运行（R4） ——
  useEffect(() => {
    const tick = (): void => {
      if (linesRef.current.length > 0) {
        const { positionMs, receivedAt } = baseRef.current;
        const now =
          positionMs + (playingRef.current ? performance.now() - receivedAt : 0);
        const idx = findActiveIndex(linesRef.current, now);
        if (idx !== activeIdxRef.current) {
          activeIdxRef.current = idx;
          setActiveIdx(idx);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // —— 内容自适应：窗口高度跟随歌词实际内容（大字号 / 三行时自动加高，
  // 内容变少时自动缩回），下限 180（工具条占位 + 两三行歌词的舒适高度），
  // 上限跟随 Rust 侧 set_bounds 的 600 夹紧。变化超过阈值才动手，避免抖动。
  useEffect(() => {
    const el = lyricAreaRef.current;
    const inner = el?.firstElementChild as HTMLElement | null;
    if (!el || !inner) return;
    const fit = (): void => {
      // 44 = 顶部工具条占位条，+12 = 底部 padding 与余量
      const needed = Math.max(180, Math.ceil(44 + inner.offsetHeight + 12));
      void (async () => {
        try {
          const win = getCurrentWindow();
          const cur = (await win.innerSize()).toLogical(await win.scaleFactor());
          if (Math.abs(cur.height - needed) <= 4) return;
          await win.setSize(new LogicalSize(cur.width, Math.min(600, needed)));
          // 立即落盘，别等下次拖动
          const pos = await win.outerPosition();
          const size = await win.outerSize();
          await setDesktopLyricBounds(pos.x, pos.y, size.width, size.height);
        } catch {
          /* 忽略：下一轮 ResizeObserver / 交互会再试 */
        }
      })();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [ui, activeIdx, lines, hasTrack, paused, toolbarVisible]);

  // —— 拖动结束 / 移动后写回位置（防抖） ——
  useEffect(() => {
    const win = getCurrentWindow();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const promise = win.onMoved(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void (async () => {
          try {
            const pos = await win.outerPosition();
            const size = await win.outerSize();
            await setDesktopLyricBounds(pos.x, pos.y, size.width, size.height);
          } catch {
            /* 越界等失败忽略，Rust 侧已有日志 */
          }
        })();
      }, 400);
    });
    return () => {
      if (timer) clearTimeout(timer);
      void promise.then((off) => off());
    };
  }, []);

  const patchStyle = useCallback(
    async (patch: Parameters<typeof setDesktopLyricStyle>[0]): Promise<void> => {
      try {
        const s = await setDesktopLyricStyle(patch);
        setUi(s);
      } catch {
        /* 忽略 */
      }
    },
    [],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      const delta = e.deltaY < 0 ? 2 : -2;
      void patchStyle({ fontSize: ui.fontSize + delta });
    },
    [patchStyle, ui.fontSize],
  );

  // 左键按下：双击切行数，否则开始拖动（锁定时禁止拖动）；工具条内部已 stopPropagation
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      if (e.detail >= 2) {
        const i = LINE_MODES.indexOf(ui.lineMode);
        void patchStyle({ lineMode: LINE_MODES[(i + 1) % LINE_MODES.length] });
      } else if (!ui.locked) {
        void getCurrentWindow().startDragging();
      }
    },
    [patchStyle, ui.lineMode, ui.locked],
  );

  // 右键：固定 / 收起工具条（等价于网易云在歌词上的右键唤出）
  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setPinned((p) => !p);
  }, []);

  const togglePlay = useCallback((): void => {
    void (paused ? resume() : pause()).catch(() => {});
  }, [paused]);

  const cycleAlign = useCallback((): void => {
    const i = ALIGN_ORDER.indexOf(ui.align);
    void patchStyle({ align: ALIGN_ORDER[(i + 1) % ALIGN_ORDER.length] });
  }, [patchStyle, ui.align]);

  const cycleLineMode = useCallback((): void => {
    const i = LINE_MODES.indexOf(ui.lineMode);
    void patchStyle({ lineMode: LINE_MODES[(i + 1) % LINE_MODES.length] });
  }, [patchStyle, ui.lineMode]);

  const bumpFont = useCallback(
    (delta: number): void => {
      void patchStyle({ fontSize: Math.max(12, Math.min(96, ui.fontSize + delta)) });
    },
    [patchStyle, ui.fontSize],
  );

  const current = activeIdx >= 0 ? lines[activeIdx] : null;
  const prev = activeIdx > 0 ? lines[activeIdx - 1] : null;
  const nextLine = activeIdx >= 0 ? lines[activeIdx + 1] : null;
  const showSecond = ui.lineMode === "two-lines";
  const showThird = ui.lineMode === "three-lines";
  const mainText = hasTrack ? (current?.text || "… 间奏 …") : "轻听 · 桌面歌词";
  const secondText = hasTrack
    ? (current?.translation || (showSecond ? nextLine?.text : undefined) || "")
    : "播放音乐时显示逐行歌词";
  const prevText = hasTrack ? (prev?.text ?? "") : "";
  const thirdText = hasTrack ? (nextLine?.text ?? "") : "";

  const alignItems =
    ui.align === "left" ? "flex-start" : ui.align === "right" ? "flex-end" : "center";
  const textAlign = ui.align;

  // 文字基础样式：字体 / 字号 / 字间距 / 行间距 / 描边 / 阴影（桌面歌词防背景盖字的刚需）
  const baseText: React.CSSProperties = {
    fontFamily: ui.fontFamily ? `"${ui.fontFamily}", ${FONT_STACK}` : FONT_STACK,
    fontWeight: ui.fontWeight,
    letterSpacing: `${ui.letterSpacing}px`,
    lineHeight: ui.lineGap,
    WebkitTextStroke: ui.stroke
      ? `${ui.strokeWidth}px rgba(0,0,0,0.55)`
      : undefined,
    paintOrder: "stroke",
    filter: ui.shadow ? "drop-shadow(0 1px 3px rgba(0,0,0,0.7))" : undefined,
  };
  // 当前行 = 渐变高亮；非当前行 = 单色
  const currentStyle: React.CSSProperties = {
    ...baseText,
    backgroundImage: `linear-gradient(90deg, ${ui.gradient[0]}, ${ui.gradient[1]})`,
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    color: "transparent",
  };
  const inactiveStyle: React.CSSProperties = {
    ...baseText,
    color: ui.inactiveColor,
  };

  const background =
    ui.backgroundMode === "mask"
      ? `rgba(0, 0, 0, ${ui.backgroundOpacity})`
      : ui.backgroundMode === "solid"
        ? ui.backgroundColor
        : "transparent";

  return (
    <div
      className="relative flex h-screen w-screen select-none flex-col overflow-hidden rounded-lg"
      style={{
        background,
        opacity: ui.opacity,
        borderRadius: ui.borderRadius,
        cursor: toolbarVisible || ui.locked ? "default" : "move",
      }}
      onPointerDown={onPointerDown}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onWheel={onWheel}
      onContextMenu={onContextMenu}
      data-testid="lyric-window-root"
    >
      {/* 工具条独立区域（容器之外的一部分）：始终占位一条，悬停 / 右键固定时
          在这里展示，歌词永远在下方剩余空间内居中，绝不与文字重叠；
          区域跟随左 / 中 / 右对齐 */}
      <div
        className="z-20 flex h-11 w-full shrink-0 items-start px-2 pt-1"
        style={{ justifyContent: alignItems }}
        onPointerDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        {toolbarVisible && (
          <div className="relative">
          {paletteOpen && (
            <div className="absolute left-1/2 top-full mt-2 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-lg bg-black/80 px-3 py-2 shadow-lg">
              {GRADIENT_PRESETS.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  title={p.name}
                  aria-label={`配色：${p.name}`}
                  onClick={() => {
                    setPaletteOpen(false);
                    void patchStyle({ gradient: p.colors });
                  }}
                  className="h-5 w-5 rounded-full border border-white/30"
                  style={{
                    backgroundImage: `linear-gradient(90deg, ${p.colors[0]}, ${p.colors[1]})`,
                  }}
                />
              ))}
              <span className="mx-1 h-4 w-px bg-white/20" />
              <label className="flex items-center gap-1 text-[10px] text-white/70">
                起
                <input
                  type="color"
                  value={ui.gradient[0]}
                  className="h-5 w-6 cursor-pointer border-0 bg-transparent p-0"
                  onChange={(e) =>
                    void patchStyle({
                      gradient: [e.target.value, ui.gradient[1]],
                    })
                  }
                />
              </label>
              <label className="flex items-center gap-1 text-[10px] text-white/70">
                止
                <input
                  type="color"
                  value={ui.gradient[1]}
                  className="h-5 w-6 cursor-pointer border-0 bg-transparent p-0"
                  onChange={(e) =>
                    void patchStyle({
                      gradient: [ui.gradient[0], e.target.value],
                    })
                  }
                />
              </label>
            </div>
          )}
          <div className="flex items-center gap-0.5 rounded-full bg-black/75 px-2 py-1 shadow-lg">
            <ToolButton
              title={paused ? "播放" : "暂停"}
              onClick={togglePlay}
              testid="lyric-toolbar-play"
            >
              {paused ? <Play size={15} /> : <Pause size={15} />}
            </ToolButton>
            <ToolButton title="上一曲" onClick={() => void previous().catch(() => {})}>
              <SkipBack size={15} />
            </ToolButton>
            <ToolButton title="下一曲" onClick={() => void next().catch(() => {})}>
              <SkipForward size={15} />
            </ToolButton>
            <span className="mx-0.5 h-4 w-px bg-white/20" />
            <ToolButton title="缩小字号" onClick={() => bumpFont(-2)}>
              <span className="flex items-center text-[11px] font-semibold leading-none">
                A<Minus size={10} />
              </span>
            </ToolButton>
            <ToolButton title="放大字号" onClick={() => bumpFont(2)}>
              <span className="flex items-center text-[11px] font-semibold leading-none">
                A<Plus size={10} />
              </span>
            </ToolButton>
            <ToolButton
              title={`行数：${LINE_MODE_LABEL[ui.lineMode]}（点击切换）`}
              onClick={cycleLineMode}
            >
              <Rows3 size={15} />
            </ToolButton>
            <ToolButton
              title={`对齐：${
                ui.align === "left" ? "左" : ui.align === "center" ? "中" : "右"
              }（点击切换）`}
              onClick={cycleAlign}
            >
              {ui.align === "left" ? (
                <AlignLeft size={15} />
              ) : ui.align === "right" ? (
                <AlignRight size={15} />
              ) : (
                <AlignCenter size={15} />
              )}
            </ToolButton>
            <ToolButton
              title="更换配色"
              onClick={() => setPaletteOpen((o) => !o)}
              active={paletteOpen}
            >
              <span
                className="block h-3.5 w-3.5 rounded-full border border-white/40"
                style={{
                  backgroundImage: `linear-gradient(90deg, ${ui.gradient[0]}, ${ui.gradient[1]})`,
                }}
              />
            </ToolButton>
            <span className="mx-0.5 h-4 w-px bg-white/20" />
            <ToolButton
              title={ui.alwaysOnTop ? "取消置顶" : "总在最前"}
              onClick={() => void patchStyle({ alwaysOnTop: !ui.alwaysOnTop })}
            >
              {ui.alwaysOnTop ? <Pin size={15} /> : <PinOff size={15} />}
            </ToolButton>
            <ToolButton
              title={ui.locked ? "解锁歌词" : "锁定歌词（防误拖）"}
              onClick={() =>
                void setDesktopLyricLocked(!ui.locked).then(setUi).catch(() => {})
              }
              testid="lyric-toolbar-lock"
            >
              {ui.locked ? <Lock size={15} /> : <LockOpen size={15} />}
            </ToolButton>
            <ToolButton title="复位歌词位置" onClick={() => void resetDesktopLyric().then(setUi).catch(() => {})}>
              <LocateFixed size={15} />
            </ToolButton>
            <ToolButton title="歌词设置" onClick={() => void openLyricSettings().catch(() => {})}>
              <Settings size={15} />
            </ToolButton>
            <ToolButton title="关闭桌面歌词" onClick={() => void hideDesktopLyric()}>
              <X size={15} />
            </ToolButton>
          </div>
          </div>
        )}
      </div>

      {/* 歌词区：工具条下方的剩余空间；内层 my-auto 垂直居中（溢出只向下，
          scrollHeight 才能量准），跟随左 / 中 / 右对齐 */}
      <div
        ref={lyricAreaRef}
        className="flex min-h-0 w-full flex-1 flex-col overflow-hidden pb-1"
      >
        <div
          className="my-auto flex w-full flex-col gap-1"
          style={{ alignItems }}
        >
        {/* 三行模式：上一句 */}
        {showThird && prevText && (
          <div
            className="max-w-full truncate px-4"
            style={{
              ...inactiveStyle,
              fontSize: ui.fontSize * 0.6,
              textAlign,
            }}
            data-testid="lyric-prev-line"
          >
            {prevText}
          </div>
        )}

        <div
          className="max-w-full truncate px-4"
          style={{ ...currentStyle, fontSize: ui.fontSize, textAlign }}
          data-testid="lyric-main-line"
        >
          {mainText}
        </div>

        {showSecond && secondText && (
          <div
            className="max-w-full truncate px-4"
            style={{
              ...inactiveStyle,
              fontSize: ui.fontSize * 0.6,
              textAlign,
            }}
            data-testid="lyric-second-line"
          >
            {secondText}
          </div>
        )}

        {/* 三行模式：下一句 */}
        {showThird && thirdText && (
          <div
            className="max-w-full truncate px-4"
            style={{
              ...inactiveStyle,
              fontSize: ui.fontSize * 0.6,
              textAlign,
            }}
            data-testid="lyric-next-line"
          >
            {thirdText}
          </div>
        )}

        {paused && hasTrack && (
          <div className="px-4 text-[11px] text-white/50" style={{ textAlign }}>
            已暂停
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

/** 工具条图标按钮：黑色胶囊底 + 白色图标，悬停微亮 */
function ToolButton(props: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  testid?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      data-testid={props.testid}
      onClick={props.onClick}
      className={`rounded-full p-1.5 text-white/90 transition-colors hover:bg-white/20 ${
        props.active ? "bg-white/20" : ""
      }`}
    >
      {props.children}
    </button>
  );
}
