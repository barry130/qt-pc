import { describe, expect, it } from "vitest";
import type { Track } from "@/types";
import type { StyleProfile } from "@/lib/recommend-types";
import { songNameKey, trackKey } from "@/lib/text";
import {
  buildRadioBatch,
  markUsed,
  RADIO_BATCH,
  RADIO_MAX_PER_SINGER,
  RADIO_REFILL_THRESHOLD,
  RADIO_SEED_LANE,
  seedLane,
  sessionVariant,
  shouldRefill,
} from "@/lib/radio-queue";

/**
 * 私人 FM 的选曲逻辑（A7）。
 *
 * 这里只测纯函数：`buildRadioBatch` 的全部分支都可以用假池子跑出来，
 * 不需要 mock IPC 或播放器 —— 页面/store 的接线另测（见 RadioPage）。
 */

function track(id: string, title: string, singer: string, album = "专辑"): Track {
  return {
    id,
    platform: "local",
    title,
    singer,
    album,
    picUrl: "",
    duration: 240,
  };
}

/** 一份有信号的画像：华语 / 三四分钟 / 认识「歌手甲」 */
function styleProfile(overrides: Partial<StyleProfile> = {}): StyleProfile {
  return {
    langs: { zh: 1 },
    bands: { normal: 1 },
    mainLang: "zh",
    mainBand: "normal",
    singers: {},
    albums: {},
    tags: ["华语"],
    sampleSize: 20,
    ...overrides,
  };
}

const noDislike = (pool: Track[]): boolean[] => pool.map(() => false);

describe("buildRadioBatch：一轮之内不重复", () => {
  it("已在 usedKeys 里的歌不会再被排出来", () => {
    const pool = [track("a1", "第一首", "歌手甲"), track("a2", "第二首", "歌手甲")];
    const usedKeys = new Set([trackKey(pool[0]!)]);
    const batch = buildRadioBatch({
      pool,
      profile: styleProfile(),
      taste: "heart",
      usedKeys,
      disliked: noDislike(pool),
    });
    expect(batch.map((t) => t.id)).toEqual(["a2"]);
  });

  it("markUsed 之后下一批与上一批零交集（跨批次硬去重）", () => {
    const pool = Array.from({ length: 40 }, (_, i) =>
      track(`t${i}`, `歌曲${i}`, `歌手${i % 8}`, `专辑${i % 5}`),
    );
    const first = buildRadioBatch({
      pool,
      profile: styleProfile(),
      taste: "heart",
      usedKeys: new Set<string>(),
      disliked: noDislike(pool),
      count: 10,
    });
    expect(first.length).toBe(10);
    const usedKeys = new Set<string>();
    markUsed(usedKeys, first);
    const second = buildRadioBatch({
      pool,
      profile: styleProfile(),
      taste: "heart",
      usedKeys,
      disliked: noDislike(pool),
      count: 10,
    });
    const firstKeys = new Set(first.map((t) => trackKey(t)));
    second.forEach((t) => {
      expect(firstKeys.has(trackKey(t))).toBe(false);
      expect(firstKeys.has(songNameKey(t))).toBe(false);
    });
  });

  it("池子被排空时返回空数组，不拿重复的歌凑数", () => {
    const pool = [track("a1", "第一首", "歌手甲"), track("a2", "第二首", "歌手甲")];
    const usedKeys = new Set<string>();
    markUsed(usedKeys, pool);
    expect(
      buildRadioBatch({
        pool,
        profile: styleProfile(),
        taste: "familiar",
        usedKeys,
        disliked: noDislike(pool),
      }),
    ).toEqual([]);
  });

  it("空池子直接返回空数组", () => {
    expect(
      buildRadioBatch({
        pool: [],
        profile: styleProfile(),
        taste: "explore",
        usedKeys: new Set<string>(),
        disliked: [],
      }),
    ).toEqual([]);
  });
});

describe("buildRadioBatch：配额与屏蔽", () => {
  it("有别的歌手可挑时，同一歌手在一批里最多 RADIO_MAX_PER_SINGER 首", () => {
    // 3 首「歌手甲」+ 足够多的别人：配额能兜住，不该出现第 4 首同歌手
    const pool = [
      ...Array.from({ length: 3 }, (_, i) => track(`s${i}`, `甲的歌${i}`, "歌手甲")),
      ...Array.from({ length: 12 }, (_, i) => track(`o${i}`, `别人的歌${i}`, `歌手${i + 2}`)),
    ];
    const batch = buildRadioBatch({
      pool,
      profile: styleProfile(),
      taste: "heart",
      usedKeys: new Set<string>(),
      disliked: noDislike(pool),
      count: RADIO_BATCH,
    });
    const sameSinger = batch.filter((t) => t.singer === "歌手甲").length;
    expect(sameSinger).toBeLessThanOrEqual(RADIO_MAX_PER_SINGER);
    expect(batch.length).toBe(RADIO_BATCH);
  });

  it("整池只有一个歌手时配额会放开补齐（引擎的兜底口径，FM 照抄）", () => {
    // 引擎的配额只约束前排：严格按配额选不满 target 时会逐步放宽，
    // 否则「就爱听一个人」的用户会只拿到 3 首。这里固定这个行为，
    // 免得以后有人把放宽删掉导致 FM 一开就"没歌可听"。
    const pool = Array.from({ length: 12 }, (_, i) => track(`s${i}`, `歌曲${i}`, "歌手甲"));
    const batch = buildRadioBatch({
      pool,
      profile: styleProfile(),
      taste: "heart",
      usedKeys: new Set<string>(),
      disliked: noDislike(pool),
      count: RADIO_BATCH,
    });
    expect(batch.length).toBe(12);
  });

  it("disliked 与 pool 同序：被屏蔽的那首即使分高也不出现", () => {
    const pool = [track("a1", "第一首", "歌手甲"), track("a2", "第二首", "歌手乙")];
    const batch = buildRadioBatch({
      pool,
      profile: styleProfile(),
      taste: "heart",
      usedKeys: new Set<string>(),
      // 只屏蔽第一首
      disliked: [true, false],
    });
    expect(batch.map((t) => t.id)).toEqual(["a2"]);
  });

  it("count 为 0 时不排歌（调用方算错余量也不会炸）", () => {
    const pool = [track("a1", "第一首", "歌手甲")];
    expect(
      buildRadioBatch({
        pool,
        profile: styleProfile(),
        taste: "heart",
        usedKeys: new Set<string>(),
        disliked: noDislike(pool),
        count: 0,
      }),
    ).toEqual([]);
  });
});

describe("buildRadioBatch：会话轮换", () => {
  /**
   * 有真实分数差的池子：前 20 首「收藏过」（+9），后 20 首没听过。
   * 引擎排序因此高度确定 —— 这正是用户「每次重新打开 FM 都一模一样」的场景，
   * 也是只靠 `variant` 抖动（1.5，还要被归一化除小）救不回来的原因。
   */
  function rankedPool(): Track[] {
    return Array.from({ length: 40 }, (_, i) =>
      track(`t${i}`, `歌曲${i}`, `歌手${i}`, `专辑${i}`),
    );
  }
  const savedFirstHalf = (pool: Track[]): Set<string> =>
    new Set(pool.slice(0, 20).map((t) => trackKey(t)));
  const build = (pool: Track[], extra: Partial<Parameters<typeof buildRadioBatch>[0]> = {}) =>
    buildRadioBatch({
      pool,
      profile: styleProfile(),
      taste: "heart",
      usedKeys: new Set<string>(),
      disliked: noDislike(pool),
      savedKeys: savedFirstHalf(pool),
      count: RADIO_BATCH,
      ...extra,
    });

  it("同一 variant 可复现，不同 variant 换出不同的批次", () => {
    const pool = rankedPool();
    const a1 = build(pool, { variant: "session-a" }).map((t) => t.id);
    const a2 = build(pool, { variant: "session-a" }).map((t) => t.id);
    const b = build(pool, { variant: "session-b" }).map((t) => t.id);
    expect(a2).toEqual(a1);
    expect(a1.length).toBe(RADIO_BATCH);
    // 只换种子不够时这里的第一次修复就白做了：必须真的换出一批
    expect(b).not.toEqual(a1);
    expect(b[0]).not.toBe(a1[0]);
  });

  it("轮换只在引擎的高分窗口里进行（低分档进不来）", () => {
    // 200 首收藏（+9 分）+ 200 首没听过（0 分）：窗口只有 count × 3 = 36 个名额，
    // 会被高分档占满，所以任何一次会话的批次都必须整批落在收藏档里 ——
    // 「在整池里乱抽」会立刻在这里露馅。
    const pool = Array.from({ length: 400 }, (_, index) =>
      track(`p${index}`, `歌曲 ${index}`, `歌手 ${index}`),
    );
    const saved = new Set(pool.slice(0, 200).map((t) => trackKey(t)));
    for (const variant of ["session-a", "session-b", "session-c"]) {
      const batch = build(pool, { variant, savedKeys: saved });
      expect(batch.length).toBe(RADIO_BATCH);
      batch.forEach((picked) => expect(saved.has(trackKey(picked))).toBe(true));
    }
  });

  it("avoidKeys：上一轮排过的歌整批避开", () => {
    const pool = rankedPool();
    const first = build(pool, { variant: "round-1" });
    const second = build(pool, { variant: "round-2", avoidKeys: first.map((t) => trackKey(t)) });
    const firstKeys = new Set(first.map((t) => trackKey(t)));
    expect(second.length).toBe(RADIO_BATCH);
    second.forEach((t) => expect(firstKeys.has(trackKey(t))).toBe(false));
  });

  it("没有 variant 时保持引擎顺序（每日推荐那种可复现用法）", () => {
    const pool = rankedPool();
    const batch = build(pool);
    expect(build(pool).map((t) => t.id)).toEqual(batch.map((t) => t.id));
    // 引擎排在最前的就是第一首（窗口前缀稳定：count=1 的窗口头与 count=12 的一致）
    expect(batch[0]!.id).toBe(build(pool, { count: 1 })[0]!.id);
  });

  it("轮换之后仍守住同歌手配额", () => {
    const pool = [
      ...Array.from({ length: 6 }, (_, i) => track(`s${i}`, `甲的歌${i}`, "歌手甲", `甲专辑${i}`)),
      ...Array.from({ length: 12 }, (_, i) => track(`o${i}`, `别人的歌${i}`, `歌手${i + 2}`)),
    ];
    for (const variant of ["v1", "v2", "v3", "v4"]) {
      const batch = buildRadioBatch({
        pool,
        profile: styleProfile(),
        taste: "heart",
        usedKeys: new Set<string>(),
        disliked: noDislike(pool),
        count: RADIO_BATCH,
        variant,
      });
      expect(batch.filter((t) => t.singer === "歌手甲").length).toBeLessThanOrEqual(
        RADIO_MAX_PER_SINGER,
      );
      expect(batch.length).toBe(RADIO_BATCH);
    }
  });
});

describe("seedLane：先接上种子", () => {
  const seed = track("seed", "种子曲", "歌手甲", "同名专辑");
  const pool = [
    seed,
    track("same-album", "同专辑曲", "歌手甲", "同名专辑"),
    track("same-singer", "同歌手曲", "歌手甲", "另一张"),
    track("other", "别人的歌", "歌手乙", "别的专辑"),
  ];

  it("同专辑先于同歌手，且不含种子自己", () => {
    const lane = seedLane(pool, seed);
    expect(lane.map((t) => t.id)).toEqual(["same-album", "same-singer"]);
  });

  it("最多 RADIO_SEED_LANE 首", () => {
    const wide = [
      seed,
      ...Array.from({ length: 8 }, (_, i) => track(`sa${i}`, `同专辑${i}`, "歌手甲", "同名专辑")),
    ];
    expect(seedLane(wide, seed).length).toBe(RADIO_SEED_LANE);
  });

  it("没有种子 / lane 为 0 时给空车道", () => {
    expect(seedLane(pool, null)).toEqual([]);
    expect(seedLane(pool, seed, 0)).toEqual([]);
  });
});

describe("shouldRefill / markUsed", () => {
  it("余量 ≤ 阈值才补", () => {
    expect(shouldRefill(RADIO_REFILL_THRESHOLD)).toBe(true);
    expect(shouldRefill(RADIO_REFILL_THRESHOLD - 1)).toBe(true);
    expect(shouldRefill(RADIO_REFILL_THRESHOLD + 1)).toBe(false);
  });

  it("markUsed 同时记下 trackKey 与歌名键（防同名翻唱重复出现）", () => {
    const usedKeys = new Set<string>();
    const one = track("a1", "长安谣", "歌手甲");
    markUsed(usedKeys, [one]);
    expect(usedKeys.has(trackKey(one))).toBe(true);
    expect(usedKeys.has(songNameKey(one))).toBe(true);
  });
});

describe("sessionVariant", () => {
  it("每次开始都是新种子（同一毫秒内连续调用也不撞）", () => {
    const seeds = [sessionVariant(), sessionVariant(), sessionVariant()];
    expect(new Set(seeds).size).toBe(3);
  });
});
