import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** 悬停多久才出提示：太快会在连续扫过图标区时连环闪，太慢又像没反应 */
const SHOW_DELAY_MS = 380;
/** 与锚点上/下沿的间距（提示框自身高度不算，定位用 transform 收） */
const GAP_PX = 8;
/** 距视口边缘的最小留白，避免贴着窗口边被切掉 */
const EDGE_PX = 8;
/** 视口上方不足这个高度就翻到锚点下方（贴顶的标题栏按钮要用到） */
const FLIP_TOP_PX = 44;

interface Anchor {
  /** 锚点中心 x（视口坐标，已夹取到安全范围） */
  x: number;
  top: number;
  bottom: number;
  below: boolean;
}

export interface HintHandlers {
  onMouseEnter: (e: React.MouseEvent<HTMLElement>) => void;
  onMouseLeave: () => void;
  onFocus: (e: React.FocusEvent<HTMLElement>) => void;
  onBlur: () => void;
  /** 按下即收起：点下去之后提示没有意义，留着还会盖住刚打开的面板 */
  onPointerDown: () => void;
}

export interface HintResult {
  /** 展开到按钮上：只挂事件，不包额外 DOM，不改动现有布局 */
  hintProps: HintHandlers;
  /** 提示层（portal 到 body，fixed 定位）；渲染在同级即可 */
  hintLayer: React.JSX.Element | null;
}

/**
 * 轻提示（tooltip）。
 *
 * 为什么不直接写 `title=`：原生 title 有 1 秒以上的延迟、无法样式化、深色皮肤下
 * 是系统白框；而标题栏/播放条这类图标按钮恰恰最需要「悬停即知」。
 *
 * 为什么是 hook 而不是 `<Hint>` 包裹组件：包裹会多一层 DOM，标题栏窗口控制、
 * 播放条按钮都在 flex 行里按尺寸对齐，多一层 `inline-flex` 就可能改变行高或
 * 让 `h-full` 失效。这里只返回事件处理器，挂到已有按钮上，零结构改动。
 *
 * 行为：悬停/键盘聚焦 380ms 后出现，移出/失焦/按下/滚动/缩放立即收起；
 * 视口顶部空间不足时自动翻到锚点下方，并夹在左右安全区内。
 */
export function useHint(label: string | null | undefined): HintResult {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [shown, setShown] = useState(false);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const hide = useCallback((): void => {
    clearTimer();
    setShown(false);
    setAnchor(null);
  }, [clearTimer]);

  const showFor = useCallback(
    (rect: DOMRect): void => {
      if (label == null || label.length === 0) return;
      // 水平方向夹取到 [EDGE_PX + 半宽, 视口右 - EDGE_PX - 半宽]：
      // 提示框宽度未知，按 120px 估一半，够用且不会跳到屏幕外
      const half = 60;
      const maxX = window.innerWidth - EDGE_PX - half;
      const x = Math.min(Math.max(rect.left + rect.width / 2, EDGE_PX + half), Math.max(maxX, EDGE_PX + half));
      setAnchor({
        x,
        top: rect.top,
        bottom: rect.bottom,
        below: rect.top < FLIP_TOP_PX,
      });
      setShown(true);
    },
    [label],
  );

  const scheduleShow = useCallback(
    (el: HTMLElement): void => {
      clearTimer();
      if (label == null || label.length === 0) return;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        showFor(el.getBoundingClientRect());
      }, SHOW_DELAY_MS);
    },
    [clearTimer, label, showFor],
  );

  // 滚动/缩放会让 fixed 坐标失效：与其追着重新计算，不如直接收起
  useEffect(() => {
    if (!shown) return;
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
    };
  }, [shown, hide]);

  // 卸载时清掉未触发的定时器
  useEffect(() => clearTimer, [clearTimer]);

  const hintProps: HintHandlers = {
    onMouseEnter: (e) => scheduleShow(e.currentTarget),
    onMouseLeave: hide,
    onFocus: (e) => scheduleShow(e.currentTarget),
    onBlur: hide,
    onPointerDown: hide,
  };

  const hintLayer =
    shown && anchor !== null && label != null && label.length > 0
      ? createPortal(
          <div
            role="tooltip"
            className="qt-hint-in pointer-events-none fixed z-[80] max-w-[min(240px,80vw)] whitespace-nowrap rounded-lg border border-border bg-popover/95 px-2 py-1 text-2xs font-medium text-popover-foreground shadow-raised backdrop-blur-xl"
            style={{
              left: anchor.x,
              top: anchor.below ? anchor.bottom + GAP_PX : anchor.top - GAP_PX,
              transform: anchor.below ? "translate(-50%, 0)" : "translate(-50%, -100%)",
            }}
          >
            {label}
          </div>,
          document.body,
        )
      : null;

  return { hintProps, hintLayer };
}
