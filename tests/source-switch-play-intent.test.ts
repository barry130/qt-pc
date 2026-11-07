import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/types";

const io = vi.hoisted(() => ({ invoke: vi.fn(), resolve: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: io.invoke }));
vi.mock("@/lib/quality-fallback", () => ({
  normalizeQualityForSource: (_source: string, quality: string) => quality,
  peekQualityCeiling: () => null,
  resolvePlayUrlWithFallback: io.resolve,
}));
vi.mock("@/lib/source-quality", () => ({ sourcePlayQualityOf: () => "320" }));
import { usePlayerStore } from "@/stores/player";

const song = (id: string): Track => ({ id, platform: "wyy", title: id, singer: "歌手", album: "", picUrl: "", duration: 240 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
beforeEach(() => {
  vi.clearAllMocks();
  io.resolve.mockResolvedValue({ url: "https://audio/selected", quality: "320" });
});

describe("source switch readiness uses the original play intent", () => {
  it("registers the intent before waiting for cache cleanup and only then resolves audio", async () => {
    const ready = deferred<void>();
    io.invoke.mockImplementation(async command => command === "begin_play_intent" ? 11 : command === "play_queue" ? { applied: true, target: null } : undefined);
    const pending = usePlayerStore.getState().playQueue([song("chosen")], 0, ready.promise);
    await flush();
    expect(io.invoke).toHaveBeenCalledWith("begin_play_intent");
    expect(io.resolve).not.toHaveBeenCalled();
    ready.resolve(); await pending;
    expect(io.resolve).toHaveBeenCalled();
    expect(io.invoke).toHaveBeenCalledWith("play_queue", { tracks: [song("chosen")], startIndex: 0, playIntent: 11 });
  });

  it("a newer web playback request supersedes a source switch waiting on cleanup", async () => {
    const ready = deferred<void>();
    let ticket = 20;
    io.invoke.mockImplementation(async command => command === "begin_play_intent" ? ticket++ : command === "play_queue" ? { applied: true, target: null } : undefined);
    const old = usePlayerStore.getState().playQueue([song("old")], 0, ready.promise);
    await flush();
    await usePlayerStore.getState().playQueue([song("new")], 0);
    ready.resolve();
    expect((await old).applied).toBe(false);
    const commits = io.invoke.mock.calls.filter(([command]) => command === "play_queue");
    expect(commits).toHaveLength(1);
    expect(commits[0][1]).toMatchObject({ tracks: [song("new")] });
  });

  it("a newer native playback intent during cleanup rejects the original ticket instead of being overwritten", async () => {
    const ready = deferred<void>();
    let nativeIntent = 30;
    io.invoke.mockImplementation(async (command, args: { playIntent?: number } | undefined) => {
      if (command === "begin_play_intent") return nativeIntent;
      if (command === "play_queue") return { applied: args?.playIntent === nativeIntent, target: null };
      return undefined;
    });
    const old = usePlayerStore.getState().playQueue([song("chosen")], 0, ready.promise);
    await flush();
    // Model a Native next/previous/play request, which really begins a newer
    // gate intent. Unbound Native Pause does not revoke pending tickets; this
    // controlled final reply must not be presented as proof that Pause does.
    nativeIntent++;
    ready.resolve();
    expect((await old).applied).toBe(false);
    expect(io.invoke).toHaveBeenCalledWith("play_queue", { tracks: [song("chosen")], startIndex: 0, playIntent: 30 });
  });

  it("cleanup failure abandons the original intent without committing a queue", async () => {
    io.invoke.mockImplementation(async command => command === "begin_play_intent" ? 40 : undefined);
    await expect(usePlayerStore.getState().playQueue([song("chosen")], 0, Promise.reject(new Error("cleanup failed")))).rejects.toThrow("cleanup failed");
    expect(io.invoke.mock.calls.some(([command]) => command === "play_queue")).toBe(false);
    expect(io.invoke).toHaveBeenCalledWith("abandon_play_intent", { playIntent: 40 });
  });
});
