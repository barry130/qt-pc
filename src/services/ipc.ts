import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AppearancePreference,
  AppUpdateInfo,
  AppVersion,
  AudioError,
  PlayOverview,
  PlayStatItem,
  SingerStat,
  AuthSession,
  DesktopLyricState,
  DesktopLyricStylePatch,
  DownloadTask,
  HistoryItem,
  MyPlaylistSummary,
  PlaybackState,
  PositionChanged,
  QueueChanged,
  Quality,
  Track,
  UpdateDownloadProgress,
} from "@/types";

/**
 * M0-M2 IPC 契约。命令名与 Rust 侧 `#[tauri::command]` 一一对应；
 * 全部走 invoke，前端不直接发任何外部网络请求（CSP 不放开外部域名）。
 */

/// 取链脚本化（方案 v3）：把共享脚本包解析出的地址回填 Rust 引擎缓存
export async function setResolvedPlayUrl(
  track: Track,
  quality: Quality,
  url: string,
): Promise<void> {
  return invoke("set_resolved_play_url", { track, quality, url });
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
  return invoke("scan_library", { dirs, minDurationSecs, minSizeBytes });
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

/** 本地曲目的文件大小 / 修改时间（供按大小、修改时间排序） */
export interface LocalTrackFileMeta {
  id: string;
  fileSize: number;
  mtime: number;
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

/** 读本地音频的内嵌封面（data URL）；没有封面返回 null。path 即本地 Track.id */
export async function getLocalCover(path: string): Promise<string | null> {
  return invoke("get_local_cover", { path });
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
export interface LibraryScanProgress {
  visited: number;
  found: number;
  current: string;
}

export function onLibraryScanProgress(
  handler: (p: LibraryScanProgress) => void,
): Promise<() => void> {
  return listen<LibraryScanProgress>("library-scan-progress", (e) =>
    handler(e.payload),
  );
}

// ---------- 用户数据：收藏 / 播放历史（DESIGN §5.3） ----------
// 播放历史由 Rust 侧在播放开始时自动写入，前端只负责读取与清空。

// 收藏必须挂在歌单上：歌单由永久全局唯一的 pid 标识（创建后不变），
// 歌单只来自云端同步的卡片或本地自建；无归属（pid 找不到歌单）的歌不加载。
export const LOCAL_PLATFORM = "local";

/** 收藏一首歌。`pid` 不传 = 散装收藏，落到「我喜欢的歌曲」。 */
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

export async function listHistory(limit?: number): Promise<HistoryItem[]> {
  return invoke("list_history", { limit: limit ?? 0 });
}

export async function clearHistory(): Promise<void> {
  return invoke("clear_history");
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
): Promise<void> {
  return invoke("add_tracks_to_playlist", { id, tracks });
}

export async function removeTrackFromPlaylist(
  id: string,
  track: Track,
): Promise<void> {
  return invoke("remove_track_from_playlist", { id, track });
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

/** 在资源管理器中定位已下载的文件 */
export async function revealDownload(id: string): Promise<void> {
  return invoke("reveal_download", { id });
}

/** 下载任务状态变化事件（新增 / 完成 / 失败 / 暂停…） */
export function onDownloadsChanged(handler: () => void): Promise<() => void> {
  return listen("downloads-changed", () => handler());
}

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
  return v === "128" || v === "320" || v === "flac" ? v : "320";
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

/** 默认播放音质（设置页）：写 settings，重启后保持，并对当前曲目立即生效 */
export async function setDefaultQuality(quality: Quality): Promise<void> {
  return invoke("set_default_quality", { quality });
}

/** 当前这首的音质（播放条）：不写 settings，换曲自动回到默认音质 */
export async function setTrackQuality(quality: Quality): Promise<void> {
  return invoke("set_track_quality", { quality });
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

// ---------- 音源包热更新（P1/P2；类型与流程见 source-scripts/source-update.ts） ----------

export async function sourceState(): Promise<unknown> {
  return invoke("source_state");
}

export async function sourceManifest(): Promise<unknown> {
  return invoke("source_manifest");
}

export async function sourceInstall(release: unknown): Promise<unknown> {
  return invoke("source_install", { release });
}

export async function sourceApply(smoke = true): Promise<void> {
  return invoke("source_apply", { smoke });
}

export async function sourceRollbackBuiltin(): Promise<void> {
  return invoke("source_rollback_builtin");
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

// ---------- 播放 / 队列 ----------

export async function playTrack(track: Track): Promise<void> {
  return invoke("play_track", { track });
}

export async function playQueue(
  tracks: Track[],
  startIndex: number,
): Promise<void> {
  return invoke("play_queue", { tracks, startIndex });
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

export async function pause(): Promise<void> {
  return invoke("pause");
}

export async function resume(): Promise<void> {
  return invoke("resume");
}

export async function stop(): Promise<void> {
  return invoke("stop");
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
