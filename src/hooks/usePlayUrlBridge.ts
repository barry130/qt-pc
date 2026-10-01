import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { resolvePlayUrl } from "@/source-scripts";
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
  try {
    // resolvePlayUrl 内部已做源门禁（local 直接报错）并回填引擎缓存
    url = await resolvePlayUrl(req.track, req.quality);
  } catch {
    url = "";
  }
  // 迟到的应答（引擎已超时回落）在 Rust 侧按 requestId 找不到条目，静默忽略
  await invoke("resolve_play_url_reply", { requestId: req.requestId, url }).catch(() => {});
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
      const u = await listen<PlayUrlRequest>("play_url_request", (event) => {
        void answer(event.payload);
      });
      if (disposed) {
        u();
        return;
      }
      unlisten = u;
      await invoke("script_bridge_ready").catch(() => {});
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
