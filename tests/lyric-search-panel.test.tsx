// @vitest-environment jsdom
/**
 * 播放页「搜索歌词」弹层（LyricSearchButton，用户 m09160：方案同换源一样）。
 *
 * 钉住三件容易写错、写错了用户只觉得「这功能不好用」的事：
 *   1. **同一首歌只搜一次**：播放心跳每次快照都造一个字段全等的新 track 对象，
 *      依赖写错就是无限重搜（换源面板踩过同一个坑）；
 *   2. **关掉再打开用缓存**：不闪「正在搜索歌词…」，也不再打网络；
 *   3. **换歌后搜的是新歌**：关键字必须跟着新曲目走，不能拿上一首的歌名去搜。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const searchMusic = vi.hoisted(() => vi.fn(async (_kw?: unknown, _src?: unknown, _p?: unknown, _s?: unknown): Promise<unknown[]> => []));
const getLyric = vi.hoisted(() => vi.fn(async (_t?: unknown): Promise<{ lrc: string; translation: string }> => ({ lrc: "", translation: "" })));
// 弹层挂载会 ensure 音源注册表（stores/sourceRegistry），它也要走这个模块的入口
const getSourceRegistry = vi.hoisted(() => vi.fn(async () => null));
vi.mock("@/source-scripts", () => ({
  searchMusic,
  getLyric,
  getSourceRegistry,
  DEFAULT_SEARCH_PAGE_MAX: 30,
}));

import { LyricSearchButton } from "@/components/lyric/LyricSearchButton";
import { clearLyricCandidateCache } from "@/lib/localOnline";
import type { Track } from "@/types";

function track(id = "1", title = "稻香"): Track {
  return {
    id,
    platform: "qq",
    title,
    singer: "周杰伦",
    album: "",
    picUrl: "",
    duration: 0,
    musicId: null,
  };
}

function candidate(id: string, title: string): Track {
  return { ...track(id, title) };
}

/** 让一次搜索返回「带词」的候选（searchLyricCandidates 只留主词非空的） */
function mockSearch(rows: Track[]): void {
  searchMusic.mockResolvedValueOnce(rows);
  for (const _row of rows) {
    getLyric.mockResolvedValueOnce({ lrc: "[00:01.00]有词", translation: "" });
  }
}

describe("搜索歌词弹层：同一首歌只搜一次", () => {
  beforeEach(() => {
    searchMusic.mockReset();
    getLyric.mockReset();
    clearLyricCandidateCache(); // 缓存是模块级单例，测试间必须隔离
  });
  afterEach(() => {
    cleanup(); // 不清理的话上一个用例的弹层还在，getByText 会撞到多个「重新搜索」
  });

  it("track 换成字段全等的新对象时不重新搜索", async () => {
    mockSearch([candidate("c1", "稻香")]);
    const t1 = track();
    const { rerender } = render(
      <LyricSearchButton track={t1} cross={null} open onOpenChange={() => {}} onPicked={() => {}} />,
    );
    await waitFor(() => expect(searchMusic.mock.calls.length).toBe(1));
    // 心跳快照：字段一致但引用不同
    rerender(
      <LyricSearchButton
        track={{ ...t1 }}
        cross={null}
        open
        onOpenChange={() => {}}
        onPicked={() => {}}
      />,
    );
    rerender(
      <LyricSearchButton
        track={{ ...t1 }}
        cross={null}
        open
        onOpenChange={() => {}}
        onPicked={() => {}}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(searchMusic.mock.calls.length).toBe(1);
  });

  it("真的换歌（platform:id 变了）才重新搜索，且搜的是新歌名", async () => {
    mockSearch([candidate("c1", "稻香")]);
    const { rerender } = render(
      <LyricSearchButton
        track={track("1")}
        cross={null}
        open
        onOpenChange={() => {}}
        onPicked={() => {}}
      />,
    );
    await waitFor(() => expect(searchMusic.mock.calls.length).toBe(1));
    expect(searchMusic.mock.calls[0][0]).toBe("稻香 周杰伦");

    mockSearch([candidate("c2", "晴天")]);
    rerender(
      <LyricSearchButton
        track={track("2", "晴天")}
        cross={null}
        open
        onOpenChange={() => {}}
        onPicked={() => {}}
      />,
    );
    await waitFor(() => expect(searchMusic.mock.calls.length).toBe(2));
    // 换歌后关键字跟着换：拿上一首的歌名去搜是本功能最容易出、也最难发现的错误
    expect(searchMusic.mock.calls[1][0]).toBe("晴天 周杰伦");
  });

  // 缓存是进程内的，所以「重新挂载」就是用户关掉弹层再打开的真实路径
  it("关掉再打开同一个弹层直接用缓存，不再搜索", async () => {
    mockSearch([candidate("c1", "稻香")]);
    const t1 = track();
    const first = render(
      <LyricSearchButton track={t1} cross={null} open onOpenChange={() => {}} onPicked={() => {}} />,
    );
    await waitFor(() => expect(searchMusic.mock.calls.length).toBe(1));
    first.unmount();

    const second = render(
      <LyricSearchButton
        track={{ ...t1 }}
        cross={null}
        open
        onOpenChange={() => {}}
        onPicked={() => {}}
      />,
    );
    // 同步命中缓存：不该出现「正在搜索歌词…」
    expect(second.container.textContent).not.toContain("正在搜索歌词");
    await new Promise((r) => setTimeout(r, 20));
    expect(searchMusic.mock.calls.length).toBe(1);
  });

  it("点「重新搜索」才真正重跑一次", async () => {
    mockSearch([candidate("c1", "稻香")]);
    const { getByText } = render(
      <LyricSearchButton
        track={track()}
        cross={null}
        open
        onOpenChange={() => {}}
        onPicked={() => {}}
      />,
    );
    await waitFor(() => expect(searchMusic.mock.calls.length).toBe(1));
    mockSearch([candidate("c9", "稻香")]);
    fireEvent.click(getByText("重新搜索"));
    await waitFor(() => expect(searchMusic.mock.calls.length).toBe(2));
  });

  it("没搜到带词的候选时给可操作的空态文案", async () => {
    searchMusic.mockResolvedValueOnce([candidate("c1", "稻香")]);
    getLyric.mockResolvedValueOnce({ lrc: "  ", translation: "" }); // 纯音乐/该版本没挂词
    const { container } = render(
      <LyricSearchButton
        track={track()}
        cross={null}
        open
        onOpenChange={() => {}}
        onPicked={() => {}}
      />,
    );
    await waitFor(() =>
      expect(container.textContent).toContain("没有找到带歌词的结果"),
    );
  });
});
