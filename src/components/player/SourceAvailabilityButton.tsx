import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { sourceAvailability } from "@/source-scripts";
import { sourcePlayQualityOf, SOURCE_QUALITIES_CHANGED_EVENT } from "@/lib/source-quality";
import { SOURCE_PLAY_LOGIN_CHANGED_EVENT } from "@/lib/source-auth";
import { SOURCE_META_CHANGED_EVENT, SOURCE_PACK_CHANGED_EVENT } from "@/services/ipc";
import { useSourceLabelFn } from "@/stores/sourceRegistry";
import type { SourceAvailability } from "@/source-scripts/qt-contract/contract";
import type { Track } from "@/types";

const labels = { unknown: "未验证", playable: "整曲预检通过", preview: "检测到试听", "auth-required": "需登录或会员", unavailable: "暂不可用" };

export function SourceAvailabilityButton({ track }: { track: Track }): React.JSX.Element {
  const [status, setStatus] = useState<SourceAvailability | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const sourceLabel = useSourceLabelFn();
  const trackRef = useRef(track);
  trackRef.current = track;
  const key = `${track.platform}:${track.id}`;
  useEffect(() => {
    const requestGeneration = generation;
    const reset = (): void => { generation.current++; setStatus(null); setBusy(false); setError(""); };
    reset();
    const token = generation.current;
    const current = trackRef.current;
    void sourceAvailability(current, sourcePlayQualityOf(current.platform)).then(value => {
      if (token === generation.current) setStatus(value);
    }).catch(() => undefined);
    window.addEventListener(SOURCE_PLAY_LOGIN_CHANGED_EVENT, reset);
    window.addEventListener(SOURCE_QUALITIES_CHANGED_EVENT, reset);
    const listeners = [SOURCE_META_CHANGED_EVENT, SOURCE_PACK_CHANGED_EVENT].map(event => listen(event, reset).catch(() => () => undefined));
    return () => {
      requestGeneration.current++;
      window.removeEventListener(SOURCE_PLAY_LOGIN_CHANGED_EVENT, reset);
      window.removeEventListener(SOURCE_QUALITIES_CHANGED_EVENT, reset);
      for (const listener of listeners) void listener.then(unlisten => unlisten()).catch(() => undefined);
    };
  }, [key]);
  useEffect(() => {
    if (!status || status.expiresAt <= Date.now()) return;
    const timer = window.setTimeout(() => setStatus(null), status.expiresAt - Date.now());
    return () => window.clearTimeout(timer);
  }, [status]);
  const check = async (): Promise<void> => {
    if (busy) return;
    const token = ++generation.current;
    setBusy(true); setError("");
    try {
      const value = await sourceAvailability(track, sourcePlayQualityOf(track.platform), true);
      if (token === generation.current) setStatus(value);
    } catch (err) {
      if (token === generation.current) setError(err instanceof Error ? err.message : "检查失败，请更新音源包后重试");
    } finally { if (token === generation.current) setBusy(false); }
  };
  const valid = status && status.expiresAt > Date.now() && status.quality === sourcePlayQualityOf(track.platform) ? status : null;
  return <div className="flex items-center gap-2 px-2 pb-2 text-2xs text-muted-foreground">
    <span className="min-w-0 flex-1" title={valid ? `${valid.reason}；${new Date(valid.checkedAt).toLocaleTimeString()}` : "检查当前账号及音质下的可用性"}>
      {error || labels[valid?.state ?? "unknown"]}
      {valid && valid.checkedAt > 0 ? ` · ${valid.actualQuality}` : ""}
      {valid && valid.actualSource !== track.platform ? ` · 来自${sourceLabel(valid.actualSource)}` : ""}
    </span>
    <button type="button" disabled={busy} onClick={() => { void check(); }} className="shrink-0 rounded px-2 py-1 hover:bg-secondary focus-visible:outline focus-visible:outline-2 disabled:opacity-50">
      {busy ? "检查中…" : "检查音源"}
    </button>
  </div>;
}
