import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { peekQualityCeiling, normalizeQualityForSource, resolvePlayUrlWithFallback } from "@/lib/quality-fallback";
import {
  broadcastPlayUrlLine,
  PLAY_URL_LINE_REQUEST_EVENT,
} from "@/lib/play-url-broadcast";
import { qualityShortLabel } from "@/lib/quality";
import { toast } from "@/stores/toast";
import { usePlayerStore } from "@/stores/player";
import type { Quality, Track } from "@/types";
import { MAIN_WINDOW_LABEL } from "@/lib/window-labels";

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
  // 五个字段 try/catch 两路都会赋值（成功取链 / 失败回退），声明处不初始化，
  // 让 TS 的确定赋值分析保证「不漏赋」；初始化值反而是永远读不到的死赋值。
  let url: string;
  // 本次失败是否只是环境问题（弱网 / 引擎页未就绪 / 应答超时）。
  // 引擎据此不把这首拉黑、不计入连续失败熔断（2026-10-03 弱网修复）。
  let stalled: boolean;
  // 宿主取这个地址时要带的 Referer（包按源声明；空串 = 不发）。地址进引擎
  // 缓存后由播放/下载直接向 CDN 取字节，没有头可能直接 403（B 站实测）。
  let referer: string;
  // 取链诚实性（2026-10-06）：包侧 Range 预检顺手量到的文件总长，与按
  // 「实测字节 ÷ 时长」重标后的档位（只降不升）。null / 空串 = 没测出来。
  let size: number | null;
  let actualQuality: string;
  // 实际出链档位：降档时线路记忆是按**实际档位**记的（rememberPlayUrlLine 的键
  // 就是真正请求成功的那一档），广播线路给歌词窗口时必须用同一口径，否则读到空串。
  let hitQuality = req.quality;
  // 同专辑已知上限时不弹「只能提供 X」：有声书一本几百集，逐集弹同一句等于噪声
  // 存量请求档可能是旧第三方档名（v11 官方清单生效时）：先归一再取链与比对，
  // 否则「实际出链档 ≠ 请求档」的降档提示每首都误弹（官方 level 名对不上旧档名）
  const wanted = normalizeQualityForSource(req.track.platform, req.quality);
  const known = peekQualityCeiling(req.track.platform, req.track.album);
  try {
    // 降档回退与播放动作预解析共用同一份阶梯（@/lib/quality-fallback）：
    // 引擎主导的换歌（自然播完自动切歌 / 随机下一首 / 打开流失败重取）走的
    // 就是这条路径，不回退的话 QQ 有声书章节这类「只有 128k 一档文件」的曲目
    // 会表现成「点一下能放、自动播下一集就报无法播放」。
    const res = await resolvePlayUrlWithFallback(req.track, wanted);
    url = res.url;
    stalled = res.stalled;
    referer = res.referer;
    size = res.size;
    actualQuality = res.actualQuality;
    if (res.quality.length > 0) hitQuality = res.quality;
    if (url.length > 0 && res.quality !== wanted && known === null) {
      // 不静默降档：让用户知道听到的是 128K 而不是请求的档位
      toast(`当前音源只能提供 ${qualityShortLabel(res.quality)}：${req.track.title}`);
    }
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
  // 判断「当前地址是否跨源兜底」并按目标源重取歌词（取链漏斗里也已广播一次，这里
  // 是引擎主导换歌时的即时一次；重复广播幂等，对端按曲目 id 覆盖）。
  broadcastPlayUrlLine(req.track, hitQuality as Quality);
}

export function usePlayUrlBridge(): void {
  useEffect(() => {
    if (getCurrentWindow().label !== MAIN_WINDOW_LABEL) return;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    let unlistenRequest: UnlistenFn | null = null;
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
        // 桌面歌词窗口在取链**之后**才打开时，`play-url-line` 事件早已发过，它的
        // crossLineByTrack 永远是空的 → 桌面歌词一直按原源取词（用户报的「换了源
        // 歌词没换」里最常踩的一条）。窗口启动时发这条请求，主窗口按当前曲目补发。
        unlistenRequest = await listen(PLAY_URL_LINE_REQUEST_EVENT, () => {
          const state = usePlayerStore.getState().state;
          if (state === null) return;
          broadcastPlayUrlLine(state.track ?? null, state.quality);
        });
        if (disposed) {
          unlistenRequest();
          return;
        }
        await invoke("script_bridge_ready").catch(() => {});
      } catch (e) {
        // 架桥失败 = 引擎主导的每一次换歌（自动切歌/随机下一首/失败重取）都取不到
        // 地址，且本次会话内不会自愈，用户必须看得见。补上上下文再抛给全局兜底
        // （main.tsx 的 unhandledrejection）：只留一个裸的 listen 失败无从定位。
        // cause 保留原始异常：全局兜底（main.tsx）的 ErrorBoundary 能打出
        // 完整链路，而不是只有一个包装后的中文提示。
        throw new Error(`取链桥事件监听注册失败：${String(e)}`, { cause: e });
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
      unlistenRequest?.();
    };
  }, []);
}
