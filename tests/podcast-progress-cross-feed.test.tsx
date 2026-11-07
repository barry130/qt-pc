// @vitest-environment jsdom
/**
 * C16 播客进度落库回归：正在播放的单集身份不能依赖「当前选中的订阅」。
 *
 * 旧实现用 `episodes` 现算 `audioUrl → episode` 映射。用户听着 A 的单集、点开 B
 * 看节目单时，`episodes` 已经换成 B 的列表，persist() 反查不到 A —— 播放进度与
 * ≥95% 的「已听完」标记整段丢失（KeepAlive 下页面还挂着，不会有卸载兜底）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  listPodcastShows: vi.fn(),
  addPodcastShow: vi.fn(),
  refreshPodcastShow: vi.fn(),
  removePodcastShow: vi.fn(),
  listPodcastEpisodes: vi.fn(),
  savePodcastProgress: vi.fn(async () => true),
  onPlaybackStateChanged: vi.fn<(handler: (state: PlaybackState) => void) => Promise<() => void>>(),
  onPositionChanged: vi.fn<(handler: (tick: PositionChanged) => void) => Promise<() => void>>(),
  onQueueChanged: vi.fn(),
  onAudioError: vi.fn(),
  getPlaybackState: vi.fn(),
  getQueue: vi.fn(),
}));

vi.mock("@/services/ipc", () => mocks);

import { usePlayerStore } from "@/stores/player";
import type { PlaybackState, PodcastEpisode, PodcastShow, PositionChanged, Track } from "@/types";
import { PodcastPage } from "@/components/podcast/PodcastPage";
import { usePlaybackEvents } from "@/hooks/usePlaybackEvents";

function PlaybackEventsHarness(): React.JSX.Element {
  usePlaybackEvents({ restoreSession: false });
  return <PodcastPage />;
}

function show(id: string, title: string): PodcastShow {
  return {
    id,
    url: `https://feed.test/${id}.xml`,
    title,
    author: "主播甲",
    description: "",
    image: "",
    lastFetchedAt: 0,
    episodeCount: 1,
  };
}

function episode(id: string, showId: string, title: string): PodcastEpisode {
  return {
    id,
    showId,
    title,
    description: "",
    audioUrl: `https://cdn.test/${id}.mp3`,
    durationMs: 3_723_000,
    publishedAt: Date.UTC(2025, 10, 1),
    played: false,
    positionMs: 0,
  };
}

const s1 = show("podcast:s1", "轻声漫谈");
const s2 = show("podcast:s2", "另一个播客");
const epA = episode("e1", s1.id, "A 的单集");
const epB = episode("e2", s2.id, "B 的单集");

const trackA: Track = {
  id: epA.audioUrl,
  platform: "podcast",
  title: epA.title,
  singer: "主播甲",
  album: s1.title,
  picUrl: "",
  duration: 3723,
};

/** 让播放器的「当前曲目」变成 A 的单集，并给出位置 / 状态 */
function setPlaying(positionMs: number, status: "playing" | "paused"): void {
  const state = usePlayerStore.getState().state;
  if (!state) throw new Error("播放器初始 state 缺失");
  usePlayerStore.getState().applySnapshot({
    ...state,
    track: trackA,
    trackId: trackA.id,
    sourceId: trackA.platform,
    status,
    positionMs,
    durationMs: epA.durationMs,
  });
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.listPodcastShows.mockResolvedValue([s1, s2]);
  mocks.listPodcastEpisodes.mockImplementation(async (id: string) =>
    id === s1.id ? [epA] : [epB],
  );
  mocks.savePodcastProgress.mockResolvedValue(true);
  usePlayerStore.setState(usePlayerStore.getInitialState());
  usePlayerStore.setState({
    queue: [],
    queueIndex: null,
    playQueue: async () => ({ applied: true, ticket: 0, target: null }),
  });
});

describe("C16 播客进度跨订阅保存", () => {
  it("切到别的订阅后，持续播放的 timer 保存最新 tick 进度并标记 ≥95%", async () => {
    usePlayerStore.setState({
      playQueue: async () => {
        setPlaying(0, "playing");
        return { applied: true, ticket: 0, target: null };
      },
    });
    // 只控制 interval：页面加载 / React cleanup 仍使用真实调度，不靠暂停触发保存。
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const view = render(<PodcastPage />);
    try {
      await screen.findByText("A 的单集");
      fireEvent.click(screen.getByRole("button", { name: "播放「A 的单集」" }));
      await waitFor(() => expect(usePlayerStore.getState().state?.track?.id).toBe(epA.audioUrl));
      fireEvent.click(screen.getByRole("button", { name: /^另一个播客/ }));
      await screen.findByText("B 的单集");
      expect(screen.queryByText("A 的单集")).toBeNull();
      mocks.savePodcastProgress.mockClear();

      await act(async () => {
        usePlayerStore.getState().applyTick({
          positionMs: 900_000,
          durationMs: 3_723_000,
          bufferedMs: 950_000,
          monotonicMs: 5_000,
        });
        vi.advanceTimersByTime(4_999);
      });
      expect(mocks.savePodcastProgress).not.toHaveBeenCalled();
      await act(async () => { vi.advanceTimersByTime(1); });
      expect(mocks.savePodcastProgress.mock.calls).toEqual([["e1", 900_000, false]]);

      await act(async () => {
        usePlayerStore.getState().applyTick({
          positionMs: 3_660_000,
          durationMs: 3_723_000,
          bufferedMs: 3_723_000,
          monotonicMs: 10_000,
        });
        vi.advanceTimersByTime(5_000);
      });
      expect(usePlayerStore.getState().state?.status).toBe("playing");
      expect(mocks.savePodcastProgress.mock.calls).toEqual([
        ["e1", 900_000, false],
        ["e1", 3_660_000, true],
      ]);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("切到别的订阅后，真实事件监听收到播完停止快照时保存 A 的终态进度和已听完标记", async () => {
    for (const subscribe of [mocks.onPlaybackStateChanged, mocks.onPositionChanged,
      mocks.onQueueChanged, mocks.onAudioError]) subscribe.mockResolvedValue(() => {});
    mocks.getPlaybackState.mockResolvedValue(usePlayerStore.getState().state);
    mocks.getQueue.mockResolvedValue({ tracks: [], index: null });
    usePlayerStore.setState({
      playQueue: async () => {
        const state = usePlayerStore.getState().state;
        if (!state) throw new Error("播放器初始 state 缺失");
        // 从真实 Hook 注册的 transport callback 接入，Hook / store / Page 均不替换。
        mocks.onPlaybackStateChanged.mock.calls[0][0]({
          ...state,
          track: trackA,
          trackId: trackA.id,
          sourceId: trackA.platform,
          status: "playing",
          positionMs: 0,
          durationMs: 3_723_000,
          sleepAfterTrack: true,
        });
        return { applied: true, ticket: 0, target: null };
      },
    });
    // 冻住 interval 且不推进：这一例的保存只能来自 stopped 状态事件，不来自 timer。
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const view = render(<PlaybackEventsHarness />);
    try {
      await screen.findByText("A 的单集");
      await waitFor(() => expect(mocks.getQueue).toHaveBeenCalledOnce());
      fireEvent.click(screen.getByRole("button", { name: "播放「A 的单集」" }));
      await waitFor(() => expect(usePlayerStore.getState().state?.status).toBe("playing"));
      fireEvent.click(screen.getByRole("button", { name: /^另一个播客/ }));
      await screen.findByText("B 的单集");
      expect(screen.queryByText("A 的单集")).toBeNull();
      mocks.savePodcastProgress.mockClear();

      await act(async () => {
        mocks.onPositionChanged.mock.calls[0][0]({
          positionMs: 3_660_000,
          durationMs: 3_723_000,
          bufferedMs: 3_723_000,
          monotonicMs: 10_000,
        });
      });
      expect(usePlayerStore.getState().positionMs).toBe(3_660_000);
      expect(usePlayerStore.getState().state?.status).toBe("playing");
      expect(mocks.savePodcastProgress).not.toHaveBeenCalled();

      const playing = usePlayerStore.getState().state;
      if (!playing) throw new Error("播放器在播 state 缺失");
      // 对齐 playback_commit.prepare_automatic 的 sleep_after_track 分支：
      // 保留 A 身份、Stopped、position=duration，并消费 sleep_after_track。
      // 手动 AudioCmd::Stop 会清身份/位置，不能拿它伪造这一终态；这里也未执行 Native EOF。
      await act(async () => {
        mocks.onPlaybackStateChanged.mock.calls[0][0]({
          ...playing,
          status: "stopped",
          positionMs: 3_723_000,
          sleepAfterTrack: false,
          sleepTimerMs: null,
        });
      });
      expect(usePlayerStore.getState().state?.status).toBe("stopped");
      expect(mocks.savePodcastProgress.mock.calls).toEqual([["e1", 3_723_000, true]]);
      expect(screen.getByText("B 的单集")).not.toBeNull();
      expect(screen.queryByText("A 的单集")).toBeNull();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("切到别的订阅后，正在播放那一集仍按真实进度落库（含已听完标记）", async () => {
    usePlayerStore.setState({
      playQueue: async () => {
        setPlaying(0, "playing");
        return { applied: true, ticket: 0, target: null };
      },
    });
    render(<PodcastPage />);
    await screen.findByText("A 的单集");
    fireEvent.click(screen.getByRole("button", { name: "播放「A 的单集」" }));
    await waitFor(() => expect(usePlayerStore.getState().state?.track?.id).toBe(epA.audioUrl));

    // 切到 B 订阅：右侧列表只剩 B 的单集，A 的单集已经不在 episodes 里
    fireEvent.click(screen.getByRole("button", { name: /^另一个播客/ }));
    await screen.findByText("B 的单集");
    expect(screen.queryByText("A 的单集")).toBeNull();

    // 播放状态从 playing → paused 时补写一次：进度必须还是 A 的
    setPlaying(900_000, "paused");
    await waitFor(() => expect(mocks.savePodcastProgress).toHaveBeenCalledWith("e1", 900_000, false));
    mocks.savePodcastProgress.mockClear();

    // 听到 ≥95% 后暂停：补一次「已听完」；paused 不是 EOF。
    await act(async () => {
      setPlaying(3_660_000, "playing");
    });
    mocks.savePodcastProgress.mockClear();
    await act(async () => {
      setPlaying(3_660_000, "paused");
    });
    await waitFor(() =>
      expect(mocks.savePodcastProgress).toHaveBeenCalledWith("e1", 3_660_000, true),
    );
  });
});
