// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LyricScroller } from "@/components/player/LyricScroller";
import type { LyricLine } from "@/lib/lrc";

const LINES: LyricLine[] = [
  { timeMs: 1_000, text: "第一句" },
  { timeMs: 12_000, text: "第二句", translation: "第二句译文" },
  { timeMs: 25_000, text: "第三句" },
  { timeMs: 40_000, text: "第四句" },
  { timeMs: 58_000, text: "第五句" },
];

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.isPrimary = init.isPrimary ?? true;
  }
}

let captured = new Map<Element, number>();
const capturePointer = vi.fn(function (this: Element, pointerId: number): void {
  captured.set(this, pointerId);
});
const releasePointer = vi.fn(function (this: Element, pointerId: number): void {
  if (captured.get(this) === pointerId) captured.delete(this);
});
const scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions): void {
  this.scrollTop = Math.max(0, Math.min(960, options.top ?? 0));
});

function isScroller(element: HTMLElement): boolean {
  return element.dataset.testid === "lyric-scroller";
}

function row(index: number): HTMLElement {
  return screen.getByTestId("lyric-scroller").querySelector<HTMLElement>(`[data-lyric-index="${index}"]`)!;
}

function pointer(element: HTMLElement, type: string, y: number, init: PointerEventInit = {}): Event {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: 100,
    clientY: y,
    button: 0,
    pointerId: 1,
    ...init,
  });
  fireEvent(element, event);
  return event;
}

beforeEach(() => {
  captured = new Map();
  vi.clearAllMocks();
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    disconnect(): void {}
  });
  // 布局使用真实 scrollTop 与不同 row 高度：不能只按固定行号/指针位置猜落点。
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
    return 120 + Number(this.dataset.lyricIndex ?? 0) * 60;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return isScroller(this) ? 240 : 40;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => 400);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => 1200);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
    top: 0, bottom: 240, left: 0, right: 416, width: 416, height: 240,
    x: 0, y: 0, toJSON: () => ({}),
  }));
  vi.stubGlobal("getSelection", () => ({ removeAllRanges: vi.fn() }));
  Object.defineProperties(HTMLElement.prototype, {
    scrollTo: { configurable: true, value: scrollTo },
    setPointerCapture: { configurable: true, value: capturePointer },
    releasePointerCapture: { configurable: true, value: releasePointer },
    hasPointerCapture: {
      configurable: true,
      value: function (this: Element, pointerId: number): boolean {
        return captured.get(this) === pointerId;
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("主播放歌词 pointer 拖动定位", () => {
  it("小于阈值仍是单行点击；捕获原始行并还原样式", () => {
    const seek = vi.fn();
    render(<LyricScroller lines={LINES} activeIndex={0} positionMs={1000} onSeekMs={seek} />);
    const container = screen.getByTestId("lyric-scroller");
    container.style.userSelect = "text";
    container.style.scrollBehavior = "smooth";

    pointer(row(1), "pointerdown", 100);
    expect(capturePointer).toHaveBeenCalledWith(1);
    expect(captured.get(row(1))).toBe(1);
    expect(container.style.userSelect).toBe("none");
    pointer(row(1), "pointermove", 107);
    expect(screen.queryByTestId("lyric-seek-preview")).toBeNull();
    pointer(row(1), "pointerup", 107);
    expect(seek).not.toHaveBeenCalled();
    fireEvent.click(row(1), { detail: 1 });

    expect(seek).toHaveBeenCalledExactlyOnceWith(12_000);
    expect(releasePointer).toHaveBeenCalledWith(1);
    expect(container.style.userSelect).toBe("text");
    expect(container.style.scrollBehavior).toBe("smooth");
  });

  it("向上拖动按视区中央选行，预览偏移后的时间；松开提交最后落点且只 seek 一次", () => {
    const seek = vi.fn();
    render(<LyricScroller lines={LINES} activeIndex={0} positionMs={1000} seekOffsetMs={2000} onSeekMs={seek} />);
    const container = screen.getByTestId("lyric-scroller");
    pointer(row(0), "pointerdown", 180);
    pointer(row(0), "pointermove", 60);

    expect(container.scrollTop).toBe(140);
    expect(row(2).dataset.seekTarget).toBe("true");
    expect(screen.getByRole("status").textContent).toContain("0:27");
    expect(screen.getByRole("status").textContent).toContain("松开定位");
    expect(seek).not.toHaveBeenCalled();
    // up 比最后一帧 move 再向上一行，必须提交第四句而不是旧目标第三句。
    pointer(row(0), "pointerup", 0);
    fireEvent.click(row(0), { detail: 1 });

    expect(seek).toHaveBeenCalledExactlyOnceWith(40_000);
    expect(screen.queryByTestId("lyric-seek-preview")).toBeNull();
    expect(captured.size).toBe(0);
    // 尾随 click 消费后，下一次正常单击照旧可用。
    fireEvent.click(row(4), { detail: 1 });
    expect(seek).toHaveBeenLastCalledWith(58_000);
    expect(seek).toHaveBeenCalledTimes(2);
  });

  it("目标按实际行高与偏移计算，跳过无时间戳行", () => {
    const seek = vi.fn();
    const lines = [LINES[0], { timeMs: -1, text: "无时间戳" }, LINES[2]];
    render(<LyricScroller lines={lines} activeIndex={0} positionMs={1000} onSeekMs={seek} />);
    // 模拟译文/换行使第三行变高：它的中心在 300，而非默认的 260。
    Object.defineProperties(row(2), {
      offsetTop: { configurable: true, value: 220 },
      clientHeight: { configurable: true, value: 160 },
    });
    pointer(row(0), "pointerdown", 180);
    pointer(row(0), "pointermove", 120); // 中央=200，最近的有时间戳行是第一句。
    expect(row(0).dataset.seekTarget).toBe("true");
    pointer(row(0), "pointermove", 20); // 中央=300，命中高行的实际中心。
    expect(row(2).dataset.seekTarget).toBe("true");
    pointer(row(0), "pointerup", 20);
    expect(seek).toHaveBeenCalledExactlyOnceWith(25_000);
  });

  it("按住期间暂停自动跟随，取消后恢复当前行跟随", () => {
    const seek = vi.fn();
    const view = render(<LyricScroller lines={LINES} activeIndex={0} positionMs={1000} onSeekMs={seek} />);
    pointer(row(0), "pointerdown", 180);
    pointer(row(0), "pointermove", 60);
    scrollTo.mockClear();
    view.rerender(<LyricScroller lines={LINES} activeIndex={4} positionMs={58_000} onSeekMs={seek} />);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(screen.getByTestId("lyric-scroller").scrollTop).toBe(140);

    pointer(row(0), "pointercancel", 60);
    expect(scrollTo).toHaveBeenCalledWith({ top: 260, behavior: "smooth" });
    expect(seek).not.toHaveBeenCalled();
    expect(screen.queryByTestId("lyric-seek-preview")).toBeNull();
  });

  it("按住但未超过阈值时也暂停跟随，松开后恢复最新行", () => {
    const seek = vi.fn();
    const view = render(<LyricScroller lines={LINES} activeIndex={0} positionMs={1000} onSeekMs={seek} />);
    pointer(row(0), "pointerdown", 180);
    scrollTo.mockClear();
    view.rerender(<LyricScroller lines={LINES} activeIndex={4} positionMs={58_000} onSeekMs={seek} />);
    expect(scrollTo).not.toHaveBeenCalled();
    pointer(row(0), "pointerup", 181);
    expect(scrollTo).toHaveBeenCalledWith({ top: 260, behavior: "smooth" });
    expect(seek).not.toHaveBeenCalled();
  });

  it.each(["pointercancel", "lostpointercapture", "Escape", "blur", "visibilitychange"])("%s 取消后抬手/尾随 click 不定位", (reason) => {
    const seek = vi.fn();
    render(<LyricScroller lines={LINES} activeIndex={0} positionMs={1000} onSeekMs={seek} />);
    pointer(row(0), "pointerdown", 180);
    pointer(row(0), "pointermove", 60);
    if (reason === "Escape") fireEvent.keyDown(window, { key: "Escape" });
    else if (reason === "blur") fireEvent.blur(window);
    else if (reason === "visibilitychange") {
      vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      fireEvent(document, new Event("visibilitychange"));
    } else pointer(row(0), reason, 60);
    pointer(row(0), "pointerup", 60);
    fireEvent.click(row(0), { detail: 1 });

    expect(seek).not.toHaveBeenCalled();
    expect(screen.queryByTestId("lyric-seek-preview")).toBeNull();
    expect(captured.size).toBe(0);
    expect(screen.getByTestId("lyric-scroller").style.userSelect).toBe("");
  });

  it("换曲 key 卸载释放 capture，新曲目不会收到旧 pointer 的 seek", () => {
    const seek = vi.fn();
    const view = render(<LyricScroller key="track:a" lines={LINES} activeIndex={0} positionMs={1000} onSeekMs={seek} />);
    const oldContainer = screen.getByTestId("lyric-scroller");
    const oldRow = row(0);
    pointer(oldRow, "pointerdown", 180);
    pointer(oldRow, "pointermove", 60);
    view.rerender(<LyricScroller key="track:b" lines={LINES} activeIndex={0} positionMs={1000} onSeekMs={seek} />);
    expect(captured.size).toBe(0);
    expect(oldContainer.style.userSelect).toBe("");
    pointer(oldRow, "pointerup", 60);
    pointer(row(0), "pointerup", 60);
    expect(seek).not.toHaveBeenCalled();
    expect(screen.queryByTestId("lyric-seek-preview")).toBeNull();
    view.unmount();
  });

  it("同曲手动换词取消在途定位", () => {
    const seek = vi.fn();
    const view = render(<LyricScroller lines={LINES} activeIndex={0} positionMs={1000} onSeekMs={seek} />);
    pointer(row(0), "pointerdown", 180);
    pointer(row(0), "pointermove", 60);
    view.rerender(<LyricScroller lines={[{ timeMs: 3000, text: "新歌词" }]} activeIndex={0} positionMs={1000} onSeekMs={seek} />);
    pointer(row(0), "pointerup", 60);
    fireEvent.click(row(0), { detail: 1 });
    expect(seek).not.toHaveBeenCalled();
    expect(captured.size).toBe(0);
    expect(screen.queryByTestId("lyric-seek-preview")).toBeNull();
  });

  it("忽略次要 pointer、右键、滚动条与横向拖动", () => {
    const seek = vi.fn();
    render(<LyricScroller lines={LINES} activeIndex={0} positionMs={1000} onSeekMs={seek} />);
    pointer(row(0), "pointerdown", 100, { button: 2 });
    pointer(row(0), "pointerdown", 100, { isPrimary: false });
    pointer(row(0), "pointerdown", 100, { clientX: 408 });
    expect(capturePointer).not.toHaveBeenCalled();
    pointer(row(0), "pointerdown", 180);
    pointer(row(0), "pointermove", 60, { pointerId: 2 });
    pointer(row(0), "pointerup", 60, { pointerId: 2 });
    expect(screen.queryByTestId("lyric-seek-preview")).toBeNull();
    expect(captured.size).toBe(1);
    pointer(row(0), "pointermove", 178, { clientX: 130 });
    pointer(row(0), "pointerup", 178, { clientX: 130 });
    fireEvent.click(row(0), { detail: 1 });
    expect(captured.size).toBe(0);
    expect(seek).not.toHaveBeenCalled();
  });

  it("拖到上下边界时夹紧滚动位置，仍可定位首尾行", () => {
    const seek = vi.fn();
    render(<LyricScroller lines={LINES} activeIndex={2} positionMs={25_000} onSeekMs={seek} />);
    pointer(row(2), "pointerdown", 100);
    pointer(row(2), "pointermove", -2000);
    expect(screen.getByTestId("lyric-scroller").scrollTop).toBe(960);
    pointer(row(2), "pointerup", -2000);
    expect(seek).toHaveBeenLastCalledWith(58_000);
    pointer(row(2), "pointerdown", 100);
    pointer(row(2), "pointermove", 2000);
    expect(screen.getByTestId("lyric-scroller").scrollTop).toBe(0);
    pointer(row(2), "pointerup", 2000);
    expect(seek).toHaveBeenLastCalledWith(1000);
  });

  it("拖动预选保持当前行逐字染色、翻译与罗马音", () => {
    const seek = vi.fn();
    const lines: LyricLine[] = [{
      timeMs: 1000,
      text: "你好",
      words: [
        { text: "你", startMs: 0, durationMs: 1000 },
        { text: "好", startMs: 1000, durationMs: 1000 },
      ],
      translation: "Hello",
      romanization: "ni hao",
    }, LINES[1], LINES[2]];
    // jsdom 不支持含 CSS var 的 linear-gradient，观察写入值验证词内半填充。
    const gradients = vi.spyOn(CSSStyleDeclaration.prototype, "backgroundImage", "set");
    const view = render(<LyricScroller lines={lines} activeIndex={0} positionMs={1500} onSeekMs={seek} />);
    expect(gradients).toHaveBeenCalledWith(expect.stringContaining("var(--lyric-highlight) 50%"));
    expect(gradients).toHaveBeenCalledWith(expect.stringContaining("var(--lyric-highlight) 0%"));
    pointer(row(0), "pointerdown", 180);
    pointer(row(0), "pointermove", 60);
    expect(row(2).dataset.seekTarget).toBe("true");
    expect(screen.getByText("Hello")).toBeTruthy();
    expect(screen.getByText("ni hao")).toBeTruthy();
    // 目标行只做定位预选，播放中的逐字填充仍跟随 positionMs 更新。
    gradients.mockClear();
    view.rerender(<LyricScroller lines={lines} activeIndex={0} positionMs={2500} onSeekMs={seek} />);
    expect(gradients).toHaveBeenCalledWith(expect.stringContaining("var(--lyric-highlight) 100%"));
    expect(gradients).toHaveBeenCalledWith(expect.stringContaining("var(--lyric-highlight) 50%"));
    pointer(row(0), "pointercancel", 60);
    expect(seek).not.toHaveBeenCalled();
  });

  it("普通滚轮保留默认浏览，Enter/Space 与辅助技术 click 仍可定位", () => {
    const seek = vi.fn();
    render(<LyricScroller lines={LINES} activeIndex={0} positionMs={1000} onSeekMs={seek} />);
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 });
    fireEvent(screen.getByTestId("lyric-scroller"), wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(screen.queryByTestId("lyric-seek-preview")).toBeNull();
    expect(seek).not.toHaveBeenCalled();
    fireEvent.keyDown(row(1), { key: "Enter" });
    fireEvent.keyDown(row(2), { key: " " });
    fireEvent.click(row(3), { detail: 0 });
    expect(seek.mock.calls).toEqual([[12_000], [25_000], [40_000]]);
  });
});
