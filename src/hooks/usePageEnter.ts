import { useEffect, useRef, useState } from "react";

/**
 * 路由切换时的内容入场（120ms 淡入 + 2px 上浮，见 index.css 的 `.qt-page-enter`）。
 *
 * 常驻缓存页（KeepAliveOutlet）不需要这个 hook：它们的容器在 `display:none` 与
 * 可见之间切换，CSS 动画会自然从头重播。这里只服务非常驻路由（详情页/搜索页/
 * 设置页）——这些页面每次进入都是新实例，但 pathname 变化时容器元素本身是复用的，
 * 动画不会自己重播，所以要先摘掉类名、下一帧再挂回去强制重启。
 *
 * 只在 key 变化时触发；首次挂载本来就有类名，无需额外重启一次（避免闪两下）。
 *
 * 类名里必须带 `h-full`：这层 div 夹在「内容区（h-full）」与「页面根节点（h-full）」
 * 之间，一旦它没有高度，整条百分比高度链就断掉 —— 2026-10-29 漏了它，播放页歌词区
 * 拿不到高度，滚轮无反应、封面被挤到视野外。所以由 hook 一起给出，调用方不必再记。
 */
const PAGE_ENTER_CLASS = "qt-page-enter h-full";

/** 入场类名 + 高度透传（见上：h-full 不能漏） */
export function usePageEnter(key: string): string {
  const [className, setClassName] = useState(PAGE_ENTER_CLASS);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setClassName("h-full");
    const id = requestAnimationFrame(() => setClassName(PAGE_ENTER_CLASS));
    return () => cancelAnimationFrame(id);
  }, [key]);

  return className;
}
