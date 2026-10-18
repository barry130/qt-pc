// @vitest-environment jsdom
/**
 * 从 `.json` 歌单文件导入（REQUIREMENTS §3.21.5.3）。
 *
 * 覆盖点：选文件 → Rust 解析结果摆成预览卡 → 复用「新建歌单」目标 → 落库；
 * 以及"解析结果为空"时给的是可读的错误，而不是默默什么都不做。
 * 链接导入那条老路在 tests/playlist-import.test.ts 里，这里只测文件分支。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// 返回类型必须显式写成 `string | null`：真实 ipc 的 pickPlaylistJsonFile 在
// 用户取消对话框时 resolve(null)，不标注的话推断成 Promise<string>，
// 下面「取消选文件」那条用例的 mockResolvedValueOnce(null) 就通不过 tsc。
const pickPlaylistJsonFile = vi.hoisted(() =>
  vi.fn(async (): Promise<string | null> => "C:/tmp/导出的歌单.json"),
);
const parsePlaylistJson = vi.hoisted(() =>
  vi.fn(async () => ({
    name: "导出的歌单",
    exportedAt: 1_760_000_000,
    skipped: 0,
    tracks: [
      {
        id: "a1",
        platform: "qq",
        title: "晴天",
        singer: "周杰伦",
        album: "叶惠美",
        picUrl: "",
        duration: 269,
        musicId: null,
      },
      {
        id: "a2",
        platform: "qq",
        title: "七里香",
        singer: "周杰伦",
        album: "七里香",
        picUrl: "",
        duration: 299,
        musicId: null,
      },
    ],
  })),
);
const listMyPlaylists = vi.hoisted(() => vi.fn(async () => []));
const createPlaylist = vi.hoisted(() => vi.fn(async () => "p-new"));
const addTracksToPlaylist = vi.hoisted(() => vi.fn(async () => 2));

vi.mock("@/services/ipc", () => ({
  LOCAL_PLATFORM: "local",
  pickPlaylistJsonFile,
  parsePlaylistJson,
  listMyPlaylists,
  createPlaylist,
  addTracksToPlaylist,
}));
// 弹窗顶层 import 了这两个模块；文件分支用不到，但要能加载
vi.mock("@/source-scripts", () => ({}));
vi.mock("@/lib/playlist-import", () => ({
  importPlaylist: vi.fn(),
  importPlaylistSongs: vi.fn(),
}));
vi.mock("@/stores/sourceRegistry", () => ({
  useSourceRegistryStore: (
    sel: (s: { sources: unknown[]; ensure: () => Promise<void> }) => unknown,
  ) => sel({ sources: [], ensure: async () => undefined }),
  useSourceLabelFn: () => (id: string) => id,
}));

import { ImportPlaylistDialog } from "@/components/mine/ImportPlaylistDialog";

function renderDialog(): { onSongsImported: ReturnType<typeof vi.fn> } {
  const onSongsImported = vi.fn();
  render(
    <ImportPlaylistDialog
      onClose={vi.fn()}
      onImported={vi.fn()}
      onSongsImported={onSongsImported}
    />,
  );
  return { onSongsImported };
}

beforeEach(() => {
  pickPlaylistJsonFile.mockClear();
  parsePlaylistJson.mockClear();
  createPlaylist.mockClear();
  addTracksToPlaylist.mockClear();
  listMyPlaylists.mockClear();
});

describe("从 .json 歌单文件导入", () => {
  it("选文件后摆出预览，导入时新建歌单并落库", async () => {
    const { onSongsImported } = renderDialog();

    fireEvent.click(
      screen.getByRole("button", {
        name: "或从本应用导出的 .json 歌单文件导入…",
      }),
    );

    // 预览卡用的是解析结果里的歌单名与曲目数
    await screen.findByText("导出的歌单");
    expect(screen.getByText(/2 首/)).toBeTruthy();
    expect(parsePlaylistJson).toHaveBeenCalledWith("C:/tmp/导出的歌单.json");

    // 「导入歌曲」既是顶部 tab 名也是提交按钮，取最后一个（页脚那颗）
    const submits = screen.getAllByRole("button", { name: "导入歌曲" });
    fireEvent.click(submits[submits.length - 1]);

    await waitFor(() => expect(addTracksToPlaylist).toHaveBeenCalled());
    // 名字留空 = 用文件里的歌单名（与链接导入的"默认用远程歌单名"一致）
    expect(createPlaylist).toHaveBeenCalledWith("导出的歌单");
    expect(addTracksToPlaylist).toHaveBeenCalledWith(
      "p-new",
      expect.arrayContaining([expect.objectContaining({ id: "a1" })]),
    );
    expect(onSongsImported).toHaveBeenCalledWith("p-new");
    await screen.findByText(/已从文件导入 2 \/ 2 首到「导出的歌单」/);
  });

  it("解析出来一首都不剩时报可读的错误，而不是静默成功", async () => {
    parsePlaylistJson.mockResolvedValueOnce({
      name: "别人机器上的歌单",
      exportedAt: 1_760_000_000,
      skipped: 3,
      tracks: [],
    });
    renderDialog();

    fireEvent.click(
      screen.getByRole("button", {
        name: "或从本应用导出的 .json 歌单文件导入…",
      }),
    );

    await screen.findByText(/3 首曲目在本机都不存在/);
    expect(createPlaylist).not.toHaveBeenCalled();
    expect(addTracksToPlaylist).not.toHaveBeenCalled();
  });

  it("用户取消选文件时什么都不发生", async () => {
    pickPlaylistJsonFile.mockResolvedValueOnce(null);
    renderDialog();

    fireEvent.click(
      screen.getByRole("button", {
        name: "或从本应用导出的 .json 歌单文件导入…",
      }),
    );

    await waitFor(() => expect(pickPlaylistJsonFile).toHaveBeenCalled());
    expect(parsePlaylistJson).not.toHaveBeenCalled();
    expect(screen.queryByText("导出的歌单")).toBeNull();
  });
});
