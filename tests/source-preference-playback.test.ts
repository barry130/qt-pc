import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/types";

const io = vi.hoisted(() => ({ resolve: vi.fn(), invoke: vi.fn(), settings: new Map<string, string>() }));
vi.mock("@/source-scripts", () => ({ resolvePlayUrlDetailed: io.resolve }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: io.invoke }));
vi.mock("@/lib/source-quality", () => ({ sourcePlayQualityOf: (source: string) => source === "kw" ? "128" : "320" }));
vi.mock("@/stores/sourceRegistry", () => ({
  useSourceRegistryStore: { getState: () => ({
    sources: ["qq", "wyy", "kw"].map(id => ({ id, qualities: ["128", "320", "flac"] })),
    qualities: ["128", "320", "flac"].map(id => ({ id, name: id })),
    profiles: {},
  }) },
  qualityRanksOf: (qualities: { id: string }[]) => qualities.map(q => q.id).reverse(),
  normalizeQualityForSource: (_source: string, quality: string) => quality,
}));

import * as ipc from "@/services/ipc";
import { clearQualityCeilingCache, resolvePlayUrlWithFallback } from "@/lib/quality-fallback";
import { savePreferredSource, preferredSource } from "@/lib/preferred-source";
import { playUrlHitLine } from "@/source-scripts/playurl-line";

const track = (platform: string, id = "1"): Track => ({
  platform, id, title: "歌曲", singer: "歌手", album: "专辑", duration: 240, picUrl: "",
});
const hit = (url = "https://audio/selected") => ({ url, stalled: false, referer: "https://cdn/", size: 200000, actualQuality: "128" });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  clearQualityCeilingCache();
  io.settings.clear();
  io.invoke.mockImplementation(async (command: string, args?: { key?: string; value?: string }) => {
    if (command === "get_setting") return io.settings.get(args!.key!) ?? null;
    if (command === "set_setting") { io.settings.set(args!.key!, args!.value!); return; }
    return undefined;
  });
  io.resolve.mockReset().mockResolvedValue(hit());
});

describe("saved source playback", () => {
  it("resolves the saved track with its own quality, mirrors the original cache, and broadcasts the correct lyric target", async () => {
    const original = track("qq"), selected = track("kw");
    await savePreferredSource(original, selected);
    const resolved = await resolvePlayUrlWithFallback(original, "flac");
    expect(io.resolve).toHaveBeenCalledWith(selected, "128");
    expect(resolved.requestedQuality).toBe("128");
    expect(io.invoke).toHaveBeenCalledWith("set_resolved_play_url", {
      track: original, quality: "flac", url: "https://audio/selected", referer: "https://cdn/", size: 200000, actualQuality: "128",
    });
    expect(playUrlHitLine(original, "flac")).toMatchObject({ id: "cross:kw", targetSong: { id: selected.id } });
    expect(playUrlHitLine(original, resolved.quality)).toMatchObject({ id: "cross:kw" });
  });

  it("native queue and single-song IPC keep the original identity for exact downloaded-file lookup", async () => {
    const original = track("qq");
    await savePreferredSource(original, track("wyy"));
    await ipc.playQueue([original], 0, 10);
    await ipc.playTrack(original, "flac", 11);
    await ipc.queueAppend([original]);
    expect(io.invoke).toHaveBeenCalledWith("play_queue", { tracks: [original], startIndex: 0, playIntent: 10 });
    expect(io.invoke).toHaveBeenCalledWith("play_track", { track: original, quality: "flac", playIntent: 11 });
    expect(io.invoke).toHaveBeenCalledWith("queue_append", { tracks: [original] });
  });

  it("a preference change during an old URL request is resolved again with the new source", async () => {
    const original = track("qq"), second = track("wyy");
    let finish!: (value: ReturnType<typeof hit>) => void;
    io.resolve.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = resolvePlayUrlWithFallback(original, "320");
    await vi.waitFor(() => expect(io.resolve).toHaveBeenCalledTimes(1));
    await savePreferredSource(original, second);
    finish(hit("https://audio/old"));
    const result = await pending;
    expect(result.url).toBe("https://audio/selected");
    expect(io.resolve.mock.calls.at(-1)?.[0]).toEqual(second);
    expect(io.invoke.mock.calls.at(-1)?.[1]).toMatchObject({ track: original, url: "https://audio/selected" });
  });

  it("a temporary failure keeps the explicit preference for the next attempt", async () => {
    const original = track("qq"), selected = track("wyy");
    await savePreferredSource(original, selected);
    io.resolve.mockResolvedValue({ ...hit(""), stalled: true });
    expect((await resolvePlayUrlWithFallback(original, "320")).stalled).toBe(true);
    expect(await preferredSource(original)).toEqual(selected);
  });
});
