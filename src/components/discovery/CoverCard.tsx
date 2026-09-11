import { Children, useEffect, useRef, useState } from "react";
import { Play } from "lucide-react";
import { qtresCoverUrl } from "@/lib/lrc";

/**
 * 封面卡片（歌单广场 / 排行榜 / 首页推荐共用）。
 * 封面统一经 qtres:// 走 Rust 侧 Range 透传（DESIGN §6.13，带 Referer 防盗链）。
 */
export function CoverCard(props: {
  name: string;
  picUrl: string;
  /** 副标题：歌单显示播放量，榜单显示简介 */
  subtitle?: string;
  onClick: () => void;
}): React.JSX.Element {
  const { name, picUrl, subtitle, onClick } = props;
  const cover = qtresCoverUrl(picUrl);
  // 上游 404 / 代取失败 → <img> error，退到首字兜底，不留空白卡
  const [loadFailed, setLoadFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      // w-full 不能省：grid item 会 stretch 撑开，但放进横向滚动卡片行
      // （普通 flex/div 容器）时 button 是 inline-block，不写 w-full 会按内容收缩
      // active:scale 是按压反馈（80-150ms、不改布局边界）
      className="group block w-full text-left transition-transform duration-150 active:scale-[0.98]"
    >
      <div className="relative aspect-square w-full overflow-hidden rounded-xl shadow-md transition-shadow duration-200 group-hover:shadow-xl">
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
      <div className="mt-2 truncate text-sm font-medium">{name}</div>
      {subtitle ? (
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</div>
      ) : null}
    </button>
  );
}

/**
 * 卡片网格容器。
 *
 * 列数按**容器实测宽度**算，而不是 Tailwind 的视口断点：主内容区会被侧边栏和
 * 队列面板挤压，视口宽度对不上内容区宽度。列数只取 3/4/6/8，这几个数能整除 24，
 * 配合 fillRows 可以保证每一排都是满的（不会出现最后一行缺一块）。
 *
 * fillRows：把数量裁到列数的整数倍，用于首页这种「多一个少一个无所谓」的展示区；
 * 列表页（歌单广场 / 榜单）不能裁，否则会吞掉分页数据，所以默认关闭。
 */
/** 目标卡片宽度（px）与间隙：128 与「新歌速递」的横滚卡片同宽 */
const TARGET_CARD_W = 128;
const GAP = 12;

export function CoverGrid(props: {
  children: React.ReactNode;
  fillRows?: boolean;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const [cols, setCols] = useState(5);
  const [measured, setMeasured] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w <= 0) return;
      const c = Math.floor((w + GAP) / (TARGET_CARD_W + GAP));
      setCols(Math.max(3, Math.min(14, c)));
      setMeasured(true);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const items = Children.toArray(props.children);
  const shown =
    props.fillRows && measured && items.length > cols
      ? items.slice(0, Math.floor(items.length / cols) * cols)
      : items;

  return (
    <div
      ref={ref}
      className="grid gap-4"
      // 1fr 均分 → 每行铺满整屏；卡片宽度会在 128px 基础上略微拉伸吃掉余数
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {shown}
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
