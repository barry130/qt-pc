/**
 * 手动换源（lib/source-switch.ts）：评分口径与包侧 pickBestMatch 一致
 * （同名 +10 / 包含 +5；歌手同名 +6 / 包含 +3），聚合搜索做同源剔除、
 * 跨源去重、0 分剔除、按分降序。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/source-scripts", () => ({
  searchAllBatches: vi.fn(async () => []),
}));

import {
  clearSourceSwitchCache,
  findSourceCandidates,
  normalizeMatchText,
  scoreCandidate,
} from "@/lib/source-switch";
import { searchAllBatches } from "@/source-scripts";
import type { Track } from "@/types";

function track(platform: string, title: string, singer: string, id = title): Track {
  return { id, platform, title, singer, album: "", picUrl: "", duration: 0, musicId: null };
}

const WANT = track("kuwo", "稻香", "周杰伦");

describe("换源：匹配文本归一化", () => {
  it("小写 + 折叠空白", () => {
    expect(normalizeMatchText("Dao  Xiang")).toBe("daoxiang");
    expect(normalizeMatchText("周杰伦 FEAT. someone")).toBe("周杰伦feat.someone");
  });
});

describe("换源：候选评分（与 pickBestMatch 同口径）", () => {
  it("同名 +10 / 包含 +5", () => {
    expect(scoreCandidate(track("kugou", "稻香", "某人"), WANT)).toBe(10);
    expect(scoreCandidate(track("kugou", "稻香 (Live)", "某人"), WANT)).toBe(5);
    expect(scoreCandidate(track("kugou", "香料", "某人"), WANT)).toBe(0);
  });

  it("歌手同名 +6 / 包含 +3；都没有则 0", () => {
    expect(scoreCandidate(track("kugou", "稻香", "周杰伦"), WANT)).toBe(16);
    expect(scoreCandidate(track("kugou", "稻香", "周杰伦 / 林妙可"), WANT)).toBe(13);
    expect(scoreCandidate(track("kugou", "完全无关", "完全无关的人"), WANT)).toBe(0);
  });

  it("歌名或歌手为空不算匹配", () => {
    expect(scoreCandidate(track("kugou", "", "周杰伦"), WANT)).toBe(0);
    expect(scoreCandidate(track("kugou", "稻香", ""), WANT)).toBe(10);
  });
});

describe("换源：聚合搜索候选", () => {
  // 结果是进程内缓存的（同一首歌二次打开复用），用例间必须清掉，
  // 否则上一个用例的结果会被下一个用例命中
  beforeEach(() => {
    clearSourceSwitchCache();
  });

  it("空关键词直接返回空数组，不打搜索", async () => {
    expect(await findSourceCandidates(track("kuwo", "", ""))).toEqual([]);
    expect(searchAllBatches).not.toHaveBeenCalled();
  });

  it("同源剔除、跨源去重、0 分剔除、按分降序", async () => {
    vi.mocked(searchAllBatches).mockResolvedValueOnce([
      {
        source: "kugou",
        tracks: [
          track("kugou", "稻香", "周杰伦", "k1"), // +16
          track("kuwo", "稻香", "周杰伦", "self"), // 同源剔除
          track("kugou", "稻香", "周杰伦", "k1"), // 跨源去重（同 kugou:k1）
          track("kugou", "完全无关", "完全无关的人", "k2"), // 0 分剔除
        ],
      },
      {
        source: "migu",
        tracks: [track("migu", "稻香", "周杰伦", "m1")], // +16，同分稳定在后面
      },
    ]);
    const res = await findSourceCandidates(WANT);
    expect(res.map((it) => `${it.track.platform}:${it.track.id}`)).toEqual(["kugou:k1", "migu:m1"]);
    expect(res.every((it) => it.score > 0)).toBe(true);
  });

  it("候选上限 20", async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      track("kugou", `稻香${i}`, "周杰伦", `k${i}`),
    );
    vi.mocked(searchAllBatches).mockResolvedValueOnce([{ source: "kugou", tracks: many }]);
    const res = await findSourceCandidates(WANT);
    expect(res).toHaveLength(20);
  });

  it("搜索失败时抛错由调用方展示", async () => {
    vi.mocked(searchAllBatches).mockRejectedValueOnce(new Error("网络不可用"));
    await expect(findSourceCandidates(WANT)).rejects.toThrow("网络不可用");
  });

  it("同一首歌第二次取用缓存，不再打搜索", async () => {
    vi.mocked(searchAllBatches).mockResolvedValue([
      { source: "kugou", tracks: [track("kugou", "稻香", "周杰伦", "k1")] },
    ]);
    const first = await findSourceCandidates(WANT);
    const callsAfterFirst = vi.mocked(searchAllBatches).mock.calls.length;
    const second = await findSourceCandidates(WANT);
    expect(second).toEqual(first);
    expect(vi.mocked(searchAllBatches).mock.calls.length).toBe(callsAfterFirst);
  });

  it("force 才真正重搜一次", async () => {
    vi.mocked(searchAllBatches).mockResolvedValue([
      { source: "kugou", tracks: [track("kugou", "稻香", "周杰伦", "k1")] },
    ]);
    await findSourceCandidates(WANT);
    const before = vi.mocked(searchAllBatches).mock.calls.length;
    await findSourceCandidates(WANT, { force: true });
    expect(vi.mocked(searchAllBatches).mock.calls.length).toBe(before + 1);
  });

  it("不同歌各存一份，互不串味", async () => {
    vi.mocked(searchAllBatches)
      .mockResolvedValueOnce([{ source: "kugou", tracks: [track("kugou", "稻香", "周杰伦", "k1")] }])
      .mockResolvedValueOnce([{ source: "migu", tracks: [track("migu", "晴天", "周杰伦", "m1")] }]);
    const a = await findSourceCandidates(WANT);
    const b = await findSourceCandidates(track("kuwo", "晴天", "周杰伦", "2"));
    expect(a.map((it) => it.track.id)).toEqual(["k1"]);
    expect(b.map((it) => it.track.id)).toEqual(["m1"]);
  });
});
