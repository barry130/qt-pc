import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Trash2,
  ChevronDown,
  ChevronRight,
  ArrowUp,
  ArrowDown,
  Play,
  X,
  ScanSearch,
} from "lucide-react";
import { isLosslessAudioFormat } from "@/lib/audio-format";
import { errMsg } from "@/lib/utils";
import { legacyTrackSelectionKey, retainTrackSelection } from "@/lib/track-selection";
import type { Track } from "@/types";
import * as ipc from "@/services/ipc";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { usePlayerStore } from "@/stores/player";
import { TrackList } from "../discovery/TrackList";
import { AddDirButtons } from "./AddDirButtons";
import { BatchDeleteButton } from "../common/RowActions";
import { IconButton } from "../common/IconButton";
import { useKeepAliveActive } from "@/components/layout/keepAliveActive";

import { EmptyState, RowsSkeleton } from "@/components/ui";
/**
 * 本地音乐（路由 /library，DESIGN §5.2 / §13）。
 *
 * 扫描目录持久化在 Rust 侧（scan_dirs 表），扫描结果入库（tracks 表，platform=local）。
 * 本地曲目的 Track.id 即文件绝对路径，播放由 Rust 引擎特判本地源解码。
 *
 * 本地曲库 2.0：搜索、排序（标题/歌手/专辑/时长/大小/修改时间 + 正/倒序）、
 * 按歌曲 / 歌手 / 专辑 / 文件夹分组浏览、全部播放、多选批量删除、
 * 缺失文件体检与清理。
 */

const LibraryMaintenance = lazy(() => import("./LibraryMaintenance"));

type ViewMode = "songs" | "artists" | "albums" | "folders";
type SortKey = "title" | "singer" | "album" | "duration" | "size" | "mtime";

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
  { value: "size", label: "按大小" },
  { value: "mtime", label: "按修改时间" },
];

function filterLocalTracks(tracks: Track[], query: string): Track[] {
  const q = query.trim().toLowerCase();
  if (!q) return tracks;
  return tracks.filter((t) =>
    t.title.toLowerCase().includes(q) ||
    t.singer.toLowerCase().includes(q) ||
    t.album.toLowerCase().includes(q),
  );
}

function dirOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx > 0 ? path.slice(0, idx) : path;
}

/**
 * 把 Rust 侧的文件元数据（大小 / 修改时间 / 容器格式）合并到曲目上。
 * Rust `Track` 是 provider 通用结构、不带这些字段，由 `get_local_track_files`
 * 单独返回、前端按 id（= 文件绝对路径）合并。load 与 runScan 共用，避免
 * 刚扫描完的列表丢失排序依据与无损判定。
 */
function mergeFileMetas(tracks: Track[], metas: ipc.LocalTrackFileMeta[]): Track[] {
  const metaMap = new Map<string, ipc.LocalTrackFileMeta>();
  for (const meta of metas) {
    metaMap.set(meta.id, meta);
  }
  return tracks.map((tr) => {
    const fm = metaMap.get(tr.id);
    return fm
      ? { ...tr, fileSize: fm.fileSize, mtime: fm.mtime, format: fm.format }
      : tr;
  });
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
  /** 正序（默认） / 倒序 */
  const [sortDesc, setSortDesc] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const allRef = useRef<HTMLInputElement | null>(null);
  const [missing, setMissing] = useState<Track[]>([]);
  const [missingOpen, setMissingOpen] = useState(false);
  /** 扫描设置面板默认收起：扫描按钮左侧的「扫描设置」下拉展开后才显示 */
  const [scanOpen, setScanOpen] = useState(false);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [t, d, m, metas] = await Promise.all([
        ipc.getLocalTracks().catch(() => [] as Track[]),
        ipc.getScanDirs().catch(() => [] as string[]),
        ipc.getMissingLocalTracks().catch(() => [] as Track[]),
        ipc.getLocalTrackFiles().catch(() => [] as ipc.LocalTrackFileMeta[]),
      ]);
      // 合并本地曲目的文件大小 / 修改时间 / 格式，供排序与无损计数用
      setTracks(
        mergeFileMetas(Array.isArray(t) ? t : [], Array.isArray(metas) ? metas : []),
      );
      setDirs(Array.isArray(d) ? d : []);
      setMissing(Array.isArray(m) ? m : []);
      // 列表换了，旧的勾选不再有意义（被删掉的曲目尤其要清掉）
      setSelected(new Set());
    } finally {
      setLoading(false);
    }
  }, []);

  // 本页常驻缓存（挂载后不再卸载）：文件/曲目可能在别处被增删（扫描、下载落盘、
// 曲目页删除），只在首次挂载拉一次会一直显示旧库。改为每次切回来重拉。
  const active = useKeepAliveActive();

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load]);

  // 扫描进度订阅：整盘扫描可能上万文件，给用户实时反馈
  useTauriEvent<ipc.LibraryScanProgress>(ipc.LIBRARY_SCAN_PROGRESS_EVENT, (e) =>
    setProgress(e.payload),
  );

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
        // 扫描返回的 Track 不带文件元数据：不合并的话刚扫完的列表按大小 /
        // 修改时间排序显示空值、无损计数为 0，要切页回来才恢复
        // 文件元数据 / 缺失列表 / 扫描目录三者互不依赖，并行取（各自失败走原默认值）
        const [metas, m, d] = await Promise.all([
          ipc.getLocalTrackFiles().catch(() => [] as ipc.LocalTrackFileMeta[]),
          ipc.getMissingLocalTracks().catch(() => [] as Track[]),
          ipc.getScanDirs().catch(() => list),
        ]);
        setTracks(mergeFileMetas(Array.isArray(scanned) ? scanned : [], metas));
        setMissing(Array.isArray(m) ? m : []);
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

  // 搜索 + 排序（本地曲库通常几千首，前端处理足够且无往返延迟）
  const visible = useMemo(() => {
    const sorted = [...filterLocalTracks(tracks, query)];
    const dir = sortDesc ? -1 : 1;
    sorted.sort((a, b) => {
      // switch 每个 case（含 default）都先赋值再 break，声明处初值是死赋值
      let c: number;
      switch (sortKey) {
        case "singer":
          c =
            a.singer.localeCompare(b.singer, "zh-Hans-CN") ||
            a.title.localeCompare(b.title, "zh-Hans-CN");
          break;
        case "album":
          c =
            a.album.localeCompare(b.album, "zh-Hans-CN") ||
            a.title.localeCompare(b.title, "zh-Hans-CN");
          break;
        case "duration":
          c = a.duration - b.duration;
          break;
        case "size":
          c = (a.fileSize ?? 0) - (b.fileSize ?? 0);
          break;
        case "mtime":
          c = (a.mtime ?? 0) - (b.mtime ?? 0);
          break;
        default:
          c = a.title.localeCompare(b.title, "zh-Hans-CN");
      }
      return dir * c;
    });
    return sorted;
  }, [tracks, query, sortKey, sortDesc]);

  // 搜索收窄后立即丢弃隐藏选择；清空检索也不会恢复这些裸文件路径。
  const changeQuery = (value: string): void => {
    setQuery(value);
    setSelected((prev) => retainTrackSelection(filterLocalTracks(tracks, value), prev, legacyTrackSelectionKey));
  };
  const visibleSelected = useMemo(
    () => retainTrackSelection(visible, selected, legacyTrackSelectionKey),
    [visible, selected],
  );
  useEffect(() => {
    setSelected((prev) => retainTrackSelection(visible, prev, legacyTrackSelectionKey));
  }, [visible]);

  // 行内操作（在文件夹中显示 / 删除）与批量选择共用的回调：删除成功后整库重载
  const local = useMemo(
    () => ({
      onChanged: () => void load(),
      onError: (msg: string) => setError(msg),
      selection: { ids: visibleSelected, onToggle: toggleSelect, onChange: setSelected, keyOf: legacyTrackSelectionKey },
      // 行模板对齐下载管理：本地行不带封面缩略图，也不显示「已下载」标记
      plainRow: true,
    }),
    [load, visibleSelected, toggleSelect],
  );

  // 批量选择 / 删除共享当前可见范围，确保计数与真正提交给 IPC 的文件一致。
  const allSelected = visible.length > 0 && visible.every((t) => visibleSelected.has(t.id));
  const partiallySelected = !allSelected && visibleSelected.size > 0;
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = partiallySelected;
  }, [partiallySelected]);

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
    () => tracks.filter((t) => isLosslessAudioFormat(t.format)).length,
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
          <h1 className="text-xl font-bold tracking-tight">
            本地音乐
            {tracks.length > 0 && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {tracks.length} 首{losslessCount > 0 ? ` · 无损 ${losslessCount}` : ""}
              </span>
            )}
          </h1>
          <div className="flex items-center gap-1.5">
            <button type="button" aria-expanded={maintenanceOpen} onClick={() => setMaintenanceOpen((value) => !value)}
              className="rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground">曲库维护</button>
            {/* 扫描设置：下拉展开后显示添加目录 / 过滤规则 / 目录列表（默认收起） */}
            <button
              type="button"
              onClick={() => setScanOpen((v) => !v)}
              aria-expanded={scanOpen}
              className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              扫描设置
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${scanOpen ? "rotate-180" : ""}`}
              />
            </button>
            <IconButton
              label={scanning ? "扫描中…" : "扫描"}
              variant="primary"
              size="lg"
              disabled={scanning || dirs.length === 0}
              onClick={() => {
                // 收起状态下点扫描自动展开，进度提示才看得见
                setScanOpen(true);
                void runScan(dirs);
              }}
            >
              <ScanSearch />
            </IconButton>
          </div>
        </div>

        {scanOpen && (
        <>
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
                <IconButton
                  label="移除扫描目录"
                  danger
                  onClick={() => void removeDir(d)}
                >
                  <X />
                </IconButton>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            还没有扫描目录，添加一个后即可扫描本地歌曲
          </p>
        )}
        </>
        )}

        {/* 搜索 / 视图 / 排序 / 批量选择 */}
        {tracks.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              value={query}
              onChange={(e) => changeQuery(e.target.value)}
              placeholder="搜索标题 / 歌手 / 专辑"
              aria-label="搜索本地歌曲"
              className="h-7 w-48 rounded-md border border-input bg-background px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            <IconButton
              label="播放当前列表全部歌曲"
              variant="primary"
              size="md"
              disabled={visible.length === 0}
              onClick={() => void usePlayerStore.getState().playQueue(visible, 0)}
            >
              <Play />
            </IconButton>
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
            <IconButton
              label={sortDesc ? "当前为倒序，点击切换正序" : "当前为正序，点击切换倒序"}
              variant="outline"
              size="md"
              hover="secondary"
              onClick={() => setSortDesc((v) => !v)}
            >
              {sortDesc ? <ArrowDown /> : <ArrowUp />}
            </IconButton>

            {/* 批量选择：勾选行首复选框后「批量删除」 */}
            <label
              title={allSelected ? "取消全选" : "全选"}
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <input
                ref={allRef}
                type="checkbox"
                checked={allSelected}
                disabled={visible.length === 0}
                aria-checked={partiallySelected ? "mixed" : allSelected}
                aria-label={allSelected ? "取消全选" : "全选"}
                onChange={() =>
                  setSelected(
                    allSelected ? new Set() : new Set(visible.map((t) => t.id)),
                  )
                }
                className="h-3.5 w-3.5 accent-primary"
              />
            </label>
            <BatchDeleteButton
              count={visibleSelected.size}
              onDelete={async (deleteFile) => {
                if (visibleSelected.size === 0) return;
                await ipc.deleteLocalTracks([...visibleSelected], deleteFile);
              }}
              onDeleted={() => void load()}
              onError={(msg) => setError(msg)}
            />
            {visibleSelected.size > 0 && (
              <>
                <span className="text-xs text-muted-foreground">
                  已选 {visibleSelected.size} 首
                </span>
                <IconButton label="取消选择" onClick={() => setSelected(new Set())}>
                  <X />
                </IconButton>
              </>
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
                title={missingOpen ? "收起" : "展开"}
                className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {missingOpen ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                有 {missing.length} 首文件已不在（可能被移动或删除）
              </button>
              <IconButton
                label="清理记录"
                danger
                onClick={() => void purgeMissing()}
              >
                <Trash2 />
              </IconButton>
            </div>
            {missingOpen && (
              <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                {missing.map((t) => (
                  <li
                    key={t.id}
                    className="truncate text-2xs text-muted-foreground"
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
        {maintenanceOpen && <Suspense fallback={<p className="p-4 text-xs text-muted-foreground">加载维护工具…</p>}><LibraryMaintenance /></Suspense>}
        {error && (
          <div className="p-6 text-center text-sm text-destructive">
            操作失败：{error}
          </div>
        )}
        {loading ? (
          <RowsSkeleton rows={10} />
        ) : !error && tracks.length === 0 ? (
          <EmptyState title="暂无本地歌曲" />
        ) : visible.length === 0 ? (
          <EmptyState title="没有匹配的歌曲" />
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
