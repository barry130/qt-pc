// @vitest-environment jsdom
/**
 * 一级页面 keep-alive 回归（2026-09-18）：
 * 切侧边栏 tab 不再整页重载——旧页只被隐藏，组件实例、已加载数据与本地状态
 * （如歌单广场的分类筛选）都保留，切回来不重新拉接口。
 */
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

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
  getPlaylistCategories: async (source: string) => {
    api.categories += 1;
    // 换源必须给到**不同数量**的分类：歌单广场的 measure 依赖 categories.length，
    // 数量不变就不会重测，复现不出「隐藏期间量到 0」这个场景。
    if (source === "qq") {
      return [
        { id: "hot", name: "热歌", group: null },
        { id: "new", name: "新歌", group: null },
      ];
    }
    return [
      { id: "rock", name: "摇滚", group: null },
      { id: "pop", name: "流行", group: null },
      { id: "folk", name: "民谣", group: null },
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

/**
 * 「更多」按钮是否存在。
 * **不能断言 textContent 含「更多」**：列表页脚还有「继续下拉加载更多 / 已经到底了」，
 * 那个字符串永远在，会让断言恒真、把回归测试变成摆设。
 */
function hasMoreButton(container: HTMLElement): boolean {
  return container.querySelector("button[aria-label='展开全部分类']") !== null;
}

function chip(container: HTMLElement, label: string): HTMLElement {
  const hit = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  );
  if (!hit) throw new Error(`未找到分类 chip：${label}`);
  return hit;
}

/**
 * 让 jsdom 有一点几何概念：隐藏页（`div[aria-hidden="true"]` 内）量到 0，
 * 可见时量到「一行 28px / 内容共 90px」。
 *
 * 歌单广场的「更多」按钮是**测出来的**（`collapsible = rowHeight > 0 && fullHeight > rowHeight + 1`），
 * 而 jsdom 的 getBoundingClientRect/scrollHeight 恒为 0，不桩就没法复现这个 bug。
 */
function installGeometryStub(): () => void {
  const proto = window.Element.prototype;
  const origRect = proto.getBoundingClientRect;
  const origScroll = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
  const hidden = (el: Element): boolean =>
    el.closest("div[aria-hidden='true']") !== null;
  proto.getBoundingClientRect = function (this: Element): DOMRect {
    const r = origRect.call(this);
    if (hidden(this)) return r;
    return {
      ...r,
      width: 600,
      height: 28,
      top: 0,
      left: 0,
      right: 600,
      bottom: 28,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get(this: Element): number {
      return hidden(this) ? 0 : 90;
    },
  });
  return () => {
    proto.getBoundingClientRect = origRect;
    if (origScroll) Object.defineProperty(proto, "scrollHeight", origScroll);
  };
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

  /**
   * 回归（2026-10-04，用户报「切换音源之后，歌单广场右上角的更多就没了」）。
   *
   * 成因：换源时分类先被清空、再异步填充，筛选条因此重建；而 keep-alive 下
   * 用户此刻往往已经切到了别的页面，重建发生在 `display:none` 里 ——
   * 那一帧 `getBoundingClientRect()` 与 `scrollHeight` 都是 0，
   * `collapsible` 被永久钉成 false。之后切回来时 categories.length 没变、
   * window 也没 resize，没有任何东西触发重测，「更多」再也不会出现。
   *
   * 修法：measure 的依赖里加上 `useKeepAliveActive()`，重新可见时必重测。
   */
  it("换源发生在页面隐藏时，切回来仍能测出「更多」", async () => {
    const restore = installGeometryStub();
    try {
      const { KeepAliveOutlet } = await import("@/components/layout/KeepAliveOutlet");
      const { useMusicSourceStore } = await import("@/stores/musicSource");
      useMusicSourceStore.setState({ activeSourceId: "wyy" });

      const { container, rerender } = render(<KeepAliveOutlet pathname="/playlists" />);
      await waitFor(() => expect(container.textContent).toContain("歌单广场"));
      await flush();
      // 可见状态下首次测量：一行放不下 3 个分类 → 出现「更多」
      expect(hasMoreButton(container)).toBe(true);

      // 切到首页（歌单广场只被隐藏，组件实例与 DOM 都还在）
      rerender(<KeepAliveOutlet pathname="/" />);
      await waitFor(() => expect(container.textContent).toContain("发现音乐"));
      await flush();

      // 在隐藏期间换源：分类清空 → 新分类到达 → 筛选条在 display:none 里重建
      useMusicSourceStore.setState({ activeSourceId: "qq" });
      await flush();

      // 切回歌单广场：必须重新测量并恢复「更多」
      rerender(<KeepAliveOutlet pathname="/playlists" />);
      await flush();
      expect(container.textContent).toContain("热歌");
      expect(hasMoreButton(container)).toBe(true);
    } finally {
      cleanup();
      restore();
    }
  });
});
