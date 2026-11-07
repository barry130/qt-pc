// @vitest-environment jsdom
//
// C03 启动恢复：主窗口启动时会拉一次 restoreLastSession（可能慢）。等待期间，
// 纯原生媒体键 / 引擎自动切歌会推来 live 快照 —— 这条路径完全不经过 JS 的
// playActionSeq，所以「JS 代次没变」不代表恢复响应还新鲜。恢复是 fallback：
// 只要期间已经收到过任何 live 快照/事件，迟到的旧恢复快照就不许覆盖它
//（不能只比 track id：A→B→A 时 id 会相同，但 B 之后的实时状态才是真值）。
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  onPlaybackStateChanged: vi.fn(),
  onPositionChanged: vi.fn(),
  onQueueChanged: vi.fn(),
  onAudioError: vi.fn(),
  restoreLastSession: vi.fn(),
  getPlaybackState: vi.fn(),
  getQueue: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@/services/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ipc")>();
  return {
    ...actual,
    onPlaybackStateChanged: mocks.onPlaybackStateChanged,
    onPositionChanged: mocks.onPositionChanged,
    onQueueChanged: mocks.onQueueChanged,
    onAudioError: mocks.onAudioError,
    restoreLastSession: mocks.restoreLastSession,
    getPlaybackState: mocks.getPlaybackState,
    getQueue: mocks.getQueue,
  };
});

import { usePlaybackEvents } from "@/hooks/usePlaybackEvents";
import { usePlayerStore } from "@/stores/player";
import type { PlaybackState, Track } from "@/types";

function track(id: string): Track {
  return {
    id,
    platform: "local",
    title: `歌曲 ${id}`,
    singer: "歌手",
    album: "专辑",
    picUrl: "",
    duration: 240,
  };
}

function snapshot(t: Track, positionMs: number): PlaybackState {
  return {
    trackId: t.id,
    sourceId: t.platform,
    status: "playing",
    positionMs,
    durationMs: 240_000,
    bufferedMs: 0,
    volume: 0.8,
    muted: false,
    playMode: "listLoop",
    quality: "320",
    queueIndex: 0,
    queueLen: 1,
    isLocal: true,
    urlFetchedAt: null,
    playUrl: null,
    error: null,
    sleepTimerMs: null,
    track: t,
    outputDevice: "",
    bitrateKbps: null,
    sleepAfterTrack: false,
    speed: 1,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  for (const subscribe of [
    mocks.onPlaybackStateChanged,
    mocks.onPositionChanged,
    mocks.onQueueChanged,
    mocks.onAudioError,
  ]) {
    subscribe.mockResolvedValue(vi.fn());
  }
  mocks.getQueue.mockResolvedValue({ tracks: [], index: null });
  usePlayerStore.setState({
    state: null,
    positionMs: 0,
    durationMs: 0,
    bufferedMs: 0,
    queue: [],
    queueIndex: null,
    pendingSeekMs: null,
    pendingSeekAt: 0,
    positionAnchorMs: 0,
    positionAnchorValue: 0,
    isDraggingProgress: false,
  });
});

describe("C03 启动恢复与原生 live 快照", () => {
  it("恢复请求在途时收到纯原生 live 快照，迟到的旧恢复快照不得覆盖", async () => {
    const restore = deferred<PlaybackState | null>();
    mocks.restoreLastSession.mockReturnValue(restore.promise);

    const { unmount } = renderHook(() => usePlaybackEvents());
    await waitFor(() => expect(mocks.restoreLastSession).toHaveBeenCalled());

    // 纯原生路径：SMTC / 热键 / 自动下一首，JS 的 playActionSeq 完全没动。
    const liveB = snapshot(track("b"), 7_000);
    act(() => {
      usePlayerStore.getState().applySnapshot(liveB);
    });

    // 恢复请求这时才带着「上一个会话」的旧快照返回。
    await act(async () => {
      restore.resolve(snapshot(track("a"), 1_000));
    });
    await waitFor(() => expect(mocks.getQueue).toHaveBeenCalled());

    const state = usePlayerStore.getState();
    expect(state.state?.trackId).toBe("b");
    expect(state.state?.positionMs).toBe(7_000);
    expect(state.positionMs).toBe(7_000);
    unmount();
  });
});
