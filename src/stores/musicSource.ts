import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { SourceId } from "@/types";

/**
 * 音源全局状态（DESIGN §6.2 / §12.1）。
 * 音源是全局状态，唯一入口是标题栏切换器；切换后首页、搜索、
 * 歌单广场等页面按新音源刷新（M1 仅 wyy 有 Provider，其余会返回 Unsupported）。
 */

/** localStorage 缺失 / 受限（测试环境、WebView 存储被禁用）时的内存兜底 */
const memoryStorage = (() => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
})();

function safeStorage(): Storage {
  try {
    if (typeof localStorage !== "undefined" && typeof localStorage.getItem === "function") {
      return localStorage;
    }
  } catch {
    // ignore
  }
  return memoryStorage as Storage;
}

interface MusicSourceStore {
  activeSourceId: SourceId;
  aggregateMode: boolean;
  setActiveSource: (id: SourceId) => void;
  setAggregateMode: (on: boolean) => void;
}

export const useMusicSourceStore = create<MusicSourceStore>()(
  persist(
    (set) => ({
      activeSourceId: "wyy",
      aggregateMode: false,
      setActiveSource: (id) => set({ activeSourceId: id }),
      setAggregateMode: (on) => set({ aggregateMode: on }),
    }),
    { name: "lightlisten.music-source", storage: createJSONStorage(safeStorage) },
  ),
);
