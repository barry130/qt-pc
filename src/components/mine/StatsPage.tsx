import { useEffect, useState } from "react";
import { Music4, Play } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import type {
  PlayOverview,
  PlayStatItem,
  SingerStat,
  SourceId,
} from "@/types";
import * as ipc from "@/services/ipc";
import { cn } from "@/lib/utils";
import { qtresCoverUrl } from "@/lib/lrc";
import { usePlayerStore } from "@/stores/player";
import { IconButton } from "@/components/common/IconButton";
import { useKeepAliveActive } from "@/components/layout/keepAliveActive";

/**
 * 听歌报告（路由 /stats，侧边栏同名，DESIGN §5.3）。
 *
 * 数据由播放引擎按**真实收听**结算后写进 play_stats（切歌 / 停止 / 播完时）：
 * 时长记的是真听了多久（暂停与拖动跳过的不算），次数只在「播完，或听满曲目
 * 一半且不少于 30 秒」时 +1，播完的另外单独记一列成完播率（DESIGN §5.3）；
 * 曲目 / 歌手排行都出自同一张表。没有记录时给空态，而不是一堆 0。
 *
 * 版面按「报告」而不是「后台统计」排（2026-11 用户：原页太丑）：
 * - 头部 hero 数字带：四个大数字（播放次数 / 累计时长 / 曲目数 / 最近播放），
 *   带一枚主色光晕装饰，风格与详情页 hero 的铺底一致但不用图片——报告没有封面可铺；
 * - 常听歌曲前 4 名做成封面卡（封面经 qtres 代取，与首页同链路），名次角标
 *   压在封面上；5 名以后退回紧凑行 + 次数占比条，一屏内看全；
 * - 常听歌手没有头像可用（统计表只存名字），用首字圆形占位 + 占比条，
 *   与歌手页 hero 的首字占位同一观感。
 * 所有数字都是库里的真值或直接均值（平均每次时长 = 总时长 / 总次数、
 * 完播率 = 完播次数 / 总次数），不造「活跃天数」这类库里有但我们没记的指标。
 */
export function StatsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const play = usePlayerStore((s) => s.play);
  const playQueue = usePlayerStore((s) => s.playQueue);

  const [overview, setOverview] = useState<PlayOverview | null>(null);
  const [tracks, setTracks] = useState<PlayStatItem[]>([]);
  const [singers, setSingers] = useState<SingerStat[]>([]);
  const [loading, setLoading] = useState(true);

  // 本页常驻缓存（KeepAliveOutlet），挂载后不会卸载：只在首次挂载拉数据的话，
  // 听完歌再切回来看到的还是旧统计。改成「每次变为可见时重拉一次」。
  const active = useKeepAliveActive();

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [o, t, s] = await Promise.all([
          ipc.getPlayOverview(),
          ipc.getTopTracks(20),
          ipc.getTopSingers(10),
        ]);
        if (!cancelled) {
          setOverview(o);
          setTracks(Array.isArray(t) ? t : []);
          setSingers(Array.isArray(s) ? s : []);
        }
      } catch {
        // 统计是旁路数据，读不到就当没有，不挡页面
        if (!cancelled) {
          setOverview(null);
          setTracks([]);
          setSingers([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  // 空态看「有没有听过」而不是「有没有有效播放」：新用户一路跳着听，
  // 时长不为 0 但一次有效播放都攒不出来，报「没有记录」是撒谎
  const empty = !overview || (overview.totalPlays === 0 && overview.totalMs === 0);
  // 完播率 / 平均每次：库里的真值相除（有效播放为 0 时那两个小注不渲染）
  const hasPlays = !!overview && overview.totalPlays > 0;
  const finishRate =
    overview && hasPlays
      ? Math.round((overview.finishedPlays / overview.totalPlays) * 100)
      : 0;

  return (
    <div className="h-full min-w-0 overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-4xl">
        {loading ? (
          <ReportSkeleton />
        ) : empty ? (
          <EmptyReport onGoListen={() => void navigate({ to: "/" })} />
        ) : (
          <>
            <header className="flex flex-wrap items-end justify-between gap-3">
              <div className="min-w-0">
                <h1 className="text-2xl font-bold tracking-tight">听歌报告</h1>
                <p className="mt-1 text-xs text-muted-foreground">
                  数据来自本地播放记录：听完或听满一半才算一次，与音源无关，只存在你自己的库里。
                </p>
              </div>
              {tracks.length > 0 && (
                <IconButton
                  label="播放常听歌曲"
                  variant="outline"
                  size="md"
                  hover="secondary"
                  onClick={() =>
                    void playQueue(
                      tracks.map((it) => it.track),
                      0,
                    )
                  }
                >
                  <Play />
                </IconButton>
              )}
            </header>

            <div className="relative mt-5 overflow-hidden rounded-2xl border border-border bg-card/60 p-5">
              <div className="pointer-events-none absolute -right-16 -top-24 h-48 w-48 rounded-full bg-primary/10 blur-3xl" />
              <div className="relative grid grid-cols-2 gap-x-4 gap-y-6 lg:grid-cols-4">
                <HeroStat
                  label="总播放"
                  value={`${overview.totalPlays} 次`}
                />
                <HeroStat
                  label="累计时长"
                  value={formatMs(overview.totalMs)}
                  sub={
                    hasPlays
                      ? `平均每次 ${formatMs(
                          Math.round(overview.totalMs / overview.totalPlays),
                        )}`
                      : undefined
                  }
                />
                <HeroStat label="曲目数" value={`${overview.trackCount} 首`} />
                <HeroStat
                  label="最近播放"
                  value={
                    overview.lastPlayedAt
                      ? formatDate(overview.lastPlayedAt)
                      : "—"
                  }
                />
              </div>
              {overview.finishedPlays > 0 && (
                <p className="relative mt-5 border-t border-border/60 pt-3 text-xs text-muted-foreground">
                  其中完整听完{" "}
                  <span className="font-medium text-foreground">
                    {overview.finishedPlays}
                  </span>{" "}
                  次 · 完播率 {finishRate}%
                </p>
              )}
            </div>

            {tracks.length > 0 && (
              <section className="mt-7">
                <SectionTitle title="常听歌曲" />
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  {tracks.slice(0, 4).map((it, i) => (
                    <TrackStatCard
                      key={`${it.track.id}-${i}`}
                      item={it}
                      rank={i + 1}
                      onPlay={() => void play(it.track)}
                    />
                  ))}
                </div>
                {tracks.length > 4 && (
                  <ul className="mt-2">
                    {tracks.slice(4).map((it, i) => (
                      <li key={`${it.track.id}-${i + 4}`}>
                        <TrackStatRow
                          item={it}
                          rank={i + 5}
                          max={tracks[0]?.playCount ?? 1}
                          onPlay={() => void play(it.track)}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            {singers.length > 0 && (
              <section className="mt-7">
                <SectionTitle title="常听歌手" />
                <ul>
                  {singers.map((s, i) => (
                    <li key={s.singer}>
                      <SingerStatRow
                        item={s}
                        rank={i + 1}
                        max={singers[0]?.playCount ?? 1}
                        onOpen={() =>
                          void navigate({
                            to: "/artist/$platform/$id",
                            params: {
                              platform: s.platform as SourceId,
                              id: encodeURIComponent(s.singer),
                            },
                          })
                        }
                      />
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SectionTitle(props: { title: string }): React.JSX.Element {
  return (
    <h2 className="mb-3 text-sm font-medium text-muted-foreground">
      {props.title}
    </h2>
  );
}

/** hero 数字带里的一格：大数字 + 可选的小注（均值这类真值衍生） */
function HeroStat(props: {
  label: string;
  value: string;
  sub?: string;
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{props.label}</div>
      <div className="mt-1 truncate text-2xl font-bold tabular-nums tracking-tight">
        {props.value}
      </div>
      {props.sub && (
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {props.sub}
        </div>
      )}
    </div>
  );
}

/** 常听歌曲前几名的封面卡：名次角标压在封面上，点卡片整张可播 */
function TrackStatCard(props: {
  item: PlayStatItem;
  rank: number;
  onPlay: () => void;
}): React.JSX.Element {
  const { item, rank } = props;
  const cover = qtresCoverUrl(item.track.picUrl, 300);
  return (
    <button
      type="button"
      onClick={props.onPlay}
      className="group rounded-xl border border-border bg-card/60 p-2.5 text-left transition-colors hover:border-primary/40"
    >
      <div className="relative aspect-square overflow-hidden rounded-lg bg-secondary">
        {cover ? (
          <img
            src={cover}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-150 group-hover:scale-[1.03]"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-2xl text-muted-foreground">
            {item.track.title.slice(0, 1) || "?"}
          </span>
        )}
        <span className="absolute left-1.5 top-1.5 rounded-md bg-background/80 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-foreground backdrop-blur-sm">
          {rank}
        </span>
      </div>
      <div className="mt-2 min-w-0">
        <div className="truncate text-sm font-medium">{item.track.title}</div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {item.track.singer}
        </div>
        <div className="mt-1 text-[11px] tabular-nums text-muted-foreground">
          听了 {item.playCount} 次
        </div>
      </div>
    </button>
  );
}

/** 5 名以后的紧凑行：名次 + 标题 + 次数占比条（宽度按第一名归一） */
function TrackStatRow(props: {
  item: PlayStatItem;
  rank: number;
  max: number;
  onPlay: () => void;
}): React.JSX.Element {
  const { item, rank } = props;
  return (
    <button
      type="button"
      onClick={props.onPlay}
      className="flex w-full items-center gap-3 border-b border-border/50 py-2 text-left text-sm transition-colors hover:bg-secondary/60"
    >
      <RankNo rank={rank} />
      <div className="min-w-0 flex-1">
        <div className="truncate">{item.track.title}</div>
        <div className="truncate text-xs text-muted-foreground">
          {item.track.singer}
        </div>
      </div>
      <CountBar value={item.playCount} max={props.max} className="w-24" />
    </button>
  );
}

/** 歌手行：统计表没存头像，用首字圆占位（与歌手页 hero 的首字占位同观感） */
function SingerStatRow(props: {
  item: SingerStat;
  rank: number;
  max: number;
  onOpen: () => void;
}): React.JSX.Element {
  const { item, rank } = props;
  const initial = Array.from(item.singer.trim())[0] ?? "?";
  return (
    <button
      type="button"
      onClick={props.onOpen}
      className="flex w-full items-center gap-3 border-b border-border/50 py-2.5 text-left text-sm transition-colors hover:bg-secondary/60"
    >
      <RankNo rank={rank} />
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-secondary text-xs font-medium">
        {initial}
      </span>
      <span className="min-w-0 flex-1 truncate">{item.singer}</span>
      <CountBar value={item.playCount} max={props.max} className="w-32" />
    </button>
  );
}

/** 名次：前三名主色，之后的常规弱化 */
function RankNo(props: { rank: number }): React.JSX.Element {
  return (
    <span
      className={cn(
        "w-5 shrink-0 text-center text-xs tabular-nums",
        props.rank <= 3
          ? "font-semibold text-primary"
          : "text-muted-foreground",
      )}
    >
      {props.rank}
    </span>
  );
}

/** 次数 + 占比条：条宽按当页最大值归一，条只是形状不是刻度 */
function CountBar(props: {
  value: number;
  max: number;
  className?: string;
}): React.JSX.Element {
  const width = props.max > 0 ? (props.value / props.max) * 100 : 0;
  return (
    <div className={cn("shrink-0", props.className)}>
      <div className="mb-1 text-right text-[11px] tabular-nums text-muted-foreground">
        {props.value} 次
      </div>
      <div className="h-1 w-full overflow-hidden rounded bg-secondary">
        <div
          className="h-full rounded bg-primary/60"
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

/** 空态：一枚图标 + 一句话 + 去听歌的入口，别让页面只剩一行灰字 */
function EmptyReport(props: {
  onGoListen: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-secondary">
        <Music4 className="h-6 w-6 text-muted-foreground" />
      </span>
      <p className="text-sm text-muted-foreground">
        还没有听歌记录，去听几首歌再回来看。
      </p>
      <button
        type="button"
        onClick={props.onGoListen}
        className="rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        去听歌
      </button>
    </div>
  );
}

/** 加载骨架：与成稿同节奏（数字带 → 封面卡 → 列表行），刷新时布局不跳 */
function ReportSkeleton(): React.JSX.Element {
  return (
    <>
      <div className="h-8 w-40 animate-pulse rounded-lg bg-secondary/60" />
      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-6 rounded-2xl border border-border bg-card/60 p-5 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i}>
            <div className="h-3 w-14 animate-pulse rounded bg-secondary/60" />
            <div className="mt-2 h-7 w-24 animate-pulse rounded bg-secondary/60" />
          </div>
        ))}
      </div>
      <div className="mt-7 grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div
            key={i}
            className="aspect-[3/4] animate-pulse rounded-xl bg-secondary/60"
          />
        ))}
      </div>
      <div className="mt-7 space-y-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div
            key={i}
            className="h-9 animate-pulse rounded-lg bg-secondary/60"
          />
        ))}
      </div>
    </>
  );
}

/** 时长：不足 1 小时给分钟，超过给「x 小时 y 分」 */
function formatMs(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return "不到 1 分钟";
  if (totalMin < 60) return `${totalMin} 分钟`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
