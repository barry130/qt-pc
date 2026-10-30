// @vitest-environment jsdom
/**
 * 搜索页一次拉全量：四个页签与聚合模式都自动把后续页取完，不需要滚动。
 *
 * 回归起因（用户 m05614）：列表不再做「滚到底续页」，进页就把结果取全，
 * 底部也不再出现「已经到底了 / 继续下拉加载更多」这类终态文案。这里锁住
 * 四件最容易再写坏的事：
 *
 * 1. 每页条数 = **音源包自述的 searchPageMax**。搜索类接口没有 total/hasMore，
 *    「还有下一页」只能靠「满页 = 可能还有」推断；传超限值会在第 1 页就被判成
 *    到底（qq 要 100 返回 0 条、酷狗恒给 30），正是「只出一页」的来源之一。
 * 2. 聚合模式一次打四源、只能有一个 size ⇒ 取所有源的最小值；「还有下一页」
 *    由数据包 `searchMerged` 回的 `full`（**合并前**是否有任一源满页）决定，
 *    不能看合并后的条数（合并去重后必然变少，会在第 1 页就误判到底）。
 * 3. 上游无视 page 反复返回同一页时必须收尾：否则「满页 = 还有」恒真，一次性
 *    拉全量会变成无限续页，把上游打爆。零新增即收尾。
 * 4. 页签（`?type=`）由 URL 决定。搜索页不常驻，从歌单/歌手/专辑详情点返回是
 *    **重新挂载** —— 页签留在 useState 里就会被打回「歌曲」（用户实测反馈）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";

/** 路由：SearchPage 只读 q，navigate/useRouter 供 BackButton 用 */
const router = vi.hoisted(() => ({
  navigate: vi.fn(async () => {}),
  search: { q: "", type: undefined } as { q?: string; type?: string },
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => router.navigate,
  useSearch: () => router.search,
  useRouter: () => ({ history: { canGoBack: () => false, back: vi.fn() } }),
}));

/** 音源包调用面：只 mock SearchPage 会碰到的动作 */
const api = vi.hoisted(() => ({
  searchMusic: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  searchPlaylists: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  searchArtists: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  searchAlbums: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  searchAllBatches: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  // 聚合模式走「合并去重后的单列表」：数据包 `searchMerged` 负责合并/去重/排序，
  // 并回 `full`（合并前是否有任一源满页）—— 宿主拿不到各源原始条数，只能信它。
  searchMergedPage: vi.fn(async (..._args: unknown[]) => ({ tracks: [] as unknown[], full: false })),
  getAllHotWords: vi.fn(async () => [] as string[]),
}));
vi.mock("@/source-scripts", () => ({
  ...api,
  // 注册表未拉到时 useSearchPageMax 的兜底值，真实导出必须存在（stores/sourceRegistry 会 import）
  DEFAULT_SEARCH_PAGE_MAX: 50,
  getSourceRegistry: vi.fn(async () => null),
  resolvePlayUrl: vi.fn(async () => ""),
  resolvePlayUrlDetailed: vi.fn(async () => ({ url: "", reason: "" })),
}));

// 搜索历史走 settings 表（IPC），测试里只关心页面本身
vi.mock("@/lib/search-history", () => ({
  getSearchHistory: vi.fn(async () => []),
  addSearchHistory: vi.fn(async () => {}),
  removeSearchHistoryItem: vi.fn(async () => {}),
  clearSearchHistory: vi.fn(async () => {}),
}));

// 聚合搜索音源设置（设置 → 音源包）：本文件只关心取全量，按默认「全部音源」处理
vi.mock("@/lib/aggregate-sources", () => ({
  readAggregateSources: vi.fn(async () => null),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));

import { SearchPage } from "@/components/SearchPage";
import { useMusicSourceStore } from "@/stores/musicSource";
import { useSourceRegistryStore } from "@/stores/sourceRegistry";
import type { Track } from "@/types";

function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 40));
}

function track(id: string, platform = "qq"): Track {
  return {
    id,
    platform: platform as Track["platform"],
    title: `曲目${id}`,
    singer: "歌手",
    album: "",
    picUrl: "",
    duration: 0,
    musicId: null,
  };
}

/**
 * 只填 SearchPage 读得到的字段（id/name/short/searchPageMax）。
 * 行内的平台标显示的是 `short`（简称），所以这里让 short 带着「源」前缀、
 * name 用另一份文案 —— 断言命中 `源qq` 就说明确实读的是简称。
 */
function seedRegistry(entries: { id: string; searchPageMax: number }[]): void {
  useSourceRegistryStore.setState({
    sources: entries.map((e) => ({
      id: e.id,
      name: `${e.id}音乐`,
      short: `源${e.id}`,
      color: "#000000",
      searchPageMax: e.searchPageMax,
    })),
    qualities: [],
    ready: true,
  });
}

/** 底部不应该再出现任何终态/续页提示（用户 m05614 明确要求） */
function expectNoScrollFooter(container: HTMLElement): void {
  expect(container.textContent).not.toContain("继续下拉加载更多");
  expect(container.textContent).not.toContain("已经到底了");
  expect(container.textContent).not.toContain("正在加载其余");
}

beforeEach(() => {
  vi.clearAllMocks();
  router.search = { q: "" };
  router.navigate.mockClear();
  useMusicSourceStore.setState({ activeSourceId: "qq", aggregateMode: false });
  seedRegistry([{ id: "qq", searchPageMax: 2 }]);
});

afterEach(() => {
  // 注册表是模块级单例，别把种子留给下一个用例（也避免影响别的测试文件）
  useSourceRegistryStore.setState({ sources: [], qualities: [], ready: false });
});

describe("搜索页一次拉全量", () => {
  it("歌曲页签：按 searchPageMax 自动把后续页拉完，不需要滚动", async () => {
    router.search = { q: "稻香" };
    api.searchMusic.mockImplementation(async (_kw: unknown, _src: unknown, page: unknown) =>
      page === 1
        ? [track("a1"), track("a2")]
        : page === 2
          ? [track("b1")]
          : [],
    );

    const { container } = render(<SearchPage />);
    await act(settle);

    // 每页条数来自注册表自述值，写死 30/20 都会让「满页=还有」判错
    expect(api.searchMusic).toHaveBeenCalledWith("稻香", "qq", 1, 2);
    // 第 1 页满页 → 自动续第 2 页（第 2 页只有 1 条 < 2 → 到底收尾）
    await waitFor(() => expect(api.searchMusic).toHaveBeenCalledWith("稻香", "qq", 2, 2));
    await act(settle);

    // 旧页没有被冲掉，两页的行都在同一条列表里
    expect(container.textContent).toContain("曲目a1");
    expect(container.textContent).toContain("曲目b1");
    expectNoScrollFooter(container);
  });

  it("页签由 URL 决定：带 ?type=playlist 落地就渲染歌单结果（从详情页返回的场景）", async () => {
    // 搜索页不常驻，从歌单详情点返回 = 用 URL 重新挂载本页；页签若留在 state
    // 里就会被初始化成「歌曲」，这正是「返回回到歌曲页面」那个 bug
    router.search = { q: "稻香", type: "playlist" };
    api.searchMusic.mockResolvedValue([track("s1")]);
    api.searchPlaylists.mockImplementation(async () =>
      [1, 2].map((i) => ({
        id: `p${i}`,
        platform: "qq",
        name: `歌单${i}`,
        picUrl: "",
        playCount: "",
        description: null,
      })),
    );

    const { container } = render(<SearchPage />);
    await act(settle);

    // 只打歌单动作，条数同样按 searchPageMax
    expect(api.searchPlaylists).toHaveBeenCalledWith("qq", "稻香", 1, 2);
    expect(api.searchMusic).not.toHaveBeenCalled();
    expect(container.textContent).toContain("歌单1");
    // 第 2 页零新增即收尾，底部不留文案
    await waitFor(() => expect(api.searchPlaylists).toHaveBeenCalledTimes(2));
    await act(settle);
    expectNoScrollFooter(container);
  });

  it("点页签把 type 写进 URL（replace，不在历史里堆页签）", async () => {
    router.search = { q: "稻香" };
    api.searchMusic.mockResolvedValue([track("s1")]);

    const { getByText } = render(<SearchPage />);
    await act(settle);
    expect(api.searchMusic).toHaveBeenCalledWith("稻香", "qq", 1, 2);

    fireEvent.click(getByText("歌单"));
    await act(settle);

    expect(router.navigate).toHaveBeenCalledWith({
      to: "/search",
      search: { q: "稻香", type: "playlist" },
      replace: true,
    });
  });

  it("聚合模式：size 取所有源的最小 searchPageMax，满页依据由数据包给", async () => {
    seedRegistry([
      { id: "qq", searchPageMax: 50 },
      { id: "bili", searchPageMax: 20 },
    ]);
    useMusicSourceStore.setState({ activeSourceId: "qq", aggregateMode: true });
    router.search = { q: "稻香" };
    // 两源各 12 条、数据包合并后仍报 full:false（没有任何一源满页）→ 到底
    api.searchMergedPage.mockResolvedValue({
      tracks: [
        ...Array.from({ length: 12 }, (_, i) => track(`q${i}`, "qq")),
        ...Array.from({ length: 12 }, (_, i) => track(`b${i}`, "bili")),
      ],
      full: false,
    });

    const { container } = render(<SearchPage />);
    await act(settle);

    expect(api.searchMergedPage).toHaveBeenCalledWith("稻香", 1, 20, {
      sources: undefined,
      preferSource: "qq",
    });
    // 合并成一条列表：每个源的行都在，但**没有**「源qq 12 首」这种分组头
    expect(container.textContent).toContain("源qq");
    expect(container.textContent).toContain("源bili");
    expect(container.textContent).not.toContain("12 首");
    // full:false 说明第 1 页就是最后一页，不再多发一次请求
    expect(api.searchMergedPage).toHaveBeenCalledTimes(1);
    expectNoScrollFooter(container);
  });

  it("聚合模式：数据包报满页时自动续页，续页结果并进同一条列表", async () => {
    seedRegistry([
      { id: "qq", searchPageMax: 50 },
      { id: "bili", searchPageMax: 2 },
    ]);
    useMusicSourceStore.setState({ activeSourceId: "qq", aggregateMode: true });
    router.search = { q: "稻香" };
    api.searchMergedPage.mockImplementation(async (_kw: unknown, page: unknown) => {
      if (page === 1) {
        return { tracks: [track("q1", "qq"), track("b1", "bili"), track("b2", "bili")], full: true };
      }
      if (page === 2) {
        // b2 与第一页重复：跨页按「同一首歌」去重后只剩 b3
        return { tracks: [track("b2", "bili"), track("b3", "bili")], full: true };
      }
      return { tracks: [], full: false };
    });

    const { container } = render(<SearchPage />);
    await act(settle);

    expect(api.searchMergedPage).toHaveBeenCalledWith("稻香", 1, 2, {
      sources: undefined,
      preferSource: "qq",
    });
    // 第 1 页报满页 → 自动续第 2 页；第 3 页起并发补页，空页即收尾
    await waitFor(() =>
      expect(api.searchMergedPage).toHaveBeenCalledWith("稻香", 2, 2, {
        sources: undefined,
        preferSource: "qq",
      }),
    );
    await waitFor(() =>
      expect(api.searchMergedPage).toHaveBeenCalledWith("稻香", 3, 2, {
        sources: undefined,
        preferSource: "qq",
      }),
    );
    await act(settle);

    expect(container.textContent).toContain("曲目b3");
    // 跨页重复的 b2 只留一条
    expect(container.textContent?.match(/曲目b2/g)?.length ?? 0).toBe(1);
    // 没有分组头，也就没有「N 首」这种累计文案
    expect(container.textContent).not.toContain("3 首");
    expectNoScrollFooter(container);
  });

  it("上游无视 page 反复返回同一页：去重后立即收尾，不再请求下一页", async () => {
    router.search = { q: "稻香" };
    // 恒返回同样两条：满页 → 第 1 页 hasMore 为真，第二页全是重复条目
    api.searchMusic.mockImplementation(async () => [track("a1"), track("a2")]);

    const { container } = render(<SearchPage />);
    await act(settle);

    // 第 1 页 + 第 2 页（零新增）后收尾，不会无限续页
    await waitFor(() => expect(api.searchMusic).toHaveBeenCalledTimes(2));
    await act(settle);
    expect(api.searchMusic).toHaveBeenLastCalledWith("稻香", "qq", 2, 2);
    expect(api.searchMusic).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("曲目a1");
    expectNoScrollFooter(container);
  });
});
