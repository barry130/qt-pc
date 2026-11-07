import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCollectChoice, buildCollectChoiceAsync, collectKey } from "@/lib/collect-choice";
import { findCrossSourceDup } from "@/lib/collect-dup";
import * as match from "@/lib/collect-match";
import cases from "./fixtures/collect-match.json";
import type { Track } from "@/types";

const song = (platform: string, id: string, title: string, singer = "Artist Name", album = "Album"): Track => ({
  platform, id, title, singer, album, picUrl: "", duration: 180,
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("collection preparation and candidate pruning", () => {
  it.each(cases)("preserves the shared rule: $label", ({ a, b, match: expected }) => {
    const left = song("qq", "left", a[0], a[1], a[2]);
    const right = song("wyy", "right", b[0], b[1], b[2]);
    for (const [existing, incoming] of [[left, right], [right, left]]) {
      expect(buildCollectChoice([existing], [incoming]).groups.length > 0).toBe(expected);
      expect(buildCollectChoice([existing], [{ ...incoming, platform: existing.platform }]).groups).toEqual([]);
    }
  });

  it("keeps the same candidates across insertion, deletion, substitution, short and long Unicode titles", () => {
    const titles = ["", "爱", "晴天之后", "abcdefgh", "abcdefghijklmnopqrst", "🎵一段音乐和回忆🎶", "x".repeat(256), "x".repeat(257)];
    for (const title of titles) {
      const left = song("qq", "left", title);
      const variants = [title, title.slice(1), "z" + title, title.slice(0, -1) + "z", title.slice(0, 3) + "XYZ" + title.slice(6), [...title].reverse().join("")];
      for (const variant of variants) {
        for (const singer of ["", "Artist Name", "Another Artist"]) {
          const right = song("wyy", "right", variant, singer);
          const expected = findCrossSourceDup(left, [right]).length > 0;
          expect(buildCollectChoice([left], [right]).groups.length > 0, `${title.length}: ${variant.length}: ${singer}`).toBe(expected);
        }
      }
    }
  });

  it("normalizes each input once and avoids edit distance when title characters cannot meet the threshold", () => {
    const prepare = vi.spyOn(match, "prepareCollectMatch");
    const compare = vi.spyOn(match, "compareCollectMatch");
    const existing = Array.from({ length: 1_000 }, (_, i) => song("qq", String(i), "qqqqqqqqqq"));
    const incoming = Array.from({ length: 30 }, (_, i) => song("wyy", String(i), "zzzzzzzzzz"));
    const plan = buildCollectChoice(existing, incoming);
    expect(plan.groups).toEqual([]);
    expect(plan.adds).toEqual(incoming);
    expect(prepare).toHaveBeenCalledTimes(existing.length + incoming.length);
    expect(compare).not.toHaveBeenCalled();
  });

  it("merges groups bridged by a later incoming version and preserves choice order and existing membership", () => {
    const a = song("qq", "a", "abcdefghij");
    const b = song("wyy", "b", "xxxxefghij");
    const first = { ...a, platform: "kw", id: "first" };
    const second = { ...b, platform: "kw", id: "second" };
    const bridge = song("kg", "bridge", "xxcdefghij");
    const plan = buildCollectChoice([a, b], [first, second, bridge, first]);
    expect(plan.groups).toEqual([{
      id: collectKey(bridge), songs: [bridge, a, b, first, second], existingKeys: [collectKey(a), collectKey(b)],
    }]);
    expect(plan.adds).toEqual([first, second, bridge]);
    expect(plan.removes).toEqual([]);
  });
});

describe("cooperative collection planning", () => {
  function forceTimeSlices(): void {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => { elapsed += 9; return elapsed; });
  }
  const existing = Array.from({ length: 512 }, (_, i) => song("qq", String(i), `歌曲编号${i}`));
  const incoming = existing.slice(0, 6).map(track => ({ ...track, platform: "wyy" }));

  it("lets queued work run before a large check finishes and returns the synchronous plan", async () => {
    forceTimeSlices();
    const heartbeat = vi.fn();
    setTimeout(heartbeat, 0);
    let done = false;
    const result = buildCollectChoiceAsync(existing, incoming, () => true).then(plan => { done = true; return plan; });
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersToNextTimerAsync();
    expect(heartbeat).toHaveBeenCalledOnce();
    expect(done).toBe(false);
    await vi.runAllTimersAsync();
    expect(await result).toEqual(buildCollectChoice(existing, incoming));
  });

  it("stops after the owning panel closes and does not prepare the rest of the playlist", async () => {
    forceTimeSlices();
    const prepare = vi.spyOn(match, "prepareCollectMatch");
    let active = true;
    const result = buildCollectChoiceAsync(existing, incoming, () => active);
    expect(prepare.mock.calls.length).toBeGreaterThan(0);
    expect(prepare.mock.calls.length).toBeLessThan(existing.length);
    const count = prepare.mock.calls.length;
    active = false;
    await vi.runAllTimersAsync();
    expect(await result).toBeNull();
    expect(prepare).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does no metadata work for an already cancelled check or empty incoming batch", async () => {
    const prepare = vi.spyOn(match, "prepareCollectMatch");
    expect(await buildCollectChoiceAsync(existing, incoming, () => false)).toBeNull();
    expect(await buildCollectChoiceAsync(existing, [], () => true)).toEqual({ groups: [], adds: [], removes: [] });
    expect(prepare).not.toHaveBeenCalled();
  });
});
