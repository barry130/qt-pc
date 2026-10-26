import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiLocalReply, Track } from "@/types";
import type { StyleProfile } from "@/lib/recommend-types";
import { runAssistantTurn } from "@/lib/ai-assistant-local";
import * as ipc from "@/services/ipc";

// 本地引擎只碰 ipc.aiLocalChat 一个命令；getSetting/setSetting 一并 mock，
// 是因为测试会 import 的整个模块图（daily-recommend 等）也读 ipc 里的命令。
vi.mock("@/services/ipc", () => ({
  aiLocalChat: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

/** 构造测试用曲目：字段与真实 Track 一致，时长固定 200s（= normal 带） */
function track(id: string, title: string, singer: string, album = ""): Track {
  return { id, platform: "wyy", title, singer, album, picUrl: "", duration: 200 };
}

/** 一条历史消息 */
function turn(role: "user" | "assistant", content: string): {
  role: "user" | "assistant";
  content: string;
} {
  return { role, content };
}

/** 模型回执（AiLocalReply 全字段，避免 mock 形状和真实契约漂移） */
function localReply(content: string, model = "qwen-test"): AiLocalReply {
  return { content, model, elapsedMs: 12, promptTokens: null, completionTokens: null };
}

/** 一份有信号的画像（默认华语 / 三四分钟） */
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

function mockChat() {
  return vi.mocked(ipc.aiLocalChat);
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("rule 模式：关键词与排序", () => {
  it("命中风格关键词的候选排在前面，同歌手最多 2 首", async () => {
    const candidates = [
      track("g1", "长安谣", "歌手甲", "古风集"),
      track("g2", "故人叹", "歌手甲", "古风"),
      track("g3", "旧梦", "歌手甲", "古风"),
      track("g4", "江南", "歌手丙", "古风"),
      track("n1", "词牌01", "歌手丁"),
      track("n2", "词牌02", "歌手戊"),
      track("n3", "词牌03", "歌手己"),
      track("n4", "词牌04", "歌手庚"),
      track("n5", "词牌05", "歌手辛"),
    ];

    const result = await runAssistantTurn({
      mode: "rule",
      text: "来点古风",
      history: [],
      candidates,
    });

    expect(result.model).toBe("rule");
    // 关键词命中的三首（g1 最高分，g4 与 g1 同分但候选顺序靠后）排在前面
    expect(result.songs.slice(0, 3).map((song) => song.id)).toEqual(["g1", "g4", "g2"]);
    // 同歌手硬配额：歌手甲 g1/g2 各 1，g3 被挡在配额外
    const singerJia = result.songs.filter((song) => song.singer === "歌手甲");
    expect(singerJia).toHaveLength(2);
    expect(result.songs.map((song) => song.id)).not.toContain("g3");
    expect(result.songs).toHaveLength(8);
    expect(result.reply).toContain("古风");
    expect(result.reply).toContain("8 首");
  });

  it("相邻风格词会展开：说古风时专辑带「戏腔」的候选也得关键词分", async () => {
    const candidates = [
      track("x1", "无名", "歌手乙", "戏腔合集"),
      track("x2", "另一首", "歌手丁", "流行"),
    ];

    const result = await runAssistantTurn({
      mode: "rule",
      text: "来点古风",
      history: [],
      candidates,
    });

    expect(result.songs[0].id).toBe("x1");
  });

  it("点名歌手时该歌手的歌优先", async () => {
    const candidates = [
      track("o1", "夜曲", "某人", ""),
      track("j1", "晴天", "周杰伦", "叶惠美"),
      track("j2", "七里香", "周杰伦", "七里香"),
    ];

    const result = await runAssistantTurn({
      mode: "rule",
      text: "想听周杰伦",
      history: [],
      candidates,
    });

    expect(result.songs.slice(0, 2).map((song) => song.id)).toEqual(["j1", "j2"]);
    expect(result.songs[0].singer).toBe("周杰伦");
    expect(result.reply).toContain("周杰伦");
  });

  it("点名歌名时那首歌优先", async () => {
    const candidates = [
      track("p1", "别的歌", "歌手甲", ""),
      track("q1", "晴天", "周杰伦", "叶惠美"),
    ];

    const result = await runAssistantTurn({
      mode: "rule",
      text: "放一下晴天",
      history: [],
      candidates,
    });

    expect(result.songs[0].id).toBe("q1");
    expect(result.reply).toContain("晴天");
  });

  it("有画像时同主语种/同时长带的候选得分更高", async () => {
    const candidates = [track("en1", "Hello", "Adele", "25"), track("zh1", "晴天", "周杰伦", "叶惠美")];

    const result = await runAssistantTurn({
      mode: "rule",
      text: "随便来几首",
      history: [],
      candidates,
      profile: styleProfile(),
    });

    expect(result.songs[0].id).toBe("zh1");
    expect(result.reply).toBe("按你最近的听歌口味挑了 2 首。");
  });

  it("无关键词、无画像时按候选原顺序取（默认给满 20 首上限，候选不够就都给）", async () => {
    const candidates = Array.from({ length: 30 }, (_, index) =>
      track(`c${index + 1}`, `歌曲${index + 1}`, `歌手${index + 1}`),
    );

    const result = await runAssistantTurn({
      mode: "rule",
      text: "随便来几首",
      history: [],
      candidates,
    });

    expect(result.songs.map((song) => song.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `c${index + 1}`),
    );
    expect(result.reply).toBe("先从刚搜到的歌里挑了 20 首，说个歌手或风格我再收敛。");
    expect(result.model).toBe("rule");
  });

  it("用户说「5 首」时就只给 5 首", async () => {
    const candidates = Array.from({ length: 30 }, (_, index) =>
      track(`c${index + 1}`, `歌曲${index + 1}`, `歌手${index + 1}`),
    );

    const result = await runAssistantTurn({
      mode: "rule",
      text: "来 5 首古风",
      history: [],
      candidates,
    });

    expect(result.songs).toHaveLength(5);
    expect(result.reply).toContain("5 首");
  });

  it("用户说「二十首」也认得，并封顶在 20 首", async () => {
    const candidates = Array.from({ length: 40 }, (_, index) =>
      track(`c${index + 1}`, `歌曲${index + 1}`, `歌手${index + 1}`),
    );

    const result = await runAssistantTurn({
      mode: "rule",
      text: "来二十首",
      history: [],
      candidates,
    });

    expect(result.songs).toHaveLength(20);
  });

  it("点名歌手时放松同歌手配额（点周杰伦就给周杰伦的歌，而不是最多 2 首）", async () => {
    const jay = Array.from({ length: 9 }, (_, index) =>
      track(`j${index + 1}`, `周杰伦的歌${index + 1}`, "周杰伦"),
    );
    const others = Array.from({ length: 6 }, (_, index) =>
      track(`o${index + 1}`, `别的歌${index + 1}`, `别的歌手${index + 1}`),
    );

    const result = await runAssistantTurn({
      mode: "rule",
      text: "我想听周杰伦的歌",
      history: [],
      candidates: [...others, ...jay],
    });

    const jaySongs = result.songs.filter((song) => song.singer === "周杰伦");
    expect(jaySongs.length).toBeGreaterThan(2);
    expect(result.songs[0].singer).toBe("周杰伦");
  });

  it("候选为空时返回空 songs 与兜底文案", async () => {
    const result = await runAssistantTurn({
      mode: "rule",
      text: "来点古风",
      history: [],
      candidates: [],
    });

    expect(result.songs).toEqual([]);
    expect(result.reply).toBe("这次没搜到合适的歌，换个歌手、风格或场景再说一遍试试。");
    expect(result.model).toBe("rule");
  });
});

describe("local 模式：模型挑选", () => {
  const fiveCandidates = Array.from({ length: 5 }, (_, index) =>
    track(`c${index + 1}`, `歌曲${index + 1}`, `歌手${index + 1}`),
  );

  it("成功解析 picks：songs 按模型给的顺序（候选 3、1）", async () => {
    mockChat().mockResolvedValue(localReply('{"reply":"按这个顺序听最顺","picks":[3,1]}'));

    const result = await runAssistantTurn({
      mode: "local",
      text: "来点好听的",
      history: [],
      candidates: fiveCandidates,
    });

    expect(result.songs.map((song) => song.id)).toEqual(["c3", "c1"]);
    expect(result.reply).toBe("按这个顺序听最顺");
    expect(result.model).toBe("qwen-test");
  });

  it("带 ```json 围栏的输出也能解析", async () => {
    mockChat().mockResolvedValue(
      localReply('```json\n{"reply":"围栏里也能读","picks":[2,1]}\n```'),
    );

    const result = await runAssistantTurn({
      mode: "local",
      text: "来点好听的",
      history: [],
      candidates: fiveCandidates,
    });

    expect(result.songs.map((song) => song.id)).toEqual(["c2", "c1"]);
    expect(result.reply).toBe("围栏里也能读");
  });

  it("非法输出（「我也不知道」）退回规则挑歌，model 记为 rule", async () => {
    mockChat().mockResolvedValue(localReply("我也不知道"));

    const input = { text: "来点好听的", history: [], candidates: fiveCandidates };
    const local = await runAssistantTurn({ ...input, mode: "local" });
    const rule = await runAssistantTurn({ ...input, mode: "rule" });

    expect(local.songs.map((song) => song.id)).toEqual(rule.songs.map((song) => song.id));
    expect(local.model).toBe("rule");
    expect(local.reply).toBe(rule.reply);
  });

  it("模型调用抛错时走规则结果，不向调用方 throw", async () => {
    mockChat().mockRejectedValue(new Error("connect refused"));

    const input = { text: "来点好听的", history: [], candidates: fiveCandidates };
    const local = await runAssistantTurn({ ...input, mode: "local" });
    const rule = await runAssistantTurn({ ...input, mode: "rule" });

    expect(local.songs.map((song) => song.id)).toEqual(rule.songs.map((song) => song.id));
    expect(local.model).toBe("rule");
  });

  it("picks 越界/重复被丢弃，只保留合法序号", async () => {
    mockChat().mockResolvedValue(localReply('{"reply":"挑好了","picks":[0,2,2,9,1]}'));

    const result = await runAssistantTurn({
      mode: "local",
      text: "来点好听的",
      history: [],
      candidates: fiveCandidates,
    });

    expect(result.songs.map((song) => song.id)).toEqual(["c2", "c1"]);
    expect(result.model).toBe("qwen-test");
  });

  it("模型给超过 20 个序号时只保留前 20 首", async () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      track(`m${index + 1}`, `歌${index + 1}`, `歌手${index + 1}`),
    );
    const picks = Array.from({ length: 25 }, (_, index) => index + 1); // 1..25
    mockChat().mockResolvedValue(localReply(`{"reply":"挑好了","picks":[${picks.join(",")}]}`));

    const result = await runAssistantTurn({
      mode: "local",
      text: "来点好听的",
      history: [],
      candidates: many,
    });

    expect(result.songs).toHaveLength(20);
    expect(result.songs[0].id).toBe("m1");
    expect(result.songs[19].id).toBe("m20");
  });

  it("用户点名数量时，本地模型提示里的上限也跟着变", async () => {
    mockChat().mockResolvedValue(localReply('{"reply":"好","picks":[1]}'));

    await runAssistantTurn({
      mode: "local",
      text: "来 5 首",
      history: [],
      candidates: fiveCandidates,
    });

    const [systemMessage] = mockChat().mock.calls[0][0];
    expect(systemMessage.content).toContain("最多 5 个");
  });

  it("只回序号数组、没有 reply 时退回规则挑歌（model=rule）", async () => {
    mockChat().mockResolvedValue(localReply("[3,1]"));

    const input = { text: "来点好听的", history: [], candidates: fiveCandidates };
    const local = await runAssistantTurn({ ...input, mode: "local" });
    const rule = await runAssistantTurn({ ...input, mode: "rule" });

    expect(local.songs.map((song) => song.id)).toEqual(rule.songs.map((song) => song.id));
    expect(local.model).toBe("rule");
  });

  it("候选为空时直接走规则结果，且不调用模型", async () => {
    const result = await runAssistantTurn({
      mode: "local",
      text: "来点古风",
      history: [],
      candidates: [],
    });

    expect(mockChat()).not.toHaveBeenCalled();
    expect(result.songs).toEqual([]);
    expect(result.reply).toBe("这次没搜到合适的歌，换个歌手、风格或场景再说一遍试试。");
    expect(result.model).toBe("rule");
  });

  it("模型没回传模型名时 model 记为 local", async () => {
    mockChat().mockResolvedValue(localReply('{"reply":"好","picks":[1]}', ""));

    const result = await runAssistantTurn({
      mode: "local",
      text: "来点好听的",
      history: [],
      candidates: fiveCandidates,
    });

    expect(result.model).toBe("local");
  });
});

describe("local 模式：prompt 组装", () => {
  it("只把最后 4 条历史放进 user 消息（含最近一条、不含最早一条）", async () => {
    mockChat().mockResolvedValue(localReply('{"reply":"好","picks":[1]}'));

    await runAssistantTurn({
      mode: "local",
      text: "继续",
      history: [
        turn("user", "最早的一句"),
        turn("assistant", "第二句"),
        turn("user", "第三句"),
        turn("assistant", "第四句"),
        turn("user", "最近的一句"),
      ],
      candidates: [track("c1", "晴天", "周杰伦", "叶惠美"), track("c2", "七里香", "周杰伦", "七里香")],
    });

    const messages = mockChat().mock.calls[0][0];
    const userMessage = messages.find((message) => message.role === "user");
    expect(userMessage?.content).toContain("最近的一句");
    expect(userMessage?.content).toContain("你：第四句");
    expect(userMessage?.content).not.toContain("最早的一句");
  });

  it("候选行格式为 `1. 晴天 - 周杰伦（叶惠美）`，且 system 消息带输出契约", async () => {
    mockChat().mockResolvedValue(localReply('{"reply":"好","picks":[1]}'));

    await runAssistantTurn({
      mode: "local",
      text: "来点好听的",
      history: [],
      candidates: [
        track("c1", "晴天", "周杰伦", "叶惠美"),
        track("c2", "七里香", "周杰伦", "七里香"),
        track("c3", "夜曲", "周杰伦", "十一月的萧邦"),
      ],
    });

    const messages = mockChat().mock.calls[0][0];
    const [systemMessage, userMessage] = messages;
    expect(systemMessage.role).toBe("system");
    expect(systemMessage.content).toContain("只输出一个 JSON 对象");
    expect(systemMessage.content).toContain("绝不编造歌名或歌手");
    expect(systemMessage.content).toContain("最多 20 个");
    expect(userMessage.role).toBe("user");
    expect(userMessage.content).toContain("候选歌曲（共 3 首）");
    expect(userMessage.content).toContain("1. 晴天 - 周杰伦（叶惠美）");
  });

  it("有画像时把画像描述写进 user 消息", async () => {
    mockChat().mockResolvedValue(localReply('{"reply":"好","picks":[1]}'));

    await runAssistantTurn({
      mode: "local",
      text: "来点好听的",
      history: [],
      candidates: [track("c1", "晴天", "周杰伦", "叶惠美")],
      profile: styleProfile({ singers: { 周杰伦: 1 }, tags: ["华语"] }),
    });

    const messages = mockChat().mock.calls[0][0];
    const userMessage = messages.find((message) => message.role === "user");
    expect(userMessage?.content).toContain("用户的听歌画像：");
  });
});
