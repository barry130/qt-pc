/**
 * 播放音源包管理（双音源包架构）。
 *
 * 数据音源包（meta-bundle.js）内嵌随应用发版，不经本模块；本模块只管
 * **播放音源包**（play-bundle.js，高风险、不内置）：
 *
 * - `decideUpdate`：纯函数判定（可单测）：远端 release 与本地状态 →
 *   动作（none / need_app_update / download）+ 说明。官方包缺席 → 引导安装
 *   （bootstrap）；已装官方包 → 只做更新；自定义包永远不自动更新；
 * - `checkSourceUpdate`：拉 manifest（Rust source_manifest）+ 判定；
 * - `installSourceRelease`：安装/更新官方播放包（Rust source_install）；
 * - `installSourceFromUrl`：用户粘贴直链安装自定义播放包（custom，不自动更新）；
 * - `activateSourcePack` / `uninstallSourcePack`：多包共存下切换/删除。
 *
 * 安装/切换后 Rust 广播 `source-pack-changed`，引擎页热切换（不重启应用、
 * 不重建引擎窗口），因此没有 apply/rollback 动作；官方包装载失败的自动回退
 * 在 Rust 侧完成（source_pack_load_failed）。
 * manifest 与安装都在 Rust（source_install.rs），这里只做决策与编排，
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

/** 已安装的播放包（与 Rust PlayPackMeta serde 对齐） */
export interface PlayPackVo {
  /** official 或 custom-<时间戳> */
  id: string;
  /** 引擎装配成功后回填的包自述名（自定义包装配前为占位名） */
  name: string;
  /** 引擎回填的包自述版本（如 chain.11） */
  version: string;
  /** official = manifest sourceVersionCode；custom = 0 */
  versionCode: number;
  /** 版本展示名 */
  versionName: string;
  /** official（自动更新）/ custom（直链安装，不自动更新） */
  source: "official" | "custom" | string;
  /** install/ 下的目录名 */
  dir: string;
  /** 安装时间（unix 秒） */
  installedAt: number;
}

/** 与 Rust SourceBundleState serde 对齐（v2） */
export interface SourceStateVo {
  schema: number;
  packs: PlayPackVo[];
  /** 生效包 id（null = 未选任何包） */
  activeId: string | null;
  /** 冒烟失败的官方 versionCode 黑名单 */
  bad: number[];
  lastCheckAt: number;
  /** 官方包装载失败的自动回退快照 */
  previousOfficial: PlayPackVo | null;
}

/** 判定结论：不更新 / 需要升级应用 / 可下载（含首装 bootstrap） */
export type UpdateDecision =
  | { action: "none"; reason: string }
  | { action: "need_app_update"; reason: string }
  | { action: "download"; release: SourceReleaseVo; reason: string };

/** 宿主契约版本（与 Rust source_install::HOST_API_VERSION 同步维护） */
export const HOST_API_VERSION = 1;

/** 本地状态里的官方包（可能没装） */
function officialPack(local: SourceStateVo): PlayPackVo | null {
  return local.packs.find((p) => p.source === "official") ?? null;
}

/**
 * 更新判定（纯函数）：
 * 1. 无 release → 不更新；
 * 2. 撤回（bad=true 或未发布）→ 忽略（服务端预筛后通常不出现）；
 * 3. hostApiVersion 超本机 → 跳过并提示升级应用；
 * 4. 本地 bad[] 含该 code → 跳过（装载失败过，黑名单在 Rust 生效）；
 * 5. 官方包未装 → bootstrap 安装（用户同意后）；
 * 6. 已装官方包：远端 code > 本地 → 更新；== → 最新；< → 拒绝降级。
 *    自定义包永远不参与官方通道（要升级就重新粘贴链接）。
 */
export function decideUpdate(
  remote: SourceReleaseVo | null,
  local: SourceStateVo,
): UpdateDecision {
  if (!remote) {
    return { action: "none", reason: "远端没有可用播放包" };
  }
  // 公开 manifest 不暴露 published（管理端字段，恒为 null）；只有显式 false 才算未发布
  if (remote.bad === true || remote.published === false) {
    return { action: "none", reason: "该版本已撤回或未发布" };
  }
  if (remote.hostApiVersion > HOST_API_VERSION) {
    return {
      action: "need_app_update",
      reason: `播放包需要宿主契约 v${remote.hostApiVersion}，当前应用支持 v${HOST_API_VERSION}，请先升级应用`,
    };
  }
  if (local.bad.includes(remote.sourceVersionCode)) {
    return { action: "none", reason: "该版本此前装载失败，已跳过" };
  }
  const installed = officialPack(local);
  if (!installed) {
    return { action: "download", release: remote, reason: "官方播放包未安装，可安装" };
  }
  if (remote.sourceVersionCode < installed.versionCode) {
    return { action: "none", reason: "远端版本不高于本地官方包，拒绝降级" };
  }
  if (remote.sourceVersionCode === installed.versionCode) {
    return { action: "none", reason: "官方播放包已是最新版本" };
  }
  return { action: "download", release: remote, reason: "官方播放包有新版本" };
}

/** 读本地播放包状态（Rust source_state，v2） */
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

/** 本地是否已装官方播放包（启动静默检查的准入门槛：没装就不打扰用户） */
export function hasOfficialPack(local: SourceStateVo): boolean {
  return officialPack(local) !== null;
}

/** 下载安装/更新官方播放包（Rust 落盘 install/<code>/ 并广播换包） */
export async function installSourceRelease(release: SourceReleaseVo): Promise<void> {
  await ipc.sourceInstall(release);
}

/** 从直链安装自定义播放包（Rust 下载校验落盘，source=custom，不自动更新） */
export async function installSourceFromUrl(url: string): Promise<void> {
  await ipc.sourceInstallFromUrl(url);
}

/** 切换生效播放包（设置页单选；Rust 广播后引擎热切换） */
export async function activateSourcePack(packId: string): Promise<void> {
  await ipc.sourceActivatePack(packId);
}

/** 卸载播放包（删目录 + 出列表，生效位顺延） */
export async function uninstallSourcePack(packId: string): Promise<void> {
  await ipc.sourceUninstallPack(packId);
}
