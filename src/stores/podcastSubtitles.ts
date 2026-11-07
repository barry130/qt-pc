import { create } from "zustand";
import * as api from "@/services/podcastSubtitles";
import { aiLocalConfig, getSetting, setSetting } from "@/services/ipc";
import { errMsg } from "@/lib/utils";

const CONFIG_KEY = "podcast.transcription";
export interface SubtitleEntry { document: api.SubtitleDocument | null; loading: boolean; error: string; notice: string; publisherChecked: boolean; hasPublisherTranscript: boolean; audioReady: boolean; audioFileName: string }
export interface SubtitleTask { id: string; url: string; label: string; cancelling: boolean; kind?: "follow"; automatic?: boolean }
export interface PlaybackCursor { positionMs: number; durationMs: number; playing: boolean; valid: boolean }
export const EMPTY_SUBTITLE_ENTRY: SubtitleEntry = { document: null, loading: false, error: "", notice: "", publisherChecked: false, hasPublisherTranscript: false, audioReady: false, audioFileName: "" };
interface Store {
  entries: Record<string, SubtitleEntry>;
  task: SubtitleTask | null;
  preference: api.TranscribePreference;
  preferenceLoaded: boolean;
  loadPreference: () => Promise<void>;
  savePreference: (value: api.TranscribePreference) => Promise<void>;
  load: (url: string) => Promise<void>;
  fetchPublisher: (url: string) => Promise<void>;
  importFile: (url: string, file: File) => Promise<void>;
  generate: (url: string, positionMs: number, durationMs: number, whole: boolean, replace?: boolean) => Promise<void>;
  translate: (url: string, positionMs: number) => Promise<void>;
  followPlayback: (url: string, cursor: () => PlaybackCursor, automatic?: boolean) => Promise<void>;
  cancel: () => Promise<void>;
  prepareAudio: (url: string, pick: boolean) => Promise<void>;
}
const loading = new Map<string, Promise<void>>();
let preferenceRead: Promise<void> | null = null;
let preferenceRevision = 0;
let preferenceWrites = Promise.resolve();

export function subtitleIndex(cues: api.SubtitleCue[], positionMs: number): number {
  const match = precedingSubtitleIndex(cues, positionMs);
  return match >= 0 && positionMs < cues[match].endMs ? match : -1;
}

export function precedingSubtitleIndex(cues: api.SubtitleCue[], positionMs: number): number {
  let low = 0; let high = cues.length - 1; let match = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (cues[middle].startMs <= positionMs) { match = middle; low = middle + 1; } else high = middle - 1;
  }
  return match;
}

/** 当前附近先处理，再向后到末尾，最后补前面的未完成段；已完成段不重复计费。 */
export function pendingChunks(positionMs: number, durationMs: number, completed: number[], whole: boolean): number[] {
  const start = Math.max(0, Math.floor(positionMs / api.SUBTITLE_CHUNK_MS));
  if (!whole) return completed.includes(start) ? [] : [start];
  if (durationMs <= 0) throw new Error("节目时长尚未读取，请先生成当前五分钟");
  const count = Math.min(576, Math.ceil(durationMs / api.SUBTITLE_CHUNK_MS));
  const pivot = Math.min(start, count - 1);
  const done = new Set(completed);
  return [...Array.from({ length: count - pivot }, (_, i) => i + pivot), ...Array.from({ length: pivot }, (_, i) => i)].filter((i) => !done.has(i));
}

/** Coverage is explicit: silence also counts as processed; cue end times cannot imply coverage. */
export function nextSubtitleWindow(document: api.SubtitleDocument | null, positionMs: number, durationMs: number): number | undefined {
  const first = Math.max(0, Math.floor(positionMs / api.SUBTITLE_WINDOW_MS));
  const last = Math.min(Math.ceil(durationMs / api.SUBTITLE_WINDOW_MS), first + 4, 8640);
  for (let index = first; index < last; index++) {
    if (!document?.completedChunks.includes(Math.floor(index / 15)) && !document?.completedWindows?.includes(index)) return index;
  }
  return undefined;
}

export const usePodcastSubtitleStore = create<Store>((set, get) => {
  const entry = (url: string): SubtitleEntry => get().entries[url] ?? EMPTY_SUBTITLE_ENTRY;
  const patch = (url: string, value: Partial<SubtitleEntry>): void => set((state) => ({ entries: { ...state.entries, [url]: { ...(state.entries[url] ?? EMPTY_SUBTITLE_ENTRY), ...value } } }));
  const apply = (url: string, document: api.SubtitleDocument): void => {
    if (document.revision >= (entry(url).document?.revision ?? 0)) patch(url, { document });
  };
  const applyView = (url: string, view: api.SubtitleView): void => {
    apply(url, view.document);
    patch(url, { hasPublisherTranscript: view.hasPublisherTranscript, audioReady: view.audioReady === true, audioFileName: view.audioFileName ?? "" });
  };
  const run = async (url: string, label: string, work: (id: string, active: () => boolean) => Promise<void>): Promise<void> => {
    if (get().task) { patch(url, { error: "已有字幕任务正在处理，请等待完成或取消后再试" }); return; }
    const id = crypto.randomUUID();
    set({ task: { id, url, label, cancelling: false } });
    patch(url, { error: "", notice: "" });
    const active = (): boolean => get().task?.id === id && !get().task?.cancelling;
    try { await work(id, active); }
    catch (error) {
      if (active()) patch(url, { error: errMsg(error) });
      // 服务完成与取消/前端超时可能同时发生；以数据库为准恢复版本和已完成的批次。
      try { applyView(url, await api.podcastSubtitles(url)); } catch { /* 保留原错误 */ }
    }
    finally {
      if (get().task?.id === id && get().task?.cancelling) {
        try { applyView(url, await api.podcastSubtitles(url)); } catch { /* 重进页面时可再次加载 */ }
      }
      if (get().task?.id === id) set({ task: null });
    }
  };
  const label = (id: string, text: string): void => set((state) => state.task?.id === id ? { task: { ...state.task, label: text } } : {});
  const cacheAudio = async (url: string, id: string, active: () => boolean): Promise<api.SubtitleView> => {
    const started = Date.now();
    let progress: api.AudioDownloadProgress | undefined;
    let finished = false;
    const update = (): void => {
      if (finished || !active()) return;
      const amount = progress ? `${(progress.downloadedBytes / 1e6).toFixed(1)}${progress.totalBytes ? ` / ${(progress.totalBytes / 1e6).toFixed(1)}` : ""} MB` : "正在连接下载源";
      label(id, `正在缓存节目音频 · ${amount} · 已等待 ${Math.floor((Date.now() - started) / 1000)} 秒${get().task?.kind === "follow" ? "，完成后自动开始识别" : ""}…`);
    };
    update();
    const timer = setInterval(update, 1000);
    try { return await api.cachePodcastAudio(url, id, (value) => { progress = value; update(); }); }
    finally { finished = true; clearInterval(timer); }
  };
  return {
    entries: {}, task: null, preference: api.DEFAULT_TRANSCRIBE, preferenceLoaded: false,
    loadPreference: () => {
      if (get().preferenceLoaded) return Promise.resolve();
      if (preferenceRead) return preferenceRead;
      const revision = preferenceRevision;
      preferenceRead = getSetting(CONFIG_KEY).then((raw) => {
        if (revision !== preferenceRevision) return;
        let saved: Partial<api.TranscribePreference> = {};
        try { saved = JSON.parse(raw ?? "{}") ?? {}; } catch { /* 保留缺省 */ }
        const model = typeof saved.model === "string" && saved.model.trim() ? saved.model.trim() : api.DEFAULT_TRANSCRIBE.model;
        const preset = api.transcriptionPreset(model);
        const customModel = saved.customModel === true || !preset;
        const responseFormat = !customModel && preset ? preset.responseFormat
          : saved.customModel === undefined ? "json"
          : ["verbose_json", "diarized_json", "json", "text"].includes(saved.responseFormat ?? "") ? saved.responseFormat! : "json";
        set({ preferenceLoaded: true, preference: {
          mode: saved.mode === "local" ? "local" : "cloud",
          profileId: typeof saved.profileId === "string" ? saved.profileId : "",
          model, customModel, responseFormat,
          language: typeof saved.language === "string" ? saved.language : "",
          threads: typeof saved.threads === "number" && Number.isInteger(saved.threads) && saved.threads >= 1 && saved.threads <= 32 ? saved.threads : 4,
          useGpu: saved.useGpu === true,
          translationMode: saved.translationMode === "local" ? "local" : "online",
          autoTranslate: saved.autoTranslate === true,
          autoRecognize: saved.autoRecognize !== false,
        } });
      }).finally(() => { preferenceRead = null; });
      return preferenceRead;
    },
    savePreference: (value) => {
      const revision = ++preferenceRevision;
      const write = preferenceWrites.catch(() => {}).then(() => setSetting(CONFIG_KEY, JSON.stringify(value)));
      preferenceWrites = write;
      return write.then(() => { if (revision === preferenceRevision) set({ preference: value, preferenceLoaded: true }); });
    },
    load: (url) => {
      if (loading.has(url)) return loading.get(url)!;
      patch(url, { loading: true, error: "" });
      const request = api.podcastSubtitles(url).then((view) => {
        applyView(url, view);
      }).catch((error: unknown) => { patch(url, { error: errMsg(error) }); }).finally(() => { patch(url, { loading: false }); loading.delete(url); });
      loading.set(url, request);
      return request;
    },
    fetchPublisher: (url) => run(url, "正在查找节目字幕…", async (id) => {
      patch(url, { publisherChecked: true });
      const document = await api.fetchPodcastSubtitles(url, id);
      if (document) { apply(url, document); patch(url, { hasPublisherTranscript: true }); }
      else patch(url, { notice: "节目未提供字幕，可导入字幕或生成字幕" });
    }),
    importFile: async (url, file) => {
      await run(url, "正在导入字幕…", async (id, active) => {
        if (file.size > 8 * 1024 * 1024) throw new Error("字幕文件不能超过 8 MB");
        const format = file.name.split(".").pop()?.toLowerCase() ?? "";
        if (!["srt", "vtt", "json", "txt"].includes(format)) throw new Error("请选择 SRT、VTT、JSON 或 TXT 文件");
        const text = await file.text();
        if (!active()) return;
        const document = await api.importPodcastSubtitles(url, text, format, entry(url).document?.revision ?? 0, id);
        apply(url, document);
      });
    },
    generate: (url, positionMs, durationMs, whole, replace = false) => run(url, "正在准备音频并生成字幕…", async (id, active) => {
      await get().loadPreference();
      const preference = get().preference;
      if (preference.mode === "cloud" && (!preference.profileId || !preference.model.trim())) throw new Error("请先在字幕设置中选择转写供应商和模型");
      if (preference.mode === "local") {
        const status = await api.whisperStatus();
        if (!status.ready) throw new Error(status.problem || "请先在字幕设置中选择本地引擎和模型");
      }
      const chunks = pendingChunks(replace && whole ? 0 : positionMs, durationMs, replace ? [] : entry(url).document?.completedChunks ?? [], whole);
      if (!chunks.length) patch(url, { notice: "这些片段已生成；需要更新识别结果时，请选择重新生成。" });
      for (let index = 0; index < chunks.length && active(); index++) {
        const chunk = chunks[index];
        if (!replace && preference.mode === "local" && entry(url).document?.completedWindows?.some((i) => Math.floor(i / 15) === chunk)) {
          const end = Math.min((chunk + 1) * 15, Math.ceil((entry(url).document?.durationMs || durationMs) / api.SUBTITLE_WINDOW_MS));
          for (let window = chunk * 15; window < end && active(); window++) {
            const current = entry(url).document;
            if (current?.completedWindows?.includes(window) || current?.completedChunks.includes(chunk)) continue;
            label(id, `本地识别 ${window * 20}–${(window + 1) * 20} 秒字幕，补齐未完成小段…`);
            apply(url, await api.transcribePodcast(url, { ...preference, chunk, window, expectedRevision: current?.revision ?? 0 }, id));
          }
          continue;
        }
        label(id, `${replace ? "重新生成" : preference.mode === "local" ? "本地识别" : "正在生成"} ${chunk * 5}–${(chunk + 1) * 5} 分钟字幕（${index + 1}/${chunks.length}）${replace ? "，成功后替换该段" : ""}…`);
        const document = await api.transcribePodcast(url, { ...preference, chunk, ...(replace ? { replace: true, expectedRevision: entry(url).document?.revision ?? 0 } : {}) }, id);
        apply(url, document);
      }
    }),
    prepareAudio: (url, pick) => run(url, pick ? "正在选择本地节目音频…" : "正在缓存节目音频，可取消…", async (id, active) => {
      const view = await (pick ? api.pickPodcastAudio(url, id) : cacheAudio(url, id, active));
      if (view) {
        applyView(url, view);
        patch(url, { notice: view.audioReady ? "音频已就绪，可以离线生成字幕" : "" });
      }
    }),
    followPlayback: (url, cursor, automatic = false) => run(url, "正在准备边播边识别…", async (id, active) => {
      set((state) => state.task?.id === id ? { task: { ...state.task, kind: "follow", automatic } } : {});
      await get().loadPreference();
      if (!active() || !cursor().valid) return;
      const preference = get().preference;
      if (preference.mode !== "local") throw new Error("边播边识别需要选择本地识别");
      // Recheck the native cache and existing transcript before downloading or loading models.
      const view = await api.podcastSubtitles(url);
      applyView(url, view);
      if (!active() || !cursor().valid) return;
      if (entry(url).document?.source && entry(url).document?.source !== "asr") {
        if (automatic) return;
        throw new Error("本集已有节目或导入字幕，可以直接翻译");
      }
      const status = await api.whisperStatus();
      if (!status.ready) throw new Error(status.problem || "请先下载本地识别模型");
      if (!active() || !cursor().valid) return;
      let autoTranslate = preference.autoTranslate && preference.translationMode === "local";
      const pauseTranslation = (error: unknown): void => {
        autoTranslate = false;
        if (active() && cursor().valid) patch(url, { notice: `${errMsg(error)}。本集已暂停自动翻译，原文识别继续；可停止识别后点击「翻译中文」重试。` });
      };
      if (autoTranslate) {
        try {
          const translator = await api.localTranslationStatus();
          if (!translator.ready) pauseTranslation(translator.problem || "请先下载英译中模型");
        } catch (error) { pauseTranslation(error); }
      }
      if (!active() || !cursor().valid) return;
      if (!view.audioReady) {
        if (view.audioFileName) throw new Error("所选节目音频已移动或无法访问，请恢复原文件或重新选择本地音频");
        applyView(url, await cacheAudio(url, id, () => active() && cursor().valid));
        if (!active() || !cursor().valid) return;
        if (!entry(url).audioReady) throw new Error("节目音频尚未准备好，请重试或选择本地音频");
      }
      while (active() && cursor().valid) {
        const playback = cursor();
        const current = entry(url).document;
        const duration = current?.durationMs || playback.durationMs;
        if (duration <= 0) throw new Error("节目时长尚未读取，请先播放节目");
        if (current?.source && current.source !== "asr") throw new Error("本集已有节目或导入字幕，可以直接翻译");
        if (playback.positionMs >= duration) break;
        if (!playback.playing) {
          label(id, "边播边识别已开启 · 播放暂停，等待继续");
          await new Promise((resolve) => setTimeout(resolve, 500)); continue;
        }
        const index = nextSubtitleWindow(current, playback.positionMs, duration);
        if (index !== undefined) {
          label(id, `边播边识别 · ${index * 20}–${Math.min((index + 1) * 20, Math.ceil(duration / 1000))} 秒，完成即显示…`);
          const document = await api.transcribePodcast(url, { ...preference, chunk: Math.floor(index / 15), window: index, expectedRevision: current?.revision ?? 0 }, id);
          apply(url, document);
        }
        if (!active() || !cursor().valid) break;
        if (!cursor().playing) continue;
        if (autoTranslate) {
          const document = entry(url).document;
          const position = cursor().positionMs;
          const indexes = document?.cues.map((cue, i) => ({ cue, i })).filter(({ cue }) => !cue.translation && cue.endMs > position && cue.startMs < position + 80_000).slice(0, 12).map(({ i }) => i) ?? [];
          if (document && indexes.length) {
            label(id, "边播边识别 · 正在本地翻译当前附近字幕…");
            try {
              apply(url, await api.translatePodcast(url, indexes, document.revision, id, { profileId: "", model: "argos-en-zh-1.9", local: true }));
            } catch (error) {
              if (!active() || !cursor().valid) break;
              pauseTranslation(error);
              // A timeout may arrive after the native task committed its result.
              // Refresh the revision before the next recognition request.
              applyView(url, await api.podcastSubtitles(url));
            }
          }
        }
        if (index === undefined) {
          label(id, "边播边识别 · 当前及前方字幕已就绪，等待播放");
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    }),
    translate: (url, positionMs) => run(url, "正在翻译字幕…", async (id, active) => {
      await get().loadPreference();
      const original = entry(url).document;
      if (!original?.cues.length) throw new Error("请先获取或生成原文字幕");
      const current = original.timed ? Math.max(0, precedingSubtitleIndex(original.cues, positionMs)) : 0;
      const pending = original.cues.map((cue, i) => ({ cue, i })).filter(({ cue }) => !cue.translation.trim()).map(({ i }) => i);
      const ordered = [...pending.filter((i) => i >= current), ...pending.filter((i) => i < current)];
      if (!ordered.length) return;
      let target: { profileId: string; model: string; local?: boolean };
      let translator: string;
      if (get().preference.translationMode === "local") {
        const status = await api.localTranslationStatus();
        if (!status.ready) throw new Error(status.problem || "请先在字幕设置中下载英译中模型");
        target = { profileId: "", model: "argos-en-zh-1.9", local: true };
        translator = "本地 Argos 英译中";
      } else {
        const config = await aiLocalConfig();
        if (!active()) return;
        const profile = config.profiles.find((item) => item.id === config.activeId);
        if (!profile?.model) throw new Error("请先在「设置 → AI」选择用于中文翻译的聊天模型");
        target = { profileId: profile.id, model: profile.model };
        translator = `${profile.name || "当前供应商"} / ${profile.model}`;
      }
      if (!active()) return;
      const encoder = new TextEncoder();
      const unit = original.timed ? "句" : "段";
      let finished = 0;
      while (finished < ordered.length && active()) {
        const document = entry(url).document!;
        const batch: number[] = []; let size = 0;
        for (const index of ordered.slice(finished, finished + 12)) {
          const length = encoder.encode(document.cues[index].text).length + 100;
          if (batch.length && size + length > 1_400) break;
          size += length; batch.push(index);
        }
        const started = Date.now();
        const update = (): void => {
          if (active()) label(id, `正在翻译（${finished}/${ordered.length} ${unit}）· ${translator} · 本批等待 ${Math.floor((Date.now() - started) / 1000)} 秒（上限 60 秒）`);
        };
        update();
        const timer = setInterval(update, 1000);
        try {
          const translated = await api.translatePodcast(url, batch, document.revision, id, target);
          apply(url, translated); finished += batch.length;
        } finally { clearInterval(timer); }
      }
    }),
    cancel: async () => {
      const task = get().task;
      if (!task) return;
      set({ task: { ...task, cancelling: true, label: "正在取消，保留已完成内容…" } });
      try { await api.cancelPodcastSubtitles(task.id); }
      catch (error) { patch(task.url, { error: errMsg(error) }); }
    },
  };
});
