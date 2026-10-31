import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  FolderOpen,
} from "lucide-react";
import * as ipc from "@/services/ipc";
import { errMsg } from "@/lib/utils";
import { IconButton } from "@/components/common/IconButton";
import { Spinner } from "@/components/ui";

const PAGE_SIZE = 25;
const buttonClass = "rounded-md border border-border px-3 py-1.5 text-xs hover:bg-secondary disabled:opacity-50";
function bytes(value: number): string {
  return value >= 1024 * 1024 ? `${(value / (1024 * 1024)).toFixed(1)} MB` : `${(value / 1024).toFixed(1)} KB`;
}

function Pages({ page, total, onChange }: { page: number; total: number; onChange: (page: number) => void }): React.JSX.Element | null {
  const count = Math.ceil(total / PAGE_SIZE);
  if (count <= 1) return null;
  return <div className="flex items-center justify-end gap-3 py-2 text-xs">
    <button type="button" className={buttonClass} disabled={page === 0} onClick={() => onChange(page - 1)}>上一页</button>
    <span>{page + 1} / {count}</span>
    <button type="button" className={buttonClass} disabled={page + 1 >= count} onClick={() => onChange(page + 1)}>下一页</button>
  </div>;
}

/** Kept separate from the library list; loaded only when the maintenance panel opens. */
export default function LibraryMaintenance(): React.JSX.Element {
  const [tab, setTab] = useState<"duplicates" | "organize">("duplicates");
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ipc.DuplicateProgress | null>(null);
  const [report, setReport] = useState<ipc.DuplicateReport | null>(null);
  const [destination, setDestination] = useState("");
  const [preview, setPreview] = useState<ipc.OrganizePreview | null>(null);
  const [page, setPage] = useState(0);
  const scan = useRef<string | null>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  const cancelRequested = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelRequested.current = true;
      if (scan.current) void ipc.cancelLibraryDuplicateScan(scan.current).catch(() => {});
    };
  }, []);

  const detect = async (): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    cancelRequested.current = false;
    setBusy(true); setCancelling(false); setError(null); setReport(null); setProgress(null); setPage(0);
    const id = crypto.randomUUID();
    scan.current = id;
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<ipc.DuplicateProgress>(ipc.LIBRARY_DUPLICATE_PROGRESS_EVENT, ({ payload }) => {
        if (payload.scanId === scan.current) {
          if (mounted.current) setProgress(payload);
          // Early cancellation or unmount may precede backend registration.
          if (cancelRequested.current) void ipc.cancelLibraryDuplicateScan(payload.scanId).catch(() => {});
        }
      });
      if (!mounted.current) return;
      if (cancelRequested.current) {
        setReport({ scannedFiles: 0, hashedFiles: 0, groups: [], issues: [], cancelled: true });
        return;
      }
      const result = await ipc.findLibraryDuplicates(id);
      if (mounted.current) setReport(result);
    } catch (err) {
      if (mounted.current) setError(errMsg(err));
    } finally {
      unlisten?.(); scan.current = null; pending.current = false;
      if (mounted.current) { setBusy(false); setCancelling(false); setProgress(null); }
    }
  };

  const cancel = async (): Promise<void> => {
    if (!scan.current) return;
    cancelRequested.current = true;
    setCancelling(true);
    try { await ipc.cancelLibraryDuplicateScan(scan.current); }
    catch (err) { if (mounted.current) { setError(errMsg(err)); setCancelling(false); } }
  };

  const plan = async (): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setError(null); setPreview(null); setPage(0);
    try {
      const picked = await ipc.pickFolder("选择整理预览的目标文件夹");
      if (!picked || !mounted.current) return;
      setDestination(picked);
      const result = await ipc.previewLibraryOrganization(picked);
      if (mounted.current) setPreview(result);
    } catch (err) { if (mounted.current) setError(errMsg(err)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };

  const reveal = async (path: string): Promise<void> => {
    try { await ipc.revealLocalTrack(path); }
    catch (err) { if (mounted.current) setError(errMsg(err)); }
  };

  return <section aria-label="曲库维护" className="border-b border-border bg-secondary/20 px-4 py-3">
    <div role="tablist" aria-label="维护工具" className="mb-2 flex gap-2">
      {([ ["duplicates", "重复文件检测"], ["organize", "整理预览"] ] as const).map(([key, label]) =>
        <button key={key} id={`maintenance-${key}`} type="button" role="tab" aria-selected={tab === key}
          aria-controls="maintenance-content" disabled={busy} onClick={() => { setTab(key); setPage(0); setError(null); }}
          className={`${buttonClass} ${tab === key ? "bg-secondary text-foreground" : "text-muted-foreground"}`}>{label}</button>,
      )}
    </div>
    <div id="maintenance-content" role="tabpanel" aria-labelledby={`maintenance-${tab}`}>
      <p className="mb-2 text-xs text-muted-foreground">
        {tab === "duplicates"
          ? "按完整文件内容匹配，可识别不同路径下的相同副本。CUE 共用整轨文件只计一次。结果仅供核对，文件会保留。"
          : "按「歌手 / 专辑 / 标题」生成路径预览，检查重名、已有目标和附属文件。预览不会移动文件或修改曲库。"}
      </p>
      <div className="flex items-center gap-2">
        <button type="button" disabled={busy} className={buttonClass} onClick={() => void (tab === "duplicates" ? detect() : plan())}>
          {busy ? <span className="flex items-center gap-1"><Spinner size="sm" className="h-3.5 w-3.5" />处理中…</span> : tab === "duplicates" ? "开始检测" : "选择目标文件夹并预览"}
        </button>
        {busy && tab === "duplicates" && <button type="button" disabled={cancelling} className={buttonClass} onClick={() => void cancel()}>{cancelling ? "正在取消…" : "取消检测"}</button>}
        {progress && <span role="status" className="truncate text-xs text-muted-foreground" title={progress.current}>正在核对内容 {progress.checked} / {progress.total}</span>}
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
      {tab === "duplicates" && report && <div className="mt-3 text-xs">
        <p role="status" className="mb-2 text-muted-foreground">
          {report.cancelled ? "检测已取消，以下为部分结果。" : "检测完成。"}
          已检查 {report.scannedFiles} 个文件，其中 {report.hashedFiles} 个核对了完整内容，发现 {report.groups.length} 组重复文件。
        </p>
        {report.groups.length === 0 && !report.cancelled && <p className="py-2">{report.issues.length > 0 ? "已成功检查的文件中未发现重复；部分文件检查失败，请查看下方详情。" : "未发现内容完全相同的重复文件。"}</p>}
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {report.groups.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((group, index) =>
            <div key={group.sha256 + group.fileSize} className="rounded-md border border-border p-2">
              <p className="mb-1 font-medium">第 {page * PAGE_SIZE + index + 1} 组 · {group.files.length} 个文件 · 每个 {bytes(group.fileSize)}</p>
              {group.files.map((file) => <div key={file.path} className="flex items-center gap-2 py-0.5">
                <span className="min-w-0 flex-1 break-all">{file.path}{file.trackCount > 1 ? `（${file.trackCount} 首共用）` : ""}</span>
                <IconButton label="在文件夹中显示" onClick={() => void reveal(file.path)}><FolderOpen /></IconButton>
              </div>)}
            </div>,
          )}
        </div>
        <Pages page={page} total={report.groups.length} onChange={setPage} />
        {report.issues.length > 0 && <details className="mt-2 text-muted-foreground"><summary>有 {report.issues.length} 个文件无法检查</summary><ul className="mt-1 max-h-32 space-y-1 overflow-auto">{report.issues.map((issue, i) => <li key={`${issue.path}:${i}`} className="break-all">{issue.path}：{issue.message}</li>)}</ul></details>}
      </div>}
      {tab === "organize" && preview && <div className="mt-3 text-xs">
        <p className="mb-1 break-all text-muted-foreground">目标文件夹：{destination}</p>
        <p role="status" className="mb-2">可整理 {preview.ready} 个 · 需处理 {preview.blocked} 个 · 位置未变 {preview.unchanged} 个（仅预览）</p>
        {preview.entries.length === 0 && <p className="py-2 text-muted-foreground">当前曲库没有可预览的本地文件。</p>}
        <div className="max-h-64 space-y-2 overflow-y-auto">{preview.entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((entry) =>
          <div key={entry.source} className="rounded-md border border-border p-2">
            <div className="mb-1 flex items-center justify-between gap-2"><span className={entry.status === "blocked" ? "text-destructive" : "text-muted-foreground"}>{entry.status === "ready" ? "可整理" : entry.status === "blocked" ? "需处理" : "位置未变"}{entry.trackCount > 1 ? ` · ${entry.trackCount} 首共用` : ""}</span><IconButton label="在文件夹中显示" onClick={() => void reveal(entry.source)}><FolderOpen /></IconButton></div>
            <p className="break-all">原位置：{entry.source}</p><p className="break-all text-muted-foreground">建议位置：{entry.target}</p>
            {entry.message && <p className="mt-1 text-muted-foreground">{entry.message}</p>}
          </div>,
        )}</div>
        <Pages page={page} total={preview.entries.length} onChange={setPage} />
      </div>}
    </div>
  </section>;
}
