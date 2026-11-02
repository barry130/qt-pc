// @vitest-environment jsdom
/**
 * 队列面板跟随界面语言（B6 第二轮，DESIGN R84）。
 *
 * 第一轮只翻了导航和播放条，队列面板还是硬中文；这次把面板的标题、
 * 空态、批量工具条、行内操作都改成词条。测试锁三件事：
 * 英文界面下面板是英文、切回中文立刻变中文、标题里的数量是插值出来的。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Track } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));

import { QueuePanel } from "@/components/player/QueuePanel";
import { usePlayerStore } from "@/stores/player";
import { useLocaleStore } from "@/lib/i18n";

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
  useLocaleStore.getState().setLocale("zh-CN");
  usePlayerStore.setState({
    queue: QUEUE,
    queueIndex: 0,
    queueOpen: true,
    state: null,
    playAt: vi.fn(async () => {}),
  });
});

describe("播放队列面板跟随语言", () => {
  it("英文界面：标题带数量、按钮是英文", () => {
    useLocaleStore.getState().setLocale("en-US");
    render(<QueuePanel />);
    expect(screen.getByText("Queue (3)")).toBeTruthy();
    expect(screen.getByLabelText("Close queue")).toBeTruthy();
    expect(screen.getByLabelText("Clear queue")).toBeTruthy();
    expect(screen.getByLabelText("Jump to current track")).toBeTruthy();
    expect(screen.queryByText("播放队列（3）")).toBeNull();
  });

  it("中文界面：还是原来的中文", () => {
    render(<QueuePanel />);
    expect(screen.getByText("播放队列（3）")).toBeTruthy();
    expect(screen.getByLabelText("关闭队列")).toBeTruthy();
    expect(screen.queryByText("Queue (3)")).toBeNull();
  });

  it("切换语言后不用重新打开面板，词条当场变", async () => {
    render(<QueuePanel />);
    expect(screen.getByText("播放队列（3）")).toBeTruthy();

    useLocaleStore.getState().setLocale("en-US");
    await waitFor(() => expect(screen.getByText("Queue (3)")).toBeTruthy());
    expect(screen.queryByText("播放队列（3）")).toBeNull();
  });

  it("空队列时的空态也跟着语言", () => {
    useLocaleStore.getState().setLocale("en-US");
    usePlayerStore.setState({ queue: [], queueIndex: null });
    render(<QueuePanel />);
    expect(screen.getByText("Queue is empty")).toBeTruthy();
  });
});
