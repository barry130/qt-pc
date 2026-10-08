// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

// jsdom 下无 Tauri internals，mock 掉 @tauri-apps/api 的窗口与事件入口
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({})),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn(async () => false),
    onResized: vi.fn(async () => vi.fn()),
    startDragging: vi.fn(),
    startResizeDragging: vi.fn(),
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));

// jsdom 未实现 matchMedia（useAppearanceEffect 的跟随系统模式需要）
if (typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

describe("App 冒烟", () => {
  it("RouterProvider 挂载后渲染出布局（标题栏 + 侧边栏 + 播放条）", async () => {
    const { default: App } = await import("@/App");
    const { container, unmount } = render(<App />);
    // 等待 router 就绪后的首次渲染。
    // 必须用 act 包住等待：React 19.2 的调度任务首行会读 window.event，若这次异步更新
    // 被留给真实调度器、而测试先结束时 jsdom 环境已拆除，就会抛
    // `ReferenceError: window is not defined`，让 vitest 记一个 unhandled error 并以退出码 1 结束。
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(container.innerHTML.length).toBeGreaterThan(0);
    expect(container.textContent).toContain("轻听");
    // 卸载并把残余任务在 act 里排空，不给环境留挂起的 React 工作
    unmount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  });
});
