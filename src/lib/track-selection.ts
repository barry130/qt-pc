import type { Track } from "@/types";

export type TrackSelectionKey = (track: Track) => string;

/** 与曲目数据库身份一致；本地路径和不同平台的同名 id 不能互相选中。 */
export function trackSelectionKey(track: Pick<Track, "platform" | "id">): string {
  return `${track.platform}:${track.id}`;
}

/** 仅为尚未迁移的调用方保留的旧选择口径。 */
export const legacyTrackSelectionKey: TrackSelectionKey = (track) => track.id;

export interface TrackSelection {
  ids: Set<string>;
  onToggle: (trackId: string) => void;
  /** 提供后默认使用 trackSelectionKey；一次提交整批选择，避免多次 toggle 的竞态。 */
  onChange?: (next: Set<string>) => void;
  /** 只存本地文件路径的旧调用方可显式沿用 (track) => track.id。 */
  keyOf?: TrackSelectionKey;
}

/** 所有范围操作只读取当前可见顺序；锚点被筛掉后从当前项重新起选。 */
export function selectTrackRange(
  keys: readonly string[],
  selected: ReadonlySet<string>,
  anchor: string | null,
  target: string,
  additive = false,
): Set<string> {
  const end = keys.indexOf(target);
  if (end < 0) return new Set(selected);
  const anchorIndex = anchor === null ? -1 : keys.indexOf(anchor);
  const start = anchorIndex < 0 ? end : anchorIndex;
  const next = additive ? new Set(selected) : new Set<string>();
  for (let i = Math.min(start, end); i <= Math.max(start, end); i += 1) {
    next.add(keys[i]);
  }
  return next;
}

/** 保留可见选择；批量动作与过滤后的列表共享这个边界。 */
export function retainTrackSelection(
  tracks: readonly Track[],
  selected: Set<string>,
  keyOf: TrackSelectionKey = trackSelectionKey,
): Set<string> {
  const visible = new Set(tracks.map(keyOf));
  const next = new Set([...selected].filter((key) => visible.has(key)));
  return next.size === selected.size ? selected : next;
}

/** 标题 / 歌手 / 专辑的本地检索，空白与大小写不影响匹配。 */
export function filterTracks(tracks: Track[], query: string): Track[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return tracks;
  return tracks.filter((track) => {
    const text = `${track.title}\n${track.singer}\n${track.album}`.toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}
