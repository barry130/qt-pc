import { useEffect, useState } from "react";
import { Button, Checkbox, Field, Select } from "@/components/ui";
import { cancelLocalTranslationInstall, installLocalTranslation, localTranslationStatus, type LocalTranslationStatus, type TranscribePreference } from "@/services/podcastSubtitles";
import { errMsg } from "@/lib/utils";

export function TranslationSettings({ value, onChange }: { value: TranscribePreference; onChange: (value: TranscribePreference) => void }): React.JSX.Element {
  const [status, setStatus] = useState<LocalTranslationStatus | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    if (value.translationMode !== "local") return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        const next = await localTranslationStatus();
        if (!disposed) { setStatus(next); timer = setTimeout(() => void poll(), next.progress?.running ? 800 : 3000); }
      } catch (e) { if (!disposed) setError(errMsg(e)); }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [value.translationMode, starting]);
  const progress = status?.progress;
  const install = async (): Promise<void> => {
    setStarting(true); setError("");
    try { await installLocalTranslation(); setStatus(await localTranslationStatus()); }
    catch (e) { setError(errMsg(e)); }
    finally { setStarting(false); }
  };
  return <div className="space-y-3 border-t border-border pt-4">
    <Field label="中文翻译方式"><Select value={value.translationMode} onChange={(e) => onChange({ ...value, translationMode: e.target.value as TranscribePreference["translationMode"] })}>
      <option value="online">在线 · 使用 AI 设置中的当前模型</option><option value="local">本地 · 轻量英译中（Argos）</option>
    </Select></Field>
    {value.translationMode === "local" ? <>
      <p className="text-xs leading-relaxed text-muted-foreground">专用英译中模型约 71 MB，含运行组件共约 117 MB，使用 CPU，无需另装 Python 或启动服务。下载一次后可断网使用；中文原文保留，其他语言请使用在线翻译。</p>
      <p className="text-xs leading-relaxed text-muted-foreground">适合快速理解英文字幕；人名和专业术语可能保留英文，复杂长句的表达可能不如较大的在线模型。</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!status?.supported || starting || progress?.running || status.ready} onClick={() => void install()}>{status?.ready ? "英译中模型已就绪" : "下载英译中模型"}</Button>
        {progress?.running ? <Button size="xs" variant="ghost" onClick={() => void cancelLocalTranslationInstall(progress.id).catch((e: unknown) => setError(errMsg(e)))}>取消翻译模型下载</Button> : null}
      </div>
      {progress ? <div role="status" className="space-y-1 text-xs text-muted-foreground"><p>{progress.label}</p>
        {progress.running ? <><progress className="w-full" aria-label="翻译模型下载进度" value={progress.downloadedBytes} max={progress.totalBytes || 1} /><p>{(progress.downloadedBytes / 1e6).toFixed(1)} / {(progress.totalBytes / 1e6).toFixed(1)} MB</p></> : null}
      </div> : <p role="status" className="text-xs text-muted-foreground">{status && !status.supported ? "目前支持 Windows x64。" : status?.problem}</p>}
      <Checkbox label="边播边识别时，自动本地翻译新字幕" checked={value.autoTranslate} onChange={(e) => onChange({ ...value, autoTranslate: e.target.checked })} />
      {error || progress?.error ? <p role="alert" className="text-xs text-destructive">{error || progress?.error}</p> : null}
    </> : <p className="text-xs leading-relaxed text-muted-foreground">点击「翻译中文」后，字幕文本发送给「设置 → AI」当前模型；与语音识别模型独立。</p>}
  </div>;
}
