// @vitest-environment jsdom
/**
 * 搜索页翻页：四个页签与聚合模式滚到底都要自动续页。
 *
 * 回归起因（用户报）：搜索只出一页，滚到底没有任何加载动作 —— SearchPage 原先
 * 把四个动作的 page 全写死 1，整页也没有哨兵。现在统一走 usePagedList，
 * 这里锁住三件最容易再写坏的事：
 *
 * 1. 每页条数 = **音源包自述的 searchPageMax**。搜索类接口没有 total/hasMore，
 *    收尾只能靠「满页 = 可能还有下一页」；传超限值会在第 1 页就被判成到底
 *    （qq 要 100 返回 0 条、酷狗恒给 30），正是「只出一页」的来源之一。
 * 2. 聚合模式一次打四源、只能有一个 size ⇒ 取所有源的最小值；「还有下一页」
 *    看**任一源是否满页**，不能看合并后的总数（合并总数 = 源数 × 每页条数，
 *    会在最后一页把「四源各剩几条」误判成还满一页）。
 * 3. 上游无视 page 反复返回同一页时必须收尾：否则 hasMore 恒真、哨兵一相交就
 *    无限续页，把上游打爆。
 * 4. 页签（`?type=`）由 URL 决定。搜索页不常驻，从歌单/歌手/专辑详情点返回是
 *    **重新挂载** —— 页签留在 useState 里就会被打回「歌曲」（用户实测反馈）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";

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
  getHotWords: vi.fn(async () => [] as string[]),
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

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));

import { SearchPage } from "@/components/SearchPage";
import { useMusicSourceStore } from "@/stores/musicSource";
import { useSourceRegistryStore } from "@/stores/sourceRegistry";
import type { Track } from "@/types";

/**
 * jsdom 没有 IntersectionObserver：stub 出可控实例，手动 trigger 模拟滚到底。
 * hook 在 items 变化时重建 observer，所以翻页后 instances 里会多一个新实例。
 *
 * `disconnect()` 必须真的失效：hook 在 `canLoadMore` 变假时会 disconnect 掉当前
 * observer，而回调里的 setCursor 是无条件自增的 —— stub 若不认 disconnect，
 * 对旧实例再 trigger 一次就能凭空多翻一页，测试会测出真实浏览器里不存在的行为。
 */
class FakeIO {
  static instances: FakeIO[] = [];
  private disconnected = false;
  private cb: (entries: IntersectionObserverEntry[]) => void;

  constructor(cb: (entries: IntersectionObserverEntry[]) => void) {
    this.cb = cb;
    FakeIO.instances.push(this);
  }

  observe(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  unobserve(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  trigger(): void {
    if (this.disconnected) return;
    this.cb([{ isIntersecting: true } as unknown as IntersectionObserverEntry]);
  }
}
// @ts-expect-error 测试专用 stub，签名是子集
globalThis.IntersectionObserver = FakeIO;

/** 最后一个 observer = 最新一轮挂上的哨兵 */
function scrollToBottom(): void {
  FakeIO.instances[FakeIO.instances.length - 1]?.trigger();
}

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

/** 只填 SearchPage 读得到的字段（id/name/searchPageMax） */
function seedRegistry(entries: { id: string; searchPageMax: number }[]): void {
  useSourceRegistryStore.setState({
    sources: entries.map((e) => ({
      id: e.id,
      name: `源${e.id}`,
      short: e.id,
      color: "#000000",
      searchPageMax: e.searchPageMax,
    })),
    qualities: [],
    ready: true,
  });
}

beforeEach(() => {
  FakeIO.instances = [];
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

describe("搜索页翻页", () => {
  it("歌曲页签：按 searchPageMax 取第一页，滚到底自动续第二页并追加", async () => {
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
    expect(container.textContent).toContain("曲目a1");
    expect(container.textContent).toContain("继续下拉加载更多");

    await act(async () => {
      scrollToBottom();
      await settle();
    });

    expect(api.searchMusic).toHaveBeenLastCalledWith("稻香", "qq", 2, 2);
    // 第二页只有 1 条 < 2 → 到底，且旧页没有被冲掉
    expect(container.textContent).toContain("曲目a1");
    expect(container.textContent).toContain("曲目b1");
    expect(container.textContent).toContain("已经到底了");
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
    // 满页 → 还能继续滚
    expect(container.textContent).toContain("继续下拉加载更多");
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

  it("聚合模式：size 取所有源的最小 searchPageMax，满页判定看任一源", async () => {
    seedRegistry([
      { id: "qq", searchPageMax: 50 },
      { id: "bili", searchPageMax: 20 },
    ]);
    useMusicSourceStore.setState({ activeSourceId: "qq", aggregateMode: true });
    router.search = { q: "稻香" };
    // 两源各 12 条：合并 24 ≥ 20，但没有任何一源满页 → 到底（按合并总数判会白翻一轮）
    api.searchAllBatches.mockImplementation(async () => [
      { source: "qq", tracks: Array.from({ length: 12 }, (_, i) => track(`q${i}`, "qq")) },
      { source: "bili", tracks: Array.from({ length: 12 }, (_, i) => track(`b${i}`, "bili")) },
    ]);

    const { container } = render(<SearchPage />);
    await act(settle);

    expect(api.searchAllBatches).toHaveBeenCalledWith("稻香", 1, 20);
    // 分组头用的是注册表展示名
    expect(container.textContent).toContain("源qq");
    expect(container.textContent).toContain("源bili");
    expect(container.textContent).toContain("已经到底了");

    await act(async () => {
      scrollToBottom();
      await settle();
    });
    expect(api.searchAllBatches).toHaveBeenCalledTimes(1);
  });

  it("聚合模式：有源满页时续页，续页结果并进同一分组", async () => {
    seedRegistry([
      { id: "qq", searchPageMax: 50 },
      { id: "bili", searchPageMax: 2 },
    ]);
    useMusicSourceStore.setState({ activeSourceId: "qq", aggregateMode: true });
    router.search = { q: "稻香" };
    api.searchAllBatches.mockImplementation(async (_kw: unknown, page: unknown) => {
      if (page === 1) {
        return [
          { source: "qq", tracks: [track("q1", "qq")] },
          { source: "bili", tracks: [track("b1", "bili"), track("b2", "bili")] },
        ];
      }
      if (page === 2) {
        // b2 与第一页重复：去重后只剩 b3
        return [{ source: "bili", tracks: [track("b2", "bili"), track("b3", "bili")] }];
      }
      return [];
    });

    const { container, getByText } = render(<SearchPage />);
    await act(settle);
    expect(api.searchAllBatches).toHaveBeenCalledWith("稻香", 1, 2);

    await act(async () => {
      scrollToBottom();
      await settle();
    });

    expect(api.searchAllBatches).toHaveBeenLastCalledWith("稻香", 2, 2);
    expect(container.textContent).toContain("曲目b3");
    // 分组头累计 3 首 = 同一源的两页并进了同一组（getByText 命中多个会抛）
    expect(getByText("3 首")).toBeTruthy();
    // bili 第二页仍是满页 → 还有下一页
    expect(container.textContent).toContain("继续下拉加载更多");

    await act(async () => {
      scrollToBottom();
      await settle();
    });
    expect(api.searchAllBatches).toHaveBeenLastCalledWith("稻香", 3, 2);
    expect(container.textContent).toContain("已经到底了");
  });

  it("上游无视 page 反复返回同一页：去重后立即收尾，不再请求下一页", async () => {
    router.search = { q: "稻香" };
    // 恒返回同样两条：满页 → 首轮 hasMore 为真，第二页全是重复条目
    api.searchMusic.mockImplementation(async () => [track("a1"), track("a2")]);

    const { container } = render(<SearchPage />);
    await act(settle);
    expect(api.searchMusic).toHaveBeenCalledTimes(1);

    await act(async () => {
      scrollToBottom();
      await settle();
    });
    expect(api.searchMusic).toHaveBeenLastCalledWith("稻香", "qq", 2, 2);
    expect(container.textContent).toContain("已经到底了");

    // 再过一轮：hasMore 已收口，哨兵不会再挂 observer
    const instancesBefore = FakeIO.instances.length;
    await act(async () => {
      scrollToBottom();
      await settle();
    });
    expect(api.searchMusic).toHaveBeenCalledTimes(2);
    expect(FakeIO.instances.length).toBe(instancesBefore);
  });
});