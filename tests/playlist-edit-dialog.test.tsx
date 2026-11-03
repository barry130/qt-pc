// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Track } from "@/types";

const mocks = vi.hoisted(() => ({
  play: vi.fn(async () => undefined),
  playQueue: vi.fn(async () => undefined),
  navigate: vi.fn(),
  listMyPlaylists: vi.fn(),
  getPlaylistTracks: vi.fn(),
  getPlaylistCover: vi.fn(),
  getSmartPlaylist: vi.fn(),
  getLocalCover: vi.fn(),
  checkFavoriteFlags: vi.fn(),
  checkDisliked: vi.fn(),
  pickImage: vi.fn(),
  setPlaylistCover: vi.fn(),
  clearPlaylistCover: vi.fn(),
  renamePlaylist: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useRouter: () => ({ history: { back: vi.fn() } }),
  useParams: () => ({ platform: "local", id: "pl1" }),
  useSearch: () => ({}),
}));
vi.mock("@/services/ipc", () => ({
  LOCAL_PLATFORM: "local",
  listMyPlaylists: mocks.listMyPlaylists,
  getPlaylistTracks: mocks.getPlaylistTracks,
  getPlaylistCover: mocks.getPlaylistCover,
  getSmartPlaylist: mocks.getSmartPlaylist,
  getLocalCover: mocks.getLocalCover,
  checkFavoriteFlags: mocks.checkFavoriteFlags,
  checkDisliked: mocks.checkDisliked,
  isPlaylistFavorited: vi.fn(async () => false),
  pickImage: mocks.pickImage,
  setPlaylistCover: mocks.setPlaylistCover,
  clearPlaylistCover: mocks.clearPlaylistCover,
  renamePlaylist: mocks.renamePlaylist,
  deletePlaylist: vi.fn(async () => undefined),
  saveSmartPlaylistAsStatic: vi.fn(),
  pickDirectory: vi.fn(async () => null),
  exportPlaylist: vi.fn(),
  addTracksToPlaylist: vi.fn(async () => 0),
  removeTracksFromPlaylist: vi.fn(async () => undefined),
  pickSavePath: vi.fn(async () => null),
  saveBinaryFile: vi.fn(async () => undefined),
  startDownload: vi.fn(async () => undefined),
  getDownloadQuality: vi.fn(async () => "320k"),
}));
vi.mock("@/source-scripts", () => ({
  getPlaylistDetail: vi.fn(),
  getCharts: vi.fn(async () => []),
  getChartDetail: vi.fn(async () => []),
  getArtistSongs: vi.fn(),
  DEFAULT_SEARCH_PAGE_MAX: 50,
}));

const SONG: Track = {
  id: "1",
  title: "越",
  platform: "local",
  singer: "孙楠",
  album: "",
  picUrl: "",
  duration: 259000,
};

const SUMMARY = {
  id: "pl1",
  pid: "pl1",
  name: "我的老歌单",
  platform: "local",
  picUrl: "",
  trackCount: 1,
  createdAt: 1,
  updatedAt: 1,
  isLocal: true,
  isSmart: false,
};

/** 打开编辑弹窗的公共前置：渲染本地歌单详情页并点「编辑歌单」 */
async function openEditDialog(): Promise<void> {
  const { PlaylistDetailPage } = await import("@/components/discovery/PlaylistDetailPage");
  render(<PlaylistDetailPage platform="local" id="pl1" />);
  await waitFor(() => expect(screen.getByText("我的老歌单")).toBeTruthy());
  fireEvent.click(screen.getByLabelText(/编辑歌单/));
  await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "编辑歌单" })).toBeTruthy());
}

describe("本地歌单编辑弹窗（改名 + 换封面）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listMyPlaylists.mockResolvedValue([SUMMARY]);
    mocks.getPlaylistTracks.mockResolvedValue([SONG]);
    mocks.getPlaylistCover.mockResolvedValue(null);
    mocks.getSmartPlaylist.mockResolvedValue(null);
    mocks.getLocalCover.mockResolvedValue(null);
    mocks.checkFavoriteFlags.mockImplementation(async (tracks: Track[]) => tracks.map(() => false));
    mocks.checkDisliked.mockImplementation(async (tracks: Track[]) => tracks.map(() => false));
  });

  afterEach(() => {
    cleanup();
  });

  it("改名保存：调 renamePlaylist，标题当场换新，弹窗关掉", async () => {
    await openEditDialog();
    const input = screen.getByLabelText("歌单名称");
    fireEvent.change(input, { target: { value: "新歌单名" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(mocks.renamePlaylist).toHaveBeenCalledWith("pl1", "新歌单名"),
    );
    // onSaved 先就地上屏标题，再静默重载（重载会再拉一次列表）
    await waitFor(() => expect(screen.getByText("新歌单名")).toBeTruthy());
    expect(screen.queryByRole("heading", { level: 2, name: "编辑歌单" })).toBeNull();
  });

  it("名字没动就保存：不调改名接口", async () => {
    await openEditDialog();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(screen.queryByRole("heading", { level: 2, name: "编辑歌单" })).toBeNull(),
    );
    expect(mocks.renamePlaylist).not.toHaveBeenCalled();
  });

  it("换封面即时生效：选图后马上 setPlaylistCover，不等保存", async () => {
    mocks.pickImage.mockResolvedValue("D:/pics/cover.png");
    mocks.setPlaylistCover.mockResolvedValue({ path: "data/covers/pl1.png", cloud: "synced" });
    mocks.getPlaylistCover.mockResolvedValue("data:image/png;base64,QUI=");
    await openEditDialog();
    // 弹窗里的「更换封面」按钮：封面蒙层上也有一颗同名的，取最后一颗
    const buttons = screen.getAllByRole("button", { name: "更换封面" });
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() =>
      expect(mocks.setPlaylistCover).toHaveBeenCalledWith("pl1", "D:/pics/cover.png"),
    );
    // 弹窗还开着（封面操作即时生效，不需要点保存）
    expect(screen.getByRole("heading", { level: 2, name: "编辑歌单" })).toBeTruthy();
  });

  it("云端同步失败（每日配额上限）：本地封面生效，弹窗里亮出后端原因", async () => {
    mocks.pickImage.mockResolvedValue("D:/pics/cover.png");
    mocks.setPlaylistCover.mockResolvedValue({
      path: "data/covers/pl1.png",
      cloud: "failed",
      message: "Astral 业务错误(300): 今日上传次数已达上限",
    });
    mocks.getPlaylistCover.mockResolvedValue("data:image/png;base64,QUI=");
    await openEditDialog();
    const buttons = screen.getAllByRole("button", { name: "更换封面" });
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() =>
      expect(mocks.setPlaylistCover).toHaveBeenCalledWith("pl1", "D:/pics/cover.png"),
    );
    // 本地已生效：走完了读回封面的链路（getPlaylistCover 被调）……
    await waitFor(() => expect(mocks.getPlaylistCover).toHaveBeenCalledWith("pl1"));
    // ……同时 alert 里带出云端失败原因，不再静默吞掉
    expect(
      screen.getByText(/同步云端失败：Astral 业务错误\(300\): 今日上传次数已达上限/),
    ).toBeTruthy();
  });

  it("恢复默认封面：调 clearPlaylistCover", async () => {
    mocks.clearPlaylistCover.mockResolvedValue({ cloud: "synced" });
    await openEditDialog();
    fireEvent.click(screen.getByRole("button", { name: "恢复默认封面" }));

    await waitFor(() => expect(mocks.clearPlaylistCover).toHaveBeenCalledWith("pl1"));
  });

  it("封面 hover 蒙层与「编辑歌单」入口都在（在线歌单/榜单不摆）", async () => {
    const { PlaylistDetailPage } = await import("@/components/discovery/PlaylistDetailPage");
    render(<PlaylistDetailPage platform="local" id="pl1" />);
    await waitFor(() => expect(screen.getByText("我的老歌单")).toBeTruthy());
    expect(screen.getByLabelText("更换封面")).toBeTruthy();
    expect(screen.getByLabelText(/编辑歌单/)).toBeTruthy();
  });
});
