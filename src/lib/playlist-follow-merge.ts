/** Pure three-way membership merge. Keep local order; append only new source members. */
export interface FollowDelta {
  add: string[];
  remove: string[];
  baseline: string[];
  suppressed: string[];
}
export function mergeFollow(
  baseline: string[] | null, remote: string[], local: string[], suppressed: string[] = [], protectedKeys: string[] = [],
): FollowDelta {
  const next = [...new Set(remote)];
  const localSet = new Set(local);
  const remoteSet = new Set(next);
  const old = new Set(baseline ?? next);
  const keep = new Set(protectedKeys);
  const removedByUser = new Set(suppressed);
  for (const key of old) if (!localSet.has(key)) removedByUser.add(key);
  // An explicit local re-add overrides an earlier suppression.
  for (const key of localSet) removedByUser.delete(key);
  return {
    add: baseline === null ? [] : next.filter(key => !old.has(key) && !localSet.has(key) && !removedByUser.has(key)),
    remove: baseline === null ? [] : local.filter(key => old.has(key) && !remoteSet.has(key) && !keep.has(key)),
    baseline: next,
    suppressed: [...removedByUser],
  };
}
