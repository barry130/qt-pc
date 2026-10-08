/**
 * 收藏查重（lib/collect-dup.ts）：目标歌单里已有「同名不同源」的歌时报警。
 *
 * 判定要与换源（lib/source-switch.ts 的 scoreCandidate）保持同口径的归一化，
 * 但这里只关心「是不是同名」，不打分 —— 所以翻唱（同名不同歌手）不算重复，
 * 同平台同名也不算（那是同一首歌，收藏本身幂等）。
 */
import { describe, expect, it } from "vitest";

import { findCrossSourceDup } from "@/lib/collect-dup";
import type { Track } from "@/types";

function track(platform: string, title: string, singer: string): Track {
  return {
    id: `${platform}:${title}`,
    platform,
    title,
    singer,
    album: "",
    picUrl: "",
    duration: 0,
    musicId: null,
  };
}

describe("收藏查重：同名不同源", () => {
  it("同名、不同源 → 冲突", () => {
    const want = track("qq", "稻香", "周杰伦");
    const existing = [track("wyy", "稻香", "周杰伦")];
    expect(findCrossSourceDup(want, existing).map((t) => t.platform)).toEqual(["wyy"]);
  });

  it("同名、同平台 → 不算冲突（同一首歌，收藏幂等）", () => {
    const want = track("qq", "稻香", "周杰伦");
    expect(findCrossSourceDup(want, [track("qq", "稻香", "周杰伦")])).toEqual([]);
  });

  it("歌名不同 → 不冲突", () => {
    const want = track("qq", "稻香", "周杰伦");
    expect(findCrossSourceDup(want, [track("wyy", "青花瓷", "周杰伦")])).toEqual([]);
  });

  it("同名但歌手对不上（翻唱）→ 不冲突", () => {
    const want = track("qq", "稻香", "周杰伦");
    expect(findCrossSourceDup(want, [track("wyy", "稻香", "蔡依林")])).toEqual([]);
  });

  it("歌手一边有多个 / 带空格大小写差异，只要有包含关系就算同一首", () => {
    const want = track("qq", "稻香", "周杰伦");
    const existing = [track("wyy", "稻香", "周杰伦 / 林妙可")];
    expect(findCrossSourceDup(want, existing)).toHaveLength(1);
  });

  it("合写歌手的分隔符写法不同不影响判定（/ & 、 ／ | 和 feat.）", () => {
    const want = track("qq", "稻香", "周杰伦 / 林妙可");
    for (const sep of ["&", "、", "／", "|", "+", "，", ";", "和", " feat. "]) {
      const other = `周杰伦${sep}林妙可`;
      expect(findCrossSourceDup(want, [track("wyy", "稻香", other)]), other).toHaveLength(1);
    }
  });

  it("合写歌手顺序不同（谁排在前）也算同一首", () => {
    const want = track("qq", "稻香", "林妙可 / 周杰伦");
    expect(findCrossSourceDup(want, [track("wyy", "稻香", "周杰伦&林妙可")])).toHaveLength(1);
  });

  it("歌手真的对不上（翻唱）依然不算，不因拆分而误报", () => {
    const want = track("qq", "稻香", "周杰伦");
    expect(findCrossSourceDup(want, [track("wyy", "稻香", "蔡依林&王力宏")])).toEqual([]);
  });

  it("歌名带版本修饰（Live / 伴奏 / 纯音乐 / 版）剥掉后仍算同名", () => {
    const want = track("qq", "稻香", "周杰伦");
    for (const suffix of [
      " (Live)",
      "（Live）",
      " (Remix)",
      "（伴奏）",
      " (纯音乐)",
      "（现场版）",
      " (Acoustic)",
    ]) {
      const title = `稻香${suffix}`;
      expect(findCrossSourceDup(want, [track("wyy", title, "周杰伦")]), title).toHaveLength(1);
    }
  });

  it("歌名标点/全角半角写法不同不影响判定", () => {
    const want = track("qq", "稻香", "周杰伦");
    expect(findCrossSourceDup(want, [track("wyy", "稻 香", "周杰伦")])).toHaveLength(1);
    expect(findCrossSourceDup(want, [track("wyy", "稻香（电影《不能说的秘密》主题曲）", "周杰伦")])).toHaveLength(1);
  });

  it("歌名大小写与空格差异不影响判定", () => {
    const want = track("qq", " Dao  Xiang ", "周杰伦");
    expect(findCrossSourceDup(want, [track("wyy", "dao xiang", "周杰伦")])).toHaveLength(1);
  });

  it("歌名带 (Live) 这类后缀仍算同名（互相包含）", () => {
    const want = track("qq", "稻香", "周杰伦");
    expect(findCrossSourceDup(want, [track("wyy", "稻香 (Live)", "周杰伦")])).toHaveLength(1);
    // 反过来也成立：待收藏的带后缀、歌单里的是干净版本
    const live = track("qq", "稻香 (Live)", "周杰伦");
    expect(findCrossSourceDup(live, [track("wyy", "稻香", "周杰伦")])).toHaveLength(1);
  });

  it("歌手双方都为空（纯音乐 / 元数据缺失）时按同名处理", () => {
    const want = track("qq", "River Flows In You", "");
    expect(findCrossSourceDup(want, [track("wyy", "River Flows In You", "")])).toHaveLength(1);
  });

  it("歌名为空不参与判定（空名没有判定价值）", () => {
    const want = track("qq", "", "周杰伦");
    expect(findCrossSourceDup(want, [track("wyy", "", "周杰伦")])).toEqual([]);
  });

  it("一个歌单里有多首同名冲突时全部返回", () => {
    const want = track("qq", "稻香", "周杰伦");
    const existing = [
      track("wyy", "稻香", "周杰伦"),
      track("kugou", "稻香", "周杰伦"),
      track("kuwo", "稻香 (Live)", "周杰伦"),
    ];
    expect(findCrossSourceDup(want, existing).map((t) => t.platform)).toEqual([
      "wyy",
      "kugou",
      "kuwo",
    ]);
  });

  it("空歌单 → 无冲突", () => {
    expect(findCrossSourceDup(track("qq", "稻香", "周杰伦"), [])).toEqual([]);
  });
});
