// @vitest-environment jsdom
/**
 * 私人 FM 的队列归属与补歌时机（A7，2026-11-02 修复回归）。
 *
 * 测 store 层接线：`queueClaimed` 何时认领/丢失、`tick()`/`ensure()`/`refill()`
 * 的归属守卫。选曲纯函数另见 `tests/radio-queue.test.ts`，页面接线另见
 * `tests/radio-page.test.tsx`。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeBoundary = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  ticket: 0,
  committed: new Set<number>(),
  abandoned: new Set<number>(),
  target: null as import("@/types").PlayTarget | null,
  queueRevision: 0,
}));
const ipcMocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  beginPlayIntent: vi.fn(),
  abandonPlayIntent: vi.fn(),
  playQueue: vi.fn(),
  getLocalTracks: vi.fn(),
  checkDisliked: vi.fn(),
  queueAppend: vi.fn(),
  addDislikeSong: vi.fn(),
  setPlayMode: vi.fn(),
  seek: vi.fn(),
  pause: vi.fn(),
}));

vi.mock("@/services/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ipc")>();
  return { ...ipcMocks, SOURCE_META_CHANGED_EVENT: actual.SOURCE_META_CHANGED_EVENT,
    SOURCE_PACK_CHANGED_EVENT: actual.SOURCE_PACK_CHANGED_EVENT };
});

const recommendMocks = vi.hoisted(() => ({
  loadPreference: vi.fn(),
}));

vi.mock("@/lib/daily-recommend", () => recommendMocks);

import { useRadioStore } from "@/stores/radio";
import { usePlayerStore } from "@/stores/player";
import { trackKey } from "@/lib/text";
import type { PlaybackState, Track } from "@/types";
import type { StyleProfile } from "@/lib/recommend-types";

// Keep the original call spies, but obtain their receipts from the public player
// reservation path and the synthetic Native boundary instead of ticket-zero stubs.
const realPlayQueue = usePlayerStore.getState().playQueue;

// 这套环境里的 localStorage 是 Node 自带的 webstorage（getItem/setItem 之外基本不可用），
// 会盖过 jsdom 的实现（stat.test.ts / stores-persist.test.ts 同款处理）：换成内存实现，
// 保证用例之间互不污染 —— FM 的「上一轮排过的键」就存在这里。
const memStore: Record<string, string> = {};
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string): string | null => (k in memStore ? memStore[k] : null),
    setItem: (k: string, v: string): void => {
      memStore[k] = String(v);
    },
    removeItem: (k: string): void => {
      delete memStore[k];
    },
    clear: (): void => {
      for (const k of Object.keys(memStore)) delete memStore[k];
    },
  },
});

function track(id: string, title: string, singer: string): Track {
  return { id, platform: "local", title, singer, album: "专辑", picUrl: "", duration: 240 };
}

/** 一份有信号的画像，保证 buildRadioBatch 能正常打分选歌 */
const profile: StyleProfile = {
  langs: { zh: 1 },
  bands: { normal: 1 },
  mainLang: "zh",
  mainBand: "normal",
  singers: {},
  albums: {},
  tags: [],
  sampleSize: 20,
};

const fmTracks = [track("a1", "FM 一", "歌手甲"), track("a2", "FM 二", "歌手乙"), track("a3", "FM 三", "歌手丙")];
const fmKeys = fmTracks.map((item) => trackKey(item));

function mockPref(pool: Track[] = fmTracks): void {
  recommendMocks.loadPreference.mockResolvedValue({
    favoriteTracks: [],
    playlistTracks: [],
    recentTracks: [],
    topTracks: [],
    style: profile,
    qualities: undefined,
  });
  ipcMocks.getLocalTracks.mockResolvedValue(pool);
  ipcMocks.checkDisliked.mockResolvedValue(pool.map(() => false));
}

/** 只需要 playMode 的播放快照：FM 这条路径不读其它字段 */
function setPlayerMode(playMode: PlaybackState["playMode"]): void {
  usePlayerStore.setState({ state: { playMode } as unknown as PlaybackState });
}

/** 摆出「进入 FM 之前」的播放器状态：原列表、放到第几首、位置、是否在播 */
function setPlayerSession(
  queue: Track[],
  index: number,
  positionMs: number,
  playing = true,
): void {
  usePlayerStore.setState({
    queue,
    queueIndex: index,
    positionMs,
    state: {
      playMode: "listLoop",
      status: playing ? "playing" : "paused",
    } as unknown as PlaybackState,
  });
}

/** stop 里的恢复流程是 fire-and-forget，等它跑完 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  nativeBoundary.settings.clear(); // Missing persisted preferences retain application FM.
  nativeBoundary.ticket = 0; nativeBoundary.queueRevision = 0; nativeBoundary.target = null;
  nativeBoundary.committed.clear(); nativeBoundary.abandoned.clear();
  ipcMocks.getSetting.mockImplementation(async (key: string) => nativeBoundary.settings.get(key) ?? null);
  ipcMocks.setSetting.mockImplementation(async (key: string, value: string) => { nativeBoundary.settings.set(key, value); });
  ipcMocks.beginPlayIntent.mockImplementation(async () => ++nativeBoundary.ticket);
  ipcMocks.abandonPlayIntent.mockImplementation(async (ticket: number) => {
    if (ticket === nativeBoundary.ticket && !nativeBoundary.committed.has(ticket)) nativeBoundary.abandoned.add(ticket);
  });
  ipcMocks.playQueue.mockImplementation(async (_tracks: Track[], _index: number, ticket: number) => {
    const applied = Number.isSafeInteger(ticket) && ticket > 0 && ticket === nativeBoundary.ticket &&
      !nativeBoundary.abandoned.has(ticket) && !nativeBoundary.committed.has(ticket);
    if (applied) { nativeBoundary.committed.add(ticket); nativeBoundary.queueRevision += 1; }
    const selected = _tracks[_index];
    const target = nativeBoundary.target;
    return { applied, target: applied && selected?.id === target?.id && selected?.platform === target?.platform ? target : null,
      queueRevision: nativeBoundary.queueRevision };
  });
  // 上一轮会话排过的键记在 localStorage 里：不擦干净会串到下一个用例
  window.localStorage.clear();
  ipcMocks.setPlayMode.mockResolvedValue(undefined);
  ipcMocks.seek.mockResolvedValue(undefined);
  ipcMocks.pause.mockResolvedValue(undefined);
  usePlayerStore.setState({ queue: [], queueIndex: null, state: null, playQueue: vi.fn(realPlayQueue) });
  useRadioStore.setState({
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
  });
});

describe("私人 FM 队列归属（queueClaimed）", () => {
  it("start：playQueue 整队替换落地后才认领队列", async () => {
    mockPref();
    const playQueue = vi.fn(realPlayQueue);
    usePlayerStore.setState({ playQueue });
    await useRadioStore.getState().start(null);
    expect(playQueue).toHaveBeenCalledTimes(1);
    expect(playQueue.mock.calls[0]![1]).toBe(0);
    const queued = playQueue.mock.calls[0]![0];
    expect(new Set(queued.map(trackKey))).toEqual(new Set(fmKeys));
    const state = useRadioStore.getState();
    expect(state.active).toBe(true);
    expect(state.queueClaimed).toBe(true);
  });

  it("start：playQueue 被拒（整批被屏蔽滤光）→ 复位并报错，之后 tick 不再补歌", async () => {
    mockPref();
    usePlayerStore.setState({
      playQueue: vi.fn(async () => {
        throw new Error("队列为空");
      }),
    });
    await useRadioStore.getState().start(null);
    const state = useRadioStore.getState();
    expect(state.active).toBe(false);
    expect(state.queueClaimed).toBe(false);
    expect(state.error).toContain("队列为空");
    await useRadioStore.getState().tick();
    expect(ipcMocks.queueAppend).not.toHaveBeenCalled();
  });

  it("tick：队列被换走（双击别的歌单）→ FM 让位停止，不往新队列补歌", async () => {
    useRadioStore.setState({
      active: true,
      queueClaimed: true,
      usedKeys: new Set(fmKeys),
      pool: fmTracks,
      disliked: fmTracks.map(() => false),
      profile,
    });
    usePlayerStore.setState({ queue: [track("x1", "别人的歌", "歌手丁")], queueIndex: 0 });
    await useRadioStore.getState().tick();
    const state = useRadioStore.getState();
    expect(state.active).toBe(false);
    expect(state.queueClaimed).toBe(false);
    expect(ipcMocks.queueAppend).not.toHaveBeenCalled();
  });

  it("tick：余量≤阈值自动往队尾补一批（只补池子里没用过的）", async () => {
    const extras = [track("b1", "储备一", "歌手戊"), track("b2", "储备二", "歌手己")];
    useRadioStore.setState({
      active: true,
      queueClaimed: true,
      usedKeys: new Set(fmKeys),
      pool: [...fmTracks, ...extras],
      disliked: [...fmTracks, ...extras].map(() => false),
      profile,
    });
    usePlayerStore.setState({ queue: fmTracks, queueIndex: 1 });
    ipcMocks.queueAppend.mockResolvedValue(undefined);
    await useRadioStore.getState().tick();
    expect(ipcMocks.queueAppend).toHaveBeenCalledTimes(1);
    const appended = ipcMocks.queueAppend.mock.calls[0]![0] as Track[];
    expect(appended.map(trackKey).sort()).toEqual(extras.map(trackKey).sort());
    expect(useRadioStore.getState().active).toBe(true);
  });

  it("tick：未认领队列时既不补歌也不让位", async () => {
    useRadioStore.setState({
      active: true,
      queueClaimed: false,
      usedKeys: new Set(fmKeys),
      pool: fmTracks,
      disliked: fmTracks.map(() => false),
      profile,
    });
    usePlayerStore.setState({ queue: [track("x1", "别人的歌", "歌手丁")], queueIndex: 0 });
    await useRadioStore.getState().tick();
    const state = useRadioStore.getState();
    expect(state.active).toBe(true);
    expect(state.queueClaimed).toBe(false);
    expect(ipcMocks.queueAppend).not.toHaveBeenCalled();
  });

  it("refill：队列异主时直呼也会让位（不追加）", async () => {
    useRadioStore.setState({
      active: true,
      queueClaimed: true,
      usedKeys: new Set(fmKeys),
      pool: fmTracks,
      disliked: fmTracks.map(() => false),
      profile,
    });
    usePlayerStore.setState({ queue: [track("x1", "别人的歌", "歌手丁")], queueIndex: 0 });
    await useRadioStore.getState().refill();
    expect(useRadioStore.getState().active).toBe(false);
    expect(ipcMocks.queueAppend).not.toHaveBeenCalled();
  });
});

describe("私人 FM 播放模式（顺序听下去）", () => {
  it("start：随机模式下强制顺序播放，记下原模式", async () => {
    mockPref();
    setPlayerMode("random");
    await useRadioStore.getState().start(null);
    expect(ipcMocks.setPlayMode).toHaveBeenCalledWith("listLoop");
    expect(useRadioStore.getState().restorePlayMode).toBe("random");
  });

  it("stop：把借走的模式还回去", async () => {
    mockPref();
    setPlayerMode("random");
    await useRadioStore.getState().start(null);
    useRadioStore.getState().stop();
    expect(ipcMocks.setPlayMode).toHaveBeenLastCalledWith("random");
    expect(useRadioStore.getState().restorePlayMode).toBeNull();
  });

  it("start：本来就在顺序播放时不碰模式，停止也不还", async () => {
    mockPref();
    await useRadioStore.getState().start(null);
    expect(ipcMocks.setPlayMode).not.toHaveBeenCalled();
    expect(useRadioStore.getState().restorePlayMode).toBeNull();
    useRadioStore.getState().stop();
    expect(ipcMocks.setPlayMode).not.toHaveBeenCalled();
  });

  it("让位停止时也还模式（队列被换走）", async () => {
    useRadioStore.setState({
      active: true,
      queueClaimed: true,
      restorePlayMode: "random",
      usedKeys: new Set(fmKeys),
      pool: fmTracks,
      disliked: fmTracks.map(() => false),
      profile,
    });
    usePlayerStore.setState({ queue: [track("x1", "别人的歌", "歌手丁")], queueIndex: 0 });
    await useRadioStore.getState().tick();
    expect(ipcMocks.setPlayMode).toHaveBeenCalledWith("random");
    expect(useRadioStore.getState().restorePlayMode).toBeNull();
  });
});

describe("私人 FM 会话轮换（每次打开都该换一批）", () => {
  /**
   * 有真实分数差的池子：前 20 首「收藏过」（+9 分），后 20 首没听过。
   * 引擎排序因此高度确定 —— 这正是用户「每次重新打开 FM 播放的歌曲全都一模一样」
   * 的场景：只换会话种子（抖动 1.5 归一化后几乎没影响）救不回来，得靠整窗轮换。
   */
  function rankedPool(): Track[] {
    return Array.from({ length: 40 }, (_, index) =>
      track(`s${index}`, `歌曲 ${index}`, `歌手 ${index}`),
    );
  }

  function mockRanked(pool: Track[]): void {
    recommendMocks.loadPreference.mockResolvedValue({
      favoriteTracks: pool.slice(0, 20),
      playlistTracks: [],
      recentTracks: [],
      topTracks: [],
      style: profile,
      qualities: undefined,
    });
    ipcMocks.getLocalTracks.mockResolvedValue(pool);
    ipcMocks.checkDisliked.mockResolvedValue(pool.map(() => false));
  }

  /** 跑一轮 start，返回这一次真正排进播放器队列的曲目 */
  async function runStart(): Promise<Track[]> {
    const playQueue = vi.fn(realPlayQueue);
    usePlayerStore.setState({ queue: [], queueIndex: null, playQueue });
    await useRadioStore.getState().start(null);
    return playQueue.mock.calls[0]![0] as Track[];
  }

  it("两次开始换出不同的一批（不是同一批歌换个顺序）", async () => {
    mockRanked(rankedPool());
    const first = await runStart();
    const second = await runStart();
    expect(first.length).toBeGreaterThan(0);
    expect(second.map((item) => item.id)).not.toEqual(first.map((item) => item.id));
  });

  it("上一轮排过的键落进 localStorage，下一轮整批避开", async () => {
    mockRanked(rankedPool());
    const first = await runStart();
    expect(JSON.parse(window.localStorage.getItem("quietmusic.fm.lastSessionKeys")!)).toEqual(
      first.map(trackKey),
    );
    const second = await runStart();
    const firstKeys = new Set(first.map(trackKey));
    expect(second.length).toBeGreaterThan(0);
    second.forEach((item) => expect(firstKeys.has(trackKey(item))).toBe(false));
  });

  it("池子太小躲不开时退回整窗：宁可能撞，也不能没歌", async () => {
    mockPref(fmTracks);
    const first = await runStart();
    const second = await runStart();
    expect(first.length).toBe(fmTracks.length);
    expect(second.length).toBe(fmTracks.length);
  });
});

describe("私人 FM 退出时归还原播放列表", () => {
  const playlist = [track("p1", "原列表一", "歌手甲"), track("p2", "原列表二", "歌手乙")];

  it("停止 FM：把原列表、当时那一首与播放位置放回去", async () => {
    mockPref();
    const target = { generation: 1, platform: "local" as const, id: playlist[1]!.id };
    nativeBoundary.target = target;
    const playQueue = vi.fn(realPlayQueue);
    usePlayerStore.setState({ playQueue });
    setPlayerSession(playlist, 1, 61_000);
    await useRadioStore.getState().start(null);
    expect(useRadioStore.getState().stash).not.toBeNull();
    playQueue.mockClear();
    useRadioStore.getState().stop();
    await flush();
    expect(playQueue).toHaveBeenCalledTimes(1);
    expect(playQueue.mock.calls[0]![1]).toBe(1);
    expect((playQueue.mock.calls[0]![0] as Track[]).map(trackKey)).toEqual(playlist.map(trackKey));
    expect(ipcMocks.seek).toHaveBeenCalledWith(61_000, target);
    expect(ipcMocks.pause).not.toHaveBeenCalled();
    expect(useRadioStore.getState().stash).toBeNull();
  });

  it("进入时是暂停：放回原处后保持暂停", async () => {
    mockPref();
    const target = { generation: 2, platform: "local" as const, id: playlist[0]!.id };
    nativeBoundary.target = target;
    const playQueue = vi.fn(realPlayQueue);
    usePlayerStore.setState({ playQueue });
    setPlayerSession(playlist, 0, 0, false);
    await useRadioStore.getState().start(null);
    playQueue.mockClear();
    useRadioStore.getState().stop();
    await flush();
    expect(playQueue).toHaveBeenCalledTimes(1);
    expect(ipcMocks.seek).not.toHaveBeenCalled();
    expect(ipcMocks.pause).toHaveBeenCalledTimes(1);
  });

  it("让位退出（用户自己换了队列）不抢回原列表", async () => {
    mockPref();
    const playQueue = vi.fn(realPlayQueue);
    usePlayerStore.setState({ playQueue });
    setPlayerSession(playlist, 1, 61_000);
    await useRadioStore.getState().start(null);
    playQueue.mockClear();
    // 用户双击了别的歌单：队列异主 → FM 让位（stop(false)），不该把原列表抢回来
    usePlayerStore.setState({ queue: [track("x1", "别人的歌", "歌手丁")], queueIndex: 0 });
    await useRadioStore.getState().tick();
    await flush();
    expect(useRadioStore.getState().active).toBe(false);
    expect(useRadioStore.getState().stash).toBeNull();
    expect(playQueue).not.toHaveBeenCalled();
  });

  it("进入 FM 前本来就没在放东西：停止时不还原", async () => {
    mockPref();
    const playQueue = vi.fn(realPlayQueue);
    usePlayerStore.setState({ playQueue, queue: [], queueIndex: null });
    await useRadioStore.getState().start(null);
    expect(useRadioStore.getState().stash).toBeNull();
    playQueue.mockClear();
    useRadioStore.getState().stop();
    await flush();
    expect(playQueue).not.toHaveBeenCalled();
  });
});
