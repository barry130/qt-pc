import { useEffect, useMemo, useState } from "react";
import { Play, Headphones } from "lucide-react";
import type { AudioProgram, Chart, SourceId } from "@/types";
import * as sourceApi from "@/source-scripts";
import { useNavigate } from "@tanstack/react-router";
import { BackButton } from "@/components/layout/BackButton";
import { ErrorRetry } from "./Skeletons";
import { qtresCoverUrl } from "@/lib/lrc";

import { EmptyState, GridSkeleton } from "@/components/ui";
/** QQ 有声榜：榜单返回节目容器，先浏览节目，再进入章节页播放。 */
export function AudioChartPage(props: { platform: SourceId; id: string }): React.JSX.Element {
  const { platform, id } = props;
  const navigate = useNavigate();
  const [chart, setChart] = useState<Chart>({
    id,
    platform,
    name: "有声榜",
    picUrl: "",
    description: null,
    contentType: "programs",
  });
  const [programs, setPrograms] = useState<AudioProgram[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 重载触发：失败后点重试不能靠刷整页（会丢掉播放队列与滚动位置） */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [charts, list] = await Promise.all([
          sourceApi.getCharts(platform).catch(() => []),
          sourceApi.getAudioChartPrograms(chart),
        ]);
        if (cancelled) return;
        const found = charts.find((item) => item.id === id);
        if (found) setChart(found);
        setPrograms(Array.isArray(list) ? list : []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // chart 只在请求回来后替换，依赖 id/platform（+attempt）避免反复取数
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, id, attempt]);

  const cover = useMemo(() => qtresCoverUrl(chart.picUrl), [chart.picUrl]);
  const open = (program: AudioProgram): void => {
    void navigate({
      to: "/audio-program/$platform/$id",
      params: { platform: program.platform, id: program.id },
    });
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="relative shrink-0 border-b border-border">
        <div className="relative flex items-center px-6 pt-5"><BackButton /></div>
        <div className="relative flex gap-5 px-6 pb-6 pt-4">
          <div className="h-28 w-28 shrink-0 overflow-hidden rounded-2xl bg-secondary shadow-surface ring-1 ring-border">
            {cover ? <img src={cover} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-3xl text-muted-foreground/50"><Headphones /></div>}
          </div>
          <div className="min-w-0 self-end pb-1">
            <p className="text-2xs font-medium uppercase tracking-[0.2em] text-muted-foreground">有声榜</p>
            <h1 className="mt-1 truncate text-2xl font-bold tracking-tight">{chart.name}</h1>
            <p className="mt-1 text-xs text-muted-foreground">{loading ? "加载中…" : `${programs.length} 个节目`}</p>
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {error ? <ErrorRetry message={`加载失败：${error}`} onRetry={() => setAttempt((n) => n + 1)} /> : null}
        {!error && loading ? <GridSkeleton count={6} minTile={220} padded={false} /> : null}
        {!error && !loading && programs.length === 0 ? <EmptyState title="暂无节目" /> : null}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {programs.map((program, index) => {
            const image = qtresCoverUrl(program.picUrl);
            return (
              <div key={`${program.id}:${index}`} className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card/60 p-3 hover:shadow-surface">
                <button type="button" className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-secondary" onClick={() => open(program)} aria-label={`查看节目 ${program.name}`}>
                  {image ? <img src={image} alt="" loading="lazy" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-muted-foreground"><Headphones className="h-5 w-5" /></div>}
                </button>
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => open(program)}>
                  <p className="truncate text-sm font-medium">{program.name || "未命名节目"}</p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{program.artist || "QQ音乐"}</p>
                  {/* 榜单接口只给节目容器、不给集数（chapterCount 恒 0），
                      集数在节目详情里按 albummid 取 total 才有真值。 */}
                  <p className="mt-1 text-2xs text-muted-foreground">{program.chapterCount > 0 ? `${program.chapterCount} 集` : "有声节目 · 进入查看章节"}</p>
                </button>
                <button type="button" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => open(program)} aria-label={`播放节目 ${program.name}`}>
                  <Play className="h-3.5 w-3.5 fill-current" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
