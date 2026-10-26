/**
 * 面向用户的数值/单位格式化（唯一真源）。
 *
 * 字节量的两份历史实现（设置页缓存统计、下载页文件大小）输出略有差别
 * （小数位数），统一成这一份：自动选单位、大值少小数位、空值给空串。
 */

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
 * 播放量人话显示：`9999` 以下原样（`234332` → `23.4万`）。
 * 数据包下发的 playCount 是字符串形态（`"234332"`），统一收宽。
 * 空值/非正数给空串（歌单卡没有播放量就不显示这行）。
 */
export function formatPlayCount(n: number | string | null | undefined): string {
  const v = typeof n === "string" ? Number(n) : n;
  if (!v || v <= 0) return "";
  if (v < 10000) return String(v);
  const wan = v / 10000;
  if (v >= 99995000) return `${(v / 100000000).toFixed(1).replace(/\.0$/, "")}亿`;
  return `${wan.toFixed(wan >= 100 ? 0 : 1).replace(/\.0$/, "")}万`;
}
