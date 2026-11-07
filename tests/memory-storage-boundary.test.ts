// 纯内存 Storage 边界（node 环境）。
//
// 审计背景：source-tag / keep-alive 这类用例没有显式 Storage fixture，而真实
// `stores/musicSource` 模块顶层会调 `migrateLegacyStorageKey`。默认 node 环境下
// `globalThis.localStorage` 可能是本机 Node 25 的 `--localstorage-file` 宿主对象，
// 于是「import 一个 store」就会碰真实 localStorage 文件。这里用真实公开迁移 API
// 与 fake 宿主 Storage 验证边界：安装后 globalThis / window 必须指向同一个纯内存对象。
import { afterEach, describe, expect, it, vi } from "vitest";

// Observe the runner-installed boundary before this test module imports any
// production code. Descriptor inspection never evaluates a host Storage getter.
const setupSnapshot = vi.hoisted(() => ({
  globalStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
  window: Object.getOwnPropertyDescriptor(globalThis, "window"),
  windowStorage: typeof window === "undefined"
    ? undefined
    : Object.getOwnPropertyDescriptor(window, "localStorage"),
}));

import { migrateLegacyStorageKey } from "@/lib/legacy-storage";
import {
  installMemoryStorageBoundary,
  type MemoryStorageBoundary,
} from "./helpers/memory-storage-boundary";

let boundary: MemoryStorageBoundary | null = null;

afterEach(() => {
  boundary?.restore();
  boundary = null;
  if (setupSnapshot.window) {
    Object.defineProperty(globalThis, "window", setupSnapshot.window);
  } else {
    delete (globalThis as { window?: unknown }).window;
  }
  vi.resetModules();
});

describe("global setup storage isolation", () => {
  it("global setup installs memory storage before production imports", async () => {
    const storage = setupSnapshot.globalStorage?.value as Storage;
    expect(storage).toBeDefined();
    expect(setupSnapshot.globalStorage?.get).toBeUndefined();
    expect(typeof storage.getItem).toBe("function");
    expect(globalThis.localStorage).toBe(storage);
    if (setupSnapshot.window) {
      expect(setupSnapshot.windowStorage?.value).toBe(storage);
      expect(window.localStorage).toBe(storage);
    }

    const legacyValue = JSON.stringify({
      state: { activeSourceId: "qq", aggregateMode: true },
      version: 1,
    });
    vi.resetModules();
    storage.setItem("lightlisten.music-source", legacyValue);
    try {
      // No explicit helper installation: the runner's global setup must already
      // protect the real top-level migration and synchronous persist hydrate.
      const { useMusicSourceStore } = await import("@/stores/musicSource");
      expect(storage.getItem("quietmusic.music-source")).toBe(legacyValue);
      expect(useMusicSourceStore.getState().activeSourceId).toBe("qq");
      expect(useMusicSourceStore.getState().aggregateMode).toBe(true);
    } finally {
      storage.clear();
    }
  });
});

describe("内存 Storage 边界：安装位置", () => {
  it("node 环境安装到 globalThis.localStorage，而不是宿主 Storage", () => {
    boundary = installMemoryStorageBoundary();

    expect(globalThis.localStorage).toBe(boundary.storage);
    boundary.storage.setItem("probe", "1");
    expect(globalThis.localStorage.getItem("probe")).toBe("1");
  });

  it("window 存在时与 globalThis 指向同一个 Storage 对象", () => {
    Object.defineProperty(globalThis, "window", {
      value: {},
      configurable: true,
      writable: true,
    });

    boundary = installMemoryStorageBoundary();

    expect(globalThis.window.localStorage).toBe(boundary.storage);
    expect(globalThis.localStorage).toBe(boundary.storage);
  });

  it("restore 还原安装前的描述符", () => {
    const before = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

    boundary = installMemoryStorageBoundary();
    boundary.restore();
    boundary = null;

    expect(Object.getOwnPropertyDescriptor(globalThis, "localStorage")).toEqual(before);
  });
});

describe("内存 Storage 边界：Web Storage 契约", () => {
  it("getItem/setItem/removeItem/clear/length/key 与字符串化一致", () => {
    boundary = installMemoryStorageBoundary();
    const storage = boundary.storage;

    expect(storage.length).toBe(0);
    storage.setItem("a", "1");
    storage.setItem("b", 2 as unknown as string);
    expect(storage.length).toBe(2);
    expect(storage.getItem("a")).toBe("1");
    expect(storage.getItem("b")).toBe("2");
    expect(storage.key(0)).toBe("a");
    expect(storage.key(1)).toBe("b");
    expect(storage.key(9)).toBeNull();
    expect(storage.getItem("missing")).toBeNull();

    storage.removeItem("a");
    expect(storage.length).toBe(1);
    expect(storage.getItem("a")).toBeNull();

    storage.clear();
    expect(storage.length).toBe(0);
    expect(storage.key(0)).toBeNull();
  });
});

describe("内存 Storage 边界：真实迁移与真实 store 导入", () => {
  it("真实 migrateLegacyStorageKey 只单向拷贝旧键，且不覆盖已有新键", () => {
    boundary = installMemoryStorageBoundary();
    const storage = boundary.storage;
    const legacyValue = JSON.stringify({
      state: { activeSourceId: "qq", aggregateMode: true },
      version: 1,
    });
    storage.setItem("lightlisten.music-source", legacyValue);

    migrateLegacyStorageKey("quietmusic.music-source");

    expect(storage.getItem("quietmusic.music-source")).toBe(legacyValue);
    // 旧键保留，只做「新键缺失」时的一次性拷贝。
    expect(storage.getItem("lightlisten.music-source")).toBe(legacyValue);

    storage.setItem("quietmusic.music-source", "user-choice");
    migrateLegacyStorageKey("quietmusic.music-source");
    expect(storage.getItem("quietmusic.music-source")).toBe("user-choice");

    // 非 quietmusic.* 键直接忽略。
    migrateLegacyStorageKey("lightlisten.other");
    expect(storage.getItem("lightlisten.other")).toBeNull();
  });

  it("在生产模块 import 之前安装：musicSource 顶层迁移写入假 Storage 并完成 hydrate", async () => {
    vi.resetModules();
    boundary = installMemoryStorageBoundary();
    const storage = boundary.storage;
    const legacyValue = JSON.stringify({
      state: { activeSourceId: "qq", aggregateMode: true },
      version: 1,
    });
    storage.setItem("lightlisten.music-source", legacyValue);

    // 真实生产模块：顶层会跑 migrateLegacyStorageKey，zustand persist 随即同步 hydrate。
    const { useMusicSourceStore } = await import("@/stores/musicSource");

    expect(storage.getItem("quietmusic.music-source")).toBe(legacyValue);
    expect(useMusicSourceStore.getState().activeSourceId).toBe("qq");
    expect(useMusicSourceStore.getState().aggregateMode).toBe(true);
  });
});
