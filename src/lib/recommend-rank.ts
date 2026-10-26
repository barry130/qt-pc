/**
 * 推荐排序引擎：按「口味画像」给候选打分，再做 MMR 多样性选择。
 *
 * ## 为什么推倒重来
 * 旧版 `daily-recommend.ts` 的 `rankCandidates` 只有一路信号：你在不在「常听歌手」榜上。
 * 用户 2026-10-23 的原话是「不应该根据你听过的歌手去推荐，应该根据你之前听过歌曲的
 * 风格等等各方面综合一起去推荐」—— 只按歌手扩候选、只按歌手排，池子和结果都被那几个人锁死。
 * 新引擎把信号摊成三路：
 * 1. **风格**：语种、时长带、专辑亲和（本地能算，零网络）；
 * 2. **行为质量**：完播 / 重播 / 「反复点开听 20 秒就切」（`TrackQuality`）；
 * 3. **歌手亲和**：只是其中一路，而且在探索口味下**倒扣**。
 *
 * ## 为什么不是「按分数降序截断」
 * 降序截断会让同一个歌手的高分歌连排最前面（旧版就是被用户这么投诉的）。这里选择阶段用
 * MMR（maximal marginal relevance）：每轮扣掉「和已选集合最像」的那部分分数，再叠上
 * 歌手/语种硬配额。配额只约束前排 —— 池子浅的时候逐级放宽，保证页面不空。
 *
 * ## 纯函数
 * 不碰 IPC / store / React / `daily-recommend.ts`，所有输入走参数、所有输出由输入决定
 * （唯一的「环境」是 `dateKey` 缺省时的本地日期，测试可显式注入）。曾经这里**故意**
 * 复制了几个十行小工具（`trackKey` / `songNameKey` / `normText` / FNV-1a）来避免
 * 「排序 ↔ 生成」循环依赖；现在这些小工具下沉到了叶子模块 `@/lib/text`，两边都
 * import 它，循环依赖不存在了，副本也删了（2026-10-23 合并重复代码）。
 */

import { durationBand } from "@/lib/music-style";
import { MUSIC_LANG_LABEL } from "@/lib/recommend-types";
import type {
  DailyTaste,
  MusicLang,
  RankHit,
  RankOptions,
  ScoredCandidate,
  StyleProfile,
  TrackStyle,
} from "@/lib/recommend-types";
import {
  jitter,
  localDateKey,
  normText,
  songNameKey,
  trackKey,
  truncateChars,
} from "@/lib/text";
import { clamp01 } from "@/lib/utils";
import type { Track } from "@/types";

/** 目标条数缺省值 */
const DEFAULT_TARGET = 50;

/** 配额放宽的上限倍数：严格配额撑不满时按 ×2 逐级放宽，到这里为止 */
const MAX_RELAX_FACTOR = 64;

/**
 * 每种口味「同一歌手最多几首」的缺省配额。
 *
 * 探索口味是 1：它的诉求就是「一个歌手最多一首」，多出来的名额宁可空着（诚实于口味），
 * 而不是拿同一个人的歌填满 50 首 —— 那正是用户要摆脱的状态。
 */
const TASTE_MAX_PER_SINGER: Record<DailyTaste, number> = { heart: 3, familiar: 3, explore: 1 };

/** 每种口味的 MMR λ 缺省值：越探索越强调「别跟已选的像」 */
const TASTE_DIVERSITY: Record<DailyTaste, number> = { heart: 0.6, familiar: 0.4, explore: 0.9 };

/** similarity 各分量权重。四项加起来正好 1，所以同一首歌对同一首歌得 1.0 */
const SIM_WEIGHT = { singer: 0.4, album: 0.2, lang: 0.25, band: 0.15 } as const;

/**
 * 权重表：行=特征，列=口味。
 *
 * 为什么这些数（改之前先读完，别按直觉调）：
 * - `saved` 最高（心动 9）：用户亲手收进收藏/歌单的歌是最硬的「喜欢」，不需要推断；
 * - 语种「完全不在画像里」在 heart/familiar 是**负分**（口味不匹配），但在 explore 是
 *   **全表次高**（+6）：探索本来就是要出圈，只是别出得太离谱（新歌手 +9 比它更硬）；
 * - `familiar-singer` 在 explore 是 −4×s：这是本次反馈的直接落点 —— 越常听越要往后放，
 *   不然推荐永远还是那几个人；同时「新歌手 +9」给新面孔一条专属快车道；
 * - heart 也给新歌手 +3（不是 0）：心动口味应该稳，但不能被封死成「只听老熟人」。
 * - `unplayed` 三档都为正：每日推荐的重点是「没听过的」。
 */
type TasteWeights = Record<DailyTaste, number>;
const W_SAVED: TasteWeights = { heart: 9, familiar: 5, explore: 2 };
const W_ALBUM: TasteWeights = { heart: 10, familiar: 6, explore: 3 };
const W_MAIN_LANG: TasteWeights = { heart: 7, familiar: 6, explore: 4 };
const W_SECOND_LANG: TasteWeights = { heart: 2, familiar: 2, explore: 2 };
const W_NEW_LANG: TasteWeights = { heart: -5, familiar: -4, explore: 6 };
const W_MAIN_BAND: TasteWeights = { heart: 2, familiar: 2, explore: 1 };
const W_FAMILIAR_SINGER: TasteWeights = { heart: 8, familiar: 10, explore: -4 };
const W_NEW_SINGER: TasteWeights = { heart: 3, familiar: 1, explore: 9 };
const W_UNPLAYED: TasteWeights = { heart: 4, familiar: 2, explore: 6 };
/**
 * 「只在歌手榜里见过、画像里没有」时的折减系数。
 *
 * 画像的 `singers` 是加权结果（靠播放统计 + 收藏），而歌手榜是全网历史的一手计数，
 * 覆盖面更广但粒度更粗（不知道这个人最近是不是被你跳过了），所以只算一半分量。
 */
const FAMILIAR_SINGER_FALLBACK = 0.5;
/** 行为质量：affinity 换算成分数 */
const W_QUALITY_AFFINITY = 4;
/** 「反复点开但每次听不到一半」的惩罚 */
const W_SKIPPED = -8;
/** 最近几天推荐过：只降权，不放逐（硬排除会让池子耗尽时页面直接空掉） */
const W_HISTORY = -20;
/** 稳定抖动：同一天同一批结果可复现，隔天有变化 */
const W_JITTER = 1.5;

/**
 * 本模块的**局部**选项扩展。
 *
 * `recommend-types.ts` 的 `RankOptions` 没有这两个字段（契约由 Lead 定，不能改）：
 * - `excludeKeys`：Lead 在集成层已经排掉的键，打分层仍应按硬排除处理；
 * - `styles`：曲目风格坐标。`scoreCandidates` 的签名只收 `Track[]`，所以默认由本模块
 *   用 `deriveStyle` 推导；集成层如果能从 `music-style.ts` 拿到权威结果，可以透传进来，
 *   避免两处推导口径漂移。
 * 用 `extends` 扩展而不是复制一份类型：所有原有字段仍然只有一处定义。
 */
export interface RankOptionsExt extends RankOptions {
  excludeKeys?: Set<string>;
  styles?: Map<string, TrackStyle>;
}

// ---------- 小工具 ----------
// trackKey / songNameKey / normText / localDateKey / FNV-1a(jitter) / truncateChars /
// clamp01 都在共享叶子模块里（`@/lib/text` / `@/lib/utils`），这里不再留副本。
// 时长带同理用 `music-style.ts` 的唯一实现 —— 两边边界曾经不同步
// （这边 180/270/420，画像那边 150/240/330），同一首歌会被判进不同的带，
// 和画像的 mainBand 对比时错位，2026-10-23 起统一以画像口径为准。

/**
 * 文字种类推断：假名 > 谚文 > 汉字 > 拉丁。
 *
 * 优先级不能反：日文歌大量使用汉字，只看汉字会把日语歌全判成华语；有假名就一定是日语。
 * 拉丁字母要求至少两个 —— 单个字母标题（「A」「X」）更像符号或代号，判成欧美是噪音。
 */
function detectLang(raw: string): MusicLang {
  const text = raw.toLowerCase();
  let kana = 0;
  let hangul = 0;
  let han = 0;
  let latin = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0x31f0 && code <= 0x31ff)) {
      kana += 1;
    } else if (code >= 0xff66 && code <= 0xff9d) {
      kana += 1;
    } else if (
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x3130 && code <= 0x318f)
    ) {
      hangul += 1;
    } else if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      han += 1;
    } else if ((code >= 0x61 && code <= 0x7a) || (code >= 0xc0 && code <= 0x24f)) {
      latin += 1;
    }
  }
  if (kana > 0) return "ja";
  if (hangul > 0) return "ko";
  if (han > 0) return "zh";
  if (latin >= 2) return "en";
  return "und";
}

/** 整首曲目的语种：标题优先，判不出来才退回歌手/专辑（中文歌手唱英文歌的情况很常见） */
function detectTrackLang(track: Track): MusicLang {
  const fromTitle = detectLang(track.title);
  if (fromTitle !== "und") return fromTitle;
  return detectLang(`${track.singer} ${track.album}`);
}

/** 由 `Track` 推一份风格坐标：`scoreCandidates` 只收 `Track[]`，没有别的来源 */
function deriveStyle(track: Track): TrackStyle {
  const singerKey = normText(track.singer);
  const albumName = normText(track.album);
  return {
    singerKey,
    // 专辑键带上歌手：大量合辑/精选都叫「精选」，只按专辑名会把别人的精选算成同一张
    albumKey: albumName ? `${singerKey}|${albumName}` : "",
    lang: detectTrackLang(track),
    band: durationBand(track.duration),
  };
}
/** 配额取值：≤0 视为「不限」（`RankOptions.maxPerLang` 约定 0 = 不限） */
function asCap(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : Number.POSITIVE_INFINITY;
}

// ---------- similarity ----------

/**
 * 两首歌的「风格相似度」，0..1。命中即加，上限 1。
 *
 * 只用来做 MMR 的去重（「别跟已选的像」），**不参与打分** —— 打分看的是「和你整体
 * 口味像不像」，这里看的是「和你刚选的那几首像不像」，两者不能混。
 */
export function similarity(a: TrackStyle, b: TrackStyle): number {
  let score = 0;
  // 空歌手键（未知歌手）不算「同歌手」：否则全库的「未知歌手」互相 +0.4，
  // MMR 会把一堆毫不相干的歌当成同一个人的作品往死里扣。
  if (a.singerKey !== "" && a.singerKey === b.singerKey) score += SIM_WEIGHT.singer;
  if (a.albumKey !== "" && a.albumKey === b.albumKey) score += SIM_WEIGHT.album;
  // und 是「判不出来」，不是一种语种，两边都是 und 不能算同语种
  if (a.lang !== "und" && a.lang === b.lang) score += SIM_WEIGHT.lang;
  if (a.band === b.band) score += SIM_WEIGHT.band;
  return Math.min(1, score);
}

// ---------- 打分 ----------

/**
 * 给候选打分。硬排除（不进结果）：`options.disliked[i] === true`、`options.excludeKeys` 命中。
 * 其余每首都会返回，分数只为 `selectDiverse` 的 MMR 服务。
 *
 * `hits` 按命中顺序记录，只为生成推荐理由（`reasonFor`）服务，不参与算分。
 */
export function scoreCandidates(
  candidates: Track[],
  profile: StyleProfile,
  options: RankOptions,
): ScoredCandidate[] {
  const ext: RankOptionsExt = options;
  const excludeKeys = ext.excludeKeys ?? new Set<string>();
  const styles = ext.styles;
  const historyKeys = options.historyKeys ?? new Set<string>();
  const playedKeys = options.playedKeys ?? new Set<string>();
  const savedKeys = options.savedKeys ?? new Set<string>();
  const quality = options.quality;
  const disliked = options.disliked ?? [];
  const taste = options.taste;
  const dateKey = options.dateKey ?? localDateKey();
  // 「换一批」的种子：同一天点多次能换出不同批次，同一天内又可复现（缓存要能命中）
  const seed = options.variant ? `${dateKey}|${options.variant}` : dateKey;

  const singerShare = profile.singers;
  const familiarSingers = options.familiarSingers ?? new Set<string>();
  const albumShare = profile.albums;
  const langShare = profile.langs;
  const mainLang = profile.mainLang;
  const mainBand = profile.mainBand;

  const scored: ScoredCandidate[] = [];
  candidates.forEach((track, index) => {
    if (disliked[index] === true) return;
    const key = trackKey(track);
    const nameKey = songNameKey(track);
    if (excludeKeys.has(key) || excludeKeys.has(nameKey)) return;

    const style = styles?.get(key) ?? deriveStyle(track);
    const hits: RankHit[] = [];
    let score = 0;

    // 收藏：用户亲手收进来的，最硬的信号
    if (savedKeys.has(key) || savedKeys.has(nameKey)) {
      score += W_SAVED[taste];
      hits.push("saved");
    }

    // 同专辑：这张专辑你反复听，那这张里的其它歌大概率也合口味
    if (style.albumKey !== "" && style.albumKey in albumShare) {
      const affinity = albumShare[style.albumKey];
      if (affinity > 0) {
        score += W_ALBUM[taste] * affinity;
        hits.push("same-album");
      }
    }

    // 语种三态：主语种 / 画像里的次要语种 / 完全没出现过
    if (style.lang !== "und") {
      if (style.lang === mainLang) {
        score += W_MAIN_LANG[taste];
        hits.push("main-lang");
      } else if (style.lang in langShare) {
        score += W_SECOND_LANG[taste];
        hits.push("other-lang");
      } else {
        score += W_NEW_LANG[taste];
        hits.push("other-lang");
      }
    }

    // 时长带：弱特征，只用一两点分做微调
    if (style.band === mainBand) {
      score += W_MAIN_BAND[taste];
      hits.push("main-band");
    }

    // 歌手：常听 vs 新人，两档权重方向在 explore 下是反的（见权重表注释）
    if (style.singerKey !== "" && style.singerKey in singerShare) {
      score += W_FAMILIAR_SINGER[taste] * singerShare[style.singerKey];
      hits.push("familiar-singer");
    } else if (style.singerKey !== "" && familiarSingers.has(style.singerKey)) {
      // 画像里没有，但歌手榜上有：仍然算「熟悉」，只是只算一半分量。
      // 这条存在的理由是覆盖率 —— 画像样本来自 top200 播放统计，歌手榜覆盖全部历史。
      score += W_FAMILIAR_SINGER[taste] * FAMILIAR_SINGER_FALLBACK;
      hits.push("familiar-singer");
    } else {
      // 歌手未知（键为空）不算「新歌手」，不给 +9 —— 那会把一堆无歌手信息的歌顶上来
      if (style.singerKey !== "") {
        score += W_NEW_SINGER[taste];
        hits.push("new-singer");
      }
    }

    // 行为质量：完播/重播/最近性；「反复点开却听不完」直接倒扣
    const q = quality?.get(key);
    if (q) {
      score += W_QUALITY_AFFINITY * q.affinity;
      if (q.skipped) {
        score += W_SKIPPED;
        hits.push("skipped");
      }
    }

    if (!playedKeys.has(key)) {
      score += W_UNPLAYED[taste];
      hits.push("unplayed");
    }

    // 最近几天推荐过：降权不放逐 —— 硬排除会让池子耗尽时页面直接空掉
    if (historyKeys.has(key) || historyKeys.has(nameKey)) {
      score += W_HISTORY;
      hits.push("replayed");
    }

    score += W_JITTER * jitter(seed, key);
    scored.push({ track, style, score, hits });
  });
  return scored;
}

// ---------- MMR 多样性选择 ----------

/**
 * MMR 贪心选择 + 歌手/语种配额。
 *
 * 每一轮对未选候选算 `mmr = scoreNorm − λ × max(与已选集合的 similarity)`，取最大者；
 * 第一轮没有已选集合，所以就是取归一化分数最高那首。
 *
 * 配额只约束**前排**：严格按配额选不满 target 时，把两个配额同时 ×2 再来一轮，直到 ×64；
 * 仍不满的非探索口味才完全放开兜底补齐 —— 否则「就爱听三个人」的用户会看到 50 首里只有
 * 30 首。探索口味不参与任何放宽：它的诉求就是「一个歌手最多一首」，池子不够就少推，
 * 这是对口味诚实，也是这次反馈的核心。
 *
 * @param profile 保留在签名里与 `scoreCandidates` 共用同一套调用形状；MMR 只需要
 *   `taste`、分数和相似度，所以这里显式 `void` 掉，避免 `noUnusedParameters` 报错。
 */
export function selectDiverse(
  scored: ScoredCandidate[],
  profile: StyleProfile,
  options: RankOptions,
): ScoredCandidate[] {
  void profile;
  const target = Math.max(0, Math.floor(options.target ?? DEFAULT_TARGET));
  if (target === 0 || scored.length === 0) return [];

  const taste = options.taste;
  const lambda = options.diversity === undefined ? TASTE_DIVERSITY[taste] : clamp01(options.diversity);
  const singerCapBase = asCap(options.maxPerSinger ?? TASTE_MAX_PER_SINGER[taste]);
  const langCapBase = asCap(options.maxPerLang ?? Math.max(2, Math.ceil(target * 0.6)));

  /**
   * 归一化到 0..1：绝对分动辄 ±20，similarity 只有 0..1，不归一两项相减没有意义。
   * 全批最大分 ≤ 0（整池都被历史降权压穿之类）时统一给 1：此时分数已经分不出好坏，
   * 只能靠相似度决定顺序，给 0 会让 MMR 全部相等、退化成输入序。
   */
  const maxScore = scored.reduce(
    (best, candidate) => (candidate.score > best ? candidate.score : best),
    Number.NEGATIVE_INFINITY,
  );
  const norm = scored.map((candidate) =>
    maxScore > 0 ? clamp01(candidate.score / maxScore) : 1,
  );

  const chosen: ScoredCandidate[] = [];
  const used = new Set<number>();
  const singerCount = new Map<string, number>();
  const langCount = new Map<MusicLang, number>();

  /**
   * 每首候选「与已选集合的最大相似度」的运行最大值（第一轮全是 0）。
   *
   * 原先 `maxSimilarity(i)` 每次现算，要遍历整个已选集合：fill 是
   * O(未选 × 已选) 的扫描，而 fill 又被放宽配额的循环反复调用，合计
   * O(n·k²) 次 `similarity`（每次含 4 个分量比对）。这里改成「选入一首后
   * 就地刷新全部候选的 running max」，总代价降到 O(n·k)，结果逐位相同
   * （max 可结合，与遍历顺序无关）。
   */
  const simMax = new Array<number>(scored.length).fill(0);

  /** 与已选集合的最大相似度：直接读运行最大值 */
  const maxSimilarity = (index: number): number => simMax[index];

  /** 配额检查：空歌手键与 und 语种不计入配额（它们不是「某个歌手/某种语种」） */
  const withinQuota = (index: number, singerCap: number, langCap: number): boolean => {
    const { style } = scored[index];
    if (style.singerKey !== "" && (singerCount.get(style.singerKey) ?? 0) >= singerCap) {
      return false;
    }
    if (style.lang !== "und" && (langCount.get(style.lang) ?? 0) >= langCap) return false;
    return true;
  };

  const take = (index: number): void => {
    const candidate = scored[index];
    used.add(index);
    chosen.push(candidate);
    if (candidate.style.singerKey !== "") {
      const key = candidate.style.singerKey;
      singerCount.set(key, (singerCount.get(key) ?? 0) + 1);
    }
    if (candidate.style.lang !== "und") {
      const lang = candidate.style.lang;
      langCount.set(lang, (langCount.get(lang) ?? 0) + 1);
    }
    // 刷新 running max：选入一首后，所有未选候选与已选集合的最大相似度取两者较大值
    const pickedStyle = candidate.style;
    for (let i = 0; i < scored.length; i += 1) {
      const sim = similarity(scored[i].style, pickedStyle);
      if (sim > simMax[i]) simMax[i] = sim;
    }
  };

  /** 在当前配额下一直选到 target 满、或者配额把剩下的全挡住 */
  const fill = (singerCap: number, langCap: number): void => {
    while (chosen.length < target) {
      let bestIndex = -1;
      let bestMmr = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < scored.length; i += 1) {
        if (used.has(i)) continue;
        if (!withinQuota(i, singerCap, langCap)) continue;
        const mmr = norm[i] - lambda * maxSimilarity(i);
        // 并列时取绝对分更高、再并列取输入序靠前的：结果必须可复现（缓存按天算）
        const better =
          bestIndex < 0 ||
          mmr > bestMmr + 1e-12 ||
          (Math.abs(mmr - bestMmr) <= 1e-12 && scored[i].score > scored[bestIndex].score);
        if (better) {
          bestMmr = mmr;
          bestIndex = i;
        }
      }
      // 配额把剩下的全挡住了 —— 交给上一层的「放宽配额」循环
      if (bestIndex < 0) break;
      take(bestIndex);
    }
  };

  if (taste === "explore") {
    // 探索口味：只跑严格配额，不放宽、不兜底（见函数头注释）
    fill(singerCapBase, langCapBase);
  } else {
    // 放宽分两阶段，**先语种后歌手**：歌手配额是用户抱怨的那条（「每次都是这个歌手」），
    // 必须最后才让步。反过来先放宽歌手配额会出事 —— 池子全是一个语种时（华语库很常见），
    // 语种上限会先把结果卡住，于是歌手配额被连坐放宽，同一个歌手又霸屏。
    for (let factor = 1; factor <= MAX_RELAX_FACTOR && chosen.length < target; factor *= 2) {
      fill(singerCapBase, langCapBase * factor);
    }
    // 语种彻底放开后仍然不够，才轮到歌手配额逐级放宽
    for (let factor = 2; factor <= MAX_RELAX_FACTOR && chosen.length < target; factor *= 2) {
      fill(singerCapBase * factor, Number.POSITIVE_INFINITY);
    }
    // 歌手实在太少（比如整池就一个人）时不再卡配额，有多少给多少
    if (chosen.length < target) fill(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  }

  return spreadAdjacentSinger(chosen);
}

/**
 * 相邻打散：结果里不要出现连续两首同歌手。
 *
 * MMR 通常已经保证了这一点，但**兜底补齐阶段**是按分数直接往里塞的，会把同一个人的歌
 * 排到一起。这里只调顺序、不动集合（配额统计已经算完，顺序不影响任何计分）。
 *
 * **第一首是钉住的**：它是 MMR 算出来的最高分，也是用户打开页面第一眼看到的那首，
 * 打散不许把它挪走。这一条不是可选项 —— 曾经漏掉它，结果「分数最高的那首」被挤到
 * 第二位，用户看到的第一首反而像随手排的。交换只在 i >= 1 与 j > i 之间进行，
 * 天然不碰下标 0；分组轮流取那条路也必须显式钉住队首。
 *
 * 贪心 + 多轮扫描：遇到同歌手就与后面第一个「换过来不制造新冲突」的元素交换。
 * 单轮交换不够 —— 把 out[j] 换到 i 处之后，被换到 j 处的 out[i] 可能与 out[j+1] 撞上，
 * 而扫描指针已经走过 j 了。所以一轮下来还有冲突就再扫一轮，直到一轮无改动为止
 * （交换只会减少冲突，最多 n 轮必然收敛）。
 *
 * 交换有做不到的形状：`[x, y×30, x×19]` 里冲突点之后**全是** x，往后换不到任何不同歌手，
 * 但把前面的 y 换进来就能解决。所以交换失败时退回 `interleaveBySinger`（按歌手分组后
 * 轮流取，同样不动集合、同样钉住队首）—— 那条路只要「最大组 ≤ ceil(n/2)」就一定能排出
 * 无相邻结果。
 */
function spreadAdjacentSinger(items: ScoredCandidate[]): ScoredCandidate[] {
  const out = [...items];
  const n = out.length;
  for (let pass = 0; pass < n; pass += 1) {
    let changed = false;
    for (let i = 1; i < n; i += 1) {
      const prevSinger = out[i - 1].style.singerKey;
      if (out[i].style.singerKey !== prevSinger) continue;
      // 首选：换过来既不与前一格冲突、也不与后一格冲突的位置
      let swapAt = -1;
      for (let j = i + 1; j < n; j += 1) {
        if (out[j].style.singerKey === prevSinger) continue;
        if (j + 1 < n && out[j + 1].style.singerKey === out[i].style.singerKey) continue;
        swapAt = j;
        break;
      }
      // 次选：只要换到 i 处不冲突就行（后面那格由下一轮扫描修）
      if (swapAt < 0) {
        for (let j = i + 1; j < n; j += 1) {
          if (out[j].style.singerKey !== prevSinger) {
            swapAt = j;
            break;
          }
        }
      }
      // 后面没有不同歌手可换 —— 交换这条路走到头了，交给分组轮流取
      if (swapAt < 0) return interleaveBySinger(out);
      const tmp = out[i];
      out[i] = out[swapAt];
      out[swapAt] = tmp;
      changed = true;
    }
    if (!changed) return out;
  }
  return hasAdjacentSinger(out) ? interleaveBySinger(out) : out;
}

function hasAdjacentSinger(items: ScoredCandidate[]): boolean {
  for (let i = 1; i < items.length; i += 1) {
    if (items[i].style.singerKey === items[i - 1].style.singerKey) return true;
  }
  return false;
}

/**
 * 按歌手分组后轮流取（不动集合，只重排）。
 *
 * 每步从「剩余最多、且与上一首不同歌手」的组里取一首 —— 这就是经典的任务调度贪心，
 * 只要最大组 ≤ ceil(n/2) 就必然排得开。空歌手键视为各自独立（不参与分组归并）。
 *
 * **队首钉住**：`items[0]` 是 MMR 的最高分，永远留在第一位，只对 `items.slice(1)`
 * 做轮流取。不钉的话这条兜底路径会把最高分那首挪到中间去（和 `spreadAdjacentSinger`
 * 同一个坑，见那里的注释）。
 */
function interleaveBySinger(items: ScoredCandidate[]): ScoredCandidate[] {
  if (items.length <= 2) return [...items];
  // 保持组内原有相对顺序：组内顺序已经由 MMR 决定，不要打乱它
  const head = items[0];
  const rest = items.slice(1);
  const groups = new Map<string, ScoredCandidate[]>();
  const order: string[] = [];
  rest.forEach((item, index) => {
    // 未知歌手（空键）用序号当独立分组键，避免把一堆无关的歌当成同一个歌手
    const key = item.style.singerKey === "" ? `\u0000${index}` : item.style.singerKey;
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
      order.push(key);
    }
    bucket.push(item);
  });

  const cursor = new Map<string, number>(order.map((key) => [key, 0]));
  const out: ScoredCandidate[] = [head];
  let lastKey = head.style.singerKey;
  while (out.length < items.length) {
    let pickKey = "";
    let pickRemaining = 0;
    for (const key of order) {
      const bucket = groups.get(key);
      if (!bucket) continue;
      const remaining = bucket.length - (cursor.get(key) ?? 0);
      if (remaining <= 0) continue;
      if (key === lastKey) continue;
      if (remaining > pickRemaining) {
        pickRemaining = remaining;
        pickKey = key;
      }
    }
    // 剩下的全是上一首那个歌手（最大组 > ceil(n/2)）：无解，按原序接上即可
    if (pickKey === "") break;
    const bucket = groups.get(pickKey);
    const at = cursor.get(pickKey) ?? 0;
    if (!bucket) break;
    out.push(bucket[at]);
    cursor.set(pickKey, at + 1);
    lastKey = pickKey;
  }
  // 兜底：理论上不会走到（除非最大组超过一半），接上没排进去的，保证不丢歌
  if (out.length < items.length) {
    const placed = new Set(out);
    for (const item of items) if (!placed.has(item)) out.push(item);
  }
  return out;
}

// ---------- 推荐理由 ----------

/**
 * 推荐理由：只陈述**能验证的事实**，不编故事。按优先级取第一个命中的。
 *
 * 优先级不是随便排的：越靠前的信号越硬（收藏 > 同专辑 > 常听歌手 > 只收藏过这个歌手 >
 * 新歌手+语种 > 语种 > 没听过），保证同一首歌不会因为「新歌手」这种相对弱的事实，把
 * 「你收藏过」这条更硬的理由挤掉。长度控制在 20 字内，界面一行放得下。
 *
 * 「常听歌手」与「只收藏过这个歌手」必须分开：画像的加权会把收藏歌手的权重算进去，
 * 但收藏 ≠ 听过，说成「你常听 X」就是编故事 —— 理由的价值在于每一条都查得回原始事实。
 */
export function reasonFor(
  candidate: ScoredCandidate,
  profile: StyleProfile,
  taste: DailyTaste,
): string {
  // 措辞目前与口味无关（理由只陈述事实），参数保留是为了三档口味共用同一调用形状；
  // 将来若想按口味换措辞，不必再改所有调用点。
  void taste;
  const hits = new Set<RankHit>(candidate.hits);
  const { track, style } = candidate;

  if (hits.has("saved")) return "你收藏里的歌";

  if (hits.has("same-album")) {
    const album = truncateChars(track.album.trim(), 12);
    return album ? `同专辑《${album}》` : "和你常听的专辑相近";
  }

  if (hits.has("familiar-singer")) {
    const singer = truncateChars(track.singer.trim(), 12);
    if (singer) return `你常听 ${singer}`;
  }

  // 歌手只在收藏/歌单里出现过：说「常听」就是编故事了（用户可能一次都没播过）
  if (hits.has("saved-singer")) return "和你的收藏口味相近";

  // 语种名取「画像主语种」，画像没下结论（und）时退回候选自己的语种
  const langName = MUSIC_LANG_LABEL[profile.mainLang !== "und" ? profile.mainLang : style.lang];

  if (hits.has("new-singer") && hits.has("main-lang")) {
    return `新歌手，和你的${langName}口味接近`;
  }

  if (hits.has("main-lang")) return `符合你常听的${langName}`;

  if (hits.has("unplayed")) return "你没听过，换个口味试试";

  return "换一批看看";
}