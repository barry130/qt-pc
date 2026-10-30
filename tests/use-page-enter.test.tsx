// @vitest-environment jsdom
/**
 * 非常驻路由的入场容器类名（`usePageEnter`）。
 *
 * 为什么值得单独测：这层 div 夹在「内容区（h-full）」与「页面根节点（h-full）」之间，
 * 2026-10-29 只给了入场动画类、漏了 `h-full`，整条百分比高度链就断了 ——
 * 播放页歌词区 `h-full` 退化成 auto，`overflow-y-auto` 没有可滚动的量：
 * 滚轮无反应、自动跟随停在第一行；同时页面被撑到几千像素高，左侧唱片被
 * `items-center` 居中到视野之外（用户看到「封面没了」）。三个症状同一个根因。
 *
 * 所以这里钉住两条：① 类名里始终带 `h-full`；② 切路由时摘掉再挂回入场类
 * （元素复用，不摘就永远不重播动画）。
 */
import { describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { usePageEnter } from "@/hooks/usePageEnter";

describe("usePageEnter", () => {
  it("首次挂载就带 h-full + 入场类（高度必须透传）", () => {
    const { result } = renderHook(() => usePageEnter("/settings"));
    expect(result.current).toContain("h-full");
    expect(result.current).toContain("qt-page-enter");
  });

  it("换路由时先摘入场类再挂回，且 h-full 全程不丢", async () => {
    const { result, rerender } = renderHook(({ key }) => usePageEnter(key), {
      initialProps: { key: "/settings" },
    });
    rerender({ key: "/search" });
    // 摘掉类名的那一帧：高度照样要在，否则页面会闪一下 0 高
    expect(result.current).toContain("h-full");
    expect(result.current).not.toContain("qt-page-enter");
    await waitFor(() => expect(result.current).toContain("qt-page-enter"));
    expect(result.current).toContain("h-full");
  });
});
