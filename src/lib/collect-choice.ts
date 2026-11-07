import type { Track } from "@/types";
import { findCrossSourceDup } from "./collect-dup";
export type CollectChoiceGroup = { id: string; songs: Track[]; existingKeys: string[] };
export type CollectChoicePlan = { groups: CollectChoiceGroup[]; adds: Track[]; removes: Track[] };
export function collectKey(song: Track): string { return song.platform + ":" + song.id; }

/** 连通分组覆盖已有重复与同一批新增项之间的重复；只展示涉及此次新增的组。 */
export function buildCollectChoice(existing: Track[], incoming: Track[]): CollectChoicePlan {
  const existingKeys = existing.map((s: Track): string => collectKey(s));
  const groups: CollectChoiceGroup[] = [];
  const unique: Track[] = [];
  const seen = new Set<string>();
  for (const song of incoming) if (!seen.has(collectKey(song))) { seen.add(collectKey(song)); unique.push(song); }
  for (const song of unique) {
    const matches = findCrossSourceDup(song, [...existing, ...unique]);
    if (matches.length == 0) continue;
    const candidates = [song, ...matches];
    const keys = new Set(candidates.map((s: Track): string => collectKey(s)));
    const merged: Track[] = [];
    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i];
      if (!group.songs.some((s: Track): boolean => keys.has(collectKey(s)))) continue;
      for (const s of group.songs) { candidates.push(s); keys.add(collectKey(s)); }
      groups.splice(i, 1);
    }
    const added = new Set<string>();
    for (const s of candidates) if (!added.has(collectKey(s))) { added.add(collectKey(s)); merged.push(s); }
    groups.push({ id: collectKey(song), songs: merged, existingKeys: merged.filter((s: Track): boolean => existingKeys.includes(collectKey(s))).map((s: Track): string => collectKey(s)) });
  }
  return { groups, adds: unique.filter((s: Track): boolean => !existingKeys.includes(collectKey(s))), removes: [] };
}
export function resolveCollectChoice(plan: CollectChoicePlan, selected: string[]): CollectChoicePlan {
  const scope = new Set<string>();
  const adds: Track[] = [], removes: Track[] = [];
  for (const group of plan.groups) {
    if (!group.songs.some((s: Track): boolean => selected.includes(collectKey(s)))) throw new Error("每组至少保留一个版本");
    for (const song of group.songs) {
      const key = collectKey(song); scope.add(key);
      if (selected.includes(key) && !group.existingKeys.includes(key)) adds.push(song);
      if (!selected.includes(key) && group.existingKeys.includes(key)) removes.push(song);
    }
  }
  for (const song of plan.adds) if (!scope.has(collectKey(song))) adds.push(song);
  return { groups: plan.groups, adds, removes };
}
