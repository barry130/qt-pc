import { useEffect } from "react";
import { usePlayerStore } from "@/stores/player";
import { usePodcastSubtitleStore } from "@/stores/podcastSubtitles";

/** Main-window playback lifetime, independent of the currently visible route. */
export function startPodcastAutoSubtitles(): () => void {
  let disposed = false;
  let scheduled = false;
  let episode: string | null = null;
  let generation = 0;
  let attempted = false;
  let preference = usePodcastSubtitleStore.getState().preference;

  const reconcile = (): void => {
    const player = usePlayerStore.getState();
    const store = usePodcastSubtitleStore.getState();
    const track = player.state?.track;
    const next = track?.platform === "podcast" ? track.id : null;
    const settingsChanged = preference !== store.preference;
    if (next !== episode || settingsChanged) {
      episode = next;
      preference = store.preference;
      generation++;
      attempted = false;
    }
    const enabled = store.preferenceLoaded && preference.mode === "local" && preference.autoRecognize;
    const task = store.task;
    if (task?.kind === "follow") {
      // A manual start/stop also counts as this episode's attempt. Never restart
      // a cancelled/failed task on each tick or on pause/resume.
      if (task.url === next && !task.automatic) attempted = true;
      if (!task.cancelling && (task.url !== next || player.state?.status === "stopped" || player.state?.status === "error" || (task.automatic && (!enabled || settingsChanged)))) {
        void store.cancel();
      }
      return;
    }
    if (task || !enabled || !next || attempted || player.state?.status !== "playing") return;
    if (!(player.durationMs > 0 || (track?.duration ?? 0) > 0)) return;
    attempted = true;
    const ticket = generation;
    void store.followPlayback(next, () => {
      const current = usePlayerStore.getState();
      const currentTrack = current.state?.track;
      return {
        valid: !disposed && ticket === generation && currentTrack?.platform === "podcast" && currentTrack.id === next,
        playing: current.state?.status === "playing",
        positionMs: current.interpolatedPositionMs(),
        durationMs: current.durationMs || (currentTrack?.duration ?? 0) * 1000,
      };
    }, true);
  };
  const schedule = (): void => {
    if (disposed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; if (!disposed) reconcile(); });
  };
  const offPlayer = usePlayerStore.subscribe((next, previous) => {
    if (next.state?.track?.id !== previous.state?.track?.id || next.state?.track?.platform !== previous.state?.track?.platform || next.state?.status !== previous.state?.status || (next.durationMs > 0) !== (previous.durationMs > 0)) schedule();
  });
  const offSubtitles = usePodcastSubtitleStore.subscribe((next, previous) => {
    if (next.preference !== previous.preference || next.preferenceLoaded !== previous.preferenceLoaded || next.task?.id !== previous.task?.id || next.task?.cancelling !== previous.task?.cancelling) schedule();
  });
  void usePodcastSubtitleStore.getState().loadPreference().catch(() => {});
  schedule();
  return () => {
    disposed = true;
    generation++;
    offPlayer();
    offSubtitles();
    const store = usePodcastSubtitleStore.getState();
    if (store.task?.kind === "follow" && !store.task.cancelling) void store.cancel();
  };
}

export function usePodcastAutoSubtitles(): void {
  useEffect(startPodcastAutoSubtitles, []);
}
