import { cn } from "@/lib/utils";

/**
 * 「正在播放」跳动条：三根竖条按错峰延迟上下跳。
 *
 * 用途：卡片/列表里标识「当前曲目在播」。比换一个实心播放图标更好读 ——
 * 静止的图标无法区分「正在播」和「可以播」，动起来才有播放中的含义，
 * 且暂停时动画会停（`playing=false`），语义仍然成立。
 *
 * 尺寸由调用方用 className 控制（h-* / gap-* / text-* 决定竖条颜色，
 * 竖条用 currentColor 取色），内联 height 只给竖条高度比例。
 */
export function EqBars(props: {
  playing: boolean;
  className?: string;
}): React.JSX.Element {
  const { playing, className } = props;
  return (
    <span
      aria-hidden
      className={cn("flex h-3 items-end gap-[2px]", className)}
    >
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className={cn(
            "w-[2px] rounded-full bg-current",
            playing ? "qt-eq-bar" : "",
          )}
          style={{
            // 循环曲线上的静止位置：三根不等高，静止时也像「一根未跳完的波形」
            height: `${[60, 100, 45][index]}%`,
            animationDelay: `${index * 160}ms`,
          }}
        />
      ))}
    </span>
  );
}
