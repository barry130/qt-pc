import * as ipc from "@/services/ipc";
import { AGGREGATE_SOURCES_KEY } from "@/lib/storageKeys";

/**
 * 「聚合搜索只用哪几个音源」这一设置（DESIGN §8.8 / §6.5）。
 *
 * 语义：
 * - **没配置 / 配置成空数组** → 返回 null，调用方按「全部音源」处理。一个都不选
 *   不应该变成「什么都搜不到」，所以空值统一归一成 null（UI 侧也禁止把最后一个关掉）。
 * - **配置过** → 返回去重后的 id 数组。可能包含当前数据包已不提供的 id（用户卸了包），
 *   这里原样保留：过滤发生在数据包/门面侧，失效 id 自然匹配不到，用户重新装包后
 *   旧选择自动恢复，不必重选。
 *
 * 为什么落在设置里而不是各页面各存一份：搜索页「全部音源」、AI 找歌、手动换源、
 * 每日推荐跨源都是同一个「聚合搜索」概念，用户的心智是「我只要这几个源」，四个入口
 * 各配一次会互相打架。
 */

/** id 形状校验：数据包下发的源 id 都是短标识（wyy/qq/kw/kg/local 这类），脏数据直接丢 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** 上限：源数量是数据包声明的（当前 4 个），留余量防止脏数据把设置撑爆 */
const MAX_SOURCES = 16;

/**
 * 解析设置原文（JSON 字符串数组）。任何解析失败都归一成 null（= 全部音源），
 * 不让一条坏设置把聚合搜索变成空的。
 */
export function parseAggregateSources(raw: string | null | undefined): string[] | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!ID_PATTERN.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_SOURCES) break;
  }
  return out.length > 0 ? out : null;
}

/** 缓存：undefined = 还没读过；null = 读到了「全部音源」 */
let cached: string[] | null | undefined;

/**
 * 读设置（带进程内缓存）。聚合搜索是用户点一次就跑一次的路径，不值得每次都走 IPC；
 * 设置页保存后调 `saveAggregateSources` 会同步刷新缓存，所以不会读到旧值。
 */
export async function readAggregateSources(): Promise<string[] | null> {
  if (cached !== undefined) return cached;
  try {
    cached = parseAggregateSources(await ipc.getSetting(AGGREGATE_SOURCES_KEY));
  } catch {
    // 读设置失败按「全部音源」处理：宁可多搜几个源，也不要因为一次读失败让搜索变空
    cached = null;
  }
  return cached;
}

/** 保存设置并同步缓存（设置页每次勾选都调，立即生效） */
export async function saveAggregateSources(sources: string[]): Promise<void> {
  const next = parseAggregateSources(JSON.stringify(sources));
  await ipc.setSetting(AGGREGATE_SOURCES_KEY, next === null ? "" : JSON.stringify(next));
  cached = next;
}

/** 清缓存（测试用：同一进程里换 mock 的实现，不重置会读到上一个用例的设置） */
export function resetAggregateSourcesCache(): void {
  cached = undefined;
}
