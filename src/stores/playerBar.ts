import { create } from "zustand";
import { getSetting, setSetting } from "@/services/ipc";
import {
  countPlayerBarVisible,
  parseVisibleButtons,
  playerBarCounts,
  PLAYER_BAR_MAX_VISIBLE,
  serializeVisibleButtons,
} from "@/lib/player-bar";

/**
 * 播放条按钮开关（DESIGN §9「播放条」设置页 + 播放条本身共用）。
 *
 * 存「展示哪些按钮 id」的白名单（见 lib/player-bar.ts 文件头）。播放条与
 * 设置页都会 ensure 式地 load 一次（loaded 后可反复调用，同一次加载搭车），
 * 因此哪一侧先挂载都能拿到正确状态，不需要启动时预热。
 */
export const PLAYER_BAR_VISIBLE_KEY = "playerBar.visibleButtons";

interface PlayerBarStore {
  /** 展示中的按钮 id 白名单（顺序 = 用户开启的先后，仅用于持久化） */
  visible: string[];
  /** 已从设置里读过一次（读失败也算读过，按默认集） */
  loaded: boolean;
  /** 幂等读取；同一次加载搭车，避免两个组件各发一次 IPC */
  load: () => Promise<void>;
  /**
   * 乐观切换 + 落盘；写失败回滚（界面不该显示磁盘上没有的状态）。
   * 返回 false 仅代表 inline 名额已满（开启被拒绝）；关掉永远成功。
   */
  toggle: (id: string) => boolean;
  isVisible: (id: string) => boolean;
}

let inflight: Promise<void> | null = null;

export const usePlayerBarStore = create<PlayerBarStore>((set, get) => ({
  visible: parseVisibleButtons(null),
  loaded: false,
  load: () => {
    if (get().loaded) return Promise.resolve();
    if (inflight) return inflight;
    const p = (async () => {
      let raw: string | null = null;
      try {
        raw = await getSetting(PLAYER_BAR_VISIBLE_KEY);
      } catch {
        // 读失败按默认集：播放条不该因为设置读不到就少几个按钮
      }
      set({ visible: parseVisibleButtons(raw), loaded: true });
    })().finally(() => {
      inflight = null;
    });
    inflight = p;
    return p;
  },
  toggle: (id) => {
    const before = get().visible;
    if (before.includes(id)) {
      // 关掉永远成功
      const next = before.filter((x) => x !== id);
      set({ visible: next, loaded: true });
      void setSetting(PLAYER_BAR_VISIBLE_KEY, serializeVisibleButtons(next)).catch(() => {
        set({ visible: before });
      });
      return true;
    }
    // 开启：除音量（slot:"end"）外最多 PLAYER_BAR_MAX_VISIBLE 个，满了拒绝
    if (playerBarCounts(id) && countPlayerBarVisible(before) >= PLAYER_BAR_MAX_VISIBLE) {
      return false;
    }
    const next = [...before, id];
    set({ visible: next, loaded: true });
    void setSetting(PLAYER_BAR_VISIBLE_KEY, serializeVisibleButtons(next)).catch(() => {
      set({ visible: before });
    });
    return true;
  },
  isVisible: (id) => get().visible.includes(id),
}));
