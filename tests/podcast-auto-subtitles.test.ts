import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SubtitleDocument, SubtitleView } from "@/services/podcastSubtitles";
import type { PlaybackState, Track } from "@/types";

vi.mock("@/services/podcastSubtitles", async (original) => ({
  ...await original<typeof import("@/services/podcastSubtitles")>(),
  podcastSubtitles: vi.fn(), whisperStatus: vi.fn(), localTranslationStatus: vi.fn(),
  cachePodcastAudio: vi.fn(), transcribePodcast: vi.fn(), translatePodcast: vi.fn(), cancelPodcastSubtitles: vi.fn(),
}));
vi.mock("@/services/ipc", () => ({ getSetting: vi.fn(), setSetting: vi.fn() }));
import * as api from "@/services/podcastSubtitles";
import { getSetting, setSetting } from "@/services/ipc";
import { usePodcastSubtitleStore as subtitles } from "@/stores/podcastSubtitles";
import { usePlayerStore as player } from "@/stores/player";
import { startPodcastAutoSubtitles } from "@/hooks/usePodcastAutoSubtitles";

const document: SubtitleDocument = { revision: 0, source: "", timed: true, durationMs: 600000, cues: [], completedChunks: [], completedWindows: [] };
let stop: (() => void) | undefined;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function play(id: string, status: PlaybackState["status"] = "playing", platform: Track["platform"] = "podcast") {
  player.setState({ state: { ...player.getState().state, status, track: { id, platform, duration: 600 } } as PlaybackState, durationMs: 600000, interpolatedPositionMs: () => 48000 });
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.podcastSubtitles).mockResolvedValue({ document, audioReady: false, hasPublisherTranscript: false });
  vi.mocked(api.whisperStatus).mockResolvedValue({ ready: true, enginePath: "engine", modelPath: "base", problem: "" });
  vi.mocked(api.cancelPodcastSubtitles).mockResolvedValue(undefined);
  vi.mocked(setSetting).mockResolvedValue(undefined);
  subtitles.setState({ entries: {}, task: null, preferenceLoaded: true, preference: { ...api.DEFAULT_TRANSCRIBE, mode: "local" } });
  player.setState({ state: null, durationMs: 0 });
});
afterEach(async () => { stop?.(); stop = undefined; await flush(); });

it("无需打开播放页或点击按钮，开始播放即缓存并生成当前短段", async () => {
  const cached = deferred<SubtitleView>();
  const recognized = deferred<SubtitleDocument>();
  vi.mocked(api.cachePodcastAudio).mockReturnValue(cached.promise);
  vi.mocked(api.transcribePodcast).mockReturnValue(recognized.promise);
  stop = startPodcastAutoSubtitles();
  play("A", "paused"); await flush();
  expect(api.cachePodcastAudio).not.toHaveBeenCalled();
  play("A"); await flush();
  expect(api.cachePodcastAudio).toHaveBeenCalledWith("A", expect.any(String), expect.any(Function));
  expect(subtitles.getState().task).toMatchObject({ url: "A", kind: "follow", automatic: true });
  cached.resolve({ document, audioReady: true, hasPublisherTranscript: false }); await flush();
  expect(api.transcribePodcast).toHaveBeenCalledWith("A", expect.objectContaining({ window: 2, mode: "local" }), expect.any(String));
  await subtitles.getState().cancel();
  recognized.reject(new Error("cancelled")); await flush();
  expect(subtitles.getState().task).toBeNull();
});

it("播放下一集时取消旧缓存，迟到结果不生成旧集，旧任务收尾后自动接续新集", async () => {
  const first = deferred<SubtitleView>(); const second = deferred<SubtitleView>();
  vi.mocked(api.cachePodcastAudio).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  play("A"); stop = startPodcastAutoSubtitles(); await flush();
  const firstId = subtitles.getState().task!.id;
  play("B"); await flush();
  expect(api.cancelPodcastSubtitles).toHaveBeenCalledWith(firstId);
  expect(api.cachePodcastAudio).toHaveBeenCalledTimes(1);
  first.resolve({ document, audioReady: true, hasPublisherTranscript: false }); await flush();
  expect(api.transcribePodcast).not.toHaveBeenCalled();
  expect(vi.mocked(api.cachePodcastAudio).mock.calls.map(([url]) => url)).toEqual(["A", "B"]);
  expect(subtitles.getState().task).toMatchObject({ url: "B", automatic: true });
  stop(); stop = undefined;
  second.reject(new Error("cancelled")); await flush();
  expect(subtitles.getState().task).toBeNull();
});

it("停止本集或识别失败后不因进度变化与暂停恢复重复启动，下一集仍自动开始", async () => {
  const first = deferred<SubtitleView>();
  vi.mocked(api.cachePodcastAudio).mockReturnValueOnce(first.promise).mockRejectedValue(new Error("下载失败"));
  play("A"); stop = startPodcastAutoSubtitles(); await flush();
  await subtitles.getState().cancel(); first.reject(new Error("cancelled")); await flush();
  play("A", "paused"); await flush(); play("A"); await flush();
  player.setState({ positionAnchorValue: 60000 }); await flush();
  expect(api.cachePodcastAudio).toHaveBeenCalledTimes(1);
  play("B"); await flush();
  expect(api.cachePodcastAudio).toHaveBeenCalledTimes(2);
  expect(subtitles.getState().entries.B.error).toBe("下载失败");
  play("B", "paused"); await flush(); play("B"); await flush();
  expect(api.cachePodcastAudio).toHaveBeenCalledTimes(2);
});

it("普通歌曲、云端模式和关闭开关不自动识别；开启可开始，关闭取消当前自动任务", async () => {
  const pending = deferred<SubtitleView>();
  vi.mocked(api.cachePodcastAudio).mockReturnValue(pending.promise);
  play("song", "playing", "local"); stop = startPodcastAutoSubtitles(); await flush();
  expect(api.whisperStatus).not.toHaveBeenCalled();
  subtitles.setState({ preference: { ...api.DEFAULT_TRANSCRIBE, mode: "cloud" } }); play("A"); await flush();
  expect(api.cachePodcastAudio).not.toHaveBeenCalled();
  subtitles.setState({ preference: { ...api.DEFAULT_TRANSCRIBE, mode: "local", autoRecognize: false } }); await flush();
  expect(api.cachePodcastAudio).not.toHaveBeenCalled();
  await subtitles.getState().savePreference({ ...subtitles.getState().preference, autoRecognize: true }); await flush();
  expect(api.cachePodcastAudio).toHaveBeenCalledTimes(1);
  const id = subtitles.getState().task!.id;
  await subtitles.getState().savePreference({ ...subtitles.getState().preference, autoRecognize: false }); await flush();
  expect(api.cancelPodcastSubtitles).toHaveBeenCalledWith(id);
  pending.reject(new Error("cancelled")); await flush();
  expect(subtitles.getState().task).toBeNull();
});

it("启动等待偏好读取，旧本地偏好默认自动识别，显式关闭保持关闭", async () => {
  subtitles.setState({ preferenceLoaded: false, preference: api.DEFAULT_TRANSCRIBE });
  const preference = deferred<string>();
  const cached = deferred<SubtitleView>();
  vi.mocked(getSetting).mockReturnValue(preference.promise);
  vi.mocked(api.cachePodcastAudio).mockReturnValue(cached.promise);
  play("A"); stop = startPodcastAutoSubtitles(); await flush();
  expect(api.cachePodcastAudio).not.toHaveBeenCalled();
  preference.resolve(JSON.stringify({ mode: "local" })); await flush();
  expect(subtitles.getState().preference.autoRecognize).toBe(true);
  expect(api.cachePodcastAudio).toHaveBeenCalledTimes(1);
  stop(); stop = undefined; cached.reject(new Error("cancelled")); await flush();
  subtitles.setState({ preferenceLoaded: false });
  vi.mocked(getSetting).mockResolvedValue(JSON.stringify({ mode: "local", autoRecognize: false }));
  await subtitles.getState().loadPreference();
  expect(subtitles.getState().preference.autoRecognize).toBe(false);
});

it("已有导入或节目字幕时自动任务直接使用，不下载音频或调用识别引擎", async () => {
  vi.mocked(api.podcastSubtitles).mockResolvedValue({ document: { ...document, revision: 1, source: "import", cues: [{ startMs: 0, endMs: 1000, text: "Imported", translation: "" }] }, audioReady: false, hasPublisherTranscript: false });
  play("A"); stop = startPodcastAutoSubtitles(); await flush();
  expect(api.cachePodcastAudio).not.toHaveBeenCalled();
  expect(api.whisperStatus).not.toHaveBeenCalled();
  expect(subtitles.getState().entries.A.error).toBe("");
  expect(subtitles.getState().entries.A.document?.source).toBe("import");
  expect(subtitles.getState().task).toBeNull();
});
