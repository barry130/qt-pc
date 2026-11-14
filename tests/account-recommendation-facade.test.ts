import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type EventListener = (event: { payload: unknown }) => void;
const transport = vi.hoisted(() => ({
  reply: null as Record<string, unknown> | null,
  fmCursor: undefined as string | undefined,
  listeners: new Map<string, Set<EventListener>>(),
}));
// Only the separate native/event window is substituted; facade/client are real.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string) => {
    if (command === "write_log") return;
    throw new Error(`Unexpected owned native command: ${command}`);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, listener: EventListener) => {
    const listeners = transport.listeners.get(event) ?? new Set<EventListener>();
    transport.listeners.set(event, listeners); listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  emit: async () => undefined,
  emitTo: async (target: string, event: string, request: { requestId: number; kind: string; entry?: string; args?: Record<string, unknown> }) => {
    const publish = (reply: Record<string, unknown>) => {
      for (const listener of transport.listeners.get("source-engine-response") ?? []) {
        listener({ payload: { requestId: request.requestId, ...reply } });
      }
    };
    if (target !== "source-engine" || event !== "source-engine-request") { publish({ error: "OWNED_RPC_ROUTING_REJECTED" }); return; }
    if (request.kind === "status") { publish({ phase: "ready", code: 1, detail: null, pack: null }); return; }
    const args = request.args ?? {};
    const entry = transport.fmCursor === undefined ? "accountDailySongs" : "accountFmNext";
    if (request.kind !== "invoke" || request.entry !== entry || args.source !== "wyy" || args.accountId !== "42" ||
      Object.keys(args).length !== (transport.fmCursor === undefined ? 2 : 3) || args.cursor !== transport.fmCursor) {
      publish({ error: "OWNED_RPC_ROUTING_REJECTED" }); return;
    }
    publish({ result: JSON.stringify(transport.reply) });
  },
}));

beforeEach(() => {
  vi.resetModules(); transport.reply = null; transport.fmCursor = undefined; transport.listeners.clear();
  vi.stubGlobal("window", Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
  vi.stubGlobal("fetch", () => { throw new Error("Live HTTP is forbidden in owned facade fixtures"); });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("account recommendation source facade", () => {
  it("returns the account daily list in its upstream order and with its original song IDs", async () => {
    transport.reply = {
      source: "wyy", kind: "daily", accountId: "42", fetchedAt: 1_794_204_000_000,
      items: [
        { id: "wyy_900", name: "First upstream song", singer: "A", album: "", picUrl: "", interval: 180, musicId: "900" },
        { id: "wyy_100", name: "Second upstream song", singer: "A", album: "", picUrl: "", interval: 240, musicId: "100" },
      ],
    };
    const sources = await import("@/source-scripts");
    const batch = await sources.accountDailySongs("wyy", "42");
    expect(batch.items.map((song) => [song.id, song.musicId])).toEqual([
      ["wyy_900", "900"], ["wyy_100", "100"],
    ]);
  });

  it("rejects a result belonging to a different account instead of displaying it as this account's list", async () => {
    transport.reply = { source: "wyy", kind: "daily", accountId: "other-account", fetchedAt: 1_794_204_000_000, items: [] };
    const sources = await import("@/source-scripts");
    await expect(sources.accountDailySongs("wyy", "42")).rejects.toThrow("ACCOUNT_CHANGED");
  });

  it("retrieves an account FM batch using only the scoped identity and opaque upstream cursor", async () => {
    transport.fmCursor = "opaque-previous-cursor";
    transport.reply = { source: "wyy", kind: "fm", accountId: "42", fetchedAt: 1_794_204_000_000,
      cursor: "opaque-next-cursor", items: [{ id: "wyy_7", name: "FM upstream", singer: "A", album: "", picUrl: "", interval: 180, musicId: "7" }] };
    const sources = await import("@/source-scripts");
    const batch = await sources.accountFmNext("wyy", "42", transport.fmCursor);
    expect(batch.cursor).toBe("opaque-next-cursor");
    expect(batch.items.map(song => song.id)).toEqual(["wyy_7"]);
  });
});
