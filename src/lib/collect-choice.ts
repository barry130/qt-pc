import type { Track } from "@/types";
import { COLLECT_MATCH_THRESHOLDS, compareCollectMatch, prepareCollectMatch, type CollectMatchKey } from "./collect-match";
export type CollectChoiceGroup = { id: string; songs: Track[]; existingKeys: string[] };
export type CollectChoicePlan = { groups: CollectChoiceGroup[]; adds: Track[]; removes: Track[] };
export function collectKey(song: Track): string { return song.platform + ":" + song.id; }

type PreparedSong = { song: Track; match: CollectMatchKey; characters: Map<string, number> };

function prepareSong(song: Track): PreparedSong {
  const match = prepareCollectMatch(song.title, song.singer, song.album);
  const characters = new Map<string, number>();
  // 与共享编辑距离相同，按 UTF-16 code unit 计数；异常长名称只允许精确匹配。
  if (match.title.length <= 256) {
    for (let i = 0; i < match.title.length; i++) {
      const char = match.title.charAt(i);
      characters.set(char, (characters.get(char) ?? 0) + 1);
    }
  }
  return { song, match, characters };
}

/** 只排除不可能达标的歌名；最终判断仍由两端共享的 compareCollectMatch 决定。 */
function couldMatchTitle(a: PreparedSong, b: PreparedSong): boolean {
  const x = a.match.title, y = b.match.title;
  if (!x || !y) return false;
  if (x === y) return true;
  if (a.match.singers.length === 0 || b.match.singers.length === 0) return false;
  const length = Math.max(x.length, y.length);
  if (Math.min(x.length, y.length) <= 3 || length > 256) return false;
  const threshold = Math.min(COLLECT_MATCH_THRESHOLDS.title, COLLECT_MATCH_THRESHOLDS.albumTitle);
  if (Math.min(x.length, y.length) * 100 / length < threshold) return false;
  let difference = x.length + y.length;
  for (const [char, count] of a.characters) difference -= 2 * Math.min(count, b.characters.get(char) ?? 0);
  // 一次编辑最多消除两个字符计数差。因此 ceil(L1 / 2) 是编辑距离的下界，
  // 只能减少无效比较，不会改变相似度阈值或漏掉共享规则中的候选。
  return (length - Math.ceil(difference / 2)) * 100 / length >= threshold;
}

/** 连通分组覆盖已有重复与同一批新增项之间的重复；只展示涉及此次新增的组。 */
function* collectChoiceSteps(existing: Track[], incoming: Track[]): Generator<void, CollectChoicePlan> {
  const existingKeys = new Set<string>();
  const groups: CollectChoiceGroup[] = [];
  const unique: Track[] = [];
  const seen = new Set<string>();
  let work = 0;
  for (const song of incoming) {
    const key = collectKey(song);
    if (!seen.has(key)) { seen.add(key); unique.push(song); }
    if (++work % 64 === 0) yield;
  }
  if (unique.length === 0) return { groups, adds: [], removes: [] };
  const prepared: PreparedSong[] = [];
  for (const song of existing) {
    existingKeys.add(collectKey(song));
    prepared.push(prepareSong(song));
    if (++work % 64 === 0) yield;
  }
  const wanted: PreparedSong[] = [];
  for (const song of unique) {
    const item = prepareSong(song);
    wanted.push(item); prepared.push(item);
    if (++work % 64 === 0) yield;
  }
  for (const item of wanted) {
    const song = item.song;
    const matches: Track[] = [];
    for (const candidate of prepared) {
      if (candidate.song.platform !== song.platform && couldMatchTitle(item, candidate)) {
        if (compareCollectMatch(item.match, candidate.match).matches) matches.push(candidate.song);
        // 真正的编辑距离比预筛选昂贵，长名称也要有机会及时让出界面线程。
        yield;
      }
      if (++work % 64 === 0) yield;
    }
    if (matches.length == 0) continue;
    const candidates = [song];
    const keys = new Set([collectKey(song)]);
    for (const match of matches) {
      candidates.push(match); keys.add(collectKey(match));
      if (++work % 64 === 0) yield;
    }
    const merged: Track[] = [];
    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i];
      let overlaps = false;
      for (const s of group.songs) {
        if (keys.has(collectKey(s))) { overlaps = true; break; }
        if (++work % 64 === 0) yield;
      }
      if (overlaps) {
        for (const s of group.songs) {
          candidates.push(s); keys.add(collectKey(s));
          if (++work % 64 === 0) yield;
        }
        groups.splice(i, 1);
      }
      if (++work % 64 === 0) yield;
    }
    const added = new Set<string>();
    const keptKeys: string[] = [];
    for (const s of candidates) {
      const key = collectKey(s);
      if (!added.has(key)) {
        added.add(key); merged.push(s);
        if (existingKeys.has(key)) keptKeys.push(key);
      }
      if (++work % 64 === 0) yield;
    }
    groups.push({ id: collectKey(song), songs: merged, existingKeys: keptKeys });
  }
  const adds: Track[] = [];
  for (const song of unique) {
    if (!existingKeys.has(collectKey(song))) adds.push(song);
    if (++work % 64 === 0) yield;
  }
  return { groups, adds, removes: [] };
}

export function buildCollectChoice(existing: Track[], incoming: Track[]): CollectChoicePlan {
  const steps = collectChoiceSteps(existing, incoming);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

/** 界面入口按约 8ms 分片检查；关闭面板或切换选择后停止，避免过期计划进入界面。 */
export async function buildCollectChoiceAsync(
  existing: Track[], incoming: Track[], isActive: () => boolean,
): Promise<CollectChoicePlan | null> {
  const steps = collectChoiceSteps(existing, incoming);
  let deadline = performance.now() + 8;
  while (isActive()) {
    const next = steps.next();
    if (next.done) return next.value;
    if (performance.now() >= deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      deadline = performance.now() + 8;
    }
  }
  return null;
}
export function resolveCollectChoice(plan: CollectChoicePlan, selected: string[]): CollectChoicePlan {
  const scope = new Set<string>();
  const selectedKeys = new Set(selected);
  const adds: Track[] = [], removes: Track[] = [];
  for (const group of plan.groups) {
    if (!group.songs.some((s: Track): boolean => selectedKeys.has(collectKey(s)))) throw new Error("每组至少保留一个版本");
    const existingKeys = new Set(group.existingKeys);
    for (const song of group.songs) {
      const key = collectKey(song); scope.add(key);
      if (selectedKeys.has(key) && !existingKeys.has(key)) adds.push(song);
      if (!selectedKeys.has(key) && existingKeys.has(key)) removes.push(song);
    }
  }
  for (const song of plan.adds) if (!scope.has(collectKey(song))) adds.push(song);
  return { groups: plan.groups, adds, removes };
}
