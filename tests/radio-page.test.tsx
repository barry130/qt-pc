// @vitest-environment jsdom
/**
 * 私人 FM 页面（A7，路由 /radio）。
 *
 * 这里不测选曲算法（纯函数另见 `tests/radio-queue.test.ts`），只测**接线**：
 * 按钮打到哪个 store 动作、当前曲目/接下来几首读的是不是播放器队列、
 * 口味切换有没有落回 store。store 都是真 zustand，只把动作替换成 spy ——
 * 这样断言的是"页面调用了这个动作"，而不是"页面长得像某个快照"。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Track } from "@/types";

vi.mock("@/components/layout/keepAliveActive", () => ({
  useKeepAliveActive: () => true,
}));

import { useRadioStore } from "@/stores/radio";
import { usePlayerStore } from "@/stores/player";
import { RadioPage } from "@/components/mine/RadioPage";

function track(id: string, title: string, singer: string): Track {
  return { id, platform: "local", title, singer, album: "专辑", picUrl: "", duration: 240 };
}

const now = track("a1", "正在放的歌", "歌手甲");
const next1 = track("a2", "下一首", "歌手乙");
const next2 = track("a3", "再下一首", "歌手丙");

beforeEach(() => {
  usePlayerStore.setState({ queue: [], queueIndex: null });
  useRadioStore.setState({
    active: false,
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
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    setTaste: vi.fn(),
    refill: vi.fn(async () => {}),
    dislike: vi.fn(async () => {}),
    ensure: vi.fn(async () => {}),
  });
});

describe("私人 FM 页面", () => {
  it("没开始时给空态与「开始收听」，点击调 start", () => {
    render(<RadioPage />);
    expect(screen.getByText("私人 FM 还没开始")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /开始收听/ }));
    expect(useRadioStore.getState().start).toHaveBeenCalledTimes(1);
  });

  it("播放中显示当前曲目与「接下来」的 5 首（读播放器队列）", () => {
    usePlayerStore.setState({ queue: [now, next1, next2], queueIndex: 0 });
    useRadioStore.setState({ active: true });
    render(<RadioPage />);
    expect(screen.getByTestId("radio-current").textContent).toContain("正在放的歌");
    const upcoming = screen.getByTestId("radio-upcoming").textContent ?? "";
    expect(upcoming).toContain("下一首");
    expect(upcoming).toContain("再下一首");
    // 当前曲目不在「接下来」里重复出现
    expect(upcoming).not.toContain("正在放的歌");
  });

  it("点「不喜欢」把当前曲目交给 store.dislike", () => {
    usePlayerStore.setState({ queue: [now, next1], queueIndex: 0 });
    useRadioStore.setState({ active: true });
    render(<RadioPage />);
    fireEvent.click(screen.getByRole("button", { name: /不喜欢/ }));
    expect(useRadioStore.getState().dislike).toHaveBeenCalledWith(now);
  });

  it("「换一批」调 refill，停止按钮调 stop", () => {
    usePlayerStore.setState({ queue: [now], queueIndex: 0 });
    useRadioStore.setState({ active: true });
    render(<RadioPage />);
    fireEvent.click(screen.getByRole("button", { name: /换一批/ }));
    expect(useRadioStore.getState().refill).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /停止 FM/ }));
    expect(useRadioStore.getState().stop).toHaveBeenCalledTimes(1);
  });

  it("口味分段器切换调 setTaste（三档都在）", () => {
    render(<RadioPage />);
    const group = screen.getByRole("radiogroup", { name: "推荐口味" });
    expect(group.textContent).toContain("心动");
    fireEvent.click(screen.getByRole("radio", { name: "探索" }));
    expect(useRadioStore.getState().setTaste).toHaveBeenCalledWith("explore");
  });

  it("错误与排空提示都会显示出来", () => {
    useRadioStore.setState({ active: true, error: "曲库里的歌都被筛掉了", exhausted: true });
    usePlayerStore.setState({ queue: [now], queueIndex: 0 });
    render(<RadioPage />);
    expect(screen.getByRole("alert").textContent).toContain("曲库里的歌都被筛掉了");
    expect(screen.getByText(/把曲库里能推的都排完了/)).toBeTruthy();
  });
});
