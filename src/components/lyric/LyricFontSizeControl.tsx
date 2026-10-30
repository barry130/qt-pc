import { Minus, Plus, RotateCcw } from "lucide-react";

import {
  LYRIC_FONT_SIZE_DEFAULT,
  LYRIC_FONT_SIZE_MAX,
  LYRIC_FONT_SIZE_MIN,
  LYRIC_FONT_SIZE_STEP,
  type LyricFontSize,
} from "@/hooks/useLyricFontSize";
import { Popover } from "@/components/common/Popover";
import { cn } from "@/lib/utils";

/**
 * 播放页歌词字号调节。
 *
 * 面板给三个入口：滑杆（快速拖到想要的大小）、A− / A+（步进 2px，点得准）、
 * 重置（回 20px）。快捷键 Ctrl + = / − / 0 在 `PlayingPage` 里绑，
 * 右键菜单里也有一份 —— 三个入口改的是同一个 `lyric.fontSize`。
 */
export function LyricFontSizeControl(props: {
  size: LyricFontSize;
  className?: string;
}): React.JSX.Element {
  const { size, className } = props;
  const changed = size.px !== LYRIC_FONT_SIZE_DEFAULT;

  return (
    <Popover
      className={cn("relative", className)}
      trigger={(t) => (
        <button
          type="button"
          data-testid="lyric-font-size-toggle"
          aria-label="歌词字号"
          aria-expanded={t.open}
          title="歌词字号（调大调小歌词文字）"
          onClick={t.toggle}
          className={cn(
            "flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors",
            "text-foreground/80 hover:bg-foreground/10",
            changed && "text-lyric-highlight",
          )}
        >
          <span className="tabular-nums">
            {changed ? `字号 ${size.px}` : "字号"}
          </span>
        </button>
      )}
    >
      {() => (
        <div
          data-testid="lyric-font-size-panel"
          className="absolute right-0 z-20 mt-1 w-64 rounded-xl border border-border bg-popover/95 p-3 shadow-raised backdrop-blur-xl"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-medium">歌词字号</span>
            <span
              data-testid="lyric-font-size-value"
              className="text-sm tabular-nums text-foreground"
            >
              {size.px}px
            </span>
          </div>

          <input
            type="range"
            data-testid="lyric-font-size-slider"
            aria-label="歌词字号像素"
            min={LYRIC_FONT_SIZE_MIN}
            max={LYRIC_FONT_SIZE_MAX}
            step={LYRIC_FONT_SIZE_STEP}
            value={size.px}
            onChange={(e) => size.setPx(Number(e.target.value))}
            className="mt-2 w-full accent-lyric-highlight"
          />

          <div className="mt-1 flex items-center justify-between gap-1">
            <button
              type="button"
              data-testid="lyric-font-size-minus"
              aria-label="缩小歌词字号"
              disabled={size.px <= LYRIC_FONT_SIZE_MIN}
              onClick={() => size.bump(-LYRIC_FONT_SIZE_STEP)}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-foreground/80 hover:bg-foreground/10 disabled:opacity-40"
            >
              <Minus size={12} />
              变小
            </button>
            <button
              type="button"
              data-testid="lyric-font-size-plus"
              aria-label="放大歌词字号"
              disabled={size.px >= LYRIC_FONT_SIZE_MAX}
              onClick={() => size.bump(LYRIC_FONT_SIZE_STEP)}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-foreground/80 hover:bg-foreground/10 disabled:opacity-40"
            >
              <Plus size={12} />
              变大
            </button>
            <button
              type="button"
              data-testid="lyric-font-size-reset"
              aria-label="重置歌词字号"
              title={`重置为 ${LYRIC_FONT_SIZE_DEFAULT}px`}
              onClick={() => size.reset()}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-foreground/80 hover:bg-foreground/10"
            >
              <RotateCcw size={12} />
              重置
            </button>
          </div>

          <p className="mt-2 text-2xs leading-snug text-muted-foreground">
            也可以按 Ctrl + = / − 调，Ctrl + 0 复位。按全局保存，不跟曲目走。
          </p>
        </div>
      )}
    </Popover>
  );
}
