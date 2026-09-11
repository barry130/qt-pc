import { useNavigate } from "@tanstack/react-router";
import type { Track } from "@/types";
import { qtresCoverUrl, formatTime } from "@/lib/lrc";
import { usePlayerStore } from "@/stores/player";
import { AddToPlaylistButton } from "../mine/AddToPlaylistButton";
import { DownloadButton } from "../mine/DownloadButton";

/**
 * 曲目列表（发现类页面共用：榜单详情 / 歌单详情 / 新歌速递 / 收藏 / 历史）。
 * 点击整行走 `playQueue(tracks, i)`，把当前列表整体入队并从该首开始播放
 * （DESIGN §11.2：列表播放语义，而不是单曲替换队列）。
 *
 * 传了 `onRemove` 时每行右侧出现「移除」按钮（收藏、我的歌单等可编辑列表用）；
 * 为此行容器用 `div[role=button]` 而非 `button`，避免按钮嵌套。
 */
export function TrackList(props: {
  tracks: Track[];
  /** 是否显示 1/2/3 序号（榜单详情用；歌单/新歌用播放态图标） */
  showIndex?: boolean;
  /** 传入后每行右侧出现「移除」按钮 */
  onRemove?: (track: Track) => void;
  /** 为 true 时每行右侧出现「＋歌单」（加入我的歌单） */
  showAddToPlaylist?: boolean;
  /** 为 true 时每行右侧出现「下载」 */
  showDownload?: boolean;
}): React.JSX.Element {
  const {
    tracks,
    showIndex = false,
    onRemove,
    showAddToPlaylist = false,
    showDownload = false,
  } = props;
  const playQueue = usePlayerStore((s) => s.playQueue);
  const navigate = useNavigate();
  const currentTrackId = usePlayerStore((s) => s.state?.trackId ?? null);

  if (tracks.length === 0) {
    return (
      <div className="px-4 py-10 text-center text-sm text-muted-foreground">
        暂无歌曲
      </div>
    );
  }

  return (
    <div>
      {tracks.map((t, i) => {
        const active = currentTrackId === t.id;
        const cover = qtresCoverUrl(t.picUrl);
        return (
          <div
            key={`${t.id}-${i}`}
            role="button"
            tabIndex={0}
            onClick={() => void playQueue(tracks, i)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                void playQueue(tracks, i);
              }
            }}
            className={`flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-secondary ${
              active ? "bg-secondary/60" : ""
            }`}
          >
            <span className="flex h-5 w-6 shrink-0 items-center justify-center text-xs tabular-nums text-muted-foreground">
              {showIndex ? (
                i + 1
              ) : active ? (
                // 正在播放：三根跳动的均衡条（样式见 index.css .eq-bar）
                <span className="flex h-3 items-end gap-[2px]" aria-label="正在播放">
                  <span className="eq-bar" />
                  <span className="eq-bar" />
                  <span className="eq-bar" />
                </span>
              ) : (
                ""
              )}
            </span>
            <div className="h-9 w-9 shrink-0 overflow-hidden rounded bg-secondary">
              {cover ? (
                <img
                  src={cover}
                  alt=""
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              ) : null}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{t.title}</div>
              <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                {/* 歌手 / 专辑可点进对应页面（音源没有按 id 的接口，用名字搜索闭环）。
                    本地曲目不走在线搜索，退化成纯文本。 */}
                {t.singer ? (
                  t.platform === "local" ? (
                    <span className="truncate">{t.singer}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void navigate({
                          to: "/artist/$platform/$id",
                          params: {
                            platform: t.platform,
                            id: encodeURIComponent(t.singer),
                          },
                        });
                      }}
                      className="truncate transition-colors hover:text-foreground hover:underline"
                    >
                      {t.singer}
                    </button>
                  )
                ) : null}
                {t.album ? (
                  <>
                    <span className="shrink-0">·</span>
                    {t.platform === "local" ? (
                      <span className="truncate">{t.album}</span>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void navigate({
                            to: "/album/$platform/$id",
                            params: {
                              platform: t.platform,
                              id: encodeURIComponent(t.album),
                            },
                          });
                        }}
                        className="truncate transition-colors hover:text-foreground hover:underline"
                      >
                        {t.album}
                      </button>
                    )}
                  </>
                ) : null}
              </div>
            </div>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {t.duration > 0 ? formatTime(t.duration * 1000) : ""}
            </span>
            {showDownload && <DownloadButton track={t} />}
            {showAddToPlaylist && <AddToPlaylistButton track={t} />}
            {onRemove ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(t);
                }}
                className="ml-2 shrink-0 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-destructive"
              >
                移除
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
