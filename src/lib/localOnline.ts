import * as ipc from "@/services/ipc";
import type { Lyric, Track } from "@/types";

/**
 * 本地曲目的在线元数据（酷我按歌名 + 歌手匹配）：歌词 + 翻译 + 封面。
 *
 * 本地文件没有平台 id，直接按 id 向音源要歌词必然 `unsupported`；统一改在酷我
 * 搜一次补齐。按文件路径做进程内缓存（同一路径的并发请求合并成一个 Promise），
 * 拉取失败也缓存空结果，避免每次渲染重试打网络。
 */

const EMPTY: ipc.LocalOnlineMeta = { lrc: "", translation: "", picUrl: "" };

const cache = new Map<string, Promise<ipc.LocalOnlineMeta>>();

/** 按路径取在线元数据；path 即本地 Track.id（文件绝对路径） */
export function resolveLocalOnlineMeta(
  path: string,
  title: string,
  singer: string,
): Promise<ipc.LocalOnlineMeta> {
  const cached = cache.get(path);
  if (cached) return cached;
  const task = ipc
    .getLocalOnlineMeta(title, singer)
    .then((m) => (m && typeof m === "object" ? { ...EMPTY, ...m } : EMPTY))
    .catch(() => EMPTY);
  cache.set(path, task);
  return task;
}

/**
 * 播放用歌词：本地曲目走酷我匹配（匹配不到返回空歌词，由页面显示「没有歌词」），
 * 在线曲目仍走原音源。两种来源的失败语义不同，调用方无需分支。
 */
export async function getPlaybackLyric(track: Track): Promise<Lyric> {
  if (track.platform !== "local") {
    return ipc.getLyric(track);
  }
  const meta = await resolveLocalOnlineMeta(track.id, track.title, track.singer);
  return { lrc: meta.lrc, translation: meta.translation };
}
