import * as ipc from "@/services/ipc";
import { collectKey, type CollectChoicePlan } from "./collect-choice";
import type { Track } from "@/types";

/** Writes are restricted to this playlist; add must succeed before any removal. */
export async function applyCollectChoice(pid: string, plan: CollectChoicePlan, baseline: Track[], epoch: number, active: () => boolean = () => true): Promise<void> {
  const signature = (tracks: Track[]): string => tracks.map(collectKey).sort().join("\n");
  const checkActive = (): void => { if (!active()) throw new Error("收藏选择已变化，请重新选择"); };
  checkActive();
  if (await ipc.likeSessionEpoch() !== epoch) throw new Error("账号已变化，请重新选择");
  const current = await ipc.getPlaylistTracks(pid);
  if (signature(current) !== signature(baseline)) throw new Error("歌单内容已变化，请重新选择");
  if (await ipc.likeSessionEpoch() !== epoch) throw new Error("账号已变化，请重新选择");
  checkActive();
  if (plan.adds.length) await ipc.addTracksToPlaylist(pid, plan.adds, epoch);
  // Verify additions actually landed before deleting a previously working version.
  const after = await ipc.getPlaylistTracks(pid);
  if (await ipc.likeSessionEpoch() !== epoch) throw new Error("账号已变化，请重新选择");
  // 已经确认写入新增项后，收起面板只影响显示，不能把明确保存的替换拆成
  // “新版本已加、旧版本仍在”。账号与歌单内容继续校验；尚未写入时仍可取消。
  if (plan.adds.length === 0) checkActive();
  const have = new Set(after.map(collectKey));
  if (plan.adds.some(t => !have.has(collectKey(t)))) throw new Error("新增版本未保存，原有歌曲已保留");
  const expected = new Set([...baseline, ...plan.adds].map(collectKey));
  if (have.size !== expected.size || [...have].some(key => !expected.has(key))) throw new Error("歌单内容已变化，原有歌曲已保留，请重新选择");
  if (plan.removes.length) {
    await ipc.removeTracksFromPlaylist(pid, plan.removes, epoch);
    const remaining = new Set((await ipc.getPlaylistTracks(pid)).map(collectKey));
    if (await ipc.likeSessionEpoch() !== epoch) throw new Error("账号已变化，请重新选择");
    if (plan.removes.some(t => remaining.has(collectKey(t)))) throw new Error("部分旧版本未移除，请刷新歌单后重试");
  }
}
