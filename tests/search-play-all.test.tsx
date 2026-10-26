// @vitest-environment jsdom
/**
 * 搜索页「歌曲」页签的**播放全部**。
 *
 * 用户口径：搜索歌曲页面要能一次性把结果全部播起来，而不是只能一首首点。
 *
 * 两个容易写坏的点，这里锁住：
 * 1. 「全部」只能是**已加载**的那批 —— 搜索是一页一页往下拉的（usePagedList），
 *    没加载的第 3 页本来就不在手里；按钮 title 里写清条数，避免误解。
 * 2. 没有结果时不该出现这颗按钮（空列表上的「播放全部」点了什么也不会发生）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";

/** 路由：本文件以 `?q=` 进结果视图 */
const router = vi.hoisted(() => ({
  navigate: vi.fn(async () => {}),
  search: { q: "晴天", type: "song" } as { q?: string; type?: string },
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => router.navigate,
  useSearch: () => router.search,
  useRouter: () => ({ history: { canGoBack: () => false, back: vi.fn() } }),
}));

/** 播放器：SearchPage 只用到 play（单首）与 playQueue（整批入队） */
const player = vi.hoisted(() => ({
  play: vi.fn(async () => {}),
  playQueue: vi.fn(async () => {}),
}));
vi.mock("@/stores/player", () => ({
  usePlayerStore: (
    selector: (s: {
      play: typeof player.play;
      playQueue: typeof player.playQueue;
      state: { trackId: string | null } | null;
    }) => unknown,
  ) => selector({ play: player.play, playQueue: player.playQueue, state: null }),
}));

const tracks = vi.hoisted(() => [
  { id: "1", platform: "qq", title: "晴天", singer: "周杰伦", album: "", picUrl: "", duration: 269 },
  { id: "2", platform: "qq", title: "稻香", singer: "周杰伦", album: "", picUrl: "", duration: 223 },
  { id: "3", platform: "qq", title: "夜曲", singer: "周杰伦", album: "", picUrl: "", duration: 226 },
]);

const api = vi.hoisted(() => ({
  searchMusic: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  searchPlaylists: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  searchArtists: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  searchAlbums: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  searchAllBatches: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  searchMergedPage: vi.fn(async (..._args: unknown[]) => ({ tracks: [] as unknown[], full: false })),
  getAllHotWords: vi.fn(async () => [] as string[]),
}));
vi.mock("@/source-scripts", () => ({
  ...api,
  DEFAULT_SEARCH_PAGE_MAX: 50,
  getSourceRegistry: vi.fn(async () => null),
  resolvePlayUrl: vi.fn(async () => ""),
  resolvePlayUrlDetailed: vi.fn(async () => ({ url: "", reason: "" })),
}));

vi.mock("@/lib/search-history", () => ({
  getSearchHistory: vi.fn(async () => []),
  addSearchHistory: vi.fn(async () => {}),
  removeSearchHistoryItem: vi.fn(async () => {}),
  clearSearchHistory: vi.fn(async () => {}),
}));
vi.mock("@/lib/aggregate-sources", () => ({
  readAggregateSources: vi.fn(async () => null),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));

import { SearchPage } from "@/components/SearchPage";
import { useMusicSourceStore } from "@/stores/musicSource";
import { useSourceRegistryStore } from "@/stores/sourceRegistry";

beforeEach(() => {
  vi.clearAllMocks();
  router.search = { q: "晴天", type: "song" };
  useMusicSourceStore.setState({ activeSourceId: "qq", aggregateMode: false });
  useSourceRegistryStore.setState({
    sources: [{ id: "qq", name: "qq音乐", short: "QQ", color: "#000000", searchPageMax: 30 }],
    qualities: [],
    ready: true,
  });
  api.searchMusic.mockImplementation(async () => tracks);
});

afterEach(() => {
  useSourceRegistryStore.setState({ sources: [], qualities: [], ready: false });
});

describe("搜索结果的播放全部", () => {
  it("点「播放全部」= 整批入队并从第一首开始播", async () => {
    const { getByText, getByTitle } = render(<SearchPage />);

    await waitFor(() => expect(getByText("晴天")).toBeTruthy());
    const button = getByTitle("把已加载的 3 首加入队列，从第一首开始播放");
    fireEvent.click(button);

    expect(player.playQueue).toHaveBeenCalledTimes(1);
    expect(player.playQueue).toHaveBeenCalledWith(tracks, 0);
  });

  it("没有结果时不出现「播放全部」", async () => {
    api.searchMusic.mockImplementation(async () => []);
    const { queryByText, queryByTitle } = render(<SearchPage />);

    await waitFor(() => expect(queryByText("没有找到相关内容")).toBeTruthy());
    expect(queryByTitle(/播放全部/)).toBeNull();
  });

  it("歌单 / 歌手 / 专辑页签不出现「播放全部」", async () => {
    api.searchPlaylists.mockImplementation(async () => [
      { id: "pl1", platform: "qq", name: "华语精选", picUrl: "", playCount: 10 },
    ]);
    router.search = { q: "晴天", type: "playlist" };
    const { queryByTitle } = render(<SearchPage />);

    await waitFor(() => expect(api.searchPlaylists).toHaveBeenCalled());
    expect(queryByTitle(/播放全部/)).toBeNull();
  });
});
