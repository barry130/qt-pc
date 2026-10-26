// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Track } from "@/types";
import type { DailyRecommendMode, DailyRecommendResult, DailyTaste } from "@/lib/daily-recommend";

/**
 * 每日推荐页的「本期风格」区块。
 *
 * 用户 2026-10-24 反馈「风格能再多变一点、推荐维度再多一点」：候选池那边靠更多维度
 * （榜单 / 风格关键词 / 语种 / 搜索历史）搜宽，页面这边要把**这期到底覆盖了哪几条
 * 风格线**摊开给用户看，否则变没变多他无从判断。
 *
 * 页面只负责展示 `styleLanes`（生成逻辑在 `@/lib/daily-recommend`，本文件不测），
 * 所以生成链路整段替身，只喂一份结果。这四条守住：
 *   1. 有风格线 → 每条一个 chip，数量写在 chip 里，title 说明含义；
 *   2. `styleLanes` 为空数组 → 整块不渲染（不留空白、不占高度）；
 *   3. 老缓存缺 `styleLanes` 字段 → 同样整块不渲染；
 *   4. 位置在「口味画像」之后、「推荐口味」按钮组之前（不打乱现有信息顺序）。
 */

// 页面经 @/lib/daily-recommend 间接加载 Tauri IPC（设置/数据包都在 Rust 侧），
// jsdom 下没有 internals，先把这两个入口替身掉。
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));

const generateDailyRecommend = vi.fn<(options: unknown) => Promise<DailyRecommendResult>>();
const loadTodayResult = vi.fn<() => Promise<DailyRecommendResult | null>>();
const readMode = vi.fn<() => Promise<DailyRecommendMode>>();
const readTaste = vi.fn<() => Promise<DailyTaste>>();
const saveTaste = vi.fn<(taste: DailyTaste) => Promise<void>>();
const saveStyleSeeds = vi.fn<(names: string[]) => Promise<void>>();
const clearTodayResult = vi.fn<() => Promise<void>>();

vi.mock("@/lib/daily-recommend", async (importOriginal) => {
  // 常量（DAILY_TASTE_ORDER / DAILY_TASTE_LABEL / DAILY_MODE_LABEL …）保留真实值，
  // 只替换带 IO 的几个函数 —— 否则测试等于在断言一份假文案。
  const actual = await importOriginal<typeof import("@/lib/daily-recommend")>();
  return {
    ...actual,
    generateDailyRecommend,
    loadTodayResult,
    readMode,
    readTaste,
    saveTaste,
    saveStyleSeeds,
    clearTodayResult,
  };
});

// 曲目行与批量条要读收藏、下载、音质等一堆 store/IPC，与本区块无关；
// 替身掉，让「页面能渲染出来」只受本区块影响（真实行渲染另有用例覆盖）。
vi.mock("@/components/discovery/TrackList", () => ({
  TrackList: () => <div data-testid="track-list" />,
}));
vi.mock("@/components/discovery/BatchBar", () => ({
  BatchBar: () => <div data-testid="batch-bar" />,
}));

const playQueue = vi.fn(async () => {});
vi.mock("@/stores/player", () => ({
  usePlayerStore: <T,>(selector: (state: { playQueue: typeof playQueue }) => T): T =>
    selector({ playQueue }),
}));

// 常驻页的「当前是否可见」默认就是 true，显式给一下，不依赖 context 默认值
vi.mock("@/components/layout/keepAliveActive", () => ({ useKeepAliveActive: () => true }));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

function track(id: string, title: string): Track {
  return { id, platform: "wyy", title, singer: "某歌手", album: "", picUrl: "", duration: 200 };
}

/** 一份完整结果（字段对齐 DailyRecommendResult）；`styleLanes` 缺省 = 老缓存 */
function makeResult(styleLanes?: { label: string; count: number }[]): DailyRecommendResult {
  return {
    date: "2026-10-24",
    mode: "rule",
    requested: "rule",
    generatedAt: 1,
    title: "秋末的旧歌与国风",
    summary: "按你的播放记录挑的，每天换一批",
    items: [
      { track: track("1", "青花瓷"), reason: "常听中国风" },
      { track: track("2", "海阔天空"), reason: "常听粤语" },
    ],
    notice: null,
    profileText: "华语 · 三四分钟 · 常听 3 位歌手",
    ...(styleLanes ? { styleLanes } : {}),
  };
}

/** 本期覆盖的两条风格线（后台按条数降序给，页面不该重排） */
const LANES = [
  { label: "古风", count: 22 },
  { label: "粤语", count: 7 },
];

async function renderPage(): Promise<void> {
  const { DailyRecommendPage } = await import("@/components/discovery/DailyRecommendPage");
  render(<DailyRecommendPage />);
}

beforeEach(() => {
  vi.clearAllMocks();
  // 缓存未命中：否则页面直接展示缓存结果，不会走生成（也就拿不到我们的结果）
  loadTodayResult.mockResolvedValue(null);
  readMode.mockResolvedValue("rule");
  readTaste.mockResolvedValue("heart");
  saveTaste.mockResolvedValue(undefined);
  saveStyleSeeds.mockResolvedValue(undefined);
  clearTodayResult.mockResolvedValue(undefined);
  generateDailyRecommend.mockResolvedValue(makeResult(LANES));
});

describe("每日推荐页 · 本期风格", () => {
  it("有风格线时每条一个 chip，数量与含义都在", async () => {
    await renderPage();
    // 等生成结果落到页面上（h1 是 result.title）
    expect(await screen.findByText("秋末的旧歌与国风")).toBeTruthy();
    expect(screen.getByTestId("track-list")).toBeTruthy();

    expect(screen.getByText("本期风格")).toBeTruthy();
    expect(screen.getByText("古风 22")).toBeTruthy();
    expect(screen.getByText("粤语 7")).toBeTruthy();

    // 语义上是「一组风格线」：list + 两条 listitem，读屏能听出来
    const list = screen.getByRole("list", { name: "本期风格" });
    expect(list.querySelectorAll("li")).toHaveLength(2);

    // chip 的 title 说明这个数字是什么
    expect(screen.getByText("古风 22").getAttribute("title")).toBe(
      "本期歌单里来自「古风」这条风格线的歌曲数",
    );
  });

  it("styleLanes 为空数组时整块不渲染（不留空白、不占高度）", async () => {
    generateDailyRecommend.mockResolvedValue(makeResult([]));
    await renderPage();
    expect(await screen.findByText("秋末的旧歌与国风")).toBeTruthy();

    expect(screen.queryByText("本期风格")).toBeNull();
    expect(screen.queryByRole("list", { name: "本期风格" })).toBeNull();
    expect(screen.queryByText("古风 22")).toBeNull();
  });

  it("老缓存没有 styleLanes 字段时同样整块不渲染", async () => {
    generateDailyRecommend.mockResolvedValue(makeResult());
    await renderPage();
    expect(await screen.findByText("秋末的旧歌与国风")).toBeTruthy();

    expect(screen.queryByText("本期风格")).toBeNull();
    expect(screen.queryByRole("list", { name: "本期风格" })).toBeNull();
  });

  it("位置在口味画像之后、口味按钮组之前", async () => {
    await renderPage();
    expect(await screen.findByText("古风 22")).toBeTruthy();

    const profile = screen.getByText(/口味画像/);
    const lanes = screen.getByText("本期风格");
    const tasteGroup = screen.getByRole("group", { name: "推荐口味" });
    const following = Node.DOCUMENT_POSITION_FOLLOWING;

    expect(profile.compareDocumentPosition(lanes) & following).toBe(following);
    expect(lanes.compareDocumentPosition(tasteGroup) & following).toBe(following);
  });
});
