import { create } from "zustand";
import type { AppUpdateInfo } from "@/types";

/**
 * 应用更新全局状态（§15.3）：
 * - info：检查到的新版本信息（null = 无更新 / 未检查）
 * - dismissed：用户已点「暂不」，本会话不再弹窗（强制更新除外）
 * - officialValid：官方版本校验结果（null = 未校验）
 */
interface UpdateStore {
  info: AppUpdateInfo | null;
  dismissed: boolean;
  officialValid: boolean | null;
  setUpdate: (info: AppUpdateInfo | null) => void;
  dismiss: () => void;
  setOfficialValid: (valid: boolean | null) => void;
}

export const useUpdateStore = create<UpdateStore>((set) => ({
  info: null,
  dismissed: false,
  officialValid: null,
  setUpdate: (info) => set({ info }),
  dismiss: () => set({ dismissed: true }),
  setOfficialValid: (officialValid) => set({ officialValid }),
}));
