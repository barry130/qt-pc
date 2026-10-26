/**
 * 每日推荐：根据播放历史生成当天的一批歌。
 *
 * ## 为什么不在服务端做
 * 推荐要读的东西全在本机：`play_stats`（累计播放）、`liked_songs`（收藏）、
 * `dislike_rules`（屏蔽）。而且"推荐没听过的歌"必须去音源搜 —— 搜索也只在客户端
 * 有（音源脚本跑在 Tauri 侧）。所以整条链路都在客户端：读本地偏好 → 多路音源搜索
 * → 规则筛选 → 可选 AI 精选。
 *
 * ## 三种模式（`mode`：要不要叫模型）
 * - `rule`：纯规则，不联网调模型。任何情况下都能出结果，是另外两种的兜底。
 * - `local`：客户端直连用户自己配的 OpenAI 兼容接口（`@/lib/ai_local` 那侧的 Rust 命令）。
 * - `server`：借 astral 的「音乐助手」跑一轮（建会话 → 发候选 → 轮询终态 → 删会话，
 *   见 `@/lib/ai-server-picks`）。需要登录；拿不到结果才退回规则并写 `notice`。
 *
 * 三种模式是**全局**设置（`@/lib/ai-mode`）：音乐助手与每日推荐读同一个开关，
 * 用户 2026-10-24 要求「选择哪个全局都得使用这个模式」。
 *
 * ## 三种口味（`taste`：候选怎么搜、怎么排）
 * 与 `mode` **正交**：四种模式组合都能配三种口味。
 * - `heart` 心动：从收藏出发 —— **喜欢的单曲 + 在线收藏歌单 + 本地自建歌单**里的歌
 *   直接入池，它们的歌手再作为种子去扩；
 * - `familiar` 常听：以常听歌手为主轴，同歌手配额放到最大；
 * - `explore` 探索：主力是全部音源的「最新音乐」里你没听过的歌手，常听歌手倒扣。
 *
 * 候选来自**全部已装音源**（跨源按名字搜 + 全源最新音乐），不再只看当前音源。
 *
 * ## 为什么按歌手轮流取（round-robin）
 * 早期实现是「按分数降序截断」。同一个歌手的高分歌会连着排满最前面几条，用户看到
 * 的就是「每次都是这个歌手」（2026-10-22 实测：前两首都是 Groove Coverage）。
 * 现在改成按歌手分组后轮流取，同一个歌手在结果里天然被摊开；每歌手配额只约束前排，
 * 后排逐级放宽配额保证能凑满目标条数（歌手太少时不至于只出十来首）。
 * 「换一批」另外带上 `variant` 种子：轮转起手歌手会变，同一天多点几次才真的换人。
 * 模型精选这一路模型回的是它自己的顺序，结果侧只做**最小必要**的歌手摊开：相邻两首
 * 撞歌手才交换位置，模型排的顺序尽量保留（第一首永远不动 —— 那是模型最看好的，也是
 * 测试核对回填正确性的锚点）。
 *
 * ## AI 精选：求贴合，不求「风格齐全」
 * 2026-10-24 用户反馈 AI 结果「像随机选」。查库里当天那批：古风 16 首 → 抒情 14 首 →
 * 冷门网络流行 11 首 → 古风 5 首 → **四首英文歌**。这不是模型抽风，是提示词写着
 * 「不要直接照抄前 50 首」「尽量分散在不同歌手和不同风格」—— 模型忠实执行了「凑种类」。
 * 现在的提示词反过来：**清单已按贴合度排好，越靠前越贴合，优先挑靠前的和有本地证据的**；
 * 行尾括号里带上时长带和「已收藏/常听歌手/听过/非主语种」证据；模型交回来的结果还要过
 * `filterAiPicks` 的「画像依据」校验，没依据的尾部歌退回规则补位。宁可整张歌单一门心思
 * 像同一个人挑的，也不要为了「不一样」塞进无关的歌。
 *
 * ## AI 只排序、不决定歌曲
 * 交给模型的候选池是**客户端已经搜好、已经过滤过**的，模型只能回"第几号"和一句理由。
 * 返回后仍要过一遍硬校验：序号必须落在池内、不能重复、条数不够用规则补齐。
 * 这样模型编不出歌，也编不出 id —— 它根本没机会写 id。
 */

import type { MyPlaylistSummary, PlayStatItem, PlaylistCategory, Track } from "@/types";
import * as ipc from "@/services/ipc";
import { LOCAL_PLATFORM } from "@/services/ipc";
import {
  getAllLatestSongs,
  getAlbumDetail,
  getArtistSongs,
  getPlaylistCategories,
  getPlaylistDetail,
  getRecommendations,
  searchAlbums,
  searchManyBatches,
  searchPageMaxOf,
} from "@/source-scripts";
import {
  collectDimensionLanes,
  interleaveByLanes,
  laneCoverage,
  type DimensionLanes,
} from "@/lib/recommend-dimensions";
import { getSearchHistory } from "@/lib/search-history";
import { useMusicSourceStore } from "@/stores/musicSource";
import { useSourceRegistryStore } from "@/stores/sourceRegistry";
import { readAggregateSources } from "@/lib/aggregate-sources";
import {
  hashString,
  localDateKey as todayKey,
  normText,
  songNameKey,
  trackKey,
} from "@/lib/text";
import {
  DAILY_RECOMMEND_CACHE_KEY,
  DAILY_RECOMMEND_SEEDS_KEY,
  DAILY_RECOMMEND_TASTE_KEY,
} from "@/lib/storageKeys";
import {
  DURATION_BAND_LABEL,
  MUSIC_LANG_LABEL,
  type DailyTaste,
  type RankHit,
  type StyleProfile,
  type StyleSample,
  type TrackQuality,
  type TrackStat,
} from "@/lib/recommend-types";
import {
  buildStyleProfile,
  describeProfile,
  trackQuality,
  trackStyle,
} from "@/lib/music-style";
import {
  reasonFor,
  scoreCandidates,
  selectDiverse,
} from "@/lib/recommend-rank";
import {
  AI_MODE_LABEL,
  parseAiMode,
  readAiMode,
  resolveAiMode,
  saveAiMode,
  type AiEngineMode,
} from "@/lib/ai-mode";
import { askServerForPicks } from "@/lib/ai-server-picks";
import { isAdmin, useAuthStore } from "@/stores/auth";

export type { DailyTaste };

// ---------- 常量 ----------

/**
 * 规则版本：改筛选/排序逻辑时 +1，缓存里的旧结果会失效重算。
 *
 * v6（2026-10-23）：冷启动不再返回空页面，改成「平台新歌垫底 + 风格 chip 引导」，
 * 结果里也多了 `coldStart/styleOptions/styleSeeds` 三个字段 —— 旧缓存的 `today`
 * 没有这些字段，留在库里会让用户看不到风格选择入口，所以整体作废重算。
 *
 * v7（2026-10-23）：AI 候选池 60 → 150 并加尾巴轮转，模型才真的在挑而不是在删；
 * 回执解析加了修复与兜底。旧缓存里那批「AI 失败退回规则」的结果要重算 ——
 * 否则用户升级后当天还是看不到差别（正是这次反馈的来源）。
 *
 * v8（2026-10-24）：用户反馈「AI 推荐怎么那么像随机选」。库里当天那批 AI 结果坐实了
 * 病灶 —— 第 47~50 首是四首和画像无关的英文歌，前 16 首古风、中间抒情、后半段冷门
 * 网络流行，活像按「风格种类」凑出来的拼盘。原因不是模型乱来，而是 v7 的提示词就这么
 * 要求它：「不要直接照抄前 50 首」「尽量分散在不同歌手和不同风格」。这一版把提示词
 * 从「求分散」改成「求贴合」，首次温度 0.8→0.4，模型结果再过一道「有没有本地依据」
 * 的校验（详见 `buildPrompt` / `filterAiPicks` 的注释）。旧缓存的 AI 结果必须重算，
 * 否则用户当天看到的还是那批拼盘。
 *
 * v9（2026-10-24）：用户反馈「风格能再多样一点，而不是只有那么一两个，推荐的维度也可以
 * 再多一点；AI 是在你的结果里面选歌，所以你的搜索维度和结果就非常重要」。v8 把「求分散」
 * 改成「求贴合」之后，50 首几乎全落在古风/华语抒情两条线上 —— 不是提示词写错了，而是
 * 候选池本来就只有这两条线可挑（6 条取数路全部围绕常听歌手/专辑/风格歌单）。这一版从
 * **取数侧**扩维度：榜单路（古风榜/说唱榜…）、风格/情绪/场景/年代关键词的跨源搜索、
 * 风格歌单搜索、以及用户自己的搜索历史；每首歌带上「来自哪条风格线」的 provenance，
 * 排序改成按风格线交织，提示词要求覆盖 3–5 条线、AI 结果按线放宽「非主语种」的硬剔。
 * 池子/排序/提示词全变，当天的旧缓存必须作废重算。
 */
export const DAILY_RULE_VERSION = 9;

/** 目标条数 */
export const DAILY_TARGET = 50;

/**
 * 交给模型的候选池上限。
 *
 * 以前是 30（"提示词 30 行，再长小模型会数错号"）。目标提到 50 首之后池子必须
 * 比目标更大，模型才有筛选空间，所以放到 60。
 *
 * **2026-10-23 再放到 150**：用户反馈「感觉不出 AI 推荐和规则推荐有什么不同」。
 * 60 首里挑 50 首 = 模型只能砍掉 10 首，歌单与纯规则的重合度约 83%，剩下的差别
 * 只有顺序和理由文案 —— 用户的感受是准确的。要让模型真的参与，候选池必须比目标
 * 大出一截（3 倍），它才有富余去按风格取舍。
 *
 * 数错号的风险由 `parsePicks` 的硬校验兜住：越界序号直接丢，丢多了退回规则结果，
 * 不会推出不存在的歌。
 */
export const DAILY_AI_POOL_MAX = 150;

/**
 * 候选池里「规则排序的前 N 首」必进池，其余名额从尾巴里按 `variant` 轮转取样。
 *
 * 不这么做的话，候选池永远是规则前 60/150 首 —— 用户点「换一批」模型看到的还是
 * 同一批歌，AI 模式就退化成「给规则歌单换个顺序」。
 */
export const DAILY_AI_CORE = 90;

/**
 * 模型最多可以从「规则前 `DAILY_TARGET` 首之外」挑多少首。
 *
 * 两个极端都试过：把前 50 首整份照抄，用户会说「感觉不出 AI 推荐和规则推荐有什么不同」；
 * 完全放开让模型到处挑，它会为了「不一样」凑风格拼盘，2026-10-24 那天甚至挑了四首英文歌
 * 进「华语古风」歌单。规则前 50 首是规则自己认为最贴合的那批，模型应该以它为主干，
 * 只从后面的候选里换进一小部分（12/50 ≈ 1/4）来制造新鲜感 —— 换进来的仍要过
 * `filterAiPicks` 的「画像依据」校验，非主语种零证据的会被剔掉。
 */
export const DAILY_AI_OFF_CORE_MAX = 12;

/**
 * 提示词里规则条的编号。
 *
 * 不能用 `1. 2. 3.`：候选清单本身就是「序号. 歌名」一行一条，数字编号会被模型
 * （以及测试里的行解析）当成候选行。中段穿插那条（第 ⑤ 条）在池子不够长时整条不出现，
 * 所以编号按最终条数现排，不写死。
 */
const RULE_MARKS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];

/**
 * 画像里某个语种的占比达到这个数，就承认「这是他听的语种」。
 *
 * v8 之前只有「主语种」一个概念，非主语种一律标「非主语种」并被 `filterAiPicks` 剔掉；
 * 用户 2026-10-24 说「风格能再多样一点」，而画像里本来就可能有 8% 日语、5% 粤语 ——
 * 这些语种是他的口味边缘，不该被当作越界。
 */
const LANG_AFFINITY_MIN = 0.05;

/** 提示词里要求覆盖的风格线数量上限（候选池里真有这么多条时才这么要求） */
const LANE_GOAL_MAX = 5;

/**
 * 排序结果里最多掺几条风格线、以及掺多少。
 *
 * 候选池扩宽之后不能把维度路的新歌直接撒进前 50 首 —— 它们大多歌手陌生、播放证据为零，
 * 规则排序会把它们排到 150 名之后；可用户要的就是「多几个风格」，于是按配额往前补：
 * 最多 5 条线，每条线在结果里占 `LANE_QUOTA_SHARE` 的份额（30%）。既保住了「七成是他
 * 最像他的那批」，又让风格线真的出现在前 50 首里。
 */
const LANE_DIVERSITY_MAX = 5;
const LANE_QUOTA_SHARE = 0.3;


/** 模型至少给出几条才认为「它真的干活了」；不够就用规则补齐 */
export const DAILY_AI_MIN_PICKS = 3;

/** 同一歌手最多占几条（避免整屏都是一个歌手；50 首需要更多歌手参与） */
export const DAILY_MAX_PER_SINGER = 3;

/** 保留最近几天的已推荐记录做跨天降权 */
export const DAILY_HISTORY_DAYS = 7;

/** 搜索并发上限：移动网络 + 多个音源，放开会互相拖慢 */
const SEARCH_CONCURRENCY = 3;

/** 每个种子歌手在**当前音源**最多取多少首 */
const SONGS_PER_SINGER = 20;

/** 每个种子歌手在**全部音源**按名字搜时最多取多少首 */
const CROSS_SOURCE_PER_SINGER = 20;

/** 用几个歌手做种子 */
const SEED_SINGER_MAX = 8;

/** 读多少条最近播放做「最近在听」种子 */
const RECENT_SEED_MAX = 12;

/** 「最新音乐」这一路最多取多少首（全部音源交错合并后） */
const EXPLORE_LATEST_MAX = 120;

/** 最多展开几张「同专辑」（每张要发 2 次音源请求：搜专辑 + 取详情） */
const ALBUM_SEED_MAX = 4;

/** 单张专辑最多取多少首（专辑本来就不长，30 首覆盖九成） */
const ALBUM_TRACKS_MAX = 30;

/** 最多进几个「风格歌单」分类（每个分类要发 1 次推荐 + N 次详情） */
const STYLE_CATEGORY_MAX = 2;

/** 单个风格分类取几张歌单做详情 */
const STYLE_PLAYLIST_MAX = 2;

/** 单张风格歌单最多取多少首 */
const STYLE_PLAYLIST_TRACKS_MAX = 40;

/** 页面一侧的硬上限（与生成的 `STYLE_SEED_MAX` 必须一致，导出给 UI 用） */
export const DAILY_STYLE_SEED_MAX = 4;

/**
 * 冷启动最多让用户选几个风格。
 *
 * 3~4 个已经能把口味框住，再多就变成"什么都想要"——画像里的 tags 一多，
 * `pickStyleCategories` 反而匹配不到具体分类，推荐精度不升反降。
 */
const STYLE_SEED_MAX = DAILY_STYLE_SEED_MAX;

/** 冷启动页面上最多摆几个风格 chip（分类接口一般返回十几到几十个，摆满一屏没法选） */
const STYLE_OPTION_MAX = 12;

/**
 * 最多读几个收藏歌单（在线收藏 + 本地自建合计）。
 *
 * 每个在线歌单要单独发一次音源请求，几十个歌单全读会让「生成」卡十几秒。
 * 只取最近更新/创建的前几个 —— 口味是流动的，最近收藏的歌单更能代表当下。
 */
const PLAYLIST_SEED_MAX = 6;

/** 单个收藏歌单最多取多少首进候选池（歌单动辄上百首，全收会把池子灌爆） */
const PLAYLIST_TRACKS_MAX = 80;

// ---------- 模式 ----------

/**
 * 模式的**唯一真源**在 `@/lib/ai-mode`：音乐助手与每日推荐共用同一个设置
 * （2026-10-24 用户要求「选择哪个全局都得使用这个模式」）。
 *
 * 这里保留旧名字，因为页面、设置页与测试都是按 `DailyRecommendMode` /
 * `DAILY_MODE_LABEL` / `parseDailyRecommendMode` 写的 —— 换名字只是自找迁移。
 */
export type DailyRecommendMode = AiEngineMode;

export const DAILY_MODE_LABEL = AI_MODE_LABEL;

export const parseDailyRecommendMode = parseAiMode;

/**
 * 兼容旧调用：模式不再降级。
 *
 * v1.18 及以前 `server` 在这里被折成 `rule`（本页不实现服务端），现在服务端模式
 * 真的会调模型，降级只发生在运行时失败之后（见 `generateDailyRecommend` 的 catch）。
 */
export function effectiveMode(mode: DailyRecommendMode): DailyRecommendMode {
  return mode;
}

// ---------- 口味（推荐场景） ----------

/**
 * 推荐口味：决定**候选怎么搜、怎么排序**，和上面的 `mode`（要不要叫模型）正交。
 *
 * - `heart` 心动：从收藏 + 最近在听出发，尽量贴近你已经明确喜欢的东西；
 * - `familiar` 常听：以常听歌手为主轴，同歌手配额放到最大，重"熟悉感"；
 * - `explore` 探索：主力是"最新音乐"里你完全没听过的歌手，常听歌手降权。
 *
 * 类型本体在 `@/lib/recommend-types`（打分引擎要用它，两边共用一份定义），
 * 这里只做再导出，保持 `from "@/lib/daily-recommend"` 的历史 import 路径可用。
 */

export const DAILY_TASTE_LABEL: Record<DailyTaste, string> = {
  heart: "心动模式",
  familiar: "常听模式",
  explore: "探索模式",
};

/**
 * 一句话说明每种口味在干什么（页面上给用户看）。
 *
 * 2026-10-23 改口径：用户反馈「不该只按听过的歌手推，要按风格综合推」，
 * 所以三个说明都从"歌手"改成"风格"，让用户点之前就知道区别在哪。
 */
export const DAILY_TASTE_HINT: Record<DailyTaste, string> = {
  heart: "按你的口味画像（语种、风格、常听专辑）找同款，收藏过的优先",
  familiar: "在已经熟悉的风格里挑，熟悉感优先，不跳到陌生口味",
  explore: "换风格、换歌手，挑你没怎么听过的味道",
};

/** 页面上口味按钮的固定顺序（对象 key 顺序不可靠，显式列出来） */
export const DAILY_TASTE_ORDER: DailyTaste[] = ["heart", "familiar", "explore"];

/**
 * 口味对应的挑歌方向（写进模型提示词）。
 *
 * 2026-10-23 改口径：旧文案只说「常听歌手」，模型于是也只按歌手挑 —— 那正是用户
 * 反馈要改掉的做法。现在每种口味都明确说「按风格综合判断」，歌手只是其中一个信号。
 */
const TASTE_PROMPT: Record<DailyTaste, string> = {
  heart:
    "用户想要「心动」：优先挑和他口味画像（语种、风格标签、常听专辑）最接近的歌，收藏过的同款最优先；但不要连着好几首都来自同一个歌手。",
  familiar:
    "用户想要「常听」：在用户已经熟悉的风格里挑（同语种、同专辑、风格标签对得上），熟悉感优先，别跳到完全陌生的风格去。",
  explore:
    "用户想要「探索」：挑用户没听过的歌手，也挑他没怎么听过的风格（语种或风格标签与画像不同），别老是那几个人、那几种味道。",
};

/** 把库里读出来的字符串收敛成合法口味（未知值按心动处理） */
export function parseDailyTaste(raw: string | null | undefined): DailyTaste {
  return raw === "familiar" || raw === "explore" ? raw : "heart";
}

/** 读当前设置的口味 */
export async function readTaste(): Promise<DailyTaste> {
  try {
    return parseDailyTaste(await ipc.getSetting(DAILY_RECOMMEND_TASTE_KEY));
  } catch {
    return "heart";
  }
}

/** 保存口味 */
export async function saveTaste(taste: DailyTaste): Promise<void> {
  await ipc.setSetting(DAILY_RECOMMEND_TASTE_KEY, taste);
}

/**
 * 把设置里读出来的风格种子收敛成干净的字符串数组。
 *
 * 存的是 JSON 数组，但要能容忍三件脏事：老版本没有这个键（`null`）、
 * 手工改坏了 JSON、以及早期版本可能写过的逗号分隔串。三种都按"尽力还原"处理 ——
 * 这里错了不会崩，只是画像少几个风格词，不值得为它抛异常。
 */
export function parseStyleSeeds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let list: string[] = [];
  const text = raw.trim();
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) {
        list = parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      list = [];
    }
  }
  // 不是数组（老格式/手改坏）：按分隔符硬拆，能救一个算一个
  if (list.length === 0) list = text.replace(/^\[|\]$/g, "").split(/[,，、/]+/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const name = item.trim();
    if (!name) continue;
    // 风格名里不可能出现 JSON 标点：出现了就是被写坏的残渣（`{{{`、`"a":`），别让它进画像
    if (/[{}[\]"\\]/.test(name)) continue;
    const key = normText(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= STYLE_SEED_MAX) break;
  }
  return out;
}

/** 读用户选的风格种子（冷启动时点的那几个风格名） */
export async function readStyleSeeds(): Promise<string[]> {
  try {
    return parseStyleSeeds(await ipc.getSetting(DAILY_RECOMMEND_SEEDS_KEY));
  } catch {
    return [];
  }
}

/** 保存风格种子；传空数组等于清空（下次生成又会回到冷启动） */
export async function saveStyleSeeds(names: string[]): Promise<void> {
  await ipc.setSetting(DAILY_RECOMMEND_SEEDS_KEY, JSON.stringify(parseStyleSeeds(JSON.stringify(names))));
}

/** 冷启动时给用户点的风格选项（来自平台分类，名字就是风格名） */
export interface DailyStyleOption {
  id: string;
  name: string;
  /** 平台给的分类分组（「语种」「风格」「场景」「情感」…），只用于展示 */
  group: string;
}

// ---------- 类型 ----------

/** 一条推荐 + 推荐理由（理由可能来自模型，也可能是规则生成的） */
export interface DailyRecommendItem {
  track: Track;
  reason: string;
}

/** 一次生成的结果 */
export interface DailyRecommendResult {
  /** 本地日期 `YYYY-MM-DD` */
  date: string;
  /** 实际生效的模式（`server` 会被降级成 `rule`，看 `notice`） */
  mode: DailyRecommendMode;
  /**
   * 用户**要求**的模式（`mode` 是实际生效的，两者可能不同）。
   *
   * 缓存命中按这个字段判断，而不是按 `mode`：本地模型调不通时结果会落成 `rule`，
   * 若按 `mode` 比对，下次进页面就又算「模式不符」→ 重新搜十几个音源再超时一次。
   * 用「用户要的」做缓存键，失败也只失败一次，用户点「换一批」才会重试。
   *
   * 老缓存没有这个字段，读的时候回落 `mode`（见 `loadTodayResult`）。
   */
  requested: DailyRecommendMode;
  /**
   * 这次用的口味（心动/常听/探索）。
   *
   * 可选：老缓存没这个字段，读的时候按 `heart` 处理（`loadTodayResult` 里归一）。
   * 保留可选是为了让老缓存能继续命中 —— 若做成必填，升级后所有已有缓存都要重算。
   */
  taste?: DailyTaste;
  generatedAt: number;
  /** 一句话主题（模型给的，规则模式是固定文案） */
  title: string;
  summary: string;
  items: DailyRecommendItem[];
  /** 给用户看的提示：降级、模型失败、候选不足等 */
  notice: string | null;
  /**
   * 这次是按什么口味挑的（画像的人话描述，如 `华语 · 三四分钟 · 常听 12 位歌手 · 常听民谣`）。
   *
   * 用户 2026-10-23 反馈「应该按风格综合推」—— 那就必须**让他看见**系统认为他是什么
   * 口味，否则改成了按风格推他也无从判断。可选：老缓存没有这个字段。
   */
  profileText?: string;
  /**
   * 这次真正干活的模型名（`mode: "local"` 时才有）。
   *
   * 用户 2026-10-23 说「感觉不出 AI 推荐和规则推荐有什么不同」—— 除了候选池太小，
   * 另一个原因是页面上只有一个「本地模型精选」的标签，看不出到底是哪个模型在挑。
   * 写上模型名，换模型之后能直接对比。
   */
  model?: string;
  /**
   * 本期覆盖到的**风格线**（如「古风 22 首、粤语 7 首、纯音乐 5 首」）。
   *
   * 用户 2026-10-24 反馈「风格能再多变一点、推荐维度再多一点」—— 除了真的把候选池
   * 通过更多维度搜宽（榜单 / 风格关键词 / 语种 / 年代 / 搜索历史），还要**让他看见**
   * 这张歌单到底覆盖了哪几条线，否则变没变多他无从判断。
   * 按条数降序，最多 5 条；没有风格线证据时（老缓存、纯歌手扩展路径）为空数组。
   */
  styleLanes?: { label: string; count: number }[];
  /**
   * 这次是**冷启动**结果：用户没有任何播放历史、没有收藏、也没选过风格。
   *
   * 冷启动不再直接返回空页面（旧实现那样，新用户打开就是一片空白、还以为坏了），
   * 而是给一批平台侧的热门/新歌垫底，同时在页面上摆一排风格 chip 让用户点。
   * 用户点完写进 `dailyRecommend.styleSeeds`，下次生成就能按风格推了。
   */
  coldStart?: boolean;
  /** 冷启动时可选的风格（来自 `getPlaylistCategories`；音源不支持时为空数组） */
  styleOptions?: DailyStyleOption[];
  /** 这次生效的风格种子（用户之前选过的话会带上） */
  styleSeeds?: string[];
}

/** 从本地库提炼出的偏好 */
export interface DailyPreference {
  /** 常听歌手（按播放次数降序） */
  topSingers: string[];
  /** 最近在听（新的在前） */
  recentTracks: Track[];
  /** 收藏里的歌（喜欢的单曲） */
  favoriteTracks: Track[];
  /**
   * 收藏歌单里的歌：**在线收藏的歌单 + 本地自建歌单**。
   *
   * 心动模式的主力来源。以前只读 `liked_songs`（喜欢的单曲），完全没读歌单，
   * 于是"按收藏推荐"实际拿不到歌单里的歌 —— 用户 2026-10-22 反馈的正是这个。
   */
  playlistTracks: Track[];
  /** 已屏蔽规则数（只用于文案展示） */
  dislikeCount: number;
  /**
   * 播放次数最多的那批歌的**完整收听统计**（`getTopTracks(200)`）。
   *
   * 用户 2026-10-23 反馈的根本问题在这里：旧实现只用了"播放次数排行"，
   * 于是"点开听 20 秒就切"和"一遍遍听完"同分，画像必然失真。
   * 有了 `totalPlayedMs` 才能算出完播比，再折算成每首歌的可信度。
   */
  topTracks?: { track: Track; stat: TrackStat }[];
  /**
   * 口味画像：语种 / 时长带 / 常听歌手 / 常听专辑 / 歌单名里的风格词。
   *
   * 这是"按风格推荐"的核心 —— 平台接口不给 genre，画像完全由本地信号推导。
   * 可选是为了让只关心某个函数的测试能构造最小对象。
   */
  style?: StyleProfile;
  /** `trackKey` → 收听质量（完播/重播/新鲜度/综合亲和度） */
  qualities?: Map<string, TrackQuality>;
  /** 收藏歌单的名字（用户亲手写的风格自述，参与风格词提取） */
  playlistNames?: string[];
  /**
   * 用户自己选的风格种子（冷启动时点的「华语」「摇滚」…）。
   *
   * 与 `playlistNames` 分开存：歌单名是用户**间接**写的，风格种子是用户**直接**告诉
   * 系统的，两者在画像里的地位一样（都进 tags），但展示和调试时要能区分。
   */
  styleSeeds?: string[];
}

/** 缓存里存的一天 */
interface DailyCacheDay {
  date: string;
  mode: string;
  keys: string[];
}

/** `dailyRecommend.cache` 的完整结构 */
interface DailyCacheStore {
  v: number;
  /** 最近若干天推荐过的歌（跨天去重用） */
  days: DailyCacheDay[];
  /** 当天结果（生成过才有） */
  today: DailyRecommendResult | null;
}

const EMPTY_CACHE: DailyCacheStore = { v: DAILY_RULE_VERSION, days: [], today: null };

// ---------- 小工具 ----------
// 日期键 / 曲目键 / 同名键 / 归一化 / FNV-1a 哈希都在 `@/lib/text`（全仓唯一实现，
// 这里曾经留有逐字相同的私有副本）。既有调用方（测试与页面）大量从本模块
// import `todayKey` / `trackKey` / `songNameKey`，保留同名 re-export 不惊动它们。

export { todayKey, trackKey, songNameKey };

/** 并发受限的 map（保持输入顺序） */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Math.min(Math.max(1, limit), Math.max(1, items.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
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

/** 从一段可能带 markdown 围栏/前后废话的文本里抠出第一个 JSON 对象 */
export function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : trimmed;
  const start = body.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 抠出第一个 JSON **数组**（模型偶尔直接回 `[3,7,9]`，把序号摆一排）。
 *
 * 只在拿不到对象时才用：正常回执是 `{"title":…,"picks":[…]}`，先按对象解析能拿到
 * title/summary；这里只兜底「模型偷懒只回了序号」这一种。
 */
export function extractJsonArray(text: string): string | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : trimmed;
  const start = body.indexOf("[");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

// ---------- 缓存读写 ----------

function normalizeCache(raw: string | null): DailyCacheStore {
  if (!raw) return { ...EMPTY_CACHE, days: [], today: null };
  try {
    const parsed = JSON.parse(raw) as Partial<DailyCacheStore> | null;
    if (!parsed || typeof parsed !== "object") return { ...EMPTY_CACHE, days: [], today: null };
    const days = Array.isArray(parsed.days)
      ? parsed.days.filter(
          (d): d is DailyCacheDay =>
            !!d && typeof d.date === "string" && Array.isArray(d.keys),
        )
      : [];
    return {
      v: typeof parsed.v === "number" ? parsed.v : DAILY_RULE_VERSION,
      days,
      today: parsed.today ?? null,
    };
  } catch {
    return { ...EMPTY_CACHE, days: [], today: null };
  }
}

/** 读缓存（坏数据一律当空，不能让一条脏记录把页面卡死） */
export async function readDailyCache(): Promise<DailyCacheStore> {
  try {
    return normalizeCache(await ipc.getSetting(DAILY_RECOMMEND_CACHE_KEY));
  } catch {
    return { ...EMPTY_CACHE, days: [], today: null };
  }
}

async function writeDailyCache(store: DailyCacheStore): Promise<void> {
  await ipc.setSetting(DAILY_RECOMMEND_CACHE_KEY, JSON.stringify(store));
}

/**
 * 今天已生成过的结果（同一天 + 同模式 + 同口味 + 同规则版本才算命中）。
 *
 * 传了 `mode` 就要求缓存里**用户要求的模式**与它一致。比对用 `requested` 而不是
 * 生效的 `mode`：本地模型调不通时结果落成 `rule`，若按 `mode` 比对，下次进页面
 * 又算「模式不符」→ 重新搜十几个音源再超时一次。老缓存没有 `requested`，回落 `mode`。
 *
 * `taste` 同理：换了口味（心动 → 探索）必须重算，否则用户点了没反应。
 */
export async function loadTodayResult(
  mode?: DailyRecommendMode,
  taste?: DailyTaste,
): Promise<DailyRecommendResult | null> {
  const cache = await readDailyCache();
  const today = cache.today;
  if (!today) return null;
  if (today.date !== todayKey()) return null;
  if (cache.v !== DAILY_RULE_VERSION) return null;
  if (!Array.isArray(today.items) || today.items.length === 0) return null;
  if (mode !== undefined) {
    // 模式不再降级（v1.19 起 `server` 真的会调模型），直接比用户要求的模式：
    // 服务端失败落成的结果 `requested` 仍是 `server`，下次进页面照样命中缓存，
    // 不会因为「上次失败了」就每次重搜十几个音源再失败一次。
    const stored = today.requested ?? today.mode;
    if (stored !== mode) return null;
  }
  if (taste !== undefined && parseDailyTaste(today.taste) !== taste) return null;
  return today;
}

/** 清掉当天缓存（「换一批」用；历史记录保留，仍然参与跨天去重） */
export async function clearTodayResult(): Promise<void> {
  const cache = await readDailyCache();
  await writeDailyCache({ ...cache, today: null });
}

/**
 * 最近若干天推荐过的歌。
 *
 * 同时收 `trackKey` 和 `songNameKey`：同一首歌换音源 id 不同，只按 `trackKey` 去重
 * 会让它绕过历史检查又推一遍（「一直是那几首」的一个成因）。
 */
function recentRecommendedKeys(cache: DailyCacheStore, includeToday: boolean): Set<string> {
  const keys = new Set<string>();
  const cutoff = Date.now() - DAILY_HISTORY_DAYS * 24 * 3600 * 1000;
  for (const day of cache.days) {
    const at = Date.parse(`${day.date}T00:00:00`);
    if (Number.isFinite(at) && at < cutoff) continue;
    for (const key of day.keys) keys.add(key);
  }
  if (includeToday && cache.today) {
    for (const item of cache.today.items) {
      keys.add(trackKey(item.track));
      keys.add(songNameKey(item.track));
    }
  }
  return keys;
}

async function saveResult(result: DailyRecommendResult, replaceToday: boolean): Promise<void> {
  const cache = await readDailyCache();
  // 每首同时存 id 键和同名键：跨源换 id 的歌也要能被下一次去重认出来
  const keys = result.items.flatMap((item) => [trackKey(item.track), songNameKey(item.track)]);
  // 同一天点了多次「换一批」时**合并**当天的键，不能覆盖：
  // 覆盖会让上一批的歌从「已推荐过」里消失，第三次「换一批」就可能把第一批原样捞回来。
  const sameDay = cache.days.find((day) => day.date === result.date);
  const merged = new Set<string>([...(sameDay?.keys ?? []), ...keys]);
  const days = cache.days.filter((day) => day.date !== result.date);
  days.push({ date: result.date, mode: result.mode, keys: [...merged] });
  const trimmed = days
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, DAILY_HISTORY_DAYS);
  const today = replaceToday ? result : cache.today;
  await writeDailyCache({ v: DAILY_RULE_VERSION, days: trimmed, today });
}

// ---------- 偏好提取 ----------

/**
 * 读收藏歌单里的歌：在线收藏的歌单 + 本地自建歌单。
 *
 * 两类歌单取曲目的方式不同（本地走 `getPlaylistTracks`，在线走音源
 * `getPlaylistDetail`），这里统一成 `Track[]` 给上层用。
 *
 * 只读最近的前 `PLAYLIST_SEED_MAX` 个：每个在线歌单要发一次音源请求，
 * 几十个歌单全读会让「生成」卡十几秒。任何一路失败都只是少几首，不影响整体。
 */
async function loadPlaylistTracks(): Promise<{ tracks: Track[]; names: string[] }> {
  const empty = { tracks: [] as Track[], names: [] as string[] };
  let playlists: MyPlaylistSummary[];
  try {
    playlists = await ipc.listMyPlaylists();
  } catch {
    return empty;
  }
  if (!Array.isArray(playlists) || playlists.length === 0) return empty;
  const seeds = playlists
    .slice()
    // 最近更新的优先：口味是流动的，新收藏的歌单更贴近当下
    .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
    .slice(0, PLAYLIST_SEED_MAX);

  const rows = await mapLimit(seeds, SEARCH_CONCURRENCY, async (playlist) => {
    try {
      // 判 `platform` 而不是只看 `isLocal`：`list_my_playlists` 把「我喜欢的歌曲」
      // 这类云端卡片也标成 platform=local 但 isLocal=false，它们的曲目同样在本地库里，
      // 送去音源取会直接失败。
      const local = playlist.isLocal || playlist.platform === LOCAL_PLATFORM;
      const tracks = local
        ? await ipc.getPlaylistTracks(playlist.pid)
        : ((await getPlaylistDetail(playlist.platform, playlist.id)).tracks ?? []);
      return tracks.slice(0, PLAYLIST_TRACKS_MAX);
    } catch {
      // 在线歌单可能因为音源包缺失/网络失败读不到 —— 少一个歌单不影响出歌
      return [] as Track[];
    }
  });

  const out: Track[] = [];
  const seen = new Set<string>();
  for (const track of rows.flat()) {
    if (!track || !track.id || !track.title) continue;
    const key = trackKey(track);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(track);
  }
  // 歌单名一起带出去：用户亲手写的名字（「周二夜里的后摇」「女声民谣」）是唯一
  // 由人给出的风格自述，比任何算法推断都可靠，交给画像去提风格词。
  const names = seeds.map((p) => (p.name ?? "").trim()).filter(Boolean);
  return { tracks: out, names };
}

/**
 * 读本地偏好。任何一路失败都不影响其它路 —— 新用户可能三条都没有，
 * 那时返回空偏好，后面靠「搜索兜底」也能出一批歌。
 */
export async function loadPreference(): Promise<DailyPreference> {
  const [singers, recent, favorites, dislikes, playlists, topTracks, styleSeeds] = await Promise.all([
    ipc.getTopSingers(12).catch(() => []),
    ipc.listHistory(50).catch(() => []),
    ipc.listFavorites().catch(() => []),
    ipc.listDislikes().catch(() => []),
    loadPlaylistTracks(),
    // 200 首是 Rust 侧 `list_top_tracks` 的硬上限，也是"够看清口味"的量级：
    // 再往上翻都是播放一两次的长尾，反而把画像搅浑。
    ipc.getTopTracks(200).catch(() => [] as PlayStatItem[]),
    // 冷启动时用户手选的风格。和播放记录一起读：它们是同一层输入（"用户告诉我他喜欢什么"），
    // 只是来源不同 —— 一个是听出来的，一个是点出来的。
    readStyleSeeds(),
  ]);
  const playlistTracks = playlists.tracks;
  const topSingers: string[] = [];
  const seen = new Set<string>();
  const pushSinger = (raw: string): void => {
    // 歌手串可能是「周杰伦/费玉清」，拆开逐个人入种子
    for (const part of raw.split(/[/、,，&＆;；]+/)) {
      const name = part.trim();
      if (!name) continue;
      const key = normText(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      topSingers.push(name);
    }
  };
  for (const item of singers) pushSinger(item.singer);
  for (const track of favorites.slice(0, 10)) pushSinger(track.singer);
  // 收藏歌单里的歌手也是口味信号：心动模式要按它们扩
  for (const track of playlistTracks.slice(0, 20)) pushSinger(track.singer);

  const recentTracks = recent.slice(0, RECENT_SEED_MAX).map((item) => item.track);
  for (const track of recentTracks) pushSinger(track.singer);

  // ---- 收听质量 + 风格画像 ----
  // 这两块是 2026-10-23 那次反馈的正解：旧实现只按「歌手排名」推，
  // 等于把用户锁死在那几个名字里；画像把语种/时长带/专辑/风格词也算进来。
  const maxPlayCount = topTracks.reduce((max, item) => Math.max(max, item.playCount), 0);
  const now = Date.now();
  const qualities = new Map<string, TrackQuality>();
  for (const item of topTracks) {
    qualities.set(
      trackKey(item.track),
      trackQuality(
        {
          playCount: item.playCount,
          totalPlayedMs: item.totalPlayedMs,
          lastPlayedAt: item.lastPlayedAt,
        },
        item.track.duration,
        maxPlayCount,
        now,
      ),
    );
  }

  const samples: StyleSample[] = [];
  const seenSample = new Set<string>();
  const addSample = (track: Track, saved = false, stat?: TrackStat): void => {
    if (!track?.title) return;
    const key = trackKey(track);
    if (seenSample.has(key) || !key) return;
    seenSample.add(key);
    samples.push({ track, saved, stat });
  };
  // 先放有统计的（权重最高），再放收藏与歌单 —— 顺序即重要度
  for (const item of topTracks) {
    addSample(item.track, false, {
      playCount: item.playCount,
      totalPlayedMs: item.totalPlayedMs,
      lastPlayedAt: item.lastPlayedAt,
    });
  }
  for (const track of favorites) addSample(track, true);
  for (const track of playlistTracks) addSample(track, true);
  for (const track of recentTracks) addSample(track);

  return {
    topSingers: topSingers.slice(0, SEED_SINGER_MAX),
    recentTracks,
    favoriteTracks: favorites,
    playlistTracks,
    dislikeCount: dislikes.length,
    topTracks: topTracks.map((item) => ({
      track: item.track,
      stat: {
        playCount: item.playCount,
        totalPlayedMs: item.totalPlayedMs,
        lastPlayedAt: item.lastPlayedAt,
      },
    })),
    playlistNames: playlists.names,
    styleSeeds,
    qualities,
    // 风格种子并入画像的来源名：`buildStyleProfile` 从这个字段抽风格词，用户手选的名字
    // 与歌单名走同一条提取逻辑 —— 不额外给它开一套规则，画像里的 tags 就自然带上了它们。
    style: buildStyleProfile({
      samples,
      playlistNames: [...playlists.names, ...styleSeeds],
      now,
    }),
  };
}

// ---------- 候选池 ----------

/** 候选池的可选参数 */
export interface CandidatePoolOptions {
  /** 推荐口味，决定要不要额外捞「最新音乐」 */
  taste?: DailyTaste;
  /**
   * 冷启动：没有任何播放历史/收藏/风格种子时，走"平台热门 + 风格歌单"垫底。
   *
   * 与口味无关 —— 冷启动时三种口味都得先给出内容来，否则新用户永远看到空页面。
   */
  coldStart?: boolean;
  /** 已经取到的平台分类（冷启动时页面要显示同一批；传进来省一次请求） */
  categories?: PlaylistCategory[];
  /** 进度回调（已完成的搜索路数 / 总路数） */
  onProgress?: (done: number, total: number) => void;
  /**
   * 「换一批」的变体种子。
   *
   * 维度搜索的兜底词条按它轮换 —— 没有这个，用户点十次「换一批」看到的
   * 风格维度永远是同一批（古风→国风→民谣…）。
   */
  variant?: string;
}

/**
 * 从平台分类里挑出**和口味对得上**的几个，用来取风格歌单。
 *
 * 平台分类的名字就是风格名（「华语」「摇滚」「民谣」「纯音乐」…），这是整条链路上
 * 唯一拿得到的平台侧风格标签。三种口味的挑法不同：
 * - `heart`：优先命中画像里的风格词，其次命中主语种 —— 找"你已经喜欢的同款"；
 * - `explore`：**避开**画像里的风格词和主语种，专门挑你权重最低的那类 ——
 *   探索不是"在熟悉的风格里找新歌手"，而是"换个风格"；
 * - `familiar`：不走这一路（靠同专辑 + 常听歌手就够了，风格歌单反而会掺进陌生人）。
 *
 * 分类名与画像对不上时按顺序兜底取前几个，保证这一路不会因为匹配不上而空手。
 */
function pickStyleCategories(
  categories: PlaylistCategory[],
  pref: DailyPreference,
  taste: DailyTaste,
): PlaylistCategory[] {
  const list = categories.filter((item) => item?.id && item.name);
  if (list.length === 0) return [];
  const profile = pref.style;
  const tags = new Set((profile?.tags ?? []).map((tag) => normText(tag)));
  const mainLangLabel = profile && profile.mainLang !== "und" ? MUSIC_LANG_LABEL[profile.mainLang] : "";
  const langKey = normText(mainLangLabel);
  const matches = (item: PlaylistCategory): boolean => {
    const name = normText(item.name);
    if (!name) return false;
    if (tags.has(name)) return true;
    // 分类名常是「华语流行」「欧美摇滚」这种组合词，用包含判断而不是相等
    if (langKey && (name.includes(langKey) || langKey.includes(name))) return true;
    return [...tags].some((tag) => tag.length >= 2 && name.includes(tag));
  };
  if (taste === "explore") {
    const others = list.filter((item) => !matches(item));
    // 一个都匹配不上说明画像太空（新用户），此时"避开"没有意义，就按平台顺序取
    const source = others.length > 0 ? others : list;
    return source.slice(0, STYLE_CATEGORY_MAX);
  }
  const hit = list.filter(matches);
  const rest = list.filter((item) => !matches(item));
  return [...hit, ...rest].slice(0, STYLE_CATEGORY_MAX);
}

/**
 * 冷启动页面上摆哪些风格 chip。
 *
 * 平台分类会同时返回「语种」「风格」「场景」「情感」四组，几十个名字摆满一屏反而
 * 没法选。这里只做三件事：去掉脏数据、按名字去重、截断到一屏放得下的数量。
 * **不改顺序** —— 平台把「华语」「欧美」这些大分类排在前面，那是它自己的推荐顺序，
 * 比我们猜的顺序可靠。
 */
function pickStyleOptions(categories: PlaylistCategory[]): DailyStyleOption[] {
  const out: DailyStyleOption[] = [];
  const seen = new Set<string>();
  for (const item of categories) {
    if (!item?.id || !item.name) continue;
    const key = normText(item.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: item.id, name: item.name.trim(), group: (item.group ?? "").trim() });
    if (out.length >= STYLE_OPTION_MAX) break;
  }
  return out;
}

/**
 * 多路搜候选，**覆盖全部已装音源**。
 *
 * 四条路：
 * ⓪ 收藏里的歌（喜欢的单曲 + 收藏歌单，**心动模式的主力**）—— 这些歌本来就是
 *    用户明确喜欢的，直接入池，不用再搜；
 * ① 常听/收藏歌手的其它歌（`getArtistSongs`，当前音源，负责"深"）；
 * ② 按歌手名跨源搜（数据包 `searchMany` 入口，**全部音源**，负责"广" —— 用户要求
 *    "歌曲可以是全部音源的"，这一路才是真正跨源的那条）；
 * ③ 全部音源的最新音乐（`getAllLatestSongs`，探索模式的主力，也是没有播放历史
 *    时唯一能出歌的来源）。
 *
 * 已经在本地听过的歌也留在池里（规则排序会给没听过的加分），只是不额外扩。
 */
export async function buildCandidatePool(
  pref: DailyPreference,
  source: string,
  options: CandidatePoolOptions = {},
): Promise<Track[]> {
  const taste = options.taste ?? "heart";
  const onProgress = options.onProgress;
  const coldStart = options.coldStart ?? false;
  const singers = pref.topSingers.slice(0, SEED_SINGER_MAX);
  // 探索模式靠「最新音乐」也能出结果；其它口味没有种子歌手就诚实返回空，
  // 由调用方提示「先去听几首」（硬凑一堆无关的歌比空着更糟）。
  // 冷启动是例外：它就是"什么都没有"的场景，必须用最新音乐 + 风格歌单垫住。
  const wantLatest =
    taste === "explore" ||
    coldStart ||
    // 只选过风格、没有播放量的用户：种子歌手和收藏都是空的，最新音乐是兜底内容
    (singers.length === 0 && pref.favoriteTracks.length === 0 && pref.playlistTracks.length === 0);
  // 心动模式从收藏出发：收藏里已经有歌就直接入池，不需要种子歌手
  const favorites = taste === "heart" ? [...pref.favoriteTracks, ...pref.playlistTracks] : [];
  if (singers.length === 0 && !wantLatest && favorites.length === 0) return [];

  let done = 0;
  // ④ 同专辑（靠"专辑"这个最硬的风格代理扩同款）｜⑤ 风格歌单（靠平台分类名扩同款）
  const wantAlbum = taste === "heart" || taste === "familiar";
  const wantStylePlaylist = taste === "heart" || taste === "explore" || coldStart;
  const total =
    singers.length * 2 + (wantLatest ? 1 : 0) + (wantAlbum ? 1 : 0) + (wantStylePlaylist ? 1 : 0);
  const tick = (): void => {
    done += 1;
    onProgress?.(done, total);
  };

  const byArtist =
    singers.length === 0
      ? []
      : await mapLimit(singers, SEARCH_CONCURRENCY, async (singer) => {
          try {
            const pageSize = Math.min(searchPageMaxOf(source), SONGS_PER_SINGER);
            const page = await getArtistSongs(source, singer, 1, pageSize);
            return page.songs;
          } catch {
            return [] as Track[];
          } finally {
            tick();
          }
        });
  // ---- ② 按歌手名跨源搜（全部音源，负责"广"）----
  // 关键词扇出交给数据包的 `searchMany` 入口：一次 invoke 内完成「多个歌手 × 四源」，
  // 并发上限/单源超时/逐词失败隔离都在音源层实现一份（PC 与安卓共用，不再各写一套）。
  // 按 SEARCH_CONCURRENCY 分块调用：块内由包并发，块间串行 —— 这样单块超时或失败
  // 只影响这一块，与旧实现「每个歌手各自失败」的容错粒度一致。
  const bySearch: Track[][] = [];
  // 聚合搜索只查用户勾选的音源（设置 → 音源包 → 聚合搜索音源；null = 全部）
  const aggSources = (await readAggregateSources()) ?? undefined;
  for (let start = 0; start < singers.length; start += SEARCH_CONCURRENCY) {
    const chunk = singers.slice(start, start + SEARCH_CONCURRENCY);
    try {
      const result = await searchManyBatches(chunk, 1, CROSS_SOURCE_PER_SINGER, {
        concurrency: SEARCH_CONCURRENCY,
        sources: aggSources,
      });
      bySearch.push(
        ...result.groups.map((group) => group.batches.flatMap((batch) => batch.tracks)),
      );
    } catch {
      // 数据包整体不可用（引擎重启/超时）：这一块按空结果处理，其它块照常
      bySearch.push(...chunk.map(() => [] as Track[]));
    } finally {
      chunk.forEach(() => tick());
    }
  }
  const latest = wantLatest
    ? await getAllLatestSongs(EXPLORE_LATEST_MAX, 0).catch(() => [] as Track[])
    : [];
  if (wantLatest) tick();

  // ---- ④ 同专辑兄弟（"风格"的最硬代理）----
  // 平台接口不给 genre，但专辑是天然的风格容器：同一张专辑里的歌几乎必然同风格、
  // 同年代、同制作。比"同歌手"更细，也不会像"同歌手"那样把推荐锁死在一批名字上。
  const albumKeyToTrack = new Map<string, Track>();
  for (const track of [...pref.favoriteTracks, ...pref.playlistTracks, ...pref.recentTracks]) {
    if (!track?.title || !track.album) continue;
    const key = trackStyle(track).albumKey;
    if (!key || albumKeyToTrack.has(key)) continue;
    albumKeyToTrack.set(key, track);
  }
  const byAlbum = wantAlbum
    ? await (async () => {
        const albums = [...albumKeyToTrack.values()].slice(0, ALBUM_SEED_MAX);
        const rows = await mapLimit(albums, SEARCH_CONCURRENCY, async (track) => {
          try {
            // 专辑 id 拿不到（`Track` 没有 albumId 字段），所以按「歌手 专辑名」搜专辑，
            // 再挑名字对得上的那张 —— 宁可少一张专辑，也不猜错专辑。
            const found = await searchAlbums(source, `${track.singer} ${track.album}`, 1, 10);
            const hit = found.find((album) => normText(album.name) === normText(track.album));
            if (!hit) return [] as Track[];
            const detail = await getAlbumDetail(source, hit.id);
            return (detail.tracks ?? []).slice(0, ALBUM_TRACKS_MAX);
          } catch {
            return [] as Track[];
          }
        });
        return rows.flat();
      })().finally(() => {
        if (wantAlbum) tick();
      })
    : [];

  // ---- ⑤ 风格歌单（平台自己归类的"摇滚/华语/民谣"）----
  // 这是唯一能拿到**平台侧风格标签**的入口：分类名就是风格名。心动模式按画像主语种
  // 找同款；探索模式反过来，专门挑用户**权重最低**的分类，才是真的在探索。
  const byStylePlaylist = wantStylePlaylist
    ? await (async () => {
        try {
          // 冷启动时调用方已经取过分类（页面要拿同一批给用户点），别重复请求
          const categories = options.categories ?? (await getPlaylistCategories(source));
          const picked = pickStyleCategories(categories, pref, taste);
          const rows = await mapLimit(picked, 2, async (category) => {
            try {
              const playlists = await getRecommendations(source, category.id, 1, "");
              // 取两张：一张可能刚好是"猜你喜欢"这种大杂烩，两张互相兜底
              const targets = playlists.slice(0, STYLE_PLAYLIST_MAX);
              const details = await mapLimit(targets, 2, async (playlist) => {
                try {
                  const detail = await getPlaylistDetail(source, playlist.id);
                  return (detail.tracks ?? []).slice(0, STYLE_PLAYLIST_TRACKS_MAX);
                } catch {
                  return [] as Track[];
                }
              });
              return details.flat();
            } catch {
              return [] as Track[];
            }
          });
          return rows.flat();
        } catch {
          return [] as Track[];
        }
      })().finally(() => {
        if (wantStylePlaylist) tick();
      })
    : [];

  const pool: Track[] = [];
  const seen = new Set<string>();
  for (const track of [
    ...favorites,
    ...byArtist.flat(),
    ...bySearch.flat(),
    ...latest,
    ...byAlbum,
    ...byStylePlaylist,
  ]) {
    if (!track || !track.id || !track.title) continue;
    const key = trackKey(track);
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push(track);
  }
  return pool;
}

/** 候选池 + 风格线：`tracks` 是去重合并后的全部候选，`laneOf` 是维度路带回来的 provenance */
export interface CandidatePoolResult {
  tracks: Track[];
  /** trackKey → 这条曲目来自哪几条风格线（第一条是主线） */
  laneOf: Map<string, string[]>;
  /** 由画像/搜索历史推出来的线（tag / 语种 / 相邻风格 / 搜索词）；榜单线不在内 */
  affinityLanes: Set<string>;
}

/**
 * 候选池 + 「更多维度」。
 *
 * v9 的核心改动：v8 及以前的 6 条取数路都是从「常听歌手 / 收藏 / 专辑 / 风格歌单」出发，
 * 拿到的几乎是同一批风格 —— 用户 2026-10-24 的原话是「风格能再多样一点，而不是只有那么
 * 一两个」。这里在原有 6 路之外并行跑一遍维度路（榜单 / 风格关键词 / 风格歌单 / 搜索历史），
 * 每首维度歌带上「它来自哪条线」的标签，交给 `interleaveByLanes` 与提示词使用。
 *
 * 两路并行而不是串行：维度路是加分项，串行会让本来 3 秒的生成拖到 6 秒；并行时哪怕维度路
 * 整体失败（它内部每条线也都 try/catch），基础池照常返回 —— 推荐页不能因为一个榜单接口
 * 超时就空着。
 */
export async function buildCandidatePoolWithLanes(
  pref: DailyPreference,
  source: string,
  options: CandidatePoolOptions = {},
): Promise<CandidatePoolResult> {
  const taste = options.taste ?? "heart";
  const profile = pref.style ?? buildStyleProfile({ samples: samplesFromPreference(pref) });
  // 本地音乐源没有榜单/在线搜索接口，维度路只会白跑一轮网络请求
  const dimensionPromise: Promise<DimensionLanes> =
    source === "local"
      ? Promise.resolve({ lanes: [], laneOf: new Map<string, string[]>() })
      : collectDimensionLanes({
          profile,
          playlistNames: pref.playlistNames ?? [],
          searchHistory: await getSearchHistory().catch(() => [] as string[]),
          taste,
          variant: options.variant,
          source,
          sources: (await readAggregateSources()) ?? undefined,
          onProgress: () => options.onProgress?.(1, 1),
        }).catch((): DimensionLanes => ({ lanes: [], laneOf: new Map() }));
  const [basePool, lanes] = await Promise.all([
    buildCandidatePool(pref, source, options),
    dimensionPromise,
  ]);

  const laneOf = new Map(lanes.laneOf);
  const tracks: Track[] = [];
  const seen = new Set<string>();
  for (const track of [...basePool, ...lanes.lanes.flatMap((lane) => lane.tracks)]) {
    if (!track || !track.id || !track.title) continue;
    const key = trackKey(track);
    if (seen.has(key)) continue;
    seen.add(key);
    tracks.push(track);
  }
  const affinityLanes = new Set(
    lanes.lanes.filter((lane) => lane.kind !== "chart").map((lane) => lane.label),
  );
  return { tracks, laneOf, affinityLanes };
}

/**
 * 按「风格线配额」把维度路的新歌补进规则排序结果（v9）。
 *
 * 为什么不是直接插进排序里：维度歌大多歌手陌生、没有播放证据，`rankCandidates` 会把它们
 * 压到 150 名之后；可用户要的是「前 50 首里能听见几种不同的风格」。所以先保住底盘 ——
 * 规则排序前 70% 原样收下，再给每条风格线补 `perLane` 首（线顺序 = 该线在排序里第一次
 * 出现的顺序，即越贴合越优先），最后按原序补满。
 *
 * `laneOf` 只认主线（`[0]`）：一首歌同时属于两条线时按更贴切的那条算，避免重复占额度。
 * 没有线标签的歌走 `ranked` 原序，不计额度 —— 它们本来就是「常规」底盘的一部分。
 */
export function diversifyByLanes(
  ranked: Track[],
  laneOf: Map<string, string[]>,
  target: number,
): Track[] {
  if (target <= 0 || ranked.length === 0) return [];
  const byLane = new Map<string, Track[]>();
  for (const track of ranked) {
    const label = laneOf.get(trackKey(track))?.[0];
    if (!label) continue;
    const list = byLane.get(label);
    if (list) list.push(track);
    else byLane.set(label, [track]);
  }
  if (byLane.size === 0) return ranked.slice(0, target);

  const laneCount = Math.min(LANE_DIVERSITY_MAX, byLane.size);
  const laneSlots = Math.min(Math.round(target * LANE_QUOTA_SHARE), target);
  const perLane = Math.max(1, Math.floor(laneSlots / laneCount));

  const chosen: Track[] = [];
  const taken = new Set<string>();
  const push = (track: Track): void => {
    const key = trackKey(track);
    if (taken.has(key) || chosen.length >= target) return;
    taken.add(key);
    chosen.push(track);
  };

  // 1) 底盘：规则排序最靠前的那批，保证「七成还是他最像他的」
  const coreSize = Math.max(1, target - laneSlots);
  for (const track of ranked.slice(0, coreSize)) push(track);

  // 2) 每条线按排序补到 perLane（已经进底盘的算在额度里）
  let laneIndex = 0;
  for (const tracks of byLane.values()) {
    if (laneIndex >= laneCount) break;
    let added = tracks.reduce((count, track) => count + (taken.has(trackKey(track)) ? 1 : 0), 0);
    for (const track of tracks) {
      if (added >= perLane) break;
      const key = trackKey(track);
      if (taken.has(key)) continue;
      push(track);
      added += 1;
    }
    laneIndex += 1;
  }

  // 3) 不够（维度歌总数或线数不足）就用原序补满
  for (const track of ranked) push(track);
  return chosen.slice(0, target);
}

// ---------- 规则筛选与排序 ----------

/** 每种口味最多让同一歌手占几条（50 首需要更多人参与，探索模式尤其要散） */
const TASTE_MAX_PER_SINGER: Record<DailyTaste, number> = {
  heart: DAILY_MAX_PER_SINGER,
  familiar: DAILY_MAX_PER_SINGER + 2,
  explore: 1,
};

/** 从偏好里重建画像（测试构造最小 `DailyPreference` 时用；正常路径直接用 `pref.style`） */
function samplesFromPreference(pref: DailyPreference): StyleSample[] {
  const samples: StyleSample[] = [];
  const seen = new Set<string>();
  const push = (track: Track, saved = false, stat?: TrackStat): void => {
    if (!track?.title) return;
    const key = trackKey(track);
    if (!key || seen.has(key)) return;
    seen.add(key);
    samples.push({ track, saved, stat });
  };
  for (const item of pref.topTracks ?? []) push(item.track, false, item.stat);
  for (const track of pref.favoriteTracks) push(track, true);
  for (const track of pref.playlistTracks) push(track, true);
  for (const track of pref.recentTracks) push(track);
  return samples;
}

/** 收藏键集合：`trackKey` 与 `songNameKey` 都收（跨源同歌换 id 也认得出） */
function savedKeySet(pref: DailyPreference): Set<string> {
  const keys = new Set<string>();
  for (const track of [...pref.favoriteTracks, ...pref.playlistTracks]) {
    keys.add(trackKey(track));
    keys.add(songNameKey(track));
  }
  return keys;
}

/**
 * 「换一批」时轮转起手歌手。
 *
 * MMR 选出来的第一首永远是分数最高的那首，同一天点多少次「换一批」第一位都不变。
 * 旧实现靠轮转歌手组的顺序解决，这里把同一件事做在选完之后：按歌手分块、轮转块的
 * 顺序、再贪心打散（第一首因此换成另一个歌手），集合不变、只改先后。
 */
function rotateLeaderByVariant(tracks: Track[], variant: string): Track[] {
  if (tracks.length <= 2) return tracks;
  const groups = new Map<string, Track[]>();
  for (const track of tracks) {
    const key = normText(track.singer) || "?";
    const bucket = groups.get(key);
    if (bucket) bucket.push(track);
    else groups.set(key, [track]);
  }
  const keys = [...groups.keys()];
  if (keys.length <= 1) return tracks;
  const rotate = hashString(variant) % keys.length;
  const ordered = [...keys.slice(rotate), ...keys.slice(0, rotate)].flatMap(
    (key) => groups.get(key) ?? [],
  );
  return spreadItemsBySinger(ordered, (track) => track.singer);
}

/**
 * 规则排序。
 *
 * **2026-10-23 重写**：用户反馈「不应该根据你听过的歌手去推荐，应该根据你之前听过
 * 歌曲的风格等等各方面综合一起去推荐」。旧版把打分完全压在"歌手排名"上，导致推荐
 * 永远在那几个名字里打转，而且"点开听 20 秒就切"和"一遍遍听完"同分。
 *
 * 现在真正的打分手在 `@/lib/recommend-rank`：它同时看**语种 / 时长带 / 专辑 /
 * 收藏 / 播放质量（完播比、重播、新鲜度）/ 是否听过 / 历史推荐**，再用 MMR 保证
 * 结果不聚成一团。本函数只负责把本地偏好翻译成引擎参数。
 *
 * 取歌方式也不是「按分数降序截断」：MMR + 每歌手/每语种配额双保险，同一个歌手
 * 在结果里天然被摊开（降序截断会让一个人连排最前面，用户实测「每次都是这个歌手」）。
 */
export function rankCandidates(
  pool: Track[],
  pref: DailyPreference,
  options: {
    /** 硬排除键（`trackKey` / `songNameKey` 都会比对） */
    excludeKeys?: Set<string>;
    /** 最近推荐过的键：只降权，池子耗尽时仍会兜底出歌 */
    historyKeys?: Set<string>;
    playedKeys?: Set<string>;
    dislikedFlags?: boolean[];
    dateKey?: string;
    target?: number;
    /** 口味（缺省心动，与旧行为最接近） */
    taste?: DailyTaste;
    /** 「换一批」用的变体种子：同一天点换一批能换出不同顺序，但不影响缓存复现 */
    variant?: string;
  } = {},
): Track[] {
  const excludeKeys = options.excludeKeys ?? new Set<string>();
  const dislikedFlags = options.dislikedFlags ?? [];
  const target = options.target ?? DAILY_TARGET;
  const taste = options.taste ?? "heart";
  const dateKey = options.dateKey ?? todayKey();

  // 去重（跨源同名同歌只留一首）+ 硬排除。引擎的 `disliked` 是按下标对齐的，
  // 所以过滤和标记必须在同一轮里做完。
  const input: Track[] = [];
  const flags: boolean[] = [];
  const seenName = new Set<string>();
  pool.forEach((track, index) => {
    if (!track || !track.id || !track.title) return;
    const nameKey = songNameKey(track);
    if (excludeKeys.has(trackKey(track)) || excludeKeys.has(nameKey)) return;
    if (seenName.has(nameKey)) return;
    seenName.add(nameKey);
    input.push(track);
    flags.push(dislikedFlags[index] === true);
  });

  const profile = pref.style ?? buildStyleProfile({ samples: samplesFromPreference(pref) });
  const engineOptions = {
    taste,
    target,
    maxPerSinger: TASTE_MAX_PER_SINGER[taste],
    variant: options.variant,
    dateKey,
    historyKeys: options.historyKeys,
    playedKeys: options.playedKeys,
    // 歌手榜是一手统计，但画像会因样本权重为 0 丢掉一部分歌 —— 两边合并才不会漏
    familiarSingers: familiarSingerKeys(pref),
    disliked: flags,
    quality: pref.qualities,
    savedKeys: savedKeySet(pref),
  };
  const picked = selectDiverse(scoreCandidates(input, profile, engineOptions), profile, engineOptions);
  const tracks = picked.map((entry) => entry.track);
  return options.variant ? rotateLeaderByVariant(tracks, options.variant) : tracks;
}

/** 规则模式的推荐理由：只陈述能验证的事实，不编故事 */
export function ruleReason(track: Track, pref: DailyPreference): string {
  const profile = pref.style ?? buildStyleProfile({ samples: samplesFromPreference(pref) });
  const style = trackStyle(track);
  const key = trackKey(track);
  const nameKey = songNameKey(track);
  const savedKeys = savedKeySet(pref);
  const hits: RankHit[] = [];
  if (savedKeys.has(key) || savedKeys.has(nameKey)) hits.push("saved");
  const albumWeight = style.albumKey ? (profile.albums[style.albumKey] ?? 0) : 0;
  if (albumWeight > 0) hits.push("same-album");
  // 歌手熟悉度有三个来源，必须分开判断，因为**理由文案不同**：
  // 1. 有播放证据（歌手榜 / 播放统计 / 最近在听）→ 可以说「你常听 X」；
  // 2. 只在收藏/歌单里 → 只能说「和你的收藏口味相近」（收藏 ≠ 听过，说「常听」是编故事）；
  // 3. 画像 `singers` 有权重但上面两处都查不到 → 仍在画像里，算熟悉（防御式兜底）。
  const playedSinger = isPlayedSinger(style.singerKey, pref);
  if (playedSinger) {
    hits.push("familiar-singer");
  } else if (isSavedSinger(style.singerKey, pref)) {
    hits.push("saved-singer");
  } else if (style.singerKey && (profile.singers[style.singerKey] ?? 0) > 0) {
    hits.push("familiar-singer");
  } else {
    hits.push("new-singer");
  }
  if (style.lang !== "und") {
    hits.push(style.lang === profile.mainLang ? "main-lang" : "other-lang");
  }
  if (style.band === profile.mainBand) hits.push("main-band");
  // 没听过要单独说出来：旧实现漏了这个命中，导致空画像时所有歌都落到
  // 兜底的「换一批看看」，理由成了没有信息量的噪声。
  if (!isPlayed(track, pref)) hits.push("unplayed");
  return reasonFor({ track, style, score: 0, hits }, profile, "heart");
}

/**
 * 「有播放证据」的歌手键集合。
 *
 * 三个来源都要收，缺一个就会出现「明明常听却报不出来」：
 * - `topSingers`：平台按播放次数直接排的榜，覆盖**全部历史**；
 * - `topTracks`：带完整统计的 200 首，能覆盖画像因样本权重为 0 而丢弃的歌；
 * - `recentTracks`：最近在听。
 *
 * **收藏/歌单里的歌手不算**：收藏 ≠ 听过。键的构造与 `trackStyle().singerKey` 完全一致
 * （整串 `normText`，不拆分），否则合唱曲「甲/乙」永远匹配不上。
 */
function familiarSingerKeys(pref: DailyPreference): Set<string> {
  const keys = new Set<string>();
  const add = (raw: string): void => {
    const key = normText(raw ?? "");
    if (key) keys.add(key);
  };
  for (const name of pref.topSingers) add(name);
  for (const item of pref.topTracks ?? []) add(item.track.singer);
  for (const track of pref.recentTracks) add(track.singer);
  return keys;
}

/** 该歌手是否有播放证据（常听榜 / 播放统计 / 最近播放） */
function isPlayedSinger(singerKey: string, pref: DailyPreference): boolean {
  if (!singerKey) return false;
  return familiarSingerKeys(pref).has(singerKey);
}

/** 该歌手是否只在收藏/歌单里出现过（没有任何播放证据） */
function isSavedSinger(singerKey: string, pref: DailyPreference): boolean {
  if (!singerKey) return false;
  const hit = (track: Track): boolean => normText(track.singer ?? "") === singerKey;
  return pref.favoriteTracks.some(hit) || pref.playlistTracks.some(hit);
}

/** 这首歌用户是否听过（播放统计 + 最近播放；收藏不算听过） */
function isPlayed(track: Track, pref: DailyPreference): boolean {
  const key = trackKey(track);
  const nameKey = songNameKey(track);
  const hit = (candidate: Track): boolean =>
    trackKey(candidate) === key || songNameKey(candidate) === nameKey;
  return (pref.topTracks ?? []).some((item) => hit(item.track)) || pref.recentTracks.some(hit);
}

/**
 * 把一批已选好的歌做**最小必要**的歌手摊开：相邻两首撞歌手才换位置。
 *
 * 规则排序本身是「按歌手轮流取」，所以喂给模型的候选池已经是「一首一个歌手」；
 * 但模型回的是它自己排的序，偶尔会把同一个歌手连着排（用户 2026-10-22 的实测截图
 * 就是前两首同一个歌手）。旧实现是贪心重排 —— 每步都去找「下一个不同歌手」，
 * 结果模型排的顺序被彻底打乱，歌单失去自己的叙事（开场/收尾全没了）。
 * 用户 2026-10-24 说 AI 结果「像随机选」，这个重排也是帮凶之一。
 *
 * 现在只做一次顺扫：发现相邻撞歌手，就往**后**找最近的一首不同歌手交换。
 * 第一首永远不动（那是模型最看好的，也是测试核对「序号 ↔ 曲目」回填的锚点）。
 * 只调顺序、不增删歌；歌手太少时允许残留重复（那是数学上躲不掉的）。
 */
export function spreadItemsBySinger<T>(items: T[], singerOf: (item: T) => string): T[] {
  if (items.length <= 2) return items.slice();
  const result = items.slice();
  const key = (item: T): string => normText(singerOf(item));
  for (let i = 1; i < result.length; i += 1) {
    const duplicate = key(result[i]);
    if (duplicate !== key(result[i - 1])) continue;
    for (let j = i + 1; j < result.length; j += 1) {
      if (key(result[j]) === duplicate) continue;
      const tmp = result[i];
      result[i] = result[j];
      result[j] = tmp;
      break;
    }
  }
  return result;
}

// ---------- 候选歌的「本地证据」 ----------

/**
 * 给提示词和校验共用的证据快照：一次算好，逐首查。
 *
 * 为什么要证据：模型只看到歌名/歌手/专辑/语种/时长，它能判断「风格像不像」，
 * 但判断不了「这首对你意味着什么」。给它「已收藏 / 听过 12 次 / 常听歌手 /
 * 常听专辑」这类本地事实，它才有东西可抓，推荐理由也才落得到实处。
 */
export interface EvidenceSnapshot {
  profile: StyleProfile;
  /** 收藏 + 歌单里的曲目键（trackKey 与 songNameKey 都算命中） */
  savedKeys: Set<string>;
  /** 有效播放次数：trackKey / songNameKey → 次数（播放统计的前 N 首） */
  playedCounts: Map<string, number>;
  /** 有播放证据的歌手（常听榜 / 播放统计 / 最近在听） */
  familiarSingers: Set<string>;
  /** 只在收藏/歌单里出现过的歌手 */
  savedSingers: Set<string>;
}

export function evidenceSnapshot(pref: DailyPreference): EvidenceSnapshot {
  const profile = pref.style ?? buildStyleProfile({ samples: samplesFromPreference(pref) });
  const playedCounts = new Map<string, number>();
  for (const item of pref.topTracks ?? []) {
    const count = Math.max(1, Math.round(item.stat.playCount));
    playedCounts.set(trackKey(item.track), count);
    playedCounts.set(songNameKey(item.track), count);
  }
  const savedSingers = new Set<string>();
  for (const track of [...pref.favoriteTracks, ...pref.playlistTracks]) {
    const key = normText(track.singer ?? "");
    if (key) savedSingers.add(key);
  }
  return {
    profile,
    savedKeys: savedKeySet(pref),
    playedCounts,
    familiarSingers: familiarSingerKeys(pref),
    savedSingers,
  };
}

/** 单首候选在本地数据里的依据 */
interface TrackEvidence {
  saved: boolean;
  /** 有效播放次数，0 表示没听过 */
  plays: number;
  familiarSinger: boolean;
  savedSinger: boolean;
  sameAlbum: boolean;
  /** 语种与画像主语种一致（画像定不下语种时为 false） */
  mainLang: boolean;
  /** 语种检测得出来、且这个语种在画像里的占比够（≥ `LANG_AFFINITY_MIN`） */
  langAffinity: boolean;
  /** 语种检测得出来、但画像里几乎没有这个语种 —— 只有这种才值得提醒模型 */
  otherLang: boolean;
  mainBand: boolean;
}

function trackEvidence(track: Track, snapshot: EvidenceSnapshot): TrackEvidence {
  const style = trackStyle(track);
  const key = trackKey(track);
  const nameKey = songNameKey(track);
  const { profile } = snapshot;
  const singer = style.singerKey;
  const langKnown = style.lang !== "und" && profile.mainLang !== "und";
  const langAffinity =
    style.lang !== "und" && profile.sampleSize > 0 && (profile.langs[style.lang] ?? 0) >= LANG_AFFINITY_MIN;
  return {
    saved: snapshot.savedKeys.has(key) || snapshot.savedKeys.has(nameKey),
    plays: Math.max(snapshot.playedCounts.get(key) ?? 0, snapshot.playedCounts.get(nameKey) ?? 0),
    familiarSinger:
      singer.length > 0 &&
      (snapshot.familiarSingers.has(singer) || (profile.singers[singer] ?? 0) > 0),
    savedSinger: singer.length > 0 && snapshot.savedSingers.has(singer),
    sameAlbum: style.albumKey.length > 0 && (profile.albums[style.albumKey] ?? 0) > 0,
    mainLang: langKnown && style.lang === profile.mainLang,
    langAffinity,
    otherLang: langKnown && style.lang !== profile.mainLang && !langAffinity,
    mainBand: style.band === profile.mainBand,
  };
}

/** 拼成行尾括号里那截证据文字（最多 3 条，按可信度排） */
function evidenceText(evidence: TrackEvidence): string[] {
  const marks: string[] = [];
  if (evidence.saved) marks.push("已收藏");
  if (evidence.plays > 0) marks.push(`听过${evidence.plays}次`);
  if (evidence.familiarSinger) marks.push("常听歌手");
  else if (evidence.savedSinger) marks.push("收藏歌手");
  if (evidence.sameAlbum) marks.push("常听专辑");
  // 和画像里所有语种都对不上 —— 这是模型最需要知道的一条，用来防「为了凑风格塞首英文歌」
  if (evidence.otherLang) marks.push("非主语种");
  return marks.slice(0, 3);
}

/**
 * 这首歌在本地数据里「有没有依据」。
 *
 * 语种/时长带属于**画像级**证据：只要语种对得上就算贴合（画像主语种就是用户八成以上
 * 的听歌语种）；歌手/专辑/收藏/播放属于**单曲级**证据，有就更能说明「这首真的是他的」。
 * 时长带单独不算依据 —— 三四分钟的歌满大街都是，它解释不了「为什么是这首」。
 *
 * v9 起多认两条：①画像里次要语种（≥5%）也算语种依据 —— 用户明确要「风格多变」，
 * 不能一边扩候选池一边把画像边缘的语种全剔掉；②来自**画像相关维度线**的歌
 * （`laneGrounded`，如古风/粤语/纯音乐这类由画像 tag/语种/搜索历史推出来的线）也算依据，
 * 它们本来就是「从用户的搜索维度里搜出来的」，不是随机尾巴。榜单里的通用热歌不算。
 */
function hasProfileGrounding(evidence: TrackEvidence, laneGrounded = false): boolean {
  return (
    evidence.saved ||
    evidence.plays > 0 ||
    evidence.familiarSinger ||
    evidence.savedSinger ||
    evidence.sameAlbum ||
    evidence.mainLang ||
    evidence.langAffinity ||
    laneGrounded
  );
}


// ---------- 提示词 ----------

/**
 * 组装发给模型的 messages；候选池就是编号清单，模型只能回序号。
 *
 * `taste` 决定「按什么方向挑」，写进 user 段；缺省心动模式。
 *
 * **2026-10-23**：提示词从「常听歌手清单」改成「口味画像 + 每首候选的风格特征」。
 * 只报歌手名等于让模型也按歌手推 —— 那正是用户反对的做法。现在告诉它
 * 语种/时长带/风格词，并把每首候选的语种和专辑标在行尾，模型才有风格依据。
 *
 * **2026-10-24（v8）**：用户反馈结果「像随机选」。库里当天的 AI 歌单坐实了原因 ——
 * 提示词里那两句「不要直接照抄前 50 首」「尽量分散在不同歌手和不同风格」，把模型
 * 推向了「按风格种类凑拼盘」，最后四首甚至是毫无关系的英文歌。这一版反过来写：
 * 1. 明确告诉它**清单已按贴合度从高到低排序，越靠前越贴合**，优先挑靠前的；
 * 2. 每行括号里补上**时长带**（原来正文提到「时长」却从没给过数据）和
 *    **本地行为证据**（已收藏 / 听过 N 次 / 常听歌手 / 常听专辑 / 非主语种）；
 * 3. 显式给出语种下限（「50 首里至少 40 首是华语」）—— 小模型对具体数字比
 *    对形容词敏感；
 * 4. 删掉所有「求分散」的措辞，改成「求主题一致」；理由也必须落到画像上，
 *    逼模型为每一首找出依据，而不是随手点名。
 * 5. 但也不能让它整份照抄前 50 首 —— 那样 AI 推荐又变回「和规则推荐一模一样」
 *    （用户 2026-10-23 的原始抱怨）。折中是：从第 51–90 首里换进 6–10 首
 *    （规则前 90 首都算贴合，只是播放次数更低），播放顺序按听说曲线自己排；
 *    真超额的由 app 侧 `limitAiPicks` 封顶（12 首），不指望小模型自觉。
 *
 * **2026-10-24（v9）**：v8 之后用户又说「风格能再多样一点，而不是只有那么一两个」。
 * 病根不在提示词，而在候选池 —— 6 条取数路全围着常听歌手/专辑/风格歌单转，池子里
 * 只有古风/抒情两条线。v9 从取数侧扩维度后，提示词相应改成「多线」口径：
 * 1. 每行括号里标出**这首歌来自哪条风格线**（榜单/关键词/风格歌单），候选清单本身
 *    就带着线的分布，模型不用猜；
 * 2. 画像里补上**语种分布**（华语 82%、日语 8%…），让「次要语种」有据可依；
 * 3. 心/熟口味从「宁可整张集中在主风格」改成「覆盖 3–5 条线、主风格约一半、
 *    相邻线各 4–10 首」，并保留「每条线都要能说出理由」防止滑回凑拼盘；
 * 4. 语种下限保留（50 首至少 40 首华语），但把「剩下的 N 首」明确指给画像里的
 *    其它语种 —— 否则模型要么全挑主语种，要么又去挑无关英文歌。
 */
export function buildPrompt(
  pool: Track[],
  pref: DailyPreference,
  pickCount: number,
  taste: DailyTaste = "heart",
  laneOf?: Map<string, string[]>,
): { role: "system" | "user"; content: string }[] {
  const snapshot = evidenceSnapshot(pref);
  const profile = pref.style ?? snapshot.profile;
  // 候选池里出现了哪些风格线、每条线几首 —— 用来给模型可对账的「线清单」
  const laneCount = new Map<string, number>();
  for (const track of pool) {
    const label = laneOf?.get(trackKey(track))?.[0] ?? "";
    if (label) laneCount.set(label, (laneCount.get(label) ?? 0) + 1);
  }
  const laneRank = [...laneCount.entries()].sort((a, b) => b[1] - a[1]);
  const lines = pool.map((track, index) => {
    const style = trackStyle(track);
    const marks: string[] = [];
    const lane = laneOf?.get(trackKey(track))?.[0] ?? "";
    if (lane) marks.push(`风格线：${lane}`);
    if (track.album) marks.push(track.album);
    if (style.lang !== "und") marks.push(MUSIC_LANG_LABEL[style.lang]);
    marks.push(DURATION_BAND_LABEL[style.band]);
    const evidence = evidenceText(trackEvidence(track, snapshot));
    const detail = [marks.join(" / "), evidence.join("·")]
      .filter((part) => part.length > 0)
      .join("；");
    return `${index + 1}. ${track.title} - ${track.singer}（${detail}）`;
  });
  const profileText = pref.style ? describeProfile(profile) : "口味还不明显";
  const tagText =
    profile.tags.length > 0 ? profile.tags.slice(0, 4).join("、") : "（暂无）";
  const singerText = pref.topSingers.slice(0, 6).join("、") || "（暂无）";
  const recentText =
    pref.recentTracks
      .slice(0, 5)
      .map((track) => `${track.title}-${track.singer}`)
      .join("、") || "（暂无）";
  const system = [
    "你是音乐推荐助手。你会收到一份客户端已经搜索好的候选歌曲清单，",
    "你只能从清单里挑选，绝不能编造清单之外的歌曲，也不能输出歌曲 ID。",
    "你的目标是让这份歌单听起来像同一个人按同一套口味挑出来的，",
    "同时要覆盖他常听的几种风格线，而不是只挑一条线、也不是随机抽样拼盘。",
    "只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码围栏。",
  ].join("");
  // 语种分布：v9 要告诉模型「他不是只听华语」，画像里的次要语种也允许上桌。
  // 没有这一行，「风格更多变」在提示词里就只剩一句空话。
  const langEntries = Object.entries(profile.langs)
    .filter(([, share]) => (share ?? 0) >= LANG_AFFINITY_MIN)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, 3) as [keyof typeof MUSIC_LANG_LABEL, number][];
  const langDistText =
    langEntries.length > 1
      ? `画像里的语种分布：${langEntries
          .map(([lang, share]) => `${MUSIC_LANG_LABEL[lang]} ${Math.round(share * 100)}%`)
          .join("、")}`
      : null;
  const mainLangLabel = profile.mainLang !== "und" ? MUSIC_LANG_LABEL[profile.mainLang] : "";
  const otherLangLabels = langEntries
    .filter(([lang]) => lang !== profile.mainLang)
    .map(([lang]) => MUSIC_LANG_LABEL[lang]);
  // 语种下限：画像主语种定得下来时，给小模型一个能对账的数字。
  // 「别挑奇怪的歌」它听不懂，「至少 40 首华语」它听得懂。
  // v9 起给「剩下的 N 首」一条明路：可以从画像里出现过的其它语种里挑 —— 否则模型
  // 要么只能全挑主语种（和 v8 一样单调），要么又滑回凑拼盘。
  const langLine =
    profile.mainLang !== "und"
      ? taste === "explore"
        ? `他平时主要听${mainLangLabel}：这次可以换歌手换风格、多碰几条线，但主语种别整体放弃（${pickCount} 首里至少 ${Math.round(
            pickCount * 0.5,
          )} 首是${mainLangLabel}）。`
        : `他平时主要听${mainLangLabel}：${pickCount} 首里请至少有 ${Math.round(
            pickCount * 0.8,
          )} 首是${mainLangLabel}${
            otherLangLabels.length > 0
              ? `；剩下的 ${pickCount - Math.round(pickCount * 0.8)} 首可以从画像里的其它语种里挑（${otherLangLabels.join(
                  " / ",
                )}），但别选画像里完全没出现过的语种`
              : ""
          }。`
      : null;
  const mainBandLabel = DURATION_BAND_LABEL[profile.mainBand];
  // 风格线：候选池里真有几条线，就按实际条数给目标；一条都没有时退回「2–3 种不同风格」。
  // 线数 ≤3 时直接说「覆盖 N 条」——只有 3 条线却要求「覆盖 3–5 条」是指向不存在的候选。
  const laneGoalMax = Math.min(LANE_GOAL_MAX, Math.max(1, laneRank.length));
  const laneGoal = laneRank.length >= 4 ? `3–${laneGoalMax}` : String(laneRank.length);
  const laneListText = laneRank
    .slice(0, 6)
    .map(([label, count]) => `${label}（${count} 首）`)
    .join("、");
  const mainLaneLabel = laneRank[0]?.[0] ?? "";
  // 多风格目标：v8 的「宁可整张歌单都集中在主风格上」正是 v9 要修的病 ——
  // 用户说「只有那么一两个风格」。改成「覆盖 3–5 条线、主风格约一半、相邻线各 4–10 首」，
  // 同时用「每条线都要能说出理由」防止退回凑拼盘。
  const laneRule =
    laneRank.length > 0
      ? `这张歌单要覆盖 ${laneGoal} 条不同的「风格线」（每行括号里标了这首歌来自哪条线；候选里一共 ${
          laneRank.length
        } 条：${laneListText}）：${
          mainLaneLabel ? `「${mainLaneLabel}」` : "主风格线"
        }占一半左右（约 ${Math.round(
          pickCount / 2,
        )} 首），再从里面挑 2–4 条相邻的线各 4–10 首。同一条线内部要连贯，线跟线之间要听得出区别（语种 / 风格 / 情绪 / 场景 / 年代都算一条线）。`
      : `这张歌单要有 2–3 种明显不同的风格（语种 / 风格 / 情绪 / 场景 / 年代都算），不要 50 首都是同一种；同一类内部要连贯。`;
  // 用 ①②③ 而不是 1. 2. 3.：候选清单本身就是「序号. 歌名」的格式，
  // 再用数字编号规则会被模型（以及测试里的行解析）当成候选行。
  // 中段穿插：只有池子确实比 pickCount 长、且中段还有歌时才写这条，
  // 否则（池子刚好 50 首 / 候选太少）说「从第 51 首挑」会指向不存在的行。
  const midFrom = pickCount + 1;
  const midTo = Math.min(DAILY_AI_CORE, pool.length);
  const midCount = midTo - midFrom + 1;
  const midRule =
    midCount >= 6
      ? `别把清单前 ${pickCount} 首整份照抄：第 ${midFrom}–${midTo} 首里也有风格贴合、只是播放次数不高的歌，请从中挑 6–${Math.min(10, midCount)} 首换进来（换进来的一定要带证据）；播放顺序按「开场 → 沉浸 → 收束」自己排，不要照抄清单顺序。`
      : midCount >= 1
        ? `别把清单前 ${pickCount} 首整份照抄：第 ${midFrom}–${midTo} 首里也有风格贴合、只是播放次数不高的歌，可以挑 ${midCount} 首换进来；播放顺序按「开场 → 沉浸 → 收束」自己排，不要照抄清单顺序。`
        : null;
  // 编号不写死（中段那条可能整体不出现），按最终条数补齐 ①②③……
  const rules = (
    taste === "explore"
      ? [
          "清单已经按「和画像的贴合度」从高到低排好，越靠前越贴合；这次用户想探索，优先挑靠前、歌手陌生、但风格仍在他接受范围内的歌。",
          laneRank.length > 0
            ? `这张歌单要覆盖 ${laneGoal} 条风格线，其中至少 2 条是他平时不常听的（新风格 / 新语种 / 新年代）；每条线至少要 3 首，否则听不出一条线。`
            : "这张歌单要覆盖 2–3 种明显不同的风格，其中至少 2 种是他平时不常听的。",
          "括号里标了「非主语种」的歌可以挑，但要有风格线支撑（属于某条相邻的线），别整张歌单变成随机拼盘。",
          `同一位歌手最多 ${DAILY_MAX_PER_SINGER} 首；不要重复挑同一首。`,
          "每首理由写清「哪里不一样」（新歌手 / 新风格 / 新语种 / 新的年代），不要写「值得一听」这种空话。",
          "title 和 summary 要写出这张歌单的多风格结构（例如「古风打底，掺几首粤语和纯音乐」），不要只写一个主题。",
        ]
      : [
          "清单已经按「和画像的贴合度」从高到低排好，越靠前越贴合：优先挑靠前的歌，以及括号里带「已收藏 / 听过 / 常听歌手 / 常听专辑」证据的歌。",
          laneRule,
          "但别为了「看起来多样」去挑和画像无关的歌：每条线都要能说出它为什么适合他（来自他的收藏 / 常听歌手 / 主语种 / 搜索过的词）；括号里标了「非主语种」、又不在任何一条线里的歌不要选。",
          `同一位歌手最多 ${DAILY_MAX_PER_SINGER} 首；不要重复挑同一首；清单最前面几首明显贴合的歌不要漏掉。`,
          ...(midRule ? [midRule] : []),
          "每首理由必须点出「这条风格线 + 和画像的对应」（例如「古风线里最接近你的收藏」「粤语线，和你常听的陈奕迅同语种」），不要写「值得一听」「很有感觉」这种空话。",
          "title 和 summary 要写出这张歌单的多风格结构（例如「古风打底，掺几首粤语和纯音乐」），不要只写一个主题。",
        ]
  ).map((rule, index) => `${RULE_MARKS[index] ?? `${index + 1}.`} ${rule}`);
  const user = [
    `候选歌曲（共 ${pool.length} 首）：`,
    ...lines,
    "",
    `用户的音乐口味画像：${profileText}`,
    `画像里的风格标签：${tagText}`,
    ...(langDistText ? [langDistText] : []),
    `画像的主时长带：${mainBandLabel}`,
    `用户的常听歌手：${singerText}`,
    `用户最近在听：${recentText}`,
    "",
    TASTE_PROMPT[taste],
    ...(langLine ? [langLine] : []),
    `请从上面挑 ${pickCount} 首，按「你希望他今天按什么顺序听」排好（第 1 首是开场），并覆盖上面说的几条风格线；每首给一句不超过 20 字的中文推荐理由。`,
    "括号里依次是：风格线（如果这首歌来自额外维度的搜索）/ 专辑 / 语种 / 时长带，以及本地收听证据（已收藏 / 听过 N 次 / 常听歌手 / 常听专辑 / 非主语种）；挑选时优先用有证据、有线可归的歌。",
    ...rules,
    "输出格式：",
    '{"title":"今天歌单的一句话主题","summary":"一句话说明","picks":[{"index":1,"reason":"理由"}]}',
    "index 必须是上面清单里的序号。",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** 模型回执解析结果 */
export interface ParsedPicks {
  title: string;
  summary: string;
  picks: { index: number; reason: string }[];
  /** 解析失败原因（成功为 null） */
  error: string | null;
}

/**
 * 把小模型常见「差一点就是合法 JSON」的输出修回来。
 *
 * 实测（`deepseek-v4.1-flash` 走中转站）最常见的两种坏法：
 * 1. 理由里写了裸换行 —— JSON 字符串里 `\n` 必须是转义序列，裸换行直接让 `JSON.parse` 抛错；
 * 2. 数组/对象最后一个元素后面多一个逗号。
 *
 * 这两种都不改变模型的意思，修回来是还原、不是编造；真正的语义问题（越界、重复）
 * 仍由后面的硬校验拦。**不碰中文引号** —— 理由里出现「“周杰伦”」是正常文本，
 * 全局替换成 ASCII 引号反而会把合法 JSON 弄坏。
 */
function repairJsonText(text: string): string {
  // 逐字符替换控制字符而不是用正则字符类：`/[\u0000-\u001f]/` 会触发 eslint 的
  // no-control-regex，而这个替换本身是正当的（JSON 里字符串内不许有裸控制字符）。
  let repaired = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    repaired += code < 0x20 ? " " : ch;
  }
  return repaired.replace(/,\s*([}\]])/g, "$1");
}

/** 从坏了但还能看出结构的回执里捞序号（JSON 彻底解析不了时的最后一手） */
function salvagePicks(raw: string, poolSize: number): { index: number; reason: string }[] {
  const picks: { index: number; reason: string }[] = [];
  const used = new Set<number>();
  const push = (index: number, reason: string): void => {
    if (!Number.isInteger(index) || index < 1 || index > poolSize || used.has(index)) return;
    used.add(index);
    picks.push({ index, reason: reason.slice(0, 30) });
  };
  // 形态 A：`{"picks":[{"index":3,"reason":"…"}, …]}` —— 按 `"index":` 切成若干段逐段捞
  for (const chunk of raw.split(/"index"\s*:/).slice(1)) {
    const head = chunk.match(/^\s*"?(\d{1,4})"?/);
    if (!head) continue;
    const reason = chunk.slice(head[0].length).match(/"reason"\s*:\s*"([^"\\]{0,60})/);
    push(Number(head[1]), reason ? reason[1].trim() : "");
  }
  // 形态 B：`{"picks":[3,17,42]}` —— 小模型偷懒只给序号数组
  if (picks.length === 0) {
    const arr = raw.match(/"picks"\s*:\s*\[([\d,\s]+)\]/);
    if (arr) for (const seg of arr[1].split(",")) push(Number(seg.trim()), "");
  }
  return picks;
}

/** 从回执文本里捞一个字符串字段（title/summary 兜底用） */
function salvageField(raw: string, field: string, max: number): string {
  const hit = raw.match(new RegExp(`"${field}"\\s*:\\s*"([^"\\\\]{0,${max * 2}})`));
  return hit ? hit[1].trim().slice(0, max) : "";
}

/** 硬校验：序号必须在 1..poolSize 内、不能重复；`Number(true)` 那类"看似合法"的值不收 */
function normalizePicks(rawPicks: unknown[], poolSize: number): { index: number; reason: string }[] {
  const picks: { index: number; reason: string }[] = [];
  const used = new Set<number>();
  for (const item of rawPicks) {
    // 允许 `[3, 17, 42]` 这种纯序号写法（同样的越界/重复规则）
    if (typeof item === "number" || (typeof item === "string" && /^\d+$/.test(item.trim()))) {
      const index = typeof item === "number" ? item : Number(item.trim());
      if (!Number.isInteger(index) || index < 1 || index > poolSize || used.has(index)) continue;
      used.add(index);
      picks.push({ index, reason: "" });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    // 只接受数字或纯数字字符串：`Number(true)` 也会得到 1，放过布尔值等于接受
    // 一个模型根本没给的序号（那不是"纠正"，是替它编）。
    const rawIndex = entry.index;
    const index =
      typeof rawIndex === "number"
        ? rawIndex
        : typeof rawIndex === "string" && /^\d+$/.test(rawIndex.trim())
          ? Number(rawIndex.trim())
          : Number.NaN;
    if (!Number.isInteger(index)) continue;
    if (index < 1 || index > poolSize) continue;
    if (used.has(index)) continue;
    used.add(index);
    const reason = typeof entry.reason === "string" ? entry.reason.trim().slice(0, 30) : "";
    picks.push({ index, reason });
  }
  return picks;
}

/**
 * 解析模型输出并做**硬校验**：序号必须在 1..pool.length 内、不能重复。
 *
 * 越界/重复的条目直接丢（不是纠正成别的歌 —— 纠正等于替模型编造）。
 * 整段解析不出来才返回 error，调用方退回规则结果。
 *
 * **2026-10-23**：用户反馈「感觉不出 AI 推荐和规则推荐有什么不同」，排查发现当天的
 * 缓存是 `mode=rule` + notice「模型返回的 JSON 无法解析」—— AI 整条链路其实失败了，
 * 用户看的是规则结果。小模型偶尔多写一个裸换行就整批作废，代价太大，所以这里按
 * 「先修后捞」三级降级：原样解析 → 修复后解析（裸换行/尾逗号）→ 正则捞序号。
 */
export function parsePicks(raw: string, poolSize: number): ParsedPicks {
  const json = extractJsonObject(raw);
  if (!json) {
    // 模型偷懒只回了一排序号：`[3,7,9]`
    const arrayText = extractJsonArray(raw);
    if (arrayText) {
      try {
        const picks = normalizePicks(JSON.parse(arrayText), poolSize);
        if (picks.length > 0) return { title: "", summary: "", picks, error: null };
      } catch {
        // 数组也坏了，继续用正则捞
      }
    }
    const picks = salvagePicks(raw, poolSize);
    if (picks.length === 0) return { title: "", summary: "", picks: [], error: "模型没有返回 JSON" };
    return {
      title: salvageField(raw, "title", 40),
      summary: salvageField(raw, "summary", 120),
      picks,
      error: null,
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    try {
      data = JSON.parse(repairJsonText(json));
    } catch {
      // 结构都读不出来（例如理由里没转义的引号把字符串截断了）：捞序号总比整批作废强
      const picks = salvagePicks(raw, poolSize);
      if (picks.length === 0) {
        return { title: "", summary: "", picks, error: "模型返回的 JSON 无法解析" };
      }
      return {
        title: salvageField(raw, "title", 40),
        summary: salvageField(raw, "summary", 120),
        picks,
        error: null,
      };
    }
  }
  if (!data || typeof data !== "object") {
    return { title: "", summary: "", picks: [], error: "模型返回的不是对象" };
  }
  const obj = data as Record<string, unknown>;
  const title = typeof obj.title === "string" ? obj.title.trim().slice(0, 40) : "";
  const summary = typeof obj.summary === "string" ? obj.summary.trim().slice(0, 120) : "";
  const picks = normalizePicks(Array.isArray(obj.picks) ? obj.picks : [], poolSize);
  if (picks.length === 0) {
    return { title, summary, picks, error: "模型没有给出有效的候选序号" };
  }
  return { title, summary, picks, error: null };
}

// ---------- 主流程 ----------

/**
 * 从规则结果里挑出交给模型的候选池。
 *
 * 规则前 `DAILY_AI_CORE` 首必进（它们是最符合口味的那批，模型不该被剥夺选择权），
 * 其余名额从尾巴里按 `variant` 轮转取样 —— 不这么做的话，「换一批」之后模型看到的
 * 还是同一批歌，AI 模式就退化成「给规则歌单换个顺序」。
 */
export function pickAiPool(picked: Track[], variant?: string): Track[] {
  if (picked.length <= DAILY_AI_POOL_MAX) return picked.slice();
  const coreSize = Math.min(DAILY_AI_CORE, picked.length);
  const core = picked.slice(0, coreSize);
  const rest = picked.slice(coreSize);
  if (rest.length === 0) return core;
  const tail: Track[] = [];
  const want = DAILY_AI_POOL_MAX - core.length;
  const offset = variant ? hashString(variant) % rest.length : 0;
  for (let i = 0; i < rest.length && tail.length < want; i += 1) {
    tail.push(rest[(offset + i) % rest.length]);
  }
  return [...core, ...tail];
}

/**
 * 模型挑好的歌，再过一道「本地有没有依据」的校验。
 *
 * 为什么要这道闸：2026-10-24 库里那批 AI 结果的最后四首是英文歌和一首粤语说唱，
 * 用户画像却是「华语 · 三四分钟 · 常听古风」—— 提示词再怎么改，小模型偶尔还是会
 * 「为了不一样」从 150 首候选的尾部摸几首凑数。用户看不出模型为什么选它，只能
 * 得出一个结论：像随机选的。
 *
 * 校验只用本地事实：收藏、听过、常听歌手、收藏歌手、常听专辑、主语种一致。
 * 一条都不占的歌直接丢掉，由调用方用规则结果补位（规则结果本身就能给出理由）。
 * `explore` 口味**不校验** —— 探索本来就要推陌生歌，拿画像去筛会把它筛空。
 */
/**
 * 风格线信息：只给「有没有依据」这道闸用。
 *
 * `laneOf` 是维度搜索带回来的 provenance（`trackKey` → 这条歌来自哪几条风格线），
 * `affinityLanes` 是其中**由画像/搜索历史推出来**的线（tag/语种/相邻风格/搜索词），
 * 榜单线（热歌榜/飙升榜）不算 —— 榜单上的歌谁都能看见，不能当「他的依据」。
 */
export interface AiLaneOptions {
  laneOf?: Map<string, string[]>;
  affinityLanes?: Set<string>;
}

/** 这首歌是不是来自一条「和画像有关」的风格线 */
function laneGrounded(track: Track, lanes: AiLaneOptions | undefined): boolean {
  if (!lanes?.laneOf || !lanes.affinityLanes || lanes.affinityLanes.size === 0) return false;
  const labels = lanes.laneOf.get(trackKey(track)) ?? [];
  return labels.some((label) => lanes.affinityLanes?.has(label) ?? false);
}

export function filterAiPicks(
  items: DailyRecommendItem[],
  pref: DailyPreference,
  taste: DailyTaste,
  lanes?: AiLaneOptions,
  snapshotIn?: EvidenceSnapshot,
): DailyRecommendItem[] {
  if (taste === "explore") return items.slice();
  // 快照由调用方传进来时复用（limitAiPicks 紧接着也要用同一份）；
  // 单独调用（测试 / 其它入口）仍按 pref 现算，语义不变。
  const snapshot = snapshotIn ?? evidenceSnapshot(pref);
  if (snapshot.profile.mainLang === "und" && snapshot.profile.sampleSize === 0) {
    // 画像还没成形时无从判断「有没有依据」，硬筛等于随机砍一刀
    return items.slice();
  }
  return items.filter((item) =>
    hasProfileGrounding(
      trackEvidence(item.track, snapshot),
      laneGrounded(item.track, lanes),
    ),
  );
}

/**
 * 把模型回的序号翻成歌，并给「规则前 50 首之外」的挑选封顶。
 *
 * 为什么要封顶：`buildPrompt` 里让模型「从第 51–90 首里挑 6–10 首换进来」，
 * 实测小模型经常超额 —— 一轮 50 首里有 30 首来自中段，歌单立刻从「贴合」滑向
 * 「不知道从哪冒出来的歌」。提示词管不住的部分就用代码管：中段最多留
 * `DAILY_AI_OFF_CORE_MAX` 首（约 1/4），而且每首都必须过「画像依据」校验。
 * 主干仍是规则前 50 首，所以结果既不会和规则推荐一模一样，也不会像随机抽样。
 *
 * `explore` 口味不封顶：探索本来就要推清单后面的陌生歌。
 */
export function limitAiPicks(
  picks: { index: number; reason: string }[],
  pool: Track[],
  pref: DailyPreference,
  taste: DailyTaste,
  lanes?: AiLaneOptions,
  snapshotIn?: EvidenceSnapshot,
): DailyRecommendItem[] {
  const items: DailyRecommendItem[] = [];
  const explore = taste === "explore";
  const snapshot = snapshotIn ?? evidenceSnapshot(pref);
  let offCore = 0;
  for (const pick of picks) {
    const track = pool[pick.index - 1];
    if (!track) continue;
    if (!explore && pick.index > DAILY_TARGET) {
      if (offCore >= DAILY_AI_OFF_CORE_MAX) continue;
      if (!hasProfileGrounding(trackEvidence(track, snapshot), laneGrounded(track, lanes))) continue;
      offCore += 1;
    }
    items.push({ track, reason: pick.reason || ruleReason(track, pref) });
  }
  return items;
}

/** 模型挑选最多问几次：第一次被截断/写坏，再问一次通常就好了 */
const AI_PICK_ATTEMPTS = 2;

/**
 * 第一次调模型的温度。
 *
 * 老代码是 0.8（「保留多样性」），但推荐不是写诗：0.8 下同一个候选池两次能给出
 * 差别很大的歌单，用户眼里的表现就是「随机」。降到 0.4 —— 还留一点措辞变化，
 * 但「挑哪几首」主要由清单顺序和证据决定，同一天重算结果基本稳定。
 */
const AI_PICK_TEMPERATURE = 0.4;

/** 重试温度：这次只要格式，不要再换一批歌 */
const AI_PICK_RETRY_TEMPERATURE = 0.2;

/**
 * 让模型从候选池里挑，带一次重试。
 *
 * 为什么要重试：小模型的失败是**偶发**的（实测同一份提示词三次里能有一次多写个
 * 裸换行），而一次失败就是整天退回规则结果 —— 用户看到的就是「AI 模式没区别」。
 * 第一次用正常温度（保留多样性），第二次压低温度并明说「上次不是合法 JSON」，
 * 让它把格式收回来。
 */
async function askModelForPicks(
  pool: Track[],
  pref: DailyPreference,
  pickCount: number,
  taste: DailyTaste,
  laneOf?: Map<string, string[]>,
): Promise<{ parsed: ParsedPicks; model: string }> {
  const messages = buildPrompt(pool, pref, pickCount, taste, laneOf);
  const minPicks = Math.min(DAILY_AI_MIN_PICKS, pool.length);
  let lastError = "模型挑得太少";
  let model = "";
  for (let attempt = 1; attempt <= AI_PICK_ATTEMPTS; attempt += 1) {
    const payload =
      attempt === 1
        ? messages
        : [
            ...messages,
            {
              role: "user" as const,
              content:
                "上一次的输出不是合法 JSON（可能有裸换行、多余逗号或多说了话）。请重新只输出一个 JSON 对象：字符串里不许有换行，不要解释，不要 markdown 代码围栏。",
            },
          ];
    const reply = await ipc.aiLocalChat(
      payload,
      attempt === 1 ? AI_PICK_TEMPERATURE : AI_PICK_RETRY_TEMPERATURE,
    );
    if (reply.model) model = reply.model;
    const parsed = parsePicks(reply.content, pool.length);
    if (!parsed.error && parsed.picks.length >= minPicks) return { parsed, model };
    lastError = parsed.error ?? "模型挑得太少";
  }
  throw new Error(lastError);
}


/**
 * 服务端 AI 精选：借音乐助手跑一轮，把回执解析成 picks。
 *
 * 两段容错：先按每日推荐的契约（`{"title","summary","picks":[{"index"}]}`）解析；
 * 解析不出来（服务端助手往往直接说人话 + 给 `song_list` 块）就把块里的曲目按
 * `trackKey` 对回候选池序号，理由用规则文案垫上 —— 宁可理由是模板的，也别因为
 * 格式不同就整批退回规则。
 */
async function pickByServer(
  pool: Track[],
  pref: DailyPreference,
  pickCount: number,
  taste: DailyTaste,
  laneOf: Map<string, string[]> | undefined,
): Promise<{ parsed: ParsedPicks; model: string }> {
  const reply = await askServerForPicks({
    pool,
    messages: buildPrompt(pool, pref, pickCount, taste, laneOf),
  });
  const parsed = parsePicks(reply.content, pool.length);
  if (!parsed.error && parsed.picks.length >= DAILY_AI_MIN_PICKS) {
    return { parsed, model: reply.model };
  }

  const indexOf = new Map(pool.map((track, index) => [trackKey(track), index + 1] as const));
  const picks: ParsedPicks["picks"] = [];
  for (const track of reply.tracks) {
    const index = indexOf.get(trackKey(track));
    if (index === undefined) continue;
    if (picks.some((pick) => pick.index === index)) continue;
    picks.push({ index, reason: ruleReason(track, pref) });
  }
  if (picks.length === 0) throw new Error(parsed.error ?? "服务端没挑出可用的歌");
  return { parsed: { title: "", summary: "", picks, error: null }, model: reply.model };
}

export interface GenerateOptions {
  /** 强制重算（「换一批」）；默认命中当天缓存就直接返回 */
  force?: boolean;
  /** 指定模式；不传读设置 */
  mode?: DailyRecommendMode;
  /** 指定口味；不传读设置 */
  taste?: DailyTaste;
  onProgress?: (text: string) => void;
}

/**
 * 读当前设置的 AI 模式（全局，音乐助手共用）。
 *
 * 读的是**当前账号的有效模式**而不是库里的原值：「服务端 AI」只对管理员开放
 * （2026-10-24），非管理员存过 server 也按 rule 返回 —— 页面据这个值决定缓存键，
 * 否则会命中一份服务端生成的旧缓存、把「隐藏了却还在用」的观感做实。
 * 需要原值时用 `@/lib/ai-mode` 的 `readAiMode()`（设置页判「存过的就是服务端」用它）。
 */
export async function readMode(): Promise<DailyRecommendMode> {
  return resolveAiMode(await readAiMode(), isAdmin(useAuthStore.getState().profile));
}

/** 保存 AI 模式（全局，音乐助手共用） */
export async function saveMode(mode: DailyRecommendMode): Promise<void> {
  await saveAiMode(mode);
}

/**
 * 生成当天推荐。命中缓存直接返回（除非 `force`）。
 *
 * 流程：读偏好 → 多路搜候选（全部音源）→ 批量查屏蔽 → 按口味规则排序
 * → 可选交给模型精选 → 落缓存。
 */
export async function generateDailyRecommend(
  options: GenerateOptions = {},
): Promise<DailyRecommendResult> {
  // 模式与口味互不依赖（各自一次本地设置读），并行取，少一次往返
  const [storedMode, storedTaste] = await Promise.all([
    options.mode ? Promise.resolve(options.mode) : readMode(),
    options.taste ? Promise.resolve(options.taste) : readTaste(),
  ]);
  const stored = storedMode;
  // 「服务端 AI」仅管理员（2026-10-24）：库里存过 server、或调用方显式传 server，
  // 非管理员一律按纯规则跑。`requested` 也记成收敛后的规则 —— 缓存命中判定比的是
  // `requested`，记成 server 的话非管理员每次进页面都对不上缓存、每天重算一遍。
  const requested = resolveAiMode(stored, isAdmin(useAuthStore.getState().profile));
  const mode = requested;
  /** 用户存的是服务端模式、当前却被降级：规则分支要说明一句，不能默默变样 */
  const downgradedFromServer = stored === "server" && requested !== "server";
  const taste = storedTaste;
  if (!options.force) {
    const cached = await loadTodayResult(mode, taste);
    if (cached) return cached;
  }

  const report = options.onProgress ?? (() => {});
  const cache = await readDailyCache();
  // 最近推荐过的**只降权不硬排除**：50 首 × 7 天足够把候选池掏空，
  // 硬排除会让页面直接空掉；降权保证没推过的先上，池子耗尽时仍能兜底。
  const historyKeys = recentRecommendedKeys(cache, true);

  report("正在读取播放记录…");
  const pref = await loadPreference();
  // 冷启动 = 三条输入全空：没听过、没收藏、也没自己选过风格（新装、换设备、清过统计）。
  // 旧实现这里直接返回空页面 —— 用户 2026-10-23 追问"没有历史怎么办"时暴露的正是这个缺口。
  // 现在不空着：给一批平台侧的最新/热门垫底，同时在页面上摆风格 chip 让用户点。
  const hasSaved = pref.favoriteTracks.length > 0 || pref.playlistTracks.length > 0;
  const hasSeeds = (pref.styleSeeds?.length ?? 0) > 0;
  const coldStart = pref.topSingers.length === 0 && !hasSaved && !hasSeeds;

  await useSourceRegistryStore.getState().ensure();
  const source = useMusicSourceStore.getState().activeSourceId;

  // 冷启动要先拿平台分类：一给页面摆 chip，二给候选池挑风格歌单（同一批数据，只请求一次）
  let styleOptions: DailyStyleOption[] = [];
  let categories: PlaylistCategory[] | undefined;
  if (coldStart) {
    report("正在读取平台风格分类…");
    categories = await getPlaylistCategories(source).catch(() => [] as PlaylistCategory[]);
    styleOptions = pickStyleOptions(categories);
  }
  const styleSeeds = pref.styleSeeds ?? [];

  // 「换一批」换个变体种子，同一天多点几次才会换出不同顺序；维度路的兜底词也按它轮换
  const variant = options.force ? `${Date.now()}` : undefined;

  report("正在搜索候选歌曲（含榜单与风格维度）…");
  const {
    tracks: pool,
    laneOf,
    affinityLanes,
  } = await buildCandidatePoolWithLanes(pref, source, {
    taste,
    coldStart,
    categories,
    variant,
    onProgress: () => report("正在搜索候选歌曲（含榜单与风格维度）…"),
  });
  if (pool.length === 0) {
    return {
      date: todayKey(),
      mode: "rule",
      requested,
      taste,
      generatedAt: Date.now(),
      title: coldStart ? "先挑几个你爱听的风格" : "这次没搜到候选",
      summary: coldStart
        ? "音源这次没返回内容，先选几个风格我再试一次。"
        : "音源没有返回结果，稍后再试一次。",
      items: [],
      notice: coldStart
        ? "音源没有返回内容：点上面的风格标签试试，或稍后重试。"
        : "音源搜索没有结果，检查一下音源包是否正常。",
      coldStart,
      styleOptions,
      styleSeeds,
    };
  }

  report("正在排除屏蔽与重复…");
  // 屏蔽判定与播放历史互不依赖：并行取（原来串行，等于多等一次 IPC）
  const [dislikedFlags, played] = await Promise.all([
    ipc.checkDisliked(pool).catch(() => pool.map(() => false)),
    ipc.listHistory(500).catch(() => [] as { track: Track }[]),
  ]);
  const playedKeys = new Set(played.map((item) => trackKey(item.track)));

  // 两种 AI 模式都要多排一批：`rankCandidates` 只按目标条数返回，
  // 只要 50 首、再让模型从这 50 首里挑 50 首，结果必然和规则模式逐首相同 ——
  // 用户 2026-10-23 说「感觉不出 AI 和规则有什么不同」就是这里造成的。
  const rankTarget =
    mode !== "rule" && !coldStart ? Math.max(DAILY_TARGET, DAILY_AI_POOL_MAX) : DAILY_TARGET;
  const ranked = rankCandidates(pool, pref, {
    historyKeys,
    playedKeys,
    dislikedFlags,
    taste,
    variant,
    target: rankTarget,
  });
  // 按风格线配额补维度歌（v9），再按线交织排列：规则排序只看「和画像的贴合度」，
  // 维度路搜到的粤语/纯音乐/日系哪怕很贴合也会因为歌手陌生被压到 150 名之后 ——
  // 先按配额把它们拉进前 50（七成底盘 + 三成风格线），再交织，用户才看得到
  // 「不止一两个风格」。没有线标签的歌归「常规」线（权重最高），保证主干仍是
  // 规则认为最贴合的那批；展示用的 laneOf 不掺这个合成标签。
  const CORE_LANE = "常规";
  const diverse = diversifyByLanes(ranked, laneOf, rankTarget);
  const interleaveLaneOf = new Map(laneOf);
  for (const track of diverse) {
    const key = trackKey(track);
    if (!interleaveLaneOf.has(key)) interleaveLaneOf.set(key, [CORE_LANE]);
  }
  const rulePicked = interleaveByLanes(diverse, interleaveLaneOf, rankTarget);
  // 本期覆盖了哪几条线：给页面显示（老缓存/纯歌手路径为空数组）
  const laneStatsOf = (list: { track: Track }[]): { label: string; count: number }[] =>
    laneCoverage(
      list.map((item) => item.track),
      laneOf,
    );
  // 规则结果永远只取前 DAILY_TARGET 首（降级与补齐都用它）
  const ruleItems: DailyRecommendItem[] = rulePicked.slice(0, DAILY_TARGET).map((track) => ({
    track,
    reason: ruleReason(track, pref),
  }));
  // 画像的人话描述：页面上要显示"系统认为你是什么口味"，用户才能判断推荐得准不准。
  // 冷启动时画像一定是空的（没有样本），显示「口味还不明显」不如直接让他去选风格。
  const profileText = coldStart || !pref.style ? undefined : describeProfile(pref.style);
  // 冷启动相关字段：三处结果出口都要带上，页面靠 `coldStart` 决定摆不摆风格 chip
  const coldFields = { coldStart, styleOptions, styleSeeds };

  // 规则模式直接返回规则结果。冷启动也走这里：没有画像时让模型挑等于让它瞎猜，
  // 还不如把选择权交给用户。两种 AI 模式（local / server）才往下走。
  if (mode === "rule" || coldStart) {
    const result: DailyRecommendResult = {
      date: todayKey(),
      mode: "rule",
      requested,
      taste,
      generatedAt: Date.now(),
      title: coldStart ? "先挑几个你爱听的风格" : "根据你的播放记录挑的",
      summary: coldStart
        ? styleOptions.length > 0
          ? "点上面的风格标签，我按你选的风格来挑；不选也行，先听这批新歌。"
          : "还没有你的口味数据，先听几首新歌，明天这里就会像你了。"
        : `${DAILY_TASTE_LABEL[taste]}：共 ${ruleItems.length} 首，来自全部已装音源。`,
      items: ruleItems,
      notice: downgradedFromServer ? "服务端 AI 仅管理员可用，已按纯规则推荐。" : null,
      profileText,
      styleLanes: laneStatsOf(ruleItems),
      ...coldFields,
    };
    await saveResult(result, true);
    return result;
  }

  // ---- 本地模型精选 ----
  if (ruleItems.length === 0) {
    const result: DailyRecommendResult = {
      date: todayKey(),
      mode: "rule",
      requested,
      taste,
      generatedAt: Date.now(),
      title: "这批候选都推荐过了",
      summary: "把屏蔽或收藏调一下，或者明天再来看看。",
      items: [],
      notice: "候选池里的歌最近都推荐过（或被屏蔽），已无新歌可推。",
      ...coldFields,
    };
    await saveResult(result, true);
    return result;
  }

  // 候选池要比目标大出一截模型才有得挑（150 挑 50）；尾巴按 variant 轮转，
  // 「换一批」时模型看到的是不同的候选，而不是同一批歌换个顺序。
  const aiPool = pickAiPool(rulePicked, variant);
  const pickCount = Math.min(DAILY_TARGET, aiPool.length);
  report(mode === "server" ? "正在让服务端 AI 挑选…" : "正在让模型挑选…");
  try {
    const { parsed, model } =
      mode === "server"
        ? await pickByServer(aiPool, pref, pickCount, taste, laneOf)
        : await askModelForPicks(aiPool, pref, pickCount, taste, laneOf);
    // 实测模型偶尔会多给一两首（要 50 给 51），按目标条数截住，别让页面多出一行
    const targetPicks = parsed.picks.slice(0, DAILY_TARGET);
    // 中段穿插封顶 + 「有没有本地依据」两道闸：没依据的（尤其尾部那些为了凑风格
    // 摸进来的）丢掉。v9 起「来自画像相关维度线」也算依据 —— 否则扩了候选池又用
    // v8 的「非主语种零证据全剔」把它筛回去，风格还是只有那一两个。
    // `used` 用**模型挑过的全部歌**（含被闸门丢掉的），免得丢掉的那首又被规则补回来。
    const laneOptions = { laneOf, affinityLanes };
    // 证据快照只算一次：原先 limitAiPicks 与 filterAiPicks 各算一遍（每次都要
    // 遍历收藏 + 歌单 + 播放统计重建 Set/Map），这里算好传下去，两道闸共用。
    const snapshot = evidenceSnapshot(pref);
    const items = filterAiPicks(
      limitAiPicks(targetPicks, aiPool, pref, taste, laneOptions, snapshot),
      pref,
      taste,
      laneOptions,
      snapshot,
    );
    const used = new Set(
      targetPicks.map((pick) => trackKey(aiPool[pick.index - 1])),
    );
    let filled = 0;
    for (const track of rulePicked) {
      if (items.length >= DAILY_TARGET) break;
      if (used.has(trackKey(track))) continue;
      used.add(trackKey(track));
      items.push({ track, reason: ruleReason(track, pref) });
      filled += 1;
    }
    // 模型给的是它自己的顺序，可能把同一个歌手连着排 —— 只做最小相邻交换，
    // 尽量保留模型排出来的叙事（旧实现是贪心重排，把顺序彻底打乱了）。
    const spread = spreadItemsBySinger(items, (item) => item.track.singer);
    const result: DailyRecommendResult = {
      date: todayKey(),
      mode,
      requested,
      taste,
      generatedAt: Date.now(),
      title: parsed.title || "今天为你挑的",
      summary:
        parsed.summary ||
        `模型从 ${aiPool.length} 首候选里挑了 ${parsed.picks.length} 首${filled > 0 ? "，其余按规则补齐" : ""}。`,
      items: spread,
      notice: null,
      profileText,
      model: model || undefined,
      styleLanes: laneStatsOf(spread),
      ...coldFields,
    };
    await saveResult(result, true);
    return result;
  } catch (error) {
    // 模型挂了不能让页面空着：退回规则结果，并把原因如实写出来
    const reason = error instanceof Error ? error.message : String(error);
    const result: DailyRecommendResult = {
      date: todayKey(),
      mode: "rule",
      requested,
      taste,
      generatedAt: Date.now(),
      title: "根据你的播放记录挑的",
      summary: "模型这次没帮上忙，先用规则给你挑了一批。",
      items: ruleItems,
      notice:
        mode === "server"
          ? `服务端 AI 调用失败（${reason}），已退回规则推荐。`
          : `本地模型调用失败（${reason}），已退回规则推荐。`,
      profileText,
      ...coldFields,
    };
    await saveResult(result, true);
    return result;
  }
}
