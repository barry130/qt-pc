/**
 * facade 多关键词聚合搜索（searchManyBatches）测试。
 *
 * 「一次进去搜 N 个词、词内四源并发、逐词失败隔离」这层住在数据包
 * （qt-sources 的 `searchMany` 入口）；app 侧只剩一件事：把包应答映射成 `Track`
 * （与 `searchAllBatches` 同一套映射）。
 *
 * 2026-10-24 起 app 侧不再保留「旧包退回本地扇出」的兜底（DESIGN §1.2）：装在
 * 老包上时直接抛「数据包版本过旧」，避免两端各写一份聚合规则后漂移。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EngineMockState } from "./helpers/engine-client";
import { engineClientModule, resetEngineState } from "./helpers/engine-client";

/** 音源引擎替身：app 侧数据接口只经引擎窗口（Mock 行为见 `./helpers/engine-client`） */
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

describe("searchManyBatches（数据包多关键词聚合）", () => {
  afterEach(() => {
    resetEngineState(engineMock);
  });

  it("应答映射：关键词归一化去重，batches 映射成 Track", async () => {
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
        // ok 缺失 = 按成功处理（无结果 ≠ 失败）
        { keyword: "陈奕迅", ok: false, batches: [] },
      ],
      truncated: true,
    };

    const result = await mod.searchManyBatches(
      [" 周杰伦 ", "周杰伦", "", "陈奕迅"],
      1,
      20,
      { concurrency: 2, budgetMs: 3000 },
    );

    // 空白丢弃、大小写/重复折叠，保留首次出现的原文
    expect(engineMock.calls).toEqual([
      {
        entry: "searchMany",
        args: {
          keywords: ["周杰伦", "陈奕迅"],
          page: 1,
          size: 20,
          concurrency: 2,
          budgetMs: 3000,
        },
      },
    ]);
    expect(result.groups.map((group) => group.keyword)).toEqual(["周杰伦", "陈奕迅"]);
    expect(result.groups[0]?.batches.map((batch) => batch.source)).toEqual(["wyy", "qq"]);
    expect(result.groups[0]?.batches[0]?.tracks[0]).toMatchObject({
      id: "a1",
      platform: "wyy",
      title: "晴天",
      singer: "周杰伦",
      duration: 200,
      musicId: null,
    });
    expect(result.groups[1]?.ok).toBe(false);
    expect(result.truncated).toBe(true);
  });

  it("关键词全是空白 → 直接返回空结果，不发任何音源调用", async () => {
    const mod = await import("@/source-scripts");
    const result = await mod.searchManyBatches(["", "   "], 1, 10);
    expect(engineMock.calls).toEqual([]);
    expect(result).toEqual({ groups: [], truncated: false });
  });

  it("包内接口执行失败（不是缺入口）→ 原样抛出，不静默降级", async () => {
    const mod = await import("@/source-scripts");
    engineMock.errors.set("searchMany", "音源接口执行失败：搜索超时");
    await expect(mod.searchManyBatches(["周杰伦"], 1, 10)).rejects.toThrow(/音源接口执行失败/);
  });

  it("旧数据包没有 searchMany 入口 → 报「数据包版本过旧」，不再退回 app 侧扇出", async () => {
    const mod = await import("@/source-scripts");
    engineMock.errors.set(
      "searchMany",
      "当前数据包缺少「searchMany」接口，请到「设置 → 音源包」更新数据包",
    );
    engineMock.fallback = {
      batches: [{ source: "wyy", list: [info("s1", "晴天", "周杰伦")] }],
    };

    await expect(mod.searchManyBatches(["周杰伦", "陈奕迅"], 1, 10, { concurrency: 2 })).rejects.toThrow(
      /数据包版本过旧：当前数据包缺少 searchMany 入口（需要 数据包 2026\.10\.22\.1（META_REVISION 6） 及以上）/,
    );
    // 关键：不再逐词调 searchAll
    expect(engineMock.calls.map((call) => call.entry)).toEqual(["searchMany"]);
  });

  it("旧包报错文案提到「设置 → 音源包」，用户知道该去哪更新", async () => {
    const mod = await import("@/source-scripts");
    engineMock.errors.set("searchMany", "缺少入口");
    await expect(mod.searchManyBatches(["周杰伦"], 1, 10)).rejects.toThrow(/设置 → 音源包/);
  });
});
