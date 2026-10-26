/**
 * 聚合搜索的「只用这几个源」过滤（设置 → 音源包 → 聚合搜索音源）。
 *
 * 过滤是双层的：数据包侧（新包）在发请求前就只查勾选的源；门面这层还要再过滤
 * 一遍应答 —— 因为装在旧包上时包会忽略 `sources` 字段，什么都不滤，关掉的源
 * 就会从旧包的应答里漏回来。这一层是旧包兼容的唯一保证，用用例锁住。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EngineMockState } from "./helpers/engine-client";
import { engineClientModule, resetEngineState } from "./helpers/engine-client";


/** 音源引擎替身（Mock 行为见 `./helpers/engine-client`） */
const engineMock = vi.hoisted<EngineMockState>(() => ({
  phase: "ready",
  detail: null,
  fallback: null,
  payloads: new Map(),
  errors: new Map(),
  calls: [],
}));

vi.mock("@/source-engine/client", () => engineClientModule(engineMock));

function info(id: string, name: string, singer: string): Record<string, unknown> {
  return { id, name, singer, album: "", picUrl: "", interval: 200, musicId: null };
}

describe("聚合搜索的源过滤", () => {
  afterEach(() => {
    resetEngineState(engineMock);
  });

  it("没配置过滤 → invoke 参数保持原样（不带 sources 字段）", async () => {
    const mod = await import("@/source-scripts");
    engineMock.fallback = {
      batches: [
        { source: "wyy", list: [info("a1", "晴天", "周杰伦")] },
        { source: "qq", list: [] },
      ],
    };

    const result = await mod.searchAllBatches("晴天", 1, 20);

    expect(engineMock.calls).toEqual([
      { entry: "searchAll", args: { keyword: "晴天", page: 1, size: 20 } },
    ]);
    expect(result.map((batch) => batch.source)).toEqual(["wyy", "qq"]);
  });

  it("配了过滤 → 请求带上 sources，应答里未勾选的源被丢弃（旧包兼容兜底）", async () => {
    const mod = await import("@/source-scripts");
    // 模拟旧包：收到了 sources 但不理它，照样四个源全返回
    engineMock.fallback = {
      batches: (["wyy", "qq", "kw", "kg"] as const).map((source) => ({
        source,
        list: [info(`${source}-1`, "晴天", "周杰伦")],
      })),
    };

    const result = await mod.searchAllBatches("晴天", 2, 30, ["qq", "kg"]);

    expect(engineMock.calls).toEqual([
      {
        entry: "searchAll",
        args: { keyword: "晴天", page: 2, size: 30, sources: ["qq", "kg"] },
      },
    ]);
    expect(result.map((batch) => batch.source)).toEqual(["qq", "kg"]);
    expect(result.map((batch) => batch.tracks[0]?.platform)).toEqual(["qq", "kg"]);
  });

  it("空数组 = 不过滤（等价于「全部音源」），也不会往包里塞空 sources", async () => {
    const mod = await import("@/source-scripts");
    engineMock.fallback = { batches: [{ source: "wyy", list: [] }] };

    await mod.searchAllBatches("晴天", 1, 20, []);

    expect(engineMock.calls[0]?.args).toEqual({ keyword: "晴天", page: 1, size: 20 });
  });

  it("searchManyBatches 也带 sources，并按勾选集过滤每个关键词的 batches", async () => {
    const mod = await import("@/source-scripts");
    engineMock.fallback = {
      groups: [
        {
          keyword: "周杰伦",
          batches: [
            { source: "wyy", list: [info("a1", "晴天", "周杰伦")] },
            { source: "qq", list: [info("a2", "稻香", "周杰伦")] },
          ],
        },
      ],
      truncated: false,
    };

    const result = await mod.searchManyBatches(["周杰伦"], 1, 10, {
      concurrency: 2,
      sources: ["qq"],
    });

    expect(engineMock.calls[0]).toEqual({
      entry: "searchMany",
      args: { keywords: ["周杰伦"], page: 1, size: 10, concurrency: 2, sources: ["qq"] },
    });
    expect(result.groups[0]?.batches.map((batch) => batch.source)).toEqual(["qq"]);
  });

  it("旧包缺 searchMany 入口时直接报「数据包版本过旧」，不再扇出（也就不需要降级过滤）", async () => {
    const mod = await import("@/source-scripts");
    engineMock.errors.set(
      "searchMany",
      "当前数据包缺少「searchMany」接口，请到「设置 → 音源包」更新数据包",
    );
    engineMock.fallback = {
      batches: [
        { source: "wyy", list: [info("a1", "晴天", "周杰伦")] },
        { source: "qq", list: [info("a2", "稻香", "周杰伦")] },
      ],
    };

    await expect(
      mod.searchManyBatches(["周杰伦"], 1, 10, { sources: ["qq"] }),
    ).rejects.toThrow(/数据包版本过旧/);
    expect(engineMock.calls.map((call) => call.entry)).toEqual(["searchMany"]);
  });
});
