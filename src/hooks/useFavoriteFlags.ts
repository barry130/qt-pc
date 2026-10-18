import type { Track } from "@/types";
import * as ipc from "@/services/ipc";
import { useTrackFlags } from "./useTrackFlags";

// 与 Rust is_liked_songs_flags 的 (sid, platform) 判定一致；其他元数据不影响收藏。
const favoriteKey = (track: Track): string => JSON.stringify([track.platform, track.id]);

/** 收藏变化后版本失效；列表搜索/重排复用本实例已查结果，只批查新增曲目。 */
export function useFavoriteFlags(tracks: Track[], version: number): boolean[] {
  return useTrackFlags(tracks, version, ipc.checkFavoriteFlags, favoriteKey);
}
