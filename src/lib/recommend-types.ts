/**
 * 推荐引擎的共享类型契约（风格画像 / 曲目风格坐标 / 行为质量 / 打分选项）。
 *
 * ## 为什么单独一个文件
 * 推荐链路被切成三块，各有各的职责：
 * - `music-style.ts`：把「播放记录 + 收藏 + 歌单」提炼成**口味画像**（你爱听什么风格）；
 * - `recommend-rank.ts`：按画像给候选打分，再做多样性选择（不许一个歌手/一种语种霸屏）；
 * - `daily-recommend.ts`：接到 IPC、缓存、提示词上，并把三段串成一次生成。
 *
 * 三块之间传的东西全在这里定义一次。**画像多一个字段只改这里**，不要在三处各写一份
 * 形状相近的结构体 —— 那样迟早会漂移成「画像里有、打分时没读」的静默 bug。
 *
 * ## 为什么没有「曲风」字段
 * `Track` 只有 id/platform/title/singer/album/picUrl/duration，音源契约
 * （`qt-contract/contract.ts` 的 `MusicInfo`）同样没有 genre / 年代 / 语种。
 * 所以「风格」只能由**本地能算出来的信号**推导：
 * 文字种类（华语/日语/韩语/欧美）、时长带、专辑、歌单里的共现与歌单名，
 * 再叠上**真实的收听行为**（完播比、重复次数、最近性）——行为才是"喜欢"最硬的证据，
 * 比任何标签都准。
 */

import type { Track } from "@/types";

/** 推荐口味：决定**怎么扩候选、怎么配色**，与推荐模式（要不要叫模型）正交 */
export type DailyTaste = "heart" | "familiar" | "explore";

/**
 * 语种 / 文字种类。
 *
 * 没有元数据，靠字符集统计推断（见 `detectLanguage`）：
 * 假名 > 谚文 > 汉字 > 拉丁 的优先级 —— 日文歌大量使用汉字，只看汉字会把日语歌
 * 全判成华语；有假名就一定是日语。`und` 是「判不出来」：纯器乐、俄语/法语等
 * 拉丁以外文字、空标题都落在这里，**不要当成一种语种去推**。
 */
export type MusicLang = "zh" | "ja" | "ko" | "en" | "und";

/** 界面上给人看的语种名 */
export const MUSIC_LANG_LABEL: Record<MusicLang, string> = {
  zh: "华语",
  ja: "日语",
  ko: "韩语",
  en: "欧美",
  und: "器乐/其它",
};

/** 时长带：把"4 分钟的歌"和"8 分钟的后摇"分开，是弱特征但零成本 */
export type DurationBand = "short" | "normal" | "long" | "epic";

/** 界面上给人看的时长描述 */
export const DURATION_BAND_LABEL: Record<DurationBand, string> = {
  short: "短歌",
  normal: "三四分钟",
  long: "四五分钟",
  epic: "长曲",
};

/** 单曲的「风格坐标」：全部由本地字段算出，零网络、可缓存 */
export interface TrackStyle {
  /** 归一化歌手键（同一个歌手的不同写法合并成一个） */
  singerKey: string;
  /**
   * 归一化专辑键，形如 `歌手键|专辑键`；无专辑信息时为 `""`。
   *
   * 带上歌手：大量合辑/精选都叫「精选」「Greatest Hits」，只按专辑名会把
   * 周杰伦的精选和别人的精选算成同一张，反而给出错误的"同专辑"加分。
   */
  albumKey: string;
  lang: MusicLang;
  band: DurationBand;
}

/**
 * 一首歌的累计收听统计（来自 `play_stats`，`ipc.getTopTracks` 拿得到）。
 *
 * 三个数字缺一不可：
 * - `playCount`：算「有效播放」次数（见 `counts_as_play`，起播 3 秒跳过不计）；
 * - `totalPlayedMs`：真实收听的毫秒累积（暂停与 seek 跳过的不计）；
 * - `lastPlayedAt`：最后一次播放时刻，用来算「当下口味」。
 */
export interface TrackStat {
  playCount: number;
  totalPlayedMs: number;
  lastPlayedAt: number;
}

/**
 * 行为质量（0..1 量纲统一，便于直接加权）。
 *
 * 这是整个新推荐引擎相对旧版最大的信息增量：旧版只用「播放次数排行榜」，
 * 于是「反复点开听 20 秒就切」和「一遍遍听完」得分一样。有了
 * `totalPlayedMs / playCount` 才能把两者分开。
 */
export interface TrackQuality {
  /** 完播比 = totalPlayedMs ÷ (playCount × 曲长)，clamp 到 0..1（超过 1 的按 1 算） */
  completion: number;
  /** 沉迷度 = playCount ÷ 全库最大 playCount，0..1 */
  replay: number;
  /** 最近性：30 天内线性衰减到 0，0..1 */
  recency: number;
  /** 综合喜欢度 = 0.5×completion + 0.3×replay + 0.2×recency */
  affinity: number;
  /**
   * 「反复点开但每次听不到一半」= 其实不喜欢。
   *
   * 判据：playCount ≥ 3 且 completion < 0.4。收藏过的歌不算（用户自己收进去的
   * 比行为更硬，收藏但听得少通常是"想听还没听"）。
   */
  skipped: boolean;
}

/**
 * 口味画像：描述「你喜欢什么风格」，而不是「你听过哪些歌手」。
 *
 * 旧版只有 `topSingers`，于是推荐必然被歌手锁死 —— 用户 2026-10-23 的原话：
 * 「不应该根据你听过的歌手去推荐，应该根据你之前听过歌曲的风格等等各方面综合一起去推荐」。
 * 画像把所有能算的维度都摊开，歌手只是其中一维（`singers`）。
 */
export interface StyleProfile {
  /** 各语种权重，Σ=1（没有任何样本时为 `{}`） */
  langs: Partial<Record<MusicLang, number>>;
  /** 各时长带权重，Σ=1 */
  bands: Partial<Record<DurationBand, number>>;
  /** 权重最高的语种；低于 `MIN_MAIN_SHARE` 或为空时给 `"und"`（不下结论） */
  mainLang: MusicLang;
  /** 权重最高的时长带；为空时给 `"normal"` */
  mainBand: DurationBand;
  /** 歌手亲和：归一化歌手键 → 0..1（已按行为质量加权，最强者为 1） */
  singers: Record<string, number>;
  /** 专辑亲和：归一化专辑键 → 0..1 */
  albums: Record<string, number>;
  /**
   * 从**用户自己歌单的名字**里抽到的风格词（如「华语」「粤语」「摇滚」「纯音乐」），
   * 按出现次数降序。歌单名是用户亲手写的风格自述，比任何推断都直接。
   */
  tags: string[];
  /** 参与画像的样本数（去过重），用来判断画像是否可信 */
  sampleSize: number;
}

/** 画像的一条输入：一首"有行为"的歌 */
export interface StyleSample {
  track: Track;
  /**
   * 该曲的累计统计。`null`/缺省 = 没听过（比如只是被收进歌单），
   * 这时 `saved` 是唯一的强弱信号。
   */
  stat?: TrackStat | null;
  /** 是否在收藏（喜欢的单曲 / 收藏歌单 / 自建歌单）里 */
  saved?: boolean;
}

/** `buildStyleProfile` 的入参 */
export interface StyleProfileInput {
  /** 有行为的曲目样本 */
  samples: StyleSample[];
  /** 用户自己的歌单名（抽风格词用；没有就传空数组） */
  playlistNames?: string[];
  /** 当前时刻（毫秒），测试注入用；缺省 `Date.now()` */
  now?: number;
}

/** 打分命中的特征 —— 只为**生成推荐理由**服务，不参与算分 */
export type RankHit =
  | "saved"
  | "same-album"
  | "main-lang"
  | "other-lang"
  | "main-band"
  | "familiar-singer"
  /** 歌手只出现在收藏/歌单里，没有播放证据 —— 理由不能说「常听」 */
  | "saved-singer"
  | "new-singer"
  | "unplayed"
  | "replayed"
  | "skipped";

/** 打分后的候选 */
export interface ScoredCandidate {
  track: Track;
  style: TrackStyle;
  /** 绝对分（未归一化，越大越好） */
  score: number;
  /** 命中的特征（按命中顺序，给理由生成用） */
  hits: RankHit[];
}

/** 打分 / 选择的选项 */
export interface RankOptions {
  /** 口味（决定每个特征的权重） */
  taste: DailyTaste;
  /** 目标条数，默认 50 */
  target?: number;
  /** 同歌手最多几条 */
  maxPerSinger?: number;
  /** 同语种最多几条（0 = 不限；`und` 不计入这个上限） */
  maxPerLang?: number;
  /**
   * 多样性强度 λ（MMR 里扣除的相似度权重）。
   * 0 = 纯按分数（会霸屏）；1 = 只求不相似。经验区间 0.4~0.9。
   */
  diversity?: number;
  /** 「换一批」的变体种子：同一天多次点能换出不同结果，但同一天内可复现 */
  variant?: string;
  /** 日期键 `YYYY-MM-DD`（抖动种子的一部分） */
  dateKey?: string;
  /** 最近几天推荐过的键（`trackKey` / `songNameKey`）：只降权不放逐 */
  historyKeys?: Set<string>;
  /** 已经听过的键（`trackKey`） */
  playedKeys?: Set<string>;
  /**
   * 常听歌手的键集合（已归一化，见 `trackStyle().singerKey`）。
   *
   * 画像里的 `singers` 是**加权**结果，会丢掉「既没播放统计也没收藏」的样本；
   * 而平台的歌手播放榜（`ipc.getTopSingers`）是全网历史的一手统计，覆盖面更广。
   * 两边都不是全集，所以歌手熟悉的程度按「画像权重优先、榜单权重减半」合并。
   */
  familiarSingers?: Set<string>;
  /** 与候选同序的屏蔽标记（`true` = 硬排除） */
  disliked?: boolean[];
  /** 行为质量（键 = `trackKey`；没有统计的歌不要放进来） */
  quality?: Map<string, TrackQuality>;
  /** 用户收藏/歌单里的键（`trackKey` 与 `songNameKey` 都可能命中） */
  savedKeys?: Set<string>;
}