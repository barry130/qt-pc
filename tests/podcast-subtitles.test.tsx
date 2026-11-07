// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { SubtitleDocument } from "@/services/podcastSubtitles";
vi.mock("@/services/podcastSubtitles", async (original) => ({
  ...await original<typeof import("@/services/podcastSubtitles")>(),
  podcastSubtitles: vi.fn(), fetchPodcastSubtitles: vi.fn(), whisperStatus: vi.fn(), pickWhisperFile: vi.fn(), pickPodcastAudio: vi.fn(), cachePodcastAudio: vi.fn(), transcribePodcast: vi.fn(), podcastTranscriptionModels: vi.fn(),
  whisperCatalog: vi.fn(), installWhisper: vi.fn(), whisperInstallProgress: vi.fn(), cancelWhisperInstall: vi.fn(),
  localTranslationStatus: vi.fn(), installLocalTranslation: vi.fn(), cancelLocalTranslationInstall: vi.fn(),
}));
vi.mock("@/services/ipc", () => ({ getSetting: vi.fn(async () => null), setSetting: vi.fn(), aiLocalConfig: vi.fn(async () => ({ profiles: [], activeId: "" })) }));
import * as api from "@/services/podcastSubtitles";
import { PodcastSubtitles } from "@/components/podcast/PodcastSubtitles";
import { usePodcastSubtitleStore as store } from "@/stores/podcastSubtitles";
import { usePlayerStore } from "@/stores/player";
import { SubtitleSettings } from "@/components/podcast/SubtitleSettings";
import { aiLocalConfig } from "@/services/ipc";
import type { AiProfileView } from "@/types";

const fixture: SubtitleDocument = { revision: 1, source: "publisher", timed: true, durationMs: 20000, completedChunks: [], cues: [
  { startMs: 1000, endMs: 4000, text: "Hello world", translation: "你好，世界" },
  { startMs: 6000, endMs: 9000, text: "Take your time", translation: "慢慢来" },
  { startMs: 12000, endMs: 15000, text: "Listen closely", translation: "" },
] };
const seek = vi.fn(async () => true);
async function position(ms: number) {
  await act(async () => usePlayerStore.setState({ positionAnchorValue: ms, interpolatedPositionMs: () => ms }));
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.podcastSubtitles).mockResolvedValue({ document: structuredClone(fixture), hasPublisherTranscript: true });
  vi.mocked(api.fetchPodcastSubtitles).mockResolvedValue(null);
  vi.mocked(api.whisperStatus).mockResolvedValue({ ready: false, enginePath: "", modelPath: "", problem: "请选择本地引擎" });
  vi.mocked(api.whisperCatalog).mockResolvedValue({ supported: true, engineBytes: 8928640, models: [{ id: "tiny", label: "tiny · 轻量快速", bytes: 77691713 }, { id: "base", label: "base · 推荐", bytes: 147951465 }, { id: "small", label: "small · 更准确，较慢", bytes: 487601967 }] });
  vi.mocked(api.whisperInstallProgress).mockResolvedValue(null);
  vi.mocked(aiLocalConfig).mockResolvedValue({ profiles: [], activeId: "" });
  vi.mocked(api.podcastTranscriptionModels).mockResolvedValue(["whisper-1", "gpt-4o-transcribe-diarize"]);
  store.setState({ entries: {}, task: null, preferenceLoaded: true, preference: api.DEFAULT_TRANSCRIBE });
  usePlayerStore.setState({ state: { ...usePlayerStore.getState().state!, status: "paused" }, positionAnchorValue: 2000, pendingSeekMs: null, interpolatedPositionMs: () => 2000, seekTo: seek });
  Element.prototype.scrollTo = vi.fn();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});

function provider(id: string): AiProfileView {
  return { id, name: id, baseUrl: `https://${id}.test/v1`, protocol: "openai", model: "chat-model", models: ["chat-model"], hasKey: true, keyMask: "masked", keyMasks: ["masked"], icon: "", skipCertVerify: false };
}
function cloudSettings() {
  // 当前聊天档案刻意不是转写档案；已保存模型也刻意不含转写模型。
  vi.mocked(aiLocalConfig).mockResolvedValue({ profiles: [provider("crouter"), provider("other")], activeId: "other" });
  store.setState({ preference: { ...api.DEFAULT_TRANSCRIBE, profileId: "crouter" } });
}

it("可选轻量本地翻译，显式下载并展示进度，不依赖在线模型", async () => {
  cloudSettings();
  vi.mocked(api.installLocalTranslation).mockResolvedValue(undefined);
  vi.mocked(api.cancelLocalTranslationInstall).mockResolvedValue(undefined);
  vi.mocked(api.localTranslationStatus).mockResolvedValue({ supported: true, ready: false, bytes: 117288717, problem: "请先下载英译中模型", progress: null });
  render(<SubtitleSettings onClose={vi.fn()} />);
  await waitFor(() => expect(api.podcastTranscriptionModels).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText("中文翻译方式"), { target: { value: "local" } });
  await screen.findByText("请先下载英译中模型");
  expect(api.installLocalTranslation).not.toHaveBeenCalled();
  vi.mocked(api.localTranslationStatus).mockResolvedValue({ supported: true, ready: false, bytes: 117288717, problem: "", progress: { id: "translation-install", running: true, label: "正在下载本地翻译…", downloadedBytes: 1000000, totalBytes: 117288717, error: "" } });
  fireEvent.click(screen.getByRole("button", { name: "下载英译中模型" }));
  await screen.findByRole("progressbar", { name: "翻译模型下载进度" });
  expect(api.installLocalTranslation).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "取消翻译模型下载" }));
  expect(api.cancelLocalTranslationInstall).toHaveBeenCalledWith("translation-install");
  fireEvent.click(screen.getByLabelText("边播边识别时，自动本地翻译新字幕"));
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() => expect(store.getState().preference).toMatchObject({ translationMode: "local", autoTranslate: true }));
});

it("本地模型可以直接下载安装，完成后自动填入路径并禁用 CPU 引擎的显卡选项", async () => {
  store.setState({ preference: { ...api.DEFAULT_TRANSCRIBE, mode: "local", useGpu: true } });
  const task = { id: "download", modelId: "tiny", running: true, phase: "model", label: "正在下载语音模型…", downloadedBytes: 10000000, totalBytes: 77691713, error: "" };
  vi.mocked(api.installWhisper).mockResolvedValue(task);
  const close = vi.fn();
  render(<SubtitleSettings onClose={close} />);
  await waitFor(() => expect((screen.getByRole("button", { name: "下载并自动配置" }) as HTMLButtonElement).disabled).toBe(false));
  expect(api.installWhisper).not.toHaveBeenCalled();
  expect((screen.getByLabelText("下载离线模型") as HTMLSelectElement).value).toBe("base");
  fireEvent.change(screen.getByLabelText("下载离线模型"), { target: { value: "tiny" } });
  vi.mocked(api.whisperInstallProgress).mockResolvedValue(task);
  fireEvent.click(screen.getByRole("button", { name: "下载并自动配置" }));
  await screen.findByRole("progressbar");
  expect(api.installWhisper).toHaveBeenCalledWith("tiny");
  expect(api.pickWhisperFile).not.toHaveBeenCalled();
  await waitFor(() => expect((screen.getByRole("button", { name: "选择引擎" }) as HTMLButtonElement).disabled).toBe(true));
  vi.mocked(api.whisperStatus).mockResolvedValue({ ready: true, enginePath: "managed/whisper-cli.exe", modelPath: "managed/ggml-tiny.bin", problem: "", cpuOnly: true });
  vi.mocked(api.whisperInstallProgress).mockResolvedValue({ ...task, running: false, phase: "done", label: "安装完成" });
  await waitFor(() => expect((screen.getByLabelText("本地语音模型路径") as HTMLInputElement).value).toContain("ggml-tiny.bin"));
  expect((screen.getByRole("checkbox", { name: /启用显卡加速/ }) as HTMLInputElement).disabled).toBe(true);
  await waitFor(() => expect((screen.getByRole("button", { name: "保存设置" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(store.getState().preference.useGpu).toBe(false);
});

it("重新打开设置会恢复下载进度；取消与失败均可重试且不覆盖原文件", async () => {
  store.setState({ preference: { ...api.DEFAULT_TRANSCRIBE, mode: "local" } });
  const task = { id: "download-old", modelId: "small", running: true, phase: "model", label: "正在下载语音模型…", downloadedBytes: 10000000, totalBytes: 487601967, error: "" };
  vi.mocked(api.whisperStatus).mockResolvedValue({ ready: true, enginePath: "old/whisper-cli.exe", modelPath: "old/model.bin", problem: "" });
  vi.mocked(api.whisperInstallProgress).mockResolvedValue(task);
  const view = render(<SubtitleSettings onClose={() => {}} />);
  await screen.findByRole("progressbar");
  expect((screen.getByLabelText("下载离线模型") as HTMLSelectElement).value).toBe("small");
  fireEvent.click(screen.getByRole("button", { name: "取消下载" }));
  expect(api.cancelWhisperInstall).toHaveBeenCalledWith("download-old");
  vi.mocked(api.whisperInstallProgress).mockResolvedValue({ ...task, running: false, phase: "cancelled", label: "已取消" });
  await screen.findByText("已取消");
  expect((screen.getByLabelText("本地语音模型路径") as HTMLInputElement).value).toBe("old/model.bin");
  view.unmount();
  vi.mocked(api.whisperInstallProgress).mockResolvedValue({ ...task, running: false, phase: "error", label: "下载失败", error: "SHA-256 校验失败" });
  render(<SubtitleSettings onClose={() => {}} />);
  expect((await screen.findByRole("alert")).textContent).toContain("SHA-256");
  expect(screen.getByRole("button", { name: "重试下载并配置" })).toBeTruthy();
});

it("转写模型用下拉框，内置格式自动匹配，最后为自定义", async () => {
  cloudSettings();
  const close = vi.fn();
  render(<SubtitleSettings onClose={close} />);
  await waitFor(() => expect(api.podcastTranscriptionModels).toHaveBeenCalledWith("crouter"));
  const model = screen.getByRole("combobox", { name: "语音转写模型" }) as HTMLSelectElement;
  expect(Array.from(model.options).map((option) => option.value)).toEqual(["gpt-4o-transcribe-diarize", "whisper-1", "custom"]);
  expect(model.options[2].text).toBe("自定义（不保证可用）");
  expect(screen.queryByRole("textbox", { name: "语音转写模型" })).toBeNull();
  fireEvent.change(model, { target: { value: "whisper-1" } });
  expect(screen.getByText("返回格式：verbose_json（自动匹配）")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(store.getState().preference).toMatchObject({ profileId: "crouter", model: "whisper-1", responseFormat: "verbose_json", customModel: false });
});

it("供应商缺少内置模型时直接提示，不能保存，也不发转写请求", async () => {
  cloudSettings();
  vi.mocked(api.podcastTranscriptionModels).mockResolvedValue(["Qwen3-ASR-1.7B"]);
  const close = vi.fn();
  render(<SubtitleSettings onClose={close} />);
  expect((await screen.findByRole("alert")).textContent).toContain("crouter 的模型列表中没有 gpt-4o-transcribe-diarize");
  expect((screen.getByRole("button", { name: "保存设置" }) as HTMLButtonElement).disabled).toBe(true);
  expect(api.transcribePodcast).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});

it("模型列表请求失败不误报缺失，自定义可带提示保存 JSON 或纯文本", async () => {
  cloudSettings();
  vi.mocked(api.podcastTranscriptionModels).mockRejectedValue(new Error("HTTP 404"));
  const close = vi.fn();
  render(<SubtitleSettings onClose={close} />);
  expect((await screen.findByRole("alert")).textContent).toContain("无法核实模型列表");
  expect(screen.queryByText(/模型列表中没有/)).toBeNull();
  fireEvent.change(screen.getByLabelText("语音转写模型"), { target: { value: "custom" } });
  expect((screen.getByRole("button", { name: "保存设置" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("自定义模型名称"), { target: { value: " Qwen3-ASR-1.7B " } });
  expect((screen.getByLabelText("返回格式") as HTMLSelectElement).value).toBe("json");
  expect(screen.getByText(/自定义模式仍可保存并尝试/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("返回格式"), { target: { value: "text" } });
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(store.getState().preference).toMatchObject({ customModel: true, model: "Qwen3-ASR-1.7B", responseFormat: "text" });
});

it("切换供应商后迟到的模型列表不会覆盖当前选择，刷新可重新核实", async () => {
  cloudSettings();
  let finish!: (ids: string[]) => void;
  const pending = new Promise<string[]>((resolve) => { finish = resolve; });
  vi.mocked(api.podcastTranscriptionModels).mockImplementation((id) => id === "crouter" ? pending : Promise.resolve([]));
  render(<SubtitleSettings onClose={vi.fn()} />);
  await waitFor(() => expect(api.podcastTranscriptionModels).toHaveBeenCalledWith("crouter"));
  fireEvent.change(screen.getByLabelText("语音转写供应商"), { target: { value: "other" } });
  expect((await screen.findByRole("alert")).textContent).toContain("other 的模型列表中没有");
  await act(async () => finish(["gpt-4o-transcribe-diarize"]));
  expect(screen.getByRole("alert").textContent).toContain("other 的模型列表中没有");
  expect((screen.getByRole("button", { name: "保存设置" }) as HTMLButtonElement).disabled).toBe(true);
  vi.mocked(api.podcastTranscriptionModels).mockResolvedValue(["gpt-4o-transcribe-diarize"]);
  fireEvent.click(screen.getByRole("button", { name: "刷新模型列表" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "保存设置" }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("生成的无时间轴文字稿展示双语并禁用跳转", async () => {
  vi.mocked(api.podcastSubtitles).mockResolvedValue({ document: { ...fixture, timed: false, source: "asr", cues: fixture.cues.map((cue) => ({ ...cue, startMs: 0, endMs: 0, chunkIndex: 1 })) }, hasPublisherTranscript: false });
  render(<PodcastSubtitles audioUrl="A" />);
  await screen.findByText(/部分转写结果未提供完整时间轴/);
  expect(screen.getByText("Hello world")).toBeTruthy();
  expect(screen.getByText("你好，世界")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "重听本句" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^跳到/ })).toBeNull();
  expect((screen.getByRole("button", { name: "翻译中文" }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByText("Hello world").closest("button") as HTMLButtonElement).disabled).toBe(true);
});

it("本地翻译保留中文时双语只显示一次，中文模式仍可阅读", async () => {
  const chinese = "这是节目原有的中文内容。";
  vi.mocked(api.podcastSubtitles).mockResolvedValue({ document: { ...fixture, cues: [{ ...fixture.cues[0], text: chinese, translation: chinese }] }, hasPublisherTranscript: true });
  render(<PodcastSubtitles audioUrl="A" />);
  await screen.findByText(chinese);
  expect(screen.getAllByText(chinese)).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("字幕显示语言"), { target: { value: "translation" } });
  expect(screen.getAllByText(chinese)).toHaveLength(1);
});

it("已完成整集可重新生成，确认前不清空或发起任务，成功后恢复同步字幕", async () => {
  store.setState({ preference: { ...api.DEFAULT_TRANSCRIBE, mode: "local" } });
  usePlayerStore.setState({ durationMs: 600000 });
  const old = { ...fixture, source: "asr" as const, timed: false, completedChunks: [0, 1], cues: fixture.cues.map((cue) => ({ ...cue, startMs: 0, endMs: 0, chunkIndex: 0 })) };
  vi.mocked(api.podcastSubtitles).mockResolvedValue({ document: old, hasPublisherTranscript: false, audioReady: true });
  vi.mocked(api.whisperStatus).mockResolvedValue({ ready: true, enginePath: "engine", modelPath: "base", problem: "" });
  vi.mocked(api.transcribePodcast).mockResolvedValue({ ...old, revision: 2, timed: true, cues: fixture.cues });
  render(<PodcastSubtitles audioUrl="A" />);
  await screen.findByText("整集已生成");
  expect(screen.queryByRole("button", { name: "继续生成整集" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重新生成整集" }));
  await screen.findByRole("dialog", { name: "重新生成整集字幕？" });
  expect(api.transcribePodcast).not.toHaveBeenCalled();
  expect(store.getState().entries.A.document?.cues).toEqual(old.cues);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(api.transcribePodcast).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "重新生成整集" }));
  fireEvent.click(screen.getByRole("button", { name: "开始重新生成" }));
  await screen.findByRole("button", { name: "重听本句" });
  await waitFor(() => expect(api.transcribePodcast).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.transcribePodcast).mock.calls[0][1]).toMatchObject({ chunk: 0, replace: true, expectedRevision: 1 });
});

it("已完成的当前五分钟会确认重识别，换集后不会把确认请求用到另一集", async () => {
  store.setState({ preference: { ...api.DEFAULT_TRANSCRIBE, mode: "local" } });
  vi.mocked(api.podcastSubtitles).mockResolvedValue({ document: { ...fixture, source: "asr", completedChunks: [0] }, hasPublisherTranscript: false });
  const view = render(<PodcastSubtitles audioUrl="A" />);
  await screen.findByText("Hello world");
  fireEvent.click(screen.getByRole("button", { name: "生成当前五分钟" }));
  await screen.findByRole("dialog", { name: "重新生成当前五分钟？" });
  view.rerender(<PodcastSubtitles audioUrl="B" />);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.transcribePodcast).not.toHaveBeenCalled();
});

it("离线页面不会自动请求节目字幕，只在点击后选择本地音频", async () => {
  store.setState({ preference: { ...api.DEFAULT_TRANSCRIBE, mode: "local" } });
  const document = { ...fixture, source: "" as const, revision: 0, cues: [] };
  vi.mocked(api.podcastSubtitles).mockResolvedValue({ document, hasPublisherTranscript: false, audioReady: false });
  vi.mocked(api.pickPodcastAudio).mockResolvedValue({ document, hasPublisherTranscript: false, audioReady: true, audioFileName: "episode.mp3" });
  render(<PodcastSubtitles audioUrl="A" />);
  await screen.findByText("尚未缓存 · 开始识别时自动下载");
  expect(api.fetchPodcastSubtitles).not.toHaveBeenCalled();
  expect(api.cachePodcastAudio).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "选择本地音频" }));
  await screen.findByText("episode.mp3");
  expect(api.pickPodcastAudio).toHaveBeenCalledWith("A", expect.any(String));
  expect((screen.getByRole("button", { name: "缓存节目音频" }) as HTMLButtonElement).disabled).toBe(true);
});

it("新节目未缓存时仍可点击边播边识别，离开页面继续准备，可手动停止", async () => {
  store.setState({ preference: { ...api.DEFAULT_TRANSCRIBE, mode: "local" } });
  usePlayerStore.setState({ state: { ...usePlayerStore.getState().state!, status: "playing", track: { ...usePlayerStore.getState().state?.track, id: "A" } as NonNullable<ReturnType<typeof usePlayerStore.getState>["state"]>["track"] } });
  vi.mocked(api.whisperStatus).mockResolvedValue({ ready: true, enginePath: "engine", modelPath: "base", problem: "" });
  const document = { ...fixture, source: "" as const, revision: 0, cues: [] };
  vi.mocked(api.podcastSubtitles).mockResolvedValue({ document, hasPublisherTranscript: false, audioReady: false });
  let finish!: (view: api.SubtitleView) => void;
  vi.mocked(api.cachePodcastAudio).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const cancel = vi.spyOn(store.getState(), "cancel").mockImplementation(async () => {
    store.setState((state) => ({ task: state.task ? { ...state.task, cancelling: true } : null }));
  });
  const view = render(<PodcastSubtitles audioUrl="A" />);
  await screen.findByText("尚未缓存 · 开始识别时自动下载");
  const start = screen.getByRole("button", { name: "边播边识别" }) as HTMLButtonElement;
  expect(start.disabled).toBe(false);
  expect(api.cachePodcastAudio).not.toHaveBeenCalled();
  fireEvent.click(start);
  await screen.findByText(/正在缓存节目音频.*完成后自动开始识别/);
  expect(api.cachePodcastAudio).toHaveBeenCalledWith("A", expect.any(String), expect.any(Function));
  expect(api.transcribePodcast).not.toHaveBeenCalled();
  view.unmount();
  expect(cancel).not.toHaveBeenCalled();
  await store.getState().cancel();
  expect(cancel).toHaveBeenCalledTimes(1);
  await act(async () => finish({ document, hasPublisherTranscript: false, audioReady: true }));
  await waitFor(() => expect(store.getState().task).toBeNull());
  expect(api.transcribePodcast).not.toHaveBeenCalled();
  cancel.mockRestore();
});

it("本地模式默认自动识别，可关闭并保存", async () => {
  store.setState({ preference: { ...api.DEFAULT_TRANSCRIBE, mode: "local" } });
  vi.mocked(api.whisperStatus).mockResolvedValue({ ready: true, enginePath: "engine", modelPath: "base", problem: "" });
  render(<SubtitleSettings onClose={vi.fn()} />);
  await waitFor(() => expect((screen.getByRole("button", { name: "保存设置" }) as HTMLButtonElement).disabled).toBe(false));
  const automatic = screen.getByRole("checkbox", { name: "播放播客时自动识别字幕" }) as HTMLInputElement;
  expect(automatic.checked).toBe(true);
  fireEvent.click(automatic);
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() => expect(store.getState().preference.autoRecognize).toBe(false));
});

it("没有 AI 供应商也能配置本地识别，引擎和模型齐全才可保存", async () => {
  vi.mocked(aiLocalConfig).mockRejectedValue(new Error("AI configuration unavailable"));
  const close = vi.fn();
  render(<SubtitleSettings onClose={close} />);
  await waitFor(() => expect((screen.getByLabelText("识别方式") as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("识别方式"), { target: { value: "local" } });
  expect(screen.queryByLabelText("语音转写供应商")).toBeNull();
  expect((screen.getByRole("button", { name: "保存设置" }) as HTMLButtonElement).disabled).toBe(true);
  vi.mocked(api.pickWhisperFile).mockResolvedValueOnce({ ready: false, enginePath: "C:/engine/whisper-cli.exe", modelPath: "", problem: "请选择模型" });
  await waitFor(() => expect((screen.getByRole("button", { name: "选择引擎" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "选择引擎" }));
  await screen.findByDisplayValue("C:/engine/whisper-cli.exe");
  vi.mocked(api.pickWhisperFile).mockResolvedValueOnce({ ready: true, enginePath: "C:/engine/whisper-cli.exe", modelPath: "C:/models/ggml-base.bin", problem: "" });
  fireEvent.click(screen.getByRole("button", { name: "选择模型" }));
  await screen.findByDisplayValue("C:/models/ggml-base.bin");
  fireEvent.change(screen.getByLabelText("CPU 线程数"), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(store.getState().preference).toMatchObject({ mode: "local", threads: 2, useGpu: false });
});

it("双语、原文、中文显示与点句跳转、重听", async () => {
  render(<PodcastSubtitles audioUrl="A" />);
  expect(await screen.findByText("Hello world")).toBeTruthy();
  expect(screen.getByText("你好，世界")).toBeTruthy();
  const current = screen.getByRole("button", { name: /跳到 0:01：Hello world/ });
  expect(current.getAttribute("aria-current")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "重听本句" }));
  expect(seek).toHaveBeenLastCalledWith(1000);
  fireEvent.click(screen.getByRole("button", { name: /跳到 0:06：/ }));
  expect(seek).toHaveBeenLastCalledWith(6000);
  fireEvent.change(screen.getByLabelText("字幕显示语言"), { target: { value: "original" } });
  expect(screen.queryByText("你好，世界")).toBeNull();
  fireEvent.change(screen.getByLabelText("字幕显示语言"), { target: { value: "translation" } });
  expect(screen.queryByText("Hello world")).toBeNull();
  expect(screen.getByText("你好，世界")).toBeTruthy();
  expect(screen.getByText("暂无译文，显示原文")).toBeTruthy();
});

it("单击字幕不关闭跟随，手动翻阅后点句或拖动进度会恢复定位", async () => {
  render(<PodcastSubtitles audioUrl="A" />);
  const row = await screen.findByRole("button", { name: /跳到 0:06：/ });
  fireEvent.pointerDown(row);
  fireEvent.click(row);
  expect(screen.queryByRole("button", { name: "回到当前播放" })).toBeNull();
  fireEvent.wheel(screen.getByLabelText("字幕正文"));
  expect(screen.getByRole("button", { name: "回到当前播放" })).toBeTruthy();
  fireEvent.click(row);
  expect(screen.queryByRole("button", { name: "回到当前播放" })).toBeNull();
  fireEvent.wheel(screen.getByLabelText("字幕正文"));
  await act(async () => usePlayerStore.setState({ pendingSeekMs: 13000 }));
  expect(screen.queryByRole("button", { name: "回到当前播放" })).toBeNull();
});

it("停止翻阅四秒恢复当前行，重复滚动会延长等待时间", async () => {
  const view = render(<PodcastSubtitles audioUrl="A" />);
  await screen.findByText("Hello world");
  vi.useFakeTimers();
  try {
    fireEvent.wheel(screen.getByLabelText("字幕正文"));
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    fireEvent.wheel(screen.getByLabelText("字幕正文"));
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByRole("button", { name: "回到当前播放" })).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(screen.queryByRole("button", { name: "回到当前播放" })).toBeNull();
    expect(screen.getByText("自动跟随播放")).toBeTruthy();
  } finally { view.unmount(); vi.useRealTimers(); }
});

it("当前位置的字幕晚到时立即按真实布局定位，空白段仍定位最近行", async () => {
  const view = render(<PodcastSubtitles audioUrl="A" />);
  await screen.findByText("Hello world");
  const viewport = screen.getByLabelText("字幕正文");
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 400 });
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({ top: 100 } as DOMRect);
  const row = screen.getByRole("button", { name: /跳到 0:12：/ });
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ top: 800 } as DOMRect);
  vi.mocked(Element.prototype.scrollTo).mockClear();
  await position(13000);
  expect(row.getAttribute("aria-current")).toBe("true");
  expect(Element.prototype.scrollTo).toHaveBeenLastCalledWith({ top: 560, behavior: "instant" });
  await position(16000);
  expect(row.getAttribute("aria-current")).toBeNull();
  const updated = { ...fixture, revision: 2, cues: [...fixture.cues, { startMs: 16000, endMs: 19000, text: "Newly recognized", translation: "" }] };
  await act(async () => store.setState((state) => ({ entries: { A: { ...state.entries.A, document: updated } } })));
  expect(screen.getByRole("button", { name: /跳到 0:16：Newly recognized/ }).getAttribute("aria-current")).toBe("true");
  view.unmount();
});

it("拖动到空白或片尾，高亮清空且上一句不会错误跳回开头", async () => {
  render(<PodcastSubtitles audioUrl="A" />);
  await screen.findByText("Hello world");
  await position(10000);
  expect(document.querySelector('[aria-current="true"]')).toBeNull();
  expect((screen.getByRole("button", { name: "重听本句" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "上一句" })); expect(seek).toHaveBeenLastCalledWith(6000);
  await position(20000);
  fireEvent.click(screen.getByRole("button", { name: "上一句" })); expect(seek).toHaveBeenLastCalledWith(12000);
  expect((screen.getByRole("button", { name: "下一句" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.wheel(screen.getByLabelText("字幕正文"));
  expect(screen.getByRole("button", { name: "回到当前播放" })).toBeTruthy();
});

it("文字稿保留阅读翻译，隐藏同步跳转与重听", async () => {
  vi.mocked(api.podcastSubtitles).mockResolvedValue({ document: { ...fixture, timed: false, source: "import" }, hasPublisherTranscript: false });
  render(<PodcastSubtitles audioUrl="A" />);
  expect(await screen.findByText(/节目未提供同步时间轴/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "重听本句" })).toBeNull();
  expect((screen.getByText("Hello world").closest("button") as HTMLButtonElement).disabled).toBe(true);
});

it("没有节目字幕只自动查一次，生成前可打开供应商设置", async () => {
  vi.mocked(api.podcastSubtitles).mockResolvedValue({ document: { ...fixture, revision: 0, source: "", cues: [] }, hasPublisherTranscript: false });
  const view = render(<PodcastSubtitles audioUrl="A" />);
  expect(await screen.findByText(/节目未提供字幕，可导入/)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  view.unmount(); render(<PodcastSubtitles audioUrl="A" />);
  await waitFor(() => expect(store.getState().entries.A.loading).toBe(false));
  expect(api.fetchPodcastSubtitles).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "生成当前五分钟" }));
  expect(await screen.findByRole("dialog", { name: "播客字幕设置" })).toBeTruthy();
  expect(await screen.findByText(/请先到「设置 → AI」添加/)).toBeTruthy();
});

it("长节目分页不创建数万行，随播放翻页并支持手动阅读", async () => {
  const cues = Array.from({ length: 1000 }, (_, i) => ({ startMs: i * 5000, endMs: i * 5000 + 3000, text: `Sentence ${i}`, translation: "" }));
  vi.mocked(api.podcastSubtitles).mockResolvedValue({ document: { ...fixture, cues }, hasPublisherTranscript: true });
  render(<PodcastSubtitles audioUrl="A" />);
  await screen.findByText("Sentence 0");
  expect(screen.queryByText("Sentence 200")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "后 200 句" }));
  expect(screen.getByText("Sentence 200")).toBeTruthy();
  await position(4500000);
  expect(screen.queryByText("Sentence 900")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "回到当前播放" }));
  expect(screen.getByText("Sentence 900")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: /^跳到/ })).toHaveLength(200);
});

it("切集时不会显示前一集的字幕", async () => {
  const view = render(<PodcastSubtitles audioUrl="A" />);
  await screen.findByText("Hello world");
  vi.mocked(api.podcastSubtitles).mockResolvedValue({ document: { ...fixture, cues: [{ ...fixture.cues[0], text: "Next episode", translation: "下一集" }] }, hasPublisherTranscript: true });
  view.rerender(<PodcastSubtitles audioUrl="B" />);
  await screen.findByText("Next episode");
  expect(screen.queryByText("Hello world")).toBeNull();
});
