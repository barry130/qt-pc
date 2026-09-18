/**
 * 音源包启动检查（音源包热更新方案 P2 / §2.4 静默更新）：
 * - 复用应用更新的 4 小时节流（settings `sourceUpdate.lastCheckAt`）；
 * - 静默：检查失败不提示；发现新包只下载落盘，不自动生效——
 *   设置页显示「音源包 vX 已就绪」+「立即应用」，正在播放不被打断；
 * - 冒烟与生效由引擎窗口负责（应用动作 = 重建引擎窗口）。
 */
import { useEffect } from "react";
import * as ipc from "@/services/ipc";
import { stripErrorUrls } from "@/lib/utils";
import { checkSourceUpdate, getSourceState, installSourceRelease } from "@/source-scripts/source-update";
import { useSourceUpdateStore } from "@/stores/source-update";

const CHECK_INTERVAL_MS = 4 * 3600 * 1000;
const LAST_CHECK_KEY = "sourceUpdate.lastCheckAt";

/** 启动挂一次；检查动作静默，结果进全局 store（设置页消费） */
export function useSourceUpdateCheck(): void {
  useEffect(() => {
    void (async () => {
      try {
        const last = await ipc.getSetting(LAST_CHECK_KEY).catch(() => null);
        const lastMs = Number(last ?? 0);
        const fresh = Number.isFinite(lastMs) && Date.now() - lastMs < CHECK_INTERVAL_MS;
        if (!fresh) {
          await checkAndDownload();
          await ipc.setSetting(LAST_CHECK_KEY, String(Date.now())).catch(() => {});
        } else {
          // 节流窗口内也要刷新本地状态展示（上一次可能下载完没应用）
          const local = await getSourceState().catch(() => null);
          if (local) useSourceUpdateStore.getState().setLocal(local);
        }
      } catch {
        // 音源包检查失败完全静默（后端没起/离线都正常）
      }
    })();
  }, []);
}

/** 执行一次检查+按需下载（自动检查与设置页「立即检查」共用） */
export async function checkAndDownload(): Promise<string> {
  const store = useSourceUpdateStore.getState();
  const { decision, remote, local } = await checkSourceUpdate();
  store.setLocal(local);
  store.setRemote(remote);
  store.setReady(null);
  store.setMessage(decision.action === "download" ? decision.reason : decision.reason);
  if (decision.action !== "download") {
    return decision.reason;
  }
  try {
    await installSourceRelease(decision.release);
    const installed = await getSourceState();
    store.setLocal(installed);
    store.setReady(installed.installed?.sourceVersionCode ?? null);
    store.setMessage(`音源包 ${decision.release.sourceVersionName} 已就绪，点击「立即应用」生效`);
    return store.message;
  } catch (e) {
    const msg = `下载失败：${stripErrorUrls(String(e))}`;
    store.setMessage(msg);
    return msg;
  }
}
