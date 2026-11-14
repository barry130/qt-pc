// @vitest-environment jsdom
// Agreed public seam: real daily generator/load/clear + account context/auth,
// provider selection, facade and engine client. Only Native KV and the engine
// event/RPC transport are owned fixtures; no live HTTP or private accounts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_DAILY_CACHE_KEY,
  DAILY_RECOMMEND_CACHE_KEY,
  DAILY_RECOMMEND_MODE_KEY,
  RECOMMENDATION_SOURCE_KEY,
  SOURCE_AUTH_ACCOUNTS_KEY,
  SOURCE_AUTH_TOGGLES_KEY,
  SOURCE_AUTH_USE_META_KEY,
  SOURCE_AUTH_USE_PLAY_KEY,
} from "@/lib/storageKeys";
import { SOURCE_POLICY_KEY } from "@/lib/source-policy";

type EventListener = (event: { payload: Record<string, unknown> }) => void;
type EngineRequest = { requestId: number; kind: string; entry?: string; args?: Record<string, unknown> };
const boundary = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  listeners: new Map<string, Set<EventListener>>(),
  unexpected: [] as string[],
  meta: { id: "owned-meta", code: 1, revision: "18" },
  request: null as ((request: EngineRequest) => Promise<void>) | null,
  dailyError: null as string | null,
  dailyWait: null as Promise<void> | null,
  dailyEntered: null as (() => void) | null,
  cacheWrite: null as ((value: string) => Promise<void>) | null,
  dailyItems: [] as unknown[],
  dailySource: "wyy",
  dailyAccount: "42",
  dailyExpiresAt: null as number | null,
  allowAppCache: false,
  cacheRead: null as ((key: string) => Promise<void>) | null,
}));
function publish(name: string, payload: Record<string, unknown>): void {
  for (const listener of boundary.listeners.get(name) ?? []) listener({ payload });
}
function forbidden(message: string): never {
  boundary.unexpected.push(message);
  throw new Error(`Forbidden application/live boundary: ${message}`);
}
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "get_setting" || command === "set_setting") {
      const key = String(args.key);
      const allowed: string[] = [SOURCE_POLICY_KEY, ACCOUNT_DAILY_CACHE_KEY, RECOMMENDATION_SOURCE_KEY,
        SOURCE_AUTH_ACCOUNTS_KEY, SOURCE_AUTH_TOGGLES_KEY, SOURCE_AUTH_USE_META_KEY, SOURCE_AUTH_USE_PLAY_KEY];
      if (!allowed.includes(key) && !(boundary.allowAppCache && key === DAILY_RECOMMEND_CACHE_KEY)) forbidden(`${command}:${key}`);
      if (command === "get_setting") {
        const value = boundary.settings.get(key) ?? null;
        if (key === ACCOUNT_DAILY_CACHE_KEY || key === DAILY_RECOMMEND_CACHE_KEY) await boundary.cacheRead?.(key);
        return value;
      }
      if (key === ACCOUNT_DAILY_CACHE_KEY) await boundary.cacheWrite?.(String(args.value));
      boundary.settings.set(key, String(args.value));
      return;
    }
    if (command === "source_state") return { activeMetaId: boundary.meta.id,
      packs: [{ id: boundary.meta.id, kind: "meta", versionCode: boundary.meta.code }] };
    if (command === "clear_play_url_cache") return 0;
    return forbidden(command);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, listener: EventListener) => {
    const listeners = boundary.listeners.get(name) ?? new Set<EventListener>();
    boundary.listeners.set(name, listeners); listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  emit: async (name: string, payload: Record<string, unknown>) => publish(name, payload),
  emitTo: async (_target: string, name: string, request: EngineRequest) => {
    if (name !== "source-engine-request" || !boundary.request) forbidden(`event:${name}`);
    // Sending an event acknowledges transport, not the remote business work.
    void boundary.request!(request);
  },
}));
// Logger is external diagnostic IO, not an account/daily business collaborator.
vi.mock("@/lib/logger", () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const SYNTHETIC_CREDENTIAL = "owned-account-daily-fixture-not-a-real-cookie";
const USER = { id: "42", nickname: "Owned account", avatar: "", vip: false, vipLabel: "" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const UPSTREAM = [
  { id: "wyy_900", musicId: "900", name: "Upstream first", singer: "Same singer", album: "", picUrl: "", interval: 200 },
  { id: "wyy_100", musicId: "100", name: "Upstream second", singer: "Same singer", album: "", picUrl: "", interval: 180 },
];

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-09T08:00:00.000Z")); vi.resetModules();
  boundary.settings.clear(); boundary.listeners.clear(); boundary.unexpected.length = 0;
  boundary.meta = { id: "owned-meta", code: 1, revision: "18" }; boundary.dailyError = null;
  boundary.dailyWait = null; boundary.dailyEntered = null; boundary.cacheWrite = null; boundary.dailyItems = UPSTREAM;
  boundary.dailySource = "wyy"; boundary.dailyAccount = "42"; boundary.dailyExpiresAt = null; boundary.allowAppCache = false; boundary.cacheRead = null;
  vi.stubGlobal("fetch", () => forbidden("live HTTP"));
  boundary.settings.set(DAILY_RECOMMEND_MODE_KEY, "server");
  boundary.settings.set(DAILY_RECOMMEND_CACHE_KEY, "owned-app-history-must-stay-unchanged");
  boundary.settings.set(RECOMMENDATION_SOURCE_KEY, JSON.stringify({ v: 1,
    daily: { origin: "account", sourceId: "wyy" }, fm: { origin: "app", sourceId: "" } }));
  boundary.settings.set(SOURCE_AUTH_ACCOUNTS_KEY, JSON.stringify({ wyy: {
    cookie: SYNTHETIC_CREDENTIAL, savedAt: "2026-11-09T00:00:00.000Z", user: USER,
  } }));
  boundary.settings.set(SOURCE_AUTH_TOGGLES_KEY, JSON.stringify({ wyy: { useMeta: true, usePlay: false } }));
  boundary.request = async ({ requestId, kind, entry }) => {
    try {
      if (kind === "status") {
        publish("source-engine-response", { requestId, phase: "ready", pack: null, meta: boundary.meta });
        return;
      }
      if (kind !== "invoke") forbidden(`RPC kind:${kind}`);
      let result: Record<string, unknown>;
      if (entry === "sourceRegistry") result = { sources: [
        { id: "wyy", name: "Owned source", accountRecommendations: { daily: true, fm: true } },
        { id: "kg", name: "Other source", accountRecommendations: { daily: true, fm: false } },
      ], qualities: [] };
      else if (entry === "setAuth" || entry === "clearAuth") result = { ok: true };
      else if (entry === "accountDailySongs") {
        if (boundary.dailyError) throw new Error(boundary.dailyError);
        result = { source: boundary.dailySource, kind: "daily", accountId: boundary.dailyAccount,
          fetchedAt: Date.now(), items: boundary.dailyItems,
          ...(boundary.dailyExpiresAt === null ? {} : { expiresAt: boundary.dailyExpiresAt }) };
        boundary.dailyEntered?.();
        await boundary.dailyWait;
      }
      else return forbidden(`source entry:${String(entry)}`);
      publish("source-engine-response", { requestId, result: JSON.stringify(result) });
    } catch (error) {
      publish("source-engine-response", { requestId, error: error instanceof Error ? error.message : String(error) });
    }
  };
});
afterEach(() => {
  boundary.request = null; vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("account daily recommendation through the public generator", () => {
  it("selected account ignores server mode and returns exactly the upstream order and original IDs", async () => {
    const { generateDailyRecommend } = await import("@/lib/daily-recommend");
    const result = await generateDailyRecommend({ mode: "server", taste: "explore" });
    expect(result).toMatchObject({ origin: "account", mode: "rule", requested: "rule", account: {
      sourceId: "wyy", sourceName: "Owned source", accountId: "42", nickname: "Owned account",
      packVersion: "owned-meta@1:18", fetchedAt: 1794211200000,
    } });
    expect(result.items.map(item => [item.track.platform, item.track.id, item.track.musicId])).toEqual([
      ["wyy", "wyy_900", "900"], ["wyy", "wyy_100", "100"],
    ]);
    expect(result.items.map(item => item.reason)).toEqual(["Owned source · 账号每日推荐", "Owned source · 账号每日推荐"]);
    expect(result.taste).toBeUndefined(); expect(result.profileText).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(SYNTHETIC_CREDENTIAL);
    expect(boundary.settings.get(DAILY_RECOMMEND_MODE_KEY)).toBe("server");
    expect(boundary.settings.get(DAILY_RECOMMEND_CACHE_KEY)).toBe("owned-app-history-must-stay-unchanged");
    expect(boundary.unexpected).toEqual([]);
  });

  it("loads and reuses the selected account cache independently of app history, mode and taste", async () => {
    const daily = await import("@/lib/daily-recommend");
    const first = await daily.generateDailyRecommend();
    boundary.dailyError = "ACCOUNT_NETWORK: owned unavailable upstream";
    expect(await daily.loadTodayResult("server", "explore")).toEqual(first);
    expect(await daily.generateDailyRecommend({ mode: "local", taste: "heart" })).toEqual(first);
    expect(boundary.settings.get(ACCOUNT_DAILY_CACHE_KEY)).toBeDefined();
    expect(boundary.settings.get(ACCOUNT_DAILY_CACHE_KEY)).not.toContain(SYNTHETIC_CREDENTIAL);
    expect(boundary.settings.get(DAILY_RECOMMEND_CACHE_KEY)).toBe("owned-app-history-must-stay-unchanged");
    expect(boundary.settings.get(DAILY_RECOMMEND_MODE_KEY)).toBe("server");
    expect(boundary.unexpected).toEqual([]);
  });

  it("discards a fetched batch after the caller page epoch is revoked without caching or stale progress", async () => {
    const daily = await import("@/lib/daily-recommend");
    const entered = deferred<void>(); const held = deferred<void>();
    boundary.dailyEntered = () => entered.resolve(); boundary.dailyWait = held.promise;
    let current = true;
    const progress: boolean[] = [];
    const pending = daily.generateDailyRecommend({ force: true, isCurrent: () => current,
      onProgress: () => { progress.push(current); } }).then(value => ({ value }), error => ({ error }));
    await entered.promise;
    current = false; held.resolve();
    expect(await pending).toMatchObject({ error: { code: "STALE_CONTEXT" } });
    expect(progress).not.toContain(false);
    boundary.dailyWait = null; boundary.dailyError = "ACCOUNT_NETWORK: owned unavailable upstream";
    await expect(daily.generateDailyRecommend()).rejects.toMatchObject({ code: "NETWORK" });
    expect(boundary.settings.get(ACCOUNT_DAILY_CACHE_KEY)).toBeUndefined();
    expect(boundary.unexpected).toEqual([]);
  });

  it("retires a cache write whose Native acknowledgement arrives after caller revocation", async () => {
    const daily = await import("@/lib/daily-recommend");
    const entered = deferred<void>(); const held = deferred<void>();
    boundary.cacheWrite = async () => { boundary.cacheWrite = null; entered.resolve(); await held.promise; };
    let current = true;
    const pending = daily.generateDailyRecommend({ force: true, isCurrent: () => current })
      .then(value => ({ value }), error => ({ error }));
    await entered.promise;
    current = false; held.resolve();
    expect(await pending).toMatchObject({ error: { code: "STALE_CONTEXT" } });
    expect(await daily.loadTodayResult()).toBeNull();
    boundary.dailyError = "ACCOUNT_NETWORK: owned unavailable upstream";
    await expect(daily.generateDailyRecommend()).rejects.toMatchObject({ code: "NETWORK" });
    expect(boundary.unexpected).toEqual([]);
  });

  it("a newer generation supersedes an older same-account response and remains the cached batch", async () => {
    const daily = await import("@/lib/daily-recommend");
    const entered = deferred<void>(); const held = deferred<void>();
    boundary.dailyEntered = () => entered.resolve(); boundary.dailyWait = held.promise;
    const old = daily.generateDailyRecommend({ force: true }).then(value => ({ value }), error => ({ error }));
    await entered.promise;
    boundary.dailyEntered = null; boundary.dailyWait = null; boundary.dailyItems = UPSTREAM.slice(1);
    const current = await daily.generateDailyRecommend({ force: true });
    held.resolve();
    expect(await old).toMatchObject({ error: { code: "STALE_CONTEXT" } });
    expect(current.items.map(item => item.track.id)).toEqual(["wyy_100"]);
    expect(await daily.loadTodayResult()).toEqual(current);
    expect(boundary.unexpected).toEqual([]);
  });

  it("does not stamp a response started before local midnight as the new day's account batch", async () => {
    const daily = await import("@/lib/daily-recommend");
    vi.setSystemTime(new Date(2026, 10, 9, 23, 59));
    const entered = deferred<void>(); const held = deferred<void>();
    boundary.dailyEntered = () => entered.resolve(); boundary.dailyWait = held.promise;
    const pending = daily.generateDailyRecommend({ force: true }).then(value => ({ value }), error => ({ error }));
    await entered.promise;
    vi.setSystemTime(new Date(2026, 10, 10, 0, 0)); held.resolve();
    expect(await pending).toMatchObject({ error: { code: "STALE_CONTEXT" } });
    expect(await daily.loadTodayResult()).toBeNull();
    boundary.dailyWait = null;
    const current = await daily.generateDailyRecommend();
    expect(current.date).toBe("2026-11-10");
    expect(current.items.map(item => item.track.id)).toEqual(["wyy_900", "wyy_100"]);
    expect(boundary.unexpected).toEqual([]);
  });

  it("a new login with the same account ID cannot reuse the previous savedAt session cache", async () => {
    const daily = await import("@/lib/daily-recommend");
    const auth = await import("@/lib/source-auth");
    await daily.generateDailyRecommend();
    vi.setSystemTime(new Date("2026-11-09T08:00:01.000Z"));
    await auth.saveSourceAuthAccount("wyy", SYNTHETIC_CREDENTIAL, USER);
    boundary.dailyError = "ACCOUNT_NETWORK: owned unavailable upstream";
    expect(await daily.loadTodayResult()).toBeNull();
    await expect(daily.generateDailyRecommend()).rejects.toMatchObject({ code: "NETWORK" });
    expect(boundary.settings.get(ACCOUNT_DAILY_CACHE_KEY)).not.toContain(SYNTHETIC_CREDENTIAL);
    expect(boundary.unexpected).toEqual([]);
  });

  it("another account cannot read the previous account's batch and receives only its own upstream songs", async () => {
    const daily = await import("@/lib/daily-recommend");
    const auth = await import("@/lib/source-auth");
    await daily.generateDailyRecommend();
    await auth.saveSourceAuthAccount("wyy", SYNTHETIC_CREDENTIAL, { ...USER, id: "84", nickname: "Next account" });
    boundary.dailyAccount = "84"; boundary.dailyItems = UPSTREAM.slice(1);
    expect(await daily.loadTodayResult()).toBeNull();
    const next = await daily.generateDailyRecommend();
    expect(next.account).toMatchObject({ sourceId: "wyy", accountId: "84", nickname: "Next account" });
    expect(next.items.map(item => item.track.id)).toEqual(["wyy_100"]);
    expect(await daily.loadTodayResult()).toEqual(next);
    expect(boundary.unexpected).toEqual([]);
  });

  it("an actual loaded metadata revision change invalidates cache even when the installation code is unchanged", async () => {
    const daily = await import("@/lib/daily-recommend");
    const first = await daily.generateDailyRecommend();
    boundary.meta = { id: "owned-meta", code: 1, revision: "19" };
    publish("source-engine-status", { phase: "ready", meta: boundary.meta });
    expect(await daily.loadTodayResult()).toBeNull();
    boundary.dailyItems = UPSTREAM.slice(1);
    const next = await daily.generateDailyRecommend();
    expect(first.account?.packVersion).toBe("owned-meta@1:18");
    expect(next.account?.packVersion).toBe("owned-meta@1:19");
    expect(next.items.map(item => item.track.id)).toEqual(["wyy_100"]);
    expect(boundary.unexpected).toEqual([]);
  });

  it("expires local account cache at thirty minutes despite a longer valid upstream expiry and never falls back", async () => {
    const daily = await import("@/lib/daily-recommend");
    boundary.dailyExpiresAt = Date.now() + 60 * 60 * 1000;
    const first = await daily.generateDailyRecommend();
    expect(first.account?.expiresAt).toBe(1794214800000);
    vi.setSystemTime(new Date("2026-11-09T08:29:59.999Z"));
    expect(await daily.loadTodayResult()).toEqual(first);
    vi.setSystemTime(new Date("2026-11-09T08:30:00.000Z"));
    expect(await daily.loadTodayResult()).toBeNull();
    boundary.dailyError = "ACCOUNT_RATE_LIMIT: owned provider throttled";
    await expect(daily.generateDailyRecommend()).rejects.toMatchObject({ code: "RATE_LIMIT" });
    expect(boundary.unexpected).toEqual([]);
  });

  it("honors a shorter platform expiry instead of extending account cache to the local maximum", async () => {
    const daily = await import("@/lib/daily-recommend");
    boundary.dailyExpiresAt = Date.now() + 60_000;
    const first = await daily.generateDailyRecommend();
    vi.setSystemTime(new Date("2026-11-09T08:00:59.999Z"));
    expect(await daily.loadTodayResult()).toEqual(first);
    vi.setSystemTime(new Date("2026-11-09T08:01:00.000Z"));
    expect(await daily.loadTodayResult()).toBeNull();
    boundary.dailyError = "ACCOUNT_NETWORK: owned unavailable upstream";
    await expect(daily.generateDailyRecommend()).rejects.toMatchObject({ code: "NETWORK" });
    expect(boundary.unexpected).toEqual([]);
  });

  it("a valid empty upstream batch stays empty with an explicit account notice and reusable account cache", async () => {
    const daily = await import("@/lib/daily-recommend");
    boundary.dailyItems = [];
    const result = await daily.generateDailyRecommend();
    expect(result.origin).toBe("account"); expect(result.items).toEqual([]);
    expect(result.notice).toBe("平台本次没有返回账号推荐歌曲，未使用应用算法补齐。");
    expect(result.coldStart).toBeUndefined(); expect(result.profileText).toBeUndefined();
    boundary.dailyError = "ACCOUNT_NETWORK: owned unavailable upstream";
    expect(await daily.loadTodayResult()).toEqual(result);
    expect(await daily.generateDailyRecommend()).toEqual(result);
    expect(boundary.unexpected).toEqual([]);
  });

  it("clearing the selected account source preserves another source's account cache and application history", async () => {
    const daily = await import("@/lib/daily-recommend");
    const auth = await import("@/lib/source-auth");
    const { useRecommendationSourceStore } = await import("@/stores/recommendation-source");
    const first = await daily.generateDailyRecommend();
    await auth.saveSourceAuthAccount("kg", SYNTHETIC_CREDENTIAL, { ...USER, id: "84", nickname: "Other account" });
    await useRecommendationSourceStore.getState().setSelection("daily", { origin: "account", sourceId: "kg" });
    boundary.dailySource = "kg"; boundary.dailyAccount = "84"; boundary.dailyItems = [
      { id: "kg_77", musicId: "77", name: "Other account song", singer: "Fixture", album: "", picUrl: "", interval: 180 },
    ];
    const other = await daily.generateDailyRecommend();
    expect(other.items.map(item => [item.track.platform, item.track.id])).toEqual([["kg", "kg_77"]]);
    await daily.clearTodayResult();
    expect(await daily.loadTodayResult()).toBeNull();
    await useRecommendationSourceStore.getState().setSelection("daily", { origin: "account", sourceId: "wyy" });
    boundary.dailyError = "ACCOUNT_NETWORK: owned unavailable upstream";
    expect(await daily.loadTodayResult()).toEqual(first);
    expect(boundary.settings.get(DAILY_RECOMMEND_CACHE_KEY)).toBe("owned-app-history-must-stay-unchanged");
    expect(boundary.unexpected).toEqual([]);
  });

  it("app callers may revoke their page epoch from progress before any preference/history/search work", async () => {
    const daily = await import("@/lib/daily-recommend");
    const { useRecommendationSourceStore } = await import("@/stores/recommendation-source");
    await useRecommendationSourceStore.getState().load();
    await useRecommendationSourceStore.getState().setSelection("daily", { origin: "app", sourceId: "" });
    boundary.allowAppCache = true;
    let current = true;
    await expect(daily.generateDailyRecommend({ force: true, mode: "rule", taste: "heart", isCurrent: () => current,
      onProgress: () => { current = false; } })).rejects.toMatchObject({ code: "STALE_CONTEXT" });
    expect(boundary.unexpected).toEqual([]);
    expect(boundary.settings.get(DAILY_RECOMMEND_CACHE_KEY)).toBe("owned-app-history-must-stay-unchanged");
  });

  it("an app cache read cannot publish its result after the optional caller epoch is revoked", async () => {
    const daily = await import("@/lib/daily-recommend");
    const { useRecommendationSourceStore } = await import("@/stores/recommendation-source");
    await useRecommendationSourceStore.getState().load();
    await useRecommendationSourceStore.getState().setSelection("daily", { origin: "app", sourceId: "" });
    boundary.allowAppCache = true;
    boundary.settings.set(DAILY_RECOMMEND_CACHE_KEY, JSON.stringify({ v: daily.DAILY_RULE_VERSION, days: [], today: {
      date: "2026-11-09", mode: "rule", requested: "rule", taste: "heart", generatedAt: Date.now(),
      title: "Owned app cache", summary: "Owned fixture", items: [{ reason: "Owned fixture", track: {
        id: "wyy_900", musicId: "900", platform: "wyy", title: "Owned fixture", singer: "Fixture", album: "", picUrl: "", duration: 200,
      } }],
    } }));
    const entered = deferred<void>(); const held = deferred<void>();
    boundary.cacheRead = async () => { boundary.cacheRead = null; entered.resolve(); await held.promise; };
    let current = true;
    const pending = daily.generateDailyRecommend({ mode: "rule", taste: "heart", isCurrent: () => current })
      .then(value => ({ value }), error => ({ error }));
    await entered.promise; current = false; held.resolve();
    expect(await pending).toMatchObject({ error: { code: "STALE_CONTEXT" } });
    expect(boundary.unexpected).toEqual([]);
  });

  it("a selection changed from initial account progress cannot adopt the newly selected source inside the old request", async () => {
    const daily = await import("@/lib/daily-recommend");
    const auth = await import("@/lib/source-auth");
    const { useRecommendationSourceStore } = await import("@/stores/recommendation-source");
    await useRecommendationSourceStore.getState().load();
    await auth.saveSourceAuthAccount("kg", SYNTHETIC_CREDENTIAL, { ...USER, id: "84", nickname: "Other account" });
    boundary.dailySource = "kg"; boundary.dailyAccount = "84"; boundary.dailyItems = [
      { id: "kg_77", musicId: "77", name: "Other account song", singer: "Fixture", album: "", picUrl: "", interval: 180 },
    ];
    let switched: Promise<void> | undefined;
    await expect(daily.generateDailyRecommend({ force: true, onProgress: () => {
      switched ??= useRecommendationSourceStore.getState().setSelection("daily", { origin: "account", sourceId: "kg" });
    } })).rejects.toMatchObject({ code: "STALE_CONTEXT" });
    await switched;
    expect(boundary.settings.get(ACCOUNT_DAILY_CACHE_KEY)).toBeUndefined();
    expect(boundary.unexpected).toEqual([]);
  });

  it("a cache Native error is an explicit safe account error, not raw credentials or an application fallback", async () => {
    const daily = await import("@/lib/daily-recommend");
    boundary.cacheRead = async () => { throw new Error(`owned storage rejected ${SYNTHETIC_CREDENTIAL}`); };
    const error = await daily.generateDailyRecommend().catch(error => error);
    expect(error).toMatchObject({ code: "UPSTREAM" });
    expect(String(error)).not.toContain(SYNTHETIC_CREDENTIAL);
    expect(boundary.settings.get(DAILY_RECOMMEND_CACHE_KEY)).toBe("owned-app-history-must-stay-unchanged");
    expect(boundary.unexpected).toEqual([]);
  });

  it("bounds its own index to twelve pack namespaces and evicts expired records before a fresh write", async () => {
    const daily = await import("@/lib/daily-recommend");
    let latest;
    for (let index = 0; index < 14; index++) {
      boundary.meta = { id: "owned-meta", code: 1, revision: String(18 + index) };
      publish("source-engine-status", { phase: "ready", meta: boundary.meta });
      latest = await daily.generateDailyRecommend({ force: true });
    }
    const bounded = JSON.parse(boundary.settings.get(ACCOUNT_DAILY_CACHE_KEY)!);
    expect(bounded.records).toHaveLength(12);
    expect(new Set(bounded.records.map((record: { packVersion: string }) => record.packVersion)).size).toBe(12);
    expect(await daily.loadTodayResult()).toEqual(latest);
    vi.setSystemTime(new Date("2026-11-09T08:31:00.000Z"));
    await daily.generateDailyRecommend({ force: true });
    expect(JSON.parse(boundary.settings.get(ACCOUNT_DAILY_CACHE_KEY)!).records).toHaveLength(1);
    expect(boundary.settings.get(ACCOUNT_DAILY_CACHE_KEY)).not.toContain(SYNTHETIC_CREDENTIAL);
    expect(boundary.unexpected).toEqual([]);
  });

  it("whitelists parsed cache entries and never re-persists unknown credentials even in another retained pack entry", async () => {
    const daily = await import("@/lib/daily-recommend");
    const first = await daily.generateDailyRecommend();
    const untrusted = JSON.parse(boundary.settings.get(ACCOUNT_DAILY_CACHE_KEY)!);
    untrusted.cookie = SYNTHETIC_CREDENTIAL;
    untrusted.records[0].auth = { cookie: SYNTHETIC_CREDENTIAL };
    untrusted.records[0].tracks[0].unknown = { token: SYNTHETIC_CREDENTIAL };
    untrusted.records[0].tracks[0].reason = SYNTHETIC_CREDENTIAL;
    boundary.settings.set(ACCOUNT_DAILY_CACHE_KEY, JSON.stringify(untrusted));
    expect(await daily.loadTodayResult()).toEqual(first);
    boundary.meta = { id: "owned-meta", code: 1, revision: "19" };
    publish("source-engine-status", { phase: "ready", meta: boundary.meta });
    await daily.generateDailyRecommend({ force: true });
    const safe = boundary.settings.get(ACCOUNT_DAILY_CACHE_KEY)!;
    expect(JSON.parse(safe).records).toHaveLength(2);
    expect(safe).not.toContain(SYNTHETIC_CREDENTIAL);
    expect(safe).not.toContain('"unknown"'); expect(safe).not.toContain('"reason"');
    expect(boundary.unexpected).toEqual([]);
  });

  it.each(["syntax", "schema", "track", "optional"])("an invalid %s cache is a miss followed by authenticated live fetch, never a shortened/stale/app batch", async kind => {
    const daily = await import("@/lib/daily-recommend");
    await daily.generateDailyRecommend();
    const raw = JSON.parse(boundary.settings.get(ACCOUNT_DAILY_CACHE_KEY)!);
    if (kind === "schema") raw.v = 999;
    if (kind === "track") raw.records[0].tracks[0].duration = "invalid duration";
    if (kind === "optional") { raw.records[0].tracks[0].version = null; raw.records[0].tracks[0].isrc = null; }
    boundary.settings.set(ACCOUNT_DAILY_CACHE_KEY, kind === "syntax" ? "{broken-owned-json" : JSON.stringify(raw));
    expect(await daily.loadTodayResult()).toBeNull();
    boundary.dailyError = "ACCOUNT_AUTH_EXPIRED: owned expired session";
    await expect(daily.generateDailyRecommend()).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(boundary.settings.get(DAILY_RECOMMEND_CACHE_KEY)).toBe("owned-app-history-must-stay-unchanged");
    expect(boundary.unexpected).toEqual([]);
  });

  it("auth revoked during a Native cache read discards that disk result and disabled metadata cannot serve a valid cache", async () => {
    const daily = await import("@/lib/daily-recommend");
    const auth = await import("@/lib/source-auth");
    await daily.generateDailyRecommend();
    const entered = deferred<void>(); const held = deferred<void>();
    boundary.cacheRead = async () => { boundary.cacheRead = null; entered.resolve(); await held.promise; };
    const pending = daily.loadTodayResult().then(value => ({ value }), error => ({ error }));
    await entered.promise;
    await auth.setSourceAuthToggle("wyy", "meta", false);
    held.resolve();
    expect(await pending).toMatchObject({ error: { code: "STALE_CONTEXT" } });
    await expect(daily.loadTodayResult()).rejects.toMatchObject({ code: "META_DISABLED" });
    await expect(daily.generateDailyRecommend()).rejects.toMatchObject({ code: "META_DISABLED" });
    expect(boundary.unexpected).toEqual([]);
  });

  it("auth revoked before Native write ACK retires only that stale batch even after metadata is enabled again", async () => {
    const daily = await import("@/lib/daily-recommend");
    const auth = await import("@/lib/source-auth");
    const entered = deferred<void>(); const held = deferred<void>();
    boundary.cacheWrite = async () => { boundary.cacheWrite = null; entered.resolve(); await held.promise; };
    const pending = daily.generateDailyRecommend({ force: true }).then(value => ({ value }), error => ({ error }));
    await entered.promise;
    await auth.setSourceAuthToggle("wyy", "meta", false);
    held.resolve();
    expect(await pending).toMatchObject({ error: { code: "STALE_CONTEXT" } });
    await auth.setSourceAuthToggle("wyy", "meta", true);
    expect(await daily.loadTodayResult()).toBeNull();
    expect(boundary.settings.get(DAILY_RECOMMEND_CACHE_KEY)).toBe("owned-app-history-must-stay-unchanged");
    expect(boundary.unexpected).toEqual([]);
  });

  it("serialized stale-ACK retirement preserves an earlier pack entry and the newer queued same-account write", async () => {
    const daily = await import("@/lib/daily-recommend");
    await daily.generateDailyRecommend();
    boundary.meta = { id: "owned-meta", code: 1, revision: "19" };
    publish("source-engine-status", { phase: "ready", meta: boundary.meta });
    const writeEntered = deferred<void>(); const held = deferred<void>();
    boundary.cacheWrite = async () => { boundary.cacheWrite = null; writeEntered.resolve(); await held.promise; };
    const old = daily.generateDailyRecommend({ force: true }).then(value => ({ value }), error => ({ error }));
    await writeEntered.promise;
    boundary.dailyItems = UPSTREAM.slice(1);
    const fetchEntered = deferred<void>(); boundary.dailyEntered = () => fetchEntered.resolve();
    const newer = daily.generateDailyRecommend({ force: true });
    await fetchEntered.promise; held.resolve();
    expect(await old).toMatchObject({ error: { code: "STALE_CONTEXT" } });
    const current = await newer;
    expect(current.items.map(item => item.track.id)).toEqual(["wyy_100"]);
    expect(await daily.loadTodayResult()).toEqual(current);
    const records = JSON.parse(boundary.settings.get(ACCOUNT_DAILY_CACHE_KEY)!).records;
    expect(records).toHaveLength(2);
    expect(records.map((record: { packVersion: string }) => record.packVersion)).toEqual(["owned-meta@1:19", "owned-meta@1:18"]);
    expect(boundary.unexpected).toEqual([]);
  });

  it.each(["selection", "auth", "pack"])("an in-flight account response is rejected after %s revocation without saving or an app fallback", async kind => {
    const daily = await import("@/lib/daily-recommend");
    const auth = await import("@/lib/source-auth");
    const { useRecommendationSourceStore } = await import("@/stores/recommendation-source");
    const entered = deferred<void>(); const held = deferred<void>();
    boundary.dailyEntered = () => entered.resolve(); boundary.dailyWait = held.promise;
    const pending = daily.generateDailyRecommend({ force: true }).then(value => ({ value }), error => ({ error }));
    await entered.promise;
    if (kind === "selection") await useRecommendationSourceStore.getState().setSelection("daily", { origin: "app", sourceId: "" });
    if (kind === "auth") await auth.setSourceAuthToggle("wyy", "meta", false);
    if (kind === "pack") {
      boundary.meta = { id: "owned-meta", code: 1, revision: "19" };
      publish("source-engine-status", { phase: "ready", meta: boundary.meta });
    }
    held.resolve();
    expect(await pending).toMatchObject({ error: { code: kind === "auth" ? expect.stringMatching(/^(STALE_CONTEXT|AUTH_CHANGED)$/) : "STALE_CONTEXT" } });
    expect(boundary.settings.get(ACCOUNT_DAILY_CACHE_KEY)).toBeUndefined();
    expect(boundary.settings.get(DAILY_RECOMMEND_CACHE_KEY)).toBe("owned-app-history-must-stay-unchanged");
    expect(boundary.unexpected).toEqual([]);
  });

  it("a revoked caller cannot publish a cached account batch but does not delete a previously valid committed cache", async () => {
    const daily = await import("@/lib/daily-recommend");
    const first = await daily.generateDailyRecommend();
    const entered = deferred<void>(); const held = deferred<void>(); let current = true;
    boundary.cacheRead = async () => { boundary.cacheRead = null; entered.resolve(); await held.promise; };
    const pending = daily.generateDailyRecommend({ isCurrent: () => current }).then(value => ({ value }), error => ({ error }));
    await entered.promise; current = false; held.resolve();
    expect(await pending).toMatchObject({ error: { code: "STALE_CONTEXT" } });
    expect(await daily.loadTodayResult()).toEqual(first);
    expect(boundary.unexpected).toEqual([]);
  });
});
