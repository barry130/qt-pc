import { useEffect } from "react";
import * as ipc from "@/services/ipc";
import { useUpdateStore } from "@/stores/update";

/**
 * 启动自动检查更新（§15.3）：
 * - 节流：settings `update.lastCheckAt`，4 小时一次（手动检查不受限）；
 * - 结果进全局 store：弹窗组件据此渲染（updateType=1 或 isForce 弹窗、2 红点）；
 * - 失败静默（后端没起 / 未登录都不打扰用户）。
 */
export function useUpdateCheck(): void {
  const setUpdate = useUpdateStore((s) => s.setUpdate);
  const setOfficialValid = useUpdateStore((s) => s.setOfficialValid);

  useEffect(() => {
    void (async () => {
      try {
        const last = await ipc.getSetting("update.lastCheckAt").catch(() => null);
        const lastMs = Number(last ?? 0);
        if (Number.isFinite(lastMs) && Date.now() - lastMs < 4 * 3600 * 1000) {
          return;
        }
        await runCheck(setUpdate, setOfficialValid);
        await ipc
          .setSetting("update.lastCheckAt", String(Date.now()))
          .catch(() => {});
      } catch {
        // 检查失败不打扰
      }
    })();
  }, [setUpdate, setOfficialValid]);
}

/** 执行一次更新检查并写入全局 store（自动检查与设置页共用） */
export async function runCheck(
  setUpdate: (info: AppUpdateInfoLike | null) => void,
  setOfficialValid?: (v: boolean | null) => void,
): Promise<AppUpdateInfoLike | null> {
  // 官方版本校验失败（非官版）只标记，不阻断更新提示
  const official = await ipc.astralCheckOfficialVersion().catch(() => null);
  if (setOfficialValid) setOfficialValid(official != null);

  const update = await ipc.astralAppUpdate().catch(() => null);
  const info =
    update && typeof update === "object" && (update as AppUpdateInfoLike).versionName
      ? (update as AppUpdateInfoLike)
      : null;
  setUpdate(info);
  return info;
}

/** 结构宽哨兵：后端序列化字段与 AppUpdateInfo 对齐，这里只做存在性判断 */
type AppUpdateInfoLike = {
  versionName: string;
  versionCode: number;
  versionInfo: string;
  updateType: string;
  downloadUrl: string;
  browserUrl: string;
  isGithub: number;
  channel: string;
  isForce: number;
  fileSize: number;
  md5: string;
};
