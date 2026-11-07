import { useEffect, useState } from "react";
import { Button, Field, Select } from "@/components/ui";
import { cancelWhisperInstall, installWhisper, whisperCatalog, whisperInstallProgress, type WhisperCatalog, type WhisperInstallProgress } from "@/services/podcastSubtitles";
import { errMsg } from "@/lib/utils";

const megabytes = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;

export function WhisperDownload({ disabled, onInstalled, onBusy }: { disabled: boolean; onInstalled: () => Promise<void>; onBusy: (busy: boolean) => void }): React.JSX.Element {
  const [catalog, setCatalog] = useState<WhisperCatalog | null>(null);
  const [model, setModel] = useState("base");
  const [task, setTask] = useState<WhisperInstallProgress | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const busy = starting || task?.running === true;
  useEffect(() => { onBusy(busy || !loaded); }, [busy, loaded, onBusy]);
  useEffect(() => {
    let disposed = false;
    void Promise.all([whisperCatalog(), whisperInstallProgress()]).then(async ([catalog, progress]) => {
      if (disposed) return;
      setCatalog(catalog); setTask(progress);
      if (progress?.running) setModel(progress.modelId);
      if (progress?.phase === "done") await onInstalled();
    }).catch((e: unknown) => { if (!disposed) setError(errMsg(e)); }).finally(() => { if (!disposed) setLoaded(true); });
    return () => { disposed = true; };
  }, [onInstalled]);
  useEffect(() => {
    if (!task?.running) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      try {
        const next = await whisperInstallProgress();
        if (disposed) return;
        if (!next) { setTask(null); setCancelling(false); throw new Error("下载任务已中断，可重试下载"); }
        setTask(next); setError("");
        if (!next.running) {
          setCancelling(false);
          if (next.phase === "done") await onInstalled();
          return;
        }
      } catch (e) { if (!disposed) setError(errMsg(e)); }
      if (!disposed) timer = setTimeout(() => void poll(), 600);
    };
    timer = setTimeout(() => void poll(), 300);
    return () => { disposed = true; clearTimeout(timer); };
  }, [task?.id, task?.running, onInstalled]);
  async function start(): Promise<void> {
    setStarting(true); setError(""); setCancelling(false);
    try { setTask(await installWhisper(model)); }
    catch (e) { setError(errMsg(e)); }
    finally { setStarting(false); }
  }
  async function cancel(): Promise<void> {
    if (!task) return;
    setCancelling(true);
    try { await cancelWhisperInstall(task.id); }
    catch (e) { setError(errMsg(e)); setCancelling(false); }
  }
  const selected = catalog?.models.find((item) => item.id === model);
  return <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-3">
    <Field label="下载离线模型" hint="均支持中英文。tiny 速度快；base 适合先试；small 通常更准确，也更占内存。">
      <Select value={model} disabled={disabled || busy || !catalog?.supported} onChange={(e) => setModel(e.target.value)}>
        {catalog?.models.map((item) => <option key={item.id} value={item.id}>{item.label} · {megabytes(item.bytes)}</option>)}
      </Select>
    </Field>
    <p className="text-xs leading-relaxed text-muted-foreground">{catalog?.supported ? `从 whisper.cpp 官方 GitHub / Hugging Face 下载。首次约 ${megabytes((selected?.bytes ?? 0) + catalog.engineBytes)}，含 Windows x64 CPU 引擎；下载后自动配置，已有完整文件会复用。` : loaded ? "自动安装目前支持 Windows x64；此系统可在下方手动选择引擎与模型。" : "正在检查下载支持…"}</p>
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="primary" disabled={disabled || busy || !loaded || !catalog?.supported} loading={starting} onClick={() => void start()}>{task?.phase === "error" ? "重试下载并配置" : "下载并自动配置"}</Button>
      {busy && task ? <Button size="sm" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? "正在取消…" : "取消下载"}</Button> : null}
    </div>
    {task ? <div role="status" className="space-y-2 text-xs text-muted-foreground">
      <p>{task.label}</p>
      {task.running && task.totalBytes > 0 ? <><progress className="h-2 w-full accent-primary" aria-label="离线模型下载进度" max={task.totalBytes} value={task.downloadedBytes} />
        <p>{megabytes(task.downloadedBytes)} / {megabytes(task.totalBytes)} · {Math.floor(task.downloadedBytes / task.totalBytes * 100)}%</p></> : null}
    </div> : null}
    {error || task?.error ? <p role="alert" className="break-words text-xs text-destructive">{error || task?.error}</p> : null}
  </div>;
}
