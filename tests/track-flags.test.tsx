// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/types";

const mocks = vi.hoisted(() => ({ favorite: vi.fn(), dislike: vi.fn() }));
vi.mock("@/services/ipc", () => ({
  checkFavoriteFlags: mocks.favorite,
  checkDisliked: mocks.dislike,
}));
import { useFavoriteFlags } from "@/hooks/useFavoriteFlags";
import { useDislikeFlags } from "@/hooks/useDislikeFlags";

function song(id: string, platform = "qq", title = id, singer = "Singer"): Track {
  return { id, platform, title, singer, album: "", picUrl: "", duration: 180 };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  mocks.favorite.mockReset().mockImplementation(async (tracks: Track[]) => tracks.map(() => false));
  mocks.dislike.mockReset().mockImplementation(async (tracks: Track[]) => tracks.map(() => false));
});

describe("列表批量状态关联与缓存", () => {
  it("同长度换列表的第一帧不沿用旧下标，迟到查询不会覆盖新曲目", async () => {
    const a = song("a");
    const b = song("b");
    const old = deferred<boolean[]>();
    const fresh = deferred<boolean[]>();
    mocks.favorite.mockResolvedValueOnce([true]).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const { result, rerender } = renderHook(({ tracks }) => useFavoriteFlags(tracks, 0), { initialProps: { tracks: [a] } });
    await waitFor(() => expect(result.current).toEqual([true]));
    rerender({ tracks: [b] });
    expect(result.current).toEqual([false]);
    await waitFor(() => expect(mocks.favorite).toHaveBeenCalledTimes(2));
    rerender({ tracks: [song("c")] });
    await waitFor(() => expect(mocks.favorite).toHaveBeenCalledTimes(3));
    await act(async () => { fresh.resolve([true]); });
    expect(result.current).toEqual([true]);
    await act(async () => { old.resolve([false]); });
    expect(result.current).toEqual([true]);
  });

  it("搜索、重排、清空再恢复复用缓存，分页只请求新增项", async () => {
    const a = song("a");
    const b = song("b");
    const c = song("c");
    mocks.favorite.mockResolvedValueOnce([true, false]).mockResolvedValueOnce([true]);
    const { result, rerender } = renderHook(({ tracks }) => useFavoriteFlags(tracks, 0), { initialProps: { tracks: [a, b] } });
    await waitFor(() => expect(result.current).toEqual([true, false]));
    rerender({ tracks: [b] });
    expect(result.current).toEqual([false]);
    rerender({ tracks: [] });
    expect(result.current).toEqual([]);
    rerender({ tracks: [{ ...b }, { ...a }] });
    expect(result.current).toEqual([false, true]);
    await act(async () => {});
    expect(mocks.favorite).toHaveBeenCalledTimes(1);
    rerender({ tracks: [b, a, c] });
    await waitFor(() => expect(result.current).toEqual([false, true, true]));
    expect(mocks.favorite).toHaveBeenLastCalledWith([c]);
  });

  it("收藏使用平台+id，重复行合并请求但保留每行结果", async () => {
    const qq = song("same");
    const wyy = song("same", "wyy");
    mocks.favorite.mockResolvedValue([true, false]);
    const { result } = renderHook(() => useFavoriteFlags([qq, { ...qq }, wyy], 0));
    await waitFor(() => expect(result.current).toEqual([true, true, false]));
    expect(mocks.favorite).toHaveBeenCalledTimes(1);
    expect(mocks.favorite).toHaveBeenCalledWith([qq, wyy]);
  });

  it("屏蔽键包含歌名歌手，同 id 元数据补全后重新查，其他元数据不重查", async () => {
    const a = song("a", "qq", "旧歌名");
    const next = { ...a, title: "新歌名" };
    mocks.dislike.mockResolvedValueOnce([true]).mockResolvedValueOnce([false]);
    const { result, rerender } = renderHook(({ tracks }) => useDislikeFlags(tracks, 0), { initialProps: { tracks: [a] } });
    await waitFor(() => expect(result.current).toEqual([true]));
    rerender({ tracks: [{ ...a, picUrl: "cover" }] });
    await act(async () => {});
    expect(mocks.dislike).toHaveBeenCalledTimes(1);
    rerender({ tracks: [next] });
    expect(result.current).toEqual([false]);
    await waitFor(() => expect(mocks.dislike).toHaveBeenCalledTimes(2));
    expect(mocks.dislike).toHaveBeenLastCalledWith([next]);
  });

  it("规则版本变化立即隐藏旧结果，旧版本迟到回执不污染新版本", async () => {
    const a = song("a");
    const initial = deferred<boolean[]>();
    const latest = deferred<boolean[]>();
    mocks.favorite.mockReturnValueOnce(initial.promise).mockReturnValueOnce(latest.promise);
    const { result, rerender } = renderHook(({ version }) => useFavoriteFlags([a], version), { initialProps: { version: 0 } });
    await waitFor(() => expect(mocks.favorite).toHaveBeenCalledTimes(1));
    rerender({ version: 1 });
    await waitFor(() => expect(mocks.favorite).toHaveBeenCalledTimes(2));
    await act(async () => { latest.resolve([false]); initial.resolve([true]); });
    expect(result.current).toEqual([false]);
    rerender({ version: 1 });
    await act(async () => {});
    expect(mocks.favorite).toHaveBeenCalledTimes(2);
  });

  it("已完成版本失效同样清空高亮并重新查询", async () => {
    const a = song("a");
    const pending = deferred<boolean[]>();
    mocks.dislike.mockResolvedValueOnce([true]).mockReturnValueOnce(pending.promise);
    const { result, rerender } = renderHook(({ version }) => useDislikeFlags([a], version), { initialProps: { version: 0 } });
    await waitFor(() => expect(result.current).toEqual([true]));
    rerender({ version: 1 });
    expect(result.current).toEqual([false]);
    await act(async () => { pending.resolve([false]); });
    expect(result.current).toEqual([false]);
  });

  it("进行中重排共享同一请求，StrictMode 重挂 effect 不重复 IPC", async () => {
    const a = song("a");
    const b = song("b");
    const pending = deferred<boolean[]>();
    mocks.favorite.mockReturnValue(pending.promise);
    const { result, rerender } = renderHook(({ tracks }) => useFavoriteFlags(tracks, 0), {
      initialProps: { tracks: [a, b] },
      wrapper: StrictMode,
    });
    await waitFor(() => expect(mocks.favorite).toHaveBeenCalledTimes(1));
    rerender({ tracks: [b, a] });
    await act(async () => { pending.resolve([true, false]); });
    expect(result.current).toEqual([false, true]);
    expect(mocks.favorite).toHaveBeenCalledTimes(1);
  });

  it.each(["rejected", "short", "not-boolean"])("异常响应 %s 降级且不会缓存错误结果", async (kind) => {
    const a = song("a");
    if (kind === "rejected") mocks.favorite.mockRejectedValueOnce(new Error("offline"));
    else mocks.favorite.mockResolvedValueOnce(kind === "short" ? [] : ["yes"]);
    mocks.favorite.mockResolvedValueOnce([true]);
    const { result, rerender } = renderHook(({ tracks }) => useFavoriteFlags(tracks, 0), { initialProps: { tracks: [a] } });
    await act(async () => {});
    expect(result.current).toEqual([false]);
    rerender({ tracks: [{ ...a }] });
    await waitFor(() => expect(result.current).toEqual([true]));
    expect(mocks.favorite).toHaveBeenCalledTimes(2);
  });

  it("超长列表全量展示，缩小后淘汰多余旧缓存并保留当前项", async () => {
    const tracks = Array.from({ length: 4100 }, (_, index) => song(String(index)));
    mocks.favorite.mockImplementation(async (items: Track[]) => items.map(() => true));
    const { result, rerender } = renderHook(({ items }) => useFavoriteFlags(items, 0), { initialProps: { items: tracks } });
    await waitFor(() => expect(result.current.filter(Boolean)).toHaveLength(4100));
    rerender({ items: [tracks[4099]] });
    await act(async () => {});
    expect(mocks.favorite).toHaveBeenCalledTimes(1);
    rerender({ items: [tracks[0], tracks[4099]] });
    await waitFor(() => expect(mocks.favorite).toHaveBeenCalledTimes(2));
    expect(mocks.favorite).toHaveBeenLastCalledWith([tracks[0]]);
    await waitFor(() => expect(result.current).toEqual([true, true]));
  });

  it("空列表不请求，卸载后迟到响应无副作用", async () => {
    const pending = deferred<boolean[]>();
    mocks.dislike.mockReturnValueOnce(pending.promise);
    const { rerender, unmount } = renderHook(({ tracks }) => useDislikeFlags(tracks, 0), { initialProps: { tracks: [] as Track[] } });
    expect(mocks.dislike).not.toHaveBeenCalled();
    rerender({ tracks: [song("a")] });
    await waitFor(() => expect(mocks.dislike).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => { pending.resolve([true]); });
  });
});
