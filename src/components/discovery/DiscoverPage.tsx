import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { BarChart3, ChevronRight, Disc3, FileMusic, Flame, PackageOpen, RefreshCw, Sparkles } from "lucide-react";
import type { Chart, Playlist, Track } from "@/types";
import { cn } from "@/lib/utils";
import { useSourceLabel, useSourceRegistryStore, useSourceSupports } from "@/stores/sourceRegistry";
import * as sourceApi from "@/source-scripts";
import { getRecommendations } from "@/source-scripts";
import { engineSnapshot } from "@/source-engine/client";
import { useMusicSourceStore } from "@/stores/musicSource";
import { usePlayerStore } from "@/stores/player";
import { CoverCard, SectionTitle } from "./CoverCard";
import { ChartSpotlightCard } from "./ChartSpotlight";
import { HorizontalScroller } from "./HorizontalScroller";
import { TrackCard } from "./TrackCard";

/**
 * 首页 / 发现（路由 /，DESIGN §5.2 / §5.3）。
 *
 * 布局自上而下：Hero（当前音源 + 快捷入口）→ 榜单精选（卡片列数随内容区实测宽度
 * 自适应，封面 + 前三首）→ 新歌速递（横向歌曲卡）→ 推荐歌单（横向封面卡）。
 * 后两个区块同为一行横向滚动、条数一致（HOME_ROW_COUNT）：一上一下两个行，
 * 一行满一行空会被读成「数据没加载完」，同口径才像同一套版式。
 * 三个区块统一跟随全局音源（§6.4 要点 5）：榜单此前用四源聚合命令，但点进详情
 * 后该 chart 可能不属于当前源、详情页拉不到标题，故一并改为按源取。
 * 任一区块失败只降级为空区块，不弹全局错误（首页是聚合视图，允许部分为空）。
 *
 * 榜单精选取代了此前的「热门榜单」横向封面行：两处展示的是同一批榜单，
 * 而卡片版已经把「榜里有什么歌」摆出来了，封面行只是它的信息子集。
 */

/**
 * 榜单精选取几排。
 *
 * 改造前是写死的「两列 × 两排」= 4 张，现在列数随内容区实测宽度浮动，**排数不动**：
 * 只有列数变、排数不变，宽屏才是「同一块版式铺得更开」，而不是「下面又长出一截」。
 */
const SPOTLIGHT_ROWS = 2;
/** 列数下限 2：改造前的固定列数，窗口收到最窄也不至于退成单列 */
const SPOTLIGHT_MIN_COLS = 2;
/**
 * 列数上限 5 —— 它同时决定了首页最多一次拉几个榜的详情。
 *
 * 每多展示一张卡就多一次 chartDetail 请求（有进程内缓存，但首屏是并发打出去的），
 * 不封顶的话 4K 屏会一次甩出十几个请求。5 列 × 2 排 = 10 张，宽屏早已铺满。
 */
const SPOTLIGHT_MAX_COLS = 5;
/**
 * 榜单卡的最小宽度（px）与卡片间隙（与 grid 的 gap-4 对齐）。
 *
 * 360 的来由：卡片左侧是 80px 封面，右侧一列曲目（名次 + 歌名 - 歌手），
 * 两侧各 16px 内边距、中间 12px 间距 —— 再窄曲目名就只剩几个字。
 * 与 CoverGrid 的 128 不是一回事：那是纯封面卡，这里一张卡的信息量顶三张封面。
 */
const SPOTLIGHT_CARD_MIN_W = 360;
const SPOTLIGHT_GAP = 16;
/** 首页「榜单精选」一次取回的榜单条数：刚好铺满上限列数 × 排数，多取是白拿 */
const SPOTLIGHT_FETCH = SPOTLIGHT_MAX_COLS * SPOTLIGHT_ROWS;
/** 每张卡右侧的曲目条数 */
const SPOTLIGHT_TRACKS = 3;

/**
 * 首页两条横滚行（新歌速递 / 推荐歌单）各自装多少张卡。
 *
 * 两行取同一个数：一条 20 一条 30 时，滑到底的时间不一样、右箭头消失的位置
 * 也不一样，用户会以为其中一行没加载完。20 是原来新歌速递的口径（一次请求的量），
 * 也够铺满宽屏再滑一屏。
 */
const HOME_ROW_COUNT = 20;

/**
 * 榜单详情缓存（进程内，键 = 音源:榜单 id）。
 *
 * 卡片只要前 3 首，但 chartDetail 契约没有 limit 参数、只能整榜拉回来
 * （酷我/咪咕在脚本侧还是翻页取的），既然拉都拉了就留着：重渲染、切走再切回、
 * 以及「播放整榜」都直接命中，不至于为同一个榜反复打源站。
 * 只有区块标题上的刷新按钮会绕过它（force）。
 */
const chartDetailCache = new Map<string, Track[]>();

async function loadChartDetail(chart: Chart, force = false): Promise<Track[]> {
  const key = `${chart.platform}:${chart.id}`;
  if (!force) {
    const hit = chartDetailCache.get(key);
    if (hit !== undefined) return hit;
  }
  const rows = await sourceApi.getChartDetail(chart);
  const list = Array.isArray(rows) ? rows : [];
  chartDetailCache.set(key, list);
  return list;
}

const QUICK_LINKS = [
  {
    label: "每日新歌",
    to: "/daily",
    icon: Sparkles,
  },
  {
    label: "歌单广场",
    to: "/playlists",
    icon: Disc3,
  },
  {
    label: "热门榜单",
    to: "/charts",
    icon: Flame,
  },
  {
    label: "本地音乐",
    to: "/library",
    icon: FileMusic,
  },
] as const;

export function DiscoverPage(): React.JSX.Element {
  const navigate = useNavigate();
  const activeSourceId = useMusicSourceStore((s) => s.activeSourceId);
  const play = usePlayerStore((s) => s.play);
  const playQueue = usePlayerStore((s) => s.playQueue);

  // 功能面门控（v4 契约）：数据包声明当前源有没有新歌流/歌单载体、还有没有
  // 任何源有榜单。不支持的区块/快捷入口直接不渲染，也不发对应请求；
  // 未声明（旧包）一律按支持处理，页面与门控上线前完全一致。
  const showLatest = useSourceSupports(activeSourceId, "latest");
  const showPlaylists = useSourceSupports(activeSourceId, "playlists");
  // 热门榜单区块跟随当前音源（getCharts(activeSourceId)），按当前源判断
  const showCharts = useSourceSupports(activeSourceId, "charts");
  const quickLinks = QUICK_LINKS.filter((item) => {
    if (item.to === "/daily") return showLatest;
    if (item.to === "/playlists") return showPlaylists;
    if (item.to === "/charts") return showCharts;
    return true;
  });

  // 注册表世代：装/卸/换数据包后 +1。本页是 keep-alive 常驻页，effect 依赖
  // 只有 activeSourceId 的话，卸载包后旧榜单/歌单/新歌会一直残留（id 没变、
  // 门控对空注册表保守放行，两个依赖都不动，effect 永不重跑）。
  const metaGeneration = useSourceRegistryStore((s) => s.generation);

  const [songs, setSongs] = useState<Track[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [charts, setCharts] = useState<Chart[]>([]);
  /** 榜单精选的曲目：键 = `音源:榜单 id`；未到 = 骨架屏 */
  const [chartTracks, setChartTracks] = useState<Record<string, Track[]>>({});
  /** 榜单精选的实测列数（见下方 useLayoutEffect）；初始 2 与最小窗口宽度一致 */
  const [spotlightCols, setSpotlightCols] = useState(SPOTLIGHT_MIN_COLS);
  const spotlightRef = useRef<HTMLDivElement | null>(null);
  /**
   * 首页「榜单精选」实际展示的条数 = 实测列数 × 排数，再被真实拿到的榜单数封顶。
   *
   * 它是**派生值**而不是 state：列数一变，条数和「拉哪几个榜的详情」都要跟着变，
   * 三处（展示、详情 effect、刷新）读同一个数才不会各算各的。
   */
  const spotlightCount = Math.min(charts.length, spotlightCols * SPOTLIGHT_ROWS);
  /** 刷新按钮的在飞态（只挡重复点击，不挡卡片渲染） */
  const [refreshing, setRefreshing] = useState(false);
  // 引擎相位 + 播放包装配状态：数据面由已装数据包提供（不内置）；error（引擎
  // 异常）或 ready 但未装配播放包时，在线试听不可用 → 给「去安装播放包」引导卡
  const [enginePhase, setEnginePhase] = useState<string | null>("booting");
  const [playPackMissing, setPlayPackMissing] = useState(false);

  // 引擎启动与播放包安装都是异步的，快照轮询最简单；只影响一张卡的显隐
  useEffect(() => {
    const tick = (): void => {
      const snap = engineSnapshot();
      setEnginePhase(snap.phase);
      setPlayPackMissing(snap.phase === "ready" && snap.pack === null);
    };
    tick();
    const timer = window.setInterval(tick, 3000);
    return () => window.clearInterval(timer);
  }, []);

  // 新歌速递 + 推荐歌单（跟随音源；功能面声明不支持时跳过请求，区块同步隐藏）
  useEffect(() => {
    let cancelled = false;
    setSongs([]);
    setPlaylists([]);
    if (!showLatest && !showPlaylists) return;
    void (async () => {
      const [s, p] = await Promise.all([
        showLatest
          ? sourceApi.getLatestSongs(activeSourceId, HOME_ROW_COUNT, 0).catch(() => [] as Track[])
          : ([] as Track[]),
        // 插件化试点：推荐歌单经 source-scripts 统一入口分发
        // （scheme=script 走共享脚本包，否则原 Rust 通道），其余调用不变
        showPlaylists
          ? getRecommendations(activeSourceId, null, 1).catch(() => [] as Playlist[])
          : ([] as Playlist[]),
      ]);
      // IPC 在测试/异常环境下可能返回非数组，这里统一兜底（页面只做展示，允许区块为空）
      if (cancelled) return;
      setSongs(Array.isArray(s) ? s.slice(0, HOME_ROW_COUNT) : []);
      // 首页只展示一行，按 HOME_ROW_COUNT 截断；接口按页给 30 条，多的不进 DOM。
      // 与「新歌速递」同数：两行长短不一会被读成其中一行没加载完。
      setPlaylists(Array.isArray(p) ? p.slice(0, HOME_ROW_COUNT) : []);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSourceId, showLatest, showPlaylists, metaGeneration]);

  // 热门榜单 —— 跟随当前音源（与 /charts 页面同口径；全源聚合会混入其它源的榜，
  // 点进详情后该 chart 不属于当前源，详情页拿不到标题）。没有任何源有榜单时跳过。
  useEffect(() => {
    let cancelled = false;
    setCharts([]);
    if (!showCharts) return;
    void (async () => {
      const c = await sourceApi
        .getCharts(activeSourceId)
        .catch(() => [] as Chart[]);
      if (!cancelled) setCharts(Array.isArray(c) ? c.slice(0, SPOTLIGHT_FETCH) : []);
    })();
    return () => {
      cancelled = true;
    };
  }, [showCharts, activeSourceId, metaGeneration]);

  /**
   * 榜单精选的网格是否已挂载 —— 它是 useLayoutEffect 的重测触发条件。
   *
   * 空态时渲染的是 EmptyBlock、没有 grid 可测；等榜单到了 grid 才出现，
   * 这个布尔量翻转，effect 才拿得到 ref。依赖 ref.current 本身不触发重跑。
   */
  const spotlightGridMounted = showCharts && charts.length > 0;

  /**
   * 榜单精选列数：按**容器实测宽度**算，不用 Tailwind 的视口断点 —— 主内容区会被
   * 侧边栏和播放队列面板挤压，视口宽度对不上内容区宽度（同 CoverGrid 的口径）。
   *
   * 用 useLayoutEffect 而不是 useEffect：测到之前会先按初始列数画一帧，
   * 等 effect 再改成 3~5 列，宽屏上能看见卡片「重新排版」的那一下。
   * 布局阶段同步测完，第一帧就是最终列数。
   */
  useLayoutEffect(() => {
    const el = spotlightRef.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const measure = (): void => {
      const w = el.clientWidth;
      // 切走（KeepAliveOutlet 的 display:none）时宽度归零，保留上一次的列数，
      // 切回来 ResizeObserver 会再报一次真实宽度
      if (w <= 0) return;
      const c = Math.floor((w + SPOTLIGHT_GAP) / (SPOTLIGHT_CARD_MIN_W + SPOTLIGHT_GAP));
      setSpotlightCols(Math.max(SPOTLIGHT_MIN_COLS, Math.min(SPOTLIGHT_MAX_COLS, c)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [spotlightGridMounted]);

  // 榜单精选：拿前 N 个榜各拉一次详情，取前 3 首。
  // 每个榜各自 catch —— 一个榜挂了不该让另外三张卡空着；失败记成空数组，
  // 卡片显示「暂无曲目」，和「这个榜真的没歌」是同一副样子（首页不做错误态）。
  useEffect(() => {
    let cancelled = false;
    if (!showCharts || charts.length === 0) return;
    const picked = charts.slice(0, spotlightCount);
    void (async () => {
      const rows = await Promise.all(
        picked.map(async (c) => {
          const key = `${c.platform}:${c.id}`;
          const list = await loadChartDetail(c).catch(() => [] as Track[]);
          return [key, list] as const;
        }),
      );
      if (cancelled) return;
      setChartTracks((prev) => {
        const next = { ...prev };
        for (const [key, list] of rows) next[key] = list;
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [charts, showCharts, spotlightCount]);

  // 刷新：绕过详情缓存重拉榜单列表与每张卡的曲目（源站榜单是按天/按小时更新的，
  // 用户点它就是想看最新名次）。缓存整体丢弃，避免新旧混着显示。
  const refreshSpotlight = async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const c = await sourceApi
        .getCharts(activeSourceId)
        .catch(() => [] as Chart[]);
      const picked = (Array.isArray(c) ? c : []).slice(0, spotlightCount);
      const rows = await Promise.all(
        picked.map(async (chart) => {
          const list = await loadChartDetail(chart, true).catch(() => [] as Track[]);
          return [`${chart.platform}:${chart.id}`, list] as const;
        }),
      );
      // 整体替换而不是合并：只保留本次仍在展示的榜，换源后旧源的曲目不再留在表里
      const next: Record<string, Track[]> = {};
      for (const [key, list] of rows) next[key] = list;
      setChartTracks(next);
      setCharts(Array.isArray(c) ? c.slice(0, SPOTLIGHT_FETCH) : []);
    } finally {
      setRefreshing(false);
    }
  };

  /** 整张榜入队播放：用已经拉回来的详情，不再打一次源站 */
  const playChart = async (chart: Chart): Promise<void> => {
    const list =
      chartTracks[`${chart.platform}:${chart.id}`] ??
      (await loadChartDetail(chart).catch(() => [] as Track[]));
    if (list.length > 0) await playQueue(list, 0);
  };

  const activeSourceLabel = useSourceLabel(activeSourceId);
  const sourceLabel =
    activeSourceId === "local" ? "本地音乐" : activeSourceLabel;

  return (
    <div className="h-full min-w-0 overflow-y-auto pb-6">
      {/* Hero：当前音源 + 快捷入口 */}
      <section className="px-5 pt-5">
        <div className="rounded-2xl border border-border bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-6">
          <h1 className="text-2xl font-bold">发现音乐</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            当前音源：{sourceLabel}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {quickLinks.map((item) => (
              <button
                key={item.to}
                type="button"
                onClick={() => void navigate({ to: item.to })}
                className="flex items-center gap-1.5 rounded-full border border-border bg-card/60 px-3.5 py-2 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <item.icon className="h-3.5 w-3.5" />
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* 未装播放包引导（引擎正常、只缺播放包时才显示）：数据功能不受影响，
          只是在线试听需要播放音源包（应用不内置，需自行安装）；
          引擎 error 的数据面不可用引导卡在上面单独一张 */}
      {enginePhase === "error" && (
        <section className="mt-4 px-5">
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card/70 px-4 py-3">
            <PackageOpen className="h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
              音源引擎未能启动，搜索、歌单、榜单、歌词与在线试听暂不可用；请重启应用重试。
            </div>
          </div>
        </section>
      )}
      {enginePhase !== "error" && playPackMissing && (
        <section className="mt-4 px-5">
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card/70 px-4 py-3">
            <PackageOpen className="h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
              在线试听需要播放音源包（应用未内置）。搜索、歌单、榜单、歌词不受影响；
              想在线播放，可到「设置 → 音源包」安装。
            </div>
            <button
              type="button"
              onClick={() =>
                void navigate({ to: "/settings/$section", params: { section: "source-package" } })
              }
              className="rounded-full border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              去安装
            </button>
          </div>
        </section>
      )}

      {/* 榜单精选（跟随当前音源；当前源没声明榜单时整块隐藏）。
          列数随内容区实测宽度浮动（见 useLayoutEffect）：左封面 + 右前三首。
          比原来的横向封面行多给了一层信息，所以原来那条「热门榜单」行已经删掉，
          不再重复展示同一批榜单。 */}
      {showCharts && (
      <section className="mt-6 px-5">
        <SectionTitle
          title="榜单精选"
          action={
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void refreshSpotlight()}
                disabled={refreshing}
                title="刷新榜单"
                aria-label="刷新榜单"
                className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
              </button>
              <button
                type="button"
                onClick={() => void navigate({ to: "/charts" })}
                className="flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                全部榜单
                <ChevronRight className="h-3 w-3" />
              </button>
            </div>
          }
        />
        {charts.length === 0 ? (
          <EmptyBlock icon={BarChart3} text="暂无榜单" />
        ) : (
          <div
            ref={spotlightRef}
            className="grid gap-4"
            // 列数由容器实测宽度决定（见上方 useLayoutEffect）；1fr 均分 → 每行铺满，
            // 卡片在 360px 基础上略微拉伸吃掉余数
            style={{ gridTemplateColumns: `repeat(${spotlightCols}, minmax(0, 1fr))` }}
          >
            {charts.slice(0, spotlightCount).map((c) => (
              <ChartSpotlightCard
                key={`${c.platform}-${c.id}`}
                chart={c}
                tracks={chartTracks[`${c.platform}:${c.id}`]?.slice(0, SPOTLIGHT_TRACKS)}
                total={chartTracks[`${c.platform}:${c.id}`]?.length}
                onOpen={() =>
                  void navigate({
                    to: "/chart/$platform/$id",
                    params: { platform: c.platform, id: c.id },
                  })
                }
                onPlayAll={() => void playChart(c)}
                onPlayTrack={(t) => void play(t)}
              />
            ))}
          </div>
        )}
      </section>
      )}

      {/* 新歌速递（跟随当前源；当前源无新歌流时整块隐藏） */}
      {showLatest && (
      <section className="mt-6 px-5">
        <SectionTitle
          title="新歌速递"
          action={
            <button
              type="button"
              onClick={() => void navigate({ to: "/daily" })}
              className="flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              更多新歌
              <ChevronRight className="h-3 w-3" />
            </button>
          }
        />
        {songs.length === 0 ? (
          <EmptyBlock icon={Sparkles} text="暂无新歌" />
        ) : (
          <HorizontalScroller>
            {songs.map((t, i) => (
              <TrackCard
                key={`${t.id}-${i}`}
                track={t}
                onPlay={() => void play(t)}
              />
            ))}
          </HorizontalScroller>
        )}
      </section>
      )}

      {/* 推荐歌单（跟随当前源；当前源无歌单载体时整块隐藏） */}
      {showPlaylists && (
      <section className="mt-6 px-5">
        <SectionTitle
          title="推荐歌单"
          action={
            <button
              type="button"
              onClick={() => void navigate({ to: "/playlists" })}
              className="flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              歌单广场
              <ChevronRight className="h-3 w-3" />
            </button>
          }
        />
        {playlists.length === 0 ? (
          <EmptyBlock icon={Disc3} text="暂无推荐歌单" />
        ) : (
          // 与「新歌速递」同款横向滚动行（同宽卡片、同箭头、同滚轮转横滚）。
          // 此前是一行静态网格（CoverGrid maxRows={1}），滑不动也点不到被裁掉的歌单。
          <HorizontalScroller>
            {playlists.map((p) => (
              <CoverCard
                key={p.id}
                layout="row"
                name={p.name}
                picUrl={p.picUrl}
                subtitle={p.playCount ? `${p.playCount} 次播放` : undefined}
                onClick={() =>
                  void navigate({
                    to: "/playlist/$platform/$id",
                    params: { platform: p.platform, id: p.id },
                  })
                }
              />
            ))}
          </HorizontalScroller>
        )}
      </section>
      )}
    </div>
  );
}

/**
 * 区块空态：图标 + 一句话说明，虚线框轻量占位。
 * 替换此前的裸文本 <p>——空态与正常内容共用同一版式骨架（圆角容器），
 * 数据到达后切换不会产生明显的排版跳变。
 */
function EmptyBlock(props: {
  icon: React.ComponentType<{ className?: string }>;
  text: string;
}): React.JSX.Element {
  const Icon = props.icon;
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/80 py-8 text-muted-foreground">
      <Icon className="h-6 w-6 opacity-50" />
      <span className="text-xs">{props.text}</span>
    </div>
  );
}
