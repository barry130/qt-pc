import { useEffect, useRef, useState } from "react";
import { errMsg } from "@/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import type { Chart, SourceId, Track } from "@/types";
import * as sourceApi from "@/source-scripts";
import { loadChartDetail } from "@/lib/chart-detail";
import { useMusicSourceStore } from "@/stores/musicSource";
import { usePlayerStore } from "@/stores/player";
import { useSourceLabel, useSourceRegistryStore } from "@/stores/sourceRegistry";
import { ChartSpotlightCard, SPOTLIGHT_TRACKS, useSpotlightColumns } from "./ChartSpotlight";

/**
 * 排行榜（路由 /charts，DESIGN §5.2）。
 *
 * **版式与首页「榜单精选」是同一套**：同一张 `ChartSpotlightCard`（左封面 + 右前
 * 三首）、同一份几何常量、同一个 `useSpotlightColumns` 按内容区实测宽度算列数。
 * 差别只在「铺多大」—— 首页是 2 排的一条精选，本页是当前音源的全部榜单铺满整页。
 * 共用一套版式而不是各画一版长得像的，是为了「首页看到的那张榜，点『全部榜单』
 * 进来还是那张卡」：卡片会变样的话，用户会以为进了另一个地方。
 * 详情缓存也因此是共用的（`@/lib/chart-detail`），从首页点进来不必把整榜重拉一遍。
 *
 * **按指定音源展示，不做全源聚合** —— 聚合版把四个源的榜单拼成一屏，同源榜单
 * 被其它源的榜单隔开、顺序随注册表漂移，且任一源失败都会让整屏缺项。
 * 改成单源后：**跟随全局「音源设置」里选中的音源，页面本身不再放音源切换器**
 * （2026-10-06：顶部那排「网易云音乐/QQ音乐…」tag 删掉了——全局切换器已经在
 * 侧边栏/标题栏统一出口，页面里再放一排是重复入口，且两处状态容易打架）。
 * 换音源在全局切换即可，本页随之刷新。
 *
 * 本音源没有榜单时显示「该音源暂无榜单」，不再预先做 features.charts 过滤——
 * 跟随全局的情况下，用户看到的空缺原因必须真实：是这个源没有榜单，而不是
 * 不知道去哪里找。
 */
export function ChartsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const play = usePlayerStore((s) => s.play);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const activeSourceId = useMusicSourceStore((s) => s.activeSourceId);
  const sourceLabel = useSourceLabel(activeSourceId);
  // 注册表世代：装/卸/换数据包后 +1。本页 keep-alive 常驻，不盯世代的话，
  // 卸载包后旧榜单会一直残留（activeSourceId 不变，effect 永不重跑）。
  const metaGeneration = useSourceRegistryStore((s) => s.generation);

  const [charts, setCharts] = useState<Chart[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 每张卡的曲目：键 = `音源:榜单 id`；未到 = 骨架屏（同首页「榜单精选」） */
  const [chartTracks, setChartTracks] = useState<Record<string, Track[]>>({});
  /** 已经发起过请求的榜单，避免重排/滚动反复打源站（失败也记，不自动重试） */
  const requested = useRef<Set<string>>(new Set());
  /** 整页都是网格，ref 同时给 useSpotlightColumns 测宽和下面的可视区懒加载 */
  const { gridRef, cols } = useSpotlightColumns(charts.length > 0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const list = await sourceApi.getCharts(activeSourceId as SourceId);
        if (cancelled) return;
        setCharts(Array.isArray(list) ? list : []);
      } catch (err) {
        if (cancelled) return;
        setCharts([]);
        setError(errMsg(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSourceId, metaGeneration]);

  /**
   * 卡片详情按**可视区**懒加载 —— 本页与首页最要紧的一处刻意不同。
   *
   * 首页最多只展示 10 张卡（列数上限 × 2 排），所以它把这 10 个榜的详情一次并发
   * 打出去；本页是「全部榜单」出口、条数由源站决定（四个源都在 20 张上下），而
   * chartDetail 契约没有 limit、一次就是整榜（包内最多 200 条）。照首页那样全量并发
   * 会在进页瞬间甩出二十几个整榜请求，既慢又像爬虫。
   *
   * 所以卡片进视口（前面留 240px，同 PlaylistsPage 哨兵的口径）才去要它的前 3 首，
   * 没到的地方留着骨架屏。IntersectionObserver 在 observe 的下一帧就会为每个目标发
   * 一次初始回调，所以首屏那几张不需要额外的预热分支。
   *
   * 没有 IntersectionObserver（测试环境 / 老内核）时退回全量取：版式照旧，只是少了
   * 省流那一层，不能让页面在这里卡住不显示曲目。
   */
  useEffect(() => {
    if (charts.length === 0) return;
    const grid = gridRef.current;
    if (grid === null) return;

    const load = (chart: Chart): void => {
      const key = `${chart.platform}:${chart.id}`;
      if (requested.current.has(key)) return;
      requested.current.add(key);
      if (chart.contentType === "programs") {
        setChartTracks((prev) => ({ ...prev, [key]: [] }));
        return;
      }
      void loadChartDetail(chart)
        .catch(() => [] as Track[])
        .then((list) => {
          // 单个榜挂了不该让整页报错：记成空数组，卡片显示「暂无曲目」
          setChartTracks((prev) => ({ ...prev, [key]: list }));
        });
    };

    if (typeof IntersectionObserver === "undefined") {
      for (const chart of charts) load(chart);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          // 卡片是网格的直接子节点、顺序与 charts 一一对应，所以下标即索引；
          // 不在卡上加 data-index 是因为卡片组件不接受额外属性（同首页的取数口径）
          const idx = Array.from(grid.children).indexOf(entry.target);
          const chart = idx >= 0 ? charts[idx] : undefined;
          if (chart !== undefined) load(chart);
          io.unobserve(entry.target);
        }
      },
      { rootMargin: "240px" },
    );
    for (const node of Array.from(grid.children)) io.observe(node);
    return () => io.disconnect();
    // cols 不是读值、只当重排信号：列数一变卡片位置全变，视口里是谁要重算一遍
  }, [charts, cols, gridRef]);

  /** 整张榜入队：节目型榜单只浏览节目，不请求或播放容器。 */
  const playChart = async (chart: Chart): Promise<void> => {
    if (chart.contentType === "programs") return;
    const list =
      chartTracks[`${chart.platform}:${chart.id}`] ??
      (await loadChartDetail(chart).catch(() => [] as Track[]));
    if (list.length > 0) await playQueue(list, 0);
  };

  const openChart = (chart: Chart): void => {
    if (chart.contentType === "programs") {
      void navigate({
        to: "/audio-chart/$platform/$id",
        params: { platform: chart.platform, id: chart.id },
      });
      return;
    }
    void navigate({
      to: "/chart/$platform/$id",
      params: { platform: chart.platform, id: chart.id },
    });
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="border-b border-border px-4 py-3">
        <h1 className="text-base font-medium">排行榜</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">
          跟随当前音源（{sourceLabel}），点歌名直接播放，点榜单名看全部歌曲
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading && charts.length === 0 && (
          <div className="py-10 text-center text-sm text-muted-foreground">加载中…</div>
        )}
        {!loading && error && (
          <div className="py-10 text-center text-sm text-destructive">加载失败：{error}</div>
        )}
        {!loading && !error && charts.length === 0 && (
          <div className="py-10 text-center text-sm text-muted-foreground">该音源暂无榜单</div>
        )}
        {charts.length > 0 && (
          <div
            ref={gridRef}
            className="grid gap-4"
            // 列数由容器实测宽度决定（见 useSpotlightColumns）；1fr 均分 → 每行铺满，
            // 卡片在 360px 基础上略微拉伸吃掉余数（与首页「榜单精选」同一行口径）
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          >
            {charts.map((c) => (
              <ChartSpotlightCard
                key={`${c.platform}-${c.id}`}
                chart={c}
                tracks={chartTracks[`${c.platform}:${c.id}`]?.slice(0, SPOTLIGHT_TRACKS)}
                total={chartTracks[`${c.platform}:${c.id}`]?.length}
                onOpen={() => openChart(c)}
                onPlayAll={() => void playChart(c)}
                onPlayTrack={(t) => void play(t)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}