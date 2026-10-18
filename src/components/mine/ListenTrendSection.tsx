import { useEffect, useState } from "react";
import { ChevronRight, Music4 } from "lucide-react";
import type { ListenDayReport, ListenReportEntry, ListenReportKind } from "@/types";
import * as ipc from "@/services/ipc";
import { cn, errMsg } from "@/lib/utils";
import { qtresCoverUrl } from "@/lib/lrc";
import { formatDayAxis, formatReportDuration, listenDayKey, reportSourceLabel } from "@/lib/listen-report";
import { useSourceLabelFn } from "@/stores/sourceRegistry";
import { ArtistAvatar } from "@/components/common/ArtistAvatar";
import { SourceLogo } from "@/components/common/SourceLogo";
import { useKeepAliveActive } from "@/components/layout/keepAliveActive";

/** 时间档，与 Rust 侧 `days` 窗口一一对应（1 = 今天）。 */
const WINDOWS = [
  { days: 1, label: "今天" },
  { days: 7, label: "近 7 天" },
  { days: 30, label: "近 30 天" },
] as const;

const KINDS = [
  { kind: "tracks", label: "歌曲" },
  { kind: "singers", label: "歌手" },
  { kind: "sources", label: "音源" },
] as const;

/** 日榜只展示前 N 条，与移动端 pages/stats 的 Top 10 对齐。 */
const ROW_LIMIT = 10;

/**
 * 日榜：逐日趋势 + 窗口总量 + 前 N 条排行。
 *
 * 和上面的累计榜刻意分开：累计榜回答「我最常听什么」，这里回答「我最近在听什么」。
 * 两者的分组与排序口径在 Rust 侧是同一条 SQL 分支，所以点进去看到的明细必定对得上。
 */
export function ListenTrendSection(props: {
  onOpenDetail: (kind: ListenReportKind, days: number, entry?: ListenReportEntry) => void;
}): React.JSX.Element {
  const { onOpenDetail } = props;
  const active = useKeepAliveActive();
  const sourceLabel = useSourceLabelFn();
  const [days, setDays] = useState<number>(7);
  const [kind, setKind] = useState<ListenReportKind>("tracks");
  const [report, setReport] = useState<ListenDayReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    // 清空旧数据：窗口一换，趋势轴的格数和刻度就整套不同，留着旧值会画错。
    setReport(null);
    void ipc.getListenDayReport({ kind, order: "count", days, limit: ROW_LIMIT })
      .then((value) => { if (!cancelled) setReport(value); })
      .catch((reason: unknown) => { if (!cancelled) setError(errMsg(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [active, days, kind, revision]);

  const windowLabel = WINDOWS.find((item) => item.days === days)?.label ?? "";
  const kindLabel = KINDS.find((item) => item.kind === kind)?.label ?? "";
  const points = report?.daily ?? [];
  const maxPlays = Math.max(1, ...points.map((point) => point.playCount));
  // 30 天窗口下 30 个刻度会糊成一片，抽稀到 6 个左右，末位必留。
  const labelEvery = points.length <= 7 ? 1 : Math.ceil(points.length / 6);
  const todayKey = listenDayKey(Date.now());
  const nameOf = (entry: ListenReportEntry): string =>
    kind === "sources" ? reportSourceLabel(sourceLabel, entry.id) : entry.track?.title ?? entry.name;

  return (
    <section className="mt-7" aria-label="听歌趋势">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">听歌趋势</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented label="统计时间范围" value={days} options={WINDOWS.map((item) => ({ value: item.days, label: item.label }))} onChange={setDays} />
          <Segmented label="统计维度" value={kind} options={KINDS.map((item) => ({ value: item.kind, label: item.label }))} onChange={setKind} />
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card/60 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-xs text-muted-foreground">{windowLabel} · 常听{kindLabel}</p>
          {report && <p className="text-xs tabular-nums text-muted-foreground">共 <span className="text-sm font-semibold text-foreground">{report.totalPlays}</span> 次播放 · {formatReportDuration(report.totalPlayedMs)} · 活跃 {report.activeDays} 天</p>}
        </div>

        {error ? (
          <div role="alert" className="flex flex-col items-center gap-2 py-10 text-center text-xs text-destructive">
            <p>趋势读取失败：{error}</p>
            <button type="button" className="rounded-md border border-border px-3 py-1 text-xs text-foreground hover:bg-secondary" onClick={() => setRevision((value) => value + 1)}>重试</button>
          </div>
        ) : <>
          <div className="mt-3 flex h-24 items-end gap-1" role="img" aria-label={`${windowLabel}逐日播放次数`}>
            {loading
              ? Array.from({ length: 7 }, (_, index) => <span key={index} className="h-1/3 flex-1 animate-pulse rounded-t bg-secondary/60" />)
              : points.map((point) => <span key={point.day} title={`${formatDayAxis(point.day, todayKey, days)} · ${point.playCount} 次 · ${formatReportDuration(point.totalPlayedMs)}`} className="group/bar flex h-full min-w-0 flex-1 flex-col justify-end">
                <span className={cn("w-full rounded-t transition-colors", point.playCount > 0 ? "bg-primary/60 group-hover/bar:bg-primary" : "bg-secondary")} style={{ height: point.playCount > 0 ? `${Math.max(8, point.playCount / maxPlays * 100)}%` : "3px" }} />
              </span>)}
          </div>
          <div className="mt-1 flex h-3 items-center gap-1 text-[10px] text-muted-foreground">
            {points.map((point, index) => <span key={point.day} className="min-w-0 flex-1 truncate text-center">{!loading && (index % labelEvery === 0 || index === points.length - 1) ? formatDayAxis(point.day, todayKey, days) : ""}</span>)}
          </div>

          {report && report.items.length > 0 ? <ul className="mt-2">{report.items.map((entry, index) => (
            <li key={entry.id} className="border-b border-border/50 last:border-b-0">
              <button type="button" className="flex w-full items-center gap-3 py-2 text-left transition-colors hover:bg-secondary/60" onClick={() => onOpenDetail(kind, days, entry)}>
                <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                <EntryPicture entry={entry} kind={kind} name={nameOf(entry)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{nameOf(entry)}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{kind === "tracks" ? entry.track?.singer || "未知歌手" : `${entry.trackCount} 首歌曲`}</span>
                </span>
                <span className="shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{entry.playCount} 次<span className="mt-0.5 block">{formatReportDuration(entry.totalPlayedMs)}</span></span>
                <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
              </button>
            </li>
          ))}</ul> : !loading && <p className="py-6 text-center text-xs text-muted-foreground">这个范围内还没有播放记录。</p>}

          {report && <div className="mt-3 flex justify-end">
            <button type="button" className="flex items-center gap-0.5 text-xs text-primary hover:underline" aria-label={`查看全部${windowLabel}${kindLabel}`} onClick={() => onOpenDetail(kind, days)}>查看全部{kindLabel}<ChevronRight className="h-3 w-3" /></button>
          </div>}
        </>}
      </div>
    </section>
  );
}

function Segmented<T extends string | number>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}): React.JSX.Element {
  return <div role="group" aria-label={props.label} className="flex items-center gap-0.5 rounded-lg border border-border bg-card/60 p-0.5">
    {props.options.map((option) => <button key={option.value} type="button" aria-pressed={option.value === props.value} onClick={() => props.onChange(option.value)} className={cn("rounded-md px-2 py-1 text-xs transition-colors", option.value === props.value ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>{option.label}</button>)}
  </div>;
}

/** 三档维度各自的图片口径，与累计榜的 GroupRow / EntryPicture 保持一致。 */
function EntryPicture(props: { entry: ListenReportEntry; kind: ListenReportKind; name: string }): React.JSX.Element {
  const { entry, kind, name } = props;
  if (kind === "sources") return <SourceLogo platform={entry.id} size={32} />;
  if (kind === "singers") return <ArtistAvatar platform={entry.platform} name={name} size={32} />;
  const cover = entry.track ? qtresCoverUrl(entry.track.picUrl, 96) : "";
  return <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-primary/10 text-primary">
    {cover ? <img src={cover} alt="" loading="lazy" className="h-full w-full object-cover" /> : <Music4 className="h-4 w-4" />}
  </span>;
}
