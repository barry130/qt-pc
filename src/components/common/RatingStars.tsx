import { useState } from "react";
import { Star } from "lucide-react";

/**
 * 五星评分控件（A6）。
 *
 * 交互沿用绝大多数播放器的习惯：
 * - 点第 N 颗星 = 打 N 分；**再点一次当前分值 = 清除**（不用另找一个「清除」按钮）；
 * - 悬停时预览「如果点下去会变成几星」，移开恢复真实值；
 * - 0 星时显示空心星，1–5 星时填充。
 *
 * 无障碍：整组是 `role="radiogroup"`，每颗星是 `role="radio"` + `aria-checked`，
 * 键盘 Tab 可达、Enter / 空格可点（用真 `<button>`，不手搓 keydown）。
 * 只读模式（`onRate` 缺省）只渲染图标，用于列表行的紧凑显示。
 */
export function RatingStars(props: {
  value: number;
  /** 不打这个回调 = 只读展示 */
  onRate?: (value: number) => void;
  /** 尺寸：`xs` 行内紧凑（12px），`sm` 面板 / 播放页（16px） */
  size?: "xs" | "sm";
  /** 是否显示「N 星」文字（只读展示用不到） */
  className?: string;
}): React.JSX.Element {
  const [hover, setHover] = useState(0);
  const size = props.size ?? "sm";
  const iconClass = size === "xs" ? "h-3 w-3" : "h-4 w-4";
  const interactive = typeof props.onRate === "function";
  // 悬停预览优先，没悬停时显示真实值
  const shown = hover > 0 ? hover : props.value;

  return (
    <div
      className={`flex items-center gap-0.5 ${props.className ?? ""}`}
      role={interactive ? "radiogroup" : undefined}
      aria-label={interactive ? "评分" : undefined}
      onMouseLeave={() => setHover(0)}
    >
      {[1, 2, 3, 4, 5].map((star) => {
        const filled = star <= shown;
        return (
          <button
            key={star}
            type="button"
            role={interactive ? "radio" : undefined}
            aria-checked={interactive ? star === props.value : undefined}
            aria-label={interactive ? `${star} 星` : undefined}
            tabIndex={interactive ? (star === props.value || (props.value === 0 && star === 1) ? 0 : -1) : -1}
            disabled={!interactive}
            title={interactive ? `${star} 星（再点一次清除）` : undefined}
            onMouseEnter={() => {
              if (interactive) setHover(star);
            }}
            onClick={(event) => {
              event.stopPropagation();
              // 再点同一分值 = 清除，和「点第 N 颗 = N 分」共用一颗星，不额外加按钮
              props.onRate?.(star === props.value ? 0 : star);
            }}
            className={`rounded p-0.5 transition-colors ${
              interactive
                ? "cursor-pointer text-muted-foreground/60 hover:text-amber-400"
                : "cursor-default text-muted-foreground/40"
            }`}
          >
            <Star
              className={`${iconClass} ${
                filled ? "fill-amber-400 text-amber-400" : "fill-transparent"
              }`}
            />
          </button>
        );
      })}
    </div>
  );
}
