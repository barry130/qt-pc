import { useCallback, useMemo, useState } from "react";
import { Play, Headphones } from "lucide-react";
import type { SourceId, Track } from "@/types";
import * as sourceApi from "@/source-scripts";
import { usePlayerStore } from "@/stores/player";
import { BackButton } from "@/components/layout/BackButton";
import { TrackList } from "./TrackList";
import { ErrorRetry, TrackRowsSkeleton } from "./Skeletons";
import { qtresCoverUrl } from "@/lib/lrc";
import { usePagedList, type PageResult } from "@/hooks/usePagedList";

/** 有声节目详情：章节是普通 Track，可沿用播放器、下载、收藏和批量操作。 */
export function AudioProgramPage(props: { platform: SourceId; id: string }): React.JSX.Element {
  const { platform, id } = props;
  const playQueue = usePlayerStore((s) => s.playQueue);
  const [meta, setMeta] = useState({ name: "有声节目", artist: "", picUrl: "", description: "" });
  const pageSize = 30;
  const fetchPage = useCallback(async (page: number): Promise<PageResult<Track>> => {
    const detail = await sourceApi.getAudioProgramDetail(platform, id, page, pageSize);
    if (page === 1) {
      setMeta({
        name: detail.program.name || "有声节目",
        artist: detail.program.artist,
        picUrl: detail.program.picUrl,
        description: detail.program.description ?? "",
      });
    }
    return { list: detail.tracks, hasMore: detail.hasMore };
  }, [id, platform]);
  const { items: tracks, loading, loadingMore, error, hasMore, sentinelRef, reload } = usePagedList<Track>({
    fetchPage,
    keyOf: (track) => `${track.platform}:${track.id}`,
    resetKey: `${platform}:${id}`,
    pageSize,
  });
  const [query, setQuery] = useState("");
  const visibleTracks = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? tracks.filter((t) => `${t.title} ${t.singer} ${t.album}`.toLowerCase().includes(q)) : tracks;
  }, [query, tracks]);
  const cover = qtresCoverUrl(meta.picUrl);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="relative shrink-0 border-b border-border">
        <div className="flex items-center px-6 pt-5"><BackButton /></div>
        <div className="flex gap-5 px-6 pb-6 pt-4">
          <div className="h-36 w-36 shrink-0 overflow-hidden rounded-2xl bg-secondary shadow-xl ring-1 ring-border">
            {cover ? <img src={cover} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-muted-foreground/50"><Headphones className="h-10 w-10" /></div>}
          </div>
          <div className="min-w-0 flex-1 self-end pb-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">有声节目</p>
            <h1 className="mt-1 truncate text-2xl font-bold tracking-tight">{meta.name}</h1>
            {meta.artist ? <p className="mt-1 truncate text-xs text-muted-foreground">{meta.artist}</p> : null}
            {meta.description ? <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{meta.description}</p> : null}
            <div className="mt-3 flex items-center gap-2">
              <button type="button" disabled={loading || visibleTracks.length === 0} onClick={() => void playQueue(visibleTracks, 0)} className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-lg shadow-primary/25 disabled:opacity-50" aria-label={query.trim() ? "播放搜索到的章节" : "播放全部章节"}><Play className="h-4 w-4 fill-current" /></button>
              {/* 搜索只在已加载的章节里过滤（分页是无限下拉），所以要说清是「已加载」，
                  不能让人以为整本只剩这么多集。 */}
              <span className="text-xs text-muted-foreground">
                {loading
                  ? "加载中…"
                  : query.trim()
                    ? `已加载 ${tracks.length} 集，匹配 ${visibleTracks.length} 集`
                    : `${tracks.length} 集${hasMore ? "（继续下拉加载）" : ""}`}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-end pb-1">
            {tracks.length > 0 ? <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="章节内搜索" aria-label="章节内搜索" className="h-8 w-40 rounded-lg border border-input bg-background/80 px-2 text-xs outline-none focus:ring-1 focus:ring-ring" /> : null}
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? <ErrorRetry message={`加载失败：${error}`} onRetry={reload} /> : null}
        {!error && loading ? <TrackRowsSkeleton rows={8} /> : null}
        {!error && !loading && visibleTracks.length === 0 ? <div className="py-10 text-center text-sm text-muted-foreground">{tracks.length === 0 ? "暂无章节" : "没有匹配的章节"}</div> : null}
        {!error && !loading && visibleTracks.length > 0 ? <TrackList tracks={visibleTracks} showIndex showCollect showDownload /> : null}
        <div ref={sentinelRef} className="h-1" />
        <div className="py-4 text-center text-xs text-muted-foreground">{loadingMore ? "加载中…" : hasMore ? "继续下拉加载更多" : tracks.length > 0 ? "已经到底了" : ""}</div>
      </div>
    </div>
  );
}
