// @vitest-environment node
import { readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const artifact = readFileSync(new URL("../src-tauri/src/source_engine_rtc_init.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../src-tauri/src/source_engine_page.html", import.meta.url), "utf8");
const pageModule = html.match(/<script\s+type="module">([\s\S]*?)<\/script>/)?.[1];
if (!pageModule) throw new Error("source-engine page module missing");

// Public browser entry points, independently exercised through actual VM dispatch.
const rtcEntries = [
  "RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection",
  "RTCDataChannel", "RTCIceGatherer", "RTCIceTransport", "RTCDtlsTransport", "WebTransport",
];

function freshFrame(href = "about:blank") {
  const factories = Object.fromEntries(rtcEntries.map(name => [name, vi.fn(function fakeRtcFactory() { return {}; })]));
  const fetch = vi.fn(async () => new Response("", { status: 200 }));
  const ipc = vi.fn(async (command: string) => command === "source_state"
    ? { packs: [], activeMetaId: null, activePackId: null } : null);
  const xhr = vi.fn();
  const socket = vi.fn();
  const events = vi.fn();
  const beacon = vi.fn(() => true);
  const frame = createContext({
    ...factories, URL, URLSearchParams, Request, Response, TextEncoder, TextDecoder,
    location: new URL(href), fetch, XMLHttpRequest: xhr, WebSocket: socket, EventSource: events,
    navigator: { sendBeacon: beacon }, __TAURI_INTERNALS__: { invoke: ipc, transformCallback: vi.fn(() => 1) },
  });
  frame.window = frame;
  const initialize = () => new Script(artifact, { filename: "source_engine_rtc_init.js" }).runInContext(frame);
  return { frame, factories, fetch, ipc, xhr, socket, events, beacon, initialize };
}

describe("shared source-engine DocumentStart RTC artifact", () => {
  it.each(rtcEntries)("blocks restoring %s in a fresh frame", (name) => {
    const realm = freshFrame();
    realm.initialize();
    const nativeFactory = realm.factories[name];
    Reflect.set(realm.frame, name, nativeFactory);
    Reflect.deleteProperty(realm.frame, name);
    try { Object.defineProperty(realm.frame, name, { value: nativeFactory, writable: true, configurable: true }); } catch { /* frozen */ }
    const prototype = Object.create(Object.getPrototypeOf(realm.frame));
    Object.defineProperty(prototype, name, { value: nativeFactory });
    Object.setPrototypeOf(realm.frame, prototype);
    expect(() => new Script(`new ${name}()`).runInContext(realm.frame)).toThrow();
    expect(nativeFactory).not.toHaveBeenCalled();
  });

  it("exposes a locked unsafe host capability without abandoning the other RTC locks", () => {
    const realm = freshFrame();
    Object.defineProperty(realm.frame, "RTCPeerConnection", {
      value: realm.factories.RTCPeerConnection, writable: false, configurable: false,
    });
    try { realm.initialize(); } catch { /* Native hosts may ignore initialization-script errors. */ }
    for (const name of rtcEntries.filter(name => name !== "RTCPeerConnection")) {
      expect(() => new Script(`new ${name}()`).runInContext(realm.frame)).toThrow();
      expect(realm.factories[name]).not.toHaveBeenCalled();
    }
    expect(realm.frame.__qtRtcLockFailures).toEqual(["RTCPeerConnection"]);
    expect(Object.isFrozen(realm.frame.__qtRtcLockFailures)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(realm.frame, "__qtRtcLockFailures")).toMatchObject({
      enumerable: false, configurable: false, writable: false,
    });
  });

  it.each(["about:blank", "about:srcdoc", "http://qtres.localhost/engine/index.html"])(
    "is repeatable in %s without touching IPC/local loading capabilities", (href) => {
      const realm = freshFrame(href);
      realm.initialize();
      realm.initialize();
      expect(realm.frame.fetch).toBe(realm.fetch);
      expect(realm.frame.XMLHttpRequest).toBe(realm.xhr);
      expect(realm.frame.WebSocket).toBe(realm.socket);
      expect(realm.frame.EventSource).toBe(realm.events);
      expect(realm.frame.navigator.sendBeacon).toBe(realm.beacon);
      expect(realm.frame.__qtRtcLockFailures).toBeUndefined();
      expect(realm.fetch).not.toHaveBeenCalled();
      expect(realm.ipc).not.toHaveBeenCalled();
    },
  );

  it("fails the actual page before package loading when native RTC freezing was incomplete", async () => {
    const realm = freshFrame("http://qtres.localhost/engine/index.html");
    Object.defineProperty(realm.frame, "RTCPeerConnection", {
      value: realm.factories.RTCPeerConnection, writable: false, configurable: false,
    });
    realm.initialize();
    await expect(new Script(`(async () => { ${pageModule} })()`, { filename: "source_engine_page.html" })
      .runInContext(realm.frame)).rejects.toThrow("音源引擎禁网能力初始化失败");
    expect(realm.ipc).not.toHaveBeenCalled();
    expect(realm.fetch).not.toHaveBeenCalled();
    for (const factory of Object.values(realm.factories)) expect(factory).not.toHaveBeenCalled();
  });

  it("boots the entire actual page after shared DocumentStart and preserves genuine IPC/local fetch", async () => {
    const realm = freshFrame("http://qtres.localhost/engine/index.html");
    realm.initialize();
    await new Script(`(async () => { ${pageModule} })()`, { filename: "source_engine_page.html" })
      .runInContext(realm.frame);
    expect(realm.ipc).toHaveBeenCalledWith("source_state");
    await realm.frame.fetch("ipc://localhost/test", { method: "POST", body: "IPC_CANARY" });
    await realm.frame.fetch("/script/synthetic/meta-bundle.js");
    expect(realm.fetch).toHaveBeenCalledTimes(2);
    for (const factory of Object.values(realm.factories)) expect(factory).not.toHaveBeenCalled();
  });
});
