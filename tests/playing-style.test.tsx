// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSetting = vi.hoisted(() => vi.fn(async (_key: string): Promise<string | null> => null));
const setSetting = vi.hoisted(() => vi.fn(async (_key: string, _value: string): Promise<void> => undefined));
vi.mock("@/services/ipc", () => ({ getSetting, setSetting }));

import { PLAYING_STYLE_KEY, PLAYING_BACKGROUND_KEY, usePlayingStyleStore } from "@/stores/playingStyle";
import { PlayingStyleControl } from "@/components/player/PlayingStyleControl";
import { RhythmLyrics } from "@/components/player/RhythmLyrics";
import { FocusLyrics } from "@/components/player/FocusLyrics";
import { DEFAULT_PLAYING_BACKGROUND, parsePlayingBackground, readPlayingBackgroundImage } from "@/lib/playing-background";
import { rhythmGlyphs } from "@/lib/lyric-rhythm";
import type { LyricLine } from "@/lib/lrc";

beforeEach(() => {
  getSetting.mockReset().mockResolvedValue(null);
  setSetting.mockReset().mockResolvedValue(undefined);
  usePlayingStyleStore.setState({ style: "classic", loaded: false, saveError: false,
    background: DEFAULT_PLAYING_BACKGROUND, backgroundLoaded: false, backgroundSaveError: false });
});

describe("播放页风格偏好", () => {
  it("旧用户默认经典唱片，已保存的律动风格可恢复，未知值安全回落且不覆写", async () => {
    for (const [saved, expected] of [[null, "classic"], ["rhythm", "rhythm"], ["gallery", "gallery"], ["focus", "focus"], ["future-style", "classic"]]) {
      usePlayingStyleStore.setState({ loaded: false });
      getSetting.mockResolvedValueOnce(saved);
      await usePlayingStyleStore.getState().load();
      expect(usePlayingStyleStore.getState().style).toBe(expected);
    }
    expect(getSetting).toHaveBeenCalledWith(PLAYING_STYLE_KEY);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("读取慢时手动切换不会被迟到的已保存值覆盖，重复加载共用请求", async () => {
    let resolveRead!: (value: string) => void;
    getSetting.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
    const first = usePlayingStyleStore.getState().load();
    const second = usePlayingStyleStore.getState().load();
    await usePlayingStyleStore.getState().select("rhythm");
    resolveRead("classic");
    await Promise.all([first, second]);
    expect(usePlayingStyleStore.getState().style).toBe("rhythm");
    expect(getSetting.mock.calls.filter(([key]) => key === PLAYING_STYLE_KEY)).toHaveLength(1);
    expect(getSetting.mock.calls.filter(([key]) => key === PLAYING_BACKGROUND_KEY)).toHaveLength(1);
  });

  it("快速切换串行保存，以最后选择为准，较早失败不污染最新结果", async () => {
    let rejectFirst!: (reason: Error) => void;
    setSetting.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }));
    const first = usePlayingStyleStore.getState().select("rhythm");
    await Promise.resolve();
    const second = usePlayingStyleStore.getState().select("classic");
    expect(usePlayingStyleStore.getState().style).toBe("classic");
    expect(setSetting).toHaveBeenCalledTimes(1);
    rejectFirst(new Error("unavailable"));
    await Promise.all([first, second]);
    expect(setSetting.mock.calls).toEqual([[PLAYING_STYLE_KEY, "rhythm"], [PLAYING_STYLE_KEY, "classic"]]);
    expect(usePlayingStyleStore.getState().saveError).toBe(false);
  });

  it("保存失败保留当前呈现、显示未保存，重试后恢复；读取失败不写默认值", async () => {
    getSetting.mockRejectedValueOnce(new Error("read failed"));
    await usePlayingStyleStore.getState().load();
    expect(usePlayingStyleStore.getState().loaded).toBe(false);
    expect(setSetting).not.toHaveBeenCalled();
    setSetting.mockRejectedValueOnce(new Error("write failed"));
    await usePlayingStyleStore.getState().select("rhythm");
    expect(usePlayingStyleStore.getState()).toMatchObject({ style: "rhythm", saveError: true });
    render(<PlayingStyleControl />);
    expect(screen.getByRole("status").textContent).toBe("未保存");
    fireEvent.click(screen.getByRole("button", { name: "播放页风格" }));
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(usePlayingStyleStore.getState().saveError).toBe(false));
  });

  it("风格选项切换并恢复触发器焦点，Esc 和外部点击都能收起", async () => {
    render(<PlayingStyleControl />);
    const trigger = screen.getByRole("button", { name: "播放页风格" });
    fireEvent.click(trigger);
    expect(screen.getByRole("button", { name: "经典唱片" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "歌词律动" }));
    await waitFor(() => expect(setSetting).toHaveBeenCalledWith(PLAYING_STYLE_KEY, "rhythm"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    expect(screen.getByRole("button", { name: "歌词律动" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => { await usePlayingStyleStore.getState().select("classic"); });
  });
});

describe("播放页背景独立保存", () => {
  it("背景读取不覆盖期间的新选择，同时仍恢复保存的布局", async () => {
    let finishStyle!: (value: string) => void;
    let finishBackground!: (value: string) => void;
    getSetting.mockImplementation((key) => new Promise((resolve) => {
      if (key === PLAYING_STYLE_KEY) finishStyle = resolve;
      else finishBackground = resolve;
    }));
    const loading = usePlayingStyleStore.getState().load();
    await usePlayingStyleStore.getState().selectBackground({ kind: "forest", image: "" });
    finishStyle("gallery");
    finishBackground(JSON.stringify({ kind: "burgundy", image: "" }));
    await loading;
    expect(usePlayingStyleStore.getState()).toMatchObject({ style: "gallery", background: { kind: "forest" }, loaded: true, backgroundLoaded: true });
  });

  it("切换布局期间仍恢复背景，两个偏好分别写入", async () => {
    let finishBackground!: (value: string) => void;
    getSetting.mockImplementation((key) => key === PLAYING_BACKGROUND_KEY
      ? new Promise((resolve) => { finishBackground = resolve; }) : Promise.resolve("classic"));
    const loading = usePlayingStyleStore.getState().load();
    await usePlayingStyleStore.getState().select("focus");
    finishBackground(JSON.stringify({ kind: "midnight", image: "" }));
    await loading;
    expect(usePlayingStyleStore.getState()).toMatchObject({ style: "focus", background: { kind: "midnight" } });
    await usePlayingStyleStore.getState().select("rhythm");
    expect(usePlayingStyleStore.getState().background.kind).toBe("midnight");
    expect(setSetting.mock.calls.every(([key]) => key === PLAYING_STYLE_KEY)).toBe(true);
  });

  it("背景保存失败与布局保存独立，重试只写失败的偏好", async () => {
    setSetting.mockRejectedValueOnce(new Error("write failed"));
    await usePlayingStyleStore.getState().selectBackground({ kind: "forest", image: "" });
    await usePlayingStyleStore.getState().select("gallery");
    expect(usePlayingStyleStore.getState()).toMatchObject({ saveError: false, backgroundSaveError: true });
    await usePlayingStyleStore.getState().retrySave();
    expect(setSetting.mock.calls.map(([key]) => key)).toEqual([PLAYING_BACKGROUND_KEY, PLAYING_STYLE_KEY, PLAYING_BACKGROUND_KEY]);
    expect(usePlayingStyleStore.getState().backgroundSaveError).toBe(false);
  });

  it("损坏的图片设置安全回退，有效本地图片可恢复", () => {
    for (const raw of [null, "bad json", "42", '{"kind":"unknown"}', '{"kind":"image","image":"https://example.com/image.png"}']) {
      expect(parsePlayingBackground(raw)).toEqual(DEFAULT_PLAYING_BACKGROUND);
    }
    const saved = { kind: "image", image: "data:image/jpeg;base64,AAAA" };
    expect(parsePlayingBackground(JSON.stringify(saved))).toEqual(saved);
  });

  it("拒绝格式和体积不符的文件，保持背景不变", async () => {
    await expect(readPlayingBackgroundImage(new File(["bad"], "bad.svg", { type: "image/svg+xml" }))).rejects.toThrow("JPG、PNG 或 WebP");
    const large = new File(["jpg"], "large.jpg", { type: "image/jpeg" });
    Object.defineProperty(large, "size", { value: 13 * 1024 * 1024 });
    await expect(readPlayingBackgroundImage(large)).rejects.toThrow("12 MB");
    expect(usePlayingStyleStore.getState().background).toEqual(DEFAULT_PLAYING_BACKGROUND);
  });

  it("四种风格与背景独立成组，选背景保持面板展开，换风格保留背景", async () => {
    render(<PlayingStyleControl />);
    const trigger = screen.getByRole("button", { name: "播放页风格" });
    fireEvent.click(trigger);
    for (const name of ["经典唱片", "歌词律动", "专辑画廊", "纯净歌词"]) expect(screen.getByRole("button", { name })).toBeTruthy();
    expect(screen.getByRole("group", { name: "播放页背景" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "松林绿" }));
    await waitFor(() => expect(usePlayingStyleStore.getState().background.kind).toBe("forest"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "专辑画廊" }));
    await waitFor(() => expect(usePlayingStyleStore.getState().style).toBe("gallery"));
    expect(usePlayingStyleStore.getState().background.kind).toBe("forest");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("画廊和纯净歌词", () => {
  it.each(["gallery", "focus"] as const)("%s 同步当前句和译文，支持跳转上下句、前奏与间奏", (variant) => {
    // jsdom 不解析包含 CSS 变量的渐变，直接观察交给浏览器的词内填充值。
    const gradients = vi.spyOn(CSSStyleDeclaration.prototype, "backgroundImage", "set");
    const lines = [{ timeMs: 1000, text: "开头" }, { timeMs: 3000, text: "" },
      { timeMs: 5000, text: "你好", translation: "Hello", romanization: "nǐ hǎo", words: [{ text: "你好", startMs: 0, durationMs: 2000 }] },
      { timeMs: 9000, text: "世界" }];
    const seek = vi.fn();
    const base = { lines, fontSize: 20, variant, onSeekMs: seek };
    const view = render(<FocusLyrics {...base} activeIndex={-1} positionMs={0} />);
    expect(screen.getByRole("group", { name: "开头" })).toBeTruthy();
    view.rerender(<FocusLyrics {...base} activeIndex={2} positionMs={6000} />);
    expect(screen.getByText("Hello")).toBeTruthy();
    expect(screen.getByText("nǐ hǎo")).toBeTruthy();
    expect(gradients).toHaveBeenCalledWith(expect.stringContaining("var(--lyric-highlight) 50%"));
    fireEvent.click(screen.getByRole("button", { name: "跳到上一句：开头" }));
    fireEvent.click(screen.getByRole("button", { name: "跳到下一句：世界" }));
    expect(seek.mock.calls).toEqual([[1000], [9000]]);
    view.rerender(<FocusLyrics {...base} activeIndex={1} positionMs={4000} />);
    expect(screen.getByRole("group", { name: "间奏" })).toBeTruthy();
    expect(screen.queryByText("Hello")).toBeNull();
    view.rerender(<FocusLyrics {...base} activeIndex={3} positionMs={10000} />);
    expect(screen.getByText("尾声")).toBeTruthy();
    gradients.mockRestore();
  });
});

describe("歌词律动时间轴", () => {
  it("逐字拆分保留词间停顿及 Unicode 字素，普通 LRC 按相邻行估算", () => {
    const timed = rhythmGlyphs({ timeMs: 1000, text: "你好👩‍🚀", words: [
      { text: "你好", startMs: 100, durationMs: 400 },
      { text: "👩‍🚀", startMs: 1200, durationMs: 600 },
    ] }, 8000, 10000);
    expect(timed).toEqual([
      { text: "你", startMs: 100, durationMs: 200 },
      { text: "好", startMs: 300, durationMs: 200 },
      { text: "👩‍🚀", startMs: 1200, durationMs: 600 },
    ]);
    expect(rhythmGlyphs({ timeMs: 1000, text: "歌词" }, 5000, 10000)).toEqual([
      { text: "歌", startMs: 0, durationMs: 2000 },
      { text: "词", startMs: 2000, durationMs: 2000 },
    ]);
    expect(rhythmGlyphs({ timeMs: 1000, text: "尾声" }, undefined, 0)[1].startMs).toBe(2000);
  });

  it("开唱前预览，播放位置驱动字形，暂停保持当前值，向后 seek 可还原", () => {
    const lines: LyricLine[] = [{ timeMs: 1000, text: "你好", translation: "Hello", romanization: "nǐ hǎo" }, { timeMs: 5000, text: "世界" }];
    const base = { lines, durationMs: 8000, playing: true, fontSize: 20, onSeekMs: vi.fn() };
    const view = render(<RhythmLyrics {...base} activeIndex={-1} positionMs={0} />);
    expect(screen.getByText("等待歌词开始")).toBeTruthy();
    expect(view.container.querySelector('[data-sung="true"]')).toBeNull();
    view.rerender(<RhythmLyrics {...base} activeIndex={0} positionMs={2000} />);
    const glyph = view.container.querySelector<HTMLElement>(".qt-rhythm-glyph")!;
    const lift = glyph.style.getPropertyValue("--rhythm-lift");
    expect(Number.parseFloat(lift)).toBeLessThan(-0.08);
    expect(screen.getByText("Hello")).toBeTruthy();
    expect(screen.getByText("nǐ hǎo")).toBeTruthy();
    view.rerender(<RhythmLyrics {...base} activeIndex={0} positionMs={2000} playing={false} />);
    expect(glyph.style.getPropertyValue("--rhythm-lift")).toBe(lift);
    fireEvent.click(screen.getByRole("button", { name: "跳到下一句：世界" }));
    expect(base.onSeekMs).toHaveBeenCalledWith(5000);
    view.rerender(<RhythmLyrics {...base} activeIndex={-1} positionMs={500} />);
    expect(view.container.querySelector('[data-sung="true"]')).toBeNull();
  });

  it("空白行呈现间奏，换歌移除旧字和译文，末句显示尾声", () => {
    const base = { durationMs: 8000, playing: true, fontSize: 20, onSeekMs: vi.fn(), activeIndex: 0, positionMs: 1000 };
    const view = render(<RhythmLyrics {...base} lines={[{ timeMs: 0, text: "旧歌词", translation: "old" }]} />);
    view.rerender(<RhythmLyrics {...base} lines={[{ timeMs: 0, text: "" }, { timeMs: 4000, text: "新歌词" }]} />);
    expect(screen.getByRole("group", { name: "间奏" })).toBeTruthy();
    expect(screen.queryByText("old")).toBeNull();
    view.rerender(<RhythmLyrics {...base} lines={[{ timeMs: 0, text: "新歌词" }]} />);
    expect(screen.getByRole("group", { name: "新歌词" })).toBeTruthy();
    expect(screen.getByText("尾声")).toBeTruthy();
  });
});
