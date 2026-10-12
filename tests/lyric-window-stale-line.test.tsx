// @vitest-environment jsdom
/**
 * 桌面歌词「当前行越界」的回归（2026-10-12 用户实测）。
 *
 * 现象：桌面歌词窗口整块变成「这块内容出错了（桌面歌词）」，歌词不再显示、也不能
 * 自愈。证据是组件自己落库的那条日志（settings 表 `app.lastError`，由
 * ErrorBoundary.componentDidCatch 写入）：
 *
 *   [桌面歌词] Cannot read properties of undefined (reading 'words')
 *   TypeError: Cannot read properties of undefined (reading 'words')
 *
 * 内因：`lines`（整篇歌词）与 `activeIdx`（当前行）是两个独立 state，而 `activeIdx`
 * 只在 rAF 里重算。换歌 / 换词 / 取词失败都会**整篇替换** `lines`，若新的那份更短
 * （或直接为空），上一首留下的 `activeIdx` 就越界：`lines[activeIdx]` 是 `undefined`，
 * 而 render 里的判空原先写的是 `current !== null` —— undefined 能过，紧接着
 * `current.words`（逐字卡拉 OK 判定）抛 TypeError，整个窗口被 ErrorBoundary 接管。
 *
 * 这里锁两条路径（都是真机上会发生的）：
 * 1. 换到行数更少的歌词：不许抛错，主行按新歌词定位（而不是残留上一首的行号）；
 * 2. 取词失败（`lines` 变空）：不许抛错，主行回落「… 间奏 …」。
 *
 * 复现要点：必须真把 `activeIdx` 推到高处（走位置事件 + 手动推进一帧 rAF），
 * 否则 `activeIdx` 停在 -1，越界根本不会发生。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => {
  /** 五路订阅：按 key 各存一个回调，用例直接 emit 驱动 */
  const listeners = new Map<string, (payload: unknown) => void>();
  const track = (id: string): Record<string, unknown> => ({
    id,
    platform: "wyy",
    title: `曲目 ${id}`,
    singer: "s",
    album: "",
    picUrl: "",
    duration: 200,
    musicId: null,
  });
  return {
    listeners,
    track,
    on: (key: string) => (cb: (payload: unknown) => void): (() => void) => {
      listeners.set(key, cb);
      return () => listeners.delete(key);
    },
    emit: (key: string, payload: unknown): void => {
      listeners.get(key)?.(payload);
    },
    /** 被接管的 rAF 回调：用例手动推进一帧，避免依赖 jsdom 的动画时钟 */
    frames: [] as Array<() => void>,
    /** 当前「库里的」歌词，用例按场景改写 */
    getPlaybackLyric: vi.fn(async (..._args: unknown[]) => ({
      lrc: "",
      wordByWord: "",
      translation: "",
      romanization: "",
    })),
    /**
     * getDesktopLyricState 的返回值。组件是**整体替换** ui（不是逐字段合并），
     * 所以字段必须给全 —— 缺 gradient 之类会在 render 里直接炸。
     */
    uiState: {
      visible: true,
      locked: false,
      x: 120,
      y: 940,
      width: 520,
      height: 180,
      alwaysOnTop: true,
      fontFamily: "",
      fontSize: 24,
      fontWeight: 700,
      letterSpacing: 0,
      lineGap: 1.35,
      gradient: ["#5b8cff", "#b18cff"],
      inactiveColor: "rgba(255,255,255,0.65)",
      opacity: 0.9,
      stroke: false,
      strokeWidth: 1,
      shadow: true,
      backgroundMode: "none",
      backgroundColor: "#000000",
      backgroundOpacity: 0,
      borderRadius: 12,
      align: "center",
      lineMode: "two-lines",
    },
  };
});

vi.mock("@/services/ipc", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/services/ipc");
  return {
    ...actual,
    getDesktopLyricState: async () => h.uiState,
    getPlaybackState: async () => ({ status: "playing", positionMs: 0 }),
    getQueue: async () => ({ index: 0, tracks: [h.track("a")] }),
    onQueueChanged: h.on("queue"),
    onPositionChanged: h.on("position"),
    onPlaybackStateChanged: h.on("playback"),
    onLyricWindowChanged: h.on("ui"),
    onLyricManuallyPicked: h.on("picked"),
    hideDesktopLyric: async () => {},
    next: async () => {},
    previous: async () => {},
    pause: async () => {},
    resume: async () => {},
    openLyricSettings: async () => {},
    setDesktopLyricBounds: async () => {},
    setDesktopLyricLocked: async () => {},
    setDesktopLyricStyle: async () => {},
  };
});

// 偏移是另一个独立单元（tests/lyric-offset-sync.test.tsx），这里只要它能给个值
vi.mock("@/hooks/useLyricOffset", () => ({
  useLyricOffset: () => ({
    offsetMs: 0,
    draftMs: 0,
    setDraftMs: () => {},
    commit: () => {},
    nudge: () => {},
    reset: () => {},
  }),
}));

vi.mock("@/lib/localOnline", () => ({
  getPlaybackLyric: h.getPlaybackLyric,
  dropCachedLyric: vi.fn(),
  crossSourceHitFromLine: () => null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "lyrics",
    innerSize: async () => ({ toLogical: () => ({ width: 520, height: 180 }) }),
    outerSize: async () => ({ width: 520, height: 180 }),
    outerPosition: async () => ({ x: 120, y: 940 }),
    scaleFactor: async () => 1,
    setSize: async () => {},
    setPosition: async () => {},
    onMoved: async () => () => {},
  }),
}));

import { LyricWindow } from "@/components/lyric/LyricWindow";

const pad = (n: number): string => String(n).padStart(2, "0");
/** 60 行、秒级一行：位置 50s 时活跃行就是第 50 行 */
const LONG_LRC = Array.from({ length: 60 }, (_, i) => `[00:${pad(i)}.00]第 ${i} 行`).join("\n");
const SHORT_LRC = "[00:00.00]新歌 A\n[00:01.00]新歌 B\n[00:02.00]新歌 C";

/** 排空挂载时那一串 await（状态读取 / 队列 / 取词 / 五路订阅） */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 推进一帧 rAF（组件的 tick 会把下一帧再交回来） */
async function frame(): Promise<void> {
  const cbs = h.frames.splice(0, h.frames.length);
  await act(async () => {
    for (const cb of cbs) cb();
  });
}

function mainLine(): string {
  return screen.getByTestId("lyric-main-line").textContent ?? "";
}

/** 播到 50s：把 activeIdx 推到第 50 行 */
async function playToLine50(): Promise<void> {
  await act(async () => {
    h.emit("position", { positionMs: 50_000 });
  });
  await frame();
}

beforeEach(() => {
  h.listeners.clear();
  h.frames.length = 0;
  h.getPlaybackLyric.mockReset();
  h.getPlaybackLyric.mockResolvedValue({
    lrc: LONG_LRC,
    wordByWord: "",
    translation: "",
    romanization: "",
  });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    h.frames.push(() => cb(performance.now()));
    return h.frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("桌面歌词当前行越界", () => {
  it("换到行数更少的歌词：不打崩窗口，主行按新歌词定位", async () => {
    render(<LyricWindow />);
    await settle();
    await playToLine50();
    expect(mainLine()).toBe("第 50 行");

    // 换一首只有 3 行的歌（applyLines 之前：activeIdx=50 会撞上 length=3）
    h.getPlaybackLyric.mockResolvedValue({
      lrc: SHORT_LRC,
      wordByWord: "",
      translation: "",
      romanization: "",
    });
    await act(async () => {
      h.emit("playback", {
        status: "playing",
        positionMs: 50_000,
        track: h.track("b"),
      });
    });
    await settle();

    // 修复前这里抛 TypeError，整棵树被 ErrorBoundary 换成错误卡片
    expect(screen.getByTestId("lyric-window-root")).toBeTruthy();
    // 50s 已过末行（第 3 行 @2s）⇒ 新歌词的最后一行
    expect(mainLine()).toBe("新歌 C");
  });

  it("取词失败（lines 变空）：不打崩窗口，主行回落间奏", async () => {
    render(<LyricWindow />);
    await settle();
    await playToLine50();
    expect(mainLine()).toBe("第 50 行");

    h.getPlaybackLyric.mockRejectedValue(new Error("取词失败"));
    await act(async () => {
      h.emit("playback", {
        status: "playing",
        positionMs: 50_000,
        track: h.track("c"),
      });
    });
    await settle();

    expect(screen.getByTestId("lyric-window-root")).toBeTruthy();
    expect(mainLine()).toBe("… 间奏 …");
  });
});