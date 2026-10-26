/**
 * 本地设置（`ipc.getSetting/setSetting`）里用到的键名集中在这里。
 *
 * 为什么单独一个模块：键名原本散落在各页面里，且 `AppShell` 为了判断"是否走过首次
 * 引导"静态 import 了 `OnboardingPage` —— 于是整页引导流程（含全部图标与文案）被绑进
 * 主 chunk，页面懒加载也就失效了。键名是纯字符串常量，抽出来两边共用即可解耦。
 */

/** 是否已完成首次启动引导（onboarding） */
export const ONBOARDING_KEY = "onboarded";

/** 应用级最近一次未捕获错误（ErrorBoundary 落盘，便于事后排查闪退/白屏） */
export const LAST_ERROR_KEY = "app.lastError";

/** 默认播放音质（与 Rust settings_keys.rs 的 SETTING_QUALITY 同值，契约见 tests/settings-keys-contract.test.ts） */
export const QUALITY_KEY = "quality";

/**
 * 默认下载音质（settings 表 downloadQuality，ipc.ts 同名私有常量同值）。
 * 2026-10-25 起下载音质按平台独立（lib/source-quality.ts 的
 * `download.sourceQualities`）；本键仅作存量迁移回落，不再有设置入口。
 */
export const DOWNLOAD_QUALITY_KEY = "downloadQuality";

/** 音频缓存上限 MB（与 Rust cache.rs 的 SETTING_AUDIO_CACHE_LIMIT_MB 同值，契约见 tests/settings-keys-contract.test.ts） */
export const CACHE_AUDIO_LIMIT_MB_KEY = "cache.audioLimitMb";

/** 无缝播放（Rust audio/engine.rs SETTING_GAPLESS；"true" / "false"） */
export const GAPLESS_KEY = "playback.gapless";

/**
 * 首次启动免责声明的接受时刻（ISO 字符串）。
 * 缺失或空串 = 还没接受过 → 装完第一次启动弹一次，读完 3 秒才能确认。
 * 存在 SQLite settings 表里：卸载重装 = 新库 = 重新弹一次，这正是「安装后首次」的语义。
 */
export const DISCLAIMER_KEY = "disclaimer.acceptedAt";

/**
 * 客户端直连模型的接口配置档列表（Rust SETTING_AI_PROFILES 同值）。
 *
 * 支持多套接口地址任选其一：整份是 JSON 数组，每项含 id / name / baseUrl /
 * model / apiKey。读写都走 `ipc.aiLocalConfig()` / `ipc.aiLocalSaveConfig()`，
 * 前端拿不到 Key 明文（只回 `hasKey`），这里保留常量是为了两端键名可对照。
 */
export const AI_PROFILES_KEY = "ai.profiles";

/** 当前生效的配置档 id（Rust SETTING_AI_ACTIVE_PROFILE 同值） */
export const AI_ACTIVE_PROFILE_KEY = "ai.activeProfile";

/** 老版本的单一接口地址（Rust SETTING_AI_BASE_URL 同值；仅迁移用，新代码不写） */
export const AI_BASE_URL_KEY = "ai.baseUrl";

/** 老版本的单一模型名（Rust SETTING_AI_MODEL 同值；仅迁移用，新代码不写） */
export const AI_MODEL_KEY = "ai.model";

/** 老版本的单一 API Key（Rust SETTING_AI_KEY 同值；仅迁移用，前端不读明文） */
export const AI_API_KEY_KEY = "ai.apiKey";

/** 每日推荐生成方式：`rule` 纯规则 / `local` 本地模型精选 / `server` 走 astral 音乐助手 */
export const DAILY_RECOMMEND_MODE_KEY = "dailyRecommend.mode";

/** 每日推荐当日缓存（JSON：日期 + 曲目 + 规则版本 + 最近若干天已推荐 key） */
export const DAILY_RECOMMEND_CACHE_KEY = "dailyRecommend.cache";

/** 每日推荐口味：`heart` 心动 / `familiar` 常听 / `explore` 探索（缺省 heart） */
export const DAILY_RECOMMEND_TASTE_KEY = "dailyRecommend.taste";

/**
 * 每日推荐的**风格种子**（JSON 字符串数组，如 `["华语","摇滚"]`）。
 *
 * 冷启动用：新用户（没有播放历史、没有收藏）在推荐页面上点几个风格，就把这些风格名
 * 存下来当作初始画像。存名字不存平台分类 id —— id 随音源和平台版本变，名字是用户
 * 自己看得懂的、也是跨音源唯一稳定的东西。
 */
export const DAILY_RECOMMEND_SEEDS_KEY = "dailyRecommend.styleSeeds";

/**
 * 聚合搜索只用哪些音源（JSON 字符串数组，如 `["wyy","qq"]`；缺省 = 全部）。
 *
 * 只影响「聚合」类搜索：搜索页「全部音源」分组、AI 找歌、手动换源、每日推荐的跨源
 * 补充。单源搜索（搜索页某个源的页签、榜单、歌单、歌手页）永远用用户当前选的那个源，
 * 不受这里影响。存 id 不存名字：名字是数据包里下发的展示文案，宿主不该拿它做判断。
 * 空数组会被当成「没配置」→ 全部音源（让「一个都没选」永远不会变成「搜不到任何东西」）。
 */
export const AGGREGATE_SOURCES_KEY = "search.aggregateSources";

/**
 * 音源账号登录（v9 数据包）：各源已登录账号的凭据（JSON，含 Cookie 与用户
 * 展示信息）。键只有前端读写（Rust 侧是透传 KV），不进跨端契约测试。
 * 凭据只存在本机设置库里，注入给数据包的是引擎内存工作副本。
 */
export const SOURCE_AUTH_ACCOUNTS_KEY = "sourceAuth.accounts";

/**
 * 「是否使用登录态」开关（JSON：source → { useMeta, usePlay }），**按音源独立**：
 * 数据面（meta）与播放面（play）每源各一对。源未物化时的解析优先级见
 * lib/source-auth.ts（per-source 表 → 旧全局键 → 双开）。
 */
export const SOURCE_AUTH_TOGGLES_KEY = "sourceAuth.toggles";

/**
 * 旧版全局开关（"true"/"false"）——per-source 表上线前所有源共用一对。
 * 现在只作为未物化源的**一次性继承源**读取，不再写入；保留键定义是为了
 * 旧用户升级后已调过的全局选择不至于回跳。
 */
export const SOURCE_AUTH_USE_META_KEY = "sourceAuth.useMeta";

/** 同上（play 面旧全局键） */
export const SOURCE_AUTH_USE_PLAY_KEY = "sourceAuth.usePlay";
