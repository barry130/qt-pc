import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 横向滚动容器（首页卡片行）。
 *
 * 桌面端没有触摸横滑，滚动条又是隐藏的，所以必须给出可操作入口：
 * 1. 垂直滚轮 → 横向滚动（滚到两端后把事件交还给页面，页面继续纵向滚动）
 * 2. 左右箭头按钮（hover 时淡入，到边界自动隐藏）
 */
export function HorizontalScroller(props: {
  children: React.ReactNode;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);

  // 滚轮转横向。必须用非 passive 的原生监听器：React 的 onWheel 是 passive 的，
  // 里面调 preventDefault 无效（还会告警）
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      const before = el.scrollLeft;
      const next = Math.max(0, Math.min(max, before + e.deltaY));
      if (next === before) return; // 已到边界，不拦截 → 页面继续纵向滚动
      el.scrollLeft = next;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const syncEdges = (): void => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setAtStart(el.scrollLeft <= 1);
    setAtEnd(el.scrollLeft >= max - 1);
  };

  useEffect(() => {
    syncEdges();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(syncEdges);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scrollByPage = (dir: 1 | -1): void => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({
      left: dir * Math.max(240, el.clientWidth * 0.8),
      behavior: "smooth",
    });
  };

  return (
    <div className="group/scroller relative">
      <div
        ref={ref}
        onScroll={syncEdges}
        className="flex snap-x gap-3 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {props.children}
      </div>

      {/* 箭头层：高度 = 封面高度，箭头对齐**封面**中线。
          不能直接放在 relative 容器上写 top-1/2 —— 那个中线是「封面 + 标题 + 副标题」的
          整卡中线，会落到封面偏下、压住封面里的字；而副标题有无各排不同
          （新歌速递的 TrackCard 没有副标题），整卡中线本身也不一致。 */}
      <div className={cn("pointer-events-none absolute inset-x-0 top-0 z-10", COVER_H)}>
        <ScrollArrow side="left" hidden={atStart} onClick={() => scrollByPage(-1)} />
        <ScrollArrow side="right" hidden={atEnd} onClick={() => scrollByPage(1)} />
      </div>
    </div>
  );
}

/** 横向卡片行里的卡片固定 `w-32`（128px），封面是 `aspect-square` → 封面方块恒为 128px */
const COVER_H = "h-32";

function ScrollArrow(props: {
  side: "left" | "right";
  hidden: boolean;
  onClick: () => void;
}): React.JSX.Element | null {
  if (props.hidden) return null;
  return (
    <button
      type="button"
      aria-label={props.side === "left" ? "向左滚动" : "向右滚动"}
      onClick={props.onClick}
      className={cn(
        "pointer-events-auto absolute top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card/90 text-foreground opacity-0 shadow-md transition-opacity hover:bg-accent group-hover/scroller:opacity-100",
        props.side === "left" ? "left-0" : "right-0",
      )}
    >
      {props.side === "left" ? (
        <ChevronLeft className="h-4 w-4" />
      ) : (
        <ChevronRight className="h-4 w-4" />
      )}
    </button>
  );
}
