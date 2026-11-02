// @vitest-environment jsdom
/**
 * 用户 m18755：「私人 FM 时将播放列表禁止打开」。
 * 面板本身不给开（播放条的队列按钮已置灰，见 tests/playerbar-radio.test.tsx），
 * 这里锁住兜底那半句：FM 接管时面板若正开着，自动收起来。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { Track } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));

import { QueuePanel } from "@/components/player/QueuePanel";
import { usePlayerStore } from "@/stores/player";
import { useRadioStore } from "@/stores/radio";

const QUEUE: Track[] = ["A", "B", "C"].map((title) => ({
  id: title.toLowerCase(),
  platform: "wy",
  title,
  singer: "Singer",
  album: "Album",
  picUrl: "",
  duration: 100,
}));

function setRadio(active: boolean): void {
  act(() => useRadioStore.setState({ active, queueClaimed: active }));
}

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
  useRadioStore.setState({ active: false, queueClaimed: false });
});

describe("播放队列面板：私人 FM 期间不给开", () => {
  it("平时：面板正常打开，是播放列表形态", () => {
    render(<QueuePanel />);
    expect(screen.getByText("播放队列（3）")).toBeTruthy();
    expect(screen.getByRole("button", { name: "清空队列" })).toBeTruthy();
  });

  it("FM 接管时面板正开着：自动收起（store 里也置回关闭）", () => {
    render(<QueuePanel />);
    expect(screen.getByText("播放队列（3）")).toBeTruthy();

    setRadio(true);

    expect(usePlayerStore.getState().queueOpen).toBe(false);
    expect(screen.queryByText("播放队列（3）")).toBeNull();
  });

  it("退出 FM 后再点开：恢复播放列表形态", () => {
    render(<QueuePanel />);
    setRadio(true);
    expect(usePlayerStore.getState().queueOpen).toBe(false);

    setRadio(false);
    act(() => usePlayerStore.setState({ queueOpen: true }));

    expect(screen.getByText("播放队列（3）")).toBeTruthy();
    expect(screen.getByRole("button", { name: "清空队列" })).toBeTruthy();
  });
});