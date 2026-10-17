import type { Chart, Track } from "@/types";
import * as sourceApi from "@/source-scripts";

/**
 * 榜单详情缓存（进程内，键 = `音源:榜单 id`）。
 *
 * 卡片只要前 3 首，但 chartDetail 契约没有 limit 参数、只能整榜拉回来
 * （酷我/咪咕在脚本侧还是翻页取的），既然拉都拉了就留着：重渲染、切走再切回、
 * 以及「播放整榜」都直接命中，不至于为同一个榜反复打源站。
 *
 * 缓存**跨页面共用** —— 首页「榜单精选」与 /charts 展示的是同一批榜单，从首页点
 * 「全部榜单」进来时，两个页面看到的前几首正因为读同一份缓存才是同一批数据；
 * 各留一份的话换个页面就要把整榜重拉一遍。只有首页区块标题上的刷新按钮会绕过它
 * （force=true）：源站榜单按天/按小时更新，用户点刷新就是想看最新名次。
 */
const chartDetailCache = new Map<string, Track[]>();

/** 榜单详情（带进程内缓存）；`force` 绕过缓存重打源站 */
export async function loadChartDetail(chart: Chart, force = false): Promise<Track[]> {
  const key = `${chart.platform}:${chart.id}`;
  if (!force) {
    const hit = chartDetailCache.get(key);
    if (hit !== undefined) return hit;
  }
  const rows = await sourceApi.getChartDetail(chart);
  const list = Array.isArray(rows) ? rows : [];
  chartDetailCache.set(key, list);
  return list;
}