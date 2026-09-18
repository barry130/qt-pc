import { useCallback, useEffect, useState } from "react";
import { errMsg } from "@/lib/utils";
import { Play, Search, SearchX } from "lucide-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { Album, Artist, Playlist, Track } from "@/types";
import * as sourceApi from "@/source-scripts";
import { usePlayerStore } from "@/stores/player";
import { useMusicSourceStore } from "@/stores/musicSource";
import { qtresCoverUrl, formatTime } from "@/lib/lrc";
import { CoverCard, CoverGrid } from "./discovery/CoverCard";
import { TrackRowsSkeleton } from "./discovery/Skeletons";
import { BackButton } from "@/components/layout/BackButton";

/**
 * 搜索页（路由 /search?q=，DESIGN §5.2：关键字走 URL query，前进 / 后退可复现）。
 *
 * 四类结果对应脚本层四个动作（DESIGN §6.5）：
 * - 歌曲   searchMusic
 * - 歌单   searchPlaylists → 跳歌单详情
 * - 歌手   searchArtists   → 跳歌手详情
 * - 专辑   searchAlbums    → 跳专辑详情
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

  const [keyword, setKeyword] = useState(urlParams.q ?? "");
  const [tab, setTab] = useState<Tab>("song");
  const [songs, setSongs] = useState<Track[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [artists, setArtists] = useState<Artist[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const currentTrackId = usePlayerStore((s) => s.state?.trackId ?? null);

  const run = useCallback(
    async (kw: string, t: Tab): Promise<void> => {
      const trimmed = kw.trim();
      if (!trimmed) return;
      setSearching(true);
      setError(null);
      try {
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
      void navigate({ to: "/search", search: { q: trimmed } });
      void run(trimmed, tab);
    },
    [navigate, run, tab],
  );

  // URL q 变化（前进 / 后退 / 标题栏搜索框）或切换页签 → 触发搜索
  useEffect(() => {
    const q = urlParams.q?.trim() ?? "";
    if (q) void run(q, tab);
  }, [urlParams.q, tab, run]);

  const switchTab = (t: Tab): void => {
    setTab(t);
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

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <BackButton />
        <Search className="h-4 w-4 text-muted-foreground" />
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit(keyword);
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
      </div>

      <div className="flex gap-1 border-b border-border px-4 py-2">
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

        {tab === "song" &&
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

function TrackRow(props: {
  track: Track;
  active: boolean;
  onPlay: () => void;
}): React.JSX.Element {
  const { track, active, onPlay } = props;
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
        <div className="truncate text-sm">{track.title}</div>
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
