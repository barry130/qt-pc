import { useEffect, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * 模态弹层的焦点陷阱：Tab / Shift+Tab 在弹层内部循环，Esc 关闭，关闭后把焦点还给打开前的元素。
 *
 * 命令面板自报 `role="dialog" aria-modal="true"`，但以前只在输入框上接了 Esc：
 * Tab 一次焦点就落到结果按钮上，此后 Esc 完全失效（只能用鼠标点遮罩关），
 * Shift+Tab 更会退到遮罩背后看不见的页面控件上——回车真的会触发背后的暂停/切歌
 * （评审 2026-10-29）。这里把 Esc 与 Tab 循环提到容器层，语义与 aria-modal 对齐。
 *
 * 用法：把返回的 ref 挂到 dialog 根节点，`active` 跟随弹层开关。
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // 不用 offsetParent 判可见：它依赖真实布局，jsdom 里恒为 null（测试全灭），
    // 而弹层里的隐藏内容基本都是「不渲染」，真正隐藏的用 hidden / aria-hidden 标出来。
    const focusables = (): HTMLElement[] =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => !el.hidden && el.getAttribute("aria-hidden") !== "true",
      );

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      const inside = current instanceof Node && node.contains(current);
      if (event.shiftKey) {
        if (!inside || current === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (!inside || current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // Esc 额外挂到 document：焦点万一不在弹层内（点了不可聚焦的区域、外层组件抢回焦点），
    // 键盘用户仍然能关掉。旧的手写弹窗都是在 document 上监听，换壳不能退化。
    // 弹层内的 Esc 由上面的 onKeyDown 处理并 stopPropagation，不会重复触发。
    const onDocKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };

    node.addEventListener("keydown", onKeyDown);
    document.addEventListener("keydown", onDocKeyDown);
    return () => {
      node.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keydown", onDocKeyDown);
      // 关闭后焦点回到打开它的按钮，键盘用户不会「丢位置」
      if (restore !== null && document.contains(restore)) restore.focus();
    };
  }, [active, onClose, ref]);
}
