// @vitest-environment jsdom
/**
 * 退出 FM 恢复原会话的代次防护（C03）。
 *
 * 恢复流程是「整队换回原列表 → seek 回原位置 → 当时是暂停就再暂停」。但整队
 * 替换要先等取链预解析，这段时间里用户完全可能已经点了另一首歌。以前
 * `playQueue` 的代次校验直接 `return`（void），恢复流程看不出「这次动作根本没
 * 发出去」，接着把旧会话的 seek/pause 落到用户的新歌上 —— 表现为新歌刚播就被
 * 拖到 61 秒、甚至被暂停。
 *
 * 现在 `playQueue` 回执 `{ applied, ticket }`，`seekTo`/`pauseForAction` 也校验
 * 票据代次；被取代的恢复必须一步都不动当前播放器。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcMocks = vi.hoisted(() => ({
  getLocalTracks: vi.fn(),
  checkDisliked: vi.fn(),
  queueAppend: vi.fn(),
  addDislikeSong: vi.fn(),
  setPlayMode: vi.fn(),
  seek: vi.fn(),
  pause: vi.fn(),
  playTrack: vi.fn(),
  playQueue: vi.fn(),
  beginPlayIntent: vi.fn(),
}));

vi.mock("@/services/ipc", () => ipcMocks);

const qualityMocks = vi.hoisted(() => ({
  resolvePlayUrlWithFallback: vi.fn(),
  peekQualityCeiling: vi.fn(),
  normalizeQualityForSource: vi.fn(),
  sourcePlayQualityOf: vi.fn(),
}));

vi.mock("@/lib/quality-fallback", () => ({
  resolvePlayUrlWithFallback: qualityMocks.resolvePlayUrlWithFallback,
  peekQualityCeiling: qualityMocks.peekQualityCeiling,
  normalizeQualityForSource: qualityMocks.normalizeQualityForSource,
}));

vi.mock("@/lib/source-quality", () => ({
  sourcePlayQualityOf: qualityMocks.sourcePlayQualityOf,
}));

import { usePlayerStore } from "@/stores/player";
import { useRadioStore } from "@/stores/radio";
import type { PlaybackState, Track } from "@/types";

function track(id: string, platform: Track["platform"] = "local"): Track {
  return { id, platform, title: `歌曲 ${id}`, singer: "歌手", album: "专辑", picUrl: "", duration: 240 };
}

/** FM 退出时正在恢复的那首在线歌：预解析要走异步取链，窗口足够长 */
const oldOnline = track("old-online", "wyy");
/** 用户在恢复期间自己点的新歌（本地曲目，不经过取链） */
const newChoice = track("new-choice");

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function stashOf(tracks: Track[], positionMs: number, playing: boolean) {
  return { queue: tracks, index: 0, positionMs, playing };
}

beforeEach(() => {
  vi.clearAllMocks();
  ipcMocks.setPlayMode.mockResolvedValue(undefined);
  ipcMocks.seek.mockResolvedValue(undefined);
  ipcMocks.pause.mockResolvedValue(undefined);
  ipcMocks.playQueue.mockResolvedValue({ applied: true, target: null });
  ipcMocks.playTrack.mockResolvedValue(undefined);
  // 真实 PC 后端一定有 begin_play_intent；测试替身给一张有效正票。
  ipcMocks.beginPlayIntent.mockResolvedValue(100);
  qualityMocks.peekQualityCeiling.mockReturnValue(null);
  qualityMocks.normalizeQualityForSource.mockImplementation((_platform: string, q: string) => q);
  qualityMocks.sourcePlayQualityOf.mockReturnValue("320");
  qualityMocks.resolvePlayUrlWithFallback.mockResolvedValue({
    url: "https://cdn.example/song.mp3",
    quality: "320",
  });
  usePlayerStore.setState({
    state: null,
    positionMs: 0,
    durationMs: 0,
    bufferedMs: 0,
    queue: [],
    queueIndex: null,
    pendingSeekMs: null,
    pendingSeekAt: 0,
  });
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

describe("退出 FM 恢复原会话的代次防护（C03）", () => {
  it("恢复期间用户点了新歌：不再 seek/pause，旧会话一步都不碰新歌", async () => {
    let release: (value: { url: string; quality: string }) => void = () => {};
    qualityMocks.resolvePlayUrlWithFallback.mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );

    useRadioStore.setState({
      active: true,
      queueClaimed: true,
      stash: stashOf([oldOnline], 61_000, false),
    });
    useRadioStore.getState().stop();
    await flush();

    // 恢复动作还卡在取链上，用户自己点了另一首歌
    await usePlayerStore.getState().play(newChoice);
    expect(ipcMocks.playTrack).toHaveBeenCalledTimes(1);

    // 旧会话的取链这时才回来
    release({ url: "https://cdn.example/old.mp3", quality: "320" });
    await flush();
    await flush();

    // 整队替换从未发出，seek/pause 也没落到用户的新歌上
    expect(ipcMocks.playQueue).not.toHaveBeenCalled();
    expect(ipcMocks.seek).not.toHaveBeenCalled();
    expect(ipcMocks.pause).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().state?.trackId ?? null).not.toBe(newChoice.id);
  });

  it("没被打断时照常换回原列表、seek 回原位置并保持暂停", async () => {
    const target = { generation: 11, platform: "wyy" as const, id: oldOnline.id };
    ipcMocks.playQueue.mockResolvedValueOnce({ applied: true, target });
    useRadioStore.setState({
      active: true,
      queueClaimed: true,
      stash: stashOf([oldOnline], 61_000, false),
    });
    useRadioStore.getState().stop();
    await flush();
    await flush();

    expect(ipcMocks.playQueue).toHaveBeenCalledTimes(1);
    expect(ipcMocks.seek).toHaveBeenCalledWith(61_000, target);
    expect(ipcMocks.pause).toHaveBeenCalledWith(target);
  });

  it("票据代次过期后，带票据的 seek/pause 都是空操作", async () => {
    const action = await usePlayerStore.getState().playQueue([newChoice], 0);
    expect(action).toEqual({ applied: true, ticket: expect.any(Number), target: null });

    // 更新的用户播放动作让旧票据作废
    await usePlayerStore.getState().play(newChoice);

    expect(await usePlayerStore.getState().seekTo(5_000, action.ticket)).toBe(false);
    expect(await usePlayerStore.getState().pauseForAction(action.ticket)).toBe(false);
    expect(ipcMocks.seek).not.toHaveBeenCalled();
    expect(ipcMocks.pause).not.toHaveBeenCalled();
  });

  it("Native 拒绝旧队列提交时不继续 seek/pause，即使 JS 票据尚未变化", async () => {
    ipcMocks.playQueue.mockResolvedValueOnce({ applied: false, target: null });
    useRadioStore.setState({
      active: true,
      queueClaimed: true,
      stash: stashOf([oldOnline], 61_000, false),
    });

    useRadioStore.getState().stop();
    await flush();
    await flush();

    expect(ipcMocks.playQueue).toHaveBeenCalledTimes(1);
    expect(ipcMocks.seek).not.toHaveBeenCalled();
    expect(ipcMocks.pause).not.toHaveBeenCalled();
    expect(useRadioStore.getState().error).toBeNull();
  });

  it("已接受队列的 Native 目标透传到恢复 seek/pause，而不是只使用 JS 代次", async () => {
    const target = { generation: 73, platform: "wyy", id: "old-online" };
    ipcMocks.playQueue.mockResolvedValueOnce({ applied: true, target });
    useRadioStore.setState({
      active: true,
      queueClaimed: true,
      stash: stashOf([oldOnline], 61_000, false),
    });

    useRadioStore.getState().stop();
    await flush();
    await flush();

    expect(ipcMocks.seek).toHaveBeenCalledWith(61_000, target);
    expect(ipcMocks.pause).toHaveBeenCalledWith(target);
  });

  it("没有票据的旧调用仍按原样 seek/pause", async () => {
    usePlayerStore.setState({
      state: { playMode: "listLoop", status: "playing" } as unknown as PlaybackState,
    });
    expect(await usePlayerStore.getState().seekTo(1_234)).toBe(true);
    expect(await usePlayerStore.getState().pauseForAction()).toBe(true);
    expect(ipcMocks.seek).toHaveBeenCalledWith(1_234);
    expect(ipcMocks.pause).toHaveBeenCalledTimes(1);
  });

  it("队列接受但 Native 目标为空：恢复 fail closed，不再 legacy seek/pause", async () => {
    ipcMocks.playQueue.mockResolvedValueOnce({ applied: true, target: null });
    useRadioStore.setState({
      active: true,
      queueClaimed: true,
      stash: stashOf([oldOnline], 61_000, false),
    });

    useRadioStore.getState().stop();
    await flush();
    await flush();

    expect(ipcMocks.playQueue).toHaveBeenCalledTimes(1);
    expect(ipcMocks.seek).not.toHaveBeenCalled();
    expect(ipcMocks.pause).not.toHaveBeenCalled();
    expect(useRadioStore.getState().error).toBeNull();
  });

  it("带票据但没有 Native 目标的 seek/pause fail closed，不落到当前歌上", async () => {
    ipcMocks.playQueue.mockResolvedValueOnce({ applied: true, target: null });
    const action = await usePlayerStore.getState().playQueue([newChoice], 0);
    // 当前在播的是用户新点的歌
    usePlayerStore.setState({ positionMs: 2_000 });

    expect(await usePlayerStore.getState().seekTo(5_000, action.ticket)).toBe(false);
    expect(await usePlayerStore.getState().pauseForAction(action.ticket)).toBe(false);
    expect(ipcMocks.seek).not.toHaveBeenCalled();
    expect(ipcMocks.pause).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().positionMs).toBe(2_000);

    // 手动调用（无票据）仍保持旧的乐观 seek / 无条件 pause
    expect(await usePlayerStore.getState().seekTo(1_234)).toBe(true);
    expect(await usePlayerStore.getState().pauseForAction()).toBe(true);
    expect(ipcMocks.seek).toHaveBeenCalledWith(1_234);
    expect(ipcMocks.pause).toHaveBeenCalledTimes(1);
  });
});
