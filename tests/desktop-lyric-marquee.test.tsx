// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MarqueeLine } from "@/components/lyric/MarqueeLine";

let notifyResize: () => void;
beforeEach(() => {
  document.documentElement.classList.remove("reduce-motion");
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { notifyResize = callback; }
    observe() {}
    disconnect() {}
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("desktop lyric marquee tail visibility", () => {
  it("keeps the final outlined character outside the fade after scrolling a padded line", () => {
    // jsdom has no layout: model a 300px line with 16px gutters and 600px text.
    // The readable width is 268px; scroll 332px plus the existing 16px fade.
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(600);
    render(<>
      <style>{".lyric-gutter { padding: 0 16px; }"}</style>
      <MarqueeLine
        text="风吹起思绪向远方 倾城烟霞芬芳"
        textStyle={{ fontSize: 36, WebkitTextStroke: "2px black" }}
        className="lyric-gutter"
        testid="line"
        marquee
        playing={false}
      />
    </>);
    const line = screen.getByTestId("line");
    const text = line.querySelector("span")!;
    expect(text.style.getPropertyValue("--mq-d")).toBe("348px");
    expect(text.style.transform).toBe("translateX(calc(var(--mq-d) * -1))");
    expect(line.textContent).toBe("风吹起思绪向远方 倾城烟霞芬芳");
  });

  it("scrolls when only the final half-character exceeds the content width", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(280);
    render(<>
      <style>{".lyric-gutter { padding: 0 16px; }"}</style>
      <MarqueeLine text="最后一个字" textStyle={{ fontSize: 36 }} className="lyric-gutter" marquee />
    </>);
    const text = screen.getByText("最后一个字");
    // 280px exceeds the actual 268px, even though it fits inside clientWidth.
    expect(text.style.animation).toContain("qt-marquee");
    expect(text.style.getPropertyValue("--mq-d")).toBe("28px");
  });

  it("stays still when text fits, then remeasures both gutters after a resize", () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(268);
    render(<>
      <style>{".lyric-gutter { padding: 0 16px; }"}</style>
      <MarqueeLine text="恰好放得下" textStyle={{ fontSize: 36 }} className="lyric-gutter" marquee />
    </>);
    const text = screen.getByText("恰好放得下");
    expect(text.style.animation).toBe("none");
    width.mockReturnValue(280);
    act(() => notifyResize());
    expect(text.style.animation).toContain("qt-marquee");
    expect(text.style.getPropertyValue("--mq-d")).toBe("36px");
    width.mockReturnValue(300);
    act(() => notifyResize());
    expect(text.style.animation).toBe("none");
  });

  it("preserves reduced-motion ellipsis instead of starting a marquee", () => {
    document.documentElement.classList.add("reduce-motion");
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(600);
    render(<MarqueeLine text="减弱动效" textStyle={{ fontSize: 36 }} marquee />);
    const text = screen.getByText("减弱动效");
    expect(text.style.textOverflow).toBe("ellipsis");
    expect(text.style.animation).toBe("");
  });
});
