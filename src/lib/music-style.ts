/**
 * 口味画像：把「播放记录 + 收藏 + 歌单」提炼成「你喜欢什么风格」。
 *
 * ## 为什么需要它
 * 旧的每日推荐只按「你听过哪些歌手」出歌，于是推荐被歌手锁死：听三个歌手，
 * 推荐就永远是这三个歌手的冷门曲。用户 2026-10-23 的反馈是「要根据歌曲风格等
 * 各方面综合推荐」。但音源契约（`qt-contract` 的 `MusicInfo`）里**没有**
 * genre / 年代 / 语种 —— 风格只能由本地算得出来的信号推导：
 *
 * 1. **文字种类**（华语/日语/韩语/欧美）：标题+歌手+专辑的字符集统计，零成本；
 * 2. **时长带**：4 分钟的歌和 8 分钟的后摇是两种口味，弱特征但免费；
 * 3. **歌手/专辑亲和**：**按真实收听行为加权**，而不是按出现次数 —— 这是相对旧版
 *    最大的信息增量（旧版「听 20 秒切掉」和「一遍遍听完」得分一样）；
 * 4. **歌单风格词**：歌单名是用户亲手写的风格自述（「粤语」「摇滚」「纯音乐」），
 *    比任何推断都直接，所以单独抽成 `tags`。
 *
 * ## 为什么必须是纯函数
 * 画像被 UI（标签展示）和提示词（给模型的口味描述）共用，还要进缓存。
 * 一旦它摸 IPC / store，测试就得 mock 整个 Tauri 环境，且同一天两次生成会得到
 * 不同的画像（缓存失效）。所以这里只接收「已经取到的样本」，`now` 也由调用方注入。
 *
 * 类型全部来自 `@/lib/recommend-types`：那里是推荐链路唯一的契约，
 * 在这里重写一份 `StyleProfile` 会与 `recommend-rank.ts` 的结构不相等，
 * 集成时直接编译失败。
 */

import { DURATION_BAND_LABEL, MUSIC_LANG_LABEL } from "@/lib/recommend-types";
import type {
  DurationBand,
  MusicLang,
  StyleProfile,
  StyleProfileInput,
  StyleSample,
  TrackQuality,
  TrackStat,
  TrackStyle,
} from "@/lib/recommend-types";
import { normText } from "@/lib/text";
import { clamp01 } from "@/lib/utils";
import type { Track } from "@/types";

/**
 * 主语种的最低占比。低于它就不下结论（`mainLang = "und"`）。
 *
 * 0.34 的口径：两种语种各半（0.5/0.5）时「用一种当主」仍然是有效的近似 ——
 * 排除掉另一种会把一半的收听当噪音；但口语种一多（五五分之后的 1/3、1/5），
 * 最高的那个只是"矮子里的将军"，拿它当主语种会让打分系统的语种加成打偏。
 * 0.34 刚好卡在「两强相争（≥0.5 通过）」和「三足鼎立（≤0.33 不通过）」之间。
 */
export const MIN_MAIN_SHARE = 0.34;

/** 30 天：最近性线性衰减的窗口 */
const RECENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** 只有收藏、没有播放统计时的权重 —— 用户亲手收的比"没听过"硬，但比真听过的弱 */
const SAVED_ONLY_WEIGHT = 0.5;

// ---------- 文字种类 ----------

interface CharCounts {
  kana: number;
  hangul: number;
  han: number;
  latin: number;
}

/** 逐码点统计四类文字（用码点而不是 UTF-16 单元，避免把代理对算成两个字符） */
function countScripts(text: string): CharCounts {
  const counts: CharCounts = { kana: 0, hangul: 0, han: 0, latin: 0 };
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp >= 0x3040 && cp <= 0x309f) || (cp >= 0x30a0 && cp <= 0x30ff)) {
      // ひらがな / カタカナ
      counts.kana += 1;
    } else if ((cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff)) {
      // 谚文音节 / 谚文字母
      counts.hangul += 1;
    } else if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) {
      // 康熙部首区 + 扩展 A（生僻字、人名用字常落在这里）
      counts.han += 1;
    } else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) {
      counts.latin += 1;
    }
  }
  return counts;
}

/**
 * 去掉括号内容（半角/全角圆括号、方括号、书名号）。
 *
 * 中文歌极常见「中文名（英文别名）」的写法（`周杰伦（Jay Chou）`、
 * `起风了（The Wind Rises）`、`晴天（Live）`）。括号里是**副标题/版本注记**，
 * 不是正文：让它们参与「汉字 vs 拉丁」的对比，会把中文歌成片判成英文。
 */
function stripBrackets(raw: string): string {
  return raw.replace(/(?:（[^）]*）|\([^)]*\)|【[^】]*】|\[[^\]]*\])/g, "");
}

/**
 * 判断一段文字（歌名+歌手+专辑拼起来）的语种。
 *
 * 优先级不可调换：
 * 1. **假名 → ja**。日文歌大量使用汉字，只看汉字会把日语歌全部判成华语；
 *    反过来，只要出现假名就一定是日语（华语歌不用假名）。
 * 2. **谚文 → ko**。韩文歌同样会夹汉字，但谚文是决定性的。
 * 3. **汉字 → zh**，条件是 `汉字×2 ≥ 拉丁`（去括号后比）。
 *    阈值取 1:2 而不是 1:1：中文歌带英文副标题/英文歌手名时拉丁字母会明显多于汉字
 *    （`晴天 周杰伦 (Jay Chou)` 汉字 3、拉丁 7），按 1:1 会判成英文；
 *    取 1:2 后「汉字只要不是零头（不到拉丁的一半）就算华语」。
 *    纯英文标题汉字为 0，直接落到下一条，不会误判。
 * 4. **拉丁 → en**。注意这里用**未去括号**的计数：`晴天（Live）` 已经在上一条
 *    判成华语了，走到这里的样本里拉丁才是主体。
 * 5. 其它 → **und**。纯器乐标题（`✦ ✦ ✦`）、俄语/法语等拉丁以外文字、纯数字、
 *    空串都落在这里 —— `und` 不是一种语种，是"判不出来"。
 */
export function detectLanguage(text: string): MusicLang {
  const whole = countScripts(text);
  if (whole.kana > 0) return "ja";
  if (whole.hangul > 0) return "ko";
  const bare = countScripts(stripBrackets(text));
  if (bare.han > 0 && bare.han * 2 >= bare.latin) return "zh";
  if (whole.latin > 0) return "en";
  return "und";
}

/**
 * 时长带。
 *
 * 未知时长（`<= 0`）给 `"normal"` 而不是 `"short"`：`Track.duration` 缺失时
 * 若落到 short，画像会把用户描述成"爱听短歌"，进而给所有及格线的歌加分 ——
 * 未知必须是中性的，不能变成一种偏好。
 */
export function durationBand(seconds: number): DurationBand {
  if (!Number.isFinite(seconds) || seconds <= 0) return "normal";
  if (seconds < 150) return "short";
  if (seconds < 240) return "normal";
  if (seconds < 330) return "long";
  return "epic";
}

// ---------- 曲目风格坐标 ----------

// 归一化文本（去空白/括号内容/标点/小写）与 clamp01 都是全仓共享实现：
// `src/lib/text.ts` / `src/lib/utils.ts`（这里曾经各有一份私有副本）。

/**
 * 「等于没有专辑」的专辑名。音源缺元数据时会给 `""` / `"未知专辑"` / `"Unknown"`，
 * 这些不是一张真的专辑，不能参与专辑亲和（否则所有缺元数据的歌会互相「同专辑」加分）。
 */
const UNKNOWN_ALBUMS = new Set(["", "未知专辑", "未知", "unknown", "noalbum", "unknownalbum"]);

/** 单曲的风格坐标：歌手键 / 专辑键 / 语种 / 时长带 */
export function trackStyle(track: Track): TrackStyle {
  const singerKey = normText(track.singer);
  const albumKey = normText(track.album);
  const albumKnown = !UNKNOWN_ALBUMS.has(albumKey);
  return {
    singerKey,
    // 带上歌手：一堆「精选」「Greatest Hits」同名不同人，只按专辑名会算成同一张
    albumKey: albumKnown ? `${singerKey}|${albumKey}` : "",
    lang: detectLanguage(`${track.title} ${track.singer} ${track.album}`),
    band: durationBand(track.duration),
  };
}

// ---------- 行为质量 ----------

/**
 * 一首歌的「行为质量」。
 *
 * `completion`（完播比）是旧版没有、也是最有用的一个：`totalPlayedMs / playCount`
 * 把「反复点开听 20 秒就切」和「一遍遍听完」分开。两种未知都给 0.5：
 * 没统计过 / 曲长缺失时既不冤枉也不奖赏，否则新歌或本地曲目会被系统性压分。
 *
 * `skipped` **只看行为，不看 saved**：收藏是调用方的事（收藏了但听得少，
 * 通常是"想听还没听"，不是讨厌）。本函数只回答"这个行为像不像在跳歌"。
 */
export function trackQuality(
  stat: TrackStat,
  durationSeconds: number,
  maxPlayCount: number,
  now = Date.now(),
): TrackQuality {
  const playCount = Number.isFinite(stat.playCount) ? Math.max(0, stat.playCount) : 0;
  const durationKnown = Number.isFinite(durationSeconds) && durationSeconds > 0;

  const completion =
    playCount > 0 && durationKnown
      ? clamp01(stat.totalPlayedMs / (playCount * durationSeconds * 1000))
      : 0.5;

  const replay = maxPlayCount > 0 ? clamp01(playCount / maxPlayCount) : 0;

  // lastPlayedAt <= 0 = 没听过：最近性给 0（而不是 1），免得没听过的歌靠 recency 冒头
  const recency =
    stat.lastPlayedAt > 0 ? 1 - clamp01((now - stat.lastPlayedAt) / RECENCY_WINDOW_MS) : 0;

  const affinity = 0.5 * completion + 0.3 * replay + 0.2 * recency;

  // 反复点开（≥3 次）但每次听不到四成 = 其实不喜欢
  const skipped = playCount >= 3 && completion < 0.4;

  return { completion, replay, recency, affinity, skipped };
}

// ---------- 风格词表 ----------

/**
 * 歌单名里的风格词 → 规范标签。
 *
 * 口径说明（为什么是这张表）：
 * - 只收**语种**与**大曲风**，不收「心情」「场景」（`通勤`、`睡前`）：
 *   它们对选歌没有区分度，却会挤掉真正有用的 tag；
 * - 同一概念的俗称并成一档（`说唱/嘻哈/rap` → `说唱`），否则同一个口味会被拆成
 *   三个各 1 次的 tag，排序全乱；
 * - **不收复合词**（`民谣摇滚`、`流行摇滚`）：拆成「民谣 + 摇滚」两个 tag 才能与
 *   其它歌单的「民谣」「摇滚」合流计票；单独收一条会让这个词项一次贡献 3 票。
 */
const STYLE_TAGS: { tag: string; aliases: string[] }[] = [
  { tag: "华语", aliases: ["华语", "国语", "中文"] },
  { tag: "粤语", aliases: ["粤语"] },
  { tag: "日语", aliases: ["日语", "日系", "二次元"] },
  { tag: "韩语", aliases: ["韩语", "韩系"] },
  { tag: "欧美", aliases: ["欧美", "英文"] },
  { tag: "流行", aliases: ["流行"] },
  { tag: "摇滚", aliases: ["摇滚"] },
  { tag: "民谣", aliases: ["民谣"] },
  { tag: "说唱", aliases: ["说唱", "嘻哈", "rap"] },
  { tag: "电子", aliases: ["电子", "电音"] },
  { tag: "古风", aliases: ["古风", "国风"] },
  { tag: "器乐", aliases: ["纯音乐", "器乐", "轻音乐"] },
  { tag: "爵士", aliases: ["爵士"] },
  { tag: "古典", aliases: ["古典"] },
  { tag: "怀旧", aliases: ["怀旧", "经典", "老歌"] },
  { tag: "治愈", aliases: ["治愈", "安静"] },
  { tag: "伤感", aliases: ["伤感"] },
  { tag: "燃", aliases: ["燃", "热血"] },
  { tag: "影视原声", aliases: ["影视", "ost", "原声"] },
  { tag: "儿歌", aliases: ["儿歌"] },
  { tag: "舞曲", aliases: ["dj", "舞曲"] },
  { tag: "乡村", aliases: ["乡村"] },
  { tag: "金属", aliases: ["金属"] },
];

/**
 * 从歌单名抽风格词。
 *
 * 子串匹配 + 大小写不敏感（`OST` / `ost` 都算）；**每个歌单名最多给同一个词一票**，
 * 这样「摇滚合集（摇滚）」不会因为自己名字里出现两次就压过三个歌单各提一次的「民谣」。
 * 排序：次数降序，同次数的按首次出现顺序，保证同输入必然同输出（画像要缓存）。
 */
function extractTags(names: string[] | undefined): string[] {
  const counts = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let order = 0;
  for (const name of names ?? []) {
    const lower = name.toLowerCase();
    if (!lower) continue;
    // Set 天然去重：同一个歌单名里多个别名命中同一 tag 也只算一次
    const hit = new Set<string>();
    for (const entry of STYLE_TAGS) {
      if (entry.aliases.some((alias) => lower.includes(alias))) hit.add(entry.tag);
    }
    for (const tag of hit) {
      if (!firstSeen.has(tag)) firstSeen.set(tag, order);
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
      order += 1;
    }
  }
  return [...counts.keys()].sort((a, b) => {
    const diff = (counts.get(b) ?? 0) - (counts.get(a) ?? 0);
    if (diff !== 0) return diff;
    return (firstSeen.get(a) ?? 0) - (firstSeen.get(b) ?? 0);
  });
}

// ---------- 画像 ----------

/** 样本权重：有统计看行为综合分；只有收藏给 0.5；两者都没有的直接丢弃 */
function sampleWeight(sample: StyleSample, maxPlayCount: number, now: number): number {
  if (sample.stat) return trackQuality(sample.stat, sample.track.duration, maxPlayCount, now).affinity;
  return sample.saved ? SAVED_ONLY_WEIGHT : 0;
}

function sumValues(record: Partial<Record<string, number>>): number {
  let total = 0;
  for (const value of Object.values(record)) total += value ?? 0;
  return total;
}

/** 最大值（不用 `Math.max(...values)`：歌手多的用户会把展开参数撑到爆栈） */
function maxValue(record: Record<string, number>): number {
  let max = 0;
  for (const value of Object.values(record)) {
    if (value > max) max = value;
  }
  return max;
}

/**
 * 构造口味画像。
 *
 * 归一化口径（两个不一样，别统一）：
 * - `langs` / `bands` 归一到 **Σ=1**：它们是"占比"，要能说"60% 是华语"。
 * - `singers` / `albums` 归一到 **最大值=1**：打分要的是"相对最强者的比例"。
 *   若按 Σ=1 归一，只听过一个歌手的用户，他所有歌的亲和都变成 0.x 的小数，
 *   加分弱到看不出来 —— 归一化反而把"铁杆偏好"抹平了。
 */
export function buildStyleProfile(input: StyleProfileInput): StyleProfile {
  const now = input.now ?? Date.now();
  const maxPlayCount = input.samples.reduce(
    (max, sample) => Math.max(max, sample.stat?.playCount ?? 0),
    0,
  );

  const langs: Partial<Record<MusicLang, number>> = {};
  const bands: Partial<Record<DurationBand, number>> = {};
  const singers: Record<string, number> = {};
  const albums: Record<string, number> = {};

  const seen = new Set<string>();
  let sampleSize = 0;

  for (const sample of input.samples) {
    // 同一首歌可能同时出现在播放记录和收藏里：按 trackKey 去重，只算一次
    const key = `${sample.track.platform}:${sample.track.id}`;
    if (seen.has(key)) continue;
    const weight = sampleWeight(sample, maxPlayCount, now);
    // 既没听过又没收藏的歌不代表口味 —— 权重 0 会把画像稀释成"什么都听一点"
    if (weight <= 0) continue;
    seen.add(key);
    sampleSize += 1;

    const style = trackStyle(sample.track);
    langs[style.lang] = (langs[style.lang] ?? 0) + weight;
    bands[style.band] = (bands[style.band] ?? 0) + weight;
    // 空歌手键（缺元数据）会聚成一个假歌手，把「常听 N 位歌手」撑大，丢掉
    if (style.singerKey) singers[style.singerKey] = (singers[style.singerKey] ?? 0) + weight;
    if (style.albumKey) albums[style.albumKey] = (albums[style.albumKey] ?? 0) + weight;
  }

  const langsTotal = sumValues(langs);
  if (langsTotal > 0) {
    for (const lang of Object.keys(langs) as MusicLang[]) langs[lang] = (langs[lang] ?? 0) / langsTotal;
  }

  const bandsTotal = sumValues(bands);
  if (bandsTotal > 0) {
    for (const band of Object.keys(bands) as DurationBand[]) {
      bands[band] = (bands[band] ?? 0) / bandsTotal;
    }
  }

  const maxSinger = maxValue(singers);
  if (maxSinger > 0) {
    for (const singerKey of Object.keys(singers)) singers[singerKey] /= maxSinger;
  }

  const maxAlbum = maxValue(albums);
  if (maxAlbum > 0) {
    for (const albumKey of Object.keys(albums)) albums[albumKey] /= maxAlbum;
  }

  // 主语种：`und` 不参与竞争（它不是语种）。同权重时按 zh/ja/ko/en 的顺序取 ——
  // 两强相争（各 0.5）时华语优先，与产品默认受众一致。
  let mainLang: MusicLang = "und";
  let bestShare = 0;
  for (const lang of ["zh", "ja", "ko", "en"] as const) {
    const share = langs[lang] ?? 0;
    if (share > bestShare) {
      bestShare = share;
      mainLang = lang;
    }
  }
  if (bestShare < MIN_MAIN_SHARE) mainLang = "und";

  let mainBand: DurationBand = "normal";
  let bestBand = 0;
  for (const band of ["short", "normal", "long", "epic"] as const) {
    const share = bands[band] ?? 0;
    if (share > bestBand) {
      bestBand = share;
      mainBand = band;
    }
  }

  return {
    langs,
    bands,
    mainLang,
    mainBand,
    singers,
    albums,
    tags: extractTags(input.playlistNames),
    sampleSize,
  };
}

/**
 * 一行中文描述，给 UI 和模型提示词共用。
 *
 * 不列数字权重（`0.42` 对用户没意义，对模型也是噪音），只说结论：
 * `华语 · 三四分钟 · 常听 12 位歌手`。画像空的时候必须**明说不知道**，
 * 而不是编一个默认口味 —— 那会让全新用户拿到一套"别人的推荐"。
 */
export function describeProfile(profile: StyleProfile): string {
  if (profile.sampleSize <= 0) {
    // 冷启动里选了风格、但还没听过的用户：画像没有任何收听样本，可那几个风格是他
    // **亲手点的**，说"口味还不明显"等于无视他的选择 —— 直接把他选的念回去。
    if (profile.tags.length > 0) return `你选的风格：${profile.tags.slice(0, 2).join(" · ")}`;
    return "口味还不明显";
  }
  const parts: string[] = [];
  // `und` 是"判不出来"，说出来只会让用户困惑，直接省略语种段
  if (profile.mainLang !== "und") parts.push(MUSIC_LANG_LABEL[profile.mainLang]);
  parts.push(DURATION_BAND_LABEL[profile.mainBand]);
  const singerCount = Object.keys(profile.singers).length;
  if (singerCount > 0) parts.push(`常听 ${singerCount} 位歌手`);
  // 最多带一个 tag：画像描述是提示词的一部分，堆一串标签只会把 token 花在重复信息上。
  // 与主语种同名（"华语"）的 tag 跳过 —— 前面已经说过「华语」，再说一次「常听华语」
  // 是纯重复，用户看到的应该是「常听民谣」这种新增信息。
  const mainLangLabel = profile.mainLang === "und" ? "" : MUSIC_LANG_LABEL[profile.mainLang];
  const tag = profile.tags.find((candidate) => candidate !== mainLangLabel);
  if (tag) parts.push(`常听${tag}`);
  return parts.join(" · ");
}

/**
 * 把 `tags` 摊成带权重的列表，供打分复用。
 *
 * 权重 = `(n - index) / n`：第一位（出现次数最多的风格）为 1，最后一位最小。
 * 这是把"排序"翻译成"分数"的最省事口径 —— 不需要再维护一套独立的频次表。
 */
export function profileTagWeights(profile: StyleProfile): { tag: string; weight: number }[] {
  const total = profile.tags.length;
  if (total === 0) return [];
  return profile.tags.map((tag, index) => ({ tag, weight: (total - index) / total }));
}