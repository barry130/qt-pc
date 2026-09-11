import { useCallback, useEffect, useState } from "react";
import { errMsg } from "@/lib/utils";
import type { DownloadTask } from "@/types";
import * as ipc from "@/services/ipc";

const STATUS_LABEL: Record<DownloadTask["status"], string> = {
  pending: "等待中",
  downloading: "下载中",
  done: "已完成",
  failed: "失败",
};

/**
 * 下载管理（路由 /downloads，DESIGN §5.3）。
 * 任务由 Rust 后台执行（进度写库），这里在有进行中任务时按 1s 轮询。
 */
export function DownloadsPage(): React.JSX.Element {
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [dir, setDir] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [l, d] = await Promise.all([
        ipc.listDownloads().catch(() => [] as DownloadTask[]),
        ipc.getDownloadDir().catch(() => ""),
      ]);
      setTasks(Array.isArray(l) ? l : []);
      setDir(typeof d === "string" ? d : "");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const hasActive = tasks.some(
    (t) => t.status === "downloading" || t.status === "pending",
  );
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => void load(), 1000);
    return () => window.clearInterval(timer);
  }, [hasActive, load]);

  const remove = async (t: DownloadTask): Promise<void> => {
    setError(null);
    try {
      await ipc.deleteDownload(t.id, true);
      await load();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="border-b border-border px-4 py-3">
        <h1 className="text-base font-medium">下载管理</h1>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {dir ? `保存位置：${dir}（在 设置 · 下载 中修改）` : "在歌曲列表里点「下载」即可加入队列"}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <div className="p-6 text-center text-sm text-destructive">
            操作失败：{error}
          </div>
        )}
        {loading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            加载中…
          </div>
        ) : !error && tasks.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            还没有下载任务
          </div>
        ) : (
          <ul>
            {tasks.map((t) => (
              <li
                key={t.id}
                className="border-b border-border/50 px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{t.track.title}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {t.track.singer} · {t.quality}
                      {t.status === "failed" && t.error ? ` · ${t.error}` : ""}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {STATUS_LABEL[t.status]}
                    {t.status === "downloading"
                      ? ` ${Math.round(t.progress * 100)}%`
                      : ""}
                  </span>
                  <button
                    type="button"
                    onClick={() => void remove(t)}
                    className="shrink-0 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-destructive"
                  >
                    删除
                  </button>
                </div>
                {t.status === "downloading" && (
                  <div className="mt-2 h-1 w-full overflow-hidden rounded bg-secondary">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{ width: `${Math.round(t.progress * 100)}%` }}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
