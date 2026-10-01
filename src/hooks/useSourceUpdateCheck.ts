/**
 * 播放音源包启动静默更新（双音源包架构）：
 * - **只在已装官方播放包时**静默检查并更新（不打扰未安装的用户——安装引导
 *   由设置页/播放时提示负责，应用不内置下载链接以外的任何强推）；
 * - 检查失败完全静默（后端没起/离线都正常）；
 * - 官方包更新装完即热切换生效（Rust 广播 source-pack-changed，引擎页换装，
 *   不重启应用、不打断播放）；自定义包永不自动更新。
 */
import { useEffect } from "react";
import { stripErrorUrls } from "@/lib/utils";
import {
  checkSourceUpdate,
  getSourceState,
  hasOfficialPack,
  installSourceRelease,
} from "@/source-scripts/source-update";
import { useSourceUpdateStore } from "@/stores/source-update";

/** 启动挂一次；检查动作静默，结果进全局 store（设置页消费） */
export function useSourceUpdateCheck(): void {
  useEffect(() => {
    void (async () => {
      try {
        await checkAndDownload();
      } catch {
        // 播放包检查失败完全静默（后端没起/离线都正常）
      }
    })();
  }, []);
}

/**
 * 执行一次检查+按需安装（自动检查与设置页「立即检查」共用）。
 * 未装官方包时只刷新状态不做动作（首装必须用户在设置页主动点击）。
 */
export async function checkAndDownload(): Promise<string> {
  const store = useSourceUpdateStore.getState();
  const { decision, remote, local } = await checkSourceUpdate();
  store.setLocal(local);
  store.setRemote(remote);
  store.setMessage(decision.reason);
  if (decision.action !== "download") {
    return decision.reason;
  }
  if (!hasOfficialPack(local)) {
    // 首装不下手：设置页展示「可安装」，由用户决定（高风险包，用户自行安装）
    return decision.reason;
  }
  try {
    await installSourceRelease(decision.release);
    const installed = await getSourceState();
    store.setLocal(installed);
    store.setMessage(
      `官方播放包 ${decision.release.sourceVersionName} 已更新并生效`,
    );
    return store.message;
  } catch (e) {
    const msg = `更新失败：${stripErrorUrls(String(e))}`;
    store.setMessage(msg);
    return msg;
  }
}
