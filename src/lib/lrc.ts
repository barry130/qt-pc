/** LRC 逐行歌词解析（纯函数，供播放页 / 桌面歌词共用） */

/** 逐字歌词里的一个词：起点一律相对行首（音源包两种口径在解析出口已归一，见下） */
export interface LyricWord {
  /** 相对行首的起点，毫秒 */
  startMs: number;
  /** 时长，毫秒 */
  durationMs: number;
  text: string;
}

export interface LyricLine {
  /** 毫秒 */
  timeMs: number;
  text: string;
  /** 翻译（按时间戳匹配合并） */
  translation?: string;
  /** 罗马音（按时间戳匹配合并，同 translation 的就近合并口径） */
  romanization?: string;
  /** 逐字（有则卡拉 OK 逐字染色） */
  words?: LyricWord[];
}

function parseTimeTag(tag: string): number | null {
  // [mm:ss] / [mm:ss.xx] / [mm:ss.xxx]
  const m = /^(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?$/.exec(tag);
  if (!m) return null;
  const min = parseInt(m[1], 10);
  const sec = parseInt(m[2], 10);
  const fracRaw = m[3] ?? "0";
  const frac = parseInt(fracRaw, 10) / Math.pow(10, fracRaw.length);
  return Math.round((min * 60 + sec + frac) * 1000);
}

/** 解析 LRC 文本为按时间升序的行；忽略元数据标签与空行 */
export function parseLrc(text: string): LyricLine[] {
  if (!text) return [];
  const lines: LyricLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    const tags = [...line.matchAll(/\[([^\[\]]+)\]/g)];
    if (tags.length === 0) continue;
    const content = line.replace(/\[([^\[\]]+)\]/g, "").trim();
    for (const t of tags) {
      const ms = parseTimeTag(t[1]);
      if (ms === null) continue; // [ti:] 等元数据
      lines.push({ timeMs: ms, text: content });
    }
  }
  lines.sort((a, b) => a.timeMs - b.timeMs);
  // 同一时间的多行合并（多行同 tag 场景），保留首个
  const merged: LyricLine[] = [];
  for (const l of lines) {
    const last = merged[merged.length - 1];
    if (last && last.timeMs === l.timeMs) {
      if (!last.text && l.text) last.text = l.text;
      continue;
    }
    merged.push(l);
  }
  return merged;
}

/**
 * 解析逐字歌词（音源包 `wordByWord`，行内格式）：
 * `[行起点ms,行时长ms]词(词起点ms,词时长ms)…`。
 *
 * 三个源（wyy YRC / qq QRC / kg KRC）在包里都已统一成这个形态，
 * 所以这里只需要一套解析器——不要按源分支。
 * 文本里理论上可以含括号，故按「文本段 + (数字,数字)」成对读取，而不是先剥标签。
 *
 * 词起点 **并不总是** 相对行首：包侧归一到这一行格式却沿用了各源自己的口径 ——
 * qq/部分源给的是行内绝对时间（首词起点 ≈ 行起点），kg 给的是相对值（首词起点 0）。
 * 统一在解析出口按下面的 `normalizeWordTimeline` 折算成相对行首，
 * 上层（卡拉 OK 染色）只认相对口径，不再分支判源。
 */

/**
 * 把一行里的词时间轴统一换算成「相对行首」。
 *
 * 判定用两个锚点各自与两套口径的误差之和：首词起点（绝对≈行起点 / 相对≈0）
 * 与末词终点（绝对≈行起点+时长 / 相对≈时长）。误差小的那套胜出；都贴合不了
 * （异常数据）就按契约原样返回相对值，至少不会比现在更差。
 *
 * 容忍度 400ms：行起点与首词起点在包侧各自四舍五入，几十毫秒的漂移要能吃下。
 */
const WORD_TIMELINE_TOLERANCE_MS = 400;

function normalizeWordTimeline(
  timeMs: number,
  durationMs: number,
  words: LyricWord[],
): LyricWord[] {
  if (words.length === 0) return words;
  const first = words[0];
  const last = words[words.length - 1];
  const lastEnd = last.startMs + last.durationMs;
  const errAbsolute =
    Math.abs(first.startMs - timeMs) + Math.abs(lastEnd - (timeMs + durationMs));
  const errRelative = Math.abs(first.startMs) + Math.abs(lastEnd - durationMs);
  // 严格小于：两套误差相等（典型是行起点为 0 的开场行）时按契约保持相对
  if (errAbsolute < errRelative && errAbsolute <= WORD_TIMELINE_TOLERANCE_MS) {
    return words.map((w) => ({ ...w, startMs: w.startMs - timeMs }));
  }
  return words;
}

export function parseWordByWordLrc(text: string): LyricLine[] {
  if (!text) return [];
  const lines: LyricLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const head = /^\[(\d+),(\d+)\]/.exec(line);
    if (head === null) continue; // 元信息行（[ti:] 等）没有逐字时间轴
    const timeMs = parseInt(head[1], 10);
    const body = line.slice(head[0].length);
    const words: LyricWord[] = [];
    const re = /([^()]*)\((\d+),(\d+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const wordText = m[1];
      if (wordText.length === 0) continue; // 纯间奏的占位括号（如 `-(320,160)`）
      words.push({
        startMs: parseInt(m[2], 10),
        durationMs: parseInt(m[3], 10),
        text: wordText,
      });
    }
    if (words.length === 0) continue;
    lines.push({
      timeMs,
      text: words.map((w) => w.text).join(""),
      words: normalizeWordTimeline(timeMs, parseInt(head[2], 10), words),
    });
  }
  lines.sort((a, b) => a.timeMs - b.timeMs);
  return lines;
}

/** 将罗马音按时间戳（±500ms 内就近）合并进歌词行（与 mergeTranslation 同口径） */
export function mergeRomanization(main: LyricLine[], romanization: string): LyricLine[] {
  if (!romanization) return main;
  const roma = parseLrc(romanization);
  if (roma.length === 0) return main;
  return main.map((line) => {
    if (!line.text) return line;
    let best: LyricLine | null = null;
    let bestDiff = 501;
    for (const r of roma) {
      const diff = Math.abs(r.timeMs - line.timeMs);
      if (diff < bestDiff && r.text) {
        best = r;
        bestDiff = diff;
      }
    }
    return best ? { ...line, romanization: best.text } : line;
  });
}

/** 将翻译歌词按时间戳（±500ms 内就近）合并进主歌词 */
export function mergeTranslation(main: LyricLine[], translation: string): LyricLine[] {
  if (!translation) return main;
  const trans = parseLrc(translation);
  if (trans.length === 0) return main;
  return main.map((line) => {
    if (!line.text) return line;
    let best: LyricLine | null = null;
    let bestDiff = 501;
    for (const t of trans) {
      const diff = Math.abs(t.timeMs - line.timeMs);
      if (diff < bestDiff && t.text) {
        best = t;
        bestDiff = diff;
      }
    }
    return best ? { ...line, translation: best.text } : line;
  });
}

/** 二分查找当前时间对应的活跃行下标；无行返回 -1 */
export function findActiveIndex(lines: LyricLine[], timeMs: number): number {
  if (lines.length === 0) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].timeMs <= timeMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * 逐字行的「已唱比例」（0~1）：桌面歌词的卡拉 OK 用它把整行渐变分界点
 * 随演唱推进。播放页逐词拆 span 染色，桌面歌词字小、带描边/阴影/跑马灯，
 * 按词渲染得不偿失——改成整行一条渐变，分界点 = 已唱字符占比
 * （中日文等宽字占绝大多数，字符占比 ≈ 宽度占比，英文按字符近似够用）。
 *
 * - 无 words / 唱完最后一个词 → 1（整行高亮）
 * - 行已激活但第一个词还没开唱 → 0（整行暗）
 * - 词间间奏 gap：词内比例在该词末尾被夹住，填充停在已唱完的位置不动，
 *   下一个词开唱才继续推进
 */
export function karaokeFillRatio(line: LyricLine, elapsedInLineMs: number): number {
  const words = line.words ?? [];
  if (words.length === 0) return 1;
  const totalChars = words.reduce((n, w) => n + w.text.length, 0);
  if (totalChars === 0) return 1;
  // 已开唱的最后一个词；它之前的词全部视为唱完
  let end = -1;
  for (let i = 0; i < words.length; i += 1) {
    if (words[i].startMs <= elapsedInLineMs) end = i;
    else break;
  }
  if (end < 0) return 0;
  const w = words[end];
  const passed = elapsedInLineMs - w.startMs;
  const raw = w.durationMs > 0 ? passed / w.durationMs : passed >= 0 ? 1 : 0;
  const ratio = raw < 0 ? 0 : raw > 1 ? 1 : raw;
  let sungChars = 0;
  for (let i = 0; i < end; i += 1) sungChars += words[i].text.length;
  sungChars += ratio * w.text.length;
  const fill = sungChars / totalChars;
  return fill < 0 ? 0 : fill > 1 ? 1 : fill;
}

export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * picUrl → 封面代理 URL（Rust 代取，CSP 不放开外部域名）。
 * 遵循 Tauri v2 自定义协议地址约定（与 convertFileSrc 一致）：
 * - Windows/WebView2 不认识自定义 scheme，必须用 http://qtres.localhost/<path>
 * - 其余平台为 qtres://localhost/<path>
 * Rust 侧 handle_qtres 对两种形式都用 uri().path() 解析，路径统一为 /cover/<base64url>。
 *
 * `px` 可选：目标边长（Rust 侧会按它向上游要缩略图，缺省 300 = 列表卡片 2×）。
 * 播放页大图传 900。不传时不追加查询串，输出与旧版逐字节一致。
 */
export function qtresCoverUrl(picUrl: string, px?: number): string | null {
  if (!picUrl) return null;
  if (!/^https?:\/\//i.test(picUrl)) return null;
  try {
    // URL 可能含非 ASCII（中文路径），btoa 只接受 Latin1，先过 UTF-8 编码
    const bytes = new TextEncoder().encode(picUrl);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    const b64 = btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const suffix = px ? `?w=${px}` : "";
    const path = `cover/${b64}${suffix}`;
    if (typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)) {
      return `http://qtres.localhost/${path}`;
    }
    return `qtres://localhost/${path}`;
  } catch {
    return null;
  }
}

