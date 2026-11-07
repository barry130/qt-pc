import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SubtitleDocument } from "@/services/podcastSubtitles";
import type { PlaybackState, Track } from "@/types";
const events = vi.hoisted(() => new Map<string, () => void>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: () => void) => { events.set(name, callback); return () => events.delete(name); }),
  emit: vi.fn(async () => {}), emitTo: vi.fn(async () => {}),
}));
vi.mock("@/services/podcastSubtitles", async (original) => ({
  ...await original<typeof import("@/services/podcastSubtitles")>(), podcastSubtitles: vi.fn(),
}));
import { emitTo } from "@tauri-apps/api/event";
import { podcastSubtitles } from "@/services/podcastSubtitles";
import { startPodcastSubtitleBroadcast } from "@/hooks/usePodcastSubtitleBroadcast";
import { desktopActiveIndex, desktopSubtitleLines, PODCAST_SUBTITLE_REQUEST, PODCAST_SUBTITLE_UPDATE } from "@/lib/podcast-subtitle-sync";
import { usePlayerStore as player } from "@/stores/player";
import { usePodcastSubtitleStore as subtitles, EMPTY_SUBTITLE_ENTRY } from "@/stores/podcastSubtitles";

const document: SubtitleDocument = { revision: 2, source: "asr", timed: true, durationMs: 10000, completedChunks: [], cues: [
  { startMs: 0, endMs: 3000, text: "Hello", translation: "你好" },
  { startMs: 5000, endMs: 9000, text: "本来就是中文", translation: "本来就是中文" },
] };
let stop: (() => void) | undefined;
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function play(id: string, platform: Track["platform"] = "podcast") {
  player.setState({ state: { status: "playing", track: { id, platform } } as PlaybackState });
}
beforeEach(() => {
  vi.clearAllMocks(); events.clear();
  player.setState({ state: null }); subtitles.setState({ entries: {} });
  vi.mocked(podcastSubtitles).mockResolvedValue({ document, hasPublisherTranscript: false });
});
afterEach(async () => { stop?.(); stop = undefined; await flush(); });

it("不用打开播放页，播放播客即读取字幕；新窗口可补发，增量更新无需反复读库", async () => {
  stop = startPodcastSubtitleBroadcast(); await flush();
  play("A"); await flush();
  expect(podcastSubtitles).toHaveBeenCalledWith("A");
  expect(emitTo).toHaveBeenLastCalledWith("lyrics", PODCAST_SUBTITLE_UPDATE, { episodeId: "A", document });
  vi.mocked(emitTo).mockClear();
  player.setState({ positionAnchorValue: 5000 }); await flush();
  expect(emitTo).not.toHaveBeenCalled();
  events.get(PODCAST_SUBTITLE_REQUEST)?.();
  expect(emitTo).toHaveBeenCalledTimes(1);
  const updated = { ...document, revision: 3 };
  subtitles.setState({ entries: { A: { ...EMPTY_SUBTITLE_ENTRY, document: updated } } });
  expect(emitTo).toHaveBeenLastCalledWith("lyrics", PODCAST_SUBTITLE_UPDATE, { episodeId: "A", document: updated });
  expect(podcastSubtitles).toHaveBeenCalledTimes(1);
});

it("换集清空旧快照，旧集迟到结果不会广播到新集；歌曲不读取字幕，卸载移除监听", async () => {
  let resolve!: (view: { document: SubtitleDocument; hasPublisherTranscript: boolean }) => void;
  vi.mocked(podcastSubtitles).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  play("A"); stop = startPodcastSubtitleBroadcast(); await flush();
  play("B"); await flush();
  vi.mocked(emitTo).mockClear();
  resolve({ document, hasPublisherTranscript: false }); await flush();
  expect(emitTo).not.toHaveBeenCalled();
  play("song", "local"); await flush();
  expect(emitTo).toHaveBeenLastCalledWith("lyrics", PODCAST_SUBTITLE_UPDATE, { episodeId: "", document: null });
  expect(podcastSubtitles).toHaveBeenCalledTimes(2);
  stop(); stop = undefined;
  expect(events.size).toBe(0);
  vi.mocked(emitTo).mockClear(); play("C"); await flush();
  expect(emitTo).not.toHaveBeenCalled();
});

it("桌面字幕保留时间段与译文，不重复中文、不伪造无时间轴文字稿的同步", () => {
  const lines = desktopSubtitleLines(document);
  expect(desktopActiveIndex(lines, 2000)).toBe(0);
  expect(desktopActiveIndex(lines, 4000)).toBe(-1);
  expect(desktopActiveIndex(lines, 6000)).toBe(1);
  expect(desktopActiveIndex(lines, 10000)).toBe(-1);
  expect(lines[0].translation).toBe("你好");
  expect(lines[1].translation).toBeUndefined();
  expect(desktopSubtitleLines({ ...document, timed: false })).toEqual([]);
  expect(desktopActiveIndex([{ timeMs: 100, text: "Song" }], 10000)).toBe(0);
});
