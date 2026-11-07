import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * 模态弹层的焦点陷阱：打开时把焦点移进弹层，Tab / Shift+Tab 在弹层内部循环，
 * Esc 关闭，关闭后把焦点还给打开前的元素。
 *
 * 命令面板自报 `role="dialog" aria-modal="true"`，但以前只在输入框上接了 Esc：
 * Tab 一次焦点就落到结果按钮上，此后 Esc 完全失效（只能用鼠标点遮罩关），
 * Shift+Tab 更会退到遮罩背后看不见的页面控件上——回车真的会触发背后的暂停/切歌
 * （评审 2026-10-29）。这里把 Esc 与 Tab 循环提到容器层，语义与 aria-modal 对齐。
 *
 * 用法：把返回的 ref 挂到 dialog 根节点，`active` 跟随弹层开关。
 *
 * 两个容易踩的坑（C09）：
 * - `onClose` 常常是内联箭头函数，每次渲染都是新引用。若把它放进 effect 依赖，
 *   父组件任何一次重渲染都会让 effect 重跑：cleanup 里的「还焦点」先执行，焦点被
 *   送回弹层外面，陷阱等于断开。所以只把 `active` / `ref` 作为依赖，回调走 ref。
 * - 原来的 Tab 监听只挂在 dialog 上：焦点一旦不在弹层内（打开时没主动聚焦、点了
 *   不可聚焦区域），Tab 就交给浏览器默认行为，直接跑到遮罩背后。现在打开时主动
 *   把焦点放到弹层容器（有子元素 autofocus 时保留它），并在 document 上兜住
 *   「焦点在弹层外」的 Tab。
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onClose: () => void,
): void {
  // 最新回调：事件监听只注册一次，读 ref 拿到当前渲染的 onClose
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const node = ref.current;
    if (!active || !node) return;
    // 只记录弹层外的焦点：如果子元素已经 autofocus（命令面板输入框），
    // 打开瞬间 activeElement 已经在弹层里，它不是「打开前的元素」，不能拿来还原。
    const restore =
      document.activeElement instanceof HTMLElement && !node.contains(document.activeElement)
        ? document.activeElement
        : null;

    // 不用 offsetParent 判可见：它依赖真实布局，jsdom 里恒为 null（测试全灭），
    // 而弹层里的隐藏内容基本都是「不渲染」，真正隐藏的用 hidden / aria-hidden 标出来。
    const focusables = (): HTMLElement[] =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => !el.hidden && el.getAttribute("aria-hidden") !== "true",
      );

    /**
     * 把焦点放进弹层：子元素已经 autofocus 就保持不动；否则先落在容器上。
     *
     * 不直接抢第一个可聚焦元素，是因为 Modal 的 × 关闭按钮 / ConfirmDialog 的确认
     * 按钮都可能是第一个控件 —— 手快的回车会误关甚至误删（ConfirmDialog 的注释
     * 明确要求焦点留在容器上）。容器 tabIndex=-1，Tab 再由下面的循环逻辑送进控件。
     */
    const focusContainer = (): void => {
      const current = document.activeElement;
      if (current instanceof HTMLElement && current !== node && node.contains(current)) return;
      node.focus({ preventScroll: true });
    };

    /** 焦点在弹层外时按 Tab：直接把焦点送到第一个 / 最后一个控件 */
    const focusEdge = (fromEnd: boolean): void => {
      const items = focusables();
      const target = items.length === 0 ? node : fromEnd ? items[items.length - 1] : items[0];
      target.focus({ preventScroll: true });
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        node.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      // 容器本身不算「在可循环的控件里」：从容器按 Tab 要落到第一个控件
      const inside = current instanceof Node && current !== node && node.contains(current);
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
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const current = document.activeElement;
      // 焦点已在弹层内部：交给 onKeyDown 的循环逻辑，避免两边各处理一次
      if (current instanceof Node && current !== node && node.contains(current)) return;
      // 焦点在弹层外（打开时没聚焦成功、被外层抢走、点了不可聚焦区域）：
      // 浏览器默认 Tab 会落到遮罩背后的页面控件上，必须拦下来送回弹层
      event.preventDefault();
      focusEdge(event.shiftKey);
    };

    node.addEventListener("keydown", onKeyDown);
    document.addEventListener("keydown", onDocKeyDown);
    // 打开时主动进入焦点（子元素 autofocus 已经落在弹层里则保持不动）
    focusContainer();
    return () => {
      node.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keydown", onDocKeyDown);
      // 关闭后焦点回到打开它的按钮，键盘用户不会「丢位置」
      if (restore !== null && document.contains(restore) && !node.contains(restore)) {
        restore.focus({ preventScroll: true });
      }
    };
    // onClose 故意不进依赖：内联回调每次渲染都变，重跑 effect 会在 cleanup 里提前还焦点
  }, [active, ref]);
}
