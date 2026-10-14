import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useToastStore, type ToastItem } from "@/stores/toast";

/** 停留时长与淡出时长（用户 m09470：3 秒就消失） */
const DURATION_MS = 3000;
const FADE_MS = 180;

function Toast({ item }: { item: ToastItem }): React.JSX.Element {
  const dismiss = useToastStore((s) => s.dismiss);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const fade = window.setTimeout(() => setLeaving(true), DURATION_MS);
    const gone = window.setTimeout(() => dismiss(item.id), DURATION_MS + FADE_MS);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(gone);
    };
  }, [dismiss, item.id]);

  return (
    <div
      className={cn(
        "qt-toast max-w-[22rem] truncate rounded-lg border px-3 py-1.5 text-xs shadow-lg backdrop-blur-sm transition-opacity",
        // 淡出：先透明再卸载，别让它「啪」地消失
        leaving && "opacity-0",
        item.kind === "error"
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-border bg-card/95 text-foreground",
      )}
    >
      {item.text}
    </div>
  );
}

/**
 * 轻提示宿主：固定在右上角（标题栏正下方），每条 3 秒自己淡出。
 *
 * 全局只在 `AppShell` 挂一次，页面用 `toast()` 往队列里塞文案即可 —— 提示不占
 * 任何页面的布局，这是它相对「写在条子里的回执」的全部意义（m09470）。
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