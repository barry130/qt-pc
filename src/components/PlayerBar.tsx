import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRightToLine,
  Captions,
  Check,
  Link2,
  ListMusic,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import type { PointerEvent as ReactPointerEvent } from "react";
import { usePlayerStore } from "@/stores/player";
import { useAuthStore, isAdmin } from "@/stores/auth";
import { CollectButton } from "@/components/player/CollectButton";
import { DownloadButton } from "@/components/mine/DownloadButton";
import { QUALITY_OPTIONS, qualityShort } from "@/lib/quality";
import type { Quality } from "@/types";
import { useInterpolatedPosition } from "@/hooks/useInterpolatedPosition";
import { formatTime, qtresCoverUrl } from "@/lib/lrc";
import { cn } from "@/lib/utils";
import {
  getDesktopLyricState,
  getPlaybackState,
  hideDesktopLyric,
  onLyricWindowChanged,
  setTrackQuality,
  showDesktopLyric,
} from "@/services/ipc";

/**
 * 播放条（DESIGN §5.5）：
 * 封面 / 歌名歌手 / 上一首 / 播放 / 下一首 / 模式 / 队列 / 进度条 / 音量
 * 进度拖动期间暂停插值（isDraggingProgress），松手即 seek */
export function PlayerBar(): React.JSX.Element {
  const state = usePlayerStore((s) => s.state);
  const toggle = usePlayerStore((s) => s.toggle);
  const seekTo = usePlayerStore((s) => s.seekTo);
  const setDragging = usePlayerStore((s) => s.setDragging);
  const nextTrack = usePlayerStore((s) => s.nextTrack);
  const prevTrack = usePlayerStore((s) => s.prevTrack);
  const cyclePlayMode = usePlayerStore((s) => s.cyclePlayMode);
  const position = useInterpolatedPosition();
  const navigate = useNavigate();
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [dragPreviewMs, setDragPreviewMs] = useState<number | null>(null);
  // 松手后到 seek 生效前的乐观目标（store 侧），优先于插值位置展示
  const pendingSeekMs = usePlayerStore((s) => s.pendingSeekMs);
  // 队列面板是布局级组件（挂在 AppShell 主区右侧），开关状态放 store 里共享
  const queueOpen = usePlayerStore((s) => s.queueOpen);
  const toggleQueue = usePlayerStore((s) => s.toggleQueue);

  const track = state?.track ?? null;
  const isPlayingPage = pathname === "/playing";
  const duration = state?.durationMs ?? 0;
  const playing = state?.status === "playing";
  const loading = state?.status === "loading" || state?.status === "buffering";
  const cover = track ? qtresCoverUrl(track.picUrl) : null;
  const shownPosition = dragPreviewMs ?? pendingSeekMs ?? position;
  // qt_admin 专属：播放地址调试入口只向内部账号展示
  const profile = useAuthStore((s) => s.profile);
  const showPlayUrl = isAdmin(profile);

  // 自愈：状态不是"停止"却拿不到曲目（事件丢失/覆盖的兜底）——
  // 主动拉一次实时快照，拿到曲目为止；正常时这个 effect 空转
  useEffect(() => {
    if (track || !state || state.status === "stopped") return;
    const timer = setTimeout(() => {
      void getPlaybackState()
        .then((s) => usePlayerStore.getState().applySnapshot(s))
        .catch(() => {});
    }, 800);
    return () => clearTimeout(timer);
  }, [track, state, state?.positionMs]);

  /**
   * 封面/歌名点击 = 播放页开关：第一次进播放页（歌词页）
   * 再点一次回退到来时的页面。back 只在历史里真有来路时用，
   * 否则（比如刚启动就点）退回发现页 */
  const togglePlayingPage = (): void => {
    if (pathname === "/playing") {
      if (router.history.canGoBack()) {
        router.history.back();
      } else {
        void navigate({ to: "/" });
      }
      return;
    }
    void navigate({ to: "/playing" });
  };

  const ratioFromEvent = (
    e: ReactPointerEvent<HTMLDivElement>,
  ): number | null => {
    const durationMs = usePlayerStore.getState().state?.durationMs ?? 0;
    if (durationMs <= 0) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    return ratio * durationMs;
  };

  const onBarDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      const ms = ratioFromEvent(e);
      if (ms === null) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
      setDragPreviewMs(ms);
    },
    [setDragging],
  );

  const onBarMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      if (!usePlayerStore.getState().isDraggingProgress) return;
      const ms = ratioFromEvent(e);
      if (ms !== null) setDragPreviewMs(ms);
    },
    [],
  );

  const onBarUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      if (!usePlayerStore.getState().isDraggingProgress) return;
      const ms = ratioFromEvent(e);
      setDragging(false);
      setDragPreviewMs(null);
      if (ms !== null) void seekTo(ms);
      e.currentTarget.releasePointerCapture(e.pointerId);
    },
    [seekTo, setDragging],
  );

  /** 拖动被系统取消（触屏滚动手势等）：收尾但不 seek，避免位置错跳 */
  const onBarCancel = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      if (!usePlayerStore.getState().isDraggingProgress) return;
      setDragging(false);
      setDragPreviewMs(null);
      e.currentTarget.releasePointerCapture(e.pointerId);
    },
    [setDragging],
  );

  return (
    <div
      className={cn(
        // z-20 不能省：播放条有 backdrop-blur，会自成层叠上下文，而它本身 z 是 auto；
        // 内容区是 `relative z-10`，层数更高的内容区会盖在播放条（连同它的弹窗）上面，
        // 于是向上弹的收藏 / 音质菜单被页面内容整个遮住，表现是「点了没反应」。
        // 与 TitleBar 的 z-20 同理（见 TitleBar.tsx 同位置注释）。
        "relative z-20 flex h-[80px] shrink-0 items-center gap-4 border-t backdrop-blur-xl px-4",
        isPlayingPage ? "" : "border-border bg-card/70",
      )}
      style={
        isPlayingPage
          ? {
              // 顶部略带封面色调 → 底部回到背景色，与页面渐变无缝衔接
              background:
                "linear-gradient(to bottom, color-mix(in srgb, var(--playing-cover-accent, var(--background)) 16%, var(--background)) 0%, color-mix(in srgb, var(--playing-cover-accent, var(--background)) 4%, var(--background)) 100%)",
              // 细分隔线用封面色调的极淡色，几乎隐入背景，只保留一点层次
              borderColor:
                "color-mix(in srgb, var(--playing-cover-accent, var(--border)) 20%, transparent)",
            }
          : undefined
      }
    >
      {/* 播放失败提示（REQUIREMENTS §3.1：重取仍失败时提示不可播放） */}
      {state?.status === "error" && state.error && (
        <div className="pointer-events-none absolute bottom-full left-1/2 mb-1 max-w-[60%] -translate-x-1/2 truncate rounded-md bg-destructive/10 px-3 py-1 text-xs text-destructive shadow">
          {state.error}
        </div>
      )}
      {/* 封面 + 歌名/歌手（点击打开/收起播放页） */}
      <button
        type="button"
        aria-label={pathname === "/playing" ? "返回之前页面" : "打开播放页"}
        onClick={togglePlayingPage}
        className="flex w-56 min-w-0 items-center gap-3 rounded-md text-left transition-colors hover:bg-secondary/60"
      >
        <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-secondary">
          {cover ? (
            <img
              src={cover}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            <span className="text-xs text-muted-foreground">无封面</span>
          )}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {track ? track.title : "未在播放"}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {track ? track.singer : "未知"}
          </div>
        </div>
      </button>

      {/* 控制 + 进度 */}
      <div className="flex min-w-0 flex-1 flex-col items-center gap-1">
        <div className="flex items-center gap-3">
          {/* qt_admin 专属：播放地址入口（图标按钮，点击展开当前实际播放地址） */}
          {showPlayUrl && <PlayUrlButton url={state?.playUrl ?? null} />}
          {/* 收藏：点开是本地歌单清单，勾上/取消即收藏/取消收藏 */}
          <CollectButton track={track} />
          <PlayModeButton mode={state?.playMode ?? "listLoop"} onCycle={() => void cyclePlayMode()} />
          <ControlButton label="上一首" onClick={() => void prevTrack()}>
            <SkipBack className="h-4 w-4" />
          </ControlButton>
          <button
            type="button"
            aria-label={playing ? "暂停" : "播放"}
            onClick={() => void toggle()}
            disabled={!track}
            className={cn(
              // 辉光颜色跟 --primary 走（color-mix 派生），换肤/换主色时不会留旧色残影
              "flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/80 text-primary-foreground shadow-[0_4px_14px_color-mix(in_srgb,var(--primary)_32%,transparent),0_2px_4px_rgba(0,0,0,0.12),inset_0_1px_2px_rgba(255,255,255,0.2)] transition-all hover:shadow-[0_6px_18px_color-mix(in_srgb,var(--primary)_42%,transparent),0_3px_6px_rgba(0,0,0,0.15),inset_0_1px_2px_rgba(255,255,255,0.25)] hover:scale-105 active:shadow-[inset_0_2px_6px_rgba(0,0,0,0.25)] disabled:cursor-not-allowed disabled:opacity-40",
              loading && "animate-pulse",
            )}
          >
            {playing ? (
              <Pause className="h-5 w-5" />
            ) : (
              <Play className="h-5 w-5 translate-x-0.5" />
            )}
          </button>
          <ControlButton label="下一首" onClick={() => void nextTrack()}>
            <SkipForward className="h-4 w-4" />
          </ControlButton>
          <DesktopLyricButton />
          <ControlButton
            label="播放队列"
            active={queueOpen}
            onClick={toggleQueue}
          >
            <ListMusic className="h-4 w-4" />
          </ControlButton>
          {track && <DownloadButton track={track} variant="icon" />}
          {track && track.platform !== "local" && (
            <QualityMenu current={state?.quality ?? "320"} />
          )}
        </div>

        {/* 进度条 */}
        <div className="flex w-full items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
          <span className="w-10 text-right">{formatTime(shownPosition)}</span>
          <div
            role="slider"
            aria-label="播放进度"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(shownPosition)}
            onPointerDown={onBarDown}
            onPointerMove={onBarMove}
            onPointerUp={onBarUp}
            onPointerCancel={onBarCancel}
            style={{ touchAction: "none" }}
            className="relative h-2 min-w-0 flex-1 cursor-pointer rounded-full bg-secondary/60"
          >
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-primary"
              style={{
                width:
                  duration > 0
                    ? `${Math.min(100, (shownPosition / duration) * 100)}%`
                    : "0%",
              }}
            />
          </div>
          <span className="w-10">{formatTime(duration)}</span>
        </div>
      </div>

      {/* 音量 */}
      <VolumeControl />
    </div>
  );
}

/** 桌面歌词开关（DESIGN §10）：初始读 Rust 状态，此后跟随 lyric-window-changed */
function DesktopLyricButton(): React.JSX.Element {
  const [on, setOn] = useState(false);

  useEffect(() => {
    let off: (() => void) | null = null;
    let disposed = false;
    void getDesktopLyricState()
      .then((s) => {
        if (!disposed) setOn(s.visible);
      })
      .catch(() => {});
    void onLyricWindowChanged((s) => setOn(s.visible)).then((u) => {
      if (disposed) u();
      else off = u;
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  return (
    <ControlButton
      label={on ? "关闭桌面歌词" : "开启桌面歌词"}
      active={on}
      onClick={() => void (on ? hideDesktopLyric() : showDesktopLyric()).then(
        (s) => setOn(s.visible),
      )}
    >
      <Captions className="h-4 w-4" />
    </ControlButton>
  );
}

/**
 * 音质入口（播放条）：只改**当前这首**，不写设置里的默认音质
 * —— 默认值在设置页改，换歌后自动回到默认。
 * 菜单向上弹（播放条贴在窗口底部）。
 */
function QualityMenu(props: { current: Quality }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // 点外面 / Esc 收起
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (q: Quality): void => {
    setOpen(false);
    if (q === props.current) return;
    setBusy(true);
    // 取址失败不会抛到这里，走 audio-error 事件 → 播放条自己提示
    void setTrackQuality(q).finally(() => setBusy(false));
  };

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        aria-label={`音质：${qualityShort(props.current)}（只对当前这首歌生效）`}
        title="音质（只对当前这首歌生效，默认音质在设置里改）"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-9 min-w-12 items-center justify-center rounded-full bg-secondary/40 px-2.5 text-xs font-medium tabular-nums transition-all hover:bg-secondary/60 disabled:opacity-50",
          props.current === "flac" ? "text-primary" : "text-foreground/80",
        )}
      >
        {qualityShort(props.current)}
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute bottom-full right-0 z-30 mb-2 w-32 overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {QUALITY_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitem"
              onClick={() => pick(o.value)}
              className={cn(
                "flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-xs transition-colors hover:bg-secondary",
                o.value === props.current ? "text-primary" : "",
              )}
            >
              <span>{o.label}</span>
              <span className="text-[10px] text-muted-foreground">{o.short}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 播放模式四态：顺序 → 列表循环 → 单曲循环 → 随机（REQUIREMENTS §3.2） */
function PlayModeButton(props: {
  mode: "sequence" | "listLoop" | "oneLoop" | "random";
  onCycle: () => void;
}): React.JSX.Element {
  const meta = {
    sequence: { label: "顺序播放", Icon: ArrowRightToLine },
    listLoop: { label: "列表循环", Icon: Repeat },
    oneLoop: { label: "单曲循环", Icon: Repeat1 },
    random: { label: "随机播放", Icon: Shuffle },
  }[props.mode];
  const { Icon, label } = meta;
  return (
    <ControlButton label={`播放模式：${label}`} onClick={props.onCycle} active={props.mode !== "listLoop"}>
      <Icon className="h-4 w-4" />
    </ControlButton>
  );
}

/**
 * 播放地址入口（qt_admin 专属）：图标按钮，点开向上弹面板展示**当前实际在播**
 * 的地址（换源兜底后指向真正在播的源），点地址即复制。
 * 与音质菜单同款：向上弹 + 点外面/Esc 收起。
 */
function PlayUrlButton(props: { url: string | null }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // 点外面 / Esc 收起
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 收起时把「已复制」复位，下次打开是干净状态
  useEffect(() => {
    if (!open) setCopied(false);
  }, [open]);

  const copy = (): void => {
    if (!props.url) return;
    void navigator.clipboard
      .writeText(props.url)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  };

  return (
    <div ref={boxRef} className="relative">
      <ControlButton
        label="播放地址（仅管理员）"
        active={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Link2 className="h-4 w-4" />
      </ControlButton>
      {open ? (
        <div className="absolute bottom-full left-1/2 z-30 mb-2 w-[420px] max-w-[70vw] -translate-x-1/2 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg">
          <div className="mb-1.5 text-[10px] text-muted-foreground">
            当前实际播放地址（换源后指向真正在播的源）
          </div>
          {props.url ? (
            <button
              type="button"
              onClick={copy}
              title="点击复制"
              className="block max-h-24 w-full overflow-y-auto break-all rounded-md bg-secondary/60 px-2 py-1.5 text-left font-mono text-[11px] leading-relaxed transition-colors hover:bg-secondary"
            >
              {props.url}
            </button>
          ) : (
            <div className="rounded-md bg-secondary/40 px-2 py-1.5 text-xs text-muted-foreground">
              本地曲目，或尚未取到播放地址
            </div>
          )}
          <div className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground">
            {copied ? (
              <>
                <Check className="h-3 w-3 text-primary" />
                已复制到剪贴板
              </>
            ) : (
              props.url ? "点击地址可复制" : ""
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ControlButton(props: {
  label: string;
  active?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      className={cn(
        "flex h-9 w-9 items-center justify-center rounded-full bg-secondary/40 shadow-[0_2px_4px rgba(0,0,0,0.1),0_4px_8px rgba(0,0,0,0.05)] transition-all hover:bg-secondary/60 hover:shadow-[0_3px_6px rgba(0,0,0,0.12),0_6px_12px rgba(0,0,0,0.06)] active:shadow-[inset_0_2px_4px rgba(0,0,0,0.12)] dark:bg-card/15 dark:shadow-[0_2px_4px rgba(0,0,0,0.3),0_4px_8px rgba(0,0,0,0.2)] dark:hover:shadow-[0_3px_6px rgba(0,0,0,0.4),0_6px_12px rgba(0,0,0,0.3)] dark:active:shadow-[inset_0_2px_4px rgba(0,0,0,0.4)]",
        props.active ? "text-primary" : "text-foreground/80",
      )}
    >
      {props.children}
    </button>
  );
}

function VolumeControl(): React.JSX.Element {
  const state = usePlayerStore((s) => s.state);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const toggleMute = usePlayerStore((s) => s.toggleMute);
  const volume = state?.volume ?? 0.8;
  const muted = state?.muted ?? false;

  return (
    <div className="flex w-32 items-center gap-2">
      <button
        type="button"
        aria-label={muted ? "取消静音" : "静音"}
        title={muted ? "取消静音" : "静音"}
        onClick={() => void toggleMute()}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        {muted || volume === 0 ? "🔇" : volume < 0.5 ? "🔉" : "🔊"}
      </button>
      <input
        type="range"
        aria-label="音量"
        min={0}
        max={1}
        step={0.01}
        value={muted ? 0 : volume}
        onChange={(e) => void setVolume(parseFloat(e.target.value))}
        className="h-1 w-full accent-[var(--primary)]"
      />
    </div>
  );
}