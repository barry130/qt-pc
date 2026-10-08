/**
 * 手动换词的跨窗口同步（2026-10-08）。
 *
 * 背景：播放页与桌面歌词窗口是两个独立 WebView，`localOnline` 的歌词 LRU 各自持一份
 * 实例。用户在播放页「搜索歌词」里挑中一份候选后，播放页自己 set state 就变了，
 * 桌面歌词窗口那条旧 Promise 还躺在它自己的缓存里 —— 用户看到的就是「主页面换了，
 * 桌面歌词还是旧词」。
 *
 * 修法与 `lyric-offset-changed` 同一套路：落库后广播 `lyric-manually-picked`（只带
 * trackId + 源头，不搬正文），订阅方丢掉自己那份缓存再重取。这里钉三点：
 *   - 选中会广播（带 trackId 与选中的源）；
 *   - 落库失败也要广播（另一窗口自己回读，少这一次广播会永久不一致）；
 *   - 订阅方丢缓存后重取拿的是新词（不丢就命中旧 Promise = 换了没反应）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Payload = { trackId: string; source: string };

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, ((event: { payload: unknown }) => void)[]>,
  emits: [] as { event: string; payload: unknown }[],
  saved: [] as unknown[][],
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
    for (const fn of [...(h.handlers[event] ?? [])]) fn({ payload });
  }),
}));

vi.mock("@/source-scripts", () => ({
  getLyric: vi.fn(),
  searchMusic: vi.fn(),
  toAppTrack: vi.fn(),
}));

vi.mock("@/services/ipc", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/services/ipc");
  return {
    ...actual,
    saveLyric: vi.fn(async (...args: unknown[]) => {
      h.saved.push(args);
    }),
    getLyric: vi.fn(async () => null),
  };
});

import { getLyric as sourceGetLyric } from "@/source-scripts";
import {
  applyPickedLyric,
  dropCachedLyric,
  getPlaybackLyric,
  type LyricCandidate,
} from "@/lib/localOnline";
import { onLyricManuallyPicked } from "@/services/ipc";
import type { Lyric, Track } from "@/types";

const sourceGetLyricMock = vi.mocked(sourceGetLyric);

let seq = 0;
function track(): Track {
  seq += 1;
  return {
    id: `id${seq}`,
    platform: "qq",
    title: "t",
    singer: "s",
    album: "",
    picUrl: "",
    duration: 100,
    musicId: null,
  };
}

const lyric = (lrc: string): Lyric => ({ lrc, translation: "" });

/** 手动派发一次事件（模拟另一窗口 emit 过来的广播） */
async function dispatch(payload: Payload): Promise<void> {
  const { emit } = await import("@tauri-apps/api/event");
  await emit("lyric-manually-picked", payload);
}

beforeEach(() => {
  h.handlers = {};
  h.emits = [];
  h.saved = [];
  sourceGetLyricMock.mockReset();
});

describe("手动换词的广播", () => {
  it("选中后广播 lyric-manually-picked，带 trackId 与选中的源", async () => {
    const t = track();
    await applyPickedLyric(t, null, { track: t, lyric: lyric("[00:01.00]新词"), source: "kw" });

    const evt = h.emits.find((e) => e.event === "lyric-manually-picked");
    expect(evt).toEqual({ event: "lyric-manually-picked", payload: { trackId: `qq:${t.id}`, source: "kw" } });
  });

  it("落库失败也照常广播（另一窗口自己回读，不落这一条会永久不一致）", async () => {
    const { saveLyric } = await import("@/services/ipc");
    vi.mocked(saveLyric).mockRejectedValueOnce(new Error("db down"));

    const t = track();
    await expect(
      applyPickedLyric(t, null, { track: t, lyric: lyric("[00:01.00]词"), source: "kg" }),
    ).resolves.toBeUndefined();
    expect(h.emits.some((e) => e.event === "lyric-manually-picked")).toBe(true);
  });
});

describe("桌面歌词窗口的重取", () => {
  it("丢掉自己那份缓存后重取，拿到的是新词（不丢就命中旧 Promise）", async () => {
    const t = track();
    sourceGetLyricMock.mockResolvedValueOnce(lyric("[00:01.00]旧词"));
    await expect(getPlaybackLyric(t)).resolves.toEqual(lyric("[00:01.00]旧词"));
    // 不丢缓存：还是旧词（这就是修复前桌面歌词的表现）
    await expect(getPlaybackLyric(t)).resolves.toEqual(lyric("[00:01.00]旧词"));

    dropCachedLyric(t, null);
    sourceGetLyricMock.mockResolvedValueOnce(lyric("[00:01.00]新词"));
    await expect(getPlaybackLyric(t)).resolves.toEqual(lyric("[00:01.00]新词"));
  });

  it("连换两次：两路重取叠加时以最后一次为准（桌面歌词不会跳回第一份）", async () => {
    const t = track();
    sourceGetLyricMock.mockResolvedValueOnce(lyric("[00:01.00]第一份"));
    await getPlaybackLyric(t);

    const candidate: LyricCandidate = { track: t, lyric: lyric("[00:01.00]第二份"), source: "kw" };
    dropCachedLyric(t, null);
    sourceGetLyricMock.mockResolvedValueOnce(lyric("[00:01.00]第二份"));
    const second = getPlaybackLyric(t);
    await applyPickedLyric(t, null, candidate);
    await expect(second).resolves.toEqual(lyric("[00:01.00]第二份"));
    // 应用后的缓存就是用户选的那份
    await expect(getPlaybackLyric(t)).resolves.toEqual(candidate.lyric);
  });
});

describe("onLyricManuallyPicked 订阅", () => {
  it("订阅的是 lyric-manually-picked，可收到载荷也可取消", async () => {
    const got: Payload[] = [];
    const un = await onLyricManuallyPicked((p) => {
      got.push(p);
    });
    expect((h.handlers["lyric-manually-picked"] ?? []).length).toBe(1);

    await dispatch({ trackId: "qq:id1", source: "kw" });
    expect(got).toEqual([{ trackId: "qq:id1", source: "kw" }]);

    un();
    expect(h.handlers["lyric-manually-picked"] ?? []).toHaveLength(0);
  });
});
