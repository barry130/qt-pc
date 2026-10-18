/**
 * 取链的档位回退阶梯（**唯一实现**，播放预解析与引擎取链桥共用）。
 *
 * 为什么需要：音源包的每条线路都声明了自己能出哪几档，取链时**只跑支持该档的
 * 线路**，不做降档重试。而播不出 320 的情况与「这歌没有无损」不同——音频源
 * 本身只有一档文件时，高码率前缀（M800 / F000 等）CDN 直接 404，每次都被
 * Range 预检判成死链。2026-10-17 实测 QQ 有声书章节：
 *   · M500（128k）→ 206 audio/mpeg，12,247,262 字节 / 765s ≈ 128kbps ✔
 *   · M800 / F000 → vkey 接口不给 purl；C400 → 404 / 64 字节
 * 就属于这一类：128 一拿就中，320/flac 全灭。不降档的话，用户默认音质
 * 是 320 就永远播不出来（表现是「这些是不是无法播放」）。
 *
 * 为什么抽成独立模块：同一条回退逻辑此前只长在 `stores/player.ts` 的播放动作
 * 预解析里，而引擎主导的换歌（自然播完自动切歌 / 随机下一首 / 打开流失败重取）
 * 走的是 `hooks/usePlayUrlBridge.ts` 的应答路径 —— 那里没有回退，于是
 * 「点一下能放、自动播下一集就报无法播放」。两处必须是同一份实现，否则口径
 * 一定分叉（历史上 play-guard 就分叉过一次）。
 *
 * 只回退到**该平台注册表声明过的档位**，顺序与 clampQualityForPlatform 同源
 * （QUALITIES 由低到高，qualityRanksOf 取反成高→低），不猜包外档位。
 */
import * as ipc from "@/services/ipc";
import { resolvePlayUrlDetailed } from "@/source-scripts";
import { qualityRanksOf, useSourceRegistryStore } from "@/stores/sourceRegistry";
import type { Track } from "@/types";

/** 一次回退取链的完整结果（失败时 url 为空串，其余字段为「没测出来」） */
export interface FallbackResolveResult {
  url: string;
  /** 本次失败是否只是环境问题（弱网 / 引擎页未就绪 / 应答超时） */
  stalled: boolean;
  referer: string;
  size: number | null;
  actualQuality: string;
  /** 真正出链的档位（空串 = 没有出链）；与请求档不同即说明发生了降档 */
  quality: string;
}

/**
 * 「这个专辑实际能出到哪一档」的记忆（跨曲目复用）。
 *
 * 为什么需要：降档阶梯虽然能出链，但**每次都要先把高档位跑满**。2026-10-17 实测
 * QQ 有声书：320 跑满 9s 链预算才判失败，再花 1s 走 128 —— 首次点一集要等约
 * 11s。而有声书一集就是一个独立 track（id 不同），引擎的地址缓存按
 * `platform:trackId:quality` 存，**跨集完全不命中**，于是每一集都要重付这 11s。
 *
 * 所以这里按 `平台:专辑` 记住「实际出链的最高档」：同一张专辑后续的曲目直接从
 * 这一档起试，不再白跑注定失败的高档位。一张专辑内的曲目编码是一致的（有声书
 * 更是整本同一套转码），因此这个记忆在真实场景里成立。
 *
 * 两个安全阀：
 * - 专辑名为空时**不记**（否则所有「未知专辑」的曲目会共用一个键，把别处的结论
 *   串过来）；
 * - 只在「请求档高于实际出链档」时记（真实观测到降档），不会凭空压低档位。
 *
 * 代价：若某张专辑里个别曲目其实有更高档，会被这张专辑此前的结论带着走。相比
 * 「每集固定多等 9 秒」，这个方向是可接受的 —— 且清缓存（设置 → 播放地址）即可复位。
 */
const qualityCeiling = new Map<string, string>();
const CEILING_CAP = 128;

function ceilingKeyOf(platform: string, album: string): string {
  return `${platform}:${album.trim().toLowerCase()}`;
}

/** 记下这张专辑实际能出的最高档（内部用；专辑名为空直接忽略） */
function rememberCeiling(platform: string, album: string, quality: string): void {
  const name = album.trim();
  if (name.length === 0 || quality.length === 0) return;
  const key = ceilingKeyOf(platform, name);
  const known = qualityCeiling.get(key);
  const ranks = qualityRanksOf(useSourceRegistryStore.getState().qualities);
  const rankOf = (q: string): number => ranks.indexOf(q);
  // 已有结论取两者中更高的那一档：先遇到低档、后遇到高档时要能升回去
  if (known !== undefined && rankOf(known) >= 0 && rankOf(quality) >= 0 && rankOf(known) <= rankOf(quality)) {
    return;
  }
  qualityCeiling.delete(key);
  qualityCeiling.set(key, quality);
  while (qualityCeiling.size > CEILING_CAP) {
    const oldest = qualityCeiling.keys().next().value;
    if (oldest === undefined) break;
    qualityCeiling.delete(oldest);
  }
}

/** 这张专辑已知能出的最高档（没有结论返回 null） */
export function peekQualityCeiling(platform: string, album: string): string | null {
  const name = album.trim();
  if (name.length === 0) return null;
  return qualityCeiling.get(ceilingKeyOf(platform, name)) ?? null;
}

/** 清空档位记忆（设置页「播放地址」清理 / 测试用） */
export function clearQualityCeilingCache(): number {
  const count = qualityCeiling.size;
  qualityCeiling.clear();
  return count;
}

/**
 * 该曲目平台的档位回退阶梯（从请求档一路往下，最低一档收尾）。
 *
 * 请求档不在该源声明的阶梯上时（例如上次用 flac、切到只声明 128/320 的源，
 * 或注册表还没拉到）按**该源最好的可用档**起试，与 clampQualityForPlatform
 * 的钳位口径一致：拿一个该源根本不会出的档去试只会白烧一次 Range 预检。
 * 阶梯彻底为空（注册表未就绪）时才照原样只试请求档。
 *
 * `album` 给了且这张专辑此前被观测到只能出更低档时，起点直接降到那一档
 * （见 qualityCeiling 的注释：有声书每集都会重付一次高档位的失败预算）。
 */
export function qualityFallbackLadder(platform: string, wanted: string, album = ""): string[] {
  const registry = useSourceRegistryStore.getState();
  const declared = registry.sources.find((item) => item.id === platform)?.qualities;
  // 全局档位表按「高→低」排（qualityRanksOf 内部取反，见其注释）
  const allRanks = qualityRanksOf(registry.qualities);
  const ladder = (
    declared === undefined || declared.length === 0
      ? allRanks
      : allRanks.filter((q) => declared.includes(q))
  ).filter((q) => q.length > 0);
  if (ladder.length === 0) return [wanted];
  let start = ladder.indexOf(wanted);
  const ceiling = peekQualityCeiling(platform, album);
  if (ceiling !== null) {
    const ceilingRank = ladder.indexOf(ceiling);
    // 只在「记忆档比请求档低」时下调起点；请求档本来就更低（用户手动选了 128）
    // 或记忆档不在该源阶梯上时不动。
    if (ceilingRank >= 0 && (start < 0 || ceilingRank > start)) start = ceilingRank;
  }
  return start >= 0 ? ladder.slice(start) : ladder;
}

/**
 * 按回退阶梯逐档取链，返回第一次出链的完整结果。
 *
 * 全部失败时把 `stalled` 汇成「只要有一次是环境问题就算环境问题」：引擎据此
 * 不把曲目拉黑、不计入连续失败熔断（2026-10-03 弱网修复）。降档成功时
 * `actualQuality` 由包侧按实测码率重标，宿主下载命名不会虚标。
 */
export async function resolvePlayUrlWithFallback(
  track: Track,
  wanted: string,
): Promise<FallbackResolveResult> {
  const attempts = qualityFallbackLadder(track.platform, wanted, track.album);
  let stalled = false;
  for (const quality of attempts) {
    const res = await resolvePlayUrlDetailed(track, quality);
    if (res.url.length > 0) {
      if (quality !== wanted) {
        // 降档命中时，`resolvePlayUrlDetailed` 只把地址写进**实际档位**的缓存键
        // （platform:id:128）。而引擎随后是按**请求档**（320）查缓存的，必然未命中，
        // 又要经 playurl_bridge 问一次前端 —— 每播一集都白跑一轮跨进程往返，
        // 弱网下就是「点一下等好几秒」。这里补写一份请求档的键，让引擎直接命中。
        // 只补写成功出链的这一次，不写失败，避免把死档位固化进缓存。
        await ipc
          .setResolvedPlayUrl(track, wanted, res.url, res.referer, res.size, res.actualQuality)
          .catch(() => {});
      }
      // 只在**真实观测到降档**时记上限。以请求档命中时不能记：那只证明「这一档能出」，
      // 并不证明更高档出不了 —— 记了会把 flac 也一起挡在门外（请求 320 成功 ≠ 这张
      // 专辑没有无损）。
      if (quality !== wanted) rememberCeiling(track.platform, track.album, quality);
      return { ...res, quality };
    }
    if (res.stalled) stalled = true;
  }
  return { url: "", stalled, referer: "", size: null, actualQuality: "", quality: "" };
}
