/**
 * 听歌热力图的网格与色阶计算（纯函数，单独放这里是为了能单测）。
 *
 * 为什么不用「按天索引 + 百分比高度」的画法：热力图回答的是「哪天听得多、有没有断档」，
 * 需要的是**按周成列、按星期成行**的日历骨架（同 GitHub 贡献图）。日期到行列的
 * 换算、首列的空位补齐、月份刻度的抽稀都在这里做，组件只管画。
 */
import type { ListenDayPoint } from "@/types";

/** 星期标签：行序从周一到周日（与 `Date.getDay()` 的 0=周日 不同，见 weekdayIndex）。 */
export const HEAT_WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"] as const;

/** 只画这几行的星期标签（其余留白）：GitHub 贡献图的惯例，一屏里三行足够定位。 */
export const HEAT_LABELED_ROWS = new Set([0, 2, 4]);

/** 色阶档数（0 = 没有播放，1～4 = 由浅到深）。 */
export const HEAT_LEVEL_COUNT = 4;

/** 月份刻度最小间隔（列）：小于这个数就跳过，免得「11月12月1月」叠在一起。 */
const MONTH_LABEL_MIN_GAP = 2;

function parseDayKey(key: string): Date | null {
  const parts = key.split("-").map(Number);
  const [year, month, date] = parts;
  if (parts.length !== 3) return null;
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(date)) return null;
  return new Date(year as number, (month as number) - 1, date as number);
}

/** 周一 = 0 … 周日 = 6（把 JS 的 0=周日 平移过来）。 */
export function weekdayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

export interface ListenHeatGrid {
  /** 每列 7 格，自上而下是周一到周日；null = 窗口之外的补齐格 */
  columns: (ListenDayPoint | null)[][];
  /** 月份刻度：`column` 是列下标，`label` 形如 `10月` */
  monthLabels: { column: number; label: string }[];
}

/**
 * 把连续的逐日数据摆成周列。首列按第一天是星期几补空位，末列补满 7 格 —— 补齐格
 * 必须存在，否则最后一周的几格会被挤到上一行去。
 */
export function buildListenHeatGrid(points: ListenDayPoint[]): ListenHeatGrid {
  if (points.length === 0) return { columns: [], monthLabels: [] };
  const first = parseDayKey(points[0]?.day ?? "");
  const lead = first === null ? 0 : weekdayIndex(first);
  const cells: (ListenDayPoint | null)[] = [];
  for (let index = 0; index < lead; index += 1) cells.push(null);
  for (const point of points) cells.push(point);
  while (cells.length % 7 !== 0) cells.push(null);
  const columns: (ListenDayPoint | null)[][] = [];
  for (let index = 0; index < cells.length; index += 7) {
    columns.push(cells.slice(index, index + 7));
  }

  // 月份刻度只打在「某月 1 号所在的那一列」：按「最上面那天换了月」打标会把窗口
  // 首列那个**残缺月份**也标出来（一年视图从 10 月底开始，就会出现「10月」紧挨着
  // 「12月」、11 月被间隔规则吞掉的怪象）。按月初打标天然对齐，缺哪个月一眼能看出来。
  const monthLabels: { column: number; label: string }[] = [];
  let lastColumn = -MONTH_LABEL_MIN_GAP;
  columns.forEach((column, columnIndex) => {
    const head = column.find((cell) => cell !== null && cell.day.endsWith("-01")) ?? null;
    if (head === null) return;
    if (columnIndex - lastColumn < MONTH_LABEL_MIN_GAP && monthLabels.length > 0) return;
    monthLabels.push({ column: columnIndex, label: `${Number(head.day.slice(5, 7))}月` });
    lastColumn = columnIndex;
  });
  return { columns, monthLabels };
}

/**
 * 横向月历的行列：行 = 一周，列 = 周一…周日。
 *
 * 与周列布局（列 = 周、行 = 星期）是同一张二维表的另一种读法：`buildListenHeatGrid`
 * 已经按「每周一列、七格补齐」切好并补过空位，所以一行就是其中一列那七格本身，
 * 不需要再转置。短窗口（今天 / 近 7 天 / 近 30 天）用它，格子尺寸才能恒定。
 */
export function buildListenMonthGrid(points: ListenDayPoint[]): (ListenDayPoint | null)[][] {
  return buildListenHeatGrid(points).columns.map((week) => [...week]);
}

/**
 * 色阶阈值：取**有播放的那些天**的四分位点，而不是按最大值等分 —— 一天狂刷 200 次
 * 会把其余所有天压成同一个浅色，「偶尔听一点」和「完全没听」就分不出来了。
 */
export function heatThresholds(counts: number[]): [number, number, number] {
  const positive = counts.filter((count) => count > 0).sort((a, b) => a - b);
  if (positive.length === 0) return [1, 2, 3];
  const at = (ratio: number): number => positive[Math.min(positive.length - 1, Math.floor(positive.length * ratio))] ?? 1;
  const p25 = at(0.25);
  const p50 = Math.max(p25, at(0.5));
  const p75 = Math.max(p50, at(0.75));
  return [p25, p50, p75];
}

/** 0 = 没播过，1～4 = 由浅到深。 */
export function heatLevel(count: number, thresholds: [number, number, number]): number {
  if (count <= 0) return 0;
  const [p25, p50, p75] = thresholds;
  if (count <= p25) return 1;
  if (count <= p50) return 2;
  if (count <= p75) return 3;
  return 4;
}

/**
 * 格子提示的日期部分。tooltip 比坐标轴宽裕，直接给「今天 / 昨天 / M月D日」，
 * 再带上星期几 —— 热力图是按星期分行的，看格子时最想知道的就是这个。
 */
export function heatCellDate(day: string, todayKey: string): string {
  const date = parseDayKey(day);
  if (date === null) return day;
  const yesterday = new Date();
  const today = parseDayKey(todayKey);
  if (today !== null) yesterday.setFullYear(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const yesterdayKey = today === null ? "" : `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
  if (day === todayKey) return "今天";
  if (day === yesterdayKey) return "昨天";
  return `${date.getMonth() + 1}月${date.getDate()}日 周${HEAT_WEEKDAYS[weekdayIndex(date)]}`;
}
