import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, resolvePlayUrl } = vi.hoisted(() => ({
  invoke: vi.fn(),
  resolvePlayUrl: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/lib/quality-fallback", () => ({
  normalizeQualityForSource: (_platform: string, quality: string) => quality,
  peekQualityCeiling: () => null,
  resolvePlayUrlWithFallback: resolvePlayUrl,
}));
vi.mock("@/lib/source-quality", () => ({ sourcePlayQualityOf: () => "320" }));

import { usePlayerStore } from "@/stores/player";
import type { Track } from "@/types";

function track(id: string, platform = "wyy"): Track {
  return { id, platform, title: id, singer: "synthetic", album: "", picUrl: "", duration: 240 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  invoke.mockReset();
  resolvePlayUrl.mockReset();
  usePlayerStore.setState({
    state: null, queue: [], queueIndex: null, positionMs: 0,
    durationMs: 0, bufferedMs: 0, pendingSeekMs: null, pendingSeekAt: 0,
    positionAnchorMs: 0, positionAnchorValue: 0, isDraggingProgress: false,
  });
});

describe("C03 原票取消", () => {
  it("A 的预解析被 B 超越后，取消原 A 票而不发送 A 的整队替换", async () => {
    const held = deferred<{ url: string; quality: "320" }>();
    const entered = deferred<void>();
    resolvePlayUrl.mockImplementation(() => { entered.resolve(); return held.promise; });
    let nextTicket = 73;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "begin_play_intent") return Promise.resolve(nextTicket++);
      if (cmd === "play_queue") {
        return Promise.resolve({ applied: true, target: { generation: 74, platform: "local", id: "b" } });
      }
      if (cmd === "abandon_play_intent") return Promise.resolve(undefined);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    const original = usePlayerStore.getState().playQueue([track("a")], 0);
    await entered.promise;
    const latest = await usePlayerStore.getState().playQueue([track("b", "local")], 0);
    expect(latest).toMatchObject({ applied: true, target: { generation: 74, id: "b" } });
    held.resolve({ url: "https://audio.example.test/a.mp3", quality: "320" });
    await expect(original).resolves.toMatchObject({ applied: false, target: null });

    // B 的 finally 已先取消自身 74；释放旧 A 后只能追加原 A 的 73，不能再次取消 B。
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "abandon_play_intent")).toEqual([
      ["abandon_play_intent", { playIntent: 74 }],
      ["abandon_play_intent", { playIntent: 73 }],
    ]);
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "play_queue")).toEqual([
      ["play_queue", { tracks: [track("b", "local")], startIndex: 0, playIntent: 74 }],
    ]);
  });

  it.each(["play", "playQueue", "playAt", "nextTrack", "prevTrack"] as const)(
    "%s 的实际播放 IPC 失败时，保留原错误并取消原票",
    async (action) => {
      const failure = new Error("synthetic-playback-IPC-failure");
      const local = track("failed", "local");
      usePlayerStore.setState({ queue: [local], queueIndex: 0 });
      invoke.mockImplementation((cmd: string) => {
        if (cmd === "begin_play_intent") return Promise.resolve(101);
        if (cmd === "abandon_play_intent") return Promise.resolve(undefined);
        return Promise.reject(failure);
      });
      const store = usePlayerStore.getState();
      const actions = {
        play: () => store.play(local),
        playQueue: () => store.playQueue([local], 0),
        playAt: () => store.playAt(0),
        nextTrack: () => store.nextTrack(),
        prevTrack: () => store.prevTrack(),
      };
      await expect(actions[action]()).rejects.toBe(failure);
      expect(invoke.mock.calls.filter(([cmd]) => cmd === "abandon_play_intent")).toEqual([
        ["abandon_play_intent", { playIntent: 101 }],
      ]);
    },
  );

  it.each(["reject", "throw"] as const)("取消 IPC %s 不覆盖已接受回执", async (mode) => {
    const local = track("accepted", "local");
    const target = { generation: 201, platform: "local", id: local.id };
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "begin_play_intent") return Promise.resolve(201);
      if (cmd === "play_queue") return Promise.resolve({ applied: true, target });
      if (cmd === "abandon_play_intent") {
        const error = new Error("synthetic-abandon-IPC-failure");
        if (mode === "throw") throw error;
        return Promise.reject(error);
      }
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    await expect(usePlayerStore.getState().playQueue([local], 0)).resolves.toMatchObject({
      applied: true, target,
    });
    expect(invoke).toHaveBeenCalledWith("abandon_play_intent", { playIntent: 201 });
  });

  it("取消 IPC 未完成时，原播放回执仍立即完成", async () => {
    const pending = deferred<void>();
    const entered = deferred<void>();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "begin_play_intent") return Promise.resolve(202);
      if (cmd === "play_queue") return Promise.resolve({ applied: true, target: null });
      if (cmd === "abandon_play_intent") { entered.resolve(); return pending.promise; }
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    const action = usePlayerStore.getState().playQueue([track("accepted", "local")], 0);
    await entered.promise;
    try {
      const completed = await Promise.race([
        action.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 0)),
      ]);
      expect(completed).toBe(true);
      await expect(action).resolves.toMatchObject({ applied: true, target: null });
    } finally {
      pending.resolve();
    }
  });
});
