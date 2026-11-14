// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/types";
import { RECOMMENDATION_SOURCE_KEY, SOURCE_AUTH_ACCOUNTS_KEY, SOURCE_AUTH_TOGGLES_KEY } from "@/lib/storageKeys";

// Only Tauri transport, engine RPC messages, and native playback receipts are fixtures.
// The recommendation helper, source facade, auth, FM state machine, and player are real.
const boundary = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  listeners: new Map<string, Array<(event: { payload: Record<string, unknown> }) => void>>(),
  commands: [] as Array<{ command: string; args: Record<string, unknown> }>,
  requests: [] as Array<Record<string, unknown>>,
  ticket: 0,
  committed: new Set<number>(),
  abandoned: new Set<number>(),
  appendFailure: "",
  queueRevision: 7,
  queue: [] as Track[],
  queueIndex: 0,
  appendApplied: true,
  appendWait: null as Promise<void> | null,
  appendReceiptWait: null as Promise<void> | null,
  playApplied: true,
  commitRevision: 7 as number | undefined,
  sourceStateWait: null as Promise<void> | null,
  playWait: null as Promise<void> | null,
  pageWait: null as Promise<void> | null,
  pageError: "",
  pages: [] as Array<Record<string, unknown>>,
  applyQueue: null as ((tracks: Track[], index: number, revision: number) => void) | null,
  locals: [] as Track[],
  localsWait: null as Promise<void> | null,
  dislikeWait: null as Promise<void> | null,
  appAppendRejected: false,
}));
function publish(event: string, payload: Record<string, unknown>): void {
  for (const listener of boundary.listeners.get(event) ?? []) listener({ payload });
}
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    boundary.commands.push({ command, args });
    if (command === "get_setting") return boundary.settings.get(String(args.key)) ?? null;
    if (command === "set_setting") { boundary.settings.set(String(args.key), String(args.value)); return; }
    if (command === "clear_play_url_cache") return 0;
    if (command === "get_local_tracks") { await boundary.localsWait; return boundary.locals; }
    if (command.startsWith("check_")) return (args.tracks as Track[]).map(() => false);
    if (command === "get_ratings") return {};
    if (command === "list_playlists") return [];
    if (command === "add_dislike_song") { await boundary.dislikeWait; return; }
    if (command === "queue_append") {
      if (boundary.appAppendRejected) throw new Error("Owned app append rejected");
      boundary.queue = [...boundary.queue, ...args.tracks as Track[]]; boundary.queueRevision += 1;
      boundary.applyQueue?.(boundary.queue, boundary.queueIndex, boundary.queueRevision);
      return;
    }
    if (command === "source_state") {
      await boundary.sourceStateWait;
      return { activeMetaId: "owned-meta", packs: [{ id: "owned-meta", kind: "meta", versionCode: 1 }] };
    }
    if (command === "begin_play_intent") {
      if (args.expectedRevision !== undefined) {
        const pending = boundary.ticket > 0 && !boundary.committed.has(boundary.ticket) && !boundary.abandoned.has(boundary.ticket);
        if (pending || args.expectedRevision !== boundary.queueRevision) return null;
      }
      return ++boundary.ticket;
    }
    if (command === "abandon_play_intent") {
      const ticket = Number(args.playIntent);
      if (ticket === boundary.ticket && !boundary.committed.has(ticket)) boundary.abandoned.add(ticket);
      return;
    }
    if (command === "set_play_mode") return;
    if (command === "play_queue") {
      await boundary.playWait;
      const ticket = Number(args.playIntent);
      const pending = ticket === boundary.ticket && !boundary.abandoned.has(ticket) && !boundary.committed.has(ticket);
      const owned = args.expectedRevision === undefined || args.expectedRevision === boundary.queueRevision;
      const applied = boundary.playApplied && pending && owned;
      // Native consumes only this pending ticket, even when its owner comparison rejects.
      if (pending) boundary.committed.add(ticket);
      if (applied && boundary.commitRevision !== undefined) {
        boundary.queue = args.tracks as Track[]; boundary.queueIndex = Number(args.startIndex);
        boundary.queueRevision = args.expectedRevision === undefined ? boundary.commitRevision : boundary.queueRevision + 1;
        boundary.applyQueue?.(boundary.queue, boundary.queueIndex, boundary.queueRevision);
      }
      return { applied, target: null, queueRevision: args.expectedRevision === undefined ? boundary.commitRevision : applied ? boundary.queueRevision : undefined };
    }
    if (command === "queue_release_if_current") {
      if (args.expectedRevision !== boundary.queueRevision) return { applied: false, queueRevision: boundary.queueRevision };
      boundary.queueRevision += 1;
      return { applied: true, queueRevision: boundary.queueRevision };
    }
    if (command === "queue_append_if_current") {
      await boundary.appendWait;
      if (boundary.appendFailure === "undefined") return undefined;
      if (boundary.appendFailure === "invalid-revision") return { applied: true, queueRevision: "8" };
      if (boundary.appendFailure === "throws") throw new Error("ACCOUNT_NETWORK owned unknown commit fixture-cookie=not-real https://fixture.invalid/native");
      if (!boundary.appendApplied || args.expectedRevision !== boundary.queueRevision) return { applied: false, queueRevision: boundary.queueRevision };
      boundary.queue = [...boundary.queue, ...args.tracks as Track[]];
      boundary.queueRevision += 1;
      boundary.applyQueue?.(boundary.queue, boundary.queueIndex, boundary.queueRevision);
      const receipt = { applied: true, queueRevision: boundary.queueRevision };
      await boundary.appendReceiptWait;
      return receipt;
    }
    throw new Error(`Unexpected owned native command: ${command}`);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, listener: (event: { payload: Record<string, unknown> }) => void) => {
    const listeners = boundary.listeners.get(name) ?? [];
    listeners.push(listener); boundary.listeners.set(name, listeners);
    return () => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); };
  },
  emit: async () => undefined,
  emitTo: async (_label: string, event: string, request: Record<string, unknown>) => {
    if (event !== "source-engine-request") throw new Error(`Unexpected owned event: ${event}`);
    boundary.requests.push(request);
    if (request.kind === "status") {
      publish("source-engine-response", { requestId: request.requestId, phase: "ready", pack: null, meta: { id: "owned-meta", code: 1, revision: "18" } });
      return;
    }
    if (request.kind === "resolve") {
      publish("source-engine-response", { requestId: request.requestId, url: "", line: null, error: "", stalled: false });
      return;
    }
    if (request.kind !== "invoke") throw new Error(`Unexpected owned RPC kind: ${String(request.kind)}`);
    let result: Record<string, unknown>;
    if (request.entry === "sourceRegistry") result = { sources: [{ id: "wyy", name: "Owned source", accountRecommendations: { daily: true, fm: true } }], qualities: [] };
    else if (request.entry === "setAuth" || request.entry === "clearAuth") result = { ok: true };
    else if (request.entry === "getSourceQualities") result = { mode: "platform", qualities: [], aliases: {} };
    else if (request.entry === "accountFmNext") {
      await boundary.pageWait;
      if (boundary.pageError) { publish("source-engine-response", { requestId: request.requestId, error: boundary.pageError }); return; }
      result = boundary.pages.shift() ?? { source: "wyy", kind: "fm", accountId: "42", fetchedAt: Date.now(), items: [], exhausted: true };
    } else throw new Error(`Unexpected owned source entry: ${String(request.entry)}`);
    publish("source-engine-response", { requestId: request.requestId, result: JSON.stringify(result) });
  },
}));
vi.mock("@/lib/logger", () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

function setOwnedAccount(): void {
  boundary.settings.set(SOURCE_AUTH_ACCOUNTS_KEY, JSON.stringify({ wyy: {
    cookie: "owned-static-fixture-not-a-real-cookie", savedAt: "2026-11-09T00:00:00.000Z",
    user: { id: "42", nickname: "Owned account", avatar: "", vip: false, vipLabel: "" },
  } }));
  boundary.settings.set(SOURCE_AUTH_TOGGLES_KEY, JSON.stringify({ wyy: { useMeta: true, usePlay: false } }));
}
function page(ids: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { source: "wyy", kind: "fm", accountId: "42", fetchedAt: Date.now(), items: ids.map(id => ({
    id: `wyy_${id}`, musicId: id, name: `Owned ${id}`, singer: "Fixture", album: "", picUrl: "", interval: 180,
  })), ...extra };
}
async function startOwnedRadio(ids = ["1"], extra: Record<string, unknown> = {}) {
  setOwnedAccount();
  boundary.pages.push(page(ids, { exhausted: false, ...extra }));
  const { usePlayerStore } = await import("@/stores/player");
  boundary.applyQueue = (tracks, index) => usePlayerStore.getState().applyQueue({ tracks, index });
  const { useRadioStore } = await import("@/stores/radio");
  await useRadioStore.getState().start();
  expect(useRadioStore.getState().error).toBeNull();
  expect(useRadioStore.getState().active).toBe(true);
  return { useRadioStore, usePlayerStore };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.resetModules();
  boundary.settings.clear(); boundary.listeners.clear(); boundary.commands.length = 0; boundary.requests.length = 0;
  boundary.ticket = 0; boundary.committed.clear(); boundary.abandoned.clear(); boundary.appendFailure = ""; boundary.queueRevision = 7; boundary.queue = []; boundary.queueIndex = 0;
  boundary.appendApplied = true; boundary.appendWait = null; boundary.appendReceiptWait = null; boundary.playApplied = true; boundary.commitRevision = 7;
  boundary.sourceStateWait = null; boundary.playWait = null; boundary.pageWait = null; boundary.pageError = ""; boundary.pages = []; boundary.applyQueue = null;
  boundary.locals = []; boundary.localsWait = null; boundary.dislikeWait = null; boundary.appAppendRejected = false;
  boundary.settings.set(RECOMMENDATION_SOURCE_KEY, JSON.stringify({ v: 1, daily: { origin: "app", sourceId: "" }, fm: { origin: "account", sourceId: "wyy" } }));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function setAppLibrary(): void {
  boundary.settings.delete(RECOMMENDATION_SOURCE_KEY);
  boundary.locals = Array.from({ length: 65 }, (_, index) => ({
    id: `local_${index + 1}`, title: `Local fixture ${index + 1}`, singer: "Fixture", album: "", picUrl: "", duration: 180, platform: "local",
  }));
}
async function startAppRadio() {
  setAppLibrary();
  const { usePlayerStore } = await import("@/stores/player");
  boundary.applyQueue = (tracks, index) => usePlayerStore.getState().applyQueue({ tracks, index });
  const { useRadioStore } = await import("@/stores/radio");
  await useRadioStore.getState().start();
  expect(useRadioStore.getState()).toMatchObject({ active: true, error: null, origin: "app" });
  return { useRadioStore, usePlayerStore };
}

describe("real app FM compatibility at the Native boundary", () => {
  it("does not persist app session history before a rejected Native initial queue receipt", async () => {
    setAppLibrary(); boundary.playApplied = false;
    const old = JSON.stringify(["owned_previous_session"]); localStorage.setItem("quietmusic.fm.lastSessionKeys", old);
    const { useRadioStore } = await import("@/stores/radio");
    await useRadioStore.getState().start();
    expect(localStorage.getItem("quietmusic.fm.lastSessionKeys")).toBe(old);
    expect(useRadioStore.getState()).toMatchObject({ active: false, queueClaimed: false });
    expect(useRadioStore.getState().usedKeys.size).toBe(0);
    expect(boundary.commands.filter(call => call.command === "play_queue")).toHaveLength(1);
  });

  it("does not continue app filtering or history writes after stop during the local-library await", async () => {
    setAppLibrary(); let release!: () => void; boundary.localsWait = new Promise<void>(resolve => { release = resolve; });
    const old = JSON.stringify(["owned_previous_session"]); localStorage.setItem("quietmusic.fm.lastSessionKeys", old);
    const { useRadioStore } = await import("@/stores/radio");
    const start = useRadioStore.getState().start();
    await vi.waitFor(() => expect(boundary.commands.filter(call => call.command === "get_local_tracks")).toHaveLength(1));
    useRadioStore.getState().stop(); release(); await start;
    expect(localStorage.getItem("quietmusic.fm.lastSessionKeys")).toBe(old);
    expect(boundary.commands.filter(call => call.command === "check_disliked")).toHaveLength(0);
    expect(boundary.commands.filter(call => call.command === "play_queue")).toHaveLength(0);
  });

  it("keeps app used keys unchanged if Native append rejects", async () => {
    const { useRadioStore } = await startAppRadio();
    const used = new Set(useRadioStore.getState().usedKeys); const queue = [...boundary.queue];
    boundary.appAppendRejected = true;
    await useRadioStore.getState().refill(1);
    expect(boundary.commands.filter(call => call.command === "queue_append")).toHaveLength(1);
    expect(useRadioStore.getState().usedKeys).toEqual(used);
    expect(boundary.queue).toEqual(queue);
  });

  it("does not skip or mutate app dislike state after switching to account FM during the feedback await", async () => {
    const { useRadioStore } = await startAppRadio();
    let release!: () => void; boundary.dislikeWait = new Promise<void>(resolve => { release = resolve; });
    const original = [...useRadioStore.getState().disliked];
    const dislike = useRadioStore.getState().dislike(boundary.queue[0]!);
    await vi.waitFor(() => expect(boundary.commands.filter(call => call.command === "add_dislike_song")).toHaveLength(1));
    const { useRecommendationSourceStore } = await import("@/stores/recommendation-source");
    await useRecommendationSourceStore.getState().setSelection("fm", { origin: "account", sourceId: "wyy" });
    release(); await dislike; for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    expect(useRadioStore.getState().disliked).toEqual(original);
    expect(boundary.commands.filter(call => call.command === "begin_play_intent")).toHaveLength(1);
    expect(boundary.commands.filter(call => call.command === "next_track")).toHaveLength(0);
  });
});

describe("account FM uses the real shared account provider and native receipts", () => {
  it("keeps its FM session across a heartbeat after the Native append mirror but before its receipt", async () => {
    const { useRadioStore, usePlayerStore } = await startOwnedRadio(["1"], { cursor: "before" });
    let release!: () => void;
    boundary.appendReceiptWait = new Promise<void>(resolve => { release = resolve; });
    boundary.pages.push(page(["2"], { cursor: "after", exhausted: false }));
    const refill = useRadioStore.getState().refill();
    try {
      await vi.waitFor(() => expect(usePlayerStore.getState().queue.map(track => track.id)).toEqual(["wyy_1", "wyy_2"]));
      // The public heartbeat observes the committed Native mirror while its ACK is still pending.
      useRadioStore.getState().tick();
      expect(useRadioStore.getState()).toMatchObject({
        active: true, queueClaimed: true, loading: true, receivedCount: 1,
        queueRevision: 7, accountCursor: "before",
      });
      expect(boundary.commands.filter(call => call.command === "queue_release_if_current")).toEqual([]);
    } finally {
      release();
      await refill;
    }
    expect(useRadioStore.getState()).toMatchObject({
      active: true, queueClaimed: true, loading: false, receivedCount: 2,
      queueRevision: 8, accountCursor: "after",
    });
    expect(boundary.requests.filter(request => request.entry === "accountFmNext").map(request => request.args)).toEqual([
      { source: "wyy", accountId: "42" }, { source: "wyy", accountId: "42", cursor: "before" },
    ]);
    expect(boundary.commands.filter(call => call.command === "queue_append_if_current")).toHaveLength(1);
    expect(usePlayerStore.getState().queue.map(track => track.id)).toEqual(["wyy_1", "wyy_2"]);
  });

  it("does not undo an already committed append when metadata revokes before the Native receipt arrives", async () => {
    const { useRadioStore } = await startOwnedRadio();
    let release!: () => void; boundary.appendReceiptWait = new Promise<void>(resolve => { release = resolve; });
    boundary.pages.push(page(["2"], { exhausted: false }));
    const refill = useRadioStore.getState().refill();
    await vi.waitFor(() => expect(boundary.queue.map(track => track.id)).toEqual(["wyy_1", "wyy_2"]));
    const { setSourceAuthToggle } = await import("@/lib/source-auth"); await setSourceAuthToggle("wyy", "meta", false);
    release(); await refill;
    expect(boundary.queue.map(track => track.id)).toEqual(["wyy_1", "wyy_2"]);
    expect(boundary.queueRevision).toBe(8);
    expect(boundary.commands.filter(call => call.command === "queue_release_if_current")).toMatchObject([{ args: { expectedRevision: 7 } }]);
    expect(useRadioStore.getState()).toMatchObject({ active: false, queueClaimed: false, receivedCount: 0 });
    expect(boundary.commands.filter(call => call.command === "begin_play_intent")).toHaveLength(1);
  });

  it("does not release a later manual Native owner when cancelling a pending old-account append", async () => {
    const { useRadioStore } = await startOwnedRadio();
    let release!: () => void; boundary.appendWait = new Promise<void>(resolve => { release = resolve; });
    boundary.pages.push(page(["2"], { exhausted: false }));
    const refill = useRadioStore.getState().refill();
    await vi.waitFor(() => expect(boundary.commands.filter(call => call.command === "queue_append_if_current")).toHaveLength(1));
    boundary.queue = [{ ...boundary.queue[0]!, id: "manual-owner", title: "Owned manual queue" }]; boundary.queueRevision = 99;
    const { setSourceAuthToggle } = await import("@/lib/source-auth"); await setSourceAuthToggle("wyy", "meta", false);
    release(); await refill;
    expect(boundary.queue.map(track => track.id)).toEqual(["manual-owner"]);
    expect(boundary.queueRevision).toBe(99);
    expect(boundary.commands.filter(call => call.command === "queue_release_if_current")).toMatchObject([{ args: { expectedRevision: 7 } }]);
    expect(useRadioStore.getState()).toMatchObject({ active: false, queueClaimed: false, receivedCount: 0 });
    expect(boundary.commands.filter(call => call.command === "begin_play_intent")).toHaveLength(1);
  });
  it.each(["metadata-off", "provider-changed", "stop"])("does not commit a queued old-account append on %s before Native commit", async (change) => {
    const { useRadioStore } = await startOwnedRadio();
    let release!: () => void; boundary.appendWait = new Promise<void>(resolve => { release = resolve; });
    boundary.pages.push(page(["2"], { exhausted: false }));
    const refill = useRadioStore.getState().refill();
    await vi.waitFor(() => expect(boundary.commands.filter(call => call.command === "queue_append_if_current")).toHaveLength(1));
    if (change === "metadata-off") { const { setSourceAuthToggle } = await import("@/lib/source-auth"); await setSourceAuthToggle("wyy", "meta", false); }
    else if (change === "stop") useRadioStore.getState().stop();
    else { const { useRecommendationSourceStore } = await import("@/stores/recommendation-source"); await useRecommendationSourceStore.getState().setSelection("fm", { origin: "app", sourceId: "" }); }
    release(); await refill;
    expect(boundary.queue.map(track => track.id)).toEqual(["wyy_1"]);
    expect(useRadioStore.getState()).toMatchObject({ active: false, queueClaimed: false, receivedCount: 0, queueRevision: null });
    expect(boundary.commands.filter(call => call.command === "begin_play_intent")).toHaveLength(1);
  });
  it.each(["stop", "logout", "metadata-off"])("abandons only the original uncommitted Native ticket on %s during pending play IPC", async (change) => {
    setOwnedAccount(); boundary.pages.push(page(["1"], { exhausted: false }));
    let release!: () => void; boundary.playWait = new Promise<void>(resolve => { release = resolve; });
    const { useRadioStore } = await import("@/stores/radio");
    const start = useRadioStore.getState().start();
    await vi.waitFor(() => expect(boundary.commands.filter(call => call.command === "play_queue")).toHaveLength(1));
    const original = boundary.commands.find(call => call.command === "play_queue")!.args.playIntent;
    if (change === "stop") useRadioStore.getState().stop();
    else if (change === "logout") { const { removeSourceAuthAccount } = await import("@/lib/source-auth"); await removeSourceAuthAccount("wyy"); }
    else { const { setSourceAuthToggle } = await import("@/lib/source-auth"); await setSourceAuthToggle("wyy", "meta", false); }
    release(); await start;
    expect(boundary.queue).toEqual([]);
    expect(boundary.committed.size).toBe(0);
    expect(boundary.abandoned.has(Number(original))).toBe(true);
    expect(boundary.commands.filter(call => call.command === "begin_play_intent")).toHaveLength(1);
    expect(boundary.commands.filter(call => call.command === "abandon_play_intent").every(call => call.args.playIntent === original)).toBe(true);
    expect(useRadioStore.getState()).toMatchObject({ active: false, queueClaimed: false, receivedCount: 0, queueRevision: null, loading: false });
  });

  it.each(["undefined", "invalid-revision", "throws"])("fails closed immediately on a %s Native append outcome without feed-network retries", async (failure) => {
    const { useRadioStore } = await startOwnedRadio();
    boundary.appendFailure = failure; boundary.pages.push(page(["2"], { exhausted: false }));
    await useRadioStore.getState().refill();
    expect(useRadioStore.getState()).toMatchObject({ active: false, queueClaimed: false, receivedCount: 0, queueRevision: null, retryAt: 0, loading: false });
    expect(useRadioStore.getState().usedKeys.size).toBe(0);
    expect(useRadioStore.getState().error).toContain("回执");
    expect(useRadioStore.getState().error).not.toContain("fixture.invalid");
    vi.advanceTimersByTime(60_000); await useRadioStore.getState().tick();
    expect(boundary.requests.filter(request => request.entry === "accountFmNext")).toHaveLength(2);
    expect(boundary.commands.filter(call => call.command === "queue_append_if_current")).toHaveLength(1);
  });

  it("ignores application taste changes while the account provider owns FM", async () => {
    const { useRadioStore } = await startOwnedRadio();
    const taste = useRadioStore.getState().taste;
    useRadioStore.getState().setTaste(taste === "explore" ? "heart" : "explore");
    expect(useRadioStore.getState().taste).toBe(taste);
    expect(useRadioStore.getState()).toMatchObject({ receivedCount: 1, active: true, error: null });
    expect(boundary.requests.filter(request => request.entry === "accountFmNext")).toHaveLength(1);
  });
  it("does not send local dislikes, skip feedback, or ranked refill actions in platform-account mode", async () => {
    const { useRadioStore, usePlayerStore } = await startOwnedRadio();
    const commands = boundary.commands.length;
    const requests = boundary.requests.length;
    await useRadioStore.getState().dislike(usePlayerStore.getState().queue[0]);
    expect(boundary.commands.slice(commands)).toEqual([]);
    expect(boundary.requests.slice(requests)).toEqual([]);
    expect(useRadioStore.getState()).toMatchObject({ error: null, receivedCount: 1, active: true });
  });

  it("does not revoke a metadata FM session when only playback authorization changes", async () => {
    const { useRadioStore } = await startOwnedRadio();
    const { setSourceAuthToggle } = await import("@/lib/source-auth");
    await setSourceAuthToggle("wyy", "play", true);
    expect(useRadioStore.getState()).toMatchObject({ active: true, queueClaimed: true, receivedCount: 1, error: null });
  });

  it.each(["rejected", "missing-owner"])("never claims or marks tracks from a %s initial Native receipt", async (kind) => {
    setOwnedAccount(); boundary.pages.push(page(["1"], { exhausted: false }));
    if (kind === "rejected") boundary.playApplied = false; else boundary.commitRevision = undefined;
    const { useRadioStore } = await import("@/stores/radio");
    await useRadioStore.getState().start();
    expect(useRadioStore.getState()).toMatchObject({ active: false, queueClaimed: false, loading: false, receivedCount: 0, queueRevision: null });
    expect(useRadioStore.getState().usedKeys.size).toBe(0);
    expect(useRadioStore.getState().error).toContain("回执");
    await useRadioStore.getState().refill();
    expect(boundary.commands.filter(call => call.command === "queue_append_if_current")).toEqual([]);
  });

  it("still restores its original queue when the acknowledged account FM action has not been superseded", async () => {
    const { usePlayerStore } = await import("@/stores/player");
    boundary.applyQueue = (tracks, index) => usePlayerStore.getState().applyQueue({ tracks, index });
    const original: Track = { id: "local_original", platform: "local", title: "Original queue", singer: "Fixture", album: "", picUrl: "", duration: 180 };
    boundary.commitRevision = 6;
    expect((await usePlayerStore.getState().playQueue([original], 0))?.applied).toBe(true);
    boundary.commitRevision = 7;
    const { useRadioStore } = await startOwnedRadio();

    boundary.commitRevision = 8;
    useRadioStore.getState().stop(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(boundary.commands.filter(call => call.command === "play_queue")).toHaveLength(3);
    expect(boundary.queue).toEqual([original]);
    expect(usePlayerStore.getState().queue).toEqual([original]);
    expect(useRadioStore.getState()).toMatchObject({ active: false, queueClaimed: false, stash: null, error: null });
  });

  it("does not restore its stash over a manual replay of FM tracks before the first heartbeat", async () => {
    const { usePlayerStore } = await import("@/stores/player");
    boundary.applyQueue = (tracks, index) => usePlayerStore.getState().applyQueue({ tracks, index });
    const original: Track = { id: "local_original", platform: "local", title: "Original queue", singer: "Fixture", album: "", picUrl: "", duration: 180 };
    boundary.commitRevision = 6;
    expect((await usePlayerStore.getState().playQueue([original], 0))?.applied).toBe(true);
    boundary.commitRevision = 7;
    const { useRadioStore } = await startOwnedRadio(["1", "2"]);
    expect(useRadioStore.getState().stash?.queue).toEqual([original]);

    const manualQueue = [...usePlayerStore.getState().queue].reverse();
    boundary.commitRevision = 8;
    expect((await usePlayerStore.getState().playQueue(manualQueue, 0))?.applied).toBe(true);
    expect(boundary.queueRevision).toBe(8);
    // Same FM keys, but a genuine newer Native owner; no heartbeat has run yet.
    const plays = boundary.commands.filter(call => call.command === "play_queue").length;
    useRadioStore.getState().stop(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(boundary.commands.filter(call => call.command === "play_queue")).toHaveLength(plays);
    expect(boundary.queue).toEqual(manualQueue);
    expect(usePlayerStore.getState().queue).toEqual(manualQueue);
    expect(useRadioStore.getState()).toMatchObject({ active: false, queueClaimed: false, stash: null, queueRevision: null });
  });

  it("does not restore its stash over a newer Native queue reorder without a player action", async () => {
    const { usePlayerStore } = await import("@/stores/player");
    boundary.applyQueue = (tracks, index) => usePlayerStore.getState().applyQueue({ tracks, index });
    const original: Track = { id: "local_original", platform: "local", title: "Original queue", singer: "Fixture", album: "", picUrl: "", duration: 180 };
    boundary.commitRevision = 6;
    expect((await usePlayerStore.getState().playQueue([original], 0))?.applied).toBe(true);
    boundary.commitRevision = 7;
    const { useRadioStore } = await startOwnedRadio(["1", "2"]);

    // Owned Native transport delivers a structural mutation, not a JS play click.
    const nativeQueue = [...boundary.queue].reverse();
    boundary.queue = nativeQueue; boundary.queueRevision = 8;
    boundary.applyQueue?.(nativeQueue, 0, 8);
    boundary.commitRevision = 9;
    const plays = boundary.commands.filter(call => call.command === "play_queue").length;
    useRadioStore.getState().stop(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(boundary.commands.filter(call => call.command === "play_queue")).toHaveLength(plays);
    expect(boundary.queueRevision).toBe(8);
    expect(boundary.queue).toEqual(nativeQueue);
    expect(usePlayerStore.getState().queue).toEqual(nativeQueue);
  });

  it("relinquishes a stale Native append owner without used/count changes or restoring over the user's new queue", async () => {
    const { usePlayerStore } = await import("@/stores/player");
    const foreign: Track = { id: "foreign", platform: "wyy", title: "Other queue", singer: "Other", album: "", picUrl: "", duration: 180 };
    usePlayerStore.setState({ queue: [foreign], queueIndex: 0 });
    const { useRadioStore } = await startOwnedRadio();
    boundary.queue = [foreign]; boundary.queueRevision = 99;
    boundary.pages.push(page(["2"], { cursor: "not-accepted", exhausted: false }));
    await useRadioStore.getState().refill();
    expect(boundary.queue).toEqual([foreign]);
    expect(useRadioStore.getState()).toMatchObject({ active: false, queueClaimed: false, loading: false, receivedCount: 0, queueRevision: null, account: null });
    expect(useRadioStore.getState().usedKeys.size).toBe(0);
    useRadioStore.getState().stop(true);
    expect(boundary.commands.filter(call => call.command === "play_queue")).toHaveLength(1);
  });
  it("keeps the accepted account cursor and queue state when three empty or duplicate batches add no tracks", async () => {
    const history = JSON.stringify(["owned_previous_session"]);
    localStorage.setItem("quietmusic.fm.lastSessionKeys", history);
    const { useRadioStore, usePlayerStore } = await startOwnedRadio(["1"], { cursor: "accepted-cursor" });
    const queue = [...usePlayerStore.getState().queue];
    const usedKeys = new Set(useRadioStore.getState().usedKeys);
    boundary.pages.push(
      page(["1"], { cursor: "uncommitted-1", exhausted: false }),
      page([], { cursor: "uncommitted-2", exhausted: false }),
      page(["1", "1"], { cursor: "uncommitted-3", exhausted: false }),
      page(["2"], { cursor: "not-pulled", exhausted: false }),
    );
    await useRadioStore.getState().refill();
    expect(useRadioStore.getState()).toMatchObject({
      active: true, queueClaimed: true, exhausted: true, loading: false,
      accountCursor: "accepted-cursor", receivedCount: 1, queueRevision: 7,
    });
    expect(useRadioStore.getState().usedKeys).toEqual(usedKeys);
    expect(usePlayerStore.getState().queue).toEqual(queue);
    expect(boundary.queueRevision).toBe(7);
    expect(boundary.commands.filter(call => call.command === "queue_append_if_current")).toEqual([]);
    expect(boundary.requests.filter(request => request.entry === "accountFmNext").map(request => request.args)).toEqual([
      { source: "wyy", accountId: "42" },
      { source: "wyy", accountId: "42", cursor: "accepted-cursor" },
      { source: "wyy", accountId: "42", cursor: "uncommitted-1" },
      { source: "wyy", accountId: "42", cursor: "uncommitted-2" },
    ]);
    expect(localStorage.getItem("quietmusic.fm.lastSessionKeys")).toBe(history);
    await useRadioStore.getState().tick();
    expect(boundary.requests.filter(request => request.entry === "accountFmNext")).toHaveLength(4);
  });
  it("bounds empty or duplicate pulls to three at both start and refill without app padding", async () => {
    setOwnedAccount();
    boundary.pages.push(page([], { cursor: "s1", exhausted: false }), page([], { cursor: "s2", exhausted: false }), page(["7"], { cursor: "s3", exhausted: false }));
    const { usePlayerStore } = await import("@/stores/player");
    boundary.applyQueue = (tracks, index) => usePlayerStore.getState().applyQueue({ tracks, index });
    const { useRadioStore } = await import("@/stores/radio");
    await useRadioStore.getState().start();
    expect(useRadioStore.getState()).toMatchObject({ active: true, receivedCount: 1, accountCursor: "s3", error: null });
    expect(boundary.requests.filter(request => request.entry === "accountFmNext")).toHaveLength(3);
    boundary.pages.push(page(["7"], { cursor: "r1", exhausted: false }), page([], { cursor: "r2", exhausted: false }), page(["8"], { cursor: "r3", exhausted: false }));
    await useRadioStore.getState().refill();
    expect(useRadioStore.getState()).toMatchObject({ active: true, receivedCount: 2, accountCursor: "r3", queueRevision: 8 });
    expect(boundary.requests.filter(request => request.entry === "accountFmNext")).toHaveLength(6);
    boundary.pages.push(page([], { cursor: "e1", exhausted: false }), page(["7", "8"], { cursor: "e2", exhausted: false }), page([], { cursor: "e3", exhausted: false }), page(["9"], { cursor: "not-pulled", exhausted: false }));
    await useRadioStore.getState().refill(); await useRadioStore.getState().tick();
    expect(boundary.requests.filter(request => request.entry === "accountFmNext")).toHaveLength(9);
    expect(boundary.commands.filter(call => call.command === "queue_append_if_current")).toHaveLength(1);
    expect(usePlayerStore.getState().queue.map(track => track.id)).toEqual(["wyy_7", "wyy_8"]);
    expect(useRadioStore.getState()).toMatchObject({ exhausted: true, receivedCount: 2, queueRevision: 8, loading: false });
    expect(boundary.commands.filter(call => call.command === "queue_append")).toEqual([]);
  });
  it("shows a safe network error and exponentially backs off the one-second heartbeat with at most three failed pulls", async () => {
    const { useRadioStore } = await startOwnedRadio();
    boundary.pageError = "ACCOUNT_NETWORK: https://fixture.invalid/?Cookie=not-a-credential";
    await useRadioStore.getState().tick();
    expect(useRadioStore.getState().error).toContain("网络");
    expect(useRadioStore.getState().error).not.toContain("fixture.invalid");
    expect(useRadioStore.getState().error).not.toContain("Cookie");
    for (let second = 0; second < 4; second += 1) { await vi.advanceTimersByTimeAsync(1_000); await useRadioStore.getState().tick(); }
    expect(boundary.requests.filter(request => request.entry === "accountFmNext")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000); await useRadioStore.getState().tick();
    expect(boundary.requests.filter(request => request.entry === "accountFmNext")).toHaveLength(3);
    for (let second = 0; second < 9; second += 1) { await vi.advanceTimersByTimeAsync(1_000); await useRadioStore.getState().tick(); }
    expect(boundary.requests.filter(request => request.entry === "accountFmNext")).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1_000); await useRadioStore.getState().tick();
    expect(boundary.requests.filter(request => request.entry === "accountFmNext")).toHaveLength(4);
    expect(useRadioStore.getState()).toMatchObject({ active: false, queueClaimed: false, loading: false });
    for (let second = 0; second < 5; second += 1) { await vi.advanceTimersByTimeAsync(1_000); await useRadioStore.getState().tick(); }
    expect(boundary.requests.filter(request => request.entry === "accountFmNext")).toHaveLength(4);
    boundary.pageError = ""; boundary.pages.push(page(["9"], { exhausted: false })); boundary.commitRevision = 8;
    await useRadioStore.getState().start();
    expect(useRadioStore.getState()).toMatchObject({ active: true, loading: false, error: null, receivedCount: 1, queueRevision: 8 });
  });
  it.each(["logout", "metadata-off", "pack-replaced"])("immediately invalidates the FM session and pending batch on %s", async (change) => {
    const { useRadioStore } = await startOwnedRadio();
    boundary.pages.push(page(["2"], { exhausted: false }));
    let release!: () => void;
    boundary.pageWait = new Promise<void>(resolve => { release = resolve; });
    const pending = useRadioStore.getState().refill();
    await vi.waitFor(() => expect(boundary.requests.filter(request => request.entry === "accountFmNext")).toHaveLength(2));
    try {
      const auth = await import("@/lib/source-auth");
      if (change === "logout") await auth.removeSourceAuthAccount("wyy");
      else if (change === "metadata-off") await auth.setSourceAuthToggle("wyy", "meta", false);
      else { const { SOURCE_PACK_CHANGED_EVENT } = await import("@/services/ipc"); publish(SOURCE_PACK_CHANGED_EVENT, {}); }
      expect(useRadioStore.getState()).toMatchObject({ active: false, queueClaimed: false, loading: false, account: null, queueRevision: null, receivedCount: 0 });
    } finally { release(); await pending; }
    expect(boundary.commands.filter(call => call.command === "queue_append_if_current")).toEqual([]);
    expect(boundary.commands.filter(call => call.command === "play_queue")).toHaveLength(1);
  });
  it("accepts an acknowledged Native queue then conditionally refills only new tracks in original platform order", async () => {
    setOwnedAccount();
    boundary.pages.push(page(["3", "1", "3", "2"], { cursor: "first", exhausted: false }), page(["2", "4", "3", "5"], { cursor: "second", exhausted: false }));
    const { usePlayerStore } = await import("@/stores/player");
    boundary.applyQueue = (tracks, index) => usePlayerStore.getState().applyQueue({ tracks, index });
    const { useRadioStore } = await import("@/stores/radio");
    await useRadioStore.getState().start();
    expect(useRadioStore.getState().error).toBeNull();
    expect(useRadioStore.getState()).toMatchObject({ origin: "account", active: true, queueClaimed: true, receivedCount: 3, queueRevision: 7, accountCursor: "first" });
    expect(usePlayerStore.getState().queue.map(track => track.id)).toEqual(["wyy_3", "wyy_1", "wyy_2"]);
    await useRadioStore.getState().refill();
    const append = boundary.commands.find(call => call.command === "queue_append_if_current");
    expect(append?.args.expectedRevision).toBe(7);
    expect((append?.args.tracks as Track[] | undefined)?.map(track => track.id)).toEqual(["wyy_4", "wyy_5"]);
    expect(usePlayerStore.getState().queue.map(track => track.id)).toEqual(["wyy_3", "wyy_1", "wyy_2", "wyy_4", "wyy_5"]);
    expect(useRadioStore.getState()).toMatchObject({ receivedCount: 5, queueRevision: 8, accountCursor: "second", active: true });
    expect(boundary.requests.filter(request => request.entry === "accountFmNext").map(request => request.args)).toEqual([
      { source: "wyy", accountId: "42" }, { source: "wyy", accountId: "42", cursor: "first" },
    ]);
    const forbidden = new Set(["get_local_tracks", "list_top_singers", "list_history", "list_favorites", "list_top_tracks", "queue_append"]);
    expect(boundary.commands.filter(call => forbidden.has(call.command))).toEqual([]);
  });
  it("reserves the original Native playback intent before account preparation so a later user action has priority", async () => {
    let release!: () => void;
    boundary.sourceStateWait = new Promise<void>(resolve => { release = resolve; });
    const { useRadioStore } = await import("@/stores/radio");
    const pending = useRadioStore.getState().start();
    await vi.waitFor(() => expect(boundary.commands.some(call => call.command === "source_state")).toBe(true));
    try {
      const intent = boundary.commands.findIndex(call => call.command === "begin_play_intent");
      const prepare = boundary.commands.findIndex(call => call.command === "source_state");
      expect(intent).toBeGreaterThanOrEqual(0);
      expect(intent).toBeLessThan(prepare);
    } finally {
      useRadioStore.getState().stop(false);
      release();
      await pending;
    }
  });
  it("relinquishes a pending account start when FM provider is explicitly changed without restoring a queue", async () => {
    let release!: () => void;
    boundary.sourceStateWait = new Promise<void>(resolve => { release = resolve; });
    const { useRadioStore } = await import("@/stores/radio");
    const { useRecommendationSourceStore } = await import("@/stores/recommendation-source");
    const pending = useRadioStore.getState().start();
    await vi.waitFor(() => expect(boundary.commands.some(call => call.command === "source_state")).toBe(true));
    await useRecommendationSourceStore.getState().setSelection("fm", { origin: "app", sourceId: "wyy" });
    release();
    await pending;
    expect(useRadioStore.getState()).toMatchObject({ active: false, queueClaimed: false, loading: false, error: null, stash: null });
    expect(boundary.commands.some(call => call.command === "play_queue")).toBe(false);
    expect(useRecommendationSourceStore.getState().fm.origin).toBe("app");
  });
  it("ignores a late preparation failure after explicit stop instead of reviving error or loading state", async () => {
    let release!: () => void;
    boundary.sourceStateWait = new Promise<void>(resolve => { release = resolve; });
    const { useRadioStore } = await import("@/stores/radio");
    const pending = useRadioStore.getState().start();
    await vi.waitFor(() => expect(boundary.commands.some(call => call.command === "source_state")).toBe(true));
    useRadioStore.getState().stop(false);
    release();
    await pending;
    expect(useRadioStore.getState()).toMatchObject({ active: false, queueClaimed: false, loading: false, error: null });
    expect(boundary.commands.some(call => call.command === "play_queue")).toBe(false);
  });
  it("requires explicit metadata login before touching local history, taste ranking, or the playback queue", async () => {
    const { useRadioStore } = await import("@/stores/radio");
    await useRadioStore.getState().start();
    const state = useRadioStore.getState();
    expect(state.error, JSON.stringify({ commands: boundary.commands, requests: boundary.requests })).toContain("登录");
    expect(state.active).toBe(false);
    expect(state.queueClaimed).toBe(false);
    expect(state.usedKeys.size).toBe(0);
    expect(boundary.commands.some(call => ["get_local_tracks", "get_liked_songs", "get_top_play_stats", "play_queue"].includes(call.command))).toBe(false);
    expect(boundary.requests.some(request => request.entry === "accountFmNext")).toBe(false);
  });
});
