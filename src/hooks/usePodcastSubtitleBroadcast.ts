import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { PODCAST_SUBTITLE_REQUEST, publishPodcastSubtitles } from "@/lib/podcast-subtitle-sync";
import { usePlayerStore } from "@/stores/player";
import { usePodcastSubtitleStore } from "@/stores/podcastSubtitles";
import type { SubtitleDocument } from "@/services/podcastSubtitles";

/** Only the main window reads the subtitle database; desktop receives the current episode. */
export function startPodcastSubtitleBroadcast(): () => void {
  let disposed = false;
  let episode = "";
  let previous: SubtitleDocument | null | undefined;
  const currentEpisode = (): string => {
    const track = usePlayerStore.getState().state?.track;
    return track?.platform === "podcast" ? track.id : "";
  };
  const publish = (force = false): void => {
    if (disposed) return;
    const id = currentEpisode();
    const changed = id !== episode;
    episode = id;
    const document = usePodcastSubtitleStore.getState().entries[id]?.document ?? null;
    if (changed || force || document !== previous) {
      previous = document;
      publishPodcastSubtitles({ episodeId: id, document });
    }
    if (id && changed) void usePodcastSubtitleStore.getState().load(id);
  };
  const offPlayer = usePlayerStore.subscribe((next, previous) => {
    if (next.state?.track?.id !== previous.state?.track?.id || next.state?.track?.platform !== previous.state?.track?.platform) publish();
  });
  const offSubtitles = usePodcastSubtitleStore.subscribe((next, previous) => {
    if (next.entries[episode]?.document !== previous.entries[episode]?.document) publish();
  });
  let offRequest: (() => void) | undefined;
  void listen(PODCAST_SUBTITLE_REQUEST, () => publish(true)).then((off) => {
    if (disposed) off(); else offRequest = off;
  }).catch(() => {});
  publish();
  return () => {
    disposed = true;
    offPlayer(); offSubtitles();
    offRequest?.();
  };
}

export function usePodcastSubtitleBroadcast(): void {
  useEffect(startPodcastSubtitleBroadcast, []);
}
