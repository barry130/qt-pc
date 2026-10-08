// @vitest-environment jsdom
/**
 * 播放队列的拖动排序（用户 m04913：「播放列表的拖拽排序无反应」）。
 *
 * 原先用的是 HTML5 拖放（draggable / dragover / drop），在 Tauri + Windows 下被
 * 系统层的 OLE IDropTarget 压掉，事件根本不触发 —— 表象就是「拖了没反应」。
 * 现在改成 **pointer 事件自绘**（pointerdown/move/up + setPointerCapture），
 * 这里锁住三件事：
 *   1. 行上不再有 HTML5 拖放那套（draggable=false，且不再依赖 drop 事件）；
 *   2. 按下后位移越过阈值再抬手 ⇒ 提交 queueMove(from, to)，落点按坐标命中测试；
 *   3. 未越过阈值的按下（等同点击）不提交排序，切歌照旧（不被拖拽吃掉）。
 * 回归测试文件：tests/queue-panel-drag.test.tsx。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * jsdom 没有 PointerEvent（截至 jsdom 24 仍只实现了 MouseEvent），也没有
 * setPointerCapture。这里的用例只关心事件携带的坐标与 pointerId，故用 MouseEvent
 * 派生一个最小实现补上，再给元素补 setPointerCapture/releasePointerCapture 的空实现。
 */
if (typeof globalThis.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  (globalThis as unknown as { PointerEvent: unknown }).PointerEvent =
    PointerEventPolyfill;
}
if (typeof Element.prototype.setPointerCapture !== "function") {
  Element.prototype.setPointerCapture = function (): void {};
  Element.prototype.releasePointerCapture = function (): void {};
  Element.prototype.hasPointerCapture = function (): boolean {
    return false;
  };
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({})),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));

import * as ipc from "@/services/ipc";
import { QueuePanel } from "@/components/player/QueuePanel";
import { usePlayerStore } from "@/stores/player";

/** 队列里的假曲目：只要 id / title 不同即可，面板不校验其余字段 */
function track(id: string, title: string): {
  id: string;
  title: string;
  singer: string;
  album: string;
  platform: string;
  duration: number;
  picUrl: string;
} {
  return {
    id,
    title,
    singer: "singer",
    album: "album",
    platform: "wy",
    duration: 100,
    picUrl: "",
  };
}

const QUEUE = [track("a", "A"), track("b", "B"), track("c", "C")];

/** 行元素：面板里每行是 role=button，按曲名取 */
function row(title: string): HTMLElement {
  return screen.getByText(title).closest("[data-queue-index]") as HTMLElement;
}

/**
 * jsdom 没有布局，getBoundingClientRect 全 0、elementFromPoint 也不работает，
 * 所以命中测试的两个依赖都在这里打桩：给每行一个 20px 高的矩形（第 i 行占
 * [i*20, i*20+20)），并把坐标换算回行下标。
 */
function stubLayout(): void {
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    const el = this as HTMLElement;
    const raw = (el as HTMLElement & { dataset?: DOMStringMap }).dataset
      ?.queueIndex;
    if (raw === undefined) return { top: 0, bottom: 0, left: 0, right: 0 } as DOMRect;
    const i = Number(raw);
    return {
      top: i * 20,
      bottom: i * 20 + 20,
      left: 0,
      right: 320,
      height: 20,
      width: 320,
      x: 0,
      y: i * 20,
      toJSON: () => ({}),
    } as DOMRect;
  };
  document.elementFromPoint = ((_x: number, y: number) => {
    const i = Math.floor(y / 20);
    const found = document.querySelector(`[data-queue-index="${i}"]`);
    return i >= 0 && i < QUEUE.length ? found : null;
  }) as typeof document.elementFromPoint;
}

/** 一次完整的拖拽：按下 → 移到目标行 → 抬手 */
function drag(fromTitle: string, toY: number): void {
  const from = row(fromTitle);
  const startY = Number(from.dataset.queueIndex) * 20 + 10;
  from.setPointerCapture = vi.fn();
  from.releasePointerCapture = vi.fn();
  from.hasPointerCapture = () => true;

  const down = new PointerEvent("pointerdown", {
    bubbles: true,
    clientY: startY,
    clientX: 10,
    button: 0,
  });
  Object.defineProperty(down, "pointerId", { value: 1 });
  from.dispatchEvent(down);

  const move = new PointerEvent("pointermove", {
    bubbles: true,
    clientY: toY,
    clientX: 10,
  });
  Object.defineProperty(move, "pointerId", { value: 1 });
  from.dispatchEvent(move);

  const up = new PointerEvent("pointerup", {
    bubbles: true,
    clientY: toY,
    clientX: 10,
  });
  Object.defineProperty(up, "pointerId", { value: 1 });
  from.dispatchEvent(up);
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  stubLayout();
  usePlayerStore.setState({
    queue: QUEUE,
    queueIndex: 0,
    queueOpen: true,
    state: null,
  });
});

describe("播放队列：拖动排序（pointer 自绘，绕开 Tauri 的 OLE 拖放）", () => {
  it("行上不再挂 HTML5 拖放：draggable 关闭，且带 data-queue-index 供命中测试", () => {
    render(<QueuePanel />);
    const first = row("A");
    expect(first.getAttribute("draggable")).toBe("false");
    expect(first.dataset.queueIndex).toBe("0");
    expect(row("C").dataset.queueIndex).toBe("2");
  });

  it("拖到第 3 行：提交 queueMove(0, 2)", () => {
    const move = vi.spyOn(ipc, "queueMove");
    render(<QueuePanel />);

    drag("A", 2 * 20 + 10); // A（第 0 行）拖到 C（第 2 行）的位置

    expect(move).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledWith(0, 2);
  });

  it("位移不足阈值：不排序，也不吃点击", () => {
    const move = vi.spyOn(ipc, "queueMove");
    const playAt = vi.fn();
    usePlayerStore.setState({ playAt });
    render(<QueuePanel />);

    const from = row("A");
    from.setPointerCapture = vi.fn();
    from.releasePointerCapture = vi.fn();
    from.hasPointerCapture = () => true;
    const down = new PointerEvent("pointerdown", {
      bubbles: true,
      clientY: 10,
      clientX: 10,
      button: 0,
    });
    Object.defineProperty(down, "pointerId", { value: 1 });
    from.dispatchEvent(down);
    // 只挪 2px（阈值 4px）：仍算点击
    const up = new PointerEvent("pointerup", {
      bubbles: true,
      clientY: 12,
      clientX: 10,
    });
    Object.defineProperty(up, "pointerId", { value: 1 });
    from.dispatchEvent(up);
    from.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(move).not.toHaveBeenCalled();
    expect(playAt).toHaveBeenCalledWith(0);
  });

  it("拖完抬手后补发的 click 不再触发切歌", () => {
    const playAt = vi.fn();
    usePlayerStore.setState({ playAt });
    render(<QueuePanel />);

    drag("A", 2 * 20 + 10);
    row("A").dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(playAt).not.toHaveBeenCalled();
  });
});
