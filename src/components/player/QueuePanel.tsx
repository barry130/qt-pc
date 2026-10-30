import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GripVertical,
  ListChecks,
  ListMusic,
  ListX,
  LocateFixed,
  Square,
  SquareCheckBig,
  SquareMinus,
  Trash2,
  X,
} from "lucide-react";
import * as ipc from "@/services/ipc";
import { usePlayerStore } from "@/stores/player";
import { qtresCoverUrl, formatTime } from "@/lib/lrc";
import { cn, errMsg } from "@/lib/utils";
import { SourceTag } from "@/components/common/SourceTag";
import { log } from "@/lib/logger";
import { toastError } from "@/stores/toast";
import { LocalCover } from "@/components/library/LocalCover";
import { IconButton } from "@/components/common/IconButton";
import { PlayNextIcon } from "@/components/common/PlayNextIcon";
import type { Track } from "@/types";

type QueueSnapshot = {
  queue: Track[];
  keys: string[];
  hasDuplicates: boolean;
};

function trackKey(track: Track): string {
  return JSON.stringify([
    track.platform,
    track.id,
    track.startMs ?? null,
    track.endMs ?? null,
  ]);
}

function snapshotQueue(queue: Track[]): QueueSnapshot {
  const keys = queue.map(trackKey);
  return { queue, keys, hasDuplicates: new Set(keys).size !== keys.length };
}

function matchesQueueKeys(
  snapshot: QueueSnapshot,
  keys: string[],
  queue: Track[],
): boolean {
  return (
    snapshot.keys.length === keys.length &&
    // 重复身份没有队列条目 ID，新快照无法确认条目顺序，保守作废。
    (!snapshot.hasDuplicates || snapshot.queue === queue) &&
    snapshot.keys.every((key, i) => key === keys[i])
  );
}

function matchesQueue(snapshot: QueueSnapshot, queue: Track[]): boolean {
  return matchesQueueKeys(snapshot, queue.map(trackKey), queue);
}

const EMPTY_SELECTION = new Set<number>();

/**
 * 播放队列面板（DESIGN §5.5 QueueButton / §11.5 队列 2.0）。
 *
 * 挂在 AppShell 主区右侧的布局级面板：高度撑满内容区、宽度固定 320px，
 * 主内容区相应收缩。当前曲高亮，点击行 play_at 跳曲。
 *
 * 队列 2.0 新增：单曲移除、拖动排序、下一首播放、清空后续；
 * 批量管理：多选（含全选）后一次移除，走 queue_remove_indices 单事件重排。
 *
 * 拖动排序走 **pointer 事件自绘**，不用 draggable / dragover / drop（见下方
 * startPointerDrag 的注释）：Tauri 在 Windows 上会把整个窗口的 OLE IDropTarget
 * 换成自己的，页面内的 HTML5 拖放事件被它压掉，表现为「拖了没反应」。
 */
export function QueuePanel(): React.JSX.Element | null {
  const queue = usePlayerStore((s) => s.queue);
  const queueIndex = usePlayerStore((s) => s.queueIndex);
  const currentTrackId = usePlayerStore((s) => s.state?.trackId ?? null);
  const currentPlatform = usePlayerStore(
    (s) => s.state?.track?.platform ?? s.state?.sourceId ?? null,
  );
  const playAt = usePlayerStore((s) => s.playAt);
  const open = usePlayerStore((s) => s.queueOpen);
  const setQueueOpen = usePlayerStore((s) => s.setQueueOpen);

  // 优先使用有效的引擎下标；镜像尚未同步时以 platform + id 回退，避免跨源同 ID 误命中。
  const fallbackIndex = queue.findIndex(
    (t) => t.id === currentTrackId && t.platform === currentPlatform,
  );
  const activeIndex =
    queueIndex !== null &&
    Number.isInteger(queueIndex) &&
    queueIndex >= 0 &&
    queueIndex < queue.length
      ? queueIndex
      : fallbackIndex >= 0
        ? fallbackIndex
        : null;
  const currentRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 拖动排序：dragIndex 为被拖的行，overIndex 为当前悬停的行
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  // 本次按下的原始信息（起始行 / 起始 Y / 是否已越过阈值）。用 ref 而非 state：
  // move 事件每帧都来，走 state 会丢帧且闭包里读到的常是旧值。
  const dragRef = useRef<{
    pointerId: number;
    index: number;
    startY: number;
    active: boolean;
    overIndex: number;
    element: HTMLElement;
    snapshot: QueueSnapshot;
  } | null>(null);
  // 刚拖完立即抬手时浏览器仍会补一个 click，用它吃掉（否则拖完会顺手切歌）
  const justDraggedRef = useRef(false);
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<{
    snapshot: QueueSnapshot;
    indices: Set<number>;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 行组件 memo 的配套：queueKeys 只在队列变化时重算一次，行 key 与选择校验
  // 共用，不再每行每渲染各做一次 JSON.stringify（#14）。
  const queueKeys = useMemo(() => queue.map(trackKey), [queue]);
  const selected =
    selection && matchesQueueKeys(selection.snapshot, queueKeys, queue)
      ? selection.indices
      : EMPTY_SELECTION;

  // 行事件处理器要做成身份稳定的 useCallback，就必然会跨渲染存活；里面读到
  // 的渲染值（queue/selecting/activeIndex/dragIndex）走 latest-ref，提交时取最新。
  const queueRef = useRef(queue);
  const selectingRef = useRef(selecting);
  const activeIndexRef = useRef(activeIndex);
  const dragIndexRef = useRef<number | null>(null);
  useEffect(() => {
    queueRef.current = queue;
    selectingRef.current = selecting;
    activeIndexRef.current = activeIndex;
  });

  const resetPointerDrag = useCallback((suppressClick: boolean): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    dragIndexRef.current = null;
    if (suppressClick) justDraggedRef.current = true;
    setDragIndex(null);
    setOverIndex(null);
    // 先清 ref：releasePointerCapture 同步触发 lostpointercapture 时不能再提交或取消一次。
    if (drag?.element.hasPointerCapture(drag.pointerId)) {
      drag.element.releasePointerCapture(drag.pointerId);
    }
  }, []);

  const cancelPointerDrag = useCallback((): void => {
    if (dragRef.current) resetPointerDrag(true);
  }, [resetPointerDrag]);

  // 行位置一旦变化，原下标不再可信；唯一身份且顺序相同的元数据刷新保留选择。
  useEffect(() => {
    setSelection((prev) =>
      prev && (!open || !selecting || !matchesQueue(prev.snapshot, queue))
        ? null
        : prev,
    );
    if (!open) setSelecting(false);
    const drag = dragRef.current;
    if (!open || (drag && !matchesQueue(drag.snapshot, queue))) {
      cancelPointerDrag();
    }
  }, [open, queue, selecting, cancelPointerDrag]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || !dragRef.current) return;
      event.preventDefault();
      cancelPointerDrag();
    };
    const onVisibilityChange = (): void => {
      if (document.hidden) cancelPointerDrag();
    };
    window.addEventListener("blur", cancelPointerDrag);
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", cancelPointerDrag);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      cancelPointerDrag();
    };
  }, [open, cancelPointerDrag]);

  const scrollToCurrent = useCallback((): void => {
    const box = listRef.current;
    const el = currentRef.current;
    if (!box) return;
    if (!el) {
      box.scrollTop = 0;
      return;
    }
    const boxRect = box.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    box.scrollTop +=
      elRect.top - boxRect.top - (box.clientHeight - el.clientHeight) / 2;
  }, []);

  // 打开面板时把当前曲目滚到列表可视区中央（队列长的时候不定位就得手动翻找）。
  // 这里直接算 scrollTop，而不用 scrollIntoView —— 后者会连带滚动所有可滚动祖先，
  // 在这套嵌套布局里行为不好预期。
  // 只在 open 变化时触发：面板已打开时用户可能在自己浏览，切歌就别抢滚动条了。
  useEffect(() => {
    if (!open) return;
    // 两帧：第一帧等列表 DOM 插入并完成布局，第二帧等行高（封面占位）稳定
    let raf2 = 0;
    const raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(scrollToCurrent);
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, [open, scrollToCurrent]);

  /**
   * 拖动排序的落点提交。
   *
   * 不用 HTML5 拖放（draggable / dragover / drop）：Tauri 在 Windows 上会把自己
   * 的 OLE IDropTarget 注册到窗口的每个子 HWND 上（`wry` 的 drag_drop.rs 用
   * EnumChildWindows 逐个 RevokeDragDrop + RegisterDragDrop），而这个 target 只认
   * CF_HDROP（外部文件拖入），页面内的 dragstart/dragover/drop 全被它压掉 ——
   * 表现就是「拖了没反应」。队列内部排序改成 pointer 事件自绘（与播放条的
   * 进度条 / 音量条同一套写法），与窗口接收外部文件拖入的处理互不干扰。
   */
  const dropAt = useCallback(
    (to: number): void => {
      const drag = dragRef.current;
      const latest = usePlayerStore.getState();
      if (
        drag &&
        latest.queueOpen &&
        matchesQueue(drag.snapshot, latest.queue) &&
        to >= 0 &&
        to < latest.queue.length &&
        drag.index !== to
      ) {
        void ipc.queueMove(drag.index, to).catch((err) => {
          log.warn("[queue] 拖拽排序失败", err);
        });
      }
      // 越过阈值的拖动即使回到原位，也必须吃掉浏览器补发的 click。
      resetPointerDrag(true);
    },
    [resetPointerDrag],
  );

  /**
   * 按下手柄：先只登记起点，等移动超过阈值（4px）才真正进入拖动态 ——
   * 否则普通点击切歌会被判成一次零位移拖拽。
   *
   * 按下点落在行内按钮上（「下一首」/「移除」）不启动拖拽，让按钮自己处理点击。
   */
  const startPointerDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, i: number): void => {
      if (e.button !== 0) return;
      // 新一轮真实按下不属于上次拖动的尾随 click，选择模式和行内按钮也一样。
      justDraggedRef.current = false;
      if (selectingRef.current) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest("button")) return;
      cancelPointerDrag();
      dragRef.current = {
        pointerId: e.pointerId,
        index: i,
        startY: e.clientY,
        active: false,
        overIndex: i,
        element: e.currentTarget,
        snapshot: snapshotQueue(queueRef.current),
      };
      justDraggedRef.current = false;
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [cancelPointerDrag],
  );

  /**
   * 命中测试：指针下面那一行的下标。
   *
   * 不能用回调自带的 i —— 一旦 setPointerCapture，后续 pointermove 全部重定向到
   * 捕获元素（也就是起始行），拿到的永远是起点下标。故按坐标做真实命中测试，
   * 行上挂 data-queue-index 供查找；指针飘到列表外时返回 null，保留上一次落点。
   */
  const indexAtPoint = useCallback(
    (x: number, y: number): number | null => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      const row = el?.closest("[data-queue-index]") as HTMLElement | null;
      if (!row || !listRef.current?.contains(row)) return null;
      const raw = Number(row.dataset.queueIndex);
      return Number.isInteger(raw) && raw >= 0 && raw < queueRef.current.length
        ? raw
        : null;
    },
    [],
  );

  const movePointerDrag = useCallback(
    (e: React.PointerEvent): void => {
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      const latest = usePlayerStore.getState();
      if (!latest.queueOpen || !matchesQueue(d.snapshot, latest.queue)) {
        cancelPointerDrag();
        return;
      }
      // 越过阈值才点亮拖动态：避免手抖把点击吃掉，也避免误触就整行变淡
      if (!d.active) {
        if (Math.abs(e.clientY - d.startY) < 4) return;
        d.active = true;
      }
      if (dragIndexRef.current !== d.index) {
        dragIndexRef.current = d.index;
        setDragIndex(d.index);
      }
      const over = indexAtPoint(e.clientX, e.clientY) ?? d.overIndex;
      d.overIndex = over;
      setOverIndex(over);
    },
    [cancelPointerDrag, indexAtPoint],
  );

  const endPointerDrag = useCallback(
    (e: React.PointerEvent): void => {
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      const latest = usePlayerStore.getState();
      if (!latest.queueOpen || !matchesQueue(d.snapshot, latest.queue)) {
        cancelPointerDrag();
      } else if (d.active) {
        const over = indexAtPoint(e.clientX, e.clientY) ?? d.overIndex;
        dropAt(over);
      } else {
        // 没越过阈值＝这是一次点击，交给 onClick 走切歌。
        resetPointerDrag(false);
      }
    },
    [cancelPointerDrag, indexAtPoint, dropAt, resetPointerDrag],
  );

  const cancelPointerEvent = useCallback(
    (e: React.PointerEvent): void => {
      if (dragRef.current?.pointerId === e.pointerId) cancelPointerDrag();
    },
    [cancelPointerDrag],
  );

  const toggleOne = useCallback(
    (i: number): void => {
      setSelection((prev) => {
        const next = new Set(
          prev && matchesQueue(prev.snapshot, queueRef.current)
            ? prev.indices
            : [],
        );
        if (next.has(i)) next.delete(i);
        else next.add(i);
        return { snapshot: snapshotQueue(queueRef.current), indices: next };
      });
    },
    [],
  );

  const selectAll = useCallback((): void => {
    cancelPointerDrag();
    setSelecting(true);
    const q = queueRef.current;
    setSelection({
      snapshot: snapshotQueue(q),
      indices: new Set(q.map((_, i) => i)),
    });
  }, [cancelPointerDrag]);

  // 行内「下一首播放」：引擎先移除再插入；来自当前曲之前的行会让当前下标减一。
  const playNextAt = useCallback(
    (i: number): void => {
      const ai = activeIndexRef.current;
      if (i === ai) return;
      const len = queueRef.current.length;
      const target = ai === null ? 0 : i < ai ? ai : Math.min(ai + 1, len - 1);
      void ipc.queueMove(i, target).catch((err) => {
        log.warn("[queue] 下一首播放失败", err);
        toastError(`下一首播放失败：${errMsg(err)}`);
      });
    },
    [],
  );

  const removeAt = useCallback(
    (i: number): void => {
      void ipc.queueRemoveAt(i).catch((err) => {
        log.warn("[queue] 移除失败", err);
        toastError(`从队列移除失败：${errMsg(err)}`);
      });
    },
    [],
  );

  const handleRowClick = useCallback(
    (e: React.MouseEvent, i: number): void => {
      if ((e.target as HTMLElement).closest("button")) return;
      // 刚拖完的那一下 click 是浏览器补的，不当作切歌
      if (justDraggedRef.current) {
        justDraggedRef.current = false;
        return;
      }
      if (selectingRef.current) toggleOne(i);
      else void playAt(i);
    },
    [toggleOne, playAt],
  );

  const handleRowKeyDown = useCallback(
    (e: React.KeyboardEvent, i: number): void => {
      // 行内原生按钮保留 Enter / Space 等默认语义，不把冒泡当成行快捷键。
      if (e.target !== e.currentTarget) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectAll();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelPointerDrag();
        setSelecting(false);
        setSelection(null);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (selectingRef.current) toggleOne(i);
        else void playAt(i);
      }
    },
    [selectAll, cancelPointerDrag, toggleOne, playAt],
  );

  if (!open) return null;

  const deleteSelected = async (): Promise<void> => {
    if (
      deleting ||
      !selection ||
      selected.size === 0 ||
      !matchesQueue(selection.snapshot, usePlayerStore.getState().queue)
    ) return;
    setDeleting(true);
    try {
      await ipc.queueRemoveIndices([...selected]);
      setSelecting(false);
    } catch (err) {
      // 批量删除失败不上浮全局错误浮层，也不在面板里堆红字（选择集还得留着
      // 重试）：右上角一条红 Toast 告知即可，日志照留可排查
      log.warn("[queue] 批量删除失败", err);
      toastError(`批量删除失败：${errMsg(err)}`);
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
              <IconButton
                label="定位当前播放"
                size="md"
                hover="secondary"
                disabled={activeIndex === null}
                onClick={scrollToCurrent}
              >
                <LocateFixed />
              </IconButton>
              <IconButton
                label={selected.size === queue.length ? "全不选" : "全选"}
                size="lg"
                hover="secondary"
                onClick={() =>
                  selected.size === queue.length
                    ? setSelection(null)
                    : selectAll()
                }
              >
                {/* 图标说的是「当前状态」而不是「点了会变成什么」：全选 → 勾选方框；
                    只选了一部分 → 半选方框；一首没选 → 空方框。 */}
                {selected.size === queue.length ? (
                  <SquareCheckBig />
                ) : selected.size > 0 ? (
                  <SquareMinus />
                ) : (
                  <Square />
                )}
              </IconButton>
              <IconButton
                label={deleting ? "删除中…" : `删除已选（${selected.size}）`}
                size="lg"
                hover="secondary"
                danger
                disabled={deleting || selected.size === 0}
                onClick={() => void deleteSelected()}
              >
                <Trash2 />
              </IconButton>
              <IconButton
                label="退出批量管理"
                size="lg"
                hover="secondary"
                onClick={() => setSelecting(false)}
              >
                <X />
              </IconButton>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm font-medium">
              <ListMusic className="h-4 w-4" />
              播放队列（{queue.length}）
            </div>
            <div className="flex items-center gap-1">
              <IconButton
                label="定位当前播放"
                size="md"
                hover="secondary"
                disabled={activeIndex === null}
                onClick={scrollToCurrent}
              >
                <LocateFixed />
              </IconButton>
              {queue.length > 1 && (
                <IconButton
                  label="批量管理"
                  size="lg"
                  hover="secondary"
                  onClick={() => {
                    cancelPointerDrag();
                    setSelecting(true);
                  }}
                >
                  <ListChecks />
                </IconButton>
              )}
              {activeIndex !== null && activeIndex < queue.length - 1 && (
                <IconButton
                  label="清空后续"
                  size="lg"
                  hover="secondary"
                  onClick={() =>
                    void ipc.queueClearAfter().catch((err) => {
                      log.warn("[queue] 清空后续失败", err);
                      toastError(`清空后续失败：${errMsg(err)}`);
                    })
                  }
                >
                  <ListX />
                </IconButton>
              )}
              {queue.length > 0 && (
                <IconButton
                  label="清空队列"
                  size="lg"
                  hover="secondary"
                  danger
                  onClick={() =>
                    void ipc
                      .clearQueue()
                      // 乐观清空：引擎随后会推 queue 事件，但那一跳要等 IPC 往返，
                      // 面板会先闪一帧旧队列；这里立刻按空队列渲染，事件到达时幂等覆盖。
                      .then(() => usePlayerStore.getState().applyQueue({ tracks: [], index: null }))
                      .catch((err) => {
                        log.warn("[queue] 清空队列失败", err);
                        toastError(`清空队列失败：${errMsg(err)}`);
                      })
                  }
                >
                  <Trash2 />
                </IconButton>
              )}
              <IconButton
                label="关闭队列"
                size="lg"
                hover="secondary"
                onClick={() => setQueueOpen(false)}
              >
                <X />
              </IconButton>
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
            <QueueRow
              // 行 key 复用上面算好的 queueKeys，不再逐行 JSON.stringify（#14）
              key={`${queueKeys[i]}-${i}`}
              track={t}
              index={i}
              active={i === activeIndex}
              selecting={selecting}
              checked={selected.has(i)}
              dragging={dragIndex === i}
              dropTarget={overIndex === i && dragIndex !== null && dragIndex !== i}
              rowRef={i === activeIndex ? currentRef : null}
              onRowPointerDown={startPointerDrag}
              onRowPointerMove={movePointerDrag}
              onRowPointerUp={endPointerDrag}
              onRowPointerCancel={cancelPointerEvent}
              onRowClick={handleRowClick}
              onRowKeyDown={handleRowKeyDown}
              onPlayNext={playNextAt}
              onRemove={removeAt}
            />
          ))
        )}
      </div>
    </aside>
  );
}

type QueueRowProps = {
  track: Track;
  index: number;
  active: boolean;
  selecting: boolean;
  checked: boolean;
  dragging: boolean;
  dropTarget: boolean;
  rowRef: React.RefObject<HTMLDivElement | null> | null;
  onRowPointerDown: (e: React.PointerEvent<HTMLDivElement>, i: number) => void;
  onRowPointerMove: (e: React.PointerEvent) => void;
  onRowPointerUp: (e: React.PointerEvent) => void;
  onRowPointerCancel: (e: React.PointerEvent) => void;
  onRowClick: (e: React.MouseEvent, i: number) => void;
  onRowKeyDown: (e: React.KeyboardEvent, i: number) => void;
  onPlayNext: (i: number) => void;
  onRemove: (i: number) => void;
};

/**
 * 单行队列条目（#12：从 QueuePanel 抽成 memo 叶子组件）。
 *
 * 面板每 100ms 会随播放进度重渲一次；行内 props 全是原始值或稳定回调，
 * memo 后只有真正变化的那一行重新渲染。回调一律由父级 useCallback 提供。
 */
const QueueRow = memo(function QueueRow({
  track: t,
  index: i,
  active,
  selecting,
  checked,
  dragging,
  dropTarget,
  rowRef,
  onRowPointerDown,
  onRowPointerMove,
  onRowPointerUp,
  onRowPointerCancel,
  onRowClick,
  onRowKeyDown,
  onPlayNext,
  onRemove,
}: QueueRowProps): React.JSX.Element {
  const cover = t.platform === "local" ? null : qtresCoverUrl(t.picUrl);
  return (
    <div
      ref={rowRef}
      role="button"
      tabIndex={0}
      aria-current={active ? "true" : undefined}
      aria-pressed={selecting ? checked : undefined}
      // 拖动排序走 pointer 自绘（见 startPointerDrag）：行上挂下标供命中测试
      data-queue-index={i}
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
      onPointerDown={(e) => onRowPointerDown(e, i)}
      onPointerMove={onRowPointerMove}
      onPointerUp={onRowPointerUp}
      onPointerCancel={onRowPointerCancel}
      onLostPointerCapture={onRowPointerCancel}
      onClick={(e) => onRowClick(e, i)}
      onKeyDown={(e) => onRowKeyDown(e, i)}
      className={cn(
        // cv-row：视口外的行跳过布局与绘制（见 index.css）。队列可长达数百条，
        // 拖拽 / 多选时每次重渲都要处理全部行，跳绘能明显减轻滚动与拖拽的掉帧。
        "cv-row group flex w-full cursor-pointer items-center gap-2 px-2 py-2 text-left transition-colors hover:bg-secondary",
        active && "bg-secondary/60",
        checked && "bg-primary/5",
        dragging && "opacity-50",
        dropTarget
          ? "border-t-2 border-primary"
          : "border-t-2 border-transparent",
      )}
    >
      {selecting ? (
        <span
          aria-hidden
          className={cn(
            "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
            checked
              ? "border-primary bg-primary text-primary-foreground"
              : "border-muted-foreground/40",
          )}
        >
          {checked && (
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
          cover && (
            <img
              src={cover}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
            />
          )
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              "truncate text-xs",
              active ? "text-primary" : "text-foreground",
            )}
          >
            {t.title}
          </span>
          <SourceTag platform={t.platform} size="xs" />
        </div>
        <div className="truncate text-2xs text-muted-foreground">
          {t.singer}
        </div>
      </div>
      {t.duration > 0 && (
        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
          {formatTime(t.duration * 1000)}
        </span>
      )}
      {/* 行内操作：悬停才出现，避免平时干扰阅读；批量模式下不显示（点击行本身即选择） */}
      {!selecting && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <IconButton
            label="下一首播放"
            disabled={active}
            onClick={(e) => {
              e.stopPropagation();
              if (active) return;
              onPlayNext(i);
            }}
          >
            <PlayNextIcon />
          </IconButton>
          <IconButton
            label="从队列移除"
            danger
            onClick={(e) => {
              e.stopPropagation();
              onRemove(i);
            }}
          >
            <X />
          </IconButton>
        </div>
      )}
    </div>
  );
});
