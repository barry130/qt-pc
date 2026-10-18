import type { Track } from "@/types";
import * as ipc from "@/services/ipc";
import { useTrackFlags } from "./useTrackFlags";

// Rust DislikeMatcher 只读歌名与歌手；同 id 的元数据补全也必须重新判定。
// 原文只用于缓存键，归一化/版本后缀剥离仍由 Rust 完成。
const dislikeKey = (track: Track): string => JSON.stringify([track.title, track.singer]);

/** 规则变化后版本失效；请求失败或未返回时标记降级为空，不阻塞列表使用。 */
export function useDislikeFlags(tracks: Track[], version: number): boolean[] {
  return useTrackFlags(tracks, version, ipc.checkDisliked, dislikeKey);
}
