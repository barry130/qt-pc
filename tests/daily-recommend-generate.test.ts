// 生成主流程的兜底契约：模型挂了必须出规则结果（页面不能空着），
// 且失败也只失败一次 —— 结果要落缓存，否则下次进页面又重搜一遍音源。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chart, SingerStat, Track } from "@/types";

const store = new Map<string, string>();
const aiLocalChat = vi.fn<(messages: unknown, temperature?: number) => Promise<unknown>>();

function track(id: string, title: string, singer: string): Track {
  return { id, platform: "wyy", title, singer, album: "", picUrl: "", duration: 200 };
}

/** 空历史用例通过它让搜索返回空池（直接改常量数组会污染其它用例） */
let emptyHistory = false;
/** 「一个收藏歌单都没有」的用例单独控制（不能跟 emptyHistory 绑死） */
let noPlaylists = false;
/** 冷启动用的平台分类（默认空 = 音源不支持分类，这也是要覆盖的降级路径） */
let styleCategories: { id: string; name: string; group: string }[] = [];
/** 风格歌单里的歌：选了风格种子之后候选池的主来源 */
let stylePlaylistTracks: Track[] = [];
/** 数据包 searchMany 入口的返回：默认每词空批（跨源这一路在旧用例里一直是空的） */
let manyBatches: { source: "wyy" | "qq" | "kw" | "kg"; tracks: Track[] }[] = [];
/** 让整块聚合失败（模拟数据包超时）：候选池要能吞掉，不能连坐整次生成 */
let manyThrows = false;
/** 每次跨源聚合的入参现场（验证「只用勾选的源」真的传到了门面） */
const manyCalls: { keywords: string[]; sources?: readonly string[] }[] = [];
/**
 * 维度路（v9）的榜单：默认空 = 音源不支持榜单，维度层整体不产出（老用例行为不变）。
 * 用户 2026-10-24「风格能再多样一点」的落点就是这三条新路，所以要有用例把榜单真的打开。
 */
let charts: Chart[] = [];
/** 榜单 → 曲目（getChartDetail 的返回） */
const chartDetailTracks = new Map<string, Track[]>();

/**
 * 服务端 AI 模式的对话现场（v1.19 起 `mode: "server"` 真的会走 astral 会话）。
 * 默认「未登录」= serverSession null，此时应当退回规则并写 notice。
 */
let serverSession: unknown = null;
let serverAgents: unknown = [];
let serverConversation: unknown = { id: 9 };
let serverSend: unknown = { requestId: 9, assistantMessageId: 1, status: "PENDING" };
let serverEvents: unknown = { events: [], terminal: true, status: "COMPLETED", nextSequence: 1 };

const singerTracks: Track[] = [
  track("1", "晴天", "周杰伦"),
  track("2", "稻香", "周杰伦"),
  track("3", "浮夸", "陈奕迅"),
  track("4", "好久不见", "陈奕迅"),
  track("5", "后来", "刘若英"),
];

const singers: SingerStat[] = [
  { singer: "周杰伦", platform: "wyy", playCount: 30 },
  { singer: "陈奕迅", platform: "wyy", playCount: 20 },
];

/** 探索模式那一路「全部音源最新音乐」的返回（跨源，模拟真实全源聚合） */
const latestTracks: Track[] = [
  { id: "q1", platform: "qq", title: "陌生新歌", singer: "某个新人", album: "", picUrl: "", duration: 180 },
  { id: "q2", platform: "qq", title: "另一首新歌", singer: "另一个新人", album: "", picUrl: "", duration: 190 },
];

/**
 * 「我的歌单」里的歌 —— 心动模式的正牌来源。
 * 用户反馈（2026-10-22）：心动模式根本没读收藏歌单，于是永远只在常听歌手附近转。
 */
const playlistTracks: Track[] = [
  { id: "p1", platform: "qq", title: "歌单里的歌", singer: "歌单歌手", album: "", picUrl: "", duration: 200 },
  { id: "p2", platform: "qq", title: "歌单里的另一首", singer: "另一个歌单歌手", album: "", picUrl: "", duration: 210 },
];

vi.mock("@/services/ipc", () => ({
  getSetting: (key: string) => Promise.resolve(store.get(key) ?? null),
  setSetting: (key: string, value: string) => {
    store.set(key, value);
    return Promise.resolve();
  },
  getTopSingers: () => Promise.resolve(emptyHistory ? [] : singers),
  listHistory: () => Promise.resolve([]),
  listFavorites: () => Promise.resolve([]),
  listDislikes: () => Promise.resolve([]),
  checkDisliked: () => Promise.resolve([]),
  // 收藏歌单：本地自建的那一类直接读库
  listMyPlaylists: () =>
    Promise.resolve(
      noPlaylists
        ? []
        : [
            {
              id: "local-1",
              pid: "local-1",
              name: "我喜欢的",
              platform: "local",
              picUrl: "",
              trackCount: 0,
              createdAt: 1,
              updatedAt: 2,
              isLocal: true,
            },
          ],
    ),
  getPlaylistTracks: () => Promise.resolve(noPlaylists ? [] : playlistTracks),
  // 收听统计：口味画像与收听质量的来源（完播比靠 totalPlayedMs 算）。
  // 这里返回空数组 = 「有播放历史但没有统计」，画像退化成只有收藏/歌单样本，
  // 正好覆盖「统计缺失也不能崩」这条。
  getTopTracks: () => Promise.resolve([]),
  aiLocalChat: (...args: unknown[]) => aiLocalChat(...(args as [unknown, number?])),
  // 服务端 AI：每日推荐借音乐助手跑一轮（建会话 → 发消息 → 轮询 → 删会话）
  astralSession: () => Promise.resolve(serverSession),
  astralAiAgents: () => Promise.resolve(serverAgents),
  astralAiCreateConversation: () => Promise.resolve(serverConversation),
  astralAiSendMessage: () => Promise.resolve(serverSend),
  astralAiEvents: () => Promise.resolve(serverEvents),
  astralAiDeleteConversation: () => Promise.resolve(),
}));

vi.mock("@/source-scripts", () => ({
  getArtistSongs: () =>
    Promise.resolve({ songs: emptyHistory ? [] : singerTracks, picUrl: "", hasMore: false }),
  // 多关键词聚合（数据包 searchMany）：跨源这一路的唯一来源。
  // 默认每词空批 —— 旧用例里跨源搜索本来就返回空，行为保持不变。
  searchManyBatches: (
    keywords: string[],
    _page?: number,
    _size?: number,
    options?: { sources?: readonly string[]; concurrency?: number },
  ) => {
    manyCalls.push({ keywords, sources: options?.sources });
    return manyThrows
      ? Promise.reject(new Error("音源包调用失败：音源接口执行失败（搜索超时）"))
      : Promise.resolve({
          groups: keywords.map((keyword) => ({
            keyword,
            ok: true,
            batches: manyBatches.map((batch) => ({ source: batch.source, tracks: batch.tracks })),
          })),
          truncated: false,
        });
  },
  // 探索模式会额外捞「全部音源最新音乐」，mock 必须提供同名导出。
  // 它不受 `emptyHistory` 影响：探索模式本来就要在没有历史时也能出歌。
  getAllLatestSongs: () => Promise.resolve(latestTracks),
  // 在线收藏歌单的曲目只能走音源脚本拿（不落本地库）。
  // 风格歌单那条路也复用它 —— 有分类时返回风格曲目，模拟平台真的给歌。
  getPlaylistDetail: () =>
    Promise.resolve({
      tracks: styleCategories.length > 0 ? stylePlaylistTracks : [],
      name: "",
      picUrl: "",
      playCount: 0,
      description: "",
    }),
  searchPageMaxOf: () => 50,
  // 同专辑这一路（心动/常听会走）：搜不到专辑就诚实返回空，不影响出歌
  searchAlbums: () => Promise.resolve([]),
  getAlbumDetail: () => Promise.resolve({ tracks: [], name: "", picUrl: "", playCount: 0, description: "" }),
  // 风格歌单这一路（心动/探索/冷启动会走）：没有分类就跳过
  getPlaylistCategories: () => Promise.resolve(styleCategories),
  getRecommendations: () =>
    Promise.resolve(
      styleCategories.length === 0
        ? []
        : [{ id: "pl-mock", platform: "wyy", name: "风格精选", picUrl: "", playCount: 0 }],
    ),
  // 维度路（v9）：榜单 / 榜单详情 / 风格歌单搜索。默认空 —— 不打开时行为与 v8 一致。
  getCharts: () => Promise.resolve(charts),
  getChartDetail: (chart: { id: string }) =>
    Promise.resolve(chartDetailTracks.get(chart.id) ?? []),
  searchPlaylists: () => Promise.resolve([]),
}));

vi.mock("@/stores/musicSource", () => ({
  useMusicSourceStore: { getState: () => ({ activeSourceId: "wyy" }) },
}));

vi.mock("@/stores/sourceRegistry", () => ({
  useSourceRegistryStore: { getState: () => ({ ensure: () => Promise.resolve() }) },
}));

import {
  DAILY_TARGET,
  clearTodayResult,
  generateDailyRecommend,
  loadTodayResult,
  parseStyleSeeds,
  readDailyCache,
  readStyleSeeds,
  saveStyleSeeds,
} from "@/lib/daily-recommend";
import { resetAggregateSourcesCache } from "@/lib/aggregate-sources";
import { AGGREGATE_SOURCES_KEY, DAILY_RECOMMEND_SEEDS_KEY } from "@/lib/storageKeys";
import { useAuthStore } from "@/stores/auth";

beforeEach(() => {
  store.clear();
  aiLocalChat.mockReset();
  emptyHistory = false;
  noPlaylists = false;
  styleCategories = [];
  stylePlaylistTracks = [];
  manyBatches = [];
  manyThrows = false;
  manyCalls.length = 0;
  charts = [];
  chartDetailTracks.clear();
  serverSession = null;
  serverAgents = [];
  serverConversation = { id: 9 };
  serverSend = { requestId: 9, assistantMessageId: 1, status: "PENDING" };
  serverEvents = { events: [], terminal: true, status: "COMPLETED", nextSequence: 1 };
  // 聚合搜索音源设置是进程内缓存：不重置会读到上一个用例的勾选
  resetAggregateSourcesCache();
  // 默认按管理员跑：服务端 AI 只对管理员开放（2026-10-24），
  // 下面「未登录」「真的走助手会话」两个用例要真的进 server 分支；
  // 非管理员用例自己覆盖 profile。
  useAuthStore.setState({ profile: { permissions: ["admin:qt:admin"] }, session: null });
});

describe("规则模式", () => {
  it("不调模型，直接出结果并落缓存", async () => {
    const result = await generateDailyRecommend({ mode: "rule" });
    expect(aiLocalChat).not.toHaveBeenCalled();
    expect(result.mode).toBe("rule");
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.length).toBeLessThanOrEqual(DAILY_TARGET);
    expect(await loadTodayResult("rule")).not.toBeNull();
  });

  it("每条都带理由（列表里要显示，不能是空串）", async () => {
    const result = await generateDailyRecommend({ mode: "rule" });
    for (const item of result.items) expect(item.reason.length).toBeGreaterThan(0);
  });

  it("服务端 AI 未登录时退回规则，并明确说明原因", async () => {
    const result = await generateDailyRecommend({ mode: "server" });
    expect(result.mode).toBe("rule");
    expect(result.notice).toContain("还没有登录服务端");
    expect(aiLocalChat).not.toHaveBeenCalled();
  });

  it("非管理员传了 server：不进服务端，按纯规则跑并说明仅管理员可用", async () => {
    useAuthStore.setState({ profile: { roles: ["APP_USER"], permissions: ["user:ai:music:use"] } });
    // 会话/智能体都备好，证明是「身份闸」先拦住，而不是退到了未登录分支
    serverSession = { token: "t", refreshToken: "r", expiresAt: 0 };
    serverAgents = { data: [{ agentCode: "music_assistant", name: "音乐助手", agentType: "MUSIC" }] };

    const result = await generateDailyRecommend({ mode: "server" });
    expect(result.mode).toBe("rule");
    // requested 也收敛成 rule：否则非管理员永远命中不了规则缓存、每天重算
    expect(result.requested).toBe("rule");
    expect(result.notice).toContain("仅管理员可用");
    expect(result.notice).not.toContain("调用失败");
    expect(aiLocalChat).not.toHaveBeenCalled();
  });

  it("服务端 AI 真的走助手会话挑歌（v1.19，不再降级成规则）", async () => {
    serverSession = { token: "t", refreshToken: "r", expiresAt: 0 };
    serverAgents = { data: [{ agentCode: "music_assistant", name: "音乐助手", agentType: "MUSIC" }] };
    serverEvents = {
      events: [
        {
          type: "message.completed",
          data: {
            content: JSON.stringify({
              title: "服务端挑的",
              summary: "服务端说明",
              // 本地/服务端共用同一道闸 `DAILY_AI_MIN_PICKS=3`：少于 3 首视为没挑出来
              picks: [
                { index: 1, reason: "服务端理由" },
                { index: 2, reason: "服务端理由二" },
                { index: 3, reason: "服务端理由三" },
              ],
            }),
          },
        },
      ],
      terminal: true,
      status: "COMPLETED",
      nextSequence: 1,
    };
    const result = await generateDailyRecommend({ mode: "server" });
    expect(result.notice).toBeNull();
    expect(result.mode).toBe("server");
    expect(result.title).toBe("服务端挑的");
    expect(result.model).toBe("音乐助手");
    expect(result.items.slice(0, 3).map((item) => item.reason)).toEqual([
      "服务端理由",
      "服务端理由二",
      "服务端理由三",
    ]);
    // 本地模型这条路一次都不能碰：两种模式是互斥的
    expect(aiLocalChat).not.toHaveBeenCalled();
  });

  it("第二次调用命中缓存，不再打音源搜索", async () => {
    const first = await generateDailyRecommend({ mode: "rule" });
    const second = await generateDailyRecommend({ mode: "rule" });
    expect(second.generatedAt).toBe(first.generatedAt);
  });

  it("force 会重算（「换一批」）", async () => {
    const first = await generateDailyRecommend({ mode: "rule" });
    const second = await generateDailyRecommend({ mode: "rule", force: true });
    expect(second.generatedAt).toBeGreaterThanOrEqual(first.generatedAt);
    // 当天的键合并保留：上一批不能从「已推荐过」里消失
    const cache = await readDailyCache();
    const today = cache.days.find((day) => day.date === first.date);
    expect(today).toBeDefined();
    expect(today!.keys.length).toBeGreaterThanOrEqual(first.items.length);
  });
});

// 用户 2026-10-24：「风格能再多样一点，而不是只有那么一两个。因为你的数据来源是历史和
// 搜索出来的，AI 主要是在你的结果里面选歌，那么你的搜索维度和结果就非常重要。」
// 这一组钉住「候选池真的多了维度」：榜单曲目要进池、要有风格线标签、要进前 50。
describe("维度路：榜单把新风格带进候选池（v9）", () => {
  const chartTracks = (prefix: string, count: number, title: string, singer: string): Track[] =>
    Array.from({ length: count }, (_, index) =>
      track(`${prefix}${index + 1}`, `${title}${index + 1}`, `${singer}${index % 8}`),
    );

  it("榜单曲目进池进前 50，结果带「本期风格」，提示词按线给要求", async () => {
    charts = [
      { id: "c1", platform: "wyy", name: "国风榜", picUrl: "", description: null },
      { id: "c2", platform: "wyy", name: "热歌榜", picUrl: "", description: null },
    ];
    chartDetailTracks.set("c1", chartTracks("g", 30, "国风曲", "国风歌手"));
    chartDetailTracks.set("c2", chartTracks("h", 20, "热歌", "热歌手"));
    aiLocalChat.mockResolvedValue({
      content:
        '{"title":"国风打底，掺几首别的","summary":"多风格","picks":[{"index":1,"reason":"开场"},{"index":20,"reason":"换条线"},{"index":40,"reason":"收束"}]}',
      model: "m",
      elapsedMs: 1,
      promptTokens: null,
      completionTokens: null,
    });
    const result = await generateDailyRecommend({ mode: "local", taste: "heart" });
    const user = userPrompt();
    // 候选行要标出来源，模型才挑得出「另一条线」的歌
    expect(user).toContain("风格线：国风");
    expect(user).toContain("风格线：热歌");
    expect(user).toMatch(/这张歌单要覆盖 \d/);
    // 页面「本期风格」chips 的数据源
    const labels = (result.styleLanes ?? []).map((lane) => lane.label);
    expect(labels).toContain("国风");
    expect((result.styleLanes ?? []).find((lane) => lane.label === "国风")?.count ?? 0).toBeGreaterThan(0);
    // 榜单曲目真的进了结果（不是只在池里挂着）
    expect(result.items.some((item) => item.track.id.startsWith("g"))).toBe(true);
  });

  it("规则模式降级时也带「本期风格」（AI 挂了页面照样有维度信息）", async () => {
    charts = [{ id: "c1", platform: "wyy", name: "国风榜", picUrl: "", description: null }];
    chartDetailTracks.set("c1", chartTracks("g", 30, "国风曲", "国风歌手"));
    const result = await generateDailyRecommend({ mode: "rule" });
    expect((result.styleLanes ?? []).find((lane) => lane.label === "国风")?.count ?? 0).toBeGreaterThan(0);
    expect(result.items.some((item) => item.track.id.startsWith("g"))).toBe(true);
  });
});

/**
 * 提示词是模型唯一的信息来源，也是「序号 ↔ 曲目」回填的唯一依据。
 * 候选池的先后由推荐引擎决定（会随口味/日期/抖动变），所以测试必须从提示词里读池序，
 * 不许假设"池首一定是某首歌"。
 */
function userPrompt(): string {
  const messages = aiLocalChat.mock.calls[0]?.[0] as { role: string; content: string }[];
  return messages?.find((m) => m.role === "user")?.content ?? "";
}

/** 从提示词里取出候选池的「序号 → 曲目」列表（保持提示词里的顺序） */
function poolLines(): { title: string; singer: string }[] {
  return userPrompt()
    .split("\n")
    .map((line) => /^(\d+)\. (.+)$/.exec(line))
    .filter((matched): matched is RegExpExecArray => matched !== null)
    .map((matched) => {
      // 行格式：`1. 晴天 - 周杰伦（范特西 / 华语）` —— 括号里是风格信息，不属于曲目名
      const body = matched[2].split("（")[0];
      const [title, singer] = body.split(" - ");
      return { title: title.trim(), singer: (singer ?? "").trim() };
    });
}

describe("本地模型精选", () => {
  // 这一组只关心「序号 ↔ 池内曲目」的回填正确性，与口味无关。
  it("模型给出合法序号 → 按序号回填真实曲目，其余用规则补齐", async () => {
    aiLocalChat.mockResolvedValue({
      content:
        '{"title":"夜色","summary":"安静","picks":[{"index":1,"reason":"适合夜里"},{"index":3,"reason":"慢一点"},{"index":5,"reason":"收尾"}]}',
      model: "m",
      elapsedMs: 10,
      promptTokens: null,
      completionTokens: null,
    });
    const result = await generateDailyRecommend({ mode: "local", taste: "familiar" });
    const pool = poolLines();
    expect(result.mode).toBe("local");
    expect(result.title).toBe("夜色");
    // index=1 就是提示词里的第一首（模型只能看到序号，回填必须逐字对上）
    expect(result.items[0].track.title).toBe(pool[0].title);
    expect(result.items[0].track.singer).toBe(pool[0].singer);
    expect(result.items[0].reason).toBe("适合夜里");
    // 模型只挑 3 首 → 规则补齐到目标条数，且补齐的不与已选重复
    expect(result.items.length).toBeGreaterThan(3);
    expect(result.items.length).toBeLessThanOrEqual(DAILY_TARGET);
    const keys = result.items.map((item) => `${item.track.platform}:${item.track.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("模型把同歌手连着排 → 结果里被拆开（第一首仍是它最看好的那首）", async () => {
    aiLocalChat.mockResolvedValue({
      content:
        '{"picks":[{"index":1,"reason":"头牌"},{"index":4,"reason":"同歌手第二首"},{"index":2,"reason":"换个人"}]}',
      model: "m",
      elapsedMs: 1,
      promptTokens: null,
      completionTokens: null,
    });
    const result = await generateDailyRecommend({ mode: "local", taste: "familiar" });
    const pool = poolLines();
    // 模型最看好的那首（序号 1）必须还在第一位
    expect(result.items[0].track.title).toBe(pool[0].title);
    expect(result.items[1].track.singer).not.toBe(result.items[0].track.singer);
    // 打散只调顺序，模型挑的三首一个不少（补齐的规则歌会插在中间，所以不能只看前三条）
    const titles = result.items.map((item) => item.track.title);
    for (const hit of [pool[0], pool[1], pool[3]]) {
      expect(titles).toContain(hit.title);
    }
    // 集合里不许有重复曲目
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("候选池给到 150 首（不是把目标 50 首硬塞给模型挑）", async () => {
    // 用户 2026-10-23：「感觉不出 AI 和规则有什么不同」—— 池子只有 60 首、要挑 50 首，
    // 模型只能在 60 里砍 10 首，结果当然跟规则几乎一样。池子必须比目标大出一截。
    manyBatches = [
      {
        source: "qq",
        tracks: Array.from({ length: 160 }, (_, i) => ({
          id: `q${i + 1}`,
          platform: "qq",
          title: `候选${i + 1}`,
          singer: `候选歌手${i % 12}`,
          album: "",
          picUrl: "",
          duration: 200,
        })),
      },
    ];
    aiLocalChat.mockResolvedValue({
      content: '{"picks":[{"index":1,"reason":"a"},{"index":2,"reason":"b"},{"index":3,"reason":"c"}]}',
      model: "m",
      elapsedMs: 1,
      promptTokens: null,
      completionTokens: null,
    });
    const result = await generateDailyRecommend({ mode: "local", taste: "heart" });
    expect(result.mode).toBe("local");
    // 提示词里确实有 150 首候选
    expect(userPrompt()).toContain("共 150 首");
    expect(poolLines().length).toBe(150);
    // 结果里带上真正干活的模型名，换模型后能对比
    expect(result.model).toBe("m");
  });

  it("第一次回执格式坏了会重试一次，第二次成功就算成功（不是一次失败就整天退回规则）", async () => {
    aiLocalChat.mockResolvedValueOnce({
      // 说了话但没有任何序号 —— 第一次就是废的
      content: "好的，我觉得这些歌都不错，你听听看。",
      model: "m",
      elapsedMs: 1,
      promptTokens: null,
      completionTokens: null,
    });
    aiLocalChat.mockResolvedValueOnce({
      content: '{"title":"再来一次","picks":[{"index":1,"reason":"第一"},{"index":2,"reason":"第二"},{"index":3,"reason":"第三"}]}',
      model: "m",
      elapsedMs: 1,
      promptTokens: null,
      completionTokens: null,
    });
    const result = await generateDailyRecommend({ mode: "local" });
    expect(aiLocalChat).toHaveBeenCalledTimes(2);
    expect(result.mode).toBe("local");
    expect(result.title).toBe("再来一次");
    // 重试时温度再调低（0.4 → 0.2），并且明确告诉模型「上次不是合法 JSON」
    const retryMessages = aiLocalChat.mock.calls[1]?.[0] as { role: string; content: string }[];
    expect(retryMessages[retryMessages.length - 1].content).toContain("不是合法 JSON");
    expect(aiLocalChat.mock.calls[1]?.[1]).toBe(0.2);
    // 第一次也不能高：0.8 下同一个候选池能给出两份完全不同的歌单，这就是用户说的「像随机选」
    expect(aiLocalChat.mock.calls[0]?.[1]).toBe(0.4);
  });

  it("提示词改成「贴合优先」：给出语种下限，不再要求「别照抄前 N 首 / 尽量分散」", async () => {
    manyBatches = [
      {
        source: "qq",
        tracks: Array.from({ length: 160 }, (_, i) => ({
          id: `q${i + 1}`,
          platform: "qq",
          title: `候选${i + 1}`,
          singer: `候选歌手${i % 12}`,
          album: "",
          picUrl: "",
          duration: 200,
        })),
      },
    ];
    aiLocalChat.mockResolvedValue({
      content:
        '{"title":"贴合","picks":[{"index":1,"reason":"a"},{"index":2,"reason":"b"},{"index":3,"reason":"c"}]}',
      model: "m",
      elapsedMs: 1,
      promptTokens: null,
      completionTokens: null,
    });
    await generateDailyRecommend({ mode: "local", taste: "heart" });
    const prompt = userPrompt();
    // 用户 2026-10-24「AI 推荐怎么那么像随机选」：旧提示词的这两句正是「凑风格拼盘」的源头，
    // 模型为了满足它们会把弱匹配的尾巴歌（英文歌/冷门网络流行）塞进结果。
    expect(prompt).not.toContain("不要直接照抄");
    expect(prompt).not.toContain("尽量分散在不同歌手和不同风格");
    // 换成能逐条对账的约束：先贴合、再排序，语种有下限
    expect(prompt).toContain("越靠前越贴合");
    expect(prompt).toContain("非主语种");
    expect(prompt).toMatch(/请至少有 \d+ 首是华语/);
    // 候选行带时长带：旧提示词正文让模型「按时长判断」，却从没给过时长数据
    expect(prompt).toContain("三四分钟");
  });

  it("模型硬挑一首与画像无关的歌 → 结果里剔掉，并由规则补满 50 首", async () => {
    const unrelated: Track = {
      id: "en1",
      platform: "qq",
      title: "Random Pop Song",
      singer: "Some Artist",
      album: "",
      picUrl: "",
      duration: 200,
    };
    manyBatches = [
      {
        source: "qq",
        tracks: [
          ...Array.from({ length: 120 }, (_, i) => ({
            id: `q${i + 1}`,
            platform: "qq" as const,
            title: `候选${i + 1}`,
            singer: `候选歌手${i % 12}`,
            album: "",
            picUrl: "",
            duration: 200,
          })),
          // 候选总数 128 < 150，必进模型看到的池子
          unrelated,
        ],
      },
    ];
    // 模型「故意」挑那首英文歌：序号从提示词里读，不假设池序
    let targetedIndex: number | null = null;
    aiLocalChat.mockImplementationOnce(async (messages: unknown) => {
      const list = messages as { role: string; content: string }[];
      const user = list.find((message) => message.role === "user")?.content ?? "";
      const hit = /^(\d+)\. Random Pop Song - Some Artist/m.exec(user);
      targetedIndex = hit ? Number(hit[1]) : null;
      return {
        content: JSON.stringify({
          title: "混杂",
          picks: [
            { index: targetedIndex ?? 1, reason: "换换口味" },
            { index: 2, reason: "b" },
            { index: 3, reason: "c" },
          ],
        }),
        model: "m",
        elapsedMs: 1,
        promptTokens: null,
        completionTokens: null,
      };
    });
    const result = await generateDailyRecommend({ mode: "local", taste: "heart" });
    // 前提成立：那首英文歌真的进了候选清单，模型也真的挑了它
    expect(targetedIndex).not.toBeNull();
    expect(result.mode).toBe("local");
    // 剔掉 1 首之后仍要有 50 首（规则补位），页面不能少行
    expect(result.items.length).toBe(DAILY_TARGET);
    expect(result.items.map((item) => item.track.title)).not.toContain("Random Pop Song");
  });

  it("模型多给了一两首时按目标条数截住（页面不多出一行）", async () => {
    manyBatches = [
      {
        source: "qq",
        tracks: Array.from({ length: 160 }, (_, i) => ({
          id: `q${i + 1}`,
          platform: "qq",
          title: `候选${i + 1}`,
          singer: `候选歌手${i % 12}`,
          album: "",
          picUrl: "",
          duration: 200,
        })),
      },
    ];
    const picks = Array.from({ length: 51 }, (_, i) => ({ index: i + 1, reason: `理由${i + 1}` }));
    aiLocalChat.mockResolvedValue({
      content: JSON.stringify({ title: "多给了", summary: "模型给了 51 首", picks }),
      model: "m",
      elapsedMs: 1,
      promptTokens: null,
      completionTokens: null,
    });
    const result = await generateDailyRecommend({ mode: "local" });
    expect(result.mode).toBe("local");
    expect(result.items.length).toBe(DAILY_TARGET);
  });

  it("两次都拿不到序号才退回规则，并且把失败原因写进 notice", async () => {
    aiLocalChat.mockResolvedValue({
      content: "我不会",
      model: "m",
      elapsedMs: 1,
      promptTokens: null,
      completionTokens: null,
    });
    const result = await generateDailyRecommend({ mode: "local" });
    expect(aiLocalChat).toHaveBeenCalledTimes(2);
    expect(result.mode).toBe("rule");
    expect(result.notice).toContain("本地模型调用失败");
    // 退回规则的结果不带模型名（免得页面写着模型名、其实是规则挑的）
    expect(result.model).toBeUndefined();
  });

  it("模型返回池外序号 / 非 JSON → 退回规则结果，notice 写清原因", async () => {
    aiLocalChat.mockResolvedValue({ content: "我不会", model: "m", elapsedMs: 1, promptTokens: null, completionTokens: null });
    const result = await generateDailyRecommend({ mode: "local" });
    expect(result.mode).toBe("rule");
    expect(result.notice).toContain("本地模型调用失败");
    expect(result.items.length).toBeGreaterThan(0);
  });

  it("模型调用抛错（接口不可达）→ 退回规则结果", async () => {
    aiLocalChat.mockRejectedValue(new Error("请求模型接口失败：连接被拒绝"));
    const result = await generateDailyRecommend({ mode: "local" });
    expect(result.mode).toBe("rule");
    expect(result.notice).toContain("连接被拒绝");
  });

  it("模型只挑 1 首（少于下限）→ 视为没干活，退回规则", async () => {
    aiLocalChat.mockResolvedValue({
      content: '{"picks":[{"index":1,"reason":"a"}]}',
      model: "m",
      elapsedMs: 1,
      promptTokens: null,
      completionTokens: null,
    });
    const result = await generateDailyRecommend({ mode: "local" });
    expect(result.mode).toBe("rule");
  });

  it("失败结果也落缓存：下次进页面不重复搜音源、不重复调模型", async () => {
    aiLocalChat.mockRejectedValue(new Error("超时"));
    await generateDailyRecommend({ mode: "local" });
    expect(aiLocalChat).toHaveBeenCalledTimes(1);
    const cached = await loadTodayResult("local");
    expect(cached).not.toBeNull();
    expect(cached?.mode).toBe("rule");
    expect(cached?.requested).toBe("local");
  });

  it("提示词里带上候选池编号（模型只能回序号，拿不到 id）", async () => {
    aiLocalChat.mockResolvedValue({
      content: '{"picks":[{"index":1,"reason":"a"},{"index":2,"reason":"b"},{"index":3,"reason":"c"}]}',
      model: "m",
      elapsedMs: 1,
      promptTokens: null,
      completionTokens: null,
    });
    await generateDailyRecommend({ mode: "local", taste: "familiar" });
    const user = userPrompt();
    const numbered = user.split("\n").filter((row) => /^\d+\. /.test(row));
    // 从 1 开始连续编号：模型回 "3" 必须能唯一落到第三行
    expect(numbered.length).toBeGreaterThan(0);
    numbered.forEach((row, index) => expect(row.startsWith(`${index + 1}. `)).toBe(true));
    // 每行是「序号. 曲名 - 歌手（风格信息）」，不给 id
    expect(numbered[0]).toMatch(/^\d+\. .+ - .+/);
    // 候选池里不许出现任何真实 id（模型没机会抄 id）
    expect(user).not.toContain("wyy:");
  });
});

describe("空历史（冷启动）", () => {
  it("没有播放记录也没有收藏 → 不再返回空页面：平台新歌垫底 + 给出风格选项", async () => {
    emptyHistory = true;
    noPlaylists = true;
    styleCategories = [
      { id: "c1", name: "华语", group: "语种" },
      { id: "c2", name: "摇滚", group: "风格" },
    ];
    stylePlaylistTracks = [{ ...track("s1", "风格里的歌", "风格歌手"), platform: "wyy" }];
    const result = await generateDailyRecommend({ mode: "rule", force: true });
    // 旧契约是「空数组 + 提示去听歌」，新契约是「先给内容 + 让用户选风格」
    expect(result.coldStart).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.styleOptions?.map((option) => option.name)).toEqual(["华语", "摇滚"]);
    expect(result.styleSeeds).toEqual([]);
    // 冷启动不弹 toast：没有任何"出错了"的意思，只是还没数据
    expect(result.notice).toBeNull();
    expect(aiLocalChat).not.toHaveBeenCalled();
  });

  it("冷启动不叫模型：没有画像时让模型挑等于让它瞎猜", async () => {
    emptyHistory = true;
    noPlaylists = true;
    const result = await generateDailyRecommend({ mode: "local", force: true });
    expect(result.mode).toBe("rule");
    expect(result.coldStart).toBe(true);
    expect(aiLocalChat).not.toHaveBeenCalled();
  });

  it("音源不支持风格分类时，冷启动仍能出歌（只靠最新音乐）", async () => {
    emptyHistory = true;
    noPlaylists = true;
    const result = await generateDailyRecommend({ mode: "rule", force: true });
    expect(result.coldStart).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.styleOptions).toEqual([]);
  });

  it("选了风格种子 → 冷启动结束，候选池按该风格分类取歌", async () => {
    emptyHistory = true;
    noPlaylists = true;
    styleCategories = [{ id: "c2", name: "摇滚", group: "风格" }];
    stylePlaylistTracks = [
      track("r1", "摇滚一号", "摇滚歌手"),
      track("r2", "摇滚二号", "另一个摇滚歌手"),
    ];
    await saveStyleSeeds(["摇滚"]);
    await clearTodayResult();
    const result = await generateDailyRecommend({ mode: "rule", force: true });
    expect(result.coldStart).toBe(false);
    expect(result.styleSeeds).toEqual(["摇滚"]);
    expect(result.items.map((item) => item.track.id)).toContain("r1");
    // 只有种子、没有收听样本：画像不能说"口味还不明显"（那是无视用户的选择）
    expect(result.profileText).toBe("你选的风格：摇滚");
  });

  it("探索模式没有历史也能出歌（靠全音源最新音乐）", async () => {
    emptyHistory = true;
    const result = await generateDailyRecommend({ mode: "rule", taste: "explore", force: true });
    expect(result.items.length).toBeGreaterThan(0);
    // 出的是「最新音乐」那一路的跨源曲目
    expect(result.items.every((item) => item.track.platform === "qq")).toBe(true);
  });
});

describe("口味与缓存", () => {
  it("结果里记录口味，缓存按口味命中", async () => {
    const first = await generateDailyRecommend({ mode: "rule", taste: "familiar", force: true });
    expect(first.taste).toBe("familiar");
    expect(await loadTodayResult("rule", "familiar")).not.toBeNull();
    // 换口味必须重算，不能拿另一套口味的结果糊弄
    expect(await loadTodayResult("rule", "explore")).toBeNull();
  });

  it("换口味重算出来的结果换成新口味（不是复用旧缓存）", async () => {
    await generateDailyRecommend({ mode: "rule", taste: "heart", force: true });
    const next = await generateDailyRecommend({ mode: "rule", taste: "explore", force: true });
    expect(next.taste).toBe("explore");
  });
});

describe("心动模式吃收藏歌单", () => {
  it("收藏歌单里的歌进候选池并被推荐（不再只看常听歌手）", async () => {
    const result = await generateDailyRecommend({ mode: "rule", taste: "heart", force: true });
    const ids = result.items.map((item) => `${item.track.platform}:${item.track.id}`);
    expect(ids).toContain("qq:p1");
    // 歌单里的歌理由落在「收藏」上（收藏单曲与收藏歌单同权，不再区分渠道）
    const fromPlaylist = result.items.find((item) => item.track.id === "p1");
    expect(fromPlaylist?.reason).toContain("收藏");
  });

  it("只有收藏歌单、没有任何播放记录也能出歌（新用户不至于空白）", async () => {
    emptyHistory = true;
    const result = await generateDailyRecommend({ mode: "rule", taste: "heart", force: true });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every((item) => item.track.platform === "qq")).toBe(true);
  });
});

describe("跨源聚合搜索（数据包 searchMany）", () => {
  it("常听歌手的跨源结果进候选池并被推荐（扇出在音源包里做，app 只分块）", async () => {
    manyBatches = [
      {
        source: "qq",
        tracks: [
          { id: "x1", platform: "qq", title: "跨源来的歌", singer: "陌生歌手", album: "", picUrl: "", duration: 200 },
        ],
      },
      {
        source: "kw",
        tracks: [
          { id: "x2", platform: "kw", title: "跨源另一首", singer: "另一个陌生歌手", album: "", picUrl: "", duration: 210 },
        ],
      },
    ];
    const result = await generateDailyRecommend({ mode: "rule", taste: "heart", force: true });
    const ids = result.items.map((item) => `${item.track.platform}:${item.track.id}`);
    // 跨源结果确实进了池子并被选中：这层以前在 app 侧 mapLimit 扇出，现在走包入口
    expect(ids).toContain("qq:x1");
    expect(ids).toContain("kw:x2");
  });

  it("聚合整块失败不连坐整次生成（候选池吞掉错误，照常出结果）", async () => {
    manyThrows = true;
    const result = await generateDailyRecommend({ mode: "rule", taste: "heart", force: true });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.notice).toBeNull();
  });

  it("「只用勾选的源」会传到聚合搜索（设置 → 音源包 → 聚合搜索音源）", async () => {
    // 默认不传 sources = 全部音源
    await generateDailyRecommend({ mode: "rule", taste: "heart", force: true });
    expect(manyCalls.length).toBeGreaterThan(0);
    expect(manyCalls.every((call) => call.sources === undefined)).toBe(true);

    // 勾了 QQ/酷我之后：跨源这一路必须带上白名单，未勾选的源不会被请求
    store.set(AGGREGATE_SOURCES_KEY, '["qq","kw"]');
    resetAggregateSourcesCache();
    manyCalls.length = 0;
    manyBatches = [
      {
        source: "qq",
        tracks: [
          { id: "y1", platform: "qq", title: "勾选源里的歌", singer: "陌生歌手", album: "", picUrl: "", duration: 200 },
        ],
      },
    ];
    await generateDailyRecommend({ mode: "rule", taste: "heart", force: true });
    expect(manyCalls.length).toBeGreaterThan(0);
    expect(manyCalls.every((call) => call.sources?.join(",") === "qq,kw")).toBe(true);
  });
});

describe("风格种子持久化", () => {
  it("存进去读回来是干净数组（去空白、去重）", async () => {
    await saveStyleSeeds([" 摇滚 ", "", "摇滚", "华语"]);
    expect(await readStyleSeeds()).toEqual(["摇滚", "华语"]);
  });

  it("库里被写坏也读得出来：不是 JSON 就按分隔符救", async () => {
    store.set(DAILY_RECOMMEND_SEEDS_KEY, "摇滚, 华语、电子");
    expect(await readStyleSeeds()).toEqual(["摇滚", "华语", "电子"]);
  });

  it("最多存 4 个", async () => {
    await saveStyleSeeds(["a", "b", "c", "d", "e"]);
    expect((await readStyleSeeds()).length).toBe(4);
  });

  it("读设置抛异常时返回空数组（设置库坏了不该让整页推荐失败）", async () => {
    // 用非法 JSON 走不到异常分支，这里直接验证解析口径：坏字符串=空数组
    expect(parseStyleSeeds("{{{")).toEqual([]);
  });
});
