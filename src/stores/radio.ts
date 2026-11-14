/**
 * 私人 FM 的状态机（A7，对照分析文档 §4.7）。
 *
 * ## 和每日推荐的关系
 * 每日推荐是「一次生成 50 首 + 落缓存 + 可复现」，FM 是「一直听下去」。
 * 两者共用同一套画像（`loadPreference()`）与打分引擎（`recommend-rank.ts`），
 * 区别只在**取数节奏**：FM 每次补 `RADIO_BATCH` 首，靠 `usedKeys` 保证一轮里不重复。
 *
 * ## 队列放在哪
 * FM 的"接下来几首"就是播放器队列本身 —— 不另建一个影子队列，否则「下一首」
 * 按钮、双击播放、队列面板三处会各说各话。所以：
 * - 第一批 `player.playQueue(batch, 0)` —— 从头播；
 * - 后续批次 `ipc.queueAppend(batch)` —— **追加到队尾，不打断当前曲目**，
 *   同时这条 IPC 会让 Rust 侧的播放队列与前端 store 同步（播放器自己不会
 *   在末尾停下，切歌行为与普通队列完全一致）。
 *
 * 进 FM 之前正在放的那份播放列表会被整份抄进 `stash`（曲目 + 序号 + 播放位置 +
 * 播放/暂停），用户点「停止 FM」时按原样放回去 —— 对齐网易云：退出 FM 仍能接着放
 * 原来的播放列表。让位退出（用户自己换了队列）不还原：那是用户的选择。
 *
 * ## 队列归属（queueClaimed）
 * 只有 `playQueue(batch, 0)` 真正落地（整队替换成功）FM 才算"持有"这个队列：
 * `queueClaimed` 记这一点，`tick()`/`ensure()`/`refill()` 都会先核对当前播放器
 * 队列是否还是 FM 推过的那批（每首的 key 都在 `usedKeys` 里）。用户双击别的
 * 歌单、「下一首播放」插了外曲或清空队列 → FM 主动让位（stop），绝不往别人
 * 家的队列里追加推荐歌。补歌心跳挂在 AppShell 而不在页面：见 useRadioRefill。
 *
 * ## 播放模式
 * FM 的语义是「沿队列顺序一直听下去」：随机 / 单曲循环模式下「下一首」会跳到队列里
 * 任意一首，页面上的「接下来」当场换成另一批（用户反馈「和之前的展示毫无关系」）。
 * 所以 FM 持有队列期间强制 `listLoop`，并把用户原来的模式记在 `restorePlayMode`，
 * 停止或让位时还回去。
 *
 * ## 为什么不缓存推荐结果（但记一份「上一轮排过的键」）
 * FM 的推荐结果是一次性的：缓存下来既没有"复现"价值（对齐网易云的无限电台），
 * 又会让下一次进入 FM 时听到同一批 —— 这也是每次开始都要换一个会话种子
 * （`sessionVariant()`，见 radio-queue）的原因。所以 `usedKeys` 只活在本会话内存里。
 *
 * 唯一落到 localStorage 的是**上一轮会话排过的键**（`LAST_SESSION_KEY`）：引擎的
 * 排序是确定性的，只换种子还不足以让两次会话真正不同（抖动权重 1.5 归一化后
 * 几乎不影响前排，见 radio-queue 文件头「会话轮换」），所以新会话额外**避开**上一轮
 * 那十来首 —— 用户才不会看到「每次重新打开 FM 播放的歌曲全都一模一样」（2026-11-02）。
 */

import { create } from "zustand";
import type { DailyTaste, StyleProfile, TrackQuality } from "@/lib/recommend-types";
import type { PlaybackState, Track } from "@/types";
import { trackKey } from "@/lib/text";
import { loadPreference } from "@/lib/daily-recommend";
import {
  buildRadioBatch,
  markUsed,
  RADIO_BATCH,
  seedLane,
  sessionVariant,
  shouldRefill,
} from "@/lib/radio-queue";
import * as ipc from "@/services/ipc";
import {
  abandonPreparedPlayAction, bindPreparedPlayDependency, isPlayActionCurrent, isPreparedPlayActionCurrent,
  reservePlayAction, usePlayerStore, type PlayActionResult, type PreparedPlayAction,
} from "@/stores/player";
import { useRecommendationSourceStore, type RecommendationSelection } from "@/stores/recommendation-source";
import { accountRecommendationContextIsCurrent, fetchAccountRecommendation, getAccountRecommendationContext, onAccountRecommendationContextChange, type AccountRecommendationContext, type AccountRecommendationPage } from "@/lib/account-recommendation";
import { safeAccountRecommendationError } from "@/lib/account-recommendation-error";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 按 `trackKey` 去重，保留先出现的 */
function dedupe(tracks: Track[]): Track[] {
  const seen = new Set<string>();
  const out: Track[] = [];
  for (const track of tracks) {
    if (!track?.id || !track.title) continue;
    const key = trackKey(track);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(track);
  }
  return out;
}

/** FM 是否仍持有当前播放器队列：队列非空，且每一首都是 FM 自己推过的（key ∈ usedKeys） */
function queueBelongsToRadio(queue: Track[], usedKeys: Set<string>): boolean {
  if (queue.length === 0) return false;
  return queue.every((track) => usedKeys.has(trackKey(track)));
}

/** 上一轮 FM 会话排过的键：只用来让下一轮避开它们（见文件头「为什么不缓存推荐结果」） */
const LAST_SESSION_KEY = "quietmusic.fm.lastSessionKeys";

function readLastSessionKeys(): string[] {
  try {
    const raw = window.localStorage.getItem(LAST_SESSION_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item !== "");
  } catch {
    // 读不出来（隐私模式 / 已被清掉 / 存的是坏数据）就当没有：只是少一次避让，不是错误
    return [];
  }
}

function writeLastSessionKeys(keys: string[]): void {
  try {
    window.localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(keys));
  } catch {
    // 写不进去也无碍：下一次最多是「没避开」，不会打断 FM
  }
}

/** 没有任何收听行为时的空画像：引擎照常能跑，只是所有特征都不命中 */
const EMPTY_PROFILE: StyleProfile = {
  langs: {},
  bands: {},
  mainLang: "und",
  mainBand: "normal",
  singers: {},
  albums: {},
  tags: [],
  sampleSize: 0,
};

/**
 * 进入 FM 前正在播放的东西：FM 只是「接管」播放器队列，退出时要原样还回去
 * （对齐网易云：退出 FM 后还能接着放原来的播放列表，曲目、播放位置、
 * 暂停状态都不变）。
 */
export interface RadioStash {
  /** 被接管那一刻的播放列表 */
  queue: Track[];
  /** 当时放到第几首 */
  index: number;
  /** 当时的播放位置（毫秒） */
  positionMs: number;
  /** 当时是否正在播放：不是的话，恢复后保持暂停 */
  playing: boolean;
}

interface RadioStore {
  origin: RecommendationSelection["origin"];
  /** Safe, acknowledged account metadata only; no credential records. */
  account: AccountRecommendationContext | null;
  receivedCount: number;
  accountCursor?: string;
  queueRevision: number | null;
  accountFailureCount: number;
  retryAt: number;
  /** 是否正在 FM 模式（用户停止、或队列被换走让位后变 false） */
  active: boolean;
  /** playQueue 整队替换落地后才 true：FM 持有当前播放器队列的凭证 */
  queueClaimed: boolean;
  /**
   * FM 开始时用户原本的播放模式（`random` / `oneLoop`）：FM 期间强制顺序播放，
   * 停止或让位时把这个模式还回去；本来就是 `listLoop` 时为 null
   */
  restorePlayMode: PlaybackState["playMode"] | null;
  /**
   * 进入 FM 那一刻抄下来的原播放列表：退出 FM（`stop`）时放回去。
   * 让位退出（用户自己换了队列）不会还原 —— 那是用户的选择，不该被我们改回去。
   */
  stash: RadioStash | null;
  loading: boolean;
  error: string | null;
  /** 用户选的口味档 */
  taste: DailyTaste;
  /** 本次 FM 的种子（当前播放/右键"以此曲为种子"时传入） */
  seed: Track | null;
  /** 本轮已经排过的键：跨批次硬去重 */
  usedKeys: Set<string>;
  /** 候选池与同序屏蔽标记 —— 补歌复用，避免每批都重读曲库 */
  pool: Track[];
  disliked: boolean[];
  profile: StyleProfile | null;
  quality?: Map<string, TrackQuality>;
  savedKeys: Set<string>;
  playedKeys: Set<string>;
  /** 曲库/收藏/歌单全被排空：不再自动补 */
  exhausted: boolean;

  start: (seed?: Track | null) => Promise<void>;
  /**
   * 退出 FM。`restoreOriginal` 为真（默认，用户点「停止 FM」）时把进入前抄下来的
   * 播放列表放回去；让位退出（队列被用户换走）时传 false，只清状态不动播放器。
   */
  stop: (restoreOriginal?: boolean) => void;
  setTaste: (taste: DailyTaste) => void;
  /** 立刻补一批（"换一批"按钮） */
  refill: (count?: number) => Promise<void>;
  /** 不喜欢当前这首：落屏蔽规则 + 立刻补一首顶上 */
  dislike: (track: Track) => Promise<void>;
  /** 播放器队列余量不足时补一批；先核对 FM 是否仍持有队列（tick 的实际执行者） */
  ensure: (remaining: number) => Promise<void>;
  /** 全局心跳（AppShell 的 useRadioRefill 每秒调一次）：读播放器余量并按需补歌 */
  tick: () => Promise<void>;
}

/**
 * 退出 FM 时把进入前抄下来的播放列表放回去。
 *
 * 顺序：整队换回原列表（从当时那一首起播）→ seek 回当时的位置 → 当时是暂停就再暂停。
 * 任何一步失败都不该让 FM 退不出去，只在页面上报一句「恢复原播放列表失败」。
 */
async function restoreStash(
  stash: RadioStash,
  set: (patch: Partial<RadioStore>) => void,
  owner?: { revision: number; isCurrent: () => boolean; signal: AbortSignal },
): Promise<void> {
  try {
    const player = usePlayerStore.getState();
    const result: PlayActionResult | undefined = owner
      ? await player.playQueue(stash.queue, stash.index, undefined, owner.isCurrent, owner.signal, owner.revision)
      : await player.playQueue(stash.queue, stash.index);
    if (owner?.isCurrent() === false) return;
    // 恢复期间用户点了别的歌：整队替换动作已被取代、IPC 根本没发出。此时
    // 播放器属于用户新点的歌，旧会话的 seek/pause 一步都不能再落上去。
    if (!result || !result.applied) return;
    // 队列虽然接受了，但没有 Native 目标（代次 + 曲目身份）可校验：后面的
    // seek/pause 无法证明会落到恢复的那首歌上，宁可放弃恢复的进度也不误伤
    // 用户此刻正在听的新歌（fail closed）。
    if (!result.target) return;
    const { ticket, target } = result;
    if (stash.positionMs > 0) await player.seekTo(stash.positionMs, ticket, target);
    if (!stash.playing) await player.pauseForAction(ticket, target);
  } catch (err) {
    if (owner?.isCurrent() !== false) set({ error: `恢复原播放列表失败：${errMsg(err)}` });
  }
}

// Every explicit start/stop owns a generation; old awaits cannot revive its state.
async function pullAccountRadioBatch(
  account: AccountRecommendationContext,
  usedKeys: ReadonlySet<string>,
  isCurrent: () => boolean,
  cursor?: string,
): Promise<{ page: AccountRecommendationPage; batch: Track[] } | null> {
  for (let pull = 0; pull < 3; pull += 1) {
    if (!isCurrent()) return null;
    const page = await fetchAccountRecommendation(account, cursor);
    if (!isCurrent()) return null;
    const batch = dedupe(page.tracks).filter(track => !usedKeys.has(trackKey(track)));
    if (batch.length > 0 || page.exhausted || pull === 2) return { page, batch };
    cursor = page.cursor;
  }
  return null;
}

let radioSession = 0;
let pendingStartAction: PreparedPlayAction | null = null;
let pendingStartAbort: AbortController | null = null;
let pendingAppendAbort: AbortController | null = null;
let pendingRestoreAbort: AbortController | null = null;
let accountQueueActionTicket: number | null = null;

export const useRadioStore = create<RadioStore>((set, get) => ({
  origin: "app",
  account: null,
  receivedCount: 0,
  accountCursor: undefined,
  queueRevision: null,
  accountFailureCount: 0,
  retryAt: 0,
  active: false,
  queueClaimed: false,
  restorePlayMode: null,
  stash: null,
  loading: false,
  error: null,
  taste: "heart",
  seed: null,
  usedKeys: new Set<string>(),
  pool: [],
  disliked: [],
  profile: null,
  quality: undefined,
  savedKeys: new Set<string>(),
  playedKeys: new Set<string>(),
  exhausted: false,

  start: async (seed = null) => {
    if (get().loading) return;
    const session = ++radioSession;
    pendingRestoreAbort?.abort();
    pendingRestoreAbort = null;
    accountQueueActionTicket = null;
    const abortController = new AbortController();
    pendingStartAbort?.abort();
    pendingStartAbort = abortController;
    // reservePlayAction increments the JS generation synchronously at the original click.
    const actionPromise = reservePlayAction();
    let action: PreparedPlayAction | null = null;
    let consumed = false;
    const current = (): boolean => session === radioSession && !abortController.signal.aborted && (!action || consumed || isPreparedPlayActionCurrent(action));
    const playBatch = async (tracks: Track[], providerCurrent: () => boolean = () => true): Promise<PlayActionResult | null> => {
      if (!action || !current() || !providerCurrent()) return null;
      const dependency = Promise.resolve();
      if (!bindPreparedPlayDependency(action, dependency)) return null;
      consumed = true;
      if (pendingStartAction === action) pendingStartAction = null;
      return usePlayerStore.getState().playQueue(tracks, 0, dependency, () => current() && providerCurrent(), abortController.signal);
    };
    set({ loading: true, error: null, exhausted: false, seed, accountFailureCount: 0, retryAt: 0 });
    try {
      action = await actionPromise;
      if (!current()) return;
      if (!action) {
        set({ loading: false, active: false, queueClaimed: false, error: "播放意图未取得有效回执，FM 未接管队列。" });
        return;
      }
      pendingStartAction = action;
      await useRecommendationSourceStore.getState().load();
      if (!current()) return;
      const selection = useRecommendationSourceStore.getState().fm;
      set({ origin: selection.origin });
      if (selection.origin === "account") {
        try {
          const account = await getAccountRecommendationContext("fm");
          if (!current()) return;
          set({ account });
          const pulled = await pullAccountRadioBatch(account, new Set(), current);
          if (!pulled || !current() || !accountRecommendationContextIsCurrent(account)) return;
          const { page, batch } = pulled;
          if (batch.length === 0) {
            set({ active: false, queueClaimed: false, loading: false, exhausted: page.exhausted,
              error: "平台本次没有返回 FM 歌曲，未使用应用曲库替补。" });
            return;
          }
          const before = usePlayerStore.getState();
          const stash = get().queueClaimed ? get().stash : before.queue.length > 0 ? {
            queue: [...before.queue], index: Math.min(Math.max(0, before.queueIndex ?? 0), before.queue.length - 1),
            positionMs: Math.max(0, Math.round(before.positionMs)), playing: before.state?.status === "playing",
          } : null;
          const receipt = await playBatch(batch, () => accountRecommendationContextIsCurrent(account));
          if (!current() || !accountRecommendationContextIsCurrent(account)) return;
          if (!receipt?.applied || typeof receipt.queueRevision !== "number" || !Number.isSafeInteger(receipt.queueRevision) || receipt.queueRevision < 1) {
            set({ active: false, queueClaimed: false, loading: false, error: "未取得可验证的播放队列回执，FM 未接管队列。" });
            return;
          }
          accountQueueActionTicket = receipt.ticket;
          const usedKeys = new Set<string>();
          markUsed(usedKeys, batch);
          const currentMode = usePlayerStore.getState().state?.playMode ?? "listLoop";
          const restorePlayMode = currentMode === "listLoop" ? get().restorePlayMode : currentMode;
          if (currentMode !== "listLoop") void ipc.setPlayMode("listLoop").catch(() => undefined);
          set({ active: true, queueClaimed: true, loading: false, account, stash, restorePlayMode, usedKeys,
            receivedCount: batch.length, accountCursor: page.cursor, queueRevision: receipt.queueRevision,
            exhausted: page.exhausted, pool: [], disliked: [], profile: null, quality: undefined,
            savedKeys: new Set(), playedKeys: new Set() });
        } catch (error) {
          if (current()) set({ active: false, queueClaimed: false, loading: false, error: safeAccountRecommendationError(error).message });
        }
        return;
      }
      const pref = await loadPreference();
      if (!current()) return;
      const locals = await ipc.getLocalTracks().catch(() => [] as Track[]);
      if (!current()) return;
      // 池子 = 本地库 + 收藏 + 歌单 + 最近播放；收藏/歌单/最近可能不在本地库里
      // （云端卡片、已删文件），但只要有 playable 的 id 就能进队列，所以一并并进去重。
      const pool = dedupe([
        ...locals,
        ...pref.favoriteTracks,
        ...pref.playlistTracks,
        ...pref.recentTracks,
      ]);
      if (pool.length === 0) {
        set({ loading: false, active: false, error: "曲库里还没有可以播放的歌，先扫描一次本地目录吧" });
        return;
      }
      const disliked = await ipc.checkDisliked(pool).catch(() => pool.map(() => false));
      if (!current()) return;
      const savedKeys = new Set(pref.favoriteTracks.map((t) => trackKey(t)));
      // `topTracks` / `style` 在「完全没有收听行为」时可能缺省：
      // 前者只是加权用的历史键（没有就是没听过），后者要一份空画像兜底，
      // 否则引擎拿不到 `StyleProfile` 只能整批放弃 —— 新用户一进 FM 就该有歌。
      const playedKeys = new Set((pref.topTracks ?? []).map((item) => trackKey(item.track)));
      const profile = pref.style ?? EMPTY_PROFILE;
      const usedKeys = new Set<string>();
      // 种子车道先占位：同歌手/同专辑的 3 首排在最前，其余名额交给引擎
      const lane = seedLane(pool, seed);
      markUsed(usedKeys, lane);
      // 上一轮会话排过的键：这一次整批避开它们。引擎排序是确定性的，只换种子
      // 还不足以让两次会话不同（用户反馈「每次重新打开 FM 播放的歌曲全都一模一样」）
      const avoidKeys = readLastSessionKeys();
      const rest = buildRadioBatch({
        pool,
        profile,
        taste: get().taste,
        usedKeys,
        disliked,
        playedKeys,
        savedKeys,
        quality: pref.qualities,
        count: Math.max(1, RADIO_BATCH - lane.length),
        // 会话种子：不加这一行的话，同一份画像 + 同一个池子每次开始都会挑出
        // 一模一样的第一首和同一批队列（用户反馈「每次开始都是这一首歌」）
        variant: sessionVariant(),
        avoidKeys,
      });
      const batch = [...lane, ...rest];
      if (batch.length === 0) {
        set({ loading: false, active: false, error: "曲库里的歌都被筛掉了，试试放宽屏蔽列表" });
        return;
      }
      // 进入 FM 前把用户原来的播放列表整份抄下来：FM 只是「接管」播放器队列，
      // 退出（停止 FM）时要原样还回去 —— 对齐网易云，退出 FM 仍能接着放原列表。
      // 已经在 FM 里（queueClaimed）时不再抄一次，否则会把 FM 队列当成「原列表」。
      let stash = get().stash;
      const before = usePlayerStore.getState();
      if (!get().queueClaimed && before.queue.length > 0) {
        stash = {
          queue: [...before.queue],
          index: Math.min(Math.max(0, before.queueIndex ?? 0), before.queue.length - 1),
          positionMs: Math.max(0, Math.round(before.positionMs)),
          playing: before.state?.status === "playing",
        };
      }
      try {
        // 等 playQueue 真正落地（整队替换成功）才认领队列。整批撞上屏蔽列表
        // 被 Rust 滤光时会返回 Err("队列为空")：不接住这个 rejection 的话
        // active 还挂着 true，补歌会一直往旧队列里追加（2026-11-02 修复）。
        const receipt = await playBatch(batch);
        if (!current()) return;
        if (!receipt?.applied) {
          set({ loading: false, active: false, queueClaimed: false, error: "播放队列未接受 FM，本轮未接管队列。" });
          return;
        }
      } catch (err) {
        if (!current()) return;
        set({ loading: false, active: false, queueClaimed: false, error: errMsg(err) });
        return;
      }
      // 只有已接受的 Native 队列才计入本轮已用键和跨会话避让历史。
      markUsed(usedKeys, rest);
      writeLastSessionKeys(batch.map((track) => trackKey(track)));
      // FM 在随机 / 单曲循环模式下「下一首」会跳到队列里任意一首（页面上的
      // 「接下来」当场换成另一批，和刚看到的毫无关系）——用户反馈的就是这个。
      // 所以持有队列期间强制顺序播放，把用户原来的模式记下来，停止/让位时还回去。
      const currentMode = usePlayerStore.getState().state?.playMode ?? "listLoop";
      const restorePlayMode = currentMode === "listLoop" ? get().restorePlayMode : currentMode;
      if (currentMode !== "listLoop") {
        void ipc.setPlayMode("listLoop").catch(() => {
          // 切模式失败不该让 FM 起不来：最坏这次仍按用户原来的模式走
        });
      }
      set({
        loading: false,
        active: true,
        queueClaimed: true,
        restorePlayMode,
        stash,
        usedKeys,
        pool,
        disliked,
        profile,
        quality: pref.qualities,
        savedKeys,
        playedKeys,
        exhausted: false,
      });
    } catch (err) {
      if (current()) set({ loading: false, active: false, queueClaimed: false, error: errMsg(err) });
    } finally {
      const stillCurrent = current();
      if (pendingStartAction === action) pendingStartAction = null;
      if (pendingStartAbort === abortController) pendingStartAbort = null;
      if (action && !consumed) abandonPreparedPlayAction(action);
      if (session === radioSession && !stillCurrent) get().stop(false);
      if (session === radioSession && get().loading) set({ loading: false });
    }
  },

  stop: (restoreOriginal = true) => {
    radioSession += 1;
    pendingRestoreAbort?.abort();
    pendingRestoreAbort = null;
    pendingStartAbort?.abort();
    pendingStartAbort = null;
    pendingAppendAbort?.abort();
    pendingAppendAbort = null;
    if (pendingStartAction) abandonPreparedPlayAction(pendingStartAction);
    pendingStartAction = null;
    const { origin, restorePlayMode: restore, stash, queueRevision } = get();
    const acceptedAction = accountQueueActionTicket;
    accountQueueActionTicket = null;
    set({
      active: false,
      queueClaimed: false,
      restorePlayMode: null,
      stash: null,
      loading: false,
      error: null,
      exhausted: false,
      seed: null,
      account: null,
      accountCursor: undefined,
      queueRevision: null,
      receivedCount: 0,
      accountFailureCount: 0,
      retryAt: 0,
      usedKeys: new Set(),
    });
    if (restore !== null) {
      // 把 FM 期间借走的播放模式还给用户：停 FM 只停「继续推歌」，
      // 不该顺手把「随机播放」这种个人设置也一起改掉
      void ipc.setPlayMode(restore).catch(() => {
        // 还原失败无碍播放；用户自己点一下模式按钮即可
      });
    }
    // 用户点「停止 FM」= 退出 FM：把进入前那份播放列表原样放回去
    if (restoreOriginal && stash !== null) {
      if (origin === "account") {
        if (acceptedAction === null || !isPlayActionCurrent(acceptedAction) || queueRevision === null) return;
        const stoppedSession = radioSession;
        const abortController = new AbortController();
        pendingRestoreAbort = abortController;
        // Native qualifies reservation without replacing pending B, then compares
        // this original owner again in the actual replacement commit. Never release
        // and read back a newer owner as permission to resurrect the stash.
        void restoreStash(stash, set, {
          revision: queueRevision,
          isCurrent: () => stoppedSession === radioSession && !abortController.signal.aborted,
          signal: abortController.signal,
        }).finally(() => {
          if (pendingRestoreAbort === abortController) pendingRestoreAbort = null;
        });
        return;
      }
      void restoreStash(stash, set);
    }
  },

  setTaste: (taste) => {
    if (useRecommendationSourceStore.getState().fm.origin === "account" || get().taste === taste) return;
    set({ taste });
    // 口味变了下一批就该按新口味排；已经在队列里的歌不动（不打断正在听的东西）
  },

  refill: async (count = RADIO_BATCH) => {
    const state = get();
    if (!state.active || !state.queueClaimed || state.loading || state.exhausted) return;
    if (state.origin === "account") {
      const account = state.account;
      const expectedRevision = state.queueRevision;
      if (!account || !accountRecommendationContextIsCurrent(account) || expectedRevision === null || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        get().stop(false);
        return;
      }
      if (!queueBelongsToRadio(usePlayerStore.getState().queue, state.usedKeys)) {
        get().stop(false);
        return;
      }
      if (Date.now() < state.retryAt) return;
      const session = radioSession;
      const controller = new AbortController();
      pendingAppendAbort?.abort();
      pendingAppendAbort = controller;
      const current = (): boolean => session === radioSession && !controller.signal.aborted && get().active && get().queueClaimed &&
        get().account === account && get().queueRevision === expectedRevision && accountRecommendationContextIsCurrent(account);
      set({ loading: true, error: null });
      let appendAttempted = false;
      try {
        const pulled = await pullAccountRadioBatch(account, state.usedKeys, current, state.accountCursor);
        if (!pulled || !current()) return;
        const { page, batch } = pulled;
        if (batch.length === 0) {
          // Empty/duplicate pulls cannot commit a cursor without an accepted queue mutation.
          set({ exhausted: true });
          return;
        }
        // The native compare-and-append is the authority even if the UI mirror is still old.
        if (!queueBelongsToRadio(usePlayerStore.getState().queue, state.usedKeys)) {
          get().stop(false);
          return;
        }
        appendAttempted = true;
        const receipt = await ipc.queueAppendIfCurrent(batch, expectedRevision, controller.signal);
        if (!current()) return;
        if (!receipt.applied || !Number.isSafeInteger(receipt.queueRevision) || receipt.queueRevision <= expectedRevision) {
          get().stop(false);
          return;
        }
        const usedKeys = new Set(state.usedKeys);
        markUsed(usedKeys, batch);
        set({ usedKeys, receivedCount: state.receivedCount + batch.length, queueRevision: receipt.queueRevision,
          accountCursor: page.cursor, exhausted: page.exhausted, accountFailureCount: 0, retryAt: 0 });
      } catch (error) {
        if (!current()) return;
        if (appendAttempted) {
          get().stop(false);
          set({ error: "无法验证本次队列追加回执，FM 已停止；请重新开始收听。" });
          return;
        }
        const failure = safeAccountRecommendationError(error);
        const failures = state.accountFailureCount + 1;
        const transient = failure.code === "NETWORK" || failure.code === "RATE_LIMIT" || failure.code === "UPSTREAM";
        if (!transient || failures >= 3) {
          get().stop(false);
          set({ error: failure.message });
        } else {
          const delay = Math.min(60_000, 5_000 * 2 ** (failures - 1));
          set({ error: failure.message, accountFailureCount: failures, retryAt: Date.now() + delay });
        }
      } finally {
        if (pendingAppendAbort === controller) pendingAppendAbort = null;
        if (session === radioSession && (get().account !== account || !accountRecommendationContextIsCurrent(account))) get().stop(false);
        if (session === radioSession) set({ loading: false });
      }
      return;
    }
    if (!state.profile) return;
    const session = radioSession;
    const current = (): boolean => session === radioSession && get().active && get().queueClaimed && useRecommendationSourceStore.getState().fm.origin === "app";
    // 队列被换走（双击别的歌单/清空队列/插了外曲）：FM 让位，绝不往别人的队列里追加。
    // 传 false：这是用户自己的选择，不要把我们抄下来的旧列表抢回去。
    if (!queueBelongsToRadio(usePlayerStore.getState().queue, state.usedKeys)) {
      get().stop(false);
      return;
    }
    set({ loading: true });
    try {
      const batch = buildRadioBatch({
        pool: state.pool,
        profile: state.profile,
        taste: state.taste,
        usedKeys: state.usedKeys,
        disliked: state.disliked,
        playedKeys: state.playedKeys,
        savedKeys: state.savedKeys,
        quality: state.quality,
        count,
        // 变体种子：同一次会话里同样一批候选也要能"换一批"
        variant: `${Date.now()}`,
      });
      if (batch.length === 0) {
        set({ loading: false, exhausted: true });
        return;
      }
      if (!current()) return;
      await ipc.queueAppend(batch);
      if (!current()) return;
      const usedKeys = new Set(get().usedKeys);
      markUsed(usedKeys, batch);
      set({ usedKeys });
    } catch (err) {
      if (current()) set({ error: errMsg(err) });
    } finally {
      if (current()) set({ loading: false });
    }
  },

  dislike: async (track) => {
    const state = get();
    if (useRecommendationSourceStore.getState().fm.origin === "account") return;
    const session = radioSession;
    const current = (): boolean => session === radioSession && useRecommendationSourceStore.getState().fm.origin === "app";
    try {
      await ipc.addDislikeSong(track);
    } catch (err) {
      // 屏蔽失败不该挡住切歌：把错误显示出来，但照常往下走
      if (!current()) return;
      set({ error: errMsg(err) });
    }
    if (!current()) return;
    // 池子里同键的候选就地标脏，下一批就不会再挑到它（Rust 侧 check_disliked 才是权威，
    // 这里只是让内存里的标记跟上，省掉一次整池重查）。键统一用 trackKey，
    // 与池子判定的口径一致 —— 双口径（歌名键）会让标记和判定对不上。
    const badKey = trackKey(track);
    const disliked = state.pool.map((item, index) => {
      if (state.disliked[index] === true) return true;
      return trackKey(item) === badKey;
    });
    set({ disliked });
    void usePlayerStore.getState().nextTrack().catch(() => {
      // 切歌失败不把 rejection 悬空（引擎侧已记日志）；FM 状态不受影响
    });
    if (state.active && !state.exhausted) await get().refill(1);
  },

  ensure: async (remaining) => {
    const state = get();
    if (!state.active || !state.queueClaimed) return;
    // 归属核对必须排在补歌阈值之前：队列被换走时哪怕余量还很多（用户双击了
    // 自己的长歌单），FM 也要立刻让位。以前先看阈值，长队列一辈子触发不到这里，
    // queueClaimed 一直挂着，之后退出 FM 会把原列表盖到用户自己的队列上。
    // An account append can update the Native mirror before its receipt commits
    // usedKeys/cursor. Let that receipt settle ownership; Native still compares
    // the expected revision, and auth/provider revocation cancels immediately.
    if (state.origin === "account" && state.loading) return;
    const player = usePlayerStore.getState();
    if (!queueBelongsToRadio(player.queue, state.usedKeys)) {
      // 同上：让位退出不还原原列表
      get().stop(false);
      return;
    }
    if (!shouldRefill(remaining)) return;
    await get().refill();
  },

  tick: async () => {
    const state = get();
    if (!state.active || !state.queueClaimed) return;
    const player = usePlayerStore.getState();
    const remaining = player.queue.length - (player.queueIndex ?? 0) - 1;
    await get().ensure(remaining);
  },
}));

// Selection changes are explicit relinquishment, not an invitation to restore or auto-start.
useRecommendationSourceStore.subscribe((state, previous) => {
  if (state.fmRevision === previous.fmRevision) return;
  const radio = useRadioStore.getState();
  if (radio.active || radio.loading || pendingRestoreAbort !== null) radio.stop(false);
});

onAccountRecommendationContextChange((feature) => {
  if (feature !== undefined && feature !== "fm") return;
  const radio = useRadioStore.getState();
  if (radio.origin !== "account" || (!radio.active && !radio.loading && pendingRestoreAbort === null)) return;
  // The initial engine-ready notification may precede the first acknowledged context.
  // Auth/provider revocation cancels preparation and any still-pending owned restore.
  if (feature === "fm" || radio.account !== null || pendingRestoreAbort !== null) radio.stop(false);
});
