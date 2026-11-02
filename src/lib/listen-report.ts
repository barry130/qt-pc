import { t, useLocaleStore } from "./i18n";
import { formatDateTime } from "./format";

/** 时长：中文「不到 1 分钟 / N 分钟 / N 小时 M 分」，英文「<1 min / N min / N h M min」 */
export function formatReportDuration(ms: number): string {
  const value = Math.max(0, Math.floor(ms));
  const minutes = Math.floor(value / 60_000);
  if (useLocaleStore.getState().locale === "en-US") {
    if (minutes < 1) return "<1 min";
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  }
  if (minutes < 1) return "不到 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
}

export function formatReportDate(timestamp: number): string {
  return formatDateTime(timestamp);
}

export function reportSourceLabel(label: (id: string) => string, id: string): string {
  const name = label(id);
  return name === "未知" ? `未知音源（${id}）` : name;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * 本地自然日 `YYYY-MM-DD`，必须与 Rust 侧按天明细的 key 口径一致。
 * 不能用 `toISOString()`：那是 UTC，东八区凌晨 0-8 点会算进前一天。
 */
export function listenDayKey(at: number): string {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shiftDayKey(key: string, delta: number): string {
  const parts = key.split("-").map(Number);
  const [year, month, date] = parts;
  if (parts.length !== 3 || !Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(date)) return "";
  // 交给 Date 处理跨月跨年进位，比手写月末天数可靠。
  return listenDayKey(new Date(year as number, (month as number) - 1, (date as number) + delta).getTime());
}

/**
 * 趋势轴上的短标签：窗口越窄给的信息越具体。
 * 1 天窗口只有一个「今天」；7 天用星期几（比「10/12」更容易看出作息）；30 天回到「M/D」。
 */
export function formatDayAxis(day: string, todayKey: string, windowDays: number): string {
  const english = useLocaleStore.getState().locale === "en-US";
  if (windowDays <= 1) return t("common.today");
  if (day === todayKey) return t("common.today");
  if (day === shiftDayKey(todayKey, -1)) return t("common.yesterday");
  const parts = day.split("-").map(Number);
  const [year, month, date] = parts;
  if (parts.length !== 3 || !Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(date)) return day;
  if (windowDays <= 7) {
    const weekday = new Date(year as number, (month as number) - 1, date as number).getDay();
    return english ? (WEEKDAYS_EN[weekday] ?? "") : `周${WEEKDAYS[weekday] ?? ""}`;
  }
  return `${month}/${date}`;
}
