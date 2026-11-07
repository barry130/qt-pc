// @vitest-environment jsdom
/**
 * 播客页面（B9，路由 /podcast）。
 *
 * 只测**接线**：订阅入口打到哪个命令、单集播放时交给播放器的 `Track` 长什么样
 * （平台必须是 `podcast`、`id` 必须是音频直链，否则引擎不会走播客分支）、
 * 未听完的单集起播后有没有 seek 回上次位置。RSS 解析本身在 Rust 侧单测里
 * （`src-tauri/src/podcast.rs` 的 7 个用例）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  listPodcastShows: vi.fn(),
  addPodcastShow: vi.fn(),
  refreshPodcastShow: vi.fn(),
  removePodcastShow: vi.fn(),
  listPodcastEpisodes: vi.fn(),
  savePodcastProgress: vi.fn(async () => true),
  podcastEpisodeAudio: vi.fn(),
}));

vi.mock("@/services/ipc", () => mocks);

import { usePlayerStore } from "@/stores/player";
import type { PodcastEpisode, PodcastShow, Track } from "@/types";
import { PodcastPage } from "@/components/podcast/PodcastPage";

function show(id: string, title: string, author = "主播甲"): PodcastShow {
  return {
    id,
    url: `https://feed.test/${id}.xml`,
    title,
    author,
    description: "一档慢慢聊的播客",
    image: "",
    lastFetchedAt: 0,
    episodeCount: 2,
  };
}

function episode(id: string, title: string, over: Partial<PodcastEpisode> = {}): PodcastEpisode {
  return {
    id,
    showId: "podcast:s1",
    title,
    description: "",
    audioUrl: `https://cdn.test/${id}.mp3`,
    durationMs: 3_723_000,
    publishedAt: Date.UTC(2025, 10, 1),
    played: false,
    positionMs: 0,
    ...over,
  };
}

const s1 = show("podcast:s1", "轻声漫谈");
const s2 = show("podcast:s2", "另一个播客", "主播乙");
const ep1 = episode("e1", "第 1 期：开场", { positionMs: 754_000 });
const ep2 = episode("e2", "第 2 期：慢下来", { played: true, positionMs: 3_700_000 });

/** 让播放器的「当前曲目」变成刚被播放的那条 */
function simulatePlaying(track: Track, status: "playing" | "paused" = "playing"): void {
  const state = usePlayerStore.getState().state;
  if (!state) throw new Error("播放器初始 state 缺失");
  usePlayerStore.setState({ state: { ...state, track, status, positionMs: 0 } });
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.listPodcastShows.mockResolvedValue([s1, s2]);
  mocks.listPodcastEpisodes.mockResolvedValue([ep1, ep2]);
  mocks.removePodcastShow.mockResolvedValue(1);
  mocks.addPodcastShow.mockResolvedValue(s1);
  mocks.refreshPodcastShow.mockResolvedValue(s1);
  usePlayerStore.setState({ queue: [], queueIndex: null });
});

describe("播客页面", () => {
  it("挂载后列出订阅并自动打开第一个（拉它的单集）", async () => {
    render(<PodcastPage />);
    // 标题同时出现在左侧订阅列表与右侧详情头，按 heading 定位详情头
    expect(await screen.findByRole("heading", { name: "轻声漫谈" })).toBeTruthy();
    expect(screen.getByText("另一个播客")).toBeTruthy();
    await waitFor(() => expect(mocks.listPodcastEpisodes).toHaveBeenCalledWith("podcast:s1"));
    expect(await screen.findByText("第 1 期：开场")).toBeTruthy();
    // 未听完的显示续播位置，听完的显示已听完
    expect(screen.getByText(/继续播放 12:34/)).toBeTruthy();
    expect(screen.getByText(/已听完/)).toBeTruthy();
  });

  it("粘贴地址订阅：交给后端拉取，成功后提示并选中新订阅", async () => {
    render(<PodcastPage />);
    await screen.findByRole("heading", { name: "轻声漫谈" });

    fireEvent.change(screen.getByLabelText("播客订阅地址"), {
      target: { value: " https://feed.test/new.xml " },
    });
    fireEvent.click(screen.getByRole("button", { name: "订阅" }));

    await waitFor(() =>
      expect(mocks.addPodcastShow).toHaveBeenCalledWith("https://feed.test/new.xml"),
    );
    expect((await screen.findByRole("status")).textContent).toContain("已订阅「轻声漫谈」");
  });

  it("订阅失败时把后端原因原样显示出来", async () => {
    mocks.addPodcastShow.mockRejectedValue("这个地址不像是播客订阅源（没找到频道标题）");
    render(<PodcastPage />);
    await screen.findByRole("heading", { name: "轻声漫谈" });

    fireEvent.change(screen.getByLabelText("播客订阅地址"), {
      target: { value: "https://feed.test/bad.xml" },
    });
    fireEvent.click(screen.getByRole("button", { name: "订阅" }));

    expect((await screen.findByRole("alert")).textContent).toContain("没找到频道标题");
  });

  it("点单集播放：交给播放器的 Track 用音频直链当 id、平台是 podcast", async () => {
    const playQueue = vi.fn(async () => ({ applied: true, ticket: 0, target: null }));
    usePlayerStore.setState({ playQueue });
    render(<PodcastPage />);
    await screen.findByText("第 1 期：开场");

    fireEvent.click(screen.getByRole("button", { name: "播放「第 1 期：开场」" }));

    await waitFor(() => expect(playQueue).toHaveBeenCalledTimes(1));
    const [tracks, index] = playQueue.mock.calls[0] as unknown as [Track[], number];
    expect(index).toBe(0);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      id: "https://cdn.test/e1.mp3",
      platform: "podcast",
      title: "第 1 期：开场",
      singer: "主播甲",
      album: "轻声漫谈",
      duration: 3723,
    });
  });

  it("未听完的单集起播后 seek 回上次位置", async () => {
    const seekTo = vi.fn(async () => true);
    const track: Track = {
      id: ep1.audioUrl,
      platform: "podcast",
      title: ep1.title,
      singer: "主播甲",
      album: "轻声漫谈",
      picUrl: "",
      duration: 3723,
    };
    usePlayerStore.setState({
      playQueue: async () => {
        simulatePlaying(track);
        return { applied: true, ticket: 0, target: null };
      },
      seekTo,
    });

    render(<PodcastPage />);
    await screen.findByText("第 1 期：开场");
    fireEvent.click(screen.getByRole("button", { name: "播放「第 1 期：开场」" }));

    await waitFor(() => expect(seekTo).toHaveBeenCalledWith(754_000));
  });

  it("已听完的单集重听从头开始（不 seek）", async () => {
    const seekTo = vi.fn(async () => true);
    const track: Track = {
      id: ep2.audioUrl,
      platform: "podcast",
      title: ep2.title,
      singer: "主播甲",
      album: "轻声漫谈",
      picUrl: "",
      duration: 3723,
    };
    usePlayerStore.setState({
      playQueue: async () => {
        simulatePlaying(track);
        return { applied: true, ticket: 0, target: null };
      },
      seekTo,
    });

    render(<PodcastPage />);
    await screen.findByText("第 2 期：慢下来");
    fireEvent.click(screen.getByRole("button", { name: "播放「第 2 期：慢下来」" }));

    await waitFor(() => expect(usePlayerStore.getState().state?.track?.id).toBe(ep2.audioUrl));
    expect(seekTo).not.toHaveBeenCalled();
  });

  it("取消订阅：调删除命令并重新拉列表", async () => {
    mocks.listPodcastShows.mockResolvedValueOnce([s1, s2]).mockResolvedValue([s2]);
    render(<PodcastPage />);
    await screen.findByRole("heading", { name: "轻声漫谈" });

    fireEvent.click(screen.getByRole("button", { name: "取消订阅「轻声漫谈」" }));

    await waitFor(() => expect(mocks.removePodcastShow).toHaveBeenCalledWith("podcast:s1"));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "轻声漫谈" })).toBeNull(),
    );
  });
});
