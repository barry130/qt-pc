import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Album,
  AppearancePreference,
  AppUpdateInfo,
  AppVersion,
  Artist,
  AudioError,
  Chart,
  PlayOverview,
  PlayStatItem,
  SingerStat,
  AuthSession,
  DesktopLyricState,
  DesktopLyricStylePatch,
  DownloadTask,
  HistoryItem,
  Lyric,
  MyPlaylistSummary,
  Playlist,
  PlaylistCategory,
  PlayUrl,
  PlaybackState,
  PositionChanged,
  QueueChanged,
  Quality,
  SourceId,
  Track,
  UpdateDownloadProgress,
  Video,
} from "@/types";

/**
 * M0-M2 IPC 契约。命令名与 Rust 侧 `#[tauri::command]` 一一对应；
 * 全部走 invoke，前端不直接发任何外部网络请求（CSP 不放开外部域名）。
 */

// ---------- 音源 ----------

export async function searchMusic(
  keyword: string,
  source: SourceId,
  page: number,
  size: number,
): Promise<Track[]> {
  return invoke("search_music", { keyword, source, page, size });
}

export async function getPlayUrl(
  track: Track,
  quality: Quality,
): Promise<PlayUrl> {
  return invoke("get_play_url", { track, quality });
}

export async function getLyric(track: Track): Promise<Lyric> {
  return invoke("get_lyric", { track });
}

/// MV/视频播放地址（quality：auto / hd / low）
export async function getVideoUrl(
  source: SourceId,
  videoId: string,
  quality: string,
): Promise<string> {
  return invoke("get_video_url", { source, videoId, quality });
}

// ---------- 发现类：歌单 / 榜单 / 新歌 / 热词 / 搜索（DESIGN §6.5） ----------

export async function getPlaylistCategories(
  source: SourceId,
): Promise<PlaylistCategory[]> {
  return invoke("get_playlist_categories", { source });
}

export async function getRecommendations(
  source: SourceId,
  category: string | null,
  page: number,
): Promise<Playlist[]> {
  return invoke("get_recommendations", { source, category, page });
}

export async function getLatestSongs(
  source: SourceId,
  limit: number,
  offset: number,
): Promise<Track[]> {
  return invoke("get_latest_songs", { source, limit, offset });
}

export async function getAllLatestSongs(
  limit: number,
  offset: number,
): Promise<Track[]> {
  return invoke("get_all_latest_songs", { limit, offset });
}

export async function getCharts(source: SourceId): Promise<Chart[]> {
  return invoke("get_charts", { source });
}

export async function getAllCharts(): Promise<Chart[]> {
  return invoke("get_all_charts");
}

export async function getChartDetail(
  chart: Chart,
  page: number,
  size: number,
): Promise<Track[]> {
  return invoke("get_chart_detail", { chart, page, size });
}

export async function getPlaylistDetail(
  source: SourceId,
  id: string,
  page: number,
  size: number,
): Promise<Playlist> {
  return invoke("get_playlist_detail", { source, id, page, size });
}

export async function getHotWords(source: SourceId): Promise<string[]> {
  return invoke("get_hot_words", { source });
}

export async function getAllHotWords(): Promise<string[]> {
  return invoke("get_all_hot_words");
}

export async function searchPlaylists(
  source: SourceId,
  keyword: string,
  page: number,
  size: number,
): Promise<Playlist[]> {
  return invoke("search_playlists", { source, keyword, page, size });
}

export async function searchArtists(
  source: SourceId,
  keyword: string,
  page: number,
  size: number,
): Promise<Artist[]> {
  return invoke("search_artists", { source, keyword, page, size });
}

export async function searchAlbums(
  source: SourceId,
  keyword: string,
  page: number,
  size: number,
): Promise<Album[]> {
  return invoke("search_albums", { source, keyword, page, size });
}

export async function searchAllMusicSources(
  keyword: string,
  page: number,
  size: number,
): Promise<Track[]> {
  return invoke("search_all_music_sources", { keyword, page, size });
}

export async function getArtistSongs(
  source: SourceId,
  name: string,
  page: number,
  size: number,
): Promise<Track[]> {
  return invoke("get_artist_songs", { source, name, page, size });
}

export async function getVideos(
  source: SourceId,
  page: number,
  size: number,
): Promise<Video[]> {
  return invoke("get_videos", { source, page, size });
}

export async function getTrackCover(track: Track): Promise<string> {
  return invoke("get_track_cover", { track });
}

// ---------- 本地音乐（DESIGN §13） ----------
// 本地曲目的 Track.id 就是文件绝对路径，平台固定 "local"；
// 播放时 Rust 侧 engine 会特判 Local 直接按路径解码，不走 Provider 取址。

export async function scanLibrary(dirs: string[]): Promise<Track[]> {
  return invoke("scan_library", { dirs });
}

export async function getLocalTracks(): Promise<Track[]> {
  return invoke("get_local_tracks");
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

// ---------- 下载管理（DESIGN §5.3） ----------
// start_download 只负责发起（返回任务 id），进度在后台写入库，前端轮询 listDownloads。

/** 「默认下载音质」在 settings 表里的键 */
const DOWNLOAD_QUALITY_KEY = "downloadQuality";

export async function startDownload(
  track: Track,
  quality: Quality,
): Promise<string> {
  return invoke("start_download", { track, quality });
}

export async function listDownloads(): Promise<DownloadTask[]> {
  return invoke("list_downloads");
}

/** deleteFile=true 时连同已下载的文件一起删除 */
export async function deleteDownload(
  id: string,
  deleteFile: boolean,
): Promise<void> {
  return invoke("delete_download", { id, deleteFile });
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
  email?: string,
  code?: string,
): Promise<AuthSession> {
  return invoke("astral_register", { username, password, email, code });
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

/** 发邮箱验证码（注册 / 找回密码共用） */
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

/** 用系统默认浏览器打开更新页（browserUrl 兜底） */
export async function runUpdateBrowser(url: string): Promise<void> {
  return invoke("run_update_browser", { url });
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
