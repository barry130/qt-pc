import { useEffect } from "react";
import { create } from "zustand";
import * as ipc from "@/services/ipc";
import { trackDbId } from "@/stores/downloads";
import { toastError } from "@/stores/toast";
import { errMsg } from "@/lib/utils";
import type { Track } from "@/types";

/**
 * 评分（A6）的前端镜像。
 *
 * 真值在 Rust 的 `track_ratings` 表（键 = `platform:id`，与 `tracks.id` 同口径）。
 * 这份 store 只做三件事：
 *   1. 把「这一屏曲目的评分」一次批量取回来（`get_track_ratings`），列表滚动 /
 *      排序 / 翻页时只补新增的键；
 *   2. 点击星星时**先改本地再发 IPC**（乐观更新）：一次点击就要立刻看到变化，
 *      等 IPC 往返再刷界面会有一帧回跳；
 *   3. IPC 失败时回滚到点之前的值并弹错误条 —— 界面上不能留下一个没落库的星星。
 *
 * 为什么不用 `useTrackFlags`：那个 hook 的返回值是布尔数组，评分是 1–5 的整数；
 * 而且评分会被用户就地改动，改动要立刻反映到所有同曲目的行上（同一首歌在播放页、
 * 列表页、队列里都要同步），store 天然做到，hook 里的私有缓存做不到。
 */

interface RatingsStore {
  /** 键 = `platform:id` → 1–5；缺键 = 没打分 */
  ratings: Record<string, number>;
  /** 已经查过的键（含查过但没评分的）：避免列表重排 / 滚动时反复请求 */
  known: Record<string, true>;
  /** 批量补齐这一屏的评分（已查过的键不会重复请求） */
  ensure: (tracks: Track[]) => Promise<void>;
  /** 打分（`rating <= 0` = 清除），乐观更新 + 失败回滚 */
  set: (track: Track, rating: number) => Promise<void>;
  /** 账号切换 / 退出登录时清空镜像 */
  clear: () => void;
}

/**
 * `known` 的上限：正常使用下键数 = 见过的曲目数，几万首才会到这个量级。
 * 超过就整体重置（下次渲染会重新批量拉一遍），换取内存有界。
 */
const MAX_KNOWN = 20000;

export const useRatingsStore = create<RatingsStore>((set, get) => ({
  ratings: {},
  known: {},

  ensure: async (tracks) => {
    if (tracks.length === 0) return;
    const { known } = get();
    const keys = [...new Set(tracks.map(trackDbId))].filter((key) => !known[key]);
    if (keys.length === 0) return;
    // 先登记再请求：同一批曲目在多个组件里同时挂载时，只有一次 IPC。
    set((state) => {
      const next = { ...state.known };
      for (const key of keys) next[key] = true;
      const over = Object.keys(next).length > MAX_KNOWN;
      return { known: over ? {} : next };
    });
    try {
      const got = await ipc.getTrackRatings(keys);
      set((state) => {
        const next = { ...state.ratings };
        for (const [key, value] of Object.entries(got)) {
          if (value >= 1) next[key] = Math.min(5, Math.round(value));
        }
        return { ratings: next };
      });
    } catch {
      // 失败要把登记撤掉：否则这一次网络/数据库抖动会让这批曲目永远显示 0 星。
      set((state) => {
        const next = { ...state.known };
        for (const key of keys) delete next[key];
        return { known: next };
      });
    }
  },

  set: async (track, rating) => {
    const key = trackDbId(track);
    const value = Math.max(0, Math.min(5, Math.round(rating)));
    const previous = get().ratings[key] ?? 0;
    set((state) => {
      const next = { ...state.ratings };
      if (value > 0) next[key] = value;
      else delete next[key];
      const known = { ...state.known, [key]: true as const };
      return { ratings: next, known };
    });
    try {
      await ipc.setTrackRating(key, value);
    } catch (err) {
      set((state) => {
        const next = { ...state.ratings };
        if (previous > 0) next[key] = previous;
        else delete next[key];
        return { ratings: next };
      });
      toastError(`保存评分失败：${errMsg(err)}`);
    }
  },

  clear: () => set({ ratings: {}, known: {} }),
}));

/**
 * 列表页挂钩：把这一屏曲目的评分补齐。曲目数组变化（翻页 / 换页 / 排序）时
 * 只请求没查过的键；`ensure` 内部已经去重，这里不必再做 diff。
 */
export function useTrackRatings(tracks: Track[]): void {
  const ensure = useRatingsStore((state) => state.ensure);
  useEffect(() => {
    void ensure(tracks);
  }, [tracks, ensure]);
}

/** 单曲评分（没有就是 0 星）。行 / 播放页直接用它订阅，改动会立刻重渲染。 */
export function useTrackRating(track: Track | null): number {
  return useRatingsStore((state) => (track ? state.ratings[trackDbId(track)] ?? 0 : 0));
}
