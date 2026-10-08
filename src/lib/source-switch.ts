import { searchAllBatches } from "@/source-scripts";
import type { Track } from "@/types";

/**
 * 手动换源（用户 m07452：「增加一个换源，即当前源不支持该歌曲，支持搜索
 * 其他源歌曲并展示」）。
 *
 * 与包侧取链兜底（qt-sources/src/actions/play-url.ts 的 pickBestMatch）同口径
 * 的轻量评分：同名 +10 / 包含 +5；歌手同名 +6 / 包含 +3；0 分剔除。区别在于
 * 那边是**自动兜底**（取链失败时静默换），这边是**手动挑选**（把候选列出来
 * 让用户自己选），所以门槛更低（>=5 的自动兜底门槛在这里只影响排序，不拦截）、
 * 并保留全部正分候选供用户翻看。
 */

/** 归一化匹配文本：小写 + 折叠空白 */
export function normalizeMatchText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}

/**
 * 候选与目标歌的相似度：同名 +10 / 包含 +5；歌手同名 +6 / 包含 +3。
 * 歌名与歌手都没有匹配时返回 0（调用方剔除）。
 */
export function scoreCandidate(
  candidate: Track,
  want: { title: string; singer: string },
): number {
  const name = normalizeMatchText(candidate.title ?? "");
  const wantName = normalizeMatchText(want.title ?? "");
  if (!name || !wantName) return 0;
  let score = 0;
  if (name === wantName) score += 10;
  else if (name.includes(wantName) || wantName.includes(name)) score += 5;
  const singer = normalizeMatchText(candidate.singer ?? "");
  const wantSinger = normalizeMatchText(want.singer ?? "");
  if (singer && wantSinger) {
    if (singer === wantSinger) score += 6;
    else if (singer.includes(wantSinger) || wantSinger.includes(singer)) score += 3;
  }
  return score;
}

/** 候选上限：防止冷门歌搜出几百条把弹层撑爆 */
const MAX_CANDIDATES = 20;

/**
 * 换源结果的**进程内临时缓存**（用户口径：关掉再打开不用重新搜一遍）。
 *
 * 为什么只做内存缓存不做持久化：候选是「此刻各源能不能播」的快照，落库后
 * 下次打开拿到的可能是已经失效的源，反而误导；而一次会话里反复开同一个
 * 换源弹层才是真实痛点（换源失败 → 关掉 → 再开 → 再等一轮聚合搜索）。
 * 进程退出即失效，与「临时」的定位一致。
 *
 * 键 = `platform:id` + 页码（翻页结果分页存，命中就直接追加，不重搜）。
 * 上限 32 首 + FIFO 淘汰：多到这个量级说明用户在批量试冷门歌，旧结果已无意义。
 */
const CACHE_MAX_ENTRIES = 32;
/** 缓存有效期 10 分钟：源站可用性/榜单排序会变，但不需要分钟级新鲜度 */
const CACHE_TTL_MS = 10 * 60 * 1000;

type Candidate = { track: Track; score: number };
const cache = new Map<string, { at: number; items: Candidate[] }>();

function cacheKey(track: Track, page: number, size: number): string {
  return `${track.platform}:${track.id}:${page}:${size}`;
}

/** 取缓存（过期/缺失返回 null）；命中时顺手把键提到队尾，维持 FIFO 顺序 */
function cacheGet(key: string): Candidate[] | null {
  const hit = cache.get(key);
  if (hit === undefined) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, hit); // 重新插入 = 移到队尾
  return hit.items;
}

function cacheSet(key: string, items: Candidate[]): void {
  cache.delete(key);
  cache.set(key, { at: Date.now(), items });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** 清空换源缓存（切账号/换包/手动刷新时用；测试里也要用它隔离） */
export function clearSourceSwitchCache(): void {
  cache.clear();
}

/**
 * 同步窥一眼首页缓存（未命中返回 null）。
 * 面板用它决定「要不要进 loading」：命中就直接渲染，不闪「正在搜索…」。
 */
export function peekSourceCandidates(track: Track): Candidate[] | null {
  return cacheGet(cacheKey(track, 1, 5));
}

/**
 * 在其他音源里搜这首歌：聚合搜索（keyword = 「歌名 歌手」），同源剔除、
 * 跨源去重、0 分剔除，按相似度降序返回候选。
 * 搜索失败时抛错由调用方展示；空关键词直接返回空数组。
 *
 * 结果按「曲目 + 页码」缓存：`force` 为真时跳过缓存并覆盖（面板的「重新搜索」）。
 */
export async function findSourceCandidates(
  track: Track,
  opts?: { page?: number; size?: number; force?: boolean },
): Promise<{ track: Track; score: number }[]> {
  const keyword = [track.title, track.singer].filter(Boolean).join(" ").trim();
  if (!keyword) return [];
  const page = opts?.page ?? 1;
  const size = opts?.size ?? 5;
  const key = cacheKey(track, page, size);
  if (opts?.force !== true) {
    const cached = cacheGet(key);
    if (cached !== null) return cached;
  }
  const batches = await searchAllBatches(keyword, page, size);
  const out: { track: Track; score: number }[] = [];
  const seen = new Set<string>();
  for (const batch of batches) {
    for (const candidate of batch.tracks) {
      if (candidate.platform === track.platform) continue; // 同源剔除
      const dedupKey = `${candidate.platform}:${candidate.id}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      const score = scoreCandidate(candidate, track);
      if (score <= 0) continue;
      out.push({ track: candidate, score });
    }
  }
  out.sort((a, b) => b.score - a.score);
  const result = out.slice(0, MAX_CANDIDATES);
  cacheSet(key, result);
  return result;
}
