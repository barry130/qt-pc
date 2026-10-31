/**
 * 「这条播放地址是音源包里哪条源取到的」——取链命中线路的宿主侧记忆。
 *
 * 为什么要在宿主侧记一份：线路只在**取链那一刻**知道（bundle 的 getPlayUrl 应答
 * 里带回），而地址会被 Rust 引擎缓存并复用、界面上随时可能被点开查看；同一条歌
 * 换个时间也可能被不同线路接走（顺序回退 + parallel 抢跑 + 跨源兜底），只看地址
 * 看不出是哪个源。所以按「曲目 + 音质」记下最近一次命中的线路，与安卓端
 * `music-api.playUrlLine()` 同一口径（key 与展示文本都一致）。
 *
 * 只在内存里：重启后第一次取链会重新写；命中包内缓存时为「未知」（见 PlayUrlLine）。
 */
import type { Quality, Track } from "@/types";
import type { PlayUrlLine } from "@/source-engine/client";

const lines = new Map<string, string>();
const misses = new Map<string, string>();

/** 原始线路记忆（含跨源命中的 targetSong）：「歌词跟随换源」要按精确歌曲取词 */
const rawLines = new Map<string, PlayUrlLine>();

/** 记忆键：与取链缓存同口径（platform:id:quality） */
export function playUrlLineKey(track: Track, quality: Quality): string {
  return `${track.platform}:${track.id}:${quality}`;
}

/**
 * 展示文本：`名称 · 机制 · 线路 id`（缺名称/机制时只拼有的那几段，
 * 与安卓端 rememberUrlLine 输出逐字一致）。
 */
export function formatPlayUrlLine(line: PlayUrlLine): string {
  const segments: string[] = [];
  if (line.name.length > 0) segments.push(line.name);
  if (line.kind.length > 0) segments.push(line.kind);
  segments.push(line.id);
  return segments.join(" · ");
}

/** 记下本次命中线路（line null = 未知，保持原值不动）；命中即清掉上一次的死因。
 *  missNote = 官方前置线路的尝试结论（诊断用；非空时随死因一起展示——官方失败
 *  会静默落回第三方链，不记下来用户只看到命中线路名，看不出官方为什么没走）。 */
export function rememberPlayUrlLine(
  track: Track,
  quality: Quality,
  line: PlayUrlLine | null,
  missNote?: string,
): void {
  if (line === null) return;
  const key = playUrlLineKey(track, quality);
  lines.set(key, formatPlayUrlLine(line));
  // 原始结构单独记一份：展示文本拼完就丢了 targetSong，而「歌词跟随换源」
  // 要按目标源的**精确那首歌**取词（见 crossSourceHitFromLine）。
  rawLines.set(key, line);
  if (missNote !== undefined && missNote.length > 0) misses.set(key, missNote);
  else misses.delete(key);
}

/**
 * 把「实际出链档位」的线路记忆镜像到**请求档**上。
 *
 * 为什么会缺这一步：`resolvePlayUrlWithFallback` 降档命中时，只把地址补写进请求档
 * 的缓存键（`ipc.setResolvedPlayUrl(track, wanted, …)`），线路记忆却留在实际档位上。
 * 而播放页/桌面歌词是按 `state.quality`（**请求档**）查 `playUrlHitLine` 的，于是
 * 降档播放时「换源后歌词跟着换」整条链路又被绕断 —— 用户报的「换了源歌词没换」
 * 里，降档是最难复现的那条路径。
 *
 * 只镜像原始结构、不镜像展示文本：展示文本说的是「这一档真正用的那条线」，
 * 冒认到更高档位会骗人；而歌词只关心「跨源命中的是哪首歌」。
 */
export function mirrorPlayUrlLine(track: Track, from: Quality, to: Quality): void {
  if (from === to) return;
  const line = rawLines.get(playUrlLineKey(track, from));
  if (line === undefined) return;
  rawLines.set(playUrlLineKey(track, to), line);
}

/** 读最近一次命中线路的原始结构（含 targetSong；未知返回 null） */
export function playUrlHitLine(track: Track | null, quality: Quality | null): PlayUrlLine | null {
  if (track === null || quality === null) return null;
  return rawLines.get(playUrlLineKey(track, quality)) ?? null;
}

/** 读某首歌某个音质最近一次命中的线路展示文本（未知返回空串） */
export function playUrlLine(track: Track | null, quality: Quality | null): string {
  if (track === null || quality === null) return "";
  return lines.get(playUrlLineKey(track, quality)) ?? "";
}

/**
 * 记下本次取链的失败死因（bundle 的逐线路 trace）。
 *
 * 为什么值得记：PC 上「取不到地址」以前只表现为播不动 + 跳歌，看不出是线路挂死、
 * 死链、还是跨源兜底根本没跑（2026-09-24 排查 kg 不换源时，正是靠这条 trace 才
 * 定位到 `cross:kw=预算耗尽未跑`）。管理端面板把它显示成「上次取链死因」。
 */
export function rememberPlayUrlMiss(track: Track, quality: Quality, reason: string): void {
  if (reason.length === 0) return;
  misses.set(playUrlLineKey(track, quality), reason);
}

/** 读某首歌某个音质最近一次取链失败死因（没失败过返回空串） */
export function playUrlMiss(track: Track | null, quality: Quality | null): string {
  if (track === null || quality === null) return "";
  return misses.get(playUrlLineKey(track, quality)) ?? "";
}

/** 清空（测试用 / 设置页可选清理）并返回清理条目数。 */
export function clearPlayUrlLines(): number {
  const count = new Set([...lines.keys(), ...rawLines.keys(), ...misses.keys()]).size;
  lines.clear();
  rawLines.clear();
  misses.clear();
  return count;
}
