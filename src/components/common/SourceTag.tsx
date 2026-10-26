import type React from "react";
import { LOCAL_PLATFORM } from "@/lib/platform";
import { useSourceColor, useSourceShort } from "@/stores/sourceRegistry";
import { cn } from "@/lib/utils";

/**
 * 歌名右侧的「平台简称」徽标。
 *
 * 全项目只有这一个实现：正在播放页（大号歌名旁）与各处音乐列表（曲目行歌名旁）
 * 用的是同一个组件、同一套配色 —— 用户要求「所有音乐列表都要在歌名右边标出平台，
 * 样式和详情页一致」，各写一份必然有一天两边配色对不上。
 *
 * 展示的是数据包下发的**简称**（`sourceRegistry` 的 `short`，如「网易云」「QQ」），
 * 不是全名（「网易云音乐」）：列表里歌名本来就长，全名会把歌名挤掉一截。
 * 简称缺失的旧版数据包退回全名。
 *
 * 底色用该音源的颜色做 16% 淡底、文字用本色 —— 与正在播放页完全一致，
 * 不抢标题的视觉重心。本地曲目没有「平台」概念，返回 null（调用处不必判 platform）。
 */
export function SourceTag(props: {
  platform: string;
  /**
   * `sm`（默认）：正在播放页那种 11px；`xs`：列表行内 10px —— 行高只有 20px，
   * 11px 的徽标会把行撑高、行距变得忽宽忽窄。
   */
  size?: "sm" | "xs";
  className?: string;
}): React.JSX.Element | null {
  const short = useSourceShort(props.platform);
  const color = useSourceColor(props.platform);
  if (props.platform === LOCAL_PLATFORM) return null;
  return (
    <span
      title={`来源：${short}`}
      className={cn(
        // whitespace-nowrap：简称是整体，折行会把「网易云」劈成两半
        "shrink-0 whitespace-nowrap rounded font-medium leading-none",
        props.size === "xs" ? "px-1 py-0.5 text-[10px]" : "px-1.5 py-0.5 text-[11px]",
        props.className,
      )}
      style={{
        color,
        backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)`,
      }}
    >
      {short}
    </span>
  );
}
