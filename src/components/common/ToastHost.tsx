import { useEffect, useState } from "react";
import { Check, CircleAlert, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToastStore, type ToastItem } from "@/stores/toast";

/**
 * 停留与退场时长。成功/普通 3 秒（用户 m09470 的口径），出错给 6 秒 ——
 * 失败原因往往更长也更值得读完，3 秒就飘走等于没报。退场 = 位移 + 淡出
 * 的 transition（.qt-toast 只管进场，见 index.css 侧的注释）。
 */
const STAY_MS: Record<ToastItem["kind"], number> = {
  success: 3000,
  info: 3000,
  error: 6000,
};
const EXIT_MS = 200;

/** 三种 kind 的图标 + 图标底色 + 进度条颜色（正文都用前景色，红字整段太吵） */
const KIND_STYLE: Record<
  ToastItem["kind"],
  { icon: typeof Info; chip: string; bar: string }
> = {
  success: {
    icon: Check,
    chip: "bg-success/15 text-success",
    bar: "bg-success/70",
  },
  info: { icon: Info, chip: "bg-primary/10 text-primary", bar: "bg-primary/70" },
  error: {
    icon: CircleAlert,
    chip: "bg-destructive/15 text-destructive",
    bar: "bg-destructive/70",
  },
};

function Toast({ item }: { item: ToastItem }): React.JSX.Element {
  const dismiss = useToastStore((s) => s.dismiss);
  const [leaving, setLeaving] = useState(false);
  const stay = STAY_MS[item.kind];
  const kind = KIND_STYLE[item.kind];
  const Icon = kind.icon;

  useEffect(() => {
    const exit = window.setTimeout(() => setLeaving(true), stay);
    const gone = window.setTimeout(() => dismiss(item.id), stay + EXIT_MS);
    return () => {
      window.clearTimeout(exit);
      window.clearTimeout(gone);
    };
  }, [dismiss, item.id, stay]);

  return (
    <div
      role={item.kind === "error" ? "alert" : "status"}
      className={cn(
        // 进场动画（右侧滑入）在 .qt-toast 上；退场走下面这组 transition
        "qt-toast relative flex w-72 max-w-[22rem] items-start gap-2.5 overflow-hidden rounded-xl border px-3.5 py-2.5 shadow-lg backdrop-blur-md transition-[opacity,transform] duration-200 ease-in",
        leaving && "translate-x-3 scale-95 opacity-0",
        item.kind === "error"
          ? "border-destructive/40 bg-card/95"
          : item.kind === "success"
            ? "border-success/30 bg-card/95"
            : "border-border bg-card/95",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
          kind.chip,
        )}
      >
        <Icon className="h-3 w-3" strokeWidth={2.5} />
      </span>
      {/* line-clamp 兜底超长文案（歌单名 + 歌名可能很长），不给无限高 */}
      <p className="min-w-0 flex-1 py-px text-xs leading-relaxed break-words text-foreground line-clamp-3">
        {item.text}
      </p>
      {/* 剩余时长进度条：从满宽线性收到零（时长随 kind），压在卡片底边 */}
      <span
        aria-hidden="true"
        className={cn(
          "qt-toast-progress absolute inset-x-0 bottom-0 h-0.5 origin-left",
          kind.bar,
        )}
        style={{ animationDuration: `${stay}ms` }}
      />
    </div>
  );
}

/**
 * 轻提示宿主：固定在右上角（标题栏正下方），每条按 kind 停留几秒后滑出。
 *
 * 全局只在 `AppShell` 挂一次，页面用 `toast()/toastSuccess()/toastError()`
 * 往队列里塞文案即可 —— 提示不占任何页面的布局，这是它相对「写在条子里的
 * 回执」的全部意义（m09470）。
 *
 * 整层 `pointer-events-none`：它正好压在页头右侧那排控件上，绝不能替用户挡住
 * 点击（点击穿透到下面的按钮 / 面板）。挂在对话框之前，弹窗起来时盖住它。
 */
export function ToastHost(): React.JSX.Element | null {
  const items = useToastStore((s) => s.items);
  if (items.length === 0) return null;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-4 top-[48px] z-50 flex flex-col items-end gap-2"
    >
      {items.map((item) => (
        <Toast key={item.id} item={item} />
      ))}
    </div>
  );
}
