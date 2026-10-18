// @vitest-environment jsdom
/**
 * 接线检查：`App` 确实给桌面歌词窗口开了自愈（2026-10-12）。
 *
 * 上面那组用例锁的是 ErrorBoundary 自身的 autoReset 行为；这里锁的是**它被接上了**。
 * 两者缺一不可 —— 边界写得再好，忘了在 App 里传 `autoReset` 也等于没做，而这正是
 * 用户报的场景（歌词窗整块变错误卡片且永不自愈）。
 *
 * 用假的 LyricWindow 抛错来驱动：真组件现在不会在渲染期抛了（越界已修），
 * 但边界要防的是「以后别的地方又抛」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  label: "lyrics",
  /** 让歌词组件在渲染期抛错（只有渲染期抛才会被错误边界接住） */
  boom: { on: true },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: h.label }),
}));

// App 的歌词分支不碰路由；主窗口分支才用得到。真实的 RouterProvider 需要一整套
// 路由上下文（这里只关心分流有没有写反），所以换成能看出「走的是主窗口分支」的桩。
vi.mock("@/lib/router", () => ({ router: {} }));
vi.mock("@tanstack/react-router", () => ({
  RouterProvider: (): React.JSX.Element => <div data-testid="router">主窗口路由</div>,
}));

vi.mock("@/components/lyric/LyricWindow", () => ({
  LyricWindow: (): React.JSX.Element => {
    if (h.boom.on) throw new Error("歌词窗口炸了");
    return <div data-testid="lyric-ok">歌词正常</div>;
  },
}));

vi.mock("@/services/ipc", () => ({
  setSetting: vi.fn(async () => {}),
  writeLog: vi.fn(async () => {}),
}));

import App from "@/App";

beforeEach(() => {
  vi.useFakeTimers();
  h.label = "lyrics";
  h.boom.on = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("桌面歌词窗口的自愈接线", () => {
  it("歌词窗崩掉后自动重试，故障消失即恢复（不再永久停在错误卡片）", async () => {
    await act(async () => { render(<App />); await vi.dynamicImportSettled(); });
    expect(screen.queryByText(/这块内容出错了/)).toBeTruthy();

    // 故障消失（真实场景：越界的那一帧过去了 / 数据到了）
    h.boom.on = false;
    await act(async () => {
      vi.advanceTimersByTime(1500);
      await Promise.resolve();
    });

    expect(screen.queryByText(/这块内容出错了/)).toBeNull();
    expect(screen.getByTestId("lyric-ok")).toBeTruthy();
  });

  it("主窗口分支不进歌词视图（按 label 分流没被写反）", async () => {
    vi.useRealTimers();
    h.label = "main";
    await act(async () => { render(<App />); await vi.dynamicImportSettled(); });
    expect(await screen.findByTestId("router")).toBeTruthy();
    // 歌词视图若被误渲染，会因 boom 抛错、并被歌词窗的边界接住 —— 两者都不该出现
    expect(screen.queryByTestId("lyric-ok")).toBeNull();
    expect(screen.queryByText(/这块内容出错了/)).toBeNull();
  });
});