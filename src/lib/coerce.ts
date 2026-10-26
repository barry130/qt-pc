/**
 * 「从脏数据里取值」的唯一真源。
 *
 * 两族语义，刻意分开、不互相兜底：
 *
 * - **strict 族**（`as*`）：只认 typeof，不认就不给 —— 用于自家 IPC / 内部结构，
 *   类型错了应该暴露成默认值而不是被悄悄转掉。
 * - **coerce 族**（`coerce*`）：尽力转（`Number(...)` / `"true"` / `"1"`）—— 用于
 *   外部 JSON（后端接口、公告、免责声明），字段形态不受我们控制，宽松才能少丢数据。
 *
 * 之前 ai.ts / feedback.ts / messages-data.ts / qt-NoticeDialog.tsx / disclaimer.tsx
 * 各写一份、名字还不同（str/num/bool/stringValue/numberValue），现在只有这一份。
 */

// ==================== strict 族 ====================

/** 只认字符串；别的类型给 fallback */
export function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** 只认有限数字；别的类型（含 NaN/Infinity）给 fallback */
export function asNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** 只认布尔；别的类型给 fallback */
export function asBoolean(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** 对象兜底：非对象（含 null/数组）给空对象，后面就能放心 `v.x` */
export function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** 同 `asRecord`，但非对象给 null（调用方要区分「空对象」和「根本没有」时用这个） */
export function asRecordOrNull(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** 数组兜底：非数组给空数组 */
export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// ==================== coerce 族（外部 JSON 用） ====================

/** 字符串直取；null/undefined 给空串，其余尽力 `String()` */
export function coerceString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/** 尽力转数字：数字直取，其余 `Number()`；转不出有限值给 0 */
export function coerceNumber(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 尽力转布尔：`true`/`"true"`/`1`/`"1"` 都算真（后端字段经常用 0/1 和字符串） */
export function coerceBool(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}
