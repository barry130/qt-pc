import { useEffect, useRef, useState } from "react";
import { Check, Plus } from "lucide-react";
import { errMsg } from "@/lib/utils";
import { buildCollectChoiceAsync, type CollectChoicePlan } from "@/lib/collect-choice";
import { applyCollectChoice } from "@/lib/apply-collect-choice";
import { CollectChoice } from "./CollectChoice";
import { useFavoritesStore } from "@/stores/favorites";
import { toastSuccess, toastUndo } from "@/stores/toast";
import type { MyPlaylistSummary, Track } from "@/types";
import * as ipc from "@/services/ipc";
import { Button } from "@/components/ui";

/**
 * 收藏选择器面板（**播放条红心与列表行红心共用这一个组件**）。
 *
 * 收藏不能脱离歌单：面板里是**本地歌单清单**（含「我喜欢的歌曲」），
 * 每点一行即在「收藏 / 取消收藏」之间切换 —— 与 qt-uniappx 的
 * `pickerPlaylists()` + `applyPickerSelection()` 同口径。
 * 一首歌可以挂在多个歌单（v6 起多对多），勾上新的不会放开旧的。
 *
 * 为什么要抽出来：列表行的「＋歌单」要换成「收藏」，而用户的要求是
 * 「和播放控制栏的收藏逻辑一致」。两边各写一份查重 / 新建 / 勾选逻辑，
 * 迟早会漂移（一边查重一边不查、一边能新建一边不能）—— 共用一个组件，
 * 「一致」就是结构上保证的，不靠人盯。
 *
 * 触发按钮与「点外部关闭」留在宿主：播放条是圆形红心、列表行是图标按钮，
 * 外观与定位都不同；`className` 由宿主给（含定位与圆角）。
 * 面板只在 `open` 时挂载，所以拉数据写在挂载副作用里，不必再判 open。
 */
export function CollectMenu(props: {
  track: Track;
  /** 收藏动作完成后收起面板（取消收藏不收，方便连续调整归属） */
  onClose: () => void;
  /** 收藏态变化时通知宿主（播放条要更新自己那份红心高亮） */
  onLikedChange?: (liked: boolean) => void;
  /** 定位 + 外观（宽度 / 圆角 / 毛玻璃）由宿主决定 */
  className?: string;
}): React.JSX.Element {
  const { track, onClose, onLikedChange } = props;
  const [items, setItems] = useState<MyPlaylistSummary[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  /** 展示新旧版本，由用户明确选择要保留的集合。 */
  const [pending, setPending] = useState<{
    playlist: MyPlaylistSummary;
    plan: CollectChoicePlan;
    existing: Track[];
    epoch: number;
  } | null>(null);
  const bump = useFavoritesStore((s) => s.bump);
  const scope = useRef(0);
  const trackRef = useRef(track);
  trackRef.current = track;
  const trackKey = `${track.platform}:${track.id}`;
  const active = (token: number): boolean => scope.current === token && `${trackRef.current.platform}:${trackRef.current.id}` === trackKey;

  const reload = async (token: number): Promise<void> => {
    const [all, inLists] = await Promise.all([
      ipc.listMyPlaylists(),
      ipc.listTrackPlaylists(track),
    ]);
    // 可作为收藏目标：本地自建歌单 + 云端 local 卡片（「我喜欢的歌曲」等，
    // 曲目落本地 liked_songs）；在线音源歌单的曲目归音源管，加不进去
    if (!active(token)) return;
    setItems(all.filter((p) => p.platform === ipc.LOCAL_PLATFORM));
    setSelected(inLists);
  };

  useEffect(() => {
    const token = ++scope.current;
    setError(null);
    setPending(null);
    setBusy(false);
    setItems([]);
    setSelected([]);
    setNewName("");
    void reload(token).catch((err: unknown) => {
      if (active(token)) setError(errMsg(err));
    });
    return () => {
      scope.current += 1;
    };
    // track 变了就整体重来：面板是挂在具体一首歌上的
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackKey]);

  /** 归属变了，以库里的为准通知宿主 + 让所有列表重新批量判定 */
  const syncLiked = async (token: number): Promise<void> => {
    const liked = await ipc.isFavorite(track).catch(() => false);
    bump();
    if (active(token)) onLikedChange?.(liked);
  };

  const addTo = async (p: MyPlaylistSummary, plan: CollectChoicePlan, existing: Track[], epoch: number, token: number): Promise<void> => {
    if (!active(token)) return;
    setBusy(true);
    setError(null);
    try {
      await applyCollectChoice(p.pid, plan, existing, epoch, () => active(token));
      // 面板马上就收起，勾选结果看不见 —— 收藏到哪儿得给条回执
      // （与批量收藏的文案口径一致：「到哪儿」必须写清楚）
      toastSuccess(`已收藏到「${p.name}」`);
      await reload(token);
      await syncLiked(token);
      if (!active(token)) return;
      setPending(null);
      onClose();
    } catch (err) {
      if (active(token)) setError(errMsg(err));
    } finally {
      if (active(token)) setBusy(false);
    }
  };

  const toggle = async (p: MyPlaylistSummary): Promise<void> => {
    if (busy || pending) return;
    const token = scope.current;
    // 取消收藏不需要查重：那是减操作，不会造成重复
    if (selected.includes(p.pid)) {
      setBusy(true);
      setError(null);
      try {
        const epoch = await ipc.likeSessionEpoch();
        if (!active(token)) return;
        await ipc.removeTracksFromPlaylist(p.pid, [track], epoch);
        await reload(token);
        await syncLiked(token);
        // 取消收藏是高频低风险动作，不给二次确认，改成「先做完再给一次后悔的机会」。
        // 撤销就是加回这个歌单：`syncLiked` 会把宿主的红心与所有列表的判定改回来
        // （面板此时可能已经收起，`reload` 打空也无害）
        toastUndo(`已从「${p.name}」取消收藏`, async () => {
          if (await ipc.likeSessionEpoch() !== epoch) throw new Error("账号已变化，无法撤销旧账号的收藏");
          await ipc.addTracksToPlaylist(p.pid, [track], epoch);
          await reload(token);
          await syncLiked(token);
        });
      } catch (err) {
        if (active(token)) setError(errMsg(err));
      } finally {
        if (active(token)) setBusy(false);
      }
      return;
    }
    await chooseVersions(p, false);
  };

  const chooseVersions = async (p: MyPlaylistSummary, manageOnly: boolean): Promise<void> => {
    if (busy || pending) return;
    const token = scope.current;
    setBusy(true);
    setError(null);
    try {
      const epoch = await ipc.likeSessionEpoch();
      const existing = await ipc.getPlaylistTracks(p.pid);
      if (await ipc.likeSessionEpoch() !== epoch || !active(token)) return;
      const plan = await buildCollectChoiceAsync(existing, [track], () => active(token));
      if (!plan || !active(token)) return;
      if (await ipc.likeSessionEpoch() !== epoch || !active(token)) return;
      if (plan.groups.length > 0) {
        setPending({ playlist: p, plan, existing, epoch });
        return;
      }
      if (manageOnly) {
        setError("此歌单没有这首歌的跨源重复版本");
        return;
      }
      await addTo(p, plan, existing, epoch, token);
    } catch (err) {
      if (active(token)) setError(errMsg(err));
      return;
    } finally {
      if (active(token)) setBusy(false);
    }
  };

  const saveChoice = async (plan: CollectChoicePlan): Promise<void> => {
    if (!pending || busy) return;
    const token = scope.current;
    setBusy(true); setError(null);
    try {
      await applyCollectChoice(pending.playlist.pid, plan, pending.existing, pending.epoch, () => active(token));
      await reload(token); await syncLiked(token);
      if (!active(token)) return;
      setPending(null);
      toastSuccess('已更新歌单中的歌曲版本'); onClose();
    } catch (err) { if (active(token)) setError(errMsg(err)); }
    finally { if (active(token)) setBusy(false); }
  };

  const createAndCollect = async (): Promise<void> => {
    const n = newName.trim();
    if (!n || busy || pending) return;
    const token = scope.current;
    // 新建的歌单必然是空的，不需要查重
    setBusy(true);
    setError(null);
    try {
      // createPlaylist 返回的就是新歌单的永久 pid（已上送云端登记）
      const epoch = await ipc.likeSessionEpoch();
      if (!active(token)) return;
      const pid = await ipc.createPlaylist(n);
      if (await ipc.likeSessionEpoch() !== epoch || !active(token)) return;
      setNewName("");
      await ipc.addTracksToPlaylist(pid, [track], epoch);
      toastSuccess(`已收藏到「${n}」（新建歌单）`);
      await reload(token);
      await syncLiked(token);
      if (!active(token)) return;
      onClose();
    } catch (err) {
      if (active(token)) setError(errMsg(err));
    } finally {
      if (active(token)) setBusy(false);
    }
  };

  return (
    <div className={props.className} onClick={(e) => e.stopPropagation()}>
      <div className="px-2 py-1 text-xs text-muted-foreground">{pending ? `歌单：${pending.playlist.name}` : "收藏到歌单"}</div>
      {!pending ? <div className="max-h-56 overflow-y-auto">
        {items.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">
            还没有本地歌单，下面新建一个
          </div>
        ) : (
          items.map((p) => {
            // 打勾按 pid 对（selected 里存的是歌单的永久 pid）
            const on = selected.includes(p.pid);
            return (
              <div key={p.pid} className="flex items-center">
              <button
                key={p.pid}
                type="button"
                disabled={busy || pending !== null}
                onClick={(e) => {
                  // 列表行整行是可点的 div[role=button]，面板在行内，
                  // 不拦住冒泡会顺手把这首播了
                  e.stopPropagation();
                  void toggle(p);
                }}
                className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary disabled:opacity-50"
              >
                <Check
                  className={[
                    "h-3.5 w-3.5 shrink-0",
                    on ? "text-primary" : "text-transparent",
                  ].join(" ")}
                />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <span className="shrink-0 text-muted-foreground">{p.trackCount}</span>
              </button>
              {on ? <Button variant="ghost" size="xs" disabled={busy} onClick={(e) => { e.stopPropagation(); void chooseVersions(p, true); }} aria-label={`整理「${p.name}」的重复版本`} title="选择保留哪些重复版本">版本</Button> : null}
              </div>
            );
          })
        )}
      </div> : null}

      {pending !== null ? (
        <CollectChoice key={pending.playlist.pid} plan={pending.plan} busy={busy} onCancel={() => { setPending(null); setError(null); }} onSave={(plan) => { void saveChoice(plan); }} />
      ) : null}

      {!pending ? <div className="mt-1 flex items-center gap-1 border-t border-border pt-1">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") void createAndCollect();
          }}
          placeholder="新建歌单并收藏"
          className="h-7 min-w-0 flex-1 rounded border border-input bg-background px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="button"
          disabled={!newName.trim() || busy}
          onClick={(e) => {
            e.stopPropagation();
            void createAndCollect();
          }}
          aria-label="新建歌单并收藏"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border transition-colors hover:bg-secondary disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div> : null}

      {error && <div className="px-2 py-1 text-2xs text-destructive">{error}</div>}
    </div>
  );
}
