// @vitest-environment jsdom
/**
 * 搜索页「页签切换」回归：URL 是页签的唯一真源，改 URL 必须重算列表。
 *
 * 用户报（反复）：点「歌曲 / 歌单 / 歌手 / 专辑」页签，URL 已经变成新的
 * `?type=`，但结果列表不换 —— 还是上一个页签的数据，或者停在旧页。
 *
 * 和 tests/search-page-pagination.test.tsx 的区别（这是**故意**的）：
 * 那个文件把 `@tanstack/react-router` 整个 mock 掉了，`useSearch()` 返回一个
 * 测试里随便改的对象，navigate 也只是个 spy —— 于是「URL 变了之后组件会不会
 * 真的重算」这条链路根本没被测到（那里只断言了 navigate 被调用）。
 * 本文件用**真的** memory-history 路由 + `RouterProvider`：点页签走真实的
 * navigate → 真实的路由状态 → 真实的 `useSearch` 重渲染，能测出「URL 变了但
 * 列表没重算」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";

/**
 * jsdom 没有 IntersectionObserver：stub 出可控实例，手动 trigger 模拟「滚到底」。
 * 翻到第 2 页后再切页签是用户报的「停在旧页」最可能的复现路径，必须能测。
 */
class FakeIO {
  static instances: FakeIO[] = [];
  private cb: (entries: IntersectionObserverEntry[]) => void;
  private target: Element | null = null;
  constructor(cb: (entries: IntersectionObserverEntry[]) => void) {
    this.cb = cb;
    FakeIO.instances.push(this);
  }
  observe(el: Element): void {
    this.target = el;
  }
  disconnect(): void {
    FakeIO.instances = FakeIO.instances.filter((i) => i !== this);
  }
  unobserve(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  /** 模拟哨兵进入视口（提前一屏触发） */
  trigger(): void {
    if (!this.target) return;
    this.cb([{ isIntersecting: true, target: this.target } as IntersectionObserverEntry]);
  }
}
globalThis.IntersectionObserver = FakeIO as unknown as typeof IntersectionObserver;

/** 让当前挂上的哨兵实例「滚到底」一次 */
async function scrollToBottom(): Promise<void> {
  await act(async () => {
    for (const io of [...FakeIO.instances]) io.trigger();
    await new Promise((r) => setTimeout(r, 20));
  });
}

/** 音源包调用面：只 mock SearchPage 会碰到的动作 */
const api = vi.hoisted(() => ({
  searchMusic: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  searchPlaylists: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  searchArtists: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  searchAlbums: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  searchAllBatches: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  searchMergedPage: vi.fn(async (..._args: unknown[]) => ({
    tracks: [] as unknown[],
    full: false,
  })),
  getAllHotWords: vi.fn(async () => [] as string[]),
}));
vi.mock("@/source-scripts", () => ({
  ...api,
  // 注册表未拉到时 useSearchPageMax 的兜底值，真实导出必须存在
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
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
  emitTo: vi.fn(async () => {}),
}));

import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type AnyRouter,
} from "@tanstack/react-router";
import { SearchPage } from "@/components/SearchPage";
import { parseSearchType, type SearchType } from "@/lib/search-params";
import { useMusicSourceStore } from "@/stores/musicSource";
import { useSourceRegistryStore } from "@/stores/sourceRegistry";
import type { Album, Artist, Playlist, Track } from "@/types";

/**
 * 起一个**真**路由：结构与 src/lib/router.tsx 的 searchRoute 一致
 * （path /search + 同一份 validateSearch + SearchPage 组件），history 用 memory。
 */
function makeRouter(initialEntry: string): AnyRouter {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const searchRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/search",
    validateSearch: (search: Record<string, unknown>): { q: string; type: SearchType } => ({
      q: typeof search.q === "string" ? search.q : "",
      type: parseSearchType(search.type),
    }),
    component: SearchPage,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([searchRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
}

function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 40));
}

/** 手动控制的 promise：用来把「旧页签的请求」卡在飞行中 */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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

function playlistOf(id: string): Playlist {
  return {
    id,
    platform: "qq",
    name: `歌单${id}`,
    picUrl: "",
    playCount: "",
    description: null,
  };
}

function artistOf(id: string): Artist {
  return { id, platform: "qq", name: `歌手${id}`, picUrl: "" };
}

function albumOf(id: string): Album {
  return { id, platform: "qq", name: `专辑${id}`, artist: "歌手", picUrl: "" };
}

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

beforeEach(() => {
  vi.clearAllMocks();
  FakeIO.instances = [];
  // jsdom 没实现滚动：路由的 scrollRestoration 会调它，不打桩就是满屏 stderr 噪声
  window.scrollTo = (() => {}) as typeof window.scrollTo;
  useMusicSourceStore.setState({ activeSourceId: "qq", aggregateMode: false });
  seedRegistry([{ id: "qq", searchPageMax: 2 }]);
});

afterEach(() => {
  useSourceRegistryStore.setState({ sources: [], qualities: [], ready: false });
});

describe("搜索页页签切换（URL 驱动的真实路由）", () => {
  it("点页签改 URL 后按新页签重新请求，并把列表换成新页签的结果", async () => {
    api.searchMusic.mockResolvedValue([track("s1"), track("s2")]);
    api.searchPlaylists.mockResolvedValue([playlistOf("p1"), playlistOf("p2")]);

    const router = makeRouter("/search?q=稻香&type=song");
    const { container, getByText } = render(<RouterProvider router={router} />);
    await act(settle);

    // 歌曲页签：只有 searchMusic 被调用
    expect(api.searchMusic).toHaveBeenCalledWith("稻香", "qq", 1, 2);
    expect(container.textContent).toContain("曲目s1");
    expect(router.state.location.search).toEqual({ q: "稻香", type: "song" });

    fireEvent.click(getByText("歌单"));
    await act(settle);

    // URL 变了
    expect(router.state.location.search).toEqual({ q: "稻香", type: "playlist" });
    // 列表也必须按新页签重算：打歌单动作、渲染歌单卡片、旧歌曲结果消失
    expect(api.searchPlaylists).toHaveBeenCalledWith("qq", "稻香", 1, 2);
    expect(container.textContent).toContain("歌单p1");
    expect(container.textContent).not.toContain("曲目s1");
  });

  it("连续切换多个页签，每次都以最新页签为准（不留上一个页签的结果）", async () => {
    api.searchMusic.mockResolvedValue([track("s1")]);
    api.searchPlaylists.mockResolvedValue([playlistOf("p1")]);
    api.searchArtists.mockResolvedValue([artistOf("a1")]);
    api.searchAlbums.mockResolvedValue([albumOf("b1")]);

    const router = makeRouter("/search?q=稻香&type=song");
    const { container, getByRole } = render(<RouterProvider router={router} />);
    await act(settle);

    // 用 role 而不是文本：「歌手」既是页签名，也是 TrackRow 里的歌手列文本
    fireEvent.click(getByRole("button", { name: "歌手" }));
    await act(settle);
    expect(router.state.location.search).toEqual({ q: "稻香", type: "artist" });
    expect(api.searchArtists).toHaveBeenCalledWith("qq", "稻香", 1, 2);
    expect(container.textContent).toContain("歌手a1");
    expect(container.textContent).not.toContain("曲目s1");

    fireEvent.click(getByRole("button", { name: "专辑" }));
    await act(settle);
    expect(router.state.location.search).toEqual({ q: "稻香", type: "album" });
    expect(api.searchAlbums).toHaveBeenCalledWith("qq", "稻香", 1, 2);
    expect(container.textContent).toContain("专辑b1");
    expect(container.textContent).not.toContain("歌手a1");
  });

  it("旧页签的请求还在飞时切页签：迟到的旧结果不得覆盖新页签列表", async () => {
    // 歌曲请求卡住不返回，切到歌单后才放行 —— 复现「URL 变了但列表停在旧数据」
    const songs = deferred<Track[]>();
    api.searchMusic.mockReturnValue(songs.promise);
    api.searchPlaylists.mockResolvedValue([playlistOf("p1")]);

    const router = makeRouter("/search?q=稻香&type=song");
    const { container, getByText } = render(<RouterProvider router={router} />);
    await act(settle);
    expect(api.searchMusic).toHaveBeenCalledTimes(1);

    fireEvent.click(getByText("歌单"));
    await act(settle);
    expect(api.searchPlaylists).toHaveBeenCalledWith("qq", "稻香", 1, 2);
    expect(container.textContent).toContain("歌单p1");

    // 迟到的歌曲应答：必须被丢弃（旧代际的请求不能写进新页签的列表）
    await act(async () => {
      songs.resolve([track("s1"), track("s2")]);
      await settle();
    });

    expect(container.textContent).toContain("歌单p1");
    expect(container.textContent).not.toContain("曲目s1");
  });

  it("带 ?type=playlist 直接从 URL 落地就渲染歌单（从详情页返回的场景）", async () => {
    api.searchMusic.mockResolvedValue([track("s1")]);
    api.searchPlaylists.mockResolvedValue([playlistOf("p1")]);

    const router = makeRouter("/search?q=稻香&type=playlist");
    const { container } = render(<RouterProvider router={router} />);
    await act(settle);

    expect(api.searchPlaylists).toHaveBeenCalledWith("qq", "稻香", 1, 2);
    expect(api.searchMusic).not.toHaveBeenCalled();
    expect(container.textContent).toContain("歌单p1");
  });

  it("翻到第 2 页后再切页签：新页签必须从第 1 页重拉，不残留旧页签的旧页", async () => {
    // 歌曲第 1 页满页（2 条 = searchPageMax）→ hasMore，滚到底拉第 2 页
    api.searchMusic.mockImplementation(async (...args: unknown[]) => {
      const page = args[2] as number;
      return page === 1 ? [track("s1"), track("s2")] : [track("s3")];
    });
    api.searchPlaylists.mockResolvedValue([playlistOf("p1")]);

    const router = makeRouter("/search?q=稻香&type=song");
    const { container, getByRole } = render(<RouterProvider router={router} />);
    await act(settle);
    expect(container.textContent).toContain("曲目s1");

    await scrollToBottom();
    expect(api.searchMusic).toHaveBeenCalledWith("稻香", "qq", 2, 2);
    expect(container.textContent).toContain("曲目s3");

    fireEvent.click(getByRole("button", { name: "歌单" }));
    await act(settle);

    // 新页签只许拉第 1 页：把旧页码（2）带过去就会「停在旧页」
    expect(api.searchPlaylists).toHaveBeenCalledTimes(1);
    expect(api.searchPlaylists).toHaveBeenCalledWith("qq", "稻香", 1, 2);
    expect(container.textContent).toContain("歌单p1");
    expect(container.textContent).not.toContain("曲目s1");
    expect(container.textContent).not.toContain("曲目s3");
  });

  it("聚合模式下从歌曲切到歌单：走歌单动作而不是聚合合并，列表跟着换", async () => {
    useMusicSourceStore.setState({ activeSourceId: "qq", aggregateMode: true });
    api.searchMergedPage.mockResolvedValue({ tracks: [track("s1")], full: false });
    api.searchPlaylists.mockResolvedValue([playlistOf("p1")]);

    const router = makeRouter("/search?q=稻香&type=song");
    const { container, getByRole } = render(<RouterProvider router={router} />);
    await act(settle);
    expect(api.searchMergedPage).toHaveBeenCalled();
    expect(container.textContent).toContain("曲目s1");

    fireEvent.click(getByRole("button", { name: "歌单" }));
    await act(settle);

    expect(router.state.location.search).toEqual({ q: "稻香", type: "playlist" });
    expect(api.searchPlaylists).toHaveBeenCalledWith("qq", "稻香", 1, 2);
    expect(container.textContent).toContain("歌单p1");
    expect(container.textContent).not.toContain("曲目s1");
  });

  it("快速连点两个页签：以最后一次点击为准（URL 与列表不得分叉）", async () => {
    api.searchMusic.mockResolvedValue([track("s1")]);
    api.searchPlaylists.mockResolvedValue([playlistOf("p1")]);
    api.searchArtists.mockResolvedValue([artistOf("a1")]);

    const router = makeRouter("/search?q=稻香&type=song");
    const { container, getByRole } = render(<RouterProvider router={router} />);
    await act(settle);

    fireEvent.click(getByRole("button", { name: "歌单" }));
    fireEvent.click(getByRole("button", { name: "歌手" }));
    await act(settle);

    expect(router.state.location.search).toEqual({ q: "稻香", type: "artist" });
    expect(container.textContent).toContain("歌手a1");
    expect(container.textContent).not.toContain("歌单p1");
  });
});
