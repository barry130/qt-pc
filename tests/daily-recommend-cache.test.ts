// 每日推荐缓存：命中判定是「每天第一次进来生成、当天再进直接读」的支点，
// 判错一次就是十几个音源请求白打一遍。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/types";

const store = new Map<string, string>();

vi.mock("@/services/ipc", () => ({
  getSetting: (key: string) => Promise.resolve(store.get(key) ?? null),
  setSetting: (key: string, value: string) => {
    store.set(key, value);
    return Promise.resolve();
  },
  getTopSingers: () => Promise.resolve([]),
  listHistory: () => Promise.resolve([]),
  listFavorites: () => Promise.resolve([]),
  listDislikes: () => Promise.resolve([]),
  checkDisliked: () => Promise.resolve([]),
}));

vi.mock("@/source-scripts", () => ({
  getArtistSongs: () => Promise.resolve({ songs: [], picUrl: "", hasMore: false }),
  // 多关键词聚合（数据包 searchMany）：本文件只测缓存读写，返回空批即可
  searchManyBatches: (keywords: string[]) =>
    Promise.resolve({
      groups: keywords.map((keyword) => ({ keyword, ok: true, batches: [] })),
      truncated: false,
    }),
  searchPageMaxOf: () => 50,
}));

import {
  DAILY_RECOMMEND_CACHE_KEY,
  DAILY_RECOMMEND_MODE_KEY,
} from "@/lib/storageKeys";
import {
  DAILY_RULE_VERSION,
  clearTodayResult,
  loadTodayResult,
  readDailyCache,
  readMode,
  saveMode,
  todayKey,
  type DailyRecommendResult,
} from "@/lib/daily-recommend";

function track(id: string): Track {
  return { id, platform: "wyy", title: `歌${id}`, singer: "某歌手", album: "", picUrl: "", duration: 200 };
}

function result(overrides: Partial<DailyRecommendResult> = {}): DailyRecommendResult {
  return {
    date: todayKey(),
    mode: "rule",
    requested: "rule",
    generatedAt: Date.now(),
    title: "t",
    summary: "s",
    items: [{ track: track("1"), reason: "r" }],
    notice: null,
    ...overrides,
  };
}

function writeCache(payload: unknown): void {
  store.set(DAILY_RECOMMEND_CACHE_KEY, JSON.stringify(payload));
}

function cacheOf(today: unknown, v = DAILY_RULE_VERSION, days: unknown[] = []): unknown {
  return { v, days, today };
}

beforeEach(() => {
  store.clear();
});

describe("readDailyCache", () => {
  it("没有任何缓存时返回空结构，不抛错", async () => {
    const cache = await readDailyCache();
    expect(cache.days).toEqual([]);
    expect(cache.today).toBeNull();
  });

  it("脏数据（非 JSON）当空处理", async () => {
    store.set(DAILY_RECOMMEND_CACHE_KEY, "{坏掉的");
    const cache = await readDailyCache();
    expect(cache.today).toBeNull();
    expect(cache.days).toEqual([]);
  });

  it("days 里缺字段的条目被过滤掉（不能让一条脏记录把去重搞坏）", async () => {
    writeCache(cacheOf(null, DAILY_RULE_VERSION, [{ date: "2026-10-20", keys: ["a"] }, { keys: [] }, null]));
    const cache = await readDailyCache();
    expect(cache.days).toHaveLength(1);
    expect(cache.days[0].date).toBe("2026-10-20");
  });
});

describe("loadTodayResult 命中判定", () => {
  it("当天 + 同规则版本 + 有曲目 → 命中", async () => {
    writeCache(cacheOf(result()));
    expect(await loadTodayResult()).not.toBeNull();
  });

  it("不是当天 → 未命中（跨天自动重算）", async () => {
    writeCache(cacheOf(result({ date: "2000-01-01" })));
    expect(await loadTodayResult()).toBeNull();
  });

  it("规则版本变了 → 未命中（改排序逻辑后旧结果必须失效）", async () => {
    writeCache(cacheOf(result(), DAILY_RULE_VERSION + 1));
    expect(await loadTodayResult()).toBeNull();
  });

  it("空歌单不算命中（避免把一次失败的空结果缓存一整天）", async () => {
    writeCache(cacheOf(result({ items: [] })));
    expect(await loadTodayResult()).toBeNull();
  });

  it("要求的模式一致才命中", async () => {
    writeCache(cacheOf(result({ requested: "rule", mode: "rule" })));
    expect(await loadTodayResult("rule")).not.toBeNull();
    expect(await loadTodayResult("local")).toBeNull();
  });

  it("本地模型失败落成 rule 时，仍命中「本地模型精选」——失败只失败一次，不再重搜", async () => {
    writeCache(cacheOf(result({ requested: "local", mode: "rule", notice: "调用失败" })));
    const hit = await loadTodayResult("local");
    expect(hit).not.toBeNull();
    expect(hit?.mode).toBe("rule");
    expect(hit?.notice).toBe("调用失败");
  });

  it("老缓存没有 requested 字段时回落 mode", async () => {
    const legacy = { ...result({ mode: "rule" }) } as Record<string, unknown>;
    delete legacy.requested;
    writeCache(cacheOf(legacy));
    expect(await loadTodayResult("rule")).not.toBeNull();
    expect(await loadTodayResult("local")).toBeNull();
  });

  it("三种模式互不冒充：存 rule 的缓存不会被 server / local 命中", async () => {
    writeCache(cacheOf(result({ requested: "rule", mode: "rule" })));
    expect(await loadTodayResult("rule")).not.toBeNull();
    expect(await loadTodayResult("server")).toBeNull();
    expect(await loadTodayResult("local")).toBeNull();
  });

  it("服务端失败落成 rule 时，仍命中「服务端 AI」——失败只失败一次，不再重搜音源", async () => {
    writeCache(cacheOf(result({ requested: "server", mode: "rule", notice: "服务端没返回" })));
    expect(await loadTodayResult("server")).not.toBeNull();
    // 别的模式不能拿这份结果冒充：规则没调模型、本地模型更没调
    expect(await loadTodayResult("rule")).toBeNull();
    expect(await loadTodayResult("local")).toBeNull();
  });
});

describe("clearTodayResult", () => {
  it("只清当天结果，历史 days 保留（跨天去重不能被「换一批」抹掉）", async () => {
    writeCache(cacheOf(result(), DAILY_RULE_VERSION, [{ date: todayKey(), keys: ["wyy:9"] }]));
    await clearTodayResult();
    expect(await loadTodayResult()).toBeNull();
    const cache = await readDailyCache();
    expect(cache.days).toHaveLength(1);
    expect(cache.days[0].keys).toEqual(["wyy:9"]);
  });
});

describe("模式读写", () => {
  it("没存过时是 rule", async () => {
    expect(await readMode()).toBe("rule");
  });

  it("存什么读什么", async () => {
    await saveMode("local");
    expect(store.get(DAILY_RECOMMEND_MODE_KEY)).toBe("local");
    expect(await readMode()).toBe("local");
  });

  it("库里的值被改坏时回落 rule（不能让设置项把页面搞崩）", async () => {
    store.set(DAILY_RECOMMEND_MODE_KEY, "nonsense");
    expect(await readMode()).toBe("rule");
  });
});
