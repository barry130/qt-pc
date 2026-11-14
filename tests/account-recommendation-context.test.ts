// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RECOMMENDATION_SOURCE_KEY, SOURCE_AUTH_ACCOUNTS_KEY, SOURCE_AUTH_TOGGLES_KEY } from "@/lib/storageKeys";
import { SOURCE_META_CHANGED_EVENT } from "@/services/ipc";

const boundary = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  listeners: new Map<string, Array<(event: { payload: Record<string, unknown> }) => void>>(),
  installedCode: 1,
  loadedCode: 1,
  dailyWait: null as Promise<void> | null,
  dailyError: null as string | null,
  dailyStarted: false,
  settingWait: null as Promise<void> | null,
}));
function publish(event: string, payload: Record<string, unknown>): void {
  for (const listener of boundary.listeners.get(event) ?? []) listener({ payload });
}
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    if (command === "get_setting") return boundary.settings.get(String(args.key)) ?? null;
    if (command === "set_setting") { await boundary.settingWait; boundary.settings.set(String(args.key), String(args.value)); return; }
    if (command === "clear_play_url_cache") return 0;
    if (command === "source_state") return { activeMetaId: "owned-meta", packs: [{ id: "owned-meta", kind: "meta", versionCode: boundary.installedCode }] };
    throw new Error(`Unexpected owned native command: ${command}`);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, listener: (event: { payload: Record<string, unknown> }) => void) => {
    const listeners = boundary.listeners.get(name) ?? []; listeners.push(listener); boundary.listeners.set(name, listeners);
    return () => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); };
  },
  emit: async () => undefined,
  emitTo: async (_label: string, event: string, request: Record<string, unknown>) => {
    if (event !== "source-engine-request") throw new Error(`Unexpected event: ${event}`);
    if (request.kind === "status") {
      publish("source-engine-response", { requestId: request.requestId, phase: "ready", pack: null,
        meta: { id: "owned-meta", code: boundary.loadedCode, revision: "18" } });
      return;
    }
    if (request.kind !== "invoke") throw new Error(`Unexpected RPC kind: ${String(request.kind)}`);
    let result: Record<string, unknown>;
    if (request.entry === "sourceRegistry") result = { sources: [{ id: "wyy", name: "Owned source", accountRecommendations: { daily: true, fm: true } }], qualities: [] };
    else if (request.entry === "setAuth" || request.entry === "clearAuth") result = { ok: true };
    else if (request.entry === "accountDailySongs") {
      boundary.dailyStarted = true;
      await boundary.dailyWait;
      if (boundary.dailyError) { publish("source-engine-response", { requestId: request.requestId, error: boundary.dailyError }); return; }
      result = { source: "wyy", kind: "daily", accountId: "42", fetchedAt: Date.now(), items: [
        { id: "wyy_900", musicId: "900", name: "Upstream first", singer: "Fixture", album: "", picUrl: "", interval: 200 },
        { id: "wyy_100", musicId: "100", name: "Upstream second", singer: "Fixture", album: "", picUrl: "", interval: 180 },
      ] };
    } else throw new Error(`Unexpected owned source entry: ${String(request.entry)}`);
    publish("source-engine-response", { requestId: request.requestId, result: JSON.stringify(result) });
  },
}));
// Logging is an external IO boundary, not the recommendation business implementation.
vi.mock("@/lib/logger", () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  vi.useFakeTimers(); vi.resetModules(); boundary.settings.clear(); boundary.listeners.clear();
  boundary.installedCode = 1; boundary.loadedCode = 1; boundary.dailyWait = null;
  boundary.dailyError = null; boundary.dailyStarted = false; boundary.settingWait = null;
  boundary.settings.set(RECOMMENDATION_SOURCE_KEY, JSON.stringify({ v: 1, daily: { origin: "account", sourceId: "wyy" }, fm: { origin: "app", sourceId: "" } }));
  boundary.settings.set(SOURCE_AUTH_ACCOUNTS_KEY, JSON.stringify({ wyy: {
    cookie: "owned-fixture-not-a-real-cookie", savedAt: "2026-11-09T00:00:00.000Z",
    user: { id: "42", nickname: "Owned account", avatar: "", vip: false, vipLabel: "" },
  } }));
  boundary.settings.set(SOURCE_AUTH_TOGGLES_KEY, JSON.stringify({ wyy: { useMeta: true, usePlay: false } }));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("public account recommendation context", () => {
  it("binds live engine metadata and acknowledged account auth without re-ranking upstream tracks", async () => {
    const account = await import("@/lib/account-recommendation");
    const context = await account.getAccountRecommendationContext("daily");
    const result = await account.fetchAccountRecommendation(context);
    expect(context).toMatchObject({ sourceId: "wyy", accountId: "42", nickname: "Owned account", packVersion: "owned-meta@1:18" });
    expect(result.tracks.map(track => [track.platform, track.id, track.musicId])).toEqual([
      ["wyy", "wyy_900", "900"], ["wyy", "wyy_100", "100"],
    ]);
    expect(JSON.stringify({ context, result })).not.toContain("owned-fixture-not-a-real-cookie");
  });

  it("rejects a late public RPC batch after the user changes the daily provider", async () => {
    const account = await import("@/lib/account-recommendation");
    const store = (await import("@/stores/recommendation-source")).useRecommendationSourceStore;
    const context = await account.getAccountRecommendationContext("daily");
    let release!: () => void;
    boundary.dailyWait = new Promise<void>(resolve => { release = resolve; });
    const pending = account.fetchAccountRecommendation(context);
    const rejected = expect(pending).rejects.toMatchObject({ code: "STALE_CONTEXT" });
    await store.getState().setSelection("daily", { origin: "app", sourceId: "" });
    release(); await rejected;
  });

  it("discards an old RPC failure immediately on metadata revocation before its native persistence ACK", async () => {
    const account = await import("@/lib/account-recommendation");
    const auth = await import("@/lib/source-auth");
    const context = await account.getAccountRecommendationContext("daily");
    let releaseRpc!: () => void;
    let releaseSetting!: () => void;
    boundary.dailyWait = new Promise<void>(resolve => { releaseRpc = resolve; });
    boundary.settingWait = new Promise<void>(resolve => { releaseSetting = resolve; });
    boundary.dailyError = "ACCOUNT_RECOMMENDATIONS_RATE_LIMIT";
    const pending = account.fetchAccountRecommendation(context);
    const rejected = expect(pending).rejects.toMatchObject({ code: "STALE_CONTEXT" });
    await vi.waitFor(() => expect(boundary.dailyStarted).toBe(true));
    const revocation = auth.setSourceAuthToggle("wyy", "meta", false);
    expect(account.accountRecommendationContextIsCurrent(context)).toBe(false);
    try { releaseRpc(); await rejected; }
    finally { releaseSetting(); await revocation; }
  });

  it("revokes an old loaded-pack context and binds the new actual pack after metadata replacement", async () => {
    const account = await import("@/lib/account-recommendation");
    const context = await account.getAccountRecommendationContext("daily");
    boundary.installedCode = 2; boundary.loadedCode = 2;
    publish(SOURCE_META_CHANGED_EVENT, {});
    expect(account.accountRecommendationContextIsCurrent(context)).toBe(false);
    await expect(account.fetchAccountRecommendation(context)).rejects.toMatchObject({ code: "STALE_CONTEXT" });
    const next = await account.getAccountRecommendationContext("daily");
    expect(next.packVersion).toBe("owned-meta@2:18");
    expect(next.engineRevision).not.toBe(context.engineRevision);
    await expect(account.fetchAccountRecommendation(next)).resolves.toMatchObject({ tracks: expect.any(Array) });
  });
});
