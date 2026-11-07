import { useMemo } from "react";
import { crossSourceForPlayback, type CrossSourceHit } from "@/lib/localOnline";
import { usePlayerStore } from "@/stores/player";
import { useSourceRegistryStore } from "@/stores/sourceRegistry";

/** 播放页与播放条共用实际取链来源，歌曲本身的身份仍供收藏、队列等操作使用。 */
export function useNowPlayingCrossSource(): CrossSourceHit | null {
  const track = usePlayerStore((s) => s.state?.track ?? null);
  const quality = usePlayerStore((s) => s.state?.quality ?? null);
  const playUrl = usePlayerStore((s) => s.state?.playUrl ?? null);
  const isLocal = usePlayerStore((s) => s.state?.isLocal ?? false);
  const generation = useSourceRegistryStore((s) => s.generation);

  return useMemo(() => {
    // 本地播放/尚未取到地址时不能拿上一次在线取链的记忆当作当前来源。
    if (!playUrl || isLocal || track?.platform === "podcast") return null;
    return crossSourceForPlayback(track, quality);
    // 线路记忆在取链时写入，由播放地址和注册表世代变化触发重新读取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, quality, playUrl, isLocal, generation]);
}
