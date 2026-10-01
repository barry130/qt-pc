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
  /**
   * 首次读取是否**成功**。false 表示当前 preference 只是默认值、
   * 并不代表库里的真实值 —— 此时绝不能把默认值写回去（会把用户已存的外观覆盖掉）。
   */
  loadOk: boolean;
  /** 写库失败的用户可读原因；null = 内存与库一致。设置页据此提示「未保存」。 */
  saveError: string | null;
  load: () => Promise<void>;
  update: (patch: Partial<AppearancePreference>) => Promise<void>;
  /** 手动重试落库（提示条上的「重试」） */
  retrySave: () => Promise<void>;
}

/**
 * 写库失败后的自动重试节奏（毫秒）。用完仍失败就停在「未保存」提示，
 * 交回给用户手动重试 —— 不无限重试，避免库长期不可用时刷屏/耗电。
 */
const RETRY_DELAYS_MS = [1_000, 3_000, 9_000];
/** 待落库的最新值（重试时写它，永远写"最后一次"而不是中间态） */
let pendingSave: AppearancePreference | null = null;
let retryTimer: number | null = null;
let retryIndex = 0;

function clearRetry(): void {
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
}

export const useAppearanceStore = create<AppearanceStore>()((set, get) => ({
  preference: DEFAULT_APPEARANCE,
  loaded: false,
  loadOk: false,
  saveError: null,
  load: async () => {
    try {
      const saved = await getAppearance();
      // 字段级合并：旧版本存档缺新字段时回落默认值
      set({ preference: { ...DEFAULT_APPEARANCE, ...saved }, loaded: true, loadOk: true });
    } catch {
      // IPC 失败（如库未就绪）：保持默认值，但**标记未读到**，
      // 于是 update 不会拿默认值去覆盖库里的真实值（P2-8）。
      set({ loaded: true, loadOk: false });
    }
  },

  /**
   * 内存立即生效（交互不能等 IO），随后异步落库。
   * 失败不再静默吞掉：记 saveError 让设置页显示「未保存」，并按 RETRY_DELAYS_MS
   * 自动重试 —— 以前是「界面显示已生效、重启却回滚」，用户无从察觉（P2-8）。
   */
  update: async (patch) => {
    const next = { ...get().preference, ...patch };
    set({ preference: next });

    // 从没成功读到过库里的值：先把真实值读回来再写，否则会用默认值覆盖用户设置。
    if (!get().loadOk) {
      try {
        const saved = await getAppearance();
        const merged = { ...DEFAULT_APPEARANCE, ...saved, ...patch };
        set({ preference: merged, loadOk: true });
        pendingSave = merged;
      } catch {
        set({
          saveError: "未能读取已保存的外观设置，已仅在本机界面生效（改动未写入数据库）",
        });
        return;
      }
    } else {
      pendingSave = next;
    }

    retryIndex = 0;
    clearRetry();
    await flushSave(set, get);
  },

  retrySave: async () => {
    if (pendingSave === null) {
      pendingSave = get().preference;
    }
    retryIndex = 0;
    clearRetry();
    await flushSave(set, get);
  },
}));

/**
 * 把 pendingSave 写库；失败则按 RETRY_DELAYS_MS 退避重试，用尽后留下 saveError。
 * 抽成函数是为了让 update / retrySave / 定时器三条路径共用同一套语义。
 */
async function flushSave(
  set: (partial: Partial<AppearanceStore>) => void,
  get: () => AppearanceStore,
): Promise<void> {
  const payload = pendingSave;
  if (payload === null) return;
  try {
    await setAppearance(payload);
    pendingSave = null;
    retryIndex = 0;
    set({ saveError: null });
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    if (retryIndex < RETRY_DELAYS_MS.length) {
      const delay = RETRY_DELAYS_MS[retryIndex];
      retryIndex += 1;
      set({ saveError: `外观设置保存失败，正在重试（${retryIndex}/${RETRY_DELAYS_MS.length}）：${reason}` });
      clearRetry();
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void flushSave(set, get);
      }, delay);
      return;
    }
    set({ saveError: `外观设置保存失败（已重试 ${RETRY_DELAYS_MS.length} 次），重启后会回滚：${reason}` });
  }
}
