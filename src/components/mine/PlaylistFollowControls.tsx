import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Modal } from "@/components/ui";
import { Switch } from "@/components/ui/switch";
import { useAuthStore } from "@/stores/auth";
import { errMsg } from "@/lib/utils";
import { applyPlaylistFollow, playlistFollow, previewPlaylistFollow, togglePlaylistFollow, PLAYLIST_FOLLOW_CHANGED } from "@/lib/playlist-follow";
import type { FollowPreview, PlaylistFollow } from "@/lib/playlist-follow";

export function PlaylistFollowControls({ pid }: { pid: string }): React.JSX.Element | null {
  const [record, setRecord] = useState<PlaylistFollow | null>(null);
  const [preview, setPreview] = useState<FollowPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const lifecycle = useRef(0);
  const reload = useCallback(() => {
    const request = ++generation.current;
    void playlistFollow(pid).then(value => { if (request === generation.current) setRecord(value); })
      .catch(err => { if (request === generation.current) setError(errMsg(err)); });
  }, [pid]);
  useEffect(() => {
    const requestGeneration = generation;
    const actionLifecycle = lifecycle;
    setPreview(null); setBusy(false);
    reload();
    window.addEventListener(PLAYLIST_FOLLOW_CHANGED, reload);
    const off = useAuthStore.subscribe(() => { actionLifecycle.current++; setPreview(null); setRecord(null); setBusy(false); reload(); });
    return () => { actionLifecycle.current++; requestGeneration.current++; off(); window.removeEventListener(PLAYLIST_FOLLOW_CHANGED, reload); };
  }, [reload]);
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return;
    const request = lifecycle.current;
    setBusy(true); setError("");
    try { await action(); if (request === lifecycle.current) reload(); }
    catch (err) { if (request === lifecycle.current) setError(errMsg(err)); }
    finally { if (request === lifecycle.current) setBusy(false); }
  };
  if (!record) return error ? <p role="status" className="px-4 text-xs text-destructive">{error}</p> : null;
  return <div className="mx-4 my-3 rounded-lg border border-border p-3 text-xs">
    <div className="flex flex-wrap items-center gap-3">
      <Switch checked={record.enabled} disabled={busy} label="跟随原歌单更新" onToggle={() => void run(() => togglePlaylistFollow(pid))} />
      <span className="font-medium">跟随原歌单更新</span>
      <span className="text-muted-foreground">{record.enabled ? "本设备每天检查" : "已暂停"} · {record.checkedAt ? new Date(record.checkedAt).toLocaleString() : "尚未检查"}</span>
      <Button size="xs" disabled={busy} onClick={() => void run(async () => {
        const request = generation.current;
        const value = await previewPlaylistFollow(pid);
        if (request === generation.current) setPreview(value);
      })}>检查变化</Button>
    </div>
    <p className="mt-2 text-muted-foreground">保留你手动添加和删除的歌曲；仅完整来源列表会被应用。</p>
    {(error || record.error) && <p role="status" className="mt-2 text-destructive">{error || record.error}</p>}
    {preview && <Modal open title="来源歌单变化" onClose={() => { if (!busy) setPreview(null); }} dismissible={!busy}
      description={`新增 ${preview.added.length} 首，移除 ${preview.removed.length} 首；已有歌曲顺序保持。`}
      footer={<><Button disabled={busy} onClick={() => setPreview(null)}>取消</Button><Button variant="primary" loading={busy} onClick={() => void run(async () => { await applyPlaylistFollow(preview); setPreview(null); })}>应用变化</Button></>}>
      {preview.added.length + preview.removed.length === 0 && <p className="text-sm text-muted-foreground">没有曲目变化，应用后更新检查时间。</p>}
      <ul className="space-y-2 text-sm">{preview.added.map(t => <li key={`add:${t.platform}:${t.id}`}>＋ {t.title} · {t.singer}</li>)}{preview.removed.map(t => <li key={`remove:${t.platform}:${t.id}`} className="text-muted-foreground">－ {t.title} · {t.singer}</li>)}</ul>
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    </Modal>}
  </div>;
}
