import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Ban, Copy, Disc3, Download, Heart, ListEnd, Play, RefreshCw, User, X } from "lucide-react";
import type { Track } from "@/types";
import { qtresCoverUrl, formatTime } from "@/lib/lrc";
import { usePlayerStore } from "@/stores/player";
import { trackDbId, useDownloadsStore } from "@/stores/downloads";
import { useDislikesStore } from "@/stores/dislikes";
import { useDislikeFlags } from "@/hooks/useDislikeFlags";
import { useFavoritesStore } from "@/stores/favorites";
import { useFavoriteFlags } from "@/hooks/useFavoriteFlags";
import { useTrackSelection } from "@/hooks/useTrackSelection";
import type { TrackSelection } from "@/lib/track-selection";
import { EmptyState } from "@/components/common/EmptyState";
import { toastError, toastSuccess } from "@/stores/toast";
import { clampQualityForPlatform } from "@/stores/sourceRegistry";
import { sourceDownloadQualityOf } from "@/lib/source-quality";
import * as ipc from "@/services/ipc";
import { errMsg } from "@/lib/utils";
import { CollectButton } from "../mine/CollectButton";
import { CollectMenu } from "../mine/CollectMenu";
import { DownloadButton } from "../mine/DownloadButton";
import { SourceSwitchPanel } from "../player/SourceSwitchPanel";
import { LocalCover } from "../library/LocalCover";
import { RowActions } from "../common/RowActions";
import { SourceTag } from "../common/SourceTag";
import { IconButton } from "../common/IconButton";
import { PlayNextIcon } from "../common/PlayNextIcon";
import { ContextMenu, FloatingPanel, type ContextMenuItem } from "../common/ContextMenu";

/**
 * 曲目列表（发现类页面共用：榜单详情 / 歌单详情 / 新歌速递 / 收藏 / 历史 / 本地）。
 * 点击整行走 `play(track)`：把这一首加入播放列表并播放 —— 队里已有它就播原来那条，
 * 否则追加到队尾；**不清空**正在排队的整张列表。整体入队（替换队列）只在页面顶部的
 * 「播放全部」按钮上（`playQueue(tracks, 0)`，DESIGN §11.2 的列表播放语义）。
 *
 * 传了 `onRemove` 时每行右侧出现「移除」按钮（可编辑列表用，如播放记录的
 * 「从播放记录移除」）；为此行容器用 `div[role=button]` 而非 `button`，避免按钮嵌套。
 * 行上右键另出上下文菜单（REQUIREMENTS §3.21.7.1 的十项动作）：播放 / 下一首播放 /
 * 加入队列 / 收藏到歌单 / 下载 / 换源 / 复制歌曲信息 / 查看歌手·专辑 / 从歌单移除。
 * 低频动作收进右键菜单而不是全摊成行内图标 —— 一行已经要塞序号、封面、歌名、
 * 歌手、专辑、时长、队列、屏蔽、下载、收藏，再摊开就是一片认不出的图标。
 * 菜单里的「从歌单移除」只在调用方传了 `onRemove` 时出现。
 *
 * 队列 2.0：悬停行会露出「下一首播放」「加入队列」；已下载的曲目带「已下载」标。
 * 本地曲库页传 `local` 进入本地模式：悬停按钮用「播放」代替「下一首播放」，
 * 行尾出现「在文件夹中显示 / 删除」，需要时可带行首复选框做批量选择。
 * 这两个动作的图标必须能一眼区分：本地模式是 Play（就是播放），其余列表是
 * PlayNextIcon（播放三角 + 回车形，插到这首后面）。若两处都用 Play，
 * 用户会以为那个按钮是「播放」。
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
  selection?: TrackSelection;
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
  /**
   * 移除按钮的提示文案。默认「从歌单移除」；历史页传「从播放记录移除」——
   * 同一个 × 按钮在不同页面含义不同，悬停提示必须是当前页面的那个动作。
   */
  removeLabel?: string;
  /** 为 true 时每行右侧出现「收藏」（点开是本地歌单清单，与播放条红心同逻辑） */
  showCollect?: boolean;
  /** 为 true 时每行右侧出现「下载」 */
  showDownload?: boolean;
  /**
   * 批量选择（对**所有行**生效）：传入后每行行首出现复选框，
   * 歌单详情等混合列表的批量管理用。`local.selection` 是旧入口，仅本地曲库页继续沿用。
   */
  selection?: TrackSelection;
  /**
   * 本地行专属配置（plainRow / onChanged / onError 只对 `platform === "local"` 的行生效）。
   */
  local?: LocalListOptions;
  /**
   * 每行的补充说明（如每日推荐的「推荐理由」）。
   *
   * 用「按曲目取」的函数而不是 `Map`：调用方几乎都是现造箭头函数，函数本身
   * 每次渲染都换引用会让 `memo` 白做；而 `TrackRow` 只在**自己这行**调用它，
   * 传下去的是同一份 `Track`，`memo` 的浅比较仍然命中（调用方要用 `useCallback`
   * 包一下，`DailyRecommendPage` 已这么做）。
   */
  reasonOf?: (track: Track) => string | undefined;
}): React.JSX.Element {
  const {
    tracks,
    showIndex = false,
    onRemove,
    removeLabel = "从歌单移除",
    showCollect = false,
    showDownload = false,
    selection: selectionProp,
    local,
    reasonOf,
  } = props;
  const selection = selectionProp ?? local?.selection;
  const { keyOf, select, selectAll, clear } = useTrackSelection(tracks, selection);
  // 本地曲库页的朴素行：无封面、无下载标记（对齐下载管理的行模板）
  const plainRow = local?.plainRow === true;
  const play = usePlayerStore((s) => s.play);
  const currentTrackId = usePlayerStore((s) => s.state?.trackId ?? null);
  const downloaded = useDownloadsStore((s) => s.downloaded);
  const active = useDownloadsStore((s) => s.active);
  const rulesVersion = useDislikesStore((s) => s.version);
  // 哪些行中了屏蔽规则：一次 IPC 查整张列表（判定规则在 Rust 侧，前端猜不出来）
  const dislikeFlags = useDislikeFlags(tracks, rulesVersion);
  const favoritesVersion = useFavoritesStore((s) => s.version);
  // 哪些行已被收藏：同样一次 IPC 查整张列表，行尾红心据此点亮
  const favoriteFlags = useFavoriteFlags(tracks, favoritesVersion);

  /**
   * 回调放 ref、只暴露 `useCallback` 包出来的稳定引用：调用方（各页面）几乎都在
   * 渲染期现造箭头函数（`onRemove={(t) => void remove(t)}`），直接透传会让
   * `memo` 每次都失效，等于白 memo。ref 在提交后同步（点击必然晚于提交），
   * 所以行为与直接调用调用方回调完全一致。
   */
  const latest = useRef({
    onRemove,
    onChanged: local?.onChanged,
    onError: local?.onError,
  });
  useEffect(() => {
    latest.current = {
      onRemove,
      onChanged: local?.onChanged,
      onError: local?.onError,
    };
  });
  const handleRemove = useCallback((t: Track) => latest.current.onRemove?.(t), []);
  const handleChanged = useCallback(() => latest.current.onChanged?.(), []);
  const handleError = useCallback((msg: string) => latest.current.onError?.(msg), []);
  // 行Hover 一屏通常没有几条不同的 suspicion, 但 Hover 回调必须落到 set-ipc 上
  const banSong = useDislikesStore((s) => s.banSong);
  const banSinger = useDislikesStore((s) => s.banSinger);
  const unbanSong = useDislikesStore((s) => s.unbanSong);
  const handleDislikeError = useCallback((msg: string) => {
    latest.current.onError?.(msg);
  }, []);
  const handleBanSong = useCallback(
    (t: Track) => {
      banSong(t).catch((err) => handleDislikeError(errMsg(err)));
    },
    [banSong, handleDislikeError],
  );
  const handleBanSinger = useCallback(
    (singer: string) => {
      banSinger(singer).catch((err) => handleDislikeError(errMsg(err)));
    },
    [banSinger, handleDislikeError],
  );
  const handleUnban = useCallback(
    (t: Track) => {
      unbanSong(t)
        .then((ok) => {
          if (!ok) {
            // 重启后 / 换设备进了同一个账号的心净列表 → 本地查不到规则 id
            latest.current.onError?.("这条屏蔽规则不在这台设备上（请在设置页管理）");
          }
        })
        .catch((err) => handleDislikeError(errMsg(err)));
    },
    [unbanSong, handleDislikeError],
  );

  // 行 key：`身份#第几次出现`。以前是 `身份-下标`——切排序（艺人页的
  // TrackSortSelect 会对全量列表重排）时下标全变，所有行 key 一起变，整表
  // unmount/remount（可见闪烁 + 重挂载卡顿）。带上出现序号是为了兼容
  // 「聚合列表里同一首歌出现多次」的情况，避免重复 key 让 React 复用错行
  // （评审 2026-10-29）。
  const rowKeys = useMemo(() => {
    const seen = new Map<string, number>();
    return tracks.map((t) => {
      const dbId = trackDbId(t);
      const occurrence = seen.get(dbId) ?? 0;
      seen.set(dbId, occurrence + 1);
      return `${dbId}#${occurrence}`;
    });
  }, [tracks]);

  if (tracks.length === 0) {
    return (
      <EmptyState
        icon={Disc3}
        title="暂无歌曲"
        className="px-4"
      />
    );
  }

  return (
    <div
      role="group"
      aria-label="歌曲列表"
      onKeyDown={(e) => {
        // 输入框和行内动作保留自身键盘语义；快捷键只在行本身获得焦点时生效。
        if (e.target instanceof HTMLElement && e.target.dataset.trackRow === "true") {
          if (selection && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
            e.preventDefault();
            selectAll();
          } else if (selection && e.key === "Escape") {
            e.preventDefault();
            clear();
          }
        }
      }}
    >
      {tracks.map((t, i) => {
        const dbId = trackDbId(t);
        const isDownloaded = downloaded.has(dbId);
        return (
          <TrackRow
            key={rowKeys[i]}
            track={t}
            index={i}
            active={currentTrackId === t.id}
            downloaded={isDownloaded}
            downloading={!isDownloaded && active.has(dbId)}
            disliked={dislikeFlags[i] === true}
            favorited={favoriteFlags[i] === true}
            showIndex={showIndex}
            plainRow={plainRow}
            // 本地行：悬停按钮换成「播放」，行尾带定位 / 删除
            localRow={local !== undefined && t.platform === "local"}
            onBanSong={handleBanSong}
            onBanSinger={handleBanSinger}
            onUnban={handleUnban}
            showCollect={showCollect}
            showDownload={showDownload}
            selectable={selection !== undefined}
            selected={selection?.ids.has(keyOf(t)) === true}
            onSelect={select}
            // 注意：onRemove 传下去的是**稳定化的包装函数**（恒为函数），
            // 是否需要「移除」按钮必须由这个布尔决定，不能判 onRemove 是否存在
            showRemove={onRemove !== undefined}
            onRemove={handleRemove}
            removeLabel={removeLabel}
            onChanged={handleChanged}
            onError={handleError}
            play={play}
            reason={reasonOf?.(t)}
          />
        );
      })}
    </div>
  );
}

interface TrackRowProps {
  track: Track;
  index: number;
  /**
   * 整个列表（保留仅为 `memo` 的引用稳定性：点击整行只播这一首，不再整列表入队）。
   */
  tracks?: Track[];
  active: boolean;
  downloaded: boolean;
  downloading: boolean;
  showIndex: boolean;
  plainRow: boolean;
  localRow: boolean;
  /** 这一行是否命中了屏蔽规则（淡化显示 + 行尾按钮变「取消屏蔽」） */
  disliked: boolean;
  /** 这一行是否已被收藏（行尾红心实心高亮） */
  favorited: boolean;
  /** 屏蔽这首歌 */
  onBanSong: (track: Track) => void;
  /** 屏蔽这首歌的歌手（整串歌手一起） */
  onBanSinger: (singer: string) => void;
  /** 取消这首的屏蔽 */
  onUnban: (track: Track) => void;
  showCollect: boolean;
  showDownload: boolean;
  /** 选择状态按行传标量，切换一项不重绘整张列表。 */
  selectable: boolean;
  selected: boolean;
  onSelect: ReturnType<typeof useTrackSelection>["select"];
  showRemove: boolean;
  onRemove: (track: Track) => void;
  /** 移除按钮的悬停提示（历史页与歌单页含义不同，文案由调用方给） */
  removeLabel: string;
  onChanged: () => void;
  onError: (msg: string) => void;
  play: (track: Track) => Promise<void>;
  /** 行内补充说明（每日推荐的推荐理由）；空则不渲染 */
  reason?: string;
}

const TrackRow = memo(function TrackRow(props: TrackRowProps): React.JSX.Element {
  const {
    track: t,
    index: i,
    active: activeRow,
    downloaded: isDownloaded,
    downloading: isDownloading,
    showIndex,
    plainRow,
    localRow,
    disliked,
    favorited,
    onBanSong,
    onBanSinger,
    onUnban,
    showCollect,
    showDownload,
    selectable,
    selected,
    onSelect,
    showRemove,
    onRemove,
    removeLabel,
    onChanged,
    onError,
    play,
    reason,
  } = props;
  const navigate = useNavigate();
  const cover = qtresCoverUrl(t.picUrl);
  /** 右键菜单的位置（鼠标坐标）；`null` = 没开 */
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  /**
   * 菜单里「收藏到歌单…」「换源…」要就地换成面板，位置沿用刚才那个坐标。
   * 面板状态挂在**行**上而不是菜单组件里：菜单点完就卸载，若面板由菜单自己渲染，
   * 它随菜单一起消失，面板永远开不出来。
   */
  const [panel, setPanel] = useState<{
    kind: "collect" | "switch";
    x: number;
    y: number;
  } | null>(null);

  /** 歌手 / 专辑跳转（行内文字按钮与右键菜单共用一份，避免两处口径漂移） */
  const openArtist = (): void => {
    void navigate({
      to: "/artist/$platform/$id",
      params: { platform: t.platform, id: encodeURIComponent(t.singer) },
    });
  };
  const openAlbum = (): void => {
    void navigate({
      to: "/album/$platform/$id",
      params: { platform: t.platform, id: encodeURIComponent(t.album) },
    });
  };
  /** 复制「歌名 - 歌手 - 专辑」到剪贴板：分享/报错时最常要的就是这一行 */
  const copyInfo = (): void => {
    const text = [t.title, t.singer, t.album].filter((s) => s !== "").join(" - ");
    navigator.clipboard.writeText(text).then(
      () => toastSuccess("已复制歌曲信息"),
      (err) => toastError(`复制失败：${errMsg(err)}`),
    );
  };
  /** 下载：与行尾 DownloadButton 同一套「用户偏好质量 → 按平台收敛」 */
  const download = (): void => {
    void (async () => {
      try {
        const wanted = sourceDownloadQualityOf(t.platform);
        await ipc.startDownload(t, clampQualityForPlatform(t.platform, wanted));
        toastSuccess("加入下载队列成功");
      } catch (err) {
        toastError(`下载发起失败：${errMsg(err)}`);
      }
    })();
  };

  /**
   * 右键菜单项。按需求口径是十项动作，落地时有两条合并/取舍：
   *  - 「加入歌单」与「收藏」在本应用是同一件事：收藏必须挂在某个歌单下
   *    （`cmd_add_favorite` 没有默认歌单，不给 pid 直接报错），所以合并成
   *    一项「收藏到歌单…」，点开就是既有的 `CollectMenu`（勾选 / 取消多个歌单、
   *    新建歌单、同名不同源查重都在里面）—— 与播放条红心共用同一份逻辑。
   *  - 「换源」开既有的 `SourceSwitchPanel`，选中即播放：行上没有「当前曲目」的
   *    概念（右键的是列表里某一首，未必是正在播的那首），所以这里是「换源播放」，
   *    而不是播放条那种「就地替换正在播的这首」。
   * 本地曲目没有在线音源，下载 / 换源 / 查看歌手专辑都不适用，直接不出现在菜单里。
   */
  const buildMenu = (x: number, y: number): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      { key: "play", label: "播放", icon: Play, onSelect: () => void play(t) },
      {
        key: "next",
        label: "下一首播放",
        icon: PlayNextIcon,
        onSelect: () => {
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
        onSelect: () => {
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
        onSelect: () => setPanel({ kind: "collect", x, y }),
      },
      {
        key: "download",
        label: "下载",
        icon: Download,
        disabled: localRow,
        onSelect: download,
      },
      {
        key: "switch",
        label: "换源…",
        icon: RefreshCw,
        disabled: localRow,
        onSelect: () => setPanel({ kind: "switch", x, y }),
      },
      { key: "copy", label: "复制歌曲信息", icon: Copy, onSelect: copyInfo },
      {
        key: "artist",
        label: "查看歌手",
        icon: User,
        disabled: localRow || t.singer === "",
        onSelect: openArtist,
      },
      {
        key: "album",
        label: "查看专辑",
        icon: Disc3,
        disabled: localRow || t.album === "",
        onSelect: openAlbum,
      },
    ];
    // 「从歌单移除」只在可编辑列表里出现，且与上面那组动作分开一格
    if (showRemove) {
      items.push({
        key: "remove",
        label: removeLabel,
        icon: X,
        danger: true,
        separatorBefore: true,
        onSelect: () => onRemove(t),
      });
    }
    return items;
  };

  return (
    <div
      role="button"
      data-track-row="true"
      tabIndex={0}
      aria-pressed={selectable ? selected : undefined}
      aria-keyshortcuts={selectable ? "Control+Space Meta+Space Shift+Space Control+A Meta+A Escape" : undefined}
      onClick={(e) => {
        if (!onSelect(i, e)) void play(t);
      }}
      onKeyDown={(e) => {
        // 子按钮 / 复选框的 Enter 和 Space 不能冒泡成整行播放。
        if (e.target !== e.currentTarget) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
          e.preventDefault();
          const rows = Array.from(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>("[data-track-row='true']") ?? []);
          const nextIndex = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : i + (e.key === "ArrowDown" ? 1 : -1);
          const next = rows[nextIndex];
          if (next) {
            // 先记住出发点：第一次 Shift+方向键也能包含原先聚焦的那行。
            if (e.shiftKey) {
              onSelect(i, e, "anchor");
              onSelect(nextIndex, e);
            }
            next.focus();
          }
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (!onSelect(i, e)) void play(t);
        }
      }}
      // 右键出上下文菜单（低频动作的收纳处）。必须 preventDefault：默认菜单会
      // 顶掉它，且 WebView 里不拦的话整个应用像"没接住"这一下。
      onContextMenu={(e) => {
        e.preventDefault();
        setCtx({ x: e.clientX, y: e.clientY });
      }}
      className={`cv-row group flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-secondary focus-visible:bg-secondary focus-visible:outline-none ${
        selected ? "bg-primary/10 ring-1 ring-inset ring-primary/25" : activeRow ? "bg-secondary/60" : ""
        // 被屏蔽的行压暗：还能点、还能播（规则只是「别自动出现」），
        // 但要让人一眼看出它不在常规轮换里
      } ${disliked ? "opacity-40" : ""}`}
    >
      {/* 左侧固定槽位：批量选择时放复选框，否则放序号 / 播放态均衡条。
          复选框放在槽位里（而不是另起一列），否则槽位空着还要多占一份
          行间距，复选框到歌名会拉开近 50px。
          榜单 / 每日新歌是「带名次的列表」，勾选框和名次都要看得见，所以
          两者同时要的时候把槽位加宽到 w-12 并排摆（只多占 24px），
          而不是让复选框把名次顶掉。 */}
      <span
        className={`flex h-5 shrink-0 items-center justify-center gap-1.5 text-xs tabular-nums text-muted-foreground ${
          selectable && showIndex ? "w-12" : "w-6"
        }`}
      >
        {selectable ? (
          <input
            type="checkbox"
            checked={selected}
            aria-label={`选择 ${t.title}`}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(i, e, true);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                onSelect(i, e, true);
              }
            }}
            // 选择在 click / keydown 提交，保留受控输入的 change 接口。
            onChange={() => {}}
            className="h-3.5 w-3.5 accent-primary"
          />
        ) : null}
        {showIndex ? (
          i + 1
        ) : selectable ? null : activeRow ? (
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
          {/* 平台简称：本地曲目由 SourceTag 自己判空（本地没有"平台"可言） */}
          <SourceTag platform={t.platform} size="xs" />
          {!plainRow && isDownloaded && (
            <span className="shrink-0 rounded bg-primary/15 px-1 py-px text-3xs text-primary">
              已下载
            </span>
          )}
          {!plainRow && isDownloading && (
            <span className="shrink-0 rounded bg-secondary px-1 py-px text-3xs text-muted-foreground">
              下载中
            </span>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          {/* 歌手 / 专辑可点进对应页面（曲目上只有歌手名没有歌手 id，这里是名字搜索闭环：
               ArtistPage 没有 ?name= 时把 $id 位置的名字当名字用、不传 id）。
              本地曲目不走在线搜索，退化成纯文本。 */}
          {t.singer ? (
            t.platform === "local" ? (
              <span className="truncate">{t.singer}</span>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  openArtist();
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
                    openAlbum();
                  }}
                  className="truncate transition-colors hover:text-foreground hover:underline"
                >
                  {t.album}
                </button>
              )}
            </>
          ) : null}
        </div>
        {/* 推荐理由（每日推荐页）：单独一行、字号更小，不与「歌手 · 专辑」抢同一行。
            只有调用方传了 `reasonOf` 才有值，其它页面不渲染任何多余节点。 */}
        {reason ? (
          <p className="mt-0.5 truncate text-2xs text-muted-foreground/80">{reason}</p>
        ) : null}
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
              void play(t);
            } else {
              // 队列动作对界面没有任何可见变化（不切歌、列表也不动），给一条
              // 绿勾回执，不然用户会怀疑刚才那下点了没
              void ipc.queueAddNext(t).then(
                () => toastSuccess(`已将「${t.title}」设为下一首播放`),
                (err) => toastError(`加入下一首播放失败：${errMsg(err)}`),
              );
            }
          }}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
        >
          {/* 本地模式这个按钮就是「播放」，用 Play；其余列表是「下一首播放」，
              用 PlayNextIcon（播放三角 + 回车形 = 插到这首后面）。原先两处都用
              Play，和「播放」完全同形，看不出是「下一首」。 */}
          {localRow ? (
            <Play className="h-3.5 w-3.5" />
          ) : (
            <PlayNextIcon className="h-3.5 w-3.5" />
          )}
        </button>
        <button
          type="button"
          title="加入播放队列"
          aria-label="加入播放队列"
          onClick={(e) => {
            e.stopPropagation();
            void ipc.queueAppend([t]).then(
              () => toastSuccess(`已将「${t.title}」加入播放队列`),
              (err) => toastError(`加入播放队列失败：${errMsg(err)}`),
            );
          }}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
        >
          <ListEnd className="h-3.5 w-3.5" />
        </button>
        {/* 屏蔽：已命中规则时按钮变成「取消屏蔽」，让上一次误操作能就地回滚。
            屏蔽歌手的入口藏在 alt 点击里 —— 行已经很挤了，而屏蔽歌手是不可逆的
            重操作，给它一个裸露按钮会让人手滑。 */}
        <button
          type="button"
          title={disliked ? "取消屏蔽" : "屏蔽这首歌"}
          aria-label={disliked ? "取消屏蔽" : "屏蔽这首歌"}
          data-testid={disliked ? "row-unban" : "row-ban"}
          onClick={(e) => {
            e.stopPropagation();
            if (disliked) {
              onUnban(t);
            } else if (e.altKey && t.singer) {
              onBanSinger(t.singer);
            } else {
              onBanSong(t);
            }
          }}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
        >
          <Ban className="h-3.5 w-3.5" />
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
      {showCollect && <CollectButton track={t} favorited={favorited} />}
      {showRemove ? (
        <IconButton
          label={removeLabel}
          danger
          onClick={(e) => {
            e.stopPropagation();
            onRemove(t);
          }}
        >
          <X />
        </IconButton>
      ) : null}
      {/* 菜单 / 面板都 portal 到 body（见 common/ContextMenu）：列表滚动容器是
          overflow-y-auto，挂在行里会被裁掉 */}
      {ctx ? (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={buildMenu(ctx.x, ctx.y)}
          onClose={() => setCtx(null)}
        />
      ) : null}
      {panel?.kind === "collect" ? (
        <FloatingPanel x={panel.x} y={panel.y} width={240} onClose={() => setPanel(null)}>
          <CollectMenu
            track={t}
            onClose={() => setPanel(null)}
            className="rounded-xl border border-border bg-popover/95 p-1 backdrop-blur-xl shadow-raised"
          />
        </FloatingPanel>
      ) : null}
      {panel?.kind === "switch" ? (
        <FloatingPanel x={panel.x} y={panel.y} width={404} onClose={() => setPanel(null)}>
          <div className="rounded-xl border border-border bg-popover/95 backdrop-blur-xl p-3 text-popover-foreground shadow-raised">
            <SourceSwitchPanel
              track={t}
              onPick={(candidate) => {
                setPanel(null);
                void play(candidate);
              }}
            />
          </div>
        </FloatingPanel>
      ) : null}
    </div>
  );
});
