// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Track } from "@/types";

/**
 * 标签编辑（A2 / 分析文档 §4.2）的入口与口径：
 * - 单曲：右键「编辑标签…」→ 表单预填文件原值 → 保存时**整份字段**下发（空串 = 清除）；
 * - 批量：批量条「编辑标签…」→ 只下发填了的字段（留空 = 不修改）；
 * - 撤销：最近一批批次号存在时可点，成功后关窗并刷新列表；
 * - CUE 虚拟分轨不参与写入（Rust 侧会拒，前端就别发过去）。
 */
const mocks = vi.hoisted(() => ({
  getLocalTracks: vi.fn(async (): Promise<Track[]> => []),
  readLocalTags: vi.fn(async () => ({
    title: "旧标题",
    artist: "旧歌手",
    album: "旧专辑",
    albumArtist: "",
    genre: "流行",
    year: 2018,
    trackNo: 3,
    discNo: null as number | null,
  })),
  writeLocalTags: vi.fn(
    async (): Promise<{
      batch: string;
      updated: number;
      failed: { path: string; reason: string }[];
    }> => ({ batch: "tag-9", updated: 1, failed: [] }),
  ),
  undoTagEdit: vi.fn(async () => 1),
  lastTagEditBatch: vi.fn(async (): Promise<string | null> => null),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));

// 曲库页会连带加载一整串 IPC（屏蔽规则、评分、下载态…），逐个列举太脆：
// 用「真模块 + 覆盖标签相关函数」，其余在这几个用例里不会真的被关心。
vi.mock("@/services/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ipc")>();
  return {
    ...actual,
    getLocalTracks: mocks.getLocalTracks,
    getScanDirs: vi.fn(async () => []),
    getMissingLocalTracks: vi.fn(async () => []),
    getScanMinDuration: vi.fn(async () => 60),
    getScanMinSize: vi.fn(async () => 1048576),
    getLibraryWatch: vi.fn(async () => true),
    setLibraryWatch: vi.fn(async () => undefined),
    deleteLocalTracks: vi.fn(async () => 0),
    readLocalTags: mocks.readLocalTags,
    writeLocalTags: mocks.writeLocalTags,
    undoTagEdit: mocks.undoTagEdit,
    lastTagEditBatch: mocks.lastTagEditBatch,
  };
});

import { LibraryPage } from "@/components/library/LibraryPage";

const localTrack = (id: string, title: string): Track => ({
  id,
  platform: "local",
  title,
  singer: "某歌手",
  album: "某专辑",
  picUrl: "",
  duration: 200,
});

/** 右键某一行的上下文菜单，返回菜单项文案 */
async function openRowMenu(rowTitle: string): Promise<void> {
  const row = (await screen.findByText(rowTitle)).closest("[data-track-row='true']");
  expect(row).toBeTruthy();
  fireEvent.contextMenu(row!);
}

beforeEach(() => {
  mocks.getLocalTracks.mockReset();
  mocks.readLocalTags.mockClear();
  mocks.writeLocalTags.mockReset();
  mocks.writeLocalTags.mockResolvedValue({ batch: "tag-9", updated: 1, failed: [] });
  mocks.undoTagEdit.mockClear();
  mocks.lastTagEditBatch.mockReset();
  mocks.lastTagEditBatch.mockResolvedValue(null);
});

describe("标签编辑", () => {
  it("单曲：右键进入后预填原值，保存时整份字段下发", async () => {
    mocks.getLocalTracks.mockResolvedValue([localTrack("D:/music/a.flac", "第一首")]);
    render(<LibraryPage />);

    await openRowMenu("第一首");
    fireEvent.click(await screen.findByRole("menuitem", { name: "编辑标签…" }));

    const title = (await screen.findByLabelText("标题")) as HTMLInputElement;
    await waitFor(() => expect(title.value).toBe("旧标题"));
    expect((screen.getByLabelText("年份") as HTMLInputElement).value).toBe("2018");

    fireEvent.change(title, { target: { value: "新标题" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(mocks.writeLocalTags).toHaveBeenCalledTimes(1));
    const [paths, patch] = mocks.writeLocalTags.mock.calls[0] as unknown as [
      string[],
      Record<string, unknown>,
    ];
    expect(paths).toEqual(["D:/music/a.flac"]);
    expect(patch.title).toBe("新标题");
    // 单曲口径：表单就是原值，没填的文本字段=清空，所以也要出现在 patch 里
    expect(patch.albumArtist).toBe("");
    expect(patch.year).toBe(2018);
    expect(patch.discNo).toBe(0);
  });

  it("批量：只下发填了的字段，留空的不动", async () => {
    mocks.getLocalTracks.mockResolvedValue([
      localTrack("D:/music/a.flac", "第一首"),
      localTrack("D:/music/b.flac", "第二首"),
    ]);
    render(<LibraryPage />);
    await screen.findByText("第一首");

    const boxes = screen.getAllByRole("checkbox", { name: /^选择 / });
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);

    fireEvent.click(await screen.findByRole("button", { name: "编辑标签…" }));
    const album = (await screen.findByLabelText("专辑")) as HTMLInputElement;
    expect(album.value).toBe("");
    fireEvent.change(album, { target: { value: "合辑 X" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(mocks.writeLocalTags).toHaveBeenCalledTimes(1));
    const [paths, patch] = mocks.writeLocalTags.mock.calls[0] as unknown as [
      string[],
      Record<string, unknown>,
    ];
    // 顺序跟列表排序一致，不强绑：只校验「两首都在」
    expect([...paths].sort()).toEqual(["D:/music/a.flac", "D:/music/b.flac"]);
    expect(patch.album).toBe("合辑 X");
    expect("title" in patch).toBe(false);
    expect("year" in patch).toBe(false);
    // 批量不读文件（读了也只能代表其中一首）
    expect(mocks.readLocalTags).not.toHaveBeenCalled();
  });

  it("撤销：有最近批次时可点，成功后关窗并刷新列表", async () => {
    mocks.getLocalTracks.mockResolvedValue([localTrack("D:/music/a.flac", "第一首")]);
    mocks.lastTagEditBatch.mockResolvedValue("tag-7");
    render(<LibraryPage />);

    const loadsBefore = mocks.getLocalTracks.mock.calls.length;
    await openRowMenu("第一首");
    fireEvent.click(await screen.findByRole("menuitem", { name: "编辑标签…" }));

    const undo = await screen.findByRole("button", { name: "撤销上次修改" });
    fireEvent.click(undo);

    await waitFor(() => expect(mocks.undoTagEdit).toHaveBeenCalledWith("tag-7"));
    await waitFor(() =>
      expect(mocks.getLocalTracks.mock.calls.length).toBeGreaterThan(loadsBefore),
    );
    // 撤完弹层关掉：标题输入框消失
    await waitFor(() => expect(screen.queryByLabelText("标题")).toBeNull());
  });

  it("CUE 分轨被跳过，不会发给写入命令", async () => {
    mocks.getLocalTracks.mockResolvedValue([
      localTrack("D:/music/a.flac", "普通曲目"),
      localTrack("D:/music/album.cue#cue:3", "分轨曲目"),
    ]);
    render(<LibraryPage />);
    await screen.findByText("普通曲目");

    const boxes = screen.getAllByRole("checkbox", { name: /^选择 / });
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);
    fireEvent.click(await screen.findByRole("button", { name: "编辑标签…" }));

    expect(await screen.findByText(/已跳过 1 首 CUE 分轨/)).toBeTruthy();
    fireEvent.change((await screen.findByLabelText("流派")) as HTMLInputElement, {
      target: { value: "摇滚" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(mocks.writeLocalTags).toHaveBeenCalledTimes(1));
    const [paths] = mocks.writeLocalTags.mock.calls[0] as unknown as [string[]];
    expect(paths).toEqual(["D:/music/a.flac"]);
  });

  it("有文件写失败时留在弹层里给原因", async () => {
    mocks.getLocalTracks.mockResolvedValue([localTrack("D:/music/a.flac", "第一首")]);
    mocks.writeLocalTags.mockResolvedValue({
      batch: "tag-9",
      updated: 0,
      failed: [{ path: "D:/music/a.flac", reason: "文件被占用" }],
    });
    render(<LibraryPage />);

    await openRowMenu("第一首");
    fireEvent.click(await screen.findByRole("menuitem", { name: "编辑标签…" }));
    const title = (await screen.findByLabelText("标题")) as HTMLInputElement;
    await waitFor(() => expect(title.value).toBe("旧标题"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText(/文件被占用/)).toBeTruthy();
    expect(screen.getByLabelText("标题")).toBeTruthy();
  });
});
