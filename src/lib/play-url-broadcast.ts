/**
 * 把「当前曲目这次取链命中的线路」广播给其它窗口。
 *
 * 为什么要有这一层：桌面歌词窗口是**独立 WebView、独立 JS 上下文**，读不到主窗口
 * 里的线路记忆（`source-scripts/playurl-line.ts` 的 rawLines）。它判断「当前地址是否
 * 被跨源兜底接走」只能靠 `play-url-line` 事件。而事件的发出点以前只有一个：引擎主动
 * 问前端 `play_url_request` 的那条路径（usePlayUrlBridge 的 answer）。
 *
 * 于是有两条路径永远发不出事件，「换源后歌词跟着换」对它们完全不生效：
 * ① 用户点播放（前端预解析好地址塞进引擎缓存，引擎不需要再问前端）；
 * ② 桌面歌词窗口在取链**之后**才打开（事件早已发过，监听才挂上）。
 *
 * 现在：取链漏斗 `resolvePlayUrlWithFallback` 出链即广播（覆盖 ① 与所有路径），
 * 歌词窗口启动时用 `request-play-url-line` 向主窗口要一次（覆盖 ②）。
 */
import { emit } from "@tauri-apps/api/event";
import type { Quality, Track } from "@/types";
import { playUrlHitLine } from "@/source-scripts/playurl-line";

/** 歌词窗口启动时发给主窗口的「请把当前线路补发一次」请求事件名 */
export const PLAY_URL_LINE_REQUEST_EVENT = "request-play-url-line";

/** 主窗口 → 所有窗口的命中线路广播事件名 */
export const PLAY_URL_LINE_EVENT = "play-url-line";

/** 广播命中线路（line 为 null 也照发：让对端知道「这首没有被跨源接走」） */
export function broadcastPlayUrlLine(track: Track | null, quality: Quality | null): void {
  if (track === null) return;
  try {
    void emit(PLAY_URL_LINE_EVENT, {
      platform: track.platform,
      id: track.id,
      line: playUrlHitLine(track, quality),
    }).catch(() => {
      /* 没有窗口在听 / 非 Tauri 运行时：广播失败不该影响播放 */
    });
  } catch {
    /* 单测与浏览器直开里 emit 会同步抛（没有 __TAURI_INTERNALS__），忽略 */
  }
}

/**
 * 请主窗口把「当前曲目命中线路」补发一次（桌面歌词窗口启动时调用）。
 *
 * 为什么需要：歌词窗口可能在取链**之后**才打开，`play-url-line` 早已发过，
 * 它的 crossLineByTrack 会一直是空的 —— 于是桌面歌词永远按原平台取词。
 * 单窗口调试 / 单测里没有主窗口应答，静默即可（按原源取词）。
 */
export function requestPlayUrlLine(): void {
  try {
    void emit(PLAY_URL_LINE_REQUEST_EVENT).catch(() => {});
  } catch {
    /* 同上：没有 Tauri 运行时（或被测试 mock 掉 emit）时不该让窗口打崩 */
  }
}
