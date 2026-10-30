import { memo, useCallback, useEffect, useRef, useState } from "react";
import { formatTime, type LyricLine, type LyricWord } from "@/lib/lrc";
import {
  LYRIC_FONT_SIZE_DEFAULT,
  LYRIC_INACTIVE_RATIO,
  LYRIC_ROMANIZATION_RATIO,
  LYRIC_TRANSLATION_RATIO,
} from "@/hooks/useLyricFontSize";
import { cn } from "@/lib/utils";

/** 行高统一按字号的 1.4 倍算：字号调大时行距跟着放大，不会被行高裁掉 */
const LYRIC_LINE_HEIGHT = 1.4;

/** 把 px 换成 rem，外观里的全局字体缩放（html font-size）才能一起生效 */
function remOf(px: number): string {
  return `${(px / 16).toFixed(3)}rem`;
}

const DRAG_THRESHOLD_PX = 8;

interface LyricDrag {
  pointerId: number;
  startX: number;
  startY: number;
  startScrollTop: number;
  capture: HTMLElement;
  container: HTMLDivElement;
  previousUserSelect: string;
  previousScrollBehavior: string;
  active: boolean;
  targetIndex: number;
  /** 激活拖动时缓存的行几何量：move 里逐行读 offsetTop/clientHeight 会强制同步布局。 */
  rowGeometry: Array<{ top: number; half: number } | null> | null;
  /** 建缓存时的 active 行；换行会改行高布局（高亮行字号更大），届时整组重建。 */
  geometryAtIndex: number;
}

function releaseDrag(drag: LyricDrag | null): void {
  if (!drag) return;
  drag.container.style.userSelect = drag.previousUserSelect;
  drag.container.style.scrollBehavior = drag.previousScrollBehavior;
  try {
    if (drag.capture.hasPointerCapture(drag.pointerId)) {
      drag.capture.releasePointerCapture(drag.pointerId);
    }
  } catch {
    // 窗口失焦或元素已移除时，浏览器可能已经释放了 capture。
  }
}

/**
 * 主播放页歌词：单击/Enter/Space 定位单行，纵向拖动把目标行移到视区中央后松手定位。
 * 桌面歌词使用独立窗口的移窗手势，不复用这里的拖动语义。
 */
export function LyricScroller(props: {
  lines: LyricLine[];
  activeIndex: number;
  onSeekMs: (ms: number) => void;
  /** 当前播放位置，已减去歌词偏移；仅用于逐字染色。 */
  positionMs: number;
  /** 预览显示实际播放时间；提交仍返回原始行时间，由调用方统一加偏移。 */
  seekOffsetMs?: number;
  /** 高亮行字号（px）。译文/罗马音/非高亮行按固定比例跟随，见 useLyricFontSize */
  fontSize?: number;
}): React.JSX.Element {
  const {
    lines,
    activeIndex,
    onSeekMs,
    positionMs,
    seekOffsetMs = 0,
    fontSize = LYRIC_FONT_SIZE_DEFAULT,
  } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const dragRef = useRef<LyricDrag | null>(null);
  const suppressClickRef = useRef(false);
  /**
   * 手动滚动后暂停「自动跟随」的截止时间（performance.now 基准）。
   *
   * 以前只挡「按住拖拽」（dragRef）：容器是 overflow-y-auto + scroll-smooth，
   * 滚轮/触控板上滚完全不走 dragRef，于是用户刚往上翻看后面的词，下一次换行
   * （2~4 秒一次）就被 smooth 拽回当前行——后段歌词根本看不了
   * （评审 2026-10-29）。滚轮/触控板/滚动条一动手就暂停 4 秒。
   */
  const followPausedUntilRef = useRef(0);
  const [followPaused, setFollowPaused] = useState(false);
  const [holding, setHolding] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [targetIndex, setTargetIndex] = useState(-1);

  // onSeekMs 的 latest-ref：调用方（PlayingPage）传的是内联箭头，每次渲染都换
  // 身份；行组件靠 memo 挡住无关重渲染，必须喂给它身份稳定的提交函数。
  // ref 在提交后同步，点击/键盘提交必然晚于当次提交，读到的必是最新回调。
  const onSeekRef = useRef(onSeekMs);
  useEffect(() => {
    onSeekRef.current = onSeekMs;
  });
  const seekLine = useCallback((ms: number): void => {
    onSeekRef.current(ms);
  }, []);
  // moveDrag 的几何缓存失效判定要用最新 active 行，不能拿渲染闭包里的旧值。
  const activeIndexRef = useRef(activeIndex);
  useEffect(() => {
    activeIndexRef.current = activeIndex;
  });

  const cancelDrag = useCallback((suppressClick = true): void => {
    const drag = dragRef.current;
    if (!drag) return;
    // 先清 ref：releasePointerCapture 可能同步派发 lostpointercapture。
    dragRef.current = null;
    suppressClickRef.current = suppressClick;
    releaseDrag(drag);
    setHolding(false);
    setDragging(false);
    setTargetIndex(-1);
  }, []);

  // 手动换词也应取消旧词的定位；换曲/换源由 PlayingPage 的 key 触发卸载。
  useEffect(() => {
    cancelDrag();
  }, [lines, cancelDrag]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || !dragRef.current) return;
      event.preventDefault();
      cancelDrag();
    };
    const onBlur = (): void => cancelDrag();
    const onVisibility = (): void => {
      if (document.hidden) cancelDrag();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      const drag = dragRef.current;
      dragRef.current = null;
      releaseDrag(drag);
    };
  }, [cancelDrag]);

  /** 手动滚动 → 暂停跟随（滚动条、滚轮、触控板都会走到这里） */
  const pauseFollow = useCallback((): void => {
    followPausedUntilRef.current = performance.now() + 4000;
    setFollowPaused(true);
  }, []);

  /** 「回到当前行」：清掉暂停标记，让下面那个 effect 立刻重新对齐 */
  const resumeFollow = useCallback((): void => {
    followPausedUntilRef.current = 0;
    setFollowPaused(false);
  }, []);

  useEffect(() => {
    const el = itemRefs.current[activeIndex];
    const container = containerRef.current;
    if (!el || !container || dragRef.current) return;
    // 用户正在自己翻词：别抢滚动位置（4 秒后或点「回到当前行」再接管）
    if (performance.now() < followPausedUntilRef.current) return;
    // 相对定位的容器让 offsetTop 不包含上方曲目信息区的高度。
    const target = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2;
    container.scrollTo({ top: target, behavior: "smooth" });
  }, [activeIndex, lines, holding, fontSize]);

  // 暂停到期后把状态复位（按钮/遮罩靠它决定是否显示「回到当前行」）
  useEffect(() => {
    if (!followPaused) return;
    const remain = followPausedUntilRef.current - performance.now();
    if (remain <= 0) {
      setFollowPaused(false);
      return;
    }
    const id = window.setTimeout(() => setFollowPaused(false), remain);
    return () => window.clearTimeout(id);
  }, [followPaused]);

  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || event.isPrimary === false || dragRef.current) return;
    if (!lines.some((line) => Number.isFinite(line.timeMs) && line.timeMs >= 0)) return;
    const container = event.currentTarget;
    const rect = container.getBoundingClientRect();
    // 滚动条保留浏览器原生拖动，不能被歌词手势捕获。
    if (event.clientX >= rect.left + container.clientLeft + container.clientWidth) return;
    const row = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-lyric-index]")
      : null;
    // 捕获原始行而非父容器，确保小幅移动后浏览器补发的 click 仍然落到该行。
    const capture = row ?? container;
    try {
      capture.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    suppressClickRef.current = false;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScrollTop: container.scrollTop,
      capture,
      container,
      previousUserSelect: container.style.userSelect,
      previousScrollBehavior: container.style.scrollBehavior,
      active: false,
      targetIndex: -1,
      rowGeometry: null,
      geometryAtIndex: -1,
    };
    setHolding(true);
    container.style.userSelect = "none";
    container.style.scrollBehavior = "auto";
    // 停止上一行留下的 smooth scroll，拖动起点才不会继续漂移。
    container.scrollTo({ top: container.scrollTop, behavior: "auto" });
  };

  const moveDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaY = event.clientY - drag.startY;
    const deltaX = event.clientX - drag.startX;
    if (!drag.active) {
      if (Math.abs(deltaX) >= DRAG_THRESHOLD_PX && Math.abs(deltaX) > Math.abs(deltaY)) {
        cancelDrag();
        return;
      }
      if (Math.abs(deltaY) < DRAG_THRESHOLD_PX) return;
      drag.active = true;
      setDragging(true);
      window.getSelection()?.removeAllRanges();
    }
    event.preventDefault();
    const container = drag.container;
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTop = Math.max(0, Math.min(maxScroll, drag.startScrollTop - deltaY));
    const center = container.scrollTop + container.clientHeight / 2;
    // 行几何量读一遍缓存在拖动状态里：pointermove 高频触发，每帧全表读
    // offsetTop/clientHeight 会强制同步布局，是拖动掉帧的主因之一。
    // 换 active 行会改行高布局，发现后整组重建（罕见，代价可忽略）。
    if (drag.rowGeometry === null || drag.geometryAtIndex !== activeIndexRef.current) {
      drag.rowGeometry = lines.map((_line, index) => {
        const item = itemRefs.current[index];
        return item !== null && item !== undefined
          ? { top: item.offsetTop, half: item.clientHeight / 2 }
          : null;
      });
      drag.geometryAtIndex = activeIndexRef.current;
    }
    let closest = -1;
    let distance = Infinity;
    for (let index = 0; index < drag.rowGeometry.length; index += 1) {
      const line = lines[index];
      const geometry = drag.rowGeometry[index];
      if (geometry === null || !Number.isFinite(line.timeMs) || line.timeMs < 0) continue;
      const nextDistance = Math.abs(geometry.top + geometry.half - center);
      if (nextDistance < distance) {
        closest = index;
        distance = nextDistance;
      }
    }
    drag.targetIndex = closest;
    setTargetIndex(closest);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    // 最后一个 move 与 up 可能不同点；抬手位置也要计入，不能提交上一帧的目标。
    moveDrag(event);
    const drag = dragRef.current;
    if (!drag) return;
    const target = drag.active ? lines[drag.targetIndex] : undefined;
    cancelDrag(drag.active);
    if (target && Number.isFinite(target.timeMs) && target.timeMs >= 0) onSeekMs(target.timeMs);
  };

  const cancelPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId === event.pointerId) cancelDrag();
  };

  const targetLine = dragging ? lines[targetIndex] : undefined;
  return (
    <div className="relative h-full">
      <div
        ref={containerRef}
        data-testid="lyric-scroller"
        className={cn(
          "relative h-full overflow-y-auto scroll-smooth px-8 [mask-image:linear-gradient(to_bottom,transparent,black_15%,black_85%,transparent)]",
          dragging && "cursor-grabbing",
        )}
        style={{ touchAction: "none" }}
        onWheel={pauseFollow}
        onTouchMove={pauseFollow}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={cancelPointer}
        onLostPointerCapture={cancelPointer}
        onClickCapture={(event) => {
          // 键盘/辅助技术的 detail=0 点击仍可用，pointer 的尾随 click 只消费一次。
          if (!suppressClickRef.current || event.detail === 0) return;
          suppressClickRef.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <div className="mx-auto flex max-w-xl flex-col gap-5 py-[40%]">
          {lines.map((line, index) => (
            <LyricLineRow
              key={index}
              line={line}
              index={index}
              active={index === activeIndex}
              dragging={dragging}
              target={dragging && targetIndex === index}
              // 逐字染色只发生在 active 行；其余行传 0（常量），播放中
              // positionMs 变化才不会击穿整张列表的 memo。
              positionMs={index === activeIndex ? positionMs : 0}
              itemRefs={itemRefs}
              onSeekMs={seekLine}
              cancelDrag={cancelDrag}
              fontSize={fontSize}
            />
          ))}
        </div>
      </div>
      {targetLine && (
        <div
          className="pointer-events-none absolute inset-x-3 top-1/2 flex -translate-y-1/2 items-center gap-3"
          data-testid="lyric-seek-preview"
          role="status"
          aria-live="polite"
        >
          <span className="h-px flex-1 bg-primary/40" />
          <span className="rounded-full border border-primary/30 bg-background/95 px-3 py-1.5 text-xs shadow-sm">
            <span className="font-medium tabular-nums text-primary">{formatTime(targetLine.timeMs + seekOffsetMs)}</span>
            <span className="ml-2 text-muted-foreground">松开定位 · Esc 取消</span>
          </span>
        </div>
      )}
      {followPaused && !dragging && (
        // 手动翻词期间不给「自动拽回」，但得留一条回去的路：点一下立刻回到当前行
        <button
          type="button"
          onClick={resumeFollow}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border/70 bg-background/95 px-3 py-1 text-2xs text-muted-foreground shadow-surface transition-colors duration-fast hover:text-foreground"
        >
          回到当前行
        </button>
      )}
    </div>
  );
}

/**
 * 单行歌词。memo + 窄 props：播放期间 positionMs 高频变化，没有这层 memo 时
 * 整张歌词列表跟着重渲染；现在只有 active 行收到新 positionMs，其余行 props
 * 全等、跳过渲染（拖动起止与目标行切换时才个别行重渲染）。
 */
const LyricLineRow = memo(function LyricLineRow(props: {
  line: LyricLine;
  index: number;
  active: boolean;
  dragging: boolean;
  target: boolean;
  positionMs: number;
  itemRefs: React.RefObject<Array<HTMLDivElement | null>>;
  onSeekMs: (ms: number) => void;
  cancelDrag: () => void;
  fontSize: number;
}): React.JSX.Element {
  const {
    line,
    index,
    active,
    dragging,
    target,
    positionMs,
    itemRefs,
    onSeekMs,
    cancelDrag,
    fontSize,
  } = props;
  // 非高亮行按比例缩小；译文/罗马音统一挂在高亮字号的 0.7 / 0.6 上，
  // 与改造前 20 / 16 / 14 / 12 的实际观感一致，调字号只等比缩放。
  const basePx = active ? fontSize : fontSize * LYRIC_INACTIVE_RATIO;
  const translationPx = fontSize * LYRIC_TRANSLATION_RATIO;
  const romanizationPx = fontSize * LYRIC_ROMANIZATION_RATIO;
  // 行自己的 ref 回调：itemRefs 对象身份稳定、index 不变，回调身份随之稳定，
  // memo 比较才会通过（写在父组件 map 里的内联 ref 每次渲染都是新函数）。
  const setItemRef = useCallback((el: HTMLDivElement | null): void => {
    itemRefs.current[index] = el;
  }, [index, itemRefs]);
  return (
    <div
      ref={setItemRef}
      data-lyric-index={index}
      data-seek-target={target ? "true" : undefined}
      role={line.timeMs >= 0 ? "button" : undefined}
      tabIndex={line.timeMs >= 0 ? 0 : undefined}
      onClick={line.timeMs >= 0 ? () => onSeekMs(line.timeMs) : undefined}
      onKeyDown={line.timeMs >= 0 ? (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        cancelDrag();
        onSeekMs(line.timeMs);
      } : undefined}
      className={cn(
        "rounded-md text-center transition-[transform,color,background-color] duration-slow",
        line.timeMs >= 0 && (dragging
          ? "cursor-grabbing"
          : "cursor-pointer hover:text-lyric-highlight/70 focus-visible:outline-none"),
        active
          ? "qt-lyric-active scale-105 font-semibold text-lyric-highlight"
          : "text-lyric-inactive",
        target && "bg-primary/10 ring-1 ring-primary/30",
      )}
      style={{ fontSize: remOf(basePx), lineHeight: LYRIC_LINE_HEIGHT }}
    >
      {active && line.words !== undefined && line.words.length > 0 ? (
        <div>
          {line.words.map((word, wordIndex) => (
            <KaraokeWord key={wordIndex} word={word} elapsedMs={positionMs - line.timeMs} />
          ))}
        </div>
      ) : (
        <div>{line.text || "…"}</div>
      )}
      {line.romanization && (
        <div
          className={cn("mt-0.5", active
            ? "text-lyric-highlight/60" : "text-lyric-inactive/50")}
          style={{ fontSize: remOf(romanizationPx), lineHeight: LYRIC_LINE_HEIGHT }}
        >
          {line.romanization}
        </div>
      )}
      {line.translation && (
        <div
          className={cn("mt-1", active
            ? "text-lyric-highlight/80" : "text-lyric-inactive/70")}
          style={{ fontSize: remOf(translationPx), lineHeight: LYRIC_LINE_HEIGHT }}
        >
          {line.translation}
        </div>
      )}
    </div>
  );
});

/** 逐字染色保留连续渐变：词唱到一半时只有半边高亮。 */
function KaraokeWord(props: { word: LyricWord; elapsedMs: number }): React.JSX.Element {
  const { word, elapsedMs } = props;
  const passed = elapsedMs - word.startMs;
  const raw = word.durationMs > 0 ? passed / word.durationMs : passed >= 0 ? 1 : 0;
  const ratio = raw < 0 ? 0 : raw > 1 ? 1 : raw;
  const pct = Math.round(ratio * 100);
  return (
    <span style={{
      backgroundImage: `linear-gradient(90deg, var(--lyric-highlight) ${pct}%, var(--lyric-inactive) ${pct}%)`,
      WebkitBackgroundClip: "text",
      backgroundClip: "text",
      color: "transparent",
    }}>
      {word.text}
    </span>
  );
}
