import { useEffect, useMemo, useState } from "react";
import { Check, Download, Heart, Loader2, Plus, X } from "lucide-react";
import { cn, errMsg } from "@/lib/utils";
import { findCrossSourceDup } from "@/lib/collect-dup";
import { clampQualityForPlatform, useSourceLabelFn } from "@/stores/sourceRegistry";
import { useFavoritesStore } from "@/stores/favorites";
import { toastSuccess } from "@/stores/toast";
import { useFavoriteFlags } from "@/hooks/useFavoriteFlags";
import type { MyPlaylistSummary, Track } from "@/types";
import * as ipc from "@/services/ipc";
import { IconButton } from "@/components/common/IconButton";
import { Popover } from "@/components/common/Popover";

/**
 * 列表批量管理条（**歌单详情 / 榜单详情 / 每日新歌 / 歌手页 / 专辑页共用**）。
 *
 * 各落点各写一份「全选 + 批量下载 + 批量收藏」必然漂移（一边查重一边不查、
 * 一边跳过已收藏一边不跳），所以抽成一根条子；页面只负责给 `tracks` 与勾选集。
 *
 * 批量下载：并发 3 个 worker 从同一游标取任务。**不放开并发**——一次放 50 个
 * 取址请求会被音源 / CDN 当爬虫（LX Music 就因为这个被封过 IP，设置页的
 * `downloadConcurrency` 默认也是 ≤3）；本地曲目跳过（本地歌没有播放地址可取）。
 *
 * 批量收藏：收藏不能脱离歌单（Rust 侧没 pid 直接报参数错误），所以按钮点开的是
 * **歌单选择面板**，与单曲版 `CollectMenu` 同口径 —— 每行是一个本地歌单，
 * 勾上 = 选中的这批已经都在里面。**单曲的逻辑是「点一下加、再点一下取消」，
 * 批量完全一样**：整批都已经在那个歌单里（全勾）时，这一下就是批量取消收藏
 * （走 `remove_tracks_from_playlist`）；只要还有没进去的，就是批量收藏
 * （走 `add_tracks_to_playlist`，**已在里面的自动跳过，只加缺的那些**，
 * 后端按 `ON CONFLICT DO NOTHING` 计数，返回的正是真实新增数）。
 *
 * 因此这里**没有**独立的「批量取消收藏」按钮：取消就是再点一次已经全勾的那行，
 * 和单曲红心一样。也不再有「整首取消收藏（从所有歌单摘掉）」的批量入口 ——
 * 批量语境下用户指的一定是「从这个歌单里去掉」，跨歌单连坐交给单曲红心。
 *
 * 工具栏那颗红心和单曲版**同一个观感**：整批都已收藏（挂在任一歌单下即算，
 * 口径同 `is_liked_song`）就实心高亮，只要还有一首没收就是空心。判定复用列表行
 * 那支 `useFavoriteFlags`（一次 IPC 查整批），所以和行尾红心不会出现
 * 「行里实心、工具条空心」这种自相矛盾。
 * 判「整批」的口径：**勾了歌看勾上的这批，一首没勾就看整张列表** ——
 * 本地歌单里的曲目必然是收藏态，所以进这种歌单时红心天生就是实心的。
 *
 * 摆放：条子不管自己在哪儿，由页面决定 —— 各落点都把它放在**页头右侧**
 * （歌单 / 榜单 / 歌手 / 专辑 hero 里，与「播放全部」同一行；每日新歌的标题行），
 * 不再在列表上方单独占一行。那一行会把首屏曲目整体往下挤，而且离页头的播放 /
 * 收藏按钮很远，像另一套东西。页头里传 `embedded`，由页头接管外框与留白。
 *
 * 回执（「已收藏 N 首到「歌单名」」）**不写进这一行**：文案长短会把右边那排
 * 按钮推来推去，页头宽度一变整个标题也跟着抖（用户 m09470）。统一走全局右上角
 * 轻提示 `stores/toast`，3 秒自动消失，对布局零影响。条子里因此只剩固定宽度的
 * 控件：全选 / 已选 N 首（下载时顶替成进度）/ 取消选择 / 批量下载 / 批量收藏。
 */
export function BatchBar(props: {
  tracks: Track[];
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  /**
   * 宿主页自己的歌单 pid（本地歌单详情页传自己）：**只有动到本页这个歌单**
   * 才需要重拉 —— 从本页歌单里取消收藏后，那几行必须跟着消失。
   * 在线歌单 / 榜单 / 每日新歌的曲目不归本地歌单管，不传。
   */
  hostPlaylistId?: string;
  /** 批量改动命中 `hostPlaylistId` 后重拉宿主列表 */
  onChanged?: () => void;
  onError?: (message: string | null) => void;
  /**
   * 嵌进页头（歌单 / 榜单详情 hero 的动作行、每日新歌标题行）时打开：
   * 位置由页面给，条子就不要再自带「贴着列表」的那圈外框（底边框 + 上下
   * 内边距），否则页头里会凭空多出一条横线、多出一层留白。
   */
  embedded?: boolean;
}): React.JSX.Element {
  const {
    tracks,
    selected,
    onSelectedChange,
    hostPlaylistId,
    onChanged,
    onError,
    embedded = false,
  } = props;
  /** 取址并发上限：见文件头注释（放开会被音源当爬虫） */
  const DOWNLOAD_CONCURRENCY = 3;

  const [busy, setBusy] = useState<"download" | null>(null);
  /** 批量下载进度文案（「3/50」），只在这段时间顶替「已选 N 首」 */
  const [progress, setProgress] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuBusy, setMenuBusy] = useState(false);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [items, setItems] = useState<MyPlaylistSummary[]>([]);
  const [newName, setNewName] = useState("");
  /**
   * 每个本地歌单里**已有**哪些选中曲目（`pid` → `平台:id` 集合）。
   * 面板里的勾就是从这里来的；打开面板时一次算好，别在渲染里逐行发 IPC。
   */
  const [members, setMembers] = useState<Record<string, Set<string>>>({});
  const [membersLoading, setMembersLoading] = useState(false);
  /**
   * 「同名不同源」待确认：目标歌单里已经有另一平台的同一首歌时先拦一下，
   * 用户点「继续收藏」才真的写入（收藏表按 platform+id 唯一，两首能共存，
   * 界面上就是重复的两行 —— 加入前提示比加完再删轻松得多）。
   * `adds` 是这次真正要新增的那部分（已在歌单里的不算）。
   */
  const [pending, setPending] = useState<{
    playlist: MyPlaylistSummary;
    adds: Track[];
    dups: Track[];
  } | null>(null);

  const sourceLabel = useSourceLabelFn();
  const bump = useFavoritesStore((s) => s.bump);
  const favVersion = useFavoritesStore((s) => s.version);
  const closeMenu = (): void => {
    setMenuOpen(false);
    setPending(null);
  };

  const targets = useMemo(
    () => tracks.filter((t) => selected.has(t.id)),
    [tracks, selected],
  );
  const count = targets.length;
  const allSelected = tracks.length > 0 && count === tracks.length;

  /**
   * 红心实心与否，判定口径与**单曲红心一模一样**（`is_liked_song`：挂在任一
   * 歌单下就算已收藏）：
   * - 勾了歌 → 看**勾上的这批**是不是全都收藏了（「这批整体已收藏」）；
   * - 一首没勾 → 看**整张列表**是不是全都收藏了。本地歌单里的曲目必然是收藏态，
   *   所以进这种歌单时红心就该是实心的，不必先点全选才亮。
   *
   * 判定走列表行红心**同一支 hook**（`useFavoriteFlags`，一次 IPC 查整批，
   * 不逐行打通道），而且**固定查整张列表**、不随勾选变化重查：勾选是高频动作，
   * 每次勾一下都发一轮 IPC 才是真浪费。
   *
   * 代价是它和 `TrackList` 内部那份判定会各查一遍整表 —— 刻意接受：一次本地
   * SQLite 批量查询，换掉「三个宿主页都得记得把红心态传下来」这个隐式约定，
   * 少一处将来必然漏掉一页的坑。
   *
   * 判定失败时 hook 给全 false → 红心空心：空心最多让人多点一下，实心会让
   * 人以为已经收藏过了，宁可保守。
   */
  const favFlags = useFavoriteFlags(tracks, favVersion);
  const likedIds = useMemo(() => {
    const set = new Set<string>();
    tracks.forEach((t, i) => {
      if (favFlags[i]) set.add(t.id);
    });
    return set;
  }, [tracks, favFlags]);
  const allLiked = useMemo(() => {
    const probe = count > 0 ? targets : tracks;
    return probe.length > 0 && probe.every((t) => likedIds.has(t.id));
  }, [count, targets, tracks, likedIds]);

  useEffect(() => {
    if (count === 0) setMenuOpen(false);
  }, [count]);

  /** 「平台:id」口径与 Rust `db_track_id()` / 列表 key 一致 */
  const keyOf = (t: Pick<Track, "platform" | "id">): string => `${t.platform}:${t.id}`;

  /** 这个歌单里已经躺着哪些选中曲目（`getPlaylistTracks` 返回的是库里的曲目行） */
  const computeMembers = async (
    list: MyPlaylistSummary[],
  ): Promise<Record<string, Set<string>>> => {
    const selectedKeys = new Set(targets.map(keyOf));
    const entries = await Promise.all(
      list.map(async (p) => {
        try {
          const rows = await ipc.getPlaylistTracks(p.pid);
          const keys = new Set(
            (Array.isArray(rows) ? rows : []).map(keyOf).filter((k) => selectedKeys.has(k)),
          );
          return [p.pid, keys] as const;
        } catch {
          // 单个歌单读失败当作「都没收藏」：宁可让用户点一下（后端会跳过重复），
          // 也不能因为一个歌单读不出来就整块面板不可用
          return [p.pid, new Set<string>()] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  };

  const openMenu = async (): Promise<void> => {
    if (menuOpen) {
      closeMenu();
      return;
    }
    setMenuOpen(true);
    setMenuError(null);
    setPending(null);
    setMembersLoading(true);
    try {
      const all = await ipc.listMyPlaylists();
      // 可作为收藏目标：本地自建歌单 + 云端 local 卡片（「我喜欢的歌曲」等）。
      // 在线音源歌单的曲目归音源管，加不进去（与单曲收藏面板同口径）
      const list = (Array.isArray(all) ? all : []).filter(
        (p) => p.platform === ipc.LOCAL_PLATFORM,
      );
      setItems(list);
      setMembers(await computeMembers(list));
    } catch (err) {
      setMenuError(errMsg(err));
    } finally {
      setMembersLoading(false);
    }
  };

  /** 这个歌单里已包含几首选中曲目 */
  const inPlaylist = (p: MyPlaylistSummary): number => {
    const set = members[p.pid];
    if (!set || set.size === 0) return 0;
    return targets.reduce((n, t) => (set.has(keyOf(t)) ? n + 1 : n), 0);
  };

  /** 还没进这个歌单的那些 */
  const missingIn = (p: MyPlaylistSummary): Track[] => {
    const set = members[p.pid];
    return set ? targets.filter((t) => !set.has(keyOf(t))) : targets;
  };

  /**
   * 上一次动作的回执。**走全局右上角轻提示**（绿勾回执，自动消失），不写在条子里 ——
   * 文案长短不一会把页头那排控件推来推去（用户 m09470）；也不往 `onError` 里塞，
   * 成功挂红字会让人以为出错。
   */
  const report = (message: string): void => {
    toastSuccess(message);
  };

  const download = async (): Promise<void> => {
    if (busy !== null || count === 0) return;
    // 本地曲目没有播放地址可下（Rust 侧 start_download 直接报「本地歌曲无需下载」），
    // 先剔掉再判断是否还有活可干，避免整批都失败还逐首弹错
    const list = targets.filter((t) => t.platform !== ipc.LOCAL_PLATFORM);
    if (list.length === 0) {
      onError?.("选中的歌曲都在本地，无需下载");
      return;
    }
    setBusy("download");
    onError?.(null);
    let failed = 0;
    let done = 0;
    setProgress(`0/${list.length}`);
    try {
      const wanted = await ipc.getDownloadQuality();
      // 固定的 N 个 worker 从同一游标取任务：比 Promise.all 一次性放出去温和，
      // 也比纯串行快（取址是网络往返，串行下 50 首要等 50 个来回）
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < list.length) {
          const t = list[cursor++]!;
          try {
            // 与 DownloadButton.start() 同款：默认音质按该曲目所在的源收敛
            await ipc.startDownload(t, clampQualityForPlatform(t.platform, wanted));
          } catch {
            // 单首失败不中断整批，最后统一报条数（逐首弹错会把页面刷满）
            failed += 1;
          }
          done += 1;
          setProgress(`${done}/${list.length}`);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, list.length) }, () => worker()),
      );
      // 下载是纯入队（§13.4）：回执只说进队，不说开始下载；部分失败时绿色
      // 回执报进队数、红色行内错误报失败数，两条信号不混在一起
      if (list.length - failed > 0) {
        report(`加入下载队列成功：${list.length - failed} 首`);
      }
      if (failed > 0) onError?.(`批量下载：${failed} 首加入队列失败`);
    } catch (err) {
      onError?.(`批量下载失败：${errMsg(err)}`);
    } finally {
      setBusy(null);
      setProgress("");
    }
  };

  /** 批量从某个歌单摘掉这些曲目（云端按 outcome 逐首推，与单曲版同一条路径） */
  const removeFrom = async (p: MyPlaylistSummary, list: Track[]): Promise<void> => {
    if (menuBusy || list.length === 0) return;
    setMenuBusy(true);
    setMenuError(null);
    try {
      await ipc.removeTracksFromPlaylist(p.pid, list);
      // 收藏态变了：让所有列表重新批量判定红心
      bump();
      // 面板里这行的勾要跟着变：重算一次归属，别让用户看到过期的勾
      setMembers(await computeMembers(items));
      // 摘的正是宿主页自己这个歌单 → 那几行必须从页面上消失
      if (hostPlaylistId !== undefined && p.pid === hostPlaylistId) onChanged?.();
      report(`已从「${p.name}」取消收藏 ${list.length} 首`);
    } catch (err) {
      setMenuError(errMsg(err));
    } finally {
      setMenuBusy(false);
    }
  };

  const addTo = async (p: MyPlaylistSummary, adds: Track[]): Promise<void> => {
    if (menuBusy || adds.length === 0) return;
    setMenuBusy(true);
    setMenuError(null);
    try {
      // 走批量收藏接口：已在歌单里的由后端 ON CONFLICT 跳过，返回的是真实新增数
      const added = await ipc.addTracksToPlaylist(p.pid, adds);
      const skipped = adds.length - added;
      bump();
      setMembers(await computeMembers(items));
      setPending(null);
      // 加的就是宿主页自己这个歌单（本地歌单页里选中的曲目其实都已在其中，
      // 走不到这里；但归属被别处改过时可能走到）→ 让页面重新对齐一次
      if (hostPlaylistId !== undefined && p.pid === hostPlaylistId) onChanged?.();
      // 回执必须带「到哪儿」和「新增几首」：只说「已收藏 N 首」会被当成
      // 「这批里已收藏 N 首」的状态，跟左边的「已选 N 首」并列时尤其像
      // （只有 1 首是新的那次，就成了「已选 100 首 已收藏 1 首」）
      report(
        skipped > 0
          ? `已收藏 ${added} 首到「${p.name}」，其余 ${skipped} 首已在里面`
          : `已收藏 ${added} 首到「${p.name}」`,
      );
    } catch (err) {
      setMenuError(errMsg(err));
    } finally {
      setMenuBusy(false);
    }
  };

  /**
   * 点一行歌单：**和单曲红心同款** —— 这批已经全在里面就是取消收藏，否则收藏。
   * 只加缺的那些（后端也会再兜一层跳过），所以「一部分在里面」时不会把已有的
   * 那几首重新插一遍（位置、加入时间都保住）。
   */
  const toggleFor = async (p: MyPlaylistSummary): Promise<void> => {
    if (menuBusy || count === 0) return;
    const have = inPlaylist(p);
    const adds = missingIn(p);
    if (have === count) {
      await removeFrom(p, targets);
      return;
    }
    if (adds.length === 0) {
      // 归属刚被别处改过：重算一遍再让用户点，别拿旧勾做动作
      setMembers(await computeMembers(items));
      return;
    }
    // 加入前查重一次（只查真正要新增的那部分）：查重失败不拦收藏 ——
    // 重复顶多是两行，拦住是功能不可用（与单曲版同口径）
    let existing: Track[] = [];
    try {
      existing = await ipc.getPlaylistTracks(p.pid);
    } catch {
      // 读不到就当作没重
    }
    const dups =
      existing.length > 0
        ? adds.flatMap((t) => findCrossSourceDup(t, Array.isArray(existing) ? existing : []))
        : [];
    if (dups.length > 0) {
      // 同一首已存在的歌可能被多首选中项判成重复（比如选中的两首是同一首
      // 不同平台），按「平台:id」去重后再报数，别把 1 首说成 3 首
      const seen = new Set<string>();
      const unique = dups.filter((d) => {
        const k = keyOf(d);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      setPending({ playlist: p, adds, dups: unique });
      return;
    }
    await addTo(p, adds);
  };

  const createAndCollect = async (): Promise<void> => {
    const n = newName.trim();
    if (!n || menuBusy || count === 0) return;
    setMenuBusy(true);
    setMenuError(null);
    try {
      // 新建的歌单必然是空的，不需要查重，直接批量写入
      const pid = await ipc.createPlaylist(n);
      setNewName("");
      const added = await ipc.addTracksToPlaylist(pid, targets);
      bump();
      const fresh = await ipc.listMyPlaylists();
      const list = (Array.isArray(fresh) ? fresh : []).filter(
        (p) => p.platform === ipc.LOCAL_PLATFORM,
      );
      setItems(list);
      setMembers(await computeMembers(list));
      report(`已收藏 ${added} 首到「${n}」`);
    } catch (err) {
      setMenuError(errMsg(err));
    } finally {
      setMenuBusy(false);
    }
  };

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-end gap-2",
        // 只有「贴列表的独立一行」才要自己的分隔线与左右留白：
        // 嵌进页头时这些都归页头，条子只管把控件摆成一排
        !embedded && "border-b border-border px-6 py-2",
      )}
    >
      <label
        title={allSelected ? "取消全选" : "全选"}
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        <input
          type="checkbox"
          checked={allSelected}
          aria-label={allSelected ? "取消全选" : "全选"}
          onChange={() =>
            onSelectedChange(allSelected ? new Set() : new Set(tracks.map((t) => t.id)))
          }
          className="h-3.5 w-3.5 accent-primary"
        />
      </label>
      <span className="text-xs text-muted-foreground">
        {progress ? `下载中 ${progress}` : `已选 ${count} 首`}
      </span>
      {/* 动作回执**不在这里**：成功文案走全局右上角轻提示（`report` → `toast`），
          3 秒自动消失。写在这一行里的话，文案一长一短就把右边的按钮推来推去，
          用户 m09470 明确不要这种影响原布局的提示（详见文件头与 report 的注释） */}
      {count > 0 && (
        <IconButton
          label="取消选择"
          disabled={busy !== null}
          onClick={() => onSelectedChange(new Set())}
        >
          <X />
        </IconButton>
      )}

      <IconButton
        label={busy === "download" ? "下载中…" : `批量下载${count > 0 ? `（${count}）` : ""}`}
        variant="outline"
        size="lg"
        hover="secondary"
        disabled={busy !== null || count === 0}
        onClick={() => void download()}
      >
        {busy === "download" ? <Loader2 className="animate-spin" /> : <Download />}
      </IconButton>

      {/* 收藏必须落在某个歌单上（Rust 侧没 pid 直接报参数错误），所以这里
          不是「点一下就收藏」，而是一个歌单选择面板 —— 面板里每行即「收藏 /
          取消收藏」的开关，与播放条红心打开的 `CollectMenu` 同口径。
          红心和单曲版一样会变实心：整批都已收藏就点亮，只要还有一首没收
          就是空心（判定口径同 `is_liked_song`）。 */}
      <Popover
        open={menuOpen}
        onOpenChange={(next) => {
          if (next) setMenuOpen(true);
          else closeMenu();
        }}
        className="relative flex items-center"
        trigger={(t) => (
          <IconButton
            label={
              allLiked
                ? `已收藏${count > 0 ? `（${count}）` : ""}，点击管理收藏`
                : `批量收藏${count > 0 ? `（${count}）` : ""}`
            }
            variant="outline"
            size="lg"
            hover="secondary"
            disabled={menuBusy || count === 0}
            ariaHasPopup="menu"
            ariaExpanded={t.open}
            onClick={() => void openMenu()}
          >
            {/* 实心高亮写在图标自己身上（与列表行红心同款）：按钮的 hover 会改
                按钮文字色，改不动 svg 自己的 color，所以悬停时红心不会褪色 */}
            <Heart className={allLiked ? "fill-current text-primary" : undefined} />
          </IconButton>
        )}
      >
        {() => (
          <div className="absolute right-0 top-full z-20 mt-1 w-60 rounded-md border border-border bg-popover p-1 shadow-md">
            <div className="px-2 py-1 text-xs text-muted-foreground">
              {membersLoading ? "读取歌单…" : `收藏 / 取消收藏 ${count} 首`}
            </div>
            <div className="max-h-56 overflow-y-auto">
              {items.length === 0 ? (
                <div className="px-2 py-2 text-xs text-muted-foreground">
                  还没有本地歌单，下面新建一个
                </div>
              ) : (
                items.map((p) => {
                  const have = inPlaylist(p);
                  const all = count > 0 && have === count;
                  return (
                    <button
                      key={p.pid}
                      type="button"
                      disabled={menuBusy || membersLoading}
                      // 全在里面 → 这一下是取消收藏；否则只加缺的那些
                      title={
                        all
                          ? `已全部收藏在「${p.name}」，点击取消收藏`
                          : have > 0
                            ? `已在「${p.name}」${have} 首，点击收藏其余 ${count - have} 首`
                            : `收藏到「${p.name}」`
                      }
                      onClick={() => void toggleFor(p)}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary disabled:opacity-50"
                    >
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      {have > 0 && !all ? (
                        <span className="shrink-0 text-muted-foreground">部分</span>
                      ) : null}
                      {all ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" /> : null}
                      <span className="shrink-0 text-muted-foreground">{p.trackCount}</span>
                    </button>
                  );
                })
              )}
            </div>

            {/* 同名不同源确认条：替换掉歌单列表，避免用户在下面又点另一个
                歌单把这个提示顶掉（确认错对象） */}
            {pending !== null ? (
              <div
                data-testid="batch-collect-dup-confirm"
                className="border-t border-border px-2 py-2"
              >
                <p className="text-[11px] leading-snug text-foreground/90">
                  「{pending.playlist.name}」里已经有了
                  {pending.dups.length > 1 ? ` ${pending.dups.length} 首` : ""}同名的
                  {sourceLabel(pending.dups[0].platform)}版本
                  {pending.dups.length === 1 ? (
                    <span className="text-muted-foreground">（{pending.dups[0].singer}）</span>
                  ) : null}
                  ，仍要收藏？
                </p>
                <div className="mt-2 flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={menuBusy}
                    onClick={() => void addTo(pending.playlist, pending.adds)}
                    className="flex-1 rounded border border-border px-2 py-1 text-[11px] transition-colors hover:bg-secondary disabled:opacity-50"
                  >
                    继续收藏
                  </button>
                  <button
                    type="button"
                    disabled={menuBusy}
                    onClick={() => setPending(null)}
                    className="flex-1 rounded border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-secondary disabled:opacity-50"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : null}

            <div className="mt-1 flex items-center gap-1 border-t border-border pt-1">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createAndCollect();
                }}
                placeholder="新建歌单并收藏"
                className="h-7 min-w-0 flex-1 rounded border border-input bg-background px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
              <button
                type="button"
                disabled={!newName.trim() || menuBusy}
                onClick={() => void createAndCollect()}
                aria-label="新建歌单并收藏"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border transition-colors hover:bg-secondary disabled:opacity-40"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>

            {menuError && (
              <div className="px-2 py-1 text-[11px] text-destructive">{menuError}</div>
            )}
          </div>
        )}
      </Popover>
    </div>
  );
}
