import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Bell, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useReduceMotionClass } from "@/hooks/useReduceMotion";
import {
  isNoticeLinkOpenable,
  useOpenNoticeLink,
} from "@/lib/notice-open";
import {
  pickNoticeBar,
  useActiveNotices,
  type ActiveNotice,
} from "@/lib/notice-data";
import { htmlToText } from "@/lib/richText";
import { useAuthStore } from "@/stores/auth";

/** 滚动速度（px/s）：与歌词单行滚动一致，超过这个速度看不清 */
const MARQUEE_SPEED = 60;
/** 两份文案之间的留白（px），也是循环位移的一部分 */
const MARQUEE_GAP = 48;
/** 只溢出几个像素就不滚动：那种情况滚动看着像抖动 */
const MARQUEE_MIN_OVERFLOW = 8;

/**
 * 通告栏的「本次会话已关闭」：与移动端 `closeNoticeBarSession` 同样只在内存里记，
 * 重启应用会重新出现（用户关掉的是"现在别烦我"，不是"永久别推"）。
 */
let dismissedThisSession = false;

/** 测试用：清掉会话级关闭标记 */
export function resetNoticeBarSession(): void {
  dismissedThisSession = false;
}

/**
 * 首页通告栏（后端展示位 `display & 2`）。
 *
 * 移动端的 qt-notice-bar 在宽屏上**关掉跑马灯**（理由写在组件里：宽屏下文字放得下，
 * 跑起来反而一直在动）。桌面端窗口宽度差别太大，所以这里改成**测量驱动**：
 * 放得下就静止 + 单行省略，真正放不下（后端 `marquee=1` 且溢出）才连续左移循环，
 * 悬停或聚焦时暂停 —— 既尊重后端「这条要滚动」的意图，又不会动不动就晃。
 *
 * 多条通告时不并排铺开（挤成一行谁也读不完）：一次显示一条，右侧给上一/下一
 * 与「2/3」计数，和移动端「只取 dispatch.noticeBar[0]」相比多走一步，但桌面有空间。
 */
export function NoticeBar(props: {
  notices: ActiveNotice[];
  onOpen?: (notice: ActiveNotice) => void;
  onClose?: () => void;
}): React.JSX.Element | null {
  const { notices } = props;
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduceMotion = useReduceMotionClass();
  const boxRef = useRef<HTMLElement | null>(null);
  // 文字区域既是 button（可跳转时）又是 div（不可跳转时），回调 ref 让两者共用一个锚点
  const setBox = useCallback((el: HTMLElement | null): void => {
    boxRef.current = el;
  }, []);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [shift, setShift] = useState(0);

  // 通告被刷新掉（后台撤回）时下标可能越界，钳一下比崩溃好
  const safeIndex = Math.min(index, Math.max(notices.length - 1, 0));
  const notice: ActiveNotice | undefined = notices[safeIndex];
  const text = notice === undefined ? "" : noticeText(notice);
  const marqueeAllowed = notice?.marquee === true && !reduceMotion;
  const openable = notice !== undefined && isNoticeLinkOpenable(notice.link);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const textEl = textRef.current;
    if (box === null || textEl === null) return;
    const measure = (): void => {
      if (!marqueeAllowed) {
        setShift(0);
        return;
      }
      const textWidth = textEl.scrollWidth;
      const boxWidth = box.clientWidth;
      setShift(textWidth > boxWidth + MARQUEE_MIN_OVERFLOW ? textWidth + MARQUEE_GAP : 0);
    };
    measure();
    // jsdom / 老内核没有 ResizeObserver：退化成「只在文案变化时量一次」
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(textEl);
    return () => observer.disconnect();
  }, [marqueeAllowed, text]);

  if (notice === undefined) return null;

  const track = (
    <div
      className={shift > 0 ? "qt-notice-scroll flex w-max items-center" : "flex"}
      style={
        shift > 0
          ? ({
              animationDuration: `${(shift / MARQUEE_SPEED).toFixed(2)}s`,
              animationPlayState: paused ? "paused" : "running",
              // 位移量交给 CSS 变量：keyframes 里只写 translateX(var(--nb-shift))
              "--nb-shift": `-${shift}px`,
            } as React.CSSProperties)
          : undefined
      }
    >
      <span
        ref={textRef}
        className={
          shift > 0 ? "shrink-0 whitespace-nowrap text-xs" : "block w-full truncate text-xs"
        }
      >
        {text}
      </span>
      {/* 第二份文案负责接上循环的尾巴；对读屏隐藏，避免同一句话念两遍 */}
      {shift > 0 && (
        <span
          aria-hidden="true"
          className="shrink-0 whitespace-nowrap text-xs"
          style={{ paddingLeft: MARQUEE_GAP }}
        >
          {text}
        </span>
      )}
    </div>
  );

  const pauseProps = {
    onMouseEnter: () => setPaused(true),
    onMouseLeave: () => setPaused(false),
    onFocus: () => setPaused(true),
    onBlur: () => setPaused(false),
  };

  return (
    <div className="flex items-center gap-2 rounded-xl border border-border bg-secondary/60 px-3 py-2">
      <Bell className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
      {openable ? (
        <button
          type="button"
          ref={setBox}
          onClick={() => props.onOpen?.(notice)}
          className="min-w-0 flex-1 overflow-hidden rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          {...pauseProps}
        >
          {track}
        </button>
      ) : (
        <div ref={setBox} className="min-w-0 flex-1 overflow-hidden" {...pauseProps}>
          {track}
        </div>
      )}
      {notices.length > 1 && (
        <>
          <button
            type="button"
            onClick={() => setIndex((value) => (value - 1 + notices.length) % notices.length)}
            aria-label="上一条通告"
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
            {safeIndex + 1}/{notices.length}
          </span>
          <button
            type="button"
            onClick={() => setIndex((value) => (value + 1) % notices.length)}
            aria-label="下一条通告"
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </>
      )}
      <button
        type="button"
        onClick={props.onClose}
        aria-label="关闭通告"
        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** 通告栏正文：富文本压成单行；正文为空时退回标题（总比一条空白横条强） */
function noticeText(notice: ActiveNotice): string {
  const plain = htmlToText(notice.content).replace(/\s+/g, " ").trim();
  return plain.length > 0 ? plain : notice.title.trim();
}

/**
 * 首页挂载点：自己取数、按展示位与受众过滤、管会话级关闭。
 * 取数与开屏弹窗共用 `loadActiveNotices` 的模块缓存，同时挂载只发一次请求。
 */
export function NoticeBarHost(): React.JSX.Element | null {
  const { notices, loading } = useActiveNotices();
  const session = useAuthStore((s) => s.session);
  const openLink = useOpenNoticeLink();
  const [dismissed, setDismissed] = useState(dismissedThisSession);

  const bars = useMemo(() => pickNoticeBar(notices, session !== null), [notices, session]);
  const onOpen = useCallback(
    (notice: ActiveNotice): void => {
      openLink(notice.link);
    },
    [openLink],
  );

  // 首帧不占位：没通告时不能留一条空白把 Hero 往下推
  if (loading || dismissed || bars.length === 0) return null;

  return (
    <section className="px-5 pt-4">
      <NoticeBar
        notices={bars}
        onOpen={onOpen}
        onClose={() => {
          dismissedThisSession = true;
          setDismissed(true);
        }}
      />
    </section>
  );
}
