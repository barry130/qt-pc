/**
 * 「在飞 + 已落定」两级字符串缓存（进程内）。
 *
 * 收敛 artist-id.ts / artist-pic.ts 原来各写一份的同构缓存管理：
 * 同 key 并发请求只查一次（pending 去重）、结果同步可读（settled）、
 * 超容量先逐出最旧、失败也落缓存（空串）—— 最后这条是两个调用方共同的策略：
 * 查不到就别每次进页都重发同一个注定失败的请求。
 */
export interface PendingStringCache {
  /** 已落定的值（同步读，组件首帧就能拿到）；没解析过返回 null */
  peek(key: string): string | null;
  /**
   * 解析一个值：同 key 在飞直接复用那个 Promise；`factory` 拿到的是
   * 「只管算值」的活，落缓存/失败兜空串/去重/逐出都由这里管。
   */
  resolve(key: string, factory: () => Promise<string>): Promise<string>;
  /** 清空全部条目（测试 / 设置页清理），返回清掉的条目数 */
  clear(): number;
}

export function createPendingStringCache(cap: number): PendingStringCache {
  /** 在飞的（含已完成的）：同一 key 并发进页只查一次 */
  const pending = new Map<string, Promise<string>>();
  /** 已落定的结果，同步可读 */
  const settled = new Map<string, string>();

  function trim(): void {
    while (pending.size > cap) {
      const oldest = pending.keys().next().value;
      if (oldest === undefined) break;
      pending.delete(oldest);
      settled.delete(oldest);
    }
    while (settled.size > cap) {
      const oldest = settled.keys().next().value;
      if (oldest === undefined) break;
      settled.delete(oldest);
    }
  }

  return {
    peek(key) {
      const value = settled.get(key);
      return value === undefined ? null : value;
    },
    resolve(key, factory) {
      const inflight = pending.get(key);
      if (inflight !== undefined) return inflight;

      const task = (async (): Promise<string> => {
        try {
          const value = await factory();
          settled.set(key, value);
          return value;
        } catch {
          // 失败也落缓存：调用方的策略是「拿不到就按老路走」，
          // 不能每次进页都对同一个注定失败的请求再发一次。
          settled.set(key, "");
          return "";
        }
      })();

      pending.set(key, task);
      trim();
      return task;
    },
    clear() {
      const count = new Set([...pending.keys(), ...settled.keys()]).size;
      pending.clear();
      settled.clear();
      return count;
    },
  };
}
