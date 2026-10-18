import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Loader2, Play, RefreshCw } from "lucide-react";
import type { LocalMixSummary, Track } from "@/types";
import * as ipc from "@/services/ipc";
import { errMsg } from "@/lib/utils";
import { usePlayerStore } from "@/stores/player";
import { TrackList } from "@/components/discovery/TrackList";

/** 合辑详情实时重算，不把动态规则合辑保存成静态歌单。 */
export function LocalMixPage({ mixKey }: { mixKey: string }): React.JSX.Element {
  const navigate = useNavigate();
  const playQueue = usePlayerStore((s) => s.playQueue);
  const [mix, setMix] = useState<LocalMixSummary | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setTracks([]);
    setMix(null);
    void Promise.all([ipc.listLocalMixes(), ipc.getLocalMixTracks(mixKey)]).then(([list, rows]) => {
      if (cancelled) return;
      setMix(list.find((entry) => entry.key === mixKey) ?? null);
      setTracks(rows);
    }).catch((err: unknown) => {
      if (!cancelled) setError(errMsg(err));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [mixKey, refreshKey]);

  const playAll = async (): Promise<void> => {
    if (playing || tracks.length === 0) return;
    setPlaying(true);
    setError(null);
    try {
      await playQueue(tracks, 0);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setPlaying(false);
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-5">
        <button
          type="button" aria-label="返回发现音乐" title="返回发现音乐"
          onClick={() => void navigate({ to: "/" })}
          className="rounded-full p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-bold">{mix?.title ?? "本地合辑"}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {mix?.subtitle ?? "根据本机收听记录和收藏整理"}
            {!loading && tracks.length > 0 ? ` · 精选 ${tracks.length} 首` : ""}
          </p>
        </div>
        <button
          type="button" aria-label="重新整理合辑" disabled={loading}
          onClick={() => setRefreshKey((key) => key + 1)}
          className="rounded-full p-2 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
        <button
          type="button" disabled={loading || playing || tracks.length === 0}
          onClick={() => void playAll()}
          className="flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {playing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          播放全部
        </button>
      </header>
      {error && <p role="alert" className="px-5 pt-4 text-sm text-destructive">{error}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {loading ? (
          <p className="py-12 text-center text-sm text-muted-foreground">正在整理合辑…</p>
        ) : tracks.length > 0 ? (
          <TrackList tracks={tracks} showIndex showCollect showDownload />
        ) : !error ? (
          <p className="py-12 text-center text-sm text-muted-foreground">暂时没有足够的曲目，听听歌后再来看看。</p>
        ) : null}
      </div>
    </div>
  );
}
