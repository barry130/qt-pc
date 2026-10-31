import { useEffect, useState } from "react";

/**
 * 监听 `<html>` 上的 `.reduce-motion` 类（项目用它而不是系统
 * `prefers-reduced-motion`：设置页的开关直接切这个类，见 useAppearanceEffect）。
 *
 * 组件需要「减弱动效时换一种渲染方式」（不只是停掉 animation）时用它；
 * 纯粹要停动画的话 CSS 里的 `.reduce-motion *` 规则已经兜住了。
 */
export function useReduceMotionClass(): boolean {
  const [reduce, setReduce] = useState(() =>
    document.documentElement.classList.contains("reduce-motion"),
  );
  useEffect(() => {
    const root = document.documentElement;
    const update = (): void => setReduce(root.classList.contains("reduce-motion"));
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return reduce;
}
