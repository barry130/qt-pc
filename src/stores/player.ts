import { create } from "zustand";
import type {
  PlaybackState,
  PositionChanged,
  QueueChanged,
  Track,
} from "@/types";
import * as ipc from "@/services/ipc";

/**
 * 播放状态store（DESIGN §12.1）。
 * - state：Rust 全量快照（语义变化才推送），前端不持有播放真值
 * - queue / queueIndex：queue-changed 事件镜像，供队列面板渲染
 * - position：250ms tick + rAF 插值得到的展示位置（不触发 Rust 往返）
 */

interface PlayerStore {
  state: PlaybackState | null;
  queue: Track[];
  queueIndex: number | null;
  /** 最近一次 Rust tick 的时间戳（performance.now 基准） */
  positionAnchorMs: number;
  /** tick 携带的锚点位置 */
  positionAnchorValue: number;
  isDraggingProgress: boolean;
  /** 乐观 seek 目标（ms）：松手即刻展示，直到新位置的 tick 确认；期间丢弃陈旧 tick */
  pendingSeekMs: number | null;
  /** 乐观 seek 的起始时刻（performance.now 基准），超时兜底用 */
  pendingSeekAt: number;
  /** 播放列表面板是否展开（布局级右侧面板，DESIGN §5.5） */
  queueOpen: boolean;

  applySnapshot: (s: PlaybackState) => void;
  applyTick: (t: PositionChanged) => void;
  applyQueue: (q: QueueChanged) => void;
  setDragging: (d: boolean) => void;
  /** rAF 每帧调用：读插值位置 */
  interpolatedPositionMs: () => number;
  /** 交互动作，全部转为 invoke（单向数据流） */
  play: (track: Track) => Promise<void>;
  playQueue: (tracks: Track[], startIndex: number) => Promise<void>;
  playAt: (index: number) => Promise<void>;
  nextTrack: () => Promise<void>;
  prevTrack: () => Promise<void>;
  cyclePlayMode: () => Promise<void>;
  toggle: () => Promise<void>;
  seekTo: (ms: number) => Promise<void>;
  setVolume: (v: number) => Promise<void>;
  toggleMute: () => Promise<void>;
  toggleQueue: () => void;
  setQueueOpen: (open: boolean) => void;
}

const MODE_ORDER = ["sequence", "listLoop", "oneLoop", "random"] as const;

/**
 * tick 落在乐观 seek 目标 ±该值内，即认为 seek 已生效。
 * 取 500ms：足够容纳 FLAC 定位到帧边界的偏移，又不会把「拖动幅度很小」时
 * seek 前的旧位置误判成生效（那种情况下偏差也小，即使误判最多跳 0.5s）。
 */
const PENDING_SEEK_TOLERANCE_MS = 500;
/** 乐观 seek 的兜底超时：超过后不再拦截 tick，避免标记卡死 */
const PENDING_SEEK_TIMEOUT_MS = 1000;

const initialSnapshot: PlaybackState = {
  trackId: null,
  sourceId: null,
  status: "stopped",
  positionMs: 0,
  durationMs: 0,
  bufferedMs: 0,
  volume: 0.8,
  muted: false,
  playMode: "listLoop",
  quality: "320",
  queueIndex: null,
  queueLen: 0,
  isLocal: false,
  urlFetchedAt: null,
  playUrl: null,
  error: null,
  sleepTimerMs: null,
  track: null,
  outputDevice: "",
};

export const usePlayerStore = create<PlayerStore>((set, get) => ({
  state: initialSnapshot,
  queue: [],
  queueIndex: null,
  positionAnchorMs: 0,
  positionAnchorValue: 0,
  isDraggingProgress: false,
  pendingSeekMs: null,
  pendingSeekAt: 0,
  queueOpen: false,

  applySnapshot: (s) => {
    // 合并默认值：快照来自 Rust，正常字段齐全，
    // 但测试 mock / 异常负载缺字段时不能把 store 打残
    const incoming = { ...initialSnapshot, ...s };
    const cur = get().state;
    // 本地曲目封面由前端在线匹配后写回（useLocalTrackOnlineMeta）：同一曲目的后续
    // 快照 picUrl 仍为空，这里保留已补全的值，避免暂停 / 继续时封面闪一下。
    if (
      incoming.track &&
      cur?.track &&
      incoming.track.id === cur.track.id &&
      !incoming.track.picUrl &&
      cur.track.picUrl
    ) {
      incoming.track = { ...incoming.track, picUrl: cur.track.picUrl };
    }
    // 降级保护：当前已有曲目、来的快照却没带（极端竞态/异常负载）→
    // 忽略这次快照。真有切歌引擎随后会推带曲目的事件，
    // 而一个"空快照"会把播放条打回「未在播放」而音频其实在响。
    if (cur?.track && !incoming.track) {
      // 但播完/换曲是真实的结束信号：乐观 seek 标记必须作废，
      // 否则（停止后不再有 tick）进度条会永远停在被拖到的目标位置。
      const ended =
        incoming.status === "stopped" ||
        (cur.trackId ?? null) !== (incoming.trackId ?? null);
      if (ended && get().pendingSeekMs !== null) set({ pendingSeekMs: null });
      return;
    }

    // 乐观 seek 尚未确认时：切歌作废标记；同曲的陈旧快照保留乐观位置，
    // 免得一次恰好同时在途的心跳快照把进度条拉回 seek 之前。
    let anchorMs = incoming.positionMs ?? 0;
    const { pendingSeekMs, pendingSeekAt } = get();
    if (pendingSeekMs !== null) {
      const sameTrack = (cur?.trackId ?? null) === (incoming.trackId ?? null);
      const stale =
        sameTrack &&
        Math.abs(anchorMs - pendingSeekMs) > PENDING_SEEK_TOLERANCE_MS &&
        performance.now() - pendingSeekAt <= PENDING_SEEK_TIMEOUT_MS;
      if (stale) {
        anchorMs = pendingSeekMs;
      } else {
        set({ pendingSeekMs: null });
      }
    }

    set({
      state: { ...incoming, positionMs: anchorMs },
      positionAnchorValue: anchorMs,
      positionAnchorMs: performance.now(),
    });
  },

  applyTick: (t) => {
    // 乐观 seek 确认前，丢弃 seek 生效之前就已发出的陈旧 tick，
    // 否则它会把进度条从目标位置拉回原处（表现为松手后抖一下）。
    const { pendingSeekMs, pendingSeekAt } = get();
    if (pendingSeekMs !== null) {
      const confirmed =
        Math.abs(t.positionMs - pendingSeekMs) <= PENDING_SEEK_TOLERANCE_MS;
      const expired = performance.now() - pendingSeekAt > PENDING_SEEK_TIMEOUT_MS;
      if (!confirmed && !expired) return;
      set({ pendingSeekMs: null });
    }
    const st = get().state;
    set({
      positionAnchorValue: t.positionMs,
      positionAnchorMs: performance.now(),
      state: st
        ? {
            ...st,
            positionMs: t.positionMs,
            durationMs: t.durationMs,
            bufferedMs: t.bufferedMs,
          }
        : st,
    });
  },

  applyQueue: (q) =>
    set({
      // 队列事件缺 tracks 时保持旧值，别让渲染端 findIndex 撞上 undefined
      queue: Array.isArray(q?.tracks) ? q.tracks : get().queue,
      queueIndex: q?.index ?? get().queueIndex,
    }),

  setDragging: (d) => set({ isDraggingProgress: d }),

  toggleQueue: () => set((s) => ({ queueOpen: !s.queueOpen })),

  setQueueOpen: (open) => set({ queueOpen: open }),

  interpolatedPositionMs: () => {
    const { positionAnchorMs, positionAnchorValue, state, isDraggingProgress } =
      get();
    if (!state || state.status !== "playing" || isDraggingProgress) {
      return positionAnchorValue;
    }
    const elapsed = performance.now() - positionAnchorMs;
    return Math.min(
      positionAnchorValue + elapsed,
      state.durationMs > 0 ? state.durationMs : Number.MAX_SAFE_INTEGER,
    );
  },

  play: async (track) => {
    await ipc.playQueue([track], 0);
  },

  playQueue: async (tracks, startIndex) => {
    await ipc.playQueue(tracks, startIndex);
  },

  playAt: async (index) => {
    await ipc.playAt(index);
  },

  nextTrack: async () => {
    await ipc.next();
  },

  prevTrack: async () => {
    await ipc.previous();
  },

  cyclePlayMode: async () => {
    const st = get().state;
    if (!st) return;
    const i = MODE_ORDER.indexOf(st.playMode);
    const next = MODE_ORDER[(i + 1) % MODE_ORDER.length];
    await ipc.setPlayMode(next);
  },

  toggle: async () => {
    const st = get().state;
    if (!st) return;
    if (st.status === "playing") await ipc.pause();
    else if (st.status === "paused") await ipc.resume();
  },

  seekTo: async (ms) => {
    const target = Math.max(0, Math.round(ms));
    // 乐观落点：锚点与快照位置同步先写上，再走 IPC。
    // 这样松手那一帧就是目标位置，不会先掉回 seek 前的旧位置再跳过去。
    const st = get().state;
    set({
      pendingSeekMs: target,
      pendingSeekAt: performance.now(),
      positionAnchorValue: target,
      positionAnchorMs: performance.now(),
      state: st ? { ...st, positionMs: target } : st,
    });
    try {
      await ipc.seek(target);
    } catch (e) {
      // seek 失败（引擎会置 error）：撤掉乐观标记，
      // 让后续 tick / 快照把位置拉回真实值
      set({ pendingSeekMs: null });
      throw e;
    }
  },

  setVolume: async (v) => {
    await ipc.setVolume(Math.min(1, Math.max(0, v)));
  },

  toggleMute: async () => {
    const st = get().state;
    if (st) await ipc.setMuted(!st.muted);
  },
}));
