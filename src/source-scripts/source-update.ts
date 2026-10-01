/**
 * 音源包更新（音源包热更新方案 P2 / §2.3 客户端判定 6 步）。
 *
 * - `decideUpdate`：纯函数判定（可单测）：远端 release 与本地状态 →
 *   动作（none / need_app_update / download）+ 说明；
 * - `checkSourceUpdate`：拉 manifest（Rust source_manifest）+ 判定；
 * - `installSourceRelease`：下载差异文件落盘（Rust source_install，official 包）；
 * - `installSourceFromUrl`：用户粘贴直链安装（Rust source_install_from_url，
 *   custom 包，不自动更新）；
 * - `applySourceRelease` / `rollbackSource`：生效与回退上一版。
 *
 * manifest 与安装落在 Rust（source_install.rs），这里只做决策与编排，
 * 设置页与启动检查（useSourceUpdateCheck.ts）都走本模块。
 */
import * as ipc from "@/services/ipc";

/** 与 Rust SourceRelease serde 对齐（camelCase） */
export interface SourceArtifactVo {
  path: string;
  version: number;
  url: string;
}

export interface SourceReleaseVo {
  sourceVersionCode: number;
  sourceVersionName: string;
  platforms: number[];
  hostApiVersion: number;
  channel: string;
  notes: string;
  artifacts: SourceArtifactVo[];
  published: boolean;
  bad: boolean;
}

/** 与 Rust SourceBundleState serde 对齐 */
export interface SourceStateVo {
  installed: {
    sourceVersionCode: number;
    dir: string;
    files: Record<string, number>;
    sourceVersionName: string;
    /** 包来源：official（astral manifest 自动更新）/ custom（用户直链，不自动更新） */
    source: "official" | "custom";
  } | null;
  previous: SourceStateVo["installed"];
  bad: number[];
  lastCheckAt: number;
}

/** 判定结论：不更新 / 需要升级应用 / 可下载 */
export type UpdateDecision =
  | { action: "none"; reason: string }
  | { action: "need_app_update"; reason: string }
  | { action: "download"; release: SourceReleaseVo; reason: string };

/** 宿主契约版本（与 Rust source_install::HOST_API_VERSION 同步维护） */
export const HOST_API_VERSION = 1;

/**
 * §2.3 判定 6 步（纯函数）：
 * 1. 无 release → 不更新；
 * 2. 撤回（bad=true 或未发布）→ 忽略（服务端预筛后通常不出现）；
 * 3. hostApiVersion 超本机 → 跳过并提示升级应用；
 * 4. 本地 bad[] 含该 code → 跳过（冒烟失败过）；
 * 5. 版本比较：远端 > 本地 → 更新；== → 按文件版本补差异；< → 拒绝降级；
 * 6. 逐文件比 version 有差异（或文件缺失）→ 下载。
 */
export function decideUpdate(
  remote: SourceReleaseVo | null,
  local: Pick<SourceStateVo, "installed" | "bad">,
): UpdateDecision {
  if (!remote) {
    return { action: "none", reason: "远端没有可用音源包" };
  }
  // 公开 manifest 不暴露 published（管理端字段，恒为 null）；只有显式 false 才算未发布
  if (remote.bad === true || remote.published === false) {
    return { action: "none", reason: "该版本已撤回或未发布" };
  }
  if (remote.hostApiVersion > HOST_API_VERSION) {
    return {
      action: "need_app_update",
      reason: `音源包需要宿主契约 v${remote.hostApiVersion}，当前应用支持 v${HOST_API_VERSION}，请先升级应用`,
    };
  }
  if (local.bad.includes(remote.sourceVersionCode)) {
    return { action: "none", reason: "该版本此前冒烟失败，已跳过" };
  }
  // 无内置包基线：installed 为空时按 0 计（任何有效 release 都可装）
  const installedCode = local.installed?.sourceVersionCode ?? 0;
  // 自定义直链包不参与官方自动更新（用户需重新粘贴链接升级）
  if (local.installed?.source === "custom") {
    return { action: "none", reason: "当前为自定义音源包，不自动更新；请从链接重新安装以升级" };
  }
  if (remote.sourceVersionCode < installedCode) {
    return { action: "none", reason: "远端版本不高于本地，拒绝降级" };
  }
  if (remote.sourceVersionCode === installedCode && local.installed) {
    // 同版本：逐文件比 version，全部一致才算最新
    const dirty = remote.artifacts.some((a) => {
      const localVersion = local.installed?.files[a.path];
      return localVersion === undefined || localVersion !== a.version;
    });
    if (!dirty) {
      return { action: "none", reason: "已是最新版本" };
    }
    return { action: "download", release: remote, reason: "同版本文件有更新，补下差异" };
  }
  if (remote.sourceVersionCode === installedCode) {
    // 未装远程包且远端版本为 0（理论上后端不会发 0）——防御性分支，不下载
    return { action: "none", reason: "无可用音源包" };
  }
  return { action: "download", release: remote, reason: "有新版本音源包" };
}

/** 读本地音源包状态（Rust source_state） */
export async function getSourceState(): Promise<SourceStateVo> {
  return (await ipc.sourceState()) as SourceStateVo;
}

/** 拉 manifest 并判定（检查动作不落盘，lastCheckAt 由调用方维护） */
export async function checkSourceUpdate(): Promise<{
  decision: UpdateDecision;
  remote: SourceReleaseVo | null;
  local: SourceStateVo;
}> {
  const [remote, local] = await Promise.all([ipc.sourceManifest(), getSourceState()]);
  return {
    decision: decideUpdate(remote as SourceReleaseVo | null, local),
    remote: remote as SourceReleaseVo | null,
    local,
  };
}

/** 下载安装（Rust 落盘 install/<code>/ 并平移 state） */
export async function installSourceRelease(release: SourceReleaseVo): Promise<void> {
  await ipc.sourceInstall(release);
}

/** 从直链安装自定义音源包（Rust 下载校验落盘，source=custom，不自动更新） */
export async function installSourceFromUrl(url: string): Promise<void> {
  await ipc.sourceInstallFromUrl(url);
}

/** 立即应用（重建引擎窗口；smoke=true 时引擎加载后跑真实网络冒烟，
 *  冒烟通过由引擎页请求重启应用，让新包在主窗口侧也彻底生效） */
export async function applySourceRelease(smoke = true): Promise<void> {
  await ipc.sourceApply(smoke);
}

/** 回退到上一版远程包；无上一版则卸载 */
export async function rollbackSource(): Promise<void> {
  await ipc.sourceRollback();
}
