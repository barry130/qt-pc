// 取链降档回退阶梯的回归测试。
//
// 为什么必须有：QQ 有声书章节只有 128k 一档文件（M500 出链、M800/F000 无 purl、
// C400 404），用户默认音质是 320 时整条链全灭，现场表现是「这些是不是无法播放」。
// 修复靠「按注册表声明的档位从请求档一路往下重试」，而这份阶梯必须**只有一份**：
// 它此前只长在播放动作预解析里，引擎主导的自动切歌走的是 usePlayUrlBridge，
// 于是出现「点一下能放、自动播下一集报无法播放」。
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock 会被提升到 import 之前，所以假实现必须用 vi.hoisted 建：
// 直接写 const 会在工厂执行时还处于 TDZ。
const { resolvePlayUrlDetailed, setResolvedPlayUrl } = vi.hoisted(() => ({
  resolvePlayUrlDetailed: vi.fn(),
  setResolvedPlayUrl: vi.fn(async () => {}),
}));
vi.mock("@/source-scripts", () => ({ resolvePlayUrlDetailed }));
// 降档命中时会补写一份「请求档 → 实际地址」的缓存键（否则引擎按请求档查缓存
// 永远未命中，每集都多跑一轮跨进程取链）。
vi.mock("@/services/ipc", () => ({ setResolvedPlayUrl }));

const registryState = {
  sources: [] as { id: string; qualities: string[] }[],
  qualities: [] as { id: string; name: string }[],
  // v12 生效音质清单缓存：本测试不测官方档位，恒空（profile 缺失 = 回落普通子集）
  profiles: {} as Record<string, unknown>,
};
vi.mock("@/stores/sourceRegistry", () => ({
  useSourceRegistryStore: { getState: () => registryState },
  qualityRanksOf: (qualities: { id: string }[]) =>
    qualities.map((q) => q.id).reverse(),
  // 本测试的 registryState 没有官方清单，归一恒原样返回（实现读同一份 state）
  normalizeQualityForSource: (_platform: string, wanted: string) => wanted,
}));

import {
  clearQualityCeilingCache,
  peekQualityCeiling,
  qualityFallbackLadder,
  resolvePlayUrlWithFallback,
} from "@/lib/quality-fallback";
import type { Track } from "@/types";

/** 包侧 QUALITIES 声明序：低 → 高（qualityRanksOf 取反成高→低） */
const QUALITIES = [
  { id: "128", name: "标准 128k" },
  { id: "320", name: "高品 320k" },
  { id: "flac", name: "无损 FLAC" },
];

const track: Track = {
  id: "002vuF5q1q3MVt",
  platform: "qq",
  title: "001 南下古井观",
  singer: "萌鹿剧场",
  album: "道士不好惹",
  picUrl: "",
  duration: 765,
};

function ok(url: string) {
  return { url, stalled: false, referer: "https://y.qq.com/", size: 12247262, actualQuality: "128" };
}
function miss(stalled = false) {
  return { url: "", stalled, referer: "", size: null, actualQuality: "" };
}

beforeEach(() => {
  registryState.sources = [{ id: "qq", qualities: ["128", "320", "flac"] }];
  registryState.qualities = QUALITIES;
  resolvePlayUrlDetailed.mockReset();
  setResolvedPlayUrl.mockClear();
  clearQualityCeilingCache();
});

describe("qualityFallbackLadder", () => {
  it("从请求档往下排到最低档，顺序与注册表高低序一致", () => {
    expect(qualityFallbackLadder("qq", "flac")).toEqual(["flac", "320", "128"]);
    expect(qualityFallbackLadder("qq", "320")).toEqual(["320", "128"]);
    expect(qualityFallbackLadder("qq", "128")).toEqual(["128"]);
  });

  it("请求档该源不提供时从该源最好的档起试（与钳位口径一致）", () => {
    registryState.sources = [{ id: "bili", qualities: ["128", "320"] }];
    expect(qualityFallbackLadder("bili", "flac")).toEqual(["320", "128"]);
  });

  it("阶梯彻底为空（注册表未就绪）时照原样只试请求档", () => {
    registryState.sources = [];
    registryState.qualities = [];
    expect(qualityFallbackLadder("qq", "320")).toEqual(["320"]);
  });

  it("源未声明档位时退回全局档位表", () => {
    registryState.sources = [];
    expect(qualityFallbackLadder("qq", "320")).toEqual(["320", "128"]);
  });
});

describe("resolvePlayUrlWithFallback", () => {
  it("320 全灭时降到 128 出链，并报告实际档位", async () => {
    resolvePlayUrlDetailed
      .mockResolvedValueOnce(miss())
      .mockResolvedValueOnce(ok("http://cdn/M500.mp3"));

    const res = await resolvePlayUrlWithFallback(track, "320");

    expect(res.url).toBe("http://cdn/M500.mp3");
    expect(res.quality).toBe("128");
    expect(res.referer).toBe("https://y.qq.com/");
    expect(res.size).toBe(12247262);
    // 第一次用请求档，第二次才降档 —— 不许一上来就降
    expect(resolvePlayUrlDetailed.mock.calls.map((c) => c[1])).toEqual(["320", "128"]);
    // 补写「请求档 → 实际地址」缓存键：引擎按请求档查缓存才命中，不必再问前端
    expect(setResolvedPlayUrl).toHaveBeenCalledTimes(1);
    const [cachedTrack, cachedQuality, cachedUrl] = setResolvedPlayUrl.mock.calls[0] as unknown[];
    expect((cachedTrack as Track).id).toBe("002vuF5q1q3MVt");
    expect(cachedQuality).toBe("320");
    expect(cachedUrl).toBe("http://cdn/M500.mp3");
  });

  it("请求档一拿就中时不白跑后续档位", async () => {
    resolvePlayUrlDetailed.mockResolvedValueOnce(ok("http://cdn/M800.mp3"));

    const res = await resolvePlayUrlWithFallback(track, "320");

    expect(res.quality).toBe("320");
    expect(resolvePlayUrlDetailed).toHaveBeenCalledTimes(1);
    // 没有降档就不该补写（resolvePlayUrlDetailed 已按请求档写过一次）
    expect(setResolvedPlayUrl).not.toHaveBeenCalled();
  });

  it("全档失败时把「有一次是环境问题」汇成 stalled，引擎据此不计熔断", async () => {
    resolvePlayUrlDetailed
      .mockResolvedValueOnce(miss(false))
      .mockResolvedValueOnce(miss(true));

    const res = await resolvePlayUrlWithFallback(track, "320");

    expect(res.url).toBe("");
    expect(res.quality).toBe("");
    expect(res.stalled).toBe(true);
  });

  it("全档都是内容问题（源确实没这首）时 stalled 保持 false", async () => {
    resolvePlayUrlDetailed.mockResolvedValue(miss(false));

    const res = await resolvePlayUrlWithFallback(track, "128");

    expect(res.stalled).toBe(false);
  });
});

// 有声书一集一个 track，引擎地址缓存按 trackId 存、跨集不命中 —— 不记「这张专辑
// 只能出到哪档」的话，每一集都要重付一次 320 跑满 9s 链预算再降档的代价。
describe("专辑档位上限记忆", () => {
  const nextChapter: Track = { ...track, id: "000QFkFm38BtJz", title: "002 陈家祖训" };

  it("降档命中后记下这张专辑的上限，同专辑下一集直接从该档起试", async () => {
    resolvePlayUrlDetailed.mockResolvedValueOnce(miss()).mockResolvedValueOnce(ok("http://cdn/M500-1.mp3"));

    await resolvePlayUrlWithFallback(track, "320");

    expect(peekQualityCeiling("qq", "道士不好惹")).toBe("128");
    expect(qualityFallbackLadder("qq", "320", "道士不好惹")).toEqual(["128"]);

    // 下一集：第一次就命中 128，不再白跑 320
    resolvePlayUrlDetailed.mockClear();
    resolvePlayUrlDetailed.mockResolvedValueOnce(ok("http://cdn/M500-2.mp3"));
    const res = await resolvePlayUrlWithFallback(nextChapter, "320");

    expect(res.quality).toBe("128");
    expect(resolvePlayUrlDetailed.mock.calls.map((c) => c[1])).toEqual(["128"]);
  });

  it("以请求档命中时不记上限（320 成功不代表这张专辑没有无损）", async () => {
    resolvePlayUrlDetailed.mockResolvedValueOnce(ok("http://cdn/M800.mp3"));

    await resolvePlayUrlWithFallback(track, "320");

    expect(peekQualityCeiling("qq", "道士不好惹")).toBeNull();
    expect(qualityFallbackLadder("qq", "flac", "道士不好惹")).toEqual(["flac", "320", "128"]);
  });

  it("请求档本来就低于记忆档时不动（用户手动选了 128 就只试 128）", async () => {
    resolvePlayUrlDetailed.mockResolvedValueOnce(miss()).mockResolvedValueOnce(ok("http://cdn/M500.mp3"));
    await resolvePlayUrlWithFallback(track, "320");

    expect(qualityFallbackLadder("qq", "128", "道士不好惹")).toEqual(["128"]);
  });

  it("记忆档不在该源阶梯上时忽略它，不改起点", () => {
    registryState.sources = [{ id: "qq", qualities: ["128", "320", "flac"] }];
    resolvePlayUrlDetailed.mockResolvedValueOnce(miss()).mockResolvedValueOnce(ok("http://cdn/M500.mp3"));
    return resolvePlayUrlWithFallback(track, "320").then(() => {
      // 换到只声明 320 的源时，记忆里的 128 不在阶梯上 → 仍从请求档起试
      registryState.sources = [{ id: "qq", qualities: ["320"] }];
      expect(qualityFallbackLadder("qq", "320", "道士不好惹")).toEqual(["320"]);
    });
  });

  it("专辑名为空不记，避免「未知专辑」共用一个键串味", async () => {
    resolvePlayUrlDetailed.mockResolvedValueOnce(miss()).mockResolvedValueOnce(ok("http://cdn/M500.mp3"));
    await resolvePlayUrlWithFallback({ ...track, album: "" }, "320");

    expect(peekQualityCeiling("qq", "")).toBeNull();
    expect(qualityFallbackLadder("qq", "320", "")).toEqual(["320", "128"]);
  });

  it("清缓存后回到「从请求档起试」", async () => {
    resolvePlayUrlDetailed.mockResolvedValueOnce(miss()).mockResolvedValueOnce(ok("http://cdn/M500.mp3"));
    await resolvePlayUrlWithFallback(track, "320");
    expect(clearQualityCeilingCache()).toBe(1);
    expect(qualityFallbackLadder("qq", "320", "道士不好惹")).toEqual(["320", "128"]);
  });
});
