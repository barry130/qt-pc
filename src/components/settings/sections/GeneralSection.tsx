import { useCallback, useEffect, useState } from "react";
import { formatBytes } from "@/lib/format";
import { setLogLevel } from "@/lib/logger";
import { clearRuntimeCache, type RuntimeCacheKind } from "@/lib/runtime-cache";
import { CACHE_AUDIO_LIMIT_MB_KEY } from "@/lib/storageKeys";
import { errMsg } from "@/lib/utils";
import * as ipc from "@/services/ipc";
import { isAdmin, useAuthStore } from "@/stores/auth";
import { useDislikesStore } from "@/stores/dislikes";
import { useFavoritesStore } from "@/stores/favorites";
import { toast, toastSuccess } from "@/stores/toast";
import { type AudioCacheClearResult, type AudioCacheStats } from "@/types";
import { DirPicker, NumberField, Segmented, SettingRow, Switch } from "../controls";

/** 通用设置：开机自启 / 缓存管理（播放缓存上限 + 分项清理） */

/** 播放缓存上限档位（MB；"0" = 不限）。与 cache.rs 的语义一致；
 *  "custom" = 手工输入档（非数字值，点它出输入框，实际值存 settings 的数字串） */
const CACHE_LIMIT_OPTIONS: { value: string; label: string }[] = [
  { value: "1024", label: "1G" },
  { value: "2048", label: "2G" },
  { value: "4096", label: "4G" },
  { value: "0", label: "不限" },
  { value: "custom", label: "自定义" },
];
/** settings 里没有上限记录时的默认档（cache.rs DEFAULT_AUDIO_CACHE_LIMIT_MB） */
const CACHE_LIMIT_DEFAULT = "1024";
/** 手工输入档的取值范围：非负整数 MB（0 = 不限），上界 1TB 够任何磁盘用 */
const CACHE_LIMIT_CUSTOM_MAX_MB = 1048576;

const RUNTIME_CACHE_OPTIONS: { kind: RuntimeCacheKind; label: string; description: string }[] = [
  { kind: "playUrl", label: "播放地址", description: "各平台解析出的播放链接与「某张专辑只能出到哪一档」的记录，清除后下次播放重新取链" },
  { kind: "sourceCandidates", label: "换源候选", description: "换源弹层中的临时搜索结果" },
  { kind: "lyricCandidates", label: "歌词候选", description: "歌词搜索候选与当前播放页歌词缓存；不删除已保存歌词" },
  { kind: "chartDetails", label: "榜单详情", description: "首页与榜单页的临时榜单曲目列表" },
  { kind: "pageResults", label: "列表结果", description: "歌手 ID、歌手头像、全量分页与本地曲目在线元数据缓存" },
];

const LOG_LEVEL_OPTIONS: { value: ipc.LogLevel; label: string }[] = [
  { value: "debug", label: "调试" },
  { value: "info", label: "信息" },
  { value: "warn", label: "警告" },
  { value: "error", label: "错误" },
];

/** 目录选择行（日志 / 缓存共用）：只读路径 + 更改位置 + 恢复默认 */

export function FileAssociationSetting(): React.JSX.Element | null {
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
      title="默认播放器"
      description="关联 MP3、FLAC、WAV、OGG、M4A。点击「设为默认」后，在 Windows 默认应用中选择轻听；取消关联前请先改选其他播放器。"
    >
      <div className="flex max-w-sm flex-col items-end gap-2">
        <span className="text-xs text-muted-foreground">
          {state === null ? "正在读取关联状态…" : state.defaultExtensions.length > 0
            ? `当前默认：${state.defaultExtensions.map((ext) => ext.toUpperCase()).join("、")}`
            : state.registered ? "已注册为可选播放器" : "尚未注册"}
        </span>
        <div className="flex gap-2">
          <button type="button" disabled={busy || state === null} onClick={() => void change(true)}
            className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50">
            设为默认
          </button>
          <button type="button" disabled={busy || state === null || (!state.registered && state.defaultExtensions.length === 0)}
            onClick={() => void change(false)}
            className="rounded-md border border-input px-3 py-1.5 text-xs hover:bg-secondary disabled:opacity-50">
            取消关联
          </button>
        </div>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </div>
    </SettingRow>
  );
}


export function GeneralSection(): React.JSX.Element {
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
    RUNTIME_CACHE_OPTIONS.map((option) => option.kind),
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
        const preset = CACHE_LIMIT_OPTIONS.some((o) => o.value !== "custom" && o.value === v);
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
      if (raw.length > 0) setError("缓存上限需为非负整数（MB，0 = 不限）");
      return;
    }
    const mb = Number(raw);
    if (mb > CACHE_LIMIT_CUSTOM_MAX_MB) {
      setError(`缓存上限最大 ${CACHE_LIMIT_CUSTOM_MAX_MB} MB`);
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
      const summary = runtimeCount > 0 ? `，进程内缓存 ${runtimeCount} 项` : "";
      // 统计单独走：它返回删掉的曲目数，混不进上面的字节 / 文件统计
      const statsRemoved = clearStats ? await ipc.clearListenStats() : 0;
      const statsNote =
        clearStats && statsRemoved > 0 ? `；听歌统计 ${statsRemoved} 首已归零` : "";
      // 清理结果是一次性回执（表单校验那种要停留的错误走上面的 error 行内提示）
      if (freed === 0 && failed === 0 && runtimeCount === 0 && statsNote === "") {
        toast("没有可清理的内容");
      } else if (failed > 0) {
        toastSuccess(
          `已清理 ${formatBytes(freed)}${summary}${statsNote}；${failed} 个文件被占用跳过（正在播放的不会删）`,
        );
      } else {
        toastSuccess(`已清理 ${formatBytes(freed)}${summary}${statsNote}`);
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
    const dir = await ipc.pickFolder("选择备份保存目录");
    if (!dir) return; // 用户取消
    setBackupBusy(true);
    try {
      const info = await ipc.exportBackup(dir);
      setBackupDir(dir);
      toastSuccess(
        `已导出备份：曲目 ${info.tracks} / 歌单 ${info.playlists} / 记录 ${info.history}`,
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
        `已${mode === "replace" ? "覆盖" : "合并"}导入：写入 ${summary.rows} 行（曲目 ${summary.tracks} / 歌单 ${summary.playlists}）`,
      );
      // 覆盖模式会自动留一份"导入前"快照，路径必须告诉用户，否则等于没留退路
      if (summary.safetyCopy) toast(`导入前的数据已快照到 ${summary.safetyCopy}`);
      toast("界面数据会在切换页面后刷新");
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBackupBusy(false);
    }
  };

  return (
    <div className="max-w-4xl divide-y divide-border">
      <FileAssociationSetting />
      <SettingRow title="开机自启" description="登录系统后自动启动轻听（收起在托盘）">
        {autostart === null ? (
          <span className="text-xs text-muted-foreground">…</span>
        ) : (
          <Switch checked={autostart} onToggle={() => void toggleAutostart()} />
        )}
      </SettingRow>
      <SettingRow
        title="播放缓存上限"
        description={
          cache
            ? `在线播放的音频会先缓冲到磁盘（边下边播）。超过上限自动清理最旧的缓存文件，正在播放的不受影响。当前 ${formatBytes(cache.totalBytes)} · ${cache.fileCount} 个文件`
            : "在线播放的音频会先缓冲到磁盘（边下边播）。超过上限自动清理最旧的缓存文件，正在播放的不受影响。"
        }
      >
        {limit === null ? (
          <span className="text-xs text-muted-foreground">…</span>
        ) : (
          <div className="flex items-center gap-2">
            <Segmented
              value={customMode ? "custom" : limit}
              options={CACHE_LIMIT_OPTIONS}
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
        title="缓存位置"
        description="播放缓存与图片缓存的存放目录，默认在安装目录下的 cache 文件夹（不占用系统盘）。换到别的盘后已缓存的文件不会自动搬过去，需要时先在上面「清理缓存」再换。"
      >
        <DirPicker
          path={cacheDir}
          busy={dirBusy}
          onChoose={() => void chooseCacheDir()}
          onReset={() => void resetCacheDir()}
        />
      </SettingRow>
      <SettingRow
        title="清理缓存"
        description={
          cache
            ? `默认只清理可再生缓存：播放 ${formatBytes(cache.totalBytes)} / 图片 ${formatBytes(cache.webBytes)}；不删除下载、登录、设置或已保存歌词。「听歌统计」是可选项，默认不勾`
            : "默认只清理可再生缓存；不删除已下载音乐、登录状态、应用设置或已保存歌词。「听歌统计」是可选项，默认不勾"
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
            播放
          </label>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={clearWeb}
              onChange={(e) => setClearWeb(e.target.checked)}
              className="h-3.5 w-3.5 accent-primary"
            />
            图片
          </label>
          {RUNTIME_CACHE_OPTIONS.map((option) => (
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
            title="累计时长、有效播放、日榜与「最近播放」一起归零，不可恢复；勾上后需要点两次「清理」"
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
            听歌统计
          </label>
          <button
            type="button"
            onClick={() => {
              // 「全选 / 全不选」必须从当前合计判断，不能各自取反：
              // 分项里取消过一个，全选再点一次应当补回全部而不是反向清掉。
              const allOn =
                clearAudio &&
                clearWeb &&
                clearRuntime.length === RUNTIME_CACHE_OPTIONS.length &&
                clearStats;
              setClearAudio(!allOn);
              setClearWeb(!allOn);
              setClearRuntime(allOn ? [] : RUNTIME_CACHE_OPTIONS.map((option) => option.kind));
              setClearStats(!allOn);
              if (!allOn) setArmedStats(false);
            }}
            className="rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {clearAudio &&
            clearWeb &&
            clearRuntime.length === RUNTIME_CACHE_OPTIONS.length &&
            clearStats
              ? "全不选"
              : "全选"}
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
            {clearing ? "清理中…" : armedStats ? "再点一次确认清除" : "清理"}
          </button>
          <p className="basis-full text-right text-2xs text-muted-foreground">
            进程内缓存可重新获取；清理歌词只清内存候选与当前歌词，不删除已保存歌词。听歌统计不可再生，勾上后需点两次「清理」；想留个底可以先「导出备份」。
          </p>
        </div>
      </SettingRow>
      <SettingRow
        title="数据备份"
        description={
          backupDir
            ? `歌单、收藏、播放记录、设置与歌词可以导出成一个备份文件（不含已下载的音乐文件本体，它支持几十 GB）。上次导出到 ${backupDir}`
            : "歌单、收藏、播放记录、设置与歌词可以导出成一个备份文件（不含已下载的音乐文件本体）。换机器或重装前导出一份，之后导入回来即可。"
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
              {backupBusy ? "处理中…" : "导出备份"}
            </button>
            <button
              type="button"
              onClick={() => void chooseBackupFile()}
              disabled={backupBusy}
              className="rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50"
            >
              从备份导入
            </button>
          </div>
          {pendingImport && (
            <div className="flex flex-col items-end gap-1">
              <span
                className="max-w-72 truncate text-xs text-muted-foreground"
                title={pendingImport}
              >
                已选：{pendingImport}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void runImport("merge")}
                  disabled={backupBusy}
                  className="rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50"
                >
                  合并导入
                </button>
                <button
                  type="button"
                  onClick={() => void runImport("replace")}
                  disabled={backupBusy}
                  className="rounded-md border border-destructive px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                >
                  覆盖导入
                </button>
                <button
                  type="button"
                  onClick={() => setPendingImport("")}
                  disabled={backupBusy}
                  className="rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  取消
                </button>
              </div>
              <span className="max-w-72 text-right text-2xs text-muted-foreground">
                合并＝只补进缺的记录，现有数据不动；覆盖＝用备份整体替换当前数据（会先自动快照一份）
              </span>
            </div>
          )}
        </div>
      </SettingRow>
      <SettingRow
        title="诊断日志"
        description={
          logCfg
            ? `应用与播放的运行日志保存在本机（${logCfg.dir || "默认目录"}），反馈问题时可一并附上${
                logCfg.enabled ? "" : "。当前未能写入文件（目录不可用），日志只输出到控制台"
              }`
            : "应用与播放的运行日志保存在本机，反馈问题时可一并附上"
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
            打开文件夹
          </button>
        </div>
      </SettingRow>
      {admin && logCfg && (
        <>
          <SettingRow
            title="日志级别"
            description={`记录到哪个级别：调试最详细、错误最少。默认为${
              LOG_LEVEL_OPTIONS.find((o) => o.value === logCfg.defaultLevel)?.label ??
              logCfg.defaultLevel
            }（未设置时按版本自动选择）。级别改动立即生效，无需重启。`}
          >
            <Segmented
              value={logCfg.level === "trace" ? "debug" : logCfg.level}
              options={LOG_LEVEL_OPTIONS}
              onChange={(v) => void patchLog({ level: v })}
            />
          </SettingRow>
          <SettingRow
            title="日志文件大小"
            description={`单个日志文件的上限（${logCfg.minFileMb}–${logCfg.maxFileMb} MB），写满后自动开始新文件`}
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
            title="日志保留份数"
            description={`最多保留几个历史日志文件（${logCfg.minBackups}–${logCfg.maxBackups} 个），超出后自动删除最旧的`}
          >
            <NumberField
              value={logCfg.backups}
              min={logCfg.minBackups}
              max={logCfg.maxBackups}
              suffix="个"
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
