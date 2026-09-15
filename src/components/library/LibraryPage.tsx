import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { errMsg } from "@/lib/utils";
import type { Track } from "@/types";
import * as ipc from "@/services/ipc";
import { TrackList } from "../discovery/TrackList";
import { AddDirButtons } from "./AddDirButtons";
import { BatchDeleteButton } from "../common/RowActions";

/**
 * 本地音乐（路由 /library，DESIGN §5.2 / §13）。
 *
 * 扫描目录持久化在 Rust 侧（scan_dirs 表），扫描结果入库（tracks 表，platform=local）。
 * 本地曲目的 Track.id 即文件绝对路径，播放由 Rust 引擎特判本地源解码。
 *
 * 本地曲库 2.0：搜索、排序、按歌曲 / 歌手 / 专辑 / 文件夹分组浏览、
 * 多选批量删除、缺失文件体检与清理。
 */

type ViewMode = "songs" | "artists" | "albums" | "folders";
type SortKey = "title" | "singer" | "album" | "duration";

const VIEW_OPTIONS: { value: ViewMode; label: string }[] = [
  { value: "songs", label: "歌曲" },
  { value: "artists", label: "歌手" },
  { value: "albums", label: "专辑" },
  { value: "folders", label: "文件夹" },
];

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "title", label: "按标题" },
  { value: "singer", label: "按歌手" },
  { value: "album", label: "按专辑" },
  { value: "duration", label: "按时长" },
];

/** 无损扩展名（按文件后缀判断，本地 Track 没有 format 字段） */
const LOSSLESS_EXTS = ["flac", "wav", "ape", "alac", "aiff"];

function extOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function dirOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx > 0 ? path.slice(0, idx) : path;
}

export function LibraryPage(): React.JSX.Element {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [dirs, setDirs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ipc.LibraryScanProgress | null>(null);
  // 扫描配置：默认忽略时长不足 60 秒的音频、小于 1 MB 的文件（0 = 关闭过滤）
  const [skipShort, setSkipShort] = useState(true);
  const [minSecs, setMinSecs] = useState(60);
  const [skipSmall, setSkipSmall] = useState(true);
  const [minSizeMb, setMinSizeMb] = useState(1);

  const [query, setQuery] = useState("");
  const [view, setView] = useState<ViewMode>("songs");
  const [sortKey, setSortKey] = useState<SortKey>("title");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const allRef = useRef<HTMLInputElement | null>(null);
  const [missing, setMissing] = useState<Track[]>([]);
  const [missingOpen, setMissingOpen] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [t, d, m] = await Promise.all([
        ipc.getLocalTracks().catch(() => [] as Track[]),
        ipc.getScanDirs().catch(() => [] as string[]),
        ipc.getMissingLocalTracks().catch(() => [] as Track[]),
      ]);
      setTracks(Array.isArray(t) ? t : []);
      setDirs(Array.isArray(d) ? d : []);
      setMissing(Array.isArray(m) ? m : []);
      // 列表换了，旧的勾选不再有意义（被删掉的曲目尤其要清掉）
      setSelected(new Set());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 扫描进度订阅：整盘扫描可能上万文件，给用户实时反馈
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void ipc
      .onLibraryScanProgress((p) => setProgress(p))
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, []);

  // 读取扫描配置（沿用 settings 表，重启后保持）
  useEffect(() => {
    void (async () => {
      try {
        const [secs, size] = await Promise.all([
          ipc.getScanMinDuration(),
          ipc.getScanMinSize(),
        ]);
        setMinSecs(secs > 0 ? secs : 60);
        setSkipShort(secs > 0);
        const mb = size > 0 ? size / (1024 * 1024) : 1;
        setMinSizeMb(Math.round(mb * 100) / 100);
        setSkipSmall(size > 0);
      } catch {
        /* 读不到就用默认值（60 秒 / 1 MB、开启） */
      }
    })();
  }, []);

  /** 保存扫描配置（时长 + 体积）；写库失败不影响本次扫描 */
  const saveScanConfig = useCallback(
    async (next: {
      skipShort: boolean;
      minSecs: number;
      skipSmall: boolean;
      minSizeMb: number;
    }): Promise<void> => {
      try {
        await ipc.setScanMinDuration(next.skipShort ? next.minSecs : 0);
        await ipc.setScanMinSize(
          next.skipSmall ? Math.round(next.minSizeMb * 1024 * 1024) : 0,
        );
      } catch {
        /* 忽略 */
      }
    },
    [],
  );

  const runScan = useCallback(
    async (list: string[]): Promise<void> => {
      if (list.length === 0) return;
      setScanning(true);
      setError(null);
      setProgress(null);
      try {
        const sizeBytes = skipSmall ? Math.round(minSizeMb * 1024 * 1024) : 0;
        const scanned = await ipc.scanLibrary(
          list,
          skipShort ? minSecs : 0,
          sizeBytes,
        );
        setTracks(Array.isArray(scanned) ? scanned : []);
        const m = await ipc.getMissingLocalTracks().catch(() => [] as Track[]);
        setMissing(Array.isArray(m) ? m : []);
        const d = await ipc.getScanDirs().catch(() => list);
        setDirs(Array.isArray(d) ? d : list);
      } catch (err) {
        setError(errMsg(err));
      } finally {
        setScanning(false);
        setProgress(null);
      }
    },
    [skipShort, minSecs, skipSmall, minSizeMb],
  );

  /** 选中文件夹 / 盘符后：登记扫描目录，再整库扫描一次 */
  const addAndScan = useCallback(
    async (path: string): Promise<void> => {
      setError(null);
      try {
        await ipc.addScanDir(path);
        const list = await ipc.getScanDirs();
        const next = Array.isArray(list) ? list : [];
        setDirs(next);
        await runScan(next);
      } catch (err) {
        setError(errMsg(err));
      }
    },
    [runScan],
  );

  const removeDir = async (p: string): Promise<void> => {
    setError(null);
    try {
      await ipc.removeScanDir(p);
      await load();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const purgeMissing = async (): Promise<void> => {
    setError(null);
    try {
      await ipc.purgeMissingLocalTracks();
      await load();
      setMissingOpen(false);
    } catch (err) {
      setError(errMsg(err));
    }
  };

  // 勾选 / 取消勾选一首（批量删除用）
  const toggleSelect = useCallback((id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // 行内操作（在文件夹中显示 / 删除）与批量选择共用的回调：删除成功后整库重载
  const local = useMemo(
    () => ({
      onChanged: () => void load(),
      onError: (msg: string) => setError(msg),
      selection: { ids: selected, onToggle: toggleSelect },
    }),
    [load, selected, toggleSelect],
  );

  // 搜索 + 排序（本地曲库通常几千首，前端处理足够且无往返延迟）
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = tracks;
    if (q) {
      list = list.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.singer.toLowerCase().includes(q) ||
          t.album.toLowerCase().includes(q),
      );
    }
    const sorted = [...list];
    sorted.sort((a, b) => {
      switch (sortKey) {
        case "singer":
          return a.singer.localeCompare(b.singer, "zh-Hans-CN") ||
            a.title.localeCompare(b.title, "zh-Hans-CN");
        case "album":
          return a.album.localeCompare(b.album, "zh-Hans-CN") ||
            a.title.localeCompare(b.title, "zh-Hans-CN");
        case "duration":
          return b.duration - a.duration;
        default:
          return a.title.localeCompare(b.title, "zh-Hans-CN");
      }
    });
    return sorted;
  }, [tracks, query, sortKey]);

  // 批量选择：以「当前可见列表」为范围，全选 / 取消全选都只影响可见项
  const allSelected = visible.length > 0 && visible.every((t) => selected.has(t.id));
  useEffect(() => {
    if (allRef.current) {
      allRef.current.indeterminate = !allSelected && selected.size > 0;
    }
  }, [allSelected, selected]);

  // 分组视图：歌手 / 专辑 / 文件夹
  const groups = useMemo(() => {
    if (view === "songs") return null;
    const keyOf = (t: Track): string => {
      if (view === "artists") return t.singer || "未知歌手";
      if (view === "albums") return t.album || "未知专辑";
      return dirOf(t.id);
    };
    const map = new Map<string, Track[]>();
    for (const t of visible) {
      const k = keyOf(t);
      const arr = map.get(k);
      if (arr) arr.push(t);
      else map.set(k, [t]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-Hans-CN"));
  }, [view, visible]);

  const losslessCount = useMemo(
    () => tracks.filter((t) => LOSSLESS_EXTS.includes(extOf(t.id))).length,
    [tracks],
  );

  /** 扫描目录里是否有整盘根（如 `D:\`），用于提示耗时 */
  const hasDriveRoot = useMemo(
    () => dirs.some((d) => /^[a-zA-Z]:[\\/]?$/.test(d.trim())),
    [dirs],
  );

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-base font-medium">
            本地音乐
            {tracks.length > 0 && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {tracks.length} 首{losslessCount > 0 ? ` · 无损 ${losslessCount}` : ""}
              </span>
            )}
          </h1>
          <button
            type="button"
            onClick={() => void runScan(dirs)}
            disabled={scanning || dirs.length === 0}
            className="h-8 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {scanning ? "扫描中…" : "扫描"}
          </button>
        </div>

        <div className="mt-2">
          <AddDirButtons onPick={(p) => void addAndScan(p)} disabled={scanning} />
        </div>

        {/* 扫描配置：滤掉提示音 / 测试样本这类短音频（默认开启） */}
        <label className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={skipShort}
            disabled={scanning}
            onChange={(e) => {
              const on = e.target.checked;
              setSkipShort(on);
              void saveScanConfig({ skipShort: on, minSecs, skipSmall, minSizeMb });
            }}
            className="h-3.5 w-3.5 accent-primary"
          />
          扫描时忽略时长不足
          <input
            type="number"
            min={0}
            value={minSecs}
            disabled={!skipShort || scanning}
            onChange={(e) => {
              const n = Math.max(0, Math.floor(Number(e.target.value) || 0));
              setMinSecs(n);
              void saveScanConfig({ skipShort, minSecs: n, skipSmall, minSizeMb });
            }}
            aria-label="时长下限（秒）"
            className="h-6 w-14 rounded border border-input bg-background px-1 text-center text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          />
          秒的音频
          <span className="text-muted-foreground/70">
            （时长读不到的仍会保留；改动后重新扫描生效）
          </span>
        </label>

        {/* 扫描配置：滤掉广告音效 / 空壳文件这类过小文件（默认 1 MB、开启） */}
        <label className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={skipSmall}
            disabled={scanning}
            onChange={(e) => {
              const on = e.target.checked;
              setSkipSmall(on);
              void saveScanConfig({ skipShort, minSecs, skipSmall: on, minSizeMb });
            }}
            className="h-3.5 w-3.5 accent-primary"
          />
          扫描时忽略小于
          <input
            type="number"
            min={0}
            step={1}
            value={minSizeMb}
            disabled={!skipSmall || scanning}
            onChange={(e) => {
              const n = Math.max(0, Number(e.target.value) || 0);
              setMinSizeMb(n);
              void saveScanConfig({ skipShort, minSecs, skipSmall, minSizeMb: n });
            }}
            aria-label="体积下限（MB）"
            className="h-6 w-14 rounded border border-input bg-background px-1 text-center text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          />
          MB 的文件
          <span className="text-muted-foreground/70">
            （读不到大小的仍会保留；改动后重新扫描生效）
          </span>
        </label>

        {scanning && (
          <p
            className="mt-2 truncate text-xs text-muted-foreground"
            title={progress?.current}
          >
            扫描中… 已访问 {progress?.visited ?? 0} 项，命中 {progress?.found ?? 0} 首
            {progress?.current ? ` · ${progress.current}` : ""}
          </p>
        )}

        {!scanning && hasDriveRoot && (
          <p className="mt-2 text-xs text-muted-foreground">
            已包含整个磁盘，扫描耗时较长，请耐心等待
          </p>
        )}

        {dirs.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {dirs.map((d) => (
              <li
                key={d}
                className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
              >
                <span className="truncate">{d}</span>
                <button
                  type="button"
                  onClick={() => void removeDir(d)}
                  className="shrink-0 text-xs transition-colors hover:text-destructive"
                >
                  移除
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            还没有扫描目录，添加一个后即可扫描本地歌曲
          </p>
        )}

        {/* 搜索 / 视图 / 排序 / 批量选择 */}
        {tracks.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索标题 / 歌手 / 专辑"
              aria-label="搜索本地歌曲"
              className="h-7 w-48 rounded-md border border-input bg-background px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="flex overflow-hidden rounded-md border border-border">
              {VIEW_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setView(o.value)}
                  className={`px-2 py-1 text-xs transition-colors ${
                    view === o.value
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-secondary"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              aria-label="排序方式"
              className="h-7 rounded-md border border-border bg-background px-2 text-xs outline-none"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>

            {/* 批量选择：勾选行首复选框后「批量删除」 */}
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                ref={allRef}
                type="checkbox"
                checked={allSelected}
                onChange={() =>
                  setSelected(
                    allSelected ? new Set() : new Set(visible.map((t) => t.id)),
                  )
                }
                className="h-3.5 w-3.5 accent-primary"
              />
              全选
            </label>
            <BatchDeleteButton
              count={selected.size}
              onDelete={async (deleteFile) => {
                await ipc.deleteLocalTracks([...selected], deleteFile);
              }}
              onDeleted={() => void load()}
              onError={(msg) => setError(msg)}
            />
            {selected.size > 0 && (
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                已选 {selected.size} 首 · 取消选择
              </button>
            )}
          </div>
        )}

        {/* 缺失文件体检：扫描后文件被删 / 被移动的记录 */}
        {missing.length > 0 && (
          <div className="mt-3 rounded-md border border-border bg-secondary/40 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setMissingOpen((v) => !v)}
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {missingOpen ? "▾" : "▸"} 有 {missing.length} 首文件已不在（可能被移动或删除）
              </button>
              <button
                type="button"
                onClick={() => void purgeMissing()}
                className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
                清理记录
              </button>
            </div>
            {missingOpen && (
              <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                {missing.map((t) => (
                  <li
                    key={t.id}
                    className="truncate text-[11px] text-muted-foreground"
                    title={t.id}
                  >
                    {t.title}
                    {t.singer ? ` · ${t.singer}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <div className="p-6 text-center text-sm text-destructive">
            操作失败：{error}
          </div>
        )}
        {loading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            加载中…
          </div>
        ) : !error && tracks.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            暂无本地歌曲
          </div>
        ) : visible.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            没有匹配的歌曲
          </div>
        ) : view === "songs" ? (
          <TrackList tracks={visible} local={local} />
        ) : (
          <div>
            {groups?.map(([name, list]) => (
              <section key={name}>
                <h2 className="sticky top-0 z-10 border-b border-border bg-background/95 px-4 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur-sm">
                  {name}
                  <span className="ml-2 font-normal">{list.length} 首</span>
                </h2>
                <TrackList tracks={list} local={local} />
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
