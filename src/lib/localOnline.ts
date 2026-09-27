import * as sourceApi from "@/source-scripts";
import { playUrlHitLine } from "@/source-scripts/playurl-line";
import type { PlayUrlLine } from "@/source-engine/client";
import type { Lyric, Quality, SourceId, Track } from "@/types";

/**
 * 本地曲目的在线元数据（酷我按歌名 + 歌手匹配）：歌词 + 翻译 + 封面。
 *
 * 本地文件没有平台 id，直接按 id 向音源要歌词必然 `unsupported`；统一改在酷我
 * 搜一次补齐。按文件路径做进程内缓存（同一路径的并发请求合并成一个
 * Promise），拉取失败也缓存空结果，避免每次渲染重试打网络。
 *
 * 应用不再内置音源实现：搜索/歌词都经 sourceApi（音源包）取。
 */

export interface LocalOnlineMeta {
  lrc: string;
  translation: string;
  picUrl: string;
}

const EMPTY: LocalOnlineMeta = { lrc: "", translation: "", picUrl: "" };

const cache = new Map<string, Promise<LocalOnlineMeta>>();

async function fetchOnlineMeta(
  title: string,
  singer: string,
): Promise<LocalOnlineMeta> {
  if (title.length === 0) return EMPTY;
  const keyword = singer.length > 0 ? `${title} ${singer}` : title;
  const hits = await sourceApi.searchMusic(keyword, "kw", 1, 5);
  const meta: LocalOnlineMeta = { ...EMPTY };
  // 逐个命中取封面 / 歌词：多数情况第 1 条就齐了，歌词为空（纯音乐等）时才看下一条
  for (const hit of hits) {
    if (meta.picUrl.length === 0 && hit.picUrl.length > 0) meta.picUrl = hit.picUrl;
    if (meta.lrc.length === 0) {
      try {
        const lyric = await sourceApi.getLyric(hit);
        if (lyric.lrc.trim().length > 0) {
          meta.lrc = lyric.lrc;
          meta.translation = lyric.translation;
        }
      } catch {
        // 该命中取词失败：继续看下一条
      }
    }
    if (meta.picUrl.length > 0 && meta.lrc.length > 0) break;
  }
  return meta;
}

/** 按路径取在线元数据；path 即本地 Track.id（文件绝对路径） */
export function resolveLocalOnlineMeta(
  path: string,
  title: string,
  singer: string,
): Promise<LocalOnlineMeta> {
  const cached = cache.get(path);
  if (cached) return cached;
  const task = fetchOnlineMeta(title.trim(), singer.trim()).catch(() => EMPTY);
  cache.set(path, task);
  return task;
}

const ONLINE_SOURCES: ReadonlyArray<Exclude<SourceId, "local">> = ["wyy", "qq", "kw", "kg"];

/** 跨源兜底命中信息：target = 实际在播的源；song = 线路上精确命中的那首歌（旧引擎页为 null） */
export interface CrossSourceHit {
  target: SourceId;
  song: Track | null;
}

/** 从命中线路解析跨源兜底（id 形如 `cross:kw`，targetSong 是命中的歌，可能为 null） */
export function crossSourceHitFromLine(line: PlayUrlLine | null, currentPlatform: SourceId): CrossSourceHit | null {
  if (line === null || !line.id.startsWith("cross:")) return null;
  const target = line.id.slice("cross:".length);
  if (!(ONLINE_SOURCES as readonly string[]).includes(target) || target === currentPlatform) {
    return null;
  }
  return { target: target as SourceId, song: crossSongToTrack(line.targetSong, target as SourceId) };
}

/** 当前实际播放地址是否来自跨源兜底：是则返回目标源与命中歌曲（歌词按它重取），否则 null */
export function crossSourceForPlayback(track: Track | null, quality: Quality | null): CrossSourceHit | null {
  if (track === null || track.platform === "local" || quality === null) return null;
  return crossSourceHitFromLine(playUrlHitLine(track, quality), track.platform);
}

function crossSongToTrack(song: PlayUrlLine["targetSong"], platform: SourceId): Track | null {
  if (song === null) return null;
  return sourceApi.toAppTrack(song, platform);
}

/** 跨源取词：在目标平台搜同名歌，逐个命中取词直到非空（与本地曲目补词同套路） */
async function fetchCrossSourceLyric(
  target: SourceId,
  title: string,
  singer: string,
): Promise<Lyric | null> {
  const keyword = singer.length > 0 ? `${title} ${singer}` : title;
  const hits = await sourceApi.searchMusic(keyword, target, 1, 5);
  for (const hit of hits) {
    try {
      const lyric = await sourceApi.getLyric(hit);
      if (lyric.lrc.trim().length > 0) return lyric;
    } catch {
      // 该命中取词失败：继续看下一条
    }
  }
  return null;
}

/**
 * 播放用歌词：本地曲目走酷我匹配（匹配不到返回空歌词，由页面显示「没有歌词」），
 * 在线曲目仍走原音源；换源兜底在播（cross 非空）时优先取目标源的词——线路带精确
 * 命中歌（targetSong）就按它取，否则在目标源按歌名搜；目标源取不到词才退回原源。
 */
export async function getPlaybackLyric(track: Track, cross: CrossSourceHit | null = null): Promise<Lyric> {
  if (track.platform !== "local" && cross !== null && cross.target !== track.platform) {
    if (cross.song !== null) {
      const exact = await sourceApi.getLyric(cross.song).catch(() => null);
      if (exact !== null && exact.lrc.trim().length > 0) return exact;
    }
    const matched = await fetchCrossSourceLyric(cross.target, track.title.trim(), track.singer.trim()).catch(() => null);
    if (matched !== null) return matched;
  }
  if (track.platform !== "local") {
    return sourceApi.getLyric(track);
  }
  const meta = await resolveLocalOnlineMeta(track.id, track.title, track.singer);
  return { lrc: meta.lrc, translation: meta.translation };
}
