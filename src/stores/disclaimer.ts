import { create } from "zustand";
import * as ipc from "@/services/ipc";
import { DISCLAIMER_KEY } from "@/lib/storageKeys";

/**
 * 首次启动免责声明 / 开源通知的展示状态（DESIGN §5.5）。
 *
 * 只在**安装后第一次启动**弹一次：接受时刻写进 SQLite settings 表
 * （`disclaimer.acceptedAt`），下次启动读到就直接返回 null，不占任何渲染。
 *
 * 两个入口：
 * - 启动：AppShell 挂 `init()`，读到「没接受过」就展示；
 * - 设置页「重新查看」：`reopen()`，只展示、不改标记（复查不是重新接受）。
 *
 * 读不到库时按「已接受」处理：宁可这次不弹，也不把用户卡在弹窗前出不去。
 */
interface DisclaimerStore {
  /** null = 还没读库（此时不显示，避免闪一下）；true = 需要展示；false = 不展示 */
  pending: boolean | null;
  /** 设置页主动重看：不写标记，只是把弹窗再打开一次 */
  reopened: boolean;
  /** 一个进程只读一次库；测试里把它置回 false 即可重置 */
  inited: boolean;
  init: () => Promise<void>;
  accept: () => Promise<void>;
  reopen: () => void;
}

export const useDisclaimerStore = create<DisclaimerStore>()((set, get) => ({
  pending: null,
  reopened: false,
  inited: false,
  init: async () => {
    if (get().inited) return;
    set({ inited: true });
    try {
      const saved = await ipc.getSetting(DISCLAIMER_KEY);
      set({ pending: !(typeof saved === "string" && saved.trim().length > 0) });
    } catch {
      // 库没就绪 / 旧版后端没这个命令：按「不需要展示」处理
      set({ pending: false });
    }
  },
  accept: async () => {
    // 先关弹窗再落库：写库失败最多下次再弹一次，不该把人拦在这儿出不去
    set({ pending: false, reopened: false });
    try {
      await ipc.setSetting(DISCLAIMER_KEY, new Date().toISOString());
    } catch {
      // 同上
    }
  },
  reopen: () => set({ reopened: true }),
}));