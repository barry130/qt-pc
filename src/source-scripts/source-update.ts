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
  /** 安装来源："" 未知 / "url" 直链 / "file" 本地文件 / "manifest" 官方通道更新 */
  installSource: string;
  /** 安装来源展示（直链 URL 或文件名；官方通道更新后为空） */
  installRef: string;
  /** 最近一次装载/冒烟/更新失败摘要（空 = 无；成功生效时清除） */
  lastError: string;
  /** 最近一次失败时间（unix 毫秒；0 = 无） */
  lastErrorAt: number;
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

/**
 * 安装预览信息（Rust PackPreview；URL/本地文件安装先预览确认再落盘）。
 * signatureVerified = 官方 id（play-official/meta-official）ed25519 签名校验
 * 通过（预览能到的官方包必为 true，假包在预览前就被硬拒）→ UI 显示
 * 「官方 · 已验签」徽标。第三方包恒 false（不受影响）。
 */
export interface PackPreviewVo {
  /** 暂存 token（一次性；确认安装时传回 sourceInstallStaged） */
  token: string;
  kind: SourcePackKind;
  id: string;
  name: string;
  versionCode: number;
  versionName: string;
  /** url / file */
  channel: string;
  /** 来源展示（完整 URL 或文件名） */
  reference: string;
  /** 官方包签名校验通过（见上） */
  signatureVerified: boolean;
  /** 已安装同 id 包的版本（0 = 未装过） */
  installedCode: number;
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

/** 安装预览 ①（直链）：下载全文并暂存，返回预览信息；确认前不落盘 */
export async function stageSourceFromUrl(url: string): Promise<PackPreviewVo> {
  return (await ipc.sourceStageFromUrl(url)) as PackPreviewVo;
}

/** 安装预览 ②（本地文件）：选文件并读入后暂存（用户取消返回 null） */
export async function stageSourceFromFile(): Promise<PackPreviewVo | null> {
  const preview = await ipc.sourceStageFromFile();
  return (preview ?? null) as PackPreviewVo | null;
}

/** 安装预览 ③：预览弹窗确认后按 token 落盘安装（token 一次性，过期需重新预览） */
export async function installStagedSource(token: string): Promise<InstallOutcomeVo> {
  return (await ipc.sourceInstallStaged(token)) as InstallOutcomeVo;
}

/** 列表「安装来源」标签（未知来源显示 — ） */
export function installSourceLabel(source: string): string {
  switch (source) {
    case "url":
      return "链接安装";
    case "file":
      return "本地安装";
    case "manifest":
      return "官方渠道";
    default:
      return "—";
  }
}

/** updatedAt（unix 秒）→ 短日期 MM-DD（列表次级信息行用） */
export function shortUpdateDate(unixSecs: number): string {
  if (!unixSecs) {
    return "";
  }
  const d = new Date(unixSecs * 1000);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}-${dd}`;
}

/** last_error 摘要（>40 字截断加省略号；空串原样返回） */
export function lastErrorSummary(error: string): string {
  const text = (error ?? "").trim();
  if (!text) {
    return "";
  }
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/** 剪贴板链接判定：https 直链、路径以 .js 结尾（允许 ?query） */
export function isPackLinkUrl(text: string): boolean {
  return /^https:\/\/\S+\.js(\?\S*)?$/i.test(text.trim());
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
