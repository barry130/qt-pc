/**
 * 每日推荐的「维度」层：把候选池从 6 条窄路扩成多维度。
 *
 * ## 为什么需要这一层
 * 用户反馈（2026-10-24）「风格太单一，只有一两个风格，推荐维度再多一点」，并强调
 * 「数据来源是历史和搜索出来的，AI 只在你给的结果里选，所以搜索维度和结果最重要」。
 * 也就是说瓶颈不在模型，而在**候选池的宽度**：候选池每多一条维度，模型就多一批可选的歌。
 *
 * ## 它做什么
 * 1. `planDimensionQueries`：把风格画像 / 歌单名 / 语种 / 搜索历史翻成一批**搜索词**；兜底
 *    广度词用 variant 做起点轮换，「换一批」和换天就会换出不同维度，否则天天推同一批。
 * 2. `collectDimensionLanes`：把榜单、关键词聚合搜索、风格歌单三条路跑一遍，产出若干
 *    「风格线」（一条线 = 一个维度命中的曲目）。任何一路挂掉都只损失那一维、绝不 throw ——
 *    推荐页不能因为一个榜单接口超时就空着。
 * 3. `interleaveByLanes` / `laneCoverage`：按风格线交织最终列表并统计覆盖面，保证前几首
 *    来自不同风格，而不是被一条线霸屏。
 *
 * ## 边界
 * 本模块只负责**候选池**：不打分、不排序、不叫模型（打分在 `recommend-rank.ts`，串流程在
 * `daily-recommend.ts`）。它只 import 叶子模块，**刻意不 import `daily-recommend`** ——
 * 那边会 import 本模块，反向依赖会成环。
 */

import type { Chart, Playlist, SourceId, Track } from "@/types";
import { hashString, normText, trackKey } from "@/lib/text";
import type { DailyTaste, MusicLang, StyleProfile } from "@/lib/recommend-types";
import type { AggregateSearchResult } from "@/source-scripts";
import {
  getChartDetail,
  getCharts,
  getPlaylistDetail,
  searchManyBatches,
  searchPlaylists,
} from "@/source-scripts";

/** 一条维度线的种类。前端「风格线」标签用它配色/文案，集成方按它分组展示 */
export type LaneKind =
  | "tag"
  | "lang"
  | "adjacent"
  | "genre"
  | "mood"
  | "scene"
  | "era"
  | "chart"
  | "search";

/** 一条维度查询：lane 是展示名，keyword 是真正丢给搜索的字符串 */
export interface LaneQuery {
  lane: string;
  keyword: string;
  kind: LaneKind;
}

// ---------- 词表 ----------
// 这些词不是拍脑袋写的：音源搜索接口**没有** genre/年代/语种元数据（见
// `recommend-types.ts` 顶部说明），风格只能靠「用风格词去搜」反推。所以词表本身就是
// 本模块的能力上限 —— 加一个词 = 多一条可搜的维度。词表外的最小补充（如 `抒情`）只
// 出现在相邻风格里，不直接进兜底池，避免兜底维度被冷门词稀释。

export const GENRE_WORDS: string[] = [
  "古风",
  "国风",
  "民谣",
  "摇滚",
  "电子",
  "说唱",
  "爵士",
  "蓝调",
  "R&B",
  "朋克",
  "金属",
  "后摇",
  "独立",
  "ACG",
  "二次元",
  "纯音乐",
  "轻音乐",
  "原声",
  "世界音乐",
  "民乐",
  "戏腔",
  "lo-fi",
  "citypop",
];

export const MOOD_WORDS: string[] = ["治愈", "热血", "伤感", "轻快", "安静", "温柔", "梦幻", "燃"];

export const SCENE_WORDS: string[] = [
  "助眠",
  "学习",
  "通勤",
  "运动",
  "咖啡厅",
  "雨天",
  "深夜",
  "驾车",
  "旅行",
];

export const ERA_WORDS: string[] = ["经典老歌", "怀旧", "80年代", "90年代", "千禧", "00年代"];

/**
 * 语种维度词。华语是默认口味，不作为维度词（否则每次都搜「华语」，等于没扩维），
 * 所以 zh 只放「粤语」这种**少数派**；`und` 放器乐向的词，这是纯音乐听众的主要入口。
 */
export const LANG_WORDS: Partial<Record<MusicLang, string[]>> = {
  zh: ["粤语"],
  ja: ["日语", "日系"],
  ko: ["韩语", "韩系"],
  en: ["欧美", "英文歌"],
  und: ["纯音乐", "器乐"],
};

/**
 * 相邻风格：从一个风格往「像但不同」的方向走一步。
 *
 * 为什么不用「同义」而用「相邻」：同义词搜回来的是同一批歌（纯浪费一次请求），
 * 相邻风格才真正扩池 —— 爱听古风的人大概率不排斥戏腔，但戏腔搜回来的歌不一样。
 */
export const ADJACENT_WORDS: Record<string, readonly string[]> = {
  古风: ["国风", "戏腔", "民乐"],
  国风: ["古风", "民乐"],
  民谣: ["独立", "原声"],
  摇滚: ["朋克", "金属", "后摇"],
  电子: ["lo-fi", "citypop", "纯音乐"],
  说唱: ["R&B", "电子"],
  爵士: ["蓝调", "原声"],
  纯音乐: ["轻音乐", "器乐", "lo-fi"],
  ACG: ["二次元", "日语"],
  轻音乐: ["纯音乐", "助眠"],
  独立: ["民谣", "后摇"],
  原声: ["轻音乐", "纯音乐"],
  "R&B": ["爵士", "citypop"],
  流行: ["citypop", "抒情"],
};

// ---------- 内部常量 ----------

const DEFAULT_MAX_QUERIES = 10;
const DEFAULT_PER_CHART = 60;
const DEFAULT_PER_KEYWORD = 24;
const DEFAULT_PER_PLAYLIST = 20;

/** 非主语种占比到 5% 才算「真实存在的一小撮口味」，1~4% 多是误判（一两首歌） */
const MIN_SECONDARY_LANG_SHARE = 0.05;
/** 搜索历史词长度上限：再长基本是整句粘贴，搜出来必是噪声 */
const MAX_SEARCH_WORD_LEN = 16;

const CHART_MAX = 5;
/** 名字里带风格词的榜优先，但最多 3 张：全是风格榜会挤掉「飙升/热歌」这类大盘榜 */
const CHART_STYLE_MAX = 3;
const CHART_FILL_MAX = 2;
const CHART_CONCURRENCY = 3;
const PLAYLIST_MAX_QUERIES = 2;
const PLAYLIST_PICK_SIZE = 4;

/** 内部线：没有命中任何维度的歌归到这里，只在交织的最后兜底 */
const OTHER_LANE = "__其他";

const LANG_WORD_LIST: string[] = (Object.keys(LANG_WORDS) as MusicLang[]).flatMap(
  (lang) => LANG_WORDS[lang] ?? [],
);

/**
 * chartLane 与「歌单名/榜单名里找词表词」共用的词表顺序。
 * 顺序即优先级：先流派、再情绪、再场景、再年代，最后语种 —— 名字里同时出现
 * 「华语」和「摇滚」时，流派比语种更能代表这张榜的内容。
 */
const NAME_VOCAB: string[] = [
  ...GENRE_WORDS,
  ...MOOD_WORDS,
  ...SCENE_WORDS,
  ...ERA_WORDS,
  ...LANG_WORD_LIST,
];

interface NormWord {
  word: string;
  key: string;
}

const NAME_VOCAB_NORM: NormWord[] = NAME_VOCAB.map((word) => ({ word, key: normText(word) }));

const ADJACENT_BY_KEY = new Map<string, readonly string[]>(
  Object.entries(ADJACENT_WORDS).map(([word, list]) => [normText(word), list]),
);

const BREADTH_POOL: { word: string; kind: LaneKind }[] = [
  ...toBreadthEntries(GENRE_WORDS, "genre"),
  ...toBreadthEntries(MOOD_WORDS, "mood"),
  ...toBreadthEntries(SCENE_WORDS, "scene"),
  ...toBreadthEntries(ERA_WORDS, "era"),
];

function toBreadthEntries(words: string[], kind: LaneKind): { word: string; kind: LaneKind }[] {
  return words.map((word) => ({ word, kind }));
}

// ---------- 小工具 ----------

/** 缺省/非法数值兜底；负数按 0 处理，避免 slice(0, -1) 之类的隐式反转 */
function countOr(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

/** 并发受限的 map（保持输入顺序）。只在本模块用，不做通用工具导出 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  const width = Math.min(Math.max(1, Math.trunc(limit) || 1), Math.max(1, items.length));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        out[index] = await fn(items[index], index);
      }
    }),
  );
  return out;
}

/**
 * 网络调用统一兜底。
 *
 * 为什么连同步 throw 也兜：数据包没装载时这些门面会在**调用表达式**上直接抛，
 * 用 `promise.catch()` 是兜不住的；而候选池少一维绝不该连坐整次生成。
 */
async function safeCall<T>(fn: () => Promise<T> | null | undefined, fallback: T): Promise<T> {
  try {
    const value = await fn();
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

/** 按 trackKey 去重（保留首次出现）再截断 —— 跨源聚合后同一首歌会重复出现 */
function dedupeTracks(tracks: readonly Track[], limit: number): Track[] {
  const out: Track[] = [];
  const seen = new Set<string>();
  for (const track of tracks) {
    if (out.length >= limit) break;
    const key = trackKey(track);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(track);
  }
  return out;
}

/** 词表里第一个「被 text 包含」的词（保留原始大小写写法，如 R&B） */
function findVocabWord(text: string): string | null {
  const key = normText(text);
  if (!key) return null;
  for (const entry of NAME_VOCAB_NORM) {
    if (entry.key && key.includes(entry.key)) return entry.word;
  }
  return null;
}

/** 相邻风格词：按归一化后的键查，容忍「R&B / r&b」这类写法差异 */
function adjacentWords(lane: string): readonly string[] {
  return ADJACENT_BY_KEY.get(normText(lane)) ?? [];
}

/**
 * 榜单名 → 风格线标签。
 *
 * 榜单名是「国风榜」「飙升榜」「QQ音乐·热歌榜」这种**带壳**的字符串：能命中词表就直接用
 * 词表词（「国风榜」→「国风」，这样榜单曲目能和关键词线合并到同一条风格线上）；
 * 命中不了就剥掉「榜」壳当标签（「飙升榜」→「飙升」），实在没有内容才叫「榜单」。
 */
export function chartLane(name: string): string {
  const raw = name.trim();
  const key = normText(raw);
  if (key) {
    for (const entry of NAME_VOCAB_NORM) {
      if (entry.key && key.includes(entry.key)) return entry.word;
    }
  }
  const stripped = raw
    .replace(/(?:排行榜|榜单|榜)$/u, "")
    // 中间的分隔点与两侧空白一起去掉，标签才像人能读的词
    .replace(/\s*[·・]\s*/gu, "·")
    .replace(/^[·・\s]+|[·・\s]+$/gu, "")
    .trim();
  return stripped || "榜单";
}

// ---------- 维度规划 ----------

export interface DimensionPlanInput {
  profile: StyleProfile;
  /** 用户自己的歌单名（用户亲手写的风格自述，比任何推断都直接） */
  playlistNames?: readonly string[];
  /** 搜索历史，**最近优先**（与 `search-history.ts` 的 mergeHistory 同序） */
  searchHistory?: readonly string[];
  taste?: DailyTaste;
  /** 「换一批」种子或日期（如 `${Date.now()}` / "2026-10-24"）；用来轮换兜底维度词 */
  variant?: string;
  /** 缺省 10：再多请求数（和等待时间）就压不住了 */
  maxQueries?: number;
}

/**
 * 把口味信号翻成一批搜索词，按「越靠前越贴合用户」排序。
 *
 * 顺序本身就是规则：自述风格（tags）→ 歌单名命中 → 少数派语种 → 相邻风格 → 兜底广度
 * → 搜索历史。搜索历史放最后，是因为它是**过去某次意图**，时效性最弱（用户昨天搜的
 * 可能是朋友发的歌名），只当补位维度用。
 */
export function planDimensionQueries(input: DimensionPlanInput): LaneQuery[] {
  const profile = input.profile;
  const playlistNames = input.playlistNames ?? [];
  const searchHistory = input.searchHistory ?? [];
  const variant = input.variant ?? "";
  const maxQueries = countOr(input.maxQueries, DEFAULT_MAX_QUERIES);

  const out: LaneQuery[] = [];
  const seen = new Set<string>();

  /** 返回值表示是否真的落了一条线（被去重掉的不占名额） */
  const push = (rawLane: string, kind: LaneKind): boolean => {
    const lane = rawLane.trim();
    const key = normText(lane);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    out.push({ lane, keyword: lane, kind });
    return true;
  };

  // 1) 画像里的自述风格词，优先级最高（「我就爱古风」比任何行为推断都硬）
  const tagWords = profile.tags.filter((tag) => normText(tag).length > 0).slice(0, 3);
  for (const tag of tagWords) push(tag, "tag");

  // 2) 歌单名命中词表：画像的 tags 只覆盖「被 STYLE_TAGS 认识的词」，这里按同一套词表
  //    再扫一遍原始歌单名，捞回画像没抽到的维度（画像 tags 空时尤其重要）
  let playlistHits = 0;
  for (const name of playlistNames) {
    if (playlistHits >= 2) break;
    const word = findVocabWord(name);
    if (!word) continue;
    if (push(word, "tag")) playlistHits += 1;
  }

  // 3) 非主语种：≥5% 才当维度（更小的份额常常是误判出来的一两首歌）
  const secondaryLangs = (Object.keys(profile.langs) as MusicLang[])
    .map((lang) => ({ lang, share: profile.langs[lang] ?? 0 }))
    .filter((entry) => entry.lang !== profile.mainLang && entry.share >= MIN_SECONDARY_LANG_SHARE)
    .sort((a, b) => b.share - a.share)
    .slice(0, 2);
  for (const entry of secondaryLangs) {
    const word = LANG_WORDS[entry.lang]?.[0];
    if (word) push(word, "lang");
  }

  // 4) 相邻风格：每个自述风格走一步，保证「像但不同」的维度进来
  const tagLanes = out.filter((query) => query.kind === "tag").slice(0, 2);
  for (const lane of tagLanes) {
    for (const word of adjacentWords(lane.lane)) {
      if (push(word, "adjacent")) break;
    }
  }

  // 5) 兜底广度词：tags 为空说明画像不可信，取 4 个；explore 模式多给一个维度。
  //    起点由 variant 哈希轮换 —— 否则「换一批」只会换歌、不会换风格。
  const breadthWant = tagWords.length === 0 || input.taste === "explore" ? 4 : 3;
  if (BREADTH_POOL.length > 0) {
    const start = hashString(variant) % BREADTH_POOL.length;
    let added = 0;
    for (let i = 0; i < BREADTH_POOL.length && added < breadthWant; i += 1) {
      const entry = BREADTH_POOL[(start + i) % BREADTH_POOL.length];
      if (push(entry.word, entry.kind)) added += 1;
    }
  }

  // 6) 搜索历史：最近的词最可能代表当下意图；超长词/重复词直接丢
  let searchAdded = 0;
  for (const raw of searchHistory) {
    if (searchAdded >= 3) break;
    const word = raw.trim();
    if (word.length < 1 || Array.from(word).length > MAX_SEARCH_WORD_LEN) continue;
    if (push(word, "search")) searchAdded += 1;
  }

  // 7) 去重已在 push 里做完，这里只截断
  return out.slice(0, maxQueries);
}

// ---------- 维度采集中 ----------

export interface DimensionCollectInput extends DimensionPlanInput {
  source: SourceId;
  /** 聚合音源（用户勾选的）；undefined/null = 全部 */
  sources?: readonly string[];
  perChart?: number;
  perKeyword?: number;
  perPlaylist?: number;
  onProgress?: () => void;
}

export interface DimensionLane {
  label: string;
  kind: LaneKind;
  tracks: Track[];
}

export interface DimensionLanes {
  /** 按优先级排序：榜单线在前，其后按查询顺序 */
  lanes: DimensionLane[];
  /** trackKey → 这条曲目来自哪些线（去重、按线顺序） */
  laneOf: Map<string, string[]>;
}

interface LaneSlot {
  label: string;
  kind: LaneKind;
  order: number;
  seq: number;
  tracks: Track[];
}

/** 榜单候选：先滤节目榜/无 id，再按名字去重，最后按「名字是否带风格词」分优先/补位 */
function pickCharts(charts: readonly Chart[], styleKeys: ReadonlySet<string>): Chart[] {
  const unique: Chart[] = [];
  const seenNames = new Set<string>();
  for (const chart of charts) {
    if (chart.contentType === "programs") continue;
    if (!chart.id) continue;
    const nameKey = normText(chart.name);
    if (seenNames.has(nameKey)) continue;
    seenNames.add(nameKey);
    unique.push(chart);
  }

  const priority: Chart[] = [];
  const rest: Chart[] = [];
  for (const chart of unique) {
    const key = normText(chart.name);
    let matched = false;
    if (key) {
      for (const word of styleKeys) {
        if (word && key.includes(word)) {
          matched = true;
          break;
        }
      }
    }
    if (matched && priority.length < CHART_STYLE_MAX) priority.push(chart);
    else rest.push(chart);
  }
  return [...priority, ...rest.slice(0, CHART_FILL_MAX)].slice(0, CHART_MAX);
}

/**
 * 跑完三条采集路，产出风格线。
 *
 * 路的顺序是刻意的：榜单先（质量最稳、最像「热门」）、关键词其次（覆盖面最广）、
 * 风格歌单最后（能拿到整张歌单，但请求最重，只给前两条风格查询）。
 * 每一路都独立兜底：榜单接口挂了关键词照跑，反之亦然 —— 生成失败比推荐窄更糟。
 */
export async function collectDimensionLanes(input: DimensionCollectInput): Promise<DimensionLanes> {
  const queries = planDimensionQueries(input);
  input.onProgress?.();

  const perChart = countOr(input.perChart, DEFAULT_PER_CHART);
  const perKeyword = countOr(input.perKeyword, DEFAULT_PER_KEYWORD);
  const perPlaylist = countOr(input.perPlaylist, DEFAULT_PER_PLAYLIST);

  const slots = new Map<string, LaneSlot>();
  let seq = 0;

  /**
   * 追加一条线的曲目。同 label 视为同一条线（榜单「国风榜」与关键词「国风」拼成一条），
   * 合并时保持首次出现的 order，这样「榜单线在前、关键词线按查询顺序」不会被打破。
   */
  const append = (label: string, kind: LaneKind, tracks: readonly Track[], order: number): void => {
    const key = normText(label);
    if (!key) return;
    let slot = slots.get(key);
    if (!slot) {
      if (tracks.length === 0) return;
      slot = { label, kind, order, seq, tracks: [] };
      seq += 1;
      slots.set(key, slot);
    }
    const have = new Set(slot.tracks.map((track) => trackKey(track)));
    for (const track of tracks) {
      const key2 = trackKey(track);
      if (have.has(key2)) continue;
      have.add(key2);
      slot.tracks.push(track);
    }
  };

  const queryOrder = (query: LaneQuery): number => 100 + queries.indexOf(query);

  /** 一路采集的产物：先收集、后按固定顺序 append，保证合并顺序与串行时完全一致 */
  interface LaneRows {
    label: string;
    kind: LaneKind;
    tracks: readonly Track[];
    order: number;
  }

  // ---- 1) 榜单路：质量最稳的一路，优先跑（哪怕后面全挂，也有它兜着） ----
  const collectCharts = async (): Promise<LaneRows[]> => {
    const rows: LaneRows[] = [];
    try {
      const charts = await safeCall(() => getCharts(input.source), [] as Chart[]);
      const styleKeys = new Set<string>();
      for (const query of queries) {
        if (query.kind === "tag" || query.kind === "lang") styleKeys.add(normText(query.lane));
      }
      // 流派/情绪是内容维度，任何一张榜名命中都说明这张榜风格集中，值得优先
      for (const word of [...GENRE_WORDS, ...MOOD_WORDS, ...LANG_WORD_LIST]) {
        styleKeys.add(normText(word));
      }
      const picked = pickCharts(charts, styleKeys);
      const tracksOf = await mapLimit(picked, CHART_CONCURRENCY, async (chart) => {
        const tracks = await safeCall(() => getChartDetail(chart), [] as Track[]);
        return dedupeTracks(tracks, perChart);
      });
      for (let i = 0; i < tracksOf.length; i += 1) {
        rows.push({ label: chartLane(picked[i].name), kind: "chart", tracks: tracksOf[i], order: i });
      }
    } catch {
      // 榜单这一路整体不可用：候选池还有关键词与歌单两路
    }
    return rows;
  };

  // ---- 2) 关键词路：所有维度词一次性交给聚合搜索（跨源打平 + 并发） ----
  const collectKeywords = async (): Promise<LaneRows[]> => {
    const rows: LaneRows[] = [];
    try {
      const keywordQueries = queries.filter((query) => query.kind !== "chart");
      const keywords = keywordQueries
        .map((query) => query.keyword)
        .filter((word) => word.trim() !== "");
      if (keywords.length > 0) {
        const result = await safeCall<AggregateSearchResult | null>(
          () =>
            searchManyBatches(keywords, 1, perKeyword, {
              concurrency: 3,
              sources: input.sources,
            }),
          null,
        );
        if (result) {
          const byKeyword = new Map<string, LaneQuery>();
          for (const query of keywordQueries) {
            const key = normText(query.keyword);
            if (key && !byKeyword.has(key)) byKeyword.set(key, query);
          }
          for (const group of result.groups) {
            if (!group.ok) continue;
            const tracks = dedupeTracks(
              group.batches.flatMap((batch) => batch.tracks),
              perKeyword,
            );
            if (tracks.length === 0) continue;
            const query = byKeyword.get(normText(group.keyword));
            if (!query) continue;
            rows.push({
              label: query.lane,
              kind: query.kind,
              tracks,
              order: queryOrder(query),
            });
          }
        }
      }
    } catch {
      // 聚合搜索失败只损失关键词这一路
    }
    return rows;
  };

  // ---- 3) 风格歌单路：整张歌单能一次带来几十首，但请求重，只给前两条风格查询 ----
  const collectPlaylists = async (): Promise<LaneRows[]> => {
    const rows: LaneRows[] = [];
    try {
      const styleQueries = queries
        .filter(
          (query) => query.kind === "tag" || query.kind === "genre" || query.kind === "adjacent",
        )
        .slice(0, PLAYLIST_MAX_QUERIES);
      for (const query of styleQueries) {
        const playlists = await safeCall(
          () => searchPlaylists(input.source, query.keyword, 1, PLAYLIST_PICK_SIZE),
          [] as Playlist[],
        );
        const playlist = playlists[0];
        if (!playlist || !playlist.id) continue;
        const detail = await safeCall(
          () => getPlaylistDetail(input.source, playlist.id),
          null as Playlist | null,
        );
        const tracks = dedupeTracks(detail?.tracks ?? [], perPlaylist);
        if (tracks.length === 0) continue;
        rows.push({ label: query.lane, kind: query.kind, tracks, order: queryOrder(query) });
      }
    } catch {
      // 歌单这一路失败不影响其它维度
    }
    return rows;
  };

  // 三路互不依赖，并行跑（原先是串行 await，生成延迟≈三路之和）。
  // append 仍按「榜单 → 关键词 → 歌单」的固定顺序执行，seq 分配因此与串行一致，
  // 合并后的线顺序（order 相同者按 seq）不会因并发而漂移。
  const tick = (): void => input.onProgress?.();
  const [chartRows, keywordRows, playlistRows] = await Promise.all([
    collectCharts().then((rows) => (tick(), rows)),
    collectKeywords().then((rows) => (tick(), rows)),
    collectPlaylists().then((rows) => (tick(), rows)),
  ]);
  for (const row of chartRows) append(row.label, row.kind, row.tracks, row.order);
  for (const row of keywordRows) append(row.label, row.kind, row.tracks, row.order);
  for (const row of playlistRows) append(row.label, row.kind, row.tracks, row.order);

  const lanes: DimensionLane[] = [...slots.values()]
    .sort((a, b) => (a.order !== b.order ? a.order - b.order : a.seq - b.seq))
    .map((slot) => ({ label: slot.label, kind: slot.kind, tracks: slot.tracks }));

  // laneOf 按最终线顺序遍历：同一首歌跨线时，数组顺序 = 线优先级（第一条即主线）
  const laneOf = new Map<string, string[]>();
  for (const lane of lanes) {
    for (const track of lane.tracks) {
      const key = trackKey(track);
      const labels = laneOf.get(key);
      if (!labels) laneOf.set(key, [lane.label]);
      else if (!labels.includes(lane.label)) labels.push(lane.label);
    }
  }

  return { lanes, laneOf };
}

// ---------- 交织与覆盖统计 ----------

/**
 * 按风格线交织（平滑加权轮询 SWRR）。
 *
 * 为什么不用「轮流取第一条线」的朴素轮询：每条线的体量差一个数量级（榜单 60 首、歌单
 * 20 首），朴素轮询会在小线耗尽后立刻退化成大盘榜的顺序，前几首仍然会霸屏。SWRR 用
 * 权重 4/2/2/1 让前三条线在前几轮轮流坐庄，之后按权重自然回落到常规密度。
 * 没有 lane 的歌归 `__其他`，权重 0 —— 只在最后兜底，绝不抢占前几首。
 */
export function interleaveByLanes(
  items: Track[],
  laneOf: Map<string, string[]>,
  target: number,
): Track[] {
  if (target <= 0 || items.length === 0) return [];
  if (laneOf.size === 0) return items.slice(0, target);

  const groups = new Map<string, Track[]>();
  const lineOrder: string[] = [];
  const seenKeys = new Set<string>();
  for (const item of items) {
    const key = trackKey(item);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const line = laneOf.get(key)?.[0] ?? OTHER_LANE;
    let group = groups.get(line);
    if (!group) {
      group = [];
      groups.set(line, group);
      lineOrder.push(line);
    }
    group.push(item);
  }

  const weighted = lineOrder.filter((line) => line !== OTHER_LANE);
  const weightOf = (line: string): number => {
    const index = weighted.indexOf(line);
    if (index === 0) return 4;
    if (index === 1 || index === 2) return 2;
    return 1;
  };

  const current = new Map<string, number>();
  const cursor = new Map<string, number>();
  for (const line of weighted) {
    current.set(line, 0);
    cursor.set(line, 0);
  }

  const picked: Track[] = [];
  const pickedKeys = new Set<string>();
  while (picked.length < target) {
    const active = weighted.filter(
      (line) => (cursor.get(line) ?? 0) < (groups.get(line)?.length ?? 0),
    );
    if (active.length === 0) break;
    for (const line of active) current.set(line, (current.get(line) ?? 0) + weightOf(line));
    let best = active[0];
    let bestValue = current.get(best) ?? 0;
    for (const line of active) {
      const value = current.get(line) ?? 0;
      // 严格大于 + active 保持线顺序 = 同分取先出现的线
      if (value > bestValue) {
        best = line;
        bestValue = value;
      }
    }
    const total = active.reduce((sum, line) => sum + weightOf(line), 0);
    current.set(best, bestValue - total);
    const index = cursor.get(best) ?? 0;
    cursor.set(best, index + 1);
    const track = (groups.get(best) ?? [])[index];
    if (!track) continue;
    picked.push(track);
    pickedKeys.add(trackKey(track));
  }

  // 兜底补位：`__其他` 与任何漏网的曲目按原顺序补，凑不满 target 就返回已取的
  for (const item of items) {
    if (picked.length >= target) break;
    const key = trackKey(item);
    if (pickedKeys.has(key)) continue;
    pickedKeys.add(key);
    picked.push(item);
  }
  return picked.slice(0, target);
}

/**
 * 结果里的风格线统计：给界面展示「这次推荐覆盖了哪几条线」。
 *
 * 只统计主线（`laneOf[0]`）：一首歌跨两线时，主线才是它被选进来的理由。
 * `__` 开头是内部线（如 `__其他`），不是给用户看的风格，跳过。
 */
export function laneCoverage(
  items: Track[],
  laneOf: Map<string, string[]>,
  max = 5,
): { label: string; count: number }[] {
  const limit = countOr(max, 5);
  if (limit === 0) return [];
  const counts = new Map<string, number>();
  for (const item of items) {
    const label = laneOf.get(trackKey(item))?.[0];
    if (!label || label.startsWith("__")) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}
