import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mic, Play, RefreshCw, Rss, Trash2 } from "lucide-react";
import { formatTime } from "@/lib/lrc";
import type { PodcastEpisode, PodcastShow, Track } from "@/types";
import * as ipc from "@/services/ipc";
import { usePlayerStore } from "@/stores/player";
import { Button, EmptyState, Input } from "@/components/ui";

/**
 * 播客 / 有声书（路由 /podcast，B9，对照分析文档 §4.13）。
 *
 * ## 为什么播客不走「下载到本地再当本地曲目播」
 * 那会把每一次订阅都塞进用户曲库：整理、去重、库体检、播放统计全被播客污染，
 * 而且下载到一半失败还得自己收拾残局。这里让单集的音频直链直接进播放引擎
 * （`platform = "podcast"`，见 Rust `provider::types::PODCAST_SOURCE`），
 * 引擎用 range_reader 边播边缓存、可 seek —— 播客需要的正是这两点。
 *
 * ## 续播靠「起播后 seek」而不是伪造开始位置
 * 本地曲库的 CUE 分轨用的是 `startMs`/`endMs`（会连带改变时长口径），
 * 播客没有这个需求：把 `positionMs` 存在库里，起播放完音就 seek 过去，
 * 进度条与时长仍然是这一集的真实值，写错也不会失真。
 *
 * ## 进度存哪里
 * 前端每 5 秒把「当前集 + 位置」写回库（`savePodcastProgress`），切集 / 暂停 /
 * 听到 95% 以上时立刻再写一次并记 `played`。存得勤不是为了数据好看，而是
 * 播客动辄一小时，崩溃或关窗丢一次就等于让用户重听半集。
 */

/** 平台标识：Rust `PODCAST_SOURCE`，两端必须一致（见 provider/types.rs） */
const PODCAST_PLATFORM = "podcast";
/** 进度落库间隔（毫秒） */
const SAVE_INTERVAL_MS = 5000;
/** 听到这个比例就算听完（多数播客结尾有口播与音乐，听不到最后一秒很正常） */
const FINISH_RATIO = 0.95;

function formatDay(ms: number): string {
  if (!ms) return "未知日期";
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

/** 单集 → 播放器曲目：`id` 就是音频直链，引擎据此走播客分支 */
function toTrack(episode: PodcastEpisode, show: PodcastShow): Track {
  return {
    id: episode.audioUrl,
    platform: PODCAST_PLATFORM,
    title: episode.title,
    singer: show.author || show.title,
    album: show.title,
    picUrl: show.image,
    // 引擎要秒；RSS 里没写时长时给 0（引擎会按解码结果补）
    duration: Math.max(0, Math.round(episode.durationMs / 1000)),
  };
}

export function PodcastPage(): React.JSX.Element {
  const [shows, setShows] = useState<PodcastShow[]>([]);
  const [episodes, setEpisodes] = useState<PodcastEpisode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const currentTrack = usePlayerStore((s) => s.state?.track ?? null);
  const status = usePlayerStore((s) => s.state?.status ?? "stopped");
  const positionMs = usePlayerStore((s) => s.state?.positionMs ?? 0);

  /** 当前选中的订阅对象（渲染用） */
  const selected = useMemo(
    () => shows.find((show) => show.id === selectedId) ?? null,
    [shows, selectedId],
  );
  /**
   * 音频直链 → 单集：保存进度时反查用（播放器只知道 `Track.id`）。
   *
   * 不能只从「当前选中的订阅」里现算：用户听着 A 的单集切到 B 看节目单时，
   * persist() 就查不到 A 的单集，播放进度与 ≥95% 的「已听完」标记整段丢失
   * （C16）。这里按音频直链跨订阅累积，只增不减；`episodes` 只负责当前列表渲染。
   */
  const episodeByUrl = useRef(new Map<string, PodcastEpisode>());
  /** 待续播位置：起播到底后 seek 一次就清掉 */
  const pendingSeek = useRef<{ trackId: string; positionMs: number } | null>(null);

  const loadShows = useCallback(async (keep?: string) => {
    const list = await ipc.listPodcastShows();
    setShows(list);
    const next = keep ?? list[0]?.id ?? null;
    setSelectedId(next);
    return next;
  }, []);

  const loadEpisodes = useCallback(async (showId: string | null) => {
    if (!showId) {
      setEpisodes([]);
      return;
    }
    const list = await ipc.listPodcastEpisodes(showId);
    // 跨订阅累积：切到别的订阅后，正在播放那一集的进度仍然要能落库（C16）
    for (const item of list) episodeByUrl.current.set(item.audioUrl, item);
    setEpisodes(list);
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await ipc.listPodcastShows();
        if (!alive) return;
        setShows(list);
        setSelectedId(list[0]?.id ?? null);
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    void loadEpisodes(selectedId);
  }, [selectedId, loadEpisodes]);

  /** 起播后把进度 seek 回去：等引擎真的开始出声（playing/paused）再定位 */
  useEffect(() => {
    const pending = pendingSeek.current;
    if (!pending || currentTrack?.id !== pending.trackId) return;
    if (status !== "playing" && status !== "paused") return;
    pendingSeek.current = null;
    if (pending.positionMs > 0 && positionMs < pending.positionMs) {
      void usePlayerStore.getState().seekTo(pending.positionMs);
    }
  }, [currentTrack?.id, status, positionMs]);

  /** 进度落库：定时一次 + 播放状态变化时一次 */
  const persist = useCallback(() => {
    // tick 只更新顶层进度标量；state.positionMs 是最近一次语义快照的位置。
    const { state, positionMs: currentPositionMs } = usePlayerStore.getState();
    const track = state?.track;
    if (!track || track.platform !== PODCAST_PLATFORM) return;
    // 从跨订阅累积的索引里取：当前列表切到别的订阅也照样能保存正在播放那一集（C16）
    const episode = episodeByUrl.current.get(track.id);
    if (!episode) return;
    const total = episode.durationMs || state.durationMs || 0;
    const played = total > 0 && currentPositionMs >= total * FINISH_RATIO;
    void ipc.savePodcastProgress(episode.id, Math.round(currentPositionMs), played).catch(() => {});
  }, []);

  useEffect(() => {
    const timer = window.setInterval(persist, SAVE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [persist]);

  const lastStatus = useRef(status);
  useEffect(() => {
    if (lastStatus.current !== status) {
      // 切集 / 暂停 / 停止都意味着「这一段的进度到此为止」
      if (lastStatus.current === "playing") persist();
      lastStatus.current = status;
    }
  }, [status, persist]);

  async function subscribe() {
    const address = url.trim();
    if (!address || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const show = await ipc.addPodcastShow(address);
      setUrl("");
      setNotice(`已订阅「${show.title}」，共 ${show.episodeCount} 集`);
      await loadShows(show.id);
      await loadEpisodes(show.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function refresh(show: PodcastShow) {
    setBusy(true);
    setError("");
    try {
      const fresh = await ipc.refreshPodcastShow(show.id);
      setNotice(`「${fresh.title}」已刷新，共 ${fresh.episodeCount} 集`);
      await loadShows(fresh.id);
      await loadEpisodes(fresh.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(show: PodcastShow) {
    setBusy(true);
    setError("");
    try {
      await ipc.removePodcastShow(show.id);
      setNotice(`已取消订阅「${show.title}」`);
      const next = await loadShows();
      await loadEpisodes(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function play(episode: PodcastEpisode) {
    if (!selected) return;
    setError("");
    // 先记进索引：即使马上切走订阅，这一集的进度也能保存（C16）
    episodeByUrl.current.set(episode.audioUrl, episode);
    try {
      const track = toTrack(episode, selected);
      const resumeAt = episode.played ? 0 : episode.positionMs;
      pendingSeek.current = resumeAt > 0 ? { trackId: track.id, positionMs: resumeAt } : null;
      await usePlayerStore.getState().playQueue([track], 0);
    } catch (e) {
      setError(String(e));
    }
  }

  const playingEpisode = currentTrack ? episodeByUrl.current.get(currentTrack.id) ?? null : null;

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">播客</h1>
        <p className="text-xs text-muted-foreground">
          订阅 RSS 后可播放、断点续播。播放后点击底部封面，进入字幕阅读，可获取字幕、生成字幕和翻译中文。
        </p>
      </header>

      <div className="flex items-center gap-2">
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="粘贴 RSS / Atom 订阅地址（https://…）"
          aria-label="播客订阅地址"
          onKeyDown={(e) => {
            if (e.key === "Enter") void subscribe();
          }}
        />
        <Button onClick={() => void subscribe()} disabled={busy || !url.trim()}>
          <Rss className="mr-1 h-4 w-4" />
          订阅
        </Button>
      </div>

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}

      {shows.length === 0 ? (
        <EmptyState
          title="还没有订阅任何播客"
          description="在上面粘贴一个 RSS 地址就能开始听。"
        />
      ) : (
        <div className="flex min-h-0 flex-1 gap-4">
          <ul
            data-testid="podcast-shows"
            className="w-64 shrink-0 space-y-1 overflow-y-auto pr-1"
          >
            {shows.map((show) => {
              const active = show.id === selectedId;
              return (
                <li key={show.id}>
                  <div
                    className={`flex items-center gap-2 rounded-md px-2 py-2 ${
                      active ? "bg-accent" : "hover:bg-accent/50"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedId(show.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      aria-current={active ? "true" : undefined}
                    >
                      {show.image ? (
                        <img
                          src={show.image}
                          alt=""
                          loading="lazy"
                          className="h-9 w-9 shrink-0 rounded object-cover"
                        />
                      ) : (
                        <span
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground"
                          aria-hidden="true"
                        >
                          <Mic className="h-4 w-4" />
                        </span>
                      )}
                      <span className="min-w-0">
                        <span className="block truncate text-sm">{show.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {show.author || "未知作者"} · {show.episodeCount} 集
                        </span>
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`刷新「${show.title}」`}
                      disabled={busy}
                      onClick={() => void refresh(show)}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`取消订阅「${show.title}」`}
                      disabled={busy}
                      onClick={() => void remove(show)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="min-w-0 flex-1 overflow-y-auto">
            {selected ? (
              <div className="mb-3 flex flex-col gap-1">
                <h2 className="text-base font-medium">{selected.title}</h2>
                {selected.description ? (
                  <p className="line-clamp-2 text-xs text-muted-foreground">
                    {selected.description}
                  </p>
                ) : null}
              </div>
            ) : null}

            {episodes.length === 0 ? (
              <p className="text-xs text-muted-foreground">这个订阅里还没有单集。</p>
            ) : (
              <ul data-testid="podcast-episodes" className="space-y-1">
                {episodes.map((episode) => {
                  const isCurrent = playingEpisode?.id === episode.id;
                  return (
                    <li
                      key={episode.id}
                      className={`flex items-center gap-3 rounded-md px-2 py-2 ${
                        isCurrent ? "bg-accent" : "hover:bg-accent/50"
                      }`}
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`播放「${episode.title}」`}
                        onClick={() => void play(episode)}
                      >
                        <Play className="h-4 w-4" />
                      </Button>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{episode.title}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {formatDay(episode.publishedAt)}
                          {episode.durationMs > 0
                            ? ` · ${formatTime(episode.durationMs)}`
                            : ""}
                          {episode.played
                            ? " · 已听完"
                            : episode.positionMs > 0
                              ? ` · 继续播放 ${formatTime(episode.positionMs)}`
                              : ""}
                        </p>
                      </div>
                      {isCurrent ? (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {status === "playing" ? "播放中" : "已暂停"}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
