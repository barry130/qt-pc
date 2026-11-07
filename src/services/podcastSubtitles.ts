import { Channel, invoke } from "@tauri-apps/api/core";
import modelPresets from "@/lib/podcast-transcription-models.json?raw";

export interface SubtitleCue { startMs: number; endMs: number; text: string; translation: string; chunkIndex?: number }
export interface SubtitleDocument {
  revision: number;
  source: "" | "publisher" | "import" | "asr";
  timed: boolean;
  cues: SubtitleCue[];
  completedChunks: number[];
  completedWindows?: number[];
  durationMs: number;
  recognizer?: "" | "local" | "cloud";
}
export interface SubtitleView { document: SubtitleDocument; hasPublisherTranscript: boolean; audioReady?: boolean; audioFileName?: string }
export interface OfflineStatus { enginePath: string; modelPath: string; ready: boolean; problem: string; cpuOnly?: boolean }
export interface WhisperCatalog { supported: boolean; engineBytes: number; models: { id: string; label: string; bytes: number }[] }
export interface WhisperInstallProgress { id: string; modelId: string; running: boolean; phase: string; label: string; downloadedBytes: number; totalBytes: number; error: string }
export type TranscriptionFormat = "verbose_json" | "diarized_json" | "json" | "text";
export const TRANSCRIPTION_MODELS: ReadonlyArray<{ id: string; label: string; responseFormat: TranscriptionFormat }> = JSON.parse(modelPresets);
export const transcriptionPreset = (model: string): typeof TRANSCRIPTION_MODELS[number] | undefined => TRANSCRIPTION_MODELS.find((item) => item.id === model.trim());
export interface TranscribePreference {
  mode: "cloud" | "local";
  profileId: string;
  model: string;
  customModel: boolean;
  responseFormat: TranscriptionFormat;
  language: string;
  threads: number;
  useGpu: boolean;
  translationMode: "online" | "local";
  autoTranslate: boolean;
  autoRecognize: boolean;
}
export const DEFAULT_TRANSCRIBE: TranscribePreference = {
  mode: "cloud", profileId: "", model: "gpt-4o-transcribe-diarize", customModel: false, responseFormat: "diarized_json", language: "", threads: 4, useGpu: false, translationMode: "online", autoTranslate: false, autoRecognize: true,
};
export const SUBTITLE_CHUNK_MS = 300_000;
export const SUBTITLE_WINDOW_MS = 20_000;
export interface LocalTranslationStatus { supported: boolean; ready: boolean; bytes: number; problem: string; progress: null | { id: string; running: boolean; label: string; downloadedBytes: number; totalBytes: number; error: string } }
export const localTranslationStatus = (): Promise<LocalTranslationStatus> => invoke("podcast_translation_status");
export const installLocalTranslation = (): Promise<void> => invoke("podcast_translation_install");
export const cancelLocalTranslationInstall = (jobId: string): Promise<void> => invoke("podcast_translation_install_cancel", { jobId });
export const podcastSubtitles = (audioUrl: string): Promise<SubtitleView> => invoke("podcast_subtitles", { audioUrl });
export const fetchPodcastSubtitles = (audioUrl: string, jobId: string): Promise<SubtitleDocument | null> => invoke("podcast_subtitles_fetch", { audioUrl, jobId });
export const importPodcastSubtitles = (audioUrl: string, text: string, format: string, expectedRevision: number, jobId: string): Promise<SubtitleDocument> => invoke("podcast_subtitles_import", { audioUrl, text, format, expectedRevision, jobId });
export const transcribePodcast = (audioUrl: string, options: TranscribePreference & { chunk: number; window?: number; replace?: boolean; expectedRevision?: number }, jobId: string): Promise<SubtitleDocument> => invoke("podcast_subtitles_transcribe", { audioUrl, options, jobId });
export const podcastTranscriptionModels = (profileId: string): Promise<string[]> => invoke("podcast_transcription_models", { profileId });
export const translatePodcast = (audioUrl: string, indexes: number[], expectedRevision: number, jobId: string, target: { profileId: string; model: string; local?: boolean }): Promise<SubtitleDocument> => invoke("podcast_subtitles_translate", { audioUrl, indexes, expectedRevision, jobId, ...target });
export const cancelPodcastSubtitles = (jobId: string): Promise<void> => invoke("podcast_subtitles_cancel", { jobId });
export const whisperStatus = (): Promise<OfflineStatus> => invoke("podcast_whisper_status");
export const whisperCatalog = (): Promise<WhisperCatalog> => invoke("podcast_whisper_catalog");
export const installWhisper = (modelId: string): Promise<WhisperInstallProgress> => invoke("podcast_whisper_install", { modelId });
export const whisperInstallProgress = (): Promise<WhisperInstallProgress | null> => invoke("podcast_whisper_install_progress");
export const cancelWhisperInstall = (jobId: string): Promise<void> => invoke("podcast_whisper_install_cancel", { jobId });
export const pickWhisperFile = (kind: "engine" | "model"): Promise<OfflineStatus | null> => invoke("podcast_whisper_pick", { kind });
export interface AudioDownloadProgress { downloadedBytes: number; totalBytes: number | null }
export const cachePodcastAudio = (audioUrl: string, jobId: string, onProgress?: (progress: AudioDownloadProgress) => void): Promise<SubtitleView> =>
  invoke("podcast_subtitles_cache_audio", { audioUrl, jobId, onProgress: new Channel<AudioDownloadProgress>(onProgress) });
export const pickPodcastAudio = (audioUrl: string, jobId: string): Promise<SubtitleView | null> => invoke("podcast_subtitles_pick_audio", { audioUrl, jobId });
