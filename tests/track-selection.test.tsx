// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Track } from "@/types";

const mocks = vi.hoisted(() => ({
  play: vi.fn(async () => undefined),
  playQueue: vi.fn(async () => undefined),
  navigate: vi.fn(),
  startDownload: vi.fn(async (_track: Track, _quality: string) => undefined),
  getDownloadQuality: vi.fn(async () => "320k"),
  listMyPlaylists: vi.fn(async () => [{ pid: "p1", name: "回归歌单", platform: "local", trackCount: 0 }]),
  getPlaylistTracks: vi.fn(async (): Promise<Track[]> => []),
  addTracksToPlaylist: vi.fn(async (_pid: string, tracks: Track[]) => tracks.length),
  removeTracksFromPlaylist: vi.fn(async () => undefined),
  getPlaylistDetail: vi.fn(),
  getCharts: vi.fn(async () => [{ id: "chart", platform: "qq", name: "回归榜单", picUrl: "" }]),
  getChartDetail: vi.fn(),
  getArtistSongs: vi.fn(),
  artistRoute: { platform: "qq", id: "artist", name: "回归歌手", artistId: "artist-id" },
  getLocalTracks: vi.fn(async (): Promise<Track[]> => []),
  deleteLocalTracks: vi.fn(async (_paths: string[], _deleteFile: boolean) => undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useRouter: () => ({ history: { back: vi.fn() } }),
  useParams: () => ({ platform: mocks.artistRoute.platform, id: mocks.artistRoute.id }),
  useSearch: () => ({ name: mocks.artistRoute.name, id: mocks.artistRoute.artistId }),
}));
vi.mock("@/services/ipc", () => ({
  LOCAL_PLATFORM: "local",
  startDownload: mocks.startDownload,
  getDownloadQuality: mocks.getDownloadQuality,
  listMyPlaylists: mocks.listMyPlaylists,
  getPlaylistTracks: mocks.getPlaylistTracks,
  addTracksToPlaylist: mocks.addTracksToPlaylist,
  removeTracksFromPlaylist: mocks.removeTracksFromPlaylist,
  checkFavoriteFlags: vi.fn(async (tracks: Track[]) => tracks.map(() => false)),
  checkDisliked: vi.fn(async (tracks: Track[]) => tracks.map(() => false)),
  isPlaylistFavorited: vi.fn(async () => false),
  getLocalCover: vi.fn(async () => null),
  getLocalTracks: mocks.getLocalTracks,
  getScanDirs: vi.fn(async () => []),
  getMissingLocalTracks: vi.fn(async () => []),
  getLocalTrackFiles: vi.fn(async () => []),
  getScanMinDuration: vi.fn(async () => 60),
  getScanMinSize: vi.fn(async () => 1048576),
  deleteLocalTracks: mocks.deleteLocalTracks,
  LIBRARY_SCAN_PROGRESS_EVENT: "library-scan-progress",
}));
vi.mock("@/source-scripts", () => ({
  getPlaylistDetail: mocks.getPlaylistDetail,
  getCharts: mocks.getCharts,
  getChartDetail: mocks.getChartDetail,
  getArtistSongs: mocks.getArtistSongs,
  DEFAULT_SEARCH_PAGE_MAX: 50,
}));

import { TrackList } from "@/components/discovery/TrackList";
import { BatchBar } from "@/components/discovery/BatchBar";
import { PlaylistDetailPage } from "@/components/discovery/PlaylistDetailPage";
import { LibraryPage } from "@/components/library/LibraryPage";
import { ArtistPage } from "@/components/discovery/ArtistPage";
import { clearPagedAllJobs } from "@/lib/paged-all";
import { filterTracks, retainTrackSelection, trackSelectionKey } from "@/lib/track-selection";
import { usePlayerStore } from "@/stores/player";

function track(id: string, title = `曲目${id}`, platform: Track["platform"] = "qq"): Track {
  return { id, title, platform, singer: "Singer", album: "Album", picUrl: "", duration: 180, musicId: null };
}
const songs = [track("same", "Alpha"), track("same", "Beta", "wyy"), track("3", "Gamma"), track("4", "Delta")];
function SelectionHarness({ tracks = songs, local = false }: { tracks?: Track[]; local?: boolean }) {
  const [ids, setIds] = useState(new Set<string>());
  return <>
    <output data-testid="keys">{[...ids].join(",")}</output>
    <TrackList tracks={tracks} selection={{ ids, onToggle: () => {}, onChange: setIds, keyOf: local ? (t) => t.id : undefined }} />
  </>;
}
function row(title: string): HTMLElement {
  return screen.getByText(title).closest<HTMLElement>("[data-track-row='true']")!;
}
function keys(): string { return screen.getByTestId("keys").textContent ?? ""; }

beforeEach(() => {
  vi.clearAllMocks();
  usePlayerStore.setState({ play: mocks.play, playQueue: mocks.playQueue });
  mocks.getPlaylistDetail.mockResolvedValue({ name: "回归歌单", picUrl: "", playCount: "", tracks: songs });
  mocks.getChartDetail.mockResolvedValue(songs);
  mocks.getArtistSongs.mockReset().mockResolvedValue({ songs, picUrl: "", hasMore: false });
  mocks.artistRoute = { platform: "qq", id: "artist", name: "回归歌手", artistId: "artist-id" };
  mocks.getPlaylistTracks.mockResolvedValue([]);
  mocks.getLocalTracks.mockResolvedValue([
    track("F:/alpha.mp3", "本地Alpha", "local"),
    track("F:/beta.mp3", "本地Beta", "local"),
    track("F:/gamma.mp3", "本地Gamma", "local"),
  ]);
});

afterEach(() => {
  clearPagedAllJobs();
});

describe("曲目多选交互", () => {
  it("普通点击播放，Ctrl/Meta 切换只选对应平台，Shift 按可见顺序替换范围", () => {
    render(<SelectionHarness />);
    fireEvent.click(row("Alpha"));
    expect(mocks.play).toHaveBeenCalledWith(songs[0]);
    mocks.play.mockClear();
    fireEvent.click(row("Alpha"), { ctrlKey: true });
    expect(keys()).toBe("qq:same");
    fireEvent.click(row("Gamma"), { shiftKey: true });
    expect(keys()).toBe("qq:same,wyy:same,qq:3");
    fireEvent.click(row("Beta"), { metaKey: true });
    expect(keys()).toBe("qq:same,qq:3");
    fireEvent.click(row("Delta"), { shiftKey: true });
    expect(keys()).toBe("wyy:same,qq:3,qq:4");
    expect(mocks.play).not.toHaveBeenCalled();
  });

  it("复选框 Shift 范围、本地 keyOf 裸路径兼容且不会触发行播放", () => {
    render(<SelectionHarness tracks={[track("F:/a.mp3", "本地A", "local"), track("F:/b.mp3", "本地B", "local")]} local />);
    fireEvent.click(screen.getByLabelText("选择 本地A"));
    fireEvent.click(screen.getByLabelText("选择 本地B"), { shiftKey: true });
    expect(keys()).toBe("F:/a.mp3,F:/b.mp3");
    expect((screen.getByLabelText("选择 本地A") as HTMLInputElement).checked).toBe(true);
    expect(mocks.play).not.toHaveBeenCalled();
  });

  it("键盘 Shift 方向 / Ctrl+A / Escape 可选可清，子按钮 Enter 不会误播放", () => {
    render(<SelectionHarness />);
    row("Alpha").focus();
    fireEvent.keyDown(row("Alpha"), { key: "ArrowDown", shiftKey: true });
    expect(document.activeElement).toBe(row("Beta"));
    expect(keys()).toBe("qq:same,wyy:same");
    fireEvent.keyDown(row("Beta"), { key: "ArrowDown", shiftKey: true });
    expect(keys()).toBe("qq:same,wyy:same,qq:3");
    fireEvent.keyDown(row("Gamma"), { key: "a", ctrlKey: true });
    expect(keys()).toBe("qq:same,wyy:same,qq:3,qq:4");
    fireEvent.keyDown(row("Gamma"), { key: "Escape" });
    expect(keys()).toBe("");
    fireEvent.keyDown(row("Gamma").querySelector("button")!, { key: "Enter" });
    expect(mocks.play).not.toHaveBeenCalled();
    fireEvent.keyDown(row("Gamma"), { key: "Enter" });
    expect(mocks.play).toHaveBeenCalledWith(songs[2]);
  });

  it("锚点被过滤后从当前项重新选择，批量只保留可见键", () => {
    const view = render(<SelectionHarness />);
    fireEvent.click(row("Alpha"), { ctrlKey: true });
    view.rerender(<SelectionHarness tracks={[songs[1], songs[3]]} />);
    fireEvent.click(row("Delta"), { shiftKey: true });
    expect(keys()).toBe("qq:4");
    expect([...retainTrackSelection([songs[3]], new Set(["qq:same", "qq:4"]))]).toEqual(["qq:4"]);
  });
});

describe("批量管理边界", () => {
  it("半选用原生 indeterminate，全选和下载只操作当前传入的可见歌曲", async () => {
    const change = vi.fn();
    render(<BatchBar tracks={[songs[0], songs[2]]} selected={new Set(["qq:same", "wyy:same"])} selectionKey={trackSelectionKey} onSelectedChange={change} />);
    const all = screen.getByLabelText("全选") as HTMLInputElement;
    expect(all.indeterminate).toBe(true);
    expect(all.getAttribute("aria-checked")).toBe("mixed");
    fireEvent.click(all);
    expect(change).toHaveBeenCalledWith(new Set(["qq:same", "qq:3"]));
    fireEvent.click(screen.getByLabelText("批量下载（1）"));
    await waitFor(() => expect(mocks.startDownload).toHaveBeenCalledTimes(1));
    expect(mocks.startDownload.mock.calls[0][0]).toEqual(songs[0]);
  });

  it("查重等待期间改变筛选会取消旧批次，旧请求不能恢复确认或收藏隐藏歌曲", async () => {
    let resolveOld!: (tracks: Track[]) => void;
    const visible = [songs[0]];
    const ids = new Set([trackSelectionKey(songs[0])]);
    const view = render(<BatchBar tracks={visible} selected={ids} selectionKey={trackSelectionKey} onSelectedChange={() => {}} />);
    fireEvent.click(screen.getByLabelText("批量收藏（1）"));
    await waitFor(() => expect(screen.getByText("回归歌单")).toBeTruthy());
    mocks.getPlaylistTracks.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    fireEvent.click(screen.getByText("回归歌单"));
    await waitFor(() => expect(resolveOld).toBeTypeOf("function"));
    view.rerender(<BatchBar tracks={[songs[1]]} selected={new Set([trackSelectionKey(songs[1])])} selectionKey={trackSelectionKey} onSelectedChange={() => {}} />);
    await act(async () => { resolveOld([]); });
    expect(mocks.addTracksToPlaylist).not.toHaveBeenCalled();
    expect(screen.queryByText("继续收藏")).toBeNull();
  });
});

describe("本地曲库检索的批量删除范围", () => {
  it("全选后搜索会裁剪隐藏路径，删除 IPC 仅收到当前可见选中项", async () => {
    render(<LibraryPage />);
    await screen.findByText("本地Alpha");
    fireEvent.click(screen.getByLabelText("全选"));
    expect(screen.getByText("已选 3 首")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("搜索本地歌曲"), { target: { value: "beta" } });
    expect(screen.queryByText("本地Alpha")).toBeNull();
    expect(screen.getByText("已选 1 首")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("批量删除（1）"));
    fireEvent.click(screen.getByText("仅删除记录（保留文件）"));
    await waitFor(() => expect(mocks.deleteLocalTracks).toHaveBeenCalledWith(["F:/beta.mp3"], false));
  });

  it("清空检索不恢复隐藏选择，半选与无结果计数匹配可见范围", async () => {
    render(<LibraryPage />);
    await screen.findByText("本地Alpha");
    fireEvent.click(screen.getByLabelText("全选"));
    const search = screen.getByLabelText("搜索本地歌曲");
    fireEvent.change(search, { target: { value: "alpha" } });
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByText("已选 1 首")).toBeTruthy();
    expect((screen.getByLabelText("选择 本地Alpha") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("选择 本地Beta") as HTMLInputElement).checked).toBe(false);
    const all = screen.getByLabelText("全选") as HTMLInputElement;
    expect(all.indeterminate).toBe(true);
    expect(all.getAttribute("aria-checked")).toBe("mixed");
    fireEvent.change(search, { target: { value: "no-match" } });
    expect(screen.getByText("没有匹配的歌曲")).toBeTruthy();
    expect((screen.getByLabelText("批量删除") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("全选") as HTMLInputElement).indeterminate).toBe(false);
    fireEvent.change(search, { target: { value: "" } });
    expect((screen.getByLabelText("选择 本地Alpha") as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByText(/已选 \d+ 首/)).toBeNull();
  });
});

describe("歌手歌曲内检索", () => {
  it("筛选联动播放和批量下载，清空不会恢复隐藏选择，输入不会重新请求", async () => {
    render(<ArtistPage />);
    await screen.findByText("Alpha");
    const input = screen.getByRole("searchbox", { name: "歌手歌曲内搜索" });
    fireEvent.click(screen.getByLabelText("全选"));
    fireEvent.change(input, { target: { value: " bETA sINGER alBUM " } });
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.getByText("显示 1 / 4 首")).toBeTruthy();
    expect(screen.getByText("已选 1 首")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("播放全部"));
    expect(mocks.playQueue).toHaveBeenCalledWith([songs[1]], 0);
    fireEvent.click(screen.getByLabelText("批量下载（1）"));
    await waitFor(() => expect(mocks.startDownload).toHaveBeenCalledTimes(1));
    expect(mocks.startDownload.mock.calls[0][0]).toEqual(songs[1]);
    fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe("");
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect((screen.getByLabelText("选择 Alpha") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("选择 Beta") as HTMLInputElement).checked).toBe(true);
    fireEvent.change(input, { target: { value: "no-match" } });
    expect(screen.getByText(/没有匹配的歌曲/)).toBeTruthy();
    expect((screen.getByLabelText("播放全部") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("批量下载") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    expect(screen.getByText("已选 0 首")).toBeTruthy();
    expect(screen.getByText("共 4 首歌")).toBeTruthy();
    expect(mocks.getArtistSongs).toHaveBeenCalledTimes(1);
  });

  it("后台追加页继续按当前关键词筛选，计数与播放范围同步更新", async () => {
    let finish!: (value: { songs: Track[]; picUrl: string; hasMore: boolean }) => void;
    mocks.getArtistSongs
      .mockResolvedValueOnce({ songs: [songs[0]], picUrl: "", hasMore: true })
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<ArtistPage />);
    await screen.findByText("Alpha");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "beta" } });
    expect(screen.getByText(/显示 0 \/ 1 首/)).toBeTruthy();
    expect(screen.getByRole("progressbar")).toBeTruthy();
    await act(async () => { finish({ songs: [songs[1]], picUrl: "", hasMore: false }); });
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.getByText("显示 1 / 2 首")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    fireEvent.click(screen.getByLabelText("全选"));
    fireEvent.click(screen.getByLabelText("播放全部"));
    expect(screen.getByText("已选 1 首")).toBeTruthy();
    expect(mocks.playQueue).toHaveBeenCalledWith([songs[1]], 0);
    expect(mocks.getArtistSongs).toHaveBeenCalledTimes(2);
  });

  it("切换歌手复位搜索和选择，上一位歌手的迟到响应不污染新页面", async () => {
    const view = render(<ArtistPage />);
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByLabelText("全选"));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "alpha" } });
    let finish!: (value: { songs: Track[]; picUrl: string; hasMore: boolean }) => void;
    mocks.getArtistSongs.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    mocks.artistRoute = { platform: "qq", id: "slow", name: "慢歌手", artistId: "slow" };
    view.rerender(<ArtistPage />);
    expect(screen.queryByText("Alpha")).toBeNull();
    mocks.artistRoute = { platform: "wyy", id: "final", name: "新歌手", artistId: "final" };
    view.rerender(<ArtistPage />);
    await screen.findByText("Beta");
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
    expect(screen.getByText("已选 0 首")).toBeTruthy();
    await act(async () => { finish({ songs: [track("old", "旧歌曲")], picUrl: "", hasMore: false }); });
    expect(screen.queryByText("旧歌曲")).toBeNull();
    expect(screen.getByText("Beta")).toBeTruthy();
  });
});

describe("歌单与榜单内检索", () => {
  it("标题/歌手/专辑大小写与多关键字检索保持原始顺序", () => {
    expect(filterTracks(songs, " album SINGER ")).toEqual(songs);
    expect(filterTracks(songs, "aLPHa singer")).toEqual([songs[0]]);
  });

  it.each(["playlist", "chart"] as const)("%s 筛选影响播放全部、全选和批量下载；无结果有空态，清空不恢复隐藏选择", async (kind) => {
    render(<PlaylistDetailPage platform="qq" id={kind} kind={kind} />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeTruthy());
    const input = screen.getByRole("searchbox");
    fireEvent.click(screen.getByLabelText("全选"));
    fireEvent.change(input, { target: { value: "beta" } });
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.getByText("已选 1 首")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("播放全部"));
    expect(mocks.playQueue).toHaveBeenCalledWith([songs[1]], 0);
    fireEvent.click(screen.getByLabelText("批量下载（1）"));
    await waitFor(() => expect(mocks.startDownload).toHaveBeenCalledTimes(1));
    expect(mocks.startDownload.mock.calls[0][0]).toEqual(songs[1]);
    fireEvent.change(input, { target: { value: "no-match" } });
    expect(screen.getByText(/没有匹配的歌曲/)).toBeTruthy();
    expect((screen.getByLabelText("播放全部") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("清空搜索"));
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("已选 0 首")).toBeTruthy();
  });

  it("路由身份变化时立即复位检索/选择，旧异步响应不会污染新页", async () => {
    const view = render(<PlaylistDetailPage platform="qq" id="first" />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("全选"));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "alpha" } });
    let finish!: (value: unknown) => void;
    mocks.getPlaylistDetail.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    view.rerender(<PlaylistDetailPage platform="qq" id="slow" />);
    expect(screen.queryByText("Alpha")).toBeNull();
    view.rerender(<PlaylistDetailPage platform="qq" id="final" />);
    await waitFor(() => expect(screen.getByText("Beta")).toBeTruthy());
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
    expect(screen.getByText("已选 0 首")).toBeTruthy();
    await act(async () => { finish({ name: "旧响应", tracks: [track("old", "旧歌曲")] }); });
    expect(screen.queryByText("旧歌曲")).toBeNull();
    expect(screen.getByText("Beta")).toBeTruthy();
  });
});
