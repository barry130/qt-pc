import { emitTo } from "@tauri-apps/api/event";
import { findActiveIndex, type LyricLine } from "@/lib/lrc";
import { LYRICS_WINDOW_LABEL, MAIN_WINDOW_LABEL } from "@/lib/window-labels";
import type { SubtitleDocument } from "@/services/podcastSubtitles";

export const PODCAST_SUBTITLE_REQUEST = "request-podcast-subtitles";
export const PODCAST_SUBTITLE_UPDATE = "podcast-subtitles-updated";
export interface PodcastSubtitleSnapshot { episodeId: string; document: SubtitleDocument | null }
export interface DesktopSubtitleLine extends LyricLine { endMs?: number }

export function desktopSubtitleLines(document: SubtitleDocument | null): DesktopSubtitleLine[] {
  if (!document?.timed) return [];
  return document.cues.map((cue) => ({
    timeMs: cue.startMs, endMs: cue.endMs, text: cue.text,
    translation: cue.translation.trim() !== cue.text.trim() ? cue.translation : undefined,
  }));
}

/** Song LRC keeps its existing semantics; podcast gaps must not hold the last sentence forever. */
export function desktopActiveIndex(lines: DesktopSubtitleLine[], positionMs: number): number {
  const index = findActiveIndex(lines, positionMs);
  const endMs = lines[index]?.endMs;
  return endMs !== undefined && positionMs >= endMs ? -1 : index;
}

export function publishPodcastSubtitles(snapshot: PodcastSubtitleSnapshot): void {
  try { void emitTo(LYRICS_WINDOW_LABEL, PODCAST_SUBTITLE_UPDATE, snapshot).catch(() => {}); }
  catch { /* Desktop window not open, or browser preview. */ }
}

export function requestPodcastSubtitles(): void {
  try { void emitTo(MAIN_WINDOW_LABEL, PODCAST_SUBTITLE_REQUEST).catch(() => {}); }
  catch { /* Browser preview has no native event bus. */ }
}
