import { emitTo } from "@tauri-apps/api/event";
import { LYRICS_WINDOW_LABEL, MAIN_WINDOW_LABEL } from "@/lib/window-labels";
import type { Lyric } from "@/types";

export const PLAYBACK_LYRIC_REQUEST = "request-playback-lyric";
export const PLAYBACK_LYRIC_UPDATE = "playback-lyric-updated";

export interface PlaybackLyricSnapshot {
  trackId: string;
  lyricKey: string;
  lyric: Lyric;
}

/** Only lyric bodies cross this bridge; playback position still comes from Rust. */
export function publishPlaybackLyric(snapshot: PlaybackLyricSnapshot): void {
  try {
    void emitTo(LYRICS_WINDOW_LABEL, PLAYBACK_LYRIC_UPDATE, snapshot).catch(() => {});
  } catch {
    // A closed desktop window or browser preview must not interrupt playback.
  }
}

export function requestPlaybackLyric(): void {
  try {
    void emitTo(MAIN_WINDOW_LABEL, PLAYBACK_LYRIC_REQUEST).catch(() => {});
  } catch {
    // Browser preview has no native event bus.
  }
}
