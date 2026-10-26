/**
 * 各平台独立的音质选择（2026-10-25 用户需求：音质从「播放/下载设置」里的全局
 * 单值改为按平台管理，入口在音源账号页每个平台卡片上）：
 *  - 播放音质：写 settings 键 `play.sourceQualities`（{平台: 档位} 全量表），
 *    启动/变更时经 `set_source_qualities` 全量推给 Rust 引擎——引擎的队列播放 /
 *    无缝预加载都按 `本曲临时 → 平台独立 → 全局默认` 取值（engine.rs
 *    effective_quality_for）。
 *  - 下载音质：写 `download.sourceQualities`，下载入口逐首按 `曲目.platform`
 *    取值（DownloadButton / TrackList / BatchBar）。
 * 档位清单仍由注册表按登录态切换（useSourceQualities：未登录 = 包声明的第三方
 * 档位，播放面登录生效 = 官方档位清单）；这里只存用户的选择。
 *
 * 读取口径与 lib/source-auth.ts 同款：进程内缓存 + 同步 getter + 变更事件。
 * 兼容迁移：平台没配过时回落旧全局键（`quality` / `downloadQuality`），
 * 存量用户升级后行为不变；用户在音源账号页选定后即落新键。
 */

import {
  getSetting,
  setSetting,
  setSourceQualities,
} from "@/services/ipc";
import { DOWNLOAD_QUALITY_KEY, QUALITY_KEY } from "@/lib/storageKeys";

const PLAY_SOURCE_QUALITIES_KEY = "play.sourceQualities";
const DOWNLOAD_SOURCE_QUALITIES_KEY = "download.sourceQualities";

/** 保守的形状校验：平台 id / 档位都只能是短字母数字串（脏数据整条丢弃） */
const SOURCE_RE = /^[A-Za-z0-9_-]{1,32}$/;
const QUALITY_RE = /^[A-Za-z0-9_-]{1,24}$/;

function parseSourceQualities(raw: string | null | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (raw === null || raw === undefined || raw === "") return map;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return map;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return map;
  for (const [source, quality] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof quality !== "string") continue;
    if (!SOURCE_RE.test(source) || !QUALITY_RE.test(quality)) continue;
    map[source] = quality;
  }
  return map;
}

let cachedPlay: Record<string, string> | undefined;
let cachedDownload: Record<string, string> | undefined;
// 旧全局键的值（迁移回落用；读一次缓存住）
let cachedLegacyPlay: string | null = null;
let cachedLegacyDownload: string | null = null;
// 引擎推送是否已成功过（失败静默：下一次任何写入都会重推全量）
let engineSynced = false;

/** 启动时读全量进缓存，并把平台音质表推给引擎（失败静默，写入时会重推） */
export async function loadSourceQualities(): Promise<void> {
  const [play, download, legacyPlay, legacyDownload] = await Promise.all([
    getSetting(PLAY_SOURCE_QUALITIES_KEY).catch(() => null),
    getSetting(DOWNLOAD_SOURCE_QUALITIES_KEY).catch(() => null),
    getSetting(QUALITY_KEY).catch(() => null),
    getSetting(DOWNLOAD_QUALITY_KEY).catch(() => null),
  ]);
  cachedPlay = parseSourceQualities(play);
  cachedDownload = parseSourceQualities(download);
  cachedLegacyPlay = legacyPlay;
  cachedLegacyDownload = legacyDownload;
  await pushSourceQualitiesToEngine();
}

async function pushSourceQualitiesToEngine(): Promise<void> {
  if (cachedPlay === undefined) return;
  try {
    await setSourceQualities({ ...cachedPlay });
    engineSynced = true;
  } catch {
    engineSynced = false;
  }
}

export function resetSourceQualityCaches(): void {
  cachedPlay = undefined;
  cachedDownload = undefined;
  cachedLegacyPlay = null;
  cachedLegacyDownload = null;
  engineSynced = false;
}

/**
 * 平台的播放音质（同步）。查找顺序：平台表 → 旧全局键（迁移回落）→ "320"。
 * 缓存未热时按回落值处理：引擎侧同样有回落链，最多慢一次推送的窗口。
 */
export function sourcePlayQualityOf(source: string): string {
  const fromMap = cachedPlay?.[source];
  if (fromMap !== undefined) return fromMap;
  if (cachedLegacyPlay !== null && QUALITY_RE.test(cachedLegacyPlay)) return cachedLegacyPlay;
  return "320";
}

/** 平台的下载音质（同步）。查找顺序同上，最终回落 "320"。 */
export function sourceDownloadQualityOf(source: string): string {
  const fromMap = cachedDownload?.[source];
  if (fromMap !== undefined) return fromMap;
  if (cachedLegacyDownload !== null && QUALITY_RE.test(cachedLegacyDownload)) {
    return cachedLegacyDownload;
  }
  return "320";
}

/** 平台音质表变化事件（音源账号页写入后派发；播放条/设置相关 UI 订阅刷新） */
export const SOURCE_QUALITIES_CHANGED_EVENT = "qt:source-qualities-changed";

function emitSourceQualitiesChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SOURCE_QUALITIES_CHANGED_EVENT));
}

/** 写平台的播放音质：落库 + 全量推引擎 + 派发变更。失败抛给调用方提示。 */
export async function setSourcePlayQuality(source: string, quality: string): Promise<void> {
  if (!SOURCE_RE.test(source) || !QUALITY_RE.test(quality)) {
    throw new Error(`非法的音质设置: ${source} = ${quality}`);
  }
  const next = { ...(cachedPlay ?? {}), [source]: quality };
  cachedPlay = next;
  await setSetting(PLAY_SOURCE_QUALITIES_KEY, JSON.stringify(next));
  await pushSourceQualitiesToEngine();
  emitSourceQualitiesChanged();
}

/** 写平台的下载音质：落库 + 派发变更（下载不走引擎，无需推送）。 */
export async function setSourceDownloadQuality(source: string, quality: string): Promise<void> {
  if (!SOURCE_RE.test(source) || !QUALITY_RE.test(quality)) {
    throw new Error(`非法的音质设置: ${source} = ${quality}`);
  }
  const next = { ...(cachedDownload ?? {}), [source]: quality };
  cachedDownload = next;
  await setSetting(DOWNLOAD_SOURCE_QUALITIES_KEY, JSON.stringify(next));
  emitSourceQualitiesChanged();
}

/** 供测试断言引擎推送状态的钩子（生产代码不读） */
export function sourceQualitiesEngineSynced(): boolean {
  return engineSynced;
}
