import { useEffect, useRef, useState } from "react";
import type { Track } from "@/types";

/** 每个列表实例的缓存有上限；当前列表本身超过上限时允许保留整张列表。 */
const CACHE_LIMIT = 4096;

type FlagQuery = (tracks: Track[]) => Promise<boolean[]>;
type TrackKey = (track: Track) => string;
interface FlagCache {
  version: number;
  values: Map<string, boolean>;
  pending: Map<string, Promise<void>>;
  visible: Set<string>;
}
interface FlagSnapshot {
  version: number;
  values: ReadonlyMap<string, boolean>;
}

function trimCache(cache: FlagCache): void {
  const limit = Math.max(CACHE_LIMIT, cache.visible.size);
  for (const key of cache.values.keys()) {
    if (cache.values.size <= limit) break;
    if (!cache.visible.has(key)) cache.values.delete(key);
  }
}

/**
 * 按判定所用字段关联结果，不能按旧数组下标套到新列表上。
 * 缓存限定在当前 hook 实例和规则版本内：搜索/重排/翻页只查新增项，
 * 相同项的并发请求共享结果；版本变化立即隐藏旧标记，迟到回执不污染新版本。
 * 收藏与屏蔽各自传入 keyOf，屏蔽仍由 Rust 归一化判定。
 */
export function useTrackFlags(
  tracks: Track[],
  version: number,
  query: FlagQuery,
  keyOf: TrackKey,
): boolean[] {
  const cacheRef = useRef<FlagCache | null>(null);
  const [snapshot, setSnapshot] = useState<FlagSnapshot>(() => ({
    version,
    values: new Map(),
  }));

  useEffect(() => {
    let cache = cacheRef.current;
    if (!cache || cache.version !== version) {
      cache = { version, values: new Map(), pending: new Map(), visible: new Set() };
      cacheRef.current = cache;
    }
    const currentCache = cache;
    const requested = new Map(tracks.map((track) => [keyOf(track), track]));
    currentCache.visible = new Set(requested.keys());
    trimCache(currentCache);
    const missing = [...requested].filter(
      ([key]) => !currentCache.values.has(key) && !currentCache.pending.has(key),
    );
    if (missing.length > 0) {
      // 通过 microtask 同时兜住同步 throw，并先登记 pending 以共享重复请求。
      const task = Promise.resolve()
        .then(() => query(missing.map(([, track]) => track)))
        .then((flags) => {
          // 协议异常整批舍弃，不缓存 false，后续列表刷新仍能重试。
          if (!Array.isArray(flags) || flags.length !== missing.length ||
            flags.some((flag) => typeof flag !== "boolean")) return;
          missing.forEach(([key], index) => currentCache.values.set(key, flags[index]));
          // 迟到请求即使已被 effect 清理，也不能无上限填充旧列表缓存。
          trimCache(currentCache);
        })
        .catch(() => {})
        .finally(() => {
          for (const [key] of missing) currentCache.pending.delete(key);
        });
      for (const [key] of missing) currentCache.pending.set(key, task);
    }

    let disposed = false;
    const pending = new Set(
      [...requested.keys()].flatMap((key) => {
        const task = currentCache.pending.get(key);
        return task ? [task] : [];
      }),
    );
    void Promise.all(pending).then(() => {
      if (disposed || cacheRef.current !== currentCache) return;
      // 优先淘汰当前列表以外的旧项；保留当前项避免长列表来回重复查。
      trimCache(currentCache);
      const values = new Map(currentCache.values);
      setSnapshot((previous) => {
        if (previous.version === version && previous.values.size === values.size &&
          [...values].every(([key, flag]) => previous.values.get(key) === flag)) return previous;
        return { version, values };
      });
    });
    return () => { disposed = true; };
  }, [tracks, version, query, keyOf]);

  // render 阶段就按当前 key 映射，搜索切换后的第一帧也不会闪到别行。
  return tracks.map((track) => snapshot.version === version && snapshot.values.get(keyOf(track)) === true);
}
