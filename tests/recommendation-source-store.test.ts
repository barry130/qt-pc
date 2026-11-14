import { beforeEach, describe, expect, it, vi } from "vitest";
import { DAILY_RECOMMEND_MODE_KEY, RECOMMENDATION_SOURCE_KEY } from "@/lib/storageKeys";

const settings = vi.hoisted(() => new Map<string, string>());
const reads = vi.hoisted(() => ({ wait: null as Promise<void> | null }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    if (command === "get_setting") { const value = settings.get(String(args.key)) ?? null; if (args.key === RECOMMENDATION_SOURCE_KEY) await reads.wait; return value; }
    if (command === "set_setting") { settings.set(String(args.key), String(args.value)); return; }
    throw new Error(`Unexpected command: ${command}`);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ emit: async () => undefined, listen: async () => () => undefined }));

beforeEach(() => { settings.clear(); reads.wait = null; vi.resetModules(); });

describe("independent recommendation origins", () => {
  it("persists an account daily selection without changing FM or the shared AI setting", async () => {
    settings.set(DAILY_RECOMMEND_MODE_KEY, "server");
    const { useRecommendationSourceStore } = await import("@/stores/recommendation-source");
    await useRecommendationSourceStore.getState().load();
    await useRecommendationSourceStore.getState().setSelection("daily", { origin: "account", sourceId: "wyy" });
    vi.resetModules();
    const reloaded = (await import("@/stores/recommendation-source")).useRecommendationSourceStore;
    await reloaded.getState().load();
    expect(reloaded.getState().daily).toEqual({ origin: "account", sourceId: "wyy" });
    expect(reloaded.getState().fm.origin).toBe("app");
    expect(settings.get(DAILY_RECOMMEND_MODE_KEY)).toBe("server");
  });

  it("preserves an explicit default-app choice made before delayed account hydration completes", async () => {
    settings.set(RECOMMENDATION_SOURCE_KEY, JSON.stringify({ v: 1, daily: { origin: "account", sourceId: "wyy" }, fm: { origin: "app", sourceId: "" } }));
    let release!: () => void; reads.wait = new Promise<void>(resolve => { release = resolve; });
    const store = (await import("@/stores/recommendation-source")).useRecommendationSourceStore;
    const hydrating = store.getState().load();
    const choosing = store.getState().setSelection("daily", { origin: "app", sourceId: "" });
    release(); await Promise.all([hydrating, choosing]);
    expect(store.getState().daily).toEqual({ origin: "app", sourceId: "" });
    vi.resetModules(); reads.wait = null;
    const reloaded = (await import("@/stores/recommendation-source")).useRecommendationSourceStore;
    await reloaded.getState().load();
    expect(reloaded.getState().daily).toEqual({ origin: "app", sourceId: "" });
  });
});
