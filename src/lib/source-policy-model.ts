import type { SourcePolicy } from "@/source-scripts/qt-contract/contract";
export type { SourcePolicy } from "@/source-scripts/qt-contract/contract";

/** Device preference, independent from package identity and aggregate-only selection. */
export function defaultSourcePolicy(): SourcePolicy { return { version: 1, enabled: null, order: [] }; }
const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
function idsOf(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("音乐源设置格式无效");
  return [...new Set(value.filter((id): id is string => typeof id === "string" &&
    id !== "local" && ID_PATTERN.test(id)))].slice(0, 128);
}
export function parseSourcePolicy(raw: string | null | undefined): SourcePolicy {
  if (!raw) return defaultSourcePolicy();
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== "object") throw new Error("音乐源设置格式无效");
  const p = value as Record<string, unknown>;
  if (p.version !== 1) throw new Error("不支持的音乐源设置版本");
  return { version: 1, enabled: p.enabled === null ? null : idsOf(p.enabled), order: idsOf(p.order) };
}
export function policySourceEnabled(policy: SourcePolicy, id: string): boolean {
  return id === "local" || id === "podcast" || policy.enabled === null || policy.enabled.includes(id);
}
export function policyOrder<T extends { id: string }>(policy: SourcePolicy, catalog: readonly T[]): T[] {
  const ordered = [...new Set([...policy.order, ...catalog.map(s => s.id)])];
  return ordered.flatMap(id => { const item = catalog.find(s => s.id === id); return item ? [item] : []; });
}
export function togglePolicySource(policy: SourcePolicy, catalog: readonly string[], id: string): SourcePolicy {
  const enabled = policy.enabled === null ? [...catalog] : [...policy.enabled];
  const index = enabled.indexOf(id);
  if (index < 0) enabled.push(id); else enabled.splice(index, 1);
  return { version: 1, enabled, order: [...new Set([...policy.order, ...catalog])] };
}
export function movePolicySource(policy: SourcePolicy, catalog: readonly string[], id: string, direction: -1 | 1): SourcePolicy {
  const order = [...new Set([...policy.order, ...catalog])];
  const visible = order.filter(source => catalog.includes(source) && policySourceEnabled(policy, source));
  const index = visible.indexOf(id);
  const target = visible[index + direction];
  if (index < 0 || !target) return policy;
  const a = order.indexOf(id), b = order.indexOf(target);
  [order[a], order[b]] = [order[b], order[a]];
  return { version: 1, enabled: policy.enabled === null ? [...catalog] : [...policy.enabled], order };
}
/** 拖拽排序（2026-11-14 用户需求：优先级改拖拽）：把 id 移到 anchor 前面；
 *  anchor 传 null = 移到完整序列末尾。order 写的是全量序列——未启用的源
 *  位置也保留，重新启用时回到原位。 */
export function dragPolicySource(
  policy: SourcePolicy,
  catalog: readonly string[],
  id: string,
  anchorId: string | null,
): SourcePolicy {
  const order = [...new Set([...policy.order, ...catalog])];
  if (!order.includes(id)) return policy;
  if (anchorId === null) {
    order.splice(order.indexOf(id), 1);
    order.push(id);
  } else {
    if (id === anchorId || !order.includes(anchorId)) return policy;
    order.splice(order.indexOf(id), 1);
    order.splice(order.indexOf(anchorId), 0, id);
  }
  return { version: 1, enabled: policy.enabled === null ? [...catalog] : [...policy.enabled], order };
}
