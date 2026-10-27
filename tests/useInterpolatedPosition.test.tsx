// @vitest-environment jsdom
// 进度条「2 分 → 1 分 → 2 分」回归。
//
// 场景：拖动到 2:00 松手 → seekTo 同步写锚点/pendingSeekMs → 引擎确认 tick 到达、
// pendingSeekMs 被清 → 展示退回插值值。若插值 hook 在锚点突变时没有立刻更新
// state（只重置了 rAF 的记账基准），退回的就是旧位置 1:00，几十毫秒后才跳回 2:00。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({})),
}));

import { usePlayerStore } from "@/stores/player";
import { useInterpolatedPosition } from "@/hooks/useInterpolatedPosition";
import type { PlaybackState, Track } from "@/types";

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
    bitrateKbps: null,
    sleepAfterTrack: false,
    speed: 1,
  };
}

/** 允许 1 个量化步长（100ms）的取整误差 */
const near = (actual: number, expected: number): boolean =>
  Math.abs(actual - expected) <= 100;

beforeEach(() => {
  usePlayerStore.setState({
    state: null,
    positionMs: 0,
    positionAnchorValue: 0,
    positionAnchorMs: 0,
    durationMs: 0,
    bufferedMs: 0,
    pendingSeekMs: null,
    pendingSeekAt: 0,
    isDraggingProgress: false,
  });
});

describe("useInterpolatedPosition", () => {
  it("锚点突变（seek 落点）在同一提交内就反映，不会先退回旧位置", () => {
    act(() => {
      usePlayerStore.getState().applySnapshot(playingSnapshot(60_000));
    });
    const { result } = renderHook(() => useInterpolatedPosition());
    expect(near(result.current, 60_000)).toBe(true);

    // 松手拖动到 2:00：seekTo 的行为（同步写锚点 + pendingSeekMs）
    act(() => {
      usePlayerStore.setState({
        pendingSeekMs: 120_000,
        pendingSeekAt: performance.now(),
        positionAnchorValue: 120_000,
        positionAnchorMs: performance.now(),
        positionMs: 120_000,
        state: playingSnapshot(120_000),
      });
    });
    // 引擎确认 tick 到达 → pendingSeekMs 清掉，展示退回插值值。
    // 修复前这里会读到 60_000（旧位置），进度条闪一下才回到 120_000。
    act(() => {
      usePlayerStore.setState({ pendingSeekMs: null });
    });

    expect(near(result.current, 120_000)).toBe(true);
  });

  it("暂停态 seek：布局同步直接给出锚点，不依赖 rAF", () => {
    act(() => {
      usePlayerStore.getState().applySnapshot({
        ...playingSnapshot(60_000),
        status: "paused",
      });
    });
    const { result } = renderHook(() => useInterpolatedPosition());
    expect(near(result.current, 60_000)).toBe(true);

    act(() => {
      usePlayerStore.setState({
        positionAnchorValue: 30_000,
        positionAnchorMs: performance.now(),
        positionMs: 30_000,
        state: { ...playingSnapshot(30_000), status: "paused" },
      });
    });
    expect(near(result.current, 30_000)).toBe(true);
  });
});
