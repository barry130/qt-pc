import { useCallback, useEffect, useState } from "react";
import { errMsg } from "@/lib/utils";
import { RefreshCw, Trash2 } from "lucide-react";
import * as ipc from "@/services/ipc";
import { BackButton } from "@/components/layout/BackButton";
import { AddDirButtons } from "./AddDirButtons";

/**
 * 本地音乐文件夹管理（路由 /library/folders，DESIGN §13）。
 * 目录选择走 tauri-plugin-dialog 的目录选择器，路径落在 scan_dirs 表；
 * 改完点「立即扫描」才真正把音频文件读进本地曲库。
 */
export function LibraryFoldersPage(): React.JSX.Element {
  const [dirs, setDirs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tip, setTip] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const list = await ipc.getScanDirs();
    setDirs(Array.isArray(list) ? list : []);
  }, []);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        await refresh();
      } catch (err) {
        setTip(errMsg(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);

  const add = async (path: string): Promise<void> => {
    const p = path.trim();
    if (!p || dirs.includes(p)) return;
    setBusy(true);
    try {
      await ipc.addScanDir(p);
      await refresh();
      setTip(`已添加：${p}`);
    } catch (err) {
      setTip(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (path: string): Promise<void> => {
    setBusy(true);
    try {
      await ipc.removeScanDir(path);
      await refresh();
      setTip(null);
    } catch (err) {
      setTip(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const rescan = async (): Promise<void> => {
    if (dirs.length === 0) {
      setTip("先添加一个文件夹");
      return;
    }
    setBusy(true);
    setTip("扫描中…");
    try {
      // 与本地音乐页共用同一份扫描配置（忽略短音频 / 过小文件），避免两个入口行为不一致
      const [minSecs, minSize] = await Promise.all([
        ipc.getScanMinDuration().catch(() => 60),
        ipc.getScanMinSize().catch(() => ipc.DEFAULT_SCAN_MIN_SIZE),
      ]);
      const tracks = await ipc.scanLibrary(dirs, minSecs, minSize);
      setTip(`扫描完成，共 ${tracks.length} 首`);
    } catch (err) {
      setTip(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full min-w-0 overflow-y-auto px-5 py-5">
      <div className="mb-3 flex items-center gap-2">
        <BackButton />
        <h1 className="text-lg font-semibold">音乐文件夹</h1>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        添加存放音乐的文件夹，轻听会把里面的音频文件读进本地曲库。
        增删文件夹后点「立即扫描」刷新。
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <AddDirButtons onPick={(p) => void add(p)} disabled={busy} />
        <button
          type="button"
          onClick={() => void rescan()}
          disabled={busy || dirs.length === 0}
          className="flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-xs transition-colors hover:bg-secondary disabled:opacity-50"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {busy ? "处理中…" : "立即扫描"}
        </button>
      </div>

      {tip && (
        <p className="mt-3 rounded-md bg-secondary px-3 py-2 text-xs text-muted-foreground">
          {tip}
        </p>
      )}

      {loading ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          加载中…
        </p>
      ) : dirs.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          还没有添加任何文件夹
        </p>
      ) : (
        <ul className="mt-5">
          {dirs.map((dir) => (
            <li
              key={dir}
              className="flex items-center gap-3 border-b border-border/50 py-2.5"
            >
              <span className="min-w-0 flex-1 truncate text-sm">{dir}</span>
              <button
                type="button"
                onClick={() => void remove(dir)}
                disabled={busy}
                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                title="移除"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
