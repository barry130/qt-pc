import { useEffect, useState } from "react";
import { errMsg } from "@/lib/utils";
import type { Chart, SourceId, Track } from "@/types";
import * as sourceApi from "@/source-scripts";
import { usePlayerStore } from "@/stores/player";
import { TrackList } from "./TrackList";
import { BackButton } from "@/components/layout/BackButton";

/**
 * 榜单详情（路由 /chart/$platform/$id，DESIGN §5.2）。
 *
 * `getChartDetail` 需要整个 Chart 对象（脚本层按 chart.platform 路由平台模块、
 * 用 chart.id 取榜单），而路由只带 platform/id，因此先从聚合榜单列表里找回
 * Chart 补全标题与封面；列表不可用时退化为仅含 platform+id 的最小对象，
 * 详情照常加载。
 */
export function ChartDetailPage(props: {
  platform: string;
  id: string;
}): React.JSX.Element {
  const { platform, id } = props;
  const [title, setTitle] = useState("榜单详情");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const playQueue = usePlayerStore((s) => s.playQueue);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      let chart: Chart = {
        id,
        platform: platform as SourceId,
        name: "",
        picUrl: "",
        description: null,
      };
      try {
        const all = await sourceApi.getAllCharts();
        const found = all.find((c) => c.platform === platform && c.id === id);
        if (!cancelled && found) chart = found;
      } catch {
        // 榜单列表失败不阻断详情：退化为最小 Chart 对象
      }
      try {
        const list = await sourceApi.getChartDetail(chart, 1, 100);
        if (cancelled) return;
        setTracks(Array.isArray(list) ? list : []);
        setTitle(chart.name || "榜单详情");
      } catch (err) {
        if (!cancelled) setError(errMsg(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [platform, id]);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <BackButton />
          <h1 className="truncate text-base font-medium">{title}</h1>
        </div>
        <button
          type="button"
          disabled={tracks.length === 0}
          onClick={() => void playQueue(tracks, 0)}
          className="h-8 shrink-0 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          播放全部
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            加载中…
          </div>
        ) : error ? (
          <div className="py-10 text-center text-sm text-destructive">
            加载失败：{error}
          </div>
        ) : (
          <TrackList tracks={tracks} showIndex showAddToPlaylist showDownload />
        )}
      </div>
    </div>
  );
}
