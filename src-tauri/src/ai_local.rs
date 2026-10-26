//! 客户端直连「OpenAI 兼容」大模型（每日推荐 AI 精选用）。
//!
//! 为什么不走前端 `fetch`：
//! 1. WebView 里直接请求第三方地址会被 CORS 拦（模型服务商基本不回 `Access-Control-Allow-Origin`）；
//! 2. API Key 会落到前端 JS 作用域与 DevTools 网络面板里，等于半公开。
//! 所以模型调用统一走这里，Key 只存在 settings 表、只在本模块内读出使用，
//! 前端拿到的永远是 `hasKey` 布尔值 / 掩码，拿不到明文。
//!
//! 为什么不复用音源脚本的 `builtin_request`：`net_guard::is_public_host`
//! 会拒绝 `127.0.0.1` / `localhost` / 内网地址（防第三方音源脚本把本机当跳板）。
//! 而本功能的典型用户正是本机跑 Ollama / LM Studio（`http://localhost:11434`），
//! 复用那条通道会直接把本地模型挡死。这里改为「只信任用户在设置里手填的地址」：
//! 地址来源是用户本人、不是第三方脚本，风险面完全不同，因此不做公网校验；
//! 但协议、主机、凭据这些基础准入仍然沿用 [`crate::net_guard::ensure_http_url`]。
//!
//! **支持多套接口配置**（用户 m01818 要求「多个接口地址任选其一」）：
//! 配置以「配置档」列表存一份 JSON（[`SETTING_AI_PROFILES`]），另存当前生效档 id。
//! 每档自带 地址 / 模型 / Key，互不干扰；切换档不需要重新填 Key。
//! 老版本只有一组 `ai.baseUrl` / `ai.model` / `ai.apiKey`，首次读取时自动迁移成一档。
//!
//! **按协议真发请求**（供应商详情页可切换「协议类型」）：
//! `protocol` 决定端点、鉴权头、请求体与响应解析，见 [`Protocol`]、
//! [`build_chat_call`] 与 [`extract_reply_by`]。支持 `openai`（默认，老配置没有
//! 这个字段就落到它）/ `openai-responses` / `anthropic` / `gemini`，
//! 不认识的值在被读取时一律按 `openai` 兜底。之所以要按协议分派而不是只存字段：
//! 四家的鉴权方式（`Authorization: Bearer` / `x-api-key` / `?key=`）与响应结构
//! 完全不同，只存字段等于配了也用不了。
//!
//! **多把 Key**（详情页可存多把、切换使用中）：`keys[0]` 是当前使用中的 Key，
//! `api_key` 是它的快照（chat 只认它，保证老代码与老配置继续可用）。
//! 读取老配置（只有 `api_key`）时自动迁移进 `keys`；保存时由 `keys[0]` 同步回去。
//! 前端只能拿到掩码（[`mask_key`]），拿不到明文。
//!
//! **跳过证书校验**：自签名 / 局域网网关需要，只在用户显式打开时才
//! `tls_danger_accept_invalid_certs(true)`，默认仍然校验证书。
//!
//! 对话历史与提示词组装全在客户端 TS 侧（`src/lib/daily-recommend.ts`），
//! 这里只做「把 messages 发出去、把 content 取回来」的薄管道。

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Deserializer, Serialize};
use tauri::State;

use crate::AppState;

/// 默认接口地址（多数 OpenAI 兼容服务的根）
const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
/// 默认模型名（留空则回落到这个；用户可以随便改）
const DEFAULT_MODEL: &str = "gpt-4o-mini";
/// 老版本只有一组配置时，迁移出来的档名
const DEFAULT_PROFILE_NAME: &str = "默认";
/// 单次生成的总超时：本机小模型冷启动 + 长上下文可能很慢，给足 120s。
const CHAT_TIMEOUT_SECS: u64 = 120;
/// 试连只发一句极短的话，超时也短。
const TEST_TIMEOUT_SECS: u64 = 30;
/// 拉模型列表（`GET /v1/models`）很快，给 20s 足够。
const LIST_TIMEOUT_SECS: u64 = 20;

/// 协议类型（存盘 JSON 里的字符串值，见 [`Protocol`]）。
const PROTOCOL_OPENAI: &str = "openai";
/// OpenAI Responses 协议（`/v1/responses`，请求/响应结构是另一套）
const PROTOCOL_OPENAI_RESPONSES: &str = "openai-responses";
/// Anthropic Messages 协议（`x-api-key` + `anthropic-version`）
const PROTOCOL_ANTHROPIC: &str = "anthropic";
/// Google Gemini 协议（`/v1beta/models/{model}:generateContent`，Key 走 query）
const PROTOCOL_GEMINI: &str = "gemini";
/// 缺省协议：老配置根本没有 `protocol` 字段，一律按 OpenAI 兼容处理
const DEFAULT_PROTOCOL: &str = PROTOCOL_OPENAI;
/// Anthropic 必填的版本头（不传直接 400）
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Anthropic 必填的 `max_tokens`（不传直接 400）
const ANTHROPIC_MAX_TOKENS: u32 = 4096;

/// 协议类型：决定端点、鉴权头、请求体与响应解析。
///
/// 存盘用字符串（要跨版本兼容、未知值按 openai 兜底），分支处用枚举
/// （穷尽匹配，将来加协议时编译器会提醒每处都要处理）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Protocol {
    OpenAi,
    OpenAiResponses,
    Anthropic,
    Gemini,
}

impl Protocol {
    /// 读配置里的字符串；不认识的一律按 `openai` 兜底（老配置没有这个字段）。
    fn parse(raw: &str) -> Self {
        match raw.trim() {
            PROTOCOL_OPENAI_RESPONSES => Self::OpenAiResponses,
            PROTOCOL_ANTHROPIC => Self::Anthropic,
            PROTOCOL_GEMINI => Self::Gemini,
            _ => Self::OpenAi,
        }
    }

    /// 回写进配置 / 视图的标准值（前端拿到的永远是四种之一）。
    fn as_str(self) -> &'static str {
        match self {
            Self::OpenAi => PROTOCOL_OPENAI,
            Self::OpenAiResponses => PROTOCOL_OPENAI_RESPONSES,
            Self::Anthropic => PROTOCOL_ANTHROPIC,
            Self::Gemini => PROTOCOL_GEMINI,
        }
    }
}

/// 落库 / 出参前统一协议字符串（不合法值按 `openai` 兜底）。
fn normalize_protocol(raw: &str) -> String {
    Protocol::parse(raw).as_str().to_string()
}

/// 允许 `null` 的字符串字段反序列化：前端「图标」等字段可能传 null 表示「没有」，
/// 直接按 `String` 解析会让整份配置反序列化失败（Tauri 侧表现为 invalid args）。
fn de_string_or_null<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<String>::deserialize(deserializer)?.unwrap_or_default())
}

/// 一套接口配置（存进 settings 表的 JSON 里，含 Key 明文）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProfile {
    pub id: String,
    /// 展示名；留空则由前端用地址里的主机名顶上
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    /// 生效 Key（= `keys[0]` 的快照，chat 只读它；老配置里它就是唯一的 Key）。
    /// 保留这个字段是为了「老配置 / 老调用方」零改动，读写时与 `keys` 同步。
    #[serde(default)]
    pub api_key: String,
    /// 协议类型（见 [`Protocol`]）；老配置没有这个字段 → `openai`
    #[serde(default, deserialize_with = "de_string_or_null")]
    pub protocol: String,
    /// 多把 Key，**第一把是使用中的**；保存时由 `keys[0]` 同步 `api_key`
    #[serde(default)]
    pub keys: Vec<String>,
    /// 详情页「仅所选」里勾选的模型（展示用，可为空；`models[0]` 是当前模型）
    #[serde(default)]
    pub models: Vec<String>,
    /// 内置图标标识（如 `sparkles`，也允许 data URL），空 = 前端用首字母方块
    #[serde(default, deserialize_with = "de_string_or_null")]
    pub icon: String,
    /// 跳过 TLS 证书校验（自签名 / 局域网网关；只在用户显式打开时生效）
    #[serde(default)]
    pub skip_cert_verify: bool,
}

/// 前端提交的一套配置。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProfileInput {
    /// 空串 = 新档，由这里生成 id
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    /// 旧字段：None = 沿用已存的 Key；Some("") = 清空；Some(k) = 覆盖。
    /// 新 UI 只传 `keys` / 局部编辑字段时不看它。
    #[serde(default)]
    pub api_key: Option<String>,
    /// 空串 = 沿用已存档的协议；不合法值按 `openai` 兜底
    #[serde(default, deserialize_with = "de_string_or_null")]
    pub protocol: String,
    /// None = **不改动已存 Key 列表**（设置页「留空保存」）；
    /// Some(vec) = 整份覆盖，空数组 = 清空所有 Key（优先级高于下面三个局部编辑字段）
    #[serde(default)]
    pub keys: Option<Vec<String>>,
    /// 追加到已存 Key 列表末尾（前端拿不到旧明文，只能这样「添加一把」）
    #[serde(default)]
    pub add_keys: Vec<String>,
    /// 按下标（对当前已存列表）删除 Key
    #[serde(default)]
    pub remove_key_indexes: Vec<usize>,
    /// 把「应用增删后」的第 i 把 Key 移到最前（= 设为使用中）
    #[serde(default)]
    pub active_key_index: Option<usize>,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default, deserialize_with = "de_string_or_null")]
    pub icon: String,
    #[serde(default)]
    pub skip_cert_verify: bool,
}

/// 前端可见的一套配置：**永远不含 Key 明文**。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProfileView {
    pub id: String,
    pub name: String,
    pub base_url: String,
    /// 已兜底为合法值（四种之一）
    pub protocol: String,
    pub model: String,
    pub models: Vec<String>,
    pub has_key: bool,
    /// 每把 Key 的掩码（[`mask_key`]），第一项对应「使用中」的 Key
    pub key_masks: Vec<String>,
    /// 等价于 `key_masks[0]`；列表行只显示它，没有 Key 时为 `""`
    pub key_mask: String,
    pub icon: String,
    pub skip_cert_verify: bool,
}

/// 设置页展示用的整体视图：所有配置档 + 当前生效档。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiLocalConfigView {
    pub profiles: Vec<AiProfileView>,
    pub active_id: String,
}

/// 前端发来的一条对话消息（OpenAI 兼容格式）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiLocalMessage {
    pub role: String,
    pub content: String,
}

/// 生成结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiLocalReply {
    pub content: String,
    /// 服务端回传的实际模型名（部分网关会改写，落日志便于排查）
    pub model: String,
    pub elapsed_ms: u128,
    /// token 用量（服务商不给就是 None）
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
}

/// 试连结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiLocalTestResult {
    pub ok: bool,
    pub status: Option<u16>,
    pub elapsed_ms: u128,
    /// 模型回的第一句话（截断），用于让用户确认「真的通了」而不只是 200
    pub reply: Option<String>,
    pub error: Option<String>,
}

// ---------- 配置读写 ----------

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 新档 id：`p` + 毫秒时间戳。前端也会自己生成，这里只是兜底。
fn new_profile_id() -> String {
    format!("p{}", now_ms())
}

fn default_profile() -> AiProfile {
    AiProfile {
        id: new_profile_id(),
        name: DEFAULT_PROFILE_NAME.to_string(),
        base_url: DEFAULT_BASE_URL.to_string(),
        model: DEFAULT_MODEL.to_string(),
        api_key: String::new(),
        protocol: DEFAULT_PROTOCOL.to_string(),
        keys: Vec::new(),
        models: Vec::new(),
        icon: String::new(),
        skip_cert_verify: false,
    }
}

/// 从地址里取主机名当展示名（`https://api.openai.com/v1` → `api.openai.com`）。
fn host_of(base_url: &str) -> String {
    let trimmed = base_url.trim();
    let after_scheme = trimmed.split("://").nth(1).unwrap_or(trimmed);
    let host = after_scheme.split('/').next().unwrap_or(after_scheme);
    if host.is_empty() {
        DEFAULT_PROFILE_NAME.to_string()
    } else {
        host.to_string()
    }
}

/// 列表清洗：去首尾空白、丢空串、按原顺序去重（Key 与模型列表都用它）。
fn normalize_list(items: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let item = item.trim().to_string();
        if !item.is_empty() && !out.contains(&item) {
            out.push(item);
        }
    }
    out
}

/// Key 掩码：`"••••••" + 最后 2 个字符`（够用户认出「是哪把」，又不足以复原）。
///
/// Key 长度 ≤ 4 时整串给 `"••••"`：再露出尾巴 2 位就占了一半，等于半明文。
fn mask_key(key: &str) -> String {
    let key = key.trim();
    if key.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = key.chars().collect();
    if chars.len() <= 4 {
        return "••••".to_string();
    }
    let tail: String = chars[chars.len() - 2..].iter().collect();
    format!("••••••{tail}")
}

/// 应用「局部编辑」得到新的 Key 列表（前端拿不到旧明文，删/加/置顶只能靠下标）。
///
/// 顺序：先按旧列表下标删 → 再追加 → 最后置顶。置顶用「增删之后」的下标，
/// 与前端提交时看到的列表一致（前端定义的下标语义）。
fn edit_keys(
    mut keys: Vec<String>,
    remove_indexes: &[usize],
    add_keys: &[String],
    active_index: Option<usize>,
) -> Vec<String> {
    // 倒序删除，避免删前面的元素后后面的下标错位
    let mut drop: Vec<usize> = remove_indexes
        .iter()
        .copied()
        .filter(|index| *index < keys.len())
        .collect();
    drop.sort_unstable();
    drop.dedup();
    for index in drop.into_iter().rev() {
        keys.remove(index);
    }
    for key in add_keys {
        let key = key.trim();
        if !key.is_empty() && !keys.iter().any(|k| k.as_str() == key) {
            keys.push(key.to_string());
        }
    }
    if let Some(index) = active_index {
        if index < keys.len() {
            let key = keys.remove(index);
            keys.insert(0, key);
        }
    }
    keys
}

/// 读盘后 / 落库前的统一规整：协议兜底 + Key 迁移 + 列表清洗。
///
/// 老配置（多档功能之前）只有 `api_key`：这里把它塞进 `keys`，即「读取时迁移」。
/// `api_key` 始终同步成 `keys[0]`，避免出现「改过 keys 但 chat 还在用旧 api_key」。
fn normalize_profile(mut profile: AiProfile) -> AiProfile {
    profile.protocol = normalize_protocol(&profile.protocol);
    let mut keys = normalize_list(profile.keys.clone());
    if keys.is_empty() && !profile.api_key.trim().is_empty() {
        keys.push(profile.api_key.trim().to_string());
    }
    profile.api_key = keys.first().cloned().unwrap_or_default();
    profile.keys = keys;
    profile.models = normalize_list(profile.models.clone());
    profile.icon = profile.icon.trim().to_string();
    profile
}

/// 读全部配置档与当前档 id。库里什么都没有时给一份默认档。
fn load_profiles(state: &State<'_, AppState>) -> Result<(Vec<AiProfile>, String), String> {
    let Some(db) = state.db.clone() else {
        let profile = default_profile();
        return Ok((vec![profile.clone()], profile.id));
    };
    let (raw, active, legacy_base, legacy_model, legacy_key) = db.with(|conn| {
        Ok((
            crate::db::store::get_setting(conn, crate::settings_keys::SETTING_AI_PROFILES)?
                .unwrap_or_default(),
            crate::db::store::get_setting(conn, crate::settings_keys::SETTING_AI_ACTIVE_PROFILE)?
                .unwrap_or_default(),
            crate::db::store::get_setting(conn, crate::settings_keys::SETTING_AI_BASE_URL)?
                .unwrap_or_default(),
            crate::db::store::get_setting(conn, crate::settings_keys::SETTING_AI_MODEL)?
                .unwrap_or_default(),
            crate::db::store::get_setting(conn, crate::settings_keys::SETTING_AI_KEY)?
                .unwrap_or_default(),
        ))
    })?;

    let mut profiles: Vec<AiProfile> = if raw.trim().is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(&raw).unwrap_or_default()
    };
    profiles.retain(|p| !p.id.trim().is_empty());
    if profiles.is_empty() {
        // 老版本只有一组配置，迁移成一档（旧键保留不删，回退老版本时还能用）
        profiles.push(AiProfile {
            id: new_profile_id(),
            name: if legacy_base.trim().is_empty() {
                DEFAULT_PROFILE_NAME.to_string()
            } else {
                host_of(&legacy_base)
            },
            base_url: legacy_base,
            model: legacy_model,
            api_key: legacy_key,
            protocol: DEFAULT_PROTOCOL.to_string(),
            keys: Vec::new(),
            models: Vec::new(),
            icon: String::new(),
            skip_cert_verify: false,
        });
    }
    // 读盘即迁移：补协议缺省、把老配置的 api_key 塞进 keys（见 `normalize_profile`）
    let profiles: Vec<AiProfile> = profiles.into_iter().map(normalize_profile).collect();
    let active_id = if profiles.iter().any(|p| p.id == active) {
        active
    } else {
        profiles[0].id.clone()
    };
    Ok((profiles, active_id))
}

/// 整份写回（配置档是整体结构，改一档就整体覆盖）。
fn save_profiles(
    state: &State<'_, AppState>,
    profiles: &[AiProfile],
    active_id: &str,
) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    let json = serde_json::to_string(profiles).map_err(|e| format!("序列化 AI 配置失败：{e}"))?;
    db.with(|conn| {
        crate::db::store::set_setting(
            conn,
            crate::settings_keys::SETTING_AI_PROFILES,
            json.as_str(),
        )?;
        crate::db::store::set_setting(
            conn,
            crate::settings_keys::SETTING_AI_ACTIVE_PROFILE,
            active_id,
        )?;
        Ok(())
    })
}

/// 当前生效的那一档（地址/模型/Key/协议都从这里取）。
fn active_profile(state: &State<'_, AppState>) -> Result<AiProfile, String> {
    let (profiles, active_id) = load_profiles(state)?;
    Ok(profiles
        .into_iter()
        .find(|p| p.id == active_id)
        .unwrap_or_else(default_profile))
}

/// 内部结构 → 前端视图（抹掉 Key，只给掩码；空地址/模型回落默认值）。
fn view_of(profiles: &[AiProfile], active_id: &str) -> AiLocalConfigView {
    AiLocalConfigView {
        profiles: profiles
            .iter()
            .map(|p| {
                let key_masks: Vec<String> = p.keys.iter().map(|k| mask_key(k)).collect();
                let key_mask = key_masks.first().cloned().unwrap_or_default();
                AiProfileView {
                    id: p.id.clone(),
                    name: if p.name.trim().is_empty() {
                        host_of(&p.base_url)
                    } else {
                        p.name.clone()
                    },
                    base_url: if p.base_url.trim().is_empty() {
                        DEFAULT_BASE_URL.to_string()
                    } else {
                        p.base_url.clone()
                    },
                    protocol: normalize_protocol(&p.protocol),
                    model: if p.model.trim().is_empty() {
                        DEFAULT_MODEL.to_string()
                    } else {
                        p.model.clone()
                    },
                    models: p.models.clone(),
                    has_key: !key_masks.is_empty(),
                    key_masks,
                    key_mask,
                    icon: p.icon.trim().to_string(),
                    skip_cert_verify: p.skip_cert_verify,
                }
            })
            .collect(),
        active_id: active_id.to_string(),
    }
}

// ---------- 地址归一 ----------

/// 把用户填的地址归一成「根地址（含可选路径前缀）」，供各协议再拼自己的端点。
///
/// 用户可能填四种形态：根域名 `https://api.openai.com`、带版本段
/// `https://api.openai.com/v1`、自建网关的完整端点
/// `https://x/openai/v1/chat/completions`，甚至把 Gemini 的
/// `…/v1beta/models/gemini-2.0-flash:generateContent?key=…` 整段粘进来。
/// 这里统一**剥掉**端点尾巴、查询串与版本段，版本段由各协议自己按需补，
/// 于是四种形态都能落到同一个请求地址上（老配置里的 `/v1` 地址行为不变）。
fn base_root(base_url: &str) -> Result<String, String> {
    let url = crate::net_guard::ensure_http_url(base_url.trim())
        .map_err(|e| format!("地址不是合法 http(s) URL：{e}"))?;
    let raw = url.as_str();
    // 粘进来的完整端点可能带 `?key=…`，查询串 / 锚点一律丢掉
    let mut root = raw
        .split(['?', '#'])
        .next()
        .unwrap_or(raw)
        .trim_end_matches('/')
        .to_string();
    // 常见端点尾巴（OpenAI 兼容的三种写法）
    for suffix in ["/chat/completions", "/responses", "/messages", "/models"] {
        if let Some(head) = root.strip_suffix(suffix) {
            root = head.trim_end_matches('/').to_string();
            break;
        }
    }
    // Gemini 的端点尾巴是「动作段 + 模型段」：`/models/<model>:generateContent`
    let mut had_action = false;
    for marker in [":streamGenerateContent", ":generateContent"] {
        if let Some(index) = root.rfind(marker) {
            root.truncate(index);
            had_action = true;
            break;
        }
    }
    if had_action {
        if let Some(index) = root.rfind("/models/") {
            root.truncate(index);
        }
    }
    // 版本段交给各协议补：`/v1`（OpenAI / Anthropic）、`/v1beta`（Gemini）
    for version in ["/v1", "/v1beta"] {
        if let Some(head) = root.strip_suffix(version) {
            root = head.trim_end_matches('/').to_string();
            break;
        }
    }
    Ok(root)
}

/// 各协议对应的 chat 端点。
///
/// - `openai`：`{root}/v1/chat/completions`
/// - `openai-responses`：`{root}/v1/responses`
/// - `anthropic`：`{root}/v1/messages`
/// - `gemini`：`{root}/v1beta/models/{model}:generateContent?key=<key>`
///   （Gemini 的 Key 走 query，不是 header；Google 的 Key 只含 URL 安全字符，不再编码）
fn chat_endpoint(
    protocol: Protocol,
    base_url: &str,
    model: &str,
    api_key: &str,
) -> Result<String, String> {
    let root = base_root(base_url)?;
    Ok(match protocol {
        Protocol::OpenAi => format!("{root}/v1/chat/completions"),
        Protocol::OpenAiResponses => format!("{root}/v1/responses"),
        Protocol::Anthropic => format!("{root}/v1/messages"),
        Protocol::Gemini => {
            let mut url = format!(
                "{root}/v1beta/models/{}:generateContent",
                gemini_model_path(model)
            );
            let key = api_key.trim();
            if !key.is_empty() {
                url.push_str("?key=");
                url.push_str(key);
            }
            url
        }
    })
}

/// 各协议的模型列表端点：Gemini 是 `/v1beta/models?key=`，其余都是 `/v1/models`。
fn models_endpoint(protocol: Protocol, base_url: &str, api_key: &str) -> Result<String, String> {
    let root = base_root(base_url)?;
    Ok(match protocol {
        Protocol::Gemini => {
            let mut url = format!("{root}/v1beta/models");
            let key = api_key.trim();
            if !key.is_empty() {
                url.push_str("?key=");
                url.push_str(key);
            }
            url
        }
        _ => format!("{root}/v1/models"),
    })
}

/// Gemini 的模型名允许带 `models/` 前缀（它自己的列表接口就是这么回的），
/// 拼进 URL 前统一去掉，用户手填带前缀也能用。
fn gemini_model_path(model: &str) -> &str {
    let model = model.trim();
    model.strip_prefix("models/").unwrap_or(model)
}

// ---------- 请求体 / 请求材料 ----------

/// 一次生成请求的全部材料：协议 + 端点 + 请求体。
///
/// 提前拼好是为了让重试循环里每次重发的是**一模一样的请求**，
/// 也免得每个协议在「构建 / 发送 / 解析」三处各拼一遍。
struct ChatCall {
    protocol: Protocol,
    endpoint: String,
    body: serde_json::Value,
}

/// 按协议拼出「端点 + 请求体」—— 这就是「协议化请求」的入口。
fn build_chat_call(
    protocol: Protocol,
    base_url: &str,
    model: &str,
    api_key: &str,
    messages: &[AiLocalMessage],
    temperature: f64,
) -> Result<ChatCall, String> {
    let model = model.trim();
    if model.is_empty() {
        return Err("模型名不能为空：请先在设置里选择或填写模型".to_string());
    }
    let endpoint = chat_endpoint(protocol, base_url, model, api_key)?;
    let body = build_chat_body(protocol, model, messages, temperature);
    Ok(ChatCall {
        protocol,
        endpoint,
        body,
    })
}

/// 按协议拼请求体（四家的字段名 / 嵌套结构都不一样）。
fn build_chat_body(
    protocol: Protocol,
    model: &str,
    messages: &[AiLocalMessage],
    temperature: f64,
) -> serde_json::Value {
    match protocol {
        // OpenAI 兼容：老路径，请求体保持原样
        // （`stream:false` 必带，中继靠它决定是否回 SSE）
        Protocol::OpenAi => serde_json::json!({
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "stream": false,
        }),
        // Responses API：input 每项都要包成 content 数组，文本项 type 用 input_text
        Protocol::OpenAiResponses => {
            let input: Vec<serde_json::Value> = messages
                .iter()
                .map(|m| {
                    serde_json::json!({
                        "role": m.role,
                        "content": [{ "type": "input_text", "text": m.content }],
                    })
                })
                .collect();
            serde_json::json!({
                "model": model,
                "input": input,
                "temperature": temperature,
            })
        }
        // Anthropic：system 必须是独立字段，messages 里只放 user/assistant
        Protocol::Anthropic => {
            let (system, dialog) = split_system(messages);
            let dialog: Vec<serde_json::Value> = dialog
                .iter()
                .map(|m| {
                    serde_json::json!({
                        "role": if m.role == "assistant" { "assistant" } else { "user" },
                        "content": m.content,
                    })
                })
                .collect();
            let mut body = serde_json::json!({
                "model": model,
                "max_tokens": ANTHROPIC_MAX_TOKENS,
                "messages": dialog,
                "temperature": temperature,
            });
            if !system.is_empty() {
                body["system"] = serde_json::Value::String(system);
            }
            body
        }
        // Gemini：contents 的角色只有 user/model，system 走 systemInstruction
        Protocol::Gemini => {
            let (system, dialog) = split_system(messages);
            // 连续同角色要合并成一个 content 的多个 parts：Gemini 要求多轮对话
            // user/model 交替，一条条平铺会被「messages must alternate」拒掉
            let mut merged: Vec<(&str, Vec<serde_json::Value>)> = Vec::new();
            for message in &dialog {
                let role = if message.role == "assistant" {
                    "model"
                } else {
                    "user"
                };
                let part = serde_json::json!({ "text": message.content });
                match merged.last_mut() {
                    Some((last_role, parts)) if *last_role == role => parts.push(part),
                    _ => merged.push((role, vec![part])),
                }
            }
            let contents: Vec<serde_json::Value> = merged
                .into_iter()
                .map(|(role, parts)| serde_json::json!({ "role": role, "parts": parts }))
                .collect();
            let mut body = serde_json::json!({
                "contents": contents,
                "generationConfig": { "temperature": temperature },
            });
            if !system.is_empty() {
                body["systemInstruction"] = serde_json::json!({ "parts": [{ "text": system }] });
            }
            body
        }
    }
}

/// 把 system 消息从对话里摘出来（Anthropic / Gemini 的 system 是独立字段，
/// 混在 messages/contents 里会被服务端按「非法角色」拒掉）。
fn split_system(messages: &[AiLocalMessage]) -> (String, Vec<&AiLocalMessage>) {
    let mut system = String::new();
    let mut dialog: Vec<&AiLocalMessage> = Vec::new();
    for message in messages {
        if message.role.trim() == "system" {
            let text = message.content.trim();
            if text.is_empty() {
                continue;
            }
            if !system.is_empty() {
                system.push_str("\n\n");
            }
            system.push_str(text);
        } else {
            dialog.push(message);
        }
    }
    (system, dialog)
}

// ---------- HTTP 客户端 ----------

/// 构建请求客户端：代理跟随全局「网络」页（与音源/后端同一个出口）。
///
/// `skip_cert_verify` 只在用户显式打开时关掉证书校验 —— 自签名证书 / 局域网
/// 网关是正当用法，但默认绝不能松（松了等于给中间人开门）。
fn build_client(timeout_secs: u64, skip_cert_verify: bool) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent("quietmusic-pc")
        .timeout(Duration::from_secs(timeout_secs));
    if skip_cert_verify {
        // reqwest 0.13 起不带 tls_ 前缀的那个名字已废弃，用新名
        builder = builder.tls_danger_accept_invalid_certs(true);
    }
    crate::net_config::configure(builder)
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败：{e}"))
}

// ---------- 命令 ----------

/// 读取配置（不含 Key 明文，只给掩码）
#[tauri::command(rename = "ai_local_config")]
pub async fn cmd_ai_local_config(state: State<'_, AppState>) -> Result<AiLocalConfigView, String> {
    let (profiles, active_id) = load_profiles(&state)?;
    Ok(view_of(&profiles, &active_id))
}

/// 整体保存配置档列表 + 当前档。
///
/// 每档的 Key 语义（优先级从高到低）：
/// 1. `keys` 传了 Some → **整份覆盖**（空数组 = 清空所有 Key），其余 Key 字段忽略；
/// 2. 否则在「已存 Key 列表」上做局部编辑：`removeKeyIndexes` 删 →
///    `addKeys` 追加 → `activeKeyIndex` 置顶（前端拿不到旧明文，只能这样增删/切换）；
/// 3. 一个 Key 字段都没传时，保留旧字段 `apiKey` 的老语义：
///    None = 沿用、Some("") = 清空、Some(k) = 覆盖成唯一一把。
/// 落库时 `apiKey` 一律同步成 `keys[0]`（第一把 = 使用中），视图只回掩码。
///
/// `protocol` 空串表示「沿用已存档的协议」（老调用方没有这个字段），
/// 不合法值按 `openai` 兜底；`model` 兼容旧字段：`models` 非空时以
/// `models[0]` 为准（前端详情页第一枚 chip 就是当前模型）。
#[tauri::command(rename = "ai_local_save_config")]
pub async fn cmd_ai_local_save_config(
    state: State<'_, AppState>,
    profiles: Vec<AiProfileInput>,
    active_id: String,
) -> Result<AiLocalConfigView, String> {
    let (existing, _) = load_profiles(&state)?;
    let mut next: Vec<AiProfile> = Vec::with_capacity(profiles.len());
    for input in profiles {
        // 地址非空就必须能归一，避免存进一份永远调不通的配置
        let base_url = input.base_url.trim().to_string();
        if !base_url.is_empty() {
            base_root(&base_url)?;
        }
        let old = existing.iter().find(|p| p.id == input.id);
        // 协议：空串（老调用方没传）沿用已存档的协议，不认识的值按 openai 兜底
        let protocol = if input.protocol.trim().is_empty() {
            old.map(|p| p.protocol.clone())
                .unwrap_or_else(|| DEFAULT_PROTOCOL.to_string())
        } else {
            normalize_protocol(&input.protocol)
        };
        let stored_keys: Vec<String> = old.map(|p| p.keys.clone()).unwrap_or_default();
        let keys = match input.keys {
            // 新 UI 常态：整份覆盖（空数组 = 清空）
            Some(list) => normalize_list(list),
            None => {
                let has_local_edit = !input.add_keys.is_empty()
                    || !input.remove_key_indexes.is_empty()
                    || input.active_key_index.is_some();
                let base = if has_local_edit {
                    // 有局部编辑时，旧字段 apiKey 不参与（新 UI 不会传它）
                    stored_keys
                } else {
                    match input.api_key {
                        // 旧语义：Some("") = 清空、Some(k) = 覆盖成唯一一把
                        Some(key) => {
                            let key = key.trim().to_string();
                            if key.is_empty() {
                                Vec::new()
                            } else {
                                vec![key]
                            }
                        }
                        None => stored_keys,
                    }
                };
                edit_keys(
                    base,
                    &input.remove_key_indexes,
                    &input.add_keys,
                    input.active_key_index,
                )
            }
        };
        let api_key = keys.first().cloned().unwrap_or_default();
        let models = normalize_list(input.models);
        let model = models
            .first()
            .cloned()
            .unwrap_or_else(|| input.model.trim().to_string());
        next.push(normalize_profile(AiProfile {
            id: if input.id.trim().is_empty() {
                new_profile_id()
            } else {
                input.id.clone()
            },
            name: input.name.trim().to_string(),
            base_url,
            model,
            api_key,
            protocol,
            keys,
            models,
            icon: input.icon.trim().to_string(),
            skip_cert_verify: input.skip_cert_verify,
        }));
    }
    if next.is_empty() {
        next.push(default_profile());
    }
    // 去重：id 撞了说明前端有 bug，保留先出现的那档
    let mut seen: Vec<String> = Vec::with_capacity(next.len());
    next.retain(|p| {
        if seen.contains(&p.id) {
            false
        } else {
            seen.push(p.id.clone());
            true
        }
    });
    let next_active = if next.iter().any(|p| p.id == active_id) {
        active_id
    } else {
        next[0].id.clone()
    };
    save_profiles(&state, &next, &next_active)?;
    Ok(view_of(&next, &next_active))
}

/// 试连：发一句「你好」，确认地址 / 模型 / Key / 协议 都对。
/// 用**表单值**而不是已存配置，用户可以「先试再存」；协议与证书开关缺省沿用已存档
/// （自签名网关要先勾上「跳过证书校验」才连得通）。
#[tauri::command(rename = "ai_local_test")]
pub async fn cmd_ai_local_test(
    state: State<'_, AppState>,
    base_url: String,
    model: String,
    api_key: Option<String>,
    protocol: Option<String>,
    skip_cert_verify: Option<bool>,
) -> Result<AiLocalTestResult, String> {
    let stored = active_profile(&state)?;
    let base = if base_url.trim().is_empty() {
        stored.base_url.clone()
    } else {
        base_url
    };
    let mdl = if model.trim().is_empty() {
        stored.model.clone()
    } else {
        model
    };
    // 表单里没填 Key 时回落到已存的第一把 Key（设置页「留空 = 沿用」）
    let key = match api_key {
        Some(k) if !k.trim().is_empty() => k,
        _ => stored.api_key.clone(),
    };
    let protocol = match protocol.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => Protocol::parse(p),
        _ => Protocol::parse(&stored.protocol),
    };
    let skip = skip_cert_verify.unwrap_or(stored.skip_cert_verify);
    let messages = vec![AiLocalMessage {
        role: "user".to_string(),
        content: "你好".to_string(),
    }];
    let call = build_chat_call(protocol, &base, &mdl, &key, &messages, 0.0)?;
    let started = std::time::Instant::now();
    let result = post_chat(&call, &key, TEST_TIMEOUT_SECS, skip).await;
    Ok(match result {
        Ok((reply, _model, _usage)) => AiLocalTestResult {
            ok: true,
            status: Some(200),
            elapsed_ms: started.elapsed().as_millis(),
            reply: Some(reply.chars().take(60).collect()),
            error: None,
        },
        Err(e) => AiLocalTestResult {
            ok: false,
            status: None,
            elapsed_ms: started.elapsed().as_millis(),
            reply: None,
            error: Some(e),
        },
    })
}

/// 拉可选模型列表（按协议打对应端点），供设置页下拉/勾选；失败由前端提示。
#[tauri::command(rename = "ai_local_list_models")]
pub async fn cmd_ai_local_list_models(
    state: State<'_, AppState>,
    base_url: String,
    api_key: Option<String>,
    protocol: Option<String>,
    skip_cert_verify: Option<bool>,
) -> Result<Vec<String>, String> {
    let stored = active_profile(&state)?;
    let base = if base_url.trim().is_empty() {
        stored.base_url.clone()
    } else {
        base_url
    };
    let key = match api_key {
        Some(k) if !k.trim().is_empty() => k,
        _ => stored.api_key.clone(),
    };
    let protocol = match protocol.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => Protocol::parse(p),
        _ => Protocol::parse(&stored.protocol),
    };
    let skip = skip_cert_verify.unwrap_or(stored.skip_cert_verify);
    let endpoint = models_endpoint(protocol, &base, &key)?;
    let client = build_client(LIST_TIMEOUT_SECS, skip)?;
    let mut request = client.get(&endpoint);
    request = match protocol {
        // Anthropic 的模型列表同样要 `x-api-key` + 版本头
        Protocol::Anthropic => {
            let mut req = request.header("anthropic-version", ANTHROPIC_VERSION);
            if !key.trim().is_empty() {
                req = req.header("x-api-key", key.trim());
            }
            req
        }
        // Gemini 的 Key 在 query 里（`models_endpoint` 已拼好），这里不加头
        Protocol::Gemini => request,
        Protocol::OpenAi | Protocol::OpenAiResponses => {
            if !key.trim().is_empty() {
                request.bearer_auth(key.trim())
            } else {
                request
            }
        }
    };
    let resp = request
        .send()
        .await
        .map_err(|e| format!("请求模型列表失败：{}", crate::astral::sanitize_err(e)))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(if status.as_u16() == 401 {
            format!(
                "服务商返回 401：{}（API Key 无效或没有权限）",
                pick_error(&text)
            )
        } else {
            format!(
                "模型列表接口返回 HTTP {}：{}",
                status.as_u16(),
                pick_error(&text)
            )
        });
    }
    Ok(match protocol {
        // Gemini 的列表是 `models[].name`（带 `models/` 前缀）+ 生成方法过滤
        Protocol::Gemini => parse_gemini_models(&text),
        _ => parse_model_ids(&text),
    })
}

/// 生成：前端给完整 messages，这里用当前生效档按协议转发并取回 content。
#[tauri::command(rename = "ai_local_chat")]
pub async fn cmd_ai_local_chat(
    state: State<'_, AppState>,
    messages: Vec<AiLocalMessage>,
    temperature: Option<f64>,
) -> Result<AiLocalReply, String> {
    if messages.is_empty() {
        return Err("消息为空".to_string());
    }
    let profile = active_profile(&state)?;
    let protocol = Protocol::parse(&profile.protocol);
    let call = build_chat_call(
        protocol,
        &profile.base_url,
        &profile.model,
        &profile.api_key,
        &messages,
        temperature.unwrap_or(0.7).clamp(0.0, 2.0),
    )?;
    let started = std::time::Instant::now();
    let (content, actual_model, usage) = post_chat(
        &call,
        &profile.api_key,
        CHAT_TIMEOUT_SECS,
        profile.skip_cert_verify,
    )
    .await?;
    Ok(AiLocalReply {
        content,
        model: if actual_model.is_empty() {
            profile.model
        } else {
            actual_model
        },
        elapsed_ms: started.elapsed().as_millis(),
        prompt_tokens: usage.as_ref().and_then(|u| u.prompt_tokens),
        completion_tokens: usage.as_ref().and_then(|u| u.completion_tokens),
    })
}

/// 中继/上游偶发失败时的总尝试次数。
///
/// 2026-10-22 实测：某个中转站上 `deepseek-v4.1-flash` 约 6 成请求被上游以
/// 403 / code 11140「request illegal」拒绝，中继把它包成 HTTP 400 返回；
/// **同一个请求重发往往就过了**（换成 `deepseek-v4-pro` 等模型则 100% 成功）。
/// 另有一种失败是 HTTP 200 但 `choices` 为空 / 回了 SSE 空帧，同样属于偶发。
/// 所以这里对内层做 3 次尝试：命中率从 40% 提到 ~94%，用户不用自己反复点。
const CHAT_ATTEMPTS: u32 = 3;

/// 值得重试的状态码：限流、网关/上游 5xx，以及中继把上游拒绝包成 400/403 的情况。
/// 401/404/422 这类「配置写错了」不重试 —— 重试只会让用户多等几秒还是一样的错。
fn retryable_status(code: u16) -> bool {
    matches!(
        code,
        400 | 403
            | 408
            | 409
            | 425
            | 429
            | 500
            | 502
            | 503
            | 504
            | 520
            | 521
            | 522
            | 523
            | 524
            | 529
    )
}

/// 一次请求的失败：带「能不能重试」的标记，由 `post_chat` 决定要不要再来一遍。
struct ChatFailure {
    message: String,
    retryable: bool,
}

impl ChatFailure {
    fn fatal(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
        }
    }

    fn retry(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
        }
    }
}

/// 中继偶尔无视 `stream:false`，照样回 `text/event-stream`（每行 `data: {...}`）。
/// 直接把整段当 JSON 解析会报「模型响应无法解析」，这里按 SSE 帧把 delta 拼起来。
fn parse_sse_content(body: &str) -> Option<String> {
    let mut out = String::new();
    for line in body.lines() {
        let Some(payload) = line.trim().strip_prefix("data:") else {
            continue;
        };
        let payload = payload.trim();
        if payload.is_empty() || payload == "[DONE]" {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
            continue;
        };
        let Some(choices) = value.get("choices").and_then(|c| c.as_array()) else {
            continue;
        };
        for choice in choices {
            let piece = choice
                .get("delta")
                .and_then(|d| d.get("content"))
                .and_then(|c| c.as_str())
                .or_else(|| {
                    choice
                        .get("message")
                        .and_then(|m| m.get("content"))
                        .and_then(|c| c.as_str())
                })
                .or_else(|| choice.get("text").and_then(|t| t.as_str()));
            if let Some(piece) = piece {
                out.push_str(piece);
            }
        }
    }
    let trimmed = out.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(out)
    }
}

// ---------- OpenAI 兼容响应结构 ----------

/// `POST /v1/chat/completions` 的响应（只取用得到的字段，其余忽略）。
#[derive(Debug, Deserialize)]
struct ChatResponse {
    #[serde(default)]
    model: String,
    #[serde(default)]
    choices: Vec<ChatChoice>,
    #[serde(default)]
    usage: Option<ChatUsage>,
}

/// 一个候选：非流式走 `message.content`，个别中继 / 旧接口回 `text`。
#[derive(Debug, Deserialize)]
struct ChatChoice {
    #[serde(default)]
    message: Option<ChatChoiceMessage>,
    #[serde(default)]
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChatChoiceMessage {
    #[serde(default)]
    content: Option<String>,
}

/// token 用量。四家的字段名不同但都归到这两个数上：
/// OpenAI 是 `prompt_tokens` / `completion_tokens`，Anthropic 与 Responses 是
/// `input_tokens` / `output_tokens`，Gemini 是 `promptTokenCount` /
/// `candidatesTokenCount`（映射见 [`usage_from`]）。
#[derive(Debug, Deserialize)]
struct ChatUsage {
    #[serde(default)]
    prompt_tokens: Option<i64>,
    #[serde(default)]
    completion_tokens: Option<i64>,
}

/// `GET /v1/models` 的响应：标准是 `{"data":[…]}`，个别网关回 `{"models":[…]}`。
#[derive(Debug, Deserialize)]
struct ModelsResponse {
    #[serde(default)]
    data: Vec<ModelEntry>,
    #[serde(default)]
    models: Vec<ModelEntry>,
}

#[derive(Debug, Deserialize)]
struct ModelEntry {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: Option<String>,
}

/// 取正文：优先 `choices[0].message.content`，兼容 `choices[0].text`。
/// 只取第一个候选 —— 非流式请求下本来也只会有一个。
fn pick_content(parsed: &ChatResponse) -> String {
    let Some(choice) = parsed.choices.first() else {
        return String::new();
    };
    if let Some(content) = choice.message.as_ref().and_then(|m| m.content.as_deref()) {
        return content.to_string();
    }
    choice.text.clone().unwrap_or_default()
}

/// 从响应体里取回 (content, model, usage)：先按整体 JSON 解析，失败再按 SSE 拼。
/// 这是 **OpenAI Chat Completions** 的解析；其余协议见 [`extract_reply_by`]。
fn extract_reply(body: &str) -> Result<(String, String, Option<ChatUsage>), String> {
    match serde_json::from_str::<ChatResponse>(body) {
        Ok(parsed) => {
            let content = pick_content(&parsed);
            if content.trim().is_empty() {
                // HTTP 200 但没内容：上游偶发把请求吞了，值得重试
                return Err("模型返回了空内容".to_string());
            }
            Ok((content, parsed.model, parsed.usage))
        }
        Err(err) => match parse_sse_content(body) {
            Some(content) => Ok((content, String::new(), None)),
            None => Err(format!("模型响应无法解析：{err}")),
        },
    }
}

/// 按协议解析响应体（四家的 content 位置与 usage 字段名都不同）。
fn extract_reply_by(
    protocol: Protocol,
    body: &str,
) -> Result<(String, String, Option<ChatUsage>), String> {
    match protocol {
        Protocol::OpenAi => extract_reply(body),
        Protocol::OpenAiResponses => extract_responses_reply(body),
        Protocol::Anthropic => extract_anthropic_reply(body),
        Protocol::Gemini => extract_gemini_reply(body),
    }
}

/// Responses API：`{"output":[{"content":[{"type":"output_text","text":"…"}]}]}`。
/// 文本项按 `output[].content[].text` 拼接（`type` 不是 output_text、但带 `text`
/// 的项也照收 —— 有些网关会自己改 type）。
fn extract_responses_reply(body: &str) -> Result<(String, String, Option<ChatUsage>), String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("模型响应无法解析：{e}"))?;
    let mut out = String::new();
    if let Some(items) = value.get("output").and_then(|o| o.as_array()) {
        for item in items {
            let Some(parts) = item.get("content").and_then(|c| c.as_array()) else {
                continue;
            };
            for part in parts {
                let is_output_text =
                    part.get("type").and_then(|t| t.as_str()) == Some("output_text");
                if !is_output_text && part.get("text").is_none() {
                    continue;
                }
                if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                    out.push_str(text);
                }
            }
        }
    }
    let content = out.trim();
    if content.is_empty() {
        return Err("模型返回了空内容".to_string());
    }
    let model = value
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or_default()
        .to_string();
    let usage = usage_from(&value, "usage", "input_tokens", "output_tokens");
    Ok((content.to_string(), model, usage))
}

/// Anthropic Messages：`{"content":[{"type":"text","text":"…"}]}`，按 `content[].text` 拼接。
fn extract_anthropic_reply(body: &str) -> Result<(String, String, Option<ChatUsage>), String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("模型响应无法解析：{e}"))?;
    let mut out = String::new();
    if let Some(blocks) = value.get("content").and_then(|c| c.as_array()) {
        for block in blocks {
            if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                out.push_str(text);
            }
        }
    }
    let content = out.trim();
    if content.is_empty() {
        return Err("模型返回了空内容".to_string());
    }
    let model = value
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or_default()
        .to_string();
    let usage = usage_from(&value, "usage", "input_tokens", "output_tokens");
    Ok((content.to_string(), model, usage))
}

/// Gemini：`{"candidates":[{"content":{"parts":[{"text":"…"}]}}]}`，
/// 取第一个候选的 `parts[].text` 拼接。
fn extract_gemini_reply(body: &str) -> Result<(String, String, Option<ChatUsage>), String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("模型响应无法解析：{e}"))?;
    let mut out = String::new();
    if let Some(candidate) = value
        .get("candidates")
        .and_then(|c| c.as_array())
        .and_then(|c| c.first())
    {
        if let Some(parts) = candidate
            .get("content")
            .and_then(|content| content.get("parts"))
            .and_then(|parts| parts.as_array())
        {
            for part in parts {
                if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                    out.push_str(text);
                }
            }
        }
    }
    let content = out.trim();
    if content.is_empty() {
        // 被安全策略拦截时 candidates 是空的，blockReason 才是用户要看的原因
        return Err(match value
            .pointer("/promptFeedback/blockReason")
            .and_then(|reason| reason.as_str())
        {
            Some(reason) => format!("模型返回了空内容（被安全策略拦截：{reason}）"),
            None => "模型返回了空内容".to_string(),
        });
    }
    // 有的版本回 `modelVersion`，有的回 `model`；都没有就交给上层回落请求里的模型名
    let model = value
        .get("modelVersion")
        .or_else(|| value.get("model"))
        .and_then(|m| m.as_str())
        .unwrap_or_default()
        .to_string();
    let usage = usage_from(
        &value,
        "usageMetadata",
        "promptTokenCount",
        "candidatesTokenCount",
    );
    Ok((content.to_string(), model, usage))
}

/// 取 token 用量：各家字段名不同（`usage.prompt_tokens` / `usage.input_tokens` /
/// `usageMetadata.promptTokenCount`），这里按「外层键 + 两个内层键」取，取不到就 None。
fn usage_from(
    value: &serde_json::Value,
    usage_key: &str,
    prompt_key: &str,
    completion_key: &str,
) -> Option<ChatUsage> {
    let usage = value.get(usage_key)?.as_object()?;
    let read = |name: &str| usage.get(name).and_then(|v| v.as_i64());
    Some(ChatUsage {
        prompt_tokens: read(prompt_key),
        completion_tokens: read(completion_key),
    })
}

/// 从服务商的错误体里抽一句可读原因（OpenAI 风格 `{"error":{"message":…}}`）。
fn pick_error(body: &str) -> String {
    let trimmed = body.trim();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(msg) = v
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
        {
            return msg.to_string();
        }
        if let Some(msg) = v.get("message").and_then(|m| m.as_str()) {
            return msg.to_string();
        }
    }
    let clipped: String = trimmed.chars().take(200).collect();
    clipped
}

/// 真正发请求（带重试）。返回 (content, model, usage)。
async fn post_chat(
    call: &ChatCall,
    api_key: &str,
    timeout_secs: u64,
    skip_cert_verify: bool,
) -> Result<(String, String, Option<ChatUsage>), String> {
    // 代理设置跟随全局「网络」页（与音源/后端同一个出口），用户配了代理这里才能通；
    // 证书校验只在用户显式打开「跳过」时才关（见 `build_client`）
    let client = build_client(timeout_secs, skip_cert_verify)?;
    let mut last = "模型接口没有响应".to_string();
    for attempt in 1..=CHAT_ATTEMPTS {
        if attempt > 1 {
            // 200ms → 600ms：给中继/上游一点恢复时间，又不至于让「试连」按钮卡太久
            let backoff = 200 + 400 * u64::from(attempt - 2);
            tokio::time::sleep(Duration::from_millis(backoff)).await;
        }
        match post_chat_once(&client, call, api_key).await {
            Ok(reply) => return Ok(reply),
            Err(failure) => {
                let retryable = failure.retryable;
                last = failure.message;
                if !retryable || attempt == CHAT_ATTEMPTS {
                    break;
                }
            }
        }
    }
    Err(last)
}

/// 单次尝试：按协议加鉴权头、发出请求并解析，失败时标明能不能重试。
async fn post_chat_once(
    client: &reqwest::Client,
    call: &ChatCall,
    api_key: &str,
) -> Result<(String, String, Option<ChatUsage>), ChatFailure> {
    let key = api_key.trim();
    let mut request = client.post(&call.endpoint).json(&call.body);
    match call.protocol {
        // Anthropic 用 `x-api-key` + 固定版本头，content-type 必须显式 JSON
        Protocol::Anthropic => {
            request = request
                .header("anthropic-version", ANTHROPIC_VERSION)
                .header("content-type", "application/json");
            if !key.is_empty() {
                request = request.header("x-api-key", key);
            }
        }
        // Gemini 的 Key 已经拼在 URL query 里（见 `chat_endpoint`），这里不加头
        Protocol::Gemini => {}
        // OpenAI 两套都走 Bearer；本机 Ollama / LM Studio 允许空 Key，此时不发头
        Protocol::OpenAi | Protocol::OpenAiResponses => {
            if !key.is_empty() {
                request = request.bearer_auth(key);
            }
        }
    }
    let resp = request.send().await.map_err(|e| {
        let message = format!("请求模型接口失败：{}", crate::astral::sanitize_err(&e));
        // 超时不重试：单次就 120s，重试三次用户要干等 6 分钟
        if e.is_timeout() {
            ChatFailure::fatal(message)
        } else {
            ChatFailure::retry(message)
        }
    })?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let mut message = if status.as_u16() == 401 {
            format!(
                "服务商返回 401：{}（API Key 无效或没有权限，请在详情页检查 Key）",
                pick_error(&text)
            )
        } else {
            format!(
                "模型接口返回 HTTP {}：{}",
                status.as_u16(),
                pick_error(&text)
            )
        };
        // 中继把上游拒绝（403 / code 11140「request illegal」）包成 400 时，
        // 给一句用户能操作的话，别只丢一个英文错误码
        if text.contains("11140") || text.contains("request illegal") {
            message
                .push_str("（上游拒绝了这次请求，属于中转站侧的偶发问题：可以重试，或换一个模型）");
        }
        return Err(ChatFailure {
            retryable: retryable_status(status.as_u16()),
            message,
        });
    }
    extract_reply_by(call.protocol, &text).map_err(ChatFailure::retry)
}

/// 从 `GET /v1/models` 的响应里抽出模型 id（去重 + 排序，过滤空串）。
fn parse_model_ids(body: &str) -> Vec<String> {
    let trimmed = body.trim();
    let entries: Vec<ModelEntry> = if let Ok(resp) = serde_json::from_str::<ModelsResponse>(trimmed)
    {
        if !resp.data.is_empty() {
            resp.data
        } else {
            resp.models
        }
    } else if let Ok(list) = serde_json::from_str::<Vec<ModelEntry>>(trimmed) {
        list
    } else {
        Vec::new()
    };
    let mut ids: Vec<String> = Vec::with_capacity(entries.len());
    for entry in entries {
        let id = if entry.id.trim().is_empty() {
            entry.name.unwrap_or_default()
        } else {
            entry.id
        };
        let id = id.trim().to_string();
        if !id.is_empty() && !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids.sort();
    ids
}

/// Gemini 的模型列表：`{"models":[{"name":"models/gemini-2.0-flash",
/// "supportedGenerationMethods":["generateContent"]}]}`。
///
/// 名字要剥掉 `models/` 前缀（拼 URL 时才不会出现 `models/models/…`）；
/// 只保留能 `generateContent` 的模型（embedding 之类在设置页里选了也没用）。
fn parse_gemini_models(body: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body.trim()) else {
        return Vec::new();
    };
    let Some(models) = value.get("models").and_then(|m| m.as_array()) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = Vec::with_capacity(models.len());
    for model in models {
        let Some(name) = model.get("name").and_then(|n| n.as_str()) else {
            continue;
        };
        let supports = match model
            .get("supportedGenerationMethods")
            .and_then(|m| m.as_array())
        {
            // 老网关不给这个字段：拿不到就按「支持」处理，总比返回空列表好
            None => true,
            Some(methods) => methods
                .iter()
                .any(|m| m.as_str() == Some("generateContent")),
        };
        if !supports {
            continue;
        }
        let id = name.trim().trim_start_matches("models/").to_string();
        if !id.is_empty() && !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids.sort();
    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 中继无视 `stream:false`、照样回 SSE 的情况：不能整段当 JSON 解析报废。
    #[test]
    fn sse_body_is_joined_into_content() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"picks\\\":\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"[]}\"}}]}\n\n",
            "data: [DONE]\n\n",
        );
        assert_eq!(parse_sse_content(body).as_deref(), Some("{\"picks\":[]}"));
    }

    #[test]
    fn sse_without_content_is_none() {
        assert!(parse_sse_content("data: [DONE]\n").is_none());
        assert!(parse_sse_content("{\"choices\":[]}").is_none());
    }

    /// 正常 JSON 仍然走快路径，不该被 SSE 逻辑影响。
    #[test]
    fn json_body_parses_content_and_model() {
        let body = r#"{"model":"m1","choices":[{"message":{"content":"你好"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}"#;
        let (content, model, usage) = extract_reply(body).expect("应能解析");
        assert_eq!(content, "你好");
        assert_eq!(model, "m1");
        assert_eq!(usage.and_then(|u| u.completion_tokens), Some(2));
    }

    /// HTTP 200 但 choices 空 → 报「空内容」，好让上层重试而不是空手返回。
    #[test]
    fn empty_choices_is_an_error() {
        let err = extract_reply(r#"{"choices":[]}"#).expect_err("空内容必须报错");
        assert!(err.contains("空内容"), "错误文案要可读：{err}");
    }

    /// 401/404 是配置写错，重试没意义；429/5xx 与中继包出来的 400 值得重试。
    #[test]
    fn retryable_status_covers_transient_only() {
        for code in [400u16, 403, 408, 425, 429, 500, 502, 503, 504] {
            assert!(retryable_status(code), "{code} 应当重试");
        }
        for code in [401u16, 404, 422] {
            assert!(!retryable_status(code), "{code} 不该重试");
        }
    }
}
