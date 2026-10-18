// @vitest-environment jsdom
/**
 * 撤销 Toast（REQUIREMENTS §3.21.7.5「操作撤销」）。
 *
 * 口径：删除类操作**先做完再给一次后悔的机会**（`stores/toast.ts::toastUndo`），
 * 不弹二次确认。这里覆盖四件事：动作按钮渲染出来、点一下真的跑反向操作、
 * 连点只撤一次、反向操作失败必须转成红字（不能留下"看起来撤回了"的假象）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ToastHost } from "@/components/common/ToastHost";
import { toast, toastUndo, useToastStore } from "@/stores/toast";

/** 用例之间 store 是模块级单例，必须自己清干净，否则上一条会飘进下一个用例 */
const resetToasts = (): void => useToastStore.setState({ items: [] });

describe("撤销 Toast", () => {
  beforeEach(resetToasts);

  it("渲染出动作按钮，点一下执行反向操作并收掉提示", async () => {
    const undo = vi.fn(async () => undefined);
    render(<ToastHost />);
    toastUndo("已从「测试歌单」取消收藏 2 首", undo);

    expect(await screen.findByText("已从「测试歌单」取消收藏 2 首")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));

    await waitFor(() => expect(undo).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("已从「测试歌单」取消收藏 2 首")).toBeNull());
  });

  it("连点两下也只撤一次（同一 tick 内用 ref 拦）", async () => {
    const undo = vi.fn(async () => undefined);
    render(<ToastHost />);
    toastUndo("已从「测试歌单」取消收藏", undo);

    const btn = await screen.findByRole("button", { name: "撤销" });
    fireEvent.click(btn);
    fireEvent.click(btn);

    await waitFor(() => expect(undo).toHaveBeenCalledTimes(1));
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("反向操作失败 → 转红字错误提示，不假装撤回成功", async () => {
    const undo = vi.fn(async () => {
      throw new Error("歌单不存在");
    });
    render(<ToastHost />);
    toastUndo("已从「测试歌单」取消收藏", undo);

    fireEvent.click(await screen.findByRole("button", { name: "撤销" }));

    expect(await screen.findByText(/撤销失败：歌单不存在/)).toBeTruthy();
    // 原回执必须已经收掉：留着会让人以为还能再点一次
    await waitFor(() => expect(screen.queryByRole("button", { name: "撤销" })).toBeNull());
  });

  it("普通提示不带按钮（只有 toastUndo 才有撤销入口）", async () => {
    render(<ToastHost />);
    toast("已清空播放记录");

    expect(await screen.findByText("已清空播放记录")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
