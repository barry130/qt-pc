// 维度模块的契约测试：规划出的搜索词要「优先贴合、兜底轮换、去重靠谱」，采集时
// 任何一路挂掉都不能连坐整池 —— 候选池窄一点可以接受，整个推荐空着不行。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chart, Playlist, SourceId, Track } from "@/types";
import type { StyleProfile } from "@/lib/recommend-types";
import { trackKey } from "@/lib/text";
import { getChartDetail, getCharts, getPlaylistDetail, searchManyBatches, searchPlaylists } from "@/source-scripts";
import {
  ADJACENT_WORDS,
  chartLane,
  collectDimensionLanes,
  ERA_WORDS,
  GENRE_WORDS,
  interleaveByLanes,
  LANG_WORDS,
  laneCoverage,
  MOOD_WORDS,
  planDimensionQueries,
  SCENE_WORDS,
} from "@/lib/recommend-dimensions";
import type { LaneQuery, LaneKind } from "@/lib/recommend-dimensions";

vi.mock("@/source-scripts", () => ({
  getCharts: vi.fn(),
  getChartDetail: vi.fn(),
  searchManyBatches: vi.fn(),
  searchPlaylists: vi.fn(),
  getPlaylistDetail: vi.fn(),
}));

const mockedGetCharts = vi.mocked(getCharts);
const mockedGetChartDetail = vi.mocked(getChartDetail);
const mockedSearchMany = vi.mocked(searchManyBatches);
const mockedSearchPlaylists = vi.mocked(searchPlaylists);
const mockedGetPlaylistDetail = vi.mocked(getPlaylistDetail);

function track(id: string, title: string, singer: string, platform: SourceId = "wyy"): Track {
  return { id, platform, title, singer, album: "", picUrl: "", duration: 200 };
}

/** 一批唯一 id 的曲目：`${prefix}-1` … `${prefix}-n` */
function tracks(prefix: string, count: number, platform: SourceId = "wyy"): Track[] {
  return Array.from({ length: count }, (_unused, index) =>
    track(`${prefix}-${index + 1}`, `${prefix}歌${index + 1}`, `${prefix}歌手`, platform),
  );
}

function chart(id: string, name: string, contentType?: "music" | "programs"): Chart {
  return {
    id,
    platform: "wyy",
    name,
    picUrl: "",
    description: null,
    ...(contentType ? { contentType } : {}),
  };
}

function playlist(id: string, name: string, list: Track[] = []): Playlist {
  return { id, platform: "wyy", name, picUrl: "", playCount: "1", description: null, tracks: list };
}

function profile(over: Partial<StyleProfile> = {}): StyleProfile {
  return {
    langs: { zh: 1 },
    bands: { normal: 1 },
    mainLang: "zh",
    mainBand: "normal",
    singers: {},
    albums: {},
    tags: [],
    sampleSize: 20,
    ...over,
  };
}

/** 每个用例都重新给五个门面装默认值（默认全空），避免上一个用例的实现漏进来 */
beforeEach(() => {
  vi.clearAllMocks();
  mockedGetCharts.mockResolvedValue([]);
  mockedGetChartDetail.mockResolvedValue([]);
  mockedSearchMany.mockResolvedValue({ groups: [], truncated: false });
  mockedSearchPlaylists.mockResolvedValue([]);
  mockedGetPlaylistDetail.mockResolvedValue(playlist("", ""));
});

function lanesOfKind(plan: LaneQuery[], kinds: readonly LaneKind[]): string[] {
  return plan.filter((query) => kinds.includes(query.kind)).map((query) => query.lane);
}

const BREADTH_KINDS: readonly LaneKind[] = ["genre", "mood", "scene", "era"];

describe("词表", () => {
  it("词表覆盖用户点名的风格/情绪/场景/年代，语种维度不含华语", () => {
    expect(GENRE_WORDS).toContain("古风");
    expect(GENRE_WORDS).toContain("R&B");
    expect(MOOD_WORDS).toContain("治愈");
    expect(SCENE_WORDS).toContain("助眠");
    expect(ERA_WORDS).toContain("怀旧");
    // 华语是默认口味，不做维度词；粤语才是少数派入口
    expect(LANG_WORDS.zh).toEqual(["粤语"]);
    expect(LANG_WORDS.ja?.[0]).toBe("日语");
    expect(ADJACENT_WORDS["古风"]).toEqual(["国风", "戏腔", "民乐"]);
    expect(ADJACENT_WORDS["不存在的风格"]).toBeUndefined();
  });
});

describe("planDimensionQueries", () => {
  it("profile.tags 优先且最多 3 个", () => {
    const plan = planDimensionQueries({
      profile: profile({ tags: ["古风", "摇滚", "民谣", "电子", "爵士"] }),
    });
    expect(lanesOfKind(plan, ["tag"])).toEqual(["古风", "摇滚", "民谣"]);
    expect(plan[0]).toEqual({ lane: "古风", keyword: "古风", kind: "tag" });
  });

  it("profile.tags 归一化后去重", () => {
    const plan = planDimensionQueries({ profile: profile({ tags: ["古风", "古风", "摇滚"] }) });
    expect(lanesOfKind(plan, ["tag"])).toEqual(["古风", "摇滚"]);
  });

  it("playlistNames 命中词表（华语古风 → 古风），最多 2 个", () => {
    const plan = planDimensionQueries({
      profile: profile(),
      playlistNames: ["华语古风", "摇滚现场", "轻音乐合集", "我的歌单"],
    });
    expect(lanesOfKind(plan, ["tag"])).toEqual(["古风", "摇滚"]);
  });

  it("非主语种占比 ≥0.05 才作为维度词（0.04 不出）", () => {
    const plan = planDimensionQueries({
      profile: profile({ mainLang: "en", langs: { en: 0.8, zh: 0.1, ja: 0.06, ko: 0.04 } }),
    });
    expect(lanesOfKind(plan, ["lang"])).toEqual(["粤语", "日语"]);
  });

  it("每个 tag 各取一个相邻词", () => {
    const plan = planDimensionQueries({ profile: profile({ tags: ["古风", "摇滚"] }) });
    expect(lanesOfKind(plan, ["adjacent"])).toEqual(["国风", "朋克"]);
  });

  it("兜底广度词数量：tags 为空取 4 个，且按 variant 轮换起点", () => {
    const first = planDimensionQueries({ profile: profile(), variant: "seed-a" });
    const second = planDimensionQueries({ profile: profile(), variant: "seed-b" });
    expect(lanesOfKind(first, BREADTH_KINDS)).toHaveLength(4);
    expect(lanesOfKind(second, BREADTH_KINDS)).toHaveLength(4);
    // 换一批 / 换天必须换维度词，否则天天推同一批
    expect(lanesOfKind(first, BREADTH_KINDS)).not.toEqual(lanesOfKind(second, BREADTH_KINDS));
  });

  it("explore 模式兜底词 4 个，heart 模式 3 个", () => {
    const heart = planDimensionQueries({
      profile: profile({ tags: ["古风"] }),
      taste: "heart",
      variant: "v1",
    });
    const explore = planDimensionQueries({
      profile: profile({ tags: ["古风"] }),
      taste: "explore",
      variant: "v1",
    });
    expect(lanesOfKind(heart, BREADTH_KINDS)).toHaveLength(3);
    expect(lanesOfKind(explore, BREADTH_KINDS)).toHaveLength(4);
  });

  it("maxQueries 截断：前几条保持优先级顺序", () => {
    const plan = planDimensionQueries({
      profile: profile({ tags: ["古风", "摇滚", "民谣"] }),
      maxQueries: 4,
    });
    expect(plan).toHaveLength(4);
    expect(plan.map((query) => query.lane)).toEqual(["古风", "摇滚", "民谣", "国风"]);
  });

  it("searchHistory：去掉与已有维度重复的、超长的、重复的", () => {
    const plan = planDimensionQueries({
      profile: profile({ tags: ["古风"] }),
      searchHistory: [
        "古风",
        "周杰伦",
        "这是一个超过十六个字符的超长搜索关键词",
        "陈奕迅",
        "林俊杰",
        "周杰伦",
      ],
    });
    expect(lanesOfKind(plan, ["search"])).toEqual(["周杰伦", "陈奕迅", "林俊杰"]);
    expect(plan.find((query) => query.kind === "search")).toEqual({
      lane: "周杰伦",
      keyword: "周杰伦",
      kind: "search",
    });
  });
});

describe("chartLane", () => {
  it("命中词表保留原始写法，命中不了剥掉榜壳", () => {
    expect(chartLane("国风榜")).toBe("国风");
    expect(chartLane("R&B榜")).toBe("R&B");
    expect(chartLane("飙升榜")).toBe("飙升");
    expect(chartLane("QQ音乐·热歌排行榜")).toBe("QQ音乐·热歌");
    expect(chartLane("榜")).toBe("榜单");
    expect(chartLane("   ")).toBe("榜单");
  });
});

describe("collectDimensionLanes", () => {
  it("榜单路：只挑带风格词的榜、名字去重、每榜条数上限", async () => {
    mockedGetCharts.mockResolvedValue([
      chart("c1", "国风榜"),
      chart("c2", "飙升榜"),
      chart("c3", "国风榜"),
      chart("c4", "日语榜"),
      chart("c5", "摇滚榜"),
      chart("c6", "热门推荐"),
      chart("c7", "经典怀旧"),
      chart("p1", "有声书榜", "programs"),
    ]);
    mockedGetChartDetail.mockImplementation((item) =>
      Promise.resolve(tracks(`d${item.id}`, 80)),
    );
    const onProgress = vi.fn();

    const result = await collectDimensionLanes({
      profile: profile({ tags: ["古风"] }),
      source: "wyy",
      perChart: 30,
      onProgress,
    });

    // 优先 3 张（国风/日语/摇滚）+ 原始顺序补 2 张（飙升/热门推荐）；重复的国风榜只留一张
    expect(result.lanes.map((lane) => lane.label)).toEqual([
      "国风",
      "日语",
      "摇滚",
      "飙升",
      "热门推荐",
    ]);
    expect(result.lanes.every((lane) => lane.kind === "chart")).toBe(true);
    expect(result.lanes.every((lane) => lane.tracks.length === 30)).toBe(true);
    const detailNames = mockedGetChartDetail.mock.calls.map(([item]) => item.name);
    expect(detailNames).toEqual(["国风榜", "日语榜", "摇滚榜", "飙升榜", "热门推荐"]);
    expect(detailNames).not.toContain("有声书榜");
    // 「国风」榜单线与「古风」关键词线不是同一条线，但都被记录到 laneOf
    expect(onProgress.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("关键词路：逐词一条线、跨源批次打平、去重、条数上限、ok=false 不出线", async () => {
    const g1 = track("1", "广陵散", "古风甲");
    const g2 = track("2", "琵琶行", "古风乙");
    const g2q = track("2", "琵琶行", "古风乙", "qq");
    const g3 = track("3", "霓裳羽衣", "古风丙", "qq");

    mockedSearchMany.mockImplementation((keywords) =>
      Promise.resolve({
        groups: keywords.map((keyword) => {
          if (keyword === "古风") {
            return {
              keyword,
              ok: true,
              batches: [
                { source: "wyy", tracks: [g1, g1, g2] },
                { source: "qq", tracks: [g2q, g3] },
              ],
            };
          }
          if (keyword === "摇滚") return { keyword, ok: false, batches: [] };
          return { keyword, ok: true, batches: [] };
        }),
        truncated: false,
      }),
    );

    const result = await collectDimensionLanes({
      profile: profile({ tags: ["古风", "摇滚"] }),
      source: "wyy",
      sources: ["wyy", "qq"],
      perKeyword: 3,
    });

    const keywordLane = result.lanes.find((lane) => lane.label === "古风");
    expect(keywordLane?.kind).toBe("tag");
    expect(keywordLane?.tracks.map((item) => `${item.platform}:${item.id}`)).toEqual([
      "wyy:1",
      "wyy:2",
      "qq:2",
    ]);
    // 逐词 ok=false 的词不产生线
    expect(result.lanes.some((lane) => lane.label === "摇滚")).toBe(false);

    const [keywords, page, size, options] = mockedSearchMany.mock.calls[0];
    expect(keywords).toEqual(["古风", "摇滚", "国风", "朋克", "通勤", "运动", "咖啡厅"]);
    expect(page).toBe(1);
    expect(size).toBe(3);
    expect(options).toEqual({ concurrency: 3, sources: ["wyy", "qq"] });
  });

  it("风格歌单路：并入同一条线、详情曲目条数上限", async () => {
    mockedSearchMany.mockImplementation((keywords) =>
      Promise.resolve({
        groups: keywords
          .filter((keyword) => keyword === "古风")
          .map((keyword) => ({
            keyword,
            ok: true,
            batches: [{ source: "wyy", tracks: [track("k1", "甲", "甲"), track("k2", "乙", "乙")] }],
          })),
        truncated: false,
      }),
    );
    mockedSearchPlaylists.mockImplementation((_source, keyword) =>
      Promise.resolve(keyword === "古风" ? [playlist("p1", "古风集")] : []),
    );
    mockedGetPlaylistDetail.mockResolvedValue(playlist("p1", "古风集", tracks("p", 30)));

    const result = await collectDimensionLanes({
      profile: profile({ tags: ["古风"] }),
      source: "wyy",
    });

    expect(mockedSearchPlaylists.mock.calls.map(([, keyword]) => keyword)).toEqual(["古风", "国风"]);
    expect(mockedGetPlaylistDetail).toHaveBeenCalledTimes(1);
    expect(mockedGetPlaylistDetail).toHaveBeenCalledWith("wyy", "p1");
    const lane = result.lanes.find((item) => item.label === "古风");
    // 2 首关键词曲目 + 20 首歌单曲目（perPlaylist 缺省 20，详情里有 30 首）
    expect(lane?.tracks).toHaveLength(22);
    expect(lane?.tracks.slice(0, 2).map((item) => item.id)).toEqual(["k1", "k2"]);
    expect(lane?.tracks[2].id).toBe("p-1");
  });

  it("getCharts 抛错时仍返回关键词路的结果", async () => {
    mockedGetCharts.mockRejectedValue(new Error("榜单超时"));
    mockedSearchMany.mockResolvedValue({
      groups: [{ keyword: "古风", ok: true, batches: [{ source: "wyy", tracks: [track("1", "甲", "甲")] }] }],
      truncated: false,
    });

    const result = await collectDimensionLanes({
      profile: profile({ tags: ["古风"] }),
      source: "wyy",
    });

    expect(result.lanes.map((lane) => lane.label)).toEqual(["古风"]);
    expect(result.laneOf.size).toBe(1);
  });

  it("searchManyBatches 抛错时仍返回榜单路的结果", async () => {
    mockedGetCharts.mockResolvedValue([chart("c1", "国风榜")]);
    mockedGetChartDetail.mockResolvedValue(tracks("c", 3));
    mockedSearchMany.mockRejectedValue(new Error("聚合搜索超时"));

    const result = await collectDimensionLanes({
      profile: profile({ tags: ["古风"] }),
      source: "wyy",
    });

    expect(result.lanes.map((lane) => lane.label)).toEqual(["国风"]);
    expect(result.lanes[0].kind).toBe("chart");
    expect(result.lanes[0].tracks).toHaveLength(3);
  });

  it("searchPlaylists 抛错时其它两路照常返回", async () => {
    mockedGetCharts.mockResolvedValue([chart("c1", "国风榜")]);
    mockedGetChartDetail.mockResolvedValue(tracks("c", 2));
    mockedSearchMany.mockResolvedValue({
      groups: [{ keyword: "古风", ok: true, batches: [{ source: "wyy", tracks: [track("1", "甲", "甲")] }] }],
      truncated: false,
    });
    mockedSearchPlaylists.mockRejectedValue(new Error("歌单接口挂了"));

    const result = await collectDimensionLanes({
      profile: profile({ tags: ["古风"] }),
      source: "wyy",
    });

    expect(result.lanes.map((lane) => lane.label)).toEqual(["国风", "古风"]);
  });

  it("三条路全挂时返回空结果而不 throw", async () => {
    mockedGetCharts.mockRejectedValue(new Error("a"));
    mockedSearchMany.mockRejectedValue(new Error("b"));
    mockedSearchPlaylists.mockRejectedValue(new Error("c"));

    const result = await collectDimensionLanes({
      profile: profile({ tags: ["古风"] }),
      source: "wyy",
    });

    expect(result.lanes).toEqual([]);
    expect(result.laneOf.size).toBe(0);
  });

  it("同一首曲目跨线时 laneOf 记两个 label，且顺序稳定（榜单线在前）", async () => {
    const shared = track("2", "同一首", "同一个歌手");
    mockedGetCharts.mockResolvedValue([chart("c1", "国风榜")]);
    mockedGetChartDetail.mockResolvedValue([track("1", "甲", "甲"), shared]);
    mockedSearchMany.mockResolvedValue({
      groups: [
        {
          keyword: "古风",
          ok: true,
          batches: [{ source: "wyy", tracks: [shared, track("3", "乙", "乙")] }],
        },
      ],
      truncated: false,
    });

    const result = await collectDimensionLanes({
      profile: profile({ tags: ["古风"] }),
      source: "wyy",
    });

    expect(result.laneOf.get(trackKey(shared))).toEqual(["国风", "古风"]);
    expect(result.laneOf.get(trackKey(track("1", "甲", "甲")))).toEqual(["国风"]);
    expect(result.laneOf.get(trackKey(track("3", "乙", "乙")))).toEqual(["古风"]);
  });
});

describe("interleaveByLanes", () => {
  const a1 = track("a1", "甲一", "甲");
  const a2 = track("a2", "甲二", "甲");
  const a3 = track("a3", "甲三", "甲");
  const b1 = track("b1", "乙一", "乙");
  const b2 = track("b2", "乙二", "乙");
  const b3 = track("b3", "乙三", "乙");
  const c1 = track("c1", "丙一", "丙");
  const c2 = track("c2", "丙二", "丙");
  const c3 = track("c3", "丙三", "丙");

  function laneMap(entries: readonly (readonly [Track, string[]])[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const [item, labels] of entries) out.set(trackKey(item), [...labels]);
    return out;
  }

  it("按 SWRR 交织：前三首来自不同线、线内顺序不变、无重复", () => {
    const items = [a1, b1, c1, a2, b2, c2, a3];
    const laneOf = laneMap([
      [a1, ["A"]],
      [a2, ["A"]],
      [a3, ["A"]],
      [b1, ["B"]],
      [b2, ["B"]],
      [b3, ["B"]],
      [c1, ["C"]],
      [c2, ["C"]],
      [c3, ["C"]],
    ]);

    const out = interleaveByLanes(items, laneOf, 6);

    // 权重 4/2/2：前三条线轮流坐庄
    expect(out.map((item) => item.id)).toEqual(["a1", "b1", "c1", "a2", "a3", "b2"]);
    expect(out).toHaveLength(6);
    expect(new Set(out.map(trackKey)).size).toBe(6);
    expect(new Set(out.slice(0, 3).map((item) => laneOf.get(trackKey(item))?.[0])).size).toBe(3);
    const aOrder = out.filter((item) => item.id.startsWith("a")).map((item) => item.id);
    expect(aOrder).toEqual(["a1", "a2", "a3"]);
  });

  it("target 超过库容时返回全部（按原顺序补齐），仍无重复", () => {
    const items = [a1, b1, c1];
    const laneOf = laneMap([
      [a1, ["A"]],
      [b1, ["B"]],
      [c1, ["C"]],
    ]);
    const out = interleaveByLanes(items, laneOf, 10);
    expect(out.map((item) => item.id).sort()).toEqual(["a1", "b1", "c1"]);
  });

  it("没有 lane 信息时原样 slice；target<=0 / 空输入返回空数组", () => {
    const items = [a1, a2, a3];
    expect(interleaveByLanes(items, new Map(), 2)).toEqual([a1, a2]);
    expect(interleaveByLanes(items, new Map(), 0)).toEqual([]);
    expect(interleaveByLanes([], new Map(), 5)).toEqual([]);
  });

  it("没有 lane 的曲目归 __其他，只在最后兜底", () => {
    const items = [a1, b1, a2, c1];
    const laneOf = laneMap([
      [a1, ["A"]],
      [a2, ["A"]],
      [b1, []],
      [c1, []],
    ]);
    const out = interleaveByLanes(items, laneOf, 3);
    expect(out.map((item) => item.id)).toEqual(["a1", "a2", "b1"]);
  });
});

describe("laneCoverage", () => {
  it("按条数降序、同数按 label 升序、截断到 max", () => {
    const items = [
      track("1", "a1", "x"),
      track("2", "a2", "x"),
      track("3", "a3", "x"),
      track("4", "b1", "x"),
      track("5", "b2", "x"),
      track("6", "c1", "x"),
      track("7", "d1", "x"),
      track("8", "e1", "x"),
      track("9", "f1", "x"),
    ];
    const laneOf = new Map<string, string[]>([
      [trackKey(items[0]), ["a"]],
      [trackKey(items[1]), ["a"]],
      [trackKey(items[2]), ["a"]],
      [trackKey(items[3]), ["b"]],
      [trackKey(items[4]), ["b"]],
      [trackKey(items[5]), ["c"]],
      [trackKey(items[6]), ["d"]],
      [trackKey(items[7]), ["e"]],
      [trackKey(items[8]), ["f"]],
    ]);

    expect(laneCoverage(items, laneOf)).toEqual([
      { label: "a", count: 3 },
      { label: "b", count: 2 },
      { label: "c", count: 1 },
      { label: "d", count: 1 },
      { label: "e", count: 1 },
    ]);
    expect(laneCoverage(items, laneOf, 2)).toEqual([
      { label: "a", count: 3 },
      { label: "b", count: 2 },
    ]);
  });

  it("跳过 __ 开头的内部线，也跳过没有线的曲目", () => {
    const items = [track("1", "a1", "x"), track("2", "b1", "x"), track("3", "c1", "x")];
    const laneOf = new Map<string, string[]>([
      [trackKey(items[0]), ["a", "b"]],
      [trackKey(items[1]), ["__其他"]],
    ]);
    expect(laneCoverage(items, laneOf)).toEqual([{ label: "a", count: 1 }]);
    expect(laneCoverage(items, laneOf, 0)).toEqual([]);
  });
});
