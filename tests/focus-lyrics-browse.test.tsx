// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FocusLyrics } from "@/components/player/FocusLyrics";
import type { LyricLine } from "@/lib/lrc";

const lines: LyricLine[] = Array.from({ length: 12 }, (_, i) => ({ timeMs: i * 1000, text: `歌词${i}` }));
const base = { lines, activeIndex: 4, positionMs: 4500, fontSize: 20, variant: "focus" as const };
const viewport = () => screen.getByRole("region", { name: "纯净歌词" });
const current = (index: number) => screen.getByRole("group", { name: `歌词${index}` });
const wheel = (deltaY: number) => fireEvent.wheel(viewport(), { deltaY });

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("纯净歌词三句视窗翻阅", () => {
  it("始终只呈现三句，滚轮可翻到首末句，翻阅不改变播放位置", () => {
    const seek = vi.fn();
    const { container } = render(<FocusLyrics {...base} onSeekMs={seek} />);
    expect(current(4)).toBeTruthy();
    expect(screen.getByText("歌词3")).toBeTruthy();
    expect(screen.getByText("歌词5")).toBeTruthy();
    expect(screen.queryByText("歌词0")).toBeNull();
    expect(container.querySelectorAll(".qt-focus-neighbor")).toHaveLength(2);
    for (let i = 0; i < 7; i += 1) wheel(-100);
    expect(current(0)).toBeTruthy();
    for (let i = 0; i < 15; i += 1) wheel(100);
    expect(current(11)).toBeTruthy();
    expect(screen.getByText("尾声")).toBeTruthy();
    expect(container.querySelectorAll(".qt-focus-current")).toHaveLength(1);
    expect(container.querySelectorAll(".qt-focus-neighbor button")).toHaveLength(1);
    expect(seek).not.toHaveBeenCalled();
  });

  it("手动翻阅期间保持视窗，每次继续翻阅均重新计算四秒恢复时间", () => {
    const view = render(<FocusLyrics {...base} onSeekMs={vi.fn()} />);
    wheel(100);
    expect(current(5)).toBeTruthy();
    act(() => vi.advanceTimersByTime(3000));
    wheel(100);
    expect(current(6)).toBeTruthy();
    view.rerender(<FocusLyrics {...base} activeIndex={8} positionMs={8500} onSeekMs={vi.fn()} />);
    act(() => vi.advanceTimersByTime(1001));
    expect(current(6)).toBeTruthy();
    act(() => vi.advanceTimersByTime(2999));
    expect(current(8)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "回到当前行" })).toBeNull();
  });

  it("回到当前行立即恢复原视窗，点选预览的中央句才跳播", () => {
    const seek = vi.fn();
    render(<FocusLyrics {...base} onSeekMs={seek} />);
    wheel(100);
    fireEvent.click(screen.getByRole("button", { name: "回到当前行" }));
    expect(current(4)).toBeTruthy();
    expect(seek).not.toHaveBeenCalled();
    wheel(100);
    fireEvent.click(screen.getByRole("button", { name: "跳到这一句：歌词5" }));
    expect(seek).toHaveBeenCalledExactlyOnceWith(5000);
    expect(screen.queryByRole("button", { name: "回到当前行" })).toBeNull();
  });

  it("触摸上下滑动翻词，松手后不继续处理旧手势", () => {
    render(<FocusLyrics {...base} onSeekMs={vi.fn()} />);
    fireEvent.touchStart(viewport(), { touches: [{ clientY: 200 }] });
    fireEvent.touchMove(viewport(), { touches: [{ clientY: 140 }] });
    expect(current(5)).toBeTruthy();
    fireEvent.touchMove(viewport(), { touches: [{ clientY: 200 }] });
    expect(current(4)).toBeTruthy();
    fireEvent.touchEnd(viewport());
    fireEvent.touchMove(viewport(), { touches: [{ clientY: 100 }] });
    expect(current(4)).toBeTruthy();
  });

  it("键盘上下翻词，Esc 回到播放句", () => {
    render(<FocusLyrics {...base} onSeekMs={vi.fn()} />);
    fireEvent.keyDown(viewport(), { key: "ArrowDown" });
    expect(current(5)).toBeTruthy();
    fireEvent.keyDown(viewport(), { key: "ArrowUp" });
    expect(current(4)).toBeTruthy();
    fireEvent.keyDown(viewport(), { key: "ArrowUp" });
    expect(current(3)).toBeTruthy();
    fireEvent.keyDown(viewport(), { key: "Escape" });
    expect(current(4)).toBeTruthy();
  });

  it("普通滚轮被视窗消费，避免外层页面跟着滚动", () => {
    const outerWheel = vi.fn();
    render(<div onWheel={outerWheel}><FocusLyrics {...base} onSeekMs={vi.fn()} /></div>);
    const event = new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
    act(() => { viewport().dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(outerWheel).not.toHaveBeenCalled();
    expect(current(5)).toBeTruthy();
  });

  it("触控板的小位移累积后翻句，横向手势与 Ctrl 缩放保持浏览器行为", () => {
    render(<FocusLyrics {...base} onSeekMs={vi.fn()} />);
    wheel(10);
    expect(current(4)).toBeTruthy();
    wheel(15);
    wheel(15);
    expect(current(5)).toBeTruthy();
    fireEvent.wheel(viewport(), { deltaY: 100, ctrlKey: true });
    fireEvent.wheel(viewport(), { deltaY: 20, deltaX: 200 });
    expect(current(5)).toBeTruthy();
    fireEvent.wheel(viewport(), { deltaY: -3, deltaMode: 1 });
    expect(current(4)).toBeTruthy();
  });

  it("更换歌词立即清除旧视窗内容，新歌仍能翻阅", () => {
    const view = render(<FocusLyrics {...base} onSeekMs={vi.fn()} />);
    wheel(100);
    view.rerender(<FocusLyrics {...base} lines={[{ timeMs: 0, text: "新歌开头" }, { timeMs: 1000, text: "新歌结尾" }]} activeIndex={0} onSeekMs={vi.fn()} />);
    expect(screen.getByRole("group", { name: "新歌开头" })).toBeTruthy();
    expect(screen.queryByText("歌词5")).toBeNull();
    expect(screen.queryByRole("button", { name: "回到当前行" })).toBeNull();
    wheel(100);
    expect(screen.getByRole("group", { name: "新歌结尾" })).toBeTruthy();
  });

  it("空歌词加载为单句后仍能处理手势和清理计时器", () => {
    const view = render(<FocusLyrics {...base} lines={[]} onSeekMs={vi.fn()} />);
    expect(screen.queryByRole("region")).toBeNull();
    view.rerender(<FocusLyrics {...base} lines={[{ timeMs: 0, text: "唯一一句" }]} activeIndex={0} onSeekMs={vi.fn()} />);
    wheel(100);
    expect(screen.getByRole("group", { name: "唯一一句" })).toBeTruthy();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
