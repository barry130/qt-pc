import { useLayoutEffect, useRef, useState } from "react";
import { Headphones, Play } from "lucide-react";
import type { Chart, Track } from "@/types";
import { qtresCoverUrl } from "@/lib/lrc";

/**
 * 「榜单精选」版式的几何常量。
 *
 * 首页 / 与 /charts（排行榜）**共用这一套**，两页的卡片大小、列数上限、每行间的
 * 疏密因此天然一致 —— 排行榜页是把首页那块版式铺满整页，不是另做一版长得像的。
 * 只把几何放这里；「取几条、点刷新绕不绕缓存」这类页面策略留在各自页面。
 */
/** 列数下限 2：改造前首页的固定列数，窗口收到最窄也不至于退成单列 */
export const SPOTLIGHT_MIN_COLS = 2;
/**
 * 列数上限 5。
 *
 * 首页那边它同时决定了最多一次拉几个榜的详情（见 DiscoverPage 的 SPOTLIGHT_FETCH）；
 * 每多展示一张卡就多一次 chartDetail 请求，不封顶的话 4K 屏会一次甩出十几个请求。
 * 排行榜页虽然整页都是卡，但按可视区懒加载详情，同样不需要更大的列数。
 */
export const SPOTLIGHT_MAX_COLS = 5;
/**
 * 卡片的最小宽度（px）与卡片间隙（与 grid 的 gap-4 对齐）。
 *
 * 360 的来由：卡片左侧是 80px 封面，右侧一列曲目（名次 + 歌名 - 歌手），
 * 两侧各 16px 内边距、中间 12px 间距 —— 再窄曲目名就只剩几个字。
 * 与 CoverGrid 的 128 不是一回事：那是纯封面卡，这里一张卡的信息量顶三张封面。
 */
export const SPOTLIGHT_CARD_MIN_W = 360;
export const SPOTLIGHT_GAP = 16;
/** 每张卡右侧的曲目条数 */
export const SPOTLIGHT_TRACKS = 3;

/**
 * 榜单卡网格的列数：按**容器实测宽度**算，不用 Tailwind 的视口断点 —— 主内容区
 * 会被侧边栏和播放队列面板挤压，视口宽度对不上内容区宽度（同 CoverGrid 的口径）。
 *
 * 用 useLayoutEffect 而不是 useEffect：测到之前会先按初始列数画一帧，等 effect
 * 再改成 3~5 列，宽屏上能看见卡片「重新排版」的那一下。布局阶段同步测完，第一帧
 * 就是最终列数。
 *
 * `mounted` 是重测触发条件：空态时渲染的是空区块、没有 grid 可测，等数据到了
 * grid 才出现、这个布尔量翻转，effect 才拿得到 ref（依赖 ref.current 本身不触发重跑）。
 */
export function useSpotlightColumns(mounted: boolean): {
  gridRef: React.RefObject<HTMLDivElement | null>;
  cols: number;
} {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [cols, setCols] = useState(SPOTLIGHT_MIN_COLS);

  useLayoutEffect(() => {
    const el = gridRef.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const measure = (): void => {
      const w = el.clientWidth;
      // 切走（KeepAliveOutlet 的 display:none）时宽度归零，保留上一次的列数，
      // 切回来 ResizeObserver 会再报一次真实宽度
      if (w <= 0) return;
      const c = Math.floor((w + SPOTLIGHT_GAP) / (SPOTLIGHT_CARD_MIN_W + SPOTLIGHT_GAP));
      setCols(Math.max(SPOTLIGHT_MIN_COLS, Math.min(SPOTLIGHT_MAX_COLS, c)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mounted]);

  return { gridRef, cols };
}

/**
 * 「榜单精选」卡片：左侧榜单封面 + 右侧前 3 首，点歌名直接播这一首，
 * 点封面上的播放键把整张榜入队。首页区块与排行榜页共用。
 *
 * 与 CoverCard 的区别是信息密度：这里要一眼看到榜里有什么歌，所以封面缩小到
 * 80px，右侧换成曲目列表。封面仍走 qtres:// 透传（DESIGN §6.13，带 Referer）。
 *
 * 卡片根节点是 div 而不是 button —— 内部还有「播放」和三条曲目各自可点，
 * button 套 button 是非法 HTML，浏览器会把内层拆出去。
 *
 * 底色是 `bg-card/60` 而不是实底 `bg-card`：浅色主题下 `--card` 就是纯白
 * `oklch(1 0 0)`，实底会把自定义背景图整块盖住（DESIGN §9.8 表面语言）。
 */
export function ChartSpotlightCard(props: {
  chart: Chart;
  /** 前 3 首；undefined = 还在取，渲染骨架 */
  tracks: Track[] | undefined;
  /** 整榜曲目数（用于右上角提示；未知时不显示） */
  total?: number;
  onOpen: () => void;
  onPlayAll: () => void;
  onPlayTrack: (track: Track) => void;
}): React.JSX.Element {
  const { chart, tracks, total, onOpen, onPlayAll, onPlayTrack } = props;
  const cover = qtresCoverUrl(chart.picUrl);
  const [loadFailed, setLoadFailed] = useState(false);

  /**
   * 右上角提示。参考稿这里是「刚刚更新 / 更新 19 首」这类刷新信息，但契约的
   * Chart 只有 description、没有更新时间，四个源里也只有两个会填 description
   * （酷狗恒空串、QQ 恒 null）。与其编一个时间，不如用真实拿得到的曲目数 ——
   * 形状一致（都读作「这个榜有多少东西」），且不会随时间撒谎。
   */
  const hint = total !== undefined && total > 0
    ? `共 ${total} ${chart.contentType === "programs" ? "个节目" : "首"}`
    : null;
  const isPrograms = chart.contentType === "programs";

  return (
    <div className="group flex flex-col rounded-xl border border-border bg-card/60 p-4 transition-shadow duration-200 hover:shadow-lg">
      {/* 整条标题行都是「进榜单详情」的命中区：只让标题那几个字可点太小，右侧的
          「共 N 首」看着也是这一条的一部分，点它没反应就是坏的。
          所以整行做成一个按钮、标题退成 span —— 按钮里不能再套按钮。
          -mx-2 / -mt-1 配 px-2 / pt-1 把命中区扩进卡片内边距，文字位置一动没动。 */}
      <button
        type="button"
        onClick={onOpen}
        title={chart.name}
        className="-mx-2 -mt-1 mb-3 flex items-baseline justify-between gap-3 rounded px-2 pt-1 text-left transition-colors hover:text-primary"
      >
        <span className="min-w-0 truncate text-base font-bold">{chart.name}</span>
        {hint !== null ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </button>

      <div className="flex items-start gap-3">
        {/* 封面做成「一叠」：后面两层错位的空壳，模仿参考稿里榜单封面堆叠的样子。
            纯装饰，不进无障碍树，也不参与命中测试（pointer-events-none）。 */}
        <div className="relative h-20 w-20 shrink-0">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -translate-x-1 translate-y-1 rounded-lg bg-border/50"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -translate-x-0.5 translate-y-0.5 rounded-lg bg-border/80"
          />
          <div className="group/cover relative h-full w-full overflow-hidden rounded-lg shadow-md">
            <button
              type="button"
              onClick={onOpen}
              aria-label={`查看榜单 ${chart.name}`}
              className="block h-full w-full"
            >
              {cover && !loadFailed ? (
                <img
                  src={cover}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover"
                  onError={() => setLoadFailed(true)}
                />
              ) : (
                // 部分榜单不给图（见 CoverCard 同款兜底），用首字 + 渐变占位
                <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-secondary via-muted to-secondary">
                  <span className="select-none text-2xl font-semibold text-muted-foreground/50">
                    {chart.name.slice(0, 1)}
                  </span>
                </div>
              )}
            </button>
            {/* 整张榜入队：详情是懒加载的（列表只取前 3 首），这里按需再拉一次全量 */}
            <button
              type="button"
              onClick={isPrograms ? onOpen : onPlayAll}
              aria-label={isPrograms ? `浏览榜单节目 ${chart.name}` : `播放榜单 ${chart.name}`}
              className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity duration-200 group-hover/cover:opacity-100"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg">
                {isPrograms ? <Headphones className="h-4 w-4" /> : <Play className="h-4 w-4 fill-current" />}
              </span>
            </button>
          </div>
        </div>

        <ol className="min-w-0 flex-1">
          {isPrograms ? (
            <li className="px-1 py-1 text-xs text-muted-foreground">
              点击查看节目列表
            </li>
          ) : tracks === undefined ? (
            Array.from({ length: 3 }, (_, i) => (
              <li key={i} className="px-1 py-1.5">
                <div className="h-3 w-full animate-pulse rounded bg-muted" />
              </li>
            ))
          ) : (
            tracks.map((t, i) => (
              <li key={`${t.id}-${i}`}>
                <button
                  type="button"
                  onClick={() => onPlayTrack(t)}
                  title={`${t.title} - ${t.singer}`}
                  className="flex w-full items-center gap-2 rounded px-1 py-1 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  <span className="w-3 shrink-0 text-xs tabular-nums text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs">
                    {t.title} - {t.singer}
                  </span>
                </button>
              </li>
            ))
          )}
          {!isPrograms && tracks !== undefined && tracks.length === 0 ? (
            <li className="px-1 py-1 text-xs text-muted-foreground">暂无曲目</li>
          ) : null}
        </ol>
      </div>
    </div>
  );
}
