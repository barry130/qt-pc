import { useEffect } from "react";
import { usePlayerStore } from "@/stores/player";
import { getLocalCover, resolveLocalFile } from "@/services/ipc";
import { qtresCoverUrl } from "@/lib/lrc";
import type { Track } from "@/types";

/**
 * 在播本地文件的封面：文件里有内嵌封面（ID3v2 APIC / FLAC PICTURE）就用它，
 * 没有才回落到在线封面。
 *
 * 为什么需要这一层：本地优先（`play.localFirst`）命中时，**在播的是磁盘文件**，
 * 但曲目的 `platform` 仍是 qq/netease，`state.playUrl` 为 null、`track.picUrl`
 * 是在线地址。用户要的是「文件自带封面优先、没有才走在线」——在线地址本身可能是
 * 错的（同名翻唱）或者干脆没有，而文件里那份就是这首歌的原始封面。
 *
 * 进程内缓存：同一路径只读一次盘（封面解析要读容器标签，不必每切歌重来）。
 */
const coverCache = new Map<string, Promise<string>>();

/**
 * 缓存上限（条）。
 *
 * 每条是一个 data URL——内嵌封面动辄几十到几百 KB，而用户一整晚可能连着放几百首
 * 本地歌，无上限的 Map 就是一条单调上升的内存曲线（评审 2026-10-29 P2）。
 * 8 条足够覆盖「上一首 / 下一首 / 反复切两首」的实际命中率，超出的按 LRU 淘汰。
 */
const COVER_CACHE_LIMIT = 8;

function embeddedCoverOf(path: string): Promise<string> {
  const cached = coverCache.get(path);
  if (cached) {
    // 命中即刷新顺序：Map 保留插入序，删了再塞就挪到队尾（最近使用）
    coverCache.delete(path);
    coverCache.set(path, cached);
    return cached;
  }
  const task = getLocalCover(path)
    .then((url) => url ?? "")
    .catch(() => "");
  coverCache.set(path, task);
  evictCoverCache();
  return task;
}

/** 超出上限时从最久未使用的一端淘汰（Map 的迭代顺序就是插入顺序）。 */
function evictCoverCache(): void {
  while (coverCache.size > COVER_CACHE_LIMIT) {
    const oldest = coverCache.keys().next();
    if (oldest.done === true) return;
    coverCache.delete(oldest.value);
  }
}

/** 清空内嵌封面缓存（退出登录 / 清理临时文件后调用；正常播放期间无需清） */
export function clearEmbeddedCoverCache(): number {
  const n = coverCache.size;
  coverCache.clear();
  return n;
}

/**
 * 当前在播曲目的本地文件路径：本地曲目是 `track.id`（CUE 分轨读封面时会自行去后缀），
 * 在线曲目被本地优先命中时由 `resolve_local_file` 现查（纯读盘/查库，不触发播放）。
 */
async function localPathOf(track: Track): Promise<string> {
  if (track.platform === "local") return track.id;
  const hit = await resolveLocalFile(track).catch(() => null);
  return hit?.path ?? "";
}

/**
 * 维护「当前在播是不是本地文件 + 该文件的内嵌封面」。
 *
 * 挂在 AppShell（全局一处）：`state.isLocal` 是引擎侧唯一权威信号
 * （Rust `PlaybackStateSnapshot.is_local`，本地曲目与本地优先命中都会置 true），
 * 不靠 `platform === "local"` 猜。
 */
export function useNowPlayingLocalMedia(): void {
  const track = usePlayerStore((s) => s.state?.track ?? null);
  const isLocal = usePlayerStore((s) => s.state?.isLocal ?? false);
  const setEmbeddedCover = usePlayerStore((s) => s.setEmbeddedCover);

  const trackKey = track ? `${track.platform}:${track.id}` : "";

  useEffect(() => {
    if (!trackKey) {
      setEmbeddedCover("", "");
      return;
    }
    // 先把这个键占住：切歌瞬间 display hook 就能靠 key 失配丢掉上一首的封面
    setEmbeddedCover(trackKey, "");
    if (!isLocal) return;
    let alive = true;
    // 读实时 store：快照会持续推新对象，effect 不该因为「track 换了个壳」重跑
    const cur = usePlayerStore.getState().state?.track ?? null;
    if (cur === null) return;
    void localPathOf(cur).then(async (path) => {
      if (!alive || path.length === 0) return;
      const url = await embeddedCoverOf(path);
      if (alive && url.length > 0) setEmbeddedCover(trackKey, url);
    });
    return () => {
      alive = false;
    };
    // trackKey 已覆盖 id/platform；isLocal 变化要重新判（同一首歌可能从在线切到本地重载）
  }, [trackKey, isLocal, setEmbeddedCover]);
}

/**
 * 「当前在播」的封面地址：内嵌优先、在线兜底。
 *
 * 只用于在播曲目的展示（播放页大封面 / 播放条 / 迷你条 / 背景取色）。列表行不走这里——
 * 列表有 `LocalCover` 按行读内嵌封面，且不该让几千行都去算「此刻在播」。
 */
export function useNowPlayingCover(px?: number): string | null {
  const picUrl = usePlayerStore((s) => s.state?.track?.picUrl ?? null);
  const track = usePlayerStore((s) => s.state?.track ?? null);
  const embedded = usePlayerStore((s) => s.embeddedCover);
  const embeddedTrack = usePlayerStore((s) => s.embeddedCoverTrack);

  const key = track ? `${track.platform}:${track.id}` : "";
  if (embedded.length > 0 && embeddedTrack === key) return embedded;
  return picUrl ? qtresCoverUrl(picUrl, px) : null;
}
