import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { migrateLegacyStorageKey } from "@/lib/legacy-storage";
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

/** 更名前的前缀是 lightlisten.*（见 lib/legacy-storage） */
const STORAGE_KEY = "quietmusic.music-source";
migrateLegacyStorageKey(STORAGE_KEY);

/**
 * 持久化结构版本。**改动已持久化字段的形状时必须 +1 并补 migrate 分支**：
 * 桌面端用户不会清 localStorage，旧结构会被直接 hydrate 进新代码，
 * 这种问题一旦发出去会长期潜伏（P2-8）。
 */
const PERSIST_VERSION = 1;

/** 真正落盘的字段（只存状态，不存 setter；也不存将来可能加的派生/大字段） */
type PersistedMusicSource = Pick<MusicSourceStore, "activeSourceId" | "aggregateMode">;

/**
 * 把任意版本 / 被手改过的存档收敛成合法结构。
 * 为什么必须做：存档是用户可编辑的（devtools / 旧版本写入），
 * 一个非字符串的 activeSourceId 会让所有页面按未知音源请求而**没有报错**，
 * 排查成本极高；这里退回默认值，行为可预期。
 *
 * id 的**清单校验**不在这里做：音源列表由数据包注册表声明
 * （stores/sourceRegistry.ts），加载完成后由它把已下线的 id 纠正为
 * 数据包里的第一个音源（见 validateActiveSource）。
 */
function sanitizePersisted(raw: unknown): PersistedMusicSource {
  const src = (raw ?? {}) as Partial<Record<keyof PersistedMusicSource, unknown>>;
  const id = src.activeSourceId;
  return {
    activeSourceId: typeof id === "string" && id.length > 0 ? id : "wyy",
    aggregateMode: typeof src.aggregateMode === "boolean" ? src.aggregateMode : false,
  };
}

export const useMusicSourceStore = create<MusicSourceStore>()(
  persist(
    (set) => ({
      activeSourceId: "wyy",
      aggregateMode: false,
      setActiveSource: (id) => set({ activeSourceId: id }),
      setAggregateMode: (on) => set({ aggregateMode: on }),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(safeStorage),
      version: PERSIST_VERSION,
      // 任何旧版本（含未带 version 的 v0 存档）都过一遍 sanitize
      migrate: (persisted) => sanitizePersisted(persisted),
      // migrate 只在**版本不同**时才会被调用，所以「当前版本但内容非法」
      // （手改过、写入被截断）还得靠 merge 兜一道 —— 这才是常态入口。
      merge: (persisted, current) => ({ ...current, ...sanitizePersisted(persisted) }),
      partialize: (s): PersistedMusicSource => ({
        activeSourceId: s.activeSourceId,
        aggregateMode: s.aggregateMode,
      }),
    },
  ),
);
