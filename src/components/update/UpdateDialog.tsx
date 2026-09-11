import { useEffect, useState } from "react";
import { errMsg } from "@/lib/utils";
import type { AppUpdateInfo } from "@/types";
import * as ipc from "@/services/ipc";
import { useUpdateStore } from "@/stores/update";

/**
 * 更新弹窗（§15.3 updateType=1 / isForce=1）：
 * - 发现新版本 → 版本号 + 更新说明 + 文件大小；
 * - 「立即更新」：解析加速直链 → 下载（进度条）→ 校验 → 启动安装器；
 * - 强制更新没有「暂不」；浏览器下载（browserUrl）始终可选。
 */
export function UpdateDialog(): React.JSX.Element | null {
  const info = useUpdateStore((s) => s.info);
  const dismissed = useUpdateStore((s) => s.dismissed);
  const dismiss = useUpdateStore((s) => s.dismiss);
  const [phase, setPhase] = useState<"idle" | "downloading" | "done">("idle");
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // 强制更新不允许关闭
  const show = info != null && (!dismissed || isForce(info));

  useEffect(() => {
    if (phase !== "downloading") return;
    let off: (() => void) | null = null;
    let disposed = false;
    void ipc.onUpdateDownloadProgress((p) => {
      if (!disposed) setPercent(p.percent);
    }).then((u) => {
      if (disposed) u();
      else off = u;
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, [phase]);

  if (!show || info == null) return null;

  const close = (): void => {
    if (!isForce(info)) dismiss();
  };

  const startDownload = async (): Promise<void> => {
    setPhase("downloading");
    setPercent(0);
    setError(null);
    try {
      // 1) GitHub 直链 → 探测加速节点拼前缀
      const resolved = await ipc.resolveUpdateUrl(info.downloadUrl);
      // 2) 流式下载 + 进度 + MD5/大小校验
      const path = await ipc.downloadUpdateFile(
        resolved.downloadUrl,
        info.md5 || undefined,
        info.fileSize || undefined,
      );
      setPercent(100);
      // 3) 启动安装器（用户点完成时退出应用走安装）
      await ipc.runUpdateInstaller(path);
      setPhase("done");
    } catch (err) {
      setError(errMsg(err));
      setPhase("idle");
    }
  };

  const openBrowser = async (): Promise<void> => {
    const url =
      info.browserUrl && info.browserUrl.length > 0 ? info.browserUrl : info.downloadUrl;
    if (!url) return;
    await ipc.runUpdateBrowser(url).catch(() => {});
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-96 rounded-2xl border border-white/20 bg-white/70 p-5 text-card-foreground shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-black/40">
        <h2 className="text-base font-medium">
          发现新版本 {info.versionName}
          {isForce(info) && (
            <span className="ml-2 rounded bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
              强制更新
            </span>
          )}
        </h2>
        <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">
          {info.versionInfo || "暂无更新说明"}
        </p>
        {info.fileSize > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            安装包大小：{(info.fileSize / 1024 / 1024).toFixed(1)} MB
          </p>
        )}

        {phase === "downloading" && (
          <div className="mt-4">
            <div className="h-1.5 w-full overflow-hidden rounded bg-secondary">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="mt-1 text-right text-xs tabular-nums text-muted-foreground">
              {percent}%
            </p>
          </div>
        )}
        {phase === "done" && (
          <p className="mt-4 text-sm text-[var(--primary)]">
            安装器已启动，关闭本应用后按安装向导完成升级。
          </p>
        )}
        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          {phase === "idle" && (
            <>
              {!isForce(info) && (
                <button
                  type="button"
                  onClick={close}
                  className="rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent"
                >
                  暂不更新
                </button>
              )}
              {info.browserUrl && info.browserUrl.length > 0 && (
                <button
                  type="button"
                  onClick={() => void openBrowser()}
                  className="rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent"
                >
                  浏览器下载
                </button>
              )}
              <button
                type="button"
                onClick={() => void startDownload()}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                立即更新
              </button>
            </>
          )}
          {phase === "done" && (
            <button
              type="button"
              onClick={close}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              完成
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function isForce(info: AppUpdateInfo): boolean {
  // 后端 isForce 为 Integer 0/1，前端类型已定义为 number
  return info.isForce === 1;
}
