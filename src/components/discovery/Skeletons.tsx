import { CircleAlert } from "lucide-react";

/**
 * 骨架屏（UX 审查 High：加载超过 300ms 必须有形状反馈，「加载中…」文字算空白态）。
 * 形状对齐真实内容：曲目行 = 封面块 + 标题/副标题条 + 时长条；
 * 封面卡 = 方图 + 两行文字条（宽度与 CoverCard 一致）。
 * 整体 aria-hidden + animate-pulse，替换真实内容时无布局跳动。
 */

/** 曲目列表骨架（歌单 / 榜单 / 歌手 / 专辑详情共用） */
export function TrackRowsSkeleton(props: { rows?: number }): React.JSX.Element {
  const rows = props.rows ?? 8;
  return (
    <div aria-hidden className="animate-pulse">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-2">
          <div className="h-9 w-9 shrink-0 rounded bg-secondary" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3 w-1/3 rounded bg-secondary" />
            <div className="h-2.5 w-1/5 rounded bg-secondary" />
          </div>
          <div className="h-2.5 w-8 shrink-0 rounded bg-secondary" />
        </div>
      ))}
    </div>
  );
}

/** 封面网格骨架（与 CoverGrid 同为 auto-fill 128px 列，占位形状一致） */
export function CoverGridSkeleton(props: { count?: number }): React.JSX.Element {
  const count = props.count ?? 8;
  return (
    <div aria-hidden className="animate-pulse p-4">
      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(128px, 1fr))" }}
      >
        {Array.from({ length: count }, (_, i) => (
          <div key={i}>
            <div className="aspect-square w-full rounded-xl bg-secondary" />
            <div className="mt-2 h-3 w-3/4 rounded bg-secondary" />
            <div className="mt-1.5 h-2.5 w-1/2 rounded bg-secondary" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** 详情页错误态：图标 + 原因 + 重试按钮（避免死胡同，审查 No Results 规范） */
export function ErrorRetry(props: {
  message: string;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <CircleAlert className="h-8 w-8 text-muted-foreground/50" />
      <p className="max-w-md text-sm text-destructive">{props.message}</p>
      <button
        type="button"
        onClick={props.onRetry}
        className="h-8 rounded-md border border-border px-4 text-sm transition-colors hover:bg-secondary"
      >
        重试
      </button>
    </div>
  );
}
