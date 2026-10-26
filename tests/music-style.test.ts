import { describe, expect, it } from "vitest";
import type { StyleProfile, StyleSample, TrackStat } from "@/lib/recommend-types";
import {
  buildStyleProfile,
  describeProfile,
  detectLanguage,
  durationBand,
  profileTagWeights,
  trackQuality,
  trackStyle,
} from "@/lib/music-style";
import type { Track } from "@/types";

const DAY = 24 * 60 * 60 * 1000;
/** 固定"现在"，否则 recency 让断言随真实时间漂移 */
const NOW = Date.UTC(2026, 9, 23, 1, 0, 0);

function track(over: Partial<Track> = {}): Track {
  return {
    id: "t1",
    platform: "wyy",
    title: "",
    singer: "",
    album: "",
    picUrl: "",
    duration: 240,
    ...over,
  };
}

function stat(playCount: number, totalPlayedMs: number, lastPlayedAt = NOW): TrackStat {
  return { playCount, totalPlayedMs, lastPlayedAt };
}

function sample(
  over: Partial<Track> = {},
  extra: { stat?: TrackStat | null; saved?: boolean } = {},
): StyleSample {
  return { track: track(over), ...extra };
}

describe("detectLanguage", () => {
  it("出现假名就判 ja —— 日文歌夹汉字也不会误判成华语", () => {
    expect(detectLanguage("夜に駆ける YOASOBI")).toBe("ja");
    expect(detectLanguage("Lemon（レモン） 米津玄師")).toBe("ja");
  });

  it("出现谚文就判 ko", () => {
    expect(detectLanguage("Dynamite 방탄소년단")).toBe("ko");
    expect(detectLanguage("사랑 韩文汉字")).toBe("ko");
  });

  it("假名优先于谚文与汉字（优先级不可调换）", () => {
    expect(detectLanguage("東方紅 さくら")).toBe("ja");
    expect(detectLanguage("한국 さくら")).toBe("ja");
  });

  it("中文歌带英文副标题仍判 zh（括号内是副标题，不参与比票）", () => {
    expect(detectLanguage("晴天 周杰伦 叶惠美 (Jay Chou)")).toBe("zh");
    expect(detectLanguage("起风了 买辣椒也用券 起风了 (The Wind Rises)")).toBe("zh");
  });

  it("没有括号时汉字只要不是零头也算华语（汉字×2 ≥ 拉丁）", () => {
    expect(detectLanguage("晴天 周杰伦 Jay Chou")).toBe("zh");
    // 汉字 2、拉丁 13：4 < 13，汉字只是零头 → 英文标题
    expect(detectLanguage("Hello 中文 Adele Someone")).toBe("en");
  });

  it("纯英文判 en", () => {
    expect(detectLanguage("Shape of You Ed Sheeran Divide")).toBe("en");
    expect(detectLanguage("Shape of You (Live)")).toBe("en");
  });

  it("纯器乐标题 / 空串 / 纯数字 / 俄语判 und", () => {
    expect(detectLanguage("✦ ✦ ✦")).toBe("und");
    expect(detectLanguage("")).toBe("und");
    expect(detectLanguage("2024")).toBe("und");
    expect(detectLanguage("Судьба")).toBe("und");
  });
});

describe("durationBand", () => {
  it("四个边界", () => {
    expect(durationBand(149)).toBe("short");
    expect(durationBand(150)).toBe("normal");
    expect(durationBand(239)).toBe("normal");
    expect(durationBand(240)).toBe("long");
    expect(durationBand(329)).toBe("long");
    expect(durationBand(330)).toBe("epic");
  });

  it("未知时长（<=0 / NaN）落到中性的 normal，而不是 short", () => {
    expect(durationBand(0)).toBe("normal");
    expect(durationBand(-1)).toBe("normal");
    expect(durationBand(Number.NaN)).toBe("normal");
  });
});

describe("trackStyle", () => {
  it("歌手/专辑按键归一化：去空格括号标点、转小写", () => {
    const style = trackStyle(
      track({ title: "晴天 (Live)", singer: "周杰伦（Jay Chou）", album: "叶惠美" }),
    );
    expect(style.singerKey).toBe("周杰伦");
    expect(style.albumKey).toBe("周杰伦|叶惠美");
    expect(style.lang).toBe("zh");
    expect(style.band).toBe("long");
  });

  it("未知专辑不给专辑键（免得所有缺元数据的歌互相「同专辑」）", () => {
    expect(trackStyle(track({ singer: "周杰伦", album: "" })).albumKey).toBe("");
    expect(trackStyle(track({ singer: "周杰伦", album: "未知专辑" })).albumKey).toBe("");
    expect(trackStyle(track({ singer: "周杰伦", album: "Unknown" })).albumKey).toBe("");
  });

  it("同一首歌在不同音源（大小写/空格不同）得到同一对键", () => {
    const a = trackStyle(track({ title: "晴天", singer: "Jay Chou", album: "叶惠美" }));
    const b = trackStyle(track({ title: "晴天", singer: "jay  chou", album: "叶惠美" }));
    expect(a.singerKey).toBe(b.singerKey);
    expect(a.albumKey).toBe(b.albumKey);
  });
});

describe("trackQuality", () => {
  it("completion 超过 1 按 1 算（重复听同一段也会把 totalPlayedMs 堆高）", () => {
    const q = trackQuality(stat(2, 240 * 5 * 1000), 240, 10, NOW);
    expect(q.completion).toBe(1);
    expect(q.affinity).toBeCloseTo(0.76, 5); // .5×1 + .3×.2 + .2×1
  });

  it("时长未知 / playCount 为 0 时 completion 给中性 0.5", () => {
    expect(trackQuality(stat(5, 999_999), 0, 5, NOW).completion).toBe(0.5);
    expect(trackQuality(stat(0, 0), 240, 5, NOW).completion).toBe(0.5);
  });

  it("replay = playCount / 全库最大 playCount，分母为 0 时给 0", () => {
    expect(trackQuality(stat(5, 0), 240, 10, NOW).replay).toBe(0.5);
    expect(trackQuality(stat(5, 0), 240, 0, NOW).replay).toBe(0);
  });

  it("recency 30 天线性衰减，没听过给 0", () => {
    const recencyOf = (lastPlayedAt: number) =>
      trackQuality(stat(1, 0, lastPlayedAt), 240, 1, NOW).recency;
    expect(recencyOf(0)).toBe(0);
    expect(recencyOf(NOW)).toBe(1);
    expect(recencyOf(NOW - 15 * DAY)).toBeCloseTo(0.5, 5);
    expect(recencyOf(NOW - 40 * DAY)).toBe(0);
  });

  it("skipped：≥3 次但平均听不到四成 = 真不喜欢", () => {
    // 3 次 × 240s × 20%
    expect(trackQuality(stat(3, 3 * 240 * 0.2 * 1000), 240, 3, NOW).skipped).toBe(true);
    expect(trackQuality(stat(3, 3 * 240 * 0.8 * 1000), 240, 3, NOW).skipped).toBe(false);
    // 播放次数不够，不看比例
    expect(trackQuality(stat(2, 2 * 240 * 0.1 * 1000), 240, 2, NOW).skipped).toBe(false);
  });

  it("skipped 不看 saved —— 这个函数只判定行为", () => {
    expect(trackQuality(stat(3, 3 * 240 * 0.1 * 1000), 240, 3, NOW).skipped).toBe(true);
  });
});

describe("buildStyleProfile", () => {
  it("无行为也无收藏的样本被丢弃（不代表口味）", () => {
    const profile = buildStyleProfile({
      samples: [sample({ title: "晴天", singer: "周杰伦" }), sample({ title: "晴天", singer: "周杰伦" }, { saved: true })],
      now: NOW,
    });
    // 同一首歌（同 platform:id）只算一条，权重 = 收藏 0.5
    expect(profile.sampleSize).toBe(1);
    expect(profile.langs).toEqual({ zh: 1 });
  });

  it("langs / bands 归一化到 Σ=1", () => {
    const profile = buildStyleProfile({
      samples: [
        sample({ title: "晴天", singer: "周杰伦", duration: 240 }, { stat: stat(10, 10 * 240 * 1000) }),
        sample({ title: "告白气球", singer: "周杰伦", duration: 200 }, { stat: stat(5, 5 * 200 * 1000) }),
        sample({ title: "Shape of You", singer: "Ed Sheeran", duration: 240 }, { saved: true }),
      ],
      now: NOW,
    });
    const langSum = Object.values(profile.langs).reduce<number>((a, b) => a + (b ?? 0), 0);
    const bandSum = Object.values(profile.bands).reduce<number>((a, b) => a + (b ?? 0), 0);
    expect(langSum).toBeCloseTo(1, 10);
    expect(bandSum).toBeCloseTo(1, 10);
  });

  it("singers 归一化到最大值=1（不是 Σ=1），否则单歌手用户的亲和全被抹平", () => {
    const profile = buildStyleProfile({
      samples: [
        // 甲：每首都听完、次数最多、刚听过 → affinity ≈ 1
        sample({ id: "a1", title: "晴天", singer: "甲", duration: 240 }, { stat: stat(10, 10 * 240 * 1000) }),
        // 乙：听完但只听了 2 次、20 天前 → 明显更弱
        sample(
          { id: "b1", title: "雨爱", singer: "乙", duration: 240 },
          { stat: stat(2, 2 * 240 * 1000, NOW - 20 * DAY) },
        ),
      ],
      now: NOW,
    });
    expect(profile.singers["甲"]).toBeCloseTo(1, 10);
    expect(profile.singers["乙"]).toBeCloseTo(0.6267, 3);
    expect(Object.keys(profile.singers)).toHaveLength(2);
  });

  it("最大播放次数取本批最大值，而不是全局常量", () => {
    const profile = buildStyleProfile({
      samples: [
        sample({ id: "a1", title: "晴天", singer: "甲" }, { stat: stat(4, 4 * 240 * 1000) }),
        sample({ id: "a2", title: "七里香", singer: "乙" }, { stat: stat(8, 8 * 240 * 1000) }),
      ],
      now: NOW,
    });
    // 甲 4/8 = .5，乙 8/8 = 1（权重含 recency 与 completion，只验证相对关系）
    expect(profile.singers["乙"]).toBeGreaterThan(profile.singers["甲"] ?? 0);
  });

  it("mainLang：单一语种 100% → zh", () => {
    const profile = buildStyleProfile({
      samples: [
        sample({ id: "a1", title: "晴天", singer: "周杰伦" }, { saved: true }),
        sample({ id: "a2", title: "七里香", singer: "周杰伦" }, { saved: true }),
      ],
      now: NOW,
    });
    expect(profile.langs).toEqual({ zh: 1 });
    expect(profile.mainLang).toBe("zh");
  });

  it("mainLang：两语种各 50% 仍判 zh（两强相争时主用语种仍可用）", () => {
    const profile = buildStyleProfile({
      samples: [
        sample({ id: "a1", title: "晴天", singer: "周杰伦" }, { saved: true }),
        sample({ id: "a2", title: "Shape of You", singer: "Ed Sheeran" }, { saved: true }),
      ],
      now: NOW,
    });
    expect(profile.langs["zh"]).toBeCloseTo(0.5, 10);
    expect(profile.langs["en"]).toBeCloseTo(0.5, 10);
    expect(profile.mainLang).toBe("zh");
  });

  it("mainLang：三语种均分（各 1/3）→ und（不下结论）", () => {
    const profile = buildStyleProfile({
      samples: [
        sample({ id: "a1", title: "晴天", singer: "周杰伦" }, { saved: true }),
        sample({ id: "a2", title: "夜に駆ける", singer: "YOASOBI" }, { saved: true }),
        sample({ id: "a3", title: "Dynamite", singer: "방탄소년단" }, { saved: true }),
      ],
      now: NOW,
    });
    expect(profile.mainLang).toBe("und");
  });

  it("mainLang：五个语种各 20% → und，且 und 语种也计入 langs", () => {
    const profile = buildStyleProfile({
      samples: [
        sample({ id: "a1", title: "晴天", singer: "周杰伦" }, { saved: true }),
        sample({ id: "a2", title: "夜に駆ける", singer: "YOASOBI" }, { saved: true }),
        sample({ id: "a3", title: "Dynamite", singer: "방탄소년단" }, { saved: true }),
        sample({ id: "a4", title: "Shape of You", singer: "Ed Sheeran" }, { saved: true }),
        sample({ id: "a5", title: "✦ ✦ ✦", singer: "✦" }, { saved: true }),
      ],
      now: NOW,
    });
    expect(profile.langs["und"]).toBeCloseTo(0.2, 10);
    expect(profile.langs["zh"]).toBeCloseTo(0.2, 10);
    expect(profile.mainLang).toBe("und");
  });

  it("mainBand 为空时给 normal，专辑缺元数据时不进 albums", () => {
    const empty = buildStyleProfile({ samples: [], now: NOW });
    expect(empty.mainBand).toBe("normal");
    expect(empty.mainLang).toBe("und");
    expect(empty.sampleSize).toBe(0);
    expect(empty.tags).toEqual([]);

    const profile = buildStyleProfile({
      samples: [sample({ title: "晴天", singer: "周杰伦", album: "未知专辑" }, { saved: true })],
      now: NOW,
    });
    expect(profile.albums).toEqual({});
    expect(profile.singers["周杰伦"]).toBe(1);
  });

  it("tags：从歌单名抽风格词，按次数降序、同次数按首次出现", () => {
    const profile = buildStyleProfile({
      samples: [sample({ title: "晴天", singer: "周杰伦" }, { saved: true })],
      playlistNames: ["华语民谣", "粤语老歌", "民谣", "开车摇滚"],
      now: NOW,
    });
    expect(profile.tags).toEqual(["民谣", "华语", "粤语", "怀旧", "摇滚"]);
  });

  it("tags：同一个歌单名只给同一个词一票（名字里重复也不加成）", () => {
    const profile = buildStyleProfile({
      samples: [],
      playlistNames: ["摇滚摇滚", "民谣"],
      now: NOW,
    });
    expect(profile.tags).toEqual(["摇滚", "民谣"]);
  });

  it("tags：别名合一、子串匹配大小写不敏感", () => {
    const profile = buildStyleProfile({
      samples: [],
      playlistNames: ["OST合集", "RAP", "纯音乐", "电音"],
      now: NOW,
    });
    expect(profile.tags).toEqual(["影视原声", "说唱", "器乐", "电子"]);
  });
});

describe("describeProfile", () => {
  it("空画像明说不知道，而不是编一个默认口味", () => {
    expect(describeProfile(buildStyleProfile({ samples: [], now: NOW }))).toBe("口味还不明显");
  });

  it("只有用户手选的风格种子、没有任何收听样本 → 把他选的念回去", () => {
    // 冷启动选了「华语」「摇滚」但还没听过：画像里没有样本，可这两个风格是用户亲手点的，
    // 说「口味还不明显」等于无视他的选择。
    const profile = buildStyleProfile({ samples: [], playlistNames: ["华语"], now: NOW });
    expect(profile.sampleSize).toBe(0);
    expect(describeProfile(profile)).toBe("你选的风格：华语");
  });

  it("多个种子最多念两个（一行描述塞不下更多）", () => {
    const profile = buildStyleProfile({ samples: [], playlistNames: ["摇滚", "电子"], now: NOW });
    expect(describeProfile(profile)).toBe("你选的风格：摇滚 · 电子");
  });

  it("一行中文：语种 · 时长带 · 歌手数", () => {
    const profile = buildStyleProfile({
      samples: [
        sample({ id: "a1", title: "晴天", singer: "周杰伦", duration: 200 }, { saved: true }),
        sample({ id: "a2", title: "七里香", singer: "周杰伦", duration: 200 }, { saved: true }),
      ],
      now: NOW,
    });
    expect(describeProfile(profile)).toBe("华语 · 三四分钟 · 常听 1 位歌手");
  });

  it("mainLang 为 und 时省略语种段", () => {
    const profile = buildStyleProfile({
      samples: [sample({ title: "✦ ✦ ✦", duration: 200 }, { saved: true })],
      now: NOW,
    });
    expect(profile.mainLang).toBe("und");
    expect(describeProfile(profile)).toBe("三四分钟");
  });

  it("最多带 1 个风格词，且跳过与主语种同名的那一个（不重复说「华语」）", () => {
    const profile = buildStyleProfile({
      samples: [sample({ title: "晴天", singer: "周杰伦", duration: 200 }, { saved: true })],
      playlistNames: ["华语民谣", "摇滚"],
      now: NOW,
    });
    expect(profile.tags).toEqual(["华语", "民谣", "摇滚"]);
    expect(describeProfile(profile)).toBe("华语 · 三四分钟 · 常听 1 位歌手 · 常听民谣");
  });
});

describe("profileTagWeights", () => {
  it("越靠前越接近 1，最后一位最小", () => {
    const profile: StyleProfile = {
      langs: {},
      bands: {},
      mainLang: "und",
      mainBand: "normal",
      singers: {},
      albums: {},
      tags: ["民谣", "摇滚", "粤语"],
      sampleSize: 3,
    };
    expect(profileTagWeights(profile)).toEqual([
      { tag: "民谣", weight: 1 },
      { tag: "摇滚", weight: 2 / 3 },
      { tag: "粤语", weight: 1 / 3 },
    ]);
  });

  it("没有 tag 时返回空数组", () => {
    expect(profileTagWeights(buildStyleProfile({ samples: [], now: NOW }))).toEqual([]);
  });
});