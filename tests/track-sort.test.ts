import { describe, expect, it } from "vitest";
import type { Track } from "@/types";
import {
  DEFAULT_TRACK_SORT,
  TRACK_SORT_DIRECTIONS,
  TRACK_SORT_FIELDS,
  TRACK_SORT_OPTIONS,
  parseTrackSort,
  sortTracks,
  trackSortValue,
} from "@/lib/track-sort";

function track(id: string, title: string, singer: string, album = ""): Track {
  return {
    id,
    platform: "wyy",
    title,
    singer,
    album,
    picUrl: "",
    duration: 200,
  };
}

const pool = [
  track("1", "夏天的风", "温岚", "温室效应"),
  track("2", "晴天", "周杰伦", "叶惠美"),
  track("3", "稻香", "周杰伦", "魔杰座"),
  track("4", "后来", "刘若英", ""),
];

describe("track-sort 选项与解析", () => {
  it("默认顺序是 none，共 7 个选项（与 uniappx 一致）", () => {
    expect(DEFAULT_TRACK_SORT).toBe("none");
    expect(TRACK_SORT_OPTIONS.map((option) => option.value)).toEqual([
      "none",
      "name-asc",
      "name-desc",
      "album-asc",
      "album-desc",
      "singer-asc",
      "singer-desc",
    ]);
    expect(TRACK_SORT_OPTIONS[0]?.label).toContain("默认");
  });

  it("parseTrackSort 把选项拆成 key 与方向，未知值回落到默认顺序", () => {
    expect(parseTrackSort("name-asc")).toEqual({ key: "name", desc: false });
    expect(parseTrackSort("singer-desc")).toEqual({ key: "singer", desc: true });
    expect(parseTrackSort("none")).toEqual({ key: "none", desc: false });
    expect(parseTrackSort("bogus")).toEqual({ key: "none", desc: false });
    expect(parseTrackSort(undefined)).toEqual({ key: "none", desc: false });
  });
});

describe("两个弹窗的数据源（用户 m00002 / m00029）", () => {
  it("上面的维度只有歌曲名 / 专辑名 / 歌手名三项，顺序与 uniappx 一致", () => {
    expect(TRACK_SORT_FIELDS.map((field) => field.key)).toEqual(["name", "album", "singer"]);
    expect(TRACK_SORT_FIELDS.map((field) => field.label)).toEqual([
      "按歌曲名",
      "按专辑名",
      "按歌手名",
    ]);
  });

  it("下面的方向只有正序 / 倒序两项（正序在前）", () => {
    expect(TRACK_SORT_DIRECTIONS.map((direction) => direction.value)).toEqual(["asc", "desc"]);
    expect(TRACK_SORT_DIRECTIONS.map((direction) => direction.label)).toEqual(["正序", "倒序"]);
    expect(TRACK_SORT_DIRECTIONS.map((direction) => direction.desc)).toEqual([false, true]);
  });

  it("trackSortValue 把维度 + 方向拼成编码；没有维度就没有方向", () => {
    expect(trackSortValue("name")).toBe("name-asc");
    expect(trackSortValue("album", true)).toBe("album-desc");
    expect(trackSortValue("singer", false)).toBe("singer-asc");
    expect(trackSortValue("none")).toBe("none");
    expect(trackSortValue("none", true)).toBe("none");
  });

  it("拼出来的编码能被 parseTrackSort 原样读回（UI 与页面只交换这一个字符串）", () => {
    for (const field of TRACK_SORT_FIELDS) {
      for (const direction of TRACK_SORT_DIRECTIONS) {
        expect(parseTrackSort(trackSortValue(field.key, direction.desc))).toEqual({
          key: field.key,
          desc: direction.desc,
        });
      }
    }
    // 每个编码都必须真的出现在 7 项表里，否则页面缓存到旧编码时行为会漂。
    const known = new Set(TRACK_SORT_OPTIONS.map((option) => option.value));
    for (const field of TRACK_SORT_FIELDS) {
      for (const direction of TRACK_SORT_DIRECTIONS) {
        expect(known.has(trackSortValue(field.key, direction.desc))).toBe(true);
      }
    }
  });
});

describe("sortTracks", () => {
  it("默认顺序不改顺序，但返回的是浅拷贝", () => {
    const sorted = sortTracks(pool, "none", false);
    expect(sorted.map((item) => item.id)).toEqual(["1", "2", "3", "4"]);
    expect(sorted).not.toBe(pool);
  });

  it("按歌曲名排序：正序相邻两首按中文排序规则单调不减，倒序是它的逆序", () => {
    const asc = sortTracks(pool, "name", false);
    const desc = sortTracks(pool, "name", true);
    const collate = (left: string, right: string): number => left.localeCompare(right, "zh-Hans-CN");
    for (let index = 1; index < asc.length; index += 1) {
      const previous = asc[index - 1]?.title ?? "";
      const current = asc[index]?.title ?? "";
      expect(collate(previous, current)).toBeLessThanOrEqual(0);
    }
    expect(desc.map((item) => item.id)).toEqual([...asc.map((item) => item.id)].reverse());
    expect(asc.map((item) => item.id).sort()).toEqual(["1", "2", "3", "4"]);
  });

  it("按专辑名排序，正序与倒序互为逆序", () => {
    const asc = sortTracks(pool, "album", false);
    const desc = sortTracks(pool, "album", true);
    expect(asc.map((item) => item.id)).toHaveLength(4);
    expect(desc.map((item) => item.id)).toEqual([...asc.map((item) => item.id)].reverse());
  });

  it("按歌手名排序：同名内按歌名收敛（不是随便换位），首首是刘若英", () => {
    const asc = sortTracks(pool, "singer", false);
    const jay = asc.filter((item) => item.singer === "周杰伦").map((item) => item.title);
    expect(jay).toEqual(["稻香", "晴天"]);
    expect(asc[0]?.singer).toBe("刘若英");
    expect(asc).toHaveLength(4);
  });
});
