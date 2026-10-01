import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const MARQUEE_SPEED = 60; // px/s：溢出距离越多滚得越久
const MIN_DURATION_S = 1; // 最短滚动时长
const FADE = 16; // 两端渐隐宽度（px），见 keyframes 侧的 mask

/** 监听 <html> 上的 .reduce-motion 减弱动效类（项目用它而非系统 prefers-reduced-motion） */
function useReduceMotionClass(): boolean {
  const [reduce, setReduce] = useState(() =>
    document.documentElement.classList.contains("reduce-motion"),
  );
  useEffect(() => {
    const root = document.documentElement;
    const update = (): void => setReduce(root.classList.contains("reduce-motion"));
    update();
    const mo = new MutationObserver(update);
    mo.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return reduce;
}

/**
 * 桌面歌词单行：放得下 → 居中静止（零变化）；溢出 → 测量驱动的 CSS 单程滚动
 * （先停 → 滚到最右端露出结尾 → forwards 停在末端，不再往返，见 index.css 的
 * @keyframes qt-marquee），两端 16px 渐隐；html.reduce-motion 时降级回 truncate。
 */
export function MarqueeLine(props: {
  text: string;
  textStyle: React.CSSProperties;
  className?: string;
  testid?: string;
  /** 是否允许溢出滚动：只有当前播放的行为 true；false/缺省 = 静止 + 单行省略号 */
  marquee?: boolean;
  /** 播放状态：false 时冻结滚动（animation-play-state: paused），恢复播放后续滚 */
  playing?: boolean;
}): React.JSX.Element {
  const outerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);
  const reduceMotion = useReduceMotionClass();

  const measure = useCallback((): void => {
    const outer = outerRef.current;
    const text = textRef.current;
    if (!outer || !text) return;
    // 文本保持 max-content 宽度，因此其 scrollWidth 是稳定的自然文本宽度；
    // 与外层可用宽度比较即可得到真实溢出距离，不受 transform 动画影响。
    const nextOverflow = Math.max(0, text.scrollWidth - outer.clientWidth);
    setOverflow((current) => current === nextOverflow ? current : nextOverflow);
  }, []);

  // 窗口拖宽时重测（文本 / 字号变化由下面的 useLayoutEffect 覆盖）
  useEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;
    const ro = new ResizeObserver(measure);
    ro.observe(outer);
    return () => ro.disconnect();
  }, [measure]);

  // 仅在会改变文本自然宽度的输入变化后重测，避免每次渲染都 setState 形成更新环。
  useLayoutEffect(() => {
    measure();
  }, [measure, props.text, props.textStyle]);

  // 非当前播放行 / 减弱动效：静止单行截断，不滚动不测量
  if (props.marquee !== true || reduceMotion) {
    return (
      <div className={`${props.className} w-full`} data-testid={props.testid} ref={outerRef}>
        <span
          style={{
            ...props.textStyle,
            display: "block",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: "100%",
          }}
        >
          {props.text}
        </span>
      </div>
    );
  }

  const doMarquee = overflow > 0;
  // 位移在实测溢出之上再多滚一个渐隐宽度：实测溢出恰好把字尾停在「内容区右缘 =
  // 遮罩渐隐区起点」，零余量，亚像素/描边误差就会让字尾落进渐隐里，看起来像
  // 「滚完了但最后半个字没显示」；多滚 FADE px 让字尾完整落在不透明区内
  const travel = overflow + FADE;
  // 单程滚动：滚到最右端后停住（forwards 保持末端位移，不再回来）
  const duration = Math.max(MIN_DURATION_S, travel / MARQUEE_SPEED);
  // 暂停：不冻结在半截（半截态字尾被裁，看起来像没滚完的 bug），而是直接
  // 跳到「整行完整展开」的末端停住；恢复播放后重新从头单程滚动
  const paused = props.playing === false;

  return (
    <div
      className={`${props.className} w-full`}
      data-testid={props.testid}
      ref={outerRef}
      style={{
        overflow: "hidden",
        whiteSpace: "nowrap",
        // 仅溢出时启用两端渐隐（裁掉的那 16px 在滚动时是文字最需要过渡的两端）
        maskImage: doMarquee
          ? `linear-gradient(90deg, transparent, black ${FADE}px, black calc(100% - ${FADE}px), transparent)`
          : undefined,
        WebkitMaskImage: doMarquee
          ? `linear-gradient(90deg, transparent, black ${FADE}px, black calc(100% - ${FADE}px), transparent)`
          : undefined,
      }}
    >
      {/* key=text：换行重挂 span，transform/keyframes 归零重跑，杜绝上一行动画残留 */}
      <span
        key={props.text}
        ref={textRef}
        style={
          {
            ...props.textStyle,
            display: "block",
            width: "max-content",
            minWidth: "100%",
            whiteSpace: "nowrap",
            "--mq-d": `${travel}px`,
            // 暂停态用静态 transform 停在末端（整行可见）；播放态交给关键帧动画。
            // transform 必须写在 animation 之前：动画运行时关键帧覆盖静态值
            transform: doMarquee && paused ? `translateX(calc(var(--mq-d) * -1))` : undefined,
            animation: doMarquee && !paused
              ? `qt-marquee ${duration.toFixed(2)}s linear 1 forwards`
              : "none",
          } as React.CSSProperties
        }
      >
        {props.text}
      </span>
    </div>
  );
}
