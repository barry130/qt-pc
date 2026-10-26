import { describe, expect, it } from "vitest";
import type { Track } from "@/types";
import type {
  RankOptions,
  ScoredCandidate,
  StyleProfile,
  TrackQuality,
  TrackStyle,
} from "@/lib/recommend-types";
import {
  reasonFor,
  scoreCandidates,
  selectDiverse,
  similarity,
} from "@/lib/recommend-rank";

// ---------- 夹具 ----------

function track(
  id: string,
  title: string,
  singer: string,
  extra: { album?: string; duration?: number; platform?: string } = {},
): Track {
  return {
    id,
    platform: extra.platform ?? "wyy",
    title,
    singer,
    album: extra.album ?? "",
    picUrl: "",
    // 200s 在时长带（music-style 150/240/330 口径）里是 normal，
    // 与 profile 夹具的 mainBand:"normal" 对齐，行为质量字段也不受边界合并影响。
    duration: extra.duration ?? 200,
  };
}

/** 华语歌：标题用汉字，detectLang 判 zh */
function zh(id: string, singer: string, extra?: Parameters<typeof track>[3]): Track {
  return track(id, `华语歌${id}`, singer, extra);
}

/** 日语歌：标题带假名，detectLang 判 ja（优先级高于汉字） */
function ja(id: string, singer: string, extra?: Parameters<typeof track>[3]): Track {
  return track(id, `夜に駆ける${id}`, singer, extra);
}

function profile(overrides: Partial<StyleProfile> = {}): StyleProfile {
  return {
    langs: { zh: 1 },
    bands: { normal: 1 },
    mainLang: "zh",
    mainBand: "normal",
    singers: {},
    albums: {},
    tags: [],
    sampleSize: 100,
    ...overrides,
  };
}

function style(overrides: Partial<TrackStyle> = {}): TrackStyle {
  return { singerKey: "", albumKey: "", lang: "zh", band: "normal", ...overrides };
}

function quality(overrides: Partial<TrackQuality> = {}): TrackQuality {
  return {
    completion: 0.8,
    replay: 0.5,
    recency: 0.9,
    affinity: 0.5,
    skipped: false,
    ...overrides,
  };
}

function opts(overrides: Partial<RankOptions> = {}): RankOptions {
  return { taste: "heart", dateKey: "2026-10-23", ...overrides };
}

/** 跑完整链路：打分 → 多样性选择 */
function run(
  candidates: Track[],
  prof: StyleProfile,
  options: RankOptions,
): ScoredCandidate[] {
  return selectDiverse(scoreCandidates(candidates, prof, options), prof, options);
}

function singersOf(items: ScoredCandidate[]): string[] {
  return items.map((item) => item.style.singerKey);
}

function countLang(items: ScoredCandidate[], lang: string): number {
  return items.filter((item) => item.style.lang === lang).length;
}

// ---------- similarity ----------

describe("similarity", () => {
  it("四个分量各自命中，总和封顶 1", () => {
    // 只同歌手 +0.40
    expect(
      similarity(style({ singerKey: "a" }), style({ singerKey: "a", lang: "ja", band: "long" })),
    ).toBeCloseTo(0.4, 6);
    // 只同专辑 +0.20（专辑键已带歌手，这里单独验证分量本身）
    expect(
      similarity(
        style({ singerKey: "a", albumKey: "a|专辑" }),
        style({ singerKey: "b", albumKey: "a|专辑", lang: "ja", band: "long" }),
      ),
    ).toBeCloseTo(0.2, 6);
    // 只同语种 +0.25
    expect(
      similarity(style({ singerKey: "a" }), style({ singerKey: "b", lang: "zh", band: "epic" })),
    ).toBeCloseTo(0.25, 6);
    // 只同时长带 +0.15
    expect(
      similarity(style({ singerKey: "a" }), style({ singerKey: "b", lang: "ja", band: "normal" })),
    ).toBeCloseTo(0.15, 6);
    // 四项全中 = 1.0（0.4+0.2+0.25+0.15）
    expect(similarity(style({ singerKey: "a", albumKey: "a|x" }), style({ singerKey: "a", albumKey: "a|x" }))).toBeCloseTo(1, 6);
  });

  it("und 不是一种语种：两边都 und 不算同语种；空歌手/空专辑不算命中", () => {
    const undA = style({ singerKey: "a", lang: "und" });
    const undB = style({ singerKey: "b", lang: "und" });
    // 只剩同时长带 0.15
    expect(similarity(undA, undB)).toBeCloseTo(0.15, 6);
    // 两边都无歌手/无专辑：只剩语种 + 时长带
    expect(similarity(style(), style())).toBeCloseTo(0.4, 6);
  });
});

// ---------- scoreCandidates ----------

describe("scoreCandidates", () => {
  it("硬排除：disliked 与 excludeKeys 都不进结果", () => {
    const candidates = [zh("1", "A"), zh("2", "B"), zh("3", "C")];
    const scored = scoreCandidates(
      candidates,
      profile(),
      Object.assign(opts(), { disliked: [false, true, false], excludeKeys: new Set(["wyy:3"]) }),
    );
    expect(scored.map((item) => item.track.id)).toEqual(["1"]);
  });

  it("选项缺省（quality/playedKeys/savedKeys/historyKeys 都没给）不报错", () => {
    expect(() => scoreCandidates([zh("1", "A")], profile(), opts())).not.toThrow();
  });

  it("hits 按命中顺序记录，且只记事实", () => {
    const candidates = [zh("1", "A", { album: "晴天" })];
    const prof = profile({ singers: { a: 1 }, albums: { "a|晴天": 1 } });
    const [scored] = scoreCandidates(
      candidates,
      prof,
      opts({ savedKeys: new Set(["wyy:1"]), playedKeys: new Set(["wyy:1"]) }),
    );
    expect(scored.hits).toEqual(["saved", "same-album", "main-lang", "main-band", "familiar-singer"]);
  });

  it("explore：新歌手 +9 压过常听歌手 −4×s（同一首歌的其他条件完全一致）", () => {
    const prof = profile({ singers: { old: 1 } });
    const candidates = [zh("1", "Old"), zh("2", "Fresh")];
    const scored = scoreCandidates(candidates, prof, opts({ taste: "explore" }));
    const oldOne = scored.find((item) => item.track.singer === "Old");
    const newOne = scored.find((item) => item.track.singer === "Fresh");
    expect(oldOne && newOne).toBeTruthy();
    expect(newOne!.hits).toContain("new-singer");
    expect(oldOne!.hits).toContain("familiar-singer");
    // 抖动最多 1.5，差值远大于抖动 → 排序稳定
    expect(newOne!.score - oldOne!.score).toBeGreaterThan(10);
  });

  it("quality.skipped 的歌排在没跳过的同分歌后面", () => {
    // 两首除「是否被反复跳过」外完全同分：同语种、同时长带、都是新歌手、都没听过
    const candidates = [zh("1", "Skipper"), zh("2", "Liker")];
    const qualityMap = new Map<string, TrackQuality>([
      ["wyy:1", quality({ skipped: true })],
      ["wyy:2", quality({ skipped: false })],
    ]);
    const scored = scoreCandidates(candidates, profile(), opts({ quality: qualityMap }));
    const result = selectDiverse(scored, profile(), opts({ target: 2 }));
    expect(result.map((item) => item.track.id)).toEqual(["2", "1"]);
    const skipper = scored.find((item) => item.track.id === "1");
    expect(skipper!.hits).toContain("skipped");
    // 惩罚是 −8，大于抖动上限 1.5
    const liker = scored.find((item) => item.track.id === "2");
    expect(liker!.score - skipper!.score).toBeGreaterThan(7);
  });

  it("familiarSingers 兜底：画像丢掉的常听歌手按一半权重算，不算新歌手", () => {
    // 画像 singers 是加权结果，样本太少的歌手会被丢掉；歌手榜能补上这批人。
    const song = zh("1", "老熟人");
    const base = scoreCandidates([song], profile(), opts({ taste: "heart" }))[0];
    const known = scoreCandidates(
      [song],
      profile(),
      opts({ taste: "heart", familiarSingers: new Set(["老熟人"]) }),
    )[0];
    expect(base.hits).toContain("new-singer");
    expect(known.hits).toContain("familiar-singer");
    expect(known.hits).not.toContain("new-singer");
    // heart：常听歌手 +8、新歌手 +3，兜底只算一半 → 差值 8×0.5 − 3 = 1
    expect(known.score - base.score).toBeCloseTo(1, 6);
  });

  it("familiarSingers 在 explore 里也算熟悉（该躲开的人不因为画像没收录就变成新歌手）", () => {
    const song = zh("1", "老熟人");
    const base = scoreCandidates([song], profile(), opts({ taste: "explore" }))[0];
    const known = scoreCandidates(
      [song],
      profile(),
      opts({ taste: "explore", familiarSingers: new Set(["老熟人"]) }),
    )[0];
    // explore：新歌手 +9、常听歌手 −4，兜底 −4×0.5 = −2 → 差值 −11
    expect(known.score - base.score).toBeCloseTo(-11, 6);
  });
});

// ---------- 验收点 1：新歌手能进前排 ----------

describe("验收 1：新歌手能进前排", () => {
  // 画像里只有歌手 A；候选 10 首 A + 3 首画像外的新歌手，语种/时长带与画像一致
  const prof = profile({ singers: { a: 1 } });
  const familiar = Array.from({ length: 10 }, (_, i) => zh(`f${i}`, "A"));
  const fresh = [zh("n1", "Fresh1"), zh("n2", "Fresh2"), zh("n3", "Fresh3")];
  const candidates = [...familiar, ...fresh];

  it("explore 口味下 3 首新歌手全部落在结果前 5 首", () => {
    const result = run(candidates, prof, opts({ taste: "explore" }));
    const freshIds = new Set(["wyy:n1", "wyy:n2", "wyy:n3"]);
    const top5 = result.slice(0, 5).map((item) => `${item.track.platform}:${item.track.id}`);
    for (const id of freshIds) expect(top5).toContain(id);
    // 而且第一首就是新歌手（不是「刚好挤进第 5」）
    expect(freshIds.has(`${result[0].track.platform}:${result[0].track.id}`)).toBe(true);
  });

  it("explore 放宽到 maxPerSinger=2 时，前 5 首仍以新歌手开头", () => {
    const result = run(candidates, prof, opts({ taste: "explore", maxPerSinger: 2 }));
    expect(result.length).toBeGreaterThanOrEqual(5);
    const freshCount = result.slice(0, 5).filter((item) => item.track.singer.startsWith("Fresh")).length;
    expect(freshCount).toBe(3);
  });

  it("heart 口味也给新歌手留门（+3，不是 0）", () => {
    const scored = scoreCandidates(candidates, prof, opts({ taste: "heart" }));
    const newOne = scored.find((item) => item.track.singer === "Fresh1");
    expect(newOne!.hits).toContain("new-singer");
    // 同语种/时长带/没听过都命中，新歌手没有任何负项
    expect(newOne!.score).toBeGreaterThan(0);
  });
});

// ---------- 验收点 2：同语种不霸屏 ----------

describe("验收 2：同语种不霸屏", () => {
  // 40 首华语 + 5 首日语，mainLang=zh；target=10 → 缺省 maxPerLang = max(2, ceil(10×0.6)) = 6
  const candidates = [
    ...Array.from({ length: 40 }, (_, i) => zh(`z${i}`, `S${i}`)),
    ...Array.from({ length: 5 }, (_, i) => ja(`j${i}`, `J${i}`)),
  ];
  const prof = profile({ langs: { zh: 0.9, ja: 0.1 } });

  it("日语 > 0，且华语不超过缺省 maxPerLang(6)", () => {
    const result = run(candidates, prof, opts({ taste: "heart", target: 10 }));
    expect(result).toHaveLength(10);
    expect(countLang(result, "ja")).toBeGreaterThan(0);
    expect(countLang(result, "zh")).toBeLessThanOrEqual(6);
  });

  it("显式 maxPerLang=5 时华语严格被卡在 5 首（池里还有 35 首华语）", () => {
    const result = run(candidates, prof, opts({ taste: "heart", target: 10, maxPerLang: 5 }));
    expect(result).toHaveLength(10);
    expect(countLang(result, "zh")).toBe(5);
    expect(countLang(result, "ja")).toBe(5);
  });

  it("und 语种不占语种配额", () => {
    // 5 首纯器乐（标题/歌手/专辑里都没有可识别文字 → und）+ 6 首华语，
    // maxPerLang=2：und 不是「一种语种」，不该被语种配额挡住
    const mixed = [
      ...Array.from({ length: 5 }, (_, i) => track(`u${i}`, "12", `${i}`)),
      ...Array.from({ length: 6 }, (_, i) => zh(`z${i}`, `Z${i}`)),
    ];
    const result = run(mixed, prof, opts({ taste: "heart", target: 7, maxPerLang: 2 }));
    expect(countLang(result, "und")).toBe(5);
    expect(countLang(result, "zh")).toBe(2);
  });
});

// ---------- 验收点 3：无相邻同歌手 ----------

describe("验收 3：无相邻同歌手", () => {
  it("50 首里 20 首同歌手，结果相邻两首不同歌手（含兜底补齐阶段）", () => {
    const candidates = [
      ...Array.from({ length: 20 }, (_, i) => zh(`x${i}`, "X")),
      ...Array.from({ length: 30 }, (_, i) => zh(`y${i}`, `Y${i}`)),
    ];
    const result = run(candidates, profile(), opts({ taste: "heart", target: 50 }));
    expect(result).toHaveLength(50);
    const singers = singersOf(result);
    for (let i = 1; i < singers.length; i += 1) {
      expect(singers[i]).not.toBe(singers[i - 1]);
    }
    // 打散只调顺序、不动集合：20 首 X 全都在
    expect(singers.filter((s) => s === "x").length).toBe(20);
  });
});

// ---------- 验收点 4：历史降权不排除 ----------

describe("验收 4：历史降权不排除", () => {
  it("historyKeys 命中全部候选，仍能返回 target 条", () => {
    const candidates = Array.from({ length: 60 }, (_, i) => zh(`h${i}`, `H${i}`));
    const historyKeys = new Set(candidates.map((item) => `wyy:${item.id}`));
    const result = run(candidates, profile(), opts({ taste: "heart", target: 50, historyKeys }));
    expect(result).toHaveLength(50);
  });

  it("全池被压成负分时仍能选出结果（归一化不除零）", () => {
    const candidates = Array.from({ length: 6 }, (_, i) => zh(`h${i}`, `H${i}`));
    const historyKeys = new Set(candidates.map((item) => `wyy:${item.id}`));
    const scored = scoreCandidates(candidates, profile(), opts({ target: 3, historyKeys }));
    // 每首都 −20 历史降权，绝对分全为负
    expect(scored.every((item) => item.score < 0)).toBe(true);
    const result = selectDiverse(scored, profile(), opts({ target: 3, historyKeys }));
    expect(result).toHaveLength(3);
  });
});

// ---------- 验收点 5：屏蔽硬排除 ----------

describe("验收 5：屏蔽硬排除", () => {
  it("disliked[i]=true 的那首一定不在结果里", () => {
    const candidates = Array.from({ length: 12 }, (_, i) => zh(`d${i}`, `D${i}`));
    const disliked = candidates.map((_, i) => i === 4);
    const result = run(candidates, profile(), opts({ taste: "heart", target: 12, disliked }));
    const ids = result.map((item) => item.track.id);
    expect(ids).not.toContain("d4");
    expect(ids).toHaveLength(11);
  });
});

// ---------- 验收点 6：配额放宽兜底 ----------

describe("验收 6：配额放宽兜底", () => {
  // 整池 30 首全是同一个歌手，target=50（池子根本不够）
  const candidates = Array.from({ length: 30 }, (_, i) => zh(`s${i}`, "Solo"));

  it("非 explore 口味放宽后能返回 30 首", () => {
    const result = run(candidates, profile(), opts({ taste: "heart", target: 50 }));
    expect(result).toHaveLength(30);
  });

  it("familiar 口味同样放宽补齐", () => {
    const result = run(candidates, profile(), opts({ taste: "familiar", target: 50 }));
    expect(result).toHaveLength(30);
  });

  it("explore 口味不放宽，只返回 1 首", () => {
    const result = run(candidates, profile(), opts({ taste: "explore", target: 50 }));
    expect(result).toHaveLength(1);
  });
});

// ---------- 验收点 7：语种上限单独放宽 ----------

describe("验收 7：语种上限单独放宽", () => {
  it("整池一个语种时，歌手配额仍然守住（不会因为放开语种就把同一个人塞满）", () => {
    // 5 首 X + 2 首 Y + 2 首 Z，全是华语；target 6 时语种上限 = ceil(6×0.6) = 4
    const candidates = [
      ...Array.from({ length: 5 }, (_, i) => zh(`x${i}`, "X")),
      ...Array.from({ length: 2 }, (_, i) => zh(`y${i}`, "Y")),
      ...Array.from({ length: 2 }, (_, i) => zh(`z${i}`, "Z")),
    ];
    const result = run(candidates, profile(), opts({ taste: "heart", target: 6 }));
    expect(result).toHaveLength(6);
    const singers = singersOf(result);
    // 歌手上限 3：X 有 5 首可选，但最多进 3 首（旧实现会退化到 4 首）
    expect(singers.filter((s) => s === "x")).toHaveLength(3);
    // 结果里至少两位歌手，且没有相邻同歌手
    expect(new Set(singers).size).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < singers.length; i += 1) {
      expect(singers[i]).not.toBe(singers[i - 1]);
    }
  });
});

// ---------- reasonFor ----------

describe("reasonFor", () => {
  function candidate(
    trackItem: Track,
    hits: ScoredCandidate["hits"],
    styleOverrides: Partial<TrackStyle> = {},
  ): ScoredCandidate {
    return { track: trackItem, style: style({ singerKey: "x", ...styleOverrides }), score: 1, hits };
  }

  it("优先级：saved 最高", () => {
    const reason = reasonFor(
      candidate(track("1", "t", "周杰伦", { album: "范特西" }), [
        "saved",
        "same-album",
        "familiar-singer",
        "main-lang",
      ]),
      profile(),
      "heart",
    );
    expect(reason).toBe("你收藏里的歌");
  });

  it("same-album 用专辑名，专辑为空时说「相近」", () => {
    expect(
      reasonFor(candidate(track("1", "t", "周杰伦", { album: "范特西" }), ["same-album"]), profile(), "heart"),
    ).toBe("同专辑《范特西》");
    expect(
      reasonFor(candidate(track("2", "t", "周杰伦"), ["same-album"]), profile(), "heart"),
    ).toBe("和你常听的专辑相近");
  });

  it("familiar-singer 带歌手名，超长截断到 12 字", () => {
    expect(
      reasonFor(candidate(track("1", "t", "陈奕迅"), ["familiar-singer"]), profile(), "heart"),
    ).toBe("你常听 陈奕迅");
    const long = reasonFor(
      candidate(track("2", "t", "一二三四五六七八九十十一十二十三"), ["familiar-singer"]),
      profile(),
      "heart",
    );
    expect(Array.from(long).length).toBeLessThanOrEqual(20);
    expect(long).toBe("你常听 一二三四五六七八九十十一");
  });

  it("new-singer + main-lang 用 MUSIC_LANG_LABEL", () => {
    expect(
      reasonFor(candidate(track("1", "t", "新人"), ["new-singer", "main-lang"]), profile(), "explore"),
    ).toBe("新歌手，和你的华语口味接近");
    expect(
      reasonFor(
        candidate(track("2", "t", "新人"), ["new-singer", "main-lang"], { lang: "ja" }),
        profile({ mainLang: "ja", langs: { ja: 1 } }),
        "explore",
      ),
    ).toBe("新歌手，和你的日语口味接近");
  });

  it("main-lang / unplayed / 兜底 依次降级", () => {
    expect(
      reasonFor(candidate(track("1", "t", "谁"), ["main-lang"]), profile(), "heart"),
    ).toBe("符合你常听的华语");
    expect(
      reasonFor(candidate(track("2", "t", "谁"), ["unplayed"]), profile(), "heart"),
    ).toBe("你没听过，换个口味试试");
    expect(reasonFor(candidate(track("3", "t", "谁"), []), profile(), "heart")).toBe("换一批看看");
  });

  it("只收藏过这个歌手（没有任何播放证据）时不说「常听」", () => {
    // 「收藏 ≠ 听过」：把收藏说成「你常听 X」就是编故事
    expect(
      reasonFor(candidate(track("1", "晴天", "周杰伦"), ["saved-singer"]), profile(), "heart"),
    ).toBe("和你的收藏口味相近");
  });

  it("画像没下结论（mainLang=und）时退回候选自己的语种名", () => {
    const reason = reasonFor(
      candidate(track("1", "t", "谁"), ["main-lang"], { lang: "ko" }),
      profile({ mainLang: "und", langs: {} }),
      "heart",
    );
    expect(reason).toBe("符合你常听的韩语");
  });

  it("所有理由都在 20 字以内", () => {
    const samples: ScoredCandidate[] = [
      candidate(track("1", "t", "周杰伦", { album: "十二新作十二新作十二新作" }), ["saved"]),
      candidate(track("2", "t", "周杰伦", { album: "十二新作十二新作十二新作" }), ["same-album"]),
      candidate(track("3", "t", "周杰伦"), ["familiar-singer"]),
      candidate(track("4", "t", "周杰伦"), ["new-singer", "main-lang"]),
      candidate(track("5", "t", "周杰伦"), ["main-lang"]),
      candidate(track("6", "t", "周杰伦"), ["unplayed"]),
      candidate(track("7", "t", "周杰伦"), ["saved-singer"]),
      candidate(track("8", "t", "周杰伦"), []),
    ];
    for (const item of samples) {
      expect(Array.from(reasonFor(item, profile(), "heart")).length).toBeLessThanOrEqual(20);
    }
  });
});

// ---------- 可复现性 ----------

describe("可复现性", () => {
  it("同样的输入两次得到同样的结果（缓存按天算，必须稳定）", () => {
    const candidates = Array.from({ length: 30 }, (_, i) => zh(`r${i}`, `R${i % 7}`));
    const a = run(candidates, profile(), opts({ taste: "heart", target: 20 }));
    const b = run(candidates, profile(), opts({ taste: "heart", target: 20 }));
    expect(a.map((item) => item.track.id)).toEqual(b.map((item) => item.track.id));
  });

  it("variant 换种子能换出不同顺序，但 target 条数不变", () => {
    const candidates = Array.from({ length: 40 }, (_, i) => zh(`v${i}`, `V${i}`));
    const a = run(candidates, profile(), opts({ taste: "heart", target: 20 }));
    const b = run(candidates, profile(), opts({ taste: "heart", target: 20, variant: "next" }));
    expect(a).toHaveLength(20);
    expect(b).toHaveLength(20);
    expect(a.map((item) => item.track.id)).not.toEqual(b.map((item) => item.track.id));
  });

  it("target=0 或空池子返回空数组", () => {
    expect(run([zh("1", "A")], profile(), opts({ target: 0 }))).toEqual([]);
    expect(run([], profile(), opts({ target: 10 }))).toEqual([]);
  });
});
