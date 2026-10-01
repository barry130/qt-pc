// 进度条松手抖动回归：乐观 seek + 陈旧 tick 丢弃。
// 纯 node 环境，mock 掉 Tauri invoke 即可。
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({})),
}));

import { invoke } from "@tauri-apps/api/core";
import { usePlayerStore } from "@/stores/player";
import type { PlaybackState, PositionChanged, Track } from "@/types";

const invokeMock = vi.mocked(invoke);

const track: Track = {
  id: "t1",
  platform: "kw",
  title: "晴天",
  singer: "周杰伦",
  album: "",
  picUrl: "",
  duration: 200,
};

function playingSnapshot(positionMs: number): PlaybackState {
  return {
    trackId: "t1",
    sourceId: "kw",
    status: "playing",
    positionMs,
    durationMs: 200_000,
    bufferedMs: 0,
    volume: 0.8,
    muted: false,
    playMode: "listLoop",
    quality: "flac",
    queueIndex: 0,
    queueLen: 1,
    isLocal: false,
    urlFetchedAt: null,
    playUrl: null,
    error: null,
    sleepTimerMs: null,
    track,
    outputDevice: "",
    sleepAfterTrack: false,
    speed: 1,
  };
}

function tick(positionMs: number): PositionChanged {
  return { positionMs, durationMs: 200_000, bufferedMs: 0, monotonicMs: 0 };
}

beforeEach(() => {
  usePlayerStore.setState({
    state: null,
    // 高频进度标量（P1-10 拆出来的一层）也要归零，否则用例之间会互相污染
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
  });
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({});
});

describe("乐观 seek", () => {
  it("seekTo 同步落点：IPC 尚未返回时进度已在目标位置", async () => {
    usePlayerStore.getState().applySnapshot(playingSnapshot(60_000));

    let release: () => void = () => {};
    invokeMock.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve({}))),
    );

    const p = usePlayerStore.getState().seekTo(120_000);

    // 同步阶段（await 之前）就必须已经到目标，否则松手那帧会掉回旧位置
    const s = usePlayerStore.getState();
    expect(s.state?.positionMs).toBe(120_000);
    expect(s.positionAnchorValue).toBe(120_000);
    expect(s.pendingSeekMs).toBe(120_000);

    release();
    await p;
  });

  it("确认前丢弃陈旧 tick，确认后清除标记", () => {
    usePlayerStore.getState().applySnapshot(playingSnapshot(60_000));
    usePlayerStore.setState({
      pendingSeekMs: 120_000,
      pendingSeekAt: performance.now(),
      positionAnchorValue: 120_000,
    });

    // seek 生效前发出的旧位置 tick：不能把进度拉回去
    usePlayerStore.getState().applyTick(tick(60_500));
    let s = usePlayerStore.getState();
    expect(s.positionAnchorValue).toBe(120_000);
    expect(s.pendingSeekMs).toBe(120_000);

    // 落在目标附近的新 tick：确认并接管
    usePlayerStore.getState().applyTick(tick(120_200));
    s = usePlayerStore.getState();
    expect(s.positionAnchorValue).toBe(120_200);
    expect(s.pendingSeekMs).toBeNull();
  });

  it("同曲陈旧快照保留乐观位置，切歌则作废标记", () => {
    usePlayerStore.getState().applySnapshot(playingSnapshot(60_000));
    usePlayerStore.setState({
      pendingSeekMs: 120_000,
      pendingSeekAt: performance.now(),
      positionAnchorValue: 120_000,
    });

    // 同曲心跳快照带来旧位置 → 保留乐观目标
    usePlayerStore.getState().applySnapshot(playingSnapshot(60_400));
    let s = usePlayerStore.getState();
    expect(s.state?.positionMs).toBe(120_000);
    expect(s.pendingSeekMs).toBe(120_000);

    // 换歌 → 旧目标作废，正常接受新快照
    const other: PlaybackState = {
      ...playingSnapshot(0),
      trackId: "t2",
      track: { ...track, id: "t2" },
    };
    usePlayerStore.getState().applySnapshot(other);
    s = usePlayerStore.getState();
    expect(s.pendingSeekMs).toBeNull();
    expect(s.state?.positionMs).toBe(0);
  });

  it("seek 失败撤掉乐观标记并抛错", async () => {
    usePlayerStore.getState().applySnapshot(playingSnapshot(60_000));
    invokeMock.mockRejectedValue(new Error("try_seek 失败"));

    await expect(usePlayerStore.getState().seekTo(120_000)).rejects.toThrow();
    expect(usePlayerStore.getState().pendingSeekMs).toBeNull();
  });

  it("停止的空快照会让乐观标记作废，避免进度条卡在目标位置", () => {
    usePlayerStore.getState().applySnapshot(playingSnapshot(60_000));
    usePlayerStore.setState({
      pendingSeekMs: 120_000,
      pendingSeekAt: performance.now(),
      positionAnchorValue: 120_000,
    });

    usePlayerStore
      .getState()
      .applySnapshot({ ...playingSnapshot(0), status: "stopped", trackId: null, track: null });

    expect(usePlayerStore.getState().pendingSeekMs).toBeNull();
  });
});
