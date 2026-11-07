// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { Track } from "@/types";

const io = vi.hoisted(() => ({
  peek: vi.fn(), search: vi.fn(), clear: vi.fn(), getState: vi.fn(),
  invoke: vi.fn(), write: vi.fn(), settings: new Map<string, string>(),
}));
vi.mock("@/lib/source-switch", () => ({ peekSourceCandidates: io.peek, findSourceCandidates: io.search }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: io.invoke }));
vi.mock("@/stores/player", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/player")>()),
  usePlayerStore: { getState: io.getState },
}));
vi.mock("@/components/common/SourceTag", () => ({ SourceTag: ({ platform }: { platform: string }) => <span>{platform}</span> }));

import { SourceSwitchPanel, replaceCurrentWithCandidate } from "@/components/player/SourceSwitchPanel";
import { preferredSource } from "@/lib/preferred-source";

const track = (platform: string, id = "1"): Track => ({
  id, platform, title: platform === "qq" ? "原曲" : "新版本" + id, singer: "歌手", album: "专辑", picUrl: "", duration: 200,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  io.clear.mockResolvedValue({ clearedCount: 1 });
  io.settings.clear();
  io.write.mockImplementation(async (key: string, value: string) => { io.settings.set(key, value); });
  io.invoke.mockImplementation(async (command: string, args?: { key: string; value?: string }) => {
    if (command === "get_setting") return io.settings.get(args!.key) ?? null;
    if (command === "set_setting") return io.write(args!.key, args!.value);
    if (command === "clear_play_url_cache") return io.clear();
    if (command === "begin_play_intent") return 1;
    if (command === "abandon_play_intent") return;
    throw new Error(`Unexpected final native IPC: ${command}`);
  });
  io.peek.mockReturnValue([{ track: track("wyy"), score: 100 }]);
});

describe("manual source choice", () => {
  it("saves the original identity once, invalidates old native URLs, then applies the chosen track", async () => {
    const original = track("qq"), candidate = track("wyy"), onPick = vi.fn();
    // Preserve the once-only durable-write invariant at its documented owner.
    const storageWrite = io.write;
    const ui = render(<SourceSwitchPanel track={original} onPick={onPick} />);
    fireEvent.click(ui.getByText(candidate.title));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(candidate, original, expect.any(Promise)));
    expect(storageWrite.mock.calls.filter(([_key, value]) => value.startsWith("["))).toHaveLength(1);
    expect(await preferredSource(original)).toEqual(candidate);
    expect(io.clear).toHaveBeenCalledTimes(1);
    storageWrite.mockClear();
  });

  it("does not play when preference persistence fails", async () => {
    const onPick = vi.fn(), write = io.write.mockRejectedValueOnce(new Error("存储失败"));
    const ui = render(<SourceSwitchPanel track={track("qq")} onPick={onPick} />);
    fireEvent.click(ui.getByText("新版本1"));
    await ui.findByText(/存储失败/);
    expect(onPick).not.toHaveBeenCalled();
    expect(io.clear).not.toHaveBeenCalled();
    write.mockClear();
  });

  it("a late refresh or page result cannot replace candidates for a new track", async () => {
    const oldRequest = deferred<{ track: Track; score: number }[]>();
    io.search.mockReturnValueOnce(oldRequest.promise);
    io.peek.mockImplementation((source: Track) => [{ track: track("wyy", source.id), score: 100 }]);
    const ui = render(<SourceSwitchPanel track={track("qq", "1")} onPick={() => {}} />);
    fireEvent.click(ui.getByText("重新搜索"));
    ui.rerender(<SourceSwitchPanel track={track("qq", "2")} onPick={() => {}} />);
    await act(async () => { oldRequest.resolve([{ track: track("kw", "old"), score: 100 }]); });
    expect(ui.queryByText("新版本old")).toBeNull();
    expect(ui.getByText("新版本2")).toBeTruthy();

    const pageRequest = deferred<{ track: Track; score: number }[]>();
    io.peek.mockReturnValue(Array.from({ length: 5 }, (_, index) => ({ track: track("wyy", String(index + 10)), score: 100 })));
    ui.rerender(<SourceSwitchPanel track={track("qq", "3")} onPick={() => {}} />);
    io.search.mockReturnValueOnce(pageRequest.promise);
    fireEvent.click(ui.getByText("加载更多"));
    io.peek.mockReturnValue([{ track: track("wyy", "final"), score: 100 }]);
    ui.rerender(<SourceSwitchPanel track={track("qq", "4")} onPick={() => {}} />);
    await act(async () => { pageRequest.resolve([{ track: track("kw", "late"), score: 100 }]); });
    expect(ui.queryByText("新版本late")).toBeNull();
    expect(ui.getByText("新版本final")).toBeTruthy();
  });

  it("dispatches the original choice immediately with a cleanup dependency, without saving a new track's preference", async () => {
    const cacheClear = deferred<{ clearedCount: number }>(), onPick = vi.fn();
    io.clear.mockReturnValueOnce(cacheClear.promise);
    const ui = render(<SourceSwitchPanel track={track("qq", "1")} onPick={onPick} />);
    fireEvent.click(ui.getByText("新版本1"));
    // Native settings have acknowledged, but cleanup is still deliberately
    // pending: dispatch must not wait for cleanup or change its exact promise.
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(track("wyy"), track("qq", "1"), cacheClear.promise));
    ui.rerender(<SourceSwitchPanel track={track("qq", "2")} onPick={onPick} />);
    await act(async () => { cacheClear.resolve({ clearedCount: 1 }); });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(await preferredSource(track("qq", "2"))).toBeNull();
  });

  it("preserves queue position and seeks with the applied native ticket; stale origins do nothing", async () => {
    const original = track("qq"), candidate = track("wyy"), next = track("qq", "2");
    const target = { generation: 4, platform: "wyy", id: candidate.id };
    const playQueue = vi.fn().mockResolvedValue({ applied: true, ticket: 8, target }), seekTo = vi.fn();
    io.getState.mockReturnValue({ queue: [original, next], queueIndex: 0, state: { track: original }, positionMs: 92000, playQueue, seekTo });
    await replaceCurrentWithCandidate(candidate, original);
    expect(playQueue).toHaveBeenCalledWith([candidate, next], 0);
    expect(seekTo).toHaveBeenCalledWith(92000, 8, target);
    io.getState.mockReturnValue({ queue: [next], queueIndex: 0, state: { track: next }, positionMs: 0, playQueue, seekTo });
    playQueue.mockClear();
    await replaceCurrentWithCandidate(candidate, original);
    expect(playQueue).not.toHaveBeenCalled();
  });
});
