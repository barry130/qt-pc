import { useCallback, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { IconButton } from "@/components/common/IconButton";
import { Button } from "./button";

/**
 * 模态弹层（本仓唯一的对话框外壳）。
 *
 * 为什么收口：全仓 8 处各自写 `fixed inset-0 z-50 flex items-center justify-center
 * bg-black/40 p-4` 的遮罩 + 卡片，细节各不相同——遮罩黑色透明度 40 / 45 / 50 三种、
 * 卡片圆角 `rounded-xl` 与 `rounded-2xl` 混用、有的按 Esc 能关有的不能、有的能点遮罩关
 * 有的点了没反应、有的自报 `role="dialog"` 却完全没有焦点陷阱（Tab 会跑到背后的页面上，
 * 回车真的会触发背后的播放/删除）。这里把它们统一成一套语义：
 *
 * - **焦点**：`useFocusTrap` 负责 Tab 循环、Esc 关闭、关闭后把焦点还给触发按钮；
 * - **关闭**：`dismissible={false}` 时 Esc 与右上角 × 都不生效（开屏公告、免责声明用），
 *   遮罩点击由 `closeOnBackdrop` 单独控制（默认开，破坏性确认框也保留——点外面=取消）；
 * - **结构**：`title` / `description` / `icon` 走标准的 header，`footer` 固定在底部，
 *   `children` 是滚动区（长内容不会把按钮顶出屏幕）。
 *
 * 只做「弹一层」这件事：拖拽、多层级联、动画都不在这里，需要时用 `Popover` 或页面。
 */
/** 卡片底色：`card` = 跟随主题；`glass` = 半透明白/黑玻璃（导入歌单、更新弹窗一直在用） */
const TONE_CLASS = {
  card: "border-border bg-card/95 shadow-overlay",
  glass:
    "border-white/20 bg-white/70 text-card-foreground shadow-overlay dark:border-white/10 dark:bg-black/40",
} as const;

export type ModalTone = keyof typeof TONE_CLASS;

const SIZE_CLASS = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
} as const;

export type ModalSize = keyof typeof SIZE_CLASS;

export function Modal(props: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** 标题左侧的图标（如 AlertTriangle / ArrowDownCircle） */
  icon?: React.ReactNode;
  children?: React.ReactNode;
  /** 底部操作区（右对齐，建议 1～3 个 Button） */
  footer?: React.ReactNode;
  /**
   * 标题左侧的槽位（返回键等）。用在「一层层往里钻」的弹层上：此时标题是被推入的
   * 内容名，返回键必须紧贴标题，不能塞进 footer。
   */
  headerLeft?: React.ReactNode;
  /** 底部操作区的类名覆盖（默认靠右；要「左信息 + 右按钮」时传 justify-between）。 */
  footerClassName?: string;
  size?: ModalSize;
  /** 卡片底色（默认 card）。glass = 玻璃拟态卡片 */
  tone?: ModalTone;
  /** 点遮罩是否关闭（默认 true） */
  closeOnBackdrop?: boolean;
  /** 是否允许关闭（默认 true）。false = 只能通过 footer 里的按钮推进 */
  dismissible?: boolean;
  /** 滚动区额外类名（默认 px-5 py-4） */
  bodyClassName?: string;
  /** 卡片额外类名 */
  className?: string;
  /** 遮罩额外类名（默认 `bg-black/45`；引导类浮层可用 `bg-background/80 backdrop-blur-sm`） */
  backdropClassName?: string;
  /** 右上角关闭按钮的读屏文案（默认「关闭」；带业务名的弹窗传「关闭 AI 供应商设置」之类） */
  closeLabel?: string;
  /** 覆盖 aria-labelledby（同一个弹窗被复用时避免 id 冲突本身由 useId 保证，通常不用传） */
  labelledBy?: string;
}): React.JSX.Element | null {
  const panelRef = useRef<HTMLElement | null>(null);
  const autoTitleId = useId();
  const titleId = props.labelledBy ?? autoTitleId;
  const dismissible = props.dismissible !== false;
  const closeOnBackdrop = props.closeOnBackdrop !== false;

  const onClose = props.onClose;
  const close = useCallback(() => {
    if (dismissible) onClose();
  }, [dismissible, onClose]);

  // Esc 与 Tab 循环由陷阱统一处理；不可关闭时传空实现，Esc 就自然失效。
  useFocusTrap(panelRef, props.open, close);

  // 挂到 body 上再画：调用点常在滚动容器 / 带 transform 的祖先里，就地渲染会被裁切
  // （ListenReportDetail、AI 供应商设置原本就各自 createPortal 过一遍）。
  if (!props.open || typeof document === "undefined") return null;

  const hasHeader =
    props.title !== undefined ||
    props.description !== undefined ||
    props.icon !== undefined ||
    props.headerLeft !== undefined;

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4",
        props.backdropClassName,
      )}
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) props.onClose();
      }}
    >
      <section
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={props.title !== undefined ? titleId : undefined}
        className={cn(
          "flex max-h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden rounded-2xl border outline-none backdrop-blur-xl",
          TONE_CLASS[props.tone ?? "card"],
          SIZE_CLASS[props.size ?? "sm"],
          props.className,
        )}
      >
        {hasHeader && (
          <header className="flex shrink-0 items-start gap-3 border-b border-border px-5 py-4">
            {props.headerLeft}
            {props.icon !== undefined && <span className="mt-0.5 shrink-0 text-primary">{props.icon}</span>}
            <div className="min-w-0 flex-1">
              {props.title !== undefined && (
                <h2 id={titleId} className="text-sm font-semibold text-foreground">
                  {props.title}
                </h2>
              )}
              {props.description !== undefined && (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {props.description}
                </p>
              )}
            </div>
            {dismissible && (
              <IconButton label={props.closeLabel ?? "关闭"} size="md" onClick={props.onClose}>
                <X />
              </IconButton>
            )}
          </header>
        )}
        <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-4", props.bodyClassName)}>
          {props.children}
        </div>
        {props.footer !== undefined && (
          <footer
            className={cn(
              "flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3",
              props.footerClassName,
            )}
          >
            {props.footer}
          </footer>
        )}
      </section>
    </div>,
    document.body,
  );
}

/**
 * 二次确认：`Modal` 的最常见用法（删除歌单、退出登录、覆盖安装…）。
 *
 * 只保留两个选择（取消 / 确认），不做三选一——需要更多出口时直接用 `Modal`。
 * `tone="danger"` 用于破坏性操作：确认按钮变红，但**不**自动聚焦到确认按钮
 * （防止手快的回车误删），焦点留在容器上由用户自己选。
 */
export function ConfirmDialog(props: {
  open: boolean;
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  tone?: "primary" | "danger";
  /** 确认按钮转圈并禁用（异步操作中） */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element | null {
  return (
    <Modal
      open={props.open}
      onClose={props.onCancel}
      title={props.title}
      description={props.description}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={props.onCancel} disabled={props.busy === true}>
            {props.cancelText ?? "取消"}
          </Button>
          <Button
            variant={props.tone === "danger" ? "danger" : "primary"}
            loading={props.busy === true}
            onClick={props.onConfirm}
          >
            {props.confirmText ?? "确定"}
          </Button>
        </>
      }
    />
  );
}
