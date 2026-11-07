import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubtitleDocument } from "@/services/podcastSubtitles";

vi.mock("@/services/podcastSubtitles", async (original) => ({
  ...await original<typeof import("@/services/podcastSubtitles")>(),
  podcastSubtitles: vi.fn(), fetchPodcastSubtitles: vi.fn(), importPodcastSubtitles: vi.fn(),
  transcribePodcast: vi.fn(), translatePodcast: vi.fn(), cancelPodcastSubtitles: vi.fn(),
  whisperStatus: vi.fn(), cachePodcastAudio: vi.fn(), pickPodcastAudio: vi.fn(),
  localTranslationStatus: vi.fn(),
}));
vi.mock("@/services/ipc", () => ({ getSetting: vi.fn(), setSetting: vi.fn(), aiLocalConfig: vi.fn() }));
import * as api from "@/services/podcastSubtitles";
import { aiLocalConfig, getSetting, setSetting } from "@/services/ipc";
import { EMPTY_SUBTITLE_ENTRY, nextSubtitleWindow, pendingChunks, precedingSubtitleIndex, subtitleIndex, usePodcastSubtitleStore as store } from "@/stores/podcastSubtitles";

function doc(revision = 0, count = 0): SubtitleDocument {
  return { revision, source: revision ? "asr" : "", timed: true, durationMs: 900000, completedChunks: [],
    cues: Array.from({ length: count }, (_, i) => ({ startMs: i * 5000, endMs: i * 5000 + 3000, text: `Line ${i}`, translation: "" })) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function put(url: string, document: SubtitleDocument) {
  store.setState((s) => ({ entries: { ...s.entries, [url]: { ...EMPTY_SUBTITLE_ENTRY, document } } }));
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.podcastSubtitles).mockResolvedValue({ document: doc(), hasPublisherTranscript: false, audioReady: true });
  vi.mocked(getSetting).mockResolvedValue(null);
  vi.mocked(setSetting).mockResolvedValue(undefined);
  vi.mocked(api.cancelPodcastSubtitles).mockResolvedValue(undefined);
  vi.mocked(aiLocalConfig).mockResolvedValue({ activeId: "translator", profiles: [{ id: "translator", name: "翻译供应商", model: "chat-model", baseUrl: "https://example.test", protocol: "openai", models: [], hasKey: false, keyMask: "", keyMasks: [], icon: "", skipCertVerify: false }] });
  store.setState({ entries: {}, task: null, preferenceLoaded: true, preference: { ...api.DEFAULT_TRANSCRIBE, profileId: "fixture" } });
});

describe("播客字幕任务与恢复", () => {
  it("未缓存节目一键下载后按最新播放位置识别并本地翻译，复用同一任务", async () => {
    store.setState({ preference: { ...api.DEFAULT_TRANSCRIBE, mode: "local", translationMode: "local", autoTranslate: true } });
    vi.mocked(api.whisperStatus).mockResolvedValue({ ready: true, enginePath: "engine", modelPath: "base", problem: "" });
    vi.mocked(api.localTranslationStatus).mockResolvedValue({ supported: true, ready: true, bytes: 117000000, problem: "", progress: null });
    vi.mocked(api.podcastSubtitles).mockResolvedValue({ document: doc(), hasPublisherTranscript: false, audioReady: false });
    const cached = deferred<api.SubtitleView>();
    const recognized = deferred<SubtitleDocument>();
    const translated = deferred<SubtitleDocument>();
    vi.mocked(api.cachePodcastAudio).mockReturnValue(cached.promise);
    vi.mocked(api.transcribePodcast).mockReturnValue(recognized.promise);
    vi.mocked(api.translatePodcast).mockReturnValue(translated.promise);
    let cursor = { positionMs: 48000, durationMs: 900000, playing: true, valid: true };
    const work = store.getState().followPlayback("A", () => cursor);
    await vi.waitFor(() => expect(api.cachePodcastAudio).toHaveBeenCalledTimes(1));
    const [, id, report] = vi.mocked(api.cachePodcastAudio).mock.calls[0];
    expect(store.getState().task).toMatchObject({ id, kind: "follow" });
    report?.({ downloadedBytes: 2000000, totalBytes: 10000000 });
    expect(store.getState().task?.label).toContain("2.0 / 10.0 MB");
    expect(store.getState().task?.label).toContain("完成后自动开始识别");
    expect(api.transcribePodcast).not.toHaveBeenCalled();
    cursor = { ...cursor, positionMs: 65000 };
    cached.resolve({ document: doc(2), hasPublisherTranscript: false, audioReady: true });
    await vi.waitFor(() => expect(api.transcribePodcast).toHaveBeenCalledTimes(1));
    expect(api.transcribePodcast).toHaveBeenCalledWith("A", expect.objectContaining({ chunk: 0, window: 3, expectedRevision: 2, mode: "local" }), id);
    const next = { ...doc(3), completedWindows: [3], cues: [{ startMs: 64000, endMs: 68000, text: "A new sentence", translation: "" }] };
    recognized.resolve(next);
    await vi.waitFor(() => expect(api.translatePodcast).toHaveBeenCalledTimes(1));
    expect(store.getState().entries.A.document?.cues[0].text).toBe("A new sentence");
    expect(api.translatePodcast).toHaveBeenCalledWith("A", [0], 3, id, expect.objectContaining({ local: true }));
    cursor = { ...cursor, valid: false };
    translated.resolve({ ...next, revision: 4, cues: [{ ...next.cues[0], translation: "新的一句话" }] });
    await work;
    expect(store.getState().entries.A.document?.cues[0].translation).toBe("新的一句话");
    expect(store.getState().task).toBeNull();
    expect(aiLocalConfig).not.toHaveBeenCalled();
  });
  it("缓存中取消会停止后续识别，迟到进度不覆盖取消状态，等待计时清理", async () => {
    vi.useFakeTimers();
    try {
      store.setState({ preference: { ...api.DEFAULT_TRANSCRIBE, mode: "local" } });
      vi.mocked(api.whisperStatus).mockResolvedValue({ ready: true, enginePath: "engine", modelPath: "base", problem: "" });
      vi.mocked(api.podcastSubtitles).mockResolvedValue({ document: doc(), hasPublisherTranscript: false, audioReady: false });
      const pending = deferred<api.SubtitleView>();
      vi.mocked(api.cachePodcastAudio).mockReturnValue(pending.promise);
      const work = store.getState().followPlayback("A", () => ({ positionMs: 48000, durationMs: 900000, playing: true, valid: true }));
      await vi.advanceTimersByTimeAsync(3000);
      expect(store.getState().task?.label).toContain("已等待 3 秒");
      const [, id, report] = vi.mocked(api.cachePodcastAudio).mock.calls[0];
      await store.getState().cancel();
      report?.({ downloadedBytes: 9000000, totalBytes: 10000000 });
      expect(store.getState().task?.label).toContain("正在取消");
      expect(api.cancelPodcastSubtitles).toHaveBeenCalledWith(id);
      pending.reject(new Error("已取消"));
      await work;
      expect(api.transcribePodcast).not.toHaveBeenCalled();
      expect(store.getState().task).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("缓存后换集不继续识别，缓存失败可再次点击重试，缺失本地文件不改用网上版本", async () => {
    store.setState({ preference: { ...api.DEFAULT_TRANSCRIBE, mode: "local" } });
    vi.mocked(api.whisperStatus).mockResolvedValue({ ready: true, enginePath: "engine", modelPath: "base", problem: "" });
    vi.mocked(api.podcastSubtitles).mockResolvedValue({ document: doc(), hasPublisherTranscript: false, audioReady: false });
    const cursor = { positionMs: 48000, durationMs: 900000, playing: true, valid: true };
    vi.mocked(api.cachePodcastAudio).mockRejectedValueOnce(new Error("音频下载失败"));
    await store.getState().followPlayback("A", () => cursor);
    expect(store.getState().entries.A.error).toBe("音频下载失败");
    expect(store.getState().task).toBeNull();
    const pending = deferred<api.SubtitleView>();
    vi.mocked(api.cachePodcastAudio).mockReturnValueOnce(pending.promise);
    const work = store.getState().followPlayback("A", () => cursor);
    await vi.waitFor(() => expect(api.cachePodcastAudio).toHaveBeenCalledTimes(2));
    cursor.valid = false;
    pending.resolve({ document: doc(), hasPublisherTranscript: false, audioReady: true });
    await work;
    expect(store.getState().entries.A.audioReady).toBe(true);
    expect(api.transcribePodcast).not.toHaveBeenCalled();
    cursor.valid = true;
    vi.mocked(api.podcastSubtitles).mockResolvedValue({ document: doc(), hasPublisherTranscript: false, audioReady: false, audioFileName: "moved.mp3" });
    await store.getState().followPlayback("A", () => cursor);
    expect(store.getState().entries.A.error).toContain("恢复原文件");
    expect(api.cachePodcastAudio).toHaveBeenCalledTimes(2);
  });
  it("本地翻译使用专用模型，不读取在线供应商；失败不回退云端", async () => {
    store.setState({ preference: { ...api.DEFAULT_TRANSCRIBE, translationMode: "local" } });
    const original = doc(1, 2); put("A", original);
    vi.mocked(api.localTranslationStatus).mockResolvedValue({ supported: true, ready: true, bytes: 117000000, problem: "", progress: null });
    const translated = { ...original, revision: 2, cues: original.cues.map((cue) => ({ ...cue, translation: "中文" })) };
    vi.mocked(api.translatePodcast).mockResolvedValue(translated);
    await store.getState().translate("A", 0);
    expect(api.translatePodcast).toHaveBeenCalledWith("A", [0, 1], 1, expect.any(String), { profileId: "", model: "argos-en-zh-1.9", local: true });
    expect(aiLocalConfig).not.toHaveBeenCalled();
    put("B", original);
    vi.mocked(api.localTranslationStatus).mockResolvedValue({ supported: true, ready: false, bytes: 117000000, problem: "请先下载英译中模型", progress: null });
    await store.getState().translate("B", 0);
    expect(store.getState().entries.B.error).toContain("下载英译中");
    expect(api.translatePodcast).toHaveBeenCalledTimes(1);
    expect(aiLocalConfig).not.toHaveBeenCalled();
  });
  it("自动翻译失败保留原文、刷新版本后继续识别，本集不重复尝试失败的翻译", async () => {
    store.setState({ preference: { ...api.DEFAULT_TRANSCRIBE, mode: "local", translationMode: "local", autoTranslate: true } });
    vi.mocked(api.whisperStatus).mockResolvedValue({ ready: true, enginePath: "engine", modelPath: "base", problem: "" });
    vi.mocked(api.localTranslationStatus).mockResolvedValue({ supported: true, ready: true, bytes: 117000000, problem: "", progress: null });
    const original = { ...doc(1, 1), completedWindows: [0] };
    const committed = { ...original, revision: 2, cues: [{ ...original.cues[0], translation: "第一句" }] };
    vi.mocked(api.podcastSubtitles).mockResolvedValueOnce({ document: doc(), hasPublisherTranscript: false, audioReady: true })
      .mockResolvedValue({ document: committed, hasPublisherTranscript: false, audioReady: true });
    const next = deferred<SubtitleDocument>();
    const third = deferred<SubtitleDocument>();
    vi.mocked(api.transcribePodcast).mockResolvedValueOnce(original).mockReturnValueOnce(next.promise).mockReturnValueOnce(third.promise);
    vi.mocked(api.translatePodcast).mockRejectedValue(new Error("本批翻译超时"));
    const cursor = { positionMs: 0, durationMs: 900000, playing: true, valid: true };
    const work = store.getState().followPlayback("A", () => cursor);
    await vi.waitFor(() => expect(api.transcribePodcast).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.transcribePodcast).mock.calls[1][1]).toMatchObject({ window: 1, expectedRevision: 2 });
    expect(store.getState().entries.A.notice).toContain("原文识别继续");
    expect(store.getState().entries.A.error).toBe("");
    expect(store.getState().entries.A.document?.cues[0].translation).toBe("第一句");
    const second = { ...doc(3, 2), completedWindows: [0, 1] };
    next.resolve(second);
    await vi.waitFor(() => expect(api.transcribePodcast).toHaveBeenCalledTimes(3));
    expect(api.translatePodcast).toHaveBeenCalledTimes(1);
    cursor.valid = false;
    third.resolve({ ...second, revision: 4, completedWindows: [0, 1, 2] });
    await work;
    expect(aiLocalConfig).not.toHaveBeenCalled();
  });
  it("未安装翻译组件仍自动识别原文，翻译不可用会提示", async () => {
    store.setState({ preference: { ...api.DEFAULT_TRANSCRIBE, mode: "local", translationMode: "local", autoTranslate: true } });
    vi.mocked(api.whisperStatus).mockResolvedValue({ ready: true, enginePath: "engine", modelPath: "base", problem: "" });
    vi.mocked(api.localTranslationStatus).mockResolvedValue({ supported: true, ready: false, bytes: 117000000, problem: "请先下载英译中模型", progress: null });
    const pending = deferred<SubtitleDocument>();
    vi.mocked(api.transcribePodcast).mockReturnValue(pending.promise);
    const cursor = { positionMs: 0, durationMs: 900000, playing: true, valid: true };
    const work = store.getState().followPlayback("A", () => cursor, true);
    await vi.waitFor(() => expect(api.transcribePodcast).toHaveBeenCalledTimes(1));
    expect(store.getState().entries.A.notice).toContain("请先下载英译中模型");
    expect(store.getState().task).toMatchObject({ kind: "follow", automatic: true });
    cursor.valid = false;
    pending.resolve({ ...doc(1, 1), completedWindows: [0] });
    await work;
    expect(api.translatePodcast).not.toHaveBeenCalled();
  });
  it("取消正在执行的自动翻译不提示失败，也不继续识别下一段", async () => {
    store.setState({ preference: { ...api.DEFAULT_TRANSCRIBE, mode: "local", translationMode: "local", autoTranslate: true } });
    vi.mocked(api.whisperStatus).mockResolvedValue({ ready: true, enginePath: "engine", modelPath: "base", problem: "" });
    vi.mocked(api.localTranslationStatus).mockResolvedValue({ supported: true, ready: true, bytes: 117000000, problem: "", progress: null });
    vi.mocked(api.transcribePodcast).mockResolvedValue({ ...doc(1, 1), completedWindows: [0] });
    const pending = deferred<SubtitleDocument>();
    vi.mocked(api.translatePodcast).mockReturnValue(pending.promise);
    const work = store.getState().followPlayback("A", () => ({ positionMs: 0, durationMs: 900000, playing: true, valid: true }));
    await vi.waitFor(() => expect(api.translatePodcast).toHaveBeenCalledTimes(1));
    await store.getState().cancel();
    pending.reject(new Error("cancelled"));
    await work;
    expect(store.getState().entries.A.notice).toBe("");
    expect(store.getState().entries.A.error).toBe("");
    expect(api.transcribePodcast).toHaveBeenCalledTimes(1);
    expect(store.getState().task).toBeNull();
  });
  it("边播边识别保存短段、跟随跳转，换集停止且不启动云端请求", async () => {
    store.setState({ preference: { ...api.DEFAULT_TRANSCRIBE, mode: "local" } });
    vi.mocked(api.whisperStatus).mockResolvedValue({ ready: true, enginePath: "engine", modelPath: "base", problem: "" });
    let cursor = { positionMs: 2000, durationMs: 900000, playing: true, valid: true };
    const first = deferred<SubtitleDocument>(); const second = deferred<SubtitleDocument>();
    vi.mocked(api.transcribePodcast).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const work = store.getState().followPlayback("A", () => cursor);
    await vi.waitFor(() => expect(api.transcribePodcast).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.transcribePodcast).mock.calls[0][1]).toMatchObject({ window: 0, chunk: 0, expectedRevision: 0 });
    cursor = { ...cursor, positionMs: 310000 };
    first.resolve({ ...doc(1, 1), completedWindows: [0] });
    await vi.waitFor(() => expect(api.transcribePodcast).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.transcribePodcast).mock.calls[1][1]).toMatchObject({ window: 15, chunk: 1, expectedRevision: 1 });
    cursor = { ...cursor, valid: false };
    second.resolve({ ...doc(2, 2), completedWindows: [0, 15] });
    await work;
    expect(store.getState().entries.A.document?.completedWindows).toEqual([0, 15]);
    expect(api.cachePodcastAudio).not.toHaveBeenCalled();
    expect(api.translatePodcast).not.toHaveBeenCalled();
    expect(store.getState().task).toBeNull();
  });
  it("边播边识别暂停等待、自动本地翻译，并可取消等待", async () => {
    vi.useFakeTimers();
    try {
      store.setState({ preference: { ...api.DEFAULT_TRANSCRIBE, mode: "local", translationMode: "local", autoTranslate: true } });
      vi.mocked(api.whisperStatus).mockResolvedValue({ ready: true, enginePath: "engine", modelPath: "base", problem: "" });
      vi.mocked(api.localTranslationStatus).mockResolvedValue({ supported: true, ready: true, bytes: 117000000, problem: "", progress: null });
      let playing = false;
      const original = { ...doc(1, 1), completedWindows: [0, 1, 2, 3] };
      put("A", original);
      vi.mocked(api.translatePodcast).mockResolvedValue({ ...original, revision: 2, cues: [{ ...original.cues[0], translation: "你好" }] });
      const work = store.getState().followPlayback("A", () => ({ positionMs: 0, durationMs: 900000, playing, valid: true }));
      await vi.advanceTimersByTimeAsync(500);
      expect(api.transcribePodcast).not.toHaveBeenCalled();
      expect(api.translatePodcast).not.toHaveBeenCalled();
      playing = true;
      await vi.advanceTimersByTimeAsync(500);
      expect(api.translatePodcast).toHaveBeenCalledWith("A", [0], 1, expect.any(String), expect.objectContaining({ local: true }));
      expect(store.getState().entries.A.document?.cues[0].translation).toBe("你好");
      await store.getState().cancel();
      await vi.advanceTimersByTimeAsync(500); await work;
      expect(store.getState().task).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("整集重新生成从头替换已完成段，每段携带最新版本；失败保留其原内容", async () => {
    store.setState({ preference: { ...api.DEFAULT_TRANSCRIBE, mode: "local" } });
    const initial = { ...doc(3, 2), completedChunks: [0, 1], timed: false };
    put("A", initial);
    vi.mocked(api.whisperStatus).mockResolvedValue({ ready: true, enginePath: "engine", modelPath: "base", problem: "" });
    const pending = deferred<SubtitleDocument>();
    vi.mocked(api.transcribePodcast).mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error("recognition failed"));
    const work = store.getState().generate("A", 400000, 600000, true, true);
    await vi.waitFor(() => expect(api.transcribePodcast).toHaveBeenCalledTimes(1));
    expect(store.getState().entries.A.document).toEqual(initial);
    expect(api.transcribePodcast).toHaveBeenCalledWith("A", expect.objectContaining({ chunk: 0, replace: true, expectedRevision: 3 }), expect.any(String));
    const updated = { ...initial, revision: 4, cues: [{ ...initial.cues[0], text: "New first chunk" }, initial.cues[1]] };
    vi.mocked(api.podcastSubtitles).mockResolvedValue({ document: updated, hasPublisherTranscript: false });
    pending.resolve(updated);
    await work;
    expect(vi.mocked(api.transcribePodcast).mock.calls[1][1]).toMatchObject({ chunk: 1, replace: true, expectedRevision: 4 });
    expect(store.getState().entries.A.document).toEqual(updated);
    expect(store.getState().entries.A.error).toBe("recognition failed");
    expect(store.getState().task).toBeNull();
  });
  it("取消重新生成不清空旧字幕，也不继续替换下一段", async () => {
    const initial = { ...doc(3, 2), completedChunks: [0, 1] };
    put("A", initial);
    const pending = deferred<SubtitleDocument>();
    vi.mocked(api.transcribePodcast).mockReturnValueOnce(pending.promise);
    vi.mocked(api.podcastSubtitles).mockResolvedValue({ document: initial, hasPublisherTranscript: false });
    const work = store.getState().generate("A", 0, 600000, true, true);
    await vi.waitFor(() => expect(api.transcribePodcast).toHaveBeenCalledTimes(1));
    await store.getState().cancel();
    pending.reject(new Error("cancelled"));
    await work;
    expect(api.transcribePodcast).toHaveBeenCalledTimes(1);
    expect(store.getState().entries.A.document).toEqual(initial);
  });
  it("长文字稿单段保存并显示模型、等待时间；失败保留已完成译文", async () => {
    const initial = { ...doc(1, 6), timed: false, cues: doc(1, 6).cues.map((cue) => ({ ...cue, text: "English ".repeat(100) })) };
    put("A", initial);
    const pending = deferred<SubtitleDocument>();
    vi.mocked(api.translatePodcast).mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error("timeout"));
    vi.useFakeTimers();
    try {
      const work = store.getState().translate("A", 0);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.mocked(api.translatePodcast).mock.calls[0][1]).toEqual([0]);
      expect(store.getState().task?.label).toContain("0/6 段");
      expect(store.getState().task?.label).toContain("翻译供应商 / chat-model");
      await vi.advanceTimersByTimeAsync(3000);
      expect(store.getState().task?.label).toContain("本批等待 3 秒");
      const partial = { ...initial, revision: 2, cues: initial.cues.map((cue, i) => ({ ...cue, translation: i === 0 ? "第一段译文" : "" })) };
      vi.mocked(api.podcastSubtitles).mockResolvedValue({ document: partial, hasPublisherTranscript: false });
      pending.resolve(partial);
      await work;
      expect(store.getState().entries.A.document?.cues[0].translation).toBe("第一段译文");
      expect(vi.mocked(api.translatePodcast).mock.calls[1][1]).toEqual([1]);
      expect(store.getState().entries.A.error).toBe("timeout");
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("缺少翻译配置直接提示；加载配置时取消不发送翻译请求", async () => {
    put("A", doc(1, 1));
    vi.mocked(aiLocalConfig).mockResolvedValueOnce({ activeId: "", profiles: [] });
    await store.getState().translate("A", 0);
    expect(store.getState().entries.A.error).toContain("设置 → AI");
    expect(api.translatePodcast).not.toHaveBeenCalled();
    const config = deferred<Awaited<ReturnType<typeof aiLocalConfig>>>();
    vi.mocked(aiLocalConfig).mockReturnValueOnce(config.promise);
    const work = store.getState().translate("A", 0);
    await store.getState().cancel();
    config.resolve({ activeId: "", profiles: [] });
    await work;
    expect(api.translatePodcast).not.toHaveBeenCalled();
  });
  it("旧自填模型恢复为自定义 JSON，内置模型纠正不兼容格式", async () => {
    store.setState({ preferenceLoaded: false });
    vi.mocked(getSetting).mockResolvedValueOnce(JSON.stringify({ profileId: "crouter", model: "Qwen3-ASR-1.7B", responseFormat: "diarized_json" }));
    await store.getState().loadPreference();
    expect(store.getState().preference).toMatchObject({ model: "Qwen3-ASR-1.7B", customModel: true, responseFormat: "json" });
    store.setState({ preferenceLoaded: false });
    vi.mocked(getSetting).mockResolvedValueOnce(JSON.stringify({ profileId: "fixture", model: "whisper-1", responseFormat: "diarized_json" }));
    await store.getState().loadPreference();
    expect(store.getState().preference).toMatchObject({ model: "whisper-1", customModel: false, responseFormat: "verbose_json" });
  });
  it("文字稿续传跳过完成片段，翻译按正文顺序且不依赖播放时间", async () => {
    store.setState({ preference: { ...api.DEFAULT_TRANSCRIBE, profileId: "crouter", model: "Qwen3-ASR-1.7B", customModel: true, responseFormat: "json" } });
    const transcript = { ...doc(2, 2), timed: false, completedChunks: [1], cues: doc(2, 2).cues.map((cue) => ({ ...cue, startMs: 0, endMs: 0, chunkIndex: 1 })) };
    put("A", transcript);
    const continued = { ...transcript, revision: 3, completedChunks: [0, 1] };
    vi.mocked(api.transcribePodcast).mockResolvedValue(continued);
    await store.getState().generate("A", 310000, 600000, true);
    expect(api.transcribePodcast).toHaveBeenCalledTimes(1);
    expect(api.transcribePodcast).toHaveBeenCalledWith("A", expect.objectContaining({ chunk: 0, model: "Qwen3-ASR-1.7B", customModel: true, responseFormat: "json" }), expect.any(String));
    vi.mocked(api.translatePodcast).mockResolvedValue({ ...continued, revision: 4 });
    await store.getState().translate("A", 500000);
    expect(api.translatePodcast).toHaveBeenCalledWith("A", [0, 1], 3, expect.any(String), { profileId: "translator", model: "chat-model" });
    expect(store.getState().entries.A.document?.timed).toBe(false);
  });
  it("旧配置默认云端，本地线程范围和类型不合法时回到安全默认值", async () => {
    store.setState({ preferenceLoaded: false });
    vi.mocked(getSetting).mockResolvedValueOnce(JSON.stringify({ profileId: "old", threads: 999, useGpu: "yes" }));
    await store.getState().loadPreference();
    expect(store.getState().preference).toMatchObject({ mode: "cloud", threads: 4, useGpu: false, profileId: "old" });
  });
  it("本地模式无需供应商，沿用时间段续传且不会隐式缓存网络音频", async () => {
    store.setState({ preference: { ...api.DEFAULT_TRANSCRIBE, mode: "local", profileId: "", threads: 2 } });
    put("A", { ...doc(1, 1), completedChunks: [0] });
    vi.mocked(api.whisperStatus).mockResolvedValue({ ready: true, enginePath: "fixture", modelPath: "fixture", problem: "" });
    vi.mocked(api.transcribePodcast).mockResolvedValue({ ...doc(2, 2), completedChunks: [0, 1], recognizer: "local" });
    await store.getState().generate("A", 0, 600000, true);
    expect(api.transcribePodcast).toHaveBeenCalledWith("A", expect.objectContaining({ mode: "local", profileId: "", chunk: 1, threads: 2 }), expect.any(String));
    expect(api.cachePodcastAudio).not.toHaveBeenCalled();
    expect(api.translatePodcast).not.toHaveBeenCalled();
  });
  it("整集续传补齐短段而不清除已有译文", async () => {
    store.setState({ preference: { ...api.DEFAULT_TRANSCRIBE, mode: "local" } });
    const initial = { ...doc(2, 1), durationMs: 40000, completedWindows: [0], cues: [{ ...doc(2, 1).cues[0], translation: "已译" }] };
    put("A", initial);
    vi.mocked(api.whisperStatus).mockResolvedValue({ ready: true, enginePath: "engine", modelPath: "base", problem: "" });
    vi.mocked(api.transcribePodcast).mockResolvedValue({ ...initial, revision: 3, completedWindows: [], completedChunks: [0] });
    await store.getState().generate("A", 0, 40000, true);
    expect(api.transcribePodcast).toHaveBeenCalledTimes(1);
    expect(api.transcribePodcast).toHaveBeenCalledWith("A", expect.objectContaining({ chunk: 0, window: 1, expectedRevision: 2 }), expect.any(String));
    expect(store.getState().entries.A.document?.cues[0].translation).toBe("已译");
  });
  it("本地模型丢失不回退云端，保留已完成字幕", async () => {
    store.setState({ preference: { ...api.DEFAULT_TRANSCRIBE, mode: "local" } });
    put("A", doc(3, 2));
    vi.mocked(api.whisperStatus).mockResolvedValue({ ready: false, enginePath: "fixture", modelPath: "", problem: "请选择模型" });
    await store.getState().generate("A", 0, 900000, false);
    expect(api.transcribePodcast).not.toHaveBeenCalled();
    expect(store.getState().entries.A).toMatchObject({ error: "请选择模型", document: { revision: 3 } });
  });
  it("音频准备必须显式发起，选择取消不改变就绪状态，缓存成功与取消同时发生仍恢复状态", async () => {
    vi.mocked(api.pickPodcastAudio).mockResolvedValue(null);
    await store.getState().prepareAudio("A", true);
    expect(api.cachePodcastAudio).not.toHaveBeenCalled();
    expect(store.getState().entries.A.audioReady).toBe(false);
    const pending = deferred<api.SubtitleView>();
    vi.mocked(api.cachePodcastAudio).mockReturnValue(pending.promise);
    const caching = store.getState().prepareAudio("A", false);
    await store.getState().cancel();
    vi.mocked(api.podcastSubtitles).mockResolvedValue({ document: doc(), hasPublisherTranscript: false, audioReady: true });
    pending.reject(new Error("cancelled")); await caching;
    expect(store.getState().entries.A.audioReady).toBe(true);
  });
  it("迟到读取不覆盖新导入，跨节目数据独立", async () => {
    const old = deferred<api.SubtitleView>();
    vi.mocked(api.podcastSubtitles).mockImplementation((url) => url === "A" ? old.promise : Promise.resolve({ document: doc(3, 2), hasPublisherTranscript: true }));
    const first = store.getState().load("A");
    const duplicate = store.getState().load("A");
    await store.getState().load("B");
    put("A", doc(4, 1));
    old.resolve({ document: doc(1), hasPublisherTranscript: false });
    await Promise.all([first, duplicate]);
    expect(api.podcastSubtitles).toHaveBeenCalledTimes(2);
    expect(store.getState().entries.A.document?.revision).toBe(4);
    expect(store.getState().entries.B.document?.revision).toBe(3);
  });
  it("未提供字幕是普通提示，不产生红色错误或无限自动重试", async () => {
    vi.mocked(api.fetchPodcastSubtitles).mockResolvedValue(null);
    await store.getState().fetchPublisher("A");
    expect(store.getState().entries.A).toMatchObject({ error: "", notice: expect.stringContaining("未提供"), publisherChecked: true });
  });
  it("按当前位置优先续传，跳过已完成段，失败保留此前成果", async () => {
    put("A", { ...doc(1, 1), completedChunks: [0] });
    const updated = { ...doc(2, 2), completedChunks: [0, 2] };
    vi.mocked(api.transcribePodcast).mockResolvedValueOnce(updated).mockRejectedValueOnce(new Error("quota"));
    vi.mocked(api.podcastSubtitles).mockResolvedValue({ document: updated, hasPublisherTranscript: false });
    await store.getState().generate("A", 610000, 900000, true);
    expect(vi.mocked(api.transcribePodcast).mock.calls.map(([, options]) => options.chunk)).toEqual([2, 1]);
    expect(store.getState().entries.A.document).toEqual(updated);
    expect(store.getState().entries.A.error).toBe("quota");
    expect(store.getState().task).toBeNull();
  });
  it("取消阻止下一批，提交与取消同时发生时恢复数据库版本，再试只补缺段", async () => {
    const pending = deferred<SubtitleDocument>();
    vi.mocked(api.transcribePodcast).mockReturnValueOnce(pending.promise);
    const generating = store.getState().generate("A", 0, 900000, true);
    await vi.waitFor(() => expect(api.transcribePodcast).toHaveBeenCalledTimes(1));
    const id = store.getState().task!.id;
    await store.getState().cancel();
    expect(api.cancelPodcastSubtitles).toHaveBeenCalledWith(id);
    const saved = { ...doc(1, 2), completedChunks: [0] };
    vi.mocked(api.podcastSubtitles).mockResolvedValue({ document: saved, hasPublisherTranscript: false });
    pending.reject(new Error("cancelled"));
    await generating;
    expect(api.transcribePodcast).toHaveBeenCalledTimes(1);
    expect(store.getState().entries.A).toMatchObject({ error: "", document: saved });
    vi.mocked(api.transcribePodcast).mockResolvedValue({ ...saved, revision: 2, completedChunks: [0, 1] });
    await store.getState().generate("A", 0, 600000, true);
    expect(vi.mocked(api.transcribePodcast).mock.calls[1][1].chunk).toBe(1);
  });
  it("拒绝同时启动另一个收费任务，晚返回内容保留在原节目", async () => {
    const pending = deferred<SubtitleDocument>();
    vi.mocked(api.transcribePodcast).mockReturnValueOnce(pending.promise);
    const first = store.getState().generate("A", 0, 900000, false);
    await vi.waitFor(() => expect(api.transcribePodcast).toHaveBeenCalledTimes(1));
    await store.getState().generate("B", 0, 900000, true);
    expect(store.getState().entries.B.error).toContain("已有字幕任务");
    pending.resolve(doc(1, 1)); await first;
    expect(store.getState().entries.A.document?.cues).toHaveLength(1);
    expect(store.getState().entries.B.document).toBeNull();
  });
  it("翻译按句 ID 批次保存，重试只发送未翻译部分", async () => {
    const initial = doc(1, 14); put("A", initial);
    const partial = { ...initial, revision: 2, cues: initial.cues.map((cue, i) => ({ ...cue, translation: i < 12 ? `译文 ${i}` : "" })) };
    vi.mocked(api.translatePodcast).mockResolvedValueOnce(partial).mockRejectedValueOnce(new Error("timeout"));
    vi.mocked(api.podcastSubtitles).mockResolvedValue({ document: partial, hasPublisherTranscript: false });
    await store.getState().translate("A", 0);
    expect(store.getState().entries.A.document).toEqual(partial);
    expect(vi.mocked(api.translatePodcast).mock.calls[1].slice(1, 3)).toEqual([[12, 13], 2]);
    vi.mocked(api.translatePodcast).mockResolvedValueOnce({ ...partial, revision: 3 });
    await store.getState().translate("A", 0);
    expect(vi.mocked(api.translatePodcast).mock.calls[2].slice(1, 3)).toEqual([[12, 13], 2]);
  });
  it("导入携带版本和任务标识，过大文件不读取", async () => {
    put("A", doc(4, 1));
    vi.mocked(api.importPodcastSubtitles).mockResolvedValue(doc(5, 2));
    await store.getState().importFile("A", { name: "example.vtt", size: 10, text: async () => "WEBVTT" } as File);
    expect(api.importPodcastSubtitles).toHaveBeenCalledWith("A", "WEBVTT", "vtt", 4, expect.any(String));
    const text = vi.fn();
    await store.getState().importFile("A", { name: "big.vtt", size: 9 * 1024 * 1024, text } as unknown as File);
    expect(text).not.toHaveBeenCalled();
    expect(store.getState().entries.A.document?.revision).toBe(5);
  });
  it("偏好恢复与保存竞态不会覆盖新选择，也不保存密钥", async () => {
    const read = deferred<string>();
    vi.mocked(getSetting).mockReturnValueOnce(read.promise);
    store.setState({ preferenceLoaded: false });
    const loading = store.getState().loadPreference();
    const next = { ...api.DEFAULT_TRANSCRIBE, profileId: "new", language: "en" };
    await store.getState().savePreference(next);
    read.resolve(JSON.stringify({ ...api.DEFAULT_TRANSCRIBE, profileId: "old" })); await loading;
    expect(store.getState().preference).toEqual(next);
    expect(setSetting).toHaveBeenCalledWith("podcast.transcription", JSON.stringify(next));
  });
});

describe("字幕定位与分段", () => {
  it("短段覆盖以完成记录为准，包含静音、边界与尾段", () => {
    const d = { ...doc(1), completedChunks: [0], completedWindows: [15, 17] };
    expect(nextSubtitleWindow(d, 0, 900000)).toBeUndefined();
    expect(nextSubtitleWindow(d, 301000, 900000)).toBe(16);
    expect(nextSubtitleWindow(d, 646000, 647008)).toBe(32);
    expect(nextSubtitleWindow(d, 660000, 647008)).toBeUndefined();
    expect(nextSubtitleWindow(null, 0, 900000)).toBe(0);
  });
  it("句子结束后的空白不高亮，片尾仍可定位上一句", () => {
    const cues = doc(1, 3).cues;
    expect(subtitleIndex(cues, 0)).toBe(0);
    expect(subtitleIndex(cues, 3000)).toBe(-1);
    expect(precedingSubtitleIndex(cues, 4000)).toBe(0);
    expect(precedingSubtitleIndex(cues, 30000)).toBe(2);
    expect(subtitleIndex([], 100)).toBe(-1);
  });
  it("未知时长仅支持当前位置，整集按当前位置先后续传", () => {
    expect(pendingChunks(610000, 1200000, [1], true)).toEqual([2, 3, 0]);
    expect(pendingChunks(610000, 0, [], false)).toEqual([2]);
    expect(pendingChunks(610000, 0, [2], false)).toEqual([]);
    expect(() => pendingChunks(0, 0, [], true)).toThrow("时长");
  });
});
