// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Track } from "@/types";

const mocks = vi.hoisted(() => ({
  play: vi.fn(async () => undefined),
  playQueue: vi.fn(async () => undefined),
  navigate: vi.fn(),
  getPlaylistDetail: vi.fn(),
  listMyPlaylists: vi.fn(async () => []),
  getPlaylistTracks: vi.fn(async (): Promise<Track[]> => []),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useRouter: () => ({ history: { back: vi.fn() } }),
  useParams: () => ({ platform: "qq", id: "p1" }),
  useSearch: () => ({}),
}));
vi.mock("@/services/ipc", () => ({
  LOCAL_PLATFORM: "local",
  listMyPlaylists: mocks.listMyPlaylists,
  getPlaylistTracks: mocks.getPlaylistTracks,
  checkFavoriteFlags: vi.fn(async (tracks: Track[]) => tracks.map(() => false)),
  checkDisliked: vi.fn(async (tracks: Track[]) => tracks.map(() => false)),
  isPlaylistFavorited: vi.fn(async () => false),
  getLocalCover: vi.fn(async () => null),
  pickSavePath: vi.fn(async () => null),
  saveBinaryFile: vi.fn(async () => undefined),
  startDownload: vi.fn(async () => undefined),
  getDownloadQuality: vi.fn(async () => "320k"),
  addTracksToPlaylist: vi.fn(async () => 0),
  removeTracksFromPlaylist: vi.fn(async () => undefined),
}));
vi.mock("@/source-scripts", () => ({
  getPlaylistDetail: mocks.getPlaylistDetail,
  getCharts: vi.fn(async () => []),
  getChartDetail: vi.fn(async () => []),
  getArtistSongs: vi.fn(),
  DEFAULT_SEARCH_PAGE_MAX: 50,
}));

/** 分享卡把卡片画在 canvas 上：jsdom 没实现，给个够用的假上下文 */
function installCanvasStubs(): void {
  const noop = (): void => undefined;
  const ctx = {
    canvas: null,
    font: "",
    fillStyle: "",
    strokeStyle: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    lineWidth: 1,
    globalAlpha: 1,
    measureText: (t: string) => ({ width: t.length * 10 }),
    fillText: noop,
    fillRect: noop,
    strokeRect: noop,
    clearRect: noop,
    scale: noop,
    save: noop,
    restore: noop,
    clip: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    quadraticCurveTo: noop,
    closePath: noop,
    fill: noop,
    stroke: noop,
    drawImage: noop,
  };
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ctx,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
    configurable: true,
    value: () => "data:image/png;base64,QUJD",
  });
  // 曲目没有封面（picUrl 空），不会走到 Image；保险起见也桩掉
  Object.defineProperty(globalThis, "Image", {
    configurable: true,
    writable: true,
    value: class {
      width = 0;
      height = 0;
      crossOrigin = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        void Promise.resolve().then(() => this.onerror?.());
      }
    },
  });
}

installCanvasStubs();

const SONG: Track = {
  id: "1",
  title: "越",
  platform: "qq",
  singer: "孙楠",
  album: "",
  picUrl: "",
  duration: 259000,
};

describe("歌单详情页的分享卡入口", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installCanvasStubs();
  });

  afterEach(() => {
    cleanup();
  });

  it("点「分享歌单卡片」弹出歌单卡预览", async () => {
    mocks.getPlaylistDetail.mockResolvedValue({
      name: "夜跑歌单",
      picUrl: "",
      playCount: "",
      tracks: [SONG],
    });
    const { PlaylistDetailPage } = await import("@/components/discovery/PlaylistDetailPage");
    render(<PlaylistDetailPage platform="qq" id="p1" />);

    await waitFor(() => expect(screen.getByText("越")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("分享歌单卡片"));

    await waitFor(() => expect(screen.getByText("分享歌单")).toBeTruthy());
    expect(screen.getByText("分享「夜跑歌单」")).toBeTruthy();
    expect(screen.getByRole("button", { name: /复制图片/ })).toBeTruthy();
  });

  it("空歌单不摆分享卡入口（没封面可拼，也没意义）", async () => {
    mocks.getPlaylistDetail.mockResolvedValue({
      name: "空歌单",
      picUrl: "",
      playCount: "",
      tracks: [],
    });
    const { PlaylistDetailPage } = await import("@/components/discovery/PlaylistDetailPage");
    render(<PlaylistDetailPage platform="qq" id="p1" />);

    await waitFor(() => expect(screen.getByText(/歌单里还没有歌曲|还没有歌曲/)).toBeTruthy());
    expect(screen.queryByLabelText("分享歌单卡片")).toBeNull();
  });
});
