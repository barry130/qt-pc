/**
 * 音源包更新（音源包热更新方案 P2 / §2.3 客户端判定 6 步）。
 *
 * - `decideUpdate`：纯函数判定（可单测）：远端 release 与本地状态 →
 *   动作（none / need_app_update / download）+ 说明；
 * - `checkSourceUpdate`：拉 manifest（Rust source_manifest）+ 判定；
 * - `installSourceRelease`：下载差异文件落盘（Rust source_install）；
 * - `applySourceRelease` / `rollbackSourceBuiltin`：生效与回滚。
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
 * 内置版音源包版本：随应用内嵌打包的音源包（构建产物由独立工程 ../qt-sources
 * 的 `pnpm build` 交付到 src-tauri/builtin-sources/，编译期打进二进制；引擎页在
 * 未安装远程包 / 远程包加载失败时经 qtres /builtin/ 加载）即该版本；更新判定也
 * 以它为无包基线（decideUpdate：installed 为空时视同已装此版）。
 *
 * 号规则：**镜像「最新一次正式发布」的后端发号**（后端在「新建 release」时生成
 * `yyyyMMddNN`，内置包随后同步为同号同物）——内置包内容一变就必须换号：
 * 安卓端按版本目录「盘上优先」采用，同号换内容时设备上已解包的旧副本会一直
 * 盖住新实现。
 * 历史注：首版曾用 `yyyyMMdd00`（后端 seq 从 01 起、永不生成 00，保证严格小于
 * 任何线上版）；2026091902 起改为镜像发布号。
 * 这里与安卓端 `qt-uniappx/services/source-bundle-fs.uts` 的 BUILTIN_VERSION_CODE
 * 同步更新（两端同号）。
 */
export const BUILTIN_SOURCE_VERSION = { code: 2026092701, name: "2026.09.27.1" };

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
  const installedCode = local.installed?.sourceVersionCode ?? BUILTIN_SOURCE_VERSION.code;
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
    // 未装远程包且远端就是内置版：内置已带该实现，无需下载
    return { action: "none", reason: "内置版已是该版本" };
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

/** 立即应用（重建引擎窗口；smoke=true 时引擎加载后跑真实网络冒烟，
 *  冒烟通过由引擎页请求重启应用，让新包在主窗口侧也彻底生效） */
export async function applySourceRelease(smoke = true): Promise<void> {
  await ipc.sourceApply(smoke);
}

/** 回滚到内置版 */
export async function rollbackSourceBuiltin(): Promise<void> {
  await ipc.sourceRollbackBuiltin();
}
