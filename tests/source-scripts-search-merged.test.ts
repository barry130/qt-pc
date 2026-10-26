/**
 * 门面 `searchMergedPage`（聚合搜索的合并去重入口）测试。
 *
 * 搜索页「聚合」模式要的是**一条**已去重、按相关性排好序的列表，这层判断属音源层
 * （各平台标题写法、版本后缀、元数据完整度），所以由数据包 `searchMerged` 入口给；
 * 宿主只拿 `{ tracks, full }` 渲染。本文件锁住三件容易写坏的事：
 *
 * 1. 应答映射：`{source, song}` → `Track`，并按「聚合搜索音源」勾选集再过滤一遍
 *    （旧包忽略 `sources` 时这是唯一保证）。
 * 2. `full` 必须原样透传：分页收尾只能信包侧按**合并前各源原始条数**算出来的值，
 *    宿主拿合并后的条数比 `size` 会永远判成到底。
 * 3. 2026-10-24 起旧包缺入口时**不再**退回 app 侧本地合并（`mergeAggregateTracks`
 *    已删除，DESIGN §1.2）：直接报「数据包版本过旧」，让人去更新包，而不是拿一份
 *    与包内规则不同的合并结果凑合用。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineMockState } from "./helpers/engine-client";
import { engineClientModule, resetEngineState } from "./helpers/engine-client";

/** 音源引擎替身：只关心「调了哪个入口、参数是什么、回了什么」（行为见 `./helpers/engine-client`） */
const engineMock = vi.hoisted<EngineMockState>(() => ({
  phase: "ready",
  detail: null,
  fallback: null,
  payloads: new Map(),
  errors: new Map(),
  calls: [],
}));

vi.mock("@/source-engine/client", () => engineClientModule(engineMock));

/** 音源包的歌曲形状（契约 `MusicInfo`） */
function song(id: string, name: string, singer = "歌手") {
  return { id, name, singer, album: "", picUrl: "", interval: 240 };
}

/** 缺入口的错误串：真实链路里 engineInvoke 抛的就是这一句（含「缺少」二字） */
const MISSING_ENTRY = "当前数据包缺少「searchMerged」接口，请到「设置 → 音源包」更新数据包";

function callsOf(entry: string) {
  return engineMock.calls.filter((call) => call.entry === entry);
}

beforeEach(() => {
  resetEngineState(engineMock);
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("searchMergedPage：数据包有 searchMerged 入口", () => {
  it("映射成 Track 并透传 full；`sources` 勾选集传下去并再过滤一遍应答", async () => {
    const mod = await import("@/source-scripts");
    engineMock.payloads.set("searchMerged", {
      list: [
        { source: "qq", song: song("q1", "晴天") },
        { source: "kw", song: song("k1", "晴天（Live）") },
      ],
      full: true,
    });

    const page = await mod.searchMergedPage("晴天", 1, 20, {
      sources: ["qq"],
      preferSource: "qq",
    });

    expect(callsOf("searchMerged")).toHaveLength(1);
    expect(engineMock.calls.at(-1)).toEqual({
      entry: "searchMerged",
      args: { keyword: "晴天", page: 1, size: 20, sources: ["qq"], preferSource: "qq" },
    });
    // 包侧通常已经按 sources 过滤；门面再过滤一次是旧包兜底（幂等）
    expect(page.tracks.map((track) => `${track.platform}:${track.id}`)).toEqual(["qq:q1"]);
    expect(page.tracks[0]?.title).toBe("晴天");
    expect(page.tracks[0]?.singer).toBe("歌手");
    expect(page.tracks[0]?.duration).toBe(240);
    // 分页收尾只能信包侧
    expect(page.full).toBe(true);
  });

  it("没配勾选集时不往入参里塞 sources（入参与旧版本一致）", async () => {
    const mod = await import("@/source-scripts");
    engineMock.payloads.set("searchMerged", { list: [], full: false });

    const page = await mod.searchMergedPage("晴天", 2, 30);

    expect(engineMock.calls.at(-1)).toEqual({
      entry: "searchMerged",
      args: { keyword: "晴天", page: 2, size: 30, preferSource: undefined },
    });
    expect(page).toEqual({ tracks: [], full: false });
  });

  it("空关键词直接返回空页，不打引擎", async () => {
    const mod = await import("@/source-scripts");

    const page = await mod.searchMergedPage("   ", 1, 20);

    expect(page).toEqual({ tracks: [], full: false });
    expect(engineMock.calls).toHaveLength(0);
  });

  it("其它错误原样抛出（不是缺入口就不该被包装成版本问题）", async () => {
    const mod = await import("@/source-scripts");
    engineMock.errors.set("searchMerged", "音源接口执行失败：搜索超时");

    await expect(mod.searchMergedPage("晴天", 1, 20)).rejects.toThrow(/音源接口执行失败/);
    expect(callsOf("searchAll")).toHaveLength(0);
  });
});

describe("searchMergedPage：旧数据包没有 searchMerged 入口", () => {
  it("报「数据包版本过旧」并提示去更新，不再退回 searchAll + 本地合并", async () => {
    const mod = await import("@/source-scripts");
    engineMock.errors.set("searchMerged", MISSING_ENTRY);
    engineMock.payloads.set("searchAll", {
      batches: [
        { source: "qq", list: [song("q1", "晴天"), song("q2", "稻香")] },
        { source: "kw", list: [song("k1", "晴天（Live）")] },
      ],
    });

    await expect(mod.searchMergedPage("晴天", 1, 2, { preferSource: "qq" })).rejects.toThrow(
      /数据包版本过旧：当前数据包缺少 searchMerged 入口/,
    );
    expect(callsOf("searchMerged")).toHaveLength(1);
    // 关键：不再拉分批做本地合并
    expect(callsOf("searchAll")).toHaveLength(0);
  });

  it("错误文案指向「设置 → 音源包」，用户知道该去哪更新", async () => {
    const mod = await import("@/source-scripts");
    engineMock.errors.set("searchMerged", MISSING_ENTRY);

    await expect(mod.searchMergedPage("晴天", 1, 20)).rejects.toThrow(/设置 → 音源包/);
  });
});
