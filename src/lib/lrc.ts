/** LRC 逐行歌词解析（纯函数，供播放页 / 桌面歌词共用） */

export interface LyricLine {
  /** 毫秒 */
  timeMs: number;
  text: string;
  /** 翻译（按时间戳匹配合并） */
  translation?: string;
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
 */
export function qtresCoverUrl(picUrl: string): string | null {
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
    const path = `cover/${b64}`;
    if (typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)) {
      return `http://qtres.localhost/${path}`;
    }
    return `qtres://localhost/${path}`;
  } catch {
    return null;
  }
}

