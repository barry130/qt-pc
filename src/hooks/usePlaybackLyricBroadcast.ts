import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  crossSourceForPlayback,
  onPlaybackLyricCached,
  peekCachedPlaybackLyric,
  playbackLyricKey,
} from "@/lib/localOnline";
import { PLAYBACK_LYRIC_REQUEST, publishPlaybackLyric } from "@/lib/playback-lyric-sync";
import { usePlayerStore } from "@/stores/player";

/** Mirror the main window's existing cache; never fetch lyrics from this bridge. */
export function startPlaybackLyricBroadcast(): () => void {
  let disposed = false;
  const offCached = onPlaybackLyricCached((track, cross, lyric) => {
    if (disposed) return;
    const state = usePlayerStore.getState().state;
    const current = state?.track;
    if (!current || current.platform === "podcast") return;
    const key = playbackLyricKey(current, crossSourceForPlayback(current, state.quality));
    if (key !== playbackLyricKey(track, cross)) return;
    publishPlaybackLyric({ trackId: `${current.platform}:${current.id}`, lyricKey: key, lyric });
  });
  const replayCached = (): void => {
    if (disposed) return;
    const state = usePlayerStore.getState().state;
    const track = state?.track;
    if (!track || track.platform === "podcast") return;
    const cross = crossSourceForPlayback(track, state.quality);
    const lyricKey = playbackLyricKey(track, cross);
    const cached = peekCachedPlaybackLyric(track, cross);
    if (!cached) return;
    void cached.then((lyric) => {
      if (disposed) return;
      const latest = usePlayerStore.getState().state;
      const current = latest?.track;
      if (!current || current.platform === "podcast") return;
      const currentCross = crossSourceForPlayback(current, latest.quality);
      if (playbackLyricKey(current, currentCross) !== lyricKey) return;
      if (peekCachedPlaybackLyric(current, currentCross) !== cached) return;
      publishPlaybackLyric({ trackId: `${current.platform}:${current.id}`, lyricKey, lyric });
    }).catch(() => {});
  };
  const offPlayer = usePlayerStore.subscribe((next, previous) => {
    if (
      next.state?.track?.id !== previous.state?.track?.id ||
      next.state?.track?.platform !== previous.state?.track?.platform ||
      next.state?.quality !== previous.state?.quality
    ) replayCached();
  });
  replayCached();
  let offRequest: (() => void) | undefined;
  void listen(PLAYBACK_LYRIC_REQUEST, replayCached).then((off) => {
    if (disposed) off();
    else offRequest = off;
  }).catch(() => {});
  return () => {
    disposed = true;
    offCached();
    offPlayer();
    offRequest?.();
  };
}

export function usePlaybackLyricBroadcast(): void {
  useEffect(startPlaybackLyricBroadcast, []);
}
