import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { DesktopLyricState, Track } from "@/types";
import {
  getDesktopLyricState,
  getLyric,
  getPlaybackState,
  getQueue,
  hideDesktopLyric,
  onLyricWindowChanged,
  onPlaybackStateChanged,
  onPositionChanged,
  onQueueChanged,
  setDesktopLyricBounds,
  setDesktopLyricLocked,
  setDesktopLyricStyle,
} from "@/services/ipc";
import { findActiveIndex, mergeTranslation, parseLrc, type LyricLine } from "@/lib/lrc";

/**
 * 桌面歌词窗口视图（DESIGN §10.2 R4）：
 * - Rust 引擎是唯一状态源：本窗口直接订阅 position-changed（250ms），
 *   以本地单调时钟为基准自行插值，不依赖主窗口转发；
 * - 整篇歌词在曲目变化时一次性拉取，逐帧只做二分查找当前行；
 * - 不可见（document.hidden）时不跑 rAF；
 * - 拖动 / 滚轮字号 / 双击换单双行 / 右键菜单，落盘由 Rust 命令完成。
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
  height: 140,
  fontSize: 24,
  fontWeight: 700,
  opacity: 0.9,
  backgroundOpacity: 0,
  stroke: false,
  shadow: true,
  gradient: ["#5b8cff", "#b18cff"],
  lineMode: "two-lines",
};

export function LyricWindow(): React.JSX.Element {
  const [ui, setUi] = useState<DesktopLyricState>(DEFAULT_STATE);
  const [lines, setLines] = useState<LyricLine[]>([]);
  const [hasTrack, setHasTrack] = useState(false);
  const [paused, setPaused] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [menuOpen, setMenuOpen] = useState(false);

  const baseRef = useRef<InterpBase>({ positionMs: 0, receivedAt: 0 });
  const playingRef = useRef(false);
  const linesRef = useRef<LyricLine[]>([]);
  const activeIdxRef = useRef(-1);
  const rafRef = useRef(0);

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
      const lyric = await getLyric(track);
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

  // 左键按下：双击切单双行，否则开始拖动；右键弹菜单
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      if (e.detail >= 2) {
        void patchStyle({ lineMode: ui.lineMode === "single" ? "two-lines" : "single" });
      } else {
        void getCurrentWindow().startDragging();
      }
    },
    [patchStyle, ui.lineMode],
  );

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenuOpen((o) => !o);
  }, []);

  const current = activeIdx >= 0 ? lines[activeIdx] : null;
  const next = activeIdx >= 0 ? lines[activeIdx + 1] : null;
  const showSecond = ui.lineMode === "two-lines";
  const mainText = hasTrack ? (current?.text || "… 间奏 …") : "轻听 · 桌面歌词";
  const secondText = hasTrack
    ? (current?.translation || (showSecond ? next?.text : undefined) || "")
    : "播放音乐时显示逐行歌词";

  const textStyle: React.CSSProperties = {
    fontSize: ui.fontSize,
    fontWeight: ui.fontWeight,
    lineHeight: 1.35,
    backgroundImage: `linear-gradient(90deg, ${ui.gradient[0]}, ${ui.gradient[1]})`,
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    color: "transparent",
    WebkitTextStroke: ui.stroke ? "1px rgba(0,0,0,0.55)" : undefined,
    filter: ui.shadow ? "drop-shadow(0 1px 3px rgba(0,0,0,0.7))" : undefined,
  };

  return (
    <div
      className="flex h-screen w-screen select-none flex-col items-center justify-center gap-1 overflow-hidden rounded-lg"
      style={{
        background: `rgba(0, 0, 0, ${ui.backgroundOpacity})`,
        opacity: ui.opacity,
        cursor: menuOpen ? "default" : "move",
      }}
      onPointerDown={onPointerDown}
      onWheel={onWheel}
      onContextMenu={onContextMenu}
      data-testid="lyric-window-root"
    >
      <div
        className="max-w-full truncate px-4 text-center"
        style={textStyle}
        data-testid="lyric-main-line"
      >
        {mainText}
      </div>
      {showSecond && secondText && (
        <div
          className="max-w-full truncate px-4 text-center"
          style={{ ...textStyle, fontSize: ui.fontSize * 0.6, opacity: 0.85 }}
          data-testid="lyric-second-line"
        >
          {secondText}
        </div>
      )}
      {paused && hasTrack && (
        <div className="text-[11px] text-white/50">已暂停</div>
      )}

      {menuOpen && (
        <div
          className="absolute right-2 top-2 z-10 min-w-32 rounded-md border border-border bg-popover p-1 text-xs text-popover-foreground shadow-md"
          onPointerDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          <MenuButton
            label={ui.locked ? "解锁歌词" : "锁定歌词"}
            onClick={() => {
              setMenuOpen(false);
              void setDesktopLyricLocked(!ui.locked).then(setUi).catch(() => {});
            }}
          />
          <MenuButton
            label="放大字号"
            onClick={() => {
              setMenuOpen(false);
              void patchStyle({ fontSize: Math.min(96, ui.fontSize + 2) });
            }}
          />
          <MenuButton
            label="缩小字号"
            onClick={() => {
              setMenuOpen(false);
              void patchStyle({ fontSize: Math.max(12, ui.fontSize - 2) });
            }}
          />
          <MenuButton
            label={ui.lineMode === "single" ? "双行显示" : "单行显示"}
            onClick={() => {
              setMenuOpen(false);
              void patchStyle({
                lineMode: ui.lineMode === "single" ? "two-lines" : "single",
              });
            }}
          />
          <MenuButton
            label="关闭歌词"
            onClick={() => {
              setMenuOpen(false);
              void hideDesktopLyric();
            }}
          />
        </div>
      )}
    </div>
  );
}

function MenuButton(props: { label: string; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className="block w-full rounded px-3 py-1.5 text-left hover:bg-secondary"
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}
