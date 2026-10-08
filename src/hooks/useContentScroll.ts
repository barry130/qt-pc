import { useEffect, useState } from "react";
import { isScrollableY, outermostScrollable, pickWheelTarget } from "@/lib/scroll";

/** 当前该「回到顶部」的目标容器 + 它是不是滚得够远（决定按钮出不出现） */
export type ContentScroll = {
  target: HTMLElement | null;
  visible: boolean;
};

const HIDDEN: ContentScroll = { target: null, visible: false };

/**
 * 滚轮放大倍数：浏览器默认一格约 100px，几千首的列表（十几万像素）要滚到手酸。
 *
 * 用**倍数**而不是固定步长，是因为不能假设设备：触控板每次事件只有几像素但
 * 触发很密，固定步长会把它变成"一格飞一屏"。按倍数放大对两种设备都是"更快"。
 */
export const WHEEL_FACTOR = 2.2;
/** deltaMode=DOM_DELTA_LINE（部分系统/鼠标驱动报"行"）时每行折算的像素 */
const LINE_PX = 40;
/** 单次推进上限：防止极快触控板甩动一下飞出整页 */
const MAX_STEP_PX = 600;

/**
 * 内容区滚动行为统一处理（用户 m05249「进度条拖不动 + 滚轮滚动很慢 + 没有回到顶部」）。
 *
 * 两件事都在 root（内容区 `<main>`）上用**原生捕获监听**做，十几个页面不必逐个挂 ref：
 * 1. 滚轮加速：位移按 WHEEL_FACTOR 倍数放大（并归一 deltaMode），不再依赖
 *    浏览器/系统给的那点像素量 —— 后者在部分机器上只有几十像素/格。
 *    取**最内层**纵向滚动容器（见 pickWheelTarget），保持「内层吃到底也不连带
 *    滚外层」的默认语义；横向滚容器（HorizontalScroller 自己把纵向滚轮转成横滚）
 *    直接让路，否则卡片行永远横滚不了。
 * 2. 回到顶部：滚过一屏的 60%（最多 240px）才显示按钮。
 *
 * 为什么用捕获：wheel 要在到达目标前拦截才有意义；scroll **不冒泡**，
 * 只有捕获阶段能在 root 上收到后代容器的滚动事件。
 */
export function useContentScroll(
  root: HTMLElement | null,
  /** 换页信号：切 tab 后重挂监听并先收起按钮，别拿上一页的滚动位置 */
  resetKey?: string,
): ContentScroll {
  const [state, setState] = useState<ContentScroll>(HIDDEN);

  useEffect(() => {
    if (root === null) {
      setState(HIDDEN);
      return;
    }
    setState(HIDDEN);

    let raf = 0;
    let watched: HTMLElement | null = null;
    // 尺寸/可见性变化兜底：切 tab（display:none 尺寸归零）、内容增删（分页追加）。
    // jsdom 没有 ResizeObserver（测试与非常老的运行时），缺席时只是少了这条兜底。
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (watched !== null) measure(watched);
          });

    function measure(el: HTMLElement | null): void {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // 页面被切走（KeepAliveOutlet 的 display:none）后容器 clientHeight 与
        // scrollHeight 同时归零，isScrollableY 自然为假 → 收起按钮。不必另外查
        // getClientRects：jsdom 没有布局，那个判定恒为空会让整条链路在测试里失效。
        if (el === null || !isScrollableY(el)) {
          setState((s) => (s.visible || s.target !== null ? HIDDEN : s));
          return;
        }
        // 阈值：滚过「一屏的 60%（最多 240px）」才出现，只滚几行时不打扰
        const visible = el.scrollTop > Math.min(240, el.clientHeight * 0.6);
        setState((s) => (s.target === el && s.visible === visible ? s : { target: el, visible }));
        if (watched !== el) {
          if (watched !== null) ro?.unobserve(watched);
          watched = el;
          ro?.observe(el);
        }
      });
    }

    const onScroll = (e: Event): void => {
      const el = e.target;
      if (!(el instanceof HTMLElement)) return;
      measure(outermostScrollable(el, root));
    };

    // 滚轮：非 passive（要 preventDefault），按倍数放大位移
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || e.defaultPrevented) return; // 缩放交给浏览器
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // 横向滚动不接管
      const el = pickWheelTarget(e.target as Element | null, root);
      if (el === null) return;
      // 先归一到像素：deltaMode=LINE 时 deltaY 报的是"行数"
      const raw = e.deltaMode === 1 ? e.deltaY * LINE_PX : e.deltaY;
      const delta = Math.max(-MAX_STEP_PX, Math.min(MAX_STEP_PX, raw * WHEEL_FACTOR));
      if (Math.abs(delta) < 1) return;
      el.scrollTop += delta;
      e.preventDefault();
    };

    root.addEventListener("scroll", onScroll, { capture: true, passive: true });
    root.addEventListener("wheel", onWheel, { capture: true, passive: false });

    return () => {
      cancelAnimationFrame(raf);
      root.removeEventListener("scroll", onScroll, { capture: true });
      root.removeEventListener("wheel", onWheel, { capture: true });
      ro?.disconnect();
    };
  }, [root, resetKey]);

  return state;
}
