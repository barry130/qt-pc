import { useEffect, useRef, useState } from "react";
import { GripVertical, ListMusic, Trash2, X } from "lucide-react";
import * as ipc from "@/services/ipc";
import { usePlayerStore } from "@/stores/player";
import { qtresCoverUrl, formatTime } from "@/lib/lrc";
import { cn } from "@/lib/utils";
import { LocalCover } from "@/components/library/LocalCover";

/**
 * 播放队列面板（DESIGN §5.5 QueueButton / §11.5 队列 2.0）。
 *
 * 挂在 AppShell 主区右侧的布局级面板：高度撑满内容区、宽度固定 320px，
 * 主内容区相应收缩。当前曲高亮，点击行 play_at 跳曲。
 *
 * 队列 2.0 新增：单曲移除、拖动排序、下一首播放、清空后续；
 * 批量管理：多选（含全选）后一次移除，走 queue_remove_indices 单事件重排。
 */
export function QueuePanel(): React.JSX.Element | null {
  const queue = usePlayerStore((s) => s.queue);
  const queueIndex = usePlayerStore((s) => s.queueIndex);
  const currentTrackId = usePlayerStore((s) => s.state?.trackId ?? null);
  const playAt = usePlayerStore((s) => s.playAt);
  const open = usePlayerStore((s) => s.queueOpen);
  const setQueueOpen = usePlayerStore((s) => s.setQueueOpen);

  // 当前曲下标：优先用 Rust 给的 queueIndex；它为 null 时（队列事件还没同步、
  // 或播的是没走队列的曲子）按当前曲目 id 在队列里回退查找，保证高亮与定位都能命中
  const fallbackIndex = queue.findIndex((t) => t.id === currentTrackId);
  const activeIndex = queueIndex ?? (fallbackIndex >= 0 ? fallbackIndex : null);
  const currentRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 拖动排序：dragIndex 为被拖的行，overIndex 为当前悬停的行
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  // 批量管理：选择模式下的已选下标集合（按移除前位置发给引擎）
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);

  // 退出选择模式 / 队列变化后清掉选择，避免残留失效下标
  useEffect(() => {
    if (!selecting) setSelected(new Set());
  }, [selecting]);
  useEffect(() => {
    setSelected(new Set());
  }, [queue.length]);

  // 打开面板时把当前曲目滚到列表可视区中央（队列长的时候不定位就得手动翻找）。
  // 这里直接算 scrollTop，而不用 scrollIntoView —— 后者会连带滚动所有可滚动祖先，
  // 在这套嵌套布局里行为不好预期。
  // 只在 open 变化时触发：面板已打开时用户可能在自己浏览，切歌就别抢滚动条了。
  useEffect(() => {
    if (!open) return;
    const scrollToCurrent = (): void => {
      const box = listRef.current;
      const el = currentRef.current;
      if (!box) return;
      if (!el) {
        box.scrollTop = 0; // 没有当前曲（未播放）就回到顶部
        return;
      }
      const boxRect = box.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      box.scrollTop +=
        elRect.top - boxRect.top - (box.clientHeight - el.clientHeight) / 2;
    };
    // 两帧：第一帧等列表 DOM 插入并完成布局，第二帧等行高（封面占位）稳定
    let raf2 = 0;
    const raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(scrollToCurrent);
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, [open]);

  if (!open) return null;

  const dropAt = (to: number): void => {
    if (dragIndex !== null && to >= 0 && to < queue.length && dragIndex !== to) {
      void ipc.queueMove(dragIndex, to).catch((err) => {
        // 拖拽排序失败不上浮全局错误浮层，留排查日志即可
        console.error("[queue] 拖拽排序失败", err);
      });
    }
    setDragIndex(null);
    setOverIndex(null);
  };

  const toggleOne = (i: number): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const deleteSelected = async (): Promise<void> => {
    if (selected.size === 0) return;
    setDeleting(true);
    try {
      await ipc.queueRemoveIndices([...selected]);
      setSelecting(false);
    } catch (err) {
      // 批量删除失败不上浮全局错误浮层：与列表页就地报错对齐，留日志可排查
      console.error("[queue] 批量删除失败", err);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <aside className="flex h-full w-[320px] shrink-0 flex-col border-l border-border bg-card/60 backdrop-blur-sm">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
        {selecting ? (
          <>
            <div className="flex items-center gap-2 text-sm font-medium">
              已选 {selected.size} / {queue.length}
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() =>
                  setSelected(
                    selected.size === queue.length
                      ? new Set()
                      : new Set(queue.map((_, i) => i)),
                  )
                }
                className="rounded px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                {selected.size === queue.length ? "全不选" : "全选"}
              </button>
              <button
                type="button"
                onClick={() => void deleteSelected()}
                disabled={deleting || selected.size === 0}
                className="rounded px-1.5 py-1 text-[11px] text-destructive transition-colors hover:bg-secondary disabled:opacity-40"
              >
                {deleting ? "删除中…" : "删除"}
              </button>
              <button
                type="button"
                aria-label="退出批量管理"
                onClick={() => setSelecting(false)}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm font-medium">
              <ListMusic className="h-4 w-4" />
              播放队列（{queue.length}）
            </div>
            <div className="flex items-center gap-1">
              {queue.length > 1 && (
                <button
                  type="button"
                  aria-label="批量管理"
                  title="批量管理"
                  onClick={() => setSelecting(true)}
                  className="rounded px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  批量
                </button>
              )}
              {activeIndex !== null && activeIndex < queue.length - 1 && (
                <button
                  type="button"
                  aria-label="清空后续"
                  title="清空后续"
                  onClick={() =>
                    void ipc.queueClearAfter().catch((err) => {
                      console.error("[queue] 清空后续失败", err);
                    })
                  }
                  className="rounded px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  清空后续
                </button>
              )}
              {queue.length > 0 && (
                <button
                  type="button"
                  aria-label="清空队列"
                  title="清空队列"
                  onClick={() =>
                    void ipc.clearQueue().catch((err) => {
                      console.error("[queue] 清空队列失败", err);
                    })
                  }
                  className="rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
              <button
                type="button"
                aria-label="关闭队列"
                onClick={() => setQueueOpen(false)}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </>
        )}
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        {queue.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            队列为空
          </p>
        ) : (
          queue.map((t, i) => (
            <div
              key={`${t.id}-${i}`}
              ref={i === activeIndex ? currentRef : null}
              role="button"
              tabIndex={0}
              draggable={!selecting}
              onDragStart={() => setDragIndex(i)}
              onDragEnd={() => {
                setDragIndex(null);
                setOverIndex(null);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (overIndex !== i) setOverIndex(i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                dropAt(i);
              }}
              onClick={() => (selecting ? toggleOne(i) : void playAt(i))}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (selecting) toggleOne(i);
                  else void playAt(i);
                }
              }}
              className={cn(
                "group flex w-full cursor-pointer items-center gap-2 px-2 py-2 text-left transition-colors hover:bg-secondary",
                i === activeIndex && "bg-secondary/60",
                selected.has(i) && "bg-primary/5",
                dragIndex === i && "opacity-50",
                overIndex === i && dragIndex !== null && dragIndex !== i
                  ? "border-t-2 border-primary"
                  : "border-t-2 border-transparent",
              )}
            >
              {selecting ? (
                <span
                  aria-hidden
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                    selected.has(i)
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-muted-foreground/40",
                  )}
                >
                  {selected.has(i) && (
                    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none">
                      <path
                        d="M2.5 6.5L5 9l4.5-5.5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </span>
              ) : (
                <GripVertical
                  className="h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground/40"
                  aria-hidden
                />
              )}
              <div className="h-8 w-8 shrink-0 overflow-hidden rounded bg-secondary">
                {t.platform === "local" ? (
                  <LocalCover path={t.id} className="h-full w-full object-cover" />
                ) : (
                  qtresCoverUrl(t.picUrl) && (
                    <img
                      src={qtresCoverUrl(t.picUrl) as string}
                      alt=""
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  )
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div
                  className={cn(
                    "truncate text-xs",
                    i === activeIndex ? "text-primary" : "text-foreground",
                  )}
                >
                  {t.title}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {t.singer}
                </div>
              </div>
              {t.duration > 0 && (
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {formatTime(t.duration * 1000)}
                </span>
              )}
              {/* 行内操作：悬停才出现，避免平时干扰阅读；批量模式下不显示（点击行本身即选择） */}
              {!selecting && (
                <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    type="button"
                    title="下一首播放"
                    aria-label="下一首播放"
                    onClick={(e) => {
                      e.stopPropagation();
                      const target =
                        activeIndex === null ? 0 : Math.min(activeIndex + 1, queue.length - 1);
                      void ipc.queueMove(i, target);
                    }}
                    className="rounded px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                  >
                    下一首
                  </button>
                  <button
                    type="button"
                    title="从队列移除"
                    aria-label="从队列移除"
                    onClick={(e) => {
                      e.stopPropagation();
                      void ipc.queueRemoveAt(i);
                    }}
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-destructive"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
