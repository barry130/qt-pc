import { memo, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ListEnd, Play } from "lucide-react";
import type { Track } from "@/types";
import { qtresCoverUrl, formatTime } from "@/lib/lrc";
import { usePlayerStore } from "@/stores/player";
import { trackDbId, useDownloadsStore } from "@/stores/downloads";
import * as ipc from "@/services/ipc";
import { AddToPlaylistButton } from "../mine/AddToPlaylistButton";
import { DownloadButton } from "../mine/DownloadButton";
import { LocalCover } from "../library/LocalCover";
import { RowActions } from "../common/RowActions";

/**
 * 曲目列表（发现类页面共用：榜单详情 / 歌单详情 / 新歌速递 / 收藏 / 历史 / 本地）。
 * 点击整行走 `playQueue(tracks, i)`，把当前列表整体入队并从该首开始播放
 * （DESIGN §11.2：列表播放语义，而不是单曲替换队列）。
 *
 * 传了 `onRemove` 时每行右侧出现「移除」按钮（收藏、我的歌单等可编辑列表用）；
 * 为此行容器用 `div[role=button]` 而非 `button`，避免按钮嵌套。
 *
 * 队列 2.0：悬停行会露出「下一首播放」「加入队列」；已下载的曲目带「已下载」标。
 * 本地曲库页传 `local` 进入本地模式：悬停按钮用「播放」代替「下一首播放」，
 * 行尾出现「在文件夹中显示 / 删除」，需要时可带行首复选框做批量选择。
 *
 * 性能（长列表）：行拆成 `memo` 的 `TrackRow`，且列表层只把**标量**传下去
 * （active/downloaded/…），因此：
 *   - 切歌只重渲染「旧行 + 新行」两行，而不是整张列表；
 *   - 下载进度刷新（`active`/`downloaded` 变化）不再牵动整个列表；
 *   - 行上还有 `.cv-row`（content-visibility: auto）让视口外的行跳过布局/绘制。
 * 本地曲库几千首时，这一层就是"文件越多越卡"的主因，改的都是渲染路径，
 * DOM 结构与交互语义逐字未变。
 */
export interface LocalListOptions {
  /** 定位 / 删除成功后通知父级重载列表 */
  onChanged: () => void;
  /** 操作失败提示 */
  onError: (msg: string) => void;
  /** 批量选择状态；省略则不显示行首复选框 */
  selection?: {
    ids: Set<string>;
    onToggle: (trackId: string) => void;
  };
  /**
   * 行模板对齐「下载管理」：不显示行首封面缩略图，也不显示「已下载 / 下载中」标记。
   * 本地曲库页专用 —— 本地行本身就是磁盘上的文件，「已下载」恒为真、纯噪声，
   * 封面缩略图在这一屏也没有信息量（专辑分组视图已用分组标题表达）。
   */
  plainRow?: boolean;
}

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
  /**
   * 批量选择（对**所有行**生效）：传入后每行行首出现复选框，
   * 歌单详情等混合列表的批量管理用。`local.selection` 是旧入口，仅本地曲库页继续沿用。
   */
  selection?: {
    ids: Set<string>;
    onToggle: (trackId: string) => void;
  };
  /**
   * 本地行专属配置（plainRow / onChanged / onError 只对 `platform === "local"` 的行生效）。
   */
  local?: LocalListOptions;
}): React.JSX.Element {
  const {
    tracks,
    showIndex = false,
    onRemove,
    showAddToPlaylist = false,
    showDownload = false,
    selection: selectionProp,
    local,
  } = props;
  const selection = selectionProp ?? local?.selection;
  // 本地曲库页的朴素行：无封面、无下载标记（对齐下载管理的行模板）
  const plainRow = local?.plainRow === true;
  const playQueue = usePlayerStore((s) => s.playQueue);
  const currentTrackId = usePlayerStore((s) => s.state?.trackId ?? null);
  const downloaded = useDownloadsStore((s) => s.downloaded);
  const active = useDownloadsStore((s) => s.active);

  /**
   * 回调放 ref、只暴露 `useCallback` 包出来的稳定引用：调用方（各页面）几乎都在
   * 渲染期现造箭头函数（`onRemove={(t) => void remove(t)}`），直接透传会让
   * `memo` 每次都失效，等于白 memo。ref 在提交后同步（点击必然晚于提交），
   * 所以行为与直接调用调用方回调完全一致。
   */
  const latest = useRef({
    onRemove,
    onToggle: selection?.onToggle,
    onChanged: local?.onChanged,
    onError: local?.onError,
  });
  useEffect(() => {
    latest.current = {
      onRemove,
      onToggle: selection?.onToggle,
      onChanged: local?.onChanged,
      onError: local?.onError,
    };
  });
  const handleRemove = useCallback((t: Track) => latest.current.onRemove?.(t), []);
  const handleToggle = useCallback((id: string) => latest.current.onToggle?.(id), []);
  const handleChanged = useCallback(() => latest.current.onChanged?.(), []);
  const handleError = useCallback((msg: string) => latest.current.onError?.(msg), []);

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
        const dbId = trackDbId(t);
        const isDownloaded = downloaded.has(dbId);
        return (
          <TrackRow
            key={`${t.id}-${i}`}
            track={t}
            index={i}
            tracks={tracks}
            active={currentTrackId === t.id}
            downloaded={isDownloaded}
            downloading={!isDownloaded && active.has(dbId)}
            showIndex={showIndex}
            plainRow={plainRow}
            // 本地行：悬停按钮换成「播放」，行尾带定位 / 删除
            localRow={local !== undefined && t.platform === "local"}
            showAddToPlaylist={showAddToPlaylist}
            showDownload={showDownload}
            selectionIds={selection?.ids}
            onToggleSelect={handleToggle}
            // 注意：onRemove 传下去的是**稳定化的包装函数**（恒为函数），
            // 是否需要「移除」按钮必须由这个布尔决定，不能判 onRemove 是否存在
            showRemove={onRemove !== undefined}
            onRemove={handleRemove}
            onChanged={handleChanged}
            onError={handleError}
            playQueue={playQueue}
          />
        );
      })}
    </div>
  );
}

interface TrackRowProps {
  track: Track;
  index: number;
  /** 整个列表（点击整行 = 从这首起播放当前列表）；引用在列表变化前保持稳定 */
  tracks: Track[];
  active: boolean;
  downloaded: boolean;
  downloading: boolean;
  showIndex: boolean;
  plainRow: boolean;
  localRow: boolean;
  showAddToPlaylist: boolean;
  showDownload: boolean;
  /** 批量选择集合；省略则不显示复选框 */
  selectionIds?: Set<string>;
  onToggleSelect: (trackId: string) => void;
  showRemove: boolean;
  onRemove: (track: Track) => void;
  onChanged: () => void;
  onError: (msg: string) => void;
  playQueue: (tracks: Track[], index: number) => Promise<void> | void;
}

const TrackRow = memo(function TrackRow(props: TrackRowProps): React.JSX.Element {
  const {
    track: t,
    index: i,
    tracks,
    active: activeRow,
    downloaded: isDownloaded,
    downloading: isDownloading,
    showIndex,
    plainRow,
    localRow,
    showAddToPlaylist,
    showDownload,
    selectionIds,
    onToggleSelect,
    showRemove,
    onRemove,
    onChanged,
    onError,
    playQueue,
  } = props;
  const navigate = useNavigate();
  const cover = qtresCoverUrl(t.picUrl);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => void playQueue(tracks, i)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void playQueue(tracks, i);
        }
      }}
      className={`cv-row group flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-secondary ${
        activeRow ? "bg-secondary/60" : ""
      }`}
    >
      {/* 左侧固定槽位：批量选择时放复选框，否则放序号 / 播放态均衡条。
          复选框放在槽位里（而不是另起一列），否则槽位空着还要多占一份
          行间距，复选框到歌名会拉开近 50px。 */}
      <span className="flex h-5 w-6 shrink-0 items-center justify-center text-xs tabular-nums text-muted-foreground">
        {selectionIds ? (
          <input
            type="checkbox"
            checked={selectionIds.has(t.id)}
            aria-label={`选择 ${t.title}`}
            onClick={(e) => e.stopPropagation()}
            onChange={() => onToggleSelect(t.id)}
            className="h-3.5 w-3.5 accent-primary"
          />
        ) : showIndex ? (
          i + 1
        ) : activeRow ? (
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
      {!plainRow && (
        <div className="h-9 w-9 shrink-0 overflow-hidden rounded bg-secondary">
          {t.platform === "local" ? (
            <LocalCover path={t.id} className="h-full w-full object-cover" />
          ) : cover ? (
            <img src={cover} alt="" className="h-full w-full object-cover" loading="lazy" />
          ) : null}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm">{t.title}</span>
          {!plainRow && isDownloaded && (
            <span className="shrink-0 rounded bg-primary/15 px-1 py-px text-[10px] text-primary">
              已下载
            </span>
          )}
          {!plainRow && isDownloading && (
            <span className="shrink-0 rounded bg-secondary px-1 py-px text-[10px] text-muted-foreground">
              下载中
            </span>
          )}
        </div>
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
      {/* 悬停露出队列操作：下一首播放 / 加入队尾（不打断当前播放）；
          本地模式第一个按钮改为「播放」，语义同点击整行（从这首起播当前列表） */}
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          title={localRow ? "播放" : "下一首播放"}
          aria-label={localRow ? "播放" : "下一首播放"}
          onClick={(e) => {
            e.stopPropagation();
            if (localRow) {
              void playQueue(tracks, i);
            } else {
              void ipc.queueAddNext(t);
            }
          }}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
        >
          <Play className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="加入播放队列"
          aria-label="加入播放队列"
          onClick={(e) => {
            e.stopPropagation();
            void ipc.queueAppend([t]);
          }}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
        >
          <ListEnd className="h-3.5 w-3.5" />
        </button>
      </div>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {t.duration > 0 ? formatTime(t.duration * 1000) : ""}
      </span>
      {localRow && (
        <RowActions
          onReveal={() => ipc.revealLocalTrack(t.id)}
          onDelete={async (deleteFile) => {
            await ipc.deleteLocalTrack(t.id, deleteFile);
            onChanged();
          }}
          onError={onError}
        />
      )}
      {showDownload && <DownloadButton track={t} />}
      {showAddToPlaylist && <AddToPlaylistButton track={t} />}
      {showRemove ? (
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
});
