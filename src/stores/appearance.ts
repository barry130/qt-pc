import { create } from "zustand";
import { getAppearance, setAppearance } from "@/services/ipc";
import { DEFAULT_APPEARANCE, type AppearancePreference } from "@/types";

/**
 * 外观偏好全局状态（DESIGN §9.2 / R7）。
 * 唯一持久化位置是 SQLite settings 表（经 IPC），不用 localStorage，
 * 避免双份状态。启动时 load() 从库中读一次；之后内存为准、写库异步跟随。
 */

interface AppearanceStore {
  preference: AppearancePreference;
  /** 是否已完成首次从库中加载（避免默认值闪一下再跳变） */
  loaded: boolean;
  load: () => Promise<void>;
  update: (patch: Partial<AppearancePreference>) => Promise<void>;
}

export const useAppearanceStore = create<AppearanceStore>()((set, get) => ({
  preference: DEFAULT_APPEARANCE,
  loaded: false,
  load: async () => {
    try {
      const saved = await getAppearance();
      // 字段级合并：旧版本存档缺新字段时回落默认值
      set({ preference: { ...DEFAULT_APPEARANCE, ...saved }, loaded: true });
    } catch {
      // IPC 失败（如库未就绪）保持默认值，下次进入设置页再试
      set({ loaded: true });
    }
  },
  update: async (patch) => {
    const next = { ...get().preference, ...patch };
    set({ preference: next });
    try {
      await setAppearance(next);
    } catch {
      // 写库失败不影响本次会话的内存生效
    }
  },
}));
