// @vitest-environment jsdom
/**
 * 下载管理页的播放入口（DESIGN §5.3 / 路由表 `/downloads`）。
 *
 * 下载完成的文件本身就是一首本地曲目：`DownloadTask.filePath` 就是
 * `Track.id`，平台改成 `local`，引擎走 `PlaySource::Local` 直接解盘，
 * 不联网取址。这几条守住：
 *   1. 只有「已完成 + 有落盘路径」的任务才给播放入口；
 *   2. 播放 / 入队用的是本地 Track（id = 文件路径，platform = local），
 *      不是原来那个在线 Track（否则又会去取一次链）；
 *   3. 行内按钮、整行点击、工具栏「播放全部已完成」三条路都对；
 *   4. 点复选框 / 删除菜单不会顺手把这首播了。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DownloadTask, Track } from "@/types";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(async () => {}),
  getDownloadDir: vi.fn(async () => "D:\\Music"),
  queueAppend: vi.fn(async (_tracks: Track[]) => {}),
  queueAddNext: vi.fn(async (_track: Track) => {}),
  deleteDownload: vi.fn(async (_id: string, _deleteFile: boolean) => {}),
  pauseDownload: vi.fn(async (_id: string) => {}),
  resumeDownload: vi.fn(async (_id: string) => {}),
  retryDownload: vi.fn(async (_id: string) => {}),
  cancelDownload: vi.fn(async (_id: string) => {}),
  revealDownload: vi.fn(async (_id: string) => {}),
  checkFavoriteFlags: vi.fn(async (tracks: Track[]) => tracks.map(() => false)),
  play: vi.fn(async (_track: Track) => {}),
  playQueue: vi.fn(async (_tracks: Track[], _index: number) => {}),
}));

/** 任务列表由每个用例通过这个可变引用注入（store 是全局单例） */
const state = vi.hoisted(() => ({ tasks: [] as DownloadTask[] }));

vi.mock("@/services/ipc", () => ({
  getDownloadDir: mocks.getDownloadDir,
  queueAppend: mocks.queueAppend,
  queueAddNext: mocks.queueAddNext,
  deleteDownload: mocks.deleteDownload,
  deleteDownloads: vi.fn(async () => 0),
  pauseDownload: mocks.pauseDownload,
  pauseDownloads: vi.fn(async () => 0),
  resumeDownload: mocks.resumeDownload,
  resumeDownloads: vi.fn(async () => 0),
  retryDownload: mocks.retryDownload,
  cancelDownload: mocks.cancelDownload,
  cancelDownloads: vi.fn(async () => 0),
  revealDownload: mocks.revealDownload,
  // 行尾收藏红心：列表层批量判定（默认都没收藏）
  checkFavoriteFlags: mocks.checkFavoriteFlags,
}));

vi.mock("@/stores/downloads", () => ({
  useDownloadsStore: <T,>(selector: (s: unknown) => T): T =>
    selector({
      tasks: state.tasks,
      loaded: true,
      refresh: mocks.refresh,
    }),
}));

vi.mock("@/stores/player", () => ({
  usePlayerStore: {
    getState: () => ({ play: mocks.play, playQueue: mocks.playQueue }),
  },
}));

vi.mock("@/stores/toast", () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

import { DownloadsPage } from "@/components/mine/DownloadsPage";

/** 原始在线曲目（下载任务里存的就是它） */
const onlineTrack: Track = {
  id: "003abc",
  platform: "qq",
  title: "夜曲",
  singer: "周杰伦",
  album: "十一月的萧邦",
  picUrl: "",
  duration: 226,
  musicId: null,
};

function task(over: Partial<DownloadTask> & { id: string }): DownloadTask {
  return {
    track: onlineTrack,
    quality: "320",
    actualQuality: "320",
    status: "done",
    progress: 1,
    filePath: null,
    fileSize: 8_000_000,
    error: "",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

const done = task({ id: "d1", filePath: "D:\\Music\\夜曲.mp3" });
const downloading = task({
  id: "d2",
  status: "downloading",
  progress: 0.4,
  filePath: null,
  track: { ...onlineTrack, id: "003def", title: "搁浅" },
});
/** 历史任务：状态是 done 但没落盘路径（旧版本留下的记录） */
const doneNoPath = task({
  id: "d3",
  filePath: null,
  track: { ...onlineTrack, id: "003ghi", title: "借口" },
});

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockClear();
  state.tasks = [done, downloading, doneNoPath];
});

afterEach(() => {
  cleanup();
});

describe("下载管理的播放入口", () => {
  it("已完成且落盘的任务：点标题播本地文件，不是原在线曲目", async () => {
    render(<DownloadsPage />);
    const title = await screen.findByRole("button", { name: "夜曲" });
    fireEvent.click(title);

    await waitFor(() => expect(mocks.play).toHaveBeenCalledTimes(1));
    const played = mocks.play.mock.calls[0][0] as unknown as Track;
    // 关键：换成本地曲目，id 是文件绝对路径（引擎据此直接解码）
    expect(played.platform).toBe("local");
    expect(played.id).toBe("D:\\Music\\夜曲.mp3");
    // 元数据沿用原曲目，比从文件名反解准
    expect(played.title).toBe("夜曲");
    expect(played.singer).toBe("周杰伦");
    // 整首文件，CUE 区间要清掉
    expect(played.startMs).toBeNull();
    expect(played.endMs).toBeNull();
  });

  it("未完成 / 无落盘路径的任务不给播放入口", async () => {
    render(<DownloadsPage />);
    await screen.findByRole("button", { name: "夜曲" });
    // 下载中的行标题是纯文本，没有播放按钮
    expect(screen.queryByRole("button", { name: "搁浅" })).toBeNull();
    expect(screen.queryByRole("button", { name: "借口" })).toBeNull();
    // 三行里只有一行有播放入口
    expect(screen.getAllByRole("button", { name: "播放" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "加入播放队列" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "下一首播放" })).toHaveLength(1);
  });

  it("行内「播放」按钮与「加入播放队列」都按本地曲目走", async () => {
    render(<DownloadsPage />);
    await screen.findByRole("button", { name: "夜曲" });

    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    await waitFor(() => expect(mocks.play).toHaveBeenCalledTimes(1));
    expect((mocks.play.mock.calls[0][0] as unknown as Track).platform).toBe("local");

    fireEvent.click(screen.getByRole("button", { name: "加入播放队列" }));
    await waitFor(() => expect(mocks.queueAppend).toHaveBeenCalledTimes(1));
    const queued = mocks.queueAppend.mock.calls[0][0] as unknown as Track[];
    expect(queued).toHaveLength(1);
    expect(queued[0]?.platform).toBe("local");
    expect(queued[0]?.id).toBe("D:\\Music\\夜曲.mp3");

    fireEvent.click(screen.getByRole("button", { name: "下一首播放" }));
    await waitFor(() => expect(mocks.queueAddNext).toHaveBeenCalledTimes(1));
    const next = mocks.queueAddNext.mock.calls[0][0] as unknown as Track;
    expect(next.platform).toBe("local");
    expect(next.id).toBe("D:\\Music\\夜曲.mp3");
  });

  it("点行内复选框不会顺手播放", async () => {
    render(<DownloadsPage />);
    await screen.findByRole("button", { name: "夜曲" });
    const row = screen.getByRole("button", { name: "夜曲" }).closest("li");
    if (!row) throw new Error("没找到任务行");
    fireEvent.click(within(row).getByRole("checkbox"));
    // 复选框的 onChange 走选中，不该冒泡成「播这一行」
    expect(mocks.play).not.toHaveBeenCalled();
  });

  it("点行内空白处（状态文字）也能播，但点按钮不会", async () => {
    render(<DownloadsPage />);
    await screen.findByRole("button", { name: "夜曲" });
    const row = screen.getByRole("button", { name: "夜曲" }).closest("li");
    if (!row) throw new Error("没找到任务行");

    // 状态文字不是交互控件 → 整行点击生效
    fireEvent.click(within(row).getByText("已完成"));
    expect(mocks.play).toHaveBeenCalledTimes(1);

    // 删除菜单按钮的点击不能顺手把这首播了（stopPropagation + closest 双保险）
    fireEvent.click(within(row).getByRole("button", { name: "删除" }));
    expect(mocks.play).toHaveBeenCalledTimes(1);
  });

  it("工具栏「播放全部已完成」只把落盘的任务整批入队", async () => {
    render(<DownloadsPage />);
    const playAll = await screen.findByRole("button", {
      name: "播放全部已完成（1）",
    });
    fireEvent.click(playAll);

    await waitFor(() => expect(mocks.playQueue).toHaveBeenCalledTimes(1));
    const [tracks, index] = mocks.playQueue.mock.calls[0] as unknown as [
      Track[],
      number,
    ];
    // 下载中 / 无路径的两个任务不进队列
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.id).toBe("D:\\Music\\夜曲.mp3");
    expect(index).toBe(0);
  });

  it("一个可播的都没有时，工具栏不出现播放全部", async () => {
    state.tasks = [downloading, doneNoPath];
    render(<DownloadsPage />);
    await screen.findByText("搁浅");
    expect(screen.queryByRole("button", { name: /播放全部已完成/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "播放" })).toBeNull();
  });
});
