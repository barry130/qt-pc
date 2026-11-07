import { useCallback, useEffect, useState } from "react";
import { Button, Checkbox, Field, Input, Modal, Select } from "@/components/ui";
import { aiLocalConfig, openExternalUrl } from "@/services/ipc";
import { pickWhisperFile, podcastTranscriptionModels, transcriptionPreset, TRANSCRIPTION_MODELS, whisperStatus, type OfflineStatus } from "@/services/podcastSubtitles";
import type { AiProfileView } from "@/types";
import { usePodcastSubtitleStore } from "@/stores/podcastSubtitles";
import { errMsg } from "@/lib/utils";
import { WhisperDownload } from "@/components/podcast/WhisperDownload";
import { TranslationSettings } from "@/components/podcast/TranslationSettings";

export function SubtitleSettings(props: { onClose: () => void }): React.JSX.Element {
  const preference = usePodcastSubtitleStore((s) => s.preference);
  const [form, setForm] = useState(preference);
  const [profiles, setProfiles] = useState<AiProfileView[]>([]);
  const [offline, setOffline] = useState<OfflineStatus | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const installed = useCallback(async (): Promise<void> => {
    const status = await whisperStatus();
    setOffline(status);
    if (status.cpuOnly) setForm((form) => ({ ...form, useGpu: false }));
  }, []);
  const [inventory, setInventory] = useState<{ profileId: string; ids: string[]; error: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const local = form.mode === "local";
  const profile = profiles.find((item) => item.id === form.profileId);
  const custom = form.customModel || !transcriptionPreset(form.model);
  const checked = inventory?.profileId === form.profileId ? inventory : null;
  const checking = !local && !!profile && !checked;
  const missing = checked && !checked.error && !checked.ids.includes(form.model.trim());
  const providerName = profile?.name || "当前供应商";
  const modelProblem = checked?.error ? `无法核实模型列表：${checked.error}`
    : missing && form.model.trim() ? `${providerName} 的模型列表中没有 ${form.model.trim()}。` : "";
  useEffect(() => {
    let disposed = false;
    void Promise.allSettled([aiLocalConfig(), usePodcastSubtitleStore.getState().loadPreference(), whisperStatus()]).then(([config, preference, status]) => {
      if (disposed) return;
      if (config.status === "fulfilled") setProfiles(config.value.profiles.filter((profile) => ["openai", "openai-responses"].includes(profile.protocol)));
      if (preference.status === "fulfilled") setForm(usePodcastSubtitleStore.getState().preference);
      else setError(errMsg(preference.reason));
      if (status.status === "fulfilled") setOffline(status.value);
      setLoading(false);
    });
    return () => { disposed = true; };
  }, []);
  const selectedProfileId = !loading && !local && profile ? profile.id : "";
  useEffect(() => {
    if (!selectedProfileId) return;
    let disposed = false;
    void podcastTranscriptionModels(selectedProfileId).then(
      (ids) => { if (!disposed) setInventory({ profileId: selectedProfileId, ids, error: "" }); },
      (reason: unknown) => { if (!disposed) setInventory({ profileId: selectedProfileId, ids: [], error: errMsg(reason) }); },
    );
    return () => { disposed = true; };
  }, [selectedProfileId, refresh]);
  async function pick(kind: "engine" | "model"): Promise<void> {
    setPicking(true); setError("");
    try { const result = await pickWhisperFile(kind); if (result) setOffline(result); }
    catch (e) { setError(errMsg(e)); }
    finally { setPicking(false); }
  }
  async function save(): Promise<void> {
    if (!ready) return;
    setSaving(true); setError("");
    try {
      const preset = custom ? undefined : transcriptionPreset(form.model);
      await usePodcastSubtitleStore.getState().savePreference({ ...form, useGpu: local && offline?.cpuOnly ? false : form.useGpu, customModel: custom, model: form.model.trim(), responseFormat: preset?.responseFormat ?? form.responseFormat, language: form.language.trim().toLowerCase() });
      props.onClose();
    }
    catch (e) { setError(errMsg(e)); }
    finally { setSaving(false); }
  }
  const ready = local ? offline?.ready && Number.isInteger(form.threads) && form.threads >= 1 && form.threads <= 32
    : !!profile && !!form.model.trim() && (custom || (!!checked && !modelProblem));
  const open = (url: string): void => { void openExternalUrl(url).catch((error: unknown) => setError(errMsg(error))); };
  return <Modal open onClose={props.onClose} title="播客字幕设置" size="md" dismissible={!picking && !saving} closeOnBackdrop={!picking && !saving}
    footer={<Button variant="primary" disabled={loading || picking || downloading || !ready} loading={saving} onClick={() => void save()}>保存设置</Button>}>
    <div className="space-y-4">
      <Field label="识别方式"><Select value={form.mode} disabled={loading || picking || downloading} onChange={(e) => setForm({ ...form, mode: e.target.value as typeof form.mode })}>
        <option value="cloud">云端转写</option><option value="local">本地离线 · whisper.cpp</option>
      </Select></Field>
      {local ? <>
        <p className="text-xs leading-relaxed text-muted-foreground">使用本机 CPU 或显卡识别，无需 API Key，也不上传音频。模型和节目音频准备好后，可以断网生成字幕。</p>
        <Checkbox label="播放播客时自动识别字幕" checked={form.autoRecognize} onChange={(e) => setForm({ ...form, autoRecognize: e.target.checked })} />
        <p className="text-xs leading-relaxed text-muted-foreground">播放与换集后自动开始，离开播放页也继续；未缓存的节目会自动下载音频。可停止本集识别，或关闭此选项改为手动启动。</p>
        <WhisperDownload disabled={loading || picking || saving} onInstalled={installed} onBusy={setDownloading} />
        <Field label="本地识别引擎" hint="选择解压后的 whisper-cli.exe，保留同目录的 DLL。">
          <div className="flex min-w-0 items-center gap-2"><Input readOnly aria-label="本地识别引擎路径" value={offline?.enginePath ?? ""} placeholder="尚未选择 whisper-cli" title={offline?.enginePath} />
            <Button size="sm" disabled={loading || picking || downloading} onClick={() => void pick("engine")}>选择引擎</Button></div>
        </Field>
        <Field label="本地语音模型" hint="选择 whisper.cpp 的 GGML .bin 文件。中英文建议 base 或 small；tiny 更快，small 通常更准确。">
          <div className="flex min-w-0 items-center gap-2"><Input readOnly aria-label="本地语音模型路径" value={offline?.modelPath ?? ""} placeholder="尚未选择模型" title={offline?.modelPath} />
            <Button size="sm" disabled={loading || picking || downloading} onClick={() => void pick("model")}>选择模型</Button></div>
        </Field>
        <div className="flex flex-wrap gap-1"><Button size="xs" variant="ghost" onClick={() => open("https://github.com/ggml-org/whisper.cpp/releases")}>获取引擎</Button>
          <Button size="xs" variant="ghost" onClick={() => open("https://huggingface.co/ggerganov/whisper.cpp/tree/main")}>获取模型</Button></div>
        <p role="status" className="text-xs text-muted-foreground">{offline?.ready ? "引擎与模型文件已就绪。所选文件路径已记住。" : offline?.problem || "请选择引擎与模型；文件路径会自动记住。"}</p>
        <Field label="CPU 线程数" hint="默认 4；较少线程可降低识别时对播放和其他应用的影响。"><Input type="number" min={1} max={32} step={1} value={form.threads} onChange={(e) => setForm({ ...form, threads: Number(e.target.value) })} /></Field>
        <Checkbox label="启用显卡加速（自动下载为 CPU 版；显卡版请手动选择引擎）" disabled={offline?.cpuOnly === true} checked={offline?.cpuOnly ? false : form.useGpu} onChange={(e) => setForm({ ...form, useGpu: e.target.checked })} />
      </> : <>
        <p className="text-xs leading-relaxed text-muted-foreground">生成字幕时会把节目音频分段发送给所选供应商，可能按时长计费。</p>
        <Field label="语音转写供应商" hint="沿用 AI 设置中的地址和密钥；该供应商还需支持音频转写。">
          <Select value={form.profileId} disabled={loading || saving} onChange={(e) => { setInventory(null); setError(""); setForm({ ...form, profileId: e.target.value }); }}>
            <option value="">请选择供应商</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name || profile.baseUrl}</option>)}
          </Select>
        </Field>
        {!loading && !profiles.length ? <p className="text-xs text-muted-foreground">请先到「设置 → AI」添加一个兼容供应商，或切换本地离线识别。</p> : null}
        <Field label="语音转写模型" hint="内置模型已适配同步字幕，返回格式自动匹配；可用性以所选供应商为准。">
          <Select value={custom ? "custom" : form.model} disabled={loading || saving} onChange={(e) => {
            setError("");
            const preset = transcriptionPreset(e.target.value);
            setForm({ ...form, customModel: !preset, model: preset?.id ?? "", responseFormat: preset?.responseFormat ?? "json" });
          }}>
            {TRANSCRIPTION_MODELS.map((model) => <option key={model.id} value={model.id}>{model.label}{checked && !checked.error && !checked.ids.includes(model.id) ? "（供应商未提供）" : ""}</option>)}
            <option value="custom">自定义（不保证可用）</option>
          </Select>
        </Field>
        {custom ? <>
          <Field label="自定义模型名称" hint="填写供应商的音频转写模型 ID。普通聊天模型不能直接代替；接口与返回格式不兼容时可能失败。">
            <Input value={form.model} maxLength={200} disabled={saving} placeholder="例如 Qwen3-ASR-1.7B" onChange={(e) => setForm({ ...form, model: e.target.value })} />
          </Field>
          <Field label="返回格式" hint="通常先选 JSON；有真实时间轴时用于同步，否则保存为可阅读、翻译的文字稿。">
            <Select value={form.responseFormat} disabled={saving} onChange={(e) => setForm({ ...form, responseFormat: e.target.value as typeof form.responseFormat })}>
              <option value="json">JSON（可兼容无时间轴文字稿）</option><option value="text">纯文本（无时间轴）</option>
              <option value="verbose_json">分句时间轴（verbose_json）</option><option value="diarized_json">带说话人的时间轴（diarized_json）</option>
            </Select>
          </Field>
        </> : <p className="text-xs text-muted-foreground">返回格式：{transcriptionPreset(form.model)?.responseFormat}（自动匹配）</p>}
        {checking ? <p role="status" className="text-xs text-muted-foreground">正在检查 {providerName} 的模型列表…</p> : null}
        {modelProblem ? <p role={custom ? "status" : "alert"} className={custom ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
          {modelProblem}{custom ? "自定义模式仍可保存并尝试，但不保证可用。" : "请选择其他模型或供应商；也可选择自定义自行尝试。"}
        </p> : null}
        {profile ? <Button size="xs" variant="ghost" disabled={checking || saving} onClick={() => { setInventory(null); setRefresh((value) => value + 1); }}>刷新模型列表</Button> : null}
        <p className="text-xs leading-relaxed text-muted-foreground">未返回时间轴时仍保留文字稿，支持阅读、翻译和双语显示，无法逐句跟随、跳转或重听。</p>
      </>}
      <Field label="节目语言" hint="留空自动识别；英文填 en，中文填 zh。"><Input value={form.language} maxLength={16} placeholder="自动识别" onChange={(e) => setForm({ ...form, language: e.target.value })} /></Field>
      <p className="text-xs leading-relaxed text-muted-foreground">{local ? "节目音频可在字幕页缓存或选择本地文件。" : "首次生成需要缓存音频。"}每段约五分钟，完成即保存；中断后可继续。</p>
      <TranslationSettings value={form} onChange={setForm} />
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </div>
  </Modal>;
}
