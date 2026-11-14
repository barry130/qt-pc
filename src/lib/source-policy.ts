import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as ipc from "@/services/ipc";
import { defaultSourcePolicy, parseSourcePolicy, policySourceEnabled, type SourcePolicy } from "./source-policy-model";
export { policyOrder, togglePolicySource, movePolicySource, type SourcePolicy } from "./source-policy-model";

export const SOURCE_POLICY_KEY = "source.platformPolicy.v1";
export const SOURCE_POLICY_CHANGED_EVENT = "qt-source-policy-changed";
export const SOURCE_POLICY_NATIVE_EVENT = "source-policy-changed";
let policy = defaultSourcePolicy();
let loaded = false;
let loading: Promise<SourcePolicy> | null = null;
let revision = 0;
let bound = false;
let readEpoch = 0;
let loadError = "";

export function sourcePolicySnapshot(): SourcePolicy {
  return { version: 1, enabled: policy.enabled === null ? null : [...policy.enabled], order: [...policy.order] };
}
export function sourcePolicyError(): string { return loadError; }
export function sourcePolicyRevision(): number { return revision; }
export function sourcePolicyFingerprint(): string { return JSON.stringify(policy); }
export function assertSourcePolicyCurrent(token: number): void {
  if (token !== revision) throw new Error("音乐源设置已变化，请重试");
}
export function isSourcePolicyError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /音乐源.*(?:关闭|设置)|平台总开关/.test(text);
}
export function sourceEnabled(id: string): boolean { return policySourceEnabled(policy, id); }
export function assertSourceEnabled(id: string): void {
  if (!sourceEnabled(id)) throw new Error("该音乐源已关闭，可在音源包管理中启用");
}
function accept(next: SourcePolicy, error = ""): void {
  loaded = true;
  if (JSON.stringify(policy) === JSON.stringify(next) && loadError === error) return;
  loadError = error;
  policy = next;
  revision++;
  window.dispatchEvent(new CustomEvent(SOURCE_POLICY_CHANGED_EVENT));
}
export async function readSourcePolicy(): Promise<SourcePolicy> {
  if (!bound) {
    bound = true;
    void listen(SOURCE_POLICY_NATIVE_EVENT, () => {
      loaded = false;
      readEpoch++;
      loading = null;
      void readSourcePolicy().catch(() => undefined);
    }).catch(() => { bound = false; });
  }
  if (loaded) return policy;
  if (loading) return loading;
  const token = readEpoch;
  const task = ipc.getSetting(SOURCE_POLICY_KEY).then(raw => {
    if (token !== readEpoch) return readSourcePolicy();
    accept(parseSourcePolicy(raw));
    return policy;
  }).catch(() => {
    if (token !== readEpoch) return readSourcePolicy();
    // Preserve a usable management catalog so the user can repair this preference.
    // A failed read must never expand the enabled set.
    accept({ version: 1, enabled: [], order: [] }, "音乐源设置无法读取，请在音源包管理中重新选择");
    return policy;
  }).finally(() => { if (loading === task) loading = null; });
  loading = task;
  return task;
}
let writes = Promise.resolve();
export async function waitSourcePolicy(): Promise<void> {
  await writes;
  await readSourcePolicy();
}
export function saveSourcePolicy(next: SourcePolicy): Promise<void> {
  // Serial durable writes. A failed write never makes the UI claim the setting was saved.
  const value = parseSourcePolicy(JSON.stringify(next));
  const task = writes.catch(() => undefined).then(async () => {
    await invoke("source_policy_set", { policy: value });
    readEpoch++;
    accept(value);
    // Read back the durable native value in the engine before new facade calls resume.
    const { engineInvoke } = await import("@/source-engine/client");
    await engineInvoke("sourcePolicyStatus", { refresh: true }).catch(() => undefined);
  });
  writes = task.catch(() => undefined);
  return task;
}
