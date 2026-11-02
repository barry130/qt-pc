/**
 * 面向用户的数值/单位格式化（唯一真源）。
 *
 * 字节量的两份历史实现（设置页缓存统计、下载页文件大小）输出略有差别
 * （小数位数），统一成这一份：自动选单位、大值少小数位、空值给空串。
 *
 * 语言（B6 第二轮，R84）：播放量/日期这类「带文字的单位」按当前界面语言出，
 * 中文 `万/亿`、英文 `K/M/B`。语言取自 i18n 的 store，所以切换语言后
 * 只要组件重渲染（订阅了 `useT()` 的祖先即可），显示就会跟着变。
 */
import { useLocaleStore } from "./i18n";

function isEnglish(): boolean {
  return useLocaleStore.getState().locale === "en-US";
}

/**
 * 字节量人话显示：`512 B`、`1.5 KB`、`23.4 MB`、`1.2 GB`。
 * 空值/非正数给空串（下载列表里「还没下完」不显示大小，而不是显示 `0 B`）。
 */
export function formatBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 播放量人话显示：`9999` 以下原样（`234332` → `23.4万` / `234.3K`）。
 * 数据包下发的 playCount 是字符串形态（`"234332"`），统一收宽。
 * 空值/非正数给空串（歌单卡没有播放量就不显示这行）。
 */
export function formatPlayCount(n: number | string | null | undefined): string {
  const v = typeof n === "string" ? Number(n) : n;
  if (!v || v <= 0) return "";
  const trim = (value: number): string => value.toFixed(value >= 100 ? 0 : 1).replace(/\.0$/, "");
  if (isEnglish()) {
    if (v < 1000) return String(v);
    if (v >= 999_950_000) return `${trim(v / 1_000_000_000)}B`;
    if (v >= 999_950) return `${trim(v / 1_000_000)}M`;
    return `${trim(v / 1000)}K`;
  }
  if (v < 10000) return String(v);
  if (v >= 99995000) return `${trim(v / 100000000)}亿`;
  return `${trim(v / 10000)}万`;
}

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * 时间点人话显示：中文 `2026-11-02 15:33`、英文 `Nov 2, 2026 15:33`。
 * 不用 `Intl`：同一台机器上 ICU 版本不同会给出不同写法，报告页与日志对不上。
 */
export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "—";
  const pad = (value: number): string => String(value).padStart(2, "0");
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (isEnglish()) {
    return `${MONTHS_EN[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} ${clock}`;
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}
