// @vitest-environment jsdom
/**
 * 歌词偏移的跨窗口同步（2026-10-06）。
 *
 * 背景：播放页与桌面歌词窗口是两个独立 WebView，各自持一份 hook 状态。以前只有
 * 切歌才去库里重读，于是在播放页改完偏移、桌面歌词仍停在旧值 —— 用户看到的就是
 * 「歌词偏移之后桌面歌词没有跟着偏移」。
 *
 * 现在写入方（`setLyricOffset`）落库后广播 `lyric-offset-changed`，订阅方即时对齐。
 * 这里锁三点：
 * - 写入会广播（带 trackId 与 offsetMs）；
 * - 另一窗口的 hook 收到同曲目事件后立即改 offsetMs（不用等到切歌）；
 * - 别的曲目的事件不该污染当前曲目。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

type Payload = { trackId: string; offsetMs: number };

const h = vi.hoisted(() => ({
  /** 每个事件多个订阅者：真实 Tauri 支持一对多，mock 也必须是数组 */
  handlers: {} as Record<string, ((event: { payload: unknown }) => void)[]>,
  emits: [] as { event: string; payload: unknown }[],
  stored: new Map<string, number>(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    const list = h.handlers[event] ?? (h.handlers[event] = []);
    list.push(handler);
    return () => {
      const cur = h.handlers[event] ?? [];
      const i = cur.indexOf(handler);
      if (i >= 0) cur.splice(i, 1);
    };
  }),
  emit: vi.fn(async (event: string, payload: unknown) => {
    h.emits.push({ event, payload });
    // 真实 emit 会派发给本进程内所有订阅者（此处两个窗口共用一份 mock）
    for (const fn of [...(h.handlers[event] ?? [])]) fn({ payload });
  }),
}));

vi.mock("@/services/ipc", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/services/ipc");
  const eventApi = await import("@tauri-apps/api/event");
  return {
    ...actual,
    getLyricOffset: vi.fn(async (trackId: string) => h.stored.get(trackId) ?? 0),
    setLyricOffset: vi.fn(async (trackId: string, offsetMs: number) => {
      h.stored.set(trackId, offsetMs);
      await eventApi.emit("lyric-offset-changed", { trackId, offsetMs });
    }),
    onLyricOffsetChanged: (handler: (p: Payload) => void) =>
      eventApi.listen("lyric-offset-changed", (event) => handler(event.payload as Payload)),
  };
});

const { useLyricOffset } = await import("@/hooks/useLyricOffset");
const { onLyricOffsetChanged } = await import("@/services/ipc");
import type { Track } from "@/types";

function track(id = "id1"): Track {
  return {
    id,
    platform: "wyy",
    title: "t",
    singer: "s",
    album: "",
    picUrl: "",
    duration: 100,
    musicId: null,
  };
}

/** 等订阅注册完（onLyricOffsetChanged 的 listen 是异步的） */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  h.handlers = {};
  h.emits = [];
  h.stored.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("歌词偏移跨窗口同步", () => {
  it("一边提交偏移，另一窗口的 hook 立即跟着变（不用等切歌）", async () => {
    const t = track();
    // 「播放页」与「桌面歌词窗口」各挂一个 hook 实例
    const page = renderHook(() => useLyricOffset(t));
    const lyricWin = renderHook(() => useLyricOffset(t));
    await settle();

    expect(page.result.current.offsetMs).toBe(0);
    expect(lyricWin.result.current.offsetMs).toBe(0);

    await act(async () => {
      page.result.current.setDraftMs(1200);
    });
    await act(async () => {
      page.result.current.commit();
      await Promise.resolve();
    });

    expect(page.result.current.offsetMs).toBe(1200);
    // 关键：桌面歌词窗口同步跟上了（修复前这里是 0）
    expect(lyricWin.result.current.offsetMs).toBe(1200);
    expect(lyricWin.result.current.draftMs).toBe(1200);
    expect(h.emits.some((e) => e.event === "lyric-offset-changed")).toBe(true);
  });

  it("nudge / reset 也会广播并被另一窗口接收", async () => {
    const t = track();
    const a = renderHook(() => useLyricOffset(t));
    const b = renderHook(() => useLyricOffset(t));
    await settle();

    await act(async () => {
      a.result.current.nudge(-500);
      await Promise.resolve();
    });
    expect(b.result.current.offsetMs).toBe(-500);

    await act(async () => {
      a.result.current.reset();
      await Promise.resolve();
    });
    expect(b.result.current.offsetMs).toBe(0);
  });

  it("别的曲目的偏移变更不该影响当前曲目", async () => {
    const t = track();
    const win = renderHook(() => useLyricOffset(t));
    await settle();

    await act(async () => {
      const { emit } = await import("@tauri-apps/api/event");
      await emit("lyric-offset-changed", { trackId: "wyy:id2", offsetMs: 3000 });
    });
    expect(win.result.current.offsetMs).toBe(0);

    // 本曲目仍然要生效
    await act(async () => {
      const { emit } = await import("@tauri-apps/api/event");
      await emit("lyric-offset-changed", { trackId: "wyy:id1", offsetMs: 800 });
    });
    expect(win.result.current.offsetMs).toBe(800);
  });

  it("onLyricOffsetChanged 订阅的是 lyric-offset-changed，且可取消", async () => {
    let got: Payload | null = null;
    const un = await onLyricOffsetChanged((p) => {
      got = p;
    });
    expect((h.handlers["lyric-offset-changed"] ?? []).length).toBe(1);

    const { emit } = await import("@tauri-apps/api/event");
    await emit("lyric-offset-changed", { trackId: "wyy:id1", offsetMs: 7 });
    expect(got).toEqual({ trackId: "wyy:id1", offsetMs: 7 });

    un();
    expect(h.handlers["lyric-offset-changed"] ?? []).toHaveLength(0);
  });
});
