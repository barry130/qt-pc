import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Captions, FileUp, Languages, RotateCcw, Settings2 } from "lucide-react";
import { Button, Select } from "@/components/ui";
import { ConfirmDialog } from "@/components/ui/modal";
import { SubtitleSettings } from "@/components/podcast/SubtitleSettings";
import { EMPTY_SUBTITLE_ENTRY, precedingSubtitleIndex, subtitleIndex, usePodcastSubtitleStore } from "@/stores/podcastSubtitles";
import { usePlayerStore } from "@/stores/player";
import { useInterpolatedPosition } from "@/hooks/useInterpolatedPosition";
import { formatTime } from "@/lib/lrc";
import { cn } from "@/lib/utils";
import type { SubtitleCue, SubtitleDocument } from "@/services/podcastSubtitles";

const SOURCE_LABEL = { publisher: "节目字幕", import: "导入字幕", asr: "自动识别", "": "暂无字幕" };
const PAGE_SIZE = 200;

export function PodcastSubtitles(props: { audioUrl: string }): React.JSX.Element {
  const { audioUrl } = props;
  const entry = usePodcastSubtitleStore((s) => s.entries[audioUrl] ?? EMPTY_SUBTITLE_ENTRY);
  const task = usePodcastSubtitleStore((s) => s.task);
  const local = usePodcastSubtitleStore((s) => s.preference.mode === "local");
  const automatic = usePodcastSubtitleStore((s) => s.preference.autoRecognize);
  const [settings, setSettings] = useState(false);
  const [regenerate, setRegenerate] = useState<{ url: string; whole: boolean; position: number } | null>(null);
  const [mode, setMode] = useState("bilingual");
  const input = useRef<HTMLInputElement>(null);
  const doc = entry.document;
  const busy = task !== null;
  const duration = usePlayerStore((s) => s.durationMs) || doc?.durationMs || 0;
  const chunkCount = Math.ceil(duration / 300_000);
  const allGenerated = chunkCount > 0 && Array.from({ length: Math.min(chunkCount, 576) }, (_, i) => i).every((i) => doc?.completedChunks.includes(i));
  useEffect(() => {
    let disposed = false;
    const store = usePodcastSubtitleStore.getState();
    void Promise.all([store.load(audioUrl), store.loadPreference()]).then(() => {
      const latest = usePodcastSubtitleStore.getState();
      const entry = latest.entries[audioUrl];
      if (!disposed && latest.preference.mode !== "local" && entry?.document?.revision === 0 && !entry.publisherChecked && !entry.error && !latest.task) void latest.fetchPublisher(audioUrl);
    }).catch(() => {});
    return () => {
      disposed = true;
    };
  }, [audioUrl]);
  const position = (): number => usePlayerStore.getState().interpolatedPositionMs();
  const generate = (whole: boolean, replace = false): void => {
    const store = usePodcastSubtitleStore.getState();
    if (store.preference.mode === "cloud" && !store.preference.profileId) { setSettings(true); return; }
    const current = position();
    const currentChunk = Math.floor(current / 300_000);
    if (replace || (!whole && (doc?.completedChunks.includes(currentChunk) || doc?.completedWindows?.some((index) => Math.floor(index / 15) === currentChunk)))) {
      setRegenerate({ url: audioUrl, whole, position: current });
      return;
    }
    void store.generate(audioUrl, current, duration, whole);
  };
  useEffect(() => { void usePodcastSubtitleStore.getState().loadPreference().catch(() => {}); }, []);
  const missingTranslations = doc?.cues.some((cue) => !cue.translation) ?? false;
  const followPlayback = (): void => {
    void usePodcastSubtitleStore.getState().followPlayback(audioUrl, () => {
      const player = usePlayerStore.getState();
      return { valid: player.state?.track?.id === audioUrl, playing: player.state?.status === "playing", positionMs: player.interpolatedPositionMs(), durationMs: player.durationMs };
    });
  };
  return <section className="flex h-full min-h-0 flex-col px-6 pb-3 sm:px-10" aria-label="播客字幕">
    <input ref={input} type="file" accept=".srt,.vtt,.json,.txt" aria-label="导入播客字幕文件" className="hidden" onChange={(event) => {
      const file = event.target.files?.[0]; event.target.value = "";
      if (file) void usePodcastSubtitleStore.getState().importFile(audioUrl, file);
    }} />
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><Captions className="h-4 w-4" aria-hidden /><span>{doc ? SOURCE_LABEL[doc.source] : "字幕"}</span>
        {doc?.cues.length ? <span>{doc.cues.length} {doc.timed ? "句" : "段文字"}{doc.source === "asr" ? ` · 已生成 ${doc.completedChunks.length} 段${doc.completedWindows?.length ? ` + ${doc.completedWindows.length} 小段` : ""}` : ""}</span> : null}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Select aria-label="字幕显示语言" value={mode} className="w-24" controlSize="xs" onChange={(e) => setMode(e.target.value)}>
          <option value="bilingual">双语</option><option value="original">原文</option><option value="translation">中文</option>
        </Select>
        <Button size="xs" variant="ghost" disabled={busy || entry.loading} onClick={() => void usePodcastSubtitleStore.getState().fetchPublisher(audioUrl)}>获取字幕</Button>
        <Button size="xs" variant="ghost" icon={<FileUp />} disabled={busy || entry.loading} onClick={() => input.current?.click()}>{doc?.cues.length ? "替换字幕" : "导入"}</Button>
        <Button size="xs" variant="ghost" icon={<Languages />} disabled={busy || !missingTranslations} onClick={() => void usePodcastSubtitleStore.getState().translate(audioUrl, position())}>翻译中文</Button>
        <Button size="xs" variant="ghost" icon={<Settings2 />} aria-label="播客字幕设置" onClick={() => setSettings(true)} />
      </div>
    </div>
    {entry.error ? <p role="alert" className="mt-2 shrink-0 text-xs text-destructive">{entry.error}</p> : null}
    {entry.notice ? <p role="status" className="mt-2 shrink-0 text-xs text-muted-foreground">{entry.notice}</p> : null}
    {task ? <div role="status" className="mt-2 flex shrink-0 items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{task.url !== audioUrl ? "另一集：" : ""}{task.label}</span><Button size="xs" variant="ghost" disabled={task.cancelling} onClick={() => void usePodcastSubtitleStore.getState().cancel()}>{task.kind === "follow" ? "停止本集识别" : "取消"}</Button>
    </div> : null}
    {!doc?.timed && doc?.cues.length ? <p role="status" className="mt-2 text-xs text-muted-foreground">这是文字稿，可阅读、翻译和双语显示；{doc.source === "asr" ? "部分转写结果未提供完整时间轴" : "节目未提供同步时间轴"}，无法逐句跟随、跳转或重听。{doc.source === "asr" && local ? "可重新生成整集，获取本地同步字幕。" : ""}</p> : null}
    {doc?.cues.length ? <SubtitleReader key={audioUrl} document={doc} mode={mode} />
      : <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 py-6 text-center">
        <Captions className="h-8 w-8 text-muted-foreground" aria-hidden />
        <p className="text-sm">{entry.loading ? "正在读取字幕…" : "让每句话都听得明白"}</p>
        <p className="max-w-lg text-xs leading-relaxed text-muted-foreground">{local ? `${automatic ? "播放播客后自动生成字幕；本集停止或失败后，可点击「边播边识别」重新开始。" : "点击「边播边识别」开始生成字幕。"}未缓存的节目会先下载音频，也可以导入已有字幕。` : "优先读取节目字幕，也可以导入 SRT / VTT 文件。没有字幕时，可选择云端或本地识别。"}</p>
      </div>}
    {(!doc?.source || doc.source === "asr") && !entry.loading ? <div className="shrink-0 border-t border-border pt-2">
      {local ? <div className="mb-1 flex flex-wrap items-center justify-center gap-2 text-2xs text-muted-foreground">
        <span className="max-w-xs truncate" title={entry.audioFileName}>{entry.audioReady ? entry.audioFileName || "节目音频已缓存" : "尚未缓存 · 开始识别时自动下载"}</span>
        <Button size="xs" variant="ghost" disabled={busy || entry.audioReady} onClick={() => void usePodcastSubtitleStore.getState().prepareAudio(audioUrl, false)}>缓存节目音频</Button>
        <Button size="xs" variant="ghost" disabled={busy || (doc?.completedChunks.length ?? 0) + (doc?.completedWindows?.length ?? 0) > 0} onClick={() => void usePodcastSubtitleStore.getState().prepareAudio(audioUrl, true)}>选择本地音频</Button>
      </div> : null}
      <div className="flex flex-wrap items-center justify-center gap-2">
      {local ? <Button size="xs" variant="primary" disabled={busy} onClick={followPlayback}>边播边识别</Button> : null}
      <Button size="xs" disabled={busy} onClick={() => generate(false)}>生成当前五分钟</Button>
      {!allGenerated ? <Button size="xs" variant="ghost" disabled={busy} onClick={() => generate(true)}>{doc?.source === "asr" ? "继续生成整集" : "生成整集字幕"}</Button> : <span className="text-2xs text-muted-foreground">整集已生成</span>}
      {doc?.source === "asr" && (doc.completedChunks.length + (doc.completedWindows?.length ?? 0)) > 0 ? <Button size="xs" variant="ghost" disabled={busy} onClick={() => generate(true, true)}>重新生成整集</Button> : null}
      <span className="text-2xs text-muted-foreground">{local ? "本地离线识别" : "云端转写"} · 分段保存</span>
      </div>
      {local ? <p className="mt-1 text-center text-2xs text-muted-foreground">{automatic ? "自动识别已开启，换集自动接续" : "点击「边播边识别」启动"}；首次先缓存音频，每 20 秒一小段，提前处理约一分钟。暂停时等待，离开播放页仍继续。</p> : null}
    </div> : null}
    {settings ? <SubtitleSettings onClose={() => setSettings(false)} /> : null}
    <ConfirmDialog open={regenerate?.url === audioUrl} title={regenerate?.whole ? "重新生成整集字幕？" : "重新生成当前五分钟？"}
      description={`使用当前${local ? "本地" : "云端"}识别设置。每段成功后替换该段原文并清除其旧译文；失败或取消会保留未完成段的原内容。${local ? "中英混合节目建议保留自动识别语言。" : "音频会发送到所选供应商，可能再次计费。"}`}
      confirmText="开始重新生成" onCancel={() => setRegenerate(null)} busy={busy}
      onConfirm={() => { if (!regenerate || regenerate.url !== audioUrl) return; const request = regenerate; setRegenerate(null); void usePodcastSubtitleStore.getState().generate(audioUrl, request.position, duration, request.whole, true); }} />
  </section>;
}

const SubtitleReader = memo(function SubtitleReader(props: { document: SubtitleDocument; mode: string }): React.JSX.Element {
  const { document: doc, mode } = props;
  const position = useInterpolatedPosition();
  const active = doc.timed ? subtitleIndex(doc.cues, position) : -1;
  const [resumeAt, setResumeAt] = useState(0);
  const follow = resumeAt === 0;
  const [page, setPage] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const current = useRef<HTMLButtonElement | null>(null);
  const seek = usePlayerStore((s) => s.seekTo);
  const pendingSeek = usePlayerStore((s) => s.pendingSeekMs);
  const preceding = precedingSubtitleIndex(doc.cues, position);
  const visiblePage = Math.min(Math.floor((doc.cues.length - 1) / PAGE_SIZE), follow && doc.timed ? Math.floor(Math.max(0, preceding) / PAGE_SIZE) : page);
  const offset = visiblePage * PAGE_SIZE;
  const target = Math.max(0, active >= 0 ? active : preceding);
  const stopFollowing = (): void => { setPage(visiblePage); setResumeAt(Date.now() + 4000); };
  const changePage = (value: number): void => { setResumeAt(Date.now() + 4000); setPage(value); container.current?.scrollTo({ top: 0 }); };
  const seekLine = useCallback((ms: number): Promise<boolean> => { setResumeAt(0); return seek(ms); }, [seek]);
  useEffect(() => {
    if (!resumeAt) return;
    const timer = window.setTimeout(() => setResumeAt(0), Math.max(0, resumeAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [resumeAt]);
  useEffect(() => { if (pendingSeek !== null) setResumeAt(0); }, [pendingSeek]);
  const rows = useMemo(() => doc.cues.slice(offset, offset + PAGE_SIZE).map((cue, index) => <SubtitleRow key={`${index + offset}:${cue.startMs}`} cue={cue} mode={mode} timed={doc.timed} active={index + offset === active}
    currentRef={index + offset === target ? current : undefined} onSeek={seekLine} />), [doc, mode, active, target, seekLine, offset]);
  useLayoutEffect(() => {
    if (!follow || !doc.timed || !container.current) return;
    const scroll = (): void => {
      if (!current.current || !container.current) return;
      const viewport = container.current;
      const top = current.current.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop - viewport.clientHeight * 0.35;
      viewport.scrollTo({ top: Math.max(0, top), behavior: "instant" });
    };
    scroll();
    const observer = new ResizeObserver(scroll);
    observer.observe(container.current);
    if (content.current) observer.observe(content.current);
    if (current.current) observer.observe(current.current);
    return () => observer.disconnect();
  }, [target, follow, mode, doc, offset]);
  const previous = active >= 0 ? active - 1 : preceding;
  const next = preceding + 1;
  return <div className="flex min-h-0 flex-1 flex-col">
    {doc.cues.length > PAGE_SIZE ? <div className="flex shrink-0 items-center justify-center gap-2 pt-2 text-2xs text-muted-foreground">
      <Button size="xs" variant="ghost" disabled={visiblePage === 0} onClick={() => changePage(visiblePage - 1)}>前 {PAGE_SIZE} 句</Button>
      <span>{offset + 1}–{Math.min(offset + PAGE_SIZE, doc.cues.length)} / {doc.cues.length}</span>
      <Button size="xs" variant="ghost" disabled={offset + PAGE_SIZE >= doc.cues.length} onClick={() => changePage(visiblePage + 1)}>后 {PAGE_SIZE} 句</Button>
    </div> : null}
    <div ref={container} className="relative min-h-0 flex-1 overflow-y-auto py-5" tabIndex={0} aria-label="字幕正文"
      onWheel={stopFollowing} onTouchMove={stopFollowing} onPointerDown={(event) => { if (event.target === event.currentTarget) stopFollowing(); }}
      onKeyDown={(e) => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(e.key)) stopFollowing(); }}>
      <div ref={content} className="mx-auto max-w-3xl space-y-2">
        {rows}
      </div>
    </div>
    {doc.timed ? <div className="flex shrink-0 flex-wrap items-center justify-center gap-1 py-2">
      <Button size="xs" variant="ghost" disabled={previous < 0} onClick={() => { void seekLine(doc.cues[previous].startMs); }}>上一句</Button>
      <Button size="xs" variant="ghost" icon={<RotateCcw />} disabled={active < 0} onClick={() => { void seekLine(doc.cues[active].startMs); }}>重听本句</Button>
      <Button size="xs" variant="ghost" disabled={next >= doc.cues.length} onClick={() => { void seekLine(doc.cues[next].startMs); }}>下一句</Button>
      {!follow ? <><Button size="xs" onClick={() => setResumeAt(0)}>回到当前播放</Button><span className="text-2xs text-muted-foreground">停止翻阅 4 秒后自动跟随</span></> : <span className="text-2xs text-muted-foreground">自动跟随播放</span>}
    </div> : null}
  </div>;
});

const SubtitleRow = memo(function SubtitleRow(props: { cue: SubtitleCue; active: boolean; timed: boolean; mode: string; currentRef?: React.Ref<HTMLButtonElement>; onSeek: (ms: number) => Promise<boolean> }): React.JSX.Element {
  const { cue, active, timed, mode, currentRef, onSeek } = props;
  return <button ref={currentRef} type="button" disabled={!timed} aria-current={active ? "true" : undefined} aria-label={timed ? `跳到 ${formatTime(cue.startMs)}：${cue.text}` : undefined}
    className={cn("flex w-full gap-4 rounded-lg px-3 py-3 text-left transition-colors duration-fast", active ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-accent/40")}
    onClick={() => void onSeek(cue.startMs)}>
    {timed ? <span className="mt-1 shrink-0 text-2xs tabular-nums opacity-70">{formatTime(cue.startMs)}</span> : null}
    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
      {mode !== "translation" || !cue.translation ? <span className={cn("block text-base leading-relaxed", active && "font-medium")}>{cue.text}</span> : null}
      {mode !== "original" && cue.translation && (mode === "translation" || cue.translation.trim() !== cue.text.trim()) ? <span className={cn("block leading-relaxed", mode === "translation" ? "text-base" : "mt-1.5 text-sm text-muted-foreground")}>{cue.translation}</span> : null}
      {mode === "translation" && !cue.translation ? <span className="mt-1 block text-2xs opacity-70">暂无译文，显示原文</span> : null}
    </span>
  </button>;
});
