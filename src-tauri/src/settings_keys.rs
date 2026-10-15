//! settings 表键名的集中出处（仅收录此前散写成裸字面量的键）。
//!
//! 各模块自有的键常量保持在原模块（如 `cache.rs` 的 `SETTING_CACHE_DIR`、
//! `commands.rs` 下载侧的 `SETTING_DOWNLOAD_DIR`、`engine.rs` 的 `SETTING_SPEED`
//! 与 `fx.*`），不在此重复声明。这里只收**此前在多个文件里散写、或被
//! 多个模块共用**的键，把运行期才会暴露的拼写错误提前到编译期。
//!
//! 键名同时是 Rust 与前端之间的隐式契约（前端经 `get_setting` / `set_setting`
//! 泛型命令读写其中部分键）。前端侧对应常量见 `src/lib/storageKeys.ts`，
//! 跨端一致性由 `tests/settings-keys-contract.test.ts` 守护。

/// 外观偏好（§9.2 单对象 JSON：mode / skinId / customColor / followCoverColor / …）
pub const SETTING_APPEARANCE: &str = "appearance";
/// 默认播放音质（128 / 320 / flac）：引擎启动恢复、会话快照、设置页共用
pub const SETTING_QUALITY: &str = "quality";
/// 用户上次选择的输出设备名（空 = 跟随系统默认）
pub const SETTING_OUTPUT_DEVICE: &str = "audio.outputDevice";
/// 会话快照：队列下标
pub const SETTING_QUEUE_INDEX: &str = "queue_index";
/// 会话快照：播放进度（毫秒）
pub const SETTING_POSITION_MS: &str = "position_ms";
/// 会话快照：播放模式（singleCycle / listLoop / …）
pub const SETTING_PLAY_MODE: &str = "play_mode";
/// 会话快照：音量（0.0–1.0 的字符串形式）
pub const SETTING_VOLUME: &str = "volume";
/// 会话快照：静音标记（"1" / "0"）
pub const SETTING_MUTED: &str = "muted";
/// 收藏同步游标（云端变更序号；前端 auth.ts 以字面量读写同名键）
pub const SETTING_LIKE_SYNC_SEQ: &str = "like.sync.seq";
/// 收藏是否已做过全量导入（与游标分开记）
pub const SETTING_LIKE_IMPORTED: &str = "like.imported";
/// 桌面歌词窗位置与样式（§10，不与主窗口状态混存）
pub const SETTING_LYRIC_WINDOW: &str = "lyric.window";
/// 自定义快捷键表（动作 ID → { key, enabled }）
pub const SETTING_SHORTCUTS: &str = "shortcuts";
/// 下载文件名格式（artist = 歌手-歌名（默认），song = 歌名-歌手）
pub const SETTING_DOWNLOAD_NAME_FORMAT: &str = "downloadNameFormat";
