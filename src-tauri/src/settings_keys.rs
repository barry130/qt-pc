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
/// 迷你播放器窗位置（第二波 §3.21.7.2；visible 仅记录、启动一律按不可见恢复）
pub const SETTING_MINI_WINDOW: &str = "mini.window";
/// 自定义快捷键表（动作 ID → { key, enabled }）
pub const SETTING_SHORTCUTS: &str = "shortcuts";
/// 下载文件名格式（artist = 歌手-歌名（默认），song = 歌名-歌手）
pub const SETTING_DOWNLOAD_NAME_FORMAT: &str = "downloadNameFormat";

/// 客户端直连模型的接口配置档列表（JSON 数组：id / name / baseUrl / model / apiKey）。
/// 支持多套地址任选其一；老版本的 `ai.baseUrl` / `ai.model` / `ai.apiKey`
/// 在首次读取时自动迁移成一档，旧键保留不删（回退老版本仍可用）。
pub const SETTING_AI_PROFILES: &str = "ai.profiles";
/// 当前生效的配置档 id（对应 [`SETTING_AI_PROFILES`] 里的一项）
pub const SETTING_AI_ACTIVE_PROFILE: &str = "ai.activeProfile";
/// 老版本的单一接口地址（仅迁移用，新代码不再写）
pub const SETTING_AI_BASE_URL: &str = "ai.baseUrl";
/// 老版本的单一模型名（仅迁移用，新代码不再写）
pub const SETTING_AI_MODEL: &str = "ai.model";
/// 老版本的单一 API Key（仅迁移用，新代码不再写）。**明文存 settings 表**
/// （无 keyring 依赖），设置页有明确提示；前端只能读到「有没有配」，读不到明文。
pub const SETTING_AI_KEY: &str = "ai.apiKey";
/// 每日推荐生成方式：`rule`（纯规则）/ `local`（本地模型精选）/ `server`（走 astral 音乐助手）
pub const SETTING_DAILY_RECOMMEND_MODE: &str = "dailyRecommend.mode";
/// 每日推荐当日缓存（JSON：日期 + 曲目 + 规则版本 + 最近若干天已推荐 key）
pub const SETTING_DAILY_RECOMMEND_CACHE: &str = "dailyRecommend.cache";
/// 每日推荐口味（推荐策略）：`heart` 心动 / `familiar` 常听 / `explore` 探索。
/// 与 [`SETTING_DAILY_RECOMMEND_MODE`] 正交：mode 决定要不要叫模型，taste 决定怎么搜怎么排。
pub const SETTING_DAILY_RECOMMEND_TASTE: &str = "dailyRecommend.taste";
