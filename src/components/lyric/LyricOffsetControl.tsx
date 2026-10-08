import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";

import { MAX_LYRIC_OFFSET_MS, type LyricOffset } from "@/hooks/useLyricOffset";
import { useDismissOnOutside } from "@/hooks/useDismissOnOutside";
import { cn } from "@/lib/utils";

/**
 * 歌词偏移调节条。
 *
 * 方向说明写在界面上，不靠用户猜：正 = 歌词延后出现。判定式是
 * `findActiveIndex(lines, position - offsetMs)`，所以「延后」对应存正值。
 *
 * 拖动是受控的本地 draft（`setDraftMs`），松手/点按钮才写库（`commit`）——
 * 每个 input 事件都打一次 IPC 会把 SQLite 写爆，而且拖到一半的中间值毫无意义。
 */
export function LyricOffsetControl(props: {
  offset: LyricOffset;
  /** 紧凑模式：桌面歌词窗口工具条下拉里用 */
  compact?: boolean;
  className?: string;
}): React.JSX.Element {
  const { offset, compact = false, className } = props;
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  draggingRef.current = dragging;
  // 与旁边「搜索歌词」弹层同款收起（点外面 / Esc）——桌面歌词工具条里两个
  // 下拉挨着，一个点外面能关、一个不能关最招人烦
  const boxRef = useRef<HTMLDivElement | null>(null);
  useDismissOnOutside(boxRef, open, () => setOpen(false));

  // 面板开着且用户没在拖时，跟随外部值（比如另一处 UI 改了偏移 / 切歌重读）
  useEffect(() => {
    if (open && !draggingRef.current) offset.setDraftMs(offset.offsetMs);
  }, [open, offset.offsetMs]); // eslint-disable-line react-hooks/exhaustive-deps

  const fmt = (ms: number): string =>
    `${ms > 0 ? "+" : ms < 0 ? "−" : ""}${Math.abs(ms)} ms`;

  return (
    <div ref={boxRef} className={cn("relative", className)}>
      <button
        type="button"
        data-testid="lyric-offset-toggle"
        aria-label="歌词偏移"
        aria-expanded={open}
        title="歌词偏移（歌词比声音快/慢时调整）"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors",
          "text-foreground/80 hover:bg-foreground/10",
          offset.offsetMs !== 0 && "text-lyric-highlight",
        )}
      >
        <span className="tabular-nums">
          {offset.offsetMs === 0 ? "偏移" : fmt(offset.offsetMs)}
        </span>
      </button>

      {open && (
        <div
          data-testid="lyric-offset-panel"
          className={cn(
            "absolute right-0 z-20 mt-1 rounded-lg border border-border bg-popover p-3 shadow-lg",
            compact ? "w-56" : "w-72",
          )}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-medium">歌词偏移</span>
            <span
              data-testid="lyric-offset-value"
              className="text-sm tabular-nums text-foreground"
            >
              {fmt(offset.draftMs)}
            </span>
          </div>

          <input
            type="range"
            data-testid="lyric-offset-slider"
            aria-label="歌词偏移毫秒"
            min={-MAX_LYRIC_OFFSET_MS}
            max={MAX_LYRIC_OFFSET_MS}
            step={50}
            value={offset.draftMs}
            onChange={(e) => {
              offset.setDraftMs(Number(e.target.value));
              setDragging(true);
            }}
            onPointerUp={() => {
              offset.commit();
              setDragging(false);
            }}
            onKeyUp={() => offset.commit()}
            onBlur={() => {
              if (draggingRef.current) {
                offset.commit();
                setDragging(false);
              }
            }}
            className="mt-2 w-full accent-lyric-highlight"
          />

          <div className="mt-1 flex items-center justify-between gap-1">
            <button
              type="button"
              aria-label="歌词提前 100 毫秒"
              onClick={() => offset.nudge(-100)}
              className="rounded px-2 py-0.5 text-xs text-foreground/80 hover:bg-foreground/10"
            >
              −100
            </button>
            <button
              type="button"
              aria-label="歌词延后 100 毫秒"
              onClick={() => offset.nudge(100)}
              className="rounded px-2 py-0.5 text-xs text-foreground/80 hover:bg-foreground/10"
            >
              +100
            </button>
            <button
              type="button"
              data-testid="lyric-offset-reset"
              aria-label="重置歌词偏移"
              title="重置为 0"
              onClick={() => offset.reset()}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-foreground/80 hover:bg-foreground/10"
            >
              <RotateCcw size={12} />
              重置
            </button>
          </div>

          <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
            歌词比声音快 → 调正（延后）；歌词比声音慢 → 调负（提前）。按曲目保存。
          </p>
        </div>
      )}
    </div>
  );
}
