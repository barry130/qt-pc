import { create } from "zustand";
import type {
  PlaybackState,
  PlayTarget,
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
    if (res.url.length > 0 && res.quality !== (res.requestedQuality ?? wanted) && known === null) {
      // 回执让用户知道「听到的是 128K 而不是请求的 320K」，不静默降档
      toast(`当前音源只能提供 ${qualityShortLabel(res.quality)}：${track.title}`);
    }
  } catch {
    // 静默：引擎侧会再问一次脚本桥（playurl_bridge）
  }
}

/**
 * 播放动作的代次票（Native 侧登记，见 ipc.beginPlayIntent）。
 *
 * 必须在任何取链 await 之前拿到：预解析窗口里原生媒体键换歌时，Native 才能
 * 凭「登记之后又出现过播放意图」丢弃这个旧动作。
 *
 * 前后端同捆绑，PC 后端一定有 begin_play_intent：登记失败（或 e2e 测试替身
 * 没给有效票）不是「旧后端」的兼容场景。拿不到有效票时整条动作 fail closed，
 * 不能退化成无票的旧载荷 —— 那会在 preResolve 窗口重新打开 C03 漏洞。
 */
async function beginPlayIntent(): Promise<number | null> {
  try {
    const ticket = await ipc.beginPlayIntent();
    // 票必须是正的安全整数：undefined/null/NaN/0/负数/非整数/超出安全整数都
    // 不能当作「无票」继续 —— 那会让晚到的无票动作重新变成 Native 眼中的最新意图。
    return typeof ticket === "number" && Number.isSafeInteger(ticket) && ticket > 0
      ? ticket
      : null;
  } catch {
    return null;
  }
}

/** 原票清理不阻塞动作回执，也不覆盖原始播放错误；Native 对已提交票取消是 no-op。 */
function abandonPlayIntent(playIntent: number): void {
  try {
    void ipc.abandonPlayIntent(playIntent).catch(() => {});
  } catch {
    // IPC 同步不可用时也不能让清理覆盖原始回执。
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

const preparedActionBrand: unique symbol = Symbol("PreparedPlayAction");
/** An original click's reservation, never a new intent created after persistence. */
export interface PreparedPlayAction { readonly [preparedActionBrand]: true }
type PreparedRecord = { gen: number; nativeTicket: number; phase: "reserved" | "bound" | "consumed" | "released" };
const preparedActions = new WeakMap<PreparedPlayAction, PreparedRecord>();
const preparedDependencies = new WeakMap<Promise<unknown>, PreparedRecord>();

/** Register synchronously, before the caller starts its settings write. */
export async function reservePlayAction(): Promise<PreparedPlayAction | null> {
  const gen = ++playActionSeq;
  const nativeTicket = await beginPlayIntent();
  if (nativeTicket === null) return null;
  if (gen !== playActionSeq) { abandonPlayIntent(nativeTicket); return null; }
  const handle: PreparedPlayAction = Object.freeze({ [preparedActionBrand]: true as const });
  preparedActions.set(handle, { gen, nativeTicket, phase: "reserved" });
  return handle;
}

export function isPreparedPlayActionCurrent(handle: PreparedPlayAction): boolean {
  const record = preparedActions.get(handle);
  return record?.phase === "reserved" && record.gen === playActionSeq;
}

/** Preserve the actual cleanup promise passed through the existing callback. */
export function bindPreparedPlayDependency(handle: PreparedPlayAction, dependency: Promise<unknown>): boolean {
  const record = preparedActions.get(handle);
  if (!record || !isPreparedPlayActionCurrent(handle) || preparedDependencies.has(dependency)) return false;
  record.phase = "bound";
  preparedDependencies.set(dependency, record);
  return true;
}

function releasePreparedRecord(record: PreparedRecord): void {
  if (record.phase === "consumed" || record.phase === "released") return;
  record.phase = "released";
  abandonPlayIntent(record.nativeTicket);
}

/** Closing the panel must not revoke an action its callback has already consumed. */
export function abandonPreparedPlayAction(handle: PreparedPlayAction): void {
  const record = preparedActions.get(handle);
  if (record) releasePreparedRecord(record);
}

function startPlayAction(dependency?: Promise<unknown>): { gen: number; intent: Promise<number | null> } {
  const record = dependency ? preparedDependencies.get(dependency) : undefined;
  if (!record) return { gen: ++playActionSeq, intent: beginPlayIntent() };
  if (record.phase !== "bound" || record.gen !== playActionSeq) {
    releasePreparedRecord(record);
    return { gen: record.gen, intent: Promise.resolve(null) };
  }
  record.phase = "consumed";
  // Keep the dependency's tombstone: reusing it must never create a fresh action.
  return { gen: record.gen, intent: Promise.resolve(record.nativeTicket) };
}

/**
 * 实时事件（快照 / tick / 队列）的单调版本号。
 *
 * 启动恢复只是 fallback：`restore_last_session` 可能很慢，等待期间纯原生路径
 * （SMTC / 媒体热键 / 自动切歌）已经推来更新的快照 —— 那条路不经过 JS 的
 * playActionSeq，所以恢复响应回来时必须靠这个版本号判断「期间有没有实时事件
 * 到过」。不能用 track id 比较：A→B→A 时 id 相同，但 B 之后的实时状态才是真值。
 */
let liveRevision = 0;

/** 当前实时事件版本号（只给恢复流程在 await 前后做新鲜度校验） */
export function currentLiveRevision(): number {
  return liveRevision;
}

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

/**
 * 播放动作的回执：`applied=false` 表示该动作在预解析期间被更新的用户播放动作
 * 取代（IPC 根本没发出），调用方不能把它当成「队列已经换成这一批」。
 *
 * `ticket` 是动作代次号：FM 退出恢复会话时，后续 seek/pause 必须带着它回来
 * 校验 —— 只有播放器还是这次动作的「最后一次点击」时才能动它，否则用户已经
 * 点了别的歌，旧会话的 seek/pause 会落到新歌身上。
 */
export interface PlayActionResult {
  applied: boolean;
  ticket: number;
  target: PlayTarget | null;
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
  /**
   * 当前这首**在播本地文件**时，从文件内嵌标签里读出的封面（data URL，无内嵌则为空串）。
   *
   * 为什么单独存、不写进 `state.track.picUrl`：`track` 会随「加歌单 / 收藏 / 历史」
   * 一路 upsert 进 Rust 的 tracks 表（`db::store::upsert_tracks` 直接把 pic_url 落库），
   * 塞一份 200KB 的 base64 进去就是数据库体积和同步请求体的双重污染。封面只用于
   * 「当前在播」的展示，所以放在 store 顶层，由 `useNowPlayingLocalMedia` 维护。
   */
  embeddedCover: string;
  /** `embeddedCover` 属于哪首（`platform:id`）：切歌瞬间立即失配，避免上一首的封面闪一帧 */
  embeddedCoverTrack: string;
  setEmbeddedCover: (trackKey: string, url: string) => void;

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
  play: (track: Track, beforeResolve?: Promise<unknown>) => Promise<void>;
  playQueue: (tracks: Track[], startIndex: number, beforeResolve?: Promise<unknown>) => Promise<PlayActionResult>;
  playAt: (index: number) => Promise<void>;
  nextTrack: () => Promise<void>;
  prevTrack: () => Promise<void>;
  cyclePlayMode: () => Promise<void>;
  toggle: () => Promise<void>;
  /**
   * 拖动进度。`expectedAction` 传播放动作票据时先校验代次：动作已被更新的
   * 用户播放动作取代（用户点了别的歌）就不动当前播放器，返回 false。
   */
  seekTo: (ms: number, expectedAction?: number, target?: PlayTarget | null) => Promise<boolean>;
  /** 仅当播放动作代次仍是 `ticket` 时才暂停；不传票据按无条件暂停处理 */
  pauseForAction: (ticket?: number, target?: PlayTarget | null) => Promise<boolean>;
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
/**
 * 乐观 seek 的兜底超时：超过后不再拦截 tick，避免标记卡死。
 * 取 10s（原 1s 太短）：引擎处理 seek 要先阻塞式定位解码器，网络流还要重新
 * 取 Range，实测慢源上「目标位置的 tick」晚到 1~3s 很常见；窗口一过，seek
 * 之前发出的陈旧 tick 就会被当成真实位置接管——进度条先跳回旧位置、等真正
 * 的 tick 到了再跳回目标，也就是用户看到的「来回变一次才定位」。
 * 真正的失败由引擎的错误快照即时撤销（见 applySnapshot），不靠这个超时兜。
 */
const PENDING_SEEK_TIMEOUT_MS = 10_000;

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
  embeddedCover: "",
  embeddedCoverTrack: "",
  setEmbeddedCover: (trackKey, url) => {
    const cur = get();
    if (cur.embeddedCover === url && cur.embeddedCoverTrack === trackKey) return;
    set({ embeddedCover: url, embeddedCoverTrack: trackKey });
  },
  pendingSeekMs: null,
  pendingSeekAt: 0,
  queueOpen: false,

  applySnapshot: (s) => {
    liveRevision += 1;
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
      const ended =
        incoming.status === "stopped" ||
        (cur.trackId ?? null) !== (incoming.trackId ?? null);
      // 真结束（停止 / 换曲 / 清空队列）必须照单全收：以前这里无条件 return，
      // 「清空队列」后引擎只推一条不带曲目的 stopped 快照，被吞掉 → 播放条继续
      // 显示上一首、进度条还在走，用户以为还在播（P0 缺陷，2026-10-29 修）。
      // 只有「自称还在 playing、trackId 也没变、却不带曲目」这种自相矛盾的负载
      // 才当成心跳竞态吞掉。
      const contradictory = incoming.status === "playing" && !ended;
      if (ended && get().pendingSeekMs !== null) set({ pendingSeekMs: null });
      if (contradictory) return;
    }

    // 乐观 seek 尚未确认时：切歌作废标记；同曲的陈旧快照保留乐观位置，
    // 免得一次恰好同时在途的心跳快照把进度条拉回 seek 之前。
    let anchorMs = incoming.positionMs ?? 0;
    const { pendingSeekMs, pendingSeekAt } = get();
    if (pendingSeekMs !== null) {
      const sameTrack = (cur?.trackId ?? null) === (incoming.trackId ?? null);
      // 引擎 seek 失败（如「进度拖动失败」）：快照带 error 到达即撤掉乐观标记，
      // 立刻回到引擎的真实位置。否则进度条会在目标位置空等到超时，而音频其实
      // 一直在旧位置继续播——用户看到的就是先停在拖到的位置、过一会儿又跳回去。
      const seekFailed = sameTrack && incoming.error != null && incoming.error !== "";
      const stale =
        sameTrack &&
        Math.abs(anchorMs - pendingSeekMs) > PENDING_SEEK_TOLERANCE_MS &&
        performance.now() - pendingSeekAt <= PENDING_SEEK_TIMEOUT_MS;
      if (seekFailed || !stale) {
        set({ pendingSeekMs: null });
      } else {
        anchorMs = pendingSeekMs;
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
    liveRevision += 1;
    // 乐观 seek 确认前，丢弃 seek 生效之前就已发出的陈旧 tick，
    // 否则它会把进度条从目标位置拉回原处（表现为松手后抖一下）。
    const { pendingSeekMs, pendingSeekAt } = get();
    if (pendingSeekMs !== null) {
      const confirmed =
        Math.abs(t.positionMs - pendingSeekMs) <= PENDING_SEEK_TOLERANCE_MS;
      const expired = performance.now() - pendingSeekAt > PENDING_SEEK_TIMEOUT_MS;
      if (!confirmed && !expired) {
        // 位置冻结在乐观目标，但时长/缓冲照常跟随，进度条信息不失真
        set({
          durationMs: effectiveDurationMs(t.durationMs),
          bufferedMs: t.bufferedMs,
        });
        return;
      }
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

  applyQueue: (q) => {
    liveRevision += 1;
    const next: Partial<PlayerStore> = {};
    // 队列事件缺 tracks 时保持旧值，别让渲染端 findIndex 撞上 undefined
    if (Array.isArray(q?.tracks)) next.queue = q.tracks;
    // index 允许显式 null（清空队列 / 当前没有曲目）——写成 `q?.index ?? get().queueIndex`
    // 会把 null 当成「字段缺席」，于是清空后 queueIndex 残留旧下标，高亮与
    // 上一首/下一首都指向不存在的行（P1 缺陷）。只有字段真的缺席才保持旧值。
    if (q != null && Object.prototype.hasOwnProperty.call(q, "index")) {
      next.queueIndex = q.index ?? null;
    }
    set(next);
  },

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

  play: async (track, beforeResolve) => {
    const { gen, intent } = startPlayAction(beforeResolve);
    void beforeResolve?.catch(() => undefined);
    const playIntent = await intent;
    if (playIntent === null) return;
    try {
      if (gen !== playActionSeq) return;
      if (beforeResolve) await beforeResolve;
      if (gen !== playActionSeq) return;
      await preResolvePlayUrl(track);
      if (gen !== playActionSeq) return;
      // 队列增删全在 Rust 引擎线程原子完成，前端只镜像 queue-changed。
      await ipc.playTrack(track, sourcePlayQualityOf(track.platform), playIntent);
    } finally {
      abandonPlayIntent(playIntent);
    }
  },

  playQueue: async (tracks, startIndex, beforeResolve) => {
    const { gen, intent } = startPlayAction(beforeResolve);
    void beforeResolve?.catch(() => undefined);
    const playIntent = await intent;
    if (playIntent === null) return { applied: false, ticket: gen, target: null };
    try {
      // 登记或预解析被更晚动作超越时，不发旧队列，也不误报应用成功。
      if (gen !== playActionSeq) return { applied: false, ticket: gen, target: null };
      if (beforeResolve) await beforeResolve;
      if (gen !== playActionSeq) return { applied: false, ticket: gen, target: null };
      await preResolvePlayUrl(tracks[startIndex]);
      if (gen !== playActionSeq) return { applied: false, ticket: gen, target: null };
      const receipt = await ipc.playQueue(tracks, startIndex, playIntent);
      return { applied: receipt.applied, ticket: gen, target: receipt.target };
    } finally {
      abandonPlayIntent(playIntent);
    }
  },

  playAt: async (index) => {
    const gen = ++playActionSeq;
    const playIntent = await beginPlayIntent();
    if (playIntent === null) return;
    try {
      if (gen !== playActionSeq) return;
      const { queue } = get();
      await preResolvePlayUrl(queue[index]);
      if (gen !== playActionSeq) return;
      await ipc.playAt(index, playIntent);
    } finally {
      abandonPlayIntent(playIntent);
    }
  },

  nextTrack: async () => {
    const gen = ++playActionSeq;
    const playIntent = await beginPlayIntent();
    if (playIntent === null) return;
    try {
      if (gen !== playActionSeq) return;
      // 顺序/循环模式可提前算出下一首并预解析；随机模式留给引擎自行解析。
      const st = get().state;
      const { queue, queueIndex } = get();
      if (st && queue.length > 0 && queueIndex !== null && st.playMode !== "random") {
        const nextIndex = (queueIndex + 1) % queue.length;
        await preResolvePlayUrl(queue[nextIndex]);
        if (gen !== playActionSeq) return;
      }
      await ipc.next(playIntent);
    } finally {
      abandonPlayIntent(playIntent);
    }
  },

  prevTrack: async () => {
    const gen = ++playActionSeq;
    const playIntent = await beginPlayIntent();
    if (playIntent === null) return;
    try {
      if (gen !== playActionSeq) return;
      const st = get().state;
      const { queue, queueIndex } = get();
      // 随机模式的上一首由引擎选择，不能预解析队列前一行。
      if (st && st.playMode !== "random" && queue.length > 0 && queueIndex !== null) {
        const prevIndex = (queueIndex - 1 + queue.length) % queue.length;
        await preResolvePlayUrl(queue[prevIndex]);
        if (gen !== playActionSeq) return;
      }
      await ipc.previous(playIntent);
    } finally {
      abandonPlayIntent(playIntent);
    }
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

  seekTo: async (ms, expectedAction, playTarget) => {
    // 带票据的调用（FM 恢复原会话）：播放动作已被更新的点击取代时，当前正在
    // 播的是用户新点的歌，旧会话的定位绝不能落上去
    if (expectedAction !== undefined && expectedAction !== playActionSeq) return false;
    // 带票据却没有 Native 目标：无法证明引擎还会接受这次定位（SMTC / 热键
    // 可能已经换歌），fail closed —— 不写乐观位置，也不发可能落到新歌上的 IPC。
    if (expectedAction !== undefined && !playTarget) return false;
    const target = Math.max(0, Math.round(ms));
    // 只把界面乐观落点留给无票据的手动拖动。带原生目标的恢复 seek 由引擎
    // 按「代次 + 曲目身份」校验，被忽略时界面必须保持新歌的真实位置。
    if (expectedAction === undefined) {
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
    }
    try {
      await (playTarget ? ipc.seek(target, playTarget) : ipc.seek(target));
      return true;
    } catch (e) {
      // 手动 seek 失败（引擎会置 error）：撤掉乐观标记，让后续 tick / 快照
      // 把位置拉回真实值。带票据的调用没写乐观标记，也不能清掉新歌自己的
      // pendingSeek —— 那可能是用户在新歌上刚发出的另一次定位。
      if (expectedAction === undefined) set({ pendingSeekMs: null });
      throw e;
    }
  },

  /** FM 恢复原会话用：只有播放器还是这次恢复动作的「最后一次点击」时才暂停 */
  pauseForAction: async (ticket, target) => {
    if (ticket !== undefined && ticket !== playActionSeq) return false;
    // 有票据却没有 Native 目标：无法确认引擎还把这次恢复当成当前意图
    // （SMTC / 热键可能已经换歌），fail closed，不暂停用户正在听的新歌。
    if (ticket !== undefined && !target) return false;
    await (target ? ipc.pause(target) : ipc.pause());
    return true;
  },

  setVolume: async (v) => {
    await ipc.setVolume(Math.min(1, Math.max(0, v)));
  },

  toggleMute: async () => {
    const st = get().state;
    if (st) await ipc.setMuted(!st.muted);
  },
}));
