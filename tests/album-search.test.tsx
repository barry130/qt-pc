// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SourceId, Track } from "@/types";

const mocks = vi.hoisted(() => ({
  route: { platform: "qq", id: "Album" } as { platform: SourceId; id: string },
  searchMusic: vi.fn(),
  getAlbumDetail: vi.fn(),
  playQueue: vi.fn(async () => undefined),
  startDownload: vi.fn(async (_track: Track, _quality: string) => undefined),
  addTracksToPlaylist: vi.fn(async (_pid: string, tracks: Track[]) => tracks.length),
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => mocks.route,
  useNavigate: () => vi.fn(),
  useRouter: () => ({ history: { back: vi.fn() } }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock("@/source-scripts", () => ({
  searchMusic: mocks.searchMusic,
  getAlbumDetail: mocks.getAlbumDetail,
  DEFAULT_SEARCH_PAGE_MAX: 50,
}));
vi.mock("@/services/ipc", () => ({
  LOCAL_PLATFORM: "local",
  checkFavoriteFlags: vi.fn(async (tracks: Track[]) => tracks.map(() => false)),
  checkDisliked: vi.fn(async (tracks: Track[]) => tracks.map(() => false)),
  getDownloadQuality: vi.fn(async () => "320k"),
  startDownload: mocks.startDownload,
  listMyPlaylists: vi.fn(async () => [{ pid: "p1", name: "收藏目标", platform: "local", trackCount: 0 }]),
  getPlaylistTracks: vi.fn(async () => []),
  addTracksToPlaylist: mocks.addTracksToPlaylist,
}));

import { AlbumPage } from "@/components/discovery/AlbumPage";
import { clearPagedAllJobs } from "@/lib/paged-all";
import { usePlayerStore } from "@/stores/player";
import { useSourceRegistryStore } from "@/stores/sourceRegistry";

function track(id: string, title: string, album = "Album", singer = "Singer", platform: SourceId = "qq"): Track {
  return { id, title, album, singer, platform, picUrl: "", duration: 180, musicId: null };
}
const songs = [track("a", "Alpha"), track("b", "Beta", "Album (Deluxe)"), track("c", "Gamma")];

function seedPageSize(size: number): void {
  useSourceRegistryStore.setState({
    sources: ["qq", "wyy", "kw"].map((id) => ({ id, name: id, short: id, color: "#000", searchPageMax: size })),
    qualities: [],
    ready: true,
  });
}
function search(): HTMLInputElement {
  return screen.getByRole("searchbox", { name: "专辑内搜索" });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.searchMusic.mockReset().mockResolvedValue(songs);
  mocks.getAlbumDetail.mockReset().mockRejectedValue(new Error("no album api"));
  mocks.route = { platform: "qq", id: "Album" };
  usePlayerStore.setState({ playQueue: mocks.playQueue });
  seedPageSize(10);
  // all 模式的任务按 cacheKey 缓存在模块上（卸载也继续跑）：不清就会拿上一条用例的全量
  clearPagedAllJobs();
});
afterEach(() => {
  useSourceRegistryStore.setState({ sources: [], qualities: [], ready: false });
});

describe("专辑内搜索", () => {
  it("标题、歌手、专辑的多词筛选同步限定播放、全选、批量收藏与下载，不发搜索请求", async () => {
    render(<AlbumPage />);
    await screen.findByText("Alpha");
    fireEvent.change(search(), { target: { value: " bETA sINGER dELUXE " } });
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.queryByText("Gamma")).toBeNull();
    expect(screen.getByText("显示 1 / 3 首")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("播放全部"));
    expect(mocks.playQueue).toHaveBeenCalledWith([songs[1]], 0);
    fireEvent.click(screen.getByLabelText("全选"));
    expect(screen.getByText("已选 1 首")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("批量下载（1）"));
    await waitFor(() => expect(mocks.startDownload).toHaveBeenCalledTimes(1));
    expect(mocks.startDownload.mock.calls[0][0]).toEqual(songs[1]);
    fireEvent.click(screen.getByLabelText("批量收藏（1）"));
    fireEvent.click(await screen.findByText("收藏目标"));
    await waitFor(() => expect(mocks.addTracksToPlaylist).toHaveBeenCalledWith("p1", [songs[1]]));
    expect(mocks.searchMusic).toHaveBeenCalledTimes(1);
  });

  it("筛选裁剪隐藏选择，Esc 和清空按钮不恢复旧选择，无结果时禁用操作", async () => {
    render(<AlbumPage />);
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByLabelText("全选"));
    fireEvent.change(search(), { target: { value: "beta" } });
    expect(screen.getByText("已选 1 首")).toBeTruthy();
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(search().value).toBe("");
    expect((screen.getByLabelText("选择 Alpha") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("选择 Beta") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("全选") as HTMLInputElement).indeterminate).toBe(true);
    fireEvent.change(search(), { target: { value: "no-match" } });
    expect(screen.getByText(/没有匹配的歌曲/)).toBeTruthy();
    expect(screen.getByText("显示 0 / 3 首")).toBeTruthy();
    for (const label of ["播放全部", "全选", "批量下载", "批量收藏"]) {
      expect((screen.getByLabelText(label) as HTMLButtonElement | HTMLInputElement).disabled).toBe(true);
    }
    fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    expect(search().value).toBe("");
    expect(screen.getByText("3 首歌曲")).toBeTruthy();
    expect(screen.getByText("已选 0 首")).toBeTruthy();
    expect((screen.getByLabelText("选择 Beta") as HTMLInputElement).checked).toBe(false);
  });

  it("无匹配时仍会跨过专辑过滤为空的满页继续取完，追加结果不会自动选中", async () => {
    seedPageSize(2);
    mocks.searchMusic.mockImplementation(async (_name: string, _source: SourceId, page: number) => {
      if (page === 1) return [songs[0], track("other-1", "无关一", "Other")];
      if (page === 2) return [track("other-2", "无关二", "Other"), track("other-3", "无关三", "Other")];
      return [songs[1]];
    });
    render(<AlbumPage />);
    await screen.findByText("Alpha");
    expect(mocks.searchMusic).toHaveBeenCalledWith("Album", "qq", 1, 2);
    // 一次性加载（用户 m05614）：第 2 页被专辑过滤裁成 0 条也要继续拉，
    // 第 3 页的 Beta 不需滚动就自动到手
    await screen.findByText("Beta");
    expect(mocks.searchMusic).toHaveBeenCalledWith("Album", "qq", 3, 2);
    // 自动追加进来的行不会被顺手勾选（勾选永远只来自用户动作）
    expect(screen.getByText("已选 0 首")).toBeTruthy();
    expect((screen.getByLabelText("选择 Beta") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByLabelText("全选"));
    fireEvent.change(search(), { target: { value: "beta" } });
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.getByText("显示 1 / 2 首")).toBeTruthy();
    // 被专辑内搜索隐藏的行同时退出批量范围
    expect(screen.getByText("已选 1 首")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("播放全部"));
    expect(mocks.playQueue).toHaveBeenCalledWith([songs[1]], 0);
    expect(screen.queryByText("已经到底了")).toBeNull();
  });

  it("首屏无同名专辑时沿用搜索回退，后续页不改成仅保留同名专辑", async () => {
    seedPageSize(2);
    const fallback = [track("x", "Fallback A", "Other"), track("y", "Fallback B", "Other")];
    mocks.searchMusic.mockResolvedValueOnce(fallback).mockResolvedValueOnce([songs[1]]);
    render(<AlbumPage />);
    await screen.findByText("Fallback A");
    // 后续页自动取完，回退列表与命中项并进同一条列表
    await screen.findByText("Beta");
    expect(screen.getByText("Fallback A")).toBeTruthy();
    expect(screen.getByText("3 首歌曲")).toBeTruthy();
  });

  it.each(["专辑", "音源"])("切换%s立即复位检索与选择，迟到响应不污染新页", async (kind) => {
    const view = render(<AlbumPage />);
    await screen.findByText("Alpha");
    fireEvent.change(search(), { target: { value: "alpha" } });
    fireEvent.click(screen.getByLabelText("全选"));
    let finish!: (value: Track[]) => void;
    mocks.searchMusic.mockImplementationOnce(() => new Promise<Track[]>((resolve) => { finish = resolve; }));
    mocks.route = kind === "专辑" ? { platform: "qq", id: "Slow" } : { platform: "wyy", id: "Album" };
    view.rerender(<AlbumPage />);
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
    const finalRoute: typeof mocks.route = kind === "专辑" ? { platform: "qq", id: "Final" } : { platform: "kw", id: "Album" };
    const fresh = track("a", "新曲目", finalRoute.id, "Singer", finalRoute.platform);
    mocks.searchMusic.mockResolvedValueOnce([fresh]);
    mocks.route = finalRoute;
    view.rerender(<AlbumPage />);
    await screen.findByText("新曲目");
    expect(search().value).toBe("");
    expect(screen.getByText("已选 0 首")).toBeTruthy();
    await act(async () => { finish([track("late", "迟到歌曲", "Slow")]); });
    expect(screen.queryByText("迟到歌曲")).toBeNull();
    expect(screen.getByText("新曲目")).toBeTruthy();
  });

  it("路由第二段是专辑 id 时走 albumDetail，不再按名字搜索", async () => {
    seedPageSize(2);
    mocks.route = { platform: "qq", id: "0025NhlN2yWrP4" };
    mocks.getAlbumDetail.mockResolvedValue({
      id: "0025NhlN2yWrP4",
      platform: "qq",
      name: "真专辑名",
      picUrl: "",
      playCount: "3",
      description: null,
      tracks: songs,
    });
    render(<AlbumPage />);
    await screen.findByText("Alpha");
    expect(mocks.getAlbumDetail).toHaveBeenCalledWith("qq", "0025NhlN2yWrP4");
    expect(mocks.searchMusic).not.toHaveBeenCalled();
    // 页头用上游真名，而不是那串 id
    expect(screen.getByRole("heading", { name: "真专辑名" })).toBeTruthy();
    // 全量已到手，本地切页；一次性加载把 3 首直接铺满，页头不留续页提示
    await screen.findByText("Gamma");
    expect(mocks.getAlbumDetail).toHaveBeenCalledTimes(1);
    expect(screen.getByText("3 首歌曲")).toBeTruthy();
    expect(screen.queryByText("已经到底了")).toBeNull();
  });

  it("专辑 id 取不到时静默退回名字搜索", async () => {
    mocks.route = { platform: "qq", id: "0025NhlN2yWrP4" };
    mocks.getAlbumDetail.mockRejectedValue(new Error("boom"));
    render(<AlbumPage />);
    await screen.findByText("Alpha");
    expect(mocks.getAlbumDetail).toHaveBeenCalledTimes(1);
    expect(mocks.searchMusic).toHaveBeenCalledWith("0025NhlN2yWrP4", "qq", 1, 10);
  });
});
