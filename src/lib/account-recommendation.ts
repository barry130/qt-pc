import { listen } from "@tauri-apps/api/event";
import type { Track } from "@/types";
import * as sources from "@/source-scripts";
import { engineSnapshot, onEnginePhaseChange, queryEngineMeta, type EngineMetaSnapshot } from "@/source-engine/client";
import { sourceState, SOURCE_META_CHANGED_EVENT, SOURCE_PACK_CHANGED_EVENT } from "@/services/ipc";
import { prepareSourceMetaAuth, sourceMetaAuthSnapshotIsCurrent, onSourceMetaAuthChange, type SourceMetaAuthSnapshot } from "@/lib/source-auth";
import { useRecommendationSourceStore, type RecommendationFeature } from "@/stores/recommendation-source";
import { AccountRecommendationError, safeAccountRecommendationError } from "./account-recommendation-error";
import { sourceEnabled, waitSourcePolicy, SOURCE_POLICY_CHANGED_EVENT } from "./source-policy";

export interface AccountRecommendationContext extends SourceMetaAuthSnapshot {
  feature: RecommendationFeature;
  sourceName: string;
  selectionRevision: number;
  engineRevision: number;
  packVersion: string;
}
export interface AccountRecommendationPage {
  tracks: Track[];
  cursor?: string;
  expiresAt?: number;
  fetchedAt: number;
  exhausted: boolean;
}
type ContextListener = (feature?: RecommendationFeature) => void;
let engineRevision = 0;
let knownPackVersion: string | null = null;
let packTransition = false;
let expectedMeta: { id: string; code: number } | null = null;
let binding: Promise<void> | null = null;
const listeners = new Set<ContextListener>();
function notify(feature?: RecommendationFeature): void {
  for (const listener of listeners) { try { listener(feature); } catch { /* Revocation cannot be blocked by UI. */ } }
}
function packVersion(meta: EngineMetaSnapshot): string { return `${meta.id}@${meta.code}:${meta.revision}`; }
function readMeta(raw: unknown): EngineMetaSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || !value.id || typeof value.code !== "number" || !Number.isSafeInteger(value.code) || value.code < 1 || typeof value.revision !== "string" || !value.revision) return null;
  return { id: value.id, code: value.code, revision: value.revision };
}
function applyLoadedMeta(meta: EngineMetaSnapshot | null): void {
  const next = meta ? packVersion(meta) : null;
  const changed = knownPackVersion !== next;
  const previous = knownPackVersion;
  knownPackVersion = next;
  if (changed && previous !== null) { engineRevision += 1; packTransition = false; notify(); }
  if (meta && expectedMeta?.id === meta.id && expectedMeta.code === meta.code && packTransition) {
    packTransition = false; notify();
  }
}
function bindEpochs(): Promise<void> {
  if (binding) return binding;
  onSourceMetaAuthChange((sourceId) => {
    const state = useRecommendationSourceStore.getState();
    for (const feature of ["daily", "fm"] as const) {
      if (state[feature].origin === "account" && (sourceId === undefined || state[feature].sourceId === sourceId)) notify(feature);
    }
  });
  useRecommendationSourceStore.subscribe((state, previous) => {
    if (state.dailyRevision !== previous.dailyRevision || state.daily !== previous.daily) notify("daily");
    if (state.fmRevision !== previous.fmRevision || state.fm !== previous.fm) notify("fm");
  });
  onEnginePhaseChange(() => { engineRevision += 1; notify(); });
  if (typeof window !== "undefined") window.addEventListener(SOURCE_POLICY_CHANGED_EVENT, () => { engineRevision += 1; notify(); });
  binding = Promise.all([
    ...[SOURCE_META_CHANGED_EVENT, SOURCE_PACK_CHANGED_EVENT].map(event => listen(event, () => {
      engineRevision += 1; packTransition = true; expectedMeta = null; notify();
    })),
    listen<Record<string, unknown>>("source-engine-status", event => {
      if (Object.prototype.hasOwnProperty.call(event.payload, "meta")) applyLoadedMeta(readMeta(event.payload.meta));
    }),
  ]).then(() => undefined).catch(() => { throw new AccountRecommendationError("ENGINE_UNAVAILABLE"); });
  return binding;
}
export function onAccountRecommendationContextChange(listener: ContextListener): () => void {
  listeners.add(listener);
  void bindEpochs().catch(() => undefined);
  return () => listeners.delete(listener);
}
function selectionIsCurrent(feature: RecommendationFeature, sourceId: string, revision: number): boolean {
  const state = useRecommendationSourceStore.getState();
  return state.loaded && state[feature].origin === "account" && state[feature].sourceId === sourceId &&
    state[feature === "daily" ? "dailyRevision" : "fmRevision"] === revision;
}
/** Cross-check native selection with the actual loaded slot, not registry-content generation. */
async function liveEngine(): Promise<{ engineRevision: number; packVersion: string }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const revision = engineRevision;
    let raw: unknown;
    try { raw = await sourceState(); } catch { throw new AccountRecommendationError("ENGINE_UNAVAILABLE"); }
    const state = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const target = Array.isArray(state.packs) ? state.packs.find(pack => pack && typeof pack === "object" && pack.id === state.activeMetaId && pack.kind === "meta") as Record<string, unknown> | undefined : undefined;
    if (!target || typeof target.id !== "string" || typeof target.versionCode !== "number") throw new AccountRecommendationError("UNSUPPORTED");
    expectedMeta = { id: target.id, code: target.versionCode };
    const loaded = await queryEngineMeta();
    if (revision !== engineRevision) continue;
    if (!loaded || loaded.id !== expectedMeta.id || loaded.code !== expectedMeta.code) throw new AccountRecommendationError("PACK_LOADING");
    applyLoadedMeta(loaded);
    packTransition = false;
    return { engineRevision, packVersion: packVersion(loaded) };
  }
  throw new AccountRecommendationError("STALE_CONTEXT");
}
export async function getAccountRecommendationContext(feature: RecommendationFeature): Promise<AccountRecommendationContext> {
  try {
    await bindEpochs();
    await waitSourcePolicy();
    await useRecommendationSourceStore.getState().load();
    const state = useRecommendationSourceStore.getState();
    const selection = state[feature];
    const selectionRevision = state[feature === "daily" ? "dailyRevision" : "fmRevision"];
    if (selection.origin !== "account" || !selection.sourceId) throw new AccountRecommendationError("UNSUPPORTED");
    if (!sourceEnabled(selection.sourceId)) throw new AccountRecommendationError("SOURCE_DISABLED");
    const engine = await liveEngine();
    const registry = await sources.getSourceRegistry();
    const source = registry?.sources.find(item => item.id === selection.sourceId);
    if (source?.accountRecommendations?.[feature] !== true) throw new AccountRecommendationError("UNSUPPORTED");
    const auth = await prepareSourceMetaAuth(selection.sourceId);
    const context = { ...auth, feature, sourceName: source.name, selectionRevision, ...engine };
    if (!accountRecommendationContextIsCurrent(context)) throw new AccountRecommendationError("STALE_CONTEXT");
    return context;
  } catch (error) { throw safeAccountRecommendationError(error); }
}
export function accountRecommendationContextIsCurrent(context: AccountRecommendationContext): boolean {
  return sourceEnabled(context.sourceId) && !packTransition && engineSnapshot().phase === "ready" && engineRevision === context.engineRevision &&
    knownPackVersion === context.packVersion && selectionIsCurrent(context.feature, context.sourceId, context.selectionRevision) &&
    sourceMetaAuthSnapshotIsCurrent(context);
}
export function assertAccountRecommendationContextCurrent(context: AccountRecommendationContext): void {
  if (!accountRecommendationContextIsCurrent(context)) throw new AccountRecommendationError("STALE_CONTEXT");
}
export async function fetchAccountRecommendation(context: AccountRecommendationContext, cursor?: string): Promise<AccountRecommendationPage> {
  try {
    assertAccountRecommendationContextCurrent(context);
    const batch = context.feature === "daily" ? await sources.accountDailySongs(context.sourceId, context.accountId)
      : await sources.accountFmNext(context.sourceId, context.accountId, cursor);
    assertAccountRecommendationContextCurrent(context);
    return { tracks: batch.items.map(item => sources.toAppTrack(item, context.sourceId)), fetchedAt: batch.fetchedAt,
      ...(batch.cursor === undefined ? {} : { cursor: batch.cursor }),
      ...(batch.expiresAt === undefined ? {} : { expiresAt: batch.expiresAt }), exhausted: batch.exhausted === true };
  } catch (error) {
    // Preserve explicit backend revocation; discard unrelated failures from an old context.
    const safe = safeAccountRecommendationError(error);
    if (safe.code !== "AUTH_CHANGED") assertAccountRecommendationContextCurrent(context);
    throw safe;
  }
}
