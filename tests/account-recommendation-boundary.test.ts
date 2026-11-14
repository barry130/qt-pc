import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type EngineRequest = { requestId: number; kind: string; entry?: string; args?: Record<string, unknown> };
type EventListener = (event: { payload: unknown }) => void;
const boundary = vi.hoisted(() => ({
  listeners: new Map<string, Set<EventListener>>(),
  expectedEntry: "accountDailySongs",
  expectedArgs: { source: "wyy", accountId: "42" } as Record<string, unknown>,
  reply: {} as Record<string, unknown>,
  error: null as string | null,
  resultText: null as string | null,
  status: {} as Record<string, unknown>,
  requests: [] as EngineRequest[],
  noReply: false,
  transportError: false,
  hangEmit: false,
  listenCalls: 0,
  waitListenAt: 0,
  finishListen: null as (() => void) | null,
  onInvoke: null as ((request: EngineRequest) => void) | null,
  envelope: null as Record<string, unknown> | null,
  logs: [] as unknown[],
}));

// Agreed seam: real public account facades and engine client. Only the separate
// native/event transport is owned; no source/helper/auth/player business mock.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    if (command === "write_log") { boundary.logs.push(args); return; }
    throw new Error(`Unexpected owned native command: ${command}`);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, listener: EventListener) => {
    const listeners = boundary.listeners.get(event) ?? new Set<EventListener>();
    boundary.listeners.set(event, listeners); listeners.add(listener);
    boundary.listenCalls++;
    if (boundary.waitListenAt === boundary.listenCalls) await new Promise<void>(resolve => { boundary.finishListen = resolve; });
    return () => { listeners.delete(listener); };
  },
  emit: async () => undefined,
  emitTo: async (target: string, event: string, request: EngineRequest) => {
    const publish = (reply: Record<string, unknown>) => {
      for (const listener of boundary.listeners.get("source-engine-response") ?? []) {
        listener({ payload: { requestId: request.requestId, ...reply } });
      }
    };
    if (target !== "source-engine" || event !== "source-engine-request") {
      publish({ error: "OWNED_RPC_ROUTING_REJECTED" }); return;
    }
    boundary.requests.push(request);
    if (request.kind === "status") { publish(boundary.status); return; }
    const args = request.args ?? {};
    if (request.kind !== "invoke" || request.entry !== boundary.expectedEntry ||
      Object.keys(args).length !== Object.keys(boundary.expectedArgs).length ||
      Object.entries(boundary.expectedArgs).some(([key, value]) => args[key] !== value)) {
      publish({ error: "OWNED_RPC_ROUTING_REJECTED" }); return;
    }
    boundary.onInvoke?.(request);
    if (boundary.transportError) throw new Error("SYNTHETIC_TRANSPORT_DO_NOT_ECHO");
    if (boundary.hangEmit) return new Promise<void>(() => undefined);
    if (boundary.noReply) return;
    publish(boundary.envelope ?? (boundary.error === null ? { result: boundary.resultText ?? JSON.stringify(boundary.reply) } : { error: boundary.error }));
  },
}));

const song = { id: "opaque/id:900", name: "Upstream song", singer: "A", album: "", picUrl: "", interval: 201.5 };
const fetchedAt = 1_794_204_000_000;
let sources: typeof import("@/source-scripts");
beforeEach(async () => {
  vi.resetModules(); boundary.listeners.clear(); boundary.logs.length = 0;
  boundary.expectedEntry = "accountDailySongs"; boundary.expectedArgs = { source: "wyy", accountId: "42" };
  boundary.error = null; boundary.resultText = null; boundary.envelope = null;
  boundary.status = { phase: "ready", code: 1, detail: null, pack: null };
  boundary.requests.length = 0; boundary.noReply = false; boundary.transportError = false; boundary.hangEmit = false; boundary.onInvoke = null;
  boundary.listenCalls = 0; boundary.waitListenAt = 0; boundary.finishListen = null;
  boundary.reply = { source: "wyy", kind: "daily", accountId: "42", items: [{ ...song }], fetchedAt };
  vi.stubGlobal("window", Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
  vi.stubGlobal("fetch", () => { throw new Error("Live HTTP is forbidden in owned account facade fixtures"); });
  sources = await import("@/source-scripts");
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("account recommendation public RPC boundary", () => {
  // Additional regressions for already GREEN validators/transport, not new RED→GREEN claims.
  it.each(["[]", '"raw text"', "123", "true", "{"])("rejects other non-contract RPC JSON: %s", async raw => {
    boundary.resultText = raw;
    await expect(sources.accountDailySongs("wyy", "42")).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it.each([
    ["id", undefined], ["name", undefined], ["singer", undefined], ["album", undefined], ["picUrl", undefined], ["interval", undefined],
    ["id", 17], ["name", []], ["singer", {}], ["album", null], ["picUrl", false],
    ["interval", "201.5"], ["interval", null], ["interval", -1],
    ["musicId", 17], ["version", false], ["isrc", null], ["durationReliable", "true"],
  ])("rejects a non-contract song field %s=%j", async (field, value) => {
    boundary.reply.items = [{ ...song, [field as string]: value }];
    await expect(sources.accountDailySongs("wyy", "42")).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it.each([
    ["kind", "fm"], ["items", {}], ["items", null], ["items", [null]], ["accountId", 17],
    ["fetchedAt", 0], ["fetchedAt", -1], ["fetchedAt", "1794204000000"], ["fetchedAt", undefined], ["fetchedAt", null], ["fetchedAt", Number.MAX_SAFE_INTEGER + 1],
    ["expiresAt", 0], ["expiresAt", -1], ["expiresAt", 1.5], ["expiresAt", "1794204000000"], ["expiresAt", null],
    ["cursor", 17], ["exhausted", 0],
  ])("rejects non-contract batch metadata %s=%j", async (field, value) => {
    boundary.reply[field as string] = value;
    await expect(sources.accountDailySongs("wyy", "42")).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it.each([
    ["source", 17], ["source", {}], ["source", null], ["source", undefined], ["source", ""], ["source", "  "],
    ["accountId", 17], ["accountId", {}], ["accountId", null], ["accountId", undefined], ["accountId", ""], ["accountId", "  "],
  ])("rejects non-string/empty identity %s=%j without any RPC", async (field, value) => {
    const args: Record<string, unknown> = { source: "wyy", accountId: "42", [field as string]: value };
    await expect(sources.accountDailySongs(args.source as string, args.accountId as string)).rejects.toMatchObject({ code: "INVALID_ARGS" });
    expect(boundary.requests).toEqual([]);
  });

  it.each(["AUTH_REQUIRED", "AUTH_EXPIRED", "ACCOUNT_MISMATCH", "AUTH_CHANGED", "NETWORK", "RATE_LIMIT", "UNSUPPORTED", "MALFORMED_RESPONSE", "INVALID_ARGS", "ENGINE_UNAVAILABLE"])(
    "preserves known safe %s while dropping all raw error extensions", async code => {
      boundary.error = `ACCOUNT_RECOMMENDATIONS_${code}: SYNTHETIC_ERROR_DO_NOT_ECHO`;
      const error: unknown = await sources.accountDailySongs("wyy", "42").catch(value => value);
      expect(error).toMatchObject({ name: "AccountRecommendationError", code });
      expect(error).not.toHaveProperty("cause");
      expect([String(error), error instanceof Error ? error.stack : "", JSON.stringify(error), JSON.stringify(boundary.logs)].join(" ")).not.toContain("SYNTHETIC_ERROR_DO_NOT_ECHO");
    },
  );

  it("allows genuine empty daily batches without inventing cursor, expiry or exhaustion", async () => {
    boundary.reply.items = [];
    expect(await sources.accountDailySongs("wyy", "42")).toEqual({ source: "wyy", kind: "daily", accountId: "42", items: [], fetchedAt: 1_794_204_000_000 });
  });

  it("accepts arbitrary nonempty identities, empty FM cursor and legitimate large finite values", async () => {
    boundary.expectedEntry = "accountFmNext";
    boundary.expectedArgs = { source: "custom /源#opaque", accountId: "00042", cursor: "" };
    boundary.reply = { source: "custom /源#opaque", kind: "fm", accountId: "00042", fetchedAt: 1, cursor: "", items: [{ ...song, interval: 86_400_000 }] };
    const batch = await sources.accountFmNext("custom /源#opaque", "00042", "");
    expect(batch).toEqual({ source: "custom /源#opaque", kind: "fm", accountId: "00042", fetchedAt: 1, cursor: "", items: [{ id: "opaque/id:900", name: "Upstream song", singer: "A", album: "", picUrl: "", interval: 86_400_000 }] });
  });

  it("rejects a JSON numeric overflow duration rather than forwarding Infinity", async () => {
    boundary.resultText = JSON.stringify(boundary.reply).replace('"interval":201.5', '"interval":1e999');
    await expect(sources.accountDailySongs("wyy", "42")).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it("does not treat unknown error codes as a new capability or rate limit", async () => {
    boundary.error = "ACCOUNT_RECOMMENDATIONS_UNKNOWN_CODE: SYNTHETIC_ERROR_DO_NOT_ECHO";
    await expect(sources.accountDailySongs("wyy", "42")).rejects.toMatchObject({ code: "UPSTREAM", message: "平台暂时无法提供账号推荐，请稍后重试。" });
  });

  it("keeps native emit failures static and makes no second account request", async () => {
    boundary.transportError = true;
    const error: unknown = await sources.accountDailySongs("wyy", "42").catch(value => value);
    expect(error).toMatchObject({ name: "AccountRecommendationError", code: "ENGINE_UNAVAILABLE" });
    expect(error).not.toHaveProperty("cause");
    expect([String(error), JSON.stringify(boundary.logs)].join(" ")).not.toContain("SYNTHETIC_TRANSPORT_");
    expect(boundary.requests.filter(request => request.kind === "invoke")).toHaveLength(1);
    expect(boundary.listeners.get("source-engine-response")?.size).toBe(1);
  });

  it("keeps raw engine lifecycle detail private when no engine is ready", async () => {
    boundary.status = { phase: "error", code: null, detail: "SYNTHETIC_LIFECYCLE_DO_NOT_ECHO", pack: null };
    const error: unknown = await sources.accountDailySongs("wyy", "42").catch(value => value);
    expect(error).toMatchObject({ name: "AccountRecommendationError", code: "ENGINE_UNAVAILABLE" });
    expect([String(error), JSON.stringify(boundary.logs)].join(" ")).not.toContain("SYNTHETIC_LIFECYCLE_DO_NOT_ECHO");
    expect(boundary.requests.filter(request => request.kind === "invoke")).toHaveLength(0);
  });

  it("bounds readiness whose native listener ACK arrives late without starting an abandoned account request", async () => {
    vi.useFakeTimers(); boundary.waitListenAt = 1; // The frozen client owns this preflight listener.
    let outcome: unknown;
    void sources.accountDailySongs("wyy", "42").catch((error: unknown) => { outcome = error; });
    await vi.advanceTimersByTimeAsync(20_001);
    try {
      expect(outcome).toMatchObject({ code: "ENGINE_UNAVAILABLE" });
      expect(boundary.requests.filter(request => request.kind === "invoke")).toHaveLength(0);
    } finally {
      boundary.finishListen?.(); await vi.advanceTimersByTimeAsync(0);
    }
    expect(boundary.requests.filter(request => request.kind === "invoke")).toHaveLength(0);
    expect(boundary.listeners.get("source-engine-response")?.size).toBe(1);
  });

  it("settles a matching account reply without waiting for the native emission ACK", async () => {
    vi.useFakeTimers(); boundary.hangEmit = true;
    boundary.onInvoke = request => {
      for (const listener of boundary.listeners.get("source-engine-response") ?? []) {
        listener({ payload: { requestId: request.requestId, result: JSON.stringify(boundary.reply) } });
      }
    };
    await expect(sources.accountDailySongs("wyy", "42")).resolves.toMatchObject({ items: [song], fetchedAt });
    expect(boundary.requests.filter(request => request.kind === "invoke")).toHaveLength(1);
    expect(boundary.listeners.get("source-engine-response")?.size).toBe(1); expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a pending account listener bind and immediately releases its late native ACK", async () => {
    vi.useFakeTimers(); boundary.waitListenAt = 2; // Keep the real client listener; delay only the private account bind.
    let outcome: unknown;
    void sources.accountDailySongs("wyy", "42").catch((error: unknown) => { outcome = error; });
    await vi.advanceTimersByTimeAsync(20_001);
    try {
      expect(outcome).toMatchObject({ code: "ENGINE_UNAVAILABLE" });
      expect(boundary.requests.filter(request => request.kind === "invoke")).toHaveLength(0);
    } finally {
      boundary.finishListen?.(); await vi.advanceTimersByTimeAsync(0);
    }
    expect(boundary.requests.filter(request => request.kind === "invoke")).toHaveLength(0);
    expect(boundary.listeners.get("source-engine-response")?.size).toBe(1);
  });

  it("times out an unacknowledged native emit without waiting forever or retaining its listener", async () => {
    vi.useFakeTimers(); boundary.hangEmit = true;
    let outcome: unknown;
    void sources.accountDailySongs("wyy", "42").catch((error: unknown) => { outcome = error; });
    await vi.advanceTimersByTimeAsync(20_001);
    expect(outcome).toMatchObject({ name: "AccountRecommendationError", code: "ENGINE_UNAVAILABLE" });
    expect(boundary.requests.filter(request => request.kind === "invoke")).toHaveLength(1);
    expect(boundary.listeners.get("source-engine-response")?.size).toBe(1);
  });

  it("distinguishes an actual account RPC timeout and releases its listener without retry", async () => {
    vi.useFakeTimers(); boundary.noReply = true;
    const error = sources.accountDailySongs("wyy", "42").catch((value: unknown) => value);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(await error).toMatchObject({ name: "AccountRecommendationError", code: "ENGINE_UNAVAILABLE" });
    expect(boundary.requests.filter(request => request.kind === "invoke")).toHaveLength(1);
    expect(boundary.listeners.get("source-engine-response")?.size).toBe(1);
  });

  it("correlates concurrent reversed replies using owned negative IDs and releases only its listeners", async () => {
    boundary.noReply = true;
    let bothSent!: () => void;
    const sent = new Promise<void>(resolve => { bothSent = resolve; });
    boundary.onInvoke = () => { if (boundary.requests.filter(request => request.kind === "invoke").length === 2) bothSent(); };
    const first = sources.accountDailySongs("wyy", "42"); const second = sources.accountDailySongs("wyy", "42");
    await sent;
    const [firstRequest, secondRequest] = boundary.requests.filter(request => request.kind === "invoke");
    expect(firstRequest.requestId).toBeLessThan(0); expect(secondRequest.requestId).toBeLessThan(0);
    expect(firstRequest.requestId).not.toBe(secondRequest.requestId);
    for (const [request, id] of [[secondRequest, "second"], [firstRequest, "first"]] as const) {
      for (const listener of boundary.listeners.get("source-engine-response") ?? []) {
        listener({ payload: { requestId: request.requestId, result: JSON.stringify({ ...boundary.reply, items: [{ ...song, id }] }) } });
      }
    }
    expect((await first).items.map(item => item.id)).toEqual(["first"]);
    expect((await second).items.map(item => item.id)).toEqual(["second"]);
    expect(boundary.listeners.get("source-engine-response")?.size).toBe(1);
  });

  it("rejects a malformed error envelope without exposing its object", async () => {
    boundary.envelope = { error: { Cookie: "SYNTHETIC_ERROR_OBJECT_DO_NOT_ECHO" }, result: JSON.stringify(boundary.reply) };
    const error: unknown = await sources.accountDailySongs("wyy", "42").catch(value => value);
    expect(error).toMatchObject({ code: "MALFORMED_RESPONSE" });
    expect(String(error)).not.toContain("SYNTHETIC_ERROR_OBJECT_DO_NOT_ECHO");
  });

  it.each([
    ["入口不存在: accountDailySongs SYNTHETIC_ERROR_DO_NOT_ECHO", "UNSUPPORTED"],
    ["未安装数据包，数据接口不可用（首页可安装）: accountDailySongs", "ENGINE_UNAVAILABLE"],
    ["ACCOUNT_CHANGED: SYNTHETIC_ERROR_DO_NOT_ECHO", "ACCOUNT_MISMATCH"],
  ])("classifies existing worker/legacy boundary error %s without raw text", async (message, code) => {
    boundary.error = message;
    const error: unknown = await sources.accountDailySongs("wyy", "42").catch(value => value);
    expect(error).toMatchObject({ code }); expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toContain("SYNTHETIC_ERROR_DO_NOT_ECHO");
  });

  it("classifies a null batch returned by a ready engine as malformed rather than unavailable", async () => {
    boundary.resultText = "null";
    await expect(sources.accountDailySongs("wyy", "42")).rejects.toMatchObject({
      name: "AccountRecommendationError", code: "MALFORMED_RESPONSE",
    });
  });

  it("rejects a non-string optional FM cursor as invalid args before using a batch", async () => {
    boundary.expectedEntry = "accountFmNext"; boundary.reply.kind = "fm";
    boundary.expectedArgs = { source: "wyy", accountId: "42", cursor: 17 };
    await expect(sources.accountFmNext("wyy", "42", 17 as unknown as string)).rejects.toMatchObject({
      name: "AccountRecommendationError", code: "INVALID_ARGS",
    });
  });

  it("never exposes or logs malicious engine error text or preserves its raw cause", async () => {
    boundary.expectedEntry = "accountFmNext"; boundary.reply.kind = "fm";
    boundary.error = "SYNTHETIC Cookie=DO_NOT_ECHO headers.token=DO_NOT_ECHO https://synthetic.test/private?token=DO_NOT_ECHO raw upstream body";
    const sinks = ["debug", "info", "warn", "error"] as const;
    const consoleSpies = sinks.map(level => vi.spyOn(console, level).mockImplementation(() => undefined));
    const error: unknown = await sources.accountFmNext("wyy", "42").catch(value => value);
    expect(error).toMatchObject({
      name: "AccountRecommendationError", code: "UPSTREAM", message: "平台暂时无法提供账号推荐，请稍后重试。",
    });
    expect(error).not.toHaveProperty("cause");
    expect([String(error), error instanceof Error ? error.stack : "", JSON.stringify(error),
      JSON.stringify(boundary.logs), ...consoleSpies.map(spy => JSON.stringify(spy.mock.calls))].join(" ")).not.toContain("DO_NOT_ECHO");
  });

  it("returns only whitelisted fields while preserving opaque IDs, duplicates, order and FM state", async () => {
    boundary.expectedEntry = "accountFmNext";
    boundary.expectedArgs = { source: "wyy", accountId: "42", cursor: "  opaque /previous+==  " };
    boundary.reply = {
      source: "wyy", kind: "fm", accountId: "42", fetchedAt, expiresAt: fetchedAt - 1,
      cursor: "  opaque /next+==  ", exhausted: false,
      Cookie: "SYNTHETIC_COOKIE_DO_NOT_FORWARD", token: "SYNTHETIC_TOKEN_DO_NOT_FORWARD",
      account: { headers: { Cookie: "SYNTHETIC_COOKIE_DO_NOT_FORWARD" } },
      request: { url: "https://synthetic.test/private", headers: {} }, cause: { body: "raw" },
      items: [
        { ...song, musicId: null, version: "Live", isrc: "", durationReliable: false, Cookie: "SYNTHETIC_COOKIE_DO_NOT_FORWARD" },
        { id: "原始 /0", name: "", singer: "", album: "", picUrl: "", interval: 0, musicId: "", token: "SYNTHETIC_TOKEN_DO_NOT_FORWARD" },
        { ...song, musicId: null, version: "Live", isrc: "", durationReliable: false, headers: { Cookie: "SYNTHETIC_COOKIE_DO_NOT_FORWARD" } },
      ],
    };
    expect(await sources.accountFmNext("wyy", "42", "  opaque /previous+==  ")).toEqual({
      source: "wyy", kind: "fm", accountId: "42", fetchedAt: 1_794_204_000_000, expiresAt: 1_794_203_999_999,
      cursor: "  opaque /next+==  ", exhausted: false,
      items: [
        { id: "opaque/id:900", name: "Upstream song", singer: "A", album: "", picUrl: "", interval: 201.5, musicId: null, version: "Live", isrc: "", durationReliable: false },
        { id: "原始 /0", name: "", singer: "", album: "", picUrl: "", interval: 0, musicId: "" },
        { id: "opaque/id:900", name: "Upstream song", singer: "A", album: "", picUrl: "", interval: 201.5, musicId: null, version: "Live", isrc: "", durationReliable: false },
      ],
    });
  });

  it("rejects a foreign source batch with a static malformed response error", async () => {
    boundary.reply.source = "kg";
    await expect(sources.accountDailySongs("wyy", "42")).rejects.toMatchObject({
      name: "AccountRecommendationError", code: "MALFORMED_RESPONSE",
    });
  });

  it("rejects invalid FM batch timestamps instead of accepting unsafe cache clocks", async () => {
    boundary.expectedEntry = "accountFmNext";
    boundary.reply.kind = "fm"; boundary.reply.fetchedAt = 1.5;
    await expect(sources.accountFmNext("wyy", "42")).rejects.toMatchObject({
      name: "AccountRecommendationError", code: "MALFORMED_RESPONSE",
    });
  });

  it("rejects malformed songs rather than allowing object values into app tracks", async () => {
    boundary.reply.items = [{ ...song, name: { text: "not a contract string" } }];
    await expect(sources.accountDailySongs("wyy", "42")).rejects.toMatchObject({
      name: "AccountRecommendationError", code: "MALFORMED_RESPONSE",
      message: "平台账号推荐应答格式无效，未使用应用算法替补。",
    });
  });
});
