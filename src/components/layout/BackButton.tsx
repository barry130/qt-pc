import { ArrowLeft } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

/**
 * 页面内返回按钮。
 *
 * 壳内走 memory history，之前从列表进详情页后只能点侧边栏切走；
 * 这里给所有「被推进来的」页面统一一个返回入口，行为与播放页关闭一致。
 */
export function BackButton({ className }: { className?: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      aria-label="返回"
      title="返回上一页"
      onClick={() => router.history.back()}
      className={cn(
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/70 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <ArrowLeft className="h-4 w-4" />
    </button>
  );
}
