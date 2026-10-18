// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { PlaybackState, Track } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));

import * as ipc from "@/services/ipc";
import { QueuePanel } from "@/components/player/QueuePanel";
import { usePlayerStore } from "@/stores/player";
import { log } from "@/lib/logger";
import * as toast from "@/stores/toast";

const QUEUE: Track[] = ["A", "B", "C"].map((title) => ({
  id: title.toLowerCase(),
  platform: "wy",
  title,
  singer: "Singer",
  album: "Album",
  picUrl: "",
  duration: 100,
}));
const initialPlaybackState = usePlayerStore.getState().state as PlaybackState;

function row(title: string): HTMLElement {
  return screen.getByText(title).closest("[data-queue-index]") as HTMLElement;
}

function selectRow(title = "A"): void {
  fireEvent.click(screen.getByRole("button", { name: "批量管理" }));
  fireEvent.click(row(title));
}

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  usePlayerStore.setState({
    queue: QUEUE,
    queueIndex: 0,
    queueOpen: true,
    state: null,
    playAt: vi.fn(async () => {}),
  });
});

describe("播放队列：选择快照", () => {
  it.each([
    ["同长度重排", [QUEUE[1], QUEUE[0], QUEUE[2]]],
    ["同长度替换", [{ ...QUEUE[0], id: "other" }, QUEUE[1], QUEUE[2]]],
    ["同 ID 换源", [{ ...QUEUE[0], platform: "qq" }, QUEUE[1], QUEUE[2]]],
    ["队列缩短", [QUEUE[0], QUEUE[1]]],
  ])("%s 后清空旧下标，不删除新位置的曲目", (_name, queue) => {
    const remove = vi.spyOn(ipc, "queueRemoveIndices");
    render(<QueuePanel />);
    selectRow();
    expect(row("A").getAttribute("aria-pressed")).toBe("true");

    act(() => usePlayerStore.setState({ queue }));
    const button = screen.getByRole("button", { name: "删除已选（0）" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(remove).not.toHaveBeenCalled();
  });

  it("稳定身份与顺序的元数据刷新保留选择，并删除原行下标", async () => {
    const remove = vi.spyOn(ipc, "queueRemoveIndices").mockResolvedValue(undefined);
    render(<QueuePanel />);
    selectRow("B");

    act(() => usePlayerStore.setState({
      queue: QUEUE.map((track) => ({ ...track, singer: "Updated singer", picUrl: "updated" })),
    }));
    expect(row("B").getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "删除已选（1）" }));
    });
    expect(remove).toHaveBeenCalledWith([1]);
  });

  it("相同身份的重复条目遇到新队列快照时保守清空选择", () => {
    const duplicates = [QUEUE[0], { ...QUEUE[0], title: "A duplicate" }, QUEUE[2]];
    usePlayerStore.setState({ queue: duplicates });
    render(<QueuePanel />);
    selectRow("A duplicate");

    act(() => usePlayerStore.setState({ queue: [...duplicates] }));
    expect((screen.getByRole("button", { name: "删除已选（0）" }) as HTMLButtonElement).disabled).toBe(true);
    expect(row("A duplicate").getAttribute("aria-pressed")).toBe("false");
  });

  it("关闭后重新打开不会恢复旧选择", () => {
    render(<QueuePanel />);
    selectRow();
    act(() => usePlayerStore.setState({ queueOpen: false }));
    act(() => usePlayerStore.setState({ queueOpen: true }));
    fireEvent.click(screen.getByRole("button", { name: "批量管理" }));
    expect(screen.getByRole("button", { name: "删除已选（0）" })).toBeTruthy();
  });
});

describe("播放队列：键盘范围与按钮语义", () => {
  it.each(["Enter", " "])("行内按钮的 %s 不被父行拦截或触发播放", (key) => {
    const move = vi.spyOn(ipc, "queueMove");
    render(<QueuePanel />);
    const button = within(row("B")).getByRole("button", { name: "下一首播放" });
    button.focus();
    // dispatchEvent 返回 true 表示行没有 preventDefault，原生按钮可继续合成 click。
    expect(fireEvent.keyDown(button, { key })).toBe(true);
    fireEvent.click(button, { detail: 0 });
    expect(move).toHaveBeenCalledWith(1, 1);
    expect(usePlayerStore.getState().playAt).not.toHaveBeenCalled();
  });

  it.each(["Enter", " "])("聚焦行的 %s 仍播放该行", (key) => {
    render(<QueuePanel />);
    row("C").focus();
    expect(fireEvent.keyDown(row("C"), { key })).toBe(false);
    expect(usePlayerStore.getState().playAt).toHaveBeenCalledWith(2);
  });

  it.each(["ctrlKey", "metaKey"])("聚焦行的 %s+A 全选，Enter 切换选择，Escape 退出", (modifier) => {
    render(<QueuePanel />);
    row("B").focus();
    expect(fireEvent.keyDown(row("B"), { key: "a", [modifier]: true })).toBe(false);
    expect(screen.getByRole("button", { name: "删除已选（3）" })).toBeTruthy();
    fireEvent.keyDown(row("B"), { key: "Enter" });
    expect(screen.getByRole("button", { name: "删除已选（2）" })).toBeTruthy();
    expect(usePlayerStore.getState().playAt).not.toHaveBeenCalled();
    fireEvent.keyDown(row("B"), { key: "Escape" });
    expect(screen.getByRole("button", { name: "批量管理" })).toBeTruthy();
    expect(row("B").hasAttribute("aria-pressed")).toBe(false);
  });

  it("窗口和行内/页头按钮的快捷键不改变选择", () => {
    render(<QueuePanel />);
    const inner = within(row("A")).getByRole("button", { name: "从队列移除" });
    inner.focus();
    expect(fireEvent.keyDown(inner, { key: "a", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(window, { key: "a", metaKey: true })).toBe(true);
    expect(screen.queryByRole("button", { name: "删除已选（3）" })).toBeNull();

    selectRow();
    const header = screen.getByRole("button", { name: "全选" });
    header.focus();
    expect(fireEvent.keyDown(header, { key: "Escape" })).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("button", { name: "删除已选（1）" })).toBeTruthy();
  });
});

describe("播放队列：当前播放定位", () => {
  it.each([null, -1, 100, 1.5])("下标 %s 无效时按 platform + id 定位并滚动当前行", (queueIndex) => {
    const first = { ...QUEUE[0], id: "same", title: "Wrong platform", platform: "wy" };
    const current = { ...QUEUE[1], id: "same", title: "Current", platform: "qq" };
    usePlayerStore.setState({
      queue: [first, current, QUEUE[2]],
      queueIndex,
      state: { ...initialPlaybackState, trackId: "same", sourceId: "qq", track: current },
    });
    render(<QueuePanel />);
    expect(row("Wrong platform").hasAttribute("aria-current")).toBe(false);
    expect(row("Current").getAttribute("aria-current")).toBe("true");

    const currentRow = row("Current");
    const list = currentRow.parentElement as HTMLElement;
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue({ top: 100 } as DOMRect);
    vi.spyOn(currentRow, "getBoundingClientRect").mockReturnValue({ top: 300 } as DOMRect);
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 100 });
    Object.defineProperty(currentRow, "clientHeight", { configurable: true, value: 20 });
    list.scrollTop = 25;
    fireEvent.click(screen.getByRole("button", { name: "定位当前播放" }));
    expect(list.scrollTop).toBe(185);
    expect(usePlayerStore.getState().playAt).not.toHaveBeenCalled();
  });

  it("优先使用快照曲目的原平台，换源播放地址不改变队列身份", () => {
    const current = { ...QUEUE[1], id: "same", platform: "qq" };
    usePlayerStore.setState({
      queue: [{ ...QUEUE[0], id: "same" }, current],
      queueIndex: null,
      state: { ...initialPlaybackState, trackId: "same", sourceId: "wy", track: current },
    });
    render(<QueuePanel />);
    expect(row("B").getAttribute("aria-current")).toBe("true");
  });

  it("缺少冗余 track 时使用 sourceId，合法引擎下标仍优先", () => {
    usePlayerStore.setState({
      queueIndex: null,
      state: { ...initialPlaybackState, trackId: "b", sourceId: "wy", track: null },
    });
    render(<QueuePanel />);
    expect(row("B").getAttribute("aria-current")).toBe("true");
    act(() => usePlayerStore.setState({ queueIndex: 2 }));
    expect(row("C").getAttribute("aria-current")).toBe("true");
  });

  it("只有跨平台同 ID 时不高亮、禁用定位且不提供清空后续", () => {
    usePlayerStore.setState({
      queueIndex: 100,
      state: { ...initialPlaybackState, trackId: "a", sourceId: "qq", track: null },
    });
    render(<QueuePanel />);
    expect(document.querySelector("[aria-current]")).toBeNull();
    expect((screen.getByRole("button", { name: "定位当前播放" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "清空后续" })).toBeNull();
  });
});

describe("播放队列：下一首播放边界", () => {
  it.each([
    ["当前曲之前", 1, "A", ["B", "A", "C"]],
    ["当前曲之后", 0, "C", ["A", "C", "B"]],
    ["已经是下一首", 0, "B", ["A", "B", "C"]],
    ["当前曲本身", 1, "B", ["A", "B", "C"]],
    ["没有当前曲", null, "C", ["C", "A", "B"]],
    ["当前曲位于末尾", 2, "A", ["B", "C", "A"]],
  ] as const)("%s：按引擎移除后插入语义排到正确位置", (_name, queueIndex, title, expected) => {
    const backendQueue = [...QUEUE];
    const move = vi.spyOn(ipc, "queueMove").mockImplementation(async (from, to) => {
      const [track] = backendQueue.splice(from, 1);
      backendQueue.splice(to, 0, track);
    });
    usePlayerStore.setState({ queueIndex });
    render(<QueuePanel />);

    const button = within(row(title)).getByRole("button", { name: "下一首播放" }) as HTMLButtonElement;
    const current = queueIndex === null ? null : QUEUE[queueIndex];
    expect(button.disabled).toBe(current?.title === title);
    fireEvent.click(button);

    expect(backendQueue.map((track) => track.title)).toEqual(expected);
    expect(usePlayerStore.getState().playAt).not.toHaveBeenCalled();
    if (current?.title === title) {
      expect(move).not.toHaveBeenCalled();
    } else {
      expect(move).toHaveBeenCalledTimes(1);
      const nextIndex = current ? backendQueue.indexOf(current) + 1 : 0;
      expect(backendQueue[nextIndex].title).toBe(title);
    }
  });
});

describe("播放队列：行内错误反馈", () => {
  it.each([
    ["下一首播放", "queueMove", "下一首播放失败：offline"],
    ["从队列移除", "queueRemoveAt", "从队列移除失败：offline"],
  ] as const)("%s 的拒绝通过日志和 toast 反馈", async (label, method, message) => {
    vi.spyOn(ipc, method).mockRejectedValue(new Error("offline"));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const errorToast = vi.spyOn(toast, "toastError").mockImplementation(() => {});
    render(<QueuePanel />);
    await act(async () => {
      fireEvent.click(within(row("C")).getByRole("button", { name: label }));
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[queue]"), expect.any(Error));
    expect(errorToast).toHaveBeenCalledWith(message);
    expect(usePlayerStore.getState().playAt).not.toHaveBeenCalled();
  });
});
