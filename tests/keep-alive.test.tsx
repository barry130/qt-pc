// @vitest-environment jsdom
/**
 * 一级页面 keep-alive 回归（2026-09-18）：
 * 切侧边栏 tab 不再整页重载——旧页只被隐藏，组件实例、已加载数据与本地状态
 * （如歌单广场的分类筛选）都保留，切回来不重新拉接口。
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  categories: 0,
  recommendations: 0,
  lastCategory: null as string | null,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));
vi.mock("@/source-scripts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/source-scripts")>()),
  getPlaylistCategories: async () => {
    api.categories += 1;
    return [
      { id: "rock", name: "摇滚", group: null },
      { id: "pop", name: "流行", group: null },
    ];
  },
  getRecommendations: async (_source: string, category: string | null) => {
    api.recommendations += 1;
    api.lastCategory = category;
    return [
      { id: "p1", platform: "wyy", name: "歌单甲", picUrl: "", playCount: "12" },
    ];
  },
}));

// jsdom 未实现 IntersectionObserver（歌单广场的滚到底加载用它）
if (typeof globalThis.IntersectionObserver !== "function") {
  class NoopIntersectionObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return [];
    }
  }
  Object.defineProperty(globalThis, "IntersectionObserver", {
    writable: true,
    value: NoopIntersectionObserver,
  });
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

function chip(container: HTMLElement, label: string): HTMLElement {
  const hit = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  );
  if (!hit) throw new Error(`未找到分类 chip：${label}`);
  return hit;
}

describe("一级页面 keep-alive", () => {
  it("切 tab 保留数据与分类：回到歌单广场仍是原分类，且不重新拉接口", async () => {
    const { KeepAliveOutlet } = await import("@/components/layout/KeepAliveOutlet");
    const { container, rerender } = render(<KeepAliveOutlet pathname="/playlists" />);
    // 一级页面本身是懒加载的（lib/lazyPage）：首帧先是 Suspense 占位，
    // 对应 chunk 到位后才是真实页面。这里必须等它出现，不能只等固定时长。
    await waitFor(() => expect(container.textContent).toContain("歌单广场"));
    await flush();

    expect(api.categories).toBe(1);

    // 切到「摇滚」
    fireEvent.click(chip(container, "摇滚"));
    await flush();
    expect(api.lastCategory).toBe("rock");
    expect(chip(container, "摇滚").getAttribute("aria-pressed")).toBe("true");

    const headingBefore = container.querySelector("h1");
    const categoriesBefore = api.categories;

    // 切到首页：歌单广场仍在 DOM 里（只是隐藏），组件实例没被销毁
    rerender(<KeepAliveOutlet pathname="/" />);
    // 首页同样懒加载：先等它真的渲染出来，再取推荐次数基线，
    // 否则它的加载会在下面的断言之间完成、把计数改掉
    await waitFor(() => expect(container.textContent).toContain("发现音乐"));
    await flush();
    expect(container.textContent).toContain("歌单广场");
    expect(headingBefore?.isConnected).toBe(true);
    expect(headingBefore?.closest("div[aria-hidden='true']")).not.toBeNull();
    // 首页自己会拉一次推荐（走同一个 mock），以切换后的计数为新基线
    const recommendationsAfterHome = api.recommendations;

    // 切回歌单广场：同一个 DOM 节点（= 同一个组件实例），分类与列表都还在
    rerender(<KeepAliveOutlet pathname="/playlists" />);
    await flush();
    expect(container.querySelector("h1")).toBe(headingBefore);
    expect(chip(container, "摇滚").getAttribute("aria-pressed")).toBe("true");
    expect(api.categories).toBe(categoriesBefore);
    expect(api.recommendations).toBe(recommendationsAfterHome);
  });

  it("只有一级列表页常驻：详情/搜索/设置不参与缓存", async () => {
    const { isKeepAlivePath } = await import("@/components/layout/KeepAliveOutlet");
    for (const path of ["/", "/playlists", "/charts", "/library/folders"]) {
      expect(isKeepAlivePath(path), path).toBe(true);
    }
    for (const path of [
      "/search",
      "/playlist/wyy/1",
      "/chart/wyy/1",
      "/settings/playback",
      "/playing",
    ]) {
      expect(isKeepAlivePath(path), path).toBe(false);
    }
  });
});
