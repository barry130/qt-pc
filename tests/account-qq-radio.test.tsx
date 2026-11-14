// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { Track } from "@/types";
import { RECOMMENDATION_SOURCE_KEY, SOURCE_AUTH_ACCOUNTS_KEY, SOURCE_AUTH_TOGGLES_KEY } from "@/lib/storageKeys";

// Confirmed public desktop seam: real controls, facade/auth/provider/FM/player.
// Only the separate source engine's event replies and Native IPC receipts are synthetic.
const boundary = vi.hoisted(() => ({
  settings: new Map<string, string>(), listeners: new Map<string, Array<(event: { payload: Record<string, unknown> }) => void>>(),
  requests: [] as Array<Record<string, unknown>>, commands: [] as Array<{ command: string; args: Record<string, unknown> }>,
  pages: [] as Array<Record<string, unknown>>, queue: [] as Track[], queueRevision: 7, ticket: 0, committed: new Set<number>(),
  applyQueue: null as ((tracks: Track[], revision: number) => void) | null,
}));
function publish(payload: Record<string, unknown>): void {
  for (const listener of boundary.listeners.get("source-engine-response") ?? []) listener({ payload });
}
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: Record<string, unknown> = {}) => {
  boundary.commands.push({ command, args });
  if (command === "get_setting") return boundary.settings.get(String(args.key)) ?? null;
  if (command === "set_setting") { boundary.settings.set(String(args.key), String(args.value)); return; }
  if (command === "clear_play_url_cache" || command === "write_log") return 0;
  if (command === "source_state") return { activeMetaId: "owned-qq-meta", packs: [{ id: "owned-qq-meta", kind: "meta", versionCode: 1 }] };
  if (command === "begin_play_intent") {
    if (args.expectedRevision !== undefined && (args.expectedRevision !== boundary.queueRevision || (boundary.ticket > 0 && !boundary.committed.has(boundary.ticket)))) return null;
    return ++boundary.ticket;
  }
  if (command === "abandon_play_intent") { boundary.committed.add(Number(args.playIntent)); return; }
  if (command === "set_play_mode") return;
  if (command === "play_queue") {
    const applied = args.playIntent === boundary.ticket && !boundary.committed.has(boundary.ticket) && (args.expectedRevision === undefined || args.expectedRevision === boundary.queueRevision);
    boundary.committed.add(Number(args.playIntent));
    if (applied) { boundary.queue = args.tracks as Track[]; boundary.applyQueue?.(boundary.queue, boundary.queueRevision); }
    return { applied, target: null, queueRevision: boundary.queueRevision };
  }
  if (command === "queue_append_if_current") {
    if (args.expectedRevision !== boundary.queueRevision) return { applied: false, queueRevision: boundary.queueRevision };
    boundary.queue = [...boundary.queue, ...args.tracks as Track[]]; boundary.queueRevision += 1;
    boundary.applyQueue?.(boundary.queue, boundary.queueRevision);
    return { applied: true, queueRevision: boundary.queueRevision };
  }
  if (command === "queue_release_if_current") {
    if (args.expectedRevision !== boundary.queueRevision) return { applied: false, queueRevision: boundary.queueRevision };
    boundary.queueRevision += 1; return { applied: true, queueRevision: boundary.queueRevision };
  }
  throw new Error("Unexpected owned QQ desktop IPC: " + command);
} }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, listener: (event: { payload: Record<string, unknown> }) => void) => {
    const listeners = boundary.listeners.get(event) ?? []; listeners.push(listener); boundary.listeners.set(event, listeners);
    return () => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); };
  },
  emit: async () => undefined,
  emitTo: async (_label: string, event: string, request: Record<string, unknown>) => {
    if (event !== "source-engine-request") throw new Error("Unexpected owned QQ desktop event");
    boundary.requests.push(request);
    if (request.kind === "status") { publish({ requestId: request.requestId, phase: "ready", pack: null, meta: { id: "owned-qq-meta", code: 1, revision: "19" } }); return; }
    if (request.kind === "resolve") { publish({ requestId: request.requestId, url: "", line: null, error: "", stalled: false }); return; }
    if (request.kind !== "invoke") throw new Error("Unexpected owned QQ RPC kind");
    let result: Record<string, unknown>;
    if (request.entry === "sourceRegistry") result = { sources: [
      { id: "wyy", name: "网易云音乐", short: "网易", color: "fixture", accountRecommendations: { daily: true, fm: true } },
      { id: "qq", name: "QQ音乐", short: "QQ", color: "fixture", accountRecommendations: { fm: true } },
      { id: "kg", name: "酷狗音乐", short: "酷狗", color: "fixture", accountRecommendations: { daily: true } },
    ], qualities: [] };
    else if (request.entry === "setAuth" || request.entry === "clearAuth") result = { ok: true };
    else if (request.entry === "getSourceQualities") result = { mode: "platform", qualities: [], aliases: {} };
    else if (request.entry === "accountFmNext") result = boundary.pages.shift() ?? { source: "qq", kind: "fm", accountId: "12345678", fetchedAt: Date.now(), items: [], exhausted: true };
    else throw new Error("Unexpected owned QQ entry: " + String(request.entry));
    publish({ requestId: request.requestId, result: JSON.stringify(result) });
  },
}));
function page(ids: string[]): Record<string, unknown> {
  return { source: "qq", kind: "fm", accountId: "12345678", fetchedAt: Date.now(), exhausted: false, items: ids.map(id => ({ id, name: "Owned " + id, singer: "Fixture", album: "", picUrl: "", interval: 180 })) };
}
beforeEach(() => {
  vi.resetModules();
  boundary.settings.clear(); boundary.listeners.clear(); boundary.requests.length = 0; boundary.commands.length = 0; boundary.pages = [];
  boundary.queue = []; boundary.queueRevision = 7; boundary.ticket = 0; boundary.committed.clear(); boundary.applyQueue = null;
  window.scrollTo = vi.fn();
  boundary.settings.set(SOURCE_AUTH_ACCOUNTS_KEY, JSON.stringify({ qq: {
    cookie: "uin=12345678; qm_keyst=SYNTHETIC_DESKTOP_NOT_REAL", savedAt: "2026-11-12T00:00:00.000Z",
    user: { id: "12345678", nickname: "合成QQ用户", avatar: "", vip: false, vipLabel: "" },
  } }));
  boundary.settings.set(SOURCE_AUTH_TOGGLES_KEY, JSON.stringify({ qq: { useMeta: true, usePlay: false } }));
  boundary.settings.set(RECOMMENDATION_SOURCE_KEY, JSON.stringify({ v: 1, daily: { origin: "app", sourceId: "" }, fm: { origin: "account", sourceId: "qq" } }));
});
afterEach(() => { vi.clearAllTimers(); });

describe("QQ FM at the real desktop public seam", () => {
  it("显示新包QQ FM选项并由所选账号串行补队列，日推/权限不变", async () => {
    const { RecommendationSourceControl } = await import("@/components/common/RecommendationSourceControl");
    const { useRecommendationSourceStore } = await import("@/stores/recommendation-source");
    const { useSourceRegistryStore } = await import("@/stores/sourceRegistry");
    const { usePlayerStore } = await import("@/stores/player");
    const { useRadioStore } = await import("@/stores/radio");
    const { getSourceRegistry } = await import("@/source-scripts");
    const registry = await getSourceRegistry();
    useSourceRegistryStore.setState({ ready: true, generation: 1, sources: registry!.sources, catalog: registry!.sources });
    boundary.applyQueue = (tracks) => usePlayerStore.getState().applyQueue({ tracks, index: 0 });
    const root = createRootRoute({ component: Outlet });
    const route = createRoute({ getParentRoute: () => root, path: "/", component: () => <><RecommendationSourceControl feature="daily" /><RecommendationSourceControl feature="fm" /></> });
    const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/"] }) });
    render(<RouterProvider router={router} />);
    const fm = await screen.findByRole("combobox", { name: "私人 FM 平台" });
    expect(within(fm).getAllByRole("option").map(option => option.textContent)).toEqual(["网易云音乐", "QQ音乐"]);
    expect((fm as HTMLSelectElement).value).toBe("qq");
    expect(await screen.findByText("账号：合成QQ用户（12345678）")).toBeTruthy();
    expect(document.body.textContent).not.toContain("SYNTHETIC_DESKTOP_NOT_REAL");
    boundary.pages.push(page(["003SyntheticB", "001SyntheticA"]));
    await act(async () => { await useRadioStore.getState().start(); });
    expect(useRadioStore.getState()).toMatchObject({ active: true, queueClaimed: true, origin: "account", receivedCount: 2, accountCursor: undefined, error: null });
    expect(usePlayerStore.getState().queue.map(track => [track.id, track.platform])).toEqual([["003SyntheticB", "qq"], ["001SyntheticA", "qq"]]);
    boundary.pages.push(page(["003SyntheticB", "004SyntheticC"]));
    await act(async () => { await useRadioStore.getState().refill(); });
    expect(usePlayerStore.getState().queue.map(track => track.id)).toEqual(["003SyntheticB", "001SyntheticA", "004SyntheticC"]);
    expect(useRadioStore.getState()).toMatchObject({ receivedCount: 3, queueRevision: 8, accountCursor: undefined });
    expect(boundary.requests.filter(request => request.entry === "accountFmNext").map(request => request.args)).toEqual([{ source: "qq", accountId: "12345678" }, { source: "qq", accountId: "12345678" }]);
    expect(boundary.requests.filter(request => request.entry === "setAuth").every(request => (request.args as { scope: string }).scope === "meta")).toBe(true);
    expect(boundary.commands.filter(call => ["get_local_tracks", "get_ratings", "add_dislike_song", "queue_append"].includes(call.command))).toEqual([]);
    expect(JSON.parse(boundary.settings.get(SOURCE_AUTH_TOGGLES_KEY)!)).toEqual({ qq: { useMeta: true, usePlay: false } });
    expect(useRecommendationSourceStore.getState().daily).toEqual({ origin: "app", sourceId: "" });
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "每日推荐来源" })).getByRole("radio", { name: "平台账号" }));
    await vi.waitFor(() => expect(useRecommendationSourceStore.getState().daily).toEqual({ origin: "account", sourceId: "wyy" }));
    expect(useRecommendationSourceStore.getState().fm).toEqual({ origin: "account", sourceId: "qq" });
    expect(useRadioStore.getState().active).toBe(true);
  });
});
