import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import type {
  AppearancePreference,
  AppUpdateInfo,
  AppVersion,
  AudioCacheClearResult,
  AudioCacheStats,
  AudioError,
  EqParams,
  FadeParams,
  FxState,
  PlayOverview,
  PlayStatItem,
  SingerStat,
  ListenReportPage,
  ListenReportQuery,
  ListenDayReport,
  ListenDayReportQuery,
  AuthSession,
  DesktopLyricState,
  DesktopLyricStylePatch,
  DislikeRule,
  DownloadTask,
  HistoryItem,
  LyricRecord,
  MyPlaylistSummary,
  PlaybackState,
  PositionChanged,
  QueueChanged,
  Quality,
  RuntimeCacheClearResult,
  Track,
  UpdateDownloadProgress,
  NetConfigView,
  NetTestResult,
  MiniPlayerState,
  FileAssociationState,
  LocalMixSummary,
  AiLocalConfigView,
  AiLocalMessage,
  AiLocalReply,
  AiLocalTestResult,
  AiProfileInput,
  AiProviderProtocol,
} from "@/types";
import { isQuality } from "@/lib/quality";

/**
 * M0-M2 IPC 契约。命令名与 Rust 侧 `#[tauri::command]` 一一对应；
 * 全部走 invoke，前端不直接发任何外部网络请求（CSP 不放开外部域名）。
 */

/// 取链脚本化（方案 v3）：把共享脚本包解析出的地址回填 Rust 引擎缓存。
/// `referer` = 宿主取这个地址时要带的头（包按源声明，空串 = 不发）；
/// 引擎缓存里的地址后续由播放/下载直接向 CDN 取字节，头必须跟着地址一起存。
///
/// `size` / `actualQuality` 同属「取链诚实性」（2026-10-06）：
/// size = 包侧 Range 预检实测的文件总长（null = 没读到），下载进度与
/// 「服务端不给 Content-Length」时的分母靠它；actualQuality = 按实测码率
/// 重标后的档位（**只降不升**，空串 = 未重标），下载命名用它而非请求档，
/// 否则请求 flac 实际拿到 320k 会被命名成 `.flac` 虚标。
export async function setResolvedPlayUrl(
  track: Track,
  quality: Quality,
  url: string,
  referer = "",
  size: number | null = null,
  actualQuality = "",
): Promise<void> {
  return invoke("set_resolved_play_url", {
    track,
    quality,
    url,
    referer,
    size,
    actualQuality,
  });
}


// ---------- 本地音乐（DESIGN §13） ----------
// 本地曲目的 Track.id 就是文件绝对路径，平台固定 "local"；
// 播放时 Rust 侧 engine 会特判 Local 直接按路径解码，不走 Provider 取址。

/** 扫描本地目录。`minDurationSecs > 0` 时忽略时长不足该值的音频，
 *  `minSizeBytes > 0` 时忽略体积小于该值的文件（均为 0 = 不过滤） */
export async function scanLibrary(
  dirs: string[],
  minDurationSecs = 0,
  minSizeBytes = 0,
): Promise<Track[]> {
  return invoke("scan_library", {
    request: { dirs, minDurationSecs, minSizeBytes },
  });
}

/** 扫描配置：忽略短音频的时长下限（秒）在 settings 表里的键，0 表示关闭过滤 */
export const SCAN_MIN_DURATION_KEY = "scanMinDurationSecs";

/** 读扫描时长下限（缺省 60 秒；0 表示用户关掉了过滤） */
export async function getScanMinDuration(): Promise<number> {
  const raw = await getSetting(SCAN_MIN_DURATION_KEY).catch(() => null);
  const n = raw === null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 60;
}

/** 写扫描时长下限（0 = 关闭过滤） */
export async function setScanMinDuration(secs: number): Promise<void> {
  return setSetting(
    SCAN_MIN_DURATION_KEY,
    String(Math.max(0, Math.floor(secs))),
  );
}

/** 扫描配置：忽略过小文件的体积下限（字节）在 settings 表里的键，0 表示关闭过滤 */
export const SCAN_MIN_SIZE_KEY = "scanMinSizeBytes";

/** 体积下限默认值：1 MiB，即「小于 1M 的不扫描」 */
export const DEFAULT_SCAN_MIN_SIZE = 1024 * 1024;

/** 读扫描体积下限（缺省 1 MiB；0 表示用户关掉了过滤） */
export async function getScanMinSize(): Promise<number> {
  const raw = await getSetting(SCAN_MIN_SIZE_KEY).catch(() => null);
  const n = raw === null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SCAN_MIN_SIZE;
}

/** 写扫描体积下限（字节，0 = 关闭过滤） */
export async function setScanMinSize(bytes: number): Promise<void> {
  return setSetting(
    SCAN_MIN_SIZE_KEY,
    String(Math.max(0, Math.floor(bytes))),
  );
}

export async function getLocalTracks(): Promise<Track[]> {
  return invoke("get_local_tracks");
}

/** 本地规则合辑；数据不够门槛的合辑不出现在列表中。 */
export async function listLocalMixes(): Promise<LocalMixSummary[]> {
  return invoke("list_local_mixes");
}

export async function getLocalMixTracks(key: string): Promise<Track[]> {
  return invoke("get_local_mix_tracks", { key });
}

/** 本地曲目的文件大小 / 修改时间（供按大小、修改时间排序） */
export interface LocalTrackFileMeta {
  id: string;
  fileSize: number;
  mtime: number;
  /** Rust 扫描器记录的实际容器扩展名（小写）。 */
  format: string;
}
export async function getLocalTrackFiles(): Promise<LocalTrackFileMeta[]> {
  return invoke("get_local_track_files");
}

/** 缺失的本地曲目（扫描后文件已不在），供本地曲库体检用 */
export async function getMissingLocalTracks(): Promise<Track[]> {
  return invoke("get_missing_local_tracks");
}

/** 清理所有缺失的本地记录，返回删除条数 */
export async function purgeMissingLocalTracks(): Promise<number> {
  return invoke("purge_missing_local_tracks");
}

export interface MaintenanceIssue {
  path: string;
  message: string;
}
export interface DuplicateGroup {
  sha256: string;
  fileSize: number;
  files: { path: string; trackCount: number }[];
}
export interface DuplicateReport {
  scannedFiles: number;
  hashedFiles: number;
  groups: DuplicateGroup[];
  issues: MaintenanceIssue[];
  cancelled: boolean;
}
export interface DuplicateProgress {
  scanId: string;
  checked: number;
  total: number;
  current: string;
}
export const LIBRARY_DUPLICATE_PROGRESS_EVENT = "library-duplicate-progress";
/** 只读检测：先按大小筛选，再计算完整 SHA-256；同一 CUE 物理文件只计一次。 */
export async function findLibraryDuplicates(scanId: string): Promise<DuplicateReport> {
  return invoke("find_library_duplicates", { scanId });
}
export async function cancelLibraryDuplicateScan(scanId: string): Promise<boolean> {
  return invoke("cancel_library_duplicate_scan", { scanId });
}
export interface OrganizeEntry {
  source: string;
  target: string;
  trackCount: number;
  status: "ready" | "blocked" | "unchanged";
  message: string;
}
export interface OrganizePreview {
  entries: OrganizeEntry[];
  ready: number;
  blocked: number;
  unchanged: number;
}
/** 仅生成 歌手/专辑/标题 的目标路径与冲突信息，不移动文件、不改数据库。 */
export async function previewLibraryOrganization(destination: string): Promise<OrganizePreview> {
  return invoke("preview_library_organization", { destination });
}

/** 读本地音频的内嵌封面（data URL）；没有封面返回 null。path 即本地 Track.id */
export async function getLocalCover(path: string): Promise<string | null> {
  return invoke("get_local_cover", { path });
}

/**
 * 「外部打开」的唤醒事件名（Rust `external_open::EVENT_OPEN_LOCAL_PATHS`）。
 * **载荷为空**：路径放在 Rust 侧待取队列里，收到事件后调 `takePendingOpenPaths()`
 * 取空 —— 这样「事件早于监听注册」不会丢参数，也不会重复播同一批文件。
 */
export const OPEN_LOCAL_PATHS_EVENT = "open-local-paths";

/** `openLocalPaths` 的结果：可播放的曲目 + 没能打开的入参（不存在 / 格式不支持） */
export interface OpenedLocalPaths {
  tracks: Track[];
  skipped: string[];
}

/**
 * 打开外部传入的本地文件 / 文件夹（拖拽入窗、命令行参数、第二实例转发共用）。
 *
 * Rust 侧会顺手把它们入库（与扫描同一段代码），所以拖进来的曲目同样有歌词、封面、
 * 播放历史；但**不会**把所在文件夹加进扫描目录。返回的 `tracks` 已按入参顺序排好，
 * 调用方直接 `playQueue(tracks, 0)` 即是用户松手时的顺序。
 */
export async function openLocalPaths(paths: string[]): Promise<OpenedLocalPaths> {
  return invoke("open_local_paths", { paths });
}

/** 取走待打开的路径队列（取空是原子的：重复调用不会拿到同一批路径）。 */
export async function takePendingOpenPaths(): Promise<string[]> {
  return invoke("take_pending_open_paths");
}

/**
 * 取走「数据库自愈」的一次性说明（启动体检发现库损坏、已隔离重建时才有内容）。
 *
 * 取一次就没了（Rust 侧 `Option::take`），所以只能在挂载时读一次并立刻提示用户，
 * 不能放进轮询或渲染路径里。
 */
export async function takeDbNotice(): Promise<string | null> {
  return invoke<string | null>("take_db_notice");
}

export async function getScanDirs(): Promise<string[]> {
  return invoke("get_scan_dirs");
}

export async function addScanDir(path: string): Promise<void> {
  return invoke("add_scan_dir", { path });
}

export async function removeScanDir(path: string): Promise<void> {
  return invoke("remove_scan_dir", { path });
}

/** 在系统文件管理器中定位本地曲目文件（path 即本地 Track.id） */
export async function revealLocalTrack(path: string): Promise<void> {
  return invoke("reveal_local_track", { path });
}

/**
 * 删除本地曲目。`deleteFile = true` 时连磁盘文件一起删；
 * 否则只删库内记录（文件保留）。记录删除会级联清掉歌单归属 / 收藏 / 历史。
 */
export async function deleteLocalTrack(
  path: string,
  deleteFile: boolean,
): Promise<void> {
  return invoke("delete_local_track", { path, deleteFile });
}

/**
 * 批量删除本地曲目（列表多选后用）。`deleteFile = true` 时连同磁盘文件一起删，
 * 返回删除的记录条数。
 */
export async function deleteLocalTracks(
  paths: string[],
  deleteFile: boolean,
): Promise<number> {
  return invoke("delete_local_tracks", { paths, deleteFile });
}

/** 可扫描的盘符根目录（如 `C:\`、`D:\`），用于「扫描整个磁盘」 */
export async function listDrives(): Promise<string[]> {
  return invoke("list_drives");
}

/** 打开系统原生「选择文件夹」对话框；用户取消返回 null */
export async function pickFolder(title = "选择音乐文件夹"): Promise<string | null> {
  const result = await invoke<string | string[] | null>("plugin:dialog|open", {
    options: { directory: true, multiple: false, title },
  });
  return Array.isArray(result) ? (result[0] ?? null) : result;
}

/** 本地扫描进度：visited 已访问条目数，found 命中音频数，current 当前路径 */
/** Rust local.rs 广播：本地库扫描进度（对应 EVENT_LIBRARY_SCAN_PROGRESS） */
export const LIBRARY_SCAN_PROGRESS_EVENT = "library-scan-progress";

export interface LibraryScanProgress {
  visited: number;
  found: number;
  current: string;
}

export function onLibraryScanProgress(
  handler: (p: LibraryScanProgress) => void,
): Promise<() => void> {
  return listen<LibraryScanProgress>(LIBRARY_SCAN_PROGRESS_EVENT, (e) =>
    handler(e.payload),
  );
}

// ---------- 用户数据：收藏 / 播放历史（DESIGN §5.3） ----------
// 播放历史由 Rust 侧在播放开始时自动写入，前端只负责读取与清空。

// 收藏必须挂在歌单上：歌单由永久全局唯一的 pid 标识（创建后不变），
// 歌单只来自云端同步的卡片或本地自建；无归属（pid 找不到歌单）的歌不加载。
/** 定义在 `@/lib/platform`：展示组件只需这个常量时不必依赖整个 IPC 层。 */
export { LOCAL_PLATFORM } from "@/lib/platform";

/**
 * 收藏一首歌到某个歌单。`pid` 指定归属歌单，**实际必传**：Rust 侧
 * `cmd_add_favorite` 没拿到 pid 直接报「收藏必须指定歌单（pid）」，
 * 无归属的歌不加载（v5 起）。留成可选只是为了调用点不必先断言。
 */
export async function addFavorite(track: Track, pid?: string): Promise<void> {
  return invoke("add_favorite", { track, pid: pid ?? null });
}

// 收藏按 (platform, 原始 id) 定位，所以传整首 Track 而不是裸 id。
// `pid` 不传 = 整首取消收藏；传了 = 只从该歌单里移除。
export async function removeFavorite(track: Track, pid?: string): Promise<void> {
  return invoke("remove_favorite", { track, pid: pid ?? null });
}

/** 收藏列表。`pid` 不传取全部，传了只取该歌单下的曲目。 */
export async function listFavorites(pid?: string): Promise<Track[]> {
  return invoke("list_favorites", { pid: pid ?? null });
}

/** 这首歌挂在哪些歌单下（pid 列表），收藏选择器据此打勾。 */
export async function listTrackPlaylists(track: Track): Promise<string[]> {
  return invoke("list_track_playlists", { track });
}

export async function isFavorite(track: Track): Promise<boolean> {
  return invoke("is_favorite", { track });
}

/**
 * 批量判定：返回与入参等长的布尔向量，true = 这首已收藏。
 * 列表行红心一次点亮整屏用（逐行调 `isFavorite` 会把 IPC 通道打满）。
 */
export async function checkFavoriteFlags(tracks: Track[]): Promise<boolean[]> {
  return invoke("check_favorite_flags", { tracks });
}

export async function listHistory(limit?: number): Promise<HistoryItem[]> {
  return invoke("list_history", { limit: limit ?? 0 });
}

export async function clearHistory(): Promise<void> {
  return invoke("clear_history");
}

/**
 * 删掉一首歌的播放记录，返回是否真删到。
 * 按 `Track` 的 platform + id 定位（后端拼 tracks 主键 `platform:id`，
 * 本地曲目的 id 是文件路径、本身带冒号，前端别自己拼）。
 */
export async function removeHistory(track: Track): Promise<boolean> {
  return invoke("remove_history", { platform: track.platform, id: track.id });
}

/** 批量删除播放记录（历史页多选），返回真正删掉的条数。 */
export async function removeHistoryMany(tracks: Track[]): Promise<number> {
  return invoke("remove_history_many", {
    items: tracks.map((t) => ({ platform: t.platform, id: t.id })),
  });
}

/** 统计指向已丢失文件的播放记录条数（这些行在列表里看不见）。 */
export async function countMissingHistory(): Promise<number> {
  return invoke("count_missing_history");
}

/** 清掉指向已丢失文件的播放记录，返回条数。 */
export async function purgeMissingHistory(): Promise<number> {
  return invoke("purge_missing_history");
}

// ---------- 音频输出设备 ----------

/** 系统当前可用的音频输出设备名列表 */
export async function listOutputDevices(): Promise<string[]> {
  return invoke("list_output_devices");
}

/**
 * 切换输出设备。不传/空 = 跟随系统默认（插拔蓝牙耳机自动跟随）；
 * 传设备名 = 固定到该设备。切换时当前曲目从原进度无缝续播。
 */
export async function setOutputDevice(name?: string): Promise<void> {
  return invoke("set_output_device", { name: name ?? null });
}

// ---------- 全局快捷键（可改键 / 可禁用） ----------

/** 单条全局快捷键（对齐 Rust `ShortcutEntry`） */
export interface ShortcutEntry {
  /** 动作 ID：play_pause / previous / next / volume_up / volume_down / mute / desktop_lyric */
  id: string;
  /** 生效加速键（自定义或默认） */
  accelerator: string;
  /** 是否启用 */
  enabled: boolean;
  /** 上次注册是否被其它程序占用（true = 该键按了不会有反应，需要改键） */
  conflict: boolean;
}

/** 当前生效的快捷键表 */
export async function listShortcuts(): Promise<ShortcutEntry[]> {
  return invoke("list_shortcuts");
}

/**
 * 保存快捷键配置并热重载（立即生效，无需重启）。
 * `config` 形如 `{ [动作ID]: { key: string; enabled: boolean } }`，
 * key 为空串表示沿用默认加速键。
 */
export async function saveShortcuts(
  config: Record<string, { key: string; enabled: boolean }>,
): Promise<ShortcutEntry[]> {
  return invoke("save_shortcuts", { config });
}

// ---------- 我的歌单（DESIGN §5.3，本地自建歌单） ----------

export async function createPlaylist(name: string): Promise<string> {
  return invoke("create_playlist", { name });
}

export async function renamePlaylist(id: string, name: string): Promise<void> {
  return invoke("rename_playlist", { id, name });
}

export async function deletePlaylist(id: string): Promise<void> {
  return invoke("delete_playlist", { id });
}

export async function listMyPlaylists(): Promise<MyPlaylistSummary[]> {
  return invoke("list_my_playlists");
}

export async function getPlaylistTracks(id: string): Promise<Track[]> {
  return invoke("get_playlist_tracks", { id });
}

export async function addTracksToPlaylist(
  id: string,
  tracks: Track[],
): Promise<number> {
  return invoke("add_tracks_to_playlist", { id, tracks });
}

/**
 * 从歌单移除单首曲目。
 *
 * 调用方只有一个：歌曲列表右键菜单的「从歌单移除」，且只在本地自建歌单详情页
 * 出现（在线歌单 / 榜单的曲目归属由音源决定，移不掉）。它是
 * `remove_tracks_from_playlist` 的单首版本，比"先读全部再批量写回"少一次读。
 */
export async function removeTrackFromPlaylist(
  id: string,
  track: Track,
): Promise<void> {
  return invoke("remove_track_from_playlist", { id, track });
}

/** 批量从歌单移除曲目（歌单批量管理）。返回实际移除的数量 */
export async function removeTracksFromPlaylist(
  id: string,
  tracks: Track[],
): Promise<number> {
  return invoke("remove_tracks_from_playlist", { id, tracks });
}

// ---------- 下载管理（DESIGN §5.3 下载 2.0） ----------
// start_download 只负责发起（返回任务 id），真正下载在 Rust 后台；
// 任务状态变化会广播 downloads-changed，前端据此刷新列表与「已下载」标记。

/** 「默认下载音质」在 settings 表里的键 */
const DOWNLOAD_QUALITY_KEY = "downloadQuality";
/** 「下载文件名格式」在 settings 表里的键（artist=歌手-歌名，song=歌名-歌手） */
const DOWNLOAD_NAME_FORMAT_KEY = "downloadNameFormat";

/** 下载文件名格式：artist = 歌手-歌名（默认），song = 歌名-歌手 */
export type DownloadNameFormat = "artist" | "song";

export async function startDownload(
  track: Track,
  quality: Quality,
): Promise<string> {
  return invoke("start_download", { track, quality });
}

export async function listDownloads(): Promise<DownloadTask[]> {
  return invoke("list_downloads");
}

/** 已下载完成的曲目 db 主键集合（形如 `wyy:123`），给列表打「已下载」标 */
export async function listDownloadedTrackIds(): Promise<string[]> {
  return invoke("list_downloaded_track_ids");
}

/** deleteFile=true 时连同已下载的文件一起删除 */
export async function deleteDownload(
  id: string,
  deleteFile: boolean,
): Promise<void> {
  return invoke("delete_download", { id, deleteFile });
}

/** 批量删除下载任务（多选后用）。`deleteFile=true` 时连文件一起删，返回删除条数 */
export async function deleteDownloads(
  ids: string[],
  deleteFile: boolean,
): Promise<number> {
  return invoke("delete_downloads", { ids, deleteFile });
}

/** 暂停下载（保留已下载部分，可继续） */
export async function pauseDownload(id: string): Promise<void> {
  return invoke("pause_download", { id });
}

/** 继续暂停中的下载（断点续传） */
export async function resumeDownload(id: string): Promise<void> {
  return invoke("resume_download", { id });
}

/** 重试失败 / 已取消的下载 */
export async function retryDownload(id: string): Promise<void> {
  return invoke("retry_download", { id });
}

/** 取消下载（丢弃已下载的临时内容） */
export async function cancelDownload(id: string): Promise<void> {
  return invoke("cancel_download", { id });
}

// ---------- 批量操作（下载页多选，2026-11 下载管理完善） ----------
// 与单条版同语义，只是按 id 列表过滤执行；服务端只动仍在进行 / 暂停中的行，
// 返回实际生效的条数，让页面能提示「已暂停 N 个」。

/** 批量暂停（多选后用）。返回实际暂停的条数（已完成 / 失败的自动跳过） */
export async function pauseDownloads(ids: string[]): Promise<number> {
  return invoke("pause_downloads", { ids });
}

/** 批量继续 / 重试（多选后用）。返回实际续上的条数 */
export async function resumeDownloads(ids: string[]): Promise<number> {
  return invoke("resume_downloads", { ids });
}

/** 批量取消（多选后用）。返回实际取消的条数 */
export async function cancelDownloads(ids: string[]): Promise<number> {
  return invoke("cancel_downloads", { ids });
}

/**
 * 把取到的歌词补写成 `<音频文件名>.lrc`（下载完成时 Rust 侧已先落一份本地
 * 缓存词；这条兜「下载当时还没词、之后才拿到」的情况）。空词不落文件。
 */
export async function writeDownloadLyric(id: string, lrc: string): Promise<void> {
  return invoke("write_download_lyric", { id, lrc });
}

/** 在资源管理器中定位已下载的文件 */
export async function revealDownload(id: string): Promise<void> {
  return invoke("reveal_download", { id });
}

/** 下载任务状态变化事件（新增 / 完成 / 失败 / 暂停…） */
export function onDownloadsChanged(handler: () => void): Promise<() => void> {
  return listen("downloads-changed", () => handler());
}

/** Rust source_install.rs 广播：播放包槽变化（安装 / 切换 / 卸载后，引擎页热切换） */
export const SOURCE_PACK_CHANGED_EVENT = "source-pack-changed";

/** Rust source_install.rs 广播：数据包槽变化（meta 装载 / 停用 / 清槽后，依赖方回读状态） */
export const SOURCE_META_CHANGED_EVENT = "source-meta-changed";

export async function getDownloadDir(): Promise<string> {
  return invoke("get_download_dir");
}

/**
 * 弹出系统文件夹选择框，选中后保存为下载目录。
 * 返回选中的路径；用户取消返回 null。
 */
export async function chooseDownloadDir(): Promise<string | null> {
  return invoke("choose_download_dir");
}

/** 重置下载目录为默认（安装目录/Download），返回重置后的路径 */
export async function resetDownloadDir(): Promise<string> {
  return invoke("reset_download_dir");
}

/** 默认下载音质（settings 表 downloadQuality，缺省 320） */
export async function getDownloadQuality(): Promise<Quality> {
  const v = await getSetting(DOWNLOAD_QUALITY_KEY);
  // 口径见 lib/quality.ts 的 isQuality：档位清单由数据包注册表声明，
  // 这里只拒空值（Rust 侧 Quality 已是开放字符串，包里声明什么就认什么）
  return isQuality(v) ? v : "320";
}

/** 设置里的默认下载音质：所有下载入口（列表 / 播放条）都从这里取值 */
export async function setDownloadQuality(quality: Quality): Promise<void> {
  await setSetting(DOWNLOAD_QUALITY_KEY, quality);
}

/** 默认下载文件名格式（settings 表 downloadNameFormat，缺省 artist=歌手-歌名） */
export async function getDownloadNameFormat(): Promise<DownloadNameFormat> {
  const v = await getSetting(DOWNLOAD_NAME_FORMAT_KEY);
  return v === "song" ? "song" : "artist";
}

/** 设置里的默认下载文件名格式：新开始的下载按此命名 */
export async function setDownloadNameFormat(format: DownloadNameFormat): Promise<void> {
  await setSetting(DOWNLOAD_NAME_FORMAT_KEY, format);
}

// ---------- 下载 sidecar 开关（下载完成后同时存封面 / 歌词，2026-11） ----------
// 键与 Rust 侧 download.rs 的 SETTING_DOWNLOAD_SAVE_COVER / SETTING_DOWNLOAD_SAVE_LYRIC
// 一一对应；两边共用同一个默认口径：值 "0" = 关，其他 / 未设置 = 开（默认开）。
// 2026-10 起新增「下载存储方式」（download.storage）：内嵌进音频标签（默认）/
// 同目录 sidecar 文件，见下方 DownloadStorageMode。

/** 「下载完成后同时保存封面」的设置键（Rust 侧同名常量） */
const DOWNLOAD_SAVE_COVER_KEY = "download.saveCover";
/** 「下载完成后同时保存歌词」的设置键（Rust 侧同名常量） */
const DOWNLOAD_SAVE_LYRIC_KEY = "download.saveLyric";
/** 「下载存储方式」的设置键（Rust 侧 download.rs SETTING_DOWNLOAD_STORAGE 同名） */
const DOWNLOAD_STORAGE_KEY = "download.storage";

/** 下载完成后是否同时保存封面（默认开） */
export async function getDownloadSaveCover(): Promise<boolean> {
  return (await getSetting(DOWNLOAD_SAVE_COVER_KEY)) !== "0";
}

export async function setDownloadSaveCover(on: boolean): Promise<void> {
  await setSetting(DOWNLOAD_SAVE_COVER_KEY, on ? "1" : "0");
}

/** 下载完成后是否同时保存歌词（默认开） */
export async function getDownloadSaveLyric(): Promise<boolean> {
  return (await getSetting(DOWNLOAD_SAVE_LYRIC_KEY)) !== "0";
}

export async function setDownloadSaveLyric(on: boolean): Promise<void> {
  await setSetting(DOWNLOAD_SAVE_LYRIC_KEY, on ? "1" : "0");
}

/** 封面 / 歌词的下载存储方式 */
export type DownloadStorageMode = "embed" | "sidecar";

/**
 * 下载存储方式（用户 2026-10「下载歌曲时同时将封面和歌词内嵌到歌曲中」）：
 * - `"embed"`（默认）：封面 / 歌词 / 标题 / 歌手 / 专辑内嵌进音频文件标签
 *   （Rust 侧 embed.rs：MP3 APIC+USLT / FLAC METADATA_BLOCK_PICTURE+LYRICS /
 *   M4A covr+©lyr / WAV ID3v2 chunk…）。白名单外格式与写入失败自动降级
 *   sidecar，内容不丢；
 * - `"sidecar"`：旧行为，同名图片 + `.lrc`。
 *
 * 未设置 / 非法值一律按 `"embed"`——新行为就是默认行为（与 Rust 侧
 * `download_storage` 同口径）。
 */
export async function getDownloadStorage(): Promise<DownloadStorageMode> {
  return (await getSetting(DOWNLOAD_STORAGE_KEY)) === "sidecar" ? "sidecar" : "embed";
}

/** 设置下载存储方式（Rust 侧归一非法值，前端只透传两个合法值） */
export async function setDownloadStorage(mode: DownloadStorageMode): Promise<void> {
  await setSetting(DOWNLOAD_STORAGE_KEY, mode);
}

/** 同时下载数的合法范围（与 Rust `download::MIN/MAX_CONCURRENCY`、设置页选项一致） */
export const MIN_DOWNLOAD_CONCURRENCY = 1;
export const MAX_DOWNLOAD_CONCURRENCY = 6;
/** 默认同时下载数，与 Rust `download::DEFAULT_CONCURRENCY` 一致 */
export const DEFAULT_DOWNLOAD_CONCURRENCY = 3;

/**
 * 同时下载数（1–6）。
 *
 * 这个值由 Rust 侧的并发闸门持有（`DownloadManager`），不走 `getSetting`：
 * 闸门内存里的值才是权威值 —— 用户刚改完立刻再读，不该被库里可能写失败的
 * 旧记录盖回去。Rust 负责持久化（settings key `download.maxConcurrent`）
 * 与启动回填，前端只管读写命令。
 */
export async function getDownloadConcurrency(): Promise<number> {
  const n = await invoke<number>("get_download_concurrency");
  // 兜一层：命令层已夹过，但万一后端返回脏值也不该把 UI 带偏
  if (!Number.isFinite(n)) return DEFAULT_DOWNLOAD_CONCURRENCY;
  return Math.min(MAX_DOWNLOAD_CONCURRENCY, Math.max(MIN_DOWNLOAD_CONCURRENCY, Math.round(n)));
}

/** 设置同时下载数（越界会被 Rust 夹到 1–6），返回实际生效的值 */
export async function setDownloadConcurrency(n: number): Promise<number> {
  const clamped = Math.min(
    MAX_DOWNLOAD_CONCURRENCY,
    Math.max(MIN_DOWNLOAD_CONCURRENCY, Math.round(n)),
  );
  return invoke<number>("set_download_concurrency", { n: clamped });
}

/** 默认播放音质（设置页）：写 settings，重启后保持，并对当前曲目立即生效 */
export async function setDefaultQuality(quality: Quality): Promise<void> {
  return invoke("set_default_quality", { quality });
}

/** 当前这首的音质（播放条）：不写 settings，换曲自动回到默认音质 */
export async function setTrackQuality(quality: Quality): Promise<void> {
  return invoke("set_track_quality", { quality });
}

/** 各平台独立音质（音源账号页）：全量推送 {平台: 档位}，只更新引擎运行时副本 */
export async function setSourceQualities(qualities: Record<string, string>): Promise<void> {
  return invoke("set_source_qualities", { qualities });
}

// ---------- 倍速 / 睡眠定时 / 音效 / 缓存 / 自启 ----------

/** 改播放倍速（0.5~2.0，引擎夹紧）。立即生效并持久化，重启保持 */
export async function setSpeed(speed: number): Promise<void> {
  return invoke("set_speed", { speed });
}

/** 预载下一首并连续输出音频；开关由引擎持久化。 */
export async function setGapless(enabled: boolean): Promise<void> {
  return invoke("set_gapless", { enabled });
}

/** 武装 / 取消睡眠定时。remainingMs=倒计时毫秒（null 取消）；afterTrack=播完当前歌停 */
export async function setSleepTimer(
  remainingMs: number | null,
  afterTrack: boolean,
): Promise<void> {
  return invoke("set_sleep_timer", { remainingMs, afterTrack });
}

/** 当前音效设置（均衡器 / 响度归一化 / 淡入淡出） */
export async function getFxState(): Promise<FxState> {
  return invoke("get_fx_state");
}

/** 整体替换均衡器参数并持久化 */
export async function setEq(eq: EqParams): Promise<void> {
  return invoke("set_eq", { eq });
}

/** 响度归一化开关并持久化 */
export async function setLoudnorm(enabled: boolean): Promise<void> {
  return invoke("set_loudnorm", { enabled });
}

/** 播放条频谱背景开关（开 = 引擎侧 FFT 推 spectrum 事件） */
export async function setSpectrum(enabled: boolean): Promise<void> {
  return invoke("set_spectrum", { enabled });
}

/** 淡入淡出参数（开关 + 时长）并持久化 */
export async function setFade(fade: FadeParams): Promise<void> {
  return invoke("set_fade", { fade });
}

/** 缓存统计：播放流缓存 + 网页缓存（WebView2 封面/脚本等） */
export async function audioCacheStats(): Promise<AudioCacheStats> {
  return invoke("audio_cache_stats");
}

/** 清理播放缓存（正在播放的流对应文件自动跳过） */
export async function clearAudioCache(): Promise<AudioCacheClearResult> {
  return invoke("clear_audio_cache");
}

/** 清理网页缓存（封面/脚本/HTTP 资源；不碰登录状态与界面设置） */
export async function clearWebCache(): Promise<AudioCacheClearResult> {
  return invoke("clear_web_cache");
}

/** 清理进程内播放地址缓存（不删除磁盘音频文件）。 */
export async function clearPlayUrlCache(): Promise<RuntimeCacheClearResult> {
  return invoke("clear_play_url_cache");
}

/** 播放缓存体积上限（MB，0 = 不限）；引擎落 settings 并立即修剪 */
export async function setAudioCacheLimit(mb: number): Promise<void> {
  return invoke("set_audio_cache_limit", { mb });
}

// ---------- 日志与缓存目录（设置页「通用 → 诊断」） ----------

/**
 * 日志配置快照：级别 / 单文件上限 / 保留份数 / 目录，外加默认档与控件区间。
 *
 * `enabled = false` 表示本次运行文件日志没起来（目录建不出来），此时 `dir`
 * 仍有值但「打开文件夹」不该给用户「里面应该有日志」的错觉。
 */
export interface LogConfig {
  dir: string;
  enabled: boolean;
  /** 当前生效级别。可能比界面的四档更细：RUST_LOG=trace 时后端如实回传 */
  level: LogLevel | "trace";
  fileMb: number;
  backups: number;
  /** 没配置过时按构建走的默认级别（debug 构建 debug，发行包 warn） */
  defaultLevel: LogLevel;
  minFileMb: number;
  maxFileMb: number;
  minBackups: number;
  maxBackups: number;
}

/** 界面可选的日志级别（trace 是 log crate 的能力，不在设置页暴露） */
export type LogLevel = "error" | "warn" | "info" | "debug";

/** 读日志配置（设置页回显） */
export async function getLogConfig(): Promise<LogConfig> {
  return invoke("get_log_config");
}

/**
 * 改日志参数。传 `undefined` 的项**不动**——只调大小的时候别把级别打回默认。
 * 返回改完之后的完整配置（含夹紧后的值），界面直接拿它回显。
 */
export async function setLogConfig(patch: {
  level?: LogLevel;
  fileMb?: number;
  backups?: number;
}): Promise<LogConfig> {
  return invoke("set_log_config", {
    level: patch.level ?? null,
    fileMb: patch.fileMb ?? null,
    backups: patch.backups ?? null,
  });
}

/** 选日志目录并立刻把日志写过去；用户取消返回 null */
export async function chooseLogDir(): Promise<string | null> {
  return invoke("choose_log_dir");
}

/** 重置日志目录为默认（安装目录/logs），返回重置后的路径 */
export async function resetLogDir(): Promise<string> {
  return invoke("reset_log_dir");
}

/** 当前缓存根目录（音频缓存是它下面的 audio） */
export async function getCacheDir(): Promise<string> {
  return invoke("get_cache_dir");
}

/** 选缓存根目录并立即切换（引擎与统计同时跟随）；用户取消返回 null */
export async function chooseCacheDir(): Promise<string | null> {
  return invoke("choose_cache_dir");
}

/** 重置缓存目录为默认（安装目录/cache），返回重置后的根目录 */
export async function resetCacheDir(): Promise<string> {
  return invoke("reset_cache_dir");
}

// ---------- 数据备份 / 恢复（报告 §3.1，见 src-tauri/src/backup.rs） ----------

/** 导出结果（与 Rust `backup::BackupInfo` 对齐） */
export interface BackupInfo {
  path: string;
  manifestPath: string;
  schemaVersion: number;
  tracks: number;
  playlists: number;
  likedPlaylists: number;
  history: number;
}

/** 导入结果（与 Rust `backup::ImportSummary` 对齐） */
export interface ImportSummary {
  mode: string;
  rows: number;
  tracks: number;
  playlists: number;
  history: number;
  /** 覆盖模式下自动留下的「导入前快照」路径（反悔时把这份导回来即可） */
  safetyCopy: string | null;
}

/**
 * 把用户数据（歌单/收藏/播放记录/设置/歌词）导出到 `dir`：
 * 产出一份 `quietmusic-backup-<时间戳>.db` 快照 + 同名 `.json` 清单。
 * **不含**下载的音频文件本体（备份的是"记录"不是"文件"）。
 */
export async function exportBackup(dir: string): Promise<BackupInfo> {
  return invoke<BackupInfo>("export_backup", { dir });
}

/** 从备份文件导入：`replace` 覆盖（导入前自动拍快照）/ `merge` 合并（保留现状） */
export async function importBackup(
  path: string,
  mode: "replace" | "merge",
): Promise<ImportSummary> {
  return invoke<ImportSummary>("import_backup", { path, mode });
}

/** 打开系统「选择备份文件」对话框（.db）；用户取消返回 null */
export async function pickBackupFile(): Promise<string | null> {
  const result = await invoke<string | string[] | null>("plugin:dialog|open", {
    options: {
      directory: false,
      multiple: false,
      title: "选择备份文件",
      filters: [{ name: "轻听备份", extensions: ["db"] }],
    },
  });
  return Array.isArray(result) ? (result[0] ?? null) : result;
}

// ---------- 歌单导出 / 导入（REQUIREMENTS §3.21.5） ----------

/** 导出结果（与 Rust `playlist_io::ExportSummary` 对齐） */
export interface PlaylistExportSummary {
  name: string;
  /** `.json` 一定写了 */
  jsonPath: string;
  /** 一首本地文件都没有时为 null（不留空 m3u8） */
  m3u8Path: string | null;
  total: number;
  /** 写进 `.m3u8` 的条目数 */
  local: number;
  /** 写不进去的条目数（在线曲目 + 本机已不存在的本地文件） */
  skipped: number;
}

/** `.json` 歌单解析结果（与 Rust `playlist_io::JsonPreview` 对齐） */
export interface PlaylistJsonPreview {
  name: string;
  exportedAt: number;
  tracks: Track[];
  /** 本机不存在 / 缺字段而被丢掉的条目数 */
  skipped: number;
}

/**
 * 把一个本地歌单导出到 `dir`：`.json`（完整元数据，可跨设备恢复）
 * + `.m3u8`（只有本地文件条目，在线曲目跳过并计数）。
 * 目录由 `pickDirectory` 选出来，Rust 侧不代建目录。
 */
export async function exportPlaylist(
  pid: string,
  dir: string,
): Promise<PlaylistExportSummary> {
  return invoke<PlaylistExportSummary>("export_playlist", { pid, dir });
}

/** 解析 `.json` 歌单文件（只读不落库，导入目标由前端再选） */
export async function parsePlaylistJson(
  path: string,
): Promise<PlaylistJsonPreview> {
  return invoke<PlaylistJsonPreview>("parse_playlist_json", { path });
}

/** 打开系统「选择文件夹」对话框；用户取消返回 null */
export async function pickDirectory(title = "选择文件夹"): Promise<string | null> {
  const result = await invoke<string | string[] | null>("plugin:dialog|open", {
    options: { directory: true, multiple: false, title },
  });
  return Array.isArray(result) ? (result[0] ?? null) : result;
}

/** 打开系统「选择歌单文件」对话框（.json）；用户取消返回 null */
export async function pickPlaylistJsonFile(): Promise<string | null> {
  const result = await invoke<string | string[] | null>("plugin:dialog|open", {
    options: {
      directory: false,
      multiple: false,
      title: "选择歌单文件",
      filters: [{ name: "轻听歌单", extensions: ["json"] }],
    },
  });
  return Array.isArray(result) ? (result[0] ?? null) : result;
}

/** 开机自启是否已开启 */
export async function autostartState(): Promise<boolean> {
  return invoke("autostart_state");
}

/** 开 / 关开机自启 */
export async function setAutostart(enable: boolean): Promise<void> {
  return invoke("set_autostart", { enable });
}

// ---------- Astral 账号（DESIGN §2.3.4；契约同 qt-uniappx AccountApi） ----------

export async function astralLogin(
  username: string,
  password: string,
): Promise<AuthSession> {
  return invoke("astral_login", { username, password });
}

export async function astralRegister(
  username: string,
  password: string,
  passwordConfirm: string,
  email?: string,
  nickname?: string,
): Promise<AuthSession> {
  return invoke("astral_register", {
    username,
    password,
    passwordConfirm,
    email,
    nickname,
  });
}

export async function astralLogout(): Promise<void> {
  return invoke("astral_logout");
}

/** 当前用户信息：后端字段不固定，按原样透传 */
export async function astralMe(): Promise<Record<string, unknown> | null> {
  return invoke("astral_me");
}

/** 用旧 token 换新会话，免得重新输密码 */
export async function astralRefresh(): Promise<AuthSession> {
  return invoke("astral_refresh");
}

/** 本地保存的会话（可能已过期） */
export async function astralSession(): Promise<AuthSession | null> {
  return invoke("astral_session");
}

// ---------- 统一音源包管理（v3；类型与流程见 source-scripts/source-update.ts） ----------

export async function sourceState(): Promise<unknown> {
  return invoke("source_state");
}

/** 更新发现（force=true 越过节流；返回 offers，仅已装包的更新，无首装） */
export async function sourceDiscoverUpdates(force: boolean): Promise<unknown> {
  return invoke("source_discover_updates", { force });
}

/** 应用一个更新 offer（下载+校验+安装；失败 Rust 自动回滚拉黑） */
export async function sourceApplyUpdate(offer: unknown): Promise<unknown> {
  return invoke("source_apply_update", { offer });
}

export async function sourceInstallFromUrl(url: string): Promise<unknown> {
  return invoke("source_install_from_url", { url });
}

/** 从本地文件安装（Rust 侧弹文件选择框；用户取消返回 null） */
export async function sourceInstallLocalFile(): Promise<unknown> {
  return invoke("source_install_local_file");
}

/** 安装预览 ①（直链）：下载全文并暂存，返回预览信息；确认前不落盘 */
export async function sourceStageFromUrl(url: string): Promise<unknown> {
  return invoke("source_stage_from_url", { url });
}

/** 安装预览 ②（本地文件）：选择并读入文件后暂存（用户取消返回 null） */
export async function sourceStageFromFile(): Promise<unknown> {
  return invoke("source_stage_from_file");
}

/** 安装预览 ③：预览确认后按 token 落盘安装（token 一次性） */
export async function sourceInstallStaged(token: string): Promise<unknown> {
  return invoke("source_install_staged", { token });
}

/** 启用包（packId 空串 = 切回空位：数据面下线/播放未装，须传 kind） */
export async function sourceActivatePack(
  packId: string,
  kind?: "meta" | "play",
): Promise<unknown> {
  return invoke("source_activate_pack", { packId, kind });
}

export async function sourceUninstallPack(packId: string): Promise<unknown> {
  return invoke("source_uninstall_pack", { packId });
}

/**
 * 发邮箱验证码。
 *
 * 邮件模板业务标识（scene）由 Rust 侧持有，前端不传：后端把它**同时**当模板编码
 * （sys_mail_template.template_code）和验证码的存取 key（`qt:email:code:{email}:{scene}`），
 * 传错会既发不出信、又让 changePass 永远校验不过。
 */
export async function astralSendEmailCode(email: string): Promise<unknown> {
  return invoke("astral_send_email_code", { email });
}

export async function astralChangePassword(
  email: string,
  password: string,
  code: string,
): Promise<unknown> {
  return invoke("astral_change_password", { email, password, code });
}

export async function astralUpdateProfile(
  patch: Record<string, unknown>,
): Promise<unknown> {
  return invoke("astral_update_profile", { patch });
}

// ---------- 媒体直传（UPDATE_DESIGN.md §5.2/§5.3） ----------
//
// 文件正文不经过 Astral 服务器：Rust 侧取凭证后直传存储端再回执登记。
// CSP 不放开外部域名，直传必须落在 Rust（见 src-tauri/src/astral.rs）。

/** 打开系统「选择图片」对话框（png/jpg/webp）；用户取消返回 null */
export async function pickImage(title = "选择图片"): Promise<string | null> {
  const result = await invoke<string | string[] | null>("plugin:dialog|open", {
    options: {
      directory: false,
      multiple: false,
      title,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
    },
  });
  return Array.isArray(result) ? (result[0] ?? null) : result;
}

/** 打开系统「另存为」对话框（分享卡片保存 PNG 用）；用户取消返回 null */
export async function pickSavePath(
  defaultPath: string,
  title = "保存文件",
): Promise<string | null> {
  const result = await invoke<string | string[] | null>("plugin:dialog|save", {
    options: {
      title,
      defaultPath,
      filters: [{ name: "图片", extensions: ["png"] }],
    },
  });
  return Array.isArray(result) ? (result[0] ?? null) : result;
}

/**
 * 把前端生成的图片（base64，不含 `data:` 前缀）按用户选好的路径写盘。
 *
 * 走自建命令而不是 fs 插件：项目只装了 dialog 插件，而路径已经由系统对话框
 * 让用户当面选过，没必要为写一次文件再给前端开文件系统能力。
 */
export async function saveBinaryFile(path: string, data: string): Promise<void> {
  return invoke("save_binary_file", { path, data });
}

/** 头像上传一条龙，返回新头像 URL（URL 即版本，天然破缓存） */
export async function astralUploadAvatar(
  filePath: string,
): Promise<{ url: string }> {
  return invoke("astral_upload_avatar", { filePath });
}

/** 在线歌单封面上传，返回新封面 URL */
export async function astralUploadPlaylistCover(
  pid: string,
  platform: string,
  filePath: string,
): Promise<{ url: string }> {
  return invoke("astral_upload_playlist_cover", { pid, platform, filePath });
}

/** 清除在线歌单封面（回到默认本地资源） */
export async function astralClearPlaylistCover(
  pid: string,
  platform: string,
): Promise<void> {
  return invoke("astral_clear_playlist_cover", { pid, platform });
}

/** 设置本地自建歌单封面：选中的图片复制进应用数据目录并登记，返回封面文件路径 */
export async function setPlaylistCover(
  pid: string,
  filePath: string,
): Promise<string> {
  return invoke("set_playlist_cover", { pid, filePath });
}

/** 读本地歌单封面文件，转 data URL；未设置或读不到返回 null */
export async function getPlaylistCover(pid: string): Promise<string | null> {
  return invoke("get_playlist_cover", { pid });
}

// ---------- 听歌统计（DESIGN §5.3） ----------

export async function getPlayOverview(): Promise<PlayOverview> {
  return invoke("get_play_overview");
}

export async function getTopTracks(limit = 20): Promise<PlayStatItem[]> {
  return invoke("get_top_tracks", { limit });
}

export async function getTopSingers(limit = 10): Promise<SingerStat[]> {
  return invoke("get_top_singers", { limit });
}

/** 按歌曲、歌手或音源分页读取累计报告，排序和精确筛选都在数据库完成。 */
export async function getListenReport(query: ListenReportQuery): Promise<ListenReportPage> {
  return invoke("get_listen_report", { query });
}

/**
 * 日榜：一次拿到逐日趋势、窗口总量与前 N 条排行。
 * 与 `getListenReport({ days })` 读同一张按天明细表，两处口径必须一致。
 */
export async function getListenDayReport(query: ListenDayReportQuery): Promise<ListenDayReport> {
  return invoke("get_listen_day_report", { query });
}

/**
 * 把升级前只有累计值、没有按天明细的存量播放归到今天（报告页首次打开时调用）。
 * 只补「累计 − 明细已有之和」的差额，幂等；返回补齐的行数。
 */
export async function seedListenDays(): Promise<number> {
  return invoke("seed_listen_days");
}

/**
 * 清除听歌统计（累计与按天明细一起删），不影响收藏、歌单与播放记录。
 * 不可撤销，调用方必须先做二次确认；返回删掉的曲目数。
 */
export async function clearListenStats(): Promise<number> {
  return invoke("clear_listen_stats");
}

// ---------- 收藏同步（DESIGN §5.3；契约同 qt-uniappx services/like.ts） ----------
//
// 推送方向由 Rust 的 add_favorite / remove_favorite 顺带完成（覆盖所有入口）；
// 这里只负责拉取方向：增量拉变更 → 落本地 → 推进游标。

/** 云端收藏变更，对齐 Rust `LikeChange` */
export interface LikeChange {
  type: "song" | "playlist";
  id: string;
  platform: string;
  name: string;
  singer: string;
  album: string;
  hash: string;
  /** 歌曲所属歌单（song 变更项可空；playlist 变更项无此字段） */
  pid?: string;
  picUrl: string;
  deleted: boolean;
  updatedSeq: number;
}

export interface LikePullResult {
  changes: LikeChange[];
  maxSeq: number;
}

/** 增量拉取云端收藏变更（since 为 0 视作从头开始） */
export async function likePull(since: number): Promise<LikePullResult> {
  return invoke("like_pull", { since });
}

// ---------- 收藏的在线歌单（schema v2） ----------
//
// 只存元信息，曲目点开时向音源取。推送方向在 Rust 侧完成，这里只调命令。

/** 收藏的在线歌单元信息，对齐 Rust `LikedPlaylist` */
export interface LikedPlaylist {
  id: string;
  platform: string;
  name: string;
  picUrl: string;
  playCount: string;
  createdAt: number;
}

export async function favoritePlaylist(
  platform: string,
  id: string,
  name: string,
  picUrl?: string,
  playCount?: string,
): Promise<void> {
  return invoke("favorite_playlist", { platform, id, name, picUrl, playCount });
}

export async function unfavoritePlaylist(
  platform: string,
  id: string,
  name: string,
  picUrl?: string,
): Promise<void> {
  return invoke("unfavorite_playlist", { platform, id, name, picUrl });
}

export async function listFavoritePlaylists(): Promise<LikedPlaylist[]> {
  return invoke("list_favorite_playlists");
}

export async function isPlaylistFavorited(
  platform: string,
  id: string,
): Promise<boolean> {
  return invoke("is_playlist_favorited", { platform, id });
}

/** 全量分页拉取（游标丢失时兜底） */
export async function likePullAll(
  page: number,
  size = 100,
): Promise<unknown> {
  return invoke("like_pull_all", { page, size });
}

/** 把云端变更落到本地收藏表（不回推，避免来回震荡） */
export async function likeApply(changes: LikeChange[]): Promise<number> {
  return invoke("like_apply", { changes });
}

/** 重放收藏推送离线队列（断网期间失败的操作，启动/登录后补推） */
export async function likeFlushPending(): Promise<number> {
  return invoke("like_flush_pending");
}

/** 启动对账：本地有而云端没有的收藏补推（存在性 diff，不是版本比较） */
export async function likeReconcile(): Promise<number> {
  return invoke("like_reconcile");
}

/** 换账号登录：清空本地收藏/队列/游标（归属检测到变化时调用） */
export async function likeClearLocal(): Promise<number> {
  return invoke("like_clear_local");
}

/** 退出登录：清离线队列与游标，保留收藏数据和归属标记 */
export async function likeResetSync(): Promise<void> {
  return invoke("like_reset_sync");
}

// ---------- 通用设置项（settings 表） ----------

export async function getSetting(key: string): Promise<string | null> {
  return invoke("get_setting", { key });
}

export async function setSetting(key: string, value: string): Promise<void> {
  return invoke("set_setting", { key, value });
}

/**
 * 前端日志落盘（`@/lib/logger` 的出口；release 下 JS 崩溃也要有现场可查）。
 *
 * `level` 是界面那四档：后端只认 error/warn/info，其余一律按 debug 记
 * （见 `cmd_write_log`），这样前端加一档不必先动后端。
 */
export async function writeLog(
  level: LogLevel,
  message: string,
): Promise<void> {
  return invoke("write_log", { level, message });
}

/** 打开日志文件夹（设置页「诊断日志」） */
export async function revealLogs(): Promise<void> {
  return invoke("reveal_logs");
}

// ---------- 播放 / 队列 ----------

export async function playQueue(
  tracks: Track[],
  startIndex: number,
): Promise<void> {
  return invoke("play_queue", { tracks, startIndex });
}

/**
 * 单曲播放：不替换播放列表 —— 队里已有这首就播它原来那条，否则追加到队尾再播。
 * 「播放全部」等整列表入队走 `playQueue`。
 */
export async function playTrack(track: Track, quality: string): Promise<void> {
  return invoke("play_track", { track, quality });
}

export async function playAt(index: number): Promise<void> {
  return invoke("play_at", { index });
}

export async function next(): Promise<void> {
  return invoke("next");
}

export async function previous(): Promise<void> {
  return invoke("previous");
}

export async function setPlayMode(
  mode: PlaybackState["playMode"],
): Promise<void> {
  return invoke("set_play_mode", { mode });
}

export async function getQueue(): Promise<QueueChanged> {
  return invoke("get_queue");
}

export async function clearQueue(): Promise<void> {
  return invoke("clear_queue");
}

// ---------- 队列编辑（DESIGN §11.5 队列 2.0） ----------

/** 下一首播放：插到当前曲目之后，不打断当前播放 */
export async function queueAddNext(track: Track): Promise<void> {
  return invoke("queue_add_next", { track });
}

/** 加入队尾（不打断当前播放） */
export async function queueAppend(tracks: Track[]): Promise<void> {
  return invoke("queue_append", { tracks });
}

/** 移除队列中的某一项 */
export async function queueRemoveAt(index: number): Promise<void> {
  return invoke("queue_remove_at", { index });
}

/** 拖动排序：把 from 位置的曲目移到 to */
export async function queueMove(from: number, to: number): Promise<void> {
  return invoke("queue_move", { from, to });
}

/** 清空当前曲目之后的所有曲目 */
export async function queueClearAfter(): Promise<void> {
  return invoke("queue_clear_after");
}

/** 批量移除队列中的多项（下标按移除前位置给出）；列表以 queue-changed 事件回灌 */
export async function queueRemoveIndices(indices: number[]): Promise<void> {
  return invoke("queue_remove_indices", { indices });
}

export async function pause(): Promise<void> {
  return invoke("pause");
}

export async function resume(): Promise<void> {
  return invoke("resume");
}

export async function seek(positionMs: number): Promise<void> {
  return invoke("seek", { positionMs });
}

export async function setVolume(volume: number): Promise<void> {
  return invoke("set_volume", { volume });
}

export async function setMuted(muted: boolean): Promise<void> {
  return invoke("set_muted", { muted });
}

export async function getPlaybackState(): Promise<PlaybackState> {
  return invoke("get_playback_state");
}

/// 恢复上次播放现场：无存档返回 null（引擎侧置队列 + 暂停加载 + 定位进度）
export async function restoreLastSession(): Promise<PlaybackState | null> {
  return invoke("restore_last_session");
}

// ---------- 外观偏好（DESIGN §9.2，存 SQLite settings 表） ----------

export async function getAppearance(): Promise<AppearancePreference> {
  return invoke("get_appearance");
}

export async function setAppearance(appearance: AppearancePreference): Promise<void> {
  return invoke("set_appearance", { appearance });
}

// ---------- Astral：更新 / 消息 / 统计 / 反馈（DESIGN §15） ----------

export async function getAppVersion(): Promise<AppVersion> {
  return invoke("get_app_version");
}

export async function astralAppUpdate(): Promise<AppUpdateInfo | null> {
  return invoke("astral_app_update");
}

export async function astralCheckOfficialVersion(): Promise<unknown> {
  return invoke("astral_check_official_version");
}

export async function astralGithubAccels(): Promise<unknown> {
  return invoke("astral_github_accels");
}

// ---------- 更新下载（GitHub 加速 / 进度 / 校验 / 安装） ----------

/**
 * 组装下载地址：GitHub 直链时并发探测后端配置的加速节点，
 * 选延迟最低的可用节点拼接。返回 { downloadUrl, accelUsed, accelLatencyMs? }。
 */
export async function resolveUpdateUrl(
  downloadUrl: string,
): Promise<{ downloadUrl: string; accelUsed: boolean; accelLatencyMs?: number }> {
  return invoke("resolve_update_url", { downloadUrl });
}

/** 下载更新包（进度走 onUpdateDownloadProgress 事件），完成后 MD5/大小校验，返回落盘路径 */
export async function downloadUpdateFile(
  url: string,
  md5?: string,
  fileSize?: number,
): Promise<string> {
  return invoke("download_update_file", {
    url,
    md5: md5 ?? null,
    fileSize: fileSize ?? null,
  });
}

/** 运行已下载的安装器（应用退出后安装器继续工作） */
export async function runUpdateInstaller(path: string): Promise<void> {
  return invoke("run_update_installer", { path });
}

/** 订阅更新包下载进度 */
export function onUpdateDownloadProgress(
  handler: (payload: UpdateDownloadProgress) => void,
): Promise<() => void> {
  return listen<UpdateDownloadProgress>("update-download-progress", (e) =>
    handler(e.payload),
  );
}

/** 用系统默认浏览器打开外部链接（更新页 / 消息正文等共用） */
export async function openExternalUrl(url: string): Promise<void> {
  return invoke("run_update_browser", { url });
}

/** 用系统默认浏览器打开更新页（browserUrl 兜底） */
export async function runUpdateBrowser(url: string): Promise<void> {
  return openExternalUrl(url);
}

export async function astralActiveMessages(versionCode?: number): Promise<unknown> {
  return invoke("astral_active_messages", { versionCode: versionCode ?? null });
}

export async function astralMessageCenter(): Promise<unknown> {
  return invoke("astral_message_center");
}

export async function astralUnreadCount(): Promise<unknown> {
  return invoke("astral_unread_count");
}

export async function astralAckMessages(ids: number[]): Promise<unknown> {
  return invoke("astral_ack_messages", { ids });
}

export async function astralReportStats(events: Record<string, unknown>[]): Promise<void> {
  return invoke("astral_report_stats", { events });
}

export async function astralSubmitFeedback(
  kind: string,
  title: string,
  content: string,
  contact: string,
): Promise<unknown> {
  return invoke("astral_submit_feedback", { kind, title, content, contact });
}

/** 我的反馈分页（全部状态，create_time DESC）→ MyBatis-Plus Page { records, total, current, pages } */
export async function astralMyFeedback(pageNum: number, pageSize: number): Promise<unknown> {
  return invoke("astral_my_feedback", { pageNum, pageSize });
}

/** 公开反馈分页（status=published AND is_public）→ 同上 */
export async function astralPublicFeedback(pageNum: number, pageSize: number): Promise<unknown> {
  return invoke("astral_public_feedback", { pageNum, pageSize });
}

/** 反馈详情（本人或已公开的）→ Feedback 对象 */
export async function astralFeedbackDetail(id: number): Promise<unknown> {
  return invoke("astral_feedback_detail", { id });
}

/** 反馈回复列表（升序，带 nickname/userType）→ FeedbackReply[] */
export async function astralFeedbackReplies(id: number): Promise<unknown> {
  return invoke("astral_feedback_replies", { id });
}

/** 用户追加回复（≤2000 字；公开反馈后端会拒绝）→ 新回复对象 */
export async function astralReplyFeedback(feedbackId: number, content: string): Promise<unknown> {
  return invoke("astral_reply_feedback", { feedbackId, content });
}

// ---------- 桌面歌词窗口（DESIGN §10，窗口管理在 Rust 侧） ----------

export async function showDesktopLyric(): Promise<DesktopLyricState> {
  return invoke("show_desktop_lyric");
}

export async function hideDesktopLyric(): Promise<DesktopLyricState> {
  return invoke("hide_desktop_lyric");
}

export async function getDesktopLyricState(): Promise<DesktopLyricState> {
  return invoke("get_desktop_lyric_state");
}

export async function setDesktopLyricLocked(locked: boolean): Promise<DesktopLyricState> {
  return invoke("set_desktop_lyric_locked", { locked });
}

export async function setDesktopLyricStyle(
  patch: DesktopLyricStylePatch,
): Promise<DesktopLyricState> {
  return invoke("set_desktop_lyric_style", { patch });
}

export async function setDesktopLyricBounds(
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<DesktopLyricState> {
  return invoke("set_desktop_lyric_bounds", { x, y, width, height });
}

export async function resetDesktopLyric(): Promise<DesktopLyricState> {
  return invoke("reset_desktop_lyric");
}

/** 歌词工具条「打开歌词设置」：唤起主窗口并跳到桌面歌词设置页 */
export async function openLyricSettings(): Promise<void> {
  return invoke("open_lyric_settings");
}

// ---------- 歌词偏移与歌词落库 ----------
//
// 键口径：`trackId` = `${platform}:${id}`，与 Rust `db::store::db_track_id()` 一致。
// 偏移方向：offsetMs > 0 = 歌词延后出现，判定用 `position - offsetMs`。
//
// ## 偏移改动要广播（2026-10-06）
// 播放页与桌面歌词窗口是两个独立 WebView，各自持一份 hook 状态。以前只有「切歌」
// 才会去库里重读，于是在播放页改完偏移、桌面歌词还停在旧值上（用户看到的就是
// 「偏移不跟随」）。写入方落库后广播 `lyric-offset-changed`，另一边订阅后即时同步。

export const LYRIC_OFFSET_CHANGED_EVENT = "lyric-offset-changed";

export interface LyricOffsetChangedPayload {
  trackId: string;
  offsetMs: number;
}

/** 读逐曲目歌词偏移（毫秒）；没设过返回 0 */
export async function getLyricOffset(trackId: string): Promise<number> {
  return invoke("get_lyric_offset", { trackId });
}

/**
 * 写逐曲目歌词偏移（毫秒）；Rust 侧夹紧到 ±10s。
 * 写完广播一次变更事件，让桌面歌词 / 播放页两边立刻对齐。
 */
export async function setLyricOffset(trackId: string, offsetMs: number): Promise<void> {
  await invoke("set_lyric_offset", { trackId, offsetMs });
  // 广播失败不影响本次写入（库里已经是新值）
  void emit(LYRIC_OFFSET_CHANGED_EVENT, { trackId, offsetMs }).catch(() => undefined);
}

/**
 * 订阅歌词偏移变更（本窗口自己写的也会收到一份，调用方按需去重）。
 * @returns 取消订阅函数
 */
export function onLyricOffsetChanged(
  handler: (payload: LyricOffsetChangedPayload) => void,
): Promise<() => void> {
  return listen<LyricOffsetChangedPayload>(LYRIC_OFFSET_CHANGED_EVENT, (event) => {
    handler(event.payload);
  });
}

/**
 * 手动挑词后的广播（2026-10-08）：播放页与桌面歌词窗口是两个独立 WebView，
 * 各自持一份进程内歌词缓存。用户在播放页选定一份歌词后，播放页自己 set state 就
 * 变了，桌面歌词窗口那条旧 Promise 还躺在它自己的缓存里 —— 表现就是「主页面换了、
 * 桌面歌词还是旧词」。前面偏移事件（`lyric-offset-changed`）就是为了同一类问题加的，
 * 这里照抄一条：事件只带 `trackId`（不搬歌词正文），订阅方自己去库里回读新词。
 */
export const LYRIC_MANUALLY_PICKED_EVENT = "lyric-manually-picked";

export interface LyricManuallyPickedPayload {
  trackId: string;
  /** 这份词来自哪个音源（候选手里带的 `candidate.source`），订阅方可按需展示 */
  source: string;
}

/** 广播「这首歌词被手动换过」。广播失败不影响本次选择（库里已经是新词）。 */
export function notifyLyricManuallyPicked(trackId: string, source: string): void {
  void emit(LYRIC_MANUALLY_PICKED_EVENT, { trackId, source }).catch(() => undefined);
}

/** 订阅手动换词（本窗口自己挑的也会收到一份，调用方按需去重） */
export function onLyricManuallyPicked(
  handler: (payload: LyricManuallyPickedPayload) => void,
): Promise<() => void> {
  return listen<LyricManuallyPickedPayload>(LYRIC_MANUALLY_PICKED_EVENT, (event) => {
    handler(event.payload);
  });
}

/**
 * 取词成功后落库（火后不管，失败不影响播放）。
 *
 * 逐字 / 罗马音是 2026-10-06 补上的面：音源包（wyy/qq/kg）能给就一起存，拿不到就传空串。
 * 传参名与音源包契约 `ContractLyric` 一致，Rust 侧再映射到 `lyrics` 表的
 * `word_lrc` / `romaji` 两列（列名是 V11 迁移定下的，前端不必知道）。
 *
 * `manual` = 这份词是不是用户在播放页「搜索歌词」手动挑的：true 时取词链路直接回读它、
 * 不打源站。自动取词一律传 false，把手动标记交回去（否则手动选择会永久粘在这首歌上）。
 */
export async function saveLyric(
  trackId: string,
  lrc: string,
  wordByWord: string,
  translation: string,
  romanization: string,
  source: string,
  manual = false,
): Promise<void> {
  return invoke("save_lyric", {
    trackId,
    lrc,
    wordByWord,
    translation,
    romanization,
    source,
    manual,
  });
}

/** 回读已落库的歌词（网络取词失败的兜底）；没落过返回 null */
export async function getLyric(trackId: string): Promise<LyricRecord | null> {
  return invoke("get_lyric", { trackId });
}

/**
 * 本地歌曲自带的歌词（同名 `.lrc` 优先，其次音频文件内嵌标签）。
 *
 * `source` 的两个取值与后端 `local.rs` 的常量一一对应：
 * `local-lrc` = 同名 `.lrc` 旁挂文件，`local-tag` = 音频文件的内嵌标签。
 * 两者都取不到时后端返回 null。
 */
export interface LocalLyric {
  lrc: string;
  /** `local-lrc` / `local-tag` */
  source: string;
  /** `.lrc` 文件路径；内嵌歌词为 null */
  path: string | null;
}

/**
 * 读本地音频文件自带的歌词（2026-10-18）。纯读盘，不碰数据库。
 *
 * 扫描时已经把文件里的词落过一次库（`library_scan`），这条链路补的是扫描之外的三种
 * 情况：拖进来还没入库的文件、扫描之后才放进来的 `.lrc`、以及用户改了 `.lrc` 内容。
 */
export async function readLocalLyric(path: string): Promise<LocalLyric | null> {
  return invoke("read_local_lyric", { path });
}

// ---------- 不喜欢列表（屏蔽规则） ----------
//
// 规则按「歌名 + 歌手」匹配，不按曲目 id —— id 是平台私有的，换源兜底后同一首歌的
// id 与 platform 都会变。Rust 侧做归一化匹配（全角折叠 / 去标点 / 剥版本后缀），
// 前端不需要也不能自己猜匹配规则，只负责搬运与展示。

/** 全部屏蔽规则（最近屏蔽的排前面） */
export async function listDislikes(): Promise<DislikeRule[]> {
  return invoke("list_dislikes");
}

/** 屏蔽一首歌。返回规则 id（设置页逐条删除要用），0 = 没成功 */
export async function addDislikeSong(track: Track): Promise<number> {
  return invoke("add_dislike_song", { track });
}

/**
 * 屏蔽某位歌手（整串歌手按分隔符拆开，逐词各建一条规则）。
 * 返回本次涉及的**全部**规则 id —— 歌手串可能拆出多条，前端要能一次撤销整串。
 */
export async function addDislikeSinger(singer: string): Promise<number[]> {
  return invoke("add_dislike_singer", { singer });
}

/**
 * 取消屏蔽某位歌手（按整串拆词逐条删），返回删掉几条。
 * 与 `addDislikeSinger` 严格互逆 —— 不依赖前端记住 id，重启后也能干净撤销。
 */
export async function removeDislikeSinger(singer: string): Promise<number> {
  return invoke("remove_dislike_singer", { singer });
}

/** 取消屏蔽（按规则 id 逐条删除） */
export async function removeDislikeRule(id: number): Promise<boolean> {
  return invoke("remove_dislike_rule", { id });
}

/** 清空全部屏蔽规则 */
export async function clearDislikes(): Promise<void> {
  return invoke("clear_dislikes");
}

/**
 * 批量判定：返回与 `tracks` 等长的布尔向量，true = 这首已被屏蔽。
 *
 * 一次传整屏回来 —— 列表一屏就是上百首，逐行查会把 IPC 通道打满。
 */
export async function checkDisliked(tracks: Track[]): Promise<boolean[]> {
  return invoke("check_disliked", { tracks });
}

// ---------- 事件 ----------

export function onPositionChanged(
  handler: (payload: PositionChanged) => void,
): Promise<() => void> {
  return listen<PositionChanged>("position-changed", (e) => handler(e.payload));
}

export function onPlaybackStateChanged(
  handler: (payload: PlaybackState) => void,
): Promise<() => void> {
  return listen<PlaybackState>("playback-state-changed", (e) =>
    handler(e.payload),
  );
}

export function onAudioError(
  handler: (payload: AudioError) => void,
): Promise<() => void> {
  return listen<AudioError>("audio-error", (e) => handler(e.payload));
}

export function onQueueChanged(
  handler: (payload: QueueChanged) => void,
): Promise<() => void> {
  return listen<QueueChanged>("queue-changed", (e) => handler(e.payload));
}

export function onLyricWindowChanged(
  handler: (payload: DesktopLyricState) => void,
): Promise<() => void> {
  return listen<DesktopLyricState>("lyric-window-changed", (e) =>
    handler(e.payload),
  );
}

/** 歌词工具条请求打开主窗口的「设置 · 桌面歌词」页（Rust 唤起主窗口后发出） */
export function onLyricOpenSettings(handler: () => void): Promise<() => void> {
  return listen("lyric-open-settings", () => handler());
}

// ---------- 网络设置（第二波：代理与单源超时） ----------

export async function getNetConfig(): Promise<NetConfigView> {
  return invoke("get_net_config");
}

/** 校验 → 落库 → 更新全局代际；常驻客户端对下一次请求生效（详见 Rust net_config 模块注释） */
export async function setNetConfig(
  proxyMode: string,
  proxyUrl: string,
  sourceTimeoutMs: number,
): Promise<NetConfigView> {
  return invoke("set_net_config", { proxyMode, proxyUrl, sourceTimeoutMs });
}

/** 试连用表单值临时构建客户端，不动已保存配置；失败时 error 带原因 */
export async function testNetConfig(
  proxyMode: string,
  proxyUrl: string,
): Promise<NetTestResult> {
  return invoke("test_net_config", { proxyMode, proxyUrl });
}

/**
 * 进入 / 退出迷你播放器模式（REQUIREMENTS §3.21.7.2）。
 *
 * 互切由 Rust 侧一起做：返回 visible=true 表示已切到迷你窗（主窗随即被收起），
 * visible=false 表示已回到主窗（迷你窗已收起）。前端不需要自己调窗口 API。
 */
export async function toggleMiniPlayer(): Promise<MiniPlayerState> {
  return invoke("toggle_mini_player");
}

export async function getFileAssociationState(): Promise<FileAssociationState> {
  return invoke("get_file_association_state");
}

export async function registerFileAssociations(): Promise<FileAssociationState> {
  return invoke("register_file_associations");
}

export async function unregisterFileAssociations(): Promise<FileAssociationState> {
  return invoke("unregister_file_associations");
}

export async function openDefaultAppsSettings(): Promise<void> {
  return invoke("open_default_apps_settings");
}

// ---------- AI 助手 ----------
//
// 与 qt-uniappx 完全同一套 App 端契约（`/api/v1/app/ai/**`）。本端不能直连后端
// —— CSP 的 connect-src 只放 self/ipc/qtres —— 所以每个接口都在 Rust 里转一手，
// 并且由 Rust 侧显式带上 `clientType=QT_PC`（后端兜底值是 QT_UNIAPPX，不传就会
// 被当成手机端，智能体按客户端过滤后可能压根不返回）。
//
// 返回值统一 `unknown`：逐字段规整放在 `src/lib/ai.ts`。这里不标强类型，是因为
// Rust 侧透传的是 `serde_json::Value`，写 `Promise<AiConversation>` 只是把
// 「后端改了字段」藏起来，真出问题时更难查。

/** 本端可见的音乐助手列表（后端已按 clientType 过滤成 QT_PC） */
export async function astralAiAgents(): Promise<unknown> {
  return invoke("astral_ai_agents");
}

/** 智能体能力（是否支持会话/反馈/引用等） */
export async function astralAiCapabilities(agentCode: string): Promise<unknown> {
  return invoke("astral_ai_capabilities", { agentCode });
}

/** 当前用户在该智能体下的会话列表 */
export async function astralAiConversations(agentCode: string): Promise<unknown> {
  return invoke("astral_ai_conversations", { agentCode });
}

/** 建会话；标题由前端传，后端只存不猜 */
export async function astralAiCreateConversation(
  agentCode: string,
  title: string,
): Promise<unknown> {
  return invoke("astral_ai_create_conversation", { agentCode, title });
}

export async function astralAiConversation(id: number): Promise<unknown> {
  return invoke("astral_ai_conversation", { id });
}

export async function astralAiDeleteConversation(id: number): Promise<unknown> {
  return invoke("astral_ai_delete_conversation", { id });
}

/** 历史消息（倒序游标：`beforeId` 为空表示取最近一页） */
export async function astralAiMessages(
  conversationId: number,
  beforeId?: number,
  limit?: number,
): Promise<unknown> {
  return invoke("astral_ai_messages", { conversationId, beforeId, limit });
}

/**
 * 发消息。只受理、不返回回答：真正的回答靠轮询 `astralAiEvents` 拿。
 *
 * `context` 里必须带客户端掌握的现状（当前歌曲/队列/音源清单/候选），后端按白名单
 * 过滤后才给模型看。`idempotencyKey` 由调用方生成，重试同一个 key 不会重复扣额度。
 */
export async function astralAiSendMessage(
  conversationId: number,
  content: string,
  context: Record<string, unknown>,
  idempotencyKey: string,
): Promise<unknown> {
  return invoke("astral_ai_send_message", {
    conversationId,
    content,
    context,
    idempotencyKey,
  });
}

/** 拉一轮事件；`after` 是上一轮的 `nextSequence`，按 sequence 升序增量返回 */
export async function astralAiEvents(
  requestId: number,
  after: number,
  limit: number,
): Promise<unknown> {
  return invoke("astral_ai_events", { requestId, after, limit });
}

/** 停止生成（后端幂等：已终态时直接返回现状，不报错） */
export async function astralAiCancelRequest(
  requestId: number,
  reason: string,
): Promise<unknown> {
  return invoke("astral_ai_cancel_request", { requestId, reason });
}

/** 消息反馈（LIKE/DISLIKE/REGENERATE/REPORT） */
export async function astralAiFeedback(
  messageId: number,
  feedbackType: string,
  reasonCode: string,
  comment: string,
): Promise<unknown> {
  return invoke("astral_ai_feedback", {
    messageId,
    feedbackType,
    reasonCode,
    comment,
  });
}

/** 回报动作执行结果，供后台统计采纳率（只报真执行了的，不支持的不报） */
export async function astralAiExecuteAction(
  actionId: string,
  actionType: string,
  success: boolean,
  message: string,
): Promise<unknown> {
  return invoke("astral_ai_execute_action", {
    actionId,
    actionType,
    success,
    message,
  });
}

// ---------- 客户端直连模型（每日推荐 AI 精选用，详见 Rust ai_local 模块注释） ----------

/**
 * 读配置。**永远拿不到 Key 明文**，只有 `hasKey`。
 *
 * 为什么不复用 `getSetting`：那会把 Key 明文带到前端 JS 里；这里由 Rust 侧读库、
 * 只回布尔值，Key 从进入进程到发出去都不经过 WebView。
 */
export async function aiLocalConfig(): Promise<AiLocalConfigView> {
  return invoke("ai_local_config");
}

/**
 * 整体保存配置档列表 + 当前生效档。
 *
 * 配置档是整体结构（多套接口地址任选其一），改一档就整份覆盖；
 * 每档的 `apiKey` 传 `undefined` = 不改动已存的 Key（设置页留空即此语义），
 * 传空串 = 清空。地址会先在 Rust 侧归一校验，填错当场报错不落库。
 */
export async function aiLocalSaveConfig(
  profiles: AiProfileInput[],
  activeId: string,
): Promise<AiLocalConfigView> {
  return invoke("ai_local_save_config", { profiles, activeId });
}

/** 试连：发一句「你好」。用表单值，允许「先试再存」；失败时 error 带可读原因 */
export async function aiLocalTest(
  baseUrl: string,
  model: string,
  apiKey?: string,
  protocol?: AiProviderProtocol,
  skipCertVerify?: boolean,
): Promise<AiLocalTestResult> {
  return invoke("ai_local_test", {
    baseUrl,
    model,
    apiKey: apiKey ?? null,
    protocol: protocol ?? null,
    skipCertVerify: skipCertVerify ?? null,
  });
}

/**
 * 拉该地址支持的模型列表（`GET /v1/models`）。模型名可下拉选、也可手输 ——
 * 有些网关不实现 /models，所以这里失败不阻断，设置页照旧允许手填。
 */
export async function aiLocalListModels(
  baseUrl: string,
  apiKey?: string,
  protocol?: AiProviderProtocol,
  skipCertVerify?: boolean,
): Promise<string[]> {
  return invoke("ai_local_list_models", {
    baseUrl,
    apiKey: apiKey ?? null,
    protocol: protocol ?? null,
    skipCertVerify: skipCertVerify ?? null,
  });
}

/**
 * 生成。前端给完整 messages（系统提示 + 用户），Rust 只做转发与取回 content。
 *
 * 提示词组装、候选池注入、结果硬校验全在 `@/lib/daily-recommend`，
 * 这里保持成一条「哑管道」，换模型服务商不用改 Rust。
 */
export async function aiLocalChat(
  messages: AiLocalMessage[],
  temperature?: number,
): Promise<AiLocalReply> {
  return invoke("ai_local_chat", {
    messages,
    temperature: temperature ?? null,
  });
}
