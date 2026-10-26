// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackState, QueueChanged } from "@/types";

const mocks = vi.hoisted(() => ({
  applySnapshot: vi.fn(), applyTick: vi.fn(), applyQueue: vi.fn(),
  onPlaybackStateChanged: vi.fn(), onPositionChanged: vi.fn(),
  onQueueChanged: vi.fn(), onAudioError: vi.fn(),
  restoreLastSession: vi.fn(), getPlaybackState: vi.fn(), getQueue: vi.fn(),
}));
vi.mock("@/services/ipc", () => mocks);
vi.mock("@/stores/player", () => ({
  usePlayerStore: (select: (state: typeof mocks) => unknown) => select(mocks),
}));
vi.mock("@/lib/logger", () => ({ log: { warn: vi.fn(), error: vi.fn() } }));
import { usePlaybackEvents } from "@/hooks/usePlaybackEvents";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  for (const subscribe of [mocks.onPlaybackStateChanged, mocks.onPositionChanged,
    mocks.onQueueChanged, mocks.onAudioError]) subscribe.mockResolvedValue(vi.fn());
});

describe("附属播放窗口的实时同步", () => {
  it("打开时加载实时状态及完整队列，不调用启动会话恢复", async () => {
    const state = { trackId: "current", positionMs: 42000 } as PlaybackState;
    const queue: QueueChanged = { tracks: [], index: null };
    mocks.getPlaybackState.mockResolvedValue(state);
    mocks.getQueue.mockResolvedValue(queue);
    const { unmount } = renderHook(() => usePlaybackEvents({ restoreSession: false }));
    await waitFor(() => expect(mocks.applyQueue).toHaveBeenCalledWith(queue));
    expect(mocks.restoreLastSession).not.toHaveBeenCalled();
    expect(mocks.applySnapshot).toHaveBeenCalledWith(state);
    unmount();
  });

  it("快照请求在途时收到切歌或换队列事件，迟到的旧快照不得覆盖它", async () => {
    const stateRequest = deferred<PlaybackState>();
    const queueRequest = deferred<QueueChanged>();
    mocks.getPlaybackState.mockReturnValue(stateRequest.promise);
    mocks.getQueue.mockReturnValue(queueRequest.promise);
    const { unmount } = renderHook(() => usePlaybackEvents({ restoreSession: false }));
    await waitFor(() => expect(mocks.getPlaybackState).toHaveBeenCalled());
    const liveState = { trackId: "new" } as PlaybackState;
    act(() => { mocks.onPlaybackStateChanged.mock.calls[0][0](liveState); });
    await act(async () => { stateRequest.resolve({ trackId: "old" } as PlaybackState); });
    await waitFor(() => expect(mocks.getQueue).toHaveBeenCalled());
    const liveQueue: QueueChanged = { tracks: [], index: 3 };
    act(() => { mocks.onQueueChanged.mock.calls[0][0](liveQueue); });
    await act(async () => { queueRequest.resolve({ tracks: [], index: 0 }); });
    expect(mocks.applySnapshot.mock.calls).toEqual([[liveState]]);
    expect(mocks.applyQueue.mock.calls).toEqual([[liveQueue]]);
    unmount();
  });

  it("监听注册未完成时卸载，迟到的监听也会注销且不触发状态读取", async () => {
    const registration = deferred<() => void>();
    const unlisten = vi.fn();
    const lateUnlisten = vi.fn();
    mocks.onPlaybackStateChanged.mockReturnValue(registration.promise);
    // 其余三个监听立刻完成，用来验证「迟到的那个」被注销、已注册的也被注销。
    mocks.onPositionChanged.mockResolvedValue(lateUnlisten);
    const { unmount } = renderHook(() => usePlaybackEvents({ restoreSession: false }));
    unmount();
    await act(async () => { registration.resolve(unlisten); });
    expect(unlisten).toHaveBeenCalledOnce();
    expect(lateUnlisten).toHaveBeenCalledOnce();
    expect(mocks.getPlaybackState).not.toHaveBeenCalled();
    expect(mocks.restoreLastSession).not.toHaveBeenCalled();
  });
});
