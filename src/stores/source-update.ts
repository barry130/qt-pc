/**
 * 音源包状态全局 store（设置页「音源包」区消费；useSourceUpdateCheck 写入）。
 * 不做持久化：installed 事实来源是 Rust state.json，启动时重新拉取。
 */
import { create } from "zustand";
import type { SourceReleaseVo, SourceStateVo } from "@/source-scripts/source-update";

interface SourceUpdateStore {
  local: SourceStateVo | null;
  /** 最近一次检查拿到的远端 release（null = 没有/未检查） */
  remote: SourceReleaseVo | null;
  /** 已下载就绪待应用的版本号（null = 没有待应用） */
  ready: number | null;
  message: string;
  busy: boolean;
  setLocal: (v: SourceStateVo | null) => void;
  setRemote: (v: SourceReleaseVo | null) => void;
  setReady: (v: number | null) => void;
  setMessage: (v: string) => void;
  setBusy: (v: boolean) => void;
}

export const useSourceUpdateStore = create<SourceUpdateStore>((set) => ({
  local: null,
  remote: null,
  ready: null,
  message: "",
  busy: false,
  setLocal: (v) => set({ local: v }),
  setRemote: (v) => set({ remote: v }),
  setReady: (v) => set({ ready: v }),
  setMessage: (v) => set({ message: v }),
  setBusy: (v) => set({ busy: v }),
}));
