/**
 * 无词时手动搜索歌词（lib/localOnline 的三个新导出）。
 *
 * 这条链路的意义是「自动取词拿不到词时的纠错出口」：自动链路只认当前源 /
 * 跨源兜底源的同一首歌，源站把词挂到别的版本上就只剩空词。所以这里重点钉住
 * 三件容易写错、写错了用户看不出原因的事：
 *   1. 候选里**不许出现空词**（选了等于没选，用户会以为功能坏了）；
 *   2. 选中后**必须刷播放页缓存**（不刷的话退出再进播放页命中的还是那条
 *      「暂无歌词」的旧 Promise，表现成「选了没用」）；
 *   3. 取词失败的剔除**只能剔自己那一条**，不能把用户刚选好的词一起抹掉。
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

import { getLyric, searchMusic } from "@/source-scripts";
import {
  applyPickedLyric,
  getPlaybackLyric,
  searchLyricCandidates,
  type LyricCandidate,
} from "@/lib/localOnline";
import type { Lyric, Track } from "@/types";

const getLyricMock = vi.mocked(getLyric);
const searchMusicMock = vi.mocked(searchMusic);

let seq = 0;
function track(platform = "qq"): Track {
  seq += 1;
  return {
    id: `id${seq}`,
    platform,
    title: `t${seq}`,
    singer: "singer",
    album: "album",
    picUrl: "",
    duration: 100,
    musicId: null,
  };
}

const lyric = (lrc: string, extra: Partial<Lyric> = {}): Lyric => ({
  lrc,
  translation: "",
  ...extra,
});

beforeEach(() => {
  getLyricMock.mockReset();
  searchMusicMock.mockReset();
  getLyricIpc.mockReset();
  saveLyricIpc.mockReset();
});

describe("searchLyricCandidates", () => {
  it("按「歌名 + 歌手」在第 1 页搜，只保留主词非空的候选", async () => {
    const empty = track();
    const withLyric = track();
    searchMusicMock.mockResolvedValueOnce([empty, withLyric]);
    getLyricMock.mockResolvedValueOnce(lyric("")); // 纯音乐 / 该版本源站没挂词
    getLyricMock.mockResolvedValueOnce(lyric("[00:01.00]有词"));

    const out = await searchLyricCandidates("歌名 歌手", "kw", 8);

    expect(searchMusicMock).toHaveBeenCalledWith("歌名 歌手", "kw", 1, 8);
    expect(out).toHaveLength(1);
    expect(out[0].track).toBe(withLyric);
    expect(out[0].source).toBe("kw");
    expect(out[0].lyric.lrc).toBe("[00:01.00]有词");
  });

  it("空白关键字直接返回空：不拿空串去打源站搜索", async () => {
    await expect(searchLyricCandidates("   ", "qq")).resolves.toEqual([]);
    expect(searchMusicMock).not.toHaveBeenCalled();
  });

  it("单个候选取词失败只跳过它自己，其余候选照常返回", async () => {
    const bad = track();
    const good = track();
    searchMusicMock.mockResolvedValueOnce([bad, good]);
    getLyricMock.mockRejectedValueOnce(new Error("boom"));
    getLyricMock.mockResolvedValueOnce(lyric("[00:01.00]好的"));

    const out = await searchLyricCandidates("x", "qq");
    expect(out.map((c) => c.track)).toEqual([good]);
  });

  it("逐字 / 罗马音随候选一起带回来（用户挑版本要看这个）", async () => {
    const t = track();
    searchMusicMock.mockResolvedValueOnce([t]);
    getLyricMock.mockResolvedValueOnce(
      lyric("[00:01.00]a", {
        wordByWord: "[1000,500]a(0,500)",
        romanization: "[00:01.00]a-romaji",
      }),
    );

    const out = await searchLyricCandidates("x", "wyy");
    expect(out[0].lyric.wordByWord).toBe("[1000,500]a(0,500)");
    expect(out[0].lyric.romanization).toBe("[00:01.00]a-romaji");
  });
});

describe("applyPickedLyric", () => {
  it("刷缓存：选完之后 getPlaybackLyric 直接命中，不再打网络", async () => {
    const t = track();
    // 先让自动链路取到空词并缓存（这正是需要手动纠错的场景）
    getLyricMock.mockResolvedValueOnce(lyric(""));
    await expect(getPlaybackLyric(t)).resolves.toEqual(lyric(""));
    expect(getLyricMock).toHaveBeenCalledTimes(1);

    const picked: LyricCandidate = {
      track: t,
      lyric: lyric("[00:01.00]手动选的", { wordByWord: "[1000,500]手动(0,500)" }),
      source: "kw",
    };
    await applyPickedLyric(t, null, picked);

    // 命中新缓存：一次网络都不该再打
    await expect(getPlaybackLyric(t)).resolves.toEqual(picked.lyric);
    expect(getLyricMock).toHaveBeenCalledTimes(1);
  });

  it("落库带 manual=true，来源记的是选中的那个源（不是当前曲目的源）", async () => {
    const t = track("qq");
    saveLyricIpc.mockResolvedValueOnce(undefined);
    await applyPickedLyric(t, null, {
      track: t,
      lyric: lyric("[00:01.00]词", { translation: "译文", romanization: "[00:01.00]ci" }),
      source: "kw",
    });

    // 最后一个参数 true = 手动标记：取词链路（含桌面歌词窗口那份）此后直接回读它，
    // 不再回源站重取 —— 不写这个标记，用户的选择会被下一次自动取词静默覆盖。
    expect(saveLyricIpc).toHaveBeenCalledWith(
      `qq:${t.id}`,
      "[00:01.00]词",
      "",
      "译文",
      "[00:01.00]ci",
      "kw",
      true,
    );
  });

  it("落库失败不影响缓存生效（歌词是锦上添花，不该打断播放页）", async () => {
    const t = track();
    saveLyricIpc.mockRejectedValueOnce(new Error("no ipc"));
    const picked: LyricCandidate = { track: t, lyric: lyric("[00:01.00]词"), source: "qq" };

    await expect(applyPickedLyric(t, null, picked)).resolves.toBeUndefined();
    await expect(getPlaybackLyric(t)).resolves.toEqual(picked.lyric);
  });

  it("换源兜底在播时按 cross 键刷缓存：与播放页取词的键口径一致", async () => {
    const t = track("qq");
    const crossSong: Track = { ...t, id: "crossSong", platform: "kw" };
    const cross = { target: "kw" as const, song: crossSong };
    getLyricMock.mockResolvedValue(lyric("[00:01.00]kw 的旧词"));
    await getPlaybackLyric(t, cross);

    const picked: LyricCandidate = { track: t, lyric: lyric("[00:01.00]手动选的"), source: "kg" };
    await applyPickedLyric(t, cross, picked);

    await expect(getPlaybackLyric(t, cross)).resolves.toEqual(picked.lyric);
    expect(getLyricMock).toHaveBeenCalledTimes(1);
  });
});

describe("取词失败的剔除只针对自己那一条", () => {
  it("在飞请求失败时不会把用户刚选好的词抹掉", async () => {
    const t = track();
    let rejectLyric!: (err: Error) => void;
    getLyricMock.mockReturnValueOnce(
      new Promise<Lyric>((_resolve, reject) => {
        rejectLyric = reject;
      }),
    );

    const inflight = getPlaybackLyric(t);
    // 用户等不及自动取词，手动选了词（同键写入新条目）
    const picked: LyricCandidate = { track: t, lyric: lyric("[00:01.00]手动选的"), source: "kw" };
    await applyPickedLyric(t, null, picked);

    // 之后自动取词才失败：只该剔掉自己，不该动用户选的那条
    rejectLyric(new Error("network"));
    await expect(inflight).rejects.toThrow("network");
    await expect(getPlaybackLyric(t)).resolves.toEqual(picked.lyric);
    expect(getLyricMock).toHaveBeenCalledTimes(1);
  });
});
