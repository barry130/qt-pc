import type { Track } from "@/types";

/**
 * 文本归一化与键的唯一真源。
 *
 * 这里收敛的是「各模块原来各写一份」的纯函数：归一化、键、解码、确定性哈希。
 * 它是叶子模块（只依赖 `@/types` 的类型），谁都能 import，不会成环。
 *
 * 注意与 `song-key.ts` 的 `normText` 区分：那边是**搜索跨页去重**专用的更激进
 * 归一化（栈式剥嵌套括号、额外剥书名号/方括号、歌手拆集合），且与
 * `qt-sources/src/actions/merge-search.ts` 逐字镜像 —— 两套规则语义不同，刻意不合并。
 */

/**
 * 归一化文本：去空白（含全角空格）、去括号内容、去标点、转小写。
 *
 * 用途：风格画像的歌手键/专辑键、「同名不同源」判重、抖动种子。这三处曾经
 * 各有一份逐字相同的实现（music-style / daily-recommend / recommend-rank），
 * 现在只有这一份 —— 改规则只改这里。
 */
export function normText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[·・.,，、\-—_/\\'"“”‘’!！?？:：;；]/g, "");
}

/**
 * 紧凑匹配文本：转小写 + 折叠全部空白。
 *
 * 比 `normText` 弱一档：只做「同一名字的写法差异」对齐（大小写/空格），
 * 不剥括号不去标点 —— 换源匹配、收藏查重、歌手名对齐用的都是它。
 * （源实现里的 `.trim()` 是多余的：空白全折叠了，首尾自然没了。）
 */
export function compactText(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, "");
}

/**
 * 曲目唯一键：`平台:原始id`。
 *
 * 与 Rust `db::store::db_track_id()` 同口径。本地路径与不同平台的同名 id
 * 靠它区分，不会互相顶掉。收 `Pick` 而不是完整 `Track`：有些调用方手里
 * 只有 `{platform, id}` 两个字段。
 */
export function trackKey(track: Pick<Track, "platform" | "id">): string {
  return `${track.platform}:${track.id}`;
}

/**
 * 同名同歌手键：同一首歌在不同音源 id 不同，靠这个把它们认成一首。
 * （播放历史降权、跨源去重、缓存判重都用它。）
 */
export function songNameKey(track: Track): string {
  return `${normText(track.title)}|${normText(track.singer)}`;
}

/**
 * 本地日期键 `YYYY-MM-DD`。
 *
 * 不能用 `toISOString()`：那是 UTC，东八区早八点前会把「今天」算成昨天。
 * 每日推荐的「当天缓存」、排序引擎的确定性抖动种子都靠它。
 */
export function localDateKey(now = new Date()): string {
  const y = now.getFullYear();
  const m = `${now.getMonth() + 1}`.padStart(2, "0");
  const d = `${now.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** URL 里可能不是合法百分号编码，解码失败就按原样用 */
export function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * FNV-1a 32 位哈希（确定性）。
 *
 * `jitter` 的根基：同一个输入永远同一个值，跨次运行/跨天缓存才有意义。
 */
export function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 稳定抖动 [0,1)：同一天同一首永远得到同一个值，缓存才有意义 */
export function jitter(seed: string, key: string): number {
  return (hashString(`${seed}|${key}`) % 1000) / 1000;
}

/** 按码点截断，避免把生僻字/emoji 劈成半个 */
export function truncateChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}
