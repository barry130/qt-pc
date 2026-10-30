import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  Ban,
  Bug,
  ChevronDown,
  Clipboard,
  Copy,
  Disc3,
  FileText,
  FolderOpen,
  Hash,
  Heart,
  Image as ImageIcon,
  Link2,
  ListEnd,
  MonitorPlay,
  RefreshCw,
  RotateCcw,
  Search,
  ThumbsDown,
  User,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { Lyric, Track } from "@/types";
import { usePlayerStore } from "@/stores/player";
import { isAdmin, useAuthStore } from "@/stores/auth";
import { useInterpolatedPosition } from "@/hooks/useInterpolatedPosition";
import {
  crossSourceForPlayback,
  getPlaybackLyric,
  type CrossSourceHit,
} from "@/lib/localOnline";
import { useLyricOffset } from "@/hooks/useLyricOffset";
import {
  LYRIC_FONT_SIZE_DEFAULT,
  LYRIC_FONT_SIZE_MAX,
  LYRIC_FONT_SIZE_MIN,
  LYRIC_FONT_SIZE_STEP,
  useLyricFontSize,
} from "@/hooks/useLyricFontSize";
import { useNowPlayingCover } from "@/hooks/useNowPlayingLocalMedia";
import { LyricFontSizeControl } from "@/components/lyric/LyricFontSizeControl";
import { LyricOffsetControl } from "@/components/lyric/LyricOffsetControl";
import { LyricSearchButton } from "@/components/lyric/LyricSearchButton";
import {
  findActiveIndex,
  mergeRomanization,
  mergeTranslation,
  parseLrc,
  parseWordByWordLrc,
  type LyricLine,
} from "@/lib/lrc";
import { WindowControls } from "@/components/WindowControls";
import { SourceTag } from "@/components/common/SourceTag";
import { errMsg } from "@/lib/utils";
import { LyricScroller } from "@/components/player/LyricScroller";
import { ContextMenu, FloatingPanel, type ContextMenuItem } from "@/components/common/ContextMenu";
import { CollectMenu } from "@/components/mine/CollectMenu";
import { replaceCurrentWithCandidate, SourceSwitchPanel } from "@/components/player/SourceSwitchPanel";
import { PlayNextIcon } from "@/components/common/PlayNextIcon";
import { toastError, toastSuccess } from "@/stores/toast";
import { useDislikesStore } from "@/stores/dislikes";
import * as ipc from "@/services/ipc";

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

  /**
   * 右键菜单：坐标是鼠标位置，`null` = 没开。
   *
   * 播放页是整页区域（左侧唱片 + 右侧歌词），右键落在哪块都该是同一份菜单，
   * 所以监听挂在最外层容器上，而不是某个子组件上。
   */
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  /**
   * 菜单里「查看全部歌词 / 收藏到歌单… / 换源播放…」要就地换成面板，坐标沿用
   * 刚才那个。面板状态挂在**页面**上而不是菜单组件里：菜单点完即卸载，面板若由
   * 菜单渲染会跟着一起消失（与 TrackList 同一套处理）。
   */
  const [panel, setPanel] = useState<{
    kind: "collect" | "switch" | "lyric";
    x: number;
    y: number;
  } | null>(null);
  /** 本次实际在播的是不是本地文件（本地曲目 / 在线歌本地优先命中都算） */
  const isLocal = usePlayerStore((s) => s.state?.isLocal ?? false);
  /**
   * 「复制调试信息」只给管理员（持有 `admin:qt:admin`）看：摊平出来的 JSON 是
   * 内部排查用，与播放条「播放地址调试入口」同一道闸（`PlayerBar` 里的 isAdmin）。
   * 登录响应/profile 自带 permissions，未登录或无权限时这一项直接不出现在菜单里。
   */
  const profile = useAuthStore((s) => s.profile);
  const canDebug = isAdmin(profile);
  /**
   * 在播本地文件路径：本地曲目就是 `track.id`（引擎约定 id 即绝对路径），
   * 在线歌本地优先命中则菜单打开时现查一次（`resolve_local_file`，纯读盘）。
   */
  const [localPath, setLocalPath] = useState("");
  const [desktopLyricVisible, setDesktopLyricVisible] = useState(false);
  const [disliked, setDisliked] = useState(false);
  const singerBanned = useDislikesStore((s) =>
    track !== null && track.singer !== "" ? s.singerBanned(track.singer) : false,
  );
  /** 菜单里的异步项（本地路径 / 桌面歌词状态 / 是否已屏蔽）用最新曲目取值 */
  const trackRef = useRef(track);
  trackRef.current = track;
  const trackKeyNow = track === null ? "" : `${track.platform}:${track.id}`;

  /**
   * 一开菜单就并发把异步状态取回来：取不到（或还没回来）的项按「不可用」渲染，
   * 免得点下去什么都不发生。切歌后过期的结果直接丢弃（`stale`）。
   */
  useEffect(() => {
    if (ctx === null) return;
    const current = trackRef.current;
    if (current === null) {
      setLocalPath("");
      return;
    }
    let stale = false;
    const ownPath = current.platform === "local" ? current.id : "";
    setLocalPath(ownPath);
    if (ownPath === "") {
      void ipc.resolveLocalFile(current).then(
        (hit) => {
          if (!stale) setLocalPath(hit?.path ?? "");
        },
        () => {
          if (!stale) setLocalPath("");
        },
      );
    }
    void ipc.getDesktopLyricState().then(
      (st) => {
        if (!stale) setDesktopLyricVisible(st.visible === true);
      },
      () => {},
    );
    void ipc.checkDisliked([current]).then(
      (res) => {
        if (!stale) setDisliked(Array.isArray(res) && res[0] === true);
      },
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [ctx, trackKeyNow]);

  /** 复制到剪贴板：空内容早退（剪贴板里留着上一段旧文字比失败更误导） */
  const copyText = (text: string, okText: string): void => {
    if (text.length === 0) {
      toastError("没有可复制的内容");
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => toastSuccess(okText),
      (err) => toastError(`复制失败：${errMsg(err)}`),
    );
  };

  /** 当前「播放地址」：本地播放给出文件路径，在线播放给出实际取链地址 */
  const playAddr = (): string => (isLocal ? localPath : (playUrl ?? ""));

  /**
   * 调试信息：把「这一刻到底是什么在响」摊平成一段 JSON —— 播放页常被用来排查
   * 「放的是哪条链 / 是不是本地文件 / 歌词哪来的」，比逐个界面翻省事。
   */
  const debugText = (t: Track): string => {
    const st = usePlayerStore.getState().state;
    return JSON.stringify(
      {
        track: t,
        crossSource: cross?.target ?? null,
        quality,
        isLocal,
        localFile: localPath === "" ? null : localPath,
        playUrl: playUrl ?? null,
        urlFetchedAt: st?.urlFetchedAt ?? null,
        status: st?.status ?? null,
        durationMs: st?.durationMs ?? null,
        positionMs: Math.round(position),
        speed: st?.speed ?? null,
        bitrateKbps: st?.bitrateKbps ?? null,
        lyric: {
          lines: lines.length,
          offsetMs: lyricOffset.offsetMs,
          hasTranslation: translation.length > 0,
          hasWordByWord: wordByWord.length > 0,
          hasRomanization: romanization.length > 0,
        },
      },
      null,
      2,
    );
  };

  /** 右键菜单项（查看 / 复制 / 播放动作三组，分组线由 separatorBefore 画） */
  const buildMenu = (x: number, y: number): ContextMenuItem[] => {
    const t = track;
    const noTrack = t === null;
    const items: ContextMenuItem[] = [
      {
        key: "lyric-all",
        label: "查看全部歌词",
        icon: FileText,
        disabled: lrc.length === 0,
        onSelect: () => setPanel({ kind: "lyric", x, y }),
      },
      {
        key: "desktop-lyric",
        label: desktopLyricVisible ? "隐藏桌面歌词" : "显示桌面歌词",
        icon: MonitorPlay,
        onSelect: () => {
          const act = desktopLyricVisible ? ipc.hideDesktopLyric() : ipc.showDesktopLyric();
          void act.then(
            (st) => setDesktopLyricVisible(st.visible === true),
            (err) => toastError(`桌面歌词切换失败：${errMsg(err)}`),
          );
        },
      },
      // 歌词字号也放进右键菜单：菜单项只走一步（点了就收起），连点靠快捷键
      // Ctrl + = / −（面板里的滑杆负责快速定位）。
      {
        key: "font-up",
        label: "歌词字号变大",
        icon: ZoomIn,
        separatorBefore: true,
        disabled: lyricFontSize.px >= LYRIC_FONT_SIZE_MAX,
        onSelect: () => lyricFontSize.bump(LYRIC_FONT_SIZE_STEP),
      },
      {
        key: "font-down",
        label: "歌词字号变小",
        icon: ZoomOut,
        disabled: lyricFontSize.px <= LYRIC_FONT_SIZE_MIN,
        onSelect: () => lyricFontSize.bump(-LYRIC_FONT_SIZE_STEP),
      },
      {
        key: "font-reset",
        label: `重置歌词字号（${LYRIC_FONT_SIZE_DEFAULT}px）`,
        icon: RotateCcw,
        disabled: lyricFontSize.px === LYRIC_FONT_SIZE_DEFAULT,
        onSelect: () => lyricFontSize.reset(),
      },
      {
        key: "artist",
        label: "查看歌手",
        icon: User,
        // 本地曲目没有在线歌手页（与列表行同一口径）
        disabled: noTrack || t.platform === "local" || t.singer === "",
        onSelect: () => {
          if (t === null) return;
          void navigate({
            to: "/artist/$platform/$id",
            params: { platform: t.platform, id: encodeURIComponent(t.singer) },
          });
        },
      },
      {
        key: "album",
        label: "查看专辑",
        icon: Disc3,
        disabled: noTrack || t.platform === "local" || t.album === "",
        onSelect: () => {
          if (t === null) return;
          void navigate({
            to: "/album/$platform/$id",
            params: { platform: t.platform, id: encodeURIComponent(t.album) },
          });
        },
      },
      {
        key: "copy-info",
        label: "复制歌曲信息",
        icon: Copy,
        separatorBefore: true,
        disabled: noTrack,
        onSelect: () => {
          if (t === null) return;
          copyText(
            [t.title, t.singer, t.album].filter((s) => s !== "").join(" - "),
            "已复制歌曲信息",
          );
        },
      },
      {
        key: "copy-id",
        label: "复制歌曲 ID",
        icon: Hash,
        disabled: noTrack,
        onSelect: () => {
          if (t === null) return;
          // platform:id 是本地库的曲目主键（也是 resolve_local_file 的入参口径），
          // 有 musicId 时一并带上 —— 报「取链不对」时两串都需要
          const text = [`${t.platform}:${t.id}`, t.musicId ? `musicId=${t.musicId}` : ""]
            .filter((s) => s !== "")
            .join("  ");
          copyText(text, "已复制歌曲 ID");
        },
      },
      {
        key: "copy-cover",
        label: "复制封面地址",
        icon: ImageIcon,
        // 内嵌封面是 data URL（整段 base64），放进剪贴板没有意义，故只在有在线地址时可用
        disabled: noTrack || t.picUrl === "",
        onSelect: () => {
          if (t === null) return;
          copyText(t.picUrl, "已复制封面地址");
        },
      },
      {
        key: "copy-url",
        label: isLocal ? "复制本地文件路径" : "复制播放地址",
        icon: Link2,
        disabled: playAddr() === "",
        onSelect: () => copyText(playAddr(), isLocal ? "已复制本地文件路径" : "已复制播放地址"),
      },
      // 「复制歌词（含时间轴）」不再单独占一项：「查看全部歌词」面板里自带复制
      // 按钮（而且是 lrc+译文，更全），同一动作两个入口属于重复
      // （2026-10-29 用户反馈，删掉菜单项、保留面板）。
      // 「复制调试信息」只给管理员：摊平的 JSON 是内部排查用，与播放条
      // 「播放地址调试入口」同一道闸 —— 没权限的人连这一项都看不到。
      ...(canDebug
        ? [
            {
              key: "copy-debug",
              label: "复制调试信息",
              icon: Bug,
              disabled: noTrack,
              onSelect: () => {
                if (t !== null) copyText(debugText(t), "已复制调试信息");
              },
            },
          ]
        : []),
      {
        key: "next-play",
        label: "下一首播放",
        icon: PlayNextIcon,
        separatorBefore: true,
        disabled: noTrack,
        onSelect: () => {
          if (t === null) return;
          void ipc.queueAddNext(t).then(
            () => toastSuccess(`已将「${t.title}」设为下一首播放`),
            (err) => toastError(`加入下一首播放失败：${errMsg(err)}`),
          );
        },
      },
      {
        key: "queue",
        label: "加入播放队列",
        icon: ListEnd,
        disabled: noTrack,
        onSelect: () => {
          if (t === null) return;
          void ipc.queueAppend([t]).then(
            () => toastSuccess(`已将「${t.title}」加入播放队列`),
            (err) => toastError(`加入播放队列失败：${errMsg(err)}`),
          );
        },
      },
      {
        key: "collect",
        label: "收藏到歌单…",
        icon: Heart,
        separatorBefore: true,
        disabled: noTrack,
        onSelect: () => setPanel({ kind: "collect", x, y }),
      },
      {
        key: "switch",
        label: "换源播放…",
        icon: RefreshCw,
        disabled: noTrack || t.platform === "local",
        onSelect: () => setPanel({ kind: "switch", x, y }),
      },
      {
        key: "dislike-song",
        label: disliked ? "取消屏蔽这首歌" : "屏蔽这首歌",
        icon: ThumbsDown,
        danger: !disliked,
        separatorBefore: true,
        disabled: noTrack,
        onSelect: () => {
          if (t === null) return;
          const store = useDislikesStore.getState();
          if (disliked) {
            void store.unbanSong(t).then((ok) => {
              if (ok) setDisliked(false);
            });
          } else {
            void store.banSong(t).then((ok) => {
              if (ok) setDisliked(true);
            });
          }
        },
      },
      {
        key: "dislike-singer",
        label: singerBanned ? "取消屏蔽该歌手" : "屏蔽该歌手",
        icon: Ban,
        danger: !singerBanned,
        disabled: noTrack || t.singer === "",
        onSelect: () => {
          if (t === null) return;
          const store = useDislikesStore.getState();
          if (singerBanned) void store.unbanSinger(t.singer);
          else void store.banSinger(t.singer);
        },
      },
      {
        key: "reveal",
        label: "打开文件所在位置",
        icon: FolderOpen,
        separatorBefore: true,
        // 只有确实在放本地文件时才可用（在线曲目没有「文件位置」可言）
        disabled: localPath === "",
        onSelect: () => {
          if (localPath === "") return;
          void ipc
            .revealLocalTrack(localPath)
            .catch((err) => toastError(`打开文件位置失败：${errMsg(err)}`));
        },
      },
      {
        key: "offset-reset",
        label: `重置歌词偏移（当前 ${lyricOffset.offsetMs} ms）`,
        icon: RotateCcw,
        disabled: lyricOffset.offsetMs === 0,
        onSelect: () => {
          lyricOffset.reset();
          toastSuccess("歌词偏移已归零");
        },
      },
    ];
    return items;
  };

  // 换源兜底会把实际播放地址切到别的平台（playUrl 变化时命中线路记忆刚更新）：
  // 歌词必须跟着换到对应源重取，避免「放的是 kw 的音、显示的是 wyy 的词」
  const cross = useMemo(
    () => crossSourceForPlayback(track, quality),
    // 线路记忆不是响应式数据，靠 playUrl 变化触发重估（跨源兜底必然改地址）。
    // playUrl 是刻意的缓存失效触发器而非被读取的值，插件会误判为多余依赖，
    // 必须保留在依赖里。
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // 歌词字号：全局偏好（settings 表 lyric.fontSize），三个入口共用一份状态 ——
  // 面板滑杆/按钮、右键菜单、Ctrl + = / − / 0 快捷键。
  const lyricFontSize = useLyricFontSize();
  // effect 里只用到这两个稳定回调（内部 useCallback），解构出来给依赖数组一个稳定身份；
  // 直接写 lyricFontSize.bump 既不稳定也会被 eslint exhaustive-deps 判为缺 lyricFontSize。
  const bumpLyricFontSize = lyricFontSize.bump;
  const resetLyricFontSize = lyricFontSize.reset;
  const activeIndex = findActiveIndex(lines, position - lyricOffset.offsetMs);

  // 快捷键只在本页挂载期间生效：Ctrl/Cmd + = / + 变大，- / _ 变小，0 复位。
  // 不用 window.addEventListener 之外的分发（播放条上的全局快捷键走另一套）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      // 焦点在输入框里时不抢键：Ctrl+0 之类在搜索框/输入框里另有语义
      const target = event.target;
      if (
        target instanceof HTMLElement
        && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      ) {
        return;
      }
      switch (event.key) {
        case "=":
        case "+":
          event.preventDefault();
          bumpLyricFontSize(LYRIC_FONT_SIZE_STEP);
          return;
        case "-":
        case "_":
          event.preventDefault();
          bumpLyricFontSize(-LYRIC_FONT_SIZE_STEP);
          return;
        case "0":
          event.preventDefault();
          resetLyricFontSize();
          return;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bumpLyricFontSize, resetLyricFontSize]);

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
    <div
      className="flex h-full w-full"
      onContextMenu={(e) => {
        // 页内没有输入框，右键一律换成自家菜单（浏览器默认菜单里没有一处对播放有用）；
        // 菜单与面板在 portal 里且各自吞掉 contextmenu，不会二次触发这里
        e.preventDefault();
        setPanel(null);
        setCtx({ x: e.clientX, y: e.clientY });
      }}
    >
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
              <LyricFontSizeControl size={lyricFontSize} />
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
                key={key}
                lines={lines}
                activeIndex={activeIndex}
                onSeekMs={(ms) => void seekTo(ms + lyricOffset.offsetMs)}
                positionMs={position - lyricOffset.offsetMs}
                seekOffsetMs={lyricOffset.offsetMs}
                fontSize={lyricFontSize.px}
              />
            )}
          </div>
        </div>
      </div>

      {/* 搜索歌词弹层挂在偏移旁的按钮上（LyricSearchButton 自带 popover） */}

      {/* 播放页的歌词一直在自动滚（逐行高亮 + 用户拖动），菜单与跟随面板一律
          不因滚动收起 —— 否则刚点开就被下一行歌词的滚动带走（2026-10-29 用户
          反馈）；点外面 / Esc / 缩放照旧收起。 */}
      {ctx !== null ? (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={buildMenu(ctx.x, ctx.y)}
          onClose={() => setCtx(null)}
          closeOnScroll={false}
        />
      ) : null}
      {panel?.kind === "collect" && track !== null ? (
        <FloatingPanel
          x={panel.x}
          y={panel.y}
          width={240}
          onClose={() => setPanel(null)}
          closeOnScroll={false}
        >
          <CollectMenu
            track={track}
            onClose={() => setPanel(null)}
            className="rounded-xl border border-border bg-popover/95 p-1 backdrop-blur-xl shadow-raised"
          />
        </FloatingPanel>
      ) : null}
      {panel?.kind === "switch" && track !== null ? (
        <FloatingPanel
          x={panel.x}
          y={panel.y}
          width={404}
          onClose={() => setPanel(null)}
          closeOnScroll={false}
        >
          <div className="rounded-xl border border-border bg-popover/95 backdrop-blur-xl p-3 text-popover-foreground shadow-raised">
            <SourceSwitchPanel
              track={track}
              onPick={(candidate) => {
                setPanel(null);
                // 与播放条「换源」同一套：就地替换当前曲目，队列位置不动
                void replaceCurrentWithCandidate(candidate);
              }}
            />
          </div>
        </FloatingPanel>
      ) : null}
      {panel?.kind === "lyric" ? (
        <FloatingPanel
          x={panel.x}
          y={panel.y}
          width={420}
          onClose={() => setPanel(null)}
          closeOnScroll={false}
        >
          <LyricRawPanel
            lrc={lrc}
            translation={translation}
            lineCount={lines.length}
            onCopy={(text) => copyText(text, "已复制歌词")}
          />
        </FloatingPanel>
      ) : null}
    </div>
  );
}

/**
 * 「查看全部歌词」面板：把取到的原始 LRC（含时间轴）与译文一并摊开，
 * 顺带给一个复制入口 —— 歌词挂错版本时，用户可以直接把文本贴出来比对/反馈。
 */
function LyricRawPanel(props: {
  lrc: string;
  translation: string;
  lineCount: number;
  onCopy: (text: string) => void;
}): React.JSX.Element {
  const text =
    props.translation.length > 0 ? `${props.lrc}\n\n【译文】\n${props.translation}` : props.lrc;
  return (
    <div className="rounded-xl border border-border bg-popover/95 backdrop-blur-xl text-popover-foreground shadow-raised">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="text-xs text-muted-foreground">{props.lineCount} 行 · 原始歌词</span>
        <button
          type="button"
          onClick={() => props.onCopy(text)}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors hover:bg-secondary"
        >
          <Clipboard className="h-3.5 w-3.5" />
          复制
        </button>
      </div>
      <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-2xs leading-relaxed">
        {text}
      </pre>
    </div>
  );
}

/** 黑胶唱片风格旋转封面（仅播放时旋转） */
function VinylCover(props: { track: Track | null; playing: boolean }): React.JSX.Element {
  const { track, playing } = props;
  // 播放页封面最大显示 420px（clamp 上界），按 2× DPR 要 840 —— 传 900
  // 让 Rust 侧向上游要这个尺寸，而不是把 1.9MB 原图整张拉下来
  // 在播封面：内嵌优先、在线兜底（2× DPR 传 900 让 Rust 向上游要这个尺寸）
  const coverUrl = useNowPlayingCover(900);

  return (
    <div className="relative">
      {/* 封面色光晕：唱片不再浮在纯色上，与整窗背景同一色源 */}
      <div
        aria-hidden
        className="qt-cover-glow absolute -inset-10 rounded-full opacity-60 blur-3xl [mask-image:radial-gradient(circle,black_55%,transparent_75%)]"
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

function CenterText(props: { text: string }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      {props.text}
    </div>
  );
}
