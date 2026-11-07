// @vitest-environment jsdom
/**
 * 桌面歌词冷启动跨源取词回归（C08）。
 *
 * 现象：桌面歌词是独立 WebView，主窗口启动时做的音源注册表 ensure() 在它这里
 * 不生效。窗口冷启动时注册表还是空的，`crossSourceHitFromLine` 里的
 * `registryHasSource(target)` 会把一条合法的跨源命中当成「目标源已下线」丢掉：
 * 歌词退回按原平台取，时间轴整体偏掉（换源后对不上拍）。
 *
 * 修复：入口先 ensure 再挂载；`loadLyricFor` 每次取词前也 ensure 一次（幂等，
 * 就绪后立即 resolve），覆盖「音源包加载慢 / 入口那次 ensure 失败过 / 事件先到」
 * 的情况。这里锁的就是「先 ensure、再判跨源、再取词」的顺序。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => {
  /** 耗时顺序：用例断言 ensure → cross → lyric */
  const events: string[] = [];
  /** getPlaybackLyric 收到的 cross 参数 */
  const lyricCalls: unknown[] = [];
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
  /** 注册表 ensure 的 deferred：用例控制「还没落地 / 失败」两种冷启动 */
  const ensure = {
    promise: Promise.resolve() as Promise<void>,
    resolve: (): void => {},
    reject: (_err: unknown): void => {},
  };
  /** 跨源命中：ensure 落地后才有（注册表空时 guard 会丢弃它） */
  const cross = { hit: null as unknown };
  return {
    events,
    lyricCalls,
    listeners,
    track,
    ensure,
    cross,
    on: (key: string) => (cb: (payload: unknown) => void): (() => void) => {
      listeners.set(key, cb);
      return () => listeners.delete(key);
    },
    emit: (key: string, payload: unknown): void => {
      listeners.get(key)?.(payload);
    },
    /** 被接管的 rAF 回调：滚动相关逻辑要能跑，用例不必推进 */
    frames: [] as Array<() => void>,
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

// 只关心「判跨源之前有没有等注册表」：跨源解析本身是纯函数，这里直接给结果
vi.mock("@/lib/localOnline", () => ({
  getPlaybackLyric: async (_track: unknown, cross: unknown) => {
    h.events.push("lyric");
    h.lyricCalls.push(cross);
    return { lrc: "[00:00.00]词", wordByWord: "", translation: "", romanization: "" };
  },
  dropCachedLyric: vi.fn(),
  crossSourceHitFromLine: () => {
    h.events.push("cross");
    return h.cross.hit;
  },
}));

vi.mock("@/stores/sourceRegistry", () => ({
  useSourceRegistryStore: {
    getState: () => ({
      ensure: (): Promise<void> => {
        h.events.push("ensure");
        return h.ensure.promise;
      },
    }),
  },
  registryHasSource: () => true,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
  emit: vi.fn(async () => {}),
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

/** 排空挂载时那一串 await（状态读取 / 队列 / 取词 / 五路订阅） */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  h.events.length = 0;
  h.lyricCalls.length = 0;
  h.listeners.clear();
  h.frames.length = 0;
  h.cross.hit = null;
  h.ensure.promise = new Promise<void>((resolve, reject) => {
    h.ensure.resolve = resolve;
    h.ensure.reject = reject;
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

describe("桌面歌词冷启动的源注册表", () => {
  it("注册表落地前不判跨源、不取词；落地后按跨源命中取词", async () => {
    render(<LyricWindow />);
    await settle();

    // 冷启动：注册表还在拉取 → 必须先等它，不能拿空注册表去判跨源
    expect(h.events).toContain("ensure");
    expect(h.events).not.toContain("cross");
    expect(h.events).not.toContain("lyric");

    // 注册表落地，跨源线路此刻才算有效
    h.cross.hit = { target: "kw", song: null };
    await act(async () => {
      h.ensure.resolve();
    });
    await settle();

    expect(h.events.indexOf("ensure")).toBeLessThan(h.events.indexOf("cross"));
    expect(h.events.indexOf("cross")).toBeLessThan(h.events.indexOf("lyric"));
    expect(h.lyricCalls[0]).toEqual({ target: "kw", song: null });
  });

  it("注册表拉取失败：照常按原平台取词，不卡住歌词窗", async () => {
    render(<LyricWindow />);
    await settle();
    expect(h.events).toContain("ensure");

    await act(async () => {
      h.ensure.reject(new Error("数据包没装"));
    });
    await settle();

    // 失败也只退回原平台（cross = null），窗口不能空着
    expect(h.lyricCalls.length).toBe(1);
    expect(h.lyricCalls[0]).toBeNull();
    expect(screen.getByTestId("lyric-window-root")).toBeTruthy();
  });
});
