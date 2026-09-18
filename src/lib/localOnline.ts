import { search } from "@/source-scripts/actions/aggregate";
import { getLyric as getLyricAction } from "@/source-scripts/actions/lyric";
import { hostRequest } from "@/source-scripts/host-request";
import * as sourceApi from "@/source-scripts";
import type { Lyric, Track } from "@/types";

/**
 * 本地曲目的在线元数据（酷我按歌名 + 歌手匹配）：歌词 + 翻译 + 封面。
 *
 * 本地文件没有平台 id，直接按 id 向音源要歌词必然 `unsupported`；统一改在酷我
 * 搜一次补齐（脚本层 kw 线路）。按文件路径做进程内缓存（同一路径的并发请求
 * 合并成一个 Promise），拉取失败也缓存空结果，避免每次渲染重试打网络。
 *
 * 原生 Rust Provider 已删除，本动作由共享脚本包承担（等价于原
 * get_local_online_meta 命令：搜 5 条命中，逐条补封面 / 歌词，取到即止）。
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
  const hits = await search(hostRequest, "kw", keyword, 1, 5);
  const meta: LocalOnlineMeta = { ...EMPTY };
  // 逐个命中取封面 / 歌词：多数情况第 1 条就齐了，歌词为空（纯音乐等）时才看下一条
  for (const hit of hits) {
    if (meta.picUrl.length === 0 && hit.picUrl.length > 0) meta.picUrl = hit.picUrl;
    if (meta.lrc.length === 0) {
      try {
        const lyric = await getLyricAction(hostRequest, "kw", hit);
        if (lyric.lyric.trim().length > 0) {
          meta.lrc = lyric.lyric;
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

/**
 * 播放用歌词：本地曲目走酷我匹配（匹配不到返回空歌词，由页面显示「没有歌词」），
 * 在线曲目仍走原音源。两种来源的失败语义不同，调用方无需分支。
 */
export async function getPlaybackLyric(track: Track): Promise<Lyric> {
  if (track.platform !== "local") {
    return sourceApi.getLyric(track);
  }
  const meta = await resolveLocalOnlineMeta(track.id, track.title, track.singer);
  return { lrc: meta.lrc, translation: meta.translation };
}
