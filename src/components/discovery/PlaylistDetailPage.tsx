import { useEffect, useState } from "react";
import { errMsg } from "@/lib/utils";
import type { Playlist, SourceId } from "@/types";
import * as ipc from "@/services/ipc";
import { qtresCoverUrl } from "@/lib/lrc";
import { usePlayerStore } from "@/stores/player";
import { TrackList } from "./TrackList";
import { ErrorRetry, TrackRowsSkeleton } from "./Skeletons";
import { BackButton } from "@/components/layout/BackButton";

/**
 * 歌单详情（路由 /playlist/$platform/$id，DESIGN §5.2）。
 * 歌曲来自 get_playlist_detail（wyy/qq 一次取全量；kw 内部分页），
 * 「播放全部」把整张歌单入队并从第 1 首开始播（DESIGN §11.2）。
 */
export function PlaylistDetailPage(props: {
  platform: string;
  id: string;
}): React.JSX.Element {
  const { platform, id } = props;
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const playQueue = usePlayerStore((s) => s.playQueue);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const pl = await ipc.getPlaylistDetail(platform as SourceId, id, 1, 100);
        if (!cancelled) setPlaylist(pl);
      } catch (err) {
        if (!cancelled) setError(errMsg(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [platform, id, reload]);

  const [favorited, setFavorited] = useState(false);
  const [favoriteBusy, setFavoriteBusy] = useState(false);

  // 收藏状态。查不到就当没收藏，不挡住听歌
  useEffect(() => {
    let cancelled = false;
    void ipc
      .isPlaylistFavorited(platform, id)
      .then((v) => {
        if (!cancelled) setFavorited(v);
      })
      .catch(() => {
        if (!cancelled) setFavorited(false);
      });
    return () => {
      cancelled = true;
    };
  }, [platform, id]);

  const toggleFavorite = (): void => {
    if (favoriteBusy || !playlist) return;
    setFavoriteBusy(true);
    const next = !favorited;
    const call = next
      ? ipc.favoritePlaylist(
          platform,
          id,
          playlist.name,
          playlist.picUrl,
          playlist.playCount,
        )
      : ipc.unfavoritePlaylist(platform, id, playlist.name, playlist.picUrl);
    void call
      .then(() => setFavorited(next))
      .catch(() => {})
      .finally(() => setFavoriteBusy(false));
  };

  const tracks = playlist?.tracks ?? [];
  const cover = playlist ? qtresCoverUrl(playlist.picUrl) : "";

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="relative shrink-0 overflow-hidden border-b border-border">
        {/* 封面模糊铺底：封面本身当氛围背景，比纯色头好看，也不依赖取色算法 */}
        {cover ? (
          <>
            <img
              src={cover}
              alt=""
              aria-hidden
              draggable={false}
              className="absolute inset-0 h-full w-full scale-125 select-none object-cover opacity-45 blur-3xl saturate-150"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-background/10 to-background" />
          </>
        ) : null}

        <div className="relative flex items-center px-6 pt-5">
          <BackButton />
        </div>

        <div className="relative flex gap-5 px-6 pb-6 pt-4">
          <div className="h-36 w-36 shrink-0 overflow-hidden rounded-2xl bg-secondary shadow-xl ring-1 ring-border">
            {cover ? (
              <img src={cover} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-4xl font-bold text-muted-foreground/50">
                {(playlist?.name ?? "歌").slice(0, 1)}
              </span>
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col justify-end pb-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
              歌单
            </p>
            <h1 className="mt-1 truncate text-2xl font-bold tracking-tight">
              {playlist?.name ?? "歌单详情"}
            </h1>
            {/* 歌单详情不展示播放量：各音源口径不一（有的是累计播放、有的像 KG 直接给歌数），
                展示「共 N 首歌」更实在，也能反映实际拉取到的数量 */}
            {tracks.length > 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">共 {tracks.length} 首歌</p>
            ) : null}
            {playlist?.description ? (
              <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">
                {playlist.description}
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={tracks.length === 0}
                onClick={() => void playQueue(tracks, 0)}
                className="h-9 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/25 transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                播放全部
              </button>
              {playlist && (
                <button
                  type="button"
                  onClick={toggleFavorite}
                  disabled={favoriteBusy}
                  className="h-9 rounded-lg border border-border px-5 text-sm transition-colors hover:bg-secondary disabled:opacity-50"
                >
                  {favorited ? "已收藏" : "收藏"}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <TrackRowsSkeleton rows={10} />
        ) : error ? (
          <ErrorRetry message={`加载失败：${error}`} onRetry={() => setReload((r) => r + 1)} />
        ) : (
          <TrackList tracks={tracks} showAddToPlaylist showDownload />
        )}
      </div>
    </div>
  );
}
