import { useCallback, useEffect, useRef, useState } from "react";
import { formatTime, type LyricLine, type LyricWord } from "@/lib/lrc";
import { cn } from "@/lib/utils";

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
}): React.JSX.Element {
  const { lines, activeIndex, onSeekMs, positionMs, seekOffsetMs = 0 } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const dragRef = useRef<LyricDrag | null>(null);
  const suppressClickRef = useRef(false);
  const [holding, setHolding] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [targetIndex, setTargetIndex] = useState(-1);

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

  useEffect(() => {
    const el = itemRefs.current[activeIndex];
    const container = containerRef.current;
    if (!el || !container || dragRef.current) return;
    // 相对定位的容器让 offsetTop 不包含上方曲目信息区的高度。
    const target = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2;
    container.scrollTo({ top: target, behavior: "smooth" });
  }, [activeIndex, lines, holding]);

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
    let closest = -1;
    let distance = Infinity;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const item = itemRefs.current[index];
      if (!item || !Number.isFinite(line.timeMs) || line.timeMs < 0) continue;
      const nextDistance = Math.abs(item.offsetTop + item.clientHeight / 2 - center);
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
            <div
              key={index}
              ref={(el) => { itemRefs.current[index] = el; }}
              data-lyric-index={index}
              data-seek-target={dragging && targetIndex === index ? "true" : undefined}
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
                "rounded-md text-center transition-all duration-300",
                line.timeMs >= 0 && (dragging
                  ? "cursor-grabbing"
                  : "cursor-pointer hover:text-lyric-highlight/70 focus-visible:outline-none"),
                index === activeIndex
                  ? "scale-105 text-xl font-semibold text-lyric-highlight"
                  : "text-base text-lyric-inactive",
                dragging && targetIndex === index && "bg-primary/10 ring-1 ring-primary/30",
              )}
            >
              {index === activeIndex && line.words !== undefined && line.words.length > 0 ? (
                <div>
                  {line.words.map((word, wordIndex) => (
                    <KaraokeWord key={wordIndex} word={word} elapsedMs={positionMs - line.timeMs} />
                  ))}
                </div>
              ) : (
                <div>{line.text || "…"}</div>
              )}
              {line.romanization && (
                <div className={cn("mt-0.5 text-xs", index === activeIndex
                  ? "text-lyric-highlight/60" : "text-lyric-inactive/50")}>
                  {line.romanization}
                </div>
              )}
              {line.translation && (
                <div className={cn("mt-1 text-sm", index === activeIndex
                  ? "text-lyric-highlight/80" : "text-lyric-inactive/70")}>
                  {line.translation}
                </div>
              )}
            </div>
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
    </div>
  );
}

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
