import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useMusicSourceStore } from "@/stores/musicSource";
import { SOURCE_DISPLAY, type SourceId } from "@/types";
import { cn } from "@/lib/utils";

/**
 * 标题栏音源切换器（DESIGN §6.2）——音源全局状态的唯一入口。
 * M1 仅 wyy 已接入 Provider；其余源选择后内容请求会返回 Unsupported 并提示。
 */

const SOURCES = Object.keys(SOURCE_DISPLAY) as Array<Exclude<SourceId, "local">>;

export function MusicSourceSwitcher(): React.JSX.Element {
  const activeSourceId = useMusicSourceStore((s) => s.activeSourceId);
  const setActiveSource = useMusicSourceStore((s) => s.setActiveSource);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="切换音源"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex items-center gap-1 rounded-full border border-border bg-secondary/50 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent",
          open && "bg-accent",
        )}
      >
        音源：{activeSourceId === "local" ? "本地" : SOURCE_DISPLAY[activeSourceId]}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>

      {open && (
        <ul
          role="listbox"
          // 语义令牌：写死 bg-white/70 dark:bg-black/40 会在换肤 / 深浅切换时脱节。
          // 透明度也别太靠页：80% 会让下面的内容明显透上来
          className="absolute left-1/2 top-full z-50 mt-1 w-36 -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover/95 py-1 shadow-2xl backdrop-blur-xl"
        >
          {SOURCES.map((id) => (
            <li key={id}>
              <button
                type="button"
                role="option"
                aria-selected={id === activeSourceId}
                onClick={() => {
                  setActiveSource(id);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between px-3 py-1.5 text-xs transition-colors hover:bg-secondary hover:text-foreground",
                  id === activeSourceId ? "text-primary" : "text-popover-foreground",
                )}
              >
                <span>{SOURCE_DISPLAY[id]}</span>
                {id === activeSourceId && (
                  <Check className="h-3.5 w-3.5 text-primary" aria-hidden />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
