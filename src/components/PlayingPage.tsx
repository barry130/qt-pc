import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ChevronDown, Search } from "lucide-react";
import type { Lyric, Track } from "@/types";
import { usePlayerStore } from "@/stores/player";
import { useInterpolatedPosition } from "@/hooks/useInterpolatedPosition";
import {
  crossSourceForPlayback,
  getPlaybackLyric,
  type CrossSourceHit,
} from "@/lib/localOnline";
import { useLyricOffset } from "@/hooks/useLyricOffset";
import { useSourceColor, useSourceLabel } from "@/stores/sourceRegistry";
import { LyricOffsetControl } from "@/components/lyric/LyricOffsetControl";
import { LyricSearchButton } from "@/components/lyric/LyricSearchButton";
import {
  findActiveIndex,
  mergeRomanization,
  mergeTranslation,
  parseLrc,
  parseWordByWordLrc,
  qtresCoverUrl,
  type LyricLine,
  type LyricWord,
} from "@/lib/lrc";
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
  const playUrl = usePlayerStore((s) => s.state?.playUrl ?? null);
  const quality = usePlayerStore((s) => s.state?.quality ?? null);
  const playing = usePlayerStore((s) => s.state?.status === "playing");
  const seekTo = usePlayerStore((s) => s.seekTo);
  const position = useInterpolatedPosition();
  const navigate = useNavigate();
  const pathname = useLocation().pathname;

  const [lrc, setLrc] = useState("");
  const [translation, setTranslation] = useState("");
  // 逐字与罗马音：取不到（老包 / 平台没这个面）就是空串，播放页照旧整行高亮
  const [wordByWord, setWordByWord] = useState("");
  const [romanization, setRomanization] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loadedFor = useRef<string | null>(null);
  /**
   * 「搜索歌词」弹层（自绘 popover，挂在偏移旁的按钮上，见 LyricSearchButton）。
   * 入口常驻偏移旁边（用户 m09160：方案同换源一样），不再只在「暂无歌词」空态里出现——
   * 词挂错版本（有词但不对）时同样需要这条纠错路径。
   */
  const [searchOpen, setSearchOpen] = useState(false);

  // 换源兜底会把实际播放地址切到别的平台（playUrl 变化时命中线路记忆刚更新）：
  // 歌词必须跟着换到对应源重取，避免「放的是 kw 的音、显示的是 wyy 的词」
  const cross = useMemo(
    () => crossSourceForPlayback(track, quality),
    // 线路记忆不是响应式数据，靠 playUrl 变化触发重估（跨源兜底必然改地址）
    [track, quality, playUrl],
  );

  const key = track
    ? `${track.platform}:${track.id}:${cross?.target ?? ""}:${cross?.song?.id ?? ""}`
    : null;

  useEffect(() => {
    if (!track || !key || loadedFor.current === key) return;
    loadedFor.current = key;
    // 换歌/换源时收起搜索弹窗：弹窗里的关键字与候选都是上一首的，留着会让人点错词
    setSearchOpen(false);
    setLrc("");
    setTranslation("");
    setWordByWord("");
    setRomanization("");
    setError(null);
    setLoading(true);
    getPlaybackLyric(track, cross)
      .then((lyr) => {
        // 已有更新的取词（如随后又换源）：过期结果不应用，最后应用的必须是对应源的
        if (loadedFor.current !== key) return;
        setLrc(lyr.lrc);
        setTranslation(lyr.translation);
        setWordByWord(lyr.wordByWord ?? "");
        setRomanization(lyr.romanization ?? "");
      })
      .catch((err) => {
        if (loadedFor.current !== key) return;
        setError(errMsg(err));
      })
      .finally(() => {
        if (loadedFor.current === key) setLoading(false);
      });
  }, [track, key, cross]);

  const lines = useMemo<LyricLine[]>(() => {
    // 有逐字就按逐字行渲染（自带 words，时间轴来自逐字文本，与原文同源）；
    // 没有就退回整行解析。译文与罗马音都按时间戳就近合并进去。
    // 逐字行的 text 是词拼接结果，与原文行文本可能差空格/标点，所以译文合并
    // 只看时间戳——这也是 mergeTranslation 一贯的口径。
    const base = wordByWord.length > 0 ? parseWordByWordLrc(wordByWord) : parseLrc(lrc);
    const withTranslation = mergeTranslation(base, translation);
    return mergeRomanization(withTranslation, romanization);
  }, [lrc, translation, wordByWord, romanization]);

  // 歌词偏移：判定用「进度 - 偏移」，正偏移 = 歌词延后出现（见 useLyricOffset 注释）
  const lyricOffset = useLyricOffset(track);
  const activeIndex = findActiveIndex(lines, position - lyricOffset.offsetMs);

  const handleBack = (): void => {
    if (pathname !== "/playing") return;
    if (window.history.length > 1) {
      window.history.back();
    } else {
      void navigate({ to: "/" });
    }
  };

  /**
   * 手动选定歌词后直接落到当前页面。
   *
   * 不重设 `loadedFor.current` 触发 useEffect 重取：缓存已经由
   * `applyPickedLyric` 同步刷好，重取只会多绕一圈（而且重取会先清空 state，
   * 页面上会闪一下「歌词加载中…」）。直接把这份词 set 进去最直接。
   */
  const handlePickedLyric = (lyric: Lyric): void => {
    setLrc(lyric.lrc);
    setTranslation(lyric.translation);
    setWordByWord(lyric.wordByWord ?? "");
    setRomanization(lyric.romanization ?? "");
    setError(null);
    setSearchOpen(false);
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
            <TrackInfo track={track} cross={cross} />
            {/* 偏移 + 搜索歌词：后者与换源同款（自绘 popover，点外面/Esc 收起），
                常驻在这里——不只是「暂无歌词」时才能纠错，词挂错版本时也要能换 */}
            <div className="mt-2 flex justify-end gap-1">
              <LyricSearchButton
                track={track}
                cross={cross}
                open={searchOpen}
                onOpenChange={setSearchOpen}
                onPicked={handlePickedLyric}
              />
              <LyricOffsetControl offset={lyricOffset} />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {error ? (
              <CenterText text={`歌词加载失败：${error}`} />
            ) : loading ? (
              <CenterText text="歌词加载中…" />
            ) : lines.length === 0 ? (
              // 无词空态：自动取词只认当前源/跨源兜底源的同一首歌，源站把词挂在
              // 别的版本上时就只剩「暂无歌词」。给一条手动纠错入口，不让用户
              // 只能靠换源碰运气（对齐 LX Music alpha.10）。
              <div className="flex h-full flex-col items-center justify-center gap-3">
                <span className="text-sm text-muted-foreground">
                  {track?.platform === "local" ? "没有歌词" : "暂无歌词"}
                </span>
                {track !== null && (
                  <button
                    type="button"
                    data-testid="lyric-search-entry"
                    onClick={() => setSearchOpen(true)}
                    className="flex items-center gap-1.5 rounded-full border border-border px-3.5 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <Search className="h-3.5 w-3.5" />
                    搜索歌词
                  </button>
                )}
              </div>
            ) : (
              <LyricScroller
                lines={lines}
                activeIndex={activeIndex}
                onSeekMs={(ms) => void seekTo(ms + lyricOffset.offsetMs)}
                positionMs={position - lyricOffset.offsetMs}
              />
            )}
          </div>
        </div>
      </div>

      {/* 搜索歌词弹层挂在偏移旁的按钮上（LyricSearchButton 自带 popover） */}
    </div>
  );
}

/** 黑胶唱片风格旋转封面（仅播放时旋转） */
function VinylCover(props: { track: Track | null; playing: boolean }): React.JSX.Element {
  const { track, playing } = props;
  // 播放页封面最大显示 420px（clamp 上界），按 2× DPR 要 840 —— 传 900
  // 让 Rust 侧向上游要这个尺寸，而不是把 1.9MB 原图整张拉下来
  const coverUrl = track ? qtresCoverUrl(track.picUrl, 900) : null;

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
          恢复播放从原角度继续，不会跳回 0 度。
          尺寸随视口呼吸：窄窗不低于 240px，宽窗封顶 420px（固定 280/320 在大屏全屏下偏小） */}
      <div
        className="vinyl-spin relative rounded-full bg-neutral-900 shadow-2xl"
        style={{
          width: "clamp(240px, 30vw, 420px)",
          height: "clamp(240px, 30vw, 420px)",
          animationPlayState: playing ? "running" : "paused",
        }}
      >
        {/* 唱片纹理（同心圆）：百分比 inset，随唱片尺寸等比缩放 */}
        <div className="absolute inset-0 rounded-full border border-neutral-800" />
        <div className="absolute inset-[5%] rounded-full border border-neutral-800" />
        <div className="absolute inset-[10%] rounded-full border border-neutral-800" />
        <div className="absolute inset-[15%] rounded-full border border-neutral-800" />

        {/* 专辑封面：占唱片直径 64%（2026-10-06 从 38% 放大——旧占比下唱片
            绝大多数是 neutral-900 底色，深色主题观感就是一大块黑）。留 18% 外缘
            给刻纹，黑胶质感还在，封面成了视觉主体 */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="relative h-[64%] w-[64%] overflow-hidden rounded-full shadow-lg">
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

function TrackInfo(props: { track: Track | null; cross?: CrossSourceHit | null }): React.JSX.Element {
  const { track } = props;
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-x-2">
        <span className="min-w-0 truncate text-2xl font-bold tracking-tight">
          {track ? track.title : "未在播放"}
        </span>
        {track && <SourceTag platform={props.cross?.target ?? track.platform} />}
      </div>
      {track ? (
        // 歌手在前（音乐 App 惯例），专辑可选展示，用「·」分隔替代全角空格；
        // 两段都可收缩截断，长专辑名不再把歌手名挤出视野
        <div className="mt-2 flex min-w-0 items-center gap-x-2 text-sm text-muted-foreground">
          <span className="min-w-0 truncate">{track.singer}</span>
          {track.album && (
            <>
              <span className="shrink-0 text-muted-foreground/50">·</span>
              <span className="min-w-0 truncate">{track.album}</span>
            </>
          )}
        </div>
      ) : (
        <div className="mt-1 text-sm text-muted-foreground">
          去搜索页找一首歌开始播放
        </div>
      )}
    </div>
  );
}

/**
 * 歌名右侧的当前音源徽标：换源后就地替换了 track，所以 track.platform 就是「现在实际在播的音源」。
 * 用注册表里的音源色做淡色底（未知源兜底中性灰），不抢标题的视觉重心。
 */
function SourceTag(props: { platform: string }): React.JSX.Element {
  const label = useSourceLabel(props.platform);
  const color = useSourceColor(props.platform);
  return (
    <span
      className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium leading-none"
      style={{
        color,
        backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)`,
      }}
      title={`当前音源：${label}`}
    >
      {label}
    </span>
  );
}

function CenterText(props: { text: string }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      {props.text}
    </div>
  );
}

/**
 * 单个词的卡拉 OK 染色：按「该词已唱过的比例」用横向渐变填充。
 *
 * 为什么用渐变而不是切 color：词内进度是连续的（一个字唱 270ms，中途就该
 * 是半边染色），切 color 只能整词跳色，观感与主流播放器的逐字不一样。
 * `background-clip:text` + 透明字色是这里唯一能实现「文字被渐变填充」的写法。
 *
 * 高亮侧必须写 `var(--lyric-highlight)`，绝不能用 `currentColor`：本元素已经
 * `color: transparent`（background-clip 的前提），`currentColor` 会解析成同一
 * 元素自己的 color（= 透明）——「已唱过」的半边会整段隐形，字边唱边消失、
 * 唱完整词跳回高亮，2026-10-06 修的就是这个 bug。
 * 渐变统一覆盖 0%~100%，不再按 pct 分支：pct=0 整词 inactive（未开唱的词
 * 不该亮——老实现 pct<=0 时不给样式，继承了整行高亮色，整行看起来全亮）、
 * pct=100 整词高亮、中间半边填充，一条公式三个状态全对。
 */
function KaraokeWord(props: { word: LyricWord; elapsedMs: number }): React.JSX.Element {
  const { word, elapsedMs } = props;
  // 词的起点相对行首，所以要减掉再比时长
  const passed = elapsedMs - word.startMs;
  const raw = word.durationMs > 0 ? passed / word.durationMs : passed >= 0 ? 1 : 0;
  const ratio = raw < 0 ? 0 : raw > 1 ? 1 : raw;
  const pct = Math.round(ratio * 100);
  return (
    <span
      style={{
        backgroundImage: `linear-gradient(90deg, var(--lyric-highlight) ${pct}%, var(--lyric-inactive) ${pct}%)`,
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        color: "transparent",
      }}
    >
      {word.text}
    </span>
  );
}

/**
 * 歌词滚动区：当前行高亮居中。整行可点击 —— 点击任意歌词行跳转到该行
 * 对应的进度（主流播放器标配；无时间戳的行不响应）。
 *
 * 2026-10-06：有逐字数据（音源包 `wordByWord`）时当前行按词染色（卡拉 OK），
 * 没有就照旧整行高亮 —— 逐字是装饰面，取不到必须完全不影响原来的显示。
 */
function LyricScroller(props: {
  lines: LyricLine[];
  activeIndex: number;
  onSeekMs: (ms: number) => void;
  /** 当前播放位置（毫秒，已减去歌词偏移）；逐字染色按它推进（暂停时它自然冻结） */
  positionMs: number;
}): React.JSX.Element {
  const { lines, activeIndex, onSeekMs, positionMs } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    const el = itemRefs.current[activeIndex];
    const container = containerRef.current;
    if (!el || !container) return;
    // offsetTop 量的是相对最近定位祖先（容器已设 relative）的距离；
    // 容器不定位的话会把上方曲目信息区的高度也计入，滚动过头、当前行偏上。
    const target =
      el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2;
    container.scrollTo({ top: target, behavior: "smooth" });
  }, [activeIndex]);

  return (
    <div
      ref={containerRef}
      className="relative h-full overflow-y-auto scroll-smooth px-8 [mask-image:linear-gradient(to_bottom,transparent,black_15%,black_85%,transparent)]"
    >
      <div className="mx-auto flex max-w-xl flex-col gap-5 py-[40%]">
        {lines.map((line, i) => (
          <div
            key={i}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            role={line.timeMs >= 0 ? "button" : undefined}
            tabIndex={line.timeMs >= 0 ? 0 : undefined}
            onClick={line.timeMs >= 0 ? () => onSeekMs(line.timeMs) : undefined}
            onKeyDown={
              line.timeMs >= 0
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSeekMs(line.timeMs);
                    }
                  }
                : undefined
            }
            className={cn(
              "text-center transition-all duration-300",
              line.timeMs >= 0
                ? "cursor-pointer hover:text-lyric-highlight/70 focus-visible:outline-none"
                : "",
              i === activeIndex
                ? "scale-105 text-xl font-semibold text-lyric-highlight"
                : "text-base text-lyric-inactive",
            )}
          >
            {i === activeIndex && line.words !== undefined && line.words.length > 0 ? (
              // 逐字（卡拉 OK）：当前行按「已唱到的比例」逐词染色。
              // 用 background-clip:text 的横向渐变做「填充」而不是改 color，
              // 才能让**单个字**唱到一半时半边染色（整词跳色的观感不对）。
              <div>
                {line.words.map((w, wi) => (
                  <KaraokeWord
                    key={wi}
                    word={w}
                    elapsedMs={positionMs - line.timeMs}
                  />
                ))}
              </div>
            ) : (
              <div>{line.text || "…"}</div>
            )}
            {line.romanization && (
              <div
                className={cn(
                  "mt-0.5 text-xs",
                  i === activeIndex
                    ? "text-lyric-highlight/60"
                    : "text-lyric-inactive/50",
                )}
              >
                {line.romanization}
              </div>
            )}
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
