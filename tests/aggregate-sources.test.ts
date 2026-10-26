// 聚合搜索音源设置：解析必须是「脏输入也不能把搜索搞死」——
// 设置里存坏的唯一后果允许是「退回全部音源」，绝不允许变成「什么都搜不到」。
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  store: new Map<string, string>(),
  reads: [] as string[],
  writes: [] as { key: string; value: string }[],
  readThrows: false,
}));

vi.mock("@/services/ipc", () => ({
  getSetting: (key: string) => {
    state.reads.push(key);
    if (state.readThrows) return Promise.reject(new Error("db boom"));
    return Promise.resolve(state.store.get(key) ?? null);
  },
  setSetting: (key: string, value: string) => {
    state.writes.push({ key, value });
    state.store.set(key, value);
    return Promise.resolve();
  },
}));

import {
  parseAggregateSources,
  readAggregateSources,
  resetAggregateSourcesCache,
  saveAggregateSources,
} from "@/lib/aggregate-sources";
import { AGGREGATE_SOURCES_KEY } from "@/lib/storageKeys";

describe("parseAggregateSources", () => {
  it("没配置过（null/空串/空白）按全部音源", () => {
    expect(parseAggregateSources(null)).toBeNull();
    expect(parseAggregateSources(undefined)).toBeNull();
    expect(parseAggregateSources("")).toBeNull();
    expect(parseAggregateSources("   ")).toBeNull();
  });

  it("坏 JSON / 非数组一律按全部音源，不抛错", () => {
    expect(parseAggregateSources("{{{")).toBeNull();
    expect(parseAggregateSources("qq,kg")).toBeNull();
    expect(parseAggregateSources('"qq"')).toBeNull();
    expect(parseAggregateSources('{"sources":["qq"]}')).toBeNull();
    expect(parseAggregateSources("null")).toBeNull();
  });

  it("空数组等于全选（存空就是默认值）", () => {
    expect(parseAggregateSources("[]")).toBeNull();
    expect(parseAggregateSources("[ ]")).toBeNull();
    // 全是脏项 → 相当于没勾任何有效源 → 退回全部
    expect(parseAggregateSources("[1, null, true, {}]")).toBeNull();
  });

  it("正常数组保序返回", () => {
    expect(parseAggregateSources('["qq","kg","wyy"]')).toEqual(["qq", "kg", "wyy"]);
  });

  it("去重保序、逐项 trim", () => {
    expect(parseAggregateSources('[" qq ","qq","kg"," kg "]')).toEqual(["qq", "kg"]);
  });

  it("非法 id 与非字符串项直接丢弃，不影响其它项", () => {
    const raw = JSON.stringify(["qq", "a b", `x`.repeat(40), "kg", 42]);
    expect(parseAggregateSources(raw)).toEqual(["qq", "kg"]);
  });

  it("超过 16 个只留前 16 个", () => {
    const many = Array.from({ length: 20 }, (_, i) => `s${i}`);
    expect(parseAggregateSources(JSON.stringify(many))).toHaveLength(16);
    expect(parseAggregateSources(JSON.stringify(many))?.[15]).toBe("s15");
  });
});

describe("readAggregateSources / saveAggregateSources", () => {
  beforeEach(() => {
    state.store.clear();
    state.reads.length = 0;
    state.writes.length = 0;
    state.readThrows = false;
    resetAggregateSourcesCache();
  });

  it("未配置 → null，并且真的读了设置键", async () => {
    await expect(readAggregateSources()).resolves.toBeNull();
    expect(state.reads).toEqual([AGGREGATE_SOURCES_KEY]);
  });

  it("配置过 → 返回勾选的源", async () => {
    state.store.set(AGGREGATE_SOURCES_KEY, '["qq","kg"]');
    await expect(readAggregateSources()).resolves.toEqual(["qq", "kg"]);
  });

  it("读到缓存后不再走 IPC", async () => {
    state.store.set(AGGREGATE_SOURCES_KEY, '["qq"]');
    await readAggregateSources();
    state.store.set(AGGREGATE_SOURCES_KEY, '["kg"]');
    // 进程内缓存：同一次会话里设置页保存会同步刷新，外部改库照旧读缓存
    await expect(readAggregateSources()).resolves.toEqual(["qq"]);
    expect(state.reads).toHaveLength(1);
  });

  it("重置缓存后能读到新值（测试/热重载口径）", async () => {
    state.store.set(AGGREGATE_SOURCES_KEY, '["qq"]');
    await expect(readAggregateSources()).resolves.toEqual(["qq"]);
    state.store.set(AGGREGATE_SOURCES_KEY, '["kg"]');
    resetAggregateSourcesCache();
    await expect(readAggregateSources()).resolves.toEqual(["kg"]);
  });

  it("保存后立即生效（缓存同步，不必再读一次）", async () => {
    await saveAggregateSources(["kg", "qq"]);
    expect(state.writes).toEqual([
      { key: AGGREGATE_SOURCES_KEY, value: '["kg","qq"]' },
    ]);
    resetAggregateSourcesCache();
    await expect(readAggregateSources()).resolves.toEqual(["kg", "qq"]);
  });

  it("保存全选（空数组）写成空串，读回来是「全部音源」", async () => {
    await saveAggregateSources([]);
    expect(state.writes[0]).toEqual({ key: AGGREGATE_SOURCES_KEY, value: "" });
    resetAggregateSourcesCache();
    await expect(readAggregateSources()).resolves.toBeNull();
  });

  it("保存时先归一化：重复项与非法 id 不会落进设置", async () => {
    await saveAggregateSources(["qq", "qq", "a b", ""]);
    expect(state.writes[0].value).toBe('["qq"]');
  });

  it("读设置抛错按全部音源，不让一次 DB 抖动把聚合搜索清空", async () => {
    state.readThrows = true;
    await expect(readAggregateSources()).resolves.toBeNull();
  });
});
