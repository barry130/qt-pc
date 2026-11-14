// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { ACCOUNT_DAILY_CACHE_KEY, RECOMMENDATION_SOURCE_KEY, SOURCE_AUTH_ACCOUNTS_KEY, SOURCE_AUTH_TOGGLES_KEY } from "@/lib/storageKeys";

// Only browser/native IO and the separate source-engine RPC transport are fixtures.
// DailyRecommendPage, controls, provider/auth, registry, generator, cache and player remain real.
const boundary = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  listeners: new Map<string, Array<(event: { payload: unknown }) => void>>(),
  commands: [] as Array<{ command: string; args: Record<string, unknown> }>,
  requests: [] as Array<Record<string, unknown>>,
  pageWait: null as Promise<void> | null,
  metaAck: null as Promise<void> | null,
  phase: "ready" as "ready" | "booting" | "error",
  pack: null as Record<string, unknown> | null,
  pageError: "",
  pages: [] as Array<Record<string, unknown>>,
  ticket: 0,
  committed: new Set<number>(),
  abandoned: new Set<number>(),
  queueIds: [] as string[],
  playWait: null as Promise<void> | null,
}));
function publish(event: string, payload: unknown): void {
  for (const listener of boundary.listeners.get(event) ?? []) listener({ payload });
}
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    boundary.commands.push({ command, args });
    if (command === "get_setting") return boundary.settings.get(String(args.key)) ?? null;
    if (command === "set_setting") { boundary.settings.set(String(args.key), String(args.value)); return; }
    if (command === "clear_play_url_cache" || command === "play_url_cache_epoch") return 0;
    if (command === "begin_play_intent") return ++boundary.ticket;
    if (command === "abandon_play_intent") {
      const ticket = Number(args.playIntent);
      if (ticket === boundary.ticket && !boundary.committed.has(ticket)) boundary.abandoned.add(ticket);
      return;
    }
    if (command === "play_queue") {
      await boundary.playWait;
      const ticket = Number(args.playIntent);
      const applied = Number.isSafeInteger(ticket) && ticket > 0 && ticket === boundary.ticket &&
        !boundary.abandoned.has(ticket) && !boundary.committed.has(ticket);
      if (applied) { boundary.committed.add(ticket); boundary.queueIds = (args.tracks as Array<{ id: string }>).map(track => track.id); }
      return { applied, target: null, queueRevision: 7 };
    }
    if (command === "source_state") return { activeMetaId: "owned-meta", packs: [{ id: "owned-meta", kind: "meta", versionCode: 1 }] };
    if (command === "check_favorite_flags" || command === "check_disliked") return (args.tracks as unknown[]).map(() => false);
    if (command === "get_track_ratings") return {};
    if (command === "list_my_playlists") return [];
    throw new Error(`Unexpected owned daily native command: ${command}`);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, listener: (event: { payload: unknown }) => void) => {
    const listeners = boundary.listeners.get(name) ?? [];
    listeners.push(listener); boundary.listeners.set(name, listeners);
    return () => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); };
  },
  emit: async () => undefined,
  emitTo: async (_label: string, event: string, request: Record<string, unknown>) => {
    if (event !== "source-engine-request") throw new Error(`Unexpected owned daily event: ${event}`);
    boundary.requests.push(request);
    if (request.kind === "status") {
      publish("source-engine-response", { requestId: request.requestId, phase: boundary.phase, pack: boundary.pack, meta: { id: "owned-meta", code: 1, revision: "18" } });
      return;
    }
    if (request.kind === "resolve") { publish("source-engine-response", { requestId: request.requestId, url: "", line: null, error: "", stalled: false }); return; }
    if (request.kind !== "invoke") throw new Error(`Unexpected owned daily RPC: ${String(request.kind)}`);
    let result: Record<string, unknown>;
    if (request.entry === "sourceRegistry") result = { sources: [{ id: "wyy", name: "Owned source", short: "Owned", color: "fixture", accountRecommendations: { daily: true, fm: true } }], qualities: [] };
    else if (request.entry === "setAuth" || request.entry === "clearAuth") {
      if (request.entry === "setAuth" && (request.args as Record<string, unknown>)?.scope === "meta") await boundary.metaAck;
      result = { ok: true };
    }
    else if (request.entry === "getSourceQualities") result = { mode: "platform", qualities: [], aliases: {} };
    else if (request.entry === "accountDailySongs") {
      const planned = boundary.pages.shift() ?? dailyPage([]);
      const wait = boundary.pageWait;
      const error = boundary.pageError;
      await wait;
      if (error) { publish("source-engine-response", { requestId: request.requestId, error }); return; }
      result = planned;
    } else throw new Error(`Unexpected owned daily source entry: ${String(request.entry)}`);
    publish("source-engine-response", { requestId: request.requestId, result: JSON.stringify(result) });
  },
}));
vi.mock("@/lib/logger", () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

function dailyPage(ids: string[]): Record<string, unknown> {
  return { source: "wyy", kind: "daily", accountId: "42", fetchedAt: Date.now(), expiresAt: Date.now() + 600_000,
    items: ids.map(id => ({ id: `wyy_${id}`, musicId: id, name: `Owned ${id}`, singer: "Fixture", album: "", picUrl: "", interval: 180 })) };
}
async function renderDaily() {
  const { DailyRecommendPage } = await import("@/components/discovery/DailyRecommendPage");
  const { KeepAliveActiveContext } = await import("@/components/layout/keepAliveActive");
  function DailyFixtureRoot() {
    const [active, setActive] = useState(true);
    return <><button onClick={() => setActive(false)}>Hide daily</button><button onClick={() => setActive(true)}>Show daily</button>
      <KeepAliveActiveContext.Provider value={active}><div hidden={!active}><Outlet /></div></KeepAliveActiveContext.Provider></>;
  }
  const root = createRootRoute({ component: DailyFixtureRoot });
  const daily = createRoute({ getParentRoute: () => root, path: "/daily-recommend", component: DailyRecommendPage });
  const accounts = createRoute({ getParentRoute: () => root, path: "/source-accounts", component: () => <p>Owned account settings</p> });
  const settings = createRoute({ getParentRoute: () => root, path: "/settings/$section", component: () => <p>Owned package settings</p> });
  const router = createRouter({ routeTree: root.addChildren([daily, accounts, settings]), history: createMemoryHistory({ initialEntries: ["/daily-recommend"] }) });
  render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { level: 1 });
  return router;
}
beforeEach(() => {
  vi.resetModules(); boundary.settings.clear(); boundary.listeners.clear(); boundary.commands.length = 0; boundary.requests.length = 0;
  boundary.pageWait = null; boundary.pageError = ""; boundary.pages = [];
  boundary.metaAck = null; boundary.phase = "ready"; boundary.pack = null;
  boundary.ticket = 0; boundary.committed.clear(); boundary.abandoned.clear(); boundary.queueIds = []; boundary.playWait = null;
  window.scrollTo = vi.fn();
  boundary.settings.set(RECOMMENDATION_SOURCE_KEY, JSON.stringify({ v: 1, daily: { origin: "account", sourceId: "wyy" }, fm: { origin: "app", sourceId: "" } }));
  boundary.settings.set(SOURCE_AUTH_ACCOUNTS_KEY, JSON.stringify({ wyy: { cookie: "owned-static-fixture-not-a-real-cookie", savedAt: "2026-11-09T00:00:00.000Z", user: { id: "42", nickname: "Owned account", avatar: "", vip: false, vipLabel: "" } } }));
  boundary.settings.set(SOURCE_AUTH_TOGGLES_KEY, JSON.stringify({ wyy: { useMeta: true, usePlay: false } }));
});
afterEach(() => { cleanup(); });

describe("real daily page account-provider integration", () => {
  it("retains acknowledged META daily rows and cache on an unrelated playback-auth change while inactive", async () => {
    boundary.pages.push(dailyPage(["3"])); await renderDaily(); await screen.findByText("Owned 3");
    const cache = boundary.settings.get(ACCOUNT_DAILY_CACHE_KEY);
    const { getAccountRecommendationContext, accountRecommendationContextIsCurrent } = await import("@/lib/account-recommendation");
    const context = await getAccountRecommendationContext("daily");
    const metaAcks = boundary.requests.filter(request => request.entry === "setAuth" && (request.args as Record<string, unknown>)?.scope === "meta").length;
    fireEvent.click(screen.getByRole("button", { name: "Hide daily" }));
    await act(async () => {
      const { setSourceAuthToggle } = await import("@/lib/source-auth"); await setSourceAuthToggle("wyy", "play", true);
    });
    expect(screen.getByText("Owned 3")).toBeTruthy();
    expect(boundary.settings.get(ACCOUNT_DAILY_CACHE_KEY)).toBe(cache);
    expect(boundary.requests.filter(request => request.entry === "accountDailySongs")).toHaveLength(1);
    expect(accountRecommendationContextIsCurrent(context)).toBe(true);
    expect(boundary.requests.filter(request => request.entry === "setAuth" && (request.args as Record<string, unknown>)?.scope === "meta")).toHaveLength(metaAcks);
  });

  it("clears inactive daily rows on a PLAY-pack lifecycle reset and requires a fresh ready context and META ACK before reactivation", async () => {
    boundary.pages.push(dailyPage(["3"])); await renderDaily(); await screen.findByText("Owned 3");
    const { getAccountRecommendationContext, accountRecommendationContextIsCurrent } = await import("@/lib/account-recommendation");
    const oldContext = await getAccountRecommendationContext("daily");
    const metaAcks = boundary.requests.filter(request => request.entry === "setAuth" && (request.args as Record<string, unknown>)?.scope === "meta").length;
    const { SOURCE_PACK_CHANGED_EVENT } = await import("@/services/ipc");
    const { engineSnapshot } = await import("@/source-engine/client");
    let releaseAck!: () => void;
    boundary.metaAck = new Promise<void>(resolve => { releaseAck = resolve; });
    fireEvent.click(screen.getByRole("button", { name: "Hide daily" }));
    await act(async () => {
      // Rust emits unit (), not a synthetic { kind: 'play' } discriminator.
      publish(SOURCE_PACK_CHANGED_EVENT, null);
      expect(engineSnapshot().phase).toBeNull();
      expect(accountRecommendationContextIsCurrent(oldContext)).toBe(false);
      boundary.pack = { id: "new-play", code: 2, name: "Owned play", version: "2" };
      // The hot-play engine reports ready with the same loaded metadata header.
      publish("source-engine-status", { phase: "ready", pack: boundary.pack, meta: { id: "owned-meta", code: 1, revision: "18" } });
    });
    expect(screen.queryByText("Owned 3")).toBeNull();
    expect(boundary.requests.filter(request => request.entry === "accountDailySongs")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Show daily" }));
    await vi.waitFor(() => expect(boundary.requests.filter(request => request.entry === "setAuth" && (request.args as Record<string, unknown>)?.scope === "meta").length).toBeGreaterThan(metaAcks));
    expect(screen.queryByText("Owned 3")).toBeNull();
    expect(boundary.requests.filter(request => request.entry === "accountDailySongs")).toHaveLength(1);
    await act(async () => { releaseAck(); for (let turn = 0; turn < 20; turn += 1) await Promise.resolve(); });
    expect(await screen.findByText("Owned 3")).toBeTruthy();
    const currentContext = await getAccountRecommendationContext("daily");
    expect(accountRecommendationContextIsCurrent(currentContext)).toBe(true);
    expect(accountRecommendationContextIsCurrent(oldContext)).toBe(false);
    expect(currentContext.engineRevision).not.toBe(oldContext.engineRevision);
    expect(currentContext.packVersion).toBe(oldContext.packVersion);
    expect(boundary.requests.filter(request => request.entry === "accountDailySongs")).toHaveLength(1);
  });
  it.each(["hide", "logout", "metadata-off"])("revokes the original uncommitted daily play ticket on %s while Native IPC is pending", async (change) => {
    boundary.pages.push(dailyPage(["3"])); await renderDaily(); await screen.findByText("Owned 3");
    let release!: () => void; boundary.playWait = new Promise<void>(resolve => { release = resolve; });
    fireEvent.click(screen.getByRole("button", { name: "播放全部" }));
    await vi.waitFor(() => expect(boundary.commands.filter(call => call.command === "play_queue")).toHaveLength(1));
    const original = boundary.commands.find(call => call.command === "play_queue")!.args.playIntent;
    await act(async () => {
      if (change === "hide") fireEvent.click(screen.getByRole("button", { name: "Hide daily" }));
      else if (change === "logout") { const { removeSourceAuthAccount } = await import("@/lib/source-auth"); await removeSourceAuthAccount("wyy"); }
      else { const { setSourceAuthToggle } = await import("@/lib/source-auth"); await setSourceAuthToggle("wyy", "meta", false); }
    });
    await act(async () => { release(); for (let turn = 0; turn < 20; turn += 1) await Promise.resolve(); });
    expect(boundary.queueIds).toEqual([]);
    expect(boundary.committed.size).toBe(0);
    expect(boundary.abandoned.has(Number(original))).toBe(true);
    expect(boundary.commands.filter(call => call.command === "begin_play_intent")).toHaveLength(1);
    expect(boundary.commands.filter(call => call.command === "abandon_play_intent").every(call => call.args.playIntent === original)).toBe(true);
  });

  it("automatically reloads an active page after explicit metadata reauthorization without changing the source", async () => {
    boundary.pages.push(dailyPage(["3"])); await renderDaily(); await screen.findByText("Owned 3");
    const { setSourceAuthToggle } = await import("@/lib/source-auth");
    await act(async () => { await setSourceAuthToggle("wyy", "meta", false); });
    expect(screen.queryByText("Owned 3")).toBeNull();
    await act(async () => { await setSourceAuthToggle("wyy", "meta", true); });
    expect(await screen.findByText("Owned 3")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(boundary.requests.filter(request => request.entry === "accountDailySongs")).toHaveLength(1);
  });

  it("keeps the rendered daily account result and cache independent from an FM selection change", async () => {
    boundary.pages.push(dailyPage(["3"])); await renderDaily(); await screen.findByText("Owned 3");
    const cache = boundary.settings.get(ACCOUNT_DAILY_CACHE_KEY);
    const { useRecommendationSourceStore } = await import("@/stores/recommendation-source");
    await act(async () => { await useRecommendationSourceStore.getState().setSelection("fm", { origin: "account", sourceId: "wyy" }); });
    expect(screen.getByText("Owned 3")).toBeTruthy();
    expect(useRecommendationSourceStore.getState().daily).toEqual({ origin: "account", sourceId: "wyy" });
    expect(boundary.settings.get(ACCOUNT_DAILY_CACHE_KEY)).toBe(cache);
    expect(boundary.requests.filter(request => request.entry === "accountDailySongs")).toHaveLength(1);
  });

  it("shows an actual empty account batch without enabling play, local taste, application padding or extra pulls", async () => {
    boundary.pages.push(dailyPage([])); await renderDaily(); await screen.findByRole("button", { name: "再试一次" });
    expect(document.body.textContent).toContain("共 0 首");
    expect((screen.getByRole("button", { name: "播放全部" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("group", { name: "推荐口味" })).toBeNull();
    expect(document.body.textContent).not.toContain("候选来自全部已装音源");
    expect(boundary.requests.filter(request => request.entry === "accountDailySongs")).toHaveLength(1);
    expect(boundary.commands.filter(call => call.command === "get_local_tracks")).toEqual([]);
  });

  it("shows only a safe account network error without app fallback or raw request details", async () => {
    boundary.pageError = "ACCOUNT_NETWORK fixture-cookie=not-real https://fixture.invalid/private";
    await renderDaily(); await screen.findByText(/网络/);
    expect(document.body.textContent).not.toContain("fixture.invalid");
    expect(document.body.textContent).not.toContain("fixture-cookie");
    expect(screen.queryByRole("group", { name: "推荐口味" })).toBeNull();
    const { useRecommendationSourceStore } = await import("@/stores/recommendation-source");
    expect(useRecommendationSourceStore.getState().daily).toEqual({ origin: "account", sourceId: "wyy" });
    expect(boundary.commands.filter(call => call.command === "get_local_tracks")).toEqual([]);
  });
  it.each(["logout", "metadata-off", "pack-replaced"])("clears an already rendered account result on %s even while the keep-alive page is inactive", async (change) => {
    boundary.pages.push(dailyPage(["3", "1", "2"]));
    await renderDaily(); await screen.findByText("Owned 3");
    fireEvent.click(screen.getByRole("button", { name: "Hide daily" }));
    await act(async () => {
      if (change === "logout") { const { removeSourceAuthAccount } = await import("@/lib/source-auth"); await removeSourceAuthAccount("wyy"); }
      else if (change === "metadata-off") { const { setSourceAuthToggle } = await import("@/lib/source-auth"); await setSourceAuthToggle("wyy", "meta", false); }
      else { const { SOURCE_PACK_CHANGED_EVENT } = await import("@/services/ipc"); publish(SOURCE_PACK_CHANGED_EVENT, { kind: "meta", id: "new-meta", code: 2 }); }
    });
    expect(screen.queryByText("Owned 3")).toBeNull();
    expect(boundary.requests.filter(request => request.entry === "accountDailySongs")).toHaveLength(1);
    const { useRecommendationSourceStore } = await import("@/stores/recommendation-source");
    expect(useRecommendationSourceStore.getState().daily).toEqual({ origin: "account", sourceId: "wyy" });
  });

  it("forwards page currentness to reject a late valid-account generation and cache write after keep-alive deactivation", async () => {
    let release!: () => void; boundary.pageWait = new Promise<void>(resolve => { release = resolve; });
    boundary.pages.push(dailyPage(["9"]));
    await renderDaily();
    await vi.waitFor(() => expect(boundary.requests.filter(request => request.entry === "accountDailySongs")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Hide daily" }));
    await act(async () => { release(); for (let turn = 0; turn < 20; turn += 1) await Promise.resolve(); });
    expect(screen.queryByText("Owned 9")).toBeNull();
    expect(boundary.settings.get(ACCOUNT_DAILY_CACHE_KEY)).toBeUndefined();
  });

  it("allows a reactivated request to own loading and ignores an older pending error/finally", async () => {
    let releaseOld!: () => void; let releaseNew!: () => void;
    boundary.pageWait = new Promise<void>(resolve => { releaseOld = resolve; }); boundary.pageError = "ACCOUNT_NETWORK fixture-cookie=not-real https://fixture.invalid/old";
    await renderDaily();
    await vi.waitFor(() => expect(boundary.requests.filter(request => request.entry === "accountDailySongs")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Hide daily" }));
    boundary.pageWait = new Promise<void>(resolve => { releaseNew = resolve; }); boundary.pageError = ""; boundary.pages.push(dailyPage(["5"]));
    fireEvent.click(screen.getByRole("button", { name: "Show daily" }));
    await vi.waitFor(() => expect(boundary.requests.filter(request => request.entry === "accountDailySongs")).toHaveLength(2));
    await act(async () => { releaseOld(); for (let turn = 0; turn < 20; turn += 1) await Promise.resolve(); });
    expect((screen.getByRole("button", { name: "刷新平台推荐" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toContain("fixture.invalid");
    await act(async () => { releaseNew(); for (let turn = 0; turn < 20; turn += 1) await Promise.resolve(); });
    expect(await screen.findByText("Owned 5")).toBeTruthy();
    expect((screen.getByRole("button", { name: "刷新平台推荐" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("shows the independent daily source control, current account and actual count without application taste or ranking claims", async () => {
    boundary.pages.push(dailyPage(["3", "1", "2"]));
    await renderDaily();
    await screen.findByText("Owned 3");
    expect(screen.getByRole("radiogroup", { name: "每日推荐来源" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "推荐口味" })).toBeNull();
    expect(screen.queryByRole("button", { name: "AI 模式设置" })).toBeNull();
    expect(screen.queryByText("你爱听什么风格？")).toBeNull();
    expect(screen.getByText(/Owned source.*共 3 首/)).toBeTruthy();
    expect(screen.getByText("账号：Owned account（42）")).toBeTruthy();
    expect(screen.getAllByText(/^Owned [123]$/).map(node => node.textContent)).toEqual(["Owned 3", "Owned 1", "Owned 2"]);
    expect(document.body.textContent).not.toContain("候选来自全部已装音源");
    expect(document.body.textContent).not.toContain("同一歌手不会连着排");
    expect(document.body.textContent).not.toContain("Cookie");
    const cache = JSON.parse(boundary.settings.get(ACCOUNT_DAILY_CACHE_KEY) ?? "null");
    expect(cache.records[0].tracks.map((track: { id: string }) => track.id)).toEqual(["wyy_3", "wyy_1", "wyy_2"]);
    expect(JSON.stringify(cache)).not.toContain("cookie");
    const forbidden = new Set(["get_local_tracks", "list_top_singers", "list_history", "list_top_tracks"]);
    expect(boundary.commands.filter(call => forbidden.has(call.command))).toEqual([]);
  });
});
