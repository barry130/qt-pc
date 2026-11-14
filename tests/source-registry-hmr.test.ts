/**
 * 与 auth-hmr.test.ts 一样编译并执行真实生产源码，仅替换模块外部边界。
 * Node 的内存 EventTarget 模拟 window，避免 jsdom 与 esbuild 的跨 realm 冲突。
 */
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import * as react from "react";
import * as zustand from "zustand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as policyModel from "@/lib/source-policy-model";
import type { SourcePolicy } from "@/lib/source-policy-model";

type SourceRegistryModule = typeof import("@/stores/sourceRegistry");
type HotData = Record<string, unknown>;
type Hot = {
  data: HotData;
  dispose: (callback: (data: HotData) => void) => void;
  runDispose: () => void;
};
type Registry = {
  sources: Array<{ id: string; name: string; short: string; color: string; qualities: string[] }>;
  qualities: Array<{ id: string; name: string }>;
  sourcePolicyVersion: number;
};

const source = readFileSync(new URL("../src/stores/sourceRegistry.ts", import.meta.url), "utf8");
const compiled = transformSync(source, {
  loader: "ts",
  format: "cjs",
  define: { "import.meta.hot": "__hot" },
}).code;

const h = {
  registry: null as Registry | null,
  policy: { version: 1, enabled: ["qq"], order: ["qq"] } as SourcePolicy,
  policyError: "",
  nativeEvents: new EventTarget(),
  deferListen: false,
  finishListens: [] as Array<() => void>,
  hotModules: [] as Hot[],
  activeSourceId: "qq",
  setActiveSource: vi.fn((id: string) => { h.activeSourceId = id; }),
};

const QQ_REGISTRY: Registry = {
  sources: [{ id: "qq", name: "QQ音乐", short: "QQ", color: "#31c27c", qualities: ["128"] }],
  qualities: [{ id: "128", name: "标准 128k" }],
  sourcePolicyVersion: 1,
};
const WYY_REGISTRY: Registry = {
  sources: [{ id: "wyy", name: "网易云音乐", short: "网易云", color: "#e6172f", qualities: ["128"] }],
  qualities: [{ id: "128", name: "标准 128k" }],
  sourcePolicyVersion: 1,
};

/** native 注册完成时才返回 unlisten，可将完成点推迟到 HMR dispose 之后。 */
function listenNative(name: string, callback: () => void): Promise<() => void> {
  const events = h.nativeEvents;
  return new Promise((resolve) => {
    const register = (): void => {
      events.addEventListener(name, callback);
      resolve(() => events.removeEventListener(name, callback));
    };
    if (h.deferListen) h.finishListens.push(register);
    else register();
  });
}

function loadSourceRegistry(hot: Hot): SourceRegistryModule {
  const module = { exports: {} };
  const dependencies: Record<string, unknown> = {
    zustand,
    react,
    "@tauri-apps/api/event": { listen: listenNative },
    "@/source-scripts": {
      DEFAULT_SEARCH_PAGE_MAX: 20,
      getSourceRegistry: vi.fn(async () => h.registry),
      fetchSourceQualityProfile: vi.fn(async () => ({ mode: "third-party", qualities: [] })),
    },
    "@/source-engine/client": { onEnginePhaseChange: vi.fn(() => () => {}) },
    "@/stores/musicSource": {
      useMusicSourceStore: {
        getState: () => ({ activeSourceId: h.activeSourceId, setActiveSource: h.setActiveSource }),
      },
    },
    "@/services/ipc": {
      SOURCE_META_CHANGED_EVENT: "source-meta-changed",
      SOURCE_PACK_CHANGED_EVENT: "source-pack-changed",
    },
    "@/lib/source-auth": {
      SOURCE_PLAY_LOGIN_CHANGED_EVENT: "qt-source-play-login-changed",
      sourceVipTierOf: vi.fn(() => "free"),
    },
    "@/lib/source-quality": {
      setSourceDownloadQuality: vi.fn(async () => {}),
      setSourcePlayQuality: vi.fn(async () => {}),
      sourceDownloadQualityOf: vi.fn(() => "128"),
      sourcePlayQualityOf: vi.fn(() => "128"),
    },
    "@/lib/source-policy": {
      policyOrder: policyModel.policyOrder,
      readSourcePolicy: vi.fn(async () => h.policy),
      sourcePolicyError: vi.fn(() => h.policyError),
      sourcePolicySnapshot: vi.fn(() => ({
        version: 1,
        enabled: h.policy.enabled === null ? null : [...h.policy.enabled],
        order: [...h.policy.order],
      })),
      SOURCE_POLICY_CHANGED_EVENT: "qt-source-policy-changed",
    },
    "@/lib/source-policy-model": policyModel,
  };
  const requireDependency = (name: string): unknown => {
    if (!(name in dependencies)) throw new Error(`未模拟的模块：${name}`);
    return dependencies[name];
  };
  new Function("require", "module", "exports", "__hot", compiled)(
    requireDependency, module, module.exports, hot,
  );
  return module.exports as SourceRegistryModule;
}

function createHot(data: HotData = {}): Hot {
  const callbacks: Array<(data: HotData) => void> = [];
  const hot: Hot = {
    data,
    dispose: (callback) => { callbacks.push(callback); },
    runDispose: () => {
      for (const callback of callbacks.splice(0)) callback(data);
    },
  };
  h.hotModules.push(hot);
  return hot;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
  h.registry = QQ_REGISTRY;
  h.policy = { version: 1, enabled: ["qq"], order: ["qq"] };
  h.policyError = "";
  h.nativeEvents = new EventTarget();
  h.deferListen = false;
  h.finishListens = [];
  h.hotModules = [];
  h.activeSourceId = "qq";
  h.setActiveSource.mockClear();
});

afterEach(() => {
  for (const hot of h.hotModules) hot.runDispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("sourceRegistry HMR 生命周期", () => {
  it("销毁旧模块后，策略事件不会再把当前音源改成旧来源或 local", async () => {
    const hot = createHot();
    const oldModule = loadSourceRegistry(hot);
    await oldModule.useSourceRegistryStore.getState().ensure();
    expect(oldModule.registrySourceIds()).toEqual(["qq"]);
    expect(h.activeSourceId).toBe("qq");

    hot.runDispose();
    h.registry = WYY_REGISTRY;
    h.policy = { version: 1, enabled: ["wyy"], order: ["wyy"] };
    const newModule = loadSourceRegistry(createHot(hot.data));
    await newModule.useSourceRegistryStore.getState().ensure();
    expect(newModule.registrySourceIds()).toEqual(["wyy"]);
    expect(h.activeSourceId).toBe("wyy");

    window.dispatchEvent(new CustomEvent("qt-source-policy-changed"));
    await Promise.resolve();

    expect(h.activeSourceId).toBe("wyy");
    expect(newModule.registrySourceIds()).toEqual(["wyy"]);
  });

  it("native listen 在 dispose 后才完成时，广播只刷新当前模块而不推动旧 store", async () => {
    h.deferListen = true;
    const hot = createHot();
    const oldModule = loadSourceRegistry(hot);
    await oldModule.useSourceRegistryStore.getState().ensure();
    expect(oldModule.registrySourceIds()).toEqual(["qq"]);

    hot.runDispose();
    for (const finishListen of h.finishListens.splice(0)) finishListen();
    await Promise.resolve();
    await Promise.resolve();
    h.deferListen = false;
    h.registry = WYY_REGISTRY;
    h.policy = { version: 1, enabled: ["wyy"], order: ["wyy"] };
    const newModule = loadSourceRegistry(createHot(hot.data));
    await newModule.useSourceRegistryStore.getState().ensure();
    expect(newModule.registrySourceIds()).toEqual(["wyy"]);

    h.registry = {
      ...WYY_REGISTRY,
      sources: [{ ...WYY_REGISTRY.sources[0]!, name: "新版网易云音乐" }],
    };
    h.nativeEvents.dispatchEvent(new Event("source-meta-changed"));
    await vi.advanceTimersByTimeAsync(2500);

    // 正控制：总线确实推送到了仍有效的新模块，非「完全没派发事件」的假通过。
    expect(newModule.useSourceRegistryStore.getState().catalog[0]?.name).toBe("新版网易云音乐");
    expect(oldModule.registrySourceIds()).toEqual(["qq"]);
    expect(h.activeSourceId).toBe("wyy");
  });
});
