/**
 * 歌单分享链接 / ID 解析 —— **仅作老包回退用**。
 *
 * 2026-10-06（报告 §4 第 11 项）：解析的权威实现已下沉到音源包
 * （`qt-sources/src/actions/sheet-import.ts`，入口 `parseSheet`），两端宿主统一
 * 调包内入口；本文件只在「音源包太旧（26 入口）/ 引擎未就绪」时被
 * `source-scripts/index.ts:parseSheetInput` 兜底调用。
 *
 * 分享文案常是整段话（如「分享XX的歌单《名称》https://t1.kugou.com/xxx（@酷狗音乐）」），
 * 所以先抠出第一个 URL，再按 URL 判断平台；纯数字 ID 则交给调用方指定的平台。
 * 本模块保持无依赖的纯函数，便于单测。
 */
import type { SourceId } from "@/types";

export interface ParsedPlaylistInput {
  platform: SourceId;
  id: string;
}

/** 分享文案里的 URL（排除中文书名号/括号等夹带字符） */
const URL_PATTERN = /https?:\/\/[^\s\u300A\u300B\uFF08\uFF09]+/;

/**
 * 解析歌单输入：返回 null 表示无法识别。
 *
 * @param text 用户粘贴的分享链接 / 分享文案 / 歌单 ID
 * @param fallback 纯数字 ID（整段就是数字）时使用的平台
 */
export function parsePlaylistInput(
  text: string,
  fallback?: SourceId,
): ParsedPlaylistInput | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  // 酷狗原生 ID（收藏歌单 collection_… / 全球歌单 gcid_…）：整段就是 ID
  if (/^(collection_|gcid_)[A-Za-z0-9_-]+$/.test(trimmed)) {
    return { platform: "kg", id: trimmed };
  }

  const urlMatch = URL_PATTERN.exec(trimmed);
  const t = (urlMatch?.[0] ?? trimmed).trim();
  if (t.length === 0) return null;
  const lower = t.toLowerCase();

  let platform: SourceId | null = null;
  if (
    lower.includes("music.163.com") ||
    lower.includes("163cn.tv") ||
    lower.includes("163.com")
  ) {
    platform = "wyy";
  } else if (
    lower.includes("y.qq.com") ||
    lower.includes("c.y.qq.com") ||
    lower.includes("qq.com")
  ) {
    platform = "qq";
  } else if (lower.includes("kugou.com")) {
    platform = "kg";
  } else if (lower.includes("kuwo.cn") || lower.includes("kuwo.com")) {
    platform = "kw";
  }

  // 酷狗：末段可能是「网页歌单 id.html」「分享短码」两类，
  // 前者要还原成数字 id（数字歌单接口），后者交给 chain 短码接口
  if (platform === "kg") {
    const seg = lastPathSegment(t);
    if (seg.length > 0) {
      const bare = seg.replace(/\.html?$/i, "");
      if (/^[0-9]+$/.test(bare)) return { platform: "kg", id: bare };
      if (/[a-zA-Z]/.test(seg)) return { platform: "kg", id: seg };
    }
  }

  const id = extractExplicitId(t) ?? extractLongestDigits(t);
  if (platform !== null && id.length > 0) {
    return { platform, id };
  }
  // 纯数字 id 且整段就是数字：用 fallback 平台
  if (id.length > 0 && id === t && fallback !== undefined) {
    return { platform: fallback, id };
  }
  // 指定平台下粘贴裸分享短码（酷狗 t1.kugou.com/<字母码> 里的码）
  if (
    fallback === "kg" &&
    /^[A-Za-z0-9_.-]+$/.test(trimmed) &&
    /[A-Za-z]/.test(trimmed)
  ) {
    return { platform: "kg", id: trimmed };
  }
  return null;
}

/**
 * 常见网页链接里的显式歌单 id：`?id=` 查询参数或
 * `/playlist|playlist_detail|special/single/<id>` 路径段。
 * 优先于「最长数字段」——否则 `?id=888` 会被域名里的 163 抢走。
 */
export function extractExplicitId(url: string): string | null {
  const query = /[?&]id=([0-9]+)/.exec(url);
  if (query) return query[1];
  const path = /\/(?:playlist|playlist_detail|single)\/([0-9]+)/.exec(url);
  if (path) return path[1];
  return null;
}

/** 取 URL 最后一段路径（去掉查询/锚点/尾斜杠），如 https://t1.kugou.com/abc123 → abc123 */
export function lastPathSegment(text: string): string {
  let t = text.trim();
  const q = t.indexOf("?");
  if (q >= 0) t = t.slice(0, q);
  const h = t.indexOf("#");
  if (h >= 0) t = t.slice(0, h);
  while (t.length > 0 && t.endsWith("/")) t = t.slice(0, -1);
  const lastSlash = t.lastIndexOf("/");
  if (lastSlash < 0 || lastSlash === t.length - 1) return "";
  // 只保留路径段开头连续的合法 token 字符（字母/数字/._-）：
  // 分享文案里可能连着中文或标点（defensive：tJnW20zxV3（@酷狗...）
  let seg = t.slice(lastSlash + 1);
  let end = seg.length;
  for (let i = 0; i < seg.length; i += 1) {
    const c = seg.charCodeAt(i);
    const ok =
      (c >= 48 && c <= 57) ||
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      c === 45 ||
      c === 46 ||
      c === 95;
    if (!ok) {
      end = i;
      break;
    }
  }
  seg = seg.slice(0, end);
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** 从文本里提取最长的一段连续数字，作为歌单 id */
export function extractLongestDigits(text: string): string {
  let best = "";
  let cur = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 48 && c <= 57) {
      cur += text.charAt(i);
    } else {
      if (cur.length > best.length) best = cur;
      cur = "";
    }
  }
  return cur.length > best.length ? cur : best;
}
