/**
 * 统一音源包管理（v3，与 qt-uniappx services/source-update.uts 同口径）。
 *
 * 每个包 = 单文件 js，首行 `__QT_PACK__` 包头自描述身份；数据包（meta）与
 * 播放包（play）共用同一条安装/更新/启停/卸载管线，只有槽位不同：
 *
 * - 数据槽 activeMetaId：内置基线永远兜底（null = 基线），数据包可运行时装；
 * - 播放槽 activeId：播放包不随应用分发，用户安装，多包共存其一生效；
 * - 更新发现（discoverSourceUpdates）三通道合一（每包 updateUrl 自探测 /
 *   基线 meta 的 updateUrl / astral manifest），**只提示不自动装**；
 * - 应用更新（applySourceUpdate）：下载 → 包头与 offer 完全一致 → 安装；
 *   失败自动回滚并拉黑该版本（Rust source_install.rs 完成）。
 *
 * 启动检查（useSourceUpdateCheck.ts）与设置页（SettingsPage.tsx）都走本模块；
 * 逐条确认的启动提示见 components/SourceUpdatePrompt.tsx。
 */
import * as ipc from "@/services/ipc";

/**
 * 宿主契约版本（与 Rust source_pack_header::HOST_API_VERSION、引擎包
 * bundleInfo.hostApiVersion 对齐；scripts/sync-config.mjs 从配置同步此值，
 * 改配置不改这里）。
 */
export const HOST_API_VERSION = 1;

/** 包类型：meta = 数据包（低风险，内置基线兜底）；play = 播放包（高风险，不内置） */
export type SourcePackKind = "meta" | "play";

/** 已安装的音源包（与 Rust SourcePackMeta serde 对齐，v3） */
export interface SourcePackVo {
  /** 包 id（来自包头 `^[a-z0-9-]{2,32}$`；同时是 install/ 下的目录名） */
  id: string;
  kind: SourcePackKind;
  /** 展示名（包头自带） */
  name: string;
  /** 版本号（更新判定唯一依据） */
  versionCode: number;
  /** 版本展示名 */
  versionName: string;
  /** 自更新探测直链（空 = 不参与自探测通道） */
  updateUrl: string;
  /** install/ 下的目录名（= id） */
  dir: string;
  /** 安装时间（unix 秒） */
  installedAt: number;
  /** 最后变更时间（unix 秒） */
  updatedAt: number;
  /** 拉黑过的 versionCode（装载/冒烟失败过，不再自动更新到该版本） */
  skipCodes: number[];
  /** 上次 updateUrl 探测时间（4h 节流） */
  lastProbeAt: number;
}

/** 与 Rust SourceBundleState serde 对齐（v3 统一包模型） */
export interface SourceStateVo {
  schema: number;
  packs: SourcePackVo[];
  /** 播放槽：生效播放包 id（null = 未装） */
  activeId: string | null;
  /** 数据槽：生效数据包 id（null = 内置基线） */
  activeMetaId: string | null;
  lastCheckAt: number;
}

/** 更新 offer（发现三通道归一后的统一形状） */
export interface PackUpdateOfferVo {
  kind: SourcePackKind;
  /** 目标包 id */
  targetId: string;
  currentCode: number;
  newCode: number;
  newName: string;
  notes: string;
  /** self（包自身 updateUrl / 基线）/ manifest（astral 官方通道） */
  channel: "self" | "manifest" | string;
  url: string;
  /** true = 从内置基线升到第一个数据包 */
  fromBaseline: boolean;
}

/** 内置数据包基线的身份（qtres 内嵌 meta-bundle.js 的包头） */
export interface BaselineMetaVo {
  id: string;
  code: number;
  name: string;
  versionName: string;
}

/** source_discover_updates 的返回 */
export interface DiscoverResultVo {
  offers: PackUpdateOfferVo[];
  baselineMeta: BaselineMetaVo | null;
}

/** 安装结果（Rust InstallOutcome） */
export interface InstallOutcomeVo {
  kind: SourcePackKind;
  /** 本次是否已上位到对应槽位（引擎热装载/重装 meta 槽） */
  activated: boolean;
  /** 同 id 原位更新 */
  replaced: boolean;
  pack: SourcePackVo;
}

export function kindLabel(kind: SourcePackKind | string): string {
  return kind === "meta" ? "数据包" : "播放包";
}

export function packDisplayName(pack: SourcePackVo): string {
  return pack.name?.trim() || kindLabel(pack.kind);
}

export function packVersionLabel(pack: SourcePackVo): string {
  return pack.versionName?.trim() || `v${pack.versionCode}`;
}

/**
 * 提示文案：`数据包有新版本：v内置基线 → v2（官方数据包）`。
 * 与 uniappx offerLabel 同口径。
 */
export function offerLabel(offer: PackUpdateOfferVo): string {
  const from = offer.fromBaseline ? "内置基线" : `v${offer.currentCode}`;
  return `${kindLabel(offer.kind)}有新版本：${from} → v${offer.newCode}（${offer.newName}）`;
}

/** 读本地音源包状态（Rust source_state，v3） */
export async function getSourceState(): Promise<SourceStateVo> {
  return (await ipc.sourceState()) as SourceStateVo;
}

/**
 * 更新发现（force=true 越过 4h/包 节流；启动静默检查用 false）。
 * 只发现不安装：offers 交给 UI 逐条确认。
 */
export async function discoverSourceUpdates(force = false): Promise<DiscoverResultVo> {
  return (await ipc.sourceDiscoverUpdates(force)) as DiscoverResultVo;
}

/** 应用一个更新 offer（下载 + 包头一致性校验 + 安装；失败 Rust 自动回滚拉黑） */
export async function applySourceUpdate(offer: PackUpdateOfferVo): Promise<InstallOutcomeVo> {
  return (await ipc.sourceApplyUpdate(offer)) as InstallOutcomeVo;
}

/** 从 https 直链安装（meta/play 同一条管线；首装或并存安装） */
export async function installSourceFromUrl(url: string): Promise<InstallOutcomeVo> {
  return (await ipc.sourceInstallFromUrl(url)) as InstallOutcomeVo;
}

/**
 * 从本地文件安装（系统文件选择框选 .js；用户取消返回 null）。
 * 对话框在 Rust 侧（无前端 dialog 插件依赖）。
 */
export async function installSourceFromLocalFile(): Promise<InstallOutcomeVo | null> {
  const outcome = await ipc.sourceInstallLocalFile();
  return (outcome ?? null) as InstallOutcomeVo | null;
}

/** 切换生效包（kind 决定槽位：play → 热切换+冒烟；meta → 重装 meta 槽）；
 *  packId 空串 + kind = 切回空位（meta=内置基线 / play=未装） */
export async function activateSourcePack(
  packId: string,
  kind?: SourcePackKind,
): Promise<void> {
  await ipc.sourceActivatePack(packId, kind);
}

/** 卸载包（数据包卸载后数据槽回内置基线；卸载生效中的播放包后在线播放不可用） */
export async function uninstallSourcePack(packId: string): Promise<void> {
  await ipc.sourceUninstallPack(packId);
}
