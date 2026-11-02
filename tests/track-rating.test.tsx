// @vitest-environment jsdom
/**
 * 列表行评分（A6）。
 *
 * 覆盖点：进列表时批量补齐这一屏的星级、行内星标打开评分面板、点星落库
 * （`set_track_rating`）、再点当前分值 = 清除（传 0）、右键菜单「评分…」也能开面板。
 * 面板是 portal 到 body 的，断言走 `screen` 而不是容器子树。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

const getTrackRatings = vi.hoisted(() => vi.fn(async (): Promise<Record<string, number>> => ({})));
const setTrackRating = vi.hoisted(() => vi.fn(async () => undefined));
const playTrack = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/services/ipc", () => ({
  getTrackRatings,
  setTrackRating,
  playTrack,
  queueAddNext: vi.fn(async () => undefined),
  queueAppend: vi.fn(async () => undefined),
  getDownloadQuality: vi.fn(async () => "320k"),
  startDownload: vi.fn(async () => undefined),
  listMyPlaylists: vi.fn(async () => []),
  listTrackPlaylists: vi.fn(async () => []),
  checkFavoriteFlags: vi.fn(async (tracks: unknown[]) => tracks.map(() => false)),
  checkDisliked: vi.fn(async (tracks: unknown[]) => tracks.map(() => false)),
  addFavorite: vi.fn(async () => undefined),
  createPlaylist: vi.fn(async () => "p1"),
  revealLocalTrack: vi.fn(async () => undefined),
  deleteLocalTrack: vi.fn(async () => undefined),
  getLocalCover: vi.fn(async () => null),
}));

import { TrackList } from "@/components/discovery/TrackList";
import { useRatingsStore } from "@/stores/ratings";
import { useToastStore } from "@/stores/toast";
import type { Track } from "@/types";

function track(id: string): Track {
  return {
    id,
    platform: "qq",
    title: `歌${id}`,
    singer: "周杰伦",
    album: "叶惠美",
    picUrl: "",
    duration: 200,
    musicId: null,
  };
}

/** 当前星级：星标按钮的 aria-label 就是「评分 N 星」/「评分」 */
function starLabel(): string | null {
  return screen.getByTestId("row-rating").getAttribute("aria-label");
}

function openRatingPanelByStar(): void {
  fireEvent.click(screen.getByTestId("row-rating"), { clientX: 200, clientY: 120 });
}

describe("列表行评分", () => {
  beforeEach(() => {
    getTrackRatings.mockClear();
    setTrackRating.mockClear();
    playTrack.mockClear();
    useRatingsStore.setState({ ratings: {}, known: {} });
    useToastStore.setState({ items: [] });
  });
  afterEach(() => {
    cleanup(); // 面板 portal 在 body 上，不清理会串到下一个用例
  });

  it("进列表就批量取星级，取回来的值直接点亮星标", async () => {
    getTrackRatings.mockResolvedValue({ "qq:1": 2 });
    render(<TrackList tracks={[track("1")]} />);

    await waitFor(() => expect(starLabel()).toBe("评分 2 星"));
    expect(getTrackRatings).toHaveBeenCalledTimes(1);
    expect(getTrackRatings).toHaveBeenCalledWith(["qq:1"]);
  });

  it("点行内星标开面板，点第 4 颗 = 4 星，面板与星标同步更新", async () => {
    getTrackRatings.mockResolvedValue({});
    render(<TrackList tracks={[track("1")]} />);

    openRatingPanelByStar();
    // 面板里「未评分」+ 五颗星
    expect(screen.getByText("未评分")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "4 星" }));

    await waitFor(() => expect(setTrackRating).toHaveBeenCalledWith("qq:1", 4));
    await waitFor(() => expect(starLabel()).toBe("评分 4 星"));
    expect(screen.getByText("4 星")).toBeTruthy();
    // 点星不能顺带把这一行播了（按钮 stopPropagation）
    expect(playTrack).not.toHaveBeenCalled();
  });

  it("再点当前分值 = 清除，传 0 且星标回到未评分", async () => {
    getTrackRatings.mockResolvedValue({ "qq:1": 3 });
    render(<TrackList tracks={[track("1")]} />);
    await waitFor(() => expect(starLabel()).toBe("评分 3 星"));

    openRatingPanelByStar();
    fireEvent.click(screen.getByRole("radio", { name: "3 星" }));

    await waitFor(() => expect(setTrackRating).toHaveBeenCalledWith("qq:1", 0));
    await waitFor(() => expect(starLabel()).toBe("评分"));
    expect(screen.getByText("未评分")).toBeTruthy();
  });

  it("右键菜单也有「评分…」：已评过分时带上当前星级", async () => {
    getTrackRatings.mockResolvedValue({ "qq:1": 5 });
    render(<TrackList tracks={[track("1")]} />);
    await waitFor(() => expect(starLabel()).toBe("评分 5 星"));

    const row = screen.getByText("歌1").closest("[role='button']");
    if (!row) throw new Error("没找到这一行");
    fireEvent.contextMenu(row, { clientX: 120, clientY: 90 });
    const menu = screen.getByRole("menu");
    fireEvent.click(within(menu).getByText("评分：5 星"));

    // 菜单让位，面板出来
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("radiogroup", { name: "评分" })).toBeTruthy();
  });

  it("IPC 失败：星标回滚到点之前的值", async () => {
    getTrackRatings.mockResolvedValue({});
    setTrackRating.mockRejectedValueOnce(new Error("db locked"));
    render(<TrackList tracks={[track("1")]} />);

    openRatingPanelByStar();
    fireEvent.click(screen.getByRole("radio", { name: "2 星" }));

    await waitFor(() => expect(useToastStore.getState().items.length).toBe(1));
    expect(useRatingsStore.getState().ratings["qq:1"]).toBeUndefined();
    expect(starLabel()).toBe("评分");
  });
});
