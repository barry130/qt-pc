import { useEffect } from "react";
import { usePlayerStore } from "@/stores/player";
import { resolveLocalOnlineMeta } from "@/lib/localOnline";

/**
 * 本地曲目播放时补全在线封面：把酷我匹配到的 picUrl 写回播放状态里的 track。
 *
 * 播放页 / 迷你播放条 / 背景取色都统一读 `track.picUrl`，因此只需在这里补一次，
 * 各处自动生效，无需分别适配本地曲目。Rust 推新快照时会重置该字段，所以以
 * `[trackId, picUrl]` 为依赖重放；元数据按路径缓存，重放不产生额外网络请求。
 */
export function useLocalTrackOnlineMeta(): void {
  const track = usePlayerStore((s) => s.state?.track ?? null);
  const local = track !== null && track.platform === "local" ? track : null;
  const trackId = local?.id ?? "";
  const title = local?.title ?? "";
  const singer = local?.singer ?? "";
  const picUrl = local?.picUrl ?? "";

  useEffect(() => {
    if (!trackId || picUrl) return;
    let alive = true;
    void resolveLocalOnlineMeta(trackId, title, singer).then((meta) => {
      if (!alive || !meta.picUrl) return;
      usePlayerStore.setState((s) => {
        const state = s.state;
        const cur = state?.track;
        if (!state || !cur || cur.id !== trackId || cur.picUrl) return {};
        return { state: { ...state, track: { ...cur, picUrl: meta.picUrl } } };
      });
    });
    return () => {
      alive = false;
    };
  }, [trackId, picUrl, title, singer]);
}
