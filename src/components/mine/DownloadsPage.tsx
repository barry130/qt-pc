import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eraser, ListEnd, Pause, Play, RotateCcw, X } from "lucide-react";
import { formatBytes } from "@/lib/format";
import { errMsg } from "@/lib/utils";
import type { DownloadTask, Track } from "@/types";
import * as ipc from "@/services/ipc";
import { useDownloadsStore } from "@/stores/downloads";
import { usePlayerStore } from "@/stores/player";
import { toastError, toastSuccess } from "@/stores/toast";
import { BatchDeleteButton, RowActions } from "@/components/common/RowActions";
import { IconButton } from "@/components/common/IconButton";
import { PlayNextIcon } from "@/components/common/PlayNextIcon";
import { CollectButton } from "@/components/mine/CollectButton";
import { useFavoriteFlags } from "@/hooks/useFavoriteFlags";
import { useFavoritesStore } from "@/stores/favorites";
import { useKeepAliveActive } from "@/components/layout/keepAliveActive";

const STATUS_LABEL: Record<DownloadTask["status"], string> = {
  pending: "等待中",
  downloading: "下载中",
  paused: "已暂停",
  done: "已完成",
  failed: "失败",
  canceled: "已取消",
};

/** 字节数 → 人类可读（下载大小展示用） */
// formatBytes 合并到 `@/lib/format`（与设置页同一实现）。

/**
 * 已完成的任务 → 可直接播放的本地曲目。
 *
 * 引擎的本地分支认的是 `platform === "local"` + `Track.id = 文件绝对路径`
 * （见 audio/engine.rs 的 LoadJob::run 与 services/ipc.ts 的本地音乐约定），
 * 所以下载完的文件本质上就是一首本地曲目，不需要另开一条「播下载文件」的通路。
 * 元数据（歌名/歌手/专辑/封面/时长）沿用原在线曲目那份，比从文件名反解准。
 *
 * 未完成 / 没有落盘路径（历史任务、失败任务）返回 null，调用方据此不给播放入口。
 */
function playableLocalTrack(t: DownloadTask): Track | null {
  if (t.status !== "done" || !t.filePath) return null;
  return {
    ...t.track,
    id: t.filePath,
    platform: "local",
    // 下载文件是整首，CUE 分轨的区间对本地文件没有意义
    startMs: null,
    endMs: null,
  };
}

/**
 * 下载管理（路由 /downloads，DESIGN §5.3 下载 2.0）。
 *
 * 任务真值在 Rust 侧：状态变化广播 `downloads-changed` 立即刷新，
 * 进行中的任务额外按 1s 轮询拿进度（进度写库不广播，避免高频事件）。
 *
 * 行内操作与本地曲库一致：定位 / 删除都是图标按钮（悬停有文字提示），
 * 删除走下拉菜单（只删记录 / 连文件一起删）；列表支持全选 + 批量管理
 * （删除 / 暂停 / 继续 / 取消，2026-11 下载管理完善）。批量版 IPC 与单条
 * 同语义，只是按 id 列表过滤执行，不适用状态（已完成 / 失败）自动跳过。
 */
export function DownloadsPage(): React.JSX.Element {
  const tasks = useDownloadsStore((s) => s.tasks);
  const loaded = useDownloadsStore((s) => s.loaded);
  const refresh = useDownloadsStore((s) => s.refresh);
  const [dir, setDir] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const allRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async (): Promise<void> => {
    await refresh();
    try {
      const d = await ipc.getDownloadDir();
      setDir(typeof d === "string" ? d : "");
    } catch {
      /* 目录读取失败不影响任务列表 */
    }
  }, [refresh]);

  useEffect(() => {
    void load();
  }, [load]);

  const hasActive = tasks.some(
    (t) => t.status === "downloading" || t.status === "pending",
  );
  // 本页常驻缓存（挂载后不再卸载）：轮询必须跟「可见性」绑定，否则用户切到
  // 别的页面后它照样每秒打一次 IPC；同时切回来要立刻刷新一次状态。
  const active = useKeepAliveActive();
  useEffect(() => {
    if (!active) return;
    void refresh();
  }, [active, refresh]);
  useEffect(() => {
    if (!active || !hasActive) return;
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(timer);
  }, [active, hasActive, refresh]);

  // 任务被删除 / 清空后，选择集里不能留下已不存在的 id（否则批量删除计数对不上）
  useEffect(() => {
    setSelected((prev) => {
      const live = new Set(tasks.map((t) => t.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [tasks]);

  const toggleSelect = useCallback((id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allSelected = tasks.length > 0 && tasks.every((t) => selected.has(t.id));
  useEffect(() => {
    if (allRef.current) {
      allRef.current.indeterminate = !allSelected && selected.size > 0;
    }
  }, [allSelected, selected]);

  /** 统一包装：调用 IPC → 报错 → 刷新（行内的暂停 / 继续 / 重试 / 取消用）。
   *  失败走右上角 Toast：行级操作没有对应文字位，页面顶部横幅又会把列表往下推 */
  const act = async (id: string, fn: () => Promise<void>): Promise<void> => {
    setBusyId(id);
    try {
      await fn();
      await load();
    } catch (err) {
      toastError(`操作失败：${errMsg(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  /** 批量版同款：整个批量期间锁住所有批量 / 全局按钮，成功静默（列表自会刷新） */
  const runBatch = async (fn: () => Promise<number>, errLabel: string): Promise<void> => {
    setBatchBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      toastError(`${errLabel}：${errMsg(err)}`);
    } finally {
      setBatchBusy(false);
    }
  };

  const inflightIds = tasks
    .filter((t) => t.status === "downloading" || t.status === "pending")
    .map((t) => t.id);
  const pausedIds = tasks.filter((t) => t.status === "paused").map((t) => t.id);
  const doneIds = tasks.filter((t) => t.status === "done").map((t) => t.id);

  // 批量按钮的适用范围与 Rust 侧过滤保持一致：暂停 = 进行中；继续 / 重试 =
  // 暂停 / 失败 / 已取消；取消 = 进行中 / 暂停（已完成两种都不动）
  const selTasks = tasks.filter((t) => selected.has(t.id));
  const selInFlight = selTasks.filter(
    (t) => t.status === "downloading" || t.status === "pending",
  );
  const selResumable = selTasks.filter(
    (t) => t.status === "paused" || t.status === "failed" || t.status === "canceled",
  );
  const selCancelable = selTasks.filter(
    (t) =>
      t.status === "downloading" ||
      t.status === "pending" ||
      t.status === "paused",
  );

  const pauseAll = () =>
    runBatch(() => ipc.pauseDownloads(inflightIds), "全部暂停失败");
  /** 全部继续只续「已暂停」：失败 / 已取消混在列表里时挨个重试是明确动作，不替用户做主 */
  const resumeAll = () =>
    runBatch(() => ipc.resumeDownloads(pausedIds), "全部继续失败");
  const clearFinished = () =>
    runBatch(() => ipc.deleteDownloads(doneIds, false), "清理已完成失败");

  const pauseSelected = () =>
    runBatch(() => ipc.pauseDownloads(selInFlight.map((t) => t.id)), "批量暂停失败");
  const resumeSelected = () =>
    runBatch(() => ipc.resumeDownloads(selResumable.map((t) => t.id)), "批量继续失败");
  const cancelSelected = () =>
    runBatch(() => ipc.cancelDownloads(selCancelable.map((t) => t.id)), "批量取消失败");

  const doneCount = doneIds.length;
  const activeCount = inflightIds.length;
  const pausedCount = pausedIds.length;

  // 可播放的已完成任务（按列表顺序）：播放入口只给真正落盘的那些。
  // 用 task.filePath 当 Track.id 走本地曲目通路，元数据沿用原在线曲目。
  const playable = useMemo(
    () =>
      tasks
        .map((t) => ({ task: t, track: playableLocalTrack(t) }))
        .filter((x): x is { task: DownloadTask; track: Track } => x.track !== null),
    [tasks],
  );
  /** 任务 id → 可播放曲目（行内按钮按 id 查，不必在渲染里重复构造） */
  const playableById = useMemo(
    () => new Map(playable.map((x) => [x.task.id, x.track])),
    [playable],
  );
  /** 行内「加入播放队列」：与本地曲库行内同语义（不打断当前播放） */
  const queueAppend = (track: Track): void => {
    void ipc.queueAppend([track]).then(
      () => toastSuccess(`已将「${track.title}」加入播放队列`),
      (err) => toastError(`加入播放队列失败：${errMsg(err)}`),
    );
  };
  /** 行内「下一首播放」：插到当前曲目后面，同样不打断现在这首 */
  const queueNext = (track: Track): void => {
    void ipc.queueAddNext(track).then(
      () => toastSuccess(`已将「${track.title}」设为下一首播放`),
      (err) => toastError(`加入下一首播放失败：${errMsg(err)}`),
    );
  };

  // 收藏判定按**原在线曲目**（`qq:003abc`）而不是转换后的本地曲目：
  // 歌单里存的就是在线曲目，收藏它才和别的列表口径一致；而且引擎对
  // 「已下载的在线曲目」有离线优先分支，从歌单点它照样播磁盘文件。
  const favoritesVersion = useFavoritesStore((s) => s.version);
  const favoriteFlags = useFavoriteFlags(
    useMemo(() => tasks.map((t) => t.track), [tasks]),
    favoritesVersion,
  );
  /** 任务 id → 是否已收藏（行尾红心点亮用） */
  const favoritedById = useMemo(
    () => new Map(tasks.map((t, i) => [t.id, favoriteFlags[i] === true])),
    [tasks, favoriteFlags],
  );

  const playTrack = (track: Track): void => {
    void usePlayerStore
      .getState()
      .play(track)
      .catch((err) => toastError(`播放失败：${errMsg(err)}`));
  };

  /** 播放全部：整批入队（顺序与列表一致），从第一首起播 */
  const playAll = (): void => {
    if (playable.length === 0) return;
    void usePlayerStore
      .getState()
      .playQueue(
        playable.map((x) => x.track),
        0,
      )
      .catch((err) => toastError(`播放失败：${errMsg(err)}`));
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-base font-medium">下载管理</h1>
          <div className="flex items-center gap-1">
            {playable.length > 0 && (
              <IconButton
                label={`播放全部已完成（${playable.length}）`}
                variant="outline"
                size="md"
                hover="secondary"
                disabled={batchBusy}
                onClick={playAll}
              >
                <Play />
              </IconButton>
            )}
            {pausedCount > 0 && (
              <IconButton
                label="全部继续"
                variant="outline"
                size="md"
                hover="secondary"
                disabled={batchBusy}
                onClick={() => void resumeAll()}
              >
                <Play />
              </IconButton>
            )}
            {activeCount > 0 && (
              <IconButton
                label="全部暂停"
                variant="outline"
                size="md"
                hover="secondary"
                disabled={batchBusy}
                onClick={() => void pauseAll()}
              >
                <Pause />
              </IconButton>
            )}
            {doneCount > 0 && (
              <IconButton
                label={`清理已完成记录（${doneCount}）`}
                variant="outline"
                size="md"
                hover="secondary"
                danger
                disabled={batchBusy}
                onClick={() => void clearFinished()}
              >
                <Eraser />
              </IconButton>
            )}
          </div>
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {dir ? `保存位置：${dir}（在 设置 · 下载 中修改）` : "在歌曲列表里点「下载」即可加入队列"}
        </p>
        {playable.length > 0 && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            已完成的可以直接点标题播放（本地文件播放，不联网取址）
          </p>
        )}

        {/* 多选 / 批量删除：与本地曲库同一套交互 */}
        {tasks.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label
              title={allSelected ? "取消全选" : "全选下载任务"}
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <input
                ref={allRef}
                type="checkbox"
                checked={allSelected}
                onChange={(e) =>
                  setSelected(
                    e.target.checked ? new Set(tasks.map((t) => t.id)) : new Set(),
                  )
                }
                aria-label="全选下载任务"
                className="h-3.5 w-3.5 accent-primary"
              />
            </label>
            <BatchDeleteButton
              count={selected.size}
              onDelete={async (deleteFile) => {
                await ipc.deleteDownloads([...selected], deleteFile);
                await load();
              }}
              onDeleted={() => setSelected(new Set())}
              onError={(msg) => toastError(msg)}
            />
            {selResumable.length > 0 && (
              <IconButton
                label={`继续 / 重试所选（${selResumable.length}）`}
                variant="outline"
                size="md"
                hover="secondary"
                disabled={batchBusy}
                onClick={() => void resumeSelected()}
              >
                <Play />
              </IconButton>
            )}
            {selInFlight.length > 0 && (
              <IconButton
                label={`暂停所选（${selInFlight.length}）`}
                variant="outline"
                size="md"
                hover="secondary"
                disabled={batchBusy}
                onClick={() => void pauseSelected()}
              >
                <Pause />
              </IconButton>
            )}
            {selCancelable.length > 0 && (
              <IconButton
                label={`取消所选（${selCancelable.length}）`}
                variant="outline"
                size="md"
                hover="secondary"
                danger
                disabled={batchBusy}
                onClick={() => void cancelSelected()}
              >
                <X />
              </IconButton>
            )}
            {selected.size > 0 && (
              <>
                <span className="text-xs text-muted-foreground">
                  已选 {selected.size} 首
                </span>
                <IconButton label="取消选择" onClick={() => setSelected(new Set())}>
                  <X />
                </IconButton>
              </>
            )}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!loaded ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            加载中…
          </div>
        ) : tasks.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            还没有下载任务
          </div>
        ) : (
          <ul>
            {tasks.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                busy={busyId === t.id}
                selected={selected.has(t.id)}
                onToggle={() => toggleSelect(t.id)}
                onPause={() => void act(t.id, () => ipc.pauseDownload(t.id))}
                onResume={() => void act(t.id, () => ipc.resumeDownload(t.id))}
                onRetry={() => void act(t.id, () => ipc.retryDownload(t.id))}
                onCancel={() => void act(t.id, () => ipc.cancelDownload(t.id))}
                onPlay={
                  playableById.has(t.id)
                    ? () => playTrack(playableById.get(t.id) as Track)
                    : undefined
                }
                onQueue={
                  playableById.has(t.id)
                    ? () => queueAppend(playableById.get(t.id) as Track)
                    : undefined
                }
                onPlayNext={
                  playableById.has(t.id)
                    ? () => queueNext(playableById.get(t.id) as Track)
                    : undefined
                }
                favorited={favoritedById.get(t.id) === true}
                onReveal={() => ipc.revealDownload(t.id)}
                onDelete={async (deleteFile) => {
                  await ipc.deleteDownload(t.id, deleteFile);
                  await load();
                }}
                onError={(msg) => toastError(msg)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TaskRow(props: {
  task: DownloadTask;
  busy: boolean;
  selected: boolean;
  onToggle: () => void;
  onPause: () => void;
  onResume: () => void;
  onRetry: () => void;
  onCancel: () => void;
  /** 已完成且文件落盘时提供：点标题 / 播放按钮播这首（本地文件，不联网） */
  onPlay?: () => void;
  /** 同条件下提供：加入播放队列（不打断当前播放） */
  onQueue?: () => void;
  /** 同条件下提供：设为下一首播放（插到当前曲目后面） */
  onPlayNext?: () => void;
  /** 这一行的原在线曲目是否已收藏（行尾红心点亮用） */
  favorited: boolean;
  onReveal: () => Promise<void>;
  onDelete: (deleteFile: boolean) => Promise<void>;
  onError: (msg: string) => void;
}): React.JSX.Element {
  const { task: t, busy } = props;
  const pct = Math.round(t.progress * 100);
  const inFlight = t.status === "downloading" || t.status === "pending";
  const canResume = t.status === "paused";
  const canRetry = t.status === "failed" || t.status === "canceled";

  return (
    <li
      // 整行可点播放（与本地曲库的行同手感）：只对已落盘的任务开放。
      // 行内有复选框 / 各种按钮，它们的点击不能顺手把这首播了 —— 用 closest
      // 拦掉交互控件，剩下的空白区（状态文字、进度条旁）才当「点这一行」。
      onClick={(e) => {
        if (!props.onPlay) return;
        if ((e.target as HTMLElement).closest("button, input, [role='menu']")) return;
        props.onPlay();
      }}
      className={`border-b border-border/50 px-4 py-2.5 ${
        props.onPlay ? "cursor-pointer hover:bg-secondary/40" : ""
      }`}
    >
      {/* 一行展示：选择 / 标题 / 状态 / 操作按钮同排 */}
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={props.selected}
          onChange={props.onToggle}
          aria-label={`选择 ${t.track.title}`}
          className="h-3.5 w-3.5 shrink-0 accent-primary"
        />
        <div className="min-w-0 flex-1">
          {/* 已完成的点标题直接播（本地文件，不走在线取址）。
              未完成的行保持纯文本：点了也没有文件可放。 */}
          {props.onPlay ? (
            <button
              type="button"
              onClick={props.onPlay}
              title={`播放「${t.track.title}」（本地文件）`}
              className="block max-w-full truncate text-left text-sm transition-colors hover:text-primary hover:underline"
            >
              {t.track.title}
            </button>
          ) : (
            <div className="truncate text-sm">{t.track.title}</div>
          )}
          <div className="truncate text-xs text-muted-foreground">
            {/* 显示**实测**档位：请求 flac 而线路只给 320k 时，标请求档就是虚标。
                没测出来（历史任务 / 取址没给结果）时退回请求档。 */}
            {t.track.singer} · {t.actualQuality || t.quality}
            {t.status === "done" && t.fileSize
              ? ` · ${formatBytes(t.fileSize)}`
              : ""}
            {t.error ? ` · ${t.error}` : ""}
          </div>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {STATUS_LABEL[t.status]}
          {inFlight || canResume ? ` ${pct}%` : ""}
        </span>

        <div className="flex shrink-0 items-center gap-0.5">
          {inFlight && (
            <IconButton label="暂停" onClick={props.onPause} disabled={busy}>
              <Pause />
            </IconButton>
          )}
          {canResume && (
            <IconButton label="继续" onClick={props.onResume} disabled={busy}>
              <Play />
            </IconButton>
          )}
          {canRetry && (
            <IconButton label="重试" onClick={props.onRetry} disabled={busy}>
              <RotateCcw />
            </IconButton>
          )}
          {(inFlight || canResume) && (
            <IconButton label="取消" danger onClick={props.onCancel} disabled={busy}>
              <X />
            </IconButton>
          )}
          {/* 已完成：给一个显式播放入口（和本地曲库行内的「播放」同形）。
              未完成 / 无落盘路径不渲染 —— 点了也没文件可放。 */}
          {props.onPlay && (
            <IconButton label="播放" onClick={props.onPlay} disabled={busy}>
              <Play />
            </IconButton>
          )}
          {props.onPlayNext && (
            <IconButton
              label="下一首播放"
              onClick={props.onPlayNext}
              disabled={busy}
            >
              <PlayNextIcon className="h-3.5 w-3.5" />
            </IconButton>
          )}
          {props.onQueue && (
            <IconButton
              label="加入播放队列"
              onClick={props.onQueue}
              disabled={busy}
            >
              <ListEnd />
            </IconButton>
          )}
          {/* 收藏用**原在线曲目**（歌单里存的就是它），不是行内转换出的本地
              曲目；红心高亮由列表层批量查得后以标量传入，避免行组件 memo 失效 */}
          <CollectButton track={t.track} favorited={props.favorited} />
          {/* 定位只在文件已落盘（已完成）时提供；删除菜单对所有状态可用 */}
          <RowActions
            onReveal={t.status === "done" ? props.onReveal : undefined}
            onDelete={props.onDelete}
            onError={props.onError}
            disabled={busy}
          />
        </div>
      </div>

      {inFlight && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded bg-secondary">
          <div
            className="h-full bg-primary transition-[width] duration-300 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </li>
  );
}
