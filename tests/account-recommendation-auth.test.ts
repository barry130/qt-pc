import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  authWait: null as Promise<void> | null,
  authStarted: false,
  authFailure: false,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    if (command === "get_setting") return boundary.settings.get(String(args.key)) ?? null;
    if (command === "set_setting") { boundary.settings.set(String(args.key), String(args.value)); return; }
    if (command === "clear_play_url_cache") return 0;
    throw new Error(`Unexpected native command in owned fixture: ${command}`);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => undefined, emit: async () => undefined }));
vi.mock("@/source-engine/client", () => ({
  INVOKE_TIMEOUT_MS: 20_000,
  onEnginePhaseChange: () => () => undefined,
  engineSnapshot: () => ({ phase: "ready", code: null, detail: null }),
  engineResolve: async () => ({ url: "", line: null, error: "", stalled: false }),
  engineInvoke: async (entry: string) => {
    if (entry === "setAuth") {
      boundary.authStarted = true;
      await boundary.authWait;
      if (boundary.authFailure) throw new Error("fixture injection failed");
      return { ok: true };
    }
    if (entry === "clearAuth") return { ok: true };
    throw new Error(`Unexpected source entry in owned fixture: ${entry}`);
  },
}));

import * as auth from "@/lib/source-auth";
import { SOURCE_AUTH_ACCOUNTS_KEY, SOURCE_AUTH_TOGGLES_KEY } from "@/lib/storageKeys";

beforeEach(() => {
  boundary.settings.clear(); boundary.authWait = null; boundary.authStarted = false; boundary.authFailure = false;
  boundary.settings.set(SOURCE_AUTH_ACCOUNTS_KEY, JSON.stringify({ wyy: {
    cookie: "fixture-not-a-real-cookie", savedAt: "2026-11-09T00:00:00.000Z",
    user: { id: "42", nickname: "Owned fixture", avatar: "", vip: false, vipLabel: "" },
  } }));
  boundary.settings.set(SOURCE_AUTH_TOGGLES_KEY, JSON.stringify({ wyy: { useMeta: true, usePlay: false } }));
  auth.resetSourceAuthCaches();
});

afterEach(() => { vi.useRealTimers(); });

describe("account recommendation metadata-auth barrier", () => {
  it("exposes a non-secret account snapshot only after the engine acknowledges metadata injection", async () => {
    let release!: () => void;
    boundary.authWait = new Promise<void>((resolve) => { release = resolve; });
    let settled = false;
    const ready = auth.prepareSourceMetaAuth("wyy").then((snapshot) => { settled = true; return snapshot; });
    await vi.waitFor(() => expect(boundary.authStarted).toBe(true));
    expect(settled).toBe(false);
    release();
    const snapshot = await ready;
    expect(snapshot).toMatchObject({ sourceId: "wyy", accountId: "42", nickname: "Owned fixture" });
    expect(JSON.stringify(snapshot)).not.toContain("fixture-not-a-real-cookie");
  });

  it("invalidates an issued metadata context as soon as logout begins", async () => {
    const snapshot = await auth.prepareSourceMetaAuth("wyy");
    const logout = auth.removeSourceAuthAccount("wyy");
    expect(auth.sourceMetaAuthRevision("wyy")).not.toBe(snapshot.authRevision);
    await logout;
  });

  it("invalidates the old context when credentials are replaced for the same account", async () => {
    const snapshot = await auth.prepareSourceMetaAuth("wyy");
    await auth.saveSourceAuthAccount("wyy", "fixture-replacement", {
      id: "42", nickname: "Owned fixture", avatar: "", vip: false, vipLabel: "",
    });
    expect(auth.sourceMetaAuthRevision("wyy")).not.toBe(snapshot.authRevision);
  });

  it("revokes a metadata context immediately when data permission is disabled", async () => {
    const snapshot = await auth.prepareSourceMetaAuth("wyy");
    const switching = auth.setSourceAuthToggle("wyy", "meta", false);
    expect(auth.sourceMetaAuthRevision("wyy")).not.toBe(snapshot.authRevision);
    await switching;
  });

  it("gives same-account replacements distinct non-secret persistent sessions even within one clock millisecond", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-09T12:00:00.000Z"));
    const user = { id: "42", nickname: "Owned fixture", avatar: "", vip: false, vipLabel: "" };
    await auth.saveSourceAuthAccount("wyy", "fixture-session-A", user);
    const first = await auth.prepareSourceMetaAuth("wyy");
    await auth.saveSourceAuthAccount("wyy", "fixture-session-B", user);
    const second = await auth.prepareSourceMetaAuth("wyy");
    expect(second.accountSession).not.toBe(first.accountSession);
    expect(second.accountId).toBe(first.accountId);
    expect(JSON.stringify(second)).not.toContain("fixture-session-B");
  });
});
