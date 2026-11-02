// @vitest-environment jsdom
/**
 * 用户 m19201：「当前播放歌曲太不清晰了」—— 队列面板（可能几百上千条）里
 * 正在播的那一行必须一眼可辨。锁住三件事：当前行带 aria-current、
 * 当前行有「正在播放」跳动条（与列表页曲目行同一套 EqBars）、暂停时跳条静止。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Track } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));

import { QueuePanel } from "@/components/player/QueuePanel";
import { usePlayerStore } from "@/stores/player";

const QUEUE: Track[] = ["A", "B", "C"].map((title) => ({
  id: title.toLowerCase(),
  platform: "wy",
  title,
  singer: "Singer",
  album: "Album",
  picUrl: "",
  duration: 100,
}));

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  usePlayerStore.setState({
    queue: QUEUE,
    queueIndex: 0,
    queueOpen: true,
    state: null,
    playAt: vi.fn(async () => {}),
  });
});

describe("播放队列面板：当前曲目要一眼看得出来", () => {
  it("正在播的那一行有跳动条，别的行没有", () => {
    usePlayerStore.setState({
      state: { status: "playing", trackId: "a" } as never,
    });
    render(<QueuePanel />);

    const markers = screen.getAllByLabelText("正在播放");
    expect(markers.length).toBe(1);
    // 播放中才动：三根竖条都挂 qt-eq-bar（暂停时只留静止高度）
    expect(markers[0].querySelectorAll(".qt-eq-bar").length).toBe(3);
    // 标记所在的那一行同时是 aria-current（读屏也认得出）
    expect(markers[0].closest("[aria-current='true']")).toBeTruthy();
  });

  it("暂停：标记还在（仍标识这一首），但跳条不动", () => {
    usePlayerStore.setState({
      state: { status: "paused", trackId: "a" } as never,
    });
    render(<QueuePanel />);

    const marker = screen.getByLabelText("正在播放");
    expect(marker.querySelectorAll(".qt-eq-bar").length).toBe(0);
  });

  it("切到下一首：标记跟着移动到新的一行", () => {
    usePlayerStore.setState({
      state: { status: "playing", trackId: "b" } as never,
      queueIndex: 1,
    });
    render(<QueuePanel />);

    const current = screen
      .getByLabelText("正在播放")
      .closest("[aria-current='true']");
    expect(current?.textContent).toContain("B");
    expect(screen.getAllByLabelText("正在播放").length).toBe(1);
  });

  it("队列里没有当前项（queueIndex 为空）：不画标记", () => {
    usePlayerStore.setState({ state: null, queueIndex: null });
    render(<QueuePanel />);
    expect(screen.queryByLabelText("正在播放")).toBeNull();
  });
});
