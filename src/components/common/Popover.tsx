import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { useDismissOnOutside } from "@/hooks/useDismissOnOutside";

/** 触发元素的渲染参数：open 挂到 aria-expanded，toggle 挂到 onClick */
export interface PopoverTriggerState {
  open: boolean;
  toggle: () => void;
}

export interface PopoverProps {
  /**
   * 受控开关（可选）。不传时组件自持状态；传了 open 就要传 onOpenChange。
   * 开关需要被外部收起（如「切歌自动收起」）或被父级共享（播放页空态入口
   * 与按钮共用一个弹层）时用受控模式，其余情况一律不传走自持。
   */
  open?: boolean;
  /** 受控模式的开合回调（toggle / 点外面 / Esc / close() 都会走到这里） */
  onOpenChange?: (open: boolean) => void;
  /** 包裹层类：须含 relative（面板绝对定位的上下文），可附 flex 等布局类 */
  className?: string;
  /** 触发元素（按钮本体）。除 aria-expanded/onClick 外的属性按各触发点原样写 */
  trigger: (state: PopoverTriggerState) => ReactNode;
  /** 面板内容（仅 open 时挂载）：close = 收起，菜单项动作完成后调用 */
  children: (close: () => void) => ReactNode;
}

/**
 * 点开式浮层（菜单 / 面板）的统一骨架：开合状态 + 触发按钮 + 点外面 / Esc
 * 收起 + 条件挂载，四件事在这里收成一份。
 *
 * 此前每个弹层组件各抄一遍这 20 行（播放条 6 处、两处列表红心、消息中心、
 * 音源切换、行内删除菜单……），手抄的还分两派：一派用 useDismissOnOutside，
 * 一派手写 document.addEventListener（漏了 Esc，点外面行为也有 window /
 * document 级的细微差异）。新弹层直接用它，不再抄监听、行为天然与全仓一致。
 *
 * 收起判定复用 useDismissOnOutside：window 级 mousedown，包裹层包含触发
 * 按钮与面板，点面板自身不算「点外面」。面板需要自带绝对定位类
 * （absolute bottom-full / top-full …），上下文由包裹层的 relative 提供。
 */
export function Popover(props: PopoverProps): React.JSX.Element {
  const [innerOpen, setInnerOpen] = useState(false);
  const open = props.open ?? innerOpen;
  const setOpen = (next: boolean): void => {
    if (props.onOpenChange) props.onOpenChange(next);
    else setInnerOpen(next);
  };
  const boxRef = useRef<HTMLDivElement | null>(null);
  useDismissOnOutside(boxRef, open, () => setOpen(false));

  return (
    <div ref={boxRef} className={props.className ?? "relative"}>
      {props.trigger({
        open,
        toggle: () => setOpen(!open),
      })}
      {open ? props.children(() => setOpen(false)) : null}
    </div>
  );
}
