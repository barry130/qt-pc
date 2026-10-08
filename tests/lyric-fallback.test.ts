/**
 * 歌词的网络失败兜底：取词抛错时回读上一次落库的正文。
 *
 * 这条语义以前不存在（歌词只在内存 LRU 里，进程退出即丢），所以是新增行为，
 * 单独一个文件测 —— 原 lyric-cache.test.ts 只 mock 了 `@/source-scripts`，
 * 这里的 mock 清单不同（还要挡住 `@/services/ipc`，否则 invoke 会同步抛）。
 *
 * 覆盖：网络失败回读、库里没有 manual 标记时不拦网络（自动取的词该重取就重取）、
 * 手动挑过的词直接回读且不打源站（详见「manual 标记」那组）、本地曲目连 IPC 都不碰
 * （它那条补全链路自带吞错、返回空词，且本地文件不写 tracks，查了也没用）、
 * 库里也是空 / 也没有时仍然抛出（页面照旧显示「暂无歌词」）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getLyricIpc = vi.fn();
const saveLyricIpc = vi.fn();

vi.mock("@/source-scripts", () => ({
  getLyric: vi.fn(),
  searchMusic: vi.fn(),
  toAppTrack: vi.fn(),
}));
vi.mock("@/services/ipc", () => ({
  getLyric: (...args: unknown[]) => getLyricIpc(...(args as [])),
  saveLyric: (...args: unknown[]) => saveLyricIpc(...(args as [])),
}));

import { getLyric } from "@/source-scripts";
import { getPlaybackLyric } from "@/lib/localOnline";
import type { Lyric, Track } from "@/types";

const getLyricMock = vi.mocked(getLyric);

let seq = 0;
function track(platform = "qq"): Track {
  seq += 1;
  return {
    id: `id${seq}`,
    platform,
    title: `t${seq}`,
    singer: "singer",
    album: "",
    picUrl: "",
    duration: 100,
    musicId: null,
  };
}

// 回读现在带逐字/罗马音（落库就有这两列，老库行 Rust 侧统一落成空串），
// 所以库值要给全 4 个字段 —— readSavedLyric 原样返回它们
const SAVED: Lyric = {
  lrc: "[00:01.00]库里的旧词",
  translation: "",
  wordByWord: "",
  romanization: "",
};

beforeEach(() => {
  getLyricMock.mockReset();
  getLyricIpc.mockReset();
  saveLyricIpc.mockReset();
});

describe("取词失败回读落库歌词", () => {
  it("网络失败时用库里的旧词顶上，且键是 platform:id", async () => {
    const t = track();
    getLyricMock.mockRejectedValueOnce(new Error("network"));
    getLyricIpc.mockResolvedValueOnce(SAVED);

    await expect(getPlaybackLyric(t)).resolves.toEqual(SAVED);
    expect(getLyricIpc).toHaveBeenCalledTimes(1);
    expect(getLyricIpc).toHaveBeenCalledWith(`qq:${t.id}`);
  });

  it("网络成功时照旧打源站：库里那行没有 manual 标记就不拦", async () => {
    const t = track();
    getLyricIpc.mockResolvedValueOnce({ ...SAVED, source: "qq", manual: false });
    getLyricMock.mockResolvedValueOnce({ lrc: "[00:01.00]新词", translation: "" });

    await expect(getPlaybackLyric(t)).resolves.toEqual({
      lrc: "[00:01.00]新词",
      translation: "",
    });
    expect(getLyricMock).toHaveBeenCalledTimes(1);
    expect(saveLyricIpc).toHaveBeenCalledTimes(1);
  });

  it("库里存的是手动挑的词时直接回读，连源站都不打", async () => {
    const t = track();
    getLyricIpc.mockResolvedValueOnce({
      lrc: "[00:01.00]手动挑的词",
      translation: "译文",
      wordByWord: "[1000,500]a(0,500)",
      romanization: "",
      source: "kg",
      manual: true,
    });
    getLyricMock.mockResolvedValueOnce({ lrc: "[00:01.00]源站的词", translation: "" });

    // 拿回的是库里那份手动挑的，源站那份没机会覆盖它
    await expect(getPlaybackLyric(t)).resolves.toEqual({
      lrc: "[00:01.00]手动挑的词",
      translation: "译文",
      wordByWord: "[1000,500]a(0,500)",
      romanization: "",
    });
    expect(getLyricMock).not.toHaveBeenCalled();
    expect(saveLyricIpc).not.toHaveBeenCalled();
  });

  it("本地曲目不走兜底：补全链路自带吞错（返回空词），也不会去查库", async () => {
    const local = track("local");
    getLyricMock.mockRejectedValueOnce(new Error("no match"));

    // 注意 reconcileLocalOnlineMeta 自己把异常吞成 EMPTY，这里拿到的是空词而非抛出
    await expect(getPlaybackLyric(local)).resolves.toEqual({ lrc: "", translation: "" });
    expect(getLyricIpc).not.toHaveBeenCalled();
  });

  it("库里也没有时照旧抛出：页面显示「暂无歌词」而不是静默吞错", async () => {
    const t = track();
    getLyricMock.mockRejectedValueOnce(new Error("network"));
    getLyricIpc.mockResolvedValueOnce(null);

    await expect(getPlaybackLyric(t)).rejects.toThrow("network");
  });

  it("库里存的空词不算命中（取信 skew 出来的空值不该顶掉占位）", async () => {
    const t = track();
    getLyricMock.mockRejectedValueOnce(new Error("network"));
    getLyricIpc.mockResolvedValueOnce({ lrc: "   ", translation: "", source: "qq" });

    await expect(getPlaybackLyric(t)).rejects.toThrow("network");
  });
});
