import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { useDismissOnOutside } from "@/hooks/useDismissOnOutside";

/** 菜单里的一项。`onSelect` 只写动作，收起菜单由本组件统一做 */
export interface ContextMenuItem {
  /** 稳定 key（React 列表用） */
  key: string;
  label: string;
  /** 行首图标（lucide 组件或本仓的 PlayNextIcon 这类同签名的组件） */
  icon?: React.ComponentType<{ className?: string }>;
  /** 负面动作（移除 / 删除）：红字 */
  danger?: boolean;
  /** 当前场景下不适用：置灰且点不动（而不是把项藏起来导致菜单长度乱跳） */
  disabled?: boolean;
  /** 在这一项之前画一条分隔线（给动作分组） */
  separatorBefore?: boolean;
  onSelect: () => void;
}

/** 浮层与视口边缘之间至少留这么多像素 */
const MARGIN = 8;

/**
 * 跟随面板的高度上限：到顶到脚各留 `MARGIN`，超出的部分由面板自己滚。
 * 夹坐标只能把「顶边」按进视口，面板比视口还高时底部仍会被切掉（用户 m10460
 * 「展示不全」正是这个：分享卡的大封面把面板撑到比可视区还高）。
 */
const PANEL_MAX_HEIGHT = `calc(100vh - ${MARGIN * 2}px)`;

/**
 * 先按鼠标位置渲染，量到真实尺寸后把坐标夹回视口内 —— 在屏幕右下角右键时，
 * 菜单 / 面板不会有一半在窗口外。尺寸要在渲染后才知道，所以是两拍。
 */
function useClampedPoint(
  ref: React.RefObject<HTMLElement | null>,
  x: number,
  y: number,
  /** 内容变化会改变高度（如换源面板从"搜索中"变成结果列表），要重新夹一次 */
  reflowKey: unknown,
): { left: number; top: number } {
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const clamp = (): { left: number; top: number } => {
      const rect = el.getBoundingClientRect();
      return {
        left: Math.max(MARGIN, Math.min(x, window.innerWidth - rect.width - MARGIN)),
        top: Math.max(MARGIN, Math.min(y, window.innerHeight - rect.height - MARGIN)),
      };
    };
    setPos(clamp());
    // **夹一次不够**：首拍量到的是「内容还没长满」时的高度 —— 分享卡的封面图要等
    // 加载 / 绘制完、换源面板先是"搜索中"一窄条再变成结果列表、收藏面板的歌单列表
    // 也是异步到的。按首拍高度算出 top 之后内容再长高，面板下半截就落到窗口外，
    // 底部按钮点不到（用户 m10460「展示不全」）。所以跟着尺寸持续夹。
    if (typeof ResizeObserver === "undefined") return; // jsdom / 老内核：只量首拍
    const ro = new ResizeObserver(() => {
      const next = clamp();
      // 尺寸没变就不 setState：ResizeObserver 在加载/动画期间会连着报，别白重渲染
      setPos((prev) => (prev.left === next.left && prev.top === next.top ? prev : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, x, y, reflowKey]);
  return pos;
}

/**
 * 浮层跟随鼠标位置时的通用收尾：外部滚动 / 缩放就把它收掉。
 *
 * `closeOnScroll=false` 只保留「缩放就收」：播放页的歌词一直在自己滚（逐行高亮
 * 的自动滚动、用户拖动歌词），菜单/面板刚打开就被那阵滚动收掉等于用不了
 * （2026-10-29 用户反馈）。这种「底下永远在动」的页面由调用方显式关掉滚动收起；
 * 其余场景（列表页）保持原行为 —— 列表滚走了菜单还浮在原地会指向错误的行。
 */
function useCloseOnViewportChange(
  ref: React.RefObject<HTMLElement | null>,
  onClose: () => void,
  closeOnScroll = true,
): void {
  useEffect(() => {
    const close = (e: Event): void => {
      // 浮层**自己内部**的滚动不算「外面的世界动了」：收藏面板里的歌单列表
      // 本身就要滚，滚一下就把面板收掉等于面板没法用
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    // capture：滚动事件不冒泡到 window，只有捕获阶段能收到滚动容器的滚动；
    // passive：close 不调 preventDefault，别让浏览器白等一次主线程（滚动会更跟手）
    if (closeOnScroll) window.addEventListener("scroll", close, { capture: true, passive: true });
    window.addEventListener("resize", close);
    return () => {
      if (closeOnScroll) window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
    };
  }, [ref, onClose, closeOnScroll]);
}

/**
 * 右键菜单（鼠标位置弹出）。
 *
 * 为什么用 portal 挂到 `document.body`：曲目列表的滚动容器是 `overflow-y-auto`，
 * 菜单若作为行内子树渲染就会被裁掉；而 `position: fixed` 也不是万能解 —— 祖先
 * 只要带了 `backdrop-filter` / `transform`，就会成为 fixed 的包含块，菜单照样被
 * 那个祖先裁切。挂到 body 后与任何祖先的 overflow / filter 都无关，是唯一稳的
 * 做法（全仓目前只有右键菜单与它的跟随面板用 portal，因为只有它们需要
 * "跟着鼠标、且不受容器裁切"）。
 *
 * 收起：点外面 / Esc 复用 `useDismissOnOutside`（与全仓弹层一致），滚动或缩放
 * 也收起 —— 菜单是 fixed 的，底下内容滚走了它却还浮在原地，会指向错误的行。
 */
export function ContextMenu(props: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  /** 外部滚动是否收起菜单（默认收起；播放页这类「底下一直在滚」的页面传 false） */
  closeOnScroll?: boolean;
}): React.JSX.Element {
  const { x, y, items, onClose, closeOnScroll = true } = props;
  const boxRef = useRef<HTMLDivElement | null>(null);
  const pos = useClampedPoint(boxRef, x, y, items.length);
  useDismissOnOutside(boxRef, true, onClose);
  useCloseOnViewportChange(boxRef, onClose, closeOnScroll);

  return createPortal(
    <div
      ref={boxRef}
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      // 菜单自己右键：吃掉事件，别让它冒泡到行上再开一层
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      // portal 只改变 DOM 位置，**不改变 React 事件树**：菜单在 React 树上仍是行
      // （`div[role=button]`，点一下即播放）的子节点，不拦住的话点「加入队列」
      // 会顺手把这首播了。
      onClick={(e) => e.stopPropagation()}
      className="fixed z-[60] min-w-[180px] max-w-[260px] rounded-xl border border-border bg-popover/95 p-1 backdrop-blur-xl shadow-raised"
    >
      {items.map((it) => {
        const Icon = it.icon;
        return (
          <div key={it.key}>
            {it.separatorBefore ? <div className="my-1 h-px bg-border" /> : null}
            <button
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={() => {
                onClose();
                it.onSelect();
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors",
                it.danger
                  ? "text-destructive hover:bg-destructive/10"
                  : "text-popover-foreground hover:bg-secondary",
                it.disabled ? "cursor-default opacity-40 hover:bg-transparent" : "",
              )}
            >
              {Icon ? (
                <Icon className="h-3.5 w-3.5 shrink-0" />
              ) : (
                // 没有图标的项留一个同宽占位，保证所有文字左对齐
                <span className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="truncate">{it.label}</span>
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

/**
 * 跟随鼠标位置的浮层面板（右键菜单里选了「收藏到歌单 / 换源」之后，面板就落在
 * 刚才那个坐标上）。与 `ContextMenu` 同一套 portal + 贴边 + 点外面收起规则，
 * 差别只是内容由调用方给、宽度由调用方定（面板宽度是内容决定的，量之前先用
 * 它来夹横向坐标更准）。
 */
export function FloatingPanel(props: {
  x: number;
  y: number;
  width: number;
  onClose: () => void;
  /** 同 ContextMenu：播放页歌词自滚时面板不该跟着消失 */
  closeOnScroll?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const { x, y, width, onClose, closeOnScroll = true, children } = props;
  const boxRef = useRef<HTMLDivElement | null>(null);
  const pos = useClampedPoint(boxRef, x, y, width);
  useDismissOnOutside(boxRef, true, onClose);
  useCloseOnViewportChange(boxRef, onClose, closeOnScroll);

  return createPortal(
    <div
      ref={boxRef}
      style={{ left: pos.left, top: pos.top, width, maxHeight: PANEL_MAX_HEIGHT }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      // 面板在 React 树上挂在行里面，点击不能漏到行的 onClick（播放）
      onClick={(e) => e.stopPropagation()}
      // 比窗口还高的面板（分享卡带大封面、换源结果多）自己滚，而不是直接把底部
      // 那排按钮甩到窗口外 —— 夹坐标只能保证「顶边可见」，兜底得靠这里
      className="fixed z-[60] overflow-y-auto overscroll-contain"
    >
      {children}
    </div>,
    document.body,
  );
}
