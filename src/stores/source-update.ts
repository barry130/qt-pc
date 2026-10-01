/**
 * 统一音源包状态全局 store（v3；设置页「音源包」区 + 启动更新提示 + 侧栏
 * 红点消费；useSourceUpdateCheck / SourceUpdatePrompt 写入）。
 * 不做持久化：packs/activeId/activeMetaId 事实来源是 Rust state.json，
 * 每次进设置页/包变化事件时重新拉取。
 */
import { create } from "zustand";
import type {
  BaselineMetaVo,
  PackUpdateOfferVo,
  SourceStateVo,
} from "@/source-scripts/source-update";

interface SourceUpdateStore {
  local: SourceStateVo | null;
  /** 待用户确认的更新 offer（非空 = 设置页入口亮红点） */
  offers: PackUpdateOfferVo[];
  /** 内置数据包基线身份（无包头的老资产为 null） */
  baselineMeta: BaselineMetaVo | null;
  message: string;
  busy: boolean;
  setLocal: (v: SourceStateVo | null) => void;
  setOffers: (v: PackUpdateOfferVo[]) => void;
  dropOffer: (targetId: string, kind: string) => void;
  setBaselineMeta: (v: BaselineMetaVo | null) => void;
  setMessage: (v: string) => void;
  setBusy: (v: boolean) => void;
}

export const useSourceUpdateStore = create<SourceUpdateStore>((set) => ({
  local: null,
  offers: [],
  baselineMeta: null,
  message: "",
  busy: false,
  setLocal: (v) => set({ local: v }),
  setOffers: (v) => set({ offers: v }),
  dropOffer: (targetId, kind) =>
    set((s) => ({
      offers: s.offers.filter((o) => !(o.targetId === targetId && o.kind === kind)),
    })),
  setBaselineMeta: (v) => set({ baselineMeta: v }),
  setMessage: (v) => set({ message: v }),
  setBusy: (v) => set({ busy: v }),
}));
