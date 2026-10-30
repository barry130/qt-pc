import { memo, useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import {
  ListMusic,
  Loader2,
  Maximize2,
  Music,
  Pause,
  Play,
  SkipBack,
  SkipForward,
} from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { Track } from "@/types";
import { usePlayerStore } from "@/stores/player";
import { usePlaybackEvents } from "@/hooks/usePlaybackEvents";
import { useInterpolatedPosition } from "@/hooks/useInterpolatedPosition";
import { useAppearanceEffect } from "@/hooks/useAppearanceEffect";
import { formatTime } from "@/lib/lrc";
import { useNowPlayingCover } from "@/hooks/useNowPlayingLocalMedia";
import { toggleMiniPlayer } from "@/services/ipc";
import { cn } from "@/lib/utils";
import { log } from "@/lib/logger";

/**
 * 迷你播放器窗口（REQUIREMENTS §3.21.7.2 / DESIGN §4.3）。
 *
 * 独立窗口（label = MINI_WINDOW_LABEL），复用同一份前端 bundle：App.tsx 按
 * 窗口 label 分流到本组件，主窗口那套路由不参与。
 *
 * 与主窗的分工：播放真值始终在 Rust 引擎、经事件广播到所有窗口，本组件只是
 * 另一个订阅者（usePlaybackEvents + usePlayerStore），不持有任何播放状态。
 * 「主窗 ↔ 迷你窗」互切由 Rust 的 toggle_mini_player 一次做完（顺带收起/唤回
 * 主窗），前端拿到的回执只用于日志与按钮态。
 *
 * 高度：条状 92、展开队列 340（与 Rust mini_window.rs 的 MINI_BAR_HEIGHT /
 * MINI_EXPANDED_HEIGHT 对齐；窗口本身 resizable(false)，改高度只在这里做）。
 */
const MINI_WIDTH = 440;
const BAR_HEIGHT = 92;
const EXPANDED_HEIGHT = 340;

export function MiniPlayer(): React.JSX.Element {
  // 迷你窗只订阅事件、拉一次实时快照：restoreSession 传 false —— 迷你窗总是
  // 在主窗之后打开，此时引擎早已在播，再「恢复上次现场」会把它拉回启动快照。
  usePlaybackEvents({ restoreSession: false });
  // 迷你窗是独立 React 根，主窗口那套外观 effect 不在这里：自己挂一次，
  // 深色模式 / 皮肤主色 / 字体缩放才与主窗一致（否则小窗永远浅色）
  useAppearanceEffect();
  const track = usePlayerStore((s) => s.state?.track ?? null);
  const status = usePlayerStore((s) => s.state?.status ?? "stopped");
  const durationMs = usePlayerStore((s) => s.durationMs);
  const queue = usePlayerStore((s) => s.queue);
  const queueIndex = usePlayerStore((s) => s.queueIndex);
  const toggle = usePlayerStore((s) => s.toggle);
  const nextTrack = usePlayerStore((s) => s.nextTrack);
  const prevTrack = usePlayerStore((s) => s.prevTrack);
  const seekTo = usePlayerStore((s) => s.seekTo);
  const playAt = usePlayerStore((s) => s.playAt);
  const position = useInterpolatedPosition();
  const [queueOpen, setQueueOpen] = useState(false);

  const playing = status === "playing";
  const loading = status === "loading" || status === "buffering";
  // 在播封面：内嵌优先、在线兜底（本地优先命中时播的是磁盘文件）
  const cover = useNowPlayingCover();
  const ratio =
    durationMs > 0 ? Math.min(1, Math.max(0, position / durationMs)) : 0;

  // 队列展开/收起时改窗口高度（逻辑像素：与建窗时的 inner_size 同一单位）
  useEffect(() => {
    const win = getCurrentWindow();
    void win
      .setSize(new LogicalSize(MINI_WIDTH, queueOpen ? EXPANDED_HEIGHT : BAR_HEIGHT))
      .catch((err: unknown) => {
        // 改高度失败不影响播放，条状布局照常可用（队列区会被裁掉，收起即可）
        log.warn("mini setSize failed", err);
      });
  }, [queueOpen]);

  // 透明窗口：html/body 只要带背景色，圆角外就会露出白/黑的方角。
  // 与桌面歌词同一手法——挂载期间清掉背景，卸载时还原。
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prevHtml = html.style.background;
    const prevBody = body.style.background;
    html.style.background = "transparent";
    body.style.background = "transparent";
    return () => {
      html.style.background = prevHtml;
      body.style.background = prevBody;
    };
  }, []);

  // 无边框窗拖动：整条可拖，交互控件自行 stopPropagation
  const startDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    void getCurrentWindow()
      .startDragging()
      .catch((err: unknown) => {
        log.warn("startDragging failed", err);
      });
  }, []);

  const seekByClick = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      e.stopPropagation();
      if (durationMs <= 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width <= 0) return;
      const p = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      void seekTo(Math.round(p * durationMs)).catch(() => {});
    },
    [durationMs, seekTo],
  );

  const back = useCallback((): void => {
    // Rust 侧收起迷你窗并唤回主窗
    void toggleMiniPlayer().catch((err: unknown) => {
      log.warn("toggleMiniPlayer failed", err);
    });
  }, []);

  const stop = (e: ReactPointerEvent): void => e.stopPropagation();

  // 队列行点击：身份稳定回调（playAt 来自 store，本身恒定），配合行组件的
  // memo——播放进度每 ~100ms 推一次重渲染，队列行不再跟着整批重画。
  const handlePlayAt = useCallback(
    (index: number): void => {
      void playAt(index).catch(() => {});
    },
    [playAt],
  );

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden rounded-xl border border-border/60 bg-card text-foreground shadow-raised">
      {/* 条状主区：封面 / 歌名歌手 / 基础控制 */}
      <div
        onPointerDown={startDrag}
        className="flex h-[92px] shrink-0 cursor-default items-center gap-3 px-3"
      >
        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-secondary/60">
          {cover ? (
            <img src={cover} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-muted-foreground">
              <Music className="h-5 w-5" />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={track?.title ?? ""}>
            {track?.title ?? "未在播放"}
          </div>
          <div className="truncate text-xs text-muted-foreground" title={track?.singer ?? ""}>
            {track?.singer ?? "—"}
          </div>
          <div
            onPointerDown={seekByClick}
            className="group mt-1.5 flex h-3 cursor-pointer items-center gap-2"
          >
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-fast"
                style={{ width: `${ratio * 100}%` }}
              />
            </div>
            <span className="shrink-0 text-3xs tabular-nums text-muted-foreground">
              {formatTime(position)} / {formatTime(durationMs)}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5" onPointerDown={stop}>
          <MiniBtn label="上一首" onClick={() => void prevTrack().catch(() => {})}>
            <SkipBack className="h-4 w-4" />
          </MiniBtn>
          <MiniBtn
            label={playing ? "暂停" : "播放"}
            primary
            onClick={() => void toggle().catch(() => {})}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : playing ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
          </MiniBtn>
          <MiniBtn label="下一首" onClick={() => void nextTrack().catch(() => {})}>
            <SkipForward className="h-4 w-4" />
          </MiniBtn>
          <MiniBtn
            label={queueOpen ? "收起播放队列" : "展开播放队列（简化）"}
            active={queueOpen}
            onClick={() => setQueueOpen((v) => !v)}
          >
            <ListMusic className="h-4 w-4" />
          </MiniBtn>
          <MiniBtn label="返回主窗口" onClick={back}>
            <Maximize2 className="h-4 w-4" />
          </MiniBtn>
        </div>
      </div>

      {/* 简化队列（DESIGN §4.3「队列：提供简化队列入口」） */}
      {queueOpen ? (
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border/60 px-2 py-1">
          {queue.length === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              队列为空
            </div>
          ) : (
            queue.map((t, i) => (
              <MiniQueueRow
                key={`${t.platform}:${t.id}:${i}`}
                track={t}
                index={i}
                current={i === queueIndex}
                onPlayAt={handlePlayAt}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 迷你窗队列行。memo + 稳定 onPlayAt：迷你窗的进度条跟 position 每 ~100ms
 * 重渲染一次，队列行只在「换歌（track 变）/ 播放行切换（current 变）」时重画。
 */
const MiniQueueRow = memo(function MiniQueueRow(props: {
  track: Track;
  index: number;
  current: boolean;
  onPlayAt: (index: number) => void;
}): React.JSX.Element {
  const { track, index, current, onPlayAt } = props;
  return (
    <button
      type="button"
      onClick={() => onPlayAt(index)}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors",
        current
          ? "bg-primary/15 text-foreground"
          : "text-foreground/70 hover:bg-secondary/50",
      )}
      title={`${track.title} - ${track.singer}`}
    >
      <span className="w-5 shrink-0 text-center tabular-nums text-muted-foreground">
        {index + 1}
      </span>
      <span className="min-w-0 flex-1 truncate">{track.title}</span>
      <span className="shrink-0 truncate text-muted-foreground">{track.singer}</span>
    </button>
  );
});

function MiniBtn(props: {
  label: string;
  primary?: boolean;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.active}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={props.onClick}
      className={cn(
        "flex items-center justify-center rounded-full transition-colors",
        props.primary ? "h-8 w-8" : "h-7 w-7",
        props.active === true
          ? "bg-primary/20 text-primary"
          : "text-foreground/80 hover:bg-secondary/60 hover:text-foreground",
        props.primary && props.active !== true && "bg-primary text-primary-foreground",
      )}
    >
      {props.children}
    </button>
  );
}
