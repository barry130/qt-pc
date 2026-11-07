// C03：开始登记（begin_play_intent）失败时，整条播放动作必须 fail closed。
//
// 前后端同捆绑：PC 的后端一定实现了 begin_play_intent。若前端在这里 catch 后
// 继续沿用无票的旧载荷，等于在 preResolve 窗口重新打开 C03 漏洞 —— 原生媒体键
// 可能在预解析期间换了歌，而这次「无票」的旧动作晚到后会被 Native 当成最新
// 播放意图。所以登记失败 = 这次动作不成立：不预解析、不发任何实际播放 IPC。
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

describe("C03 begin_play_intent 失败时 fail closed", () => {
  it("登记失败：零预解析、零实际播放 IPC，playQueue 返回 applied=false/target=null", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "begin_play_intent"
        ? Promise.reject(new Error("ipc down"))
        : Promise.reject(new Error(`unexpected invoke: ${cmd}`)),
    );

    const result = await usePlayerStore.getState().playQueue([track("a"), track("b")], 0);

    expect(result).toEqual({ applied: false, ticket: 1, target: null });
    expect(resolvePlayUrl).not.toHaveBeenCalled();
    expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual(["begin_play_intent"]);
  });
});
