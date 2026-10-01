/**
 * 歌单导入单测：链接解析（对齐 qt-uniappx parsePlaylistInput）
 * + 导入歌曲整单拷贝编排（importPlaylistSongs）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractLongestDigits,
  lastPathSegment,
  parsePlaylistInput,
} from "@/lib/playlist-link";

vi.mock("@/services/ipc", () => ({
  createPlaylist: vi.fn(),
  addTracksToPlaylist: vi.fn(),
}));
vi.mock("@/source-scripts", () => ({
  getPlaylistDetail: vi.fn(),
}));

import type { Playlist, Track } from "@/types";
import { importPlaylistSongs } from "@/lib/playlist-import";
import * as ipc from "@/services/ipc";
import * as sourceApi from "@/source-scripts";

function track(id: string): Track {
  return {
    id,
    platform: "wyy",
    title: `歌 ${id}`,
    singer: "歌手",
    album: "专辑",
    picUrl: "",
    duration: 180,
  };
}

function detail(overrides: Partial<Playlist> = {}): Playlist {
  return {
    id: "123456",
    platform: "wyy",
    name: "夜曲歌单",
    picUrl: "https://img.example/cover.jpg",
    playCount: "1.2万",
    description: null,
    tracks: [track("s1"), track("s2")],
    ...overrides,
  };
}

describe("importPlaylistSongs 导入歌曲编排", () => {
  beforeEach(() => {
    vi.mocked(sourceApi.getPlaylistDetail).mockReset();
    vi.mocked(ipc.createPlaylist).mockReset();
    vi.mocked(ipc.addTracksToPlaylist).mockReset();
  });

  it("新建歌单：名称缺省用远程歌单名，整单拷入并回传统计", async () => {
    vi.mocked(sourceApi.getPlaylistDetail).mockResolvedValue(detail());
    vi.mocked(ipc.createPlaylist).mockResolvedValue("pid-new");
    vi.mocked(ipc.addTracksToPlaylist).mockResolvedValue(2);

    const res = await importPlaylistSongs(
      "https://music.163.com/#/playlist?id=123456",
      undefined,
      { kind: "new" },
    );

    expect(ipc.createPlaylist).toHaveBeenCalledWith("夜曲歌单");
    expect(ipc.addTracksToPlaylist).toHaveBeenCalledWith("pid-new", [
      expect.objectContaining({ id: "s1" }),
      expect.objectContaining({ id: "s2" }),
    ]);
    expect(res).toEqual({
      targetId: "pid-new",
      targetName: "夜曲歌单",
      added: 2,
      total: 2,
    });
  });

  it("新建歌单：自定义名称优先于远程名", async () => {
    vi.mocked(sourceApi.getPlaylistDetail).mockResolvedValue(detail());
    vi.mocked(ipc.createPlaylist).mockResolvedValue("pid-new");
    vi.mocked(ipc.addTracksToPlaylist).mockResolvedValue(2);

    await importPlaylistSongs("123456", "wyy", {
      kind: "new",
      name: "  我的开车歌单  ",
    });

    expect(ipc.createPlaylist).toHaveBeenCalledWith("我的开车歌单");
  });

  it("选现有歌单：不再新建，直接往目标整单拷入", async () => {
    vi.mocked(sourceApi.getPlaylistDetail).mockResolvedValue(detail());
    vi.mocked(ipc.addTracksToPlaylist).mockResolvedValue(1);

    const res = await importPlaylistSongs(
      "https://music.163.com/#/playlist?id=123456",
      undefined,
      { kind: "existing", id: "pid-old", name: "已有的歌单" },
    );

    expect(ipc.createPlaylist).not.toHaveBeenCalled();
    expect(ipc.addTracksToPlaylist).toHaveBeenCalledWith("pid-old", expect.anything());
    expect(res.targetName).toBe("已有的歌单");
    expect(res.added).toBe(1);
  });

  it("歌单没有可导入的歌曲 → 明确报错", async () => {
    vi.mocked(sourceApi.getPlaylistDetail).mockResolvedValue(detail({ tracks: [] }));

    await expect(
      importPlaylistSongs("123456", "wyy", { kind: "new" }),
    ).rejects.toThrow("该歌单不存在或没有可导入的歌曲");
    expect(ipc.createPlaylist).not.toHaveBeenCalled();
  });

  it("输入无法识别 → 明确报错", async () => {
    await expect(
      importPlaylistSongs("随便一段话", undefined, { kind: "new" }),
    ).rejects.toThrow("无法识别歌单链接或 ID");
    expect(sourceApi.getPlaylistDetail).not.toHaveBeenCalled();
  });
});

describe("parsePlaylistInput 四源链接识别", () => {
  it("网易云：网页链接与分享文案都能解析", () => {
    expect(parsePlaylistInput("https://music.163.com/#/playlist?id=123456")).toEqual({
      platform: "wyy",
      id: "123456",
    });
    expect(
      parsePlaylistInput("分享歌单《夜曲》https://music.163.com/playlist?id=888（@网易云音乐）"),
    ).toEqual({ platform: "wyy", id: "888" });
  });

  it("QQ音乐：y.qq.com 歌单链接取数字 id", () => {
    expect(parsePlaylistInput("https://y.qq.com/n/ryqq/playlist/7011264340")).toEqual({
      platform: "qq",
      id: "7011264340",
    });
  });

  it("酷我：kuwo.cn 链接取数字 id", () => {
    expect(
      parsePlaylistInput("https://www.kuwo.cn/playlist_detail/3197157406?share=1"),
    ).toEqual({ platform: "kw", id: "3197157406" });
  });

  it("酷狗：网页歌单链接的 .html 去掉，还原成数字 id", () => {
    expect(
      parsePlaylistInput("https://www.kugou.com/yy/special/single/1234567.html"),
    ).toEqual({ platform: "kg", id: "1234567" });
  });

  it("酷狗：分享短码（含字母）原样交给 chain 接口", () => {
    expect(parsePlaylistInput("https://t1.kugou.com/tJnW20zxV3")).toEqual({
      platform: "kg",
      id: "tJnW20zxV3",
    });
    // 分享文案里短码后紧跟中文括号
    expect(
      parsePlaylistInput("分享歌单《测试》https://t1.kugou.com/tJnW20zxV3（@酷狗音乐）"),
    ).toEqual({ platform: "kg", id: "tJnW20zxV3" });
  });

  it("酷狗：collection_/gcid_ 原生 ID 整段识别", () => {
    expect(parsePlaylistInput("collection_3_1234567890_2_0")).toEqual({
      platform: "kg",
      id: "collection_3_1234567890_2_0",
    });
    expect(parsePlaylistInput("gcid_3za1lw0n2y4z0")).toEqual({
      platform: "kg",
      id: "gcid_3za1lw0n2y4z0",
    });
  });
});

describe("parsePlaylistInput 裸 ID 与失败分支", () => {
  it("纯数字 ID + 指定平台 → 该平台", () => {
    expect(parsePlaylistInput("123456789", "qq")).toEqual({
      platform: "qq",
      id: "123456789",
    });
    expect(parsePlaylistInput("  3197157406  ", "kw")).toEqual({
      platform: "kw",
      id: "3197157406",
    });
  });

  it("纯数字 ID 未指定平台 → 无法识别", () => {
    expect(parsePlaylistInput("123456789")).toBeNull();
  });

  it("指定酷狗时裸分享短码可用", () => {
    expect(parsePlaylistInput("tJnW20zxV3", "kg")).toEqual({
      platform: "kg",
      id: "tJnW20zxV3",
    });
  });

  it("非音乐链接 / 空输入 → 无法识别", () => {
    expect(parsePlaylistInput("")).toBeNull();
    expect(parsePlaylistInput("   ")).toBeNull();
    expect(parsePlaylistInput("https://example.com/123456789")).toBeNull();
    expect(parsePlaylistInput("随便一段话")).toBeNull();
  });

  it("链接里的平台优先于指定的 fallback", () => {
    expect(parsePlaylistInput("https://y.qq.com/n/ryqq/playlist/7011264340", "kw")).toEqual({
      platform: "qq",
      id: "7011264340",
    });
  });
});

describe("解析辅助函数", () => {
  it("lastPathSegment 去掉查询/锚点/尾斜杠", () => {
    expect(lastPathSegment("https://a.com/x/abc123?p=1#h")).toBe("abc123");
    expect(lastPathSegment("https://a.com/x/abc123/")).toBe("abc123");
    expect(lastPathSegment("abc123")).toBe("");
  });

  it("extractLongestDigits 取最长连续数字段", () => {
    expect(extractLongestDigits("https://music.163.com/playlist?id=88&x=1234567")).toBe(
      "1234567",
    );
    expect(extractLongestDigits("no digits here")).toBe("");
  });
});
