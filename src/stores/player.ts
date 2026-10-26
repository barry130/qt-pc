import { create } from "zustand";
import type {
  PlaybackState,
  PositionChanged,
  QueueChanged,
  Track,
} from "@/types";
import * as ipc from "@/services/ipc";
import { peekQualityCeiling, normalizeQualityForSource, resolvePlayUrlWithFallback } from "@/lib/quality-fallback";
import { sourcePlayQualityOf } from "@/lib/source-quality";
import { qualityShortLabel } from "@/lib/quality";
import { toast } from "@/stores/toast";

/**
 * 播放状态 store（DESIGN §12.1）。
 * - state：Rust 全量快照（语义变化才推送），前端不持有播放真值
 * - queue / queueIndex：queue-changed 事件镜像，供队列面板渲染
 * - position：250ms tick + rAF 插值得到的展示位置（不触发 Rust 往返）
 */

/**
 * 取链脚本化：播放动作发起前用共享脚本包预解析目标曲目并回填 Rust 引擎的
 * PlayUrl 缓存，引擎随后命中缓存直接播放。
 * local 曲目 / 预解析失败时静默跳过（引擎侧本次取链失败，不再有原生兜底）。
 *
 * 降档回退阶梯在 `@/lib/quality-fallback`（引擎取链桥共用同一份实现，
 * 否则「点一下能放、自动播下一集就报无法播放」）。
 */
async function preResolvePlayUrl(track: Track | undefined): Promise<void> {
  if (!track || track.platform === "local") return;
  // 音质按平台独立（lib/source-quality）：未配置的平台回落旧全局键/320。
  // 存量默认档可能是旧第三方档名（v11 官方清单生效时）：先归一再取链与比对
  const wanted = normalizeQualityForSource(track.platform, sourcePlayQualityOf(track.platform));
  // 同专辑已知上限时不再提示「只能提供 X」：那不是本次降档，而是这张专辑的既定
  // 事实（有声书一本几百集，逐集弹同一句提示等于噪声）。
  const known = peekQualityCeiling(track.platform, track.album);
  try {
    const res = await resolvePlayUrlWithFallback(track, wanted);
    if (res.url.length > 0 && res.quality !== wanted && known === null) {
      // 回执让用户知道「听到的是 128K 而不是请求的 320K」，不静默降档
      toast(`当前音源只能提供 ${qualityShortLabel(res.quality)}：${track.title}`);
    }
  } catch {
    // 静默：引擎侧会再问一次脚本桥（playurl_bridge）
  }
}

/**
 * 播放动作代际号：每个用户播放动作（点歌/切歌）入场时自增。
 *
 * 播放动作都先 `await preResolvePlayUrl`（最坏 8s 取链）再发 IPC，弱网下这个
 * 窗口很长 —— 快速点歌 A→B 时，A 的动作若后完成，会把「播 A」的 IPC 迟到发出，
 * 最终播放的是先点的 A。动作在每个 await 之后校验代际，被更新动作超越即放弃，
 * 保证「最后一次点击获胜」。
 */
let playActionSeq = 0;

/**
 * 后端报 0 的流内时长用**当前曲目声明的时长**兜底：B 站 DASH 音轨是分片 MP4
 * （fMP4），mvhd 不带总时长，symphonia 拿不到 total_duration → duration_ms
 * 恒 0，表现为结束时间恒 00:00、进度条与拖动 seek 一起失效。声明时长来自
 * 包元数据（搜索结果解析，秒）；音乐榜条目源接口不下发时长，仍为 0（诚实未知）。
 */
function effectiveDurationMs(incoming: number): number {
  if (incoming > 0) return incoming;
  const { queue, queueIndex } = usePlayerStore.getState();
  const track = queueIndex === null ? undefined : queue[queueIndex];
  const declared = Math.round((track?.duration ?? 0) * 1000);
  return declared > 0 ? declared : 0;
}

interface PlayerStore {
  state: PlaybackState | null;
  /**
   * 高频播放进度（250ms tick 写入）。
   *
   * 为什么与 `state` 分开：`state` 是"语义快照"，只在切歌 / 播放状态 / 音量等
   * 真变化时才该换新对象；而这三个字段每秒变 4 次。以前 tick 会
   * `set({ state: { ...st, positionMs } })` 造一个新快照对象，于是每个
   * `s => s.state` 的订阅者（播放条 705 行整棵子树、音量控件）每秒被重渲染 4 次。
   * 拆成标量后 `s => s.durationMs` 这类订阅按数值比较，只有真变了才重渲染；
   * 进度条/歌词的平滑推进本来就走 rAF 插值（`interpolatedPositionMs`）。
   */
  positionMs: number;
  durationMs: number;
  bufferedMs: number;
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
  /**
   * 单曲播放：**不替换播放列表** —— 队里已有这首（同 id + 同 platform）就播它
   * 原来那条，否则追加到队尾再播（Rust 侧 `play_track` 原子完成，避免前端镜像
   * 队列的竞态）。所有「点某一首」的入口都走它；整列表入队只在「播放全部」时用
   * `playQueue`（DESIGN §11.2 的列表播放语义收敛到那个按钮上）。
   */
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

const MODE_ORDER = ["listLoop", "oneLoop", "random"] as const;

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
  sleepAfterTrack: false,
  speed: 1,
  track: null,
  outputDevice: "",
  bitrateKbps: null,
};

export const usePlayerStore = create<PlayerStore>((set, get) => ({
  state: initialSnapshot,
  positionMs: 0,
  durationMs: 0,
  bufferedMs: 0,
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
      // 进度标量跟随快照：暂停/停止之后不再有 tick，进度条得靠它显示
      positionMs: anchorMs,
      durationMs: effectiveDurationMs(incoming.durationMs),
      bufferedMs: incoming.bufferedMs,
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
    // 只更新高频进度标量与锚点，**不重建 state**（见 positionMs 字段的注释）。
    // 注意 `state.positionMs` 此后表示"最近一次快照/seek 的位置"，
    // 实时位置一律读 positionMs / interpolatedPositionMs()。
    set({
      positionAnchorValue: t.positionMs,
      positionAnchorMs: performance.now(),
      positionMs: t.positionMs,
      durationMs: effectiveDurationMs(t.durationMs),
      bufferedMs: t.bufferedMs,
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
    const {
      positionAnchorMs,
      positionAnchorValue,
      state,
      isDraggingProgress,
      durationMs,
    } = get();
    if (!state || state.status !== "playing" || isDraggingProgress) {
      return positionAnchorValue;
    }
    const elapsed = performance.now() - positionAnchorMs;
    return Math.min(
      positionAnchorValue + elapsed,
      durationMs > 0 ? durationMs : Number.MAX_SAFE_INTEGER,
    );
  },

  play: async (track) => {
    const gen = ++playActionSeq;
    await preResolvePlayUrl(track);
    if (gen !== playActionSeq) return;
    // 队列增删全在 Rust 引擎线程原子完成：前端只镜像 queue-changed，自己拼数组
    // 会产生「追加后下标算错」的竞态。
    // 音质按平台独立取值（engine 侧队列播放/预加载也按同一张平台表解析）
    await ipc.playTrack(track, sourcePlayQualityOf(track.platform));
  },

  playQueue: async (tracks, startIndex) => {
    const gen = ++playActionSeq;
    await preResolvePlayUrl(tracks[startIndex]);
    if (gen !== playActionSeq) return;
    await ipc.playQueue(tracks, startIndex);
  },

  playAt: async (index) => {
    const gen = ++playActionSeq;
    const { queue } = get();
    await preResolvePlayUrl(queue[index]);
    if (gen !== playActionSeq) return;
    await ipc.playAt(index);
  },

  nextTrack: async () => {
    const gen = ++playActionSeq;
    // 顺序/循环模式可提前算出下一首并预解析；随机模式留给引擎自行解析
    const st = get().state;
    const { queue, queueIndex } = get();
    if (st && queue.length > 0 && queueIndex !== null && st.playMode !== "random") {
      const nextIndex = (queueIndex + 1) % queue.length;
      await preResolvePlayUrl(queue[nextIndex]);
      if (gen !== playActionSeq) return;
    }
    await ipc.next();
  },

  prevTrack: async () => {
    const gen = ++playActionSeq;
    const st = get().state;
    const { queue, queueIndex } = get();
    if (st && queue.length > 0 && queueIndex !== null) {
      const prevIndex = (queueIndex - 1 + queue.length) % queue.length;
      await preResolvePlayUrl(queue[prevIndex]);
      if (gen !== playActionSeq) return;
    }
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
    // paused 之外的 error 也按恢复处理：引擎侧 Play 会兜底重载当前曲
    // （Error 态 sink 是空的，裸 resume 原本是空操作，播放键像坏了）
    else await ipc.resume();
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
      // 高频标量也要同步落点，否则暂停态（没有 tick 驱动）会显示旧位置
      positionMs: target,
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
