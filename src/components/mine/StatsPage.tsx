import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type {
  PlayOverview,
  PlayStatItem,
  SingerStat,
  SourceId,
} from "@/types";
import * as ipc from "@/services/ipc";
import { usePlayerStore } from "@/stores/player";

/**
 * 听歌统计（路由 /stats，DESIGN §5.3）。
 * 数据由播放引擎在起播时写进 play_stats：次数 +1、时长按曲目时长累加。
 * 没有记录时给空态，而不是一堆 0。
 */
export function StatsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const playQueue = usePlayerStore((s) => s.playQueue);

  const [overview, setOverview] = useState<PlayOverview | null>(null);
  const [tracks, setTracks] = useState<PlayStatItem[]>([]);
  const [singers, setSingers] = useState<SingerStat[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
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
  }, []);

  const empty = !overview || overview.totalPlays === 0;

  return (
    <div className="h-full min-w-0 overflow-y-auto px-5 py-5">
      <h1 className="text-lg font-semibold">听歌统计</h1>

      {loading ? (
        <p className="py-10 text-center text-sm text-muted-foreground">加载中…</p>
      ) : empty ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          还没有听歌记录，去听几首歌再回来看。
        </p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="总播放" value={`${overview.totalPlays} 次`} />
            <StatCard label="累计时长" value={formatMs(overview.totalMs)} />
            <StatCard label="曲目数" value={`${overview.trackCount} 首`} />
            <StatCard
              label="最近播放"
              value={
                overview.lastPlayedAt
                  ? formatDate(overview.lastPlayedAt)
                  : "—"
              }
            />
          </div>

          {tracks.length > 0 && (
            <section className="mt-7">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm text-muted-foreground">常听歌曲</h2>
                <button
                  type="button"
                  onClick={() =>
                    void playQueue(
                      tracks.map((it) => it.track),
                      0,
                    )
                  }
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  播放全部
                </button>
              </div>
              <ul>
                {tracks.map((it, i) => (
                  <li key={`${it.track.id}-${i}`}>
                    <button
                      type="button"
                      onClick={() =>
                        void playQueue(
                          tracks.map((x) => x.track),
                          i,
                        )
                      }
                      className="flex w-full items-center gap-3 border-b border-border/50 py-2 text-left text-sm transition-colors hover:bg-secondary"
                    >
                      <span className="w-5 shrink-0 text-xs tabular-nums text-muted-foreground">
                        {i + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{it.track.title}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {it.track.singer}
                        </div>
                      </div>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {it.playCount} 次
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {singers.length > 0 && (
            <section className="mt-7">
              <h2 className="mb-2 text-sm text-muted-foreground">常听歌手</h2>
              <ul>
                {singers.map((s) => (
                  <li key={s.singer}>
                    <button
                      type="button"
                      onClick={() =>
                        void navigate({
                          to: "/artist/$platform/$id",
                          params: {
                            platform: s.platform as SourceId,
                            id: encodeURIComponent(s.singer),
                          },
                        })
                      }
                      className="flex w-full items-center gap-3 py-2 text-left text-sm transition-colors hover:text-primary"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {s.singer}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {s.playCount} 次
                      </span>
                    </button>
                    <Bar
                      value={s.playCount}
                      max={singers[0]?.playCount ?? 1}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function StatCard(props: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border px-4 py-3">
      <div className="text-xs text-muted-foreground">{props.label}</div>
      <div className="mt-1 truncate text-base font-medium">{props.value}</div>
    </div>
  );
}

function Bar(props: { value: number; max: number }): React.JSX.Element {
  const width = props.max > 0 ? (props.value / props.max) * 100 : 0;
  return (
    <div className="h-1 w-full overflow-hidden rounded bg-secondary">
      <div
        className="h-full rounded bg-primary/70"
        style={{ width: `${width}%` }}
      />
    </div>
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
