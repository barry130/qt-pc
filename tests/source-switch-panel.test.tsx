// @vitest-environment jsdom
/**
 * 换源面板（SourceSwitchPanel）不重复搜索。
 *
 * 回归起因：面板的 effect 曾把 `track` 对象本身当依赖，而播放心跳每次快照都会
 * 造出一个字段全等的新 track 对象 —— effect 无限重跑，界面上就是「正在搜索…」
 * 与结果列表交替闪（同一首歌被反复聚合搜索）。现在依赖必须是稳定 key。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const searchAllBatches = vi.hoisted(() => vi.fn(async () => []));
vi.mock("@/source-scripts", () => ({ searchAllBatches }));

import { SourceSwitchPanel } from "@/components/player/SourceSwitchPanel";
import { clearSourceSwitchCache } from "@/lib/source-switch";
import type { Track } from "@/types";

function track(id = "1"): Track {
  return {
    id,
    platform: "qq",
    title: "稻香",
    singer: "周杰伦",
    album: "",
    picUrl: "",
    duration: 0,
    musicId: null,
  };
}

describe("换源面板：同一首歌只搜一次", () => {
  beforeEach(() => {
    searchAllBatches.mockClear();
    clearSourceSwitchCache(); // 缓存是模块级单例，测试间必须隔离
  });
  afterEach(() => {
    cleanup(); // 不清理的话上一个用例的弹层还在，getByText 会撞到多个「重新搜索」
  });

  it("track 换成字段全等的新对象时不重新搜索", async () => {
    const t1 = track();
    const { rerender } = render(<SourceSwitchPanel track={t1} onPick={() => {}} />);
    await waitFor(() => expect(searchAllBatches.mock.calls.length).toBe(1));
    // 心跳快照：字段一致但引用不同
    rerender(<SourceSwitchPanel track={{ ...t1 }} onPick={() => {}} />);
    rerender(<SourceSwitchPanel track={{ ...t1 }} onPick={() => {}} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(searchAllBatches.mock.calls.length).toBe(1);
  });

  it("真的换歌（platform:id 变了）才重新搜索", async () => {
    const { rerender } = render(<SourceSwitchPanel track={track("1")} onPick={() => {}} />);
    await waitFor(() => expect(searchAllBatches.mock.calls.length).toBe(1));
    rerender(<SourceSwitchPanel track={track("2")} onPick={() => {}} />);
    await waitFor(() => expect(searchAllBatches.mock.calls.length).toBe(2));
  });

  // 缓存是进程内的，所以「重新挂载」就是用户关掉弹层再打开的真实路径
  it("关掉再打开同一个弹层直接用缓存，不再搜索", async () => {
    const t1 = track();
    const first = render(<SourceSwitchPanel track={t1} onPick={() => {}} />);
    await waitFor(() => expect(searchAllBatches.mock.calls.length).toBe(1));
    first.unmount();

    const second = render(<SourceSwitchPanel track={{ ...t1 }} onPick={() => {}} />);
    // 同步命中缓存：不该出现「正在搜索其他音源…」
    expect(second.container.textContent).not.toContain("正在搜索其他音源");
    await new Promise((r) => setTimeout(r, 20));
    expect(searchAllBatches.mock.calls.length).toBe(1);
  });

  it("点「重新搜索」才真正重跑一次", async () => {
    searchAllBatches.mockImplementation(async () => []);
    const { container, getByText } = render(
      <SourceSwitchPanel track={track()} onPick={() => {}} />,
    );
    await waitFor(() => expect(searchAllBatches.mock.calls.length).toBe(1));
    fireEvent.click(getByText("重新搜索"));
    await waitFor(() => expect(searchAllBatches.mock.calls.length).toBe(2));
    expect(container.textContent).toContain("其他音源没有找到匹配的歌曲");
  });
});
