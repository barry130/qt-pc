import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ListenDayPoint } from "@/types";
import { cn } from "@/lib/utils";
import { formatReportDuration } from "@/lib/listen-report";
import {
  HEAT_LABELED_ROWS,
  HEAT_WEEKDAYS,
  buildListenHeatGrid,
  buildListenMonthGrid,
  heatCellDate,
  heatLevel,
  heatThresholds,
} from "@/lib/listen-heatmap";

/** 周列布局一行（一周）的格子数，也是月历布局一行的列数。 */
const WEEK_SLOTS = HEAT_WEEKDAYS.length;

/** 格子边长（px）：容器够宽就撑到上限为止，再宽就留白 —— 大格子比留白更难看。 */
const CELL_MIN = 9;
/**
 * 周列布局的格子上限按列数放宽：一年 53 列时 15px 刚好铺满半屏；只有 30 天（5 列）时
 * 同样封到 15px 就成了一小撮像素点，看着像没画出来。
 *
 * 注意：短窗口已经改走横向月历（见 MONTH_CELL），这条只在近一年那种周列布局下生效。
 */
function cellMax(weeks: number): number {
  if (weeks <= 6) return 24;
  if (weeks <= 14) return 20;
  return 15;
}
/** 格子间隙（px） */
const GAP = 3;
/** 左侧星期标签列宽度（px，仅周列布局） */
const GUTTER = 14;
/** 月份刻度行高（px，仅周列布局） */
const MONTH_ROW = 14;
/**
 * 横向月历（行 = 周，列 = 周一…周日）的格子边长。
 *
 * 为什么短窗口要单独一套布局：5 列的周列网格在宽卡片里只是一条细带子，和 53 列的
 * 一年视图摆在一起，格子一个 24px 一个 15px、总宽差六倍，换个档位像换了个组件。
 * 七列铺开的月历格子尺寸恒定，今天 / 近 7 天 / 近 30 天 之间切换完全不动。
 */
const MONTH_CELL = 28;
/** 窄窗口下横向月历的格子下限（px）：再小就点不准了 */
const MONTH_CELL_MIN = 18;
/** 不超过这个天数就用横向月历（一年 365 天仍走周列布局） */
const MONTH_LAYOUT_MAX_DAYS = 31;

/** 色阶：0 = 没有播放，1～4 由浅到深。深浅只调透明度，主题换肤时自动跟随。 */
const LEVEL_CLASS = [
  "bg-secondary/70",
  "bg-primary/25",
  "bg-primary/45",
  "bg-primary/70",
  "bg-primary/95",
] as const;

/**
 * 听歌热力图（GitHub 贡献图口径）：七行是周一到周日，一列是一周，颜色深浅是当天播放次数。
 *
 * 为什么换成这种画法（用户 m09486）：柱状图只看得出「哪几根高」，看不出**断档**与
 * **作息周期**——一年里哪天没听、周末是不是更爱听，都得靠日历骨架才读得出来。
 *
 * 两套布局（用户 m10110 追问「为什么近 30 天和近一年大小不一致」）：
 * - `days > 31`（近一年）：周列布局，列 = 周、行 = 星期，格子随容器宽度收放但封顶；
 * - `days <= 31`（今天 / 近 7 天 / 近 30 天）：横向月历，行 = 周、列 = 星期，格子恒 28px。
 * 短窗口不再靠放大格子撑场面，两种布局各自内部尺寸一致，切档不会跳。
 *
 * 交互与取舍：
 * - 格子尺寸按容器宽度实时算（`ResizeObserver`），窗口拉宽格子变大、拉窄变小，
 *   不会出现「一年视图被压成一条线」；算出来超出上限就停下，避免大块色斑。
 * - 每格的提示走原生 `title`：半年份的格子若都挂 React 浮层，光事件监听就够卡。
 * - 容器整体给 `role="img"` + 汇总文案，格子本身对读屏隐藏 —— 逐格念 365 条
 *   「10月12日 0 次」只会把屏幕阅读器堵住。
 */
export function ListenHeatmap(props: {
  points: ListenDayPoint[];
  /** 今天的本地日键（与 Rust 按天明细同口径），用来把「今天 / 昨天」标出来 */
  todayKey: string;
  loading?: boolean;
  /**
   * loading 骨架的行数（默认 53 = 一整年的周数）。
   * 「今天」这一档真实内容只有 1 行，骨架却画满 53 行的话，加载完会整块塌缩，
   * 视觉上就是一次跳变 —— 所以由调用方按当前窗口给行数。
   */
  skeletonWeeks?: number;
  /**
   * 当前窗口的天数，决定用哪套布局（`<= 31` 走横向月历）。
   * 不传则按周列布局渲染，保持旧调用点的行为不变。
   */
  days?: number;
}): React.JSX.Element {
  const { points, todayKey, loading = false, skeletonWeeks = 53, days } = props;
  const monthLayout = days !== undefined && days > 0 && days <= MONTH_LAYOUT_MAX_DAYS;
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [cell, setCell] = useState(monthLayout ? MONTH_CELL : 11);

  const grid = useMemo(() => buildListenHeatGrid(points), [points]);
  const monthRows = useMemo(
    () => (monthLayout ? buildListenMonthGrid(points) : []),
    [monthLayout, points],
  );
  const thresholds = useMemo(() => heatThresholds(points.map((point) => point.playCount)), [points]);
  const weeks = grid.columns.length;

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (el === null || weeks === 0) return;
    const measure = (): void => {
      const width = el.clientWidth;
      if (width <= 0) return;
      if (monthLayout) {
        // 月历只有 7 列，永远放得下：只夹上限，窄窗口往下缩
        const usable = width - GAP * (WEEK_SLOTS - 1);
        const wide = Math.floor(usable / WEEK_SLOTS);
        if (!Number.isFinite(wide)) return;
        setCell(Math.max(MONTH_CELL_MIN, Math.min(MONTH_CELL, wide)));
        return;
      }
      const usable = width - GUTTER - GAP * Math.max(0, weeks - 1);
      const size = Math.floor(usable / Math.max(1, weeks));
      if (!Number.isFinite(size)) return;
      setCell(Math.max(CELL_MIN, Math.min(cellMax(weeks), size)));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [weeks, monthLayout]);

  const totalPlays = points.reduce((sum, point) => sum + point.playCount, 0);
  const activeDays = points.filter((point) => point.playCount > 0).length;
  const busiest = points.reduce<ListenDayPoint | null>(
    (best, point) => (best === null || point.playCount > best.playCount ? point : best),
    null,
  );
  const aria = busiest === null || busiest.playCount === 0
    ? "播放热力图：窗口内还没有播放记录"
    : `播放热力图：共 ${totalPlays} 次播放，活跃 ${activeDays} 天，最多的一天是 ${busiest.day}（${busiest.playCount} 次）`;

  const legend = (
    <div className="mt-2 flex items-center justify-end gap-1 text-2xs text-muted-foreground/70" aria-hidden>
      <span>少</span>
      {LEVEL_CLASS.map((cls) => (
        <span key={cls} className={cn("rounded-[2px]", cls)} style={{ width: 10, height: 10 }} />
      ))}
      <span>多</span>
    </div>
  );

  const cellNode = (point: ListenDayPoint | null, key: string, radius: string): React.JSX.Element => {
    if (point === null) return <span key={key} aria-hidden />;
    const level = heatLevel(point.playCount, thresholds);
    return (
      <span
        key={key}
        title={point.playCount > 0 ? `${heatCellDate(point.day, todayKey)} · ${point.playCount} 次 · ${formatReportDuration(point.totalPlayedMs)}` : `${heatCellDate(point.day, todayKey)} · 没有播放`}
        className={cn(
          radius,
          "transition-colors",
          LEVEL_CLASS[level],
          point.playCount > 0 && "hover:ring-1 hover:ring-primary/60",
        )}
      />
    );
  };

  if (loading && weeks === 0) {
    return (
      <div className="mt-3" aria-hidden>
        {monthLayout ? (
          <div
            className="grid"
            style={{
              gridTemplateColumns: `repeat(${WEEK_SLOTS}, ${MONTH_CELL}px)`,
              gridAutoRows: `${MONTH_CELL}px`,
              gap: GAP,
            }}
          >
            {Array.from({ length: skeletonWeeks * WEEK_SLOTS }, (_, index) => (
              <span key={index} className="animate-pulse rounded-[3px] bg-secondary/60" />
            ))}
          </div>
        ) : (
          <div
            className="grid"
            style={{
              gridAutoFlow: "column",
              gridAutoColumns: `${CELL_MIN}px`,
              gridTemplateRows: `repeat(${WEEK_SLOTS}, ${CELL_MIN}px)`,
              gap: GAP,
            }}
          >
            {Array.from({ length: skeletonWeeks * WEEK_SLOTS }, (_, index) => (
              <span key={index} className="animate-pulse rounded-[2px] bg-secondary/60" />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (monthLayout) {
    return (
      <div className="mt-3" ref={boxRef}>
        <div
          className="grid text-2xs leading-none text-muted-foreground/70"
          style={{ gridTemplateColumns: `repeat(${WEEK_SLOTS}, ${cell}px)`, gap: GAP }}
          aria-hidden
        >
          {HEAT_WEEKDAYS.map((label) => (
            <span key={label} className="text-center" style={{ height: MONTH_ROW }}>
              {label}
            </span>
          ))}
        </div>
        <div
          role="img"
          aria-label={aria}
          className="mt-1 grid"
          style={{
            gridTemplateColumns: `repeat(${WEEK_SLOTS}, ${cell}px)`,
            gridAutoRows: `${cell}px`,
            gap: GAP,
          }}
        >
          {monthRows.flatMap((row, rowIndex) =>
            row.map((point, column) =>
              cellNode(point, point === null ? `pad-${rowIndex}-${column}` : point.day, "rounded-[3px]"),
            ),
          )}
        </div>
        {legend}
      </div>
    );
  }

  return (
    <div className="mt-3" ref={boxRef}>
      <div className="flex items-start gap-2">
        <div className="flex shrink-0 flex-col" style={{ gap: GAP, width: GUTTER }} aria-hidden>
          {HEAT_WEEKDAYS.map((label, row) => (
            <span
              key={label}
              className="flex items-center justify-end text-2xs leading-none text-muted-foreground/70"
              style={{ height: cell }}
            >
              {HEAT_LABELED_ROWS.has(row) ? label : ""}
            </span>
          ))}
        </div>
        <div className="min-w-0">
          <div
            role="img"
            aria-label={aria}
            className="grid"
            style={{
              gridAutoFlow: "column",
              gridAutoColumns: `${cell}px`,
              gridTemplateRows: `repeat(${WEEK_SLOTS}, ${cell}px)`,
              gap: GAP,
            }}
          >
            {grid.columns.flatMap((column, columnIndex) =>
              column.map((point, row) =>
                cellNode(point, point === null ? `pad-${columnIndex}-${row}` : point.day, "rounded-[2px]"),
              ),
            )}
          </div>
          <div className="relative" style={{ height: MONTH_ROW }}>
            {grid.monthLabels.map((month) => (
              <span
                key={`${month.column}-${month.label}`}
                className="absolute top-0 whitespace-nowrap text-2xs leading-none text-muted-foreground/70"
                style={{ left: month.column * (cell + GAP) }}
              >
                {month.label}
              </span>
            ))}
          </div>
        </div>
      </div>
      {legend}
    </div>
  );
}
