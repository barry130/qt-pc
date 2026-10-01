import { describe, expect, it } from "vitest";
import { HISTORY_MAX, mergeHistory } from "@/lib/search-history";

describe("mergeHistory", () => {
  it("新关键词置顶", () => {
    expect(mergeHistory(["a", "b"], "c")).toEqual(["c", "a", "b"]);
  });

  it("重复关键词去重并置顶（不产生重复项）", () => {
    expect(mergeHistory(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
  });

  it("首尾空白裁掉后再比较与存储", () => {
    expect(mergeHistory(["a"], "  a  ")).toEqual(["a"]);
    expect(mergeHistory(["a"], " b ")).toEqual(["b", "a"]);
  });

  it("空串 / 纯空白不入队", () => {
    expect(mergeHistory(["a"], "")).toEqual(["a"]);
    expect(mergeHistory(["a"], "   ")).toEqual(["a"]);
  });

  it("超出上限时最旧的滚出去", () => {
    // 新关键词置顶，数组末尾是最旧的 → 被截掉的是 k19
    const full = Array.from({ length: HISTORY_MAX }, (_, i) => `k${i}`);
    const next = mergeHistory(full, "new");
    expect(next).toHaveLength(HISTORY_MAX);
    expect(next[0]).toBe("new");
    expect(next).not.toContain("k19");
    expect(next).toContain("k0");
  });

  it("支持自定义上限（联想下拉等小容量场景）", () => {
    // 去重置顶后 [d,a,b,c]，截断到 2 条 → [d,a]
    expect(mergeHistory(["a", "b", "c"], "d", 2)).toEqual(["d", "a"]);
  });

  it("空历史起步", () => {
    expect(mergeHistory([], "x")).toEqual(["x"]);
  });
});
