// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

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
    const { container } = render(<App />);
    // 等待 router 就绪后的首次渲染
    await new Promise((r) => setTimeout(r, 50));
    expect(container.innerHTML.length).toBeGreaterThan(0);
    expect(container.textContent).toContain("轻听");
  });
});
