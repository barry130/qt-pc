import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import type { Track } from "@/types";
import { usePlayerStore } from "@/stores/player";
import { useInterpolatedPosition } from "@/hooks/useInterpolatedPosition";
import { getPlaybackLyric } from "@/lib/localOnline";
import { findActiveIndex, mergeTranslation, parseLrc, qtresCoverUrl } from "@/lib/lrc";
import { WindowControls } from "@/components/WindowControls";
import { cn , errMsg } from "@/lib/utils";

/**
 * 播放页（全屏歌词 + 旋转封面）：
 * - 左侧：黑胶唱片风格旋转封面（仅播放时旋转，暂停停在当前角度）
 * - 右侧：曲目信息 + 滚动歌词
 * - 左上角：收回按钮（返回上一页）
 * - 右上角：最小化 / 最大化 / 退出（本页隐藏了 TitleBar，必须自带窗口控制）
 * - 歌词同步误差 ≤ 50ms（rAF 插值 + 高亮平滑）
 */
export function PlayingPage(): React.JSX.Element {
  const track = usePlayerStore((s) => s.state?.track ?? null);
  const playing = usePlayerStore((s) => s.state?.status === "playing");
  const position = useInterpolatedPosition();
  const navigate = useNavigate();
  const pathname = useLocation().pathname;

  const [lrc, setLrc] = useState("");
  const [translation, setTranslation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loadedFor = useRef<string | null>(null);

  const key = track ? `${track.platform}:${track.id}` : null;

  useEffect(() => {
    if (!track || !key || loadedFor.current === key) return;
    loadedFor.current = key;
    setLrc("");
    setTranslation("");
    setError(null);
    setLoading(true);
    getPlaybackLyric(track)
      .then((lyr) => {
        setLrc(lyr.lrc);
        setTranslation(lyr.translation);
      })
      .catch((err) => {
        setError(errMsg(err));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [track, key]);

  const lines = useMemo(() => {
    const parsed = parseLrc(lrc);
    return mergeTranslation(parsed, translation);
  }, [lrc, translation]);

  const activeIndex = findActiveIndex(lines, position);

  const handleBack = (): void => {
    if (pathname !== "/playing") return;
    if (window.history.length > 1) {
      window.history.back();
    } else {
      void navigate({ to: "/" });
    }
  };

  return (
    <div className="flex h-full w-full">
      {/* 收回按钮 */}
      <button
        type="button"
        onClick={handleBack}
        className="absolute left-4 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label="返回"
      >
        <ChevronDown className="h-5 w-5" />
      </button>

      {/* 窗口控制：AppShell 在播放页整页隐藏 TitleBar，没有这组按钮就没法最小化/关闭窗口 */}
      <WindowControls
        variant="floating"
        closeLabel="退出"
        className="absolute right-4 top-3 z-10"
      />

      <div className="flex min-h-0 w-full flex-1">
        {/* 左侧：旋转封面 */}
        <div className="flex w-[38%] shrink-0 items-center justify-center">
          <VinylCover track={track} playing={playing} />
        </div>

        {/* 右侧：曲目信息 + 歌词 */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* pr-32：给右上角的窗口控制按钮让位，长标题不会钻到按钮底下 */}
          <div className="pl-8 pr-32 pt-10 pb-4">
            <TrackInfo track={track} />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {error ? (
              <CenterText text={`歌词加载失败：${error}`} />
            ) : loading ? (
              <CenterText text="歌词加载中…" />
            ) : lines.length === 0 ? (
              <CenterText
                text={track?.platform === "local" ? "没有歌词" : "暂无歌词"}
              />
            ) : (
              <LyricScroller lines={lines} activeIndex={activeIndex} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 黑胶唱片风格旋转封面（仅播放时旋转） */
function VinylCover(props: { track: Track | null; playing: boolean }): React.JSX.Element {
  const { track, playing } = props;
  const coverUrl = track ? qtresCoverUrl(track.picUrl) : null;

  return (
    <div className="relative">
      {/* 封面色光晕：唱片不再浮在纯色上，与整窗背景同一色源 */}
      <div
        aria-hidden
        className="absolute -inset-10 rounded-full opacity-60 blur-3xl"
        style={{
          background:
            "color-mix(in srgb, var(--playing-cover-accent, var(--primary)) 38%, transparent)",
        }}
      />
      {/* 唱片：animation-play-state 控制转/停 —— 暂停时停在当前角度，
          恢复播放从原角度继续，不会跳回 0 度 */}
      <div
        className="vinyl-spin relative h-[280px] w-[280px] rounded-full bg-neutral-900 shadow-2xl sm:h-[320px] sm:w-[320px]"
        style={{ animationPlayState: playing ? "running" : "paused" }}
      >
        {/* 唱片纹理（同心圆） */}
        <div className="absolute inset-0 rounded-full border border-neutral-800" />
        <div className="absolute inset-4 rounded-full border border-neutral-800" />
        <div className="absolute inset-8 rounded-full border border-neutral-800" />
        <div className="absolute inset-12 rounded-full border border-neutral-800" />

        {/* 专辑封面 */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="relative h-28 w-28 overflow-hidden rounded-full shadow-lg sm:h-32 sm:w-32">
            {coverUrl ? (
              <img
                src={coverUrl}
                alt={track?.title ?? ""}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-neutral-800 text-neutral-500">
                <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 6v6l4 2" />
                </svg>
              </div>
            )}
          </div>
        </div>

        {/* 中心轴孔 */}
        <div className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-neutral-700 ring-1 ring-neutral-600" />
      </div>
    </div>
  );
}

function TrackInfo(props: { track: Track | null }): React.JSX.Element {
  const { track } = props;
  return (
    <div className="min-w-0">
      <div className="truncate text-2xl font-bold tracking-tight">
        {track ? track.title : "未在播放"}
      </div>
      <div className="mt-1 truncate text-sm text-muted-foreground">
        {track
          ? `专辑：${track.album}    歌手：${track.singer}`
          : "去搜索页找一首歌开始播放"}
      </div>
    </div>
  );
}

function CenterText(props: { text: string }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      {props.text}
    </div>
  );
}

function LyricScroller(props: {
  lines: { timeMs: number; text: string; translation?: string }[];
  activeIndex: number;
}): React.JSX.Element {
  const { lines, activeIndex } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    const el = itemRefs.current[activeIndex];
    const container = containerRef.current;
    if (!el || !container) return;
    const target =
      el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2;
    container.scrollTo({ top: target, behavior: "smooth" });
  }, [activeIndex]);

  return (
    <div
      ref={containerRef}
      className="h-full overflow-y-auto scroll-smooth px-8 [mask-image:linear-gradient(to_bottom,transparent,black_15%,black_85%,transparent)]"
    >
      <div className="mx-auto flex max-w-xl flex-col gap-5 py-[40%]">
        {lines.map((line, i) => (
          <div
            key={i}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            className={cn(
              "text-center transition-all duration-300",
              i === activeIndex
                ? "scale-105 text-xl font-semibold text-lyric-highlight"
                : "text-base text-lyric-inactive",
            )}
          >
            <div>{line.text || "…"}</div>
            {line.translation && (
              <div
                className={cn(
                  "mt-1 text-sm",
                  i === activeIndex
                    ? "text-lyric-highlight/80"
                    : "text-lyric-inactive/70",
                )}
              >
                {line.translation}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
