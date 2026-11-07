// @vitest-environment node
import { readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const html = readFileSync(new URL("../src-tauri/src/source_engine_page.html", import.meta.url), "utf8");
const pageModule = html.match(/<script\s+type="module">([\s\S]*?)<\/script>/)?.[1];
if (!pageModule) throw new Error("source-engine page module missing");

/** Execute the real page, not a copy of its private guard. Both IPC and fetch are fake boundaries. */
async function openEngine(href = "http://tauri.localhost/source-engine/index.html", rtcLockedByNative = false) {
  const nativeFetch = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response("", { status: 200 }));
  const invoke = vi.fn(async (command: string) => command === "source_state"
    ? { packs: [], activeMetaId: null, activePackId: null }
    : null);
  const networkConstructors = Object.fromEntries([
    "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker",
    "RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection",
    "RTCDataChannel", "RTCIceGatherer", "RTCIceTransport", "RTCDtlsTransport", "WebTransport",
  ].map(name => [name, vi.fn(function fakeNetworkConstructor() { return {}; })]));
  const sendBeacon = vi.fn(() => true);
  const location = new URL(href);
  const context = createContext({
    URL, URLSearchParams, Request, Response, TextEncoder, TextDecoder,
    ...networkConstructors,
    location, navigator: { sendBeacon }, fetch: nativeFetch,
    Window: { prototype: { fetch: nativeFetch } }, Navigator: { prototype: { sendBeacon } },
    __TAURI_INTERNALS__: { invoke, transformCallback: vi.fn(() => 1) },
  });
  context.window = context;
  if (rtcLockedByNative) {
    for (const name of [
      "RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection",
      "RTCDataChannel", "RTCIceGatherer", "RTCIceTransport", "RTCDtlsTransport", "WebTransport",
    ]) Object.defineProperty(context, name, { value: undefined, writable: false, configurable: false });
  }
  await new Script(`(async () => { ${pageModule} })()`, { filename: "source_engine_page.html" })
    .runInContext(context, { timeout: 1_000 });
  expect(invoke).toHaveBeenCalledWith("source_state");
  expect(nativeFetch).not.toHaveBeenCalled();
  return { fetch: context.fetch as typeof fetch, nativeFetch, context, networkConstructors, sendBeacon };
}

describe("source-engine real-page network boundary", () => {
  it("cannot restore native fetch by replacing or deleting the guarded global", async () => {
    const page = await openEngine();
    Reflect.set(page.context, "fetch", page.nativeFetch);
    Reflect.deleteProperty(page.context, "fetch");
    try { Object.defineProperty(page.context, "fetch", { value: page.nativeFetch, writable: true, configurable: true }); } catch { /* frozen */ }
    const prototype = Object.create(Object.getPrototypeOf(page.context));
    Object.defineProperty(prototype, "fetch", { value: page.nativeFetch });
    Object.setPrototypeOf(page.context, prototype);
    await expect(new Script('fetch("https://network.audit.invalid/reopen")').runInContext(page.context)).rejects.toThrow();
    expect(page.nativeFetch).not.toHaveBeenCalled();
  });

  it("cannot bypass guarded fetch by calling its native interface prototype", async () => {
    const page = await openEngine();
    await expect(new Script('Window.prototype.fetch.call(window, "https://network.audit.invalid/reopen")').runInContext(page.context)).rejects.toThrow();
    expect(page.nativeFetch).not.toHaveBeenCalled();
  });

  it("cannot bypass beacon denial by calling its native Navigator prototype", async () => {
    const page = await openEngine();
    expect(() => new Script('Navigator.prototype.sendBeacon.call(navigator, "https://network.audit.invalid/reopen", "BEACON_CANARY")').runInContext(page.context)).toThrow();
    expect(page.sendBeacon).not.toHaveBeenCalled();
  });

  it.each(["XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker"])(
    "cannot recover native %s after global/prototype tampering", async (name) => {
      const page = await openEngine();
      const original = page.networkConstructors[name];
      Reflect.set(page.context, name, original);
      Reflect.deleteProperty(page.context, name);
      try { Object.defineProperty(page.context, name, { value: original, writable: true, configurable: true }); } catch { /* frozen */ }
      const prototype = Object.create(Object.getPrototypeOf(page.context));
      Object.defineProperty(prototype, name, { value: original });
      Object.setPrototypeOf(page.context, prototype);
      expect(() => new Script(`new ${name}("https://network.audit.invalid/reopen")`).runInContext(page.context)).toThrow();
      expect(original).not.toHaveBeenCalled();
    },
  );

  it("cannot recover native beacon after navigator property/prototype tampering", async () => {
    const page = await openEngine();
    const navigator = page.context.navigator;
    Reflect.set(navigator, "sendBeacon", page.sendBeacon);
    Reflect.deleteProperty(navigator, "sendBeacon");
    try { Object.defineProperty(navigator, "sendBeacon", { value: page.sendBeacon, writable: true, configurable: true }); } catch { /* frozen */ }
    const prototype = Object.create(Object.getPrototypeOf(navigator));
    Object.defineProperty(prototype, "sendBeacon", { value: page.sendBeacon });
    Object.setPrototypeOf(navigator, prototype);
    expect(() => new Script('navigator.sendBeacon("https://network.audit.invalid/reopen", "BEACON_CANARY")').runInContext(page.context)).toThrow();
    expect(page.sendBeacon).not.toHaveBeenCalled();
  });

  it.each([
    "RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection",
    "RTCDataChannel", "RTCIceGatherer", "RTCIceTransport", "RTCDtlsTransport", "WebTransport",
  ])("cannot restore direct networking through %s", async (name) => {
    const page = await openEngine();
    const original = page.networkConstructors[name];
    Reflect.set(page.context, name, original);
    try { Object.defineProperty(page.context, name, { value: original, configurable: true, writable: true }); } catch { /* locked */ }
    const prototype = Object.create(Object.getPrototypeOf(page.context));
    Object.defineProperty(prototype, name, { value: original });
    Object.setPrototypeOf(page.context, prototype);
    expect(() => new Script(`new ${name}()`).runInContext(page.context)).toThrow();
    expect(original).not.toHaveBeenCalled();
  });

  it("keeps IPC/local loading when native DocumentStart already froze RTC APIs", async () => {
    const page = await openEngine(undefined, true);
    await page.fetch("ipc://localhost/test", { method: "POST", body: "IPC_CANARY" });
    await page.fetch("/script/fake/meta-bundle.js");
    expect(page.nativeFetch).toHaveBeenCalledTimes(2);
    for (const constructor of Object.values(page.networkConstructors)) expect(constructor).not.toHaveBeenCalled();
  });

  it.each([
    "https://ipc.localhost.audit.invalid/test",
    "http://ipc.localhost@audit.invalid/test",
    "http://user:canary@ipc.localhost/test",
    "https://ipc.localhost:444/test",
    "http://ipc.localhost:81/test",
    "http://ipc.localhost./test",
    "ipc://audit.invalid/test",
    "ipc://localhost:99/test",
    "ipc://canary@localhost/test",
    "ftp://ipc.localhost/test",
    "//audit.invalid/test",
    "/\\audit.invalid/test",
    "https://api.audit.invalid/test",
  ])("rejects disguised/non-IPC endpoint %s without native dispatch", async (url) => {
    const page = await openEngine();
    await expect(page.fetch(url, { method: "POST", body: "NETWORK_CANARY" })).rejects.toThrow();
    expect(page.nativeFetch).not.toHaveBeenCalled();
  });

  it.each([
    "http://ipc.localhost/test", "http://ipc.localhost:80/test",
    "https://ipc.localhost/test", "https://ipc.localhost:443/test", "ipc://localhost/test",
    "/script/fake/meta-bundle.js", "./meta-bundle.js", "http://tauri.localhost/script/fake/chain.json",
  ])("keeps genuine IPC and same-origin endpoint %s", async (url) => {
    const page = await openEngine();
    await page.fetch(url, { method: "POST", body: "IPC_CANARY" });
    expect(page.nativeFetch).toHaveBeenCalledOnce();
    const [input, init] = page.nativeFetch.mock.calls[0];
    expect(String(input)).toBe(new URL(url, "http://tauri.localhost/source-engine/index.html").href);
    expect(init).toMatchObject({ method: "POST", body: "IPC_CANARY", redirect: "error" });
  });

  it("validates real URL/Request inputs but rejects coercion and .url spoofing", async () => {
    const page = await openEngine();
    await page.fetch(new URL("http://ipc.localhost/test"));
    await page.fetch(new Request("https://ipc.localhost/test", { method: "POST", body: "IPC_CANARY" }));
    expect(page.nativeFetch).toHaveBeenCalledTimes(2);
    await expect(page.fetch(new Request("https://ipc.localhost.audit.invalid/test"))).rejects.toThrow();
    const disguised = { url: "http://ipc.localhost/test", toString: () => "https://audit.invalid/test" };
    await expect(page.fetch(disguised as unknown as Request)).rejects.toThrow();
    expect(page.nativeFetch).toHaveBeenCalledTimes(2);
  });

  it("cannot reopen native network access by replacing URL prototype getters", async () => {
    const page = await openEngine();
    const descriptor = Object.getOwnPropertyDescriptor(URL.prototype, "hostname")!;
    try {
      Object.defineProperty(URL.prototype, "hostname", { configurable: true, get: () => "ipc.localhost" });
      await expect(page.fetch("https://api.audit.invalid/test")).rejects.toThrow();
      expect(page.nativeFetch).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(URL.prototype, "hostname", descriptor);
    }
  });

  it("does not equate two opaque custom-scheme origins ('null')", async () => {
    const page = await openEngine("qtres://localhost/source-engine/index.html");
    await page.fetch("/script/fake/chain.json");
    await page.fetch("qtres://localhost/script/fake/chain.json");
    await expect(page.fetch("qtres://audit.invalid/script/fake/chain.json")).rejects.toThrow();
    await expect(page.fetch("other://localhost/script/fake/chain.json")).rejects.toThrow();
    expect(page.nativeFetch).toHaveBeenCalledTimes(2);
  });
});
