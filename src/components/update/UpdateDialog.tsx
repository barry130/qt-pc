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
 * - 应用内自装目前仅 Windows（NSIS 安装器 + /UPDATE 就地覆盖）；Linux/macOS
 *   没有「下载完直接装」的机制，隐藏「立即更新」、只留浏览器下载。
 */
function supportsInAppUpdate(): boolean {
  // 与 Rust 侧 cmd_run_update_installer 的 cfg 门控保持一致
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
}
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

  // 浏览器下载的落点：优先后端下发的官方下载页 browserUrl，没有才退回 downloadUrl
  // （downloadUrl 由后端按本机 type 1103/1104/1105 分别下发，本身就是本平台的包，
  // 所以退回它不会把 Linux 用户送到 Windows 安装包）。两者都为空时不显示按钮，
  // 避免出现点了没反应的死按钮。
  const browserTarget =
    info.browserUrl && info.browserUrl.length > 0 ? info.browserUrl : info.downloadUrl;
  const canBrowserDownload = browserTarget.length > 0;

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
      // 3) 启动安装器（带 /UPDATE 就地覆盖），随后应用自动退出交给安装器
      await ipc.runUpdateInstaller(path);
      setPhase("done");
    } catch (err) {
      setError(errMsg(err));
      setPhase("idle");
    }
  };

  const openBrowser = async (): Promise<void> => {
    if (!canBrowserDownload) return;
    await ipc.runUpdateBrowser(browserTarget).catch(() => {});
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
            安装器已启动，应用即将自动退出并就地覆盖安装，无需手动卸载。
          </p>
        )}
        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
        {phase === "idle" && !canBrowserDownload && !supportsInAppUpdate() && (
          <p className="mt-3 text-xs text-muted-foreground">
            后端未提供本平台的下载地址，请到官网下载页手动更新。
          </p>
        )}

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
              {canBrowserDownload && (
                <button
                  type="button"
                  onClick={() => void openBrowser()}
                  className="rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent"
                >
                  浏览器下载
                </button>
              )}
              {supportsInAppUpdate() && (
                <button
                  type="button"
                  onClick={() => void startDownload()}
                  className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
                >
                  立即更新
                </button>
              )}
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
