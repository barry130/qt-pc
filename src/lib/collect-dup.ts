import type { Track } from "@/types";

/**
 * 收藏时的「同名不同源」查重（2026-10-07）。
 *
 * 为什么需要：收藏表 `liked_songs` 的唯一键是 `UNIQUE(uid, platform, sid)`——
 * 同一首歌在不同音源上是**两条独立记录**（id 不同、platform 不同）。所以
 * 「周杰伦-稻香（QQ）」和「周杰伦-稻香（网易云）」能同时躺在一个歌单里，
 * 界面上看就是两行一模一样的歌。用户收藏时并不知道里面已经有了另一个源的
 * 同一首，加完才发现重复 —— 所以要在**加入前**提示，让用户自己决定。
 *
 * 只做判定、不做 IO，也不引 `@/source-scripts`（那会把音源包拖进收藏链路）：
 * 归一化与包含判定从 lib/source-switch.ts 的 scoreCandidate 抄同款规则，
 * 但这里只关心「是不是同名」，不打分排序。
 */

/**
 * 歌手字段里常见的分隔符：各音源写法不一（`/`、`&`、`、`、`／`、`|`、`+`、
 * 中文「和」「与」等），而且「周杰伦 / 林妙可」和「周杰伦&林妙可」是同一批人。
 * 判定前统一替换成半角逗号，拆成集合再比对。
 */
const ARTIST_SEPARATORS = /[\/／\\|&、,，;；+＋]|\s*(?:和|与|feat\.?|ft\.?)\s*/gi;

/** 归一化匹配文本：小写 + 折叠空白（与换源 scoreCandidate 同口径） */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}

/** 把歌手字段拆成集合（归一化后的每个名字） */
function splitArtists(text: string): string[] {
  const out: string[] = [];
  for (const part of (text ?? "").split(ARTIST_SEPARATORS)) {
    const name = normalize(part);
    if (name.length > 0) out.push(name);
  }
  return out;
}

/**
 * 歌名里的「版本修饰」：整块括号里说的只是版本/用途，不影响是不是同一首歌。
 * 剥掉它们再比，`稻香 (Live)` 与 `稻香`、「某某（伴奏）」与「某某」才算同名。
 */
const TITLE_NOISE =
  /[（(\[【][^)）\]】]*(?:live|remix|instrumental|acoustic|cover|demo|ost|mv|伴奏|翻唱|纯音乐|清唱|现场|原声|版)[^)）\]】]*[)）\]】]/gi;

/** 比对前连标点/括号一起剥掉：全角半角写法不同不该影响判定 */
const TITLE_PUNCT =
  /[()（）\[\]【】{}<>《》「」『』""''.,，。、:：;；!！?？~～_\-—…·|/\\]/g;

/** 歌名归一化：小写 → 剥版本修饰 → 折叠空白 → 剥标点 */
function normalizeTitle(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .replace(TITLE_NOISE, "")
    .replace(/\s+/g, "")
    .replace(TITLE_PUNCT, "");
}

/**
 * 两首歌是否「同名」：歌名归一化后相等，或互相包含（一边带后缀时包含关系仍成立）。
 * 任一侧歌名为空判否——空名不具备判定价值。
 */
function sameTitle(a: string, b: string): boolean {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (x.length === 0 || y.length === 0) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * 歌手是否对得上：**拆成集合后只要有一个名字对得上就算**。
 *
 * 为什么要拆：各音源的合写符号完全不同（`/`、`&`、`&`、`、`、`／`、`|`、
 * `+`、`和`、`feat.`），「周杰伦 / 林妙可」与「周杰伦&林妙可」是同一批人，
 * 但整串比对（旧写法）互不包含，会被判成两首歌 —— 这正是要修的漏判。
 * 拆开比对还顺带解决了「谁排在前」的问题。
 *
 * 双方都为空（纯音乐 / 元数据缺失）时不拦，按同名处理。
 */
function singerCompatible(a: string, b: string): boolean {
  const x = splitArtists(a);
  const y = splitArtists(b);
  if (x.length === 0 || y.length === 0) return true;
  for (const p of x) {
    for (const q of y) {
      if (p === q || p.includes(q) || q.includes(p)) return true;
    }
  }
  return false;
}

/**
 * 在目标歌单现有曲目里找「同名不同源」的歌。
 *
 * @param track  准备收藏的歌
 * @param existing 目标歌单里已有的曲目（调用方从 `ipc.getPlaylistTracks(pid)` 取）
 * @returns 冲突曲目（platform 与 track 不同、但同名）；无冲突返回空数组
 *
 * 注意「同名同 id 同平台」不算冲突：那是同一首歌，收藏动作本身是幂等的。
 */
export function findCrossSourceDup(track: Track, existing: Track[]): Track[] {
  const out: Track[] = [];
  for (const item of existing) {
    if (item.platform === track.platform) continue;
    if (!sameTitle(item.title, track.title)) continue;
    if (!singerCompatible(item.singer, track.singer)) continue;
    out.push(item);
  }
  return out;
}
