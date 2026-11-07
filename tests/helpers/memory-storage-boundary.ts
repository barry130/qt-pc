/**
 * Node / jsdom 通用的纯内存 Storage 边界（测试专用）。
 *
 * 为什么需要：本机 Node 25 开着实验性的 `--localstorage-file`，`globalThis.localStorage`
 * 是一个挂在磁盘文件上的宿主对象。真实生产模块（如 `stores/musicSource`）在**模块
 * 顶层**就会调用 `migrateLegacyStorageKey`，只要 Node 测试先 import 它，就会去读写
 * 那个宿主 Storage —— 既污染本机用户数据，也让用例失去确定性。
 *
 * 现有 `tests/helpers/memory-storage.ts` 只处理 jsdom 的 `window.localStorage`，
 * 在默认的 node 环境下 window 不存在，覆盖不到这个入口。本 helper 在测试模块
 * **import 生产模块之前**同时把 `globalThis.localStorage`（以及存在时的
 * `window.localStorage`）替换成同一个纯内存对象，并提供 restore() 还原原描述符。
 *
 * 用法（必须在任何生产模块 import 之前执行）：
 * ```ts
 * import { installMemoryStorageBoundary } from "./helpers/memory-storage-boundary";
 * installMemoryStorageBoundary();
 * ```
 */

export interface MemoryStorageBoundary {
  /** 已安装的纯内存 Storage（globalThis / window 指向同一对象） */
  storage: Storage;
  /** 还原安装前的属性描述符（测试收尾用；setup 里可常驻不还原） */
  restore(): void;
}

interface InstalledTarget {
  target: object;
  descriptor: PropertyDescriptor | undefined;
}

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? (map.get(key) ?? null) : null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
}

export function installMemoryStorageBoundary(): MemoryStorageBoundary {
  const storage = createMemoryStorage();
  const installed: InstalledTarget[] = [];

  const installOn = (target: object): void => {
    installed.push({
      target,
      descriptor: Object.getOwnPropertyDescriptor(target, "localStorage"),
    });
    Object.defineProperty(target, "localStorage", {
      value: storage,
      configurable: true,
      writable: true,
    });
  };

  // 默认 node 环境的入口：Node 25 的 --localstorage-file 占的就是这里。
  installOn(globalThis);

  // jsdom 环境：window 可能是独立对象；若 window 就是 globalThis，上面的安装已覆盖。
  if (typeof window !== "undefined" && (window as unknown as object) !== (globalThis as object)) {
    installOn(window as unknown as object);
  }

  return {
    storage,
    restore() {
      // 后装先还原，避免 window 与 globalThis 互相覆盖时留下半截状态。
      for (let i = installed.length - 1; i >= 0; i -= 1) {
        const { target, descriptor } = installed[i];
        if (descriptor) {
          Object.defineProperty(target, "localStorage", descriptor);
        } else {
          delete (target as { localStorage?: Storage }).localStorage;
        }
      }
      installed.length = 0;
    },
  };
}
