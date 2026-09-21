/**
 * 应用更名（LightListen → QuietMusic）的一次性 localStorage 键迁移。
 *
 * 旧版本用 `lightlisten.*` 前缀存 UI 偏好（默认音源、侧栏折叠、消息已读位点）。
 * 更名后新键若不存在而旧键在，就拷一次，用户不必重设。
 * 只做「新键缺失」时的单向拷贝：新键一旦写入就以新键为准，旧键不再读取。
 */

/** 旧前缀（更名前） */
const LEGACY_PREFIX = "lightlisten.";
/** 新前缀（更名后） */
const PREFIX = "quietmusic.";

/**
 * 把 `lightlisten.<suffix>` 的值迁移到 `newKey`（须为 `quietmusic.<suffix>`）。
 * 在任何读取该键的代码之前调用（模块顶层即可）。
 */
export function migrateLegacyStorageKey(newKey: string): void {
  if (!newKey.startsWith(PREFIX)) return;
  try {
    if (typeof localStorage === "undefined") return;
    if (localStorage.getItem(newKey) !== null) return;
    const legacyKey = LEGACY_PREFIX + newKey.slice(PREFIX.length);
    const legacy = localStorage.getItem(legacyKey);
    if (legacy !== null) localStorage.setItem(newKey, legacy);
  } catch {
    // 存储被禁用：跳过迁移，各调用点自会回落到默认值
  }
}
