// @vitest-environment jsdom
/**
 * 列表行右键菜单（REQUIREMENTS §3.21.7.1）。
 *
 * 覆盖点：菜单项齐全（含「加入歌单 / 收藏」合并成「收藏到歌单…」）、点一项即执行
 * 并收起、点外面 / Esc 收起、本地曲目没有在线动作（下载 / 换源 / 查看歌手专辑）。
 * 菜单是 portal 到 body 的，所以断言都走 document 而不是容器子树。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

const queueAddNext = vi.hoisted(() => vi.fn(async () => undefined));
const queueAppend = vi.hoisted(() => vi.fn(async () => undefined));
const getDownloadQuality = vi.hoisted(() => vi.fn(async () => "320k"));
const startDownload = vi.hoisted(() => vi.fn(async () => undefined));
const listMyPlaylists = vi.hoisted(() => vi.fn(async () => []));
const listTrackPlaylists = vi.hoisted(() => vi.fn(async () => []));
const checkFavoriteFlags = vi.hoisted(() =>
  vi.fn(async (tracks: unknown[]) => tracks.map(() => false)),
);
const checkDisliked = vi.hoisted(() =>
  vi.fn(async (tracks: unknown[]) => tracks.map(() => false)),
);
/** 播放一首歌的 IPC。portal 的事件仍走 React 树，若不拦住，点菜单项会顺手播放 */
const playTrack = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/services/ipc", () => ({
  queueAddNext,
  queueAppend,
  getDownloadQuality,
  startDownload,
  listMyPlaylists,
  listTrackPlaylists,
  checkFavoriteFlags,
  checkDisliked,
  playTrack,
  addFavorite: vi.fn(async () => undefined),
  createPlaylist: vi.fn(async () => "p1"),
  revealLocalTrack: vi.fn(async () => undefined),
  deleteLocalTrack: vi.fn(async () => undefined),
  getLocalCover: vi.fn(async () => null),
}));

import { TrackList } from "@/components/discovery/TrackList";
import { useToastStore } from "@/stores/toast";
import type { Track } from "@/types";

function track(id: string, platform: Track["platform"] = "qq"): Track {
  return {
    id,
    platform,
    title: `歌${id}`,
    singer: "周杰伦",
    album: "叶惠美",
    picUrl: "",
    duration: 200,
    musicId: null,
  };
}

/** 右键第 n 行（行是 div[role=button]，没有 accessible name，用歌名找它） */
function openMenu(title: string): HTMLElement {
  const row = screen.getByText(title).closest("[role='button']");
  if (!row) throw new Error(`没找到「${title}」这一行`);
  fireEvent.contextMenu(row, { clientX: 120, clientY: 90 });
  return screen.getByRole("menu");
}

describe("列表行右键菜单", () => {
  beforeEach(() => {
    for (const fn of [
      queueAddNext,
      queueAppend,
      getDownloadQuality,
      startDownload,
      listMyPlaylists,
      listTrackPlaylists,
      checkFavoriteFlags,
      checkDisliked,
      playTrack,
    ]) {
      fn.mockClear();
    }
    useToastStore.setState({ items: [] });
  });
  afterEach(() => {
    cleanup(); // 菜单 portal 在 body 上，不清理会串到下一个用例
  });

  it("在线曲目：十项动作齐全（加入歌单与收藏合并为「收藏到歌单…」）", () => {
    render(<TrackList tracks={[track("1")]} />);
    const menu = openMenu("歌1");
    for (const label of [
      "播放",
      "下一首播放",
      "加入播放队列",
      "收藏到歌单…",
      "下载",
      "换源…",
      "复制歌曲信息",
      "查看歌手",
      "查看专辑",
    ]) {
      expect(within(menu).getByText(label)).toBeTruthy();
    }
    // 没传 onRemove（不可编辑列表）就没有「从歌单移除」
    expect(within(menu).queryByText("从歌单移除")).toBeNull();
  });

  it("点「加入播放队列」执行动作并收起菜单", () => {
    render(<TrackList tracks={[track("1")]} />);
    const menu = openMenu("歌1");
    fireEvent.click(within(menu).getByText("加入播放队列"));
    expect(queueAppend).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    // 回归：菜单是 portal 到 body 的，但 React 事件树里仍在行内 —— 点菜单项
    // 曾经连带触发整行的 onClick，把这首歌播了
    expect(playTrack).not.toHaveBeenCalled();
  });

  it("点「收藏到歌单…」就地换成收藏面板（同一坐标，菜单让位）", async () => {
    render(<TrackList tracks={[track("1")]} />);
    const menu = openMenu("歌1");
    fireEvent.click(within(menu).getByText("收藏到歌单…"));
    // 面板挂载后才会去拉歌单清单
    await waitFor(() => expect(screen.getByPlaceholderText("新建歌单并收藏")).toBeTruthy());
    expect(listMyPlaylists).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("点菜单外面 / 按 Esc 都收起", () => {
    render(<TrackList tracks={[track("1"), track("2")]} />);
    openMenu("歌1");
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();

    openMenu("歌2");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("本地曲目：在线动作置灰，「从歌单移除」按调用方给的文案出现", () => {
    const onRemove = vi.fn();
    render(
      <TrackList
        tracks={[track("l1", "local")]}
        local={{ onChanged: () => {}, onError: () => {} }}
        onRemove={onRemove}
        removeLabel="从歌单移除"
      />,
    );
    const menu = openMenu("歌l1");
    const itemButton = (label: string): HTMLButtonElement => {
      const el = within(menu).getByText(label).closest("button");
      if (!el) throw new Error(`没找到菜单项「${label}」`);
      return el;
    };
    // 本地文件没有在线音源：这三项在，但点不动
    expect(itemButton("下载").disabled).toBe(true);
    expect(itemButton("换源…").disabled).toBe(true);
    expect(itemButton("查看歌手").disabled).toBe(true);
    // 队列与收藏对本地曲目一样有效
    expect(itemButton("下一首播放").disabled).toBe(false);
    expect(itemButton("加入播放队列").disabled).toBe(false);
    expect(itemButton("收藏到歌单…").disabled).toBe(false);
    // 可编辑列表才有移除
    fireEvent.click(itemButton("从歌单移除"));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
