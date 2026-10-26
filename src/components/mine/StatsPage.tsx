import { useEffect, useState } from "react";
import { ChevronRight, Info, Music4, Play, RefreshCw } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import type { ListenReportEntry, ListenReportKind, PlayOverview, PlayStatItem, Track } from "@/types";
import * as ipc from "@/services/ipc";
import { errMsg } from "@/lib/utils";
import { qtresCoverUrl } from "@/lib/lrc";
import { formatReportDate, formatReportDuration, reportSourceLabel } from "@/lib/listen-report";
import { usePlayerStore } from "@/stores/player";
import { useSourceLabelFn } from "@/stores/sourceRegistry";
import { IconButton } from "@/components/common/IconButton";
import { ArtistAvatar } from "@/components/common/ArtistAvatar";
import { SourceLogo } from "@/components/common/SourceLogo";
import { SourceTag } from "@/components/common/SourceTag";
import { useKeepAliveActive } from "@/components/layout/keepAliveActive";
import { ListenReportDetail } from "./ListenReportDetail";
import { ListenTrendSection } from "./ListenTrendSection";

interface ReportData {
  overview: PlayOverview;
  tracks: PlayStatItem[];
  singers: ListenReportEntry[];
  singerCount: number;
  sources: ListenReportEntry[];
}

/** 累计听歌报告。时间口径沿用播放引擎，排行榜明细由本机数据库分页查询。 */
export function StatsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const play = usePlayerStore((s) => s.play);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const active = useKeepAliveActive();
  const sourceLabel = useSourceLabelFn();
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [detail, setDetail] = useState<{ kind: ListenReportKind; days?: number | null; entry?: ListenReportEntry } | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    // 先补按天明细再读报告：日榜与「活跃天数」都只读 play_days，先读后补会闪一下
    // 「活跃天数 0 天、趋势全空」。补齐失败不挡报告本身 —— 累计值仍在库里。
    void ipc.seedListenDays()
      .catch(() => 0)
      .then(() =>
        Promise.all([
          ipc.getPlayOverview(),
          ipc.getTopTracks(8),
          ipc.getListenReport({ kind: "singers", order: "count", offset: 0, limit: 5 }),
          ipc.getListenReport({ kind: "sources", order: "count", offset: 0, limit: 5 }),
        ]),
      )
      .then(([overview, tracks, singers, sources]) => {
        if (!cancelled) setData({ overview, tracks, singers: singers.items, singerCount: singers.total, sources: sources.items });
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errMsg(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [active, revision]);

  const empty = !data || (data.overview.totalPlays === 0 && data.overview.totalMs === 0);
  const retry = (): void => setRevision((value) => value + 1);
  const playTrack = (track: Track): void => { void play(track); };

  return (
    <div className="h-full min-w-0 overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-4xl">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="mb-1 text-xs text-muted-foreground">全部听歌记录</p>
            <h1 className="text-2xl font-bold tracking-tight">听歌报告</h1>
            <p className="mt-1 text-xs text-muted-foreground">把听过的歌，重新听一遍</p>
          </div>
          <div className="flex items-center gap-2">
            <IconButton label="刷新听歌报告" variant="outline" size="md" disabled={loading} onClick={retry}><RefreshCw /></IconButton>
            {!!data?.tracks.length && !error && <IconButton label="播放常听歌曲" variant="outline" size="md" onClick={() => void playQueue(data.tracks.map((item) => item.track), 0)}><Play /></IconButton>}
          </div>
        </header>

        <details className="mt-4 rounded-lg border border-border/60 bg-card/60 px-3 py-2 text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer select-none"><Info className="mr-1 inline h-3.5 w-3.5 align-text-bottom" />统计说明</summary>
          <div className="mt-2 space-y-1.5 leading-relaxed">
            <p>时长按实际收听累计，未播完也计入；暂停、缓冲和拖动跳过的时间不计入。</p>
            <p>自然播完，或听满曲目一半且不少于 30 秒，计为一次有效播放；时长未知的曲目需听满 30 秒。完整听完的次数单独记录。</p>
            <p>同一首歌在不同音源下分别统计；歌手按歌曲原署名归并，合作歌手保留原署名。本地与在线歌曲均可计入。</p>
            <p>数据保存在本机数据库中，可通过设置里的数据备份保存；旧版本未记录的真实时长与完播情况不会反推补算。当前播放通常每 30 秒或在切歌、停止、播完时结算，刷新后可见。</p>
            <p>听歌趋势与「活跃天数」依赖按天明细：升级前的存量播放没有日期，第一次打开本页时统一计入当天，之后的播放按实际日期累计。</p>
          </div>
        </details>

        {loading ? <ReportSkeleton /> : error ? (
          <div role="alert" className="flex flex-col items-center gap-3 py-20 text-center">
            <p className="text-sm text-destructive">听歌报告读取失败：{error}</p>
            <button type="button" className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-secondary" onClick={retry}>重试</button>
          </div>
        ) : empty ? (
          <div className="flex flex-col items-center gap-3 py-24 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-secondary"><Music4 className="h-6 w-6 text-muted-foreground" /></span>
            <p className="text-sm text-muted-foreground">还没有听歌记录，去听几首歌再回来看。</p>
            <button type="button" className="rounded-md bg-primary px-4 py-1.5 text-xs text-primary-foreground" onClick={() => void navigate({ to: "/" })}>去听歌</button>
          </div>
        ) : data && (
          <>
            <section aria-label="听歌概览" className="relative mt-5 overflow-hidden rounded-2xl border border-border bg-card/60 p-5">
              <div className="pointer-events-none absolute -right-16 -top-24 h-48 w-48 rounded-full bg-primary/10 blur-3xl" />
              <div className="relative grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-5">
                <HeroStat label="累计时长" value={formatReportDuration(data.overview.totalMs)} />
                <HeroStat label="有效播放" value={`${data.overview.totalPlays} 次`} />
                <HeroStat label="听过歌曲" value={`${data.overview.trackCount} 首`} />
                <HeroStat label="活跃天数" value={`${data.overview.activeDays} 天`} />
                <HeroStat label="常听歌手" value={`${data.singerCount} 组`} />
              </div>
              <p className="relative mt-5 flex flex-wrap gap-x-4 gap-y-1 border-t border-border/60 pt-3 text-xs text-muted-foreground">
                <span>完整听完 {data.overview.finishedPlays} 次{data.overview.totalPlays > 0 ? ` · 占有效播放 ${Math.round(data.overview.finishedPlays / data.overview.totalPlays * 100)}%` : ""}</span>
                {data.overview.lastPlayedAt != null && <span>最近播放 {formatReportDate(data.overview.lastPlayedAt)}</span>}
              </p>
            </section>

            {data.tracks.length > 0 && <section className="mt-7" aria-label="常听歌曲">
              <SectionTitle title="常听歌曲" onOpen={() => setDetail({ kind: "tracks" })} />
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {data.tracks.slice(0, 4).map((item, index) => <TrackStatCard key={`${item.track.platform}:${item.track.id}`} item={item} rank={index + 1} onPlay={() => playTrack(item.track)} onDetail={() => setDetail({ kind: "tracks", entry: trackEntry(item) })} />)}
              </div>
              <ul className="mt-2">
                {data.tracks.slice(4).map((item, index) => <li key={`${item.track.platform}:${item.track.id}`} className="flex items-center gap-3 border-b border-border/50 py-2">
                  <span className="w-5 text-center text-xs tabular-nums text-muted-foreground">{index + 5}</span>
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => playTrack(item.track)}>
                    <span className="flex min-w-0 items-center gap-1.5 text-sm"><span className="truncate">{item.track.title}</span><SourceTag platform={item.track.platform} size="xs" /></span><span className="block truncate text-xs text-muted-foreground">{item.track.singer}</span>
                  </button>
                  <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">{item.playCount} 次<span className="mt-0.5 block text-[11px]">{formatReportDuration(item.totalPlayedMs)}</span></span>
                  <IconButton label={`查看 ${item.track.title} 的统计`} onClick={() => setDetail({ kind: "tracks", entry: trackEntry(item) })}><ChevronRight /></IconButton>
                </li>)}
              </ul>
            </section>}

            <div className="mt-7 grid items-start gap-6 lg:grid-cols-2">
              <section aria-label="常听歌手">
                <SectionTitle title="常听歌手" onOpen={() => setDetail({ kind: "singers" })} />
                <ul>{data.singers.map((item, index) => <GroupRow key={item.id} item={item} rank={index + 1} name={item.name} totalPlays={data.overview.totalPlays} onOpen={() => setDetail({ kind: "singers", entry: item })} />)}</ul>
                {data.singers.length === 0 && <p className="py-4 text-xs text-muted-foreground">已听歌曲暂无歌手信息</p>}
              </section>
              <section aria-label="音源分布">
                <SectionTitle title="音源分布" onOpen={() => setDetail({ kind: "sources" })} />
                <ul>{data.sources.map((item, index) => <GroupRow key={item.id} item={item} rank={index + 1} name={reportSourceLabel(sourceLabel, item.id)} totalPlays={data.overview.totalPlays} source onOpen={() => setDetail({ kind: "sources", entry: item })} />)}</ul>
              </section>
            </div>

            <ListenTrendSection onOpenDetail={(kind, days, entry) => setDetail({ kind, days, entry })} />
          </>
        )}
      </div>
      {active && detail && <ListenReportDetail kind={detail.kind} initialEntry={detail.entry} days={detail.days} onClose={() => setDetail(null)} />}
    </div>
  );
}

function trackEntry(item: PlayStatItem): ListenReportEntry {
  return { id: `${item.track.platform}:${item.track.id}`, name: item.track.title, platform: item.track.platform, playCount: item.playCount, totalPlayedMs: item.totalPlayedMs, trackCount: 1, lastPlayedAt: item.lastPlayedAt, track: item.track };
}

function SectionTitle(props: { title: string; onOpen: () => void }): React.JSX.Element {
  return <div className="mb-3 flex items-center justify-between gap-2"><h2 className="text-sm font-medium text-muted-foreground">{props.title}</h2><button type="button" className="flex items-center gap-0.5 text-xs text-primary hover:underline" aria-label={`查看全部${props.title}`} onClick={props.onOpen}>全部<ChevronRight className="h-3 w-3" /></button></div>;
}

function HeroStat(props: { label: string; value: string }): React.JSX.Element {
  return <div className="min-w-0"><div className="text-xs text-muted-foreground">{props.label}</div><div className="mt-1 text-2xl font-bold tabular-nums tracking-tight">{props.value}</div></div>;
}

function TrackStatCard(props: { item: PlayStatItem; rank: number; onPlay: () => void; onDetail: () => void }): React.JSX.Element {
  const { item } = props;
  const cover = qtresCoverUrl(item.track.picUrl, 300);
  return <div className="group min-w-0 rounded-xl border border-border bg-card/60 p-2.5 transition-colors hover:border-primary/40">
    <button type="button" className="block w-full text-left" onClick={props.onPlay} aria-label={`播放 ${item.track.title}`}>
      <div className="relative aspect-square overflow-hidden rounded-lg bg-secondary">
        {cover ? <img src={cover} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-150 group-hover:scale-[1.03]" /> : <span className="flex h-full w-full items-center justify-center text-2xl text-muted-foreground">{Array.from(item.track.title)[0] || "?"}</span>}
        <span className="absolute left-1.5 top-1.5 rounded-md bg-background/80 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums backdrop-blur-sm">{props.rank}</span>
      </div>
      <div className="mt-2 flex min-w-0 items-center gap-1.5 text-sm font-medium"><span className="truncate">{item.track.title}</span><SourceTag platform={item.track.platform} size="xs" /></div>
      <div className="mt-0.5 truncate text-xs text-muted-foreground">{item.track.singer}</div>
    </button>
    <div className="mt-1 flex items-center justify-between gap-1 text-[11px] tabular-nums text-muted-foreground"><span className="truncate">{item.playCount} 次 · {formatReportDuration(item.totalPlayedMs)}</span><IconButton label={`查看 ${item.track.title} 的统计`} onClick={props.onDetail}><ChevronRight /></IconButton></div>
  </div>;
}

function GroupRow(props: { item: ListenReportEntry; rank: number; name: string; totalPlays: number; source?: boolean; onOpen: () => void }): React.JSX.Element {
  const { item } = props;
  const percent = props.totalPlays > 0 ? item.playCount / props.totalPlays * 100 : 0;
  return <li><button type="button" className="flex w-full items-center gap-3 border-b border-border/50 py-2.5 text-left transition-colors hover:bg-secondary/60" onClick={props.onOpen}>
    <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted-foreground">{props.rank}</span>
    {props.source
      ? <SourceLogo platform={item.id} size={36} />
      : <ArtistAvatar platform={item.platform} name={props.name} size={36} />}
    <span className="min-w-0 flex-1"><span className="block truncate text-sm">{props.name}</span><span className="mt-0.5 block text-[11px] text-muted-foreground">{item.trackCount} 首 · {formatReportDuration(item.totalPlayedMs)}</span></span>
    <span className="w-20 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground"><span>{item.playCount} 次{props.totalPlays > 0 ? ` · ${Math.round(percent)}%` : ""}</span><span className="mt-1 block h-1 overflow-hidden rounded bg-secondary"><span className="block h-full rounded bg-primary/60" style={{ width: `${Math.min(100, percent)}%` }} /></span></span>
    <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
  </button></li>;
}

function ReportSkeleton(): React.JSX.Element {
  return <div role="status" aria-label="正在读取听歌报告"><div className="mt-5 h-32 animate-pulse rounded-2xl bg-secondary/60" /><div className="mt-7 grid grid-cols-2 gap-3 md:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <div key={index} className="aspect-[3/4] animate-pulse rounded-xl bg-secondary/60" />)}</div></div>;
}
