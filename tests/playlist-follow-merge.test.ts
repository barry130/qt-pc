import { describe, expect, it } from "vitest";
import { mergeFollow } from "../src/lib/playlist-follow-merge";

describe("source follow membership", () => {
  it("preserves user removals/additions and appends source additions", () => {
    expect(mergeFollow(["a", "b", "c"], ["a", "b", "c", "d"], ["a", "x", "c"]))
      .toEqual({ add: ["d"], remove: [], baseline: ["a", "b", "c", "d"], suppressed: ["b"] });
  });
  it("does not resurrect a locally deleted song after source removes and re-adds it", () => {
    const first = mergeFollow(["a", "b"], ["a"], ["a"]);
    const second = mergeFollow(first.baseline, ["a", "b"], ["a"], first.suppressed);
    expect(second.add).toEqual([]);
  });
  it("protects pre-existing target members and removes source-owned vanished songs", () => {
    expect(mergeFollow(["a", "b"], [], ["a", "b", "x"], [], ["a"]).remove).toEqual(["b"]);
  });
  it("establishes an old import baseline without any mutations", () => {
    const value = mergeFollow(null, ["a", "b"], ["x"]);
    expect(value.add).toEqual([]); expect(value.remove).toEqual([]);
  });
  it("explicit local re-add clears suppression, and a repeated merge is idempotent", () => {
    expect(mergeFollow(["a"], ["a", "b"], ["a", "b"], ["b"]).suppressed).toEqual([]);
    expect(mergeFollow(["a", "b"], ["a", "b", "b"], ["b", "a"]).add).toEqual([]);
  });
});
