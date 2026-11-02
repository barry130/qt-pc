/**
 * 私人 FM 的选曲逻辑（A7，对照分析文档 §4.7）。
 *
 * ## 为什么不另写一套打分
 * `recommend-rank.ts` 已经把「口味画像 + 行为质量 + 歌手配额 + MMR 多样性」都算完了，
 * 每日推荐和 FM 的差别只在于**取多少**与**要不要去重历史**：
 * - 每日推荐一次出 50 首、同一天可复现；
 * - FM 每次补一小批（`RADIO_BATCH`），跨批次不重复、听一首补一首。
 * 所以这里只做「把池子按已排过的键剪一遍 → 交给引擎打分选择 → 按种子补一条同歌手车道」。
 *
 * ## 为什么跨批次去重要在本模块做
 * 引擎的 `historyKeys` 只是降权（降 20 分），池子深的时候压不住同一首歌反复冒头。
 * FM 是"一直听下去"的形态，同一首歌在一轮里出现两次是硬伤，所以这里用 `usedKeys`
 * 做**硬排除**：排过的键进 `excludeKeys`，引擎连分都不给。
 *
 * ## 种子（当前曲目 / 歌手）
 * 分析文档的验收要求「种子 = 当前曲目/歌手/收藏」。收藏本来就在池子里、画像里，
 * 不需要特殊处理；当前曲目要额外做一步：**先给出它的同歌手同专辑的歌**，
 * 否则用户按「以这首歌为种子开始 FM」，下一首却是别的歌手，主观上就是"没接上"。
 *
 * ## 会话轮换（为什么不能只靠 variant）
 * `variant` 进引擎后只改**抖动**一项（`W_JITTER = 1.5`）。候选之间的分数差动辄
 * 十几分（收藏 +9、同专辑 +10、历史降权 −20），而 MMR 又把分数归一化到 0..1
 * （`score / maxScore`，真实曲库的 maxScore 常在 20 以上），抖动的影响被压到
 * 零点几分 —— 排在前面的十来首因此几乎不变。用户反馈「每次重新打开 FM 播放的
 * 歌曲全都一模一样」就是这个。所以这里改成**先从引擎取一个宽窗口，再在窗口里
 * 按会话种子换一批**：质量下限由窗口兜住（都是引擎挑过的高分+配额候选），
 * 具体是哪几首、第一首是谁，每次会话都不一样。
 */

import type { Track } from "@/types";
import { songNameKey, trackKey } from "@/lib/text";
import { scoreCandidates, selectDiverse } from "./recommend-rank";
import type { DailyTaste, ScoredCandidate, StyleProfile, TrackQuality } from "./recommend-types";

/** 一次补多少首：太短会频繁补（每次都要一次 IPC），太长会让「不喜欢」的反馈滞后 */
export const RADIO_BATCH = 12;

/** 同一歌手在一批里最多几首 —— 与每日推荐的心动档一致 */
export const RADIO_MAX_PER_SINGER = 3;

/** 种子车道的容量：开头的同歌手/同专辑歌 */
export const RADIO_SEED_LANE = 3;

/** 播放器队列剩余多少首时开始补 */
export const RADIO_REFILL_THRESHOLD = 3;

export interface RadioBatchInput {
  /** 候选池（本地库 + 收藏 + 歌单 + 最近播放，调用方去重好） */
  pool: Track[];
  profile: StyleProfile;
  taste: DailyTaste;
  /** 本轮 FM 已经排过的键（`trackKey` / `songNameKey` 都算） */
  usedKeys: Set<string>;
  /** 与 `pool` **同序**的屏蔽标记（Rust `check_disliked` 的结果） */
  disliked: boolean[];
  /** 给「没听过的优先」加权用 */
  playedKeys?: Set<string>;
  /** 收藏键（命中即视为「用户亲手收的」） */
  savedKeys?: Set<string>;
  quality?: Map<string, TrackQuality>;
  count?: number;
  /** 「换一批」的变体种子 */
  variant?: string;
  /**
   * 上一轮 FM 会话排过的键：够 `count` 首时整批避开它们，不够就退回整窗。
   * 引擎排序是确定性的，只换种子不足以让两次会话真正不同（见文件头「会话轮换」）。
   */
  avoidKeys?: string[];
}

function isUsed(track: Track, usedKeys: Set<string>): boolean {
  return usedKeys.has(trackKey(track)) || usedKeys.has(songNameKey(track));
}

/**
 * 会话轮换的候选窗口倍数：引擎先按「分数 + 歌手/语种配额 + MMR」挑出一个比 `count`
 * 宽得多的窗口，FM 再从窗口里换一批（详见文件头「会话轮换」）。
 */
const ROTATION_WINDOW_FACTOR = 3;

/** FNV-1a 32 位：把会话种子散成一个整数（同一 seed 永远同一结果，测试可复现） */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32：小、确定性、够随机（不为一个洗牌引第三方依赖） */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 洗牌（不改输入）：同一 seed 得到同一顺序，不同 seed 得到不同顺序 */
function seededShuffle<T>(items: T[], seed: number): T[] {
  const random = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * 从窗口里取 `count` 首，同时守住歌手 / 语种两个配额。
 *
 * 窗口是引擎按 `target = 窗口大小` 选出来的：配额递进放宽（×2…×64、最后完全放开）
 * 可能让窗口尾部出现超过 `RADIO_MAX_PER_SINGER` 首同歌手。窗口整体守规矩，但从中
 * 取子集也得自己再守一遍。第一趟严格守配额，取不满就第二趟放开补齐 —— 池子太浅时
 * 宁可有歌可听，也不要因为配额卡着不出声。
 */
function pickWithinCaps(
  window: ScoredCandidate[],
  count: number,
  maxPerSinger: number,
  maxPerLang: number,
): ScoredCandidate[] {
  const out: ScoredCandidate[] = [];
  const singers = new Map<string, number>();
  const langs = new Map<string, number>();
  const take = (item: ScoredCandidate): void => {
    out.push(item);
    const { singerKey, lang } = item.style;
    if (singerKey !== "") singers.set(singerKey, (singers.get(singerKey) ?? 0) + 1);
    if (lang !== "und") langs.set(lang, (langs.get(lang) ?? 0) + 1);
  };
  for (const stage of [
    // 先严格守两个配额，再只放开语种，最后才放开歌手 —— 与引擎的放宽顺序一致：
    // 「同一位歌手一轮最多 3 首」是页面上写着的承诺，能守就守到最后一步
    { singer: maxPerSinger, lang: maxPerLang },
    { singer: maxPerSinger, lang: Number.POSITIVE_INFINITY },
    { singer: Number.POSITIVE_INFINITY, lang: Number.POSITIVE_INFINITY },
  ]) {
    if (out.length >= count) break;
    for (const item of window) {
      if (out.length >= count) break;
      if (out.includes(item)) continue;
      const { singerKey, lang } = item.style;
      if (singerKey !== "" && (singers.get(singerKey) ?? 0) >= stage.singer) continue;
      if (lang !== "und" && (langs.get(lang) ?? 0) >= stage.lang) continue;
      take(item);
    }
  }
  return out;
}

/** 相邻打散：轮换打乱了引擎排好的顺序，尽量别让同歌手的歌挨着（只调顺序，不动集合） */
function spreadAdjacentSinger(items: ScoredCandidate[]): ScoredCandidate[] {
  const out = [...items];
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (let i = 1; i < out.length; i += 1) {
      const key = out[i].style.singerKey;
      if (key === "" || key !== out[i - 1].style.singerKey) continue;
      const j = out.findIndex(
        (candidate, index) =>
          index > i &&
          candidate.style.singerKey !== key &&
          (index + 1 >= out.length || out[index + 1].style.singerKey !== key),
      );
      if (j < 0) continue;
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
      changed = true;
    }
    if (!changed) break;
  }
  return out;
}

/**
 * 从池子里挑出下一批。
 *
 * 返回值可能少于 `count`（池子被排空 / 全被屏蔽）——调用方要接受这个事实并
 * 停下来，而不是拿重复的歌把队列填满。
 */
export function buildRadioBatch(input: RadioBatchInput): Track[] {
  const count = Math.max(0, Math.floor(input.count ?? RADIO_BATCH));
  if (count === 0 || input.pool.length === 0) return [];

  const candidates: Track[] = [];
  const disliked: boolean[] = [];
  input.pool.forEach((track, index) => {
    if (!track?.title || !track.id) return;
    if (isUsed(track, input.usedKeys)) return;
    candidates.push(track);
    disliked.push(input.disliked[index] === true);
  });
  if (candidates.length === 0) return [];

  const options = {
    taste: input.taste,
    // 先多打一些再让选择阶段砍到 count：MMR 的多样性要靠候选之间的比较才成立
    target: Math.min(candidates.length, Math.max(count, count * ROTATION_WINDOW_FACTOR)),
    maxPerSinger: RADIO_MAX_PER_SINGER,
    playedKeys: input.playedKeys,
    savedKeys: input.savedKeys,
    quality: input.quality,
    disliked,
    excludeKeys: input.usedKeys,
    variant: input.variant,
  };
  const scored = scoreCandidates(candidates, input.profile, options);
  // 窗口（高分 + 配额 + MMR）：比 count 宽，留出会话轮换的余地
  const window = selectDiverse(scored, input.profile, options);
  if (window.length === 0) return [];
  // 上一轮会话排过的歌优先让位：够 count 首才硬排除，不够就退回整窗（宁可能撞，也别没歌）
  const avoid = new Set(input.avoidKeys ?? []);
  const fresh = avoid.size === 0 ? window : window.filter((item) => !avoid.has(trackKey(item.track)));
  const usable = fresh.length >= count ? fresh : window;
  // 会话轮换：没有种子（每日推荐那种「可复现」用法）就保持引擎顺序取前 count 首
  const seed = input.variant ?? "";
  const rotated = seed === "" ? usable : seededShuffle(usable, hashSeed(seed));
  const picked = pickWithinCaps(
    rotated,
    count,
    RADIO_MAX_PER_SINGER,
    Math.max(2, Math.ceil(count * 0.6)),
  );
  return spreadAdjacentSinger(picked).map((item) => item.track);
}

/**
 * 种子车道：以当前曲目为种子时，先接上它的同歌手 / 同专辑。
 *
 * 只取 `lane` 首，且**不放回池子里已排过的**；不够就安静地少给，剩下的名额由
 * 常规批次补 —— 「接得顺」比「必须凑满 3 首同歌手」重要。
 */
export function seedLane(pool: Track[], seed: Track | null, lane = RADIO_SEED_LANE): Track[] {
  if (!seed || lane <= 0) return [];
  const singer = (seed.singer ?? "").trim();
  const album = (seed.album ?? "").trim();
  const seedKey = trackKey(seed);
  const sameSinger: Track[] = [];
  const sameAlbum: Track[] = [];
  for (const track of pool) {
    if (!track?.title || trackKey(track) === seedKey) continue;
    if (album && (track.album ?? "").trim() === album) {
      sameAlbum.push(track);
    } else if (singer && (track.singer ?? "").trim() === singer) {
      sameSinger.push(track);
    }
  }
  // 同专辑比同歌手更"近"，先排专辑里的其它歌
  return [...sameAlbum, ...sameSinger].slice(0, lane);
}

/** 播放器队列快见底了：该补了 */
export function shouldRefill(remaining: number): boolean {
  return remaining <= RADIO_REFILL_THRESHOLD;
}

/**
 * 把一批曲目里已经出现过的键收进 `usedKeys`（就地改，FM store 直接用）。
 */
export function markUsed(usedKeys: Set<string>, tracks: Track[]): void {
  for (const track of tracks) {
    const key = trackKey(track);
    if (key) usedKeys.add(key);
    const name = songNameKey(track);
    if (name) usedKeys.add(name);
  }
}

/**
 * 开始一次 FM 会话时的变体种子。
 *
 * 选曲是**确定性**的：同一份画像 + 同一个池子 + 没有 `variant` 时，引擎的抖动种子
 * 固定（`recommend-rank.ts` 的 `seed = dateKey`），于是每次进 FM 都会挑出**一模一样**
 * 的第一首和同一批队列 —— 用户反馈「每次开始播放都是这一首歌，播放队列是一模一样
 * 的内容」就是这个原因。
 *
 * 这个种子有两个用处：一是引擎的抖动（作用有限，见文件头「会话轮换」），
 * 二是 `buildRadioBatch` 的**窗口洗牌**（真正让两次会话不同的那一步）。
 * 「换一批」按钮用时间戳当种子，开始新会话用这里的毫秒时间戳 + 自增计数器兜底
 * （同一毫秒内连续开始两次也不会撞出同一批）。
 */
let sessionSeq = 0;
export function sessionVariant(): string {
  sessionSeq += 1;
  return `${Date.now().toString(36)}-${sessionSeq}`;
}
