/**
 * jsdom 环境下的内存 Storage 替身。
 *
 * 为什么不用 jsdom 自带的 `window.localStorage`：本机 Node 25 开着实验性的
 * `--localstorage-file`，会先占住 `globalThis.localStorage`，jsdom 环境里
 * `window.localStorage` 因此拿到一个没有 `clear/getItem` 的残缺对象
 * （报错 `window.localStorage.clear is not a function`）。测试不关心浏览器行为，
 * 只要「存得进、读得回」，用内存实现最稳，也避免用例之间互相污染。
 */
export function installMemoryStorage(): Storage {
  const map = new Map<string, string>();
  const storage: Storage = {
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
  Object.defineProperty(window, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
  return storage;
}
