import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { usePlayerStore } from "@/stores/player";
import { SourceTag } from "@/components/common/SourceTag";
import { findSourceCandidates, peekSourceCandidates } from "@/lib/source-switch";
import { formatTime } from "@/lib/lrc";
import { cn } from "@/lib/utils";
import type { Track } from "@/types";

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
  onPick: (candidate: Track) => void;
}): React.JSX.Element {
  const [items, setItems] = useState<{ track: Track; score: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [appending, setAppending] = useState(false);
  /** 重试计数：搜索失败后手动重跑（effect 依赖里参与触发） */
  const [attempt, setAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // 搜索入参用最新 track（字段有更新时翻页也用新的），但**不进 effect 依赖**
  const trackRef = useRef(props.track);
  trackRef.current = props.track;
  const trackKey = `${props.track.platform}:${props.track.id}`;

  useEffect(() => {
    let disposed = false;
    setError(null);
    setPage(1);
    // 命中缓存时**不进 loading**：否则每次开弹层都要闪一下「正在搜索…」，
    // 缓存带来的即时感就没了（缓存是同步写、同步读的，见 lib/source-switch）
    const cached = peekSourceCandidates(trackRef.current);
    if (cached !== null) {
      setItems(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    findSourceCandidates(trackRef.current)
      .then((res) => {
        if (!disposed) setItems(res);
      })
      .catch((err: unknown) => {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
    // 依赖必须是**稳定 key**而不是 track 对象本身：播放心跳每次快照都会造出一个
    // 字段全等的新 track 对象，按对象引用依赖会让这个 effect 无限重跑 —— 表现就是
    // 「正在搜索…」与结果列表交替闪（同一首歌被反复聚合搜索）。
  }, [trackKey, attempt]);

  /** 忽略缓存重搜（用户点「重新搜索」）：force 会覆盖缓存条目 */
  const refresh = (): void => {
    setRefreshing(true);
    setError(null);
    findSourceCandidates(trackRef.current, { page: 1, size: PAGE_SIZE, force: true })
      .then((res) => {
        setItems(res);
        setPage(1);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setRefreshing(false));
  };

  const loadMore = (): void => {
    const next = page + 1;
    setAppending(true);
    findSourceCandidates(trackRef.current, { page: next, size: PAGE_SIZE })
      .then((res) => {
        // 追加时按 key 去重（翻页可能带回头部的热门结果）
        setItems((prev) => {
          const seen = new Set(prev.map((it) => `${it.track.platform}:${it.track.id}`));
          const fresh = res.filter((it) => !seen.has(`${it.track.platform}:${it.track.id}`));
          return fresh.length > 0 ? [...prev, ...fresh] : prev;
        });
        setPage(next);
      })
      .catch(() => {})
      .finally(() => setAppending(false));
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
          disabled={loading || refreshing}
          onClick={refresh}
          title="忽略缓存重新搜索"
          className={cn(
            "shrink-0 rounded px-1 py-0.5 transition-colors",
            loading || refreshing ? "opacity-50" : "hover:bg-secondary/60 hover:text-foreground",
          )}
        >
          {refreshing ? "搜索中…" : "重新搜索"}
        </button>
      </div>
      {loading ? (
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
                onClick={() => props.onPick(it.track)}
                // 截断后的全量文本靠原生 tooltip 兜底（歌手常常一屏放不下）
                title={`${it.track.title || "(无标题)"}${it.track.singer ? ` — ${it.track.singer}` : ""}`}
                className="grid w-full grid-cols-[minmax(0,1fr)_minmax(0,42%)_auto] items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-secondary/60"
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
              disabled={appending}
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
export async function replaceCurrentWithCandidate(candidate: Track): Promise<void> {
  const { queue, queueIndex, play, playQueue } = usePlayerStore.getState();
  if (queueIndex !== null && queueIndex >= 0 && queueIndex < queue.length) {
    const patched = [...queue.slice(0, queueIndex), candidate, ...queue.slice(queueIndex + 1)];
    await playQueue(patched, queueIndex);
  } else {
    await play(candidate);
  }
}
