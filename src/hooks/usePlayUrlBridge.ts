import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { resolvePlayUrlDetailed } from "@/source-scripts";
import { playUrlHitLine } from "@/source-scripts/playurl-line";
import type { Quality, Track } from "@/types";

/**
 * 引擎 → 前端取链桥：
 * 引擎主导的换歌（自然播完自动切歌、随机模式下一首、打开流失败后的重取）
 * 前端无法预判，PlayUrlCache 必然未命中。原生 Rust Provider 已整体删除，
 * 引擎取链前统一发 `play_url_request` 问脚本线路，这里按「换源顺序」应答：
 * 脚本链解析出的地址回填引擎缓存；local / 解析失败回空串（本次取链失败）。
 *
 * 仅主窗口架桥：桌面歌词窗口复用同一 bundle，但不应答、不置就绪标志。
 * 监听注册成功后才置就绪，避免引擎在监听挂上前发请求白等超时。
 */

/** playurl_bridge.rs 的 PlayUrlRequest（camelCase 透传） */
interface PlayUrlRequest {
  requestId: number;
  track: Track;
  quality: Quality;
}

async function answer(req: PlayUrlRequest): Promise<void> {
  let url = "";
  // 本次失败是否只是环境问题（弱网 / 引擎页未就绪 / 应答超时）。
  // 引擎据此不把这首拉黑、不计入连续失败熔断（2026-10-03 弱网修复）。
  let stalled = false;
  // 宿主取这个地址时要带的 Referer（包按源声明；空串 = 不发）。地址进引擎
  // 缓存后由播放/下载直接向 CDN 取字节，没有头可能直接 403（B 站实测）。
  let referer = "";
  // 取链诚实性（2026-10-06）：包侧 Range 预检顺手量到的文件总长，与按
  // 「实测字节 ÷ 时长」重标后的档位（只降不升）。null / 空串 = 没测出来。
  let size: number | null = null;
  let actualQuality = "";
  try {
    // resolvePlayUrl 内部已做源门禁（local 直接报错）并回填引擎缓存
    const res = await resolvePlayUrlDetailed(req.track, req.quality);
    url = res.url;
    stalled = res.stalled;
    referer = res.referer;
    size = res.size;
    actualQuality = res.actualQuality;
  } catch {
    url = "";
    stalled = true;
    referer = "";
    size = null;
    actualQuality = "";
  }
  // 迟到的应答（引擎已超时回落）在 Rust 侧按 requestId 找不到条目，静默忽略
  await invoke("resolve_play_url_reply", {
    requestId: req.requestId,
    url,
    stalled,
    referer,
    size,
    actualQuality,
  }).catch(() => {});
  // 桌面歌词窗口读不到宿主侧的线路记忆（各窗口独立 JS 上下文），广播命中线路供它
  // 判断「当前地址是否跨源兜底」并按目标源重取歌词；主窗口自己读 playurl-line 即可
  void emit("play-url-line", {
    platform: req.track.platform,
    id: req.track.id,
    line: playUrlHitLine(req.track, req.quality),
  }).catch(() => {});
}

export function usePlayUrlBridge(): void {
  useEffect(() => {
    if (getCurrentWindow().label !== "main") return;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void (async () => {
      try {
        const u = await listen<PlayUrlRequest>("play_url_request", (event) => {
          void answer(event.payload);
        });
        if (disposed) {
          u();
          return;
        }
        unlisten = u;
        await invoke("script_bridge_ready").catch(() => {});
      } catch (e) {
        // 架桥失败 = 引擎主导的每一次换歌（自动切歌/随机下一首/失败重取）都取不到
        // 地址，且本次会话内不会自愈，用户必须看得见。补上上下文再抛给全局兜底
        // （main.tsx 的 unhandledrejection）：只留一个裸的 listen 失败无从定位。
        throw new Error(`取链桥事件监听注册失败：${String(e)}`);
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
