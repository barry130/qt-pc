// @vitest-environment jsdom
/**
 * 播放页歌词字号（用户 m03582：歌词页能不能加个字号调大调小）。
 *
 * 两条线：
 * 1) `useLyricFontSize` —— 读库、clamp、步进、复位、去抖落库；
 * 2) `LyricScroller` 的渲染契约 —— 高亮行/非高亮行/译文/罗马音按 1 : 0.8 : 0.7 : 0.6
 *    等比缩放，且用 rem 而不是 px（外观里的全局字体缩放要继续生效）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const getSetting = vi.hoisted(() => vi.fn(async (_key: string): Promise<string | null> => null));
const setSetting = vi.hoisted(() => vi.fn(async (_key: string, _value: string) => undefined));
vi.mock("@/services/ipc", () => ({ getSetting, setSetting }));

import {
  clampLyricFontSize,
  LYRIC_FONT_SIZE_DEFAULT,
  LYRIC_FONT_SIZE_MAX,
  LYRIC_FONT_SIZE_MIN,
  LYRIC_FONT_SIZE_STEP,
  useLyricFontSize,
} from "@/hooks/useLyricFontSize";
import { LyricScroller } from "@/components/player/LyricScroller";
import type { LyricLine } from "@/lib/lrc";

type Api = ReturnType<typeof useLyricFontSize>;

function Harness(props: { onReady: (api: Api) => void }): React.JSX.Element {
  const api = useLyricFontSize();
  props.onReady(api);
  return <span data-testid="px">{api.px}</span>;
}

async function mountHarness(): Promise<{ current: Api }> {
  const ref: { current: Api } = { current: null as unknown as Api };
  render(<Harness onReady={(api) => { ref.current = api; }} />);
  return ref;
}

// jsdom 没有 Element.scrollTo（歌词自动居中会调它），补一个空实现
beforeEach(() => {
  Element.prototype.scrollTo = (() => undefined) as unknown as typeof Element.prototype.scrollTo;
  getSetting.mockClear();
  setSetting.mockClear();
  getSetting.mockResolvedValue(null);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("clampLyricFontSize", () => {
  it("夹到 14–40 并吸附到 2px 步长", () => {
    expect(clampLyricFontSize(9)).toBe(LYRIC_FONT_SIZE_MIN);
    expect(clampLyricFontSize(999)).toBe(LYRIC_FONT_SIZE_MAX);
    expect(clampLyricFontSize(20.4)).toBe(20);
    expect(clampLyricFontSize(21)).toBe(22); // 21 落在 20/22 正中间，向下取整到步长后进位
    expect(clampLyricFontSize(23)).toBe(24);
    expect(clampLyricFontSize(Number.NaN)).toBe(LYRIC_FONT_SIZE_DEFAULT);
  });
});

describe("useLyricFontSize", () => {
  it("库里没值时用默认 20，读到值后按库里的来", async () => {
    const ref = await mountHarness();
    await act(async () => { await Promise.resolve(); });
    expect(ref.current.px).toBe(LYRIC_FONT_SIZE_DEFAULT);
    expect(ref.current.loaded).toBe(true);

    cleanup();
    getSetting.mockResolvedValue("32");
    const ref2 = await mountHarness();
    await act(async () => { await Promise.resolve(); });
    expect(ref2.current.px).toBe(32);
  });

  it("bump 走步长、到边界停住，reset 回默认", async () => {
    const ref = await mountHarness();
    act(() => ref.current.bump(LYRIC_FONT_SIZE_STEP));
    expect(ref.current.px).toBe(22);
    act(() => ref.current.bump(1_000));
    expect(ref.current.px).toBe(LYRIC_FONT_SIZE_MAX);
    act(() => ref.current.bump(-1_000));
    expect(ref.current.px).toBe(LYRIC_FONT_SIZE_MIN);
    act(() => ref.current.reset());
    expect(ref.current.px).toBe(LYRIC_FONT_SIZE_DEFAULT);
  });

  it("去抖 200ms 后才落库，且只写最后一次的值", async () => {
    const ref = await mountHarness();
    act(() => {
      ref.current.bump(LYRIC_FONT_SIZE_STEP);
      ref.current.bump(LYRIC_FONT_SIZE_STEP);
      ref.current.bump(LYRIC_FONT_SIZE_STEP);
    });
    expect(ref.current.px).toBe(26);
    expect(setSetting).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(setSetting).toHaveBeenCalledTimes(1);
    expect(setSetting).toHaveBeenCalledWith("lyric.fontSize", "26");
  });

  it("读库回来的旧值不会盖掉用户已经点过的值", async () => {
    let resolveRead: ((v: string | null) => void) | null = null;
    getSetting.mockImplementation(() => new Promise((resolve) => { resolveRead = resolve; }));
    const ref = await mountHarness();
    act(() => ref.current.bump(LYRIC_FONT_SIZE_STEP));
    expect(ref.current.px).toBe(22);
    await act(async () => {
      resolveRead?.("36");
      await Promise.resolve();
    });
    expect(ref.current.px).toBe(22);
  });
});

describe("LyricScroller 字号契约", () => {
  const lines: LyricLine[] = [
    { timeMs: 0, text: "第一行" },
    { timeMs: 5_000, text: "第二行", translation: "译文", romanization: "romaji" },
  ];

  function renderScroller(fontSize?: number): void {
    render(
      <LyricScroller
        lines={lines}
        activeIndex={0}
        onSeekMs={() => undefined}
        positionMs={0}
        {...(fontSize === undefined ? {} : { fontSize })}
      />,
    );
  }

  const row = (i: number): HTMLElement => {
    const el = document.querySelector<HTMLElement>(`[data-lyric-index="${i}"]`);
    if (el === null) throw new Error(`第 ${i} 行没渲染`);
    return el;
  };

  it("默认高亮 20px、非高亮 16px，都是 rem（跟随全局字体缩放）", () => {
    renderScroller();
    expect(row(0).style.fontSize).toBe("1.250rem");
    expect(row(1).style.fontSize).toBe("1.000rem");
  });

  it("传 28 时四类文字按 1 : 0.8 : 0.7 : 0.6 等比缩放", () => {
    renderScroller(28);
    expect(row(0).style.fontSize).toBe("1.750rem"); // 28
    expect(row(1).style.fontSize).toBe("1.400rem"); // 22.4
    const translation = row(1).lastElementChild as HTMLElement;
    expect(translation.style.fontSize).toBe("1.225rem"); // 19.6
    const romanization = row(1).children[1] as HTMLElement;
    expect(romanization.style.fontSize).toBe("1.050rem"); // 16.8
  });

  it("行高跟着字号走（1.4 倍），不会裁字", () => {
    renderScroller(36);
    expect(row(0).style.lineHeight).toBe("1.4");
  });
});
