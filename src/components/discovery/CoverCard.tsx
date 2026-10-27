import { memo, useEffect, useRef, useState } from "react";
import { Play } from "lucide-react";
import { qtresCoverUrl } from "@/lib/lrc";
import { cn } from "@/lib/utils";

type CoverCardProps<T> = {
  name: string;
  picUrl: string;
  /** 副标题：歌单显示播放量，榜单显示简介 */
  subtitle?: string;
  /**
   * 版式：`grid`（默认）铺满所在网格列；`row` 用于横向滚动行，固定 128px 不伸缩。
   *
   * 不用「外部传 className 覆盖」是因为根节点已带 `w-full`，再叠一个 `w-32`
   * 两者特异性相同，最终宽度取决于样式表里的先后顺序 —— 属于看运气的写法。
   */
  layout?: "grid" | "row";
  /**
   * 卡片对应的数据项。与 `onPick` 一起传，而不是让调用方内联 `onClick={() => …}`：
   * 网格里几十上百张卡片，内联箭头每次都换新引用会把 memo 打穿（#12）。
   */
  item: T;
  onPick: (item: T) => void;
};

/**
 * 封面卡片（歌单广场 / 排行榜 / 首页推荐 / 搜索结果共用）。
 * 封面统一经 qtres:// 走 Rust 侧 Range 透传（DESIGN §6.13，带 Referer 防盗链）。
 *
 * memo：无限滚动会累积数百张卡，父级任何一次重渲（翻页 loading 翻转、排序切换）
 * 都不该让已经渲染过的卡片重画。props 全是原始值 + 稳定回调，浅比较足够。
 */
function CoverCardInner<T>(props: CoverCardProps<T>): React.JSX.Element {
  const { name, picUrl, subtitle, layout = "grid", item, onPick } = props;
  const cover = qtresCoverUrl(picUrl);
  // 上游 404 / 代取失败 → <img> error，退到首字兜底，不留空白卡
  const [loadFailed, setLoadFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={() => onPick(item)}
      // grid：w-full 不能省 —— grid item 会 stretch 撑开，但放进横向滚动卡片行
      // （普通 flex/div 容器）时 button 是 inline-block，不写 w-full 会按内容收缩。
      // row：w-32 shrink-0 与「新歌速递」的 TrackCard 同宽，行内不参与压缩。
      // active:scale 是按压反馈（80-150ms、不改布局边界）
      className={cn(
        "group block text-left transition-transform duration-150 active:scale-[0.98]",
        layout === "row" ? "w-32 shrink-0 snap-start" : "w-full",
      )}
    >
      <div className="relative aspect-square w-full overflow-hidden rounded-xl shadow-md ring-1 ring-inset ring-foreground/10 transition-shadow duration-200 group-hover:shadow-xl">
        {cover && !loadFailed ? (
          <img
            src={cover}
            alt=""
            className="h-full w-full object-cover transition-transform duration-300 motion-safe:group-hover:scale-105"
            loading="lazy"
            onError={() => setLoadFailed(true)}
          />
        ) : (
          // 部分榜单（如「巅峰榜·热歌」）音源根本不给图片字段，
          // 这里用首字 + 渐变兜底，避免整块空白
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-secondary via-muted to-secondary">
            <span className="select-none text-4xl font-semibold text-muted-foreground/50">
              {name.slice(0, 1)}
            </span>
          </div>
        )}
        {/* 悬停：渐变遮罩 + 播放按钮 */}
        <div className="absolute inset-0 flex items-end justify-end bg-gradient-to-t from-black/45 via-transparent to-transparent p-3 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <span className="flex h-10 w-10 translate-y-1 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform duration-200 group-hover:translate-y-0">
            <Play className="h-4 w-4 fill-current" />
          </span>
        </div>
      </div>
      {/* 字号随版式走：row 与相邻的「新歌速递」TrackCard 逐级对齐（12px / 11px），
          两行卡片同宽同构却差 2px 字号会被看成没对齐的 bug */}
      <div
        className={cn(
          "mt-2 truncate font-medium",
          layout === "row" ? "text-xs" : "text-sm",
        )}
      >
        {name}
      </div>
      {subtitle ? (
        <div
          className={cn(
            "mt-0.5 truncate text-muted-foreground",
            layout === "row" ? "text-[11px]" : "text-xs",
          )}
        >
          {subtitle}
        </div>
      ) : null}
    </button>
  );
}

/**
 * 泛型组件的 memo 包装：`memo()` 会擦掉泛型参数，这里用断言把签名找回来，
 * 调用方仍按 `item` 的类型推断 `onPick`，不需要显式标注类型实参。
 */
export const CoverCard = memo(CoverCardInner) as typeof CoverCardInner;

/**
 * 卡片网格容器（歌单广场 / 排行榜 / 搜索结果共用，一律整排铺满）。
 *
 * 列数按**容器实测宽度**算，而不是 Tailwind 的视口断点：主内容区会被侧边栏和
 * 队列面板挤压，视口宽度对不上内容区宽度。
 *
 * 此前还有 `fillRows` / `maxRows` 两个入参，用于首页「推荐歌单」裁成整排、只留一行。
 * 该区块已改为横向滚动行（见 DiscoverPage），两个入参失去调用方，一并删除 ——
 * 留着会让人以为首页仍在用网格，而它们的语义（裁数据）对滚动行也不成立。
 */
/** 目标卡片宽度（px）与间隙：128 与「新歌速递」的横滚卡片同宽 */
const TARGET_CARD_W = 128;
const GAP = 12;

export function CoverGrid(props: {
  children: React.ReactNode;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const [cols, setCols] = useState(5);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w <= 0) return;
      const c = Math.floor((w + GAP) / (TARGET_CARD_W + GAP));
      setCols(Math.max(3, Math.min(14, c)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className="grid gap-4"
      // 1fr 均分 → 每行铺满整屏；卡片宽度会在 128px 基础上略微拉伸吃掉余数
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {props.children}
    </div>
  );
}

/** 区块标题（首页 / 各列表页的 "新歌速递" "热门歌单" 等） */
export function SectionTitle(props: {
  title: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="mb-4 flex items-baseline justify-between">
      <h2 className="text-xl font-bold tracking-tight">{props.title}</h2>
      {props.action}
    </div>
  );
}
