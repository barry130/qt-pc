import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRightToLine,
  AudioWaveform,
  Captions,
  Check,
  Link2,
  ListMusic,
  Music,
  Pause,
  Play,
  RefreshCw,
  Repeat,
  Repeat1,
  Share2,
  Shuffle,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  ThumbsDown,
  Timer,
  User,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { listen } from "@tauri-apps/api/event";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { usePlayerStore } from "@/stores/player";
import { useAuthStore, isAdmin } from "@/stores/auth";
import { useDislikesStore } from "@/stores/dislikes";
import { CollectButton } from "@/components/player/CollectButton";
import { DownloadButton } from "@/components/mine/DownloadButton";
import {
  replaceCurrentWithCandidate,
  SourceSwitchPanel,
} from "@/components/player/SourceSwitchPanel";
import { ShareCardPanel } from "@/components/player/ShareCardPanel";
import { qualityOptionsFromRegistry } from "@/lib/quality";
import { PLAYER_BAR_BUTTONS, splitPlayerBarButtons } from "@/lib/player-bar";
import { useSourceQualities } from "@/stores/sourceRegistry";
import { usePlayerBarStore } from "@/stores/playerBar";
import { useDismissOnOutside } from "@/hooks/useDismissOnOutside";
import { SPEED_OPTIONS, speedLabel } from "@/lib/fx";
import type { Quality, Track } from "@/types";
import { useInterpolatedPosition } from "@/hooks/useInterpolatedPosition";
import { formatTime, qtresCoverUrl } from "@/lib/lrc";
import { playUrlLine, playUrlMiss } from "@/source-scripts/playurl-line";
import { cn } from "@/lib/utils";
import {
  checkDisliked,
  getDesktopLyricState,
  getFxState,
  getPlaybackState,
  hideDesktopLyric,
  onLyricWindowChanged,
  setSleepTimer,
  setSpectrum,
  setSpeed,
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
  // 拖动进度条期间拖块常显（hover 才浮现的互补态）
  const isDraggingProgress = usePlayerStore((s) => s.isDraggingProgress);

  const track = state?.track ?? null;
  const isPlayingPage = pathname === "/playing";
  // 时长是高频字段（tick 里每 250ms 带一次），单独订阅标量：
  // 订整个 state 会让整棵播放条跟着 tick 重渲染（见 stores/player.ts 的说明）
  const duration = usePlayerStore((s) => s.durationMs);
  const playing = state?.status === "playing";
  const loading = state?.status === "loading" || state?.status === "buffering";
  const cover = track ? qtresCoverUrl(track.picUrl) : null;
  const shownPosition = dragPreviewMs ?? pendingSeekMs ?? position;
  // qt_admin 专属：播放地址调试入口只向内部账号展示
  const profile = useAuthStore((s) => s.profile);
  const showPlayUrl = isAdmin(profile);

  // 播放条按钮开关（设置 → 播放条）：只存「展示中的按钮 id」（见 lib/player-bar.ts），
  // 名额上限（非音量 ≤10）在 store.toggle 里把守；按钮行为一律不变
  const visibleButtons = usePlayerBarStore((s) => s.visible);
  const loadBarButtons = usePlayerBarStore((s) => s.load);
  useEffect(() => {
    void loadBarButtons();
  }, [loadBarButtons]);
  const visibleBarIds = useMemo(() => {
    return PLAYER_BAR_BUTTONS.filter((meta) => {
      if (meta.adminOnly && !showPlayUrl) return false;
      return visibleButtons.includes(meta.id);
    }).map((meta) => meta.id);
    // 注意：这里**不**看有没有曲目 / 是不是本地音乐（倍速、下载、音质在那些
    // 情况下不渲染）。左右分列按配置算，位置只随开关变化；若跟着瞬时状态算，
    // 每次开播/停播都会让播放模式这类按钮在左右之间跳一次。
  }, [visibleButtons, showPlayUrl]);
  const { left: leftBarButtons, right: rightBarButtons } = useMemo(
    () => splitPlayerBarButtons(visibleBarIds),
    [visibleBarIds],
  );

  /**
   * 播放条上的可配置按钮：key 用按钮 id（左右两组各自 map，需要稳定 key）。
   * 条件渲染与 lib/player-bar.ts 里 visibleBarIds 的判断保持一致。
   */
  const renderBarButton = (id: string): React.ReactNode => {
    switch (id) {
      case "playUrl":
        return (
          <PlayUrlButton
            key="playUrl"
            url={state?.playUrl ?? null}
            line={playUrlLine(track, state?.quality ?? null)}
            miss={playUrlMiss(track, state?.quality ?? null)}
          />
        );
      // 倍速：放在收藏左边（用户习惯位）；菜单向上弹出
      case "speed":
        return track ? <SpeedMenu key="speed" current={state?.speed ?? 1} /> : null;
      // 睡眠定时：倍速与收藏之间（用户习惯位）
      case "sleep":
        return (
          <SleepTimerMenu
            key="sleep"
            remainingMs={state?.sleepTimerMs ?? null}
            afterTrack={state?.sleepAfterTrack ?? false}
          />
        );
      // 收藏：点开是本地歌单清单，勾上/取消即收藏/取消收藏
      case "collect":
        return <CollectButton key="collect" track={track} />;
      case "mode":
        return (
          <PlayModeButton
            key="mode"
            mode={state?.playMode ?? "listLoop"}
            onCycle={() => void cyclePlayMode()}
          />
        );
      case "desktopLyric":
        return <DesktopLyricButton key="desktopLyric" />;
      case "queue":
        // emphasis：展开态和「桌面歌词」开启态同一套点亮（用户 m04741 口径：
        // 「我要和左边桌面歌词打开后效果一样就行」）。队列面板本身在右侧，
        // 按钮点亮是让用户一眼看出「队列正开着」。
        //
        // 播放页禁用（用户 m04913）：QueuePanel 是 AppShell 主区里的布局级面板，
        // 而播放页走 isPlayingPage 分支根本不渲染它 —— 在那儿点这个按钮只会有
        // 一个亮起来的图标、面板永远不出现，等同于坏按钮，故直接置灰不可点。
        return (
          <ControlButton
            key="queue"
            label={isPlayingPage ? "播放队列（播放页不可用）" : "播放队列"}
            active={queueOpen}
            emphasis={!isPlayingPage}
            disabled={isPlayingPage}
            onClick={toggleQueue}
          >
            <ListMusic className="h-4 w-4" />
          </ControlButton>
        );
      case "download":
        return track ? <DownloadButton key="download" track={track} variant="icon" /> : null;
      case "quality":
        return track && track.platform !== "local" ? (
          <QualityMenu key="quality" current={state?.quality ?? "320"} platform={track.platform} />
        ) : null;
      // 屏蔽（不喜欢）：点一下屏蔽这首歌（Alt+点击屏蔽歌手），已屏蔽时变成取消屏蔽
      case "dislike":
        return track ? <DislikeButton key="dislike" track={track} /> : null;
      // 频谱背景开关：与设置页频谱开关同一个引擎侧后端（setSpectrum）
      case "spectrum":
        return <SpectrumButton key="spectrum" />;
      // 均衡器入口：跳设置页音效节（引擎侧 DSP 的 EQ / 响度归一化都在那）
      case "equalizer":
        return <EqualizerButton key="equalizer" />;
      // 分享：复制歌曲信息到剪贴板（PC 没有分享面板，用复制兜底）
      case "share":
        return track ? <ShareButton key="share" track={track} /> : null;
      // 换源：当前源不支持这首歌时，在其他音源里搜同一首并展示，点选后就地替换
      case "source":
        return track ? <SourceSwitchButton key="source" track={track} /> : null;
      // 歌手：跳歌手页。本地曲目没有音源端点可查，直接不渲染（见 ArtistButton 注释）
      case "artist":
        return track && track.platform !== "local" ? (
          <ArtistButton key="artist" track={track} />
        ) : null;
      default:
        return null;
    }
  };

  // 自愈：拿不到曲目时（事件丢失/快照被覆盖的兜底）主动拉一次实时快照，
  // 拿到曲目为止；正常时这个 effect 空转。注意**不能**豁免 stopped——
  // 事件通道挂掉时 store 恰恰冻结在初始的 stopped+无曲目上，豁免它等于
  // 关掉最需要自愈的场景。连续 3 次拉取都无改善就停手，避免空转轮询。
  // 依赖里**不要**再放 positionMs：它每 250ms 变一次，会让这个 800ms 定时器
  // 被反复重置、永远烧不到（以前 tick 重建 state 就是这个效果）。
  const healAttemptsRef = useRef(0);
  useEffect(() => {
    if (track || !state || healAttemptsRef.current >= 3) return;
    const timer = setTimeout(() => {
      void getPlaybackState()
        .then((s) => {
          const before = usePlayerStore.getState().state;
          usePlayerStore.getState().applySnapshot(s);
          const after = usePlayerStore.getState().state;
          if (after?.track || before?.status !== after?.status) {
            healAttemptsRef.current = 0;
          } else {
            healAttemptsRef.current += 1;
          }
        })
        .catch(() => {});
    }, 800);
    return () => clearTimeout(timer);
  }, [track, state]);

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
    const durationMs = usePlayerStore.getState().durationMs;
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
        // z-20 不能省：播放条自成层叠上下文（z-20），而它本身 z 是 auto；
        // 内容区是 `relative z-10`，层数更高的内容区会盖在播放条（连同它的弹窗）上面，
        // 于是向上弹的收藏 / 音质菜单被页面内容整个遮住，表现是「点了没反应」。
        // 与 TitleBar 的 z-20 同理（见 TitleBar.tsx 同位置注释）。
        "relative z-20 flex h-[80px] shrink-0 items-center gap-4 border-t px-4",
        // 播放条的底色**不**跟队列开关联动：用户口径（m04741「我要和左边桌面歌词
        // 打开后效果一样就行」）指的是队列按钮**自身点亮**——和桌面歌词按钮开启态
        // 同一套填充（见下方 "queue" 分支的 emphasis），不是整条换表面。
        // 先前试过整条换 bg-secondary / 提高不透明度，都被判定为「没有变色」/「不是
        // 我要的」。播放页不渲染队列面板（AppShell 里 !isPlayingPage 才挂
        // QueuePanel），且那里播放条走自己的封面色渐变，本分支不受影响。
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
      {/*
        毛玻璃单独成层：backdrop-filter 每次重绘都要重新抓取并模糊身后内容，
        而本组件内部的进度条每帧都在更新——毛玻璃和它同层时，等于每帧重做一次
        全宽模糊（实测该层 paintCount 高达 527，而其它层都是 1）。
        拆成独立层（负 z 序，位于底色之上、内容之下，观感不变）后，
        进度条的更新不再触发背景重抓。
      */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 backdrop-blur-xl" />
      {/* 频谱背景：与毛玻璃同为 -z-10，DOM 顺序靠后所以画在毛玻璃之上、内容之下 */}
      <SpectrumBackground />
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
            // 空态与列表占位一致：图标而非文字，避免播放条上出现孤立小字
            <span className="flex h-full w-full items-center justify-center text-muted-foreground/60">
              <Music className="h-5 w-5" />
            </span>
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
        {/* 三栏栅格：两侧各占 1fr、中间栏 auto 放「上一首/播放/下一首」——
            播放键因此恒在中间栏正中，左右按钮的条数与宽窄都推不偏它 */}
        <div className="grid w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3">
          {/* 可配置按钮分列在播放键两侧（设置 → 播放条 逐个开关）：
              条数由 lib/player-bar.ts 的 splitPlayerBarButtons 按数量均分 */}
          <div className="flex items-center justify-end gap-3">
            {leftBarButtons.map(renderBarButton)}
          </div>
          <div className="flex items-center gap-3">
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
          </div>
          <div className="flex items-center gap-3">
            {rightBarButtons.map(renderBarButton)}
          </div>
        </div>

        {/* 进度条：外层 16px 高命中区，轨道 hover 从 6px 长到 8px 并浮现拖块；
            拖动期间（isDraggingProgress）拖块常显。时间标签在容器高度内不跳动 */}
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
            className="group relative flex h-4 min-w-0 flex-1 cursor-pointer items-center"
          >
            <div className="relative h-1.5 w-full rounded-full bg-secondary/60 transition-[height] duration-150 group-hover:h-2">
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
            {/* 拖块：hover 浮现，拖动中常显；两端超出轨道属预期（标准滑块形态） */}
            <div
              aria-hidden
              className={cn(
                "pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow-[0_1px_4px_rgba(0,0,0,0.3)] transition-opacity duration-150",
                isDraggingProgress
                  ? "opacity-100"
                  : "opacity-0 group-hover:opacity-100",
              )}
              style={{
                left:
                  duration > 0
                    ? `${Math.min(100, Math.max(0, (shownPosition / duration) * 100))}%`
                    : "0%",
              }}
            />
          </div>
          <span className="w-10">{formatTime(duration)}</span>
        </div>
      </div>

      {/* 音量：固定在播放条最右侧，不参与左右分列（设置 → 播放条 可隐藏）。
          容器定宽 w-56 与左侧封面区等宽：两侧等宽，中间控制区的中点才落在窗口中点，
          否则播放键会被挤偏（音量控件本身只有 w-32，右侧比左侧窄） */}
      <div className="flex w-56 shrink-0 items-center justify-end">
        {visibleBarIds.includes("volume") && <VolumeControl />}
      </div>
    </div>
  );
}

/** 桌面歌词开关（DESIGN §10）：初始读 Rust 状态，此后跟随 lyric-window-changed */
/** 引擎侧一帧频谱的频段数（fx.rs SPECTRUM_BANDS），事件按数组顺序到达 */
const SPECTRUM_BANDS = 48;
/** 背景方块显示条数：按条宽自适应前先用它均分整个播放条 */
const SPECTRUM_BARS = 64;
/** 事件停发多久后判定为「无频谱」（开关关闭 / 未播放），方块平滑归零 */
const SPECTRUM_STALE_MS = 300;

/**
 * 播放条频谱背景（设置页「音效 → 频谱背景」开关）。
 *
 * 数据链路：音频渲染线程的 SpectrumTap（fx.rs）做 2048 点 FFT → 48 个对数频段
 * → ~22fps 推 `spectrum` 事件；这里常驻 rAF 把每帧画成底部一排圆角方块。
 * 显示条对事件频段做线性插值；起跳快、下落慢，跳起来的方块跟手、回落有余韵。
 *
 * 开关关闭时引擎直接不发事件，这里在停发 SPECTRUM_STALE_MS 后让方块归零并
 * 只清屏一次（零态 rAF 不产生绘制），因此「关着」的常态开销约等于零，
 * 也不需要额外的跨组件状态同步。
 */
function SpectrumBackground(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bandsRef = useRef<Float32Array>(new Float32Array(SPECTRUM_BANDS));
  const displayRef = useRef<Float32Array>(new Float32Array(SPECTRUM_BARS));
  const lastAtRef = useRef(0);
  const colorRef = useRef({ rgb: "120,120,120", at: 0 });

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<{ bands: number[] }>("spectrum", (e) => {
      const bands = bandsRef.current;
      const src = e.payload.bands ?? [];
      for (let i = 0; i < bands.length; i++) bands[i] = src[i] ?? 0;
      lastAtRef.current = performance.now();
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });

    const canvas = canvasRef.current;
    let raf = 0;
    let wasActive = false;
    const draw = (): void => {
      raf = window.requestAnimationFrame(draw);
      const w = canvas?.clientWidth ?? 0;
      const h = canvas?.clientHeight ?? 0;
      if (!canvas || w === 0 || h === 0) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // 分辨率跟随窗口 / 缩放（只在尺寸变化时重置画布）
      const dpr = window.devicePixelRatio || 1;
      const pw = Math.round(w * dpr);
      const ph = Math.round(h * dpr);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const fresh = performance.now() - lastAtRef.current < SPECTRUM_STALE_MS;
      const display = displayRef.current;
      const bands = bandsRef.current;
      let max = 0;
      for (let i = 0; i < display.length; i++) {
        let target = 0;
        if (fresh) {
          const pos = (i / (display.length - 1)) * (bands.length - 1);
          const lo = Math.floor(pos);
          const hi = Math.min(bands.length - 1, lo + 1);
          target = bands[lo] + (bands[hi] - bands[lo]) * (pos - lo);
        }
        const k = target > display[i] ? 0.5 : 0.14;
        display[i] += (target - display[i]) * k;
        if (display[i] > max) max = display[i];
      }

      // 零态只清一次屏，之后不再产生绘制调用
      if (!fresh && max < 0.004) {
        if (wasActive) {
          ctx.clearRect(0, 0, w, h);
          wasActive = false;
        }
        return;
      }
      wasActive = true;

      // 主色：用 text-primary 探针取浏览器解析后的 rgb，主题 / 主色切换 2s 内跟随
      const now = performance.now();
      if (now - colorRef.current.at > 2000) {
        const probe = document.createElement("span");
        probe.className = "text-primary";
        probe.style.display = "none";
        document.body.appendChild(probe);
        const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(probe).color);
        if (m) {
          colorRef.current.rgb = m[1]
            .split(",")
            .slice(0, 3)
            .map((s) => s.trim())
            .join(",");
        }
        probe.remove();
        colorRef.current.at = now;
      }

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = `rgba(${colorRef.current.rgb},0.4)`;
      const step = w / display.length;
      const bw = Math.max(2, step * 0.55);
      const r = Math.min(3, bw / 2);
      ctx.beginPath();
      for (let i = 0; i < display.length; i++) {
        // 最低也画个小方块：静止时仍有「一排方块」的形态，而不是完全消失
        const bh = Math.max(display[i] * h * 0.82, bw);
        const x = i * step + (step - bw) / 2;
        ctx.roundRect(x, h - bh, bw, bh, r);
      }
      ctx.fill();
    };
    raf = window.requestAnimationFrame(draw);

    return () => {
      disposed = true;
      window.cancelAnimationFrame(raf);
      unlisten?.();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-full w-full"
    />
  );
}

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
      emphasis
      onClick={() =>
        void (on ? hideDesktopLyric() : showDesktopLyric())
          .then((s) => setOn(s.visible))
          // 功能开关失败不值得弹全局「致命错误」浮层：保持当前状态即可
          // （与同文件 setSpeed 等按钮的 .catch(() => {}) 口径一致）
          .catch(() => {})
      }
    >
      <Captions className="h-4 w-4" />
    </ControlButton>
  );
}

/**
 * 音质入口（播放条）：只改**当前这首**，不写设置里的默认音质
 * —— 默认值在设置页改，换歌后自动回到默认。
 * 选项按当前歌曲的源收敛（v5 契约：包侧声明了该源可用档位，如 B 站无真
 * 无损就不显示 flac；未声明 = 全部档位）。菜单向上弹（播放条贴在窗口底部）。
 */
function QualityMenu(props: { current: Quality; platform: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  useDismissOnOutside(boxRef, open, () => setOpen(false));
  // 档位清单来自数据包注册表并按当前歌曲的源过滤（未就绪时 qualityOptionsFromRegistry 兜底三档）
  const options = qualityOptionsFromRegistry(
    useSourceQualities(props.platform),
  );
  const shortOf = (q: Quality): string =>
    options.find((o) => o.value === q)?.short ?? q;

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
        aria-label={`音质：${shortOf(props.current)}（只对当前这首歌生效）`}
        title="音质（只对当前这首歌生效，默认音质在设置里改）"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 min-w-12 items-center justify-center rounded-full px-2.5 text-xs font-medium tabular-nums transition-all disabled:opacity-50 text-foreground/80 hover:bg-secondary/50 hover:text-foreground"
      >
        {shortOf(props.current)}
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute bottom-full right-0 z-30 mb-2 w-32 overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitem"
              onClick={() => pick(o.value)}
              className={cn(
                "flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-xs transition-colors hover:bg-secondary",
                o.value === props.current ? "bg-primary/10 text-primary" : "",
              )}
            >
              {/* 选中项同时给出勾选图标：颜色之外多一个形状信号 */}
              <span className="flex items-center gap-1.5">
                {o.value === props.current ? <Check className="h-3 w-3" /> : null}
                {o.label}
              </span>
              <span className="text-[10px] text-muted-foreground">{o.short}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 倍速入口（播放条）：写引擎并持久化（重启保持、对所有歌生效），
 * 与「音质」不同——音质菜单只改当前这首，默认音质在设置页。
 */
function SpeedMenu(props: { current: number }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  useDismissOnOutside(boxRef, open, () => setOpen(false));

  const pick = (v: number): void => {
    setOpen(false);
    if (v !== props.current) void setSpeed(v).catch(() => {});
  };

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        aria-label={`倍速：${speedLabel(props.current)}`}
        title="倍速"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 min-w-12 items-center justify-center rounded-full px-2.5 text-xs font-medium tabular-nums text-foreground/80 transition-all hover:bg-secondary/50 hover:text-foreground"
      >
        {speedLabel(props.current)}
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute bottom-full right-0 z-30 mb-2 w-28 overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {SPEED_OPTIONS.map((v) => (
            <button
              key={v}
              type="button"
              role="menuitem"
              onClick={() => pick(v)}
              className={cn(
                "flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-xs transition-colors hover:bg-secondary",
                v === props.current ? "bg-primary/10 text-primary" : "",
              )}
            >
              <span className="flex items-center gap-1.5">
                {v === props.current ? <Check className="h-3 w-3" /> : null}
                {speedLabel(v)}
              </span>
              {v === 1 && <span className="text-[10px] text-muted-foreground">原速</span>}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 睡眠定时档位：分钟档 + 「播完当前歌后停止」，与移动端口径一致 */
const SLEEP_MINUTE_OPTIONS = [15, 30, 60];

/**
 * 睡眠定时入口（播放条）：倒计时在引擎侧（到点暂停并发 sleep-timer-fired），
 * 按钮上只做本地倒计时展示。播完当前歌模式没有倒计时，按 state.sleepAfterTrack 显示。
 */
function SleepTimerMenu(props: {
  remainingMs: number | null;
  afterTrack: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  useDismissOnOutside(boxRef, open, () => setOpen(false));
  // 快照只带「武装时刻的剩余量」，这里本地每秒递减展示
  const [remainMs, setRemainMs] = useState<number | null>(null);
  const armedAtRef = useRef(0);
  const { remainingMs } = props;

  useEffect(() => {
    if (remainingMs === null) {
      setRemainMs(null);
      return;
    }
    armedAtRef.current = performance.now();
    setRemainMs(remainingMs);
    const iv = window.setInterval(() => {
      const left = remainingMs - (performance.now() - armedAtRef.current);
      setRemainMs(left > 0 ? left : 0);
    }, 1000);
    return () => window.clearInterval(iv);
  }, [remainingMs]);

  const armed = props.afterTrack || remainingMs !== null;
  const title = props.afterTrack
    ? "睡眠定时：播完当前歌停止"
    : remainMs !== null
      ? `睡眠定时：${formatTime(remainMs)} 后暂停`
      : "睡眠定时";

  const pick = (minutes: number | "track" | null): void => {
    setOpen(false);
    if (minutes === null) void setSleepTimer(null, false).catch(() => {});
    else if (minutes === "track") void setSleepTimer(null, true).catch(() => {});
    else void setSleepTimer(minutes * 60_000, false).catch(() => {});
  };

  return (
    <div ref={boxRef} className="relative">
      <ControlButton
        label={title}
        active={armed}
        emphasis
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Timer className="h-4 w-4" />
      </ControlButton>
      {open ? (
        <div
          role="menu"
          className="absolute bottom-full right-0 z-30 mb-2 w-36 overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {armed && (
            <button
              type="button"
              role="menuitem"
              onClick={() => pick(null)}
              className="flex w-full items-center rounded-md px-2.5 py-1.5 text-xs text-destructive transition-colors hover:bg-secondary"
            >
              关闭定时
            </button>
          )}
          {SLEEP_MINUTE_OPTIONS.map((m) => (
            <button
              key={m}
              type="button"
              role="menuitem"
              onClick={() => pick(m)}
              className={cn(
                "flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors hover:bg-secondary",
                !props.afterTrack &&
                  remainingMs !== null &&
                  Math.abs(remainingMs - m * 60_000) < 30_000
                  ? "bg-primary/10 text-primary"
                  : "",
              )}
            >
              {m} 分钟
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => pick("track")}
            className={cn(
              "flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors hover:bg-secondary",
              props.afterTrack ? "bg-primary/10 text-primary" : "",
            )}
          >
            播完当前歌停止
          </button>
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
    <ControlButton
      label={`播放模式：${label}`}
      onClick={props.onCycle}
      active={props.mode !== "listLoop"}
    >
      <Icon className="h-4 w-4" />
    </ControlButton>
  );
}

/**
 * 播放地址入口（qt_admin 专属）：图标按钮，点开向上弹面板展示**当前实际在播**
 * 的地址（换源兜底后指向真正在播的源）、这条地址是**音源包里哪条源**取到的
 * （line，见 @/source-scripts/playurl-line），以及上次取链失败的死因（miss，
 * 逐线路 trace：哪条线挂死/死链/预算耗尽未跑、跨源有没有跑），点地址即复制。
 * 与音质菜单同款：向上弹 + 点外面/Esc 收起。
 */
function PlayUrlButton(props: { url: string | null; line: string; miss: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  useDismissOnOutside(boxRef, open, () => setOpen(false));

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
          {/* 音源线路：本次取链命中 chain.json 里的哪条源（安卓端同款文案）。
              「未知」= 走的是音源包内 10 分钟缓存，或引擎页比宿主旧没有这个字段 */}
          <div
            className="mb-1.5 text-[11px] leading-relaxed"
            title="未知 = 走的是音源包内缓存，或本次未重新取链"
          >
            <span className="text-muted-foreground">音源线路：</span>
            <span className={props.line ? "break-all text-foreground/85" : "text-muted-foreground"}>
              {props.line || "未知"}
            </span>
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
          {/* 上次取链死因：bundle 的逐线路 trace（哪条线挂死/死链/预算耗尽未跑、
              跨源兜底有没有跑）。没有它，「取不到地址」在 PC 上只能靠猜 */}
          {props.miss ? (
            <div className="mt-1.5 text-[10px] leading-relaxed">
              <span className="text-muted-foreground">上次取链死因：</span>
              <span className="break-all font-mono text-amber-500/90">{props.miss}</span>
            </div>
          ) : null}
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

/**
 * 屏蔽（不喜欢）按钮：点一下屏蔽当前这首歌（Alt+点击屏蔽歌手，与曲目行的
 * 约定一致），已屏蔽时点一下就地取消（规则 id 走 dislikes store 的会话内反查表）。
 * Alt+点击同样是 toggle：歌手已被屏蔽就撤销整串歌手的规则，不是单向「屏蔽」。
 * 「已屏蔽」判定不在前端自己算 —— 归一化/后缀剥离在 Rust 侧，只发一次
 * check_disliked（单曲版），规则集合变化（version）后重新判定。
 */
function DislikeButton(props: { track: Track }): React.JSX.Element {
  const [disliked, setDisliked] = useState(false);
  // 规则增删后重新判定（哪怕是别的入口改的）
  const version = useDislikesStore((s) => s.version);
  const singer = props.track.singer;
  const singerBanned = useDislikesStore((s) => (singer ? s.singerBanned(singer) : false));

  useEffect(() => {
    let disposed = false;
    checkDisliked([props.track])
      .then((res) => {
        if (!disposed) setDisliked(Array.isArray(res) && res[0] === true);
      })
      .catch(() => {
        if (!disposed) setDisliked(false);
      });
    return () => {
      disposed = true;
    };
  }, [props.track, version]);

  const onToggle = (e: ReactMouseEvent): void => {
    e.stopPropagation();
    const store = useDislikesStore.getState();
    if (e.altKey && singer) {
      // 歌手级 toggle：一整串歌手（A/B/C）的规则一起进、一起退
      if (singerBanned) void store.unbanSinger(singer);
      else void store.banSinger(singer);
      return;
    }
    if (disliked) {
      void store.unbanSong(props.track);
    } else {
      void store.banSong(props.track);
    }
  };

  const singerLabel = singerBanned
    ? "取消屏蔽歌手"
    : "屏蔽这首歌（Alt+点击屏蔽歌手）";
  return (
    <ControlButton
      label={disliked ? "取消屏蔽" : singerLabel}
      active={disliked || singerBanned}
      emphasis
      tone="destructive"
      onClick={onToggle}
    >
      <ThumbsDown className="h-4 w-4" />
    </ControlButton>
  );
}

/**
 * 频谱背景开关：与设置页频谱开关同一个后端（ipc.setSpectrum），关闭时引擎
 * 不做任何频谱计算；SpectrumBackground 在停发事件后自行归零，无需额外同步。
 */
function SpectrumButton(): React.JSX.Element {
  const [on, setOn] = useState(false);

  useEffect(() => {
    let disposed = false;
    void getFxState()
      .then((fx) => {
        if (!disposed) setOn(fx.spectrum === true);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);

  const toggleSpectrum = (): void => {
    const next = !on;
    setOn(next);
    void setSpectrum(next).catch(() => setOn(!next));
  };

  return (
    <ControlButton label="频谱背景" active={on} emphasis onClick={toggleSpectrum}>
      <AudioWaveform className="h-4 w-4" />
    </ControlButton>
  );
}

/**
 * 歌手入口（对齐 qt-uniappx 播放页的 artist 工具）：打开当前歌曲的歌手页。
 *
 * 曲目上只有歌手名没有歌手 id（`Track.singer`），所以跟移动端一样走**名字搜索**
 * 闭环：把 encode 过的名字放在 `$id` 位置，ArtistPage 没有 `?id=` 时会把它当名字
 * 用（见 ArtistPage / SearchPage.openArtist 的注释），不会白屏。
 *
 * 本地曲目不渲染这个按钮：歌手页要打音源包的 getArtistSongs，local 源没有这个
 * 端点（TrackList 里本地曲目的歌手也不做成链接，同一口径）。
 */
function ArtistButton(props: { track: Track }): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <ControlButton
      label={`歌手：${props.track.singer}`}
      onClick={() =>
        void navigate({
          to: "/artist/$platform/$id",
          params: { platform: props.track.platform, id: encodeURIComponent(props.track.singer) },
        })
      }
    >
      <User className="h-4 w-4" />
    </ControlButton>
  );
}

/** 均衡器入口：跳设置页音效节（EQ / 响度归一化 / 淡入淡出都在那） */
function EqualizerButton(): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <ControlButton
      label="均衡器 / 音效"
      onClick={() => void navigate({ to: "/settings/$section", params: { section: "sound" } })}
    >
      <SlidersHorizontal className="h-4 w-4" />
    </ControlButton>
  );
}

/**
 * 分享按钮（用户 m07452 的「9=分享」，m10417 改成图片卡片）：PC 没有系统分享面板，
 * 照移动端做成「卡片预览 + 复制图片 / 保存 PNG」的弹层 —— 分享出去的是图，不是一行文字。
 */
function ShareButton(props: { track: Track }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  useDismissOnOutside(boxRef, open, () => setOpen(false));

  return (
    <div ref={boxRef} className="relative">
      <ControlButton label="分享" active={open} onClick={() => setOpen((v) => !v)}>
        <Share2 className="h-4 w-4" />
      </ControlButton>
      {open ? (
        <div className="absolute bottom-full left-1/2 z-30 mb-2 -translate-x-1/2 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg">
          <ShareCardPanel track={props.track} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * 换源按钮：点开向上弹候选面板（聚合搜索其他音源的同一首歌，见
 * SourceSwitchPanel），点选后就地替换 —— 队列位置不动；点外面/Esc 收起。
 */
function SourceSwitchButton(props: { track: Track }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  useDismissOnOutside(boxRef, open, () => setOpen(false));

  return (
    <div ref={boxRef} className="relative">
      <ControlButton label="换源" active={open} onClick={() => setOpen((v) => !v)}>
        <RefreshCw className="h-4 w-4" />
      </ControlButton>
      {open ? (
        <div className="absolute bottom-full left-1/2 z-30 mb-2 -translate-x-1/2 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg">
          <SourceSwitchPanel
            track={props.track}
            onPick={(candidate) => {
              setOpen(false);
              void replaceCurrentWithCandidate(candidate);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function ControlButton(props: {
  label: string;
  /** 开启态语义：只写 aria-pressed，**不再决定外观**（外观由 emphasis 决定） */
  active?: boolean;
  /**
   * 开启态是否铺底色。开启态本身就是状态的按钮用它（睡眠定时 / 收藏 / 播放 /
   * 桌面歌词 / 频谱 / 不喜欢 / 播放队列）；
   * 播放模式 / 播放地址虽有开启态，但不铺底色——弹层本身就是提示。
   */
  emphasis?: boolean;
  /**
   * 填充色。「不喜欢」开启态是负面状态，铺主色会读成「已开启某个功能」，
   * 故走 destructive 那一套；其余铺主色（默认）。
   */
  tone?: "primary" | "destructive";
  /** 禁用：点了不会有实际效果的场景（如播放页的队列按钮）用它，置灰且不可点 */
  disabled?: boolean;
  onClick?: (e: ReactMouseEvent) => void;
  /** 透传给底层 button 的 menu 语义（带弹出菜单的按钮用） */
  ariaHasPopup?: "menu";
  ariaExpanded?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const filled = props.active === true && props.emphasis === true;
  const fill =
    props.tone === "destructive"
      ? // 屏蔽态：红底。同样的 60% 填充与收敛辉光，只是换到 destructive 色系，
        // 与主色状态按钮的观感保持一致，不会被读成「开启了某个功能」。
        // 前景写死白色：项目只定义了 --destructive，没有 destructive-foreground，
        // 两种主题下的红（oklch 0.58 / #ef4444）配白字对比度都够。
        "bg-destructive/60 text-white shadow-[0_2px_8px_color-mix(in_srgb,var(--destructive)_25%,transparent)] hover:brightness-110 active:brightness-95"
      : "bg-primary/60 text-primary-foreground shadow-[0_2px_8px_color-mix(in_srgb,var(--primary)_25%,transparent)] hover:brightness-110 active:brightness-95";
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.active}
      aria-haspopup={props.ariaHasPopup}
      aria-expanded={props.ariaExpanded}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        "flex h-9 w-9 items-center justify-center rounded-full transition-all",
        // 其余按钮一律不铺底色（用户口径：除四个状态按钮外不要背景色），
        // 只留 hover 浮出的浅底做可点提示。
        // 开启态填充从 80% 降到 60%（用户反馈「选中的颜色再浅一点」），
        // 辉光同步收敛——中央播放键仍是实心，主次层级不受影响。
        filled ? fill : "text-foreground/80 hover:bg-secondary/50 hover:text-foreground active:bg-secondary/70",
        // 禁用态：压暗 + 去掉交互反馈，跟其余按钮的 hover 浅底区分开
        props.disabled === true && "cursor-not-allowed opacity-40 hover:bg-transparent",
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
  /** 展示值：静音时轨道归零，但拖动/键盘调整会先解除静音 */
  const effective = muted ? 0 : volume;
  /** 拖动标记：ref 记录，避免 move 事件高频触发重渲染 */
  const draggingRef = useRef(false);

  const ratioFromEvent = (e: ReactPointerEvent<HTMLDivElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    // 静音中开始拖动：先解除静音，否则轨道纹丝不动像「冻结」
    if (muted) void toggleMute();
    void setVolume(ratioFromEvent(e));
  };

  const onMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return;
    void setVolume(ratioFromEvent(e));
  };

  const onUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  // 键盘可达性：←/↓ 减、→/↑ 增（5% 步进），Home/End 跳到最小/最大
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = 0.05;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = effective + step;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = effective - step;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = 1;
    if (next === null) return;
    e.preventDefault();
    if (muted) void toggleMute();
    void setVolume(Math.min(1, Math.max(0, next)));
  };

  return (
    <div className="flex w-32 items-center gap-2">
      <button
        type="button"
        aria-label={muted ? "取消静音" : "静音"}
        title={muted ? "取消静音" : "静音"}
        onClick={() => void toggleMute()}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        {muted || volume === 0 ? (
          <VolumeX className="h-4 w-4" />
        ) : volume < 0.5 ? (
          <Volume1 className="h-4 w-4" />
        ) : (
          <Volume2 className="h-4 w-4" />
        )}
      </button>
      {/* 自绘轨道：与进度条同一套视觉语言（主题色填充、hover 增高、拖块浮现），
          原生 range 的 OS 默认样式做不出这种一致性。
          role=slider + 方向键兜底键盘操作，focus-visible 由全局 base 层接管 */}
      <div
        role="slider"
        aria-label="音量"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(effective * 100)}
        tabIndex={0}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onKeyDown={onKeyDown}
        className="group relative flex h-4 min-w-0 flex-1 cursor-pointer items-center"
      >
        <div className="relative h-1.5 w-full rounded-full bg-secondary/60 transition-[height] duration-150 group-hover:h-2">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-primary"
            style={{ width: `${effective * 100}%` }}
          />
        </div>
        <div
          aria-hidden
          className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary opacity-0 shadow-[0_1px_4px_rgba(0,0,0,0.3)] transition-opacity duration-150 group-hover:opacity-100"
          style={{ left: `${effective * 100}%` }}
        />
      </div>
    </div>
  );
}
