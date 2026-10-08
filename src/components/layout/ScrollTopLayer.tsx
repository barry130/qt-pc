import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { useContentScroll } from "@/hooks/useContentScroll";

/**
 * 内容区统一的「回到顶部」浮层（用户 m05249「也没有回到顶部的按钮」）。
 *
 * 挂在 `<main>` 里（AppShell 内容区）：一层 `absolute inset-0` 的透明覆盖层 +
 * 右下角的按钮。它自己不带滚动容器 —— 目标容器由 `useContentScroll` 从滚动事件
 * 反推（滚轮加速也在那里统一处理），十几处长列表因此不必逐个挂 ref、逐个改页面。
 *
 * 定位只写 `bottom-4 right-4`：按钮对齐的是**内容区**右下角，而播放队列面板是
 * `<main>` 的兄弟节点，所以面板展开时按钮自动停在面板左侧，不会钻到面板底下。
 *
 * 覆盖层自身 `pointer-events-none`，只有按钮那一块 `pointer-events-auto`，
 * 否则这层 `inset-0` 会盖住内容区右上角的行内按钮。
 */
export function ScrollTopLayer(props: {
  /** 换页信号：切 tab 后立刻收起，别拿上一页的滚动位置 */
  resetKey?: string;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  // 监听范围取宿主（main）。不能直接用 props 传进来的 ref：首次挂载时父级 host
  // 元素的 ref 还没附上（React 自下而上提交），这里用自己那层 div 的 parentElement，
  // effect 里必然已经就位。
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHost(ref.current?.parentElement ?? null);
  }, []);

  const { target, visible } = useContentScroll(host, props.resetKey);

  return (
    <div ref={ref} aria-hidden={!visible} className="pointer-events-none absolute inset-0 z-30">
      {visible && (
        <button
          type="button"
          aria-label="回到顶部"
          title="回到顶部"
          onClick={() => {
            target?.scrollTo({ top: 0, behavior: "smooth" });
          }}
          className="pointer-events-auto absolute bottom-4 right-4 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card/90 text-foreground shadow-lg backdrop-blur-sm transition-colors hover:bg-accent"
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
