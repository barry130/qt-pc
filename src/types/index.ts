/** 源 ID，与 DESIGN §6.4 一致（serde rename_all = "lowercase"） */
export type SourceId = "wyy" | "qq" | "kw" | "kg" | "local";

/** 音质，serde 值直接对齐 "128" / "320" / "flac" */
export type Quality = "128" | "320" | "flac";

export type PlaybackStatus =
  | "stopped"
  | "loading"
  | "buffering"
  | "playing"
  | "paused"
  | "error";

/** 对齐 Rust `Track`（serde rename_all = "camelCase"） */
export interface Track {
  id: string;
  platform: SourceId;
  title: string;
  singer: string;
  album: string;
  picUrl: string;
  /** 秒（移动端同口径） */
  duration: number;
  musicId?: string | null;
}

/** 播放历史条目，对齐 Rust `HistoryItem`（serde rename_all = "camelCase"，DESIGN §5.3） */
export interface HistoryItem {
  track: Track;
  /** 播放时间，Unix 毫秒 */
  playedAt: number;
}

/** 下载任务，对齐 Rust `DownloadTask`（DESIGN §5.3） */
export interface DownloadTask {
  id: string;
  track: Track;
  quality: Quality;
  /** pending / downloading / done / failed */
  status: "pending" | "downloading" | "done" | "failed";
  /** 0 ~ 1 */
  progress: number;
  filePath: string | null;
  fileSize: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Astral 登录会话，对齐 Rust `AuthSession`（camelCase，DESIGN §2.3.4） */
export interface AuthSession {
  token: string;
  refreshToken: string;
  /** 过期时间，Unix 毫秒 */
  expiresAt: number;
}

/** 听歌统计概览，对齐 Rust `PlayOverview`（DESIGN §5.3） */
export interface PlayOverview {
  totalPlays: number;
  totalMs: number;
  /** 有统计的曲目数，不是总播放次数 */
  trackCount: number;
  lastPlayedAt: number | null;
}

/** 单曲统计，对齐 Rust `PlayStatItem` */
export interface PlayStatItem {
  track: Track;
  playCount: number;
  lastPlayedAt: number;
  totalPlayedMs: number;
}

/** 歌手统计，对齐 Rust `SingerStat` */
export interface SingerStat {
  singer: string;
  /** 该歌手统计里出现过的一个音源（分组只按歌手名，音源取其一） */
  platform: string;
  playCount: number;
}

/** 我的歌单摘要，对齐 Rust `PlaylistSummary`（DESIGN §5.3） */
export interface MyPlaylistSummary {
  id: string;
  /**
   * 歌单的永久全局唯一标识（UUID，创建后不再变化）：
   * 收藏歌曲 / 查询歌单 / 删除歌单 / 上送云端登记全按它走。
   * 在线歌单的 pid 就是收藏时的歌单 id。
   */
  pid: string;
  name: string;
  /**
   * 来源：`local` 是本地自建歌单，其余（qq / wyy / kw / kg）是在线收藏的歌单。
   * 两类共存于「我的歌单」，但可做的操作不同：在线歌单不能重命名，
   * 「移除」的语义是取消收藏而不是删除。
   */
  platform: string;
  /** 封面。在线歌单是音源 URL，本地歌单是本地路径（可能为空） */
  picUrl: string;
  /** 歌单内曲目数。在线歌单曲目不落本地，恒为 0 */
  trackCount: number;
  createdAt: number;
  updatedAt: number;
  /** 是否本地自建（可改名/删除）；false = 云端同步卡片（「移除」= 取消收藏） */
  isLocal: boolean;
}

/** 对齐 Rust `PlayUrl` */
export interface PlayUrl {
  url: string;
  quality: Quality;
  /** epoch ms */
  fetchedAt: number;
  /** epoch ms，= fetchedAt + 10min */
  expiresAt: number;
}

/** 对齐 Rust `Lyric` */
export interface Lyric {
  lrc: string;
  translation: string;
}

// ---------- 发现类统一模型（DESIGN §6.6） ----------

/** 歌单广场分类；group 为音源侧分组名（如 wyy 的“语种/风格/场景”），无分组时为 null */
export interface PlaylistCategory {
  id: string;
  name: string;
  group: string | null;
}

/** 歌单（广场卡片 / 详情）。playCount 是音源已格式化的字符串（如 "1.2万"） */
export interface Playlist {
  id: string;
  platform: SourceId;
  name: string;
  picUrl: string;
  playCount: string;
  description: string | null;
  /** 仅详情接口填充 */
  tracks?: Track[];
}

/** 歌手（搜索歌手结果） */
export interface Artist {
  id: string;
  platform: SourceId;
  name: string;
  picUrl: string;
}

/** 专辑（搜索专辑结果） */
export interface Album {
  id: string;
  platform: SourceId;
  name: string;
  artist: string;
  picUrl: string;
}

/** 榜单（排行榜列表项） */
export interface Chart {
  id: string;
  platform: SourceId;
  name: string;
  picUrl: string;
  description: string | null;
}

/** MV / 视频 */
export interface Video {
  id: string;
  platform: SourceId;
  name: string;
  picUrl: string;
  singer: string;
}

/** 对齐 Rust `PlaybackState`（DESIGN §7.2 全量快照） */
export interface PlaybackState {
  trackId: string | null;
  sourceId: SourceId | null;
  status: PlaybackStatus;
  positionMs: number;
  durationMs: number;
  bufferedMs: number;
  volume: number;
  muted: boolean;
  playMode: "sequence" | "listLoop" | "oneLoop" | "random";
  quality: Quality;
  queueIndex: number | null;
  queueLen: number;
  isLocal: boolean;
  urlFetchedAt: number | null;
  error: string | null;
  sleepTimerMs: number | null;
  /** 当前曲目（Rust 侧冗余携带，前端渲染播放条直接用） */
  track: Track | null;
  /** 当前音频输出设备名（设置页显示用） */
  outputDevice: string;
}

/** position-changed 事件负载 */
export interface PositionChanged {
  positionMs: number;
  durationMs: number;
  bufferedMs: number;
  /** 发送时刻单调时钟（原点 = 引擎启动），前端插值以本地接收时刻为基准，此字段用于漂移检测 */
  monotonicMs: number;
}

/** audio-error 事件负载 */
export interface AudioError {
  trackId: string | null;
  kind: string;
  message: string;
}

/** queue-changed 事件负载 */
export interface QueueChanged {
  tracks: Track[];
  index: number | null;
}

export const SOURCE_DISPLAY: Record<Exclude<SourceId, "local">, string> = {
  wyy: "音源一",
  qq: "音源二",
  kw: "音源三",
  kg: "音源四",
};

/** 外观偏好（DESIGN §9.2 AppearancePreference，存 SQLite settings 表） */
export interface AppearancePreference {
  /** 亮暗模式：浅色 / 深色 / 跟随系统 */
  mode: "light" | "dark" | "system";
  /** 皮肤 ID：内置皮肤 ID 或 "custom"（自定义） */
  skinId: string;
  /** 自定义主色（skinId="custom" 时生效） */
  customColor: string;
  /** 跟随封面取色（开启后皮肤主色被封面色覆盖） */
  followCoverColor: boolean;
  /** 减弱动效（跟随系统"减少动态效果"之外的显式开关） */
  reduceMotion: boolean;
  /** 字体缩放倍率（0.85–1.25） */
  fontScale: number;
  /** 背景图片（data URL，留空则不显示） */
  bgImage: string;
}

/** 外观默认值（与 Rust 侧 default_appearance 保持一致） */
export const DEFAULT_APPEARANCE: AppearancePreference = {
  mode: "system",
  skinId: "default",
  customColor: "#6366f1",
  followCoverColor: false,
  reduceMotion: false,
  fontScale: 1.0,
  bgImage: "",
};

/** 后端 QtAppUpdate 更新信息（§15.3，字段对齐移动端 upgrade.ts） */
export interface AppUpdateInfo {
  versionCode: number;
  versionName: string;
  versionInfo: string;
  /** 1 弹窗 / 2 红点 / 3 无提示 */
  updateType: string;
  downloadUrl: string;
  browserUrl: string;
  isGithub: number;
  channel: string;
  /** 后端 Integer，0/1 */
  isForce: number;
  fileSize: number;
  md5: string;
}

/** 更新包下载进度（update-download-progress 事件负载） */
export interface UpdateDownloadProgress {
  percent: number;
  written: number;
  total: number;
}

/** 当前版本信息（单一真值 = Rust CARGO_PKG_VERSION，§15.7） */
export interface AppVersion {
  versionName: string;
  versionCode: number;
}

/** 桌面歌词窗口状态（对齐 Rust LyricWindowState，§4.2） */
export interface DesktopLyricState {
  visible: boolean;
  locked: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontWeight: number;
  opacity: number;
  backgroundOpacity: number;
  stroke: boolean;
  shadow: boolean;
  gradient: [string, string];
  /** single / two-lines */
  lineMode: "single" | "two-lines";
}

/** 桌面歌词样式补丁（字段级合并，Rust 侧逐字段校验夹紧） */
export interface DesktopLyricStylePatch {
  fontSize?: number;
  fontWeight?: number;
  opacity?: number;
  backgroundOpacity?: number;
  stroke?: boolean;
  shadow?: boolean;
  lineMode?: "single" | "two-lines";
  gradient?: [string, string];
}
