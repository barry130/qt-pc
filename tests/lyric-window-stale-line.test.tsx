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
 * 2. 取词失败（`lines` 变空）：不许抛错，明确显示加载失败，后续同曲心跳限次重试。
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
    events: new Map<string, (event: { payload: unknown }) => void>(),
    track,
    getPlaybackState: vi.fn(async () => ({ status: "playing", positionMs: 0, track: track("a") })),
    getQueue: vi.fn(async () => ({ index: 0, tracks: [track("a")] })),
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
    getPlaybackState: h.getPlaybackState,
    getQueue: h.getQueue,
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

// 本用例不关心源注册表：ensure 直接就绪，取词不再等它（C08 的取词顺序
// 另见 tests/lyric-window-registry-hydration.test.tsx）
vi.mock("@/stores/sourceRegistry", () => ({
  useSourceRegistryStore: {
    getState: () => ({ ensure: (): Promise<void> => Promise.resolve() }),
  },
  registryHasSource: () => true,
}));

vi.mock("@/lib/localOnline", () => ({
  getPlaybackLyric: h.getPlaybackLyric,
  dropCachedLyric: vi.fn(),
  crossSourceHitFromLine: () => null,
  playbackLyricKey: (track: { platform: string; id: string }, cross: { target: string; song: { id: string } | null } | null = null) => `${track.platform}:${track.id}:${cross?.target ?? ""}:${cross?.song?.id ?? ""}`,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    h.events.set(name, callback);
    return () => h.events.delete(name);
  }),
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
}));
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
import { dropCachedLyric } from "@/lib/localOnline";
import { PODCAST_SUBTITLE_UPDATE } from "@/lib/podcast-subtitle-sync";

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
  h.events.clear();
  h.frames.length = 0;
  h.getPlaybackState.mockReset().mockResolvedValue({ status: "playing", positionMs: 0, track: h.track("a") });
  h.getQueue.mockReset().mockResolvedValue({ index: 0, tracks: [h.track("a")] });
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
  it("打开窗口时队列仍是上一首，按当前播放快照的曲目和进度显示歌词", async () => {
    h.getPlaybackState.mockResolvedValue({ status: "paused", positionMs: 41_000, track: h.track("b") });
    h.getPlaybackLyric.mockImplementation(async (...args: unknown[]) => ({
      lrc: (args[0] as { id: string }).id === "b"
        ? "[00:00.00]新歌开始\n[00:40.00]走过荒芜的沙丘"
        : "[00:00.00]上一首歌词",
      wordByWord: "", translation: "", romanization: "",
    }));
    render(<LyricWindow />);
    await settle();
    await frame();
    expect(mainLine()).toBe("走过荒芜的沙丘");
    expect(h.getPlaybackLyric).toHaveBeenCalledWith(h.track("b"), null);
  });

  it("初始化慢快照返回时，新切歌和进度事件已显示的歌词保持不变", async () => {
    let resolveSnapshot!: (value: Awaited<ReturnType<typeof h.getPlaybackState>>) => void;
    h.getPlaybackState.mockReturnValueOnce(new Promise((resolve) => { resolveSnapshot = resolve; }));
    render(<LyricWindow />);
    await settle();
    await act(async () => {
      h.emit("playback", { status: "paused", positionMs: 50_000, track: h.track("b") });
    });
    await settle();
    expect(mainLine()).toBe("第 50 行");
    await act(async () => resolveSnapshot({ status: "paused", positionMs: 0, track: h.track("a") }));
    await settle();
    await frame();
    expect(mainLine()).toBe("第 50 行");
    expect(h.getPlaybackLyric).not.toHaveBeenCalledWith(h.track("a"), null);
  });

  it("主窗口词快照恢复桌面内容，旧取词失败或同曲旧源快照不覆盖正确歌词", async () => {
    let failOldRequest!: (error: Error) => void;
    h.getPlaybackLyric.mockReturnValueOnce(new Promise((_resolve, reject) => { failOldRequest = reject; }));
    render(<LyricWindow />);
    await settle();
    await act(async () => h.emit("position", { positionMs: 41_000 }));
    const shared = { trackId: "wyy:a", lyricKey: "wyy:a::", lyric: {
      lrc: "[00:00.00]新歌开始\n[00:40.00]走过荒芜的沙丘", translation: "", wordByWord: "", romanization: "",
    } };
    await act(async () => h.events.get("playback-lyric-updated")?.({ payload: shared }));
    expect(mainLine()).toBe("走过荒芜的沙丘");
    expect(dropCachedLyric).toHaveBeenCalledWith(h.track("a"), null);
    await act(async () => failOldRequest(new Error("旧取词超时")));
    await settle();
    expect(mainLine()).toBe("走过荒芜的沙丘");
    await act(async () => {
      h.events.get("playback-lyric-updated")?.({ payload: { ...shared, trackId: "wyy:old", lyric: { lrc: "[00:00.00]上一首", translation: "" } } });
      h.events.get("playback-lyric-updated")?.({ payload: { ...shared, lyricKey: "wyy:a:kw:wrong", lyric: { lrc: "[00:00.00]旧源", translation: "" } } });
      h.events.get("play-url-line")?.({ payload: { platform: "wyy", id: "a", line: null } });
    });
    await settle();
    expect(mainLine()).toBe("走过荒芜的沙丘");
  });

  it("播客字幕更新立即显示当前句和译文，换集或迟到更新不串集，空档不悬挂旧句", async () => {
    render(<LyricWindow />);
    await settle();
    h.getPlaybackLyric.mockClear();
    const podcast = { ...h.track("podcast-a"), platform: "podcast" };
    await act(async () => h.emit("playback", { status: "paused", positionMs: 6000, track: podcast }));
    await settle();
    expect(mainLine()).toContain("等待播客字幕");
    expect(h.getPlaybackLyric).not.toHaveBeenCalled();
    const document = { revision: 2, timed: true, source: "asr", cues: [
      { startMs: 1000, endMs: 3000, text: "First sentence", translation: "第一句" },
      { startMs: 5000, endMs: 9000, text: "Current sentence", translation: "当前句" },
    ] };
    await act(async () => h.events.get(PODCAST_SUBTITLE_UPDATE)?.({ payload: { episodeId: "podcast-a", document } }));
    expect(mainLine()).toBe("Current sentence");
    expect(screen.getByTestId("lyric-second-line").textContent).toBe("当前句");
    await act(async () => h.events.get(PODCAST_SUBTITLE_UPDATE)?.({ payload: { episodeId: "podcast-a", document: { ...document, revision: 1, cues: [] } } }));
    expect(mainLine()).toBe("Current sentence");
    await act(async () => h.emit("playback", { status: "paused", positionMs: 10000, track: podcast }));
    await frame();
    expect(mainLine()).toContain("等待当前播客字幕");
    await act(async () => h.emit("playback", { status: "paused", positionMs: 6000, track: { ...podcast, id: "podcast-b" } }));
    await act(async () => h.events.get(PODCAST_SUBTITLE_UPDATE)?.({ payload: { episodeId: "podcast-a", document } }));
    expect(mainLine()).toContain("等待播客字幕");
    await act(async () => h.events.get(PODCAST_SUBTITLE_UPDATE)?.({ payload: { episodeId: "podcast-b", document: { ...document, timed: false } } }));
    expect(mainLine()).toContain("无时间轴");
  });
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

  it("取词失败（lines 变空）：不打崩窗口，明确显示加载失败而不是间奏", async () => {
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
    expect(mainLine()).toContain("歌词加载失败");
    expect(mainLine()).not.toContain("间奏");
  });

  it("手动换词通知使旧共享词失效，主窗口补发未到也能回读新词", async () => {
    render(<LyricWindow />);
    await settle();
    await act(async () => h.events.get("playback-lyric-updated")?.({ payload: {
      trackId: "wyy:a", lyricKey: "wyy:a::", lyric: { lrc: "[00:00.00]旧共享词", translation: "" },
    } }));
    expect(mainLine()).toBe("旧共享词");
    h.getPlaybackLyric.mockResolvedValue({ lrc: "[00:00.00]手动新词", wordByWord: "", translation: "", romanization: "" });
    await act(async () => h.emit("picked", { trackId: "wyy:a" }));
    await settle();
    expect(mainLine()).toBe("手动新词");
  });

  it("换曲未取回时清除旧句，成功空词与真正前奏分别提示", async () => {
    render(<LyricWindow />);
    await settle();
    await playToLine50();
    let resolveLyric!: (value: Awaited<ReturnType<typeof h.getPlaybackLyric>>) => void;
    h.getPlaybackLyric.mockReturnValueOnce(new Promise((resolve) => { resolveLyric = resolve; }));
    await act(async () => h.emit("playback", { status: "paused", positionMs: 0, track: h.track("b") }));
    await settle();
    expect(mainLine()).toBe("正在加载歌词…");
    await act(async () => resolveLyric({ lrc: "", wordByWord: "", translation: "", romanization: "" }));
    expect(mainLine()).toBe("暂无歌词");
    h.getPlaybackLyric.mockResolvedValue({ lrc: "[00:40.00]尚未开唱", wordByWord: "", translation: "", romanization: "" });
    await act(async () => h.emit("playback", { status: "paused", positionMs: 0, track: h.track("c") }));
    await settle();
    expect(mainLine()).toBe("… 间奏 …");
  });

  it("失败重试等待至少五秒且每个曲目来源最多三次，不随心跳重复请求", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      h.getPlaybackLyric.mockRejectedValue(new Error("持续超时"));
      render(<LyricWindow />);
      await settle();
      const heartbeat = async (): Promise<void> => {
        await act(async () => h.emit("playback", { status: "paused", positionMs: 41_000, track: h.track("a") }));
        await settle();
      };
      now.mockReturnValue(5_999);
      await heartbeat();
      expect(h.getPlaybackLyric).toHaveBeenCalledTimes(1);
      now.mockReturnValue(6_000);
      await heartbeat();
      await heartbeat();
      expect(h.getPlaybackLyric).toHaveBeenCalledTimes(2);
      now.mockReturnValue(11_000);
      await heartbeat();
      now.mockReturnValue(60_000);
      await heartbeat();
      expect(h.getPlaybackLyric).toHaveBeenCalledTimes(3);
    } finally { now.mockRestore(); }
  });

  it("下一首暂时取词失败，只有进度心跳也会按时重取并恢复歌词", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const view = render(<LyricWindow />);
    try {
      await settle();
      h.getPlaybackLyric.mockRejectedValueOnce(new Error("下一首暂时超时"));
      await act(async () => h.emit("playback", { status: "playing", positionMs: 0, track: h.track("b") }));
      await settle();
      expect(mainLine()).toContain("歌词加载失败");
      expect(h.getPlaybackLyric).toHaveBeenCalledTimes(2);
      // 真实引擎的周期通知只有 position-changed，不会重复发布播放状态。
      now.mockReturnValue(5_999);
      await act(async () => h.emit("position", { positionMs: 41_000 }));
      await settle();
      expect(h.getPlaybackLyric).toHaveBeenCalledTimes(2);
      now.mockReturnValue(6_000);
      await act(async () => h.emit("position", { positionMs: 41_000 }));
      await settle();
      expect(h.getPlaybackLyric).toHaveBeenCalledTimes(3);
      await frame();
      expect(mainLine()).toBe("第 41 行");
      now.mockReturnValue(60_000);
      await act(async () => h.emit("position", { positionMs: 41_000 }));
      await settle();
      expect(h.getPlaybackLyric).toHaveBeenCalledTimes(3);
    } finally {
      view.unmount();
      now.mockRestore();
    }
  });

  it("下一首暂停且没有任何后续事件时，五秒后仍自动恢复歌词", async () => {
    const view = render(<LyricWindow />);
    await settle();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      h.getPlaybackLyric.mockRejectedValueOnce(new Error("下一首暂时超时"));
      await act(async () => {
        h.emit("playback", { status: "paused", positionMs: 41_000, track: h.track("b") });
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mainLine()).toContain("歌词加载失败");
      expect(h.getPlaybackLyric).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
      expect(h.getPlaybackLyric).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(h.getPlaybackLyric).toHaveBeenCalledTimes(3);
      expect(mainLine()).toBe("第 41 行");
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(h.getPlaybackLyric).toHaveBeenCalledTimes(3);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("定时和进度重试合并为同一次请求，持续失败最多尝试三次", async () => {
    const view = render(<LyricWindow />);
    await settle();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      h.getPlaybackLyric.mockRejectedValue(new Error("持续超时"));
      await act(async () => {
        h.emit("playback", { status: "playing", positionMs: 0, track: h.track("b") });
        await vi.advanceTimersByTimeAsync(0);
      });
      for (const expected of [3, 4]) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5_000);
          h.emit("position", { positionMs: 41_000 });
        });
        expect(h.getPlaybackLyric).toHaveBeenCalledTimes(expected);
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
        h.emit("position", { positionMs: 41_000 });
        h.emit("playback", { status: "paused", positionMs: 41_000, track: h.track("b") });
      });
      expect(h.getPlaybackLyric).toHaveBeenCalledTimes(4);
      expect(mainLine()).toContain("歌词加载失败");
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it.each(["切歌", "停止", "播客", "主窗口正文", "关闭"])("%s后废弃上首待重试任务，旧失败不覆盖新内容", async (action) => {
    const view = render(<LyricWindow />);
    await settle();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      h.getPlaybackLyric.mockRejectedValueOnce(new Error("下一首暂时超时"));
      await act(async () => {
        h.emit("playback", { status: "paused", positionMs: 0, track: h.track("b") });
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mainLine()).toContain("歌词加载失败");
      await act(async () => {
        if (action === "切歌") h.emit("playback", { status: "paused", positionMs: 41_000, track: h.track("c") });
        else if (action === "停止") h.emit("playback", { status: "stopped", positionMs: 0, track: null });
        else if (action === "播客") h.emit("playback", { status: "paused", positionMs: 0, track: { ...h.track("episode"), platform: "podcast" } });
        else if (action === "主窗口正文") h.events.get("playback-lyric-updated")?.({ payload: {
          trackId: "wyy:b", lyricKey: "wyy:b::", lyric: { lrc: "[00:00.00]主窗口正确歌词", translation: "" },
        } });
        else view.unmount();
        await vi.advanceTimersByTimeAsync(0);
      });
      const requests = h.getPlaybackLyric.mock.calls.length;
      const text = action === "关闭" ? null : mainLine();
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(h.getPlaybackLyric).toHaveBeenCalledTimes(requests);
      if (text !== null) expect(mainLine()).toBe(text);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("同曲取词失败后在播放心跳里限次恢复，不会一次失败后整首空词", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      h.getPlaybackLyric.mockRejectedValueOnce(new Error("暂时超时"));
      render(<LyricWindow />);
      await settle();
      expect(mainLine()).toContain("歌词加载失败");
      now.mockReturnValue(7_000);
      await act(async () => h.emit("playback", { status: "paused", positionMs: 41_000, track: h.track("a") }));
      await settle();
      expect(h.getPlaybackLyric).toHaveBeenCalledTimes(2);
      expect(mainLine()).toBe("第 41 行");
    } finally { now.mockRestore(); }
  });

  /**
   * 「换了源歌词没换」的跨窗口那一段：本窗口是独立 WebView，读不到主窗口的
   * 线路记忆，只订阅 `play-url-line` 事件。而它常常是在取链**之后**才打开的
   * （事件早已发过），于是 crossLineByTrack 永远是空的 → 一直按原平台取词。
   * 所以挂载时必须在订阅齐之后，主动向主窗口要一次补发。
   */
  it("挂载后向主窗口请求一次当前命中线路（后打开也能跟随换源）", async () => {
    render(<LyricWindow />);
    await settle();

    const { emit } = await import("@tauri-apps/api/event");
    expect(vi.mocked(emit)).toHaveBeenCalledWith("request-play-url-line");
  });
});
