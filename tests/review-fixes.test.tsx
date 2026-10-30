// @vitest-environment jsdom
/**
 * 2026-10-29 全库评审的修复回归（qt-pc）。
 *
 * 三条线：
 * 1) `isComposingEnter` —— 输入法选字上屏的回车不能被当成「执行」；
 * 2) `useFocusTrap` —— aria-modal 弹层的 Tab 循环 / Esc / 焦点还原；
 * 3) `LyricScroller` —— 滚轮上翻看词后不再被自动跟随拽回当前行。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";

import { isComposingEnter } from "@/lib/keyboard";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { LyricScroller } from "@/components/player/LyricScroller";
import type { LyricLine } from "@/lib/lrc";

beforeEach(() => {
  // jsdom 没实现 Element.scrollTo：歌词自动跟随一挂载就会调用，不补会直接抛
  Element.prototype.scrollTo = vi.fn();
});

afterEach(() => {
  cleanup();
});

describe("isComposingEnter", () => {
  it("输入法合成中的回车判为选字", () => {
    expect(isComposingEnter({ nativeEvent: { isComposing: true } })).toBe(true);
  });

  it("keyCode 229 也算输入法处理中", () => {
    expect(isComposingEnter({ nativeEvent: { isComposing: false }, keyCode: 229 })).toBe(true);
  });

  it("普通回车放行", () => {
    expect(isComposingEnter({ nativeEvent: { isComposing: false }, keyCode: 13 })).toBe(false);
    expect(isComposingEnter({})).toBe(false);
  });
});

function TrapHarness(props: { onClose: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const ref = useRef<HTMLDivElement | null>(null);
  useFocusTrap(ref, open, () => {
    props.onClose();
    setOpen(false);
  });
  return (
    <div>
      <button type="button">面板外</button>
      {open && (
        <div ref={ref} role="dialog" aria-modal="true" aria-label="测试弹层">
          <button type="button">第一个</button>
          <button type="button">最后一个</button>
        </div>
      )}
    </div>
  );
}

describe("useFocusTrap", () => {
  it("Esc 关闭弹层", () => {
    const onClose = vi.fn();
    render(<TrapHarness onClose={onClose} />);
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Tab 在弹层内部循环，不跑到背后的控件上", () => {
    render(<TrapHarness onClose={() => undefined} />);
    const dialog = screen.getByRole("dialog");
    const first = screen.getByRole("button", { name: "第一个" });
    const last = screen.getByRole("button", { name: "最后一个" });
    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});

const LINES: LyricLine[] = [
  { timeMs: 0, text: "第一行", translation: "" },
  { timeMs: 2000, text: "第二行", translation: "" },
  { timeMs: 4000, text: "第三行", translation: "" },
];

describe("LyricScroller 手动滚动暂停跟随", () => {
  it("滚轮一动就暂停自动跟随，并给出回到当前行的入口", () => {
    render(
      <LyricScroller lines={LINES} activeIndex={1} onSeekMs={() => undefined} positionMs={0} />,
    );
    expect(screen.queryByRole("button", { name: "回到当前行" })).toBeNull();
    fireEvent.wheel(screen.getByTestId("lyric-scroller"));
    const back = screen.getByRole("button", { name: "回到当前行" });
    fireEvent.click(back);
    expect(screen.queryByRole("button", { name: "回到当前行" })).toBeNull();
  });
});
