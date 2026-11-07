import type { Track } from "@/types";
import { compareCollectMatch, prepareCollectMatch } from "./collect-match";

/**
 * 跨音源收藏版本候选：按歌名、歌手、专辑相似度提示，由用户选择保留哪些版本。
 * 规则与 qt-uniappx/services/collect-dup.ts 同步；同平台仍由收藏唯一键去重。
 */
export function findCrossSourceDup(track: Track, existing: Track[]): Track[] {
  const out: Track[] = [];
  const wanted = prepareCollectMatch(track.title, track.singer, track.album);
  for (const item of existing) {
    if (item.platform === track.platform) continue;
    if (compareCollectMatch(wanted, prepareCollectMatch(item.title, item.singer, item.album)).matches) out.push(item);
  }
  return out;
}
