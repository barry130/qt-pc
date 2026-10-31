import { cn } from "@/lib/utils";

/**
 * 内容区块的标题与卡片外观。
 *
 * 详情节（专辑 / 歌手 / 榜单 / 歌单 / 每日推荐）顶部那一大块 Hero 里的
 * 「EYEBROW 小字 + 二号标题 + 说明」在 5 个页面里逐字重复，字号、字重、
 * 大字距各自微调过。这里固定成两档：
 * - `size="page"`：页面级（Hero 里、设置页顶部），`text-xl font-bold tracking-tight`；
 * - `size="section"`：卡片内的小节（`text-sm font-semibold`），与 `Card` 搭配。
 *
 * `eyebrow` 用 `tracking-[0.2em]` 的大写字距标签，是详情节统一的「你正在看什么」
 * 提示（PLAYLIST / ALBUM / CHART），没有它详情节的层级会塌成一片。
 */
export function SectionHeader(props: {
  /** 上方的大字距小标签（PLAYLIST / 最近在听…） */
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** 右侧操作区（与标题同一行，垂直居中） */
  actions?: React.ReactNode;
  size?: "page" | "section";
  /** 标题的语义级别，默认 h2（页面级标题通常由 PageContainer 的 h1 承担） */
  as?: "h1" | "h2" | "h3";
  className?: string;
}): React.JSX.Element {
  const Heading = props.as ?? "h2";
  const size = props.size ?? "section";
  return (
    <div className={cn("flex items-end justify-between gap-3", props.className)}>
      <div className="min-w-0">
        {props.eyebrow !== undefined && (
          <p className="text-2xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
            {props.eyebrow}
          </p>
        )}
        <Heading
          className={cn(
            "truncate",
            size === "page"
              ? "mt-1 text-xl font-bold tracking-tight"
              : "text-sm font-semibold text-foreground",
          )}
        >
          {props.title}
        </Heading>
        {props.description !== undefined && (
          <p className="mt-1 text-xs text-muted-foreground">{props.description}</p>
        )}
      </div>
      {props.actions !== undefined && <div className="shrink-0">{props.actions}</div>}
    </div>
  );
}

/**
 * 通用卡片容器：`rounded-xl border bg-card/60`。
 *
 * 全仓大量「一块带描边的浅底面板」各写各的（bg-card / bg-card/60 / bg-secondary/50、
 * rounded-lg / rounded-xl / rounded-2xl）。这里只提供一种「页面里的内容块」外观；
 * 弹出的浮层请用 `Popover`（它有 shadow-raised 与层级），浮在最上的模态用 `Modal`。
 */
export function Card(props: {
  children?: React.ReactNode;
  /** 内边距档位，默认 md（16px）；列表类内容用 none 自己控制 */
  padding?: "none" | "sm" | "md";
  className?: string;
  as?: "div" | "section" | "li";
}): React.JSX.Element {
  const As = props.as ?? "div";
  return (
    <As
      className={cn(
        "rounded-xl border border-border bg-card/60",
        props.padding === "none"
          ? ""
          : props.padding === "sm"
            ? "p-3"
            : "p-4",
        props.className,
      )}
    >
      {props.children}
    </As>
  );
}
