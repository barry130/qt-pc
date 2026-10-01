import { create } from "zustand";
import * as ipc from "@/services/ipc";
import type { DownloadTask, Track } from "@/types";

/**
 * 下载任务与「已下载」标记的全局镜像（DESIGN §5.3 下载 2.0）。
 *
 * Rust 侧是唯一真值：任务状态变化会广播 `downloads-changed`，
 * AppShell 收到后调用 `refresh()`，列表与曲目行的「已下载」标一起更新。
 */

/** db 主键口径，与 Rust `db_track_id` 一致（`platform:id`） */
export function trackDbId(t: Pick<Track, "platform" | "id">): string {
  return `${t.platform}:${t.id}`;
}

/** 仍在进行中的状态（占位「下载中」标用；完成/失败/取消不算） */
const ACTIVE_STATUSES: DownloadTask["status"][] = [
  "pending",
  "downloading",
  "paused",
];

interface DownloadsStore {
  tasks: DownloadTask[];
  /** 已下载完成的 db 主键集合 */
  downloaded: Set<string>;
  /** 正在下载 / 等待 / 暂停中的曲目 db 主键 */
  active: Set<string>;
  loaded: boolean;
  refresh: () => Promise<void>;
  isDownloaded: (t: Pick<Track, "platform" | "id">) => boolean;
  isActive: (t: Pick<Track, "platform" | "id">) => boolean;
}

export const useDownloadsStore = create<DownloadsStore>((set, get) => ({
  tasks: [],
  downloaded: new Set<string>(),
  active: new Set<string>(),
  loaded: false,

  refresh: async () => {
    try {
      const [tasks, ids] = await Promise.all([
        ipc.listDownloads().catch(() => [] as DownloadTask[]),
        ipc.listDownloadedTrackIds().catch(() => [] as string[]),
      ]);
      const list = Array.isArray(tasks) ? tasks : [];
      const active = new Set<string>();
      for (const t of list) {
        if (ACTIVE_STATUSES.includes(t.status)) active.add(trackDbId(t.track));
      }
      set({
        tasks: list,
        downloaded: new Set(Array.isArray(ids) ? ids : []),
        active,
        loaded: true,
      });
    } catch {
      set({ loaded: true });
    }
  },

  isDownloaded: (t) => get().downloaded.has(trackDbId(t)),
  isActive: (t) => get().active.has(trackDbId(t)),
}));
