// @vitest-environment jsdom
/**
 * 搜索首页（落地页）：搜索历史 / 热门搜索 + 输入框自动聚焦。
 *
 * 回归起因（用户报）：右上角的搜索应该是一个**完整的独立页面**，进去能看到
 * 历史搜索、热门搜索等等，而不是一张空列表。标题栏现在只是入口（见
 * components/TitleBar.tsx 的 goSearch），内容全在这一页：
 *
 * 1. 没有 `?q=` 时渲染两块落地内容（历史 + 热搜），页签栏与聚合开关**不出现**
 *    （还没有结果可切）；**不渲染「热门歌单」** —— 用户口径要的是热门搜索，
 *    歌单推荐在「歌单广场」有整页；
 * 2. 输入框自动获得焦点 —— 从标题栏点进来可以直接打字；
 * 3. 点历史词 / 热搜词 = 发起一次搜索：改 URL 并写入搜索历史；
 * 4. 带 `?q=` 进来时只渲染结果，落地内容全部收起来。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";

/** 路由：SearchPage 只读 q / type，navigate 用来断言「发起了一次搜索」 */
const router = vi.hoisted(() => ({
  navigate: vi.fn(async () => {}),
  search: { q: "", type: undefined } as { q?: string; type?: string },
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => router.navigate,
  useSearch: () => router.search,
  useRouter: () => ({ history: { canGoBack: () => false, back: vi.fn() } }),
}));

/** 音源包调用面：本文件只碰热搜，结果类接口一律空 */
const api = vi.hoisted(() => ({
  searchMusic: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  searchPlaylists: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  searchArtists: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  searchAlbums: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  searchAllBatches: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  searchMergedPage: vi.fn(async (..._args: unknown[]) => ({ tracks: [] as unknown[], full: false })),
  getAllHotWords: vi.fn(async () => ["稻香", "晴天", "夜曲"] as string[]),
}));
vi.mock("@/source-scripts", () => ({
  ...api,
  DEFAULT_SEARCH_PAGE_MAX: 50,
  getSourceRegistry: vi.fn(async () => null),
  resolvePlayUrl: vi.fn(async () => ""),
  resolvePlayUrlDetailed: vi.fn(async () => ({ url: "", reason: "" })),
}));

/** 搜索历史走 settings 表（IPC），这里只读不写 */
const historyStore = vi.hoisted(() => ({
  current: ["周杰伦", "晴天"] as string[],
  add: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  clear: vi.fn(async () => {}),
}));
vi.mock("@/lib/search-history", () => ({
  getSearchHistory: vi.fn(async () => historyStore.current),
  addSearchHistory: historyStore.add,
  removeSearchHistoryItem: historyStore.remove,
  clearSearchHistory: historyStore.clear,
}));

vi.mock("@/lib/aggregate-sources", () => ({
  readAggregateSources: vi.fn(async () => null),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));

import { SearchPage } from "@/components/SearchPage";
import { useMusicSourceStore } from "@/stores/musicSource";
import { useSourceRegistryStore } from "@/stores/sourceRegistry";

function seedRegistry(): void {
  useSourceRegistryStore.setState({
    sources: [
      { id: "qq", name: "qq音乐", short: "QQ", color: "#000000", searchPageMax: 30 },
    ],
    qualities: [],
    ready: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  historyStore.current = ["周杰伦", "晴天"];
  router.search = { q: "" };
  useMusicSourceStore.setState({ activeSourceId: "qq", aggregateMode: false });
  seedRegistry();
});

afterEach(() => {
  useSourceRegistryStore.setState({ sources: [], qualities: [], ready: false });
});

describe("搜索首页", () => {
  it("历史与热搜都在，且不显示页签栏、不出现热门歌单", async () => {
    const { getByText, queryByText, getAllByText } = render(<SearchPage />);

    await waitFor(() => expect(getByText("搜索历史")).toBeTruthy());
    expect(getByText("热门搜索")).toBeTruthy();
    // 历史 chips（周杰伦）与热搜词（稻香）
    expect(getByText("周杰伦")).toBeTruthy();
    expect(getByText("稻香")).toBeTruthy();
    expect(getAllByText("晴天").length).toBeGreaterThan(0);

    // 用户口径：要的是热门**搜索**，不是热门歌单（歌单广场才是歌单的入口）
    expect(queryByText("热门歌单")).toBeNull();

    // 没有关键词时不该出现「聚合搜索」这种结果视图开关
    expect(queryByText("聚合搜索")).toBeNull();
  });

  it("输入框自动获得焦点（点标题栏进来可以直接打字）", async () => {
    const { getByPlaceholderText } = render(<SearchPage />);
    const input = getByPlaceholderText("搜索歌曲 / 歌单 / 歌手 / 专辑");
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("点历史词 = 发起搜索（改 URL 并写入历史）", async () => {
    const { getByText } = render(<SearchPage />);
    await waitFor(() => expect(getByText("周杰伦")).toBeTruthy());

    fireEvent.click(getByText("周杰伦"));

    expect(historyStore.add).toHaveBeenCalledWith("周杰伦");
    expect(router.navigate).toHaveBeenCalledWith({
      to: "/search",
      search: { q: "周杰伦", type: "song" },
    });
  });

  it("输入关键词点「搜索」也会发起搜索", async () => {
    const { getByPlaceholderText, getByRole } = render(<SearchPage />);
    const input = getByPlaceholderText("搜索歌曲 / 歌单 / 歌手 / 专辑");

    fireEvent.change(input, { target: { value: "夜曲" } });
    fireEvent.click(getByRole("button", { name: "搜索" }));

    expect(historyStore.add).toHaveBeenCalledWith("夜曲");
    expect(router.navigate).toHaveBeenCalledWith({
      to: "/search",
      search: { q: "夜曲", type: "song" },
    });
  });

  it("带 ?q= 进来只渲染结果：落地内容收起、页签栏出现", async () => {
    router.search = { q: "稻香", type: "song" };
    const { getByText, queryByText } = render(<SearchPage />);

    await waitFor(() => expect(getByText("聚合搜索")).toBeTruthy());
    expect(queryByText("搜索历史")).toBeNull();
    expect(queryByText("热门搜索")).toBeNull();
    expect(queryByText("热门歌单")).toBeNull();
  });
});
