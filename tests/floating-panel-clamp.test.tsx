// @vitest-environment jsdom
/**
 * 跟随鼠标的浮层面板（`FloatingPanel`）贴边逻辑。
 *
 * 背景（用户 m10460「展示不全」）：面板首次渲染时内容还没长满 —— 分享卡的封面是
 * canvas，`h-auto w-[220px]` 在画上之前只有默认的 150px 高，绘完变 220px；换源面板
 * 先是"搜索中"一窄条、收藏面板的歌单列表也是异步到的。只按首拍高度夹一次坐标，
 * 内容再长高后底部（按钮那一排）就落到窗口外，点不到。
 *
 * 这里用假的 `ResizeObserver` + 可变的 `getBoundingClientRect` 复现「长高」，
 * 断言 top 会跟着往上收，并且面板本身带 `max-height` 兜底。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

/** 被测元素当前的尺寸（用例里改它来模拟内容长高） */
const box = { width: 352, height: 150 };
const observers: Array<{ cb: ResizeObserverCallback; el: Element }> = [];

class FakeResizeObserver {
  private readonly entry: { cb: ResizeObserverCallback; el: Element };
  constructor(cb: ResizeObserverCallback) {
    this.entry = { cb, el: document.body };
    observers.push(this.entry);
  }
  observe(el: Element): void {
    this.entry.el = el;
  }
  unobserve(): void {}
  disconnect(): void {
    const i = observers.indexOf(this.entry);
    if (i >= 0) observers.splice(i, 1);
  }
}

/** 让所有观察者按当前 box 尺寸报一次，模拟内容长高 / 变宽 */
function fireResize(): void {
  act(() => {
    for (const o of observers) {
      o.cb([{ target: o.el } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    }
  });
}

import { FloatingPanel } from "@/components/common/ContextMenu";

function panel(top: number, left = 100): HTMLElement {
  render(
    <FloatingPanel x={left} y={top} width={352} onClose={() => undefined}>
      <div>面板内容</div>
    </FloatingPanel>,
  );
  const el = document.querySelector(".fixed.z-\\[60\\]");
  if (!(el instanceof HTMLElement)) throw new Error("没找到浮层面板");
  return el;
}

describe("FloatingPanel 贴边", () => {
  beforeEach(() => {
    observers.length = 0;
    box.width = 352;
    box.height = 150;
    // jsdom 里没有布局：getBoundingClientRect 恒为 0，贴边逻辑就永远认为「放得下」
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          width: box.width,
          height: box.height,
          right: box.width,
          bottom: box.height,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 760 });
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("首拍放得下就停在鼠标位置", () => {
    const el = panel(300);
    expect(el.style.left).toBe("100px");
    expect(el.style.top).toBe("300px");
  });

  it("内容长高后往上收，底部按钮留在窗口里", () => {
    const el = panel(600);
    // 首拍 150 高：600 + 150 + 8 = 758 ≤ 760，贴着鼠标
    expect(el.style.top).toBe("600px");
    box.height = 350; // canvas 画完 / 列表异步到，面板长高
    fireResize();
    // 760 − 350 − 8 = 402
    expect(el.style.top).toBe("402px");
  });

  it("横向同理：贴到右边缘时往左收", () => {
    const el = panel(100, 700);
    // 面板在鼠标右边放不下就整体左移：1024 − 352 − 8 = 664
    expect(el.style.left).toBe("664px");
    box.width = 500;
    fireResize();
    // 1024 − 500 − 8 = 516
    expect(el.style.left).toBe("516px");
  });

  it("自带高度上限：比窗口还高时面板内部滚，不把底部甩出窗口", () => {
    const el = panel(600);
    expect(el.style.maxHeight).toBe("calc(100vh - 16px)");
    expect(el.className).toContain("overflow-y-auto");
  });
});
