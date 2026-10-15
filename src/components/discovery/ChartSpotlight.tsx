import { useState } from "react";
import { Play } from "lucide-react";
import type { Chart, Track } from "@/types";
import { qtresCoverUrl } from "@/lib/lrc";

/**
 * 首页「榜单精选」卡片：左侧榜单封面 + 右侧前 3 首，点歌名直接播这一首，
 * 点封面上的播放键把整张榜入队。
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
  const hint = total !== undefined && total > 0 ? `共 ${total} 首` : null;

  return (
    <div className="group flex flex-col rounded-xl border border-border bg-card/60 p-4 transition-shadow duration-200 hover:shadow-lg">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <button
          type="button"
          onClick={onOpen}
          title={chart.name}
          className="min-w-0 truncate text-base font-bold transition-colors hover:text-primary"
        >
          {chart.name}
        </button>
        {hint !== null ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </div>

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
              onClick={onPlayAll}
              aria-label={`播放榜单 ${chart.name}`}
              className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity duration-200 group-hover/cover:opacity-100"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg">
                <Play className="h-4 w-4 fill-current" />
              </span>
            </button>
          </div>
        </div>

        <ol className="min-w-0 flex-1">
          {tracks === undefined
            ? Array.from({ length: 3 }, (_, i) => (
                <li key={i} className="px-1 py-1.5">
                  <div className="h-3 w-full animate-pulse rounded bg-muted" />
                </li>
              ))
            : tracks.map((t, i) => (
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
              ))}
          {tracks !== undefined && tracks.length === 0 ? (
            <li className="px-1 py-1 text-xs text-muted-foreground">暂无曲目</li>
          ) : null}
        </ol>
      </div>
    </div>
  );
}
