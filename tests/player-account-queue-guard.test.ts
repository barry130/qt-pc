import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/types";
const boundary = vi.hoisted(() => ({
  queue: [] as Track[], revision: 40, ticket: 0,
  resolveWait: null as Promise<void> | null,
  resolveEntered: null as (() => void) | null,
  pendingIntent: 0,
  playWait: null as Promise<void> | null,
  playEntered: null as (() => void) | null,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    if (command === "get_setting") return null;
    if (command === "begin_play_intent") { boundary.pendingIntent = ++boundary.ticket; return boundary.ticket; }
    if (command === "abandon_play_intent") { if (boundary.pendingIntent === args.playIntent) boundary.pendingIntent = 0; return; }
    if (command === "set_resolved_play_url") return;
    if (command === "play_url_cache_epoch") return 1;
    if (command === "play_queue") {
      boundary.playEntered?.(); await boundary.playWait;
      if (boundary.pendingIntent !== args.playIntent) return { applied: false, target: null };
      boundary.pendingIntent = 0;
      boundary.queue = args.tracks as Track[]; boundary.revision += 1;
      return { applied: true, queueRevision: boundary.revision, target: { generation: boundary.ticket, platform: boundary.queue[0].platform, id: boundary.queue[0].id } };
    }
    if (command === "get_queue") return { tracks: boundary.queue, index: 0 };
    throw new Error(`Unexpected owned native command: ${command}`);
  },
}));
// Substitute only the external source-engine URL resolver, not player or quality policy.
vi.mock("@/source-engine/client", () => ({
  INVOKE_TIMEOUT_MS: 20_000,
  engineSnapshot: () => ({ phase: "ready", code: null, detail: null }),
  engineInvoke: async () => null,
  onEnginePhaseChange: () => () => undefined,
  engineResolve: async () => {
    boundary.resolveEntered?.(); await boundary.resolveWait;
    return { url: "https://owned.invalid/fixture.mp3", line: null, error: "", stalled: false, referer: "", size: null, actualQuality: "" };
  },
}));
vi.mock("@/lib/logger", () => ({ log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
const original: Track = { platform: "wyy", id: "original", title: "User queue", singer: "A", album: "", picUrl: "", duration: 180 };
const candidate: Track = { ...original, id: "candidate", title: "Account FM candidate" };
beforeEach(() => { vi.resetModules(); boundary.queue = [original]; boundary.revision = 40; boundary.ticket = 0; boundary.resolveWait = null; boundary.resolveEntered = null; boundary.pendingIntent = 0; boundary.playWait = null; boundary.playEntered = null; });
describe("actual player account queue boundary", () => {
  it("returns the actual native queue ownership receipt, not the request's optimistic state", async () => {
    const { usePlayerStore } = await import("@/stores/player");
    const receipt = await usePlayerStore.getState().playQueue([candidate], 0);
    expect(receipt).toMatchObject({ applied: true, queueRevision: 41, target: { platform: "wyy", id: "candidate" } });
  });

  it("does not replace the user's queue when the account context changes during actual source URL resolution", async () => {
    let release!: () => void; let entered!: () => void;
    boundary.resolveWait = new Promise<void>(resolve => { release = resolve; });
    const resolving = new Promise<void>(resolve => { entered = resolve; });
    boundary.resolveEntered = entered;
    let current = true;
    const { usePlayerStore } = await import("@/stores/player");
    const pending = usePlayerStore.getState().playQueue([candidate], 0, undefined, () => current);
    await resolving;
    current = false; release();
    expect(await pending).toMatchObject({ applied: false, target: null });
    const ipc = await import("@/services/ipc");
    expect(await ipc.getQueue()).toMatchObject({ tracks: [original] });
  });

  it("cancels only the uncommitted native ticket if the account session aborts while play_queue is pending", async () => {
    let release!: () => void; let entered!: () => void;
    boundary.playWait = new Promise<void>(resolve => { release = resolve; });
    const posted = new Promise<void>(resolve => { entered = resolve; }); boundary.playEntered = entered;
    const controller = new AbortController();
    const { usePlayerStore } = await import("@/stores/player");
    const pending = usePlayerStore.getState().playQueue([candidate], 0, undefined, () => true, controller.signal);
    await posted; controller.abort(); release();
    expect(await pending).toMatchObject({ applied: false, target: null });
    const ipc = await import("@/services/ipc");
    expect(await ipc.getQueue()).toMatchObject({ tracks: [original] });
  });
});
