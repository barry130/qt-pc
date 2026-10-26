import { describe, expect, it } from "vitest";
import type { Track } from "@/types";
import {
  DAILY_AI_CORE,
  DAILY_AI_OFF_CORE_MAX,
  DAILY_AI_POOL_MAX,
  DAILY_MAX_PER_SINGER,
  buildPrompt,
  diversifyByLanes,
  effectiveMode,
  extractJsonObject,
  filterAiPicks,
  limitAiPicks,
  parseDailyRecommendMode,
  parseDailyTaste,
  parsePicks,
  parseStyleSeeds,
  pickAiPool,
  rankCandidates,
  ruleReason,
  songNameKey,
  spreadItemsBySinger,
  todayKey,
  trackKey,
  type DailyPreference,
} from "@/lib/daily-recommend";

function track(id: string, title: string, singer: string, platform = "wyy"): Track {
  return { id, platform, title, singer, album: "", picUrl: "", duration: 240 };
}

function pref(overrides: Partial<DailyPreference> = {}): DailyPreference {
  return {
    topSingers: [],
    recentTracks: [],
    favoriteTracks: [],
    playlistTracks: [],
    dislikeCount: 0,
    ...overrides,
  };
}

describe("todayKey", () => {
  it("用本地日期而不是 UTC（东八区 0 点后仍是当天）", () => {
    // 本地时间 2026-10-22 00:30，UTC 还是 10-21 —— 必须取 22
    expect(todayKey(new Date(2026, 9, 22, 0, 30))).toBe("2026-10-22");
    expect(todayKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });

  it("月和日补零", () => {
    expect(todayKey(new Date(2026, 0, 1, 12, 0))).toBe("2026-01-01");
  });
});

describe("trackKey / songNameKey", () => {
  it("曲目键带上平台，不同平台的同 id 不算同一首", () => {
    expect(trackKey(track("1", "晴天", "周杰伦", "wyy"))).toBe("wyy:1");
    expect(trackKey(track("1", "晴天", "周杰伦", "qq"))).not.toBe(
      trackKey(track("1", "晴天", "周杰伦", "wyy")),
    );
  });

  it("同名键忽略括号版本、空白、标点与大小写", () => {
    const live = songNameKey(track("2", "晴天（Live版）", "周杰伦"));
    const studio = songNameKey(track("3", " 晴天 ", "周杰伦"));
    expect(live).toBe(studio);
  });

  it("歌手不同就不是同一首", () => {
    expect(songNameKey(track("1", "后来", "刘若英"))).not.toBe(
      songNameKey(track("2", "后来", "张敬轩")),
    );
  });
});

describe("parseDailyRecommendMode / effectiveMode", () => {
  it("未知值一律回落 rule", () => {
    expect(parseDailyRecommendMode(null)).toBe("rule");
    expect(parseDailyRecommendMode("")).toBe("rule");
    expect(parseDailyRecommendMode("whatever")).toBe("rule");
    expect(parseDailyRecommendMode("local")).toBe("local");
    expect(parseDailyRecommendMode("server")).toBe("server");
  });

  it("server 不再降级（v1.19 起真的会调服务端，降级只发生在运行时失败之后）", () => {
    expect(effectiveMode("server")).toBe("server");
    expect(effectiveMode("rule")).toBe("rule");
    expect(effectiveMode("local")).toBe("local");
  });
});

describe("extractJsonObject", () => {
  it("从代码围栏里抠出对象", () => {
    const raw = '```json\n{"title":"夜","picks":[]}\n```';
    expect(extractJsonObject(raw)).toBe('{"title":"夜","picks":[]}');
  });

  it("前后有废话也能抠出来", () => {
    expect(extractJsonObject('好的，结果如下：{"a":1} 希望有帮助')).toBe('{"a":1}');
  });

  it("字符串里的花括号不干扰深度计数", () => {
    expect(extractJsonObject('{"title":"含 } 的标题"}')).toBe('{"title":"含 } 的标题"}');
  });

  it("嵌套对象整体返回", () => {
    expect(extractJsonObject('{"a":{"b":2}}')).toBe('{"a":{"b":2}}');
  });

  it("没有对象时返回 null", () => {
    expect(extractJsonObject("模型什么都没说")).toBeNull();
    expect(extractJsonObject('{"unclosed":1')).toBeNull();
  });
});

describe("parsePicks 硬校验", () => {
  it("正常回执原样通过", () => {
    const raw = '{"title":"夜","summary":"安静","picks":[{"index":2,"reason":"好听"},{"index":5,"reason":"适合"}]}';
    const parsed = parsePicks(raw, 10);
    expect(parsed.error).toBeNull();
    expect(parsed.title).toBe("夜");
    expect(parsed.picks).toEqual([
      { index: 2, reason: "好听" },
      { index: 5, reason: "适合" },
    ]);
  });

  it("越界序号被丢掉（不是纠正成别的歌）", () => {
    const raw = '{"picks":[{"index":0,"reason":"a"},{"index":11,"reason":"b"},{"index":3,"reason":"c"}]}';
    const parsed = parsePicks(raw, 10);
    expect(parsed.picks).toEqual([{ index: 3, reason: "c" }]);
  });

  it("重复序号只留第一次", () => {
    const raw = '{"picks":[{"index":1,"reason":"第一次"},{"index":1,"reason":"第二次"}]}';
    expect(parsePicks(raw, 5).picks).toEqual([{ index: 1, reason: "第一次" }]);
  });

  it("非整数序号（字符串数字 / 小数 / 布尔）分别处理", () => {
    const raw = '{"picks":[{"index":"2","reason":"str"},{"index":1.5,"reason":"float"},{"index":true,"reason":"bool"}]}';
    // "2" 能转成整数 2 保留；1.5 与 true 丢掉
    expect(parsePicks(raw, 5).picks).toEqual([{ index: 2, reason: "str" }]);
  });

  it("一条有效序号都没有时报错（调用方据此退回规则）", () => {
    expect(parsePicks('{"picks":[]}', 5).error).toBe("模型没有给出有效的候选序号");
    expect(parsePicks("不是 JSON", 5).error).toBe("模型没有返回 JSON");
    expect(parsePicks("{坏掉的", 5).error).toBe("模型没有返回 JSON");
  });

  it("理由超长会截断，缺失理由留空串（由调用方回落规则理由）", () => {
    const raw = `{"picks":[{"index":1,"reason":"${"长".repeat(50)}"},{"index":2}]}`;
    const parsed = parsePicks(raw, 5);
    expect(parsed.picks[0].reason.length).toBe(30);
    expect(parsed.picks[1].reason).toBe("");
  });
});

// 用户在 2026-10-23 反馈「感觉不出 AI 推荐和规则推荐有什么不同」，
// 查库发现当天那次是「模型返回的 JSON 无法解析」直接退回了规则结果。
// 模型偶尔会在字符串里塞裸换行、尾逗号，或者多说一句话 —— 这些都不该让整批作废。
describe("parsePicks 容错（模型回执走样时不整批作废）", () => {
  it("字符串里带裸换行也能解析", () => {
    const raw = '{"picks":[{"index":2,"reason":"安静\n适合夜里听"},{"index":4,"reason":"带上耳机"}]}';
    const parsed = parsePicks(raw, 10);
    expect(parsed.error).toBeNull();
    expect(parsed.picks.map((pick) => pick.index)).toEqual([2, 4]);
  });

  it("尾逗号也能解析", () => {
    const raw = '{"title":"夜色","picks":[{"index":1,"reason":"好"},{"index":3,"reason":"妙"},]}';
    const parsed = parsePicks(raw, 10);
    expect(parsed.error).toBeNull();
    expect(parsed.picks.map((pick) => pick.index)).toEqual([1, 3]);
  });

  it("整段 JSON 坏掉时按序号捞回来（reason 一并带上）", () => {
    // 缺右括号 + 末尾多说了话：JSON.parse 必失败，但序号与理由都是完整的
    const raw = '{"picks":[{"index":5,"reason":"适合通勤"},{"index":2,"reason":"熟悉的味道"}';
    const parsed = parsePicks(raw, 10);
    expect(parsed.error).toBeNull();
    expect(parsed.picks).toEqual([
      { index: 5, reason: "适合通勤" },
      { index: 2, reason: "熟悉的味道" },
    ]);
  });

  it("模型偷懒只回一排数字（[3,7,9]）也认", () => {
    expect(parsePicks("[3,7,9]", 10).picks.map((pick) => pick.index)).toEqual([3, 7, 9]);
    expect(parsePicks('{"picks":[3,7,9]}', 10).picks.map((pick) => pick.index)).toEqual([3, 7, 9]);
    expect(parsePicks('{"picks":["3","7"]}', 10).picks.map((pick) => pick.index)).toEqual([3, 7]);
  });

  it("捞回的序号照样做越界与去重校验", () => {
    const raw = '{"picks":[{"index":99,"reason":"越界"},{"index":2,"reason":"a"},{"index":2,"reason":"b"}';
    const parsed = parsePicks(raw, 10);
    expect(parsed.picks).toEqual([{ index: 2, reason: "a" }]);
  });

  it("title / summary 走样时也能捞回来", () => {
    const raw = '好的，给你挑了这些：{"title":"深夜通勤","summary":"偏安静\n适合路上听","picks":[{"index":1}]}';
    const parsed = parsePicks(raw, 5);
    expect(parsed.title).toBe("深夜通勤");
    expect(parsed.summary).toContain("适合路上听");
  });

  it("彻底没有序号时报错（调用方据此退回规则）", () => {
    expect(parsePicks("我觉得都好听", 5).error).toBe("模型没有返回 JSON");
    expect(parsePicks('{"title":"空"}', 5).error).toBe("模型没有给出有效的候选序号");
  });
});

describe("pickAiPool（候选池要比目标大出一截模型才有得挑）", () => {
  function many(count: number): Track[] {
    return Array.from({ length: count }, (_, i) => track(`t${i + 1}`, `歌${i + 1}`, `歌手${i % 9}`));
  }

  it("池子不超过上限时原样返回（不复制污染调用方的顺序）", () => {
    const picked = many(40);
    expect(pickAiPool(picked).map((t) => t.id)).toEqual(picked.map((t) => t.id));
  });

  it("超过上限时截到上限，前 DAILY_AI_CORE 首必进（规则排出的头部不能被挤掉）", () => {
    const picked = many(300);
    const pool = pickAiPool(picked, "v1");
    expect(pool.length).toBe(DAILY_AI_POOL_MAX);
    expect(pool.slice(0, DAILY_AI_CORE).map((t) => t.id)).toEqual(picked.slice(0, DAILY_AI_CORE).map((t) => t.id));
  });

  it("同一 variant 结果稳定，换 variant 尾巴会换人", () => {
    const picked = many(300);
    const a = pickAiPool(picked, "v1").map((t) => t.id);
    const b = pickAiPool(picked, "v1").map((t) => t.id);
    const c = pickAiPool(picked, "v2").map((t) => t.id);
    expect(a).toEqual(b);
    expect(a.slice(DAILY_AI_CORE)).not.toEqual(c.slice(DAILY_AI_CORE));
    // 尾巴不含重复、也不含头部已选过的
    expect(new Set(a).size).toBe(a.length);
  });
});

describe("rankCandidates", () => {
  const pool = [
    track("1", "晴天", "周杰伦"),
    track("2", "稻香", "周杰伦"),
    track("3", "七里香", "周杰伦"),
    track("4", "浮夸", "陈奕迅"),
    track("5", "后来", "刘若英"),
  ];

  it("排除键里的歌不出现（跨天去重靠它）", () => {
    const picked = rankCandidates(pool, pref(), { excludeKeys: new Set(["wyy:1", "wyy:2"]) });
    expect(picked.map(trackKey)).not.toContain("wyy:1");
    expect(picked.map(trackKey)).not.toContain("wyy:2");
  });

  it("屏蔽标记为 true 的曲目被排除（下标与候选池对齐）", () => {
    const flags = pool.map((_, i) => i === 4);
    const picked = rankCandidates(pool, pref(), { dislikedFlags: flags });
    expect(picked.map(trackKey)).not.toContain("wyy:5");
  });

  it("同一歌手不超过配额", () => {
    const picked = rankCandidates(pool, pref({ topSingers: ["周杰伦"] }), { target: 5 });
    const jay = picked.filter((t) => t.singer === "周杰伦");
    expect(jay.length).toBeLessThanOrEqual(DAILY_MAX_PER_SINGER);
  });

  it("常听歌手排在没有交集的歌手前面", () => {
    const picked = rankCandidates(pool, pref({ topSingers: ["刘若英"] }), { target: 5 });
    // 刘若英在常听列表里，加分最多 → 排第一
    expect(picked[0].singer).toBe("刘若英");
  });

  it("没听过的歌比听过的分高（每日推荐的重点是新歌）", () => {
    const picked = rankCandidates(pool, pref(), {
      playedKeys: new Set(["wyy:1", "wyy:2", "wyy:3", "wyy:4"]),
      target: 5,
    });
    expect(picked[0] && trackKey(picked[0])).toBe("wyy:5");
  });

  it("同名不同源的重复曲目只留一首", () => {
    const dup = [track("1", "晴天", "周杰伦", "wyy"), track("9", "晴天（Live）", "周杰伦", "qq")];
    expect(rankCandidates(dup, pref(), { target: 5 }).length).toBe(1);
  });

  it("target 生效，且结果不超过候选数", () => {
    expect(rankCandidates(pool, pref(), { target: 2 }).length).toBe(2);
    expect(rankCandidates(pool, pref(), { target: 99 }).length).toBeLessThanOrEqual(pool.length);
  });

  it("池子歌手太少时放宽配额补足数量（不硬卡在配额上）", () => {
    // 只有两个歌手、各 5 首：严格配额 3 只能出 6 首，target 8 需要放宽到 2 倍
    const narrow = [
      track("a1", "A1", "甲"),
      track("a2", "A2", "甲"),
      track("a3", "A3", "甲"),
      track("a4", "A4", "甲"),
      track("a5", "A5", "甲"),
      track("b1", "B1", "乙"),
      track("b2", "B2", "乙"),
      track("b3", "B3", "乙"),
      track("b4", "B4", "乙"),
      track("b5", "B5", "乙"),
    ];
    const picked = rankCandidates(narrow, pref(), { target: 8 });
    expect(picked.length).toBe(8);
    // 放宽后仍然两边都有，不会被一个歌手独占
    expect(picked.filter((t) => t.singer === "甲").length).toBeLessThan(8);
    expect(picked.filter((t) => t.singer === "乙").length).toBeLessThan(8);
  });

  it("同一天同一份输入结果稳定（缓存才有意义）", () => {
    const a = rankCandidates(pool, pref(), { dateKey: "2026-10-22" }).map(trackKey);
    const b = rankCandidates(pool, pref(), { dateKey: "2026-10-22" }).map(trackKey);
    expect(a).toEqual(b);
  });
});

describe("ruleReason", () => {
  it("常听歌手给「你常听 X」", () => {
    expect(ruleReason(track("1", "晴天", "周杰伦"), pref({ topSingers: ["周杰伦"] }))).toBe(
      "你常听 周杰伦",
    );
  });

  it("收藏歌手但不在常听列表时给收藏口径", () => {
    expect(
      ruleReason(
        track("1", "晴天", "周杰伦"),
        pref({ favoriteTracks: [track("9", "稻香", "周杰伦")] }),
      ),
    ).toBe("和你的收藏口味相近");
  });

  it("完全不认识时给「没听过」的中性理由，不编造", () => {
    // 引擎的兜底文案分两档：查得到「没听过」这个事实就说出来，什么事实都没有才说「换一批看看」。
    // 这两种都是中性的，不许出现「你会喜欢」这类推断。
    expect(ruleReason(track("1", "晴天", "周杰伦"), pref())).toBe("你没听过，换个口味试试");
  });
});

describe("buildPrompt", () => {
  const pool = [track("1", "晴天", "周杰伦"), track("2", "浮夸", "陈奕迅")];

  it("候选池按 1 起编号写进提示词", () => {
    const messages = buildPrompt(pool, pref({ topSingers: ["周杰伦"] }), 2);
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    expect(user).toContain("1. 晴天 - 周杰伦");
    expect(user).toContain("2. 浮夸 - 陈奕迅");
    expect(user).toContain("共 2 首");
  });

  it("明确禁止编造与输出 ID", () => {
    const system = buildPrompt(pool, pref(), 2).find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("绝不能编造");
    expect(system).toContain("不能输出歌曲 ID");
  });

  it("空偏好也能组装（新用户不能崩）", () => {
    const user = buildPrompt(pool, pref(), 2).find((m) => m.role === "user")?.content ?? "";
    expect(user).toContain("（暂无）");
  });

  it("口味写进提示词（模型按同一方向挑）", () => {
    const user = buildPrompt(pool, pref(), 2, "explore")
      .find((m) => m.role === "user")?.content ?? "";
    expect(user).toContain("探索");
  });

  // 用户 2026-10-24「AI 推荐怎么那么像随机选」：根因是提示词只给了歌名/歌手/专辑/语种，
  // 模型手上没有任何「这首对我意味着什么」的证据，只能按歌名猜——所以改成证据进候选行。
  it("候选行带本地行为证据（收藏/播放次数/常听歌手）", () => {
    const richPref = pref({
      topSingers: ["周杰伦"],
      favoriteTracks: [track("1", "晴天", "周杰伦")],
      topTracks: [
        {
          track: track("1", "晴天", "周杰伦"),
          stat: { playCount: 12, totalPlayedMs: 240_000, lastPlayedAt: Date.now() },
        },
      ],
    });
    const user = buildPrompt(
      [track("1", "晴天", "周杰伦"), track("2", "Billie Jean", "Michael Jackson")],
      richPref,
      2,
    )
      .find((m) => m.role === "user")?.content ?? "";
    expect(user).toContain("已收藏");
    expect(user).toContain("听过12次");
    expect(user).toContain("常听歌手");
  });

  it("主语种定得下来时给可对账的语种下限，无关歌标「非主语种」", () => {
    const richPref = pref({
      topSingers: ["周杰伦"],
      favoriteTracks: [track("1", "晴天", "周杰伦")],
    });
    const messages = buildPrompt(
      [track("1", "晴天", "周杰伦"), track("2", "Billie Jean", "Michael Jackson")],
      richPref,
      50,
    );
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    // 「别挑奇怪的歌」小模型听不懂，「至少 40 首华语」才听得懂
    expect(user).toContain("请至少有 40 首是华语");
    const candidateLines = user.split("\n").filter((line) => /^\d+\. /.test(line));
    expect(candidateLines[1]).toContain("非主语种");
    // 旧的「别照抄前 N 首 / 尽量分散」是凑风格拼盘的源头，必须已经删掉
    expect(user).not.toContain("不要直接照抄");
    expect(user).not.toContain("尽量分散在不同歌手和不同风格");
  });

  // 用户 2026-10-24「风格能再多样一点，而不是只有那么一两个」：
  // 候选池搜宽之后，提示词必须知道每首歌属于哪条风格线，否则「更多风格」只是句空话。
  it("候选行带风格线，多风格目标按实际线数给，画像补上语种分布", () => {
    const richPref = pref({
      topSingers: ["周杰伦"],
      favoriteTracks: [
        track("1", "晴天", "周杰伦"),
        track("9", "夜に駆ける", "YOASOBI"),
      ],
    });
    const lanePool = [
      track("1", "晴天", "周杰伦"),
      track("2", "浮夸", "陈奕迅"),
      track("3", "富士山下", "陈奕迅"),
      track("4", "倾尽天下", "河图"),
      track("5", "River Flows in You", "Yiruma"),
      track("7", "夜に駆ける", "YOASOBI"),
      track("6", "稻香", "周杰伦"),
    ];
    const laneOf = new Map<string, string[]>([
      [trackKey(lanePool[0]), ["华语流行"]],
      [trackKey(lanePool[1]), ["粤语"]],
      [trackKey(lanePool[2]), ["粤语"]],
      [trackKey(lanePool[3]), ["古风"]],
      [trackKey(lanePool[4]), ["纯音乐"]],
      [trackKey(lanePool[5]), ["日语"]],
    ]);
    const user =
      buildPrompt(lanePool, richPref, 50, "heart", laneOf)
        .find((m) => m.role === "user")?.content ?? "";
    // 候选行里标出来源，模型才挑得出「这条线」的歌
    expect(user).toContain("风格线：粤语");
    expect(user).toContain("风格线：纯音乐");
    // 五条线 → 「覆盖 3–5 条」；每条的曲目数也要可对账
    expect(user).toContain("覆盖 3–5 条不同的「风格线」");
    expect(user).toContain("粤语（2 首）");
    // 画像里的次要语种要写明占比，模型才敢从「剩下的 10 首」里挑日语
    expect(user).toContain("画像里的语种分布：华语");
    expect(user).toContain("剩下的 10 首可以从画像里的其它语种里挑（日语）");
    // 没有风格线时不能出现无主的「风格线：」标签
    const noLane = buildPrompt(lanePool, richPref, 50).find((m) => m.role === "user")?.content ?? "";
    expect(noLane).not.toContain("风格线：");
  });

  it("池子比目标条数长时给出中段换歌与听感曲线，池子不够长时整条不出现", () => {
    const richPref = pref({
      topSingers: ["周杰伦"],
      favoriteTracks: [track("1", "晴天", "周杰伦")],
    });
    // 只删掉「凑风格」的指令会让模型改成整份照抄规则前 50 首（又退化成纯规则），
    // 所以给一个可执行的折中：从中段换 6–10 首，顺序按听感曲线自己排
    const longPool = Array.from({ length: 150 }, (_, index) =>
      track(String(index + 1), `候选${index + 1}`, `歌手${index % 40}`),
    );
    const longUser =
      buildPrompt(longPool, richPref, 50)
        .find((m) => m.role === "user")?.content ?? "";
    expect(longUser).toContain("第 51–90 首");
    expect(longUser).toContain("6–10 首");
    expect(longUser).toContain("开场 → 沉浸 → 收束");

    // 池子只有 2 首时不能出现「第 51–90 首」这种指向不存在行的指令，编号仍要连续
    const shortUser =
      buildPrompt(
        [track("1", "晴天", "周杰伦"), track("2", "Billie Jean", "Michael Jackson")],
        richPref,
        50,
      ).find((m) => m.role === "user")?.content ?? "";
    expect(shortUser).not.toContain("第 51");
    expect(shortUser).toContain("⑤ 每首理由");
  });
});

describe("filterAiPicks（模型挑的歌要能在本地数据里找到依据）", () => {
  const richPref = pref({
    topSingers: ["周杰伦"],
    favoriteTracks: [track("1", "晴天", "周杰伦")],
  });
  const item = (entry: Track) => ({ track: entry, reason: "理由" });

  it("非主语种、又没有任何收听证据的歌被剔掉", () => {
    const kept = filterAiPicks(
      [item(track("1", "晴天", "周杰伦")), item(track("2", "Billie Jean", "Michael Jackson"))],
      richPref,
      "heart",
    );
    expect(kept.map((entry) => entry.track.title)).toEqual(["晴天"]);
  });

  it("用户真的收藏过的外语歌不剔（有依据就留）", () => {
    const englishPref = pref({
      topSingers: ["周杰伦"],
      favoriteTracks: [
        track("1", "晴天", "周杰伦"),
        track("2", "Billie Jean", "Michael Jackson"),
      ],
    });
    const kept = filterAiPicks(
      [item(track("2", "Billie Jean", "Michael Jackson"))],
      englishPref,
      "heart",
    );
    expect(kept.length).toBe(1);
  });

  // v9：维度路会把「他画像里占比不高、但确实听过几首」的语种带回来（日语 / 纯音乐 / 粤语）。
  // 这类歌如果带着「和画像有关的风格线」，就不该再被「非主语种」一刀切掉。
  it("有画像风格线支撑的歌不剔（维度路把次要语种带回来了）", () => {
    const english = track("2", "Billie Jean", "Michael Jackson");
    const lanes = {
      laneOf: new Map<string, string[]>([[trackKey(english), ["欧美"]]]),
      affinityLanes: new Set(["欧美"]),
    };
    expect(filterAiPicks([item(english)], richPref, "heart", lanes).length).toBe(1);
    // 榜单线（不在 affinityLanes 里）不算依据，仍然要剔
    expect(
      filterAiPicks([item(english)], richPref, "heart", {
        laneOf: new Map([[trackKey(english), ["欧美热榜"]]]),
        affinityLanes: new Set(["欧美"]),
      }).length,
    ).toBe(0);
  });

  it("探索口味不筛（推陌生歌本来就是目的）", () => {
    const kept = filterAiPicks(
      [item(track("1", "晴天", "周杰伦")), item(track("2", "Billie Jean", "Michael Jackson"))],
      richPref,
      "explore",
    );
    expect(kept.length).toBe(2);
  });

  it("画像还没成形时不硬筛（新用户不砍半）", () => {
    const kept = filterAiPicks([item(track("2", "Billie Jean", "Michael Jackson"))], pref(), "heart");
    expect(kept.length).toBe(1);
  });
});

describe("limitAiPicks（中段穿插要封顶，不然又从「贴合」滑向「随机」）", () => {
  const richPref = pref({
    topSingers: ["周杰伦"],
    favoriteTracks: [track("1", "晴天", "周杰伦")],
  });
  // 池子 150 首：前 100 首中文，后 50 首英文（模拟「规则前 90 名之外」的弱匹配尾巴）
  const pool: Track[] = Array.from({ length: 150 }, (_, i) =>
    i < 100
      ? track(`t${i + 1}`, `歌${i + 1}`, `歌手${i % 9}`)
      : track(`t${i + 1}`, `Song ${i + 1}`, `Artist ${i + 1}`),
  );
  const picks = (indices: number[]) => indices.map((index) => ({ index, reason: `理由${index}` }));

  it("规则前 50 首照单全收，中段最多只放 DAILY_AI_OFF_CORE_MAX 首进来", () => {
    const inCore = Array.from({ length: 40 }, (_, i) => i + 1);
    const offCore = Array.from({ length: 25 }, (_, i) => 51 + i);
    const items = limitAiPicks(picks([...inCore, ...offCore]), pool, richPref, "heart");
    expect(items.length).toBe(40 + DAILY_AI_OFF_CORE_MAX);
  });

  it("中段里没有画像依据的（非主语种、没听过、非常听歌手）不进来", () => {
    const items = limitAiPicks(
      picks([1, 40, 51, 130]),
      pool,
      richPref,
      "heart",
    );
    // 51 是中文（主语种一致，算依据）；130 是英文歌，零依据 → 剔掉
    expect(items.map((item) => item.track.id)).toEqual(["t1", "t40", "t51"]);
  });

  it("探索口味不封顶（本来就要推陌生歌）", () => {
    const offCore = Array.from({ length: 25 }, (_, i) => 51 + i);
    const items = limitAiPicks(picks(offCore), pool, richPref, "explore");
    expect(items.length).toBe(25);
  });

  it("模型没给理由时用规则理由兜底（页面不留空理由）", () => {
    const items = limitAiPicks([{ index: 1, reason: "" }], pool, richPref, "heart");
    expect(items[0].reason.length).toBeGreaterThan(0);
  });
});

// 用户 2026-10-24「风格能再多样一点，而不是只有那么一两个」：
// 维度路搜回来的粤语/纯音乐/日系在原排序里排在 150 名之后，直接取前 50 首 = 一条线都进不来。
// 配额补位负责「塞进来」，interleaveByLanes 负责「排得开」，两件事分开测。
describe("diversifyByLanes（风格线配额：七成贴合底盘 + 三成新线）", () => {
  const ranked = Array.from({ length: 300 }, (_, index) =>
    track(String(index + 1), `歌${index + 1}`, `歌手${index % 60}`),
  );

  it("没有任何线标签时退回规则前 N 首（老路径行为不变）", () => {
    const out = diversifyByLanes(ranked, new Map(), 50);
    expect(out.map((entry) => entry.id)).toEqual(ranked.slice(0, 50).map((entry) => entry.id));
  });

  it("30% 的位置留给风格线，主干的顺序不被改动", () => {
    const laneOf = new Map<string, string[]>();
    ranked.slice(120).forEach((entry, index) => laneOf.set(trackKey(entry), [`线${index % 5}`]));
    const out = diversifyByLanes(ranked, laneOf, 50);
    expect(out.length).toBe(50);
    // 前 70% 就是规则排序本身：不能因为「多样」把最贴合的头部挤掉
    expect(out.slice(0, 35).map((entry) => entry.id)).toEqual(
      ranked.slice(0, 35).map((entry) => entry.id),
    );
    // 每条线都补到了配额（15 个位置 / 5 条线 = 每条 3 首）
    const counts = new Map<string, number>();
    for (const entry of out) {
      const label = laneOf.get(trackKey(entry))?.[0];
      if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    expect(counts.size).toBe(5);
    for (const count of counts.values()) expect(count).toBe(3);
  });

  it("线超过 5 条时只照顾前 5 条（后面的线听感上太散）", () => {
    const laneOf = new Map<string, string[]>();
    ranked.slice(120).forEach((entry, index) => laneOf.set(trackKey(entry), [`线${index % 6}`]));
    const out = diversifyByLanes(ranked, laneOf, 50);
    const labels = new Set<string>();
    for (const entry of out) {
      const label = laneOf.get(trackKey(entry))?.[0];
      if (label) labels.add(label);
    }
    expect(labels.size).toBe(5);
    expect(labels.has("线5")).toBe(false);
  });

  it("线里的歌少于配额时不硬凑，用原序补满且不重复", () => {
    const short = ranked.slice(0, 40);
    const laneOf = new Map<string, string[]>();
    short.forEach((entry) => laneOf.set(trackKey(entry), ["古风"]));
    const out = diversifyByLanes(short, laneOf, 50);
    expect(out.length).toBe(40);
    expect(new Set(out.map((entry) => entry.id)).size).toBe(40);
    expect(out.map((entry) => entry.id)).toEqual(short.map((entry) => entry.id));
  });
});

describe("口味", () => {
  const pool = [
    track("1", "晴天", "周杰伦"),
    track("2", "稻香", "周杰伦"),
    track("3", "七里香", "周杰伦"),
    track("4", "浮夸", "陈奕迅"),
    track("5", "后来", "刘若英"),
    track("6", "陌生人甲", "某新人"),
  ];

  it("未知值回落心动模式", () => {
    expect(parseDailyTaste(null)).toBe("heart");
    expect(parseDailyTaste("nonsense")).toBe("heart");
    expect(parseDailyTaste("explore")).toBe("explore");
  });

  it("探索模式把常听歌手排到后面", () => {
    const picked = rankCandidates(pool, pref({ topSingers: ["周杰伦"] }), {
      taste: "explore",
      target: 6,
    });
    const jayIndex = picked.findIndex((t) => t.singer === "周杰伦");
    const strangerIndex = picked.findIndex((t) => t.singer === "某新人");
    expect(strangerIndex).toBeGreaterThanOrEqual(0);
    expect(jayIndex).toBeGreaterThan(strangerIndex);
  });

  it("探索模式同一歌手只占一条（尽量散开）", () => {
    const picked = rankCandidates(pool, pref({ topSingers: ["周杰伦"] }), {
      taste: "explore",
      target: 6,
    });
    expect(picked.filter((t) => t.singer === "周杰伦").length).toBe(1);
  });

  it("常听模式给常听歌手更高配额，且仍排在前面", () => {
    // 同一歌手 5 首：心动配额 3 会截断，常听配额更高才能全放进来
    const jayPool = [
      track("1", "晴天", "周杰伦"),
      track("2", "稻香", "周杰伦"),
      track("3", "七里香", "周杰伦"),
      track("4", "夜曲", "周杰伦"),
      track("5", "简单爱", "周杰伦"),
      track("6", "后来", "刘若英"),
    ];
    const familiar = rankCandidates(jayPool, pref({ topSingers: ["周杰伦"] }), {
      taste: "familiar",
      target: 6,
    });
    expect(familiar.filter((t) => t.singer === "周杰伦").length).toBeGreaterThan(
      DAILY_MAX_PER_SINGER,
    );
    expect(familiar[0].singer).toBe("周杰伦");
  });
});

describe("历史推荐降权", () => {
  const pool = [
    track("1", "晴天", "周杰伦"),
    track("2", "稻香", "周杰伦"),
    track("3", "后来", "刘若英"),
  ];

  it("推过的往后排，没推过的优先", () => {
    const picked = rankCandidates(pool, pref(), {
      historyKeys: new Set([trackKey(pool[0]), songNameKey(pool[2])]),
      target: 3,
    });
    // wyy:2 没推过 → 第一；另外两首都带历史（一个按 id、一个按歌名）→ 排在后面
    expect(picked[0] && trackKey(picked[0])).toBe("wyy:2");
    expect(picked.map(trackKey).slice(1).sort()).toEqual(["wyy:1", "wyy:3"]);
  });

  it("池子被历史占满时仍会兜底出歌（不硬排除，页面不会空）", () => {
    const all = new Set(pool.map(trackKey));
    const picked = rankCandidates(pool, pref(), { historyKeys: all, target: 3 });
    expect(picked.length).toBe(3);
  });

  it("跨源同名也算推过（按歌名键降权）", () => {
    const dup = [track("1", "晴天", "周杰伦", "qq"), track("2", "稻香", "周杰伦")];
    const picked = rankCandidates(dup, pref(), {
      // 只在其它音源推过「晴天」，wyy/qq 的 id 不同也要认出来
      historyKeys: new Set([songNameKey(track("9", "晴天", "周杰伦", "wyy"))]),
      target: 2,
    });
    expect(picked[0] && trackKey(picked[0])).toBe("wyy:2");
  });
});

describe("同歌手打散（用户反馈「每次都是这个歌手」）", () => {
  // 一个歌手在常听列表里排名第一，另有两个陌生歌手 —— 旧实现会连着出这个歌手
  const jayPool = [
    track("1", "晴天", "周杰伦"),
    track("2", "稻香", "周杰伦"),
    track("3", "七里香", "周杰伦"),
    track("4", "夜曲", "周杰伦"),
    track("5", "简单爱", "周杰伦"),
    track("6", "浮夸", "陈奕迅"),
    track("7", "富士山下", "陈奕迅"),
    track("8", "后来", "刘若英"),
    track("9", "很爱很爱你", "刘若英"),
  ];

  it("心动模式前几条不会连着同一个歌手", () => {
    const picked = rankCandidates(jayPool, pref({ topSingers: ["周杰伦"] }), {
      taste: "heart",
      target: 6,
    });
    // 相邻两首绝不同歌手。**第一首是钉住的**（MMR 最高分，用户第一眼看到的那首），
    // 打散只能动它后面；周杰伦占池子 5/9，摊到 6 条时他必然还要回来填缝，
    // 所以这里断言的是「不连排」而不是「前三条三个歌手」——后者在 5/9 的分布下不可能成立。
    for (let i = 1; i < picked.length; i += 1) {
      expect(picked[i].singer).not.toBe(picked[i - 1].singer);
    }
  });

  it("摊开之后周杰伦仍然在结果里（不是靠排除他实现的）", () => {
    const picked = rankCandidates(jayPool, pref({ topSingers: ["周杰伦"] }), {
      taste: "heart",
      target: 6,
    });
    expect(picked.some((t) => t.singer === "周杰伦")).toBe(true);
    // 常听歌手仍然排在第一轮的第一位
    expect(picked[0].singer).toBe("周杰伦");
  });

  it("换一批能换出不同的领头歌手（旧实现只抖 jitter，打不破常听加分）", () => {
    const heads = new Set<string>();
    for (const variant of ["v1", "v2", "v3", "v4", "v5"]) {
      const picked = rankCandidates(jayPool, pref({ topSingers: ["周杰伦"] }), {
        taste: "heart",
        dateKey: "2026-10-22",
        variant,
        target: 6,
      });
      heads.add(picked[0].singer);
    }
    // 5 次换一批里至少出现过 2 个不同的领头歌手
    expect(heads.size).toBeGreaterThan(1);
  });
});

describe("心动模式吃收藏歌单", () => {
  const pool = [
    track("1", "晴天", "周杰伦"),
    track("2", "稻香", "周杰伦"),
    track("3", "浮夸", "陈奕迅"),
    track("4", "后来", "刘若英"),
    track("5", "很爱很爱你", "刘若英"),
  ];

  it("收藏歌单里的歌加分，排在同歌手其它歌前面", () => {
    const picked = rankCandidates(pool, pref({ playlistTracks: [pool[4]] }), {
      taste: "heart",
      target: 5,
    });
    // wyy:5 是歌单里的歌，权重压过"歌手像" → 第一
    expect(picked[0] && trackKey(picked[0])).toBe("wyy:5");
  });

  it("歌单里的歌手也进种子歌手（不靠常听列表）", () => {
    const picked = rankCandidates(pool, pref({ playlistTracks: [pool[2]] }), {
      taste: "heart",
      target: 5,
    });
    expect(picked.some((t) => t.singer === "陈奕迅")).toBe(true);
  });

  it("歌单里的歌给收藏口径的理由", () => {
    // 收藏单曲和收藏歌单里的歌在用户眼里是同一件事（都是我亲手收的），
    // 所以理由统一说「你收藏里的歌」，不再区分来源渠道。
    // 「只在收藏里、从没播过」的歌手不说「常听」这件事，由 ruleReason 组里的
    // 「收藏歌手但不在常听列表时给收藏口径」负责。
    expect(ruleReason(pool[4], pref({ playlistTracks: [pool[4]] }))).toBe("你收藏里的歌");
  });
});

describe("模型回执按歌手打散", () => {
  // 用户 2026-10-22 的实测：心动模式用本地模型精选，前两首还是同一个歌手。
  // 规则排序已经把候选池摊开了，但模型回的是它自己的顺序，所以结果侧再打散一次。
  const item = (id: string, singer: string) => ({ track: track(id, `歌${id}`, singer) });

  it("同歌手连着排 → 被拆开，第一首原地不动", () => {
    const spread = spreadItemsBySinger(
      [
        item("1", "周杰伦"),
        item("2", "周杰伦"),
        item("3", "陈奕迅"),
        item("4", "陈奕迅"),
      ],
      (entry) => entry.track.singer,
    );
    // 第一名是模型最看好的那首，必须留在原位
    expect(spread[0].track.id).toBe("1");
    // 相邻两首不再是同一个歌手
    for (let i = 1; i < spread.length; i += 1) {
      expect(spread[i].track.singer).not.toBe(spread[i - 1].track.singer);
    }
  });

  it("只调顺序，不增删歌", () => {
    const input = [
      item("1", "A"),
      item("2", "A"),
      item("3", "B"),
      item("4", "A"),
      item("5", "C"),
    ];
    const spread = spreadItemsBySinger(input, (entry) => entry.track.singer);
    expect(spread.map((entry) => entry.track.id).sort()).toEqual(
      input.map((entry) => entry.track.id).sort(),
    );
    expect(spread[0].track.id).toBe("1");
  });

  it("整池就一个歌手时保持原顺序（打散不了就诚实保序）", () => {
    const input = [item("1", "只有他"), item("2", "只有他"), item("3", "只有他")];
    expect(spreadItemsBySinger(input, (entry) => entry.track.singer).map((e) => e.track.id)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  // v8 起改成「只做最小相邻交换」：旧的贪心重排会把模型按贴合度排好的顺序整段打乱，
  // 用户看到的「随机感」有一半来自这里。
  it("顺序本来就没有相邻撞歌手时原样保留", () => {
    const input = [item("1", "甲"), item("2", "乙"), item("3", "丙")];
    expect(spreadItemsBySinger(input, (entry) => entry.track.singer)).toEqual(input);
  });

  it("只有相邻撞歌手时才动一两首，后面的顺序不受影响", () => {
    const input = [item("1", "甲"), item("2", "甲"), item("3", "乙"), item("4", "丙")];
    const spread = spreadItemsBySinger(input, (entry) => entry.track.singer);
    expect(spread[0].track.id).toBe("1");
    expect(spread.map((entry) => entry.track.id).sort()).toEqual(["1", "2", "3", "4"]);
    for (let i = 1; i < spread.length; i += 1) {
      expect(spread[i].track.singer).not.toBe(spread[i - 1].track.singer);
    }
    expect(spread.slice(2).map((entry) => entry.track.id)).toEqual(["2", "4"]);
  });
});

describe("parseStyleSeeds", () => {
  it("没有设置时是空数组（老用户没有这个键）", () => {
    expect(parseStyleSeeds(null)).toEqual([]);
    expect(parseStyleSeeds("")).toEqual([]);
    expect(parseStyleSeeds("   ")).toEqual([]);
  });

  it("JSON 数组按原顺序返回，并且去重（大小写/空白/标点归一后相同算一个）", () => {
    expect(parseStyleSeeds('["摇滚","华语","摇滚"]')).toEqual(["摇滚", "华语"]);
    expect(parseStyleSeeds('[" 摇滚 ","摇滚"]')).toEqual(["摇滚"]);
  });

  it("设置被写坏（不是 JSON）时按分隔符救回来，不抛异常", () => {
    expect(parseStyleSeeds("摇滚, 华语、电子")).toEqual(["摇滚", "华语", "电子"]);
  });

  it("最多 4 个：画像 tags 一多，分类反而匹配不上具体风格", () => {
    expect(parseStyleSeeds('["a","b","c","d","e","f"]')).toEqual(["a", "b", "c", "d"]);
  });

  it("数组里混进非字符串时跳过，不影响其它项", () => {
    expect(parseStyleSeeds('[1,"摇滚",null,"华语"]')).toEqual(["摇滚", "华语"]);
  });
});
