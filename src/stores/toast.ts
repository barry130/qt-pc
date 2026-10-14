import { create } from "zustand";

/**
 * 右上角轻提示（一次性回执文案）。
 *
 * 为什么要有它：批量收藏 / 取消收藏成功后的回执（「已收藏 41 首到「TEST」」）
 * 原先直接写在批量条里，文案一出现就把页头那一行顶宽，右边的按钮跟着左右挪
 * （用户 m09470 明确不要这种「影响原布局」的提示）。改成浮在右上角、3 秒自己
 * 消失，页头就只剩固定宽度的控件。
 *
 * 真值全在 Rust（收藏表），这里**不缓存任何状态**，只放「刚发生的事」这类
 * 一句话文案；也不做合并去重 —— 连着两次收藏就是上下叠两条，各自计时。
 */
export interface ToastItem {
  id: number;
  text: string;
  /** info = 普通回执；error = 出错（红字，留给以后需要浮层报错的地方） */
  kind: "info" | "error";
}

interface ToastStore {
  items: ToastItem[];
  push: (text: string, kind?: ToastItem["kind"]) => void;
  dismiss: (id: number) => void;
}

/** 同时最多叠几条：再多也会在 3 秒内刷掉，留着只是糊住右上角 */
const MAX_ITEMS = 4;

let seq = 0;

const useToastStore = create<ToastStore>((set) => ({
  items: [],
  push: (text, kind = "info") =>
    set((s) => ({ items: [...s.items, { id: (seq += 1), text, kind }].slice(-MAX_ITEMS) })),
  dismiss: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}));

/**
 * 塞一条轻提示。事件回调、异步流程里直接调即可：
 * `toast("已收藏 3 首到「歌单名」")`。
 */
export function toast(text: string): void {
  useToastStore.getState().push(text, "info");
}

/**
 * 出错版（红字）。需要用户动手处理的错误仍应写在页面里 —— 浮层 3 秒就走，
 * 只适合「知道一下就行」的那些。
 */
export function toastError(text: string): void {
  useToastStore.getState().push(text, "error");
}

export { useToastStore };