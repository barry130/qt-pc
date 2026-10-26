/**
 * 音乐助手的「本地引擎」：`rule` / `local` 两种模式在这里把一句话变成一份歌单。
 *
 * ## 为什么 rule / local 必须在客户端本地实现
 * 音乐助手原来只有一条路：登录后走 astral 的服务端会话。服务端模式的代价是必须联网、
 * 必须登录、每句话都要一次远端推理；而这两个模式要的恰恰是「永远能用」：
 * - `rule`：不联网、不调模型，用本地词表和**已经搜好的候选**直接排。断网、没登录、
 *   服务端抽风时，助手仍然能回答「来点古风」这种明确请求。
 * - `local`：只叫「AI 设置」里本机配置的那套 OpenAI 兼容接口，模型只负责在候选里
 *   挑序号 —— 判断哪首合适仍是本地算，远端只提供排序偏好。
 * 两者都不创建服务端会话（不碰 `@/services/ipc` 里的 astral 命令），因此不需要登录态，
 * 也不会在服务端留下对话记录。
 *
 * ## 两种模式的区别
 * `rule` 全程本地、同步、可解释：关键词/画像是怎么加分的，reply 里会说出来（「按你说的
 * 「古风」挑了…」），用户看得出这不是模型在说话。`local` 多一次模型调用，把「关键词没
 * 覆盖到的口味」交给模型判断，但输出被硬约束成 JSON 序号：越界序号、重复序号、编造的
 * 歌名一律进不来 —— 模型根本没机会自己写歌名。
 *
 * ## 解析失败为什么不打断用户
 * 助手页的主任务是「听到歌」，不是「看到模型说了什么」。小模型偶尔回 markdown 围栏、
 * 只回一串数字、或干脆说「我也不知道」——这些都不该变成错误气泡。所以 local 的解析是
 * 一条**只降级、不抛错**的链：整段 JSON → 抠数组 → 正则捞序号 → 规则挑歌，reply 也跟着
 * 回退成规则文案。用户最多觉得「这次回答朴素了点」，而不是「助手坏了」。
 */

import type { Track } from "@/types";
import type { MusicLang, StyleProfile, TrackStyle } from "@/lib/recommend-types";
import type { AiLocalMessage } from "@/types";
import {
  ADJACENT_WORDS,
  ERA_WORDS,
  GENRE_WORDS,
  LANG_WORDS,
  MOOD_WORDS,
  SCENE_WORDS,
} from "@/lib/recommend-dimensions";
import { extractJsonArray } from "@/lib/daily-recommend";
import { describeProfile, trackStyle } from "@/lib/music-style";
import { similarity } from "@/lib/recommend-rank";
import { normText, trackKey, truncateChars } from "@/lib/text";
import * as ipc from "@/services/ipc";

/** 本模块只处理两种本地模式 */
export type LocalAssistantMode = "rule" | "local";

export interface AssistantTurnInput {
  mode: LocalAssistantMode;
  /** 用户这句话 */
  text: string;
  /** 最近几轮对话（旧的在前，只取最后 6 条用；assistant 的 content 已是纯文本） */
  history: { role: "user" | "assistant"; content: string }[];
  /** 已经从已安装音源搜好的候选（10~30 首，可能为空） */
  candidates: Track[];
  /** 可选的听歌画像（来自 daily-recommend 的 loadPreference().style）；没有就 null/undefined */
  profile?: StyleProfile | null;
}

export interface AssistantTurnResult {
  /** 给用户的一句话中文回答（local 模式失败时也用规则文案兜底） */
  reply: string;
  /** 按顺序挑中的歌（默认 20 首上限、可按用户要求变，去重） */
  songs: Track[];
  /** rule 模式返回 "rule"，local 成功返回模型名，local 失败返回 "rule" */
  model: string;
}

/** 规则模式在结果里的模型名（集成层靠它区分「这句话是不是规则给的」） */
const RULE_MODEL = "rule";

/** 本地模型没回传模型名时的兜底名：说明这次确实是模型挑的，只是名字未知 */
const LOCAL_MODEL_FALLBACK = "local";

/**
 * 一次最多交付几首：用户 2026-10-24 反馈「每次只有 8 首，我要 20 首也是 8 首」，
 * 默认就按上限给满 20；话里点了数量就按他说的来（仍然封顶 20 —— 再多就成了整张
 * 歌单，不是"立刻能听"的入口）。
 */
const MAX_SONGS = 20;

/** 用户没说数量时给几首：跟上限一致，别让"再来点"每次都要重说一遍 */
const DEFAULT_SONG_COUNT = MAX_SONGS;

/** 同一歌手最多几首：和每日推荐的配额同口径，避免一个人连排 */
const MAX_PER_SINGER = 2;

/** 同歌手第 2 首起的降权：只降权不淘汰（淘汰交给 MAX_PER_SINGER 硬配额） */
const SAME_SINGER_PENALTY = 2;

/** 每个命中的关键词、每个字段（title/singer/album）加分 */
const KEYWORD_FIELD_SCORE = 3;

/** 歌名或歌手被用户点名时的加分（比关键词强一档） */
const NAMED_SCORE = 6;

/** 画像相似度的最大加分（similarity 0..1 映射到 0..4） */
const PROFILE_SCORE_MAX = 4;

/** 本地模型温度：0.6 = 有点表达自由，但别改写成诗 */
const LOCAL_TEMPERATURE = 0.6;

/** 本地模型回复正文的上限（字）：助手气泡只放得下一句话 */
const LOCAL_REPLY_MAX_CHARS = 80;

/** prompt 里最多带几条最近对话（更早的上下文只会稀释这句话的意图） */
const PROMPT_HISTORY_MAX = 4;

/** 入参 history 的截断上限（契约说只取最后 6 条） */
const INPUT_HISTORY_MAX = 6;

/** 名字匹配的最小归一化长度：单字歌名（「雨」）太容易把普通句子误判成点名 */
const MIN_NAME_MATCH_LEN = 2;

/** 候选为空时的固定文案：说清"为什么没有歌"和"下一步能做什么" */
const EMPTY_CANDIDATE_REPLY = "这次没搜到合适的歌，换个歌手、风格或场景再说一遍试试。";

/** 正则兜底捞序号：「picks: [1, 3, 5]」 / 「picks：[1,3,5]」都认 */
const PICKS_PATTERN = /picks\s*[:：]\s*\[([0-9,\s]+)\]/u;

/** 中文数字：只覆盖到 99（「二十首」「十五首」「两首」这类说法） */
const CHINESE_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 把「20」「二十」「两」这类写法换成数字；认不出来返回 null */
function countOf(text: string): number | null {
  if (/^\d{1,3}$/u.test(text)) return Number(text);
  if (text === "十") return 10;
  const matched = /^([一二两三四五六七八九])?十([一二两三四五六七八九])?$/u.exec(text);
  if (matched) {
    const tens = matched[1] ? (CHINESE_DIGITS[matched[1]] ?? 1) : 1;
    const ones = matched[2] ? (CHINESE_DIGITS[matched[2]] ?? 0) : 0;
    return tens * 10 + ones;
  }
  return CHINESE_DIGITS[text] ?? null;
}

/**
 * 这一次要交付几首：话里点了数量就按他说的，夹紧到 1..MAX_SONGS；没说就给默认值。
 *
 * 识别三种写法：「来 20 首」「来二十首」「来两首」。识别失败时**不能**退化成"
 * 少给几首"—— 用户说过一次 20 首，下次不说也不该掉回 8 首。
 */
function requestedSongCount(text: string): number {
  const arabic = /(\d{1,3})\s*首/u.exec(text);
  const chinese = /([一二两三四五六七八九十]{1,3})\s*首/u.exec(text);
  const spoken = arabic ? countOf(arabic[1]) : chinese ? countOf(chinese[1]) : null;
  if (spoken === null) return DEFAULT_SONG_COUNT;
  return Math.max(1, Math.min(MAX_SONGS, spoken));
}

// ---------- 词表 ----------

/** 语种词打平成一维：命中哪个都算语种维度 */
const LANG_WORD_LIST: string[] = (Object.keys(LANG_WORDS) as MusicLang[]).flatMap(
  (lang) => LANG_WORDS[lang] ?? [],
);

/**
 * 关键词识别的词表顺序：流派 → 情绪 → 场景 → 年代 → 语种 → 相邻词表的键。
 *
 * 相邻词表（`ADJACENT_WORDS`）的键里有「流行」这种不在前几张表、但用户真会说的词，
 * 所以键本身也当命中词；值是它的相邻风格，只在命中后展开。
 */
const KEYWORD_WORDS: string[] = dedupeWords([
  ...GENRE_WORDS,
  ...MOOD_WORDS,
  ...SCENE_WORDS,
  ...ERA_WORDS,
  ...LANG_WORD_LIST,
  ...Object.keys(ADJACENT_WORDS),
]);

/**
 * 词表去重：同一首歌的同一个词可能在多张表里出现（「纯音乐」既是流派也是语种），
 * 归一化后重复的只留第一次出现的位置 —— 顺序即「reply 里先说哪个词」的优先级。
 */
function dedupeWords(words: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const word of words) {
    const trimmed = word.trim();
    const key = normText(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

// ---------- rule：关键词 / 点名 ----------

/** 用户话里点名到的名字（歌手/歌名/专辑） */
interface NamedHits {
  /** 出现在用户话里的名字（去重、按候选顺序）；reply 只用第一条 */
  labels: string[];
  /** 歌名或歌手被点名的候选下标（参与 +6 加分） */
  indexes: Set<number>;
}

/**
 * 从用户这句话里收风格/情绪/场景/年代/语种关键词，并展开相邻风格。
 *
 * 相邻词表的意义：用户说「古风」时，国风/戏腔/民乐也是他大概率想听的 —— 不展开的话
 * 只有 title/singer/album 里带「古风」两个字的歌能得分，命中面太窄。展开只走一步
 * （不做传递闭包）：再往外走就离用户原意太远了。
 */
function collectKeywords(text: string): string[] {
  const textKey = normText(text);
  if (!textKey) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (word: string): void => {
    const key = normText(word);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(word);
  };

  const matched: string[] = [];
  for (const word of KEYWORD_WORDS) {
    const key = normText(word);
    if (!key || !textKey.includes(key)) continue;
    matched.push(word);
    push(word);
  }
  // 相邻词统一追加在真实命中之后：reply 取前 3 个时，先念用户原话里的词
  for (const word of matched) {
    for (const adjacent of ADJACENT_WORDS[word] ?? []) push(adjacent);
  }
  return out;
}

/**
 * 从候选里找「用户话里点到的名字」。
 *
 * 用归一化后的 `includes` 而不是精确相等：用户写「周杰伦的晴天」「jay」这类带修饰的
 * 说法，精确匹配会全漏。名字归一化后长度 < 2 的不算（单字太容易误判）。
 */
function findNamed(candidates: readonly Track[], text: string): NamedHits {
  const textKey = normText(text);
  const labels: string[] = [];
  const indexes = new Set<number>();
  if (!textKey) return { labels, indexes };

  const addLabel = (name: string): void => {
    const label = name.trim();
    if (label && !labels.includes(label)) labels.push(label);
  };

  candidates.forEach((track, index) => {
    // 歌名/歌手被点名才加 +6 分（spec：专辑名只进 named 文案，不参与打分）
    let artistOrTitle = false;
    for (const field of [track.title, track.singer]) {
      const key = normText(field);
      if (key.length < MIN_NAME_MATCH_LEN || !textKey.includes(key)) continue;
      addLabel(field);
      artistOrTitle = true;
    }
    const albumKey = normText(track.album);
    if (albumKey.length >= MIN_NAME_MATCH_LEN && textKey.includes(albumKey)) {
      addLabel(track.album);
    }
    if (artistOrTitle) indexes.add(index);
  });
  return { labels, indexes };
}

/**
 * 用户点名的歌手集合（归一化后）。
 *
 * 规则里「同一歌手最多 2 首」是为了避免硬塞一个人的歌；但用户自己说「我想听周杰伦」
 * 时，这条规则正好挡在他要的东西前面 —— 点名的歌手不受配额限制。
 */
function namedSingers(candidates: readonly Track[], named: NamedHits): Set<string> {
  const singers = new Set<string>();
  for (const index of named.indexes) {
    const track = candidates[index];
    const key = track ? normText(track.singer) : "";
    if (key) singers.add(key);
  }
  return singers;
}

// ---------- rule：画像相似度 ----------

/**
 * 画像里权重最高的键（没有就空串）。
 *
 * 不按出现次数而按权重：`singers`/`albums` 已经按行为质量加权过（见
 * `buildStyleProfile`），权重最高才是「最像他的那个」。
 */
function topAffinityKey(map: Record<string, number>): string {
  let bestKey = "";
  let bestValue = 0;
  for (const [key, value] of Object.entries(map)) {
    if (!key || value <= bestValue) continue;
    bestKey = key;
    bestValue = value;
  }
  return bestKey;
}

/**
 * 把画像压成一份「风格坐标」，供 `similarity(trackStyle(track), ...)` 比较。
 *
 * 仓库里没有现成的这个函数（`music-style.ts` 只有单曲的 `trackStyle`），但相似度
 * 需要两个同形状的对象。画像里能落到 `TrackStyle` 上的只有四件事：最强的歌手亲和、
 * 最强的专辑亲和、主语种、主要时长带。取「最强」而不是摊开整张亲和表，是因为
 * similarity 的语义是「和这个坐标像不像」，不是对亲和权重求期望。
 */
function trackStyleOfProfile(profile: StyleProfile): TrackStyle {
  return {
    singerKey: topAffinityKey(profile.singers),
    albumKey: topAffinityKey(profile.albums),
    lang: profile.mainLang,
    band: profile.mainBand,
  };
}

/**
 * 画像是否存在可用信号。
 *
 * `buildStyleProfile` 在没有任何样本时返回 `sampleSize = 0`、`tags = []` 的空画像；
 * 拿它算相似度只会给「三四分钟」这种默认值加分，等于无依据地抬一手候选，所以跳过。
 */
function profileHasSignal(profile: StyleProfile | null | undefined): profile is StyleProfile {
  if (!profile) return false;
  return profile.sampleSize > 0 || profile.tags.length > 0;
}

// ---------- rule：排序 ----------

/** 一首候选的规则打分结果 */
interface ScoredRuleTrack {
  track: Track;
  /** 候选原顺序：同分时保持搜索结果的原始相关度 */
  index: number;
  /** 关键词 + 点名 + 画像相似度，未扣同歌手分 */
  baseScore: number;
  /** 扣完同歌手分后的最终分 */
  score: number;
  /** 归一化歌手键（去重用；空歌手键视为互不相同） */
  singerKey: string;
}

/**
 * 给每首候选打分：
 * - 关键词命中 title/singer/album，每个字段 +3；
 * - 被点名（歌名或歌手出现在用户话里）+6；
 * - 有画像时加 `round(similarity * 4)`（画像为空跳过）；
 * - 同一歌手第 2 首起每首 -2（只降权，最终还有 MAX_PER_SINGER 硬配额）。
 *
 * 打的是**绝对分**而不是归一化分：分数本身不给用户看，只用来排序和解释。
 */
function scoreRuleCandidates(
  input: AssistantTurnInput,
  keywords: readonly string[],
  named: NamedHits,
): ScoredRuleTrack[] {
  const keywordKeys = keywords.map((word) => normText(word)).filter((key) => key.length > 0);
  const profile = input.profile;
  const profileStyle = profileHasSignal(profile) ? trackStyleOfProfile(profile) : null;

  const scored: ScoredRuleTrack[] = input.candidates.map((track, index) => {
    const fields = [normText(track.title), normText(track.singer), normText(track.album)].filter(
      (field) => field.length > 0,
    );
    let baseScore = 0;
    for (const keywordKey of keywordKeys) {
      for (const field of fields) {
        if (field.includes(keywordKey)) baseScore += KEYWORD_FIELD_SCORE;
      }
    }
    if (named.indexes.has(index)) baseScore += NAMED_SCORE;

    const style = trackStyle(track);
    if (profileStyle) baseScore += Math.round(similarity(style, profileStyle) * PROFILE_SCORE_MAX);
    return { track, index, baseScore, score: baseScore, singerKey: style.singerKey };
  });

  // 同歌手降权：在每个歌手组内按分数排，第 2 首起扣分 —— 这样扣的是「同一个人里较差的
  // 那几首」，而不是候选里碰巧排在后面的那几首（后者会把好歌误伤）。
  const groups = new Map<string, ScoredRuleTrack[]>();
  for (const item of scored) {
    const key = item.singerKey || `__track:${trackKey(item.track)}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => b.baseScore - a.baseScore || a.index - b.index);
    for (let i = 1; i < group.length; i += 1) group[i].score -= SAME_SINGER_PENALTY;
  }
  return scored;
}

/**
 * 按分数降序取歌：同分保持候选原顺序，同一歌手最多 2 首（用户点名的歌手不限），
 * 按 trackKey 去重，最多 `count` 首。
 *
 * 为什么"先排序再筛配额"而不是反过来：筛完再排会让候选原顺序的权重过大，
 * 用户搜出来的第一页顺序不该压过他自己说出来的风格。
 */
function pickRuleSongs(
  scored: readonly ScoredRuleTrack[],
  count: number,
  relaxedSingers: ReadonlySet<string>,
): Track[] {
  const ordered = scored
    .slice()
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const picked: Track[] = [];
  const usedKeys = new Set<string>();
  const singerCount = new Map<string, number>();
  for (const item of ordered) {
    if (picked.length >= count) break;
    const key = trackKey(item.track);
    if (usedKeys.has(key)) continue;
    const singerKey = item.singerKey || `__track:${key}`;
    const relaxed = relaxedSingers.size > 0 && relaxedSingers.has(normText(item.track.singer));
    if (!relaxed && (singerCount.get(singerKey) ?? 0) >= MAX_PER_SINGER) continue;
    usedKeys.add(key);
    singerCount.set(singerKey, (singerCount.get(singerKey) ?? 0) + 1);
    picked.push(item.track);
  }
  return picked;
}

// ---------- rule：reply ----------

/**
 * 规则模式的 reply：把「按什么理解你的话」说出来。
 *
 * 四档优先级（关键词 > 点名 > 画像 > 兜底）和实际打分的优先级一致，用户才能对上账：
 * 说了「古风」就先提古风，只说「周杰伦」就提周杰伦。没有依据时**明说**是"刚搜到的歌"，
 * 不要假装懂口味 —— 那会让用户以为之后能靠这句话继续收敛。
 */
function ruleReply(
  input: AssistantTurnInput,
  keywords: readonly string[],
  named: readonly string[],
  songs: readonly Track[],
): string {
  if (keywords.length > 0) {
    const spoken = keywords.slice(0, 3).join("、");
    return `按你说的「${spoken}」挑了 ${songs.length} 首，先从最贴近的开始听。`;
  }
  if (named.length > 0) {
    return `按你点到的「${named[0]}」找了 ${songs.length} 首。`;
  }
  if (profileHasSignal(input.profile)) {
    return `按你最近的听歌口味挑了 ${songs.length} 首。`;
  }
  return `先从刚搜到的歌里挑了 ${songs.length} 首，说个歌手或风格我再收敛。`;
}

/** 规则回合的中间产物：local 回退时直接复用，不再算第二遍 */
interface RulePlan {
  keywords: string[];
  named: string[];
  songs: Track[];
  reply: string;
}

/** 跑一遍规则：关键词/画像排序 + 规则文案 */
function planRuleTurn(input: AssistantTurnInput): RulePlan {
  if (input.candidates.length === 0) {
    return { keywords: [], named: [], songs: [], reply: EMPTY_CANDIDATE_REPLY };
  }
  const keywords = collectKeywords(input.text);
  const named = findNamed(input.candidates, input.text);
  const count = requestedSongCount(input.text);
  const songs = pickRuleSongs(
    scoreRuleCandidates(input, keywords, named),
    count,
    namedSingers(input.candidates, named),
  );
  return {
    keywords,
    named: named.labels,
    songs,
    reply: ruleReply(input, keywords, named.labels, songs),
  };
}

// ---------- local：prompt ----------

/** 候选行：`1. 晴天 - 周杰伦（叶惠美）`。缺专辑时给「未知专辑」，避免出现空括号 */
function candidateLine(track: Track, index: number): string {
  const album = track.album.trim() || "未知专辑";
  return `${index + 1}. ${track.title} - ${track.singer}（${album}）`;
}

/**
 * 组本地模型的 messages：一条 system（角色 + 输出契约）+ 一条 user（这句话 + 上下文）。
 *
 * 为什么把输出契约写死在系统消息里：本地小模型对"结构化输出"的服从度取决于提示词
 * 有多具体。给 JSON 形状 + 序号含义 + 禁止事项三件套，配合 `parseLocalReply` 的
 * 硬校验（越界/重复序号丢弃），模型就没有编造歌名的空间。
 */
function buildLocalMessages(input: AssistantTurnInput, count: number): AiLocalMessage[] {
  const system = [
    "你是轻听内置的音乐助手，只从用户给的候选歌曲里挑，绝不编造歌名或歌手。",
    `输出要求：只输出一个 JSON 对象，形如 {"reply":"一句中文回答（不超过60字）","picks":[1,2,3]}；picks 是候选序号（1 起）按推荐顺序，最多 ${count} 个；不能输出任何解释、代码块围栏或其它文字。`,
  ].join("\n\n");

  const sections: string[] = [`用户这句话：${input.text.trim()}`];

  // 历史只取最后 4 条：再往前是上一轮的话题，很容易把"这句话"的意图淹没
  const recent = input.history.slice(-INPUT_HISTORY_MAX).slice(-PROMPT_HISTORY_MAX);
  const historyLines = recent
    .map((turn) => ({ role: turn.role, content: turn.content.trim() }))
    .filter((turn) => turn.content.length > 0)
    .map((turn) => `${turn.role === "user" ? "用户" : "你"}：${turn.content}`);
  if (historyLines.length > 0) sections.push(["最近对话：", ...historyLines].join("\n"));

  sections.push(
    [`候选歌曲（共 ${input.candidates.length} 首）：`, ...input.candidates.map(candidateLine)].join(
      "\n",
    ),
  );

  if (profileHasSignal(input.profile)) {
    sections.push(`用户的听歌画像：${describeProfile(input.profile)}`);
  }

  return [
    { role: "system", content: system },
    { role: "user", content: sections.join("\n\n") },
  ];
}

// ---------- local：解析 ----------

/** 剥掉 markdown 代码围栏（模型最常见的"多余装饰"） */
function stripCodeFence(raw: string): string {
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (match ? match[1] : raw).trim();
}

/** JSON.parse 的安全版本：用 ok 标记区分「解析出 null」和「解析失败」 */
function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** 从解析结果里取出序号数组：整段数组，或对象里的 picks 字段 */
function rawPicksOf(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.picks)) return record.picks;
  }
  return null;
}

/** 序号容错：接受数字与纯数字字符串，其它一律 NaN（当作无效丢弃） */
function toPickIndex(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && /^\d+$/u.test(raw.trim())) return Number(raw.trim());
  return Number.NaN;
}

/**
 * 序号 → 歌曲：越界、重复序号、重复曲目直接丢（不是纠正成别的歌 —— 纠正等于替模型编造）。
 * 最多 `count` 首。
 */
function mapPicks(
  rawPicks: readonly unknown[],
  candidates: readonly Track[],
  count: number,
): Track[] {
  const picked: Track[] = [];
  const usedIndexes = new Set<number>();
  const usedKeys = new Set<string>();
  for (const raw of rawPicks) {
    if (picked.length >= count) break;
    const index = toPickIndex(raw);
    if (!Number.isInteger(index) || index < 1 || index > candidates.length) continue;
    if (usedIndexes.has(index)) continue;
    const track = candidates[index - 1];
    if (!track) continue;
    const key = trackKey(track);
    if (usedKeys.has(key)) continue;
    usedIndexes.add(index);
    usedKeys.add(key);
    picked.push(track);
  }
  return picked;
}

/** JSON 里的 reply 字段（没有/不是字符串就空串） */
function jsonReplyOf(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const record = value as Record<string, unknown>;
  const reply = record.reply;
  return typeof reply === "string" ? truncateChars(reply.trim(), LOCAL_REPLY_MAX_CHARS) : "";
}

/** 去掉 JSON/围栏片段后的正文首句（截断 80 字）：模型把话写在 JSON 外面时的兜底 */
function firstSentenceOf(raw: string): string {
  const body = raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\{[\s\S]*\}/g, " ")
    .replace(/\[[^\]]*\]/g, " ");
  const [first = ""] = body.split(/[。！？!?\n\r]+/u);
  const trimmed = first.replace(/^[\s:：,，、;；]+/u, "").replace(/[\s:：,，、;；]+$/u, "");
  return truncateChars(trimmed, LOCAL_REPLY_MAX_CHARS);
}

/** 本地模型输出解析结果 */
interface ParsedLocalReply {
  reply: string;
  songs: Track[];
}

/**
 * 解析本地模型的输出，**永不 throw**。
 *
 * 三级降级：整段 JSON（含剥围栏）→ `extractJsonArray` 抠第一个数组 → 正则捞
 * `picks: [...]`。reply 优先取 JSON 的 reply 字段，其次取去掉 JSON 片段后的正文首句。
 * 都解析不出来就返回空结果，交给调用方回退规则 —— 这里不决定"失败"，只负责"能读出
 * 什么就读什么"。
 */
function parseLocalReply(
  raw: string,
  candidates: readonly Track[],
  count: number,
): ParsedLocalReply {
  const content = raw.trim();
  if (!content) return { reply: "", songs: [] };

  let value: unknown = undefined;
  let parsed = false;
  let textForReply = content;

  // 1) 整段 JSON：先剥围栏，模型"```json {...}```"是最常见的合法但带壳输出
  const whole = tryParseJson(stripCodeFence(content));
  if (whole.ok) {
    value = whole.value;
    parsed = true;
  }

  // 2) 抠第一个 JSON 数组（模型偷懒只回 [3,1,5]）
  if (!parsed) {
    const arrayText = extractJsonArray(content);
    if (arrayText) {
      const fromArray = tryParseJson(arrayText);
      if (fromArray.ok) {
        value = fromArray.value;
        parsed = true;
        textForReply = content.split(arrayText).join(" ");
      }
    }
  }

  // 3) 正则捞 picks：JSON 坏了但序号还在
  if (!parsed) {
    const matched = content.match(PICKS_PATTERN);
    if (matched) {
      value = { picks: matched[1].split(",") };
      parsed = true;
      textForReply = content.split(matched[0]).join(" ");
    }
  }

  if (!parsed) return { reply: "", songs: [] };

  const rawPicks = rawPicksOf(value);
  const songs = rawPicks ? mapPicks(rawPicks, candidates, count) : [];
  const reply = jsonReplyOf(value) || firstSentenceOf(textForReply);
  return { reply, songs };
}

// ---------- local：调用 ----------

/**
 * 叫本机配置的模型挑歌；任何失败（没配置/超时/回废话）都回退规则结果，不 throw。
 *
 * `model` 字段是集成层和用户都能读的"这次是谁挑的"：规则回退时必须是 "rule"，
 * 免得用户以为模型挂了还在算 AI 结果。
 */
async function runLocalTurn(
  input: AssistantTurnInput,
  rule: RulePlan,
): Promise<AssistantTurnResult> {
  if (input.candidates.length === 0) {
    return { reply: rule.reply, songs: rule.songs, model: RULE_MODEL };
  }
  try {
    const count = requestedSongCount(input.text);
    const messages = buildLocalMessages(input, count);
    const reply = await ipc.aiLocalChat(messages, LOCAL_TEMPERATURE);
    const content = typeof reply?.content === "string" ? reply.content : "";
    const parsed = parseLocalReply(content, input.candidates, count);
    if (parsed.songs.length === 0 || parsed.reply === "") {
      return { reply: rule.reply, songs: rule.songs, model: RULE_MODEL };
    }
    const model = typeof reply?.model === "string" ? reply.model.trim() : "";
    return { reply: parsed.reply, songs: parsed.songs, model: model || LOCAL_MODEL_FALLBACK };
  } catch {
    return { reply: rule.reply, songs: rule.songs, model: RULE_MODEL };
  }
}

// ---------- 对外入口 ----------

/**
 * 跑一次音乐助手的本地回合（`rule` / `local`）。
 *
 * `rule`：纯本地排序 + 规则文案，`model` 恒为 "rule"。
 * `local`：候选为空直接走规则；否则调本机模型，解析失败/调用失败/序号无效都退回规则
 * 结果（`model` 记为 "rule"）。本函数**不会 throw** —— 助手页不该因为一句话没说清就没响应。
 */
export async function runAssistantTurn(input: AssistantTurnInput): Promise<AssistantTurnResult> {
  const rule = planRuleTurn(input);
  if (input.mode === "rule") {
    return { reply: rule.reply, songs: rule.songs, model: RULE_MODEL };
  }
  return runLocalTurn(input, rule);
}
