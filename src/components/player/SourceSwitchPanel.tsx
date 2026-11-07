import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { abandonPreparedPlayAction, bindPreparedPlayDependency, isPreparedPlayActionCurrent, reservePlayAction, usePlayerStore, type PreparedPlayAction } from "@/stores/player";
import { SourceTag } from "@/components/common/SourceTag";
import { findSourceCandidates, peekSourceCandidates } from "@/lib/source-switch";
import { formatTime } from "@/lib/lrc";
import { cn } from "@/lib/utils";
import type { Track } from "@/types";
import { savePreferredSource } from "@/lib/preferred-source";
import { clearPlayUrlCache } from "@/services/ipc";

/** 每页条数：与 findSourceCandidates 的默认 size 一致，缓存键要对齐才命中 */
const PAGE_SIZE = 5;

/**
 * 换源面板（用户 m07452）：当前源不支持这首歌时，搜索**其他音源**的同一首歌
 * 并展示，用户点选后就地替换 —— 队列位置不动（拼回原位置后 playQueue(patched, idx)），
 * 不在队列里就单播候选。搜索走聚合入口（bundle "searchAll"），评分与自动兜底
 * 同口径（见 @/lib/source-switch），这里只负责展示与挑选。
 */
export function SourceSwitchPanel(props: {
  track: Track;
  /** 点选候选后回调（就地替换 + 收起弹层由按钮侧处理） */
  onPick: (candidate: Track, original: Track, beforeResolve: Promise<unknown>) => void | Promise<void>;
}): React.JSX.Element {
  const [items, setItems] = useState<{ track: Track; score: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [appending, setAppending] = useState(false);
  /** 重试计数：搜索失败后手动重跑（effect 依赖里参与触发） */
  const [attempt, setAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [itemsKey, setItemsKey] = useState("");
  const generation = useRef(0);
  const pendingChoice = useRef<Promise<PreparedPlayAction | null> | null>(null);
  // 搜索入参用最新 track（字段有更新时翻页也用新的），但**不进 effect 依赖**
  const trackRef = useRef(props.track);
  trackRef.current = props.track;
  const trackKey = `${props.track.platform}:${props.track.id}`;

  useEffect(() => {
    const token = ++generation.current;
    const original = trackRef.current;
    setError(null);
    setPage(1);
    setRefreshing(false);
    setAppending(false);
    setPicking(false);
    setItemsKey(trackKey);
    // 命中缓存时**不进 loading**：否则每次开弹层都要闪一下「正在搜索…」，
    // 缓存带来的即时感就没了（缓存是同步写、同步读的，见 lib/source-switch）
    const cached = peekSourceCandidates(original);
    if (cached !== null) {
      setItems(cached);
      setLoading(false);
    } else {
      setItems([]);
      setLoading(true);
      findSourceCandidates(original)
        .then((res) => {
          if (token === generation.current) setItems(res);
        })
        .catch((err: unknown) => {
          if (token === generation.current) setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (token === generation.current) setLoading(false);
        });
    }
    return () => {
      generation.current += 1;
      void pendingChoice.current?.then((handle) => { if (handle) abandonPreparedPlayAction(handle); });
    };
    // 依赖必须是**稳定 key**而不是 track 对象本身：播放心跳每次快照都会造出一个
    // 字段全等的新 track 对象，按对象引用依赖会让这个 effect 无限重跑 —— 表现就是
    // 「正在搜索…」与结果列表交替闪（同一首歌被反复聚合搜索）。
  }, [trackKey, attempt]);

  /** 忽略缓存重搜（用户点「重新搜索」）：force 会覆盖缓存条目 */
  const refresh = (): void => {
    if (loading || refreshing || appending || picking) return;
    const token = generation.current;
    const original = trackRef.current;
    setRefreshing(true);
    setError(null);
    findSourceCandidates(original, { page: 1, size: PAGE_SIZE, force: true })
      .then((res) => {
        if (token !== generation.current) return;
        setItems(res);
        setPage(1);
      })
      .catch((err: unknown) => {
        if (token === generation.current) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (token === generation.current) setRefreshing(false);
      });
  };

  const loadMore = (): void => {
    if (loading || refreshing || appending || picking) return;
    const token = generation.current;
    const original = trackRef.current;
    const next = page + 1;
    setAppending(true);
    findSourceCandidates(original, { page: next, size: PAGE_SIZE })
      .then((res) => {
        if (token !== generation.current) return;
        // 追加时按 key 去重（翻页可能带回头部的热门结果）
        setItems((prev) => {
          const seen = new Set(prev.map((it) => `${it.track.platform}:${it.track.id}`));
          const fresh = res.filter((it) => !seen.has(`${it.track.platform}:${it.track.id}`));
          return fresh.length > 0 ? [...prev, ...fresh] : prev;
        });
        setPage(next);
      })
      .catch(() => {
        if (token === generation.current) setError("加载更多失败，请重新搜索");
      })
      .finally(() => {
        if (token === generation.current) setAppending(false);
      });
  };

  const pick = async (candidate: Track): Promise<void> => {
    if (itemsKey !== trackKey || loading || refreshing || picking) return;
    const original = trackRef.current;
    const token = generation.current;
    setPicking(true);
    setError(null);
    const reservation = reservePlayAction();
    pendingChoice.current = reservation;
    try {
      await savePreferredSource(original, candidate);
      const handle = await reservation;
      if (token !== generation.current || !handle || !isPreparedPlayActionCurrent(handle)) return;
      // 旧队列中可能仍有原歌的别名。作废进程内 URL 后，下一次自动切歌
      // 也会重新经过统一取链入口，从而使用刚保存的偏好。
      const beforeResolve = clearPlayUrlCache();
      // 即使宿主回调同步抛错，清理请求的拒绝也不会变成未处理 Promise。
      void beforeResolve.catch(() => undefined);
      // 回调只能消费点击时已登记的原票，不能在持久化 ACK 后制造更新的意图。
      // store 等待真实清理；后来的 Web / Native 播放意图仍可淘汰这张原票。
      if (!bindPreparedPlayDependency(handle, beforeResolve)) return;
      const action = props.onPick(candidate, original, beforeResolve);
      await Promise.all([beforeResolve, action]);
    } catch (err) {
      if (token === generation.current) setError(err instanceof Error ? err.message : "音源偏好保存失败，请重试");
    } finally {
      void reservation.then((handle) => { if (handle) abandonPreparedPlayAction(handle); });
      if (pendingChoice.current === reservation) pendingChoice.current = null;
      if (token === generation.current) setPicking(false);
    }
  };

  return (
    <div className="w-[380px] max-w-[80vw]">
      <div className="mb-2 flex items-center gap-1.5 text-2xs text-muted-foreground">
        <RefreshCw className="h-3 w-3" />
        <span className="min-w-0 flex-1 truncate">
          在其他音源里找「{props.track.title}」
        </span>
        {/* 结果有缓存（10 分钟内重开弹层直接复用），这里给一条强制重搜的路 */}
        <button
          type="button"
          disabled={loading || refreshing || appending || picking}
          onClick={refresh}
          title="忽略缓存重新搜索"
          className={cn(
            "shrink-0 rounded px-1 py-0.5 transition-colors",
            loading || refreshing || appending || picking ? "opacity-50" : "hover:bg-secondary/60 hover:text-foreground",
          )}
        >
          {refreshing ? "搜索中…" : "重新搜索"}
        </button>
      </div>
      {loading || itemsKey !== trackKey ? (
        <div className="py-4 text-center text-xs text-muted-foreground">正在搜索其他音源…</div>
      ) : error ? (
        <div className="py-3 text-center text-xs text-destructive">
          搜索失败：{error}
          <button
            type="button"
            onClick={() => setAttempt((a) => a + 1)}
            className="ml-2 text-primary hover:underline"
          >
            重试
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="py-4 text-center text-xs text-muted-foreground">
          其他音源没有找到匹配的歌曲
        </div>
      ) : (
        <div className="max-h-72 overflow-y-auto">
          <div className="divide-y divide-border/60">
            {items.map((it) => (
              /* 三列定死：歌名（吃掉剩余宽度，永不塌成 0）/ 歌手（上限 42%）/ 时长。
                 旧版是 flex：歌名那格 `flex-1`（basis 0）+ 歌手 `shrink` 且基数是
                 内容宽。遇到「张信哲、万芳、莫文蔚、杨乃文…」这种十几个歌手的
                 Live 版，负数剩余空间全部由歌手那一格承担（歌名 shrink 基数 0，
                 一点都缩不动），结果**歌名和平台徽标被挤成 0 宽**，整行只剩一长条
                 灰色歌手名（2026-10-29 用户截图反馈）。grid 的 minmax(0,1fr) 给歌名
                 兜底，歌手列封顶 42% 后自己截断，徽标也就不会被吃掉。 */
              <button
                key={`${it.track.platform}:${it.track.id}`}
                type="button"
                disabled={refreshing || picking}
                onClick={() => { void pick(it.track); }}
                // 截断后的全量文本靠原生 tooltip 兜底（歌手常常一屏放不下）
                title={`${it.track.title || "(无标题)"}${it.track.singer ? ` — ${it.track.singer}` : ""}`}
                className="grid w-full grid-cols-[minmax(0,1fr)_minmax(0,42%)_auto] items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-secondary/60 disabled:opacity-50"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate text-xs text-foreground/90">
                    {it.track.title || "(无标题)"}
                  </span>
                  <SourceTag platform={it.track.platform} size="xs" />
                </span>
                <span className="min-w-0 truncate text-right text-2xs text-muted-foreground">
                  {/* 没有歌手就退回专辑，总比留一列空白有用 */}
                  {it.track.singer || it.track.album}
                </span>
                <span className="justify-self-end text-2xs tabular-nums text-muted-foreground/70">
                  {it.track.duration > 0 ? formatTime(it.track.duration * 1000) : ""}
                </span>
              </button>
            ))}
          </div>
          {items.length >= 5 && (
            <button
              type="button"
              disabled={appending || refreshing || picking}
              onClick={loadMore}
              className={cn(
                "mt-1.5 w-full rounded-md py-1.5 text-center text-xs text-muted-foreground transition-colors",
                appending ? "opacity-50" : "hover:bg-secondary/60 hover:text-foreground",
              )}
            >
              {appending ? "正在加载…" : "加载更多"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 就地换源：把队列里当前位置的曲目替换成候选（队列位置与播放进度不动），
 * 不在队列里（queueIndex === null）就单播候选。
 */
export async function replaceCurrentWithCandidate(candidate: Track, original?: Track, beforeResolve?: Promise<unknown>): Promise<void> {
  const { queue, queueIndex, playQueue, state, positionMs } = usePlayerStore.getState();
  if (original && (!state?.track || state.track.id !== original.id || state.track.platform !== original.platform)) return;
  const index = queueIndex !== null && queueIndex >= 0 && queueIndex < queue.length ? queueIndex : 0;
  const patched = queueIndex !== null && queueIndex >= 0 && queueIndex < queue.length
    ? [...queue.slice(0, queueIndex), candidate, ...queue.slice(queueIndex + 1)]
    : [candidate];
  const receipt = await (beforeResolve ? playQueue(patched, index, beforeResolve) : playQueue(patched, index));
  if (receipt.applied && positionMs > 0) await usePlayerStore.getState().seekTo(positionMs, receipt.ticket, receipt.target ?? undefined);
}
