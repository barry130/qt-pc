/**
 * 「下一首播放」专用图标：播放三角 + 右下角的回车形（箭头朝左，就是 ↵）。
 *
 * 为什么不用现成的 lucide 图标：
 *   - `Play` 和「播放」完全同形，用户会以为那个按钮是播放；
 *   - `ListStart`（≡ + 细箭头）在行内 14px 下笔画糊成一团，同样认不出来；
 *   - `SkipForward`（⏭）仍是三角形，还是像播放。
 * 这个复合形把两件事一次说清：实心三角＝「这首」，回车形＝「插到它后面」。
 *
 * 几何按 24×24 / stroke-width 2 的 lucide 约定写，跟相邻图标同一套视觉。
 * 三角必须**填充**：14px 下描边三角会和回车形的笔画糊成一个方块，
 * 实测填充版才能一眼分出「三角 + 钩」。改坐标前先看 `.tmp` 里
 * 14px 的像素放大对比，别只在大图上调 —— 矢量放大图会骗人。
 */
export function PlayNextIcon(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={props.className}
    >
      {/* 播放三角（实心，左上） */}
      <path d="M4 3 L14 9 L4 15 Z" fill="currentColor" stroke="none" />
      {/* 回车形：向下拐、再向左 */}
      <path d="M17 8 V13 a3 3 0 0 1 -3 3 H9" />
      {/* 箭头（朝左） */}
      <path d="M12 13 L9 16 L12 19" />
    </svg>
  );
}
