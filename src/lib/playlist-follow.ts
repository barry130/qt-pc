import * as ipc from "@/services/ipc";
import { getPlaylistDetail } from "@/source-scripts";
import { mergeFollow } from "./playlist-follow-merge";
import type { Playlist, Track } from "@/types";
import { useFavoritesStore } from "@/stores/favorites";
import { assertSourceEnabled, assertSourcePolicyCurrent, sourceEnabled, sourcePolicyRevision, waitSourcePolicy } from "./source-policy";

export interface PlaylistFollow {
  pid: string; source: string; sourceId: string; link: string; enabled: boolean;
  baseline: string[] | null; suppressed: string[]; protectedKeys: string[];
  checkedAt: number; error: string; revision: number;
}
export interface FollowPreview {
  record: PlaylistFollow; remote: Playlist; added: Track[]; removed: Track[];
  localKeys: string[]; next: PlaylistFollow; owner: string; epoch: number; expectedJson: string | null; policyRevision: number;
}
const keyOf = (track: Track): string => JSON.stringify([track.platform, track.id]);
const storageKey = (owner: string): string => `playlist.follow.v1:${owner || "guest"}`;
export const PLAYLIST_FOLLOW_CHANGED = "qt:playlist-follow-changed";
async function context(): Promise<{ owner: string; epoch: number }> {
  const epoch = await ipc.likeSessionEpoch();
  const owner = (await ipc.getSetting("like.sync.owner")) ?? "";
  if (epoch !== await ipc.likeSessionEpoch()) throw new Error("账号已变化，请重试");
  return { owner, epoch };
}
function stringKeys(value: unknown): value is string[] { return Array.isArray(value) && value.every(key => typeof key === "string"); }
function decode(raw: string | null): PlaylistFollow[] {
  if (!raw) return [];
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data) || data.some(row => !row || typeof row.pid !== "string" || typeof row.source !== "string" || typeof row.sourceId !== "string" || typeof row.enabled !== "boolean" || !Number.isFinite(row.revision) || !Number.isFinite(row.checkedAt) || !stringKeys(row.suppressed) || !stringKeys(row.protectedKeys) || (row.baseline !== null && !stringKeys(row.baseline)))) throw new Error("歌单跟随记录损坏，请重新关联来源");
  return data as PlaylistFollow[];
}
async function read(owner: string): Promise<PlaylistFollow[]> {
  return decode(await ipc.getSetting(storageKey(owner)));
}
async function write(record: PlaylistFollow, owner: string, epoch: number, expectedJson: string | null): Promise<void> {
  const records = decode(expectedJson);
  const next = records.filter(row => row.pid !== record.pid);
  next.push(record);
  await ipc.applyPlaylistFollow({ pid: record.pid, owner, expectedLocalKeys: null, added: [], removed: [], expectedJson, nextJson: JSON.stringify(next) }, epoch);
  window.dispatchEvent(new CustomEvent(PLAYLIST_FOLLOW_CHANGED));
}
export async function playlistFollow(pid: string): Promise<PlaylistFollow | null> {
  const ctx = await context();
  return (await read(ctx.owner)).find(row => row.pid === pid) ?? null;
}
export async function attachPlaylistFollow(pid: string, remote: Playlist, existing: Track[], epoch: number): Promise<void> {
  const ctx = await context();
  if (ctx.epoch !== epoch) throw new Error("账号已变化，请重试");
  if (remote.complete !== true) throw new Error("来源歌单不完整，暂不能开启跟随");
  const expectedJson = await ipc.getSetting(storageKey(ctx.owner));
  const records = decode(expectedJson);
  if (records.some(row => row.pid === pid)) throw new Error("目标歌单已经关联来源，请导入到另一歌单");
  const remoteTracks = [...new Map((remote.tracks ?? []).map(t => [keyOf(t), t])).values()];
  const existingKeys = new Set(existing.map(keyOf));
  records.push({ pid, source: remote.platform, sourceId: remote.id, link: "", enabled: true,
    baseline: remoteTracks.map(keyOf), suppressed: [], protectedKeys: existing.map(keyOf),
    checkedAt: Date.now(), error: "", revision: Date.now() });
  await ipc.applyPlaylistFollow({ pid, owner: ctx.owner, expectedLocalKeys: existing.map(keyOf), added: remoteTracks.filter(t => !existingKeys.has(keyOf(t))), removed: [], expectedJson, nextJson: JSON.stringify(records) }, epoch);
  window.dispatchEvent(new CustomEvent(PLAYLIST_FOLLOW_CHANGED));
}
export async function togglePlaylistFollow(pid: string): Promise<void> {
  const ctx = await context();
  const expectedJson = await ipc.getSetting(storageKey(ctx.owner));
  const record = decode(expectedJson).find(row => row.pid === pid);
  if (!record) return;
  await write({ ...record, enabled: !record.enabled, revision: record.revision + 1 }, ctx.owner, ctx.epoch, expectedJson);
}
export async function previewPlaylistFollow(pid: string): Promise<FollowPreview> {
  await waitSourcePolicy();
  const policyRevision = sourcePolicyRevision();
  const ctx = await context();
  const expectedJson = await ipc.getSetting(storageKey(ctx.owner));
  const record = decode(expectedJson).find(row => row.pid === pid);
  if (!record) throw new Error("该歌单尚未关联来源");
  assertSourceEnabled(record.source);
  const [remote, local] = await Promise.all([getPlaylistDetail(record.source, record.sourceId), ipc.getPlaylistTracks(pid)]);
  assertSourcePolicyCurrent(policyRevision);
  if (ctx.epoch !== await ipc.likeSessionEpoch()) throw new Error("账号已变化，请重新检查");
  if (!remote.name || remote.complete !== true) throw new Error("来源未返回完整歌单，本次未修改。请更新数据包或稍后重试");
  const remoteTracks = [...new Map((remote.tracks ?? []).map(t => [keyOf(t), t])).values()];
  const delta = mergeFollow(record.baseline, remoteTracks.map(keyOf), local.map(keyOf), record.suppressed, record.protectedKeys);
  const additions = new Set(delta.add); const removals = new Set(delta.remove);
  return { record, remote, added: remoteTracks.filter(t => additions.has(keyOf(t))), removed: local.filter(t => removals.has(keyOf(t))),
    localKeys: local.map(keyOf), next: { ...record, baseline: delta.baseline, suppressed: delta.suppressed,
      checkedAt: Date.now(), error: "", revision: record.revision + 1 }, expectedJson, policyRevision, ...ctx };
}
export async function applyPlaylistFollow(preview: FollowPreview): Promise<void> {
  const ctx = await context();
  if (ctx.owner !== preview.owner || ctx.epoch !== preview.epoch) throw new Error("账号已变化，请重新检查");
  const current = (await read(ctx.owner)).find(row => row.pid === preview.record.pid);
  if (!current || current.revision !== preview.record.revision) throw new Error("跟随设置已变化，请重新检查");
  // Native commit compares the displayed local snapshot and changes membership/checkpoint atomically.
  const records = decode(preview.expectedJson).map(row => row.pid === current.pid ? preview.next : row);
  assertSourcePolicyCurrent(preview.policyRevision);
  assertSourceEnabled(current.source);
  await ipc.applyPlaylistFollow({ pid: current.pid, owner: ctx.owner, expectedLocalKeys: preview.localKeys, added: preview.added, removed: preview.removed,
    expectedJson: preview.expectedJson, nextJson: JSON.stringify(records) }, ctx.epoch);
  useFavoritesStore.getState().bump();
  window.dispatchEvent(new CustomEvent(PLAYLIST_FOLLOW_CHANGED));
}
let running = false;
/** Foreground-only, sequential, at most three due playlists; failures also have a 24h retry limit. */
export async function refreshDuePlaylistFollows(): Promise<void> {
  if (running || document.hidden) return;
  running = true;
  try {
    await waitSourcePolicy();
    const ctx = await context();
    const local = new Set((await ipc.listMyPlaylists()).filter(p => p.platform === "local" && !p.isSmart).map(p => p.pid));
    const due = (await read(ctx.owner)).filter(row => row.enabled && sourceEnabled(row.source) && local.has(row.pid) && Date.now() - row.checkedAt >= 86_400_000).slice(0, 3);
    for (const record of due) {
      if (!sourceEnabled(record.source)) continue;
      const policyToken = sourcePolicyRevision();
      if (document.hidden || ctx.epoch !== await ipc.likeSessionEpoch()) break;
      try {
        const preview = await previewPlaylistFollow(record.pid);
        if (!document.hidden) await applyPlaylistFollow(preview);
      }
      catch (error) {
        if (policyToken !== sourcePolicyRevision() || !sourceEnabled(record.source)) continue;
        const expectedJson = await ipc.getSetting(storageKey(ctx.owner));
        const current = decode(expectedJson).find(row => row.pid === record.pid);
        if (current?.revision === record.revision) await write({ ...record, checkedAt: Date.now(), error: error instanceof Error ? error.message : "检查失败" }, ctx.owner, ctx.epoch, expectedJson);
      }
    }
  } finally { running = false; }
}
