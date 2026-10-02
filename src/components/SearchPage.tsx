import { useCallback, useEffect, useMemo, useState } from "react";
import { errMsg } from "@/lib/utils";
import { Play, Search, SearchX, X } from "lucide-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { Album, Artist, Playlist, Track } from "@/types";
import { useSourceLabelFn } from "@/stores/sourceRegistry";
import * as sourceApi from "@/source-scripts";
import type { SearchSourceBatch } from "@/source-scripts";
import { usePlayerStore } from "@/stores/player";
import { useMusicSourceStore } from "@/stores/musicSource";
import {
  addSearchHistory,
  clearSearchHistory,
  getSearchHistory,
  removeSearchHistoryItem,
} from "@/lib/search-history";
import { qtresCoverUrl, formatTime } from "@/lib/lrc";
import { CoverCard, CoverGrid } from "./discovery/CoverCard";
import { TrackRowsSkeleton } from "./discovery/Skeletons";
import { BackButton } from "@/components/layout/BackButton";

/**
 * 搜索页（路由 /search?q=，DESIGN §5.2：关键字走 URL query，前进 / 后退可复现）。
 *
 * 四类结果对应脚本层四个动作（DESIGN §6.5）：
 * - 歌曲   searchMusic（或聚合模式 searchAllBatches：四源各一批，按源分组展示）
 * - 歌单   searchPlaylists → 跳歌单详情
 * - 歌手   searchArtists   → 跳歌手详情
 * - 专辑   searchAlbums    → 跳专辑详情
 *
 * 输入区还有三件配套事：
 * - 落地页（无 q）：搜索历史（settings 持久化）+ 当前音源热搜榜
 * - 输入中：按历史 + 热搜词前缀/包含联想（音源包没有 suggest 接口，取自本地数据）
 * - 聚合开关只作用于「歌曲」页签（歌单/歌手/专辑保持当前源）
 */
type Tab = "song" | "playlist" | "artist" | "album";

const TABS: { key: Tab; label: string }[] = [
  { key: "song", label: "歌曲" },
  { key: "playlist", label: "歌单" },
  { key: "artist", label: "歌手" },
  { key: "album", label: "专辑" },
];

export function SearchPage(): React.JSX.Element {
  const urlParams = useSearch({ strict: false }) as { q?: string };
  const navigate = useNavigate();
  const activeSourceId = useMusicSourceStore((s) => s.activeSourceId);
  const sourceLabel = useSourceLabelFn();
  const aggregateMode = useMusicSourceStore((s) => s.aggregateMode);
  const setAggregateMode = useMusicSourceStore((s) => s.setAggregateMode);

  const [keyword, setKeyword] = useState(urlParams.q ?? "");
  const [tab, setTab] = useState<Tab>("song");
  const [songs, setSongs] = useState<Track[]>([]);
  const [aggBatches, setAggBatches] = useState<SearchSourceBatch[] | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [artists, setArtists] = useState<Artist[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [hotWords, setHotWords] = useState<string[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const currentTrackId = usePlayerStore((s) => s.state?.trackId ?? null);

  // 搜索历史只在挂载时读一次（增删在本地改完同步落盘）
  useEffect(() => {
    void getSearchHistory().then(setHistory).catch(() => {});
  }, []);

  // 热搜榜跟随当前音源；接口失败静默隐藏（热搜是锦上添花，不该打扰搜索）
  useEffect(() => {
    let cancelled = false;
    if (activeSourceId === "local") {
      setHotWords([]);
      return;
    }
    void sourceApi
      .getHotWords(activeSourceId)
      .then((words) => {
        if (!cancelled) setHotWords(Array.isArray(words) ? words : []);
      })
      .catch(() => {
        if (!cancelled) setHotWords([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSourceId]);

  const run = useCallback(
    async (kw: string, t: Tab, aggregate: boolean): Promise<void> => {
      const trimmed = kw.trim();
      if (!trimmed) return;
      setSearching(true);
      setError(null);
      try {
        if (t === "song" && aggregate) {
          const batches = await sourceApi.searchAllBatches(trimmed, 1, 30);
          setAggBatches(batches);
          setSongs(batches.flatMap((b) => b.tracks));
        } else {
          setAggBatches(null);
          switch (t) {
            case "song": {
              const r = await sourceApi.searchMusic(trimmed, activeSourceId, 1, 30);
              setSongs(Array.isArray(r) ? r : []);
              break;
            }
            case "playlist": {
              const r = await sourceApi.searchPlaylists(activeSourceId, trimmed, 1, 20);
              setPlaylists(Array.isArray(r) ? r : []);
              break;
            }
            case "artist": {
              const r = await sourceApi.searchArtists(activeSourceId, trimmed, 1, 20);
              setArtists(Array.isArray(r) ? r : []);
              break;
            }
            case "album": {
              const r = await sourceApi.searchAlbums(activeSourceId, trimmed, 1, 20);
              setAlbums(Array.isArray(r) ? r : []);
              break;
            }
          }
        }
        setSearched(true);
      } catch (err) {
        setError(errMsg(err));
        setSearched(true);
      } finally {
        setSearching(false);
      }
    },
    [activeSourceId],
  );

  const submit = useCallback(
    (kw: string): void => {
      const trimmed = kw.trim();
      if (!trimmed) return;
      setKeyword(trimmed);
      setSuggestOpen(false);
      // 历史只记「主动发起的搜索」：前进/后退复现 URL 不算，避免污染历史
      void addSearchHistory(trimmed).then(() => getSearchHistory()).then(setHistory).catch(() => {});
      void navigate({ to: "/search", search: { q: trimmed } });
      void run(trimmed, tab, aggregateMode);
    },
    [aggregateMode, navigate, run, tab],
  );

  // URL q 变化（前进 / 后退 / 标题栏搜索框）、页签切换、聚合开关 → 触发搜索
  useEffect(() => {
    const q = urlParams.q?.trim() ?? "";
    if (q) void run(q, tab, aggregateMode);
  }, [urlParams.q, tab, aggregateMode, run]);

  // 联想：历史 + 热搜词里按包含关系筛（无 suggest 接口，本地数据够用且零成本）
  const suggestions = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const word of [...history, ...hotWords]) {
      const w = word.trim();
      if (!w || seen.has(w)) continue;
      seen.add(w);
      if (w.toLowerCase().includes(kw) && w.toLowerCase() !== kw) out.push(w);
      if (out.length >= 8) break;
    }
    return out;
  }, [keyword, history, hotWords]);

  const switchTab = (t: Tab): void => {
    setTab(t);
  };

  const removeHistory = (kw: string): void => {
    setHistory((h) => h.filter((k) => k !== kw));
    void removeSearchHistoryItem(kw).catch(() => {});
  };

  const clearHistory = (): void => {
    setHistory([]);
    void clearSearchHistory().catch(() => {});
  };

  /**
   * 歌手 / 专辑都跳各自的详情页（路由 /artist、/album），不再直接取歌播放：
   * 详情页能先看清单再决定播不播，也和歌单的交互保持一致。
   * 音源没有「按 id 取歌」的免费接口，所以 URL 的 $id 位置放名字（encode 过），
   * 详情页内部再按名字搜歌闭环 —— 见对应页面的注释。
   */
  const openArtist = (a: Artist): void => {
    void navigate({
      to: "/artist/$platform/$id",
      params: { platform: a.platform, id: encodeURIComponent(a.name) },
    });
  };

  const openAlbum = (a: Album): void => {
    void navigate({
      to: "/album/$platform/$id",
      params: { platform: a.platform, id: encodeURIComponent(a.name) },
    });
  };

  const empty =
    (tab === "song" && songs.length === 0) ||
    (tab === "playlist" && playlists.length === 0) ||
    (tab === "artist" && artists.length === 0) ||
    (tab === "album" && albums.length === 0);

  // 聚合模式下按源分组渲染（拍平后的整份列表作为播放队列上下文）
  const aggGroups =
    tab === "song" && aggregateMode && aggBatches !== null
      ? aggBatches.filter((b) => b.tracks.length > 0)
      : [];
  let aggOffset = 0;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="relative flex items-center gap-2 border-b border-border px-4 py-3">
        <BackButton />
        <Search className="h-4 w-4 text-muted-foreground" />
        <input
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value);
            setSuggestOpen(true);
          }}
          onFocus={() => setSuggestOpen(true)}
          onBlur={() => {
            // 延迟收起：给联想项的 mousedown 一拍时间先触发
            window.setTimeout(() => setSuggestOpen(false), 120);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit(keyword);
            if (e.key === "Escape") setSuggestOpen(false);
          }}
          placeholder="搜索歌曲 / 歌单 / 歌手 / 专辑"
          className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="button"
          onClick={() => submit(keyword)}
          disabled={searching || !keyword.trim()}
          className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {searching ? "搜索中…" : "搜索"}
        </button>

        {suggestOpen && suggestions.length > 0 && (
          <div className="absolute left-14 right-32 top-full z-20 mt-1 overflow-hidden rounded-lg border border-border bg-popover py-1 text-popover-foreground shadow-lg">
            {suggestions.map((w) => (
              <button
                key={w}
                type="button"
                // mousedown 抢在输入框 onBlur 之前完成填充，避免点击落空
                onMouseDown={(e) => {
                  e.preventDefault();
                  submit(w);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-secondary"
              >
                <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{w}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 border-b border-border px-4 py-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => switchTab(t.key)}
            className={`h-7 rounded-md px-3 text-xs transition-colors ${
              tab === t.key
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
        {tab === "song" && (
          <button
            type="button"
            onClick={() => setAggregateMode(!aggregateMode)}
            aria-pressed={aggregateMode}
            title="同时搜索全部音源，结果按源分组"
            className={`ml-auto flex h-7 items-center gap-1.5 rounded-md px-3 text-xs transition-colors ${
              aggregateMode
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            聚合搜索
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <div className="p-6 text-center text-sm text-destructive">
            搜索失败：{error}
          </div>
        )}
        {!error && searched && empty && !searching && (
          // 空状态给出口（UX 审查：No Results 不能是死胡同）
          <div className="flex flex-col items-center gap-2 py-14 text-center">
            <SearchX className="h-8 w-8 text-muted-foreground/50" aria-hidden />
            <p className="text-sm text-muted-foreground">没有找到相关内容</p>
            <p className="text-xs text-muted-foreground/70">
              换个关键词试试，或用标题栏切换音源再搜
            </p>
          </div>
        )}
        {!error && searching && empty && <TrackRowsSkeleton rows={6} />}

        {/* 落地页：搜索历史 + 热搜榜（只在还没搜过时展示） */}
        {!searched && !searching && (
          <SearchLanding
            history={history}
            hotWords={hotWords}
            onPick={submit}
            onRemoveHistory={removeHistory}
            onClearHistory={clearHistory}
          />
        )}

        {/* 聚合模式：按源分组，行上带源标 */}
        {!error && aggGroups.length > 0 &&
          aggGroups.map((batch) => {
            const start = aggOffset;
            aggOffset += batch.tracks.length;
            return (
              <div key={batch.source}>
                <div className="flex items-center gap-2 border-b border-border/60 bg-secondary/30 px-4 py-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    {sourceLabel(batch.source)}
                  </span>
                  <span className="text-[10px] text-muted-foreground/70">
                    {batch.tracks.length} 首
                  </span>
                </div>
                {batch.tracks.map((t, i) => (
                  <TrackRow
                    key={`${batch.source}-${t.id}-${i}`}
                    track={t}
                    active={currentTrackId === t.id}
                    badge={sourceLabel(batch.source)}
                    onPlay={() => void playQueue(songs, start + i)}
                  />
                ))}
              </div>
            );
          })}

        {/* 单源模式 */}
        {!error && !aggregateMode &&
          tab === "song" &&
          songs.map((t, i) => (
            <TrackRow
              key={`${t.id}-${i}`}
              track={t}
              active={currentTrackId === t.id}
              onPlay={() => void playQueue(songs, i)}
            />
          ))}

        {tab === "playlist" && playlists.length > 0 && (
          <div className="p-4">
            <CoverGrid>
              {playlists.map((p) => (
                <CoverCard
                  key={p.id}
                  name={p.name}
                  picUrl={p.picUrl}
                  subtitle={p.playCount ? `${p.playCount} 次播放` : undefined}
                  onClick={() =>
                    void navigate({
                      to: "/playlist/$platform/$id",
                      params: { platform: p.platform, id: p.id },
                    })
                  }
                />
              ))}
            </CoverGrid>
          </div>
        )}

        {tab === "artist" && artists.length > 0 && (
          <div className="p-4">
            <CoverGrid>
              {artists.map((a) => (
                <CoverCard
                  key={a.id}
                  name={a.name}
                  picUrl={a.picUrl}
                  onClick={() => openArtist(a)}
                />
              ))}
            </CoverGrid>
          </div>
        )}

        {tab === "album" && albums.length > 0 && (
          <div className="p-4">
            <CoverGrid>
              {albums.map((a) => (
                <CoverCard
                  key={a.id}
                  name={a.name}
                  picUrl={a.picUrl}
                  subtitle={a.artist}
                  onClick={() => openAlbum(a)}
                />
              ))}
            </CoverGrid>
          </div>
        )}
      </div>
    </div>
  );
}

/** 落地页：搜索历史（可删可清空）+ 当前音源热搜榜 */
function SearchLanding(props: {
  history: string[];
  hotWords: string[];
  onPick: (kw: string) => void;
  onRemoveHistory: (kw: string) => void;
  onClearHistory: () => void;
}): React.JSX.Element {
  return (
    <div className="mx-auto max-w-xl px-4 py-6">
      {props.history.length > 0 && (
        <section>
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium text-muted-foreground">搜索历史</h3>
            <button
              type="button"
              onClick={props.onClearHistory}
              className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              清空
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {props.history.map((kw) => (
              <span
                key={kw}
                className="group flex h-7 items-center gap-1 rounded-full bg-secondary/60 pl-3 pr-1.5 text-xs"
              >
                <button
                  type="button"
                  onClick={() => props.onPick(kw)}
                  className="max-w-40 truncate transition-colors hover:text-primary"
                  title={kw}
                >
                  {kw}
                </button>
                <button
                  type="button"
                  aria-label={`删除历史 ${kw}`}
                  onClick={() => props.onRemoveHistory(kw)}
                  className="rounded-full p-0.5 text-muted-foreground/60 transition-colors hover:bg-background hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        </section>
      )}

      {props.hotWords.length > 0 && (
        <section className="mt-6">
          <h3 className="text-xs font-medium text-muted-foreground">热搜榜</h3>
          <ol className="mt-2 grid grid-cols-2 gap-x-6">
            {props.hotWords.slice(0, 14).map((word, i) => (
              <li key={word}>
                <button
                  type="button"
                  onClick={() => props.onPick(word)}
                  className="flex w-full items-center gap-2.5 py-1.5 text-left text-sm transition-colors hover:text-primary"
                >
                  <span
                    className={`w-4 shrink-0 text-right text-xs tabular-nums ${
                      i < 3 ? "font-semibold text-primary" : "text-muted-foreground/60"
                    }`}
                  >
                    {i + 1}
                  </span>
                  <span className="truncate">{word}</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function TrackRow(props: {
  track: Track;
  active: boolean;
  /** 聚合模式下显示的源标（音源一/二/…） */
  badge?: string;
  onPlay: () => void;
}): React.JSX.Element {
  const { track, active, badge, onPlay } = props;
  const cover = qtresCoverUrl(track.picUrl);
  return (
    <button
      type="button"
      onClick={onPlay}
      className={`flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-secondary ${
        active ? "bg-secondary/60" : ""
      }`}
    >
      <span className="flex h-5 w-6 shrink-0 items-center justify-center text-muted-foreground">
        {active ? (
          <Play className="h-3 w-3 fill-current text-primary" aria-hidden />
        ) : null}
      </span>
      <div className="h-9 w-9 shrink-0 overflow-hidden rounded bg-secondary">
        {cover && (
          <img src={cover} alt="" className="h-full w-full object-cover" loading="lazy" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm">{track.title}</span>
          {badge && (
            <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {badge}
            </span>
          )}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {track.singer}
          {track.album ? ` · ${track.album}` : ""}
        </div>
      </div>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {track.duration > 0 ? formatTime(track.duration * 1000) : ""}
      </span>
    </button>
  );
}
