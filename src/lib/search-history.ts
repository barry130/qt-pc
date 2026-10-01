import * as ipc from "@/services/ipc";

/**
 * 搜索历史（settings 表 "search.history"，JSON 字符串数组）。
 * 为什么放 settings 而不是 localStorage：与扫描过滤、下载音质等设置同一套
 * 持久化通道，重启后保持；搜索历史量小（≤ 20 条），读写成本可忽略。
 */

const HISTORY_KEY = "search.history";
/** 上限：再多最旧的滚出去 */
export const HISTORY_MAX = 20;

/**
 * 纯逻辑：把新关键词并入历史（去重、置顶、截断）。
 * 空串 / 纯空白不入队。供 UI 与测试共用。
 */
export function mergeHistory(prev: string[], kw: string, max = HISTORY_MAX): string[] {
  const trimmed = kw.trim();
  if (!trimmed) return prev;
  const rest = prev.filter((k) => k !== trimmed);
  return [trimmed, ...rest].slice(0, max);
}

export async function getSearchHistory(): Promise<string[]> {
  const raw = await ipc.getSetting(HISTORY_KEY).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    // 存档被手改坏：当没有历史处理，别让搜索页挂掉
    return [];
  }
}

export async function addSearchHistory(kw: string): Promise<void> {
  const trimmed = kw.trim();
  if (!trimmed) return;
  const next = mergeHistory(await getSearchHistory(), trimmed);
  await ipc.setSetting(HISTORY_KEY, JSON.stringify(next)).catch(() => {
    // 历史写失败不影响搜索本身
  });
}

export async function removeSearchHistoryItem(kw: string): Promise<void> {
  const next = (await getSearchHistory()).filter((k) => k !== kw);
  await ipc.setSetting(HISTORY_KEY, JSON.stringify(next)).catch(() => {});
}

export async function clearSearchHistory(): Promise<void> {
  await ipc.setSetting(HISTORY_KEY, JSON.stringify([])).catch(() => {});
}
