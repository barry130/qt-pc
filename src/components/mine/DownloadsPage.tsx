import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play, RotateCcw, X } from "lucide-react";
import { errMsg } from "@/lib/utils";
import type { DownloadTask } from "@/types";
import * as ipc from "@/services/ipc";
import { useDownloadsStore } from "@/stores/downloads";
import { BatchDeleteButton, RowActions } from "@/components/common/RowActions";
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
function formatBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 下载管理（路由 /downloads，DESIGN §5.3 下载 2.0）。
 *
 * 任务真值在 Rust 侧：状态变化广播 `downloads-changed` 立即刷新，
 * 进行中的任务额外按 1s 轮询拿进度（进度写库不广播，避免高频事件）。
 *
 * 行内操作与本地曲库一致：定位 / 删除都是图标按钮（悬停有文字提示），
 * 删除走下拉菜单（只删记录 / 连文件一起删）；列表支持全选 + 批量删除。
 */
export function DownloadsPage(): React.JSX.Element {
  const tasks = useDownloadsStore((s) => s.tasks);
  const loaded = useDownloadsStore((s) => s.loaded);
  const refresh = useDownloadsStore((s) => s.refresh);
  const [dir, setDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
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

  /** 统一包装：调用 IPC → 报错 → 刷新（行内的暂停 / 继续 / 重试 / 取消用） */
  const act = async (id: string, fn: () => Promise<void>): Promise<void> => {
    setError(null);
    setBusyId(id);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusyId(null);
    }
  };

  const pauseAll = async (): Promise<void> => {
    setError(null);
    try {
      await Promise.all(
        tasks
          .filter((t) => t.status === "downloading" || t.status === "pending")
          .map((t) => ipc.pauseDownload(t.id)),
      );
      await load();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const clearFinished = async (): Promise<void> => {
    setError(null);
    try {
      await Promise.all(
        tasks
          .filter((t) => t.status === "done")
          .map((t) => ipc.deleteDownload(t.id, false)),
      );
      await load();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const doneCount = tasks.filter((t) => t.status === "done").length;
  const activeCount = tasks.filter(
    (t) => t.status === "downloading" || t.status === "pending",
  ).length;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-base font-medium">下载管理</h1>
          <div className="flex items-center gap-1">
            {activeCount > 0 && (
              <button
                type="button"
                onClick={() => void pauseAll()}
                className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs transition-colors hover:bg-secondary"
              >
                <Pause className="h-3.5 w-3.5" />
                全部暂停
              </button>
            )}
            {doneCount > 0 && (
              <button
                type="button"
                onClick={() => void clearFinished()}
                className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs transition-colors hover:bg-secondary"
              >
                清理已完成记录
              </button>
            )}
          </div>
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {dir ? `保存位置：${dir}（在 设置 · 下载 中修改）` : "在歌曲列表里点「下载」即可加入队列"}
        </p>

        {/* 多选 / 批量删除：与本地曲库同一套交互 */}
        {tasks.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
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
              全选
            </label>
            <BatchDeleteButton
              count={selected.size}
              onDelete={async (deleteFile) => {
                await ipc.deleteDownloads([...selected], deleteFile);
                await load();
              }}
              onDeleted={() => setSelected(new Set())}
              onError={(msg) => setError(msg)}
            />
            {selected.size > 0 && (
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                已选 {selected.size} 首 · 取消选择
              </button>
            )}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <div className="border-b border-border bg-destructive/10 p-3 text-center text-sm text-destructive">
            操作失败：{error}
          </div>
        )}
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
                onReveal={() => ipc.revealDownload(t.id)}
                onDelete={async (deleteFile) => {
                  await ipc.deleteDownload(t.id, deleteFile);
                  await load();
                }}
                onError={(msg) => setError(msg)}
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
    <li className="border-b border-border/50 px-4 py-2.5">
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
          <div className="truncate text-sm">{t.track.title}</div>
          <div className="truncate text-xs text-muted-foreground">
            {t.track.singer} · {t.quality}
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
            <IconButton
              icon={<Pause className="h-3.5 w-3.5" />}
              title="暂停"
              onClick={props.onPause}
              disabled={busy}
            />
          )}
          {canResume && (
            <IconButton
              icon={<Play className="h-3.5 w-3.5" />}
              title="继续"
              onClick={props.onResume}
              disabled={busy}
            />
          )}
          {canRetry && (
            <IconButton
              icon={<RotateCcw className="h-3.5 w-3.5" />}
              title="重试"
              onClick={props.onRetry}
              disabled={busy}
            />
          )}
          {(inFlight || canResume) && (
            <IconButton
              icon={<X className="h-3.5 w-3.5" />}
              title="取消"
              onClick={props.onCancel}
              disabled={busy}
            />
          )}
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
            className="h-full bg-primary transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </li>
  );
}

/** 图标按钮（悬停显示 title 提示），与本地曲库的行内操作风格一致 */
function IconButton(props: {
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      onClick={props.onClick}
      disabled={props.disabled}
      className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:opacity-50"
    >
      {props.icon}
    </button>
  );
}
