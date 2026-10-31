import { cn } from "@/lib/utils";

/**
 * 骨架屏原语（列表 / 网格两种形状 + 一块基础占位）。
 *
 * 为什么要收成一层（用户 m09915）：发现系页面用形状骨架，而「本地音乐 / 最近播放 /
 * 下载管理 / 我的歌单 / 本地文件夹 / 榜单 / 有声榜 / 消息」各自用「转圈 + 加载中…」，
 * 同一件事两套观感。骨架比转圈好在**占位形状与真实内容一致**——数据到达时是替换而不是
 * 重新排版，不会出现「一行小字 → 一整屏内容」那种跳变。
 *
 * 约定：
 * - 骨架本体一律 `aria-hidden`，另配一条 `sr-only` 的 `role="status"` 播报，
 *   读屏用户听到「正在加载」而不是一片空白；
 * - 形状只做到「看起来像什么」，不复制真实排版细节——跟得太紧，设计一改就得同步改骨架。
 * - 列表的内边距由调用方的行样式决定（行自带 px-4 py-2）；网格默认补 `p-4`，
 *   因为网格页的滚动容器通常不带内边距。
 */

/** 单块占位（自定义形状时直接用这个拼） */
export function Skeleton(props: { className?: string }): React.JSX.Element {
  return <div aria-hidden className={cn("animate-pulse rounded bg-secondary", props.className)} />;
}

/** 读屏播报：骨架对无障碍不可见，加载这件事得有声音说明 */
function SkeletonStatus(props: { label: string }): React.JSX.Element {
  return (
    <span role="status" className="sr-only">
      {props.label}
    </span>
  );
}

/**
 * 列表骨架：曲目行 / 歌单行 / 下载任务 / 消息行共用。
 *
 * `cover` 决定行首缩略图形状——曲目与歌单是方形封面，歌手与消息是圆形/无图，
 * 纯文本行（文件夹、消息）干脆不画，否则会给出「这里有个封面」的错误预期。
 */
export function RowsSkeleton(props: {
  /** 行数，默认 8 */
  rows?: number;
  /** 行首缩略图：方形（默认）/ 圆形 / 不画 */
  cover?: "square" | "circle" | "none";
  /** 缩略图边长（px），默认 36（与曲目行的 9 宫格封面一致） */
  coverSize?: number;
  /** 读屏播报文案，默认「正在加载…」 */
  label?: string;
  className?: string;
}): React.JSX.Element {
  const rows = props.rows ?? 8;
  const cover = props.cover ?? "square";
  const size = props.coverSize ?? 36;
  return (
    <>
      <SkeletonStatus label={props.label ?? "正在加载…"} />
      <div aria-hidden className={cn("animate-pulse", props.className)}>
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex items-center gap-3 px-4 py-2">
            {cover === "none" ? null : (
              <div
                className={cn("shrink-0 bg-secondary", cover === "circle" ? "rounded-full" : "rounded")}
                style={{ width: size, height: size }}
              />
            )}
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="h-3 w-1/3 rounded bg-secondary" />
              <div className="h-2.5 w-1/5 rounded bg-secondary" />
            </div>
            <div className="h-2.5 w-8 shrink-0 rounded bg-secondary" />
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * 网格骨架：封面上墙（歌单广场、榜单、有声节目）共用。
 *
 * 列宽口径与 `CoverGrid` 一致（`auto-fill` + 128px 底），只是最小列宽可调：
 * 有声节目那种「封面 + 两行文字」的宽卡片给 220px 才不会挤成一列方块。
 */
export function GridSkeleton(props: {
  /** 占位块数，默认 8 */
  count?: number;
  /** 最小列宽（px），默认 128 */
  minTile?: number;
  /** 自带 p-4 内边距，默认 true；容器已有内边距时传 false */
  padded?: boolean;
  /** 读屏播报文案，默认「正在加载…」 */
  label?: string;
  className?: string;
}): React.JSX.Element {
  const count = props.count ?? 8;
  const minTile = props.minTile ?? 128;
  return (
    <>
      <SkeletonStatus label={props.label ?? "正在加载…"} />
      <div aria-hidden className={cn("animate-pulse", props.padded !== false && "p-4", props.className)}>
        <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${minTile}px, 1fr))` }}>
          {Array.from({ length: count }, (_, index) => (
            <div key={index}>
              <div className="aspect-square w-full rounded-xl bg-secondary" />
              <div className="mt-2 h-3 w-3/4 rounded bg-secondary" />
              <div className="mt-1.5 h-2.5 w-1/2 rounded bg-secondary" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
