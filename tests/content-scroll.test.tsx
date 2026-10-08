// @vitest-environment jsdom
/**
 * 内容区滚动：滚轮加速 + 回到顶部（用户 m05249）。
 *
 * 用户原话：「长列表右边的进度条无法下滑，导致滚轮滚动很慢；也没有回到顶部的按钮」。
 * 这里锁住两件事：
 *   1. 滚轮被放大（不再是浏览器默认那点像素量），且**横向滚容器让路** ——
 *      首页卡片行（HorizontalScroller）自己把纵向滚轮转成横滚，若这里抢先接管，
 *      卡片行就永远横滚不了；
 *   2. 「回到顶部」按钮：滚过阈值才出现，点击把当前滚的那个容器送回顶部。
 * 回归测试文件：tests/content-scroll.test.tsx。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useContentScroll, WHEEL_FACTOR } from "@/hooks/useContentScroll";
import { ScrollTopLayer } from "@/components/layout/ScrollTopLayer";

/**
 * jsdom 没有布局：scrollHeight / clientHeight 恒为 0，getComputedStyle 也不做
 * 级联（Tailwind 的类不会真的生效）。所以两个判定都在这里打桩：
 * - 几何按 data-* 给（dataset 的键是驼峰：data-scroll-height → dataset.scrollHeight）；
 * - overflow 按 data-oy / data-ox 覆盖 getComputedStyle。
 */
function stubGeometry(): void {
  for (const prop of [
    "clientHeight",
    "scrollHeight",
    "clientWidth",
    "scrollWidth",
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        const raw = this.dataset[prop];
        return raw === undefined ? 0 : Number(raw);
      },
    });
  }
  const realStyle = window.getComputedStyle.bind(window);
  window.getComputedStyle = ((el: Element) => {
    const style = realStyle(el);
    const oy = (el as HTMLElement).dataset?.oy;
    const ox = (el as HTMLElement).dataset?.ox;
    if (oy === undefined && ox === undefined) return style;
    return new Proxy(style, {
      get: (t, k) => {
        if (k === "overflowY") return oy ?? "visible";
        if (k === "overflowX") return ox ?? "visible";
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  }) as typeof window.getComputedStyle;
}

/** 造一个可纵向滚动的长列表：视口 400、内容 4000 */
function longList(): HTMLElement {
  const el = document.createElement("div");
  el.dataset.oy = "auto";
  el.dataset.clientHeight = "400";
  el.dataset.scrollHeight = "4000";
  return el;
}

/**
 * 等状态落地：hook 的测量在 requestAnimationFrame 里（滚动中不同步 setState），
 * 且每次滚动都会重新排一次 rAF，所以这里用 waitFor 兜住"可能不止一帧"。
 */
async function settled(assert: () => void): Promise<void> {
  await waitFor(assert, { timeout: 1000 });
}

/** 探针：把 hook 的状态吐出来，避免为测 hook 造展示组件 */
function probe(root: HTMLElement): {
  read: () => { target: HTMLElement | null; visible: boolean };
} {
  const box: { current: { target: HTMLElement | null; visible: boolean } } = {
    current: { target: null, visible: false },
  };
  function Probe(): React.ReactNode {
    box.current = useContentScroll(root, "k");
    return null;
  }
  render(<Probe />);
  return { read: () => box.current };
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  stubGeometry();
});

describe("滚轮加速", () => {
  it("纵向滚轮按倍数放大：一次 100px 的事件推进 220px", async () => {
    const host = document.createElement("div");
    const list = longList();
    host.appendChild(list);
    document.body.appendChild(host);

    probe(host);
    fireEvent.wheel(list, { deltaY: 100, deltaMode: 0 });

    // jsdom 不会因为赋值 scrollTop 自动派发 scroll 事件，这里只验证位移被放大了
    // （「目标是刚滚的那个容器」由下面"滚过阈值"那条用例覆盖）
    expect(list.scrollTop).toBe(100 * WHEEL_FACTOR);
  });

  it("deltaMode=LINE（报行不报像素）也先折算成像素再放大", () => {
    const host = document.createElement("div");
    const list = longList();
    host.appendChild(list);
    document.body.appendChild(host);

    probe(host);
    fireEvent.wheel(list, { deltaY: 3, deltaMode: 1 });

    expect(list.scrollTop).toBe(3 * 40 * WHEEL_FACTOR);
  });

  it("横向滚容器让路：卡片行自己转横滚，整页不被滚走", () => {
    const host = document.createElement("div");
    const page = longList();
    // 模拟 HorizontalScroller：外层纵向长列表里嵌一个横向可滚、内容超宽的卡片行
    const scroller = document.createElement("div");
    scroller.dataset.ox = "auto";
    scroller.dataset.clientWidth = "600";
    scroller.dataset.scrollWidth = "2400";
    host.appendChild(page);
    page.appendChild(scroller);
    document.body.appendChild(host);

    probe(host);
    fireEvent.wheel(scroller, { deltaY: 100, deltaMode: 0 });

    expect(page.scrollTop).toBe(0); // 整页没动 → 卡片行自己的 wheel 监听还有机会
  });

  it("Ctrl+滚轮（缩放）不接管", () => {
    const host = document.createElement("div");
    const list = longList();
    host.appendChild(list);
    document.body.appendChild(host);

    probe(host);
    fireEvent.wheel(list, { deltaY: 100, deltaMode: 0, ctrlKey: true });

    expect(list.scrollTop).toBe(0);
  });
});

describe("回到顶部", () => {
  it("只滚了几行：不出现按钮（阈值一屏的 60%）", async () => {
    const host = document.createElement("div");
    const list = longList();
    host.appendChild(list);
    document.body.appendChild(host);

    const { read } = probe(host);
    list.scrollTop = 100; // 阈值 = min(240, 400*0.6) = 240
    fireEvent.scroll(list);
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    expect(read().visible).toBe(false);
  });

  it("滚过阈值：目标就是当前滚的那个容器", async () => {
    const host = document.createElement("div");
    const list = longList();
    host.appendChild(list);
    document.body.appendChild(host);

    const { read } = probe(host);
    list.scrollTop = 1000;
    fireEvent.scroll(list);
    await settled(() => expect(read().visible).toBe(true));
    expect(read().target).toBe(list);
  });
});

describe("ScrollTopLayer", () => {
  /**
   * 浮层的监听范围 = 自己那层 div 的 parentElement。用 RTL 默认容器（它自己
   * 新建一个 div）当宿主，再把长列表**挂进这个容器** —— 注意不能反过来先挂
   * 列表再 render：createRoot 会清空容器里已有的子节点，列表会被抹掉。
   */
  function mountLayer(): { container: HTMLElement; list: HTMLElement } {
    const { container } = render(<ScrollTopLayer resetKey="k" />);
    const list = longList();
    container.appendChild(list);
    return { container, list };
  }

  it("按钮出现后点击：把当前容器送回顶部", async () => {
    const { list } = mountLayer();

    list.scrollTop = 1000;
    fireEvent.scroll(list);
    await settled(() => {
      expect(screen.queryByRole("button", { name: "回到顶部" })).not.toBeNull();
    });

    const btn = screen.getByRole("button", { name: "回到顶部" });
    // jsdom 没有实现 scrollTo，打桩后验证调用参数
    list.scrollTo = vi.fn();
    fireEvent.click(btn);
    expect(list.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("没滚过阈值时不渲染按钮", async () => {
    const { list } = mountLayer();

    list.scrollTop = 10;
    fireEvent.scroll(list);
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    expect(screen.queryByRole("button", { name: "回到顶部" })).toBeNull();
  });
});
