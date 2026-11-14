import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestBuiltin, SourceResponse } from "../../qt-sources/src/contract";

// Agreed seam: real PC auth, recommendation helper, facade and engine client +
// real registered source handlers. Only Tauri/native transport and host HTTP
// are synthetic; no private settings, live account, network or player is used.
type EventListener = (event: { payload: unknown }) => void;
type EngineRequest = { requestId: number; kind: string; entry?: string; args?: Record<string, unknown> };
type Entries = Record<string, (args: Record<string, unknown>) => string | Promise<string>>;
const boundary = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  listeners: new Map<string, Set<EventListener>>(),
  request: null as ((request: EngineRequest) => Promise<void>) | null,
  metaAck: null as { entered: () => void; result: Promise<boolean> } | null,
  phase: "ready" as "ready" | "error",
  meta: { id: "owned-meta", code: 1, revision: "18" },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "get_setting") return boundary.settings.get(String(args.key)) ?? null;
    if (command === "set_setting") { boundary.settings.set(String(args.key), String(args.value)); return; }
    if (command === "clear_play_url_cache") return 0;
    if (command === "source_state") return {
      activeMetaId: boundary.meta.id,
      packs: [{ id: boundary.meta.id, kind: "meta", versionCode: boundary.meta.code }],
    };
    throw new Error(`Unexpected native command in owned fixture: ${command}`);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, listener: EventListener) => {
    const listeners = boundary.listeners.get(event) ?? new Set<EventListener>();
    boundary.listeners.set(event, listeners);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  emit: async (event: string, payload: unknown) => {
    for (const listener of boundary.listeners.get(event) ?? []) listener({ payload });
  },
  emitTo: async (_target: string, event: string, payload: EngineRequest) => {
    if (event !== "source-engine-request" || !boundary.request) throw new Error("Unexpected owned engine transport");
    // Sending is not awaiting remote business work, just as with Tauri events.
    void boundary.request(payload);
  },
}));

import { RECOMMENDATION_SOURCE_KEY, SOURCE_AUTH_TOGGLES_KEY } from "@/lib/storageKeys";

const WYY_ACCOUNT = "https://music.163.com/weapi/w/nuser/account/get";
const WYY_DAILY = "https://music.163.com/weapi/v3/discovery/recommend/songs";
const WYY_FM = "https://music.163.com/weapi/v1/radio/get";
const COOKIE = "MUSIC_U=owned-synthetic-session; __csrf=owned-synthetic-csrf";
const USER = { id: "42", nickname: "Owned account", avatar: "", vip: false, vipLabel: "" };
const response = (body: unknown): SourceResponse => ({ statusCode: 200, headers: {}, body });
const accountResponse = response({ code: 200, account: { id: 42 }, profile: { userId: 42 } });
const dailyResponse = response({ code: 200, data: { dailySongs: [
  { id: 902, name: "Owned daily song", ar: [{ name: "Owned singer" }], al: { name: "Owned album" }, dt: 201500 },
] } });
const fmResponse = response({ code: 200, data: [
  { id: 701, name: "Owned FM song", artists: [{ name: "Owned FM singer" }], album: { name: "Owned FM album" }, duration: 240000 },
] });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function dispatch(event: string, payload: unknown): void {
  for (const listener of boundary.listeners.get(event) ?? []) listener({ payload });
}

let auth: typeof import("@/lib/source-auth");
let recommendations: typeof import("@/lib/account-recommendation");
let entries: Entries;
let routes: Map<string, SourceResponse | (() => Promise<SourceResponse>)>;

function holdHttp(url: string, answer: SourceResponse) {
  const entered = deferred<void>();
  const held = deferred<SourceResponse>();
  routes.set(url, () => { entered.resolve(); return held.promise; });
  return { entered: entered.promise, release: () => held.resolve(answer) };
}

function holdMetaAck() {
  const entered = deferred<void>();
  const held = deferred<boolean>();
  boundary.metaAck = { entered: () => entered.resolve(), result: held.promise };
  return { entered: entered.promise, release: (ok = true) => held.resolve(ok) };
}
async function requireNewAck(gate: { entered: Promise<void> }, outcome: Promise<unknown>): Promise<void> {
  await Promise.race([
    gate.entered,
    outcome.then(() => { throw new Error("A new metadata ACK was required before readiness"); }),
  ]);
}
let acceptedCookie = COOKIE;

beforeEach(async () => {
  vi.resetModules();
  boundary.settings.clear();
  boundary.listeners.clear();
  boundary.metaAck = null;
  boundary.phase = "ready";
  boundary.meta = { id: "owned-meta", code: 1, revision: "18" };
  acceptedCookie = COOKIE;
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (...args: Parameters<typeof clearTimeout>) => clearTimeout(...args),
  }));
  vi.stubGlobal("fetch", () => { throw new Error("Live HTTP is forbidden in the owned account fixture"); });
  boundary.settings.set(RECOMMENDATION_SOURCE_KEY, JSON.stringify({
    v: 1, daily: { origin: "account", sourceId: "wyy" }, fm: { origin: "account", sourceId: "wyy" },
  }));
  boundary.settings.set(SOURCE_AUTH_TOGGLES_KEY, JSON.stringify({ wyy: { useMeta: true, usePlay: false } }));
  routes = new Map([[WYY_ACCOUNT, accountResponse], [WYY_DAILY, dailyResponse], [WYY_FM, fmResponse]]);
  const request: RequestBuiltin = async (url, options) => {
    const target = new URL(url);
    const fixture = routes.get(target.origin + target.pathname);
    if (!fixture) throw new Error(`Unexpected owned HTTP route: ${target.origin + target.pathname}`);
    // WYY prepends its device defaults; the exact saved session must still arrive.
    if (!options?.headers?.Cookie?.endsWith(acceptedCookie)) throw new Error("Synthetic HTTP account session mismatch");
    return typeof fixture === "function" ? fixture() : fixture;
  };
  const { registerQtEntries } = await import("../../qt-sources/src/meta-entries");
  registerQtEntries({ request, platform: 1103 });
  entries = (globalThis as unknown as { __qtEntries: Entries }).__qtEntries;
  entries.clearAuth({ scope: "meta" });
  entries.clearAuth({ scope: "play" });
  boundary.request = async ({ requestId, kind, entry, args }) => {
    try {
      if (kind === "status") {
        dispatch("source-engine-response", { requestId, phase: boundary.phase, code: 1, meta: boundary.meta, pack: null });
        return;
      }
      if (kind !== "invoke" || !entry || !entries[entry]) throw new Error(`Unexpected owned source entry: ${entry}`);
      if (entry === "setAuth" && args?.scope === "meta" && boundary.metaAck) {
        const gate = boundary.metaAck;
        boundary.metaAck = null;
        gate.entered();
        if (!await gate.result) {
          dispatch("source-engine-response", { requestId, result: JSON.stringify({ ok: false }) });
          return;
        }
      }
      const result = await entries[entry](args ?? {});
      dispatch("source-engine-response", { requestId, result });
    } catch (error) {
      dispatch("source-engine-response", { requestId, error: error instanceof Error ? error.message : String(error) });
    }
  };
  auth = await import("@/lib/source-auth");
  recommendations = await import("@/lib/account-recommendation");
  await auth.saveSourceAuthAccount("wyy", COOKIE, USER);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  entries?.clearAuth({ scope: "meta" });
  entries?.clearAuth({ scope: "play" });
  delete (globalThis as { __qtEntries?: unknown }).__qtEntries;
  boundary.request = null;
  vi.unstubAllGlobals();
});

describe("account metadata session sharing through real registered handlers", () => {
  it("the first successful save observes a metadata reset before any recommendation context is prepared", async () => {
    // beforeEach used the public save API, but no preparation or ensure API yet.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    dispatch("source-meta-changed", {});
    boundary.meta = { id: "owned-meta", code: 2, revision: "18" };
    entries.clearAuth({ scope: "meta" });
    const context = await recommendations.getAccountRecommendationContext("daily");
    await expect(recommendations.fetchAccountRecommendation(context)).resolves.toMatchObject({
      tracks: [expect.objectContaining({ id: "902", title: "Owned daily song" })],
    });
  });

  it("concurrent preparations await a successful ACK and a failed ACK is never reused", async () => {
    // Drain the ready-phase replay from the initial save before testing failed ACKs.
    await auth.ensureSourceAuthInjected();
    auth.resetSourceAuthCaches();
    const denied = holdMetaAck();
    let firstSettled = false;
    let secondSettled = false;
    const first = auth.prepareSourceMetaAuth("wyy").then(snapshot => {
      firstSettled = true; return { snapshot };
    }, error => { firstSettled = true; return { error }; });
    const second = auth.prepareSourceMetaAuth("wyy").then(snapshot => {
      secondSettled = true; return { snapshot };
    }, error => { secondSettled = true; return { error }; });
    await requireNewAck(denied, first);
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);
    const retry = holdMetaAck();
    denied.release(false);
    try {
      expect(await first).toEqual({ error: expect.any(Error) });
      await requireNewAck(retry, second);
      expect(secondSettled).toBe(false);
    } finally {
      retry.release();
    }
    expect(await second).toMatchObject({ snapshot: { sourceId: "wyy", accountId: "42" } });
    const context = await recommendations.getAccountRecommendationContext("daily");
    await expect(recommendations.fetchAccountRecommendation(context)).resolves.toMatchObject({
      tracks: [expect.objectContaining({ id: "902", title: "Owned daily song" })],
    });
  });

  it("same-account re-login at the same clock gives a distinct session, revokes the old snapshot and requires the new credential ACK", async () => {
    const old = await recommendations.getAccountRecommendationContext("daily");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(old.accountSession));
    const replacement = "MUSIC_U=owned-synthetic-relogin";
    acceptedCookie = replacement;
    const gate = holdMetaAck();
    const saving = auth.saveSourceAuthAccount("wyy", replacement, USER);
    expect(auth.sourceMetaAuthSnapshotIsCurrent(old)).toBe(false);
    let prepared = false;
    const preparing = auth.prepareSourceMetaAuth("wyy").then(snapshot => { prepared = true; return snapshot; });
    try {
      await requireNewAck(gate, saving);
      expect(prepared).toBe(false);
    } finally {
      gate.release();
    }
    await saving;
    const snapshot = await preparing;
    expect(snapshot.accountSession).not.toBe(old.accountSession);
    expect(snapshot.authRevision).not.toBe(old.authRevision);
    const context = await recommendations.getAccountRecommendationContext("daily");
    await expect(recommendations.fetchAccountRecommendation(context)).resolves.toMatchObject({
      tracks: [expect.objectContaining({ id: "902", title: "Owned daily song" })],
    });
  });

  it("meta-off clears the registered handler session, rejects an old FM response and requires ACK on re-enable", async () => {
    const old = await recommendations.getAccountRecommendationContext("fm");
    const fm = holdHttp(WYY_FM, fmResponse);
    const settled = recommendations.fetchAccountRecommendation(old).then(page => ({ page }), error => ({ error }));
    await Promise.race([fm.entered, settled.then(() => { throw new Error("The actual FM HTTP fixture was not reached"); })]);
    try {
      const switching = auth.setSourceAuthToggle("wyy", "meta", false);
      expect(auth.sourceMetaAuthSnapshotIsCurrent(old)).toBe(false);
      await switching;
      await expect(auth.prepareSourceMetaAuth("wyy")).rejects.toThrow("ACCOUNT_META_DISABLED");
      await expect(entries.accountDailySongs({ source: "wyy", accountId: "42" })).rejects.toThrow("AUTH_REQUIRED");
    } finally {
      fm.release();
    }
    expect(await settled).toMatchObject({ error: { code: "AUTH_CHANGED" } });
    const gate = holdMetaAck();
    const enabling = auth.setSourceAuthToggle("wyy", "meta", true);
    let prepared = false;
    const preparing = auth.prepareSourceMetaAuth("wyy").then(snapshot => { prepared = true; return snapshot; });
    try {
      await requireNewAck(gate, enabling);
      expect(prepared).toBe(false);
    } finally {
      gate.release();
    }
    await Promise.all([enabling, preparing]);
    const context = await recommendations.getAccountRecommendationContext("fm");
    await expect(recommendations.fetchAccountRecommendation(context)).resolves.toMatchObject({
      tracks: [expect.objectContaining({ id: "701", title: "Owned FM song" })],
    });
  });

  it("logout revokes immediately and leaves both the snapshot API and registered metadata handler unauthorized", async () => {
    const old = await auth.prepareSourceMetaAuth("wyy");
    const removing = auth.removeSourceAuthAccount("wyy");
    expect(auth.sourceMetaAuthSnapshotIsCurrent(old)).toBe(false);
    await removing;
    await expect(auth.prepareSourceMetaAuth("wyy")).rejects.toThrow("ACCOUNT_AUTH_REQUIRED");
    await expect(entries.accountDailySongs({ source: "wyy", accountId: "42" })).rejects.toThrow("AUTH_REQUIRED");
  });

  it("engine error-to-ready recovery cannot reuse the previous engine's metadata ACK", async () => {
    const old = await recommendations.getAccountRecommendationContext("daily");
    const engine = await import("@/source-engine/client");
    boundary.phase = "error";
    await engine.queryEngineMeta();
    entries.clearAuth({ scope: "meta" });
    expect(recommendations.accountRecommendationContextIsCurrent(old)).toBe(false);
    const gate = holdMetaAck();
    boundary.phase = "ready";
    await engine.queryEngineMeta();
    let prepared = false;
    const preparing = auth.prepareSourceMetaAuth("wyy").then(snapshot => { prepared = true; return snapshot; });
    try {
      await requireNewAck(gate, preparing);
      expect(prepared).toBe(false);
    } finally {
      gate.release();
    }
    expect((await preparing).authRevision).toBe(old.authRevision);
    const context = await recommendations.getAccountRecommendationContext("daily");
    await expect(recommendations.fetchAccountRecommendation(context)).resolves.toMatchObject({
      tracks: [expect.objectContaining({ id: "902", title: "Owned daily song" })],
    });
  });

  it("a play-pack lifecycle reset requires a new metadata ACK even when the loaded data header is unchanged", async () => {
    await recommendations.getAccountRecommendationContext("daily");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const gate = holdMetaAck();
    dispatch("source-pack-changed", {});
    entries.clearAuth({ scope: "meta" });
    let prepared = false;
    const preparing = recommendations.getAccountRecommendationContext("daily").then(context => { prepared = true; return context; });
    try {
      await requireNewAck(gate, preparing);
      expect(prepared).toBe(false);
    } finally {
      gate.release();
    }
    await expect(recommendations.fetchAccountRecommendation(await preparing)).resolves.toMatchObject({
      tracks: [expect.objectContaining({ id: "902", title: "Owned daily song" })],
    });
  });

  it("an ACK arriving across a metadata reset cannot resurrect readiness for the next preparation", async () => {
    await recommendations.getAccountRecommendationContext("daily");
    auth.resetSourceAuthCaches();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const oldAck = holdMetaAck();
    const old = auth.prepareSourceMetaAuth("wyy").then(snapshot => ({ snapshot }), error => ({ error }));
    await requireNewAck(oldAck, old);
    dispatch("source-meta-changed", {});
    const newAck = holdMetaAck();
    oldAck.release();
    try {
      expect(await old).toMatchObject({ error: { message: expect.stringMatching(/^ACCOUNT_AUTH_CHANGED:/) } });
      const preparing = auth.prepareSourceMetaAuth("wyy");
      await requireNewAck(newAck, preparing);
      newAck.release();
      await preparing;
    } finally {
      newAck.release();
    }
    const context = await recommendations.getAccountRecommendationContext("daily");
    await expect(recommendations.fetchAccountRecommendation(context)).resolves.toMatchObject({
      tracks: [expect.objectContaining({ id: "902", title: "Owned daily song" })],
    });
  });

  it("a freshly loaded metadata slot is authenticated before use and delayed retries preserve its pending FM", async () => {
    const old = await recommendations.getAccountRecommendationContext("daily");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    dispatch("source-meta-changed", {});
    // Native now selects a fresh slot; its public auth entries start empty.
    boundary.meta = { id: "owned-meta", code: 2, revision: "18" };
    entries.clearAuth({ scope: "meta" });
    entries.clearAuth({ scope: "play" });
    expect(recommendations.accountRecommendationContextIsCurrent(old)).toBe(false);
    const fresh = await recommendations.getAccountRecommendationContext("daily");
    expect(fresh.packVersion).toBe("owned-meta@2:18");
    await expect(recommendations.fetchAccountRecommendation(fresh)).resolves.toMatchObject({
      tracks: [expect.objectContaining({ id: "902", title: "Owned daily song" })],
    });
    const fmContext = await recommendations.getAccountRecommendationContext("fm");
    const fm = holdHttp(WYY_FM, fmResponse);
    const settled = recommendations.fetchAccountRecommendation(fmContext).then(page => ({ page }), error => ({ error }));
    await Promise.race([
      fm.entered,
      settled.then(() => { throw new Error("The actual FM HTTP fixture was not reached"); }),
    ]);
    try {
      await vi.advanceTimersByTimeAsync(800);
      await vi.advanceTimersByTimeAsync(1700);
    } finally {
      fm.release();
    }
    expect(await settled).toEqual({ page: {
      tracks: [expect.objectContaining({ id: "701", title: "Owned FM song" })],
      fetchedAt: expect.any(Number), exhausted: false,
    } });
  });

  it("daily and FM consumers share the saved account while the FM recommendation HTTP is pending", async () => {
    const context = await recommendations.getAccountRecommendationContext("fm");
    const fm = holdHttp(WYY_FM, fmResponse);
    const settled = recommendations.fetchAccountRecommendation(context).then(page => ({ page }), error => ({ error }));
    await Promise.race([fm.entered, settled.then(() => { throw new Error("The actual FM HTTP fixture was not reached"); })]);
    try {
      const daily = await recommendations.getAccountRecommendationContext("daily");
      await expect(recommendations.fetchAccountRecommendation(daily)).resolves.toMatchObject({
        tracks: [expect.objectContaining({ id: "902", title: "Owned daily song" })],
      });
    } finally {
      fm.release();
    }
    expect(await settled).toEqual({ page: {
      tracks: [expect.objectContaining({ id: "701", title: "Owned FM song" })],
      fetchedAt: expect.any(Number), exhausted: false,
    } });
  });

  it("play-only toggles preserve a pending FM recommendation and its metadata revision", async () => {
    const context = await recommendations.getAccountRecommendationContext("fm");
    const fm = holdHttp(WYY_FM, fmResponse);
    const settled = recommendations.fetchAccountRecommendation(context).then(page => ({ page }), error => ({ error }));
    await Promise.race([
      fm.entered,
      settled.then(() => { throw new Error("The actual FM HTTP fixture was not reached"); }),
    ]);
    try {
      await auth.setSourceAuthToggle("wyy", "play", true);
      await auth.setSourceAuthToggle("wyy", "play", false);
      expect(auth.sourceMetaAuthRevision("wyy")).toBe(context.authRevision);
      expect(recommendations.accountRecommendationContextIsCurrent(context)).toBe(true);
    } finally {
      fm.release();
    }
    expect(await settled).toEqual({ page: {
      tracks: [expect.objectContaining({ id: "701", platform: "wyy", title: "Owned FM song", duration: 240 })],
      fetchedAt: expect.any(Number), exhausted: false,
    } });
  });

  it("preparing another same-account context preserves the first consumer's pending identity request", async () => {
    const context = await recommendations.getAccountRecommendationContext("daily");
    const identity = holdHttp(WYY_ACCOUNT, accountResponse);
    const settled = recommendations.fetchAccountRecommendation(context).then(page => ({ page }), error => ({ error }));
    await Promise.race([
      identity.entered,
      settled.then(() => { throw new Error("The actual identity HTTP fixture was not reached"); }),
    ]);
    try {
      // Independent consumers can prepare the same account without re-login.
      await recommendations.getAccountRecommendationContext("daily");
    } finally {
      identity.release();
    }
    expect(await settled).toEqual({ page: {
      tracks: [expect.objectContaining({ id: "902", platform: "wyy", title: "Owned daily song", singer: "Owned singer", duration: 201.5 })],
      fetchedAt: expect.any(Number), exhausted: false,
    } });
  });
});
