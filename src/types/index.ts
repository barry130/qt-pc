/**
 * 源 ID。**清单由数据包注册表声明**（`__qtEntries.sourceRegistry()` →
 * stores/sourceRegistry.ts），本端不内置音源列表；`"local"` 是保留值（本地
 * 曲库，不走在线接口）。注意：Rust 侧 `provider::types::SourceId` 是封闭
 * 枚举，**全新 id** 要真正可播/可收藏还需在 Rust `parse()` 补一枚（存量
 * 四源 + local 不受影响；下线某个源只需数据包不再声明，UI 随之消失）。
 */
export type SourceId = string;

/**
 * 音质 id。档位清单同样由数据包注册表声明；可播值受 Rust serde 枚举约束
 * （"128" / "320" / "flac"，判口径见 lib/quality.ts 的 isQuality）。
 */
export type Quality = string;

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
  /** 本地曲目：文件大小（字节）；在线曲目无。供本地库按大小排序 */
  fileSize?: number | null;
  /** 本地曲目：文件修改时间（秒）；在线曲目无。供本地库按修改时间排序 */
  mtime?: number | null;
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
  /** pending / downloading / paused / done / failed / canceled */
  status: "pending" | "downloading" | "paused" | "done" | "failed" | "canceled";
  /** 0 ~ 1 */
  progress: number;
  filePath: string | null;
  fileSize: number | null;
  error: string | null;
  /** 断点续传的临时文件路径（`.part`） */
  partPath?: string | null;
  /** 服务端声明的总字节数（写完后校验用） */
  totalBytes?: number | null;
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
  /** 当前实际播放地址（在线曲目才有）。换源兜底后指向目标源，歌词按它换源取词 */
  playUrl: string | null;
  error: string | null;
  /** 睡眠定时剩余毫秒（快照时刻的剩余量，前端本地倒计时）；null = 未定时 */
  sleepTimerMs: number | null;
  /** 睡眠定时为「播完当前曲目后停止」模式 */
  sleepAfterTrack: boolean;
  /** 播放倍速（1.0 = 原速；进度/seek 均为内容时间域，与倍速无关） */
  speed: number;
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

/** 数据包注册表声明的音源：展示名/短名/色值，数组顺序即 UI 展示顺序 */
export interface RegistrySource {
  id: string;
  name: string;
  short: string;
  color: string;
}

/** 数据包注册表声明的音质档位 */
export interface RegistryQuality {
  id: string;
  name: string;
}

/** 数据包注册表（source-scripts 的 getSourceRegistry 解析产物） */
export interface SourceRegistry {
  sources: RegistrySource[];
  qualities: RegistryQuality[];
}

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
  /** 锁定 = 禁止拖动 + 鼠标穿透（锁定时窗口对鼠标透明，解锁走主窗口/托盘/快捷键） */
  locked: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 总在最前 */
  alwaysOnTop: boolean;
  /** 字体家族，空串 = 系统默认 */
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  /** 字间距（px） */
  letterSpacing: number;
  /** 行间距（倍数） */
  lineGap: number;
  /** 当前行高亮渐变（两端色） */
  gradient: [string, string];
  /** 非当前行文字颜色（css 颜色串） */
  inactiveColor: string;
  opacity: number;
  stroke: boolean;
  /** 描边宽度（px） */
  strokeWidth: number;
  shadow: boolean;
  /** none / mask（半透明蒙版）/ solid（纯色） */
  backgroundMode: "none" | "mask" | "solid";
  backgroundColor: string;
  backgroundOpacity: number;
  /** 窗口圆角（px） */
  borderRadius: number;
  /** left / center / right */
  align: "left" | "center" | "right";
  /** single / two-lines / three-lines */
  lineMode: "single" | "two-lines" | "three-lines";
}

/** 桌面歌词样式补丁（字段级合并，Rust 侧逐字段校验夹紧） */
export interface DesktopLyricStylePatch {
  fontSize?: number;
  fontWeight?: number;
  fontFamily?: string;
  letterSpacing?: number;
  lineGap?: number;
  opacity?: number;
  backgroundOpacity?: number;
  stroke?: boolean;
  strokeWidth?: number;
  shadow?: boolean;
  alwaysOnTop?: boolean;
  backgroundMode?: "none" | "mask" | "solid";
  backgroundColor?: string;
  borderRadius?: number;
  align?: "left" | "center" | "right";
  lineMode?: "single" | "two-lines" | "three-lines";
  gradient?: [string, string];
  inactiveColor?: string;
}

// ---------- 音效（均衡器 / 响度归一化 / 淡入淡出，对齐 Rust audio::fx） ----------

/** 十段均衡器参数。gainsDb 与十段中心频率一一对应（±12dB） */
export interface EqParams {
  enabled: boolean;
  /** 前置放大（dB）。均衡器开启时引擎自动再叠加 -max(正增益) 防削波 */
  preampDb: number;
  gainsDb: number[];
}

/** 淡入淡出参数：恢复播放淡入 / 暂停淡出 */
export interface FadeParams {
  enabled: boolean;
  /** 单次淡入 / 淡出时长（ms） */
  durationMs: number;
}

/** 当前音效设置（设置页「音效」分区回读） */
export interface FxState {
  eq: EqParams;
  loudnorm: boolean;
  fade: FadeParams;
  /** 播放条频谱背景（引擎侧 FFT 推 spectrum 事件，前端画方块） */
  spectrum: boolean;
}

/** 缓存统计：audio = 播放流缓存，web = 网页缓存（WebView2 封面/脚本等可再生内容） */
export interface AudioCacheStats {
  totalBytes: number;
  fileCount: number;
  webBytes: number;
  webCount: number;
}

/** 播放缓存清理结果 */
export interface AudioCacheClearResult {
  freedBytes: number;
  failedCount: number;
}
