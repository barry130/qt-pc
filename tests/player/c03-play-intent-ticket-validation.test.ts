// C03：原生代次票必须是「正的安全整数」。
//
// begin_play_intent 的回执经 IPC 反序列化而来，测试替身/桥接层也可能给出
// undefined、null、NaN、0、负数、非整数或超出 Number.MAX_SAFE_INTEGER 的值。
// 这些都不是有效票：若当成「无票」继续走旧载荷，等于在 preResolve 窗口重新
// 打开 C03 漏洞（Native 会把晚到的无票动作当成最新意图）。有效票才允许
// preResolve 和实际播放 IPC；非法值一律 fail closed。
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { resolvePlayUrl } = vi.hoisted(() => ({ resolvePlayUrl: vi.fn() }));
vi.mock("@/lib/quality-fallback", () => ({
  normalizeQualityForSource: (_platform: string, quality: string) => quality,
  peekQualityCeiling: () => null,
  resolvePlayUrlWithFallback: resolvePlayUrl,
}));
vi.mock("@/lib/source-quality", () => ({ sourcePlayQualityOf: () => "320" }));

import { usePlayerStore } from "@/stores/player";
import type { Track } from "@/types";

function track(id: string): Track {
  return {
    id,
    platform: "wyy",
    title: `歌曲 ${id}`,
    singer: "歌手",
    album: "专辑",
    picUrl: "",
    duration: 240,
  };
}

const INVALID_TICKETS: Array<[string, unknown]> = [
  ["undefined", undefined],
  ["null", null],
  ["NaN", Number.NaN],
  ["0", 0],
  ["负数", -3],
  ["小数", 1.5],
  ["超出安全整数", Number.MAX_SAFE_INTEGER + 1],
];

function mockBeginTicket(ticket: unknown): void {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "begin_play_intent") return Promise.resolve(ticket);
    if (cmd === "play_queue") return Promise.resolve({ applied: true, target: null });
    return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
  });
}

beforeEach(() => {
  invoke.mockReset();
  resolvePlayUrl.mockReset();
  resolvePlayUrl.mockResolvedValue({ url: "http://example.test/a.mp3", quality: "320" });
  usePlayerStore.setState({
    state: null,
    positionMs: 0,
    durationMs: 0,
    bufferedMs: 0,
    queue: [],
    queueIndex: null,
    pendingSeekMs: null,
    pendingSeekAt: 0,
    positionAnchorMs: 0,
    positionAnchorValue: 0,
    isDraggingProgress: false,
  });
});

describe("C03 原生代次票的有效性边界", () => {
  it.each(INVALID_TICKETS)("非法票 %s：不预解析、不发实际 IPC", async (_label, ticket) => {
    mockBeginTicket(ticket);

    const result = await usePlayerStore.getState().playQueue([track("a")], 0);

    expect(result).toMatchObject({ applied: false, target: null });
    expect(resolvePlayUrl).not.toHaveBeenCalled();
    expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual(["begin_play_intent"]);
  });

  it.each([1, Number.MAX_SAFE_INTEGER])("有效票 %s：原样随 play_queue 上传", async (ticket) => {
    mockBeginTicket(ticket);

    const result = await usePlayerStore.getState().playQueue([track("a")], 0);

    expect(result).toMatchObject({ applied: true, target: null });
    expect(resolvePlayUrl).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("play_queue", {
      tracks: [track("a")],
      startIndex: 0,
      playIntent: ticket,
    });
  });
});
