import { useCallback, useEffect, useState } from "react";
import { formatBytes } from "@/lib/format";
import { setLogLevel } from "@/lib/logger";
import { clearRuntimeCache, type RuntimeCacheKind } from "@/lib/runtime-cache";
import { CACHE_AUDIO_LIMIT_MB_KEY } from "@/lib/storageKeys";
import { errMsg } from "@/lib/utils";
import { changeLocale, normalizeLocale, t, useLocaleStore, useT } from "@/lib/i18n";
import * as ipc from "@/services/ipc";
import { isAdmin, useAuthStore } from "@/stores/auth";
import { useDislikesStore } from "@/stores/dislikes";
import { useFavoritesStore } from "@/stores/favorites";
import { toast, toastSuccess } from "@/stores/toast";
import { type AudioCacheClearResult, type AudioCacheStats, type UriSchemeState } from "@/types";
import { DirPicker, NumberField, Segmented, SettingRow, Switch } from "../controls";

/** 通用设置：开机自启 / 缓存管理（播放缓存上限 + 分项清理） */

/** 播放缓存上限档位（MB；"0" = 不限）。与 cache.rs 的语义一致；
 *  "custom" = 手工输入档（非数字值，点它出输入框，实际值存 settings 的数字串） */
const cacheLimitOptions = (tr: typeof t): { value: string; label: string }[] => [
  { value: "1024", label: "1G" },
  { value: "2048", label: "2G" },
  { value: "4096", label: "4G" },
  { value: "0", label: tr("settings.general.cache.unlimited") },
  { value: "custom", label: tr("settings.general.cache.custom") },
];
/** settings 里没有上限记录时的默认档（cache.rs DEFAULT_AUDIO_CACHE_LIMIT_MB） */
const CACHE_LIMIT_DEFAULT = "1024";
/** 手工输入档的取值范围：非负整数 MB（0 = 不限），上界 1TB 够任何磁盘用 */
const CACHE_LIMIT_CUSTOM_MAX_MB = 1048576;

const runtimeCacheOptions = (
  tr: typeof t,
): { kind: RuntimeCacheKind; label: string; description: string }[] => [
  {
    kind: "playUrl",
    label: tr("settings.general.runtime.playUrl.label"),
    description: tr("settings.general.runtime.playUrl.desc"),
  },
  {
    kind: "sourceCandidates",
    label: tr("settings.general.runtime.sourceCandidates.label"),
    description: tr("settings.general.runtime.sourceCandidates.desc"),
  },
  {
    kind: "lyricCandidates",
    label: tr("settings.general.runtime.lyricCandidates.label"),
    description: tr("settings.general.runtime.lyricCandidates.desc"),
  },
  {
    kind: "chartDetails",
    label: tr("settings.general.runtime.chartDetails.label"),
    description: tr("settings.general.runtime.chartDetails.desc"),
  },
  {
    kind: "pageResults",
    label: tr("settings.general.runtime.pageResults.label"),
    description: tr("settings.general.runtime.pageResults.desc"),
  },
];

const logLevelOptions = (tr: typeof t): { value: ipc.LogLevel; label: string }[] => [
  { value: "debug", label: tr("settings.general.logLevel.debug") },
  { value: "info", label: tr("settings.general.logLevel.info") },
  { value: "warn", label: tr("settings.general.logLevel.warn") },
  { value: "error", label: tr("settings.general.logLevel.error") },
];

/** 目录选择行（日志 / 缓存共用）：只读路径 + 更改位置 + 恢复默认 */

export function FileAssociationSetting(): React.JSX.Element | null {
  const tr = useT();
  const [state, setState] = useState<import("@/types").FileAssociationState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback((): void => {
    void ipc.getFileAssociationState().then(setState).catch((e: unknown) => setError(errMsg(e)));
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const change = async (enable: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (enable) {
        setState(await ipc.registerFileAssociations());
        await ipc.openDefaultAppsSettings();
      } else {
        setState(await ipc.unregisterFileAssociations());
      }
    } catch (e) {
      setError(errMsg(e));
      refresh();
    } finally {
      setBusy(false);
    }
  };

  if (state?.supported === false) return null;
  return (
    <SettingRow
      title={tr("settings.general.fileAssociation.title")}
      description={tr("settings.general.fileAssociation.desc")}
    >
      <div className="flex max-w-sm flex-col items-end gap-2">
        {state !== null && state.defaultExtensions.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {tr("settings.general.fileAssociation.currentDefault", {
              list: state.defaultExtensions
                .map((ext) => ext.toUpperCase())
                .join(tr("settings.general.listSeparator")),
            })}
          </span>
        )}
        <div className="flex gap-2">
          <button type="button" disabled={busy || state === null} onClick={() => void change(true)}
            className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50">
            {tr("settings.general.fileAssociation.setDefault")}
          </button>
          <button type="button" disabled={busy || state === null || (!state.registered && state.defaultExtensions.length === 0)}
            onClick={() => void change(false)}
            className="rounded-md border border-input px-3 py-1.5 text-xs hover:bg-secondary disabled:opacity-50">
            {tr("settings.general.fileAssociation.unassociate")}
          </button>
        </div>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </div>
    </SettingRow>
  );
}


/**
 * 链接唤起（B4，§4.13）：注册 `quietmusic://` 后，浏览器/脚本/快捷方式点一下就播放
 * 对应本地文件。只写 `HKCU\Software\Classes`，取消注册只删自己那棵子树。
 *
 * 与「默认播放器」分开摆：文件关联动的是扩展名（影响右键「打开方式」），这里动的是
 * 协议（影响链接），互不影响，所以是两个独立开关。
 */
export function UriSchemeSetting(): React.JSX.Element | null {
  const tr = useT();
  const [state, setState] = useState<UriSchemeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback((): void => {
    void ipc.getUriSchemeState().then(setState).catch((e: unknown) => setError(errMsg(e)));
  }, []);

  useEffect(() => {
    refresh();
    // 别处（另一个窗口、系统设置）改过注册表时，切回来要能刷新
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const change = async (enable: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setState(enable ? await ipc.registerUriScheme() : await ipc.unregisterUriScheme());
    } catch (e) {
      setError(errMsg(e));
      refresh();
    } finally {
      setBusy(false);
    }
  };

  // 非 Windows 平台没有系统级协议注册，整行不显示（与「默认播放器」同口径）
  if (state?.supported === false) return null;
  return (
    <SettingRow
      title={tr("settings.general.uriScheme.title")}
      description={tr("settings.general.uriScheme.desc")}
    >
      <div className="flex max-w-sm flex-col items-end gap-2">
        {state !== null && (
          <span className="font-mono text-2xs break-all text-muted-foreground">{state.example}</span>
        )}
        {state?.registered && (
          <span className="text-xs text-muted-foreground">
            {tr("settings.general.uriScheme.registered")}
          </span>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy || state === null}
            onClick={() => void change(true)}
            className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
          >
            {tr("settings.general.uriScheme.register")}
          </button>
          <button
            type="button"
            disabled={busy || state === null || !state.registered}
            onClick={() => void change(false)}
            className="rounded-md border border-input px-3 py-1.5 text-xs hover:bg-secondary disabled:opacity-50"
          >
            {tr("settings.general.uriScheme.unregister")}
          </button>
        </div>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </div>
    </SettingRow>
  );
}


export function GeneralSection(): React.JSX.Element {
  const tr = useT();
  const runtimeOptions = runtimeCacheOptions(tr);
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  const [cache, setCache] = useState<AudioCacheStats | null>(null);
  const [limit, setLimit] = useState<string | null>(null);
  // 手工输入档：true 时「自定义」段选中并显示输入框（当前值不在档位里也进入此态）
  const [customMode, setCustomMode] = useState(false);
  const [customDraft, setCustomDraft] = useState("");
  // 清理默认只勾选可再生缓存：播放/网页缓存 + 进程内临时结果；不包含下载、登录、设置或数据库。
  const [clearAudio, setClearAudio] = useState(true);
  const [clearWeb, setClearWeb] = useState(true);
  const [clearRuntime, setClearRuntime] = useState<RuntimeCacheKind[]>(
    runtimeOptions.map((option) => option.kind),
  );
  // 听歌统计不可再生（累计时长、日榜、最近播放删了就没了），所以默认不勾，
  // 且勾上后「清理」按钮要走两击确认，不能像可再生缓存那样一键执行。
  const [clearStats, setClearStats] = useState(false);
  const [clearing, setClearing] = useState(false);
  // 勾上听歌统计后的第一击只武装，3 秒内再点才真删
  const [armedStats, setArmedStats] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 日志配置（级别 / 单文件上限 / 保留份数 / 目录）。null = 还没读到
  const [logCfg, setLogCfg] = useState<ipc.LogConfig | null>(null);
  // 缓存根目录（音频缓存是它下面的 audio）
  const [cacheDir, setCacheDir] = useState("");
  const [dirBusy, setDirBusy] = useState(false);
  // 数据备份/恢复：busy = 导出或导入进行中；pendingImport = 已选好备份文件、等用户挑合并还是覆盖
  const [backupDir, setBackupDir] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [pendingImport, setPendingImport] = useState("");
  // 日志级别只对 qt_admin 开放（与「播放链接」同一口径：前端显隐，后端不设权限）
  const profile = useAuthStore((s) => s.profile);
  const admin = isAdmin(profile);

  useEffect(() => {
    void ipc
      .autostartState()
      .then(setAutostartState)
      .catch(() => setAutostartState(false));
    void refreshCache();
    void ipc
      .getLogConfig()
      .then(setLogCfg)
      .catch((err) => setError(errMsg(err)));
    void ipc
      .getCacheDir()
      .then(setCacheDir)
      .catch((err) => setError(errMsg(err)));
    // 上限档回显：脏数据/缺项都回落默认档（与引擎侧 parse 口径一致）。
    // 当前值不在档位里（含脏数据）→ 进手工输入态并回显原值
    void ipc
      .getSetting(CACHE_AUDIO_LIMIT_MB_KEY)
      .then((raw) => {
        const v = raw && raw.trim() ? raw.trim() : CACHE_LIMIT_DEFAULT;
        setLimit(v);
        const preset = cacheLimitOptions(t).some((o) => o.value !== "custom" && o.value === v);
        setCustomMode(!preset);
        setCustomDraft(preset ? "" : v);
      })
      .catch(() => setLimit(CACHE_LIMIT_DEFAULT));
  }, []);

  const refreshCache = async (): Promise<void> => {
    try {
      setCache(await ipc.audioCacheStats());
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const toggleAutostart = async (): Promise<void> => {
    if (autostart === null) return;
    setError(null);
    try {
      await ipc.setAutostart(!autostart);
      setAutostartState(!autostart);
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const changeLimit = async (v: string): Promise<void> => {
    const prev = limit;
    setLimit(v); // 乐观更新，失败回滚
    setError(null);
    try {
      await ipc.setAudioCacheLimit(Number(v));
    } catch (err) {
      setLimit(prev);
      setError(errMsg(err));
    }
  };

  /** 手工输入档提交：非负整数 MB（0 = 不限），非法值红字提示、不动原值 */
  const applyCustomLimit = async (): Promise<void> => {
    const raw = customDraft.trim();
    if (!/^\d+$/.test(raw)) {
      if (raw.length > 0) setError(tr("settings.general.cache.errorNonNegative"));
      return;
    }
    const mb = Number(raw);
    if (mb > CACHE_LIMIT_CUSTOM_MAX_MB) {
      setError(tr("settings.general.cache.errorTooLarge", { max: CACHE_LIMIT_CUSTOM_MAX_MB }));
      return;
    }
    if (limit !== null && mb === Number(limit)) return; // 没改不重复下发
    await changeLimit(raw);
  };

  const clearCache = async (): Promise<void> => {
    // 勾了听歌统计就意味着不可逆删除：第一击只武装，不清任何东西，3 秒内再点才真执行
    if (clearStats && !armedStats) {
      setArmedStats(true);
      window.setTimeout(() => setArmedStats(false), 3000);
      return;
    }
    if (armedStats) setArmedStats(false);
    setClearing(true);
    setError(null);
    try {
      const tasks: Promise<AudioCacheClearResult | number>[] = [];
      if (clearAudio) tasks.push(ipc.clearAudioCache());
      if (clearWeb) tasks.push(ipc.clearWebCache());
      tasks.push(...clearRuntime.map((kind) => clearRuntimeCache(kind)));
      const results = await Promise.all(tasks);
      const freed = results.reduce(
        (sum: number, result) => sum + (typeof result === "number" ? 0 : result.freedBytes),
        0,
      );
      const failed = results.reduce(
        (sum: number, result) => sum + (typeof result === "number" ? 0 : result.failedCount),
        0,
      );
      const runtimeCount = results.reduce(
        (sum: number, result) => sum + (typeof result === "number" ? result : 0),
        0,
      );
      const summary =
        runtimeCount > 0 ? tr("settings.general.clear.runtimeNote", { n: runtimeCount }) : "";
      // 统计单独走：它返回删掉的曲目数，混不进上面的字节 / 文件统计
      const statsRemoved = clearStats ? await ipc.clearListenStats() : 0;
      const statsNote =
        clearStats && statsRemoved > 0
          ? tr("settings.general.clear.statsNote", { n: statsRemoved })
          : "";
      // 清理结果是一次性回执（表单校验那种要停留的错误走上面的 error 行内提示）
      if (freed === 0 && failed === 0 && runtimeCount === 0 && statsNote === "") {
        toast(tr("settings.general.clear.empty"));
      } else if (failed > 0) {
        toastSuccess(
          tr("settings.general.clear.doneSkipped", {
            freed: formatBytes(freed),
            summary,
            stats: statsNote,
            failed,
          }),
        );
      } else {
        toastSuccess(
          tr("settings.general.clear.done", {
            freed: formatBytes(freed),
            summary,
            stats: statsNote,
          }),
        );
      }
      await refreshCache();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setClearing(false);
    }
  };

  const nothingSelected = !clearAudio && !clearWeb && clearRuntime.length === 0 && !clearStats;

  const openLogs = async (): Promise<void> => {
    setError(null);
    try {
      await ipc.revealLogs();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  /**
   * 下发日志配置补丁。后端返回夹紧后的完整配置，直接拿来回显 —— 用户填 999
   * 份，界面立刻显示真正生效的 50，而不是留一个「看起来生效了」的假值。
   */
  const patchLog = async (patch: {
    level?: ipc.LogLevel;
    fileMb?: number;
    backups?: number;
  }): Promise<void> => {
    setError(null);
    try {
      const next = await ipc.setLogConfig(patch);
      setLogCfg(next);
      // 前端这份过滤也得跟着改：不然管理员调了级别，前端日志还被旧档卡着
      setLogLevel(next.level === "trace" ? "debug" : next.level);
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const chooseLogDir = async (): Promise<void> => {
    setDirBusy(true);
    setError(null);
    try {
      const picked = await ipc.chooseLogDir();
      // 选中后重读：目录换了，enabled 也可能跟着变（新目录不可写就写不进去）
      if (picked) setLogCfg(await ipc.getLogConfig());
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setDirBusy(false);
    }
  };

  const resetLogDir = async (): Promise<void> => {
    setDirBusy(true);
    setError(null);
    try {
      await ipc.resetLogDir();
      setLogCfg(await ipc.getLogConfig());
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setDirBusy(false);
    }
  };

  const chooseCacheDir = async (): Promise<void> => {
    setDirBusy(true);
    setError(null);
    try {
      const picked = await ipc.chooseCacheDir();
      if (picked) {
        setCacheDir(picked);
        // 换目录后旧位置的体积统计失效，重新算
        await refreshCache();
      }
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setDirBusy(false);
    }
  };

  const resetCacheDir = async (): Promise<void> => {
    setDirBusy(true);
    setError(null);
    try {
      setCacheDir(await ipc.resetCacheDir());
      await refreshCache();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setDirBusy(false);
    }
  };

  /** 导出备份：先让用户选目录（系统对话框），再落一份快照 + JSON 清单 */
  const exportBackup = async (): Promise<void> => {
    setError(null);
    const dir = await ipc.pickFolder(tr("settings.general.backup.pickFolder"));
    if (!dir) return; // 用户取消
    setBackupBusy(true);
    try {
      const info = await ipc.exportBackup(dir);
      setBackupDir(dir);
      toastSuccess(
        tr("settings.general.backup.exported", {
          tracks: info.tracks,
          playlists: info.playlists,
          history: info.history,
        }),
      );
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBackupBusy(false);
    }
  };

  /** 选备份文件：选完不立即导入 —— 覆盖是不可逆的，得让用户明确点一次 */
  const chooseBackupFile = async (): Promise<void> => {
    setError(null);
    const path = await ipc.pickBackupFile();
    if (path) setPendingImport(path);
  };

  const runImport = async (mode: "replace" | "merge"): Promise<void> => {
    if (!pendingImport) return;
    setBackupBusy(true);
    setError(null);
    try {
      const summary = await ipc.importBackup(pendingImport, mode);
      useFavoritesStore.getState().bump();
      useDislikesStore.setState((s) => ({
        version: s.version + 1, rules: [], loaded: false, songRuleIds: {}, singerRuleIds: {},
      }));
      void useDislikesStore.getState().refresh();
      setPendingImport("");
      toastSuccess(
        tr(
          mode === "replace"
            ? "settings.general.backup.importedReplace"
            : "settings.general.backup.importedMerge",
          { rows: summary.rows, tracks: summary.tracks, playlists: summary.playlists },
        ),
      );
      // 覆盖模式会自动留一份"导入前"快照，路径必须告诉用户，否则等于没留退路
      if (summary.safetyCopy) {
        toast(tr("settings.general.backup.snapshot", { path: summary.safetyCopy }));
      }
      toast(tr("settings.general.backup.refreshHint"));
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBackupBusy(false);
    }
  };

  return (
    <div className="max-w-4xl divide-y divide-border">
      <LocaleSetting />
      <FileAssociationSetting />
      <UriSchemeSetting />
      <SettingRow
        title={tr("settings.general.autostart.title")}
        description={tr("settings.general.autostart.desc")}
      >
        {autostart === null ? (
          <span className="text-xs text-muted-foreground">…</span>
        ) : (
          <Switch checked={autostart} onToggle={() => void toggleAutostart()} />
        )}
      </SettingRow>
      <SettingRow
        title={tr("settings.general.cacheLimit.title")}
        description={
          cache
            ? tr("settings.general.cacheLimit.descWithStats", {
                size: formatBytes(cache.totalBytes),
                count: cache.fileCount,
              })
            : tr("settings.general.cacheLimit.desc")
        }
      >
        {limit === null ? (
          <span className="text-xs text-muted-foreground">…</span>
        ) : (
          <div className="flex items-center gap-2">
            <Segmented
              value={customMode ? "custom" : limit}
              options={cacheLimitOptions(tr)}
              onChange={(v) => {
                if (v === "custom") {
                  // 只切到输入态、不改值：当前数字带进输入框方便微调
                  setCustomMode(true);
                  setCustomDraft(limit !== null && !Number.isNaN(Number(limit)) ? limit : "");
                  return;
                }
                setCustomMode(false);
                void changeLimit(v);
              }}
            />
            {customMode && (
              <span className="flex items-center gap-1">
                <input
                  type="number"
                  inputMode="numeric"
                  value={customDraft}
                  placeholder="1024"
                  onChange={(e) => {
                    setCustomDraft(e.target.value);
                    setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void applyCustomLimit();
                  }}
                  onBlur={() => void applyCustomLimit()}
                  autoFocus
                  className="w-20 rounded-md border border-border bg-transparent px-2 py-1 text-xs outline-none focus:border-primary"
                />
                <span className="text-xs text-muted-foreground">MB</span>
              </span>
            )}
          </div>
        )}
      </SettingRow>
      <SettingRow
        title={tr("settings.general.cacheDir.title")}
        description={tr("settings.general.cacheDir.desc")}
      >
        <DirPicker
          path={cacheDir}
          busy={dirBusy}
          onChoose={() => void chooseCacheDir()}
          onReset={() => void resetCacheDir()}
        />
      </SettingRow>
      <SettingRow
        title={tr("settings.general.clear.title")}
        description={
          cache
            ? tr("settings.general.clear.descWithStats", {
                size: formatBytes(cache.totalBytes),
                webSize: formatBytes(cache.webBytes),
              })
            : tr("settings.general.clear.desc")
        }
      >
        <div className="flex max-w-md flex-wrap items-center justify-end gap-x-3 gap-y-2">
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={clearAudio}
              onChange={(e) => setClearAudio(e.target.checked)}
              className="h-3.5 w-3.5 accent-primary"
            />
            {tr("settings.general.clear.audio")}
          </label>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={clearWeb}
              onChange={(e) => setClearWeb(e.target.checked)}
              className="h-3.5 w-3.5 accent-primary"
            />
            {tr("settings.general.clear.images")}
          </label>
          {runtimeOptions.map((option) => (
            <label
              key={option.kind}
              className="flex items-center gap-1 text-xs text-muted-foreground"
              title={option.description}
            >
              <input
                type="checkbox"
                checked={clearRuntime.includes(option.kind)}
                onChange={(e) => {
                  setClearRuntime((current) =>
                    e.target.checked
                      ? [...current, option.kind]
                      : current.filter((kind) => kind !== option.kind),
                  );
                }}
                className="h-3.5 w-3.5 accent-primary"
              />
              {option.label}
            </label>
          ))}
          <label
            className="flex items-center gap-1 text-xs text-muted-foreground"
            title={tr("settings.general.clear.statsHint")}
          >
            <input
              type="checkbox"
              checked={clearStats}
              onChange={(e) => {
                setClearStats(e.target.checked);
                // 取消勾选时把武装状态一起撤掉，避免上一轮的「再点一次」留在界面上
                if (!e.target.checked) setArmedStats(false);
              }}
              className="h-3.5 w-3.5 accent-primary"
            />
            {tr("settings.general.clear.stats")}
          </label>
          <button
            type="button"
            onClick={() => {
              // 「全选 / 全不选」必须从当前合计判断，不能各自取反：
              // 分项里取消过一个，全选再点一次应当补回全部而不是反向清掉。
              const allOn =
                clearAudio &&
                clearWeb &&
                clearRuntime.length === runtimeOptions.length &&
                clearStats;
              setClearAudio(!allOn);
              setClearWeb(!allOn);
              setClearRuntime(allOn ? [] : runtimeOptions.map((option) => option.kind));
              setClearStats(!allOn);
              if (!allOn) setArmedStats(false);
            }}
            className="rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {clearAudio &&
            clearWeb &&
            clearRuntime.length === runtimeOptions.length &&
            clearStats
              ? tr("settings.general.clear.selectNone")
              : tr("settings.general.clear.selectAll")}
          </button>
          <button
            type="button"
            onClick={() => void clearCache()}
            disabled={clearing || nothingSelected}
            className={`rounded-md border px-3 py-1.5 text-xs transition-colors disabled:opacity-50 ${
              armedStats
                ? "border-destructive/60 bg-destructive/10 text-destructive hover:bg-destructive/20"
                : "border-border hover:bg-accent"
            }`}
          >
            {clearing
              ? tr("settings.general.clear.clearing")
              : armedStats
                ? tr("settings.general.clear.confirmAgain")
                : tr("settings.general.clear.action")}
          </button>
          <p className="basis-full text-right text-2xs text-muted-foreground">
            {tr("settings.general.clear.footnote")}
          </p>
        </div>
      </SettingRow>
      <SettingRow
        title={tr("settings.general.backup.title")}
        description={
          backupDir
            ? tr("settings.general.backup.descWithDir", { dir: backupDir })
            : tr("settings.general.backup.desc")
        }
      >
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void exportBackup()}
              disabled={backupBusy}
              className="rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50"
            >
              {backupBusy
                ? tr("settings.general.backup.exporting")
                : tr("settings.general.backup.export")}
            </button>
            <button
              type="button"
              onClick={() => void chooseBackupFile()}
              disabled={backupBusy}
              className="rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50"
            >
              {tr("settings.general.backup.import")}
            </button>
          </div>
          {pendingImport && (
            <div className="flex flex-col items-end gap-1">
              <span
                className="max-w-72 truncate text-xs text-muted-foreground"
                title={pendingImport}
              >
                {tr("settings.general.backup.selected", { path: pendingImport })}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void runImport("merge")}
                  disabled={backupBusy}
                  className="rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50"
                >
                  {tr("settings.general.backup.merge")}
                </button>
                <button
                  type="button"
                  onClick={() => void runImport("replace")}
                  disabled={backupBusy}
                  className="rounded-md border border-destructive px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                >
                  {tr("settings.general.backup.replace")}
                </button>
                <button
                  type="button"
                  onClick={() => setPendingImport("")}
                  disabled={backupBusy}
                  className="rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  {tr("common.cancel")}
                </button>
              </div>
              <span className="max-w-72 text-right text-2xs text-muted-foreground">
                {tr("settings.general.backup.modeHint")}
              </span>
            </div>
          )}
        </div>
      </SettingRow>
      <SettingRow
        title={tr("settings.general.log.title")}
        description={
          logCfg
            ? tr("settings.general.log.descWithDir", {
                dir: logCfg.dir || tr("settings.general.log.defaultDir"),
                note: logCfg.enabled ? "" : tr("settings.general.log.notWritable"),
              })
            : tr("settings.general.log.desc")
        }
      >
        <div className="flex items-center gap-2">
          <DirPicker
            path={logCfg?.dir ?? ""}
            busy={dirBusy}
            onChoose={() => void chooseLogDir()}
            onReset={() => void resetLogDir()}
          />
          <button
            type="button"
            onClick={() => void openLogs()}
            disabled={!logCfg?.enabled}
            className="rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50"
          >
            {tr("settings.general.log.openFolder")}
          </button>
        </div>
      </SettingRow>
      {admin && logCfg && (
        <>
          <SettingRow
            title={tr("settings.general.log.level.title")}
            description={tr("settings.general.log.level.desc", {
              level:
                logLevelOptions(tr).find((o) => o.value === logCfg.defaultLevel)?.label ??
                logCfg.defaultLevel,
            })}
          >
            <Segmented
              value={logCfg.level === "trace" ? "debug" : logCfg.level}
              options={logLevelOptions(tr)}
              onChange={(v) => void patchLog({ level: v })}
            />
          </SettingRow>
          <SettingRow
            title={tr("settings.general.log.fileSize.title")}
            description={tr("settings.general.log.fileSize.desc", {
              min: logCfg.minFileMb,
              max: logCfg.maxFileMb,
            })}
          >
            <NumberField
              value={logCfg.fileMb}
              min={logCfg.minFileMb}
              max={logCfg.maxFileMb}
              suffix="MB"
              onCommit={(n) => void patchLog({ fileMb: n })}
            />
          </SettingRow>
          <SettingRow
            title={tr("settings.general.log.backups.title")}
            description={tr("settings.general.log.backups.desc", {
              min: logCfg.minBackups,
              max: logCfg.maxBackups,
            })}
          >
            <NumberField
              value={logCfg.backups}
              min={logCfg.minBackups}
              max={logCfg.maxBackups}
              suffix={tr("settings.general.log.backups.suffix")}
              onCommit={(n) => void patchLog({ backups: n })}
            />
          </SettingRow>
        </>
      )}
      {error && <p className="py-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

// formatBytes 合并到 `@/lib/format`（与下载页同一实现：自动单位 + 空值给空串）。

/** 包列表单行文案：包名 · 版本 · code */

/**
 * 界面语言（B6）：只切界面词条，正文内容（歌名 / 歌单名 / 简介）不译。
 * 切换即时生效并写入设置（`ui.locale`），下次启动 `loadLocale()` 读回。
 */
function LocaleSetting(): React.JSX.Element {
  const locale = useLocaleStore((s) => s.locale);
  return (
    <SettingRow title={t("settings.language")} description={t("settings.languageHint")}>
      <Segmented
        label={t("settings.language")}
        value={locale}
        options={[
          { value: "zh-CN", label: t("locale.zh") },
          { value: "en-US", label: t("locale.en") },
        ]}
        onChange={(value) => void changeLocale(normalizeLocale(value))}
      />
    </SettingRow>
  );
}
