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
import { usePlayerStore } from "@/stores/player";

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
): Promise<void> {
  try {
    await usePlayerStore.getState().playQueue(stash.queue, stash.index);
    if (stash.positionMs > 0) await usePlayerStore.getState().seekTo(stash.positionMs);
    if (!stash.playing) await ipc.pause();
  } catch (err) {
    set({ error: `恢复原播放列表失败：${errMsg(err)}` });
  }
}

export const useRadioStore = create<RadioStore>((set, get) => ({
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
    set({ loading: true, error: null, exhausted: false, seed });
    try {
      const pref = await loadPreference();
      const locals = await ipc.getLocalTracks().catch(() => [] as Track[]);
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
      // 记下这一轮排过的键：下一轮会话据此避让（写在 localStorage，进程重启也还在）
      writeLastSessionKeys(batch.map((track) => trackKey(track)));
      markUsed(usedKeys, rest);
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
        await usePlayerStore.getState().playQueue(batch, 0);
      } catch (err) {
        set({ loading: false, active: false, queueClaimed: false, error: errMsg(err) });
        return;
      }
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
      set({ loading: false, active: false, queueClaimed: false, error: errMsg(err) });
    }
  },

  stop: (restoreOriginal = true) => {
    const { restorePlayMode: restore, stash } = get();
    set({
      active: false,
      queueClaimed: false,
      restorePlayMode: null,
      stash: null,
      loading: false,
      error: null,
      exhausted: false,
      seed: null,
    });
    if (restore !== null) {
      // 把 FM 期间借走的播放模式还给用户：停 FM 只停「继续推歌」，
      // 不该顺手把「随机播放」这种个人设置也一起改掉
      void ipc.setPlayMode(restore).catch(() => {
        // 还原失败无碍播放；用户自己点一下模式按钮即可
      });
    }
    // 用户点「停止 FM」= 退出 FM：把进入前那份播放列表原样放回去
    if (restoreOriginal && stash !== null) void restoreStash(stash, set);
  },

  setTaste: (taste) => {
    if (get().taste === taste) return;
    set({ taste });
    // 口味变了下一批就该按新口味排；已经在队列里的歌不动（不打断正在听的东西）
  },

  refill: async (count = RADIO_BATCH) => {
    const state = get();
    if (!state.active || !state.queueClaimed || state.loading || !state.profile || state.exhausted) return;
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
      const usedKeys = new Set(state.usedKeys);
      markUsed(usedKeys, batch);
      set({ loading: false, usedKeys });
      await ipc.queueAppend(batch);
    } catch (err) {
      set({ loading: false, error: errMsg(err) });
    }
  },

  dislike: async (track) => {
    const state = get();
    try {
      await ipc.addDislikeSong(track);
    } catch (err) {
      // 屏蔽失败不该挡住切歌：把错误显示出来，但照常往下走
      set({ error: errMsg(err) });
    }
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
    if (!shouldRefill(remaining)) return;
    // 队列被换走（双击别的歌单/插了外曲/清空队列）：FM 让位，不再往新队列补歌
    const player = usePlayerStore.getState();
    if (!queueBelongsToRadio(player.queue, state.usedKeys)) {
      // 同上：让位退出不还原原列表
      get().stop(false);
      return;
    }
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
