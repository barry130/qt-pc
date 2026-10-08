import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import {
  Lock,
  LockOpen,
  Minus,
  Pause,
  Play,
  Plus,
  Settings,
  SkipBack,
  SkipForward,
  X,
} from "lucide-react";
import type { DesktopLyricState, Track } from "@/types";
import { MarqueeLine } from "./MarqueeLine";
import { LyricOffsetControl } from "./LyricOffsetControl";
import { useLyricOffset } from "@/hooks/useLyricOffset";
import {
  getDesktopLyricState,
  getPlaybackState,
  getQueue,
  hideDesktopLyric,
  next,
  onLyricManuallyPicked,
  openLyricSettings,
  pause,
  previous,
  resume,
  onLyricWindowChanged,
  onPlaybackStateChanged,
  onPositionChanged,
  onQueueChanged,
  setDesktopLyricBounds,
  setDesktopLyricLocked,
  setDesktopLyricStyle,
} from "@/services/ipc";
import { listen } from "@tauri-apps/api/event";
import {
  findActiveIndex,
  karaokeFillRatio,
  mergeRomanization,
  mergeTranslation,
  parseLrc,
  parseWordByWordLrc,
  type LyricLine,
} from "@/lib/lrc";
import { crossSourceHitFromLine, dropCachedLyric, getPlaybackLyric } from "@/lib/localOnline";
import type { PlayUrlLine } from "@/source-engine/client";

/**
 * 桌面歌词窗口视图（DESIGN §10.2 R4）：
 * - Rust 引擎是唯一状态源：本窗口直接订阅 position-changed（250ms），
 *   以本地单调时钟为基准自行插值，不依赖主窗口转发；
 * - 整篇歌词在曲目变化时一次性拉取，逐帧只做二分查找当前行；
 * - 鼠标悬停（或右键固定）时在歌词正上方展示一行图标工具条
 *   （播放控制 / 字号 / 锁定 / 设置 / 关闭），平时不显示任何按钮，
 *   样式与网易云音乐桌面歌词一致；行数 / 配色 / 对齐 / 宽度 / 置顶 / 复位
 *   等低频设置收进「歌词设置」，工具条保持精简；
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
  width: 520,
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

const FONT_STACK = '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';

export function LyricWindow(): React.JSX.Element {
  const [ui, setUi] = useState<DesktopLyricState>(DEFAULT_STATE);
  const [lines, setLines] = useState<LyricLine[]>([]);
  const [hasTrack, setHasTrack] = useState(false);
  const [paused, setPaused] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  // 逐字行的整行卡拉 OK 填充比例（0~1）：非逐字行恒 1（整行渐变高亮，老行为）
  const [fillRatio, setFillRatio] = useState(1);
  // 当前曲目的 React 状态：只为驱动歌词偏移的重读（useLyricOffset 依赖它）。
  // 其余逻辑仍走 currentTrackRef（回调里读最新值，不受渲染时序影响）。
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  // 工具条：悬停即现；右键可固定（再次右键收起）
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);

  const baseRef = useRef<InterpBase>({ positionMs: 0, receivedAt: 0 });
  const playingRef = useRef(false);
  const linesRef = useRef<LyricLine[]>([]);
  const activeIdxRef = useRef(-1);
  // rAF 里比较填充比例用 ref，避免每帧读 state
  const fillRatioRef = useRef(1);
  // rAF 里读偏移用 ref：偏移在另一个组件里改，闭包捕获的旧值会让歌词一直不同步
  const offsetRef = useRef(0);
  const rafRef = useRef(0);
  const lyricAreaRef = useRef<HTMLDivElement | null>(null);

  // 桌面歌词窗口与主窗口是两个独立 WebView（各持一份 store），所以偏移也要自己
  // 去库里读一遍，不能复用主窗口的内存值。
  const lyricOffset = useLyricOffset(currentTrack);
  offsetRef.current = lyricOffset.offsetMs;

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

  const trackKey = (t: Track | null | undefined): string =>
    t ? `${t.platform}:${t.id}` : "";
  const loadedTrackKey = useRef("");
  /** 各曲目最近一次取链的命中线路（取链桥广播原始 line 对象；本窗口没有宿主侧线路记忆） */
  const crossLineByTrack = useRef(new Map<string, PlayUrlLine | null>());
  const currentTrackRef = useRef<Track | null>(null);
  const lyricSeq = useRef(0);

  // 曲目变化 → 一次性拉整篇歌词（含换源兜底：按目标源取词）
  const loadLyricFor = useCallback(async (track: Track | null): Promise<void> => {
    currentTrackRef.current = track;
    setCurrentTrack(track);
    const key = trackKey(track);
    if (!track || key.length === 0) {
      setHasTrack(false);
      linesRef.current = [];
      setLines([]);
      return;
    }
    setHasTrack(true);
    const seq = ++lyricSeq.current;
    const cross = crossSourceHitFromLine(crossLineByTrack.current.get(key) ?? null, track.platform);
    try {
      const lyric = await getPlaybackLyric(track, cross);
      // 过期取词不应用（换源后旧源的慢响应不得回填，最后应用的必须是对应源的）
      if (seq !== lyricSeq.current) return;
      // 有逐字就按逐字行渲染（自带时间轴），没有就解析普通 LRC——与播放页同口径。
      // 逐字在这里用于主行的整行卡拉 OK 填充（rAF 里按词时间轴推进渐变分界，
      // 不逐词拆 span：桌面歌词字小、带描边/阴影/跑马灯，按词渲染得不偿失）。
      const wbw = lyric.wordByWord ?? "";
      const base = wbw.length > 0 ? parseWordByWordLrc(wbw) : parseLrc(lyric.lrc);
      const merged = mergeRomanization(mergeTranslation(base, lyric.translation), lyric.romanization ?? "");
      linesRef.current = merged;
      setLines(merged);
    } catch {
      if (seq !== lyricSeq.current) return;
      linesRef.current = [];
      setLines([]);
    }
  }, []);

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

      // 五路订阅：任一注册失败都不能让这个初始化 IIFE 以"未处理拒绝"收场 ——
      // 那会弹一个说不清来源的致命浮层，而且后面的订阅静默缺失，
      // 桌面歌词从此不跟随播放（2026-10-02 收口：全局兜底只印 String(reason)，
      // 事后无从定位，所以这里补上上下文再交给全局兜底）。
      try {
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
            // 曲目以快照为准（与播放页同源）。queue-changed 在个别切歌路径下可能
            // 滞后或缺失，只认它会让桌面歌词慢一拍 —— 表现是显示上一首的词。
            const snapTrack = payload.track ?? null;
            if (snapTrack) {
              const key = trackKey(snapTrack);
              if (key !== loadedTrackKey.current) {
                loadedTrackKey.current = key;
                void loadLyricFor(snapTrack);
              }
            }
          }),
        );
        unlisten.push(
          await onLyricWindowChanged((payload) => {
            setUi(payload);
          }),
        );
        // 取链桥广播的命中线路：当前曲目被跨源兜底接走时按目标源重取歌词
        //（曲目 id/platform 不变，queue/state 事件不会触发重取，必须自己听）
        unlisten.push(
          await listen<{ platform: string; id: string; line: PlayUrlLine | null }>("play-url-line", (e) => {
            const key = `${e.payload.platform}:${e.payload.id}`;
            crossLineByTrack.current.set(key, e.payload.line);
            if (key === loadedTrackKey.current) {
              void loadLyricFor(currentTrackRef.current);
            }
          }),
        );
        // 用户在播放页手动挑了一份歌词：本窗口那份进程内缓存已经是旧词，
        // 丢掉再按同一个 key 重取 —— 取词链路会回读到刚落库的新词
        //（仅 React 侧重渲染是不够的，两边是独立 WebView，各持一份 lyricCache）
        unlisten.push(
          await onLyricManuallyPicked((payload) => {
            const track = currentTrackRef.current;
            if (track === null || payload.trackId !== trackKey(track)) return;
            const key = trackKey(track);
            dropCachedLyric(
              track,
              crossSourceHitFromLine(crossLineByTrack.current.get(key) ?? null, track.platform),
            );
            void loadLyricFor(track);
          }),
        );
      } catch (e) {
        throw new Error(`桌面歌词事件订阅注册失败：${String(e)}`);
      }
    })();

    return () => {
      disposed = true;
      for (const off of unlisten) off();
    };
  }, [loadLyricFor]);

  // —— rAF 插值：仅可见时运行（R4） ——
  useEffect(() => {
    const tick = (): void => {
      const ls = linesRef.current;
      if (ls.length > 0) {
        const { positionMs, receivedAt } = baseRef.current;
        const now =
          positionMs + (playingRef.current ? performance.now() - receivedAt : 0);
        const pos = now - offsetRef.current;
        const idx = findActiveIndex(ls, pos);
        if (idx !== activeIdxRef.current) {
          activeIdxRef.current = idx;
          setActiveIdx(idx);
        }
        // 逐字行：主行按已唱比例整行填充。0.4% 量子化——比一个字还窄，
        // 观感连续，又能少触发几次 React 渲染。
        const line = idx >= 0 ? ls[idx] : null;
        const nextFill =
          line !== null && line.words !== undefined && line.words.length > 0
            ? Math.round(karaokeFillRatio(line, pos - line.timeMs) * 250) / 250
            : 1;
        if (nextFill !== fillRatioRef.current) {
          fillRatioRef.current = nextFill;
          setFillRatio(nextFill);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // —— 内容自适应：窗口高度跟随歌词实际内容（大字号 / 三行时自动加高，
  // 内容变少时自动缩回），蒙版模式下收紧上下留白；工具条仍保留独立占位，
  // 上限跟随 Rust 侧 set_bounds 的 600 夹紧。变化超过阈值才动手，避免抖动。
  useEffect(() => {
    const el = lyricAreaRef.current;
    const inner = el?.firstElementChild as HTMLElement | null;
    if (!el || !inner) return;
    const fit = (): void => {
      // 工具条始终位于蒙版之外，保留独立的 44px 透明区域。
      // 歌词区域高度直接跟随实际排版高度，因此字号、行间距、行数变化后都会自动伸缩。
      const toolbarSpace = 44;
      const lyricVerticalPadding = ui.backgroundMode === "mask" ? 8 : 16;
      const needed = Math.ceil(toolbarSpace + inner.offsetHeight + lyricVerticalPadding);
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
  // Windows 在程序性 resize 时也可能发出 moved。等待窗口稳定后再读取最终 bounds，
  // 并串行写回，避免多个异步 moved 回调乱序把瞬时坐标覆盖成持久状态。
  useEffect(() => {
    const win = getCurrentWindow();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let generation = 0;
    let writeQueue = Promise.resolve();
    const promise = win.onMoved(() => {
      const currentGeneration = ++generation;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        writeQueue = writeQueue.then(async () => {
          if (currentGeneration !== generation) return;
          try {
            const pos = await win.outerPosition();
            const size = await win.outerSize();
            if (currentGeneration !== generation) return;
            await setDesktopLyricBounds(pos.x, pos.y, size.width, size.height);
          } catch {
            /* 越界等失败忽略，Rust 侧已有日志 */
          }
        });
      }, 400);
    });
    return () => {
      generation += 1;
      if (timer) clearTimeout(timer);
      // onMoved 注册失败（窗口正在销毁等）不该变成未处理拒绝：位置回写是尽力而为
      void promise.then((off) => off()).catch(() => {});
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
        // 拖动失败（少数平台/时机）只影响本次拖动，别弹全局浮层
        void getCurrentWindow()
          .startDragging()
          .catch(() => {});
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
  // 第二行：有罗马音（日文歌假名注音）就显示罗马音，否则仍是译文，都没有才退下一句
  const secondText = hasTrack
    ? current?.romanization ||
      current?.translation ||
      (showSecond ? nextLine?.text : undefined) ||
      ""
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
  // 当前行 = 渐变高亮；非当前行 = 单色。逐字行把渐变压进「已唱」的那段：
  // 分界点随词时间轴推进（fillRatio 来自 rAF），未唱部分走 inactiveColor ——
  // 网易云桌面歌词的卡拉 OK 观感；非逐字行保持整行渐变（老行为不变）。
  const karaokeActive =
    hasTrack && current !== null && current.words !== undefined && current.words.length > 0;
  const fillPct = Math.round(fillRatio * 1000) / 10;
  const currentStyle: React.CSSProperties = {
    ...baseText,
    backgroundImage: karaokeActive
      ? `linear-gradient(90deg, ${ui.gradient[0]} 0%, ${ui.gradient[1]} ${fillPct}%, ${ui.inactiveColor} ${fillPct}%, ${ui.inactiveColor} 100%)`
      : `linear-gradient(90deg, ${ui.gradient[0]}, ${ui.gradient[1]})`,
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    color: "transparent",
  };
  const inactiveStyle: React.CSSProperties = {
    ...baseText,
    color: ui.inactiveColor,
  };

  // 背景只绘制在歌词内容区域，不覆盖工具条预留的透明区域。
  const lyricBackground: React.CSSProperties =
    ui.backgroundMode === "mask"
      ? {
          backgroundColor: `color-mix(in srgb, ${ui.backgroundColor} ${Math.round(ui.backgroundOpacity * 100)}%, transparent)`,
          borderRadius: `${ui.borderRadius}px`,
        }
      : ui.backgroundMode === "solid"
        ? {
            backgroundColor: ui.backgroundColor,
            borderRadius: `${ui.borderRadius}px`,
          }
        : {};

  return (
    <div
      className="relative flex h-screen w-screen select-none flex-col overflow-hidden"
      style={{
        background: "transparent",
        opacity: ui.opacity,
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
          工具条固定水平居中，不随歌词对齐变位（对齐只作用于下方歌词行） */}
      <div
        className="z-20 flex h-11 w-full shrink-0 items-start px-2 pt-1"
        style={{ justifyContent: "center" }}
        onPointerDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        {toolbarVisible && (
          <div className="relative">
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
            <span className="mx-0.5 h-4 w-px bg-white/20" />
            <ToolButton
              title={ui.locked ? "解锁歌词" : "锁定歌词（防误拖）"}
              onClick={() =>
                void setDesktopLyricLocked(!ui.locked).then(setUi).catch(() => {})
              }
              testid="lyric-toolbar-lock"
            >
              {ui.locked ? <Lock size={15} /> : <LockOpen size={15} />}
            </ToolButton>
            <LyricOffsetControl
              offset={lyricOffset}
              compact
              className="pointer-events-auto"
            />
            <ToolButton title="歌词设置" onClick={() => void openLyricSettings().catch(() => {})}>
              <Settings size={15} />
            </ToolButton>
            <ToolButton title="关闭桌面歌词" onClick={() => void hideDesktopLyric().catch(() => {})}>
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
        className="flex min-h-0 w-full flex-1 flex-col overflow-hidden"
        style={{
          ...lyricBackground,
          padding: ui.backgroundMode === "mask" ? 0 : 4,
        }}
      >
        <div
          className="my-auto flex w-full flex-col gap-1"
          style={{ alignItems }}
        >
        {/* 三行模式：上一句 */}
        {showThird && prevText && (
          <MarqueeLine
            text={prevText}
            textStyle={{ ...inactiveStyle, fontSize: ui.fontSize * 0.6, textAlign }}
            className="px-4"
            testid="lyric-prev-line"
            marquee={false}
          />
        )}

        <MarqueeLine
          text={mainText}
          textStyle={{ ...currentStyle, fontSize: ui.fontSize, textAlign }}
          className="px-4"
          testid="lyric-main-line"
          marquee
          playing={!paused}
        />

        {showSecond && secondText && (
          <MarqueeLine
            text={secondText}
            textStyle={{ ...inactiveStyle, fontSize: ui.fontSize * 0.6, textAlign }}
            className="px-4"
            testid="lyric-second-line"
            marquee={false}
          />
        )}

        {/* 三行模式：下一句 */}
        {showThird && thirdText && (
          <MarqueeLine
            text={thirdText}
            textStyle={{ ...inactiveStyle, fontSize: ui.fontSize * 0.6, textAlign }}
            className="px-4"
            testid="lyric-next-line"
            marquee={false}
          />
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
