//! Astral HTTP 客户端（DESIGN §2.3.4）：
//! base_url + satoken 附加 + QtRestResp 解析。
//! 401 自动刷新：request 收口处「剩余寿命 <5 分钟先主动续期」+「401 单飞刷新后
//! 重试一次」，三态语义对齐 qt-uniappx services/http.ts（后端明确拒绝才清登录态，
//! 网络/网关瞬时故障保留 token）。

use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};

/// 云端 JSON 的标量字段实测会给 `null`（changes 接口回过 album / hash / pid: null）。
/// Rust 侧字段是 String / bool / i64，只写 `#[serde(default)]` 挡不住显式的 null：
/// serde 会直接报 `invalid type: null, expected a string`，整条变更反序列化失败，
/// 前端就看到 `like_apply` 参数错误。这里统一把 null / 非预期类型归成默认值。
fn de_string_or_default<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = Option::<Value>::deserialize(deserializer).ok().flatten();
    Ok(match v {
        Some(Value::String(s)) => s,
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    })
}

fn de_optional_pic_url<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(match value {
        Some(Value::String(value)) => Some(value),
        Some(Value::Number(value)) => Some(value.to_string()),
        Some(Value::Bool(value)) => Some(value.to_string()),
        _ => None,
    })
}

fn de_bool_or_default<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<bool>::deserialize(deserializer)
        .ok()
        .flatten()
        .unwrap_or(false))
}

fn de_i64_or_default<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<i64>::deserialize(deserializer)
        .ok()
        .flatten()
        .unwrap_or(0))
}

/// 云端收藏变更（app/user/like/changes 的单条）。字段对齐 qt-uniappx types/music LikeChange。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LikeChange {
    /// "song" | "playlist"
    #[serde(rename = "type", default, deserialize_with = "de_string_or_default")]
    pub kind: String,
    #[serde(default, deserialize_with = "de_string_or_default")]
    pub id: String,
    #[serde(default, deserialize_with = "de_string_or_default")]
    pub platform: String,
    #[serde(default, deserialize_with = "de_string_or_default")]
    pub name: String,
    #[serde(default, deserialize_with = "de_string_or_default")]
    pub singer: String,
    #[serde(default, deserialize_with = "de_string_or_default")]
    pub album: String,
    #[serde(default, deserialize_with = "de_string_or_default")]
    pub hash: String,
    /// 歌曲所属歌单（song 变更项新增，可空；playlist 变更项无此字段）
    #[serde(default, deserialize_with = "de_string_or_default")]
    pub pid: String,
    #[serde(default, deserialize_with = "de_optional_pic_url")]
    pub pic_url: Option<String>,
    #[serde(default, deserialize_with = "de_bool_or_default")]
    pub deleted: bool,
    #[serde(default, deserialize_with = "de_i64_or_default")]
    pub updated_seq: i64,
}

/// 单曲收藏推送的载荷
pub struct LikeSongPayload<'a> {
    pub action: &'a str,
    pub sid: &'a str,
    pub platform: &'a str,
    pub name: &'a str,
    pub singer: &'a str,
    pub album: &'a str,
    /// 酷狗等音源需要 hash 才能取址，没有就不传
    pub hash: Option<&'a str>,
    /// 歌曲归属歌单的 pid（后端 like/song 可选字段，≤64）。
    /// 收藏到具体歌单时必上送；不传后端保留云端已有归属。
    pub pid: Option<&'a str>,
    /// 歌曲封面地址（第三方源 URL 快照）。仅 `add` 且非空时上送，
    /// 避免旧客户端/空值把云端已有图片擦掉（后端 D4 非空覆盖策略）。
    pub pic_url: Option<&'a str>,
}

/// 登录会话。字段名与 qt-uniappx `services/auth.ts` 的 parseTokenResponse 对齐
/// （后端返回 `token` / `expiresIn`）。
///
/// 注：后端（astral）从不签发 refreshToken（全仓无下发/刷新端点，只有一条
/// 字典类型定义），续期完全靠 satoken 主动刷新（见 `refresh`）——这里不设
/// refresh_token 字段，避免误导后来者以为存在可用的刷新令牌。
// Native-only: intentionally no Serialize, so command returns cannot leak tokens.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub token: String,
    /// 过期时间（Unix 毫秒）。后端不返回 expiresIn 时按 7 天算，与移动端一致。
    pub expires_at: i64,
}

impl std::fmt::Debug for AuthSession {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AuthSession")
            .field("token", &"***")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

impl AuthSession {
    /// 是否还没过期（留 60s 余量，避免边界上带着即将失效的 token 发请求）
    pub fn is_valid(&self) -> bool {
        self.expires_at > now_ms() + 60_000
    }
}

/// 从收藏推送的响应里取 seq（移动端 like.ts 的 seqOf 同款：只认 data.seq）
fn seq_of(data: &Value) -> i64 {
    data.get("seq").and_then(Value::as_i64).unwrap_or(0)
}

/// 组装 `/like/song` 请求体（LIKE_SONG_PIC_SYNC_DESIGN §8.2 / D3 / D4）：
/// - 基础字段恒在；`hash` 非空才带；
/// - `pid` / `picUrl` 仅 `add` 且非空时上送 —— 空值不上送，
///   后端 `COALESCE(NULLIF(EXCLUDED.pic_url,''), qt_like_song.pic_url)` 会保留云端已有图片；
/// - `remove` 既不带 pid 也不带 picUrl。
///
/// 抽成纯函数便于网络无关的单测（§11.3-6）。
fn like_song_body(p: &LikeSongPayload<'_>) -> serde_json::Value {
    let mut body = serde_json::json!({
        "action": p.action,
        "sid": p.sid,
        "platform": p.platform,
        "name": p.name,
        "singer": p.singer,
        "album": p.album,
    });
    if let Some(h) = p.hash.filter(|s| !s.is_empty()) {
        body["hash"] = serde_json::json!(h);
    }
    if p.action == "add" {
        if let Some(pid) = p.pid.filter(|s| !s.is_empty()) {
            body["pid"] = serde_json::json!(pid);
        }
        if let Some(pic) = p.pic_url.filter(|s| !s.is_empty()) {
            body["picUrl"] = serde_json::json!(pic);
        }
    }
    body
}

/// 离线队列用的请求体序列化（与 like_song 上送内容一字不差）。
pub(crate) fn like_song_body_for_queue(p: &LikeSongPayload<'_>) -> String {
    like_song_body(p).to_string()
}

/// 批量接口（/like/batch）的歌曲操作体：单条请求体 + type 判别字段。
pub(crate) fn like_song_op_for_batch(p: &LikeSongPayload<'_>) -> serde_json::Value {
    let mut body = like_song_body(p);
    body["type"] = serde_json::json!("song");
    body
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 从登录 / 注册 / 刷新的响应 data 里解出会话
fn parse_session(data: &Value) -> Result<AuthSession, String> {
    let token = data
        .get("token")
        .or_else(|| data.get("accessToken"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if token.is_empty() {
        return Err("登录响应里没有 token".to_string());
    }
    let expires_in = data
        .get("expiresIn")
        .and_then(Value::as_i64)
        .unwrap_or(7 * 24 * 3600);
    Ok(AuthSession {
        token,
        expires_at: now_ms() + expires_in * 1000,
    })
}

// ---- 后端地址与平台参数单源于仓库根的 app.config.json（scripts/sync-config.mjs
// ---- 生成到 src/app_config.rs）。这里只做转发，对外名字不变，调用方无需改动。

/// 生产后端（线上环境，qt-uniappx services/config.local.ts API_BASE_URL_PROD 同源）
pub const PROD_BASE_URL: &str = crate::app_config::PROD_BASE_URL;
/// 本地开发后端（本机 astral 服务，qt-uniappx services/config.local.ts API_BASE_URL_DEV 同源）
pub const DEV_BASE_URL: &str = crate::app_config::DEV_BASE_URL;
/// 当前生效的后端地址：由 app.config.json 的 `backend.active` 决定（当前 = 生产后端）。
/// 要联调本地后端：把 active 改成 "dev" → `pnpm config:sync` → 重新编译。
pub const DEFAULT_BASE_URL: &str = crate::app_config::DEFAULT_BASE_URL;

/// 更新 / 消息 / 统计的平台固定参数（§15.2）
/// UPDATE_TYPE 按编译目标从 app.config.json 的 platform 段取值
/// （1103 = Windows / 1104 = Linux / 1105 = macOS，见 app_config.rs 生成注释）
pub const UPDATE_TYPE: &str = crate::app_config::UPDATE_TYPE;
pub const MESSAGE_CHANNEL: &str = "pc";
/// 统一客户端平台标识 = 请求头 `X-App-Ut` 的值，按编译目标三选一。
/// 与后端 `stat_platform` 字典、App 端的 `app-android` / `app-ios`、Web 端的 `web` 同源
/// （契约见后端 `com.astral.common.util.ClientHeaders`）：
/// 统计上报事件的 `ut` 字段与每个请求的 `X-App-Ut` 头都用它，两处不会漂移。
#[cfg(target_os = "windows")]
pub const CLIENT_UT: &str = "app-windows";
#[cfg(target_os = "linux")]
pub const CLIENT_UT: &str = "app-linux";
#[cfg(target_os = "macos")]
pub const CLIENT_UT: &str = "app-macos";

// ---------- 统一客户端系统头 ----------
// 凡请求 astral 后端都必须携带这 4 个头，服务端两条链路共用：
//   接口统计 ApiRequestMetricInterceptor → stat_api_hourly(ut / app_version)
//   反馈提交 AppFeedbackController.submit → sys_feedback(platform / app_version / device / os)
// 头名与长度上限的权威定义在后端 astral-common 的 ClientHeaders，改这里要同步改那边。

/// 平台头名（值 = [`CLIENT_UT`]）
pub const HDR_CLIENT_UT: &str = "X-App-Ut";
/// 版本头名（值 = [`version_name`]）
pub const HDR_CLIENT_VERSION: &str = "X-App-Version";
/// 设备头名（值 = 本机主机名）
pub const HDR_CLIENT_DEVICE: &str = "X-Device";
/// 系统头名（值 = 当前系统描述：Windows 完整版本 / Linux 发行版 / macOS 版本）
pub const HDR_CLIENT_OS: &str = "X-OS";

/// 设备名长度上限（与 sys_feedback.device 列宽一致）
const MAX_DEVICE_LEN: usize = 128;
/// 系统描述长度上限（与 sys_feedback.os 列宽一致）
const MAX_OS_LEN: usize = 64;

/// 更新安装包的临时目录名（`%TEMP%/quietmusic-update`）与固定落盘名。
///
/// 落盘名**不能**从下载 URL 推导：URL 由服务端下发，形如
/// `https://host/x/..\..\Windows\System32\bad.exe` 的路径落在 `Path::join` 上
/// 会被当成多级路径（Windows 下 `\` 同样是分隔符），写到临时目录之外。
/// 固定文件名之后，"这个路径能不能执行"就有了唯一确定的答案
/// （见 `commands::cmd_run_update_installer` 的校验）。
pub const UPDATE_DIR_NAME: &str = "quietmusic-update";
pub const UPDATE_INSTALLER_FILE_NAME: &str = "quietmusic-setup.exe";

/// 更新包 ed25519 签名公钥（raw 32 字节 base64）。与 scripts/update-sign.mjs
/// 生成的密钥对配对；私钥只存发布机（.signing/，不进仓库）。换密钥对 = 换
/// 这个常量 + 重新发版。
pub const UPDATE_SIGN_PUBKEY_B64: &str = "i6+KDVw2olPXumy/qlc9004hhQKMffU/6aUPtcugUCg=";

/// 本次进程内「下载的安装包已通过 ed25519 签名校验」标记，由
/// cmd_download_update_file 校验通过后置位；应用重启归零（要重新下载）。
/// cmd_run_update_installer 据此拒绝执行未经校验的包。
static INSTALLER_SIGNATURE_VERIFIED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub fn installer_signature_verified() -> bool {
    INSTALLER_SIGNATURE_VERIFIED.load(std::sync::atomic::Ordering::Relaxed)
}

pub(crate) fn mark_installer_signature_verified() {
    INSTALLER_SIGNATURE_VERIFIED.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// 下载开始（固定路径文件被截断/重建）时复位标记：上一次「已验签」的字节
/// 已不存在。不复位的话，二次下载中途失败（MD5/签名不过）后标记仍是 true，
/// run_update_installer 会执行从未通过校验的字节
pub(crate) fn reset_installer_signature_verified() {
    INSTALLER_SIGNATURE_VERIFIED.store(false, std::sync::atomic::Ordering::Relaxed);
}

/// 更新安装包的固定路径（下载写入与执行校验共用同一口径，避免两处各写一份）
pub fn update_installer_path() -> std::path::PathBuf {
    std::env::temp_dir()
        .join(UPDATE_DIR_NAME)
        .join(UPDATE_INSTALLER_FILE_NAME)
}

/// 邮件模板业务标识（后端 QtSendEmailDto.body / sys_mail_template.scene）。
///
/// **不是邮件正文**：后端拿它去 sys_mail_template 找模板并渲染正文，同时用
/// `qt:email:code:{email}:{scene}` 存验证码；改密码时 `changePwByEmail` 校验的
/// 是同一个 scene（QtUserService.EMAIL_BODY_CHANGE_PW）。传错就是两头都错——
/// 模板查不到（MAIL002）导致发信失败，就算发出去了验证码也永远校验不过。
pub const MAIL_SCENE_CHANGE_PW: &str = "changePasswordByEmail";

/// 会话被服务端否认时统一的错误文案。
/// HTTP 401 和业务码 401 都归一成这一条，调用方（如 `cmd_astral_me`）据此
/// 判断"确实失效"从而清掉本地会话——网络不可达是另一类错误，不能混用，
/// 否则断网时会把用户登出。
pub const ERR_UNAUTHORIZED: &str = "登录状态已失效，请重新登录";

/// 错误串是否表示"服务端明确否认这个 token"（区别于网络不可达）
pub fn is_auth_error(msg: &str) -> bool {
    msg == ERR_UNAUTHORIZED
}

/// 面向用户的报错不携带具体 URL：reqwest 的错误串会带上请求地址
/// （含自家后端/存储域名），统一替换成 …，只留失败原因。
pub(crate) fn sanitize_err(e: impl std::fmt::Display) -> String {
    let s = e.to_string();
    let mut out = String::with_capacity(s.len());
    let mut rest = s.as_str();
    while !rest.is_empty() {
        let scheme = if rest.starts_with("https://") {
            8
        } else if rest.starts_with("http://") {
            7
        } else {
            0
        };
        if scheme > 0 {
            let end = rest[scheme..]
                .find([
                    ' ', '\t', '\r', '\n', '"', '\'', '(', ')', '<', '>', ',', '[', ']', '{', '}',
                ])
                .map_or(rest.len(), |p| p + scheme);
            out.push('…');
            rest = &rest[end..];
        } else {
            let ch = rest.chars().next().unwrap_or('\u{fffd}');
            out.push(ch);
            rest = &rest[ch.len_utf8()..];
        }
    }
    out
}

/// HEAD 探测用独立小函数（无 satoken 依赖，失败返回 None）
async fn self_http_get_head(url: &str) -> Option<reqwest::Response> {
    let client = crate::net_config::configure(reqwest::Client::builder())
        .timeout(std::time::Duration::from_secs(5))
        .pool_max_idle_per_host(0)
        .build()
        .ok()?;
    client
        .get(url)
        .header("Range", "bytes=0-0")
        .header("User-Agent", "quietmusic-accel-probe")
        .send()
        .await
        .ok()
}

/// 会话持久化键（settings 表）。commands.rs 的登录/刷新命令与这里的自动刷新共用。
pub(crate) const SETTING_ASTRAL_SESSION: &str = "astral.session";

/// 刷新结果三态（对齐 qt-uniappx http.ts 的 RefreshResult）
enum RefreshOutcome {
    /// 拿到新 token（含并发请求已代为刷新的情况）
    Ok,
    /// 后端明确拒绝，登录态已清
    Invalid,
    /// 网络/网关瞬时故障，保留现有 token 不清登录态
    Network(String),
}

/// 剩余寿命不足 5 分钟就主动续期（对齐 qt-uniappx services/auth.ts shouldRefreshToken）
fn should_proactive_refresh(expires_at: i64, now: i64) -> bool {
    expires_at - now < 5 * 60 * 1000
}

/// 刷新接口本身不走「主动续期 / 401 再刷新」（防递归，也防单飞锁自锁）
fn refresh_path(path: &str) -> bool {
    path.trim_start_matches('/') == "app/user/refresh"
}

/// 刷新失败是否属于「后端明确拒绝」（HTTP/业务 401、2xx 业务拒绝、响应无 token），
/// 与网络类失败（请求失败 / 响应解析失败）区分——前者清登录态，后者不清。
/// 口径对齐 qt-uniappx http.ts tryRefreshToken；差异：移动端把刷新接口的 HTTP
/// 层 401 归为瞬时故障，这里归为失效——本后端 QtRestResp 的会话拒绝就是 401
/// 语义，cmd_astral_me 与前端同样按 401 清理，两端行为保持一致。
fn is_definitive_refresh_rejection(err: &str) -> bool {
    err == ERR_UNAUTHORIZED
        || err.starts_with("Astral 业务错误")
        || err.starts_with("登录响应里没有 token")
}

static ASTRAL_HTTP: std::sync::OnceLock<RwLock<(u64, reqwest::Client)>> =
    std::sync::OnceLock::new();

/// Owned request at the HTTP adapter boundary. Intentionally not Debug/Serialize:
/// request bodies and satoken are native-only credentials.
pub struct AstralHttpRequest {
    pub method: reqwest::Method,
    pub url: String,
    pub query: Vec<(String, String)>,
    pub json_body: Option<Value>,
    pub headers: Vec<(String, String)>,
    pub satoken: Option<String>,
}

pub struct AstralHttpResponse {
    pub status: u16,
    pub body: String,
}

pub struct AstralUploadRequest {
    pub ticket: UploadTicket,
    pub file_name: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// 两段式代传正文（CUSTOM_HTTP 渠道）：正文经 astral 网关转发，由服务端发往上游。
/// 与直传不同——这是自家后端地址，必须带 satoken 与统一客户端系统头。
pub struct AstralProxyPutRequest {
    pub url: String,
    pub satoken: Option<String>,
    pub headers: Vec<(String, String)>,
    pub bytes: Vec<u8>,
}

pub trait AstralHttpTransport: Send + Sync {
    fn send(
        &self,
        request: AstralHttpRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<AstralHttpResponse, String>> + Send + '_>,
    >;
    fn upload(
        &self,
        _request: AstralUploadRequest,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async { Err("直传适配器未配置".to_owned()) })
    }
    fn proxy_put(
        &self,
        _request: AstralProxyPutRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<AstralHttpResponse, String>> + Send + '_>,
    > {
        Box::pin(async { Err("代传适配器未配置".to_owned()) })
    }
}

/// Instance requester sharing the actual reqwest header/auth/query/body/read path.
/// A supplied production client keeps its configured policy; owned_loopback is an
/// explicit finite numeric endpoint adapter, never the production default.
pub struct AstralRequester {
    client: reqwest::Client,
    owned_origin: Option<reqwest::Url>,
}

impl AstralRequester {
    pub fn new(client: reqwest::Client) -> Self {
        Self {
            client,
            owned_origin: None,
        }
    }

    /// Caller must own this listener for the requester's whole lifetime.
    pub fn owned_loopback(addr: std::net::SocketAddr) -> Result<Self, String> {
        if addr.ip() != std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST) || addr.port() == 0 {
            return Err(
                "Astral owned endpoint must be numeric 127.0.0.1 with a bound port".to_owned(),
            );
        }
        let origin = reqwest::Url::parse(&format!("http://{addr}"))
            .map_err(|_| "Astral owned endpoint invalid".to_owned())?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(1))
            .read_timeout(std::time::Duration::from_secs(3))
            .timeout(std::time::Duration::from_secs(5))
            .pool_max_idle_per_host(0)
            .build()
            .map_err(|_| "Astral owned client initialization failed".to_owned())?;
        Ok(Self {
            client,
            owned_origin: Some(origin),
        })
    }

    pub async fn send(&self, request: AstralHttpRequest) -> Result<AstralHttpResponse, String> {
        if let Some(origin) = &self.owned_origin {
            let url = reqwest::Url::parse(&request.url)
                .map_err(|_| "Astral request is not an owned endpoint".to_owned())?;
            if url.origin() != origin.origin()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err("Astral request is not an owned endpoint".to_owned());
            }
        }
        let mut req = self
            .client
            .request(request.method, &request.url)
            .query(&request.query);
        if let Some(token) = request.satoken {
            req = req.header("satoken", token);
        }
        for (name, value) in request.headers {
            req = req.header(name, value);
        }
        if let Some(body) = request.json_body {
            req = req.json(&body);
        }
        let response = req
            .send()
            .await
            .map_err(|_| "Astral 请求失败，请检查网络连接".to_owned())?;
        let status = response.status().as_u16();
        let body = response
            .text()
            .await
            .map_err(|_| "Astral 响应读取失败".to_owned())?;
        Ok(AstralHttpResponse { status, body })
    }
}

impl AstralHttpTransport for AstralRequester {
    fn send(
        &self,
        request: AstralHttpRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<AstralHttpResponse, String>> + Send + '_>,
    > {
        Box::pin(AstralRequester::send(self, request))
    }
}

struct ReqwestAstralTransport;
impl AstralHttpTransport for ReqwestAstralTransport {
    fn send(
        &self,
        request: AstralHttpRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<AstralHttpResponse, String>> + Send + '_>,
    > {
        Box::pin(async move { AstralRequester::new(shared_http()).send(request).await })
    }

    fn upload(
        &self,
        request: AstralUploadRequest,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async move {
            let AstralUploadRequest {
                ticket,
                file_name,
                content_type,
                bytes,
            } = request;
            let client = crate::net_config::configure(reqwest::Client::builder())
                .timeout(std::time::Duration::from_secs(60))
                .pool_max_idle_per_host(0)
                .build()
                .map_err(|_| "上传客户端构建失败".to_owned())?;
            let response = if ticket.method.eq_ignore_ascii_case("PUT") {
                client
                    .put(&ticket.upload_url)
                    .body(bytes)
                    .send()
                    .await
                    .map_err(|error| format!("直传失败: {}", sanitize_err(error)))?
            } else {
                let field = ticket.form_field.unwrap_or_else(|| "file".into());
                let mut form = reqwest::multipart::Form::new();
                if let Some(policy) = ticket.form_policy {
                    form = form.text("policy", policy);
                }
                if let Some(authorization) = ticket.form_authorization {
                    form = form.text("authorization", authorization);
                }
                let part = reqwest::multipart::Part::bytes(bytes)
                    .file_name(file_name)
                    .mime_str(&content_type)
                    .map_err(|_| "上传 MIME 非法".to_owned())?;
                form = form.part(field, part);
                client
                    .post(&ticket.upload_url)
                    .multipart(form)
                    .send()
                    .await
                    .map_err(|error| format!("直传失败: {}", sanitize_err(error)))?
            };
            let status = response.status();
            if !status.is_success() {
                return Err(format!("直传被存储端拒绝({status})"));
            }
            Ok(())
        })
    }

    fn proxy_put(
        &self,
        request: AstralProxyPutRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<AstralHttpResponse, String>> + Send + '_>,
    > {
        Box::pin(async move {
            send_proxy_upload(request, crate::net_config::configure(reqwest::Client::builder())).await
        })
    }
}

async fn send_proxy_upload(
    request: AstralProxyPutRequest,
    builder: reqwest::ClientBuilder,
) -> Result<AstralHttpResponse, String> {
    // 正文上传超时对齐移动端/管理端（服务端 90s 发送截止，客户端放宽到 120s）。
    // 初始地址已经过同源校验；禁止重定向，防止自定义 satoken 头和正文被转发到别处。
    let client = builder
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(120))
        .pool_max_idle_per_host(0)
        .build()
        .map_err(|_| "上传客户端构建失败".to_owned())?;
    // 生产网关/WAF 拦截非 GET/POST 方法（实测 PUT 返回 200+纯文本「非法请求」），统一 POST。
    let mut req = client.post(&request.url);
    if let Some(token) = request.satoken {
        req = req.header("satoken", token);
    }
    for (name, value) in request.headers {
        req = req.header(name, value);
    }
    let response = req
        .body(request.bytes)
        .send()
        .await
        .map_err(|error| format!("代传失败: {}", sanitize_err(error)))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|_| "代传响应读取失败".to_owned())?;
    Ok(AstralHttpResponse { status, body })
}

fn shared_http() -> reqwest::Client {
    crate::net_config::shared_async_client(&ASTRAL_HTTP, || {
        crate::net_config::configure(reqwest::Client::builder())
            .timeout(std::time::Duration::from_secs(15))
            .pool_max_idle_per_host(0)
            .build()
            .expect("reqwest client")
    })
}

#[cfg(test)]
#[path = "../../tests/source-engine-network-guard-astral.rs"]
mod native_session_regressions;

const ERR_SESSION_CHANGED: &str = "登录会话已变化，请重新同步";

#[derive(Default)]
struct NativeSessionState {
    token: Option<String>,
    expires_at: i64,
    handle: Option<crate::credential_store::SessionHandle>,
    vault: Option<Arc<crate::credential_store::SessionVault>>,
    epoch: u64,
    revision: u64,
    login_ticket: u64,
    verified_uid: Option<String>,
    like_ready: bool,
}

#[derive(Clone)]
struct SessionSnapshot {
    token: Option<String>,
    expires_at: i64,
    vault: Option<Arc<crate::credential_store::SessionVault>>,
    epoch: u64,
    revision: u64,
    login_ticket: u64,
}

#[derive(Clone)]
struct AstralCall<'a> {
    method: reqwest::Method,
    path: &'a str,
    query: &'a [(&'a str, &'a str)],
    json_body: Option<Value>,
    extra_headers: &'a [(&'a str, &'a str)],
    auth: bool,
}

pub struct AstralClient {
    base_url: String,
    transport: Arc<dyn AstralHttpTransport>,
    metadata: Option<ClientMetadata>,
    session: Arc<RwLock<NativeSessionState>>,
    mutations: tokio::sync::Mutex<()>,
    /// Refresh requests are single-flight; OS work never holds an async executor.
    refresh_lock: tokio::sync::Mutex<()>,
}

/// 直传凭证（后端 QtUploadTicketVo 的 Rust 镜像）
#[derive(Debug, Clone)]
pub struct UploadTicket {
    pub upload_url: String,
    pub method: String,
    pub form_field: Option<String>,
    pub upload_id: String,
    pub form_policy: Option<String>,
    pub form_authorization: Option<String>,
    epoch: u64,
    requires_like_owner: bool,
}

/// 上传计划（后端 QtUploadPlanVo 的 Rust 镜像）：mode=DIRECT 复用三段式直传；
/// mode=PROXY 走两段式代传（CUSTOM_HTTP 渠道，正文经 astral 网关）。
#[derive(Debug, Clone)]
pub struct UploadPlan {
    pub mode: String,
    pub ticket: Option<UploadTicket>,
    pub proxy_upload_id: String,
    pub proxy_content_path: String,
}

impl AstralClient {
    pub fn new(base_url: &str) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            transport: Arc::new(ReqwestAstralTransport),
            metadata: None,
            session: Arc::new(RwLock::new(NativeSessionState::default())),
            mutations: tokio::sync::Mutex::new(()),
            refresh_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub fn new_with_transport(base_url: &str, transport: Arc<dyn AstralHttpTransport>) -> Self {
        let mut client = Self::new(base_url);
        client.transport = transport;
        client
    }

    /// Explicit final-metadata injection; new/new_with_transport keep the actual
    /// lazy system metadata path. Session authority and transport behavior are shared.
    pub fn new_with_transport_and_metadata(
        base_url: &str,
        transport: Arc<dyn AstralHttpTransport>,
        metadata: ClientMetadata,
    ) -> Self {
        let mut client = Self::new_with_transport(base_url, transport);
        client.metadata = Some(metadata);
        client
    }

    fn basic_headers(&self) -> Vec<(String, String)> {
        let headers = match &self.metadata {
            Some(metadata) => client_headers_with_metadata(metadata),
            None => client_headers().to_vec(),
        };
        headers
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value))
            .collect()
    }

    pub fn set_session_store(
        &self,
        db: Option<Arc<crate::db::Database>>,
        data_root: &std::path::Path,
        store: Arc<dyn crate::credential_store::CredentialStore>,
    ) {
        let vault = Arc::new(crate::credential_store::SessionVault::new(
            db,
            data_root,
            &self.base_url,
            store,
        ));
        let mut state = self.session.write().expect("session lock");
        state.vault = Some(vault);
        state.token = None;
        state.handle = None;
        state.expires_at = 0;
        state.epoch += 1;
        state.login_ticket += 1;
        state.verified_uid = None;
        state.like_ready = false;
    }

    pub fn session_status(&self) -> Option<crate::credential_store::SessionStatus> {
        let state = self.session.read().expect("session lock");
        state.token.as_ref().filter(|token| !token.is_empty())?;
        state.handle.as_ref().map(|handle| handle.status)
    }

    fn snapshot(&self) -> SessionSnapshot {
        let state = self.session.read().expect("session lock");
        SessionSnapshot {
            token: state.token.clone(),
            expires_at: state.expires_at,
            vault: state.vault.clone(),
            epoch: state.epoch,
            revision: state.revision,
            login_ticket: state.login_ticket,
        }
    }

    fn begin_login(&self) -> SessionSnapshot {
        let mut state = self.session.write().expect("session lock");
        state.login_ticket += 1;
        SessionSnapshot {
            token: state.token.clone(),
            expires_at: state.expires_at,
            vault: state.vault.clone(),
            epoch: state.epoch,
            revision: state.revision,
            login_ticket: state.login_ticket,
        }
    }

    pub fn session_epoch(&self) -> u64 {
        self.session.read().expect("session lock").epoch
    }
    pub fn is_session_epoch_current(&self, epoch: u64) -> bool {
        self.session_epoch() == epoch
    }

    /// Lock order is session -> DB. The closure must not await or reacquire this lock.
    pub fn with_session_epoch<T>(
        &self,
        epoch: u64,
        commit: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let state = self
            .session
            .read()
            .map_err(|_| ERR_SESSION_CHANGED.to_owned())?;
        if state.epoch != epoch {
            return Err(ERR_SESSION_CHANGED.to_owned());
        }
        commit()
    }

    fn require_like_owner(state: &NativeSessionState) -> Result<(), String> {
        if !state.like_ready || state.token.is_none() {
            return Err("登录用户尚未核验，收藏同步已暂停".to_owned());
        }
        let uid = state
            .verified_uid
            .as_deref()
            .ok_or_else(|| "登录用户尚未核验，收藏同步已暂停".to_owned())?;
        if !state
            .vault
            .as_ref()
            .map_or(Ok(false), |vault| vault.like_owner_matches(uid))?
        {
            return Err("收藏归属与登录用户不匹配".to_owned());
        }
        Ok(())
    }

    /// Keep real owner verification and the local cloud commit under one READ fence.
    pub fn with_like_session_epoch<T>(
        &self,
        epoch: u64,
        commit: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let state = self
            .session
            .read()
            .map_err(|_| ERR_SESSION_CHANGED.to_owned())?;
        if state.epoch != epoch {
            return Err(ERR_SESSION_CHANGED.to_owned());
        }
        Self::require_like_owner(&state)?;
        commit()
    }

    pub fn with_like_owner_commit<T>(
        &self,
        epoch: u64,
        uid: &str,
        commit: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let mut state = self
            .session
            .write()
            .map_err(|_| ERR_SESSION_CHANGED.to_owned())?;
        if state.epoch != epoch {
            return Err(ERR_SESSION_CHANGED.to_owned());
        }
        state.like_ready = false;
        if state.token.is_none() || state.verified_uid.as_deref() != Some(uid) {
            return Err("登录用户尚未核验，收藏同步已暂停".to_owned());
        }
        let result = commit()?;
        let owner_matches = state
            .vault
            .as_ref()
            .map_or(Ok(false), |vault| vault.like_owner_matches(uid))?;
        if !owner_matches {
            return Err("收藏归属与登录用户不匹配".to_owned());
        }
        state.like_ready = true;
        Ok(result)
    }

    pub fn with_like_owner_invalidated<T>(
        &self,
        epoch: u64,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let mut state = self
            .session
            .write()
            .map_err(|_| ERR_SESSION_CHANGED.to_owned())?;
        if state.epoch != epoch {
            return Err(ERR_SESSION_CHANGED.to_owned());
        }
        state.like_ready = false;
        operation()
    }

    pub fn invalidate_like_owner_ready(&self, epoch: u64) -> Result<(), String> {
        self.with_like_owner_invalidated(epoch, || Ok(()))
    }

    async fn install_session(
        &self,
        auth: &AuthSession,
        expected: SessionSnapshot,
        new_login: bool,
    ) -> Result<crate::credential_store::SessionStatus, String> {
        let _mutation = self.mutations.lock().await;
        let session = self.session.clone();
        let token = auth.token.clone();
        let expires_at = auth.expires_at;
        tokio::task::spawn_blocking(move || {
            let prepared = if let Some(vault) = &expected.vault {
                vault.prepare(&token, expires_at)?
            } else {
                crate::credential_store::SessionHandle {
                    status: crate::credential_store::SessionStatus {
                        expires_at,
                        persistence: crate::credential_store::SessionPersistence::MemoryOnly,
                    },
                    target: None,
                }
            };
            let mut state = session
                .write()
                .map_err(|_| ERR_SESSION_CHANGED.to_owned())?;
            let stale = state.epoch != expected.epoch
                || if new_login {
                    state.login_ticket != expected.login_ticket
                } else {
                    state.revision != expected.revision
                };
            if stale {
                drop(state);
                if let Some(vault) = &expected.vault {
                    vault.abort(&prepared);
                }
                return Err(ERR_SESSION_CHANGED.to_owned());
            }
            // The DB reference and RAM session install share this WRITE guard.
            // with_session_epoch's READ guard makes a local commit indivisible.
            let old = if let Some(vault) = &expected.vault {
                match vault.commit(&prepared) {
                    Ok(old) => old,
                    Err(error) => {
                        drop(state);
                        vault.abort(&prepared);
                        return Err(error);
                    }
                }
            } else {
                None
            };
            let status = prepared.status;
            state.token = Some(token);
            state.expires_at = expires_at;
            state.handle = Some(prepared);
            state.revision += 1;
            if new_login {
                state.epoch += 1;
                state.verified_uid = None;
                state.like_ready = false;
            }
            drop(state);
            if let Some(vault) = &expected.vault {
                if vault.retire(old.as_deref()).is_err() {
                    log::warn!("旧会话凭据清理失败；数据库已解除旧引用");
                }
            }
            // Return the view belonging to this successful ticket, even if a
            // newer login installs another session before the caller resumes.
            Ok(status)
        })
        .await
        .map_err(|_| "会话存储任务失败".to_owned())?
    }

    pub async fn restore_session(
        &self,
    ) -> Result<Option<crate::credential_store::SessionStatus>, String> {
        let _mutation = self.mutations.lock().await;
        let expected = self.snapshot();
        let Some(vault) = expected.vault else {
            return Ok(None);
        };
        let session = self.session.clone();
        tokio::task::spawn_blocking(move || {
            let mut state = session
                .write()
                .map_err(|_| ERR_SESSION_CHANGED.to_owned())?;
            if state.epoch != expected.epoch || state.login_ticket != expected.login_ticket {
                return Err(ERR_SESSION_CHANGED.to_owned());
            }
            let restored = vault.restore(now_ms())?;
            let status = restored.as_ref().map(|restored| restored.handle.status);
            state.token = restored.as_ref().map(|restored| restored.token.clone());
            state.expires_at = status.map_or(0, |status| status.expires_at);
            state.handle = restored.map(|restored| restored.handle);
            state.epoch += 1;
            state.revision += 1;
            state.verified_uid = None;
            state.like_ready = false;
            Ok(status)
        })
        .await
        .map_err(|_| "会话恢复任务失败".to_owned())?
    }

    pub async fn clear_session(&self) -> Result<(), String> {
        self.clear_session_for_epoch(self.session_epoch()).await
    }

    pub async fn clear_session_for_epoch(&self, epoch: u64) -> Result<(), String> {
        self.clear_session_matching(epoch, None).await
    }

    async fn clear_session_for_stamp(&self, epoch: u64, revision: u64) -> Result<(), String> {
        self.clear_session_matching(epoch, Some(revision)).await
    }

    async fn clear_session_matching(
        &self,
        epoch: u64,
        revision: Option<u64>,
    ) -> Result<(), String> {
        let _mutation = self.mutations.lock().await;
        let session = self.session.clone();
        tokio::task::spawn_blocking(move || {
            let mut state = session
                .write()
                .map_err(|_| ERR_SESSION_CHANGED.to_owned())?;
            if state.epoch != epoch || revision.is_some_and(|wanted| state.revision != wanted) {
                return Err(ERR_SESSION_CHANGED.to_owned());
            }
            let vault = state.vault.clone();
            let target = state
                .handle
                .as_ref()
                .and_then(|handle| handle.target.clone());
            state.token = None;
            state.expires_at = 0;
            state.handle = None;
            state.epoch += 1;
            state.revision += 1;
            state.login_ticket += 1;
            state.verified_uid = None;
            state.like_ready = false;
            let result = vault
                .as_ref()
                .map_or(Ok(None), |vault| vault.clear_reference());
            drop(state);
            if let Some(vault) = vault {
                let old = result
                    .as_ref()
                    .ok()
                    .and_then(|old| old.as_deref())
                    .or(target.as_deref());
                let cleanup = vault.retire(old);
                result?;
                cleanup?;
            }
            Ok(())
        })
        .await
        .map_err(|_| "会话清理任务失败".to_owned())?
    }

    /// Native-memory compatibility only. Persistent lifecycle must use the vault APIs.
    pub fn set_token(&self, token: Option<String>) {
        let mut state = self.session.write().expect("session lock");
        state.token = token;
        if state.token.is_none() {
            state.expires_at = 0;
        }
        state.handle = state
            .token
            .as_ref()
            .map(|_| crate::credential_store::SessionHandle {
                status: crate::credential_store::SessionStatus {
                    expires_at: state.expires_at,
                    persistence: crate::credential_store::SessionPersistence::MemoryOnly,
                },
                target: None,
            });
        state.epoch += 1;
        state.revision += 1;
        state.login_ticket += 1;
        state.verified_uid = None;
        state.like_ready = false;
    }

    pub fn set_session(&self, auth: &AuthSession) {
        let mut state = self.session.write().expect("session lock");
        state.token = Some(auth.token.clone());
        state.expires_at = auth.expires_at;
        state.handle = Some(crate::credential_store::SessionHandle {
            status: crate::credential_store::SessionStatus {
                expires_at: auth.expires_at,
                persistence: crate::credential_store::SessionPersistence::MemoryOnly,
            },
            target: None,
        });
        state.epoch += 1;
        state.revision += 1;
        state.login_ticket += 1;
        state.verified_uid = None;
        state.like_ready = false;
    }

    // Kept while the Lead replaces the startup call; cannot create plaintext DB persistence.
    pub fn set_session_db(&self, _db: Option<Arc<crate::db::Database>>) {}

    #[cfg(test)]
    fn expires_at_ms(&self) -> i64 {
        self.session.read().expect("session lock").expires_at
    }
    pub fn has_token(&self) -> bool {
        self.token().as_ref().is_some_and(|token| !token.is_empty())
    }

    /// 共享的 HTTP 客户端（大文件下载等场景复用连接池）
    pub fn http(&self) -> reqwest::Client {
        shared_http()
    }

    /// 当前生效的后端基地址（音源包 manifest 直拼 URL 用）
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// 当前登录态下的 satoken（未登录 / 已登出为 None）。音源包 manifest 等
    /// 走 builtin_client 的自拼请求也需要随登录态附带 satoken。
    pub fn token(&self) -> Option<String> {
        self.session.read().expect("session lock").token.clone()
    }

    /// 刷新会话并落库（单飞）。三态语义见 [`RefreshOutcome`]；调用方负责按态
    /// 决定重试 / 放行 / 返回失效。
    async fn refresh_session(&self, captured: SessionSnapshot) -> RefreshOutcome {
        match self.refresh_captured(captured.clone()).await {
            Ok(_) => RefreshOutcome::Ok,
            Err(e) if is_definitive_refresh_rejection(&e) => {
                log::info!("[astral] 刷新被后端拒绝，撤销原本地登录态");
                RefreshOutcome::Invalid
            }
            Err(e) => RefreshOutcome::Network(e),
        }
    }

    /// 发请求并解 QtRestResp：code 0/200 → Ok(data)；其余 → Err(msg)。
    /// 返回的 data 可能为 Value::Null（后端 success(null)）。
    /// 收口处带两件事：主动续期（剩余 <5 分钟先刷新）+ 401 自动刷新后重试一次。
    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, &str)],
        json_body: Option<Value>,
        extra_headers: &[(&str, &str)],
        auth: bool,
    ) -> Result<Value, String> {
        self.request_captured(
            self.snapshot(),
            AstralCall {
                method,
                path,
                query,
                json_body,
                extra_headers,
                auth,
            },
        )
        .await
    }

    fn current_snapshot_for_epoch(&self, epoch: u64) -> Result<SessionSnapshot, String> {
        let captured = self.snapshot();
        if captured.epoch != epoch {
            return Err(ERR_SESSION_CHANGED.to_owned());
        }
        Ok(captured)
    }

    async fn request_for_epoch(&self, epoch: u64, call: AstralCall<'_>) -> Result<Value, String> {
        self.request_captured(self.current_snapshot_for_epoch(epoch)?, call)
            .await
    }

    async fn request_captured(
        &self,
        mut captured: SessionSnapshot,
        call: AstralCall<'_>,
    ) -> Result<Value, String> {
        self.request_with_snapshot(&mut captured, call).await
    }

    async fn request_with_snapshot(
        &self,
        captured: &mut SessionSnapshot,
        call: AstralCall<'_>,
    ) -> Result<Value, String> {
        let is_like = call
            .path
            .trim_start_matches('/')
            .starts_with("app/user/like/");
        {
            let state = self
                .session
                .read()
                .map_err(|_| ERR_SESSION_CHANGED.to_owned())?;
            if (call.auth || is_like) && state.epoch != captured.epoch {
                return Err(ERR_SESSION_CHANGED.to_owned());
            }
            if is_like {
                Self::require_like_owner(&state)?;
            }
        }
        if call.auth
            && !refresh_path(call.path)
            && captured.token.is_some()
            && captured.expires_at > 0
            && should_proactive_refresh(captured.expires_at, now_ms())
        {
            match self.refresh_session(captured.clone()).await {
                RefreshOutcome::Ok => {
                    *captured = self.current_snapshot_for_epoch(captured.epoch)?
                }
                RefreshOutcome::Invalid => return Err(ERR_UNAUTHORIZED.to_owned()),
                RefreshOutcome::Network(_) => {}
            }
        }
        let out = self
            .request_once_captured(captured.clone(), call.clone())
            .await;
        if call.auth
            && !refresh_path(call.path)
            && captured.token.is_some()
            && out.as_ref().is_err_and(|error| is_auth_error(error))
        {
            match self.refresh_session(captured.clone()).await {
                RefreshOutcome::Ok => {
                    *captured = self.current_snapshot_for_epoch(captured.epoch)?;
                    return self.request_once_captured(captured.clone(), call).await;
                }
                RefreshOutcome::Invalid => return out,
                RefreshOutcome::Network(error) => return Err(error),
            }
        }
        out
    }

    async fn request_once_captured(
        &self,
        captured: SessionSnapshot,
        call: AstralCall<'_>,
    ) -> Result<Value, String> {
        let AstralCall {
            method,
            path,
            query,
            json_body,
            extra_headers,
            auth,
        } = call;
        let is_like = path.trim_start_matches('/').starts_with("app/user/like/");
        let url = format!("{}/{}", self.base_url, path.trim_start_matches('/'));
        let mut headers: Vec<(String, String)> = self.basic_headers();
        headers.extend(
            extra_headers
                .iter()
                .map(|(name, value)| ((*name).to_owned(), (*value).to_owned())),
        );
        let response_task = {
            let state = self
                .session
                .read()
                .map_err(|_| ERR_SESSION_CHANGED.to_owned())?;
            if (auth || is_like) && state.epoch != captured.epoch {
                return Err(ERR_SESSION_CHANGED.to_owned());
            }
            if is_like {
                Self::require_like_owner(&state)?;
            }
            self.transport.send(AstralHttpRequest {
                method,
                url,
                query: query
                    .iter()
                    .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
                    .collect(),
                json_body,
                headers,
                satoken: if auth { captured.token.clone() } else { None },
            })
        };
        let response = response_task.await?;
        if auth || is_like {
            let state = self
                .session
                .read()
                .map_err(|_| ERR_SESSION_CHANGED.to_owned())?;
            if state.epoch != captured.epoch {
                return Err(ERR_SESSION_CHANGED.to_owned());
            }
            if path.trim_start_matches('/') == "app/user/me" && state.revision != captured.revision
            {
                return Err(ERR_SESSION_CHANGED.to_owned());
            }
            if is_like {
                Self::require_like_owner(&state)?;
            }
        }
        Self::decode_response(response)
    }

    fn decode_response(response: AstralHttpResponse) -> Result<Value, String> {
        let status = reqwest::StatusCode::from_u16(response.status)
            .map_err(|_| "Astral 响应状态无效".to_owned())?;
        let body: Value = serde_json::from_str(&response.body)
            .map_err(|_| format!("Astral 响应解析失败({status})"))?;
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(ERR_UNAUTHORIZED.to_string());
        }
        let code = body.get("code").and_then(Value::as_i64).unwrap_or(200);
        // 有的后端把 token 失效放在业务码里回（HTTP 200 + code 401），
        // 一并归一，免得调用方要认两种判据。
        if code == 401 {
            return Err(ERR_UNAUTHORIZED.to_string());
        }
        if code != 0 && code != 200 {
            let msg = body
                .get("msg")
                .or_else(|| body.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("未知业务错误")
                .to_string();
            return Err(format!("Astral 业务错误({code}): {msg}"));
        }
        Ok(body.get("data").cloned().unwrap_or(Value::Null))
    }

    async fn get(&self, path: &str, query: &[(&str, &str)], auth: bool) -> Result<Value, String> {
        self.request(reqwest::Method::GET, path, query, None, &[], auth)
            .await
    }

    /// 免认证 POST（音源包装载结果上报等公开端点）
    pub async fn post_json_public(&self, path: &str, body: Value) -> Result<Value, String> {
        self.request(reqwest::Method::POST, path, &[], Some(body), &[], false)
            .await
    }

    async fn post_json(
        &self,
        path: &str,
        body: Value,
        extra_headers: &[(&'static str, String)],
        auth: bool,
    ) -> Result<Value, String> {
        let headers: Vec<(&str, &str)> = extra_headers
            .iter()
            .map(|(k, v)| (*k, v.as_str()))
            .collect();
        self.request(reqwest::Method::POST, path, &[], Some(body), &headers, auth)
            .await
    }

    // ---------- 账号（接口契约对齐 qt-uniappx services/music-api.ts AccountApi） ----------

    /// 登录。成功即把 token 装进客户端（后续请求自动带 satoken）。
    pub async fn login(
        &self,
        username: &str,
        password: &str,
    ) -> Result<crate::credential_store::SessionStatus, String> {
        let expected = self.begin_login();
        let data = self
            .post_json(
                "app/user/login",
                json!({ "username": username, "password": password }),
                &[],
                false,
            )
            .await?;
        let session = parse_session(&data)?;
        self.install_session(&session, expected, true).await
    }

    /// 注册并登录（后端注册成功后直接返回 token）。
    /// 后端的 QtRegisterDto 把 passwordConfirm 标了 @NotBlank，且会比对两次密码，
    /// 所以必须原样上送；注册接口没有验证码字段，前端不再传 code。
    pub async fn register(
        &self,
        username: &str,
        password: &str,
        password_confirm: &str,
        email: Option<&str>,
        nickname: Option<&str>,
    ) -> Result<crate::credential_store::SessionStatus, String> {
        let expected = self.begin_login();
        let mut body = json!({
            "username": username,
            "password": password,
            "passwordConfirm": password_confirm,
        });
        if let Some(e) = email.filter(|s| !s.is_empty()) {
            body["email"] = json!(e);
        }
        // 昵称可选：留空时后端把昵称默认成用户名（QtUserService.register），
        // 空串不上送，免得把「用户没填」和「用户想叫空名字」混成一件事。
        if let Some(n) = nickname.filter(|s| !s.is_empty()) {
            body["nickname"] = json!(n);
        }
        let data = self
            .post_json("app/user/register", body, &[], false)
            .await?;
        let session = parse_session(&data)?;
        self.install_session(&session, expected, true).await
    }

    /// 当前登录用户信息（app/user/me）；只有 Native 收到的身份可用于归属提交。
    pub async fn me(&self) -> Result<Value, String> {
        self.me_for_epoch(self.session_epoch()).await
    }

    pub async fn me_for_epoch(&self, epoch: u64) -> Result<Value, String> {
        let mut captured = self.current_snapshot_for_epoch(epoch)?;
        let result = self
            .request_with_snapshot(
                &mut captured,
                AstralCall {
                    method: reqwest::Method::GET,
                    path: "app/user/me",
                    query: &[],
                    json_body: None,
                    extra_headers: &[],
                    auth: true,
                },
            )
            .await;
        let result = {
            let mut state = self
                .session
                .write()
                .map_err(|_| ERR_SESSION_CHANGED.to_owned())?;
            if state.epoch != captured.epoch || state.revision != captured.revision {
                return Err(ERR_SESSION_CHANGED.to_owned());
            }
            state.like_ready = false;
            state.verified_uid = None;
            match result {
                Ok(data) => {
                    let uid = [
                        data.get("id"),
                        data.get("uid"),
                        data.pointer("/user/id"),
                        data.pointer("/user/uid"),
                    ]
                    .into_iter()
                    .flatten()
                    .find_map(|id| match id {
                        Value::String(value) if !value.trim().is_empty() => {
                            Some(value.trim().to_owned())
                        }
                        Value::Number(value) => {
                            value.as_u64().filter(|id| *id > 0).map(|id| id.to_string())
                        }
                        _ => None,
                    })
                    .ok_or_else(|| "登录用户标识无效，收藏同步已暂停".to_owned())?;
                    state.verified_uid = Some(uid);
                    Ok(data)
                }
                Err(error) => Err(error),
            }
        };
        // The final authenticated attempt can still reject a successfully
        // renewed token. Native owns revocation; a caller's epoch-only clear
        // would race with another renewal after this method returns.
        if result
            .as_ref()
            .is_err_and(|error| error == ERR_UNAUTHORIZED)
        {
            self.clear_session_for_stamp(captured.epoch, captured.revision)
                .await?;
        }
        result
    }

    pub async fn logout_for_epoch(&self, epoch: u64) -> Result<(), String> {
        let captured = self.current_snapshot_for_epoch(epoch)?;
        let local = self.clear_session_for_epoch(epoch).await;
        if local
            .as_ref()
            .is_err_and(|error| error == ERR_SESSION_CHANGED)
            || captured.token.is_none()
        {
            return local;
        }
        // Logout is the sole detached authenticated request: local authority is
        // already revoked, and this immutable token can only revoke the old actor.
        let remote = self
            .transport
            .send(AstralHttpRequest {
                method: reqwest::Method::POST,
                url: format!("{}/app/user/logout", self.base_url),
                query: Vec::new(),
                json_body: Some(json!({})),
                headers: self.basic_headers(),
                satoken: captured.token,
            })
            .await
            .and_then(Self::decode_response)
            .map(|_| ());
        local.and(remote)
    }

    /// 退出登录：无论后端是否成功，本地 token 都会清掉
    pub async fn logout(&self) -> Result<(), String> {
        self.logout_for_epoch(self.session_epoch()).await
    }

    /// 用 refresh token 换新会话（需要先装着旧 token，后端按 satoken 识别）。
    /// 直走 request_once 而非 request 收口：刷新接口不允许再套「续期/401 再
    /// 刷新」逻辑（运行时靠 refresh_path 拦住，静态上也要打断 async 递归环）。
    pub async fn refresh(&self) -> Result<crate::credential_store::SessionStatus, String> {
        self.refresh_for_epoch(self.session_epoch()).await
    }

    pub async fn refresh_for_epoch(
        &self,
        epoch: u64,
    ) -> Result<crate::credential_store::SessionStatus, String> {
        let captured = self.snapshot();
        if captured.epoch != epoch {
            return Err(ERR_SESSION_CHANGED.to_owned());
        }
        self.refresh_captured(captured).await
    }

    async fn refresh_captured(
        &self,
        captured: SessionSnapshot,
    ) -> Result<crate::credential_store::SessionStatus, String> {
        let _flight = self.refresh_lock.lock().await;
        {
            let state = self
                .session
                .read()
                .map_err(|_| ERR_SESSION_CHANGED.to_owned())?;
            if state.epoch != captured.epoch {
                return Err(ERR_SESSION_CHANGED.to_owned());
            }
            if state.token.is_none() {
                return Err(ERR_UNAUTHORIZED.to_owned());
            }
            if state.revision != captured.revision {
                return state
                    .handle
                    .as_ref()
                    .map(|handle| handle.status)
                    .ok_or_else(|| ERR_SESSION_CHANGED.to_owned());
            }
        }
        let reply = self
            .request_once_captured(
                captured.clone(),
                AstralCall {
                    method: reqwest::Method::POST,
                    path: "app/user/refresh",
                    query: &[],
                    json_body: Some(json!({})),
                    extra_headers: &[],
                    auth: true,
                },
            )
            .await;
        let session = match reply.and_then(|data| parse_session(&data)) {
            Ok(session) => session,
            Err(error) if is_definitive_refresh_rejection(&error) => {
                self.clear_session_for_stamp(captured.epoch, captured.revision)
                    .await?;
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        self.install_session(&session, captured, false).await
    }

    /// 发送邮箱验证码。`scene` 是邮件模板业务标识（见 [`MAIL_SCENE_CHANGE_PW`]），
    /// 不是邮件正文：它同时决定模板渲染和验证码的存取 key。
    pub async fn send_email_code(&self, email: &str, scene: &str) -> Result<Value, String> {
        self.post_json(
            "app/user/email",
            json!({ "email": email, "body": scene }),
            &[],
            false,
        )
        .await
    }

    /// 邮箱验证码改密码
    pub async fn change_password(
        &self,
        email: &str,
        password: &str,
        code: &str,
    ) -> Result<Value, String> {
        self.post_json(
            "app/user/changePass",
            json!({ "email": email, "password": password, "code": code }),
            &[],
            false,
        )
        .await
    }

    /// 歌单收藏/取消（app/user/like/playlist）
    pub async fn like_playlist(
        &self,
        action: &str,
        pid: &str,
        platform: &str,
        name: &str,
        pic: Option<&str>,
    ) -> Result<i64, String> {
        let mut body = serde_json::json!({
            "action": action,
            "pid": pid,
            "platform": platform,
            "name": name,
        });
        if let Some(p) = pic.filter(|s| !s.is_empty()) {
            body["picUrl"] = serde_json::json!(p);
        }
        let data = self
            .post_json("app/user/like/playlist", body, &[], true)
            .await?;
        Ok(seq_of(&data))
    }

    /// 增量拉取收藏变更：返回 (changes, maxSeq)。游标存在调用方。
    pub async fn like_changes(&self, since: i64) -> Result<(Vec<Value>, i64), String> {
        let data = self
            .get(
                "app/user/like/changes",
                &[("since", &since.to_string())],
                true,
            )
            .await?;
        let changes = data
            .get("changes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let max_seq = data.get("maxSeq").and_then(Value::as_i64).unwrap_or(since);
        Ok((changes, max_seq))
    }

    /// 全量分页拉取（首次登录 / 游标丢失时兜底）。返回 { songs, playlists, maxSeq } 原样。
    pub async fn like_list(&self, page: i64, size: i64) -> Result<Value, String> {
        self.get(
            "app/user/like/list",
            &[("page", &page.to_string()), ("size", &size.to_string())],
            true,
        )
        .await
    }

    /// 更新个人资料（昵称 / 头像等字段由后端约定，这里原样透传）
    pub async fn update_profile(&self, patch: Value) -> Result<Value, String> {
        self.update_profile_for_epoch(self.session_epoch(), patch)
            .await
    }

    pub async fn update_profile_for_epoch(
        &self,
        epoch: u64,
        patch: Value,
    ) -> Result<Value, String> {
        self.request_for_epoch(
            epoch,
            AstralCall {
                method: reqwest::Method::POST,
                path: "app/user/update",
                query: &[],
                json_body: Some(patch),
                extra_headers: &[],
                auth: true,
            },
        )
        .await
    }

    pub async fn update_user_for_epoch(&self, epoch: u64, patch: Value) -> Result<Value, String> {
        self.update_profile_for_epoch(epoch, patch).await
    }

    // Explicit epoch methods pass their captured session to the actual HTTP
    // adapter; they never check a wrapper and then call an unbound delegate.
    pub async fn like_playlist_for_epoch(
        &self,
        epoch: u64,
        action: &str,
        pid: &str,
        platform: &str,
        name: &str,
        pic: Option<&str>,
    ) -> Result<i64, String> {
        let mut body = json!({ "action": action, "pid": pid, "platform": platform, "name": name });
        if let Some(pic) = pic.filter(|pic| !pic.is_empty()) {
            body["picUrl"] = json!(pic);
        }
        let data = self
            .request_for_epoch(
                epoch,
                AstralCall {
                    method: reqwest::Method::POST,
                    path: "app/user/like/playlist",
                    query: &[],
                    json_body: Some(body),
                    extra_headers: &[],
                    auth: true,
                },
            )
            .await?;
        Ok(seq_of(&data))
    }

    pub async fn like_changes_for_epoch(
        &self,
        epoch: u64,
        since: i64,
    ) -> Result<(Vec<Value>, i64), String> {
        let since_text = since.to_string();
        let query = [("since", since_text.as_str())];
        let data = self
            .request_for_epoch(
                epoch,
                AstralCall {
                    method: reqwest::Method::GET,
                    path: "app/user/like/changes",
                    query: &query,
                    json_body: None,
                    extra_headers: &[],
                    auth: true,
                },
            )
            .await?;
        let changes = data
            .get("changes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let max_seq = data.get("maxSeq").and_then(Value::as_i64).unwrap_or(since);
        Ok((changes, max_seq))
    }

    pub async fn like_list_for_epoch(
        &self,
        epoch: u64,
        page: i64,
        size: i64,
    ) -> Result<Value, String> {
        let page_text = page.to_string();
        let size_text = size.to_string();
        let query = [("page", page_text.as_str()), ("size", size_text.as_str())];
        self.request_for_epoch(
            epoch,
            AstralCall {
                method: reqwest::Method::GET,
                path: "app/user/like/list",
                query: &query,
                json_body: None,
                extra_headers: &[],
                auth: true,
            },
        )
        .await
    }

    pub async fn like_song_for_epoch(
        &self,
        epoch: u64,
        payload: LikeSongPayload<'_>,
    ) -> Result<i64, String> {
        let data = self
            .request_for_epoch(
                epoch,
                AstralCall {
                    method: reqwest::Method::POST,
                    path: "app/user/like/song",
                    query: &[],
                    json_body: Some(like_song_body(&payload)),
                    extra_headers: &[],
                    auth: true,
                },
            )
            .await?;
        Ok(seq_of(&data))
    }

    pub async fn like_batch_for_epoch(&self, epoch: u64, ops: Vec<Value>) -> Result<i64, String> {
        let data = self
            .request_for_epoch(
                epoch,
                AstralCall {
                    method: reqwest::Method::POST,
                    path: "app/user/like/batch",
                    query: &[],
                    json_body: Some(json!({ "ops": ops })),
                    extra_headers: &[],
                    auth: true,
                },
            )
            .await?;
        Ok(seq_of(&data))
    }

    // Caller identity is carried into the actual transport and every file stage.
    // File preflight remains native; the central command must not duplicate it.
    pub async fn avatar_ticket_for_epoch(
        &self,
        epoch: u64,
        file_name: &str,
        content_type: &str,
        size_bytes: i64,
    ) -> Result<UploadTicket, String> {
        let data = self.request_for_epoch(epoch, AstralCall {
            method: reqwest::Method::POST, path: "app/user/avatar/ticket", query: &[],
            json_body: Some(json!({ "fileName": file_name, "contentType": content_type, "sizeBytes": size_bytes })), extra_headers: &[], auth: true,
        }).await?;
        Self::parse_upload_ticket(&data, epoch, false)
    }

    pub async fn avatar_complete_for_epoch(
        &self,
        epoch: u64,
        upload_id: &str,
    ) -> Result<String, String> {
        let data = self
            .request_for_epoch(
                epoch,
                AstralCall {
                    method: reqwest::Method::POST,
                    path: "app/user/avatar/complete",
                    query: &[],
                    json_body: Some(json!({ "uploadId": upload_id })),
                    extra_headers: &[],
                    auth: true,
                },
            )
            .await?;
        Self::url_of(&data)
    }

    pub async fn cover_ticket_for_epoch(
        &self,
        epoch: u64,
        pid: &str,
        platform: &str,
        file_name: &str,
        content_type: &str,
        size_bytes: i64,
    ) -> Result<UploadTicket, String> {
        let path = format!("app/user/like/playlist/{pid}/cover/ticket");
        let data = self.request_for_epoch(epoch, AstralCall {
            method: reqwest::Method::POST, path: &path, query: &[],
            json_body: Some(json!({ "platform": platform, "fileName": file_name, "contentType": content_type, "sizeBytes": size_bytes })), extra_headers: &[], auth: true,
        }).await?;
        Self::parse_upload_ticket(&data, epoch, true)
    }

    pub async fn cover_complete_for_epoch(
        &self,
        epoch: u64,
        pid: &str,
        platform: &str,
        upload_id: &str,
    ) -> Result<String, String> {
        let path = format!("app/user/like/playlist/{pid}/cover/complete");
        let query = [("platform", platform)];
        let data = self
            .request_for_epoch(
                epoch,
                AstralCall {
                    method: reqwest::Method::POST,
                    path: &path,
                    query: &query,
                    json_body: Some(json!({ "uploadId": upload_id })),
                    extra_headers: &[],
                    auth: true,
                },
            )
            .await?;
        Self::url_of(&data)
    }

    pub async fn cover_clear_for_epoch(
        &self,
        epoch: u64,
        pid: &str,
        platform: &str,
    ) -> Result<(), String> {
        let path = format!("app/user/like/playlist/{pid}/cover");
        let query = [("platform", platform)];
        self.request_for_epoch(
            epoch,
            AstralCall {
                method: reqwest::Method::DELETE,
                path: &path,
                query: &query,
                json_body: None,
                extra_headers: &[],
                auth: true,
            },
        )
        .await?;
        Ok(())
    }

    pub async fn direct_upload_for_epoch(
        &self,
        epoch: u64,
        ticket: &UploadTicket,
        file_name: &str,
        content_type: &str,
        bytes: Vec<u8>,
    ) -> Result<(), String> {
        let pending = {
            let state = self.session.read().map_err(|_| "会话锁失败".to_owned())?;
            if state.epoch != epoch || ticket.epoch != epoch {
                return Err(ERR_SESSION_CHANGED.to_owned());
            }
            if state.token.is_none() {
                return Err("尚未登录，请先登录后再上传".to_owned());
            }
            if ticket.requires_like_owner {
                Self::require_like_owner(&state)?;
            }
            self.transport.upload(AstralUploadRequest {
                ticket: ticket.clone(),
                file_name: file_name.to_owned(),
                content_type: content_type.to_owned(),
                bytes,
            })
        };
        let result = pending.await;
        let state = self
            .session
            .read()
            .map_err(|_| ERR_SESSION_CHANGED.to_owned())?;
        if state.epoch != epoch || state.token.is_none() {
            return Err(ERR_SESSION_CHANGED.to_owned());
        }
        if ticket.requires_like_owner {
            Self::require_like_owner(&state)?;
        }
        result
    }

    // ---------- 上传计划（2026-11 代传支持） ----------
    //
    // 目录首选渠道是 CUSTOM_HTTP（如 ImgBB）时，直传凭证会把上游凭据泄露给
    // 客户端，后端只发两段式代传计划；DIRECT 分支保持三段式直传不变。

    fn new_upload_idempotency_key() -> String {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!("qt-pc-upload-{}-{}", now_ms(), seq)
    }

    fn parse_upload_plan(
        data: &Value,
        epoch: u64,
        requires_like_owner: bool,
    ) -> Result<UploadPlan, String> {
        let get_str = |k: &str| {
            data.get(k)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let mode = get_str("mode").ok_or("计划缺少 mode")?;
        if mode == "PROXY" {
            let upload_id = get_str("uploadId").ok_or("计划缺少 uploadId")?;
            let content_path = get_str("contentPath").ok_or("计划缺少 contentPath")?;
            return Ok(UploadPlan {
                mode,
                ticket: None,
                proxy_upload_id: upload_id,
                proxy_content_path: content_path,
            });
        }
        if mode != "DIRECT" {
            return Err(format!("不支持的上传模式 {mode}"));
        }
        let ticket = data.get("ticket").ok_or("计划缺少直传凭证")?;
        let ticket = Self::parse_upload_ticket(ticket, epoch, requires_like_owner)?;
        Ok(UploadPlan {
            mode,
            ticket: Some(ticket),
            proxy_upload_id: String::new(),
            proxy_content_path: String::new(),
        })
    }

    pub async fn avatar_upload_plan_for_epoch(
        &self,
        epoch: u64,
        file_name: &str,
        content_type: &str,
        size_bytes: i64,
        idempotency_key: &str,
    ) -> Result<UploadPlan, String> {
        let data = self.request_for_epoch(epoch, AstralCall {
            method: reqwest::Method::POST, path: "app/user/avatar/upload-plan", query: &[],
            json_body: Some(json!({ "fileName": file_name, "contentType": content_type, "sizeBytes": size_bytes, "idempotencyKey": idempotency_key })), extra_headers: &[], auth: true,
        }).await?;
        Self::parse_upload_plan(&data, epoch, false)
    }

    // 8 个参数与同区域 cover_ticket_for_epoch 对称（pid/platform 挂路径，其余为计划要素），
    // 收拢成 struct 会破坏本文件既有调用风格。
    #[allow(clippy::too_many_arguments)]
    pub async fn cover_upload_plan_for_epoch(
        &self,
        epoch: u64,
        pid: &str,
        platform: &str,
        file_name: &str,
        content_type: &str,
        size_bytes: i64,
        idempotency_key: &str,
    ) -> Result<UploadPlan, String> {
        let path = format!("app/user/like/playlist/{pid}/cover/upload-plan");
        let data = self.request_for_epoch(epoch, AstralCall {
            method: reqwest::Method::POST, path: &path, query: &[],
            json_body: Some(json!({ "platform": platform, "fileName": file_name, "contentType": content_type, "sizeBytes": size_bytes, "idempotencyKey": idempotency_key })), extra_headers: &[], auth: true,
        }).await?;
        Self::parse_upload_plan(&data, epoch, true)
    }

    /// contentPath 以 / 开头时相对站点根解析，否则相对 API 目录解析。
    /// base_url 已含 /api/v1，不能再把 /api/v1/... 直接拼到它后面。
    /// 代传会携带登录凭据，只允许同源 HTTP(S) 路径。
    fn proxy_upload_url(&self, content_path: &str) -> Result<String, String> {
        let invalid = || "上传计划中的正文地址无效".to_owned();
        let base = reqwest::Url::parse(&format!("{}/", self.base_url.trim_end_matches('/')))
            .map_err(|_| invalid())?;
        if content_path.is_empty()
            || content_path.starts_with("//")
            || content_path.contains('\\')
            || content_path.contains("://")
        {
            return Err(invalid());
        }
        let url = base.join(content_path).map_err(|_| invalid())?;
        if !matches!(url.scheme(), "http" | "https")
            || url.origin() != base.origin()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid());
        }
        Ok(url.into())
    }

    /// 两段式代传正文：原始字节 POST astral 网关，复用插件两段式状态机；
    /// state=CREATED 表示本次渠道失败已切换备用渠道，重发同一正文（上限 3 次与服务端 MAX_ATTEMPTS 对齐）。
    pub async fn proxy_upload_content_for_epoch(
        &self,
        epoch: u64,
        content_path: &str,
        content_type: &str,
        bytes: Vec<u8>,
    ) -> Result<(), String> {
        let url = self.proxy_upload_url(content_path)?;
        for _ in 0..3 {
            let satoken = {
                let state = self
                    .session
                    .read()
                    .map_err(|_| ERR_SESSION_CHANGED.to_owned())?;
                if state.epoch != epoch {
                    return Err(ERR_SESSION_CHANGED.to_owned());
                }
                state
                    .token
                    .clone()
                    .ok_or("尚未登录，请先登录后再上传".to_owned())?
            };
            let mut headers: Vec<(String, String)> = self.basic_headers();
            headers.push(("Content-Type".to_owned(), content_type.to_owned()));
            let response = self
                .transport
                .proxy_put(AstralProxyPutRequest {
                    url: url.clone(),
                    satoken: Some(satoken),
                    headers,
                    bytes: bytes.clone(),
                })
                .await?;
            if response.status < 200 || response.status >= 300 {
                return Err(format!("代传失败（HTTP {}）", response.status));
            }
            let value: Value =
                serde_json::from_str(&response.body).map_err(|_| "代传回执格式异常".to_owned())?;
            if value.get("code").and_then(Value::as_i64) != Some(200) {
                let msg = value
                    .get("msg")
                    .and_then(Value::as_str)
                    .unwrap_or("代传失败");
                return Err(msg.to_owned());
            }
            let state = value
                .get("data")
                .and_then(|data| data.get("state"))
                .and_then(Value::as_str)
                .unwrap_or("");
            match state {
                "COMMITTED" => return Ok(()),
                "CREATED" => continue,
                other => {
                    let label = if other.is_empty() {
                        "状态未知"
                    } else {
                        other
                    };
                    return Err(format!("文件发送失败（{label}）"));
                }
            }
        }
        Err("上传渠道暂不可用，请稍后重试".to_owned())
    }

    pub async fn avatar_apply_for_epoch(
        &self,
        epoch: u64,
        upload_id: &str,
    ) -> Result<String, String> {
        let data = self
            .request_for_epoch(
                epoch,
                AstralCall {
                    method: reqwest::Method::POST,
                    path: "app/user/avatar/apply",
                    query: &[],
                    json_body: Some(json!({ "uploadId": upload_id })),
                    extra_headers: &[],
                    auth: true,
                },
            )
            .await?;
        Self::url_of(&data)
    }

    pub async fn cover_apply_for_epoch(
        &self,
        epoch: u64,
        pid: &str,
        platform: &str,
        upload_id: &str,
    ) -> Result<String, String> {
        let path = format!("app/user/like/playlist/{pid}/cover/apply");
        let query = [("platform", platform)];
        let data = self
            .request_for_epoch(
                epoch,
                AstralCall {
                    method: reqwest::Method::POST,
                    path: &path,
                    query: &query,
                    json_body: Some(json!({ "uploadId": upload_id })),
                    extra_headers: &[],
                    auth: true,
                },
            )
            .await?;
        Self::url_of(&data)
    }

    pub async fn upload_avatar_file_for_epoch(
        &self,
        epoch: u64,
        path: &str,
    ) -> Result<String, String> {
        self.current_snapshot_for_epoch(epoch)?;
        let (name, mime, _) = Self::image_meta(path, "avatar")?;
        // 先确认图片可读再创建上传任务，避免本地读盘失败也占用服务端意图名额。
        let bytes = Self::read_image_bytes(path).await?;
        let size = bytes.len() as i64;
        let idempotency_key = Self::new_upload_idempotency_key();
        let plan = self
            .avatar_upload_plan_for_epoch(epoch, &name, mime, size, &idempotency_key)
            .await?;
        if plan.mode == "PROXY" {
            let upload_id = plan.proxy_upload_id;
            self.proxy_upload_content_for_epoch(epoch, &plan.proxy_content_path, mime, bytes)
                .await?;
            return self.avatar_apply_for_epoch(epoch, &upload_id).await;
        }
        let ticket = plan.ticket.ok_or("计划缺少直传凭证")?;
        self.direct_upload_for_epoch(epoch, &ticket, &name, mime, bytes)
            .await?;
        self.avatar_complete_for_epoch(epoch, &ticket.upload_id)
            .await
    }

    pub async fn upload_cover_file_for_epoch(
        &self,
        epoch: u64,
        pid: &str,
        platform: &str,
        path: &str,
    ) -> Result<String, String> {
        self.with_like_session_epoch(epoch, || Ok(()))?;
        let (name, mime, _) = Self::image_meta(path, "cover")?;
        let bytes = Self::read_image_bytes(path).await?;
        let size = bytes.len() as i64;
        let idempotency_key = Self::new_upload_idempotency_key();
        let plan = self
            .cover_upload_plan_for_epoch(epoch, pid, platform, &name, mime, size, &idempotency_key)
            .await?;
        if plan.mode == "PROXY" {
            let upload_id = plan.proxy_upload_id;
            self.proxy_upload_content_for_epoch(epoch, &plan.proxy_content_path, mime, bytes)
                .await?;
            return self
                .cover_apply_for_epoch(epoch, pid, platform, &upload_id)
                .await;
        }
        let ticket = plan.ticket.ok_or("计划缺少直传凭证")?;
        self.direct_upload_for_epoch(epoch, &ticket, &name, mime, bytes)
            .await?;
        self.cover_complete_for_epoch(epoch, pid, platform, &ticket.upload_id)
            .await
    }

    // ---------- 媒体直传（UPDATE_DESIGN.md §5.2/§5.3） ----------
    //
    // 文件正文不经过 Astral 服务器：客户端先取签发凭证（ticket），
    // 凭证里带存储端的直传地址与表单字段，传完再拿 uploadId 回执登记。
    // 直传必须走 Rust：CSP 不放开外部域名，WebView 发不了这个请求。

    fn parse_upload_ticket(
        data: &Value,
        epoch: u64,
        requires_like_owner: bool,
    ) -> Result<UploadTicket, String> {
        let get_str = |k: &str| {
            data.get(k)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        Ok(UploadTicket {
            upload_url: get_str("uploadUrl").ok_or("凭证缺少 uploadUrl")?,
            method: get_str("method").unwrap_or_else(|| "PUT".into()),
            form_field: get_str("formField"),
            upload_id: get_str("uploadId").ok_or("凭证缺少 uploadId")?,
            form_policy: get_str("formPolicy"),
            form_authorization: get_str("formAuthorization"),
            epoch,
            requires_like_owner,
        })
    }

    fn url_of(data: &Value) -> Result<String, String> {
        Ok(data
            .get("url")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or("回执缺少 url")?
            .to_string())
    }

    /// 头像直传凭证（app/user/avatar/ticket）
    pub async fn avatar_ticket(
        &self,
        file_name: &str,
        content_type: &str,
        size_bytes: i64,
    ) -> Result<UploadTicket, String> {
        self.avatar_ticket_for_epoch(self.session_epoch(), file_name, content_type, size_bytes)
            .await
    }

    /// 头像回执登记（app/user/avatar/complete），返回头像 URL（即版本）。
    pub async fn avatar_complete(&self, upload_id: &str) -> Result<String, String> {
        let data = self
            .post_json(
                "app/user/avatar/complete",
                json!({ "uploadId": upload_id }),
                &[],
                true,
            )
            .await?;
        Self::url_of(&data)
    }

    /// 歌单封面直传凭证（app/user/like/playlist/{pid}/cover/ticket）
    pub async fn cover_ticket(
        &self,
        pid: &str,
        platform: &str,
        file_name: &str,
        content_type: &str,
        size_bytes: i64,
    ) -> Result<UploadTicket, String> {
        self.cover_ticket_for_epoch(
            self.session_epoch(),
            pid,
            platform,
            file_name,
            content_type,
            size_bytes,
        )
        .await
    }

    /// 歌单封面回执登记，返回封面 URL。
    pub async fn cover_complete(
        &self,
        pid: &str,
        platform: &str,
        upload_id: &str,
    ) -> Result<String, String> {
        let data = self
            .request(
                reqwest::Method::POST,
                &format!("app/user/like/playlist/{}/cover/complete", pid),
                &[("platform", platform)],
                Some(json!({ "uploadId": upload_id })),
                &[],
                true,
            )
            .await?;
        Self::url_of(&data)
    }

    /// 清除歌单封面（app/user/like/playlist/{pid}/cover DELETE），回到默认资源。
    pub async fn cover_clear(&self, pid: &str, platform: &str) -> Result<(), String> {
        self.request(
            reqwest::Method::DELETE,
            &format!("app/user/like/playlist/{}/cover", pid),
            &[("platform", platform)],
            None,
            &[],
            true,
        )
        .await?;
        Ok(())
    }

    /// 把文件正文按凭证描述的形态直传存储端。
    /// PUT = 预签名地址（S3 系/COS/OSS，body 即文件字节）；
    /// POST multipart = Worker 直传（TELEGRAM）或又拍云表单（额外带 policy/authorization 字段）。
    /// 用独立长超时客户端：目标在公网对象存储，和 Astral 接口的 15s 不共用。
    pub async fn direct_upload(
        &self,
        ticket: &UploadTicket,
        file_name: &str,
        content_type: &str,
        bytes: Vec<u8>,
    ) -> Result<(), String> {
        self.direct_upload_for_epoch(self.session_epoch(), ticket, file_name, content_type, bytes)
            .await
    }

    /// 头像 / 封面上传的图片大小上限（8 MiB）。
    ///
    /// 为什么要有上限：两条上传路径都是"整个文件读进内存 → 作为 PUT / multipart
    /// body 一次性上传"（预检只认 png / jpg / webp）。真实头像/封面都在 1-2 MiB
    /// 以内（手机直出也就 3-5 MiB），8 MiB 留了充足余量；再大的一律明确拒绝，
    /// 免得误选一个几百 MB 的文件就把整块内存吃掉（旧实现没有上限，`std::fs::read`
    /// 有多少读多少）。
    const IMAGE_UPLOAD_MAX_BYTES: u64 = 8 * 1024 * 1024;

    /// 图片超限的统一文案（预检失败与实读失败共用，保证两条路径提示一致）
    fn image_too_large_err(size: u64, path: &str) -> String {
        format!(
            "图片过大：{size} 字节，上限 {} MiB（{path}）",
            Self::IMAGE_UPLOAD_MAX_BYTES / 1024 / 1024
        )
    }

    /// 图片文件预检（扩展名 → MIME；只认 png/jpg/webp，与后端文件夹策略一致）
    fn image_meta(path: &str, base: &str) -> Result<(String, &'static str, i64), String> {
        let ext = std::path::Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            other => {
                return Err(format!(
                    "暂不支持的图片格式 .{other}，仅支持 png / jpg / webp"
                ))
            }
        };
        let meta = std::fs::metadata(path).map_err(|_| format!("读不到文件：{path}"))?;
        // 大小上限放在预检里：不合格的图片不必白跑一趟取凭证的网络请求
        if meta.len() > Self::IMAGE_UPLOAD_MAX_BYTES {
            return Err(Self::image_too_large_err(meta.len(), path));
        }
        Ok((format!("{base}.{ext}"), mime, meta.len() as i64))
    }

    /// 读图片正文（上传 body 需要一次性字节）。
    ///
    /// P2-4：两条上传路径原先都在 `async fn` 里直接 `std::fs::read`，
    /// 大文件读盘会把 tokio worker 占住 —— 这里放到阻塞池线程上读。
    /// 另外最多只读「上限 + 1」字节（`Read::take`）：预检的 `metadata` 与这里的
    /// `open` 之间有 TOCTOU 窗口（文件可能被换掉/正在增长），以实际读到的长度
    /// 为准兜底，任何情况下都不会把超大文件整块读进内存。
    async fn read_image_bytes(path: &str) -> Result<Vec<u8>, String> {
        let path = path.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            use std::io::Read;
            let file = std::fs::File::open(&path).map_err(|e| format!("读取文件失败: {e}"))?;
            let mut bytes = Vec::new();
            file.take(Self::IMAGE_UPLOAD_MAX_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| format!("读取文件失败: {e}"))?;
            if bytes.len() as u64 > Self::IMAGE_UPLOAD_MAX_BYTES {
                return Err(Self::image_too_large_err(bytes.len() as u64, &path));
            }
            Ok(bytes)
        })
        .await
        .map_err(|e| format!("读取文件失败: {e}"))?
    }

    /// 头像上传一条龙：预检 → 取凭证 → 直传 → 回执登记，返回头像 URL。
    pub async fn upload_avatar_file(&self, path: &str) -> Result<String, String> {
        self.upload_avatar_file_for_epoch(self.session_epoch(), path)
            .await
    }

    /// 歌单封面上传一条龙，返回封面 URL。
    pub async fn upload_cover_file(
        &self,
        pid: &str,
        platform: &str,
        path: &str,
    ) -> Result<String, String> {
        self.upload_cover_file_for_epoch(self.session_epoch(), pid, platform, path)
            .await
    }

    // ---------- 收藏同步（接口契约同 qt-uniappx services/like.ts） ----------

    /// 单曲收藏/取消（app/user/like/song）。返回服务端 seq，用作同步游标。
    /// 参数打包成结构，免得撞 clippy 的 too_many_arguments。
    pub async fn like_song(&self, p: LikeSongPayload<'_>) -> Result<i64, String> {
        let data = self
            .post_json("app/user/like/song", like_song_body(&p), &[], true)
            .await?;
        Ok(seq_of(&data))
    }

    /// 批量推送收藏操作（app/user/like/batch）。
    /// ops 是完整操作体数组（每个体带 type 判别字段：song|playlist，其余字段与
    /// 单条接口一致），按数组顺序上送，后端单事务整批原子执行并按序分配 seq；
    /// 成功返回整批占用的最大 seq（连续区段，调用方盖章/回写游标都安全）。
    /// 失败整批不落库，由调用方整批入离线队列保序重试（upsert 幂等，重放无害）。
    pub async fn like_batch(&self, ops: Vec<Value>) -> Result<i64, String> {
        let data = self
            .post_json("app/user/like/batch", json!({ "ops": ops }), &[], true)
            .await?;
        Ok(seq_of(&data))
    }

    // ---------- 更新（§15.3 / §15.7）：version 传 versionCode 数字字符串 ----------

    /// 升级查询：除 type / version 外必须上送本机架构 arch，否则服务端不知道该在
    /// 同一版本的三个 Windows 安装包里挑哪一个（默认只会给兜底的那一份）。
    pub async fn app_update(&self, version_code: i64) -> Result<Value, String> {
        let code_str = version_code.to_string();
        self.get(
            "app/update",
            &[
                ("type", UPDATE_TYPE),
                ("version", &code_str),
                ("arch", crate::app_config::ARCH),
            ],
            true,
        )
        .await
    }

    pub async fn check_official_version(
        &self,
        version_code: i64,
        version_name: &str,
    ) -> Result<Value, String> {
        let code_str = version_code.to_string();
        self.get(
            "app/version/check",
            &[
                ("type", UPDATE_TYPE),
                ("version", &code_str),
                ("versionName", version_name),
                ("arch", crate::app_config::ARCH),
            ],
            false,
        )
        .await
    }

    pub async fn github_accels(&self) -> Result<Value, String> {
        self.get("app/github/accels", &[], false).await
    }

    // ---------- 更新下载：GitHub 加速 + 进度 + 校验（UPDATE_DESIGN.md §2） ----------

    /// GitHub 原始链接是否参与加速拼接（release / raw / archive 路径）
    pub fn is_github_url(url: &str) -> bool {
        url.contains("github.com/") || url.contains("githubusercontent.com/")
    }

    /// 从加速拼接链接还原原始 GitHub 直链：
    /// `https://ghproxy.cn/https://github.com/...` → `https://github.com/...`。
    /// 找不到 `https://github.com/` 时原样返回（说明本来就是直链）。
    pub fn strip_accel_prefix(url: &str) -> String {
        match url.find("https://github.com/") {
            Some(i) => url[i..].to_string(),
            None => url.to_string(),
        }
    }

    /// 加速前缀 + 目标直链的拼接。核心是保证前缀和 `https://` 之间
    /// 恰好一个 `/`：前缀带不带尾斜杠都要出
    /// `https://ghproxy.cn/https://github.com/...`。
    /// 直接 `format!("{}{}", trim_end /, target)` 会把目标开头的
    /// `https://` 压成 `https//`（曾导致所有节点探测必失败）。
    fn join_accel_url(prefix: &str, target: &str) -> String {
        format!("{}/{}", prefix.trim_end_matches('/'), target)
    }

    /// 探测单个加速前缀是否可用：Range 0-0 请求 前缀+目标，
    /// 2xx 且响应体不是文本（HTML 广告页 / 封禁提示页也常回 200）。
    /// 与后端管理端探活同口径；5 秒超时。
    async fn probe_accel(prefix: &str, target: &str) -> Option<u128> {
        let url = Self::join_accel_url(prefix, target);
        let started = std::time::Instant::now();
        let resp = self_http_get_head(&url).await?;
        if !resp.status().is_success() {
            return None;
        }
        // 垃圾节点治理：部分节点对任意路径都回 200 的 HTML 广告页 /
        // text/plain 封禁提示（如「Suspend due to abuse report」），
        // 只认二进制流（octet-stream / application/*）为可用
        let ct = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if ct.starts_with("text/") {
            return None;
        }
        Some(started.elapsed().as_millis())
    }

    /// 按 UPDATE_DESIGN.md §2.2 组装下载地址：
    /// - 非 GitHub 直链原样返回；
    /// - GitHub 链接并发探测全部加速节点，选**延迟最低的可用节点**拼前缀；
    /// - 所有节点都不可用 / 未配置时：先用原始链接（浏览器兜底仍可用）。
    pub async fn resolve_download_url(&self, update: &Value) -> Value {
        let download_url = update
            .get("downloadUrl")
            .and_then(Value::as_str)
            .unwrap_or("");
        if download_url.is_empty() || !Self::is_github_url(download_url) {
            return serde_json::json!({ "downloadUrl": download_url });
        }
        let accels = match self.github_accels().await {
            Ok(v) => v
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|n| {
                    n.get("prefixUrl")
                        .and_then(Value::as_str)
                        .map(|s| s.to_string())
                })
                .collect::<Vec<_>>(),
            Err(_) => Vec::new(),
        };
        if accels.is_empty() {
            return serde_json::json!({ "downloadUrl": download_url, "accelUsed": false });
        }
        let mut best: Option<(String, u128)> = None;
        // 并发探测全部加速节点（文档一直写的是并发；此前实现是 for+await 串行，
        // 每个探测 5s 超时，N 个节点最坏 5N 秒全程挂住命令）。spawn 后逐个收，
        // 取最低延迟；个别任务异常按探测失败跳过
        let mut handles = Vec::with_capacity(accels.len());
        for prefix in accels {
            let target = download_url.to_string();
            handles.push(tauri::async_runtime::spawn(async move {
                let latency = Self::probe_accel(&prefix, &target).await;
                (prefix, latency)
            }));
        }
        for handle in handles {
            if let Ok((prefix, Some(latency))) = handle.await {
                if best.as_ref().map(|(_, l)| latency < *l).unwrap_or(true) {
                    best = Some((prefix, latency));
                }
            }
        }
        match best {
            Some((prefix, latency)) => {
                let url = Self::join_accel_url(&prefix, download_url);
                serde_json::json!({
                    "downloadUrl": url,
                    "accelUsed": true,
                    "accelLatencyMs": latency,
                })
            }
            // 加速全挂：仍给原始 GitHub 链接（用户可能本身就能直连）
            None => serde_json::json!({ "downloadUrl": download_url, "accelUsed": false }),
        }
    }

    /// 下载更新包到临时目录，通过事件 `update-download-progress` 上报进度。
    /// 完成后返回落盘路径（校验由调用方做）。
    ///
    /// 用独立的下载专用 client：API client 有 15s 总超时（`Self::new`），
    /// 几 MB 的安装包在慢网络下必然超 15s，超时会中断流式读取并报成
    /// 「下载中断: error decoding response body」——下载要的是「连得上」
    /// 而不是「限时完成」，这里只留 10s 连接超时，不限总时长。
    ///
    /// P2-4：整个「请求 + 流式落盘」过程搬到 tokio 阻塞池线程上跑
    /// （见 `download_update_file_inner`）。命令本身是 `async` 的，若直接在
    /// tokio worker 上做 `create_dir_all` / `File::create` / `write_all` / `flush`，
    /// 一个几十 MB 的安装包会把 worker 占住到下载结束（worker 数 = CPU 核数，
    /// 几个并发命令就能让所有异步任务排队）。下载逻辑一行没动，只换了执行线程。
    /// `_http` 参数保持原签名不变（实现里始终自建下载专用 client）。
    pub async fn download_update_file(
        _http: &reqwest::Client,
        url: &str,
        app: &tauri::AppHandle,
    ) -> Result<std::path::PathBuf, String> {
        let url = url.to_string();
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            // 阻塞池线程不在任何 runtime 上下文里（它不是 tokio worker），
            // 所以这里可以用运行时句柄 `block_on` 驱动原来的异步下载实现：
            // reqwest 的连接池/超时照常由同一个运行时驱动，不会踩
            // "Cannot start a runtime from within a runtime"（那个 panic 只在
            // 已经处于 runtime 上下文的线程上触发）。
            let rt = tauri::async_runtime::handle();
            rt.block_on(Self::download_update_file_inner(&url, &app))
        })
        .await
        .map_err(|e| format!("下载任务异常: {e}"))?
    }

    /// `download_update_file` 的实现本体（P2-4 拆分：整体在阻塞池线程上执行）。
    /// 内容与拆分前的 `download_update_file` 逐字一致（URL、校验、落盘文件名、
    /// 返回值、错误文案都没动），只是不再直接跑在 async worker 上。
    async fn download_update_file_inner(
        url: &str,
        app: &tauri::AppHandle,
    ) -> Result<std::path::PathBuf, String> {
        use std::io::Write;
        use tauri::Emitter;

        // 专用下载 client（理由见方法注释）；参数保留以兼容现有调用方
        let http = crate::net_config::configure(reqwest::Client::builder())
            .connect_timeout(std::time::Duration::from_secs(10))
            .pool_max_idle_per_host(0)
            .build()
            .map_err(|e| format!("下载客户端初始化失败: {e}"))?;

        // 临时目录 + 固定文件名（保持与改动前逐字一致；路径口径与
        // `update_installer_path()` 完全相同，命令侧执行校验用同一个常量）
        let dir = std::env::temp_dir().join(UPDATE_DIR_NAME);
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败: {e}"))?;
        // 固定文件名（理由见 UPDATE_INSTALLER_FILE_NAME 的注释）：
        // 以前是 `url.split('/').next_back()`，反斜杠不会被 '/' 切开，
        // 于是服务端下发的 `..\..\x.exe` 能写穿临时目录。
        let path = dir.join(UPDATE_INSTALLER_FILE_NAME);

        // File::create 会截断/重建固定路径文件：此刻起旧文件字节作废，先复位
        // 进程级验签标记（见 reset_installer_signature_verified 的注释）
        reset_installer_signature_verified();
        let resp = http
            .get(url)
            .send()
            .await
            .map_err(|e| format!("下载请求失败: {}", sanitize_err(e)))?
            .error_for_status()
            .map_err(|e| format!("下载请求失败: {}", sanitize_err(e)))?;
        let total = resp.content_length().unwrap_or(0);
        let mut file = std::fs::File::create(&path).map_err(|e| format!("创建文件失败: {e}"))?;
        let mut written: u64 = 0;
        let mut last_report = 0u64;
        let mut stream = resp;
        while let Some(chunk) = match stream.chunk().await {
            Ok(c) => c,
            Err(e) => {
                // reqwest 把超时/连接中断都包成 decoding 错误，把源错误拼上才好排查
                use std::error::Error as _;
                let msg = sanitize_err(&e);
                let src = e.source().map(sanitize_err).unwrap_or_default();
                return Err(if src.is_empty() {
                    format!("下载中断: {msg}")
                } else {
                    format!("下载中断: {msg}（{src}）")
                });
            }
        } {
            file.write_all(&chunk)
                .map_err(|e| format!("写入失败: {e}"))?;
            written += chunk.len() as u64;
            let percent = if total > 0 {
                (written * 100).div_ceil(total)
            } else {
                0
            };
            if percent > last_report {
                last_report = percent;
                let _ = app.emit(
                    "update-download-progress",
                    serde_json::json!({ "percent": percent, "written": written, "total": total }),
                );
            }
        }
        file.flush().map_err(|e| format!("写入失败: {e}"))?;
        Ok(path)
    }

    /// 拉取与安装包同址的签名文件（安装包 URL + ".sig"）：GitHub 发布资产 /
    /// 对象存储同名键约定，后端无需为签名单独建字段。
    pub async fn fetch_update_signature(
        client: &reqwest::Client,
        sig_url: &str,
    ) -> Result<String, String> {
        let resp = client
            .get(sig_url)
            .send()
            .await
            .map_err(|e| format!("下载签名文件失败: {}", sanitize_err(e)))?;
        if !resp.status().is_success() {
            return Err(format!(
                "签名文件不可得（HTTP {}）——发布方未上传 .sig 或链路异常",
                resp.status()
            ));
        }
        resp.text()
            .await
            .map(|s| s.trim().to_string())
            .map_err(|e| format!("签名文件读取失败: {e}"))
    }

    /// 校验安装包的 ed25519 签名（ring 实现，随 rustls 已在依赖树里）。
    /// `pubkey_b64` 参数便于单测注入测试密钥；生产调用走
    /// [`Self::verify_installer_signature`] 用内嵌公钥。
    pub(crate) fn verify_installer_signature_with(
        path: &std::path::Path,
        sig_b64: &str,
        pubkey_b64: &str,
    ) -> Result<(), String> {
        use base64::Engine;
        let pubkey = base64::engine::general_purpose::STANDARD
            .decode(pubkey_b64)
            .map_err(|e| format!("公钥解析失败: {e}"))?;
        let sig = base64::engine::general_purpose::STANDARD
            .decode(sig_b64.trim())
            .map_err(|e| format!("签名内容解析失败: {e}"))?;
        if sig.len() != 64 {
            return Err(format!(
                "签名长度异常（ed25519 应为 64 字节，实际 {}）",
                sig.len()
            ));
        }
        let file = std::fs::read(path).map_err(|e| format!("读取安装包失败: {e}"))?;
        ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &pubkey)
            .verify(&file, &sig)
            .map_err(|_| "安装包签名不匹配（文件可能被篡改）".to_string())
    }

    /// 用内嵌公钥（[`UPDATE_SIGN_PUBKEY_B64`]）校验安装包签名
    pub fn verify_installer_signature(path: &std::path::Path, sig_b64: &str) -> Result<(), String> {
        Self::verify_installer_signature_with(path, sig_b64, UPDATE_SIGN_PUBKEY_B64)
    }

    /// 校验下载文件的 MD5（后端配了 md5 才校验）与大小（配了 fileSize 才校验）。
    pub fn verify_update_file(
        path: &std::path::Path,
        expect_md5: Option<&str>,
        expect_size: Option<i64>,
    ) -> Result<(), String> {
        use std::io::Read;
        if let Some(expect) = expect_size.filter(|s| *s > 0) {
            let actual = std::fs::metadata(path)
                .map_err(|e| format!("读取文件失败: {e}"))?
                .len();
            if actual != expect as u64 {
                return Err(format!(
                    "文件大小不符：期望 {expect} 字节，实际 {actual} 字节"
                ));
            }
        }
        if let Some(expect) = expect_md5.filter(|s| !s.is_empty()) {
            use md5::Digest;
            let mut file = std::fs::File::open(path).map_err(|e| format!("读取文件失败: {e}"))?;
            let mut hasher = md5::Md5::default();
            let mut buf = [0u8; 65536];
            loop {
                let n = file
                    .read(&mut buf)
                    .map_err(|e| format!("读取文件失败: {e}"))?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
            }
            // md-5 0.11（RustCrypto digest 0.11 系）把 finalize() 的返回类型换成了
            // hybrid_array::Array，它**不再实现 LowerHex**，`format!("{:x}")` 编译不过。
            // 这里自己转十六进制：只用 core，不依赖任何 digest 版本的格式化 impl，
            // 以后再升 digest 也不用改这里。
            let actual = hasher
                .finalize()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            if !actual.eq_ignore_ascii_case(expect) {
                return Err(format!("MD5 校验不符：期望 {expect}，实际 {actual}"));
            }
        }
        Ok(())
    }

    // ---------- 消息（§15.4）：固定 channel=pc ----------

    // 三个消息端点都必须带 satoken（哪怕 /active 是公开端点）：后端拿它判断「谁在看」，
    // 游客拿不到 audience=LOGGED_IN 的通告，也拿不到点对点（反馈回复）通知。
    // 移动端 services/notice.ts 的 fetchActiveNotices 同样无条件带 token，这里对齐。

    pub async fn active_messages(&self, version_code: i64) -> Result<Value, String> {
        let code_str = version_code.to_string();
        // auth=true：已登录就带 satoken（没有 token 时 request_once 不会加头，等同游客）
        self.get(
            "app/message/active",
            &[("versionCode", &code_str), ("channel", MESSAGE_CHANNEL)],
            true,
        )
        .await
    }

    pub async fn message_center(&self) -> Result<Value, String> {
        self.get("app/message/center", &[("channel", MESSAGE_CHANNEL)], true)
            .await
    }

    pub async fn unread_count(&self) -> Result<Value, String> {
        self.get(
            "app/message/unread-count",
            &[("channel", MESSAGE_CHANNEL)],
            true,
        )
        .await
    }

    /// 已读回执：body {ids: []}
    pub async fn ack_messages(&self, ids: &[i64]) -> Result<Value, String> {
        self.post_json(
            "app/message/read-ack",
            serde_json::json!({ "ids": ids }),
            &[],
            true,
        )
        .await
    }

    // ---------- 统计（§15.4）：ut 固定为本编译目标的 CLIENT_UT，单批 ≤200 ----------

    pub async fn report_stats(&self, mut events: Vec<Value>) -> Result<(), String> {
        if events.len() > 200 {
            return Err("单批统计事件不能超过 200".to_string());
        }
        for evt in &mut events {
            if let Some(obj) = evt.as_object_mut() {
                obj.insert("ut".to_string(), Value::String(CLIENT_UT.to_string()));
            }
        }
        // App 端上报走 AppStatController：/api/v1/app/stat/report（旧 /api/v1/stat/report
        // 已删除）。base_url 已含 /api/v1/，拼相对路径 app/stat/report
        self.post_json(
            "app/stat/report",
            serde_json::json!({ "events": events }),
            &[],
            false,
        )
        .await
        .map(|_| ())
    }

    // ---------- 反馈（客户端信息头由 request() 统一注入） ----------

    pub async fn submit_feedback(
        &self,
        kind: &str,
        title: &str,
        content: &str,
        contact: &str,
    ) -> Result<Value, String> {
        let mut body = serde_json::json!({ "type": kind, "title": title, "content": content });
        if !contact.is_empty() {
            body["contact"] = Value::String(contact.to_string());
        }
        self.post_json("app/feedback/submit", body, &[], true).await
    }

    pub async fn my_feedback(&self, page_num: i64, page_size: i64) -> Result<Value, String> {
        self.get(
            "app/feedback/my",
            &[
                ("pageNum", &page_num.to_string()),
                ("pageSize", &page_size.to_string()),
            ],
            true,
        )
        .await
    }

    pub async fn public_feedback(&self, page_num: i64, page_size: i64) -> Result<Value, String> {
        self.get(
            "app/feedback/public",
            &[
                ("pageNum", &page_num.to_string()),
                ("pageSize", &page_size.to_string()),
            ],
            true,
        )
        .await
    }

    pub async fn feedback_detail(&self, id: i64) -> Result<Value, String> {
        self.get(&format!("app/feedback/{id}"), &[], true).await
    }

    pub async fn feedback_replies(&self, id: i64) -> Result<Value, String> {
        self.get(&format!("app/feedback/{id}/replies"), &[], true)
            .await
    }

    pub async fn reply_feedback(&self, feedback_id: i64, content: &str) -> Result<Value, String> {
        self.post_json(
            "app/feedback/reply",
            serde_json::json!({ "feedbackId": feedback_id, "content": content }),
            &[],
            true,
        )
        .await
    }

    // ---------- AI 助手（/api/v1/app/ai/**，与 qt-uniappx 同一套契约） ----------
    //
    // 每处都显式带 `clientType=QT_PC`：后端 AiAppController.resolveClient 的兜底值
    // 是 QT_UNIAPPX，不传就会被当成手机端，智能体按客户端过滤后可能压根不返回。

    pub async fn ai_agents(&self) -> Result<Value, String> {
        self.get("app/ai/agents", &[("clientType", AI_CLIENT_TYPE)], true)
            .await
    }

    pub async fn ai_capabilities(&self, agent_code: &str) -> Result<Value, String> {
        self.get(
            "app/ai/capabilities",
            &[("agentCode", agent_code), ("clientType", AI_CLIENT_TYPE)],
            true,
        )
        .await
    }

    pub async fn ai_conversations(&self, agent_code: &str) -> Result<Value, String> {
        self.get(
            "app/ai/conversations",
            &[("agentCode", agent_code), ("clientType", AI_CLIENT_TYPE)],
            true,
        )
        .await
    }

    pub async fn ai_create_conversation(
        &self,
        agent_code: &str,
        title: &str,
    ) -> Result<Value, String> {
        self.post_json(
            "app/ai/conversations",
            serde_json::json!({ "agentCode": agent_code, "title": title }),
            &[(AI_CLIENT_HEADER, AI_CLIENT_TYPE.to_string())],
            true,
        )
        .await
    }

    pub async fn ai_conversation(&self, id: i64) -> Result<Value, String> {
        self.get(&format!("app/ai/conversations/{id}"), &[], true)
            .await
    }

    pub async fn ai_delete_conversation(&self, id: i64) -> Result<Value, String> {
        self.request(
            reqwest::Method::DELETE,
            &format!("app/ai/conversations/{id}"),
            &[],
            None,
            &[],
            true,
        )
        .await
    }

    pub async fn ai_messages(
        &self,
        conversation_id: i64,
        before_id: Option<i64>,
        limit: Option<i64>,
    ) -> Result<Value, String> {
        let mut query: Vec<(&str, String)> = Vec::new();
        if let Some(b) = before_id {
            query.push(("beforeId", b.to_string()));
        }
        if let Some(l) = limit {
            query.push(("limit", l.to_string()));
        }
        let refs: Vec<(&str, &str)> = query.iter().map(|(k, v)| (*k, v.as_str())).collect();
        self.get(
            &format!("app/ai/conversations/{conversation_id}/messages"),
            &refs,
            true,
        )
        .await
    }

    /// 发消息。`context` 是客户端上下文（当前歌曲/队列/已装音源/候选歌…），
    /// 后端按智能体版本的 contextPolicy 白名单裁剪后才给模型看。
    pub async fn ai_send_message(
        &self,
        conversation_id: i64,
        content: &str,
        context: Value,
        idempotency_key: &str,
    ) -> Result<Value, String> {
        let mut body = serde_json::json!({ "content": content, "context": context });
        if !idempotency_key.is_empty() {
            body["idempotencyKey"] = Value::String(idempotency_key.to_string());
        }
        self.post_json(
            &format!("app/ai/conversations/{conversation_id}/messages"),
            body,
            &[(AI_CLIENT_HEADER, AI_CLIENT_TYPE.to_string())],
            true,
        )
        .await
    }

    pub async fn ai_events(
        &self,
        request_id: i64,
        after: i64,
        limit: i64,
    ) -> Result<Value, String> {
        self.get(
            &format!("app/ai/requests/{request_id}/events"),
            &[("after", &after.to_string()), ("limit", &limit.to_string())],
            true,
        )
        .await
    }

    pub async fn ai_cancel_request(&self, request_id: i64, reason: &str) -> Result<Value, String> {
        let body = if reason.is_empty() {
            serde_json::json!({})
        } else {
            serde_json::json!({ "reason": reason })
        };
        self.post_json(
            &format!("app/ai/requests/{request_id}/cancel"),
            body,
            &[],
            true,
        )
        .await
    }

    pub async fn ai_feedback(
        &self,
        message_id: i64,
        feedback_type: &str,
        reason_code: &str,
        comment: &str,
    ) -> Result<Value, String> {
        let mut body = serde_json::json!({ "feedbackType": feedback_type });
        if !reason_code.is_empty() {
            body["reasonCode"] = Value::String(reason_code.to_string());
        }
        if !comment.is_empty() {
            body["comment"] = Value::String(comment.to_string());
        }
        self.post_json(
            &format!("app/ai/messages/{message_id}/feedback"),
            body,
            &[],
            true,
        )
        .await
    }

    pub async fn ai_execute_action(
        &self,
        action_id: &str,
        action_type: &str,
        success: bool,
        message: &str,
    ) -> Result<Value, String> {
        let mut body = serde_json::json!({
            "actionId": action_id,
            "actionType": action_type,
            "success": success,
        });
        if !message.is_empty() {
            body["message"] = Value::String(message.to_string());
        }
        self.post_json("app/ai/actions/execute", body, &[], true)
            .await
    }
}

/// 本端在智能体客户端列表里的标识（后端 `AiConstants.ClientType.QT_PC`）
const AI_CLIENT_TYPE: &str = "QT_PC";
/// 后端也认 `X-Ai-Client` 头，两条路都带上，避免某天 query 被代理吃掉
const AI_CLIENT_HEADER: &str = "X-Ai-Client";

/// versionName：Cargo 包版本（Cargo.toml 由 app.config.json 同步，单一真值 §15.7）
pub fn version_name() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// versionCode：发版版本号（与移动端 manifest.json 的 versionCode 同一约定），
/// 必须和后端 qt_app_update 表里对应版本的记录一致——更新检查就是拿它比大小。
/// 1.0.0 → 100 … 1.0.7 → 107。值来自 app.config.json 的 `version.code`，
/// 由 scripts/sync-config.mjs 写进 app_config.rs：**改版本号只改 app.config.json**。
pub const VERSION_CODE: i64 = crate::app_config::VERSION_CODE;

pub fn version_code() -> i64 {
    VERSION_CODE
}

/// 截断到上限（按字符，避免截出半个 UTF-8 序列）。服务端还会按列宽再截一次，
/// 这里截是为了不把无意义的长串发出去。
fn clip(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    value.chars().take(max).collect()
}

/// 设备名 / 主机名（`X-Device` 的值）。
/// 用系统自带环境变量，不引入 `hostname` / `sysinfo` 之类的新依赖：
/// Windows 是 `COMPUTERNAME`，类 Unix 是 `HOSTNAME`；都取不到返回空串（该头就不发）。
fn device_name() -> String {
    for key in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(value) = std::env::var(key) {
            let value = value.trim();
            if !value.is_empty() {
                return clip(value, MAX_DEVICE_LEN);
            }
        }
    }
    String::new()
}

/// 读 `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion` 下的字符串值。
/// 一次调用 + 固定缓冲：这几个值（产品名/发行版本/内部版本号）都远短于 256 个 WCHAR，
/// 真超了 `RegGetValueW` 会返回 ERROR_MORE_DATA，按「取不到」处理即可。
#[cfg(target_os = "windows")]
fn windows_registry_string(name: &str) -> Option<String> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};

    let mut buf = [0u16; 256];
    let mut cb: u32 = (buf.len() * 2) as u32;
    // 值名必须 NUL 结尾，且要在调用期间存活
    let name_wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let rc = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            w!("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"),
            PCWSTR(name_wide.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
            Some(&mut cb),
        )
    };
    if rc.is_err() {
        return None;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    if len == 0 {
        return None;
    }
    String::from_utf16(&buf[..len])
        .ok()
        .filter(|s| !s.is_empty())
}

/// 按内部版本号修正产品名（Windows 11 的注册表 `ProductName` 仍写「Windows 10 …」）。
///
/// 微软为老程序兼容保留了这个字符串：装了 Windows 11 的机器上
/// `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProductName` 依然是
/// 「Windows 10 Home China」，而 `CurrentBuildNumber` 是 26200、`DisplayVersion`
/// 是 25H2 —— 直接拼出来就成了「Windows 10 Home China 25H2 (26200)」这种自相矛盾
/// 的反馈记录（用户一眼看出不对）。Windows 11 从 21H2 起内部版本号就是 22000 段，
/// 所以 ≥ 22000 一律按 11 改写前缀；也顺手覆盖 Win11 24H2/25H2 的 26100/26200。
/// 只改写以「Windows 10」开头的产品名：`Windows Server 2025`（26100）之类的
/// 服务器版本来就没写错，不能动。
// 非 Windows 目标上没有调用点（只有 cfg(windows) 的 os_description 用它）
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn windows_family_of(product: &str, build: &str) -> String {
    let build_no: u32 = build.trim().parse().unwrap_or(0);
    if build_no >= 22_000 && product.starts_with("Windows 10") {
        return product.replacen("Windows 10", "Windows 11", 1);
    }
    product.to_string()
}

/// 操作系统描述（`X-OS` 的值）。
/// Windows 下取「Windows 11 Pro 23H2 (22631)」这种能直接定位问题的完整描述
/// （音频驱动 / WebView2 的差异常常只体现在内部版本号上）；注册表读不到时退化为 `Windows`。
#[cfg(target_os = "windows")]
fn os_description() -> String {
    let product = windows_registry_string("ProductName").unwrap_or_else(|| "Windows".to_string());
    let display = windows_registry_string("DisplayVersion").unwrap_or_default();
    let build = windows_registry_string("CurrentBuildNumber").unwrap_or_default();
    let mut out = windows_family_of(&product, &build);
    if !display.is_empty() {
        out.push(' ');
        out.push_str(&display);
    }
    if !build.is_empty() {
        // 没有 DisplayVersion（Win10 早期 / 精简版）时标成 build，别输出成一对空括号
        if display.is_empty() {
            out.push_str(" build ");
        } else {
            out.push_str(" (");
        }
        out.push_str(&build);
        if !display.is_empty() {
            out.push(')');
        }
    }
    clip(&out, MAX_OS_LEN)
}

/// 非 Windows 平台的系统描述（Linux 读 /etc/os-release 的 PRETTY_NAME，
/// 如 "Ubuntu 24.04.1 LTS"；macOS 读 sw_vers 的产品名 + 版本，如 "macOS 15.1"）。
/// 都拿不到时退化为 std::env::consts::OS（"linux" / "macos"）。
#[cfg(not(target_os = "windows"))]
fn os_description() -> String {
    let raw = os_description_raw();
    clip(&raw, MAX_OS_LEN)
}

#[cfg(not(target_os = "windows"))]
fn os_description_raw() -> String {
    #[cfg(target_os = "linux")]
    {
        // PRETTY_NAME 行形如：PRETTY_NAME="Ubuntu 24.04.1 LTS"
        if let Ok(text) = std::fs::read_to_string("/etc/os-release") {
            for line in text.lines() {
                if let Some(value) = line.strip_prefix("PRETTY_NAME=") {
                    let value = value.trim().trim_matches('"');
                    if !value.is_empty() {
                        return value.to_string();
                    }
                }
            }
        }
        std::env::consts::OS.to_string()
    }
    #[cfg(target_os = "macos")]
    {
        // sw_vers 输出两行：ProductName: macOS\nProductVersion: 15.1
        let product = std::process::Command::new("sw_vers")
            .arg("-productName")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        let version = std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        match (product.is_empty(), version.is_empty()) {
            (false, false) => format!("{product} {version}"),
            (false, true) => product,
            _ => std::env::consts::OS.to_string(),
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        std::env::consts::OS.to_string()
    }
}

/// Final system metadata values. Supplying an instance performs no OS/environment
/// query; the normal client still acquires its actual metadata lazily once.
#[derive(Clone)]
pub struct ClientMetadata {
    pub device: String,
    pub os: String,
}

/// Shared basic-header contract: actual platform/version constants, column-width
/// clipping and empty-value omission. No HTTP, host query or global override.
pub fn client_headers_with_metadata(metadata: &ClientMetadata) -> Vec<(&'static str, String)> {
    let candidates = [
        (HDR_CLIENT_UT, CLIENT_UT.to_string()),
        (HDR_CLIENT_VERSION, version_name().to_string()),
        (HDR_CLIENT_DEVICE, clip(&metadata.device, MAX_DEVICE_LEN)),
        (HDR_CLIENT_OS, clip(&metadata.os, MAX_OS_LEN)),
    ];
    candidates
        .into_iter()
        .filter(|(_, value)| !value.is_empty())
        .collect()
}

/// 统一客户端系统头，进程内只算一次（设备名与系统版本在运行期不变）。
/// 空值不入列——「不存在这个头」比「头是空串」更干净，服务端也按同一语义归一。
fn client_headers() -> &'static [(&'static str, String)] {
    static HEADERS: std::sync::OnceLock<Vec<(&'static str, String)>> = std::sync::OnceLock::new();
    HEADERS.get_or_init(|| {
        client_headers_with_metadata(&ClientMetadata {
            device: device_name(),
            os: os_description(),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_metadata() -> ClientMetadata {
        ClientMetadata {
            device: "synthetic-owned-device".into(),
            os: "Synthetic Test OS 1.0".into(),
        }
    }

    /// One finite owned HTTP reply. Nonblocking accept, bounded socket operations
    /// and RAII stop/join cover request failures and assertion unwinding too.
    pub(super) struct OwnedHttp {
        pub(super) addr: std::net::SocketAddr,
        stop: Arc<std::sync::atomic::AtomicBool>,
        pub(super) requests: Arc<std::sync::Mutex<Vec<String>>>,
        worker: Option<std::thread::JoinHandle<()>>,
        joined: Arc<std::sync::atomic::AtomicBool>,
        _fixture: crate::lyric_access::native_fixture::NativeFixture,
    }

    impl OwnedHttp {
        pub(super) fn new(status: u16, headers: &str, body: &[u8]) -> Self {
            use std::io::{Read as _, Write as _};
            use std::sync::atomic::{AtomicBool, Ordering};
            let fixture = crate::lyric_access::native_fixture::NativeFixture::new("astral-http");
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
            listener
                .set_nonblocking(true)
                .expect("nonblocking owned listener");
            let addr = listener.local_addr().expect("addr");
            let stop = Arc::new(AtomicBool::new(false));
            let stopped = Arc::clone(&stop);
            let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
            let recorded = Arc::clone(&requests);
            let joined = Arc::new(AtomicBool::new(false));
            let mut reply = format!(
                "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n{headers}\r\n", body.len()
            ).into_bytes();
            reply.extend_from_slice(body);
            let worker = std::thread::spawn(move || {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
                let mut socket = loop {
                    if stopped.load(Ordering::SeqCst) || std::time::Instant::now() >= deadline {
                        return;
                    }
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(std::time::Duration::from_millis(2))
                        }
                        Err(_) => return,
                    }
                };
                socket
                    .set_read_timeout(Some(std::time::Duration::from_millis(100)))
                    .unwrap();
                socket
                    .set_write_timeout(Some(std::time::Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                let mut byte = [0];
                loop {
                    if stopped.load(Ordering::SeqCst) || std::time::Instant::now() >= deadline {
                        return;
                    }
                    match socket.read(&mut byte) {
                        Ok(0) => return,
                        Ok(_) => {
                            request.push(byte[0]);
                            if request.ends_with(b"\r\n\r\n") {
                                break;
                            }
                            if request.len() > 16 * 1024 {
                                return;
                            }
                        }
                        Err(error)
                            if matches!(
                                error.kind(),
                                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                            ) => {}
                        Err(_) => return,
                    }
                }
                let header = String::from_utf8(request.clone()).unwrap();
                let body_len = header
                    .lines()
                    .filter_map(|line| line.split_once(':'))
                    .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                    .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                    .unwrap_or(0);
                if body_len > 16 * 1024 {
                    return;
                }
                let total = request.len() + body_len;
                while request.len() < total {
                    if stopped.load(Ordering::SeqCst) || std::time::Instant::now() >= deadline {
                        return;
                    }
                    match socket.read(&mut byte) {
                        Ok(0) => return,
                        Ok(_) => request.push(byte[0]),
                        Err(error)
                            if matches!(
                                error.kind(),
                                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                            ) => {}
                        Err(_) => return,
                    }
                }
                recorded
                    .lock()
                    .unwrap()
                    .push(String::from_utf8(request).unwrap());
                if socket.write_all(&reply).is_ok() {
                    let _ = socket.flush();
                }
            });
            Self {
                addr,
                stop,
                requests,
                worker: Some(worker),
                joined,
                _fixture: fixture,
            }
        }
    }

    impl Drop for OwnedHttp {
        fn drop(&mut self) {
            use std::sync::atomic::Ordering;
            self.stop.store(true, Ordering::SeqCst);
            if let Some(worker) = self.worker.take() {
                let joined = worker.join();
                self.joined.store(true, Ordering::SeqCst);
                if !std::thread::panicking() {
                    joined.expect("owned Astral HTTP worker panicked");
                }
            }
        }
    }

    #[test]
    fn version_code_is_sourced_from_app_config() {
        // 版本号单源：app.config.json → app_config.rs（这里只验证转发没被改坏）。
        // 「version.name ↔ version.code 自洽」「app_config.rs ↔ JSON 逐项一致」
        // 「Cargo.toml 版本 ↔ JSON」由 app_config.rs 的单测守着（那里能直接读 JSON）。
        assert_eq!(VERSION_CODE, crate::app_config::VERSION_CODE);
        assert_eq!(version_code(), VERSION_CODE);
        assert_eq!(version_name(), crate::app_config::VERSION_NAME);
    }

    #[test]
    fn strip_accel_prefix_recovers_original_github_url() {
        // 加速拼接链接还原直链（下载失败降级用）
        let accel = "https://ghproxy.cn/https://github.com/barry130/x/releases/download/v1/L.exe";
        assert_eq!(
            AstralClient::strip_accel_prefix(accel),
            "https://github.com/barry130/x/releases/download/v1/L.exe"
        );
        // 直链原样返回
        let direct = "https://github.com/barry130/x/releases/download/v1/L.exe";
        assert_eq!(AstralClient::strip_accel_prefix(direct), direct);
        // 非 GitHub 链接（后端自托管等）原样返回
        let other = "https://cdn.example.com/files/L.exe";
        assert_eq!(AstralClient::strip_accel_prefix(other), other);
    }

    #[test]
    fn join_accel_url_keeps_exactly_one_slash() {
        // 前缀带/不带尾斜杠，拼出的都是「前缀/https://目标」，
        // 目标开头的 https:// 必须原样保留（历史 bug：拼成 https// 后探测全挂）
        assert_eq!(
            AstralClient::join_accel_url("https://ghproxy.cn/", "https://github.com/a/b.exe"),
            "https://ghproxy.cn/https://github.com/a/b.exe"
        );
        assert_eq!(
            AstralClient::join_accel_url("https://ghproxy.cn", "https://github.com/a/b.exe"),
            "https://ghproxy.cn/https://github.com/a/b.exe"
        );
    }

    #[test]
    fn like_change_tolerates_null_fields() {
        // 云端 changes 接口会把没值的字段写成 null，只写 #[serde(default)]
        // 挡不住（那只对「字段缺失」生效），必须显式容忍，否则整条反序列化失败。
        let raw = serde_json::json!({
            "type": "song",
            "id": "s1",
            "platform": "kw",
            "name": null,
            "singer": null,
            "album": null,
            "hash": null,
            "pid": null,
            "picUrl": null,
            "deleted": null,
            "updatedSeq": null,
        });
        let c: LikeChange = serde_json::from_value(raw).expect("null 字段应归默认值");
        assert_eq!(c.kind, "song");
        assert_eq!(c.id, "s1");
        assert_eq!(c.platform, "kw");
        assert_eq!(c.name, "");
        assert_eq!(c.album, "");
        assert_eq!(c.hash, "");
        assert_eq!(c.pid, "");
        assert_eq!(c.pic_url, None);
        assert!(!c.deleted);
        assert_eq!(c.updated_seq, 0);
    }

    #[test]
    fn like_change_keeps_real_values_and_missing_fields() {
        let raw = serde_json::json!({ "type": "playlist", "id": "p1", "deleted": true });
        let c: LikeChange = serde_json::from_value(raw).expect("缺字段走 default");
        assert_eq!(c.kind, "playlist");
        assert_eq!(c.name, "");
        assert!(c.deleted);

        let raw2 = serde_json::json!({
            "type": "song",
            "id": "s2",
            "name": "晴天",
            "singer": "周杰伦",
            "album": "叶惠美",
            "hash": "abc",
            "picUrl": "http://x/y.jpg",
            "updatedSeq": 42,
        });
        let c2: LikeChange = serde_json::from_value(raw2).expect("正常解析");
        assert_eq!(c2.name, "晴天");
        assert_eq!(c2.singer, "周杰伦");
        assert_eq!(c2.hash, "abc");
        assert_eq!(c2.pic_url.as_deref(), Some("http://x/y.jpg"));
        assert_eq!(c2.updated_seq, 42);
    }

    #[test]
    fn like_change_preserves_absent_null_and_explicit_empty_pic_url() {
        for raw in [serde_json::json!({}), serde_json::json!({ "picUrl": null })] {
            let change: LikeChange = serde_json::from_value(raw).unwrap();
            assert_eq!(change.pic_url, None);
        }
        for (raw, expected) in [
            (serde_json::json!({ "picUrl": "" }), ""),
            (
                serde_json::json!({ "picUrl": "https://example.invalid/cover" }),
                "https://example.invalid/cover",
            ),
            (serde_json::json!({ "picUrl": 42 }), "42"),
        ] {
            let change: LikeChange = serde_json::from_value(raw).unwrap();
            assert_eq!(change.pic_url.as_deref(), Some(expected));
        }
    }

    #[test]
    fn stat_events_are_forced_to_platform_ut() {
        // 不起真实请求：只验证常量与构造路径。
        // 常量按编译目标三选一，断言与定义同源（cfg 一致就不会错）。
        #[cfg(target_os = "windows")]
        {
            assert_eq!(CLIENT_UT, "app-windows");
            assert_eq!(UPDATE_TYPE, "1103");
        }
        #[cfg(target_os = "linux")]
        {
            assert_eq!(CLIENT_UT, "app-linux");
            assert_eq!(UPDATE_TYPE, "1104");
        }
        #[cfg(target_os = "macos")]
        {
            assert_eq!(CLIENT_UT, "app-macos");
            assert_eq!(UPDATE_TYPE, "1105");
        }
        assert_eq!(MESSAGE_CHANNEL, "pc");
        let events =
            vec![serde_json::json!({ "evt": "launcher", "ts": 1, "deviceId": "d", "ut": "x" })];
        let mut events = events;
        for evt in events.iter_mut() {
            evt["ut"] = Value::String(CLIENT_UT.to_string());
        }
        assert_eq!(events[0]["ut"], CLIENT_UT);
    }

    #[test]
    fn client_headers_follow_the_unified_contract() {
        // 头名与取值必须与后端 astral-common 的 ClientHeaders / stat_platform 字典一致，
        // 否则接口统计与反馈两侧会各记一套维度。
        let headers = client_headers_with_metadata(&synthetic_metadata());
        let get = |name: &str| {
            headers
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| v.as_str())
        };
        // 常量与编译目标绑定，断言与定义同源（cfg 一致就不会错）
        assert_eq!(get(HDR_CLIENT_UT), Some(CLIENT_UT));
        assert_eq!(get(HDR_CLIENT_VERSION), Some(version_name()));
        // 合成最终主机名仍遵循原合同：能取到时非空且不超列宽
        if let Some(device) = get(HDR_CLIENT_DEVICE) {
            assert!(!device.is_empty());
            assert!(device.chars().count() <= MAX_DEVICE_LEN);
        }
        // 系统描述：必须能取到（Windows 最差也是 "Windows"；非 Windows 最差是
        // consts::OS），且不超列宽
        let os = get(HDR_CLIENT_OS).expect("X-OS 不应缺失");
        assert!(!os.is_empty());
        assert!(os.chars().count() <= MAX_OS_LEN, "X-OS 超长: {os}");
    }

    #[test]
    fn final_metadata_clips_utf8_and_omits_empty_values() {
        let headers = client_headers_with_metadata(&ClientMetadata {
            device: "设备".repeat(100),
            os: "系统".repeat(70),
        });
        let get = |name: &str| {
            headers
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.as_str())
        };
        // The public wire contract is 128 device characters and 64 OS characters.
        assert_eq!(get(HDR_CLIENT_DEVICE), Some("设备".repeat(64)).as_deref());
        assert_eq!(get(HDR_CLIENT_OS), Some("系统".repeat(32)).as_deref());
        let empty = client_headers_with_metadata(&ClientMetadata {
            device: String::new(),
            os: String::new(),
        });
        assert_eq!(empty.len(), 2);
        assert!(!empty
            .iter()
            .any(|(name, _)| *name == HDR_CLIENT_DEVICE || *name == HDR_CLIENT_OS));
    }

    #[test]
    fn synthetic_metadata_reaches_the_shared_http_requester() {
        let server = OwnedHttp::new(200, "", br#"{"code":200,"data":{"ok":true}}"#);
        let requester =
            Arc::new(AstralRequester::owned_loopback(server.addr).expect("owned client"));
        let client = AstralClient::new_with_transport_and_metadata(
            &format!("http://{}/api/v1", server.addr),
            requester,
            synthetic_metadata(),
        );
        let value = tauri::async_runtime::block_on(client.get(
            "app/test",
            &[("key", "fixture value")],
            false,
        ))
        .unwrap();
        assert_eq!(value, json!({ "ok": true }));
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        let wire = requests[0].to_ascii_lowercase();
        assert!(wire.starts_with("get /api/v1/app/test?key=fixture+value http/1.1\r\n"));
        assert!(wire.contains("x-device: synthetic-owned-device\r\n"));
        assert!(wire.contains("x-os: synthetic test os 1.0\r\n"));
        assert!(wire.contains(&format!("x-app-ut: {CLIENT_UT}\r\n")));
        assert!(wire.contains(&format!("x-app-version: {}\r\n", version_name())));
        assert!(!wire.contains("satoken:"));
    }

    #[test]
    fn shared_requester_sends_synthetic_auth_query_headers_and_json() {
        let server = OwnedHttp::new(200, "", b"owned-response");
        let requester = AstralRequester::owned_loopback(server.addr).expect("owned client");
        let mut headers: Vec<_> = client_headers_with_metadata(&synthetic_metadata())
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value))
            .collect();
        headers.push(("X-Final-Adapter".to_owned(), "owned".to_owned()));
        let response = tauri::async_runtime::block_on(requester.send(AstralHttpRequest {
            method: reqwest::Method::POST,
            url: format!("http://{}/submit", server.addr),
            query: vec![("key".into(), "fixture value".into())],
            json_body: Some(json!({ "value": "fixture" })),
            headers,
            satoken: Some("synthetic-transport-token".into()),
        }))
        .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body, "owned-response");
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        let wire = requests[0].to_ascii_lowercase();
        assert!(wire.starts_with("post /submit?key=fixture+value http/1.1\r\n"));
        assert!(wire.contains("satoken: synthetic-transport-token\r\n"));
        assert!(wire.contains("x-final-adapter: owned\r\n"));
        assert!(wire.contains("content-type: application/json\r\n"));
        assert!(wire.ends_with(r#"{"value":"fixture"}"#));
    }

    #[test]
    fn owned_requester_does_not_follow_redirects_or_send_to_another_origin() {
        // Even a regression's redirect destination remains another owned listener.
        let other = OwnedHttp::new(200, "", b"unexpected-redirect");
        let server = OwnedHttp::new(
            302,
            &format!("Location: http://{}/escape\r\n", other.addr),
            b"",
        );
        let requester = AstralRequester::owned_loopback(server.addr).expect("owned client");
        let request = |url| AstralHttpRequest {
            method: reqwest::Method::GET,
            url,
            query: Vec::new(),
            json_body: None,
            headers: Vec::new(),
            satoken: None,
        };
        let response = tauri::async_runtime::block_on(
            requester.send(request(format!("http://{}/redirect", server.addr))),
        )
        .unwrap();
        assert_eq!(response.status, 302);
        let rejected = tauri::async_runtime::block_on(
            requester.send(request(format!("http://{}/escape", other.addr))),
        );
        assert!(rejected.is_err());
        assert!(other.requests.lock().unwrap().is_empty());
    }

    #[test]
    fn owned_http_server_stops_and_joins_on_assertion_unwind() {
        use std::sync::atomic::Ordering;
        let server = OwnedHttp::new(200, "", b"unused");
        let joined = Arc::clone(&server.joined);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _owned = server;
            panic!("synthetic owned HTTP assertion unwind");
        }));
        assert!(result.is_err());
        assert!(joined.load(Ordering::SeqCst));
    }

    #[test]
    fn windows_family_follows_build_not_registry_product_name() {
        // 用户机器真实取值（2026-10-27 反馈详情截图）：ProductName 永远写
        // 「Windows 10 Home China」，靠 CurrentBuildNumber 才认得出是 Windows 11
        assert_eq!(
            windows_family_of("Windows 10 Home China", "26200"),
            "Windows 11 Home China"
        );
        // 21H2 起的 22000 段都是 11
        assert_eq!(
            windows_family_of("Windows 10 Pro", "22631"),
            "Windows 11 Pro"
        );
        // 22000 以下仍是 10：不能把真 Windows 10 写成 11
        assert_eq!(
            windows_family_of("Windows 10 Pro", "19045"),
            "Windows 10 Pro"
        );
        // 服务器版本来就没写「Windows 10」，命名正确，别动
        assert_eq!(
            windows_family_of("Windows Server 2025", "26100"),
            "Windows Server 2025"
        );
        // build 读不到（空串 / 非数字）时保持原样，宁可少改不可乱改
        assert_eq!(windows_family_of("Windows 10 Pro", ""), "Windows 10 Pro");
        assert_eq!(windows_family_of("Windows 10 Pro", "abc"), "Windows 10 Pro");
        assert_eq!(windows_family_of("Windows", ""), "Windows");
    }

    #[test]
    fn parse_session_reads_token_and_defaults_expiry() {
        let data = serde_json::json!({ "token": "abc", "expiresIn": 3600 });
        let s = parse_session(&data).expect("解析会话");
        assert_eq!(s.token, "abc");
        assert!(s.is_valid());
        assert!(s.expires_at > now_ms());
    }

    #[test]
    fn parse_session_ignores_unknown_fields_and_defaults_expiry() {
        let data = serde_json::json!({
            "token": "access",
            "refreshToken": "refresh",
            "expiresIn": 60,
        });
        let s = parse_session(&data).expect("解析会话");
        assert_eq!(s.token, "access");
        // 没给 expiresIn 时按 7 天兜底
        let no_expiry = serde_json::json!({ "token": "a" });
        let s2 = parse_session(&no_expiry).expect("解析会话");
        assert!(s2.expires_at - now_ms() > 6 * 24 * 3600 * 1000);
    }

    #[test]
    fn parse_session_rejects_missing_token() {
        assert!(parse_session(&serde_json::json!({ "msg": "ok" })).is_err());
    }

    #[test]
    fn refresh_path_detection_is_exact() {
        assert!(refresh_path("app/user/refresh"));
        assert!(refresh_path("/app/user/refresh"));
        // 只有刷新接口本身豁免续期/重试，别的路径不能误伤
        assert!(!refresh_path("app/user/refreshToken"));
        assert!(!refresh_path("app/user/me"));
        assert!(!refresh_path("app/user/login"));
    }

    #[test]
    fn proactive_refresh_window_is_five_minutes() {
        let now = now_ms();
        assert!(should_proactive_refresh(now + 4 * 60 * 1000, now));
        assert!(should_proactive_refresh(now, now));
        assert!(!should_proactive_refresh(now + 6 * 60 * 1000, now));
    }

    #[test]
    fn refresh_rejection_classification() {
        // 明确拒绝：清登录态
        assert!(is_definitive_refresh_rejection(ERR_UNAUTHORIZED));
        assert!(is_definitive_refresh_rejection(
            "Astral 业务错误(401): token 无效"
        ));
        assert!(is_definitive_refresh_rejection("登录响应里没有 token"));
        // 网络类：保留登录态下次再试（对齐 uniappx tryRefreshToken 的 network 态）
        assert!(!is_definitive_refresh_rejection(
            "Astral 请求失败: error sending request for url (…)"
        ));
        assert!(!is_definitive_refresh_rejection(
            "Astral 响应解析失败(502): expected value"
        ));
    }

    #[test]
    fn set_session_tracks_expiry_and_clear_resets_it() {
        let client = AstralClient::new("http://localhost:1");
        let session = AuthSession {
            token: "t".to_string(),
            expires_at: now_ms() + 3 * 60 * 60 * 1000,
        };
        client.set_session(&session);
        assert_eq!(client.expires_at_ms(), session.expires_at);
        client.set_token(None);
        assert_eq!(client.expires_at_ms(), 0);
        assert!(!client.has_token());
    }

    #[test]
    fn installer_signature_verify_accepts_and_rejects() {
        use base64::Engine;
        // 一次性测试密钥的向量（与正式发布密钥无关，keygen 生成后硬编码）
        let pk = "eKSkjb+EApZL+AWn0zr8MNQ9B6lVUu17PmviXVsQUKs=";
        let sig = "ZjTBlCB8YTAAunfv+IzJCDECkgWIJz+VwP/sJV/E8xcFQ1EM2XQuIsKGyNz0bLwMUvu9eFY0qKNYsvUQZaZGDQ==";
        let content = base64::engine::general_purpose::STANDARD
            .decode("cXQtcGMgdXBkYXRlIHNpZ25hdHVyZSB0ZXN0IHZlY3Rvcgo=")
            .expect("测试内容");
        let dir = crate::lyric_access::native_fixture::NativeFixture::new("astral-sig");
        let file = dir.file("payload.bin", &content);
        // 正确签名通过
        assert!(AstralClient::verify_installer_signature_with(&file, sig, pk).is_ok());
        // 内容被篡改 → 拒绝
        crate::lyric_access::native_fixture::write_owned(&file, b"tampered").expect("改写测试文件");
        assert!(AstralClient::verify_installer_signature_with(&file, sig, pk).is_err());
        // 签名被篡改 → 拒绝
        crate::lyric_access::native_fixture::write_owned(&file, &content).expect("还原测试文件");
        let bad_sig = format!("{}A", &sig[..sig.len() - 1]);
        assert!(AstralClient::verify_installer_signature_with(&file, &bad_sig, pk).is_err());
        // 换成内嵌正式公钥 → 拒绝（测试密钥签的东西不认）
        assert!(
            AstralClient::verify_installer_signature_with(&file, sig, UPDATE_SIGN_PUBKEY_B64)
                .is_err()
        );
        dir.remove();
    }

    #[test]
    fn auth_error_predicate_only_matches_server_denial() {
        assert!(is_auth_error(ERR_UNAUTHORIZED));
        // 网络不可达不能算"会话失效"，否则断网就会把用户登出
        assert!(!is_auth_error(
            "Astral 请求失败: error sending request for url (http://localhost:27000/api/v1/app/user/me)"
        ));
        assert!(!is_auth_error("Astral 业务错误(500): 服务器开小差"));
    }

    #[test]
    fn expired_session_is_not_valid() {
        let s = AuthSession {
            token: "t".to_string(),
            expires_at: now_ms() - 1_000,
        };
        assert!(!s.is_valid());
    }

    #[test]
    fn like_song_body_carries_pic_url_on_add() {
        // §8.2：add + 非空 picUrl → 请求体带 picUrl（并保留 pid）
        let p = LikeSongPayload {
            action: "add",
            sid: "s1",
            platform: "kw",
            name: "晴天",
            singer: "周杰伦",
            album: "叶惠美",
            hash: Some("h1"),
            pid: Some("pl1"),
            pic_url: Some("http://x/y.jpg"),
        };
        let body = like_song_body(&p);
        assert_eq!(body["action"], "add");
        assert_eq!(body["hash"], "h1");
        assert_eq!(body["pid"], "pl1");
        assert_eq!(body["picUrl"], "http://x/y.jpg");
    }

    #[test]
    fn like_song_body_skips_empty_pic_url_on_add() {
        // §11.3-6：非空才上送 - 空字符串与 None 都不带 picUrl，且不覆盖云端
        for pic in [Some(""), None] {
            let p = LikeSongPayload {
                action: "add",
                sid: "s1",
                platform: "kw",
                name: "n",
                singer: "s",
                album: "a",
                hash: None,
                pid: Some("pl1"),
                pic_url: pic,
            };
            let body = like_song_body(&p);
            assert!(body.get("picUrl").is_none(), "空 picUrl 不应上送: {body}");
            assert_eq!(body["pid"], "pl1", "pid 仍应保留");
        }
    }

    #[test]
    fn like_song_body_omits_pic_url_and_pid_on_remove() {
        // §8.2 / D3：remove 不带 pid、不带 picUrl
        let p = LikeSongPayload {
            action: "remove",
            sid: "s1",
            platform: "kw",
            name: "n",
            singer: "s",
            album: "a",
            hash: None,
            pid: Some("pl1"),
            pic_url: Some("http://x/y.jpg"),
        };
        let body = like_song_body(&p);
        assert_eq!(body["action"], "remove");
        assert!(body.get("pid").is_none(), "remove 不带 pid: {body}");
        assert!(body.get("picUrl").is_none(), "remove 不带 picUrl: {body}");
    }

    #[test]
    fn sanitize_err_strips_urls_keeps_reason() {
        // reqwest 网络错误的典型形态（带请求地址）
        let e = "error sending request for url (https://api.example.com/api/v1/app/source/manifest?platform=1103)";
        assert_eq!(sanitize_err(e), "error sending request for url (…)");
        let e2 = "Astral 请求失败: https://cdn.example.com/p/xyz/1 超时";
        assert_eq!(sanitize_err(e2), "Astral 请求失败: … 超时");
        // 无 URL 原样通过；中文/尾部 URL 也能处理
        assert_eq!(
            sanitize_err("manifest 解析失败: invalid type"),
            "manifest 解析失败: invalid type"
        );
        assert_eq!(sanitize_err("拉取 https://x.cn/a 失败"), "拉取 … 失败");
    }

    /// P2-4 的关键运行时假设（下载实现就靠它）：阻塞池线程上可以用运行时句柄
    /// `block_on` 驱动异步 reqwest，且事件驱动照常工作。
    /// 这里起一个本地 TCP 服务器真发一次异步 HTTP 请求，验证：
    /// - `block_on` 在阻塞池线程上不 panic（"Cannot start a runtime from within a
    ///   runtime" 只在已处于 runtime 上下文的线程上触发，阻塞池线程不是）；
    /// - 响应能在被 park 住的线程上被唤醒并读到完整 body（否则这条会挂住/超时）。
    #[test]
    fn blocking_pool_thread_can_drive_async_request() {
        let server = OwnedHttp::new(200, "", b"hello-update");
        let addr = server.addr;
        let got = tauri::async_runtime::block_on(async move {
            tauri::async_runtime::spawn_blocking(move || {
                // 与 download_update_file 完全同款：阻塞池线程 + 运行时句柄 block_on
                let rt = tauri::async_runtime::handle();
                rt.block_on(async move {
                    let requester = AstralRequester::owned_loopback(addr).expect("client");
                    let headers = client_headers_with_metadata(&synthetic_metadata())
                        .into_iter()
                        .map(|(name, value)| (name.to_owned(), value))
                        .collect();
                    let response = requester
                        .send(AstralHttpRequest {
                            method: reqwest::Method::GET,
                            url: format!("http://{addr}/a.bin"),
                            query: Vec::new(),
                            json_body: None,
                            headers,
                            satoken: None,
                        })
                        .await
                        .expect("send");
                    assert_eq!(response.status, 200);
                    response.body.into_bytes()
                })
            })
            .await
            .expect("join")
        });
        assert_eq!(got, b"hello-update");
        // The listener stays owned until every awaited operation/byte assertion ends.
        drop(server);
    }

    /// P2-4：图片读盘有 8 MiB 上限，且读盘本身在阻塞池线程上完成
    #[test]
    fn image_bytes_are_capped_and_read_off_async_thread() {
        let dir = crate::lyric_access::native_fixture::NativeFixture::new("astral-img");
        let small = dir.file("small.png", b"png-bytes");

        // 预检：扩展名 → MIME、大小如实上报
        let (name, mime, size) =
            AstralClient::image_meta(small.to_str().unwrap(), "avatar").expect("meta");
        assert_eq!(name, "avatar.png");
        assert_eq!(mime, "image/png");
        assert_eq!(size, 9);

        // 实读：正常文件原样读回（走 spawn_blocking，不占 async 线程）
        let bytes =
            tauri::async_runtime::block_on(AstralClient::read_image_bytes(small.to_str().unwrap()))
                .expect("read");
        assert_eq!(bytes, b"png-bytes");

        // 超限文件：稀疏文件（set_len 不真占磁盘）也会在读之前/读之中被挡住
        let big = dir.file("big.jpg", b"");
        std::fs::OpenOptions::new()
            .write(true)
            .open(&big)
            .expect("open owned big")
            .set_len(AstralClient::IMAGE_UPLOAD_MAX_BYTES + 1)
            .expect("set_len");
        let err = AstralClient::image_meta(big.to_str().unwrap(), "avatar").unwrap_err();
        assert!(err.contains("图片过大"), "预检文案: {err}");
        let err =
            tauri::async_runtime::block_on(AstralClient::read_image_bytes(big.to_str().unwrap()))
                .unwrap_err();
        assert!(err.contains("图片过大"), "实读文案: {err}");
        assert!(err.contains("8 MiB"), "上限要写清楚: {err}");

        // 不在白名单里的扩展名照旧被拒（原有行为不变）
        let bad = dir.file("x.bmp", b"bmp");
        let err = AstralClient::image_meta(bad.to_str().unwrap(), "avatar").unwrap_err();
        assert!(err.contains("暂不支持的图片格式"), "格式文案: {err}");

        dir.remove();
    }
}
