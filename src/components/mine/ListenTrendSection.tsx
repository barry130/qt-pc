import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ListenDayReport, ListenReportEntry, ListenReportKind } from "@/types";
import * as ipc from "@/services/ipc";
import { cn, errMsg } from "@/lib/utils";

import { formatReportDuration, listenDayKey, reportSourceLabel } from "@/lib/listen-report";
import { ListenHeatmap } from "./ListenHeatmap";
import { useSourceLabelFn } from "@/stores/sourceRegistry";
import { SourceTag } from "@/components/common/SourceTag";
import { EntryPicture } from "./ListenReportBits";
import { useKeepAliveActive } from "@/components/layout/keepAliveActive";
import { Button, Segmented } from "@/components/ui";
import { LoadBar } from "@/components/discovery/Skeletons";

/** 时间档，与 Rust 侧 `days` 窗口一一对应（1 = 今天）。 */
const WINDOWS = [
  { days: 1, label: "今天" },
  { days: 7, label: "近 7 天" },
  { days: 30, label: "近 30 天" },
  // 365 是 Rust 侧 window_days 的上限（见 src-tauri/src/listen_report.rs），
  // 热力图要整年的日历骨架才有意义，所以把这一档也给出来。
  { days: 365, label: "近一年" },
] as const;

const KINDS = [
  { kind: "tracks", label: "歌曲" },
  { kind: "singers", label: "歌手" },
  { kind: "sources", label: "音源" },
] as const;

/** 日榜只展示前 N 条，与移动端 pages/stats 的 Top 10 对齐。 */
const ROW_LIMIT = 10;

/** 骨架列数跟着时间档走：一年 53 列，30 天 5 列，今天 1 列。 */
function skeletonWeeksFor(days: number): number {
  return Math.max(1, Math.ceil((days + 1) / 7));
}

/**
 * 日榜：逐日趋势 + 窗口总量 + 前 N 条排行。
 *
 * 和上面的累计榜刻意分开：累计榜回答「我最常听什么」，这里回答「我最近在听什么」。
 * 两者的分组与排序口径在 Rust 侧是同一条 SQL 分支，所以点进去看到的明细必定对得上。
 *
 * 切档时**不清空旧数据**（用户 m09915 报的「点这几个 tag 会屏闪」就是清空造成的）：
 * 把热力图和榜单整块抽掉会让卡片高度骤降，滚动容器随之把位置夹回、背景重排，
 * 看上去就是闪一下。现在旧内容原地留着、压到 70% 透明，顶部一条细进度条表示正在换档，
 * 新数据到达后直接替换 —— 高度不塌，就没有闪。
 */
export function ListenTrendSection(props: {
  onOpenDetail: (kind: ListenReportKind, days: number, entry?: ListenReportEntry) => void;
}): React.JSX.Element {
  const { onOpenDetail } = props;
  const active = useKeepAliveActive();
  const sourceLabel = useSourceLabelFn();
  const [days, setDays] = useState<number>(365);
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
    void ipc.getListenDayReport({ kind, order: "count", days, limit: ROW_LIMIT })
      .then((value) => { if (!cancelled) setReport(value); })
      .catch((reason: unknown) => { if (!cancelled) setError(errMsg(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [active, days, kind, revision]);

  const windowLabel = WINDOWS.find((item) => item.days === days)?.label ?? "";
  const kindLabel = KINDS.find((item) => item.kind === kind)?.label ?? "";
  const points = report?.daily ?? [];
  const todayKey = listenDayKey(Date.now());
  /** 有旧数据还在换档：内容压暗 + 顶部进度条，而不是抽掉重画 */
  const stale = loading && report !== null;
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

      <div
        aria-busy={loading || undefined}
        className={cn("rounded-2xl border border-border bg-card/60 p-4 transition-opacity duration-base", stale && "opacity-70")}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-xs text-muted-foreground">{windowLabel} · 常听{kindLabel}</p>
          {report && <p className="text-xs tabular-nums text-muted-foreground">共 <span className="text-sm font-semibold text-foreground">{report.totalPlays}</span> 次播放 · {formatReportDuration(report.totalPlayedMs)} · 活跃 {report.activeDays} 天</p>}
        </div>

        {/* 常驻 2px 高度：进度条出现/消失都不推动下面的内容（否则换档时又是一次跳变） */}
        <div className="mt-1 h-0.5 overflow-hidden rounded-full">{loading ? <LoadBar /> : null}</div>

        {error ? (
          <div role="alert" className="flex flex-col items-center gap-2 py-10 text-center text-xs text-destructive">
            <p>趋势读取失败：{error}</p>
            <Button variant="outline" size="xs" onClick={() => setRevision((value) => value + 1)}>重试</Button>
          </div>
        ) : <>
          <ListenHeatmap
            points={points}
            todayKey={todayKey}
            loading={loading && report === null}
            skeletonWeeks={skeletonWeeksFor(days)}
            days={days}
          />

          {report && report.items.length > 0 ? <ul className="mt-2">{report.items.map((entry, index) => (
            <li key={entry.id} className="border-b border-border/50 last:border-b-0">
              <button type="button" className="flex w-full items-center gap-3 py-2 text-left transition-colors hover:bg-secondary/60" onClick={() => onOpenDetail(kind, days, entry)}>
                <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                <EntryPicture entry={entry} kind={kind} name={nameOf(entry)} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5 text-sm"><span className="truncate">{nameOf(entry)}</span>{entry.track ? <SourceTag platform={entry.track.platform} size="xs" /> : null}</span>
                  <span className="mt-0.5 block truncate text-2xs text-muted-foreground">{kind === "tracks" ? entry.track?.singer || "未知歌手" : `${entry.trackCount} 首歌曲`}</span>
                </span>
                <span className="shrink-0 text-right text-2xs tabular-nums text-muted-foreground">{entry.playCount} 次<span className="mt-0.5 block">{formatReportDuration(entry.totalPlayedMs)}</span></span>
                <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
              </button>
            </li>
          ))}</ul> : !loading && <p className="py-6 text-center text-xs text-muted-foreground">这个范围内还没有播放记录。</p>}

          {report && <div className="mt-3 flex justify-end">
            <Button variant="link" size="xs" iconRight={<ChevronRight className="h-3 w-3" />} aria-label={`查看全部${windowLabel}${kindLabel}`} onClick={() => onOpenDetail(kind, days)}>查看全部{kindLabel}</Button>
          </div>}
        </>}
      </div>
    </section>
  );
}

// EntryPicture 合并到 `./ListenReportBits`（与收听详情页同一实现，这里传 size={32}）。
