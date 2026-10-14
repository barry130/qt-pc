import { useCallback, useEffect, useRef, useState } from "react";
import { Heart, Play } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { errMsg } from "@/lib/utils";
import type { Chart, MyPlaylistSummary, SourceId, Track } from "@/types";
import * as ipc from "@/services/ipc";
import * as sourceApi from "@/source-scripts";
import { qtresCoverUrl } from "@/lib/lrc";
import { usePlayerStore } from "@/stores/player";
import { useFavoritesStore } from "@/stores/favorites";
import { TrackList } from "./TrackList";
import { BatchBar } from "./BatchBar";
import { ErrorRetry, TrackRowsSkeleton } from "./Skeletons";
import { BackButton } from "@/components/layout/BackButton";
import { IconButton } from "@/components/common/IconButton";
import { useDismissOnOutside } from "@/hooks/useDismissOnOutside";

/**
 * 单首曲目的封面地址。在线曲目直接算 qtres:// 地址；本地曲目读音频内嵌封面
 * （Rust 转 data URL，没有则 null）。注意本地曲目也可能带 http 的 pic_url
 * （从在线列表收藏来的），所以先试 URL 再试内嵌封面。
 */
async function trackCover(track: Track): Promise<string | null> {
  const fromUrl = qtresCoverUrl(track.picUrl);
  if (fromUrl) return fromUrl;
  if (track.platform !== ipc.LOCAL_PLATFORM) return null;
  return ipc.getLocalCover(track.id).catch(() => null);
}

/** 三种「带一堆曲目的详情页」共用这一个组件的哪一支 */
export type DetailKind = "playlist" | "chart";

/**
 * 详情页（**本地歌单 / 在线歌单 / 榜单** 共用这一个页面）。
 *
 * 三条路由都落到这里，靠 `kind` + `platform === "local"` 分叉：
 * - `/playlist/$platform/$id`（kind=playlist）：在线歌单，曲目来自
 *   getPlaylistDetail（脚本层：wyy/qq 一次取全量；kw 内部分页）；
 * - `/my/playlist/$id`（kind=playlist，platform=local）：本地自建歌单，曲目来自
 *   getPlaylistTracks（挂在该 pid 下的收藏，liked_songs.pid，顺序即加入顺序）；
 * - `/chart/$platform/$id`（kind=chart）：榜单，曲目来自 getChartDetail。
 *
 * 合成一页是因为三者的**骨架**本来就一样：封面 + 标题 + 共 N 首 + 播放全部
 * + 页头右侧的批量条 + 曲目表。原先各写一份，于是本地歌单只有一行朴素的标题栏、没有封面，
 * 榜单页连封面和批量操作都没有，观感与在线歌单差一截。差异只在少数几处，
 * 都在下面显式分叉，不做静默取舍：
 * - 歌单级「收藏」红心只给歌单（榜单没有「收藏这个榜单」这个概念，不摆一颗
 *   点不动的红心占位）；且两颗来源点下去不是一回事：在线歌单是
 *   favoritePlaylist / unfavoritePlaylist（归属在音源，曲目不受影响）；
 *   本地歌单**恒为已收藏态**（红心常亮，不去查收藏位），取消收藏在语义上
 *   就是删掉整个歌单 —— 摘掉歌单等于把名下曲目的收藏一起摘干净，所以红心
 *   走两段式确认（先换文案 + 点别处撤回，第二下才真删），删完回「我的歌单」；
 * - 批量条三页共用（`BatchBar`），**摆在页头右侧、与「播放全部」同一行**
 *   （`embedded`，与列表之间不再有单独一行），收藏 / 取消收藏**与单曲红心同一套逻辑**：
 *   点开是本地歌单清单，整批都已在该歌单里 → 这一下是批量取消收藏
 *   （`remove_tracks_from_playlist`）；否则是批量收藏，**已在里面的自动跳过，
 *   只加缺的那些**（`add_tracks_to_playlist`，后端 `ON CONFLICT DO NOTHING`
 *   返回真实新增数）。没有独立的「批量取消收藏」按钮，也没有批量「整首取消」
 *   （跨所有歌单连坐）的入口 —— 那交给单曲红心。
 * - 榜单带名次（showIndex），歌单不带（曲目顺序本身就是它的信息）。
 *
 * 本地歌单没有行尾的「从歌单移除」X：本地歌单里的曲目**必然是收藏态**，
 * 所以「取消收藏」与「从歌单移除」是同一件事。留两个入口只会让人以为
 * 「取消收藏」不删歌单、X 才删。现在与在线歌单一样只有一颗收藏红心，
 * 取消勾选当前歌单即从本歌单移除（`CollectMenu` → `removeFavorite(track, pid)`），
 * 页面订阅 `stores/favorites` 的版本号静默重载，被摘掉的那行当场消失。
 * 批量移除走批量条，它有独立的 `removeTracksFromPlaylist`。
 *
 * 封面回退链（用户口径：**默认封面是最后兜底，不是第二选择**）：
 *   页面自己的封面 → 第一首曲目的封面 → 默认占位（标题首字）。
 * 所以「没设封面的歌单 / 没有配图的榜单」也能有张像样的图，只有一首歌都没有时
 * 才落回占位。两端取封面的方式不同：在线走 qtresCoverUrl(picUrl)，本地走 Rust
 * 转的 data URL（歌单封面 getPlaylistCover(pid)、曲目内嵌封面 getLocalCover(id)）。
 * 两者都是异步的，因此统一解析成一个 `cover` 字符串再喂给 hero 与模糊铺底。
 */
export function PlaylistDetailPage(props: {
  platform: string;
  id: string;
  /** 默认 playlist；`/chart/...` 传 "chart" */
  kind?: DetailKind;
}): React.JSX.Element {
  const { platform, id, kind = "playlist" } = props;
  const isChart = kind === "chart";
  const isLocal = !isChart && platform === ipc.LOCAL_PLATFORM;
  const playQueue = usePlayerStore((s) => s.playQueue);
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [description, setDescription] = useState<string | null>(null);
  /** 在线歌单的原始封面地址（歌单级收藏上送云端时要原样带上） */
  const [picUrl, setPicUrl] = useState("");
  const [playCount, setPlayCount] = useState("");
  const [tracks, setTracks] = useState<Track[]>([]);
  /** 解析后的封面（已走完回退链），null = 用默认占位 */
  const [cover, setCover] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  /**
   * 本次重载是否为「静默重载」（移除曲目后的刷新）。
   * 静默重载不清空列表、不切骨架屏，否则删一首歌整页闪一下，体验很跳。
   */
  const silentRef = useRef(false);
  /** 行级 / 批量操作的失败提示：与整页加载失败分开，别把已加载的列表顶掉 */
  const [actionError, setActionError] = useState<string | null>(null);
  /** 批量管理的已勾选曲目 id 集合（三个分支共用，见 BatchBar） */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [favorited, setFavorited] = useState(false);
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  /** 本地歌单删单的二次确认态（红心第一下只换文案，第二下才真删） */
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // 静默重载：保留现有列表与封面，等新数据回来再整体替换，不闪骨架屏
    const silent = silentRef.current;
    silentRef.current = false;
    if (!silent) {
      setLoading(true);
      setCover(null);
    }
    setError(null);
    setActionError(null);
    void (async () => {
      try {
        let list: Track[];
        if (isChart) {
          // 榜单详情的取数分两步：先按 (platform, id) 在榜单列表里找出它的
          // 名字与配图，再拿这份元信息去取曲目（getChartDetail 要整个 Chart）。
          // 列表取不到（聚合接口偶发失败）不该挡住曲目：名字退回占位即可。
          const chart: Chart = {
            id,
            platform: platform as SourceId,
            name: "",
            picUrl: "",
            description: null,
          };
          try {
            const charts = await sourceApi.getCharts(platform as SourceId);
            const found = (Array.isArray(charts) ? charts : []).find(
              (c) => c.platform === platform && c.id === id,
            );
            if (found) {
              chart.name = found.name;
              chart.picUrl = found.picUrl;
            }
          } catch {
            // 榜单列表取不到不影响取详情
          }
          const rows = await sourceApi.getChartDetail(chart);
          if (cancelled) return;
          list = Array.isArray(rows) ? rows : [];
          setName(chart.name);
          setDescription(null);
          setPicUrl(chart.picUrl);
          setPlayCount("");
          setCover(qtresCoverUrl(chart.picUrl) || (list[0] ? await trackCover(list[0]) : null));
        } else if (isLocal) {
          const [rows, all] = await Promise.all([
            ipc.getPlaylistTracks(id),
            ipc.listMyPlaylists().catch(() => [] as MyPlaylistSummary[]),
          ]);
          if (cancelled) return;
          list = Array.isArray(rows) ? rows : [];
          const summary = (Array.isArray(all) ? all : []).find((p) => p.pid === id);
          setName(summary?.name ?? "");
          setDescription(null);
          setPicUrl("");
          setPlayCount("");
          // 回退链第一环：歌单自设封面（未设置 / 文件丢了都是 null）
          const own = await ipc.getPlaylistCover(id).catch(() => null);
          // 第二环：第一首曲目的封面；一首歌都没有就留给默认占位
          const fallback = !own && list.length > 0 ? await trackCover(list[0]) : null;
          if (!cancelled) setCover(own ?? fallback);
        } else {
          const pl = await sourceApi.getPlaylistDetail(platform as SourceId, id);
          if (cancelled) return;
          list = pl.tracks ?? [];
          setName(pl.name);
          setDescription(pl.description ?? null);
          setPicUrl(pl.picUrl);
          setPlayCount(pl.playCount);
          // 同样的回退链，只是在线封面同步就能算出来
          setCover(qtresCoverUrl(pl.picUrl) || (list[0] ? await trackCover(list[0]) : null));
        }
        if (cancelled) return;
        setTracks(list);
        // 曲目可能是在别处（行尾红心里取消勾选本歌单）被摘掉的，勾选集里
        // 若还留着这些 id，「已选 N 首」就虚高了 —— 以新列表为准收一遍
        setSelected((prev) => {
          if (prev.size === 0) return prev;
          const ids = new Set(list.map((t) => t.id));
          const next = new Set([...prev].filter((x) => ids.has(x)));
          return next.size === prev.size ? prev : next;
        });
      } catch (err) {
        if (cancelled) return;
        // 静默重载失败别把已经显示的列表换成错误页：报在列表上方的提示条里，
        // 用户还能继续操作（多半是这一次读库偶发失败）
        if (silent) setActionError(`刷新失败：${errMsg(err)}`);
        else setError(errMsg(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [platform, id, kind, isLocal, isChart, reload]);

  // 切换页面后清掉勾选，避免残留已不属于这个页面的曲目 id；
  // 删单确认也一起复位，别把上一个歌单的确认态带到下一个
  useEffect(() => {
    setSelected(new Set());
    setConfirmDelete(false);
  }, [platform, id, kind]);

  // 歌单级收藏：在线歌单查音源；本地歌单**恒为已收藏态**（见模块头），
  // 不用查也不用改收藏位，红心常亮（显示处直接 `isLocal || favorited`）。
  // 榜单没有歌单级收藏，不查。
  useEffect(() => {
    if (isLocal || isChart) return;
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
  }, [platform, id, isLocal, isChart]);

  const toggleFavorite = (): void => {
    if (favoriteBusy || isLocal || isChart || !name) return;
    setFavoriteBusy(true);
    const next = !favorited;
    const call = next
      ? ipc.favoritePlaylist(platform, id, name, picUrl, playCount)
      : ipc.unfavoritePlaylist(platform, id, name, picUrl);
    void call
      .then(() => setFavorited(next))
      .catch(() => {})
      .finally(() => setFavoriteBusy(false));
  };

  /**
   * 本地歌单的「取消收藏」：本地歌单里的曲目必然挂在它名下，摘掉歌单等于
   * 把里面的收藏一起摘干净（Rust `delete_playlist` 会把失去全部归属的歌下线），
   * 所以这一步不可逆，先弹二次确认。删完回「我的歌单」，留在原地只会看到空页。
   */
  const deleteLocalPlaylist = async (): Promise<void> => {
    setFavoriteBusy(true);
    setActionError(null);
    try {
      await ipc.deletePlaylist(id);
      // 删单会摘掉这个歌单下所有曲目的归属，失去全部归属的歌跟着下线 ——
      // 别处列表里的红心必须跟着变空，否则同一首歌显示两种收藏态
      bumpFavorites();
      void navigate({ to: "/my/playlists" });
    } catch (err) {
      setActionError(`删除歌单失败：${errMsg(err)}`);
      setConfirmDelete(false);
    } finally {
      setFavoriteBusy(false);
    }
  };

  /** 本地歌单红心的两段式点击：先亮确认，再点才删 */
  const handleHeartClick = (): void => {
    if (favoriteBusy || !name) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    void deleteLocalPlaylist();
  };

  // 确认态不能一直挂着：点别处 / Esc 就撤回（沿用 RowActions 的二次确认手法），
  // 免得随手再点一下红心就把歌单删了
  const heartRef = useRef<HTMLSpanElement | null>(null);
  const cancelConfirm = useCallback(() => setConfirmDelete(false), []);
  useDismissOnOutside(heartRef, isLocal && confirmDelete, cancelConfirm);

  const toggleSelect = useCallback((trackId: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });
  }, []);

  /**
   * 本地歌单的曲目变更后重载：封面回退链也要跟着重算（第一首可能被移除了）。
   * 走静默重载 —— 删一首歌不该让整页闪回骨架屏。
   */
  const refresh = (): void => {
    silentRef.current = true;
    setReload((r) => r + 1);
  };

  /**
   * 收藏态版本号。行尾红心里「取消勾选当前歌单」就是把这首从**本歌单**移除
   * （本地歌单里的曲目必然是收藏态），可面板并不知道自己长在哪个页面上，
   * 只会 `bump()` 一下版本号。这里据此静默重载，让被摘掉的那行当场消失。
   * 在线歌单 / 榜单不跟：曲目归属由音源决定，收藏态变化不影响这里有什么。
   */
  const favVersion = useFavoritesStore((s) => s.version);
  const bumpFavorites = useFavoritesStore((s) => s.bump);
  const lastFavVersion = useRef(favVersion);
  useEffect(() => {
    if (favVersion === lastFavVersion.current) return;
    lastFavVersion.current = favVersion;
    if (!isLocal) return;
    refresh();
    // refresh 只写 ref + setState，依赖里放进来反而每渲染都跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [favVersion, isLocal]);

  const fallbackTitle = isChart ? "榜单详情" : "歌单详情";

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="relative shrink-0 border-b border-border">
        {/* 封面模糊铺底：封面本身当氛围背景，比纯色头好看，也不依赖取色算法。
            用的是走完回退链的那张（歌单没设封面时就是首曲封面）。
            裁切（`overflow-hidden`）落在这一层而不是整块 hero 上：铺底图放大
            了 125%，必须裁；但 hero 本身不能裁 —— 页头右侧批量条的歌单面板是
            absolute 展开的，hero 一裁就只剩一条缝，面板会被挡在页头里。 */}
        {cover ? (
          <div className="absolute inset-0 overflow-hidden">
            <img
              src={cover}
              alt=""
              aria-hidden
              draggable={false}
              className="absolute inset-0 h-full w-full scale-125 select-none object-cover opacity-45 blur-3xl saturate-150"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-background/10 to-background" />
          </div>
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
                {(name || (isChart ? "榜" : "歌")).slice(0, 1)}
              </span>
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col justify-end pb-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
              {isLocal ? "我的歌单" : isChart ? "榜单" : "歌单"}
            </p>
            <h1 className="mt-1 truncate text-2xl font-bold tracking-tight">
              {name || fallbackTitle}
            </h1>
            {/* 只报「共 N 首歌」：各音源 playCount 口径不一（有的算累计播放、
                有的直接给歌数），拿不到一致含义就不摆出来 */}
            {!loading ? (
              <p className="mt-1 text-xs text-muted-foreground">共 {tracks.length} 首歌</p>
            ) : null}
            {/* 榜单不带简介：它是榜单，简介位留给歌单（在线歌单的简介本来就长，
                这里 line-clamp-3 兜住） */}
            {description ? (
              <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">{description}</p>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <IconButton
                label="播放全部"
                variant="primary"
                size="lg"
                disabled={tracks.length === 0}
                className="h-9 w-9 rounded-lg shadow-lg shadow-primary/25"
                onClick={() => void playQueue(tracks, 0)}
              >
                <Play className="h-4 w-4 fill-current" />
              </IconButton>
              {/* 歌单级收藏只给歌单（榜单没有这个层级），且两颗来源点下去
                  不是一回事：
                  - 在线歌单：收藏 / 取消收藏（归属在音源，曲目不受影响）；
                  - 本地歌单：**恒为已收藏态**，取消收藏 == 删掉整个歌单，
                    所以走二次确认（原地换文案再点第二下，沿用全项目的确认手法）。 */}
              {!isChart ? (
                <span ref={heartRef} className="flex items-center gap-2">
                  <IconButton
                    label={
                      isLocal
                        ? confirmDelete
                          ? "确认删除歌单"
                          : "已收藏，点击取消收藏（会删除歌单）"
                        : favorited
                          ? "已收藏，点击取消收藏"
                          : "收藏"
                    }
                    variant="outline"
                    size="lg"
                    hover="secondary"
                    danger={isLocal && confirmDelete}
                    disabled={favoriteBusy || !name}
                    className="h-9 w-9 rounded-lg"
                    onClick={isLocal ? handleHeartClick : toggleFavorite}
                  >
                    <Heart
                      className={
                        isLocal || favorited
                          ? "h-4 w-4 fill-current text-primary"
                          : "h-4 w-4"
                      }
                    />
                  </IconButton>
                  {isLocal && confirmDelete ? (
                    <span className="text-xs text-destructive">再点一次即删除歌单</span>
                  ) : null}
                </span>
              ) : null}
            </div>
          </div>

          {/* 批量条摆在页头右侧，与左边那颗「播放全部」同一行（用户口径：
              批量操作属于页头，不该在列表上方再占一行）。三页同一根条子：
              收藏 / 取消收藏在面板里选歌单（与单曲红心同逻辑）。本地歌单把
              自己的 pid 传下去，从本歌单取消收藏后重拉列表。
              `items-end` + `pb-1` 让它与信息列的底线对齐：批量按钮和
              「播放全部」等高，底线一对齐，看着就是同一行。 */}
          {!loading && !error && tracks.length > 0 ? (
            <div className="relative flex shrink-0 items-end pb-1">
              <BatchBar
                embedded
                tracks={tracks}
                selected={selected}
                onSelectedChange={setSelected}
                hostPlaylistId={isLocal ? id : undefined}
                onChanged={isLocal ? refresh : undefined}
                onError={setActionError}
              />
            </div>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* 行级 / 批量操作失败的提示条：与整页加载失败分开，列表照常可用 */}
        {actionError && (
          <div className="px-6 pt-4 text-center text-sm text-destructive">{actionError}</div>
        )}
        {loading ? (
          <TrackRowsSkeleton rows={10} />
        ) : error ? (
          <ErrorRetry message={`加载失败：${error}`} onRetry={() => setReload((r) => r + 1)} />
        ) : tracks.length === 0 ? (
          // 空态必须由页面拦下来：TrackList 自己的「暂无歌曲」对本地歌单没有引导价值
          <div className="py-10 text-center text-sm text-muted-foreground">
            {isLocal
              ? "歌单里还没有歌曲，在其它列表里点行尾的「收藏」加进来"
              : isChart
                ? "这个榜单还没有歌曲"
                : "这个歌单还没有歌曲"}
          </div>
        ) : (
          <TrackList
            tracks={tracks}
            showIndex={isChart}
            showCollect
            showDownload
            selection={{ ids: selected, onToggle: toggleSelect }}
          />
        )}
      </div>
    </div>
  );
}
