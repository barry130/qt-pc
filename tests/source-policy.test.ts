// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/types";
import {
  defaultSourcePolicy, movePolicySource, policyOrder, policySourceEnabled, togglePolicySource,
} from "@/lib/source-policy-model";

const host = vi.hoisted(() => ({
  stored: null as string | null,
  failWrite: false,
  active: "wyy",
  catalog: ["wyy", "qq", "kw"],
  calls: [] as { name: string; args: unknown }[],
  recommendation: null as Promise<Record<string, unknown>> | null,
  resolveError: "",
  listeners: new Map<string, () => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (name: string, args: { policy?: unknown }) => {
    host.calls.push({ name, args });
    if (name === "source_policy_set") {
      if (host.failWrite) throw new Error("disk full");
      host.stored = JSON.stringify(args.policy);
    }
    return 0;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: () => void) => {
    host.listeners.set(name, callback);
    return () => host.listeners.delete(name);
  }),
  emitTo: vi.fn(),
}));
vi.mock("@/services/ipc", async importOriginal => ({
  ...await importOriginal<typeof import("@/services/ipc")>(),
  getSetting: vi.fn(async () => host.stored),
  playUrlCacheEpoch: vi.fn(async () => 1),
}));
vi.mock("@/source-engine/client", () => ({
  INVOKE_TIMEOUT_MS: 20_000,
  onEnginePhaseChange: vi.fn(),
  engineSnapshot: () => ({ phase: "ready", code: 1, detail: null }),
  engineInvoke: async (name: string, args: unknown) => {
    host.calls.push({ name, args });
    if (name === "sourceRegistry") return {
      sources: host.catalog.map(id => ({ id, name: id, short: id, color: "#000000" })),
      qualities: [], sourcePolicyVersion: 1,
    };
    if (name === "sourcePolicyStatus") return { metaSupported: true, playSupported: true };
    if (name === "recommendations" && host.recommendation) return host.recommendation;
    return { list: [], qualities: [] };
  },
  engineResolve: async (source: string) => {
    host.calls.push({ name: "resolve", args: source });
    return { url: host.resolveError ? "" : "https://fixture.invalid/kw.mp3",
      line: { id: "kw", name: "酷我", kind: "cross" }, error: host.resolveError,
      stalled: false, referer: "", size: null, actualQuality: "" };
  },
}));
vi.mock("@/stores/musicSource", () => ({
  useMusicSourceStore: {
    getState: () => ({ activeSourceId: host.active, setActiveSource: (id: string) => { host.active = id; } }),
  },
}));

beforeEach(() => {
  vi.resetModules();
  host.stored = null; host.failWrite = false; host.active = "wyy";
  host.catalog = ["wyy", "qq", "kw"]; host.calls = []; host.recommendation = null;
  host.resolveError = ""; host.listeners.clear();
});

describe("device platform settings at the storage, facade and registry boundaries", () => {
  it("first customization snapshots the catalog and preserves absent platforms and order", () => {
    const catalog = ["wyy", "qq", "kw"];
    const moved = movePolicySource(defaultSourcePolicy(), catalog, "kw", -1);
    expect(moved.order).toEqual(["wyy", "kw", "qq"]);
    expect(moved.enabled).toEqual(catalog);
    const disabled = togglePolicySource(moved, catalog, "qq");
    expect(policySourceEnabled(disabled, "qq")).toBe(false);
    expect(policySourceEnabled(disabled, "new")).toBe(false);
    expect(policyOrder(disabled, [{ id: "kw" }, { id: "new" }]).map(s => s.id)).toEqual(["kw", "new"]);
    const afterPackageChange = togglePolicySource(disabled, ["kw", "new"], "new");
    expect(afterPackageChange.enabled).toEqual(["wyy", "kw", "new"]);
    expect(afterPackageChange.order).toEqual(["wyy", "kw", "qq", "new"]);
    expect(policySourceEnabled({ ...disabled, enabled: [] }, "local")).toBe(true);
    expect(policySourceEnabled({ ...disabled, enabled: [] }, "podcast")).toBe(true);
  });

  it("does not advertise a failed durable write and exposes copies of saved preferences", async () => {
    const policy = await import("@/lib/source-policy");
    await policy.readSourcePolicy();
    host.failWrite = true;
    await expect(policy.saveSourcePolicy({ version: 1, enabled: [], order: [] })).rejects.toThrow("disk full");
    expect(policy.sourcePolicySnapshot().enabled).toBeNull();
    expect(policy.sourcePolicyRevision()).toBe(0);
    host.failWrite = false;
    await policy.saveSourcePolicy({ version: 1, enabled: ["kw"], order: ["kw", "qq"] });
    const snapshot = policy.sourcePolicySnapshot();
    snapshot.enabled!.push("qq");
    snapshot.order.reverse();
    expect(policy.sourceEnabled("qq")).toBe(false);
    expect(policy.sourcePolicySnapshot().order).toEqual(["kw", "qq"]);
    expect(JSON.parse(host.stored!).enabled).toEqual(["kw"]);
  });

  it("corrupt storage fails closed and can be repaired through the normal save path", async () => {
    host.stored = "{bad";
    const policy = await import("@/lib/source-policy");
    await policy.readSourcePolicy();
    expect(policy.sourceEnabled("wyy")).toBe(false);
    expect(policy.sourcePolicyError()).toContain("无法读取");
    await policy.saveSourcePolicy({ version: 1, enabled: ["wyy"], order: [] });
    expect(policy.sourceEnabled("wyy")).toBe(true);
    expect(policy.sourcePolicyError()).toBe("");
  });

  it("native settings changes invalidate an already mounted client", async () => {
    const policy = await import("@/lib/source-policy");
    await policy.readSourcePolicy();
    const generation = policy.sourcePolicyRevision();
    host.stored = '{"version":1,"enabled":[],"order":[]}';
    host.listeners.get(policy.SOURCE_POLICY_NATIVE_EVENT)!();
    await policy.waitSourcePolicy();
    expect(policy.sourceEnabled("wyy")).toBe(false);
    expect(() => policy.assertSourcePolicyCurrent(generation)).toThrow("设置已变化");
  });

  it("all-off blocks new requests and a disable/re-enable cannot revive an old response", async () => {
    const policy = await import("@/lib/source-policy");
    const api = await import("@/source-scripts");
    let complete!: (value: Record<string, unknown>) => void;
    host.recommendation = new Promise(resolve => { complete = resolve; });
    const old = api.getRecommendations("wyy", null, 1);
    const assertion = expect(old).rejects.toThrow("设置已变化");
    await vi.waitFor(() => expect(host.calls.some(c => c.name === "recommendations")).toBe(true));
    await policy.saveSourcePolicy({ version: 1, enabled: [], order: [] });
    await expect(api.getRecommendations("qq", null, 1)).rejects.toThrow("已关闭");
    await policy.saveSourcePolicy({ version: 1, enabled: ["wyy"], order: [] });
    complete({ list: [] });
    await assertion;
    expect(host.calls.filter(c => c.name === "recommendations")).toHaveLength(1);
  });

  it("disabled original tracks still reach the fallback resolver, whose policy errors remain actionable", async () => {
    const policy = await import("@/lib/source-policy");
    const api = await import("@/source-scripts");
    await policy.saveSourcePolicy({ version: 1, enabled: ["kw"], order: ["kw"] });
    const song: Track = { id: "a", platform: "qq", title: "歌", singer: "歌手", album: "", picUrl: "", duration: 180 };
    expect(await api.resolvePlayUrl(song, "320")).toBe("https://fixture.invalid/kw.mp3");
    expect(host.calls.find(c => c.name === "resolve")?.args).toBe("qq");
    host.resolveError = "音乐源已关闭，请在音源包管理中启用";
    await expect(api.resolvePlayUrl(song, "320")).rejects.toThrow("已关闭");
  });

  it("management retains the whole catalog while source navigation follows enablement and priority", async () => {
    const policy = await import("@/lib/source-policy");
    const { useSourceRegistryStore } = await import("@/stores/sourceRegistry");
    await useSourceRegistryStore.getState().ensure();
    await policy.saveSourcePolicy({ version: 1, enabled: ["wyy", "kw"], order: ["kw", "wyy"] });
    const state = useSourceRegistryStore.getState();
    expect(state.catalog.map(s => s.id)).toEqual(["wyy", "qq", "kw"]);
    expect(state.sources.map(s => s.id)).toEqual(["kw", "wyy"]);
    await policy.saveSourcePolicy({ version: 1, enabled: [], order: ["kw", "wyy"] });
    expect(useSourceRegistryStore.getState().sources).toEqual([]);
    expect(host.active).toBe("local");
    host.catalog = ["qq", "kw", "new"];
    await useSourceRegistryStore.getState().refresh();
    expect(useSourceRegistryStore.getState().catalog.map(s => s.id)).toEqual(host.catalog);
    expect(useSourceRegistryStore.getState().sources).toEqual([]);
  });
});
