import { useCallback, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** 8 个方向命中区，与 index.css 的 .resize-hit-* 类一一对应 */
type ResizeDir =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

const DIRS: ResizeDir[] = [
  "North",
  "South",
  "East",
  "West",
  "NorthEast",
  "NorthWest",
  "SouthEast",
  "SouthWest",
];

const CLASS_SUFFIX: Record<ResizeDir, string> = {
  North: "n",
  South: "s",
  East: "e",
  West: "w",
  NorthEast: "ne",
  NorthWest: "nw",
  SouthEast: "se",
  SouthWest: "sw",
};

/**
 * 无边框窗口原生能力补齐（DESIGN §4.1）：
 * 1. 8 向 resize：四边 + 四角命中区，调用 startResizeDragging(dir)
 * 2. 标题栏拖动区：startDragging
 * 3. 双击标题栏 toggleMaximize
 */
export function useFramelessWindow(): void {
  useEffect(() => {
    const handlers: Array<() => void> = [];

    for (const dir of DIRS) {
      const el = document.querySelector(`.resize-hit-${CLASS_SUFFIX[dir]}`);
      if (!el) continue;
      const onMousedown = (ev: Event): void => {
        const e = ev as MouseEvent;
        if (e.button !== 0) return;
        e.preventDefault();
        // macOS/WKWebView 的 tao 后端不支持 startResizeDragging（返回
        // NotSupported），失败静默——macOS 装饰窗由系统管理 resize，
        // 不会走到这里；这里兜的是 Linux 桌面边缘命中区。
        void getCurrentWindow()
          .startResizeDragging(dir)
          .catch(() => {});
      };
      el.addEventListener("mousedown", onMousedown);
      handlers.push(() => el.removeEventListener("mousedown", onMousedown));
    }

    return () => {
      for (const h of handlers) h();
    };
  }, []);
}

/** 标题栏拖动 + 双击最大化。返回 ref 挂在标题栏容器上。 */
export function useTitleBarDrag(): {
  ref: React.RefObject<HTMLDivElement | null>;
  onDoubleClick: () => void;
} {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onMousedown = (ev: Event): void => {
      const e = ev as MouseEvent;
      if (e.button !== 0) return;
      // 命中交互控件时不启动拖动。这个监听器是**原生**的、绑在标题栏容器上，
      // 比 React 合成事件（委托到 root）更早触发，所以子组件里的 stopPropagation
      // 拦不住它；不排除控件的话，按钮的 click 会被 startDragging 吞掉
      // （表现为窗口最小化/最大化/关闭、音源切换点了没反应）。
      const target = e.target as Element | null;
      if (
        target?.closest(
          "button, input, select, textarea, a, label, [role='button'], [role='option']",
        )
      ) {
        return;
      }
      void getCurrentWindow()
        .startDragging()
        .catch((err) => console.error("startDragging failed", err));
    };
    el.addEventListener("mousedown", onMousedown);
    return () => el.removeEventListener("mousedown", onMousedown);
  }, []);

  const onDoubleClick = useCallback((): void => {
    // 双击最大化失败只影响这次手势，别冒泡成未处理拒绝弹全局浮层
    void getCurrentWindow()
      .toggleMaximize()
      .catch(() => {});
  }, []);

  return { ref, onDoubleClick };
}
