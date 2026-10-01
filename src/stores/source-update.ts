/**
 * 播放音源包状态全局 store（设置页「音源包」区消费；useSourceUpdateCheck 写入）。
 * 不做持久化：packs/activeId 事实来源是 Rust state.json，启动时重新拉取。
 */
import { create } from "zustand";
import type { SourceReleaseVo, SourceStateVo } from "@/source-scripts/source-update";

interface SourceUpdateStore {
  local: SourceStateVo | null;
  /** 最近一次检查拿到的远端 release（null = 没有/未检查） */
  remote: SourceReleaseVo | null;
  message: string;
  busy: boolean;
  setLocal: (v: SourceStateVo | null) => void;
  setRemote: (v: SourceReleaseVo | null) => void;
  setMessage: (v: string) => void;
  setBusy: (v: boolean) => void;
}

export const useSourceUpdateStore = create<SourceUpdateStore>((set) => ({
  local: null,
  remote: null,
  message: "",
  busy: false,
  setLocal: (v) => set({ local: v }),
  setRemote: (v) => set({ remote: v }),
  setMessage: (v) => set({ message: v }),
  setBusy: (v) => set({ busy: v }),
}));
