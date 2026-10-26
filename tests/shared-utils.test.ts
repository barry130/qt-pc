/**
 * 公共工具模块（`lib/text` / `lib/coerce` / `lib/format` / `lib/pending-cache`）的语义锁。
 *
 * 这四个模块是从各处重复实现里抽出来的**唯一真源**（2026-10-23 去重合并），
 * 消费方一多，改一处就会牵动每日推荐画像、听歌报告、AI 回复解析、歌手头像缓存……
 * 所以语义必须钉死在这里：想改行为先改这份测试，看看到底谁会用坏。
 */
import { describe, expect, it, vi } from "vitest";

import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asRecordOrNull,
  asString,
  coerceBool,
  coerceNumber,
  coerceString,
} from "@/lib/coerce";
import { formatBytes } from "@/lib/format";
import { createPendingStringCache } from "@/lib/pending-cache";
import {
  compactText,
  hashString,
  jitter,
  localDateKey,
  normText,
  safeDecodeURIComponent,
  songNameKey,
  trackKey,
  truncateChars,
} from "@/lib/text";

describe("lib/text 归一化", () => {
  it("normText 去掉括号内容、标点与大小写", () => {
    expect(normText("晴天 (Live)")).toBe(normText("晴天"));
    expect(normText("晴天（Live）")).toBe("晴天");
    expect(normText("Hello, World!")).toBe("helloworld");
    expect(normText("a　b")).toBe("ab"); // 全角空格
  });

  it("normText 不剥嵌套括号里的正文（只吃括号整体）", () => {
    expect(normText("歌名（现场版）")).toBe("歌名");
    expect(normText("歌名")).toBe("歌名");
  });

  it("compactText 保留括号与标点，只折叠全部空白并转小写", () => {
    expect(compactText("  Jay   Chou ")).toBe("jaychou");
    expect(compactText("晴天 (Live)")).toBe("晴天(live)");
  });

  it("trackKey / songNameKey 分别按平台和歌名歌手", () => {
    const base = {
      platform: "wyy" as const,
      id: "1",
      title: "晴天",
      singer: "周杰伦",
      album: "",
      picUrl: "",
      duration: 200,
    };
    expect(trackKey(base)).toBe("wyy:1");
    expect(songNameKey(base)).toBe(songNameKey({ ...base, platform: "qq", id: "9" }));
    expect(songNameKey(base)).toBe("晴天|周杰伦");
  });

  it("localDateKey 用本地时区且补零", () => {
    expect(localDateKey(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
    expect(localDateKey(new Date(2026, 11, 31, 0, 1))).toBe("2026-12-31");
  });

  it("safeDecodeURIComponent 解码失败时原样返回", () => {
    expect(safeDecodeURIComponent("%E6%99%B4%E5%A4%A9")).toBe("晴天");
    expect(safeDecodeURIComponent("%E6%99")).toBe("%E6%99");
  });

  it("hashString 稳定且落 32 位无符号区间", () => {
    expect(hashString("周杰伦")).toBe(hashString("周杰伦"));
    expect(hashString("周杰伦")).not.toBe(hashString("陈奕迅"));
    const value = hashString("任意");
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(2 ** 32);
  });

  it("jitter 落在 [0,1) 且同 seed/key 稳定、换 seed 会变", () => {
    const a = jitter("2026-10-23", "wyy:1");
    expect(a).toBe(jitter("2026-10-23", "wyy:1"));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
    expect(jitter("换一批", "wyy:1")).not.toBe(a);
  });

  it("truncateChars 按码点截断，不劈开代理对", () => {
    expect(truncateChars("abcdef", 3)).toBe("abc");
    expect(truncateChars("晴天", 5)).toBe("晴天");
    expect(truncateChars("😀😀😀😀", 2)).toBe("😀😀");
    expect(truncateChars("abcdef", 0)).toBe("");
  });
});

describe("lib/coerce 两族语义", () => {
  it("strict 族只认本类型，不做字符串转换", () => {
    expect(asString(42)).toBe("");
    expect(asString("42")).toBe("42");
    expect(asNumber("42")).toBe(0);
    expect(asNumber(42.5)).toBe(42.5);
    expect(asBoolean("true")).toBe(false);
    expect(asBoolean(true)).toBe(true);
    expect(asRecord([])).toEqual({});
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecordOrNull([])).toBeNull();
    expect(asArray("x")).toEqual([]);
  });

  it("coerce 族宽松：字符串数字/布尔文本都转", () => {
    expect(coerceString(42)).toBe("42");
    expect(coerceString(null)).toBe("");
    expect(coerceNumber("42")).toBe(42);
    expect(coerceNumber("abc")).toBe(0);
    expect(coerceNumber(true)).toBe(1);
    expect(coerceBool("true")).toBe(true);
    expect(coerceBool(1)).toBe(true);
    expect(coerceBool("0")).toBe(false);
  });
});

describe("lib/format 体积", () => {
  it("自动换单位、小于 100 保留一位小数", () => {
    expect(formatBytes(0)).toBe("");
    expect(formatBytes(null)).toBe("");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(1024 * 1024 * 1.5)).toBe("1.5 MB");
    expect(formatBytes(1024 * 1024 * 1024 * 2)).toBe("2.0 GB");
    expect(formatBytes(1024 * 1024 * 200)).toBe("200 MB");
  });
});

describe("lib/pending-cache 在飞去重", () => {
  it("同 key 并发只调一次工厂，结果同步可读", async () => {
    const cache = createPendingStringCache(4);
    const factory = vi.fn(async () => "值");
    expect(cache.peek("a")).toBeNull();
    const [x, y] = await Promise.all([cache.resolve("a", factory), cache.resolve("a", factory)]);
    expect([x, y]).toEqual(["值", "值"]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(cache.peek("a")).toBe("值");
  });

  it("工厂失败也落空串，避免每次进页重发注定失败的请求", async () => {
    const cache = createPendingStringCache(4);
    await expect(cache.resolve("b", async () => Promise.reject(new Error("boom")))).resolves.toBe("");
    expect(cache.peek("b")).toBe("");
  });

  it("超容量逐出最旧，clear 返回清掉的条目数", async () => {
    const cache = createPendingStringCache(2);
    await cache.resolve("k1", async () => "1");
    await cache.resolve("k2", async () => "2");
    await cache.resolve("k3", async () => "3");
    expect(cache.peek("k1")).toBeNull();
    expect(cache.peek("k3")).toBe("3");
    expect(cache.clear()).toBeGreaterThan(0);
    expect(cache.peek("k2")).toBeNull();
  });
});
