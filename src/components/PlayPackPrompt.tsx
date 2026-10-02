import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { PackageOpen, X } from "lucide-react";

/**
 * 「未安装播放音源包」播放时提示（双音源包架构）。
 *
 * 在线取链需要播放音源包（高风险，不随应用分发）；resolvePlayUrl 识别到
 * 数据包的缺包错误后会派发 window 事件 `qt-play-pack-missing`，这里弹
 * 一条可操作提示——只提示「需要安装」并跳转到 设置 → 音源包（提示里不带
 * 任何下载链接，安装动作完全由用户发起）。
 */
export function PlayPackPrompt(): React.JSX.Element | null {
  const navigate = useNavigate();
  const [visible, setVisible] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const onMissing = (): void => {
      setVisible(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      // 自动消失：提示不打断用户手头的操作（切歌/继续听本地音乐）
      timer.current = window.setTimeout(() => setVisible(false), 10_000);
    };
    window.addEventListener("qt-play-pack-missing", onMissing);
    return () => {
      window.removeEventListener("qt-play-pack-missing", onMissing);
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  if (!visible) return null;
  return (
    <div className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2">
      <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-lg">
        <PackageOpen className="h-4 w-4 shrink-0 text-primary" />
        <div className="text-xs leading-relaxed text-muted-foreground">
          在线播放需要播放音源包（应用未内置，需自行安装）
        </div>
        <button
          type="button"
          onClick={() => {
            setVisible(false);
            void navigate({
              to: "/settings/$section",
              params: { section: "source-package" },
            });
          }}
          className="rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          去安装
        </button>
        <button
          type="button"
          aria-label="关闭提示"
          onClick={() => setVisible(false)}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
