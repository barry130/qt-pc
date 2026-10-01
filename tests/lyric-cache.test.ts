/**
 * 播放页歌词缓存（localOnline.getPlaybackLyric 的 LRU 层）：
 * 播放页一退出组件就卸载、歌词 state 全丢，缓存补在取词函数上。
 * 覆盖：命中不复取 / 失败不入缓存 / 并发合并 / cross 分键 / LRU 淘汰与命中刷新。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/source-scripts", () => ({
  getLyric: vi.fn(),
  searchMusic: vi.fn(),
  toAppTrack: vi.fn(),
}));

import { getLyric } from "@/source-scripts";
import { getPlaybackLyric, LYRIC_CACHE_CAP } from "@/lib/localOnline";
import type { Lyric, Track } from "@/types";

const getLyricMock = vi.mocked(getLyric);

let seq = 0;
function track(): Track {
  seq += 1;
  return {
    id: `id${seq}`,
    platform: "qq",
    title: `t${seq}`,
    singer: "singer",
    album: "",
    picUrl: "",
    duration: 100,
    musicId: null,
  };
}

const lyric = (lrc: string): Lyric => ({ lrc, translation: "" });

beforeEach(() => {
  getLyricMock.mockReset();
});

describe("getPlaybackLyric 缓存", () => {
  it("同一首命中缓存，只取一次词", async () => {
    const t = track();
    getLyricMock.mockResolvedValue(lyric("[00:01]hi"));
    await getPlaybackLyric(t);
    await getPlaybackLyric(t);
    expect(getLyricMock).toHaveBeenCalledTimes(1);
    expect(getLyricMock).toHaveBeenCalledWith(t);
  });

  it("空歌词（纯音乐）也算成功结果，同样缓存", async () => {
    const t = track();
    getLyricMock.mockResolvedValue(lyric(""));
    await getPlaybackLyric(t);
    await getPlaybackLyric(t);
    expect(getLyricMock).toHaveBeenCalledTimes(1);
  });

  it("失败不入缓存：下次重进重新取", async () => {
    const t = track();
    getLyricMock.mockRejectedValueOnce(new Error("network"));
    getLyricMock.mockResolvedValueOnce(lyric("[00:01]ok"));
    await expect(getPlaybackLyric(t)).rejects.toThrow("network");
    await expect(getPlaybackLyric(t)).resolves.toEqual(lyric("[00:01]ok"));
    expect(getLyricMock).toHaveBeenCalledTimes(2);
  });

  it("并发请求合并成一次取词", async () => {
    const t = track();
    let resolveLyric!: (v: Lyric) => void;
    getLyricMock.mockReturnValue(
      new Promise<Lyric>((resolve) => {
        resolveLyric = resolve;
      }),
    );
    const first = getPlaybackLyric(t);
    const second = getPlaybackLyric(t);
    resolveLyric(lyric("[00:01]once"));
    await Promise.all([first, second]);
    expect(getLyricMock).toHaveBeenCalledTimes(1);
  });

  it("换源兜底的 cross 是键的一部分：目标源不同则分别取词", async () => {
    const t = track();
    const crossSong: Track = { ...t, id: "crossSong", platform: "kw" };
    getLyricMock.mockResolvedValue(lyric("[00:01]kw"));
    await getPlaybackLyric(t);
    await getPlaybackLyric(t, { target: "kw", song: crossSong });
    expect(getLyricMock).toHaveBeenCalledTimes(2);
    expect(getLyricMock).toHaveBeenLastCalledWith(crossSong);
  });

  it("超出上限淘汰最旧的（LRU）", async () => {
    getLyricMock.mockResolvedValue(lyric("[00:01]x"));
    const first = track();
    await getPlaybackLyric(first);
    for (let i = 0; i < LYRIC_CACHE_CAP; i += 1) {
      await getPlaybackLyric(track());
    }
    // 最旧的 first 已被挤出去 → 重取
    await getPlaybackLyric(first);
    expect(getLyricMock).toHaveBeenCalledTimes(LYRIC_CACHE_CAP + 2);
  });

  it("命中会刷新 LRU 顺序：被点过的条目不会被新插入挤出", async () => {
    getLyricMock.mockResolvedValue(lyric("[00:01]x"));
    const touched = track();
    await getPlaybackLyric(touched);
    for (let i = 0; i < LYRIC_CACHE_CAP - 1; i += 1) {
      await getPlaybackLyric(track());
    }
    // touched 在最旧端，点一下刷新到最新端
    await getPlaybackLyric(touched);
    expect(getLyricMock).toHaveBeenCalledTimes(LYRIC_CACHE_CAP);
    // 再进一首把最旧的挤出去，被刷新过的 touched 应仍在缓存里
    await getPlaybackLyric(track());
    expect(getLyricMock).toHaveBeenCalledTimes(LYRIC_CACHE_CAP + 1);
    await getPlaybackLyric(touched);
    expect(getLyricMock).toHaveBeenCalledTimes(LYRIC_CACHE_CAP + 1);
  });
});
