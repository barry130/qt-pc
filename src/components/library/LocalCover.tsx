import { useEffect, useState } from "react";
import * as ipc from "@/services/ipc";

/**
 * 本地音频内嵌封面（ID3v2 APIC / FLAC PICTURE）。
 *
 * 读封面要走 symphonia 解容器 + 解标签，列表里每行都读一次代价不小，
 * 因此按文件路径做进程内缓存，且同一路径的并发请求合并成一个 Promise。
 * 没有封面的文件也会缓存 null，避免反复重试。
 */

const cache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

function load(path: string): Promise<string | null> {
  if (cache.has(path)) return Promise.resolve(cache.get(path) ?? null);
  const inflight = pending.get(path);
  if (inflight) return inflight;
  const task = ipc
    .getLocalCover(path)
    .then((v) => {
      cache.set(path, v);
      return v;
    })
    .catch(() => {
      cache.set(path, null);
      return null;
    })
    .finally(() => {
      pending.delete(path);
    });
  pending.set(path, task);
  return task;
}

export function LocalCover(props: {
  /** 本地曲目的 Track.id，即文件绝对路径 */
  path: string;
  className?: string;
  alt?: string;
}): React.JSX.Element | null {
  const { path, className, alt = "" } = props;
  const [src, setSrc] = useState<string | null>(cache.get(path) ?? null);

  useEffect(() => {
    if (cache.has(path)) {
      setSrc(cache.get(path) ?? null);
      return;
    }
    let alive = true;
    setSrc(null);
    void load(path).then((v) => {
      if (alive) setSrc(v);
    });
    return () => {
      alive = false;
    };
  }, [path]);

  if (!src) return null;
  return <img src={src} alt={alt} className={className} loading="lazy" />;
}
