//! Astral HTTP 客户端（DESIGN §2.3.4）：
//! base_url + satoken 附加 + QtRestResp 解析。
//! 401 自动刷新依赖登录单元（token 尚未接入 Windows 凭据管理器），当前直接报错返回。

use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
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
    #[serde(default, deserialize_with = "de_string_or_default")]
    pub pic_url: String,
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
/// （后端返回 `token` / `refreshToken` / `expiresIn`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub token: String,
    pub refresh_token: String,
    /// 过期时间（Unix 毫秒）。后端不返回 expiresIn 时按 7 天算，与移动端一致。
    pub expires_at: i64,
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
    // 后端不单独给 refreshToken 时，用 access token 顶上（与移动端降级策略一致）
    let refresh_token = data
        .get("refreshToken")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(&token)
        .to_string();
    let expires_in = data
        .get("expiresIn")
        .and_then(Value::as_i64)
        .unwrap_or(7 * 24 * 3600);
    Ok(AuthSession {
        token,
        refresh_token,
        expires_at: now_ms() + expires_in * 1000,
    })
}

/// 生产后端（线上环境，qt-uniappx services/config.local.ts API_BASE_URL_PROD 同源）
pub const PROD_BASE_URL: &str = "http://astral.canace.cn/api/v1/";
/// 本地开发后端（本机 astral 服务，qt-uniappx services/config.local.ts API_BASE_URL_DEV 同源）
pub const DEV_BASE_URL: &str = "http://localhost:27000/api/v1/";
/// 当前生效的后端地址：生产后端（音源包 P2 联调已完成；联调期间临时切 `DEV_BASE_URL`）。
pub const DEFAULT_BASE_URL: &str = PROD_BASE_URL;

/// 更新 / 消息 / 统计的平台固定参数（§15.2）
pub const UPDATE_TYPE: &str = "1103";
pub const MESSAGE_CHANNEL: &str = "pc";
pub const STAT_UT: &str = "app-windows";
pub const FEEDBACK_PLATFORM: &str = "windows";

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
                .find([' ', '\t', '\r', '\n', '"', '\'', '(', ')', '<', '>', ',', '[', ']', '{', '}'])
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
    let client = reqwest::Client::builder()
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

pub struct AstralClient {
    http: reqwest::Client,
    base_url: String,
    /// 登录单元接入前恒为 None；请求时出现则附 satoken 头
    satoken: RwLock<Option<String>>,
}

impl AstralClient {
    pub fn new(base_url: &str) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .pool_max_idle_per_host(0)
                .build()
                .expect("reqwest client"),
            base_url: base_url.trim_end_matches('/').to_string(),
            satoken: RwLock::new(None),
        }
    }

    pub fn set_token(&self, token: Option<String>) {
        *self.satoken.write().expect("satoken lock") = token;
    }

    /// 是否已登录（装着 satoken）。收藏同步据此决定要不要推送。
    pub fn has_token(&self) -> bool {
        self.satoken
            .read()
            .map(|g| g.as_ref().is_some_and(|t| !t.is_empty()))
            .unwrap_or(false)
    }

    /// 共享的 HTTP 客户端（大文件下载等场景复用连接池）
    pub fn http(&self) -> reqwest::Client {
        self.http.clone()
    }

    /// 当前生效的后端基地址（音源包 manifest 直拼 URL 用）
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    fn token(&self) -> Option<String> {
        self.satoken.read().expect("satoken lock").clone()
    }

    /// 发请求并解 QtRestResp：code 0/200 → Ok(data)；其余 → Err(msg)。
    /// 返回的 data 可能为 Value::Null（后端 success(null)）。
    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, &str)],
        json_body: Option<Value>,
        extra_headers: &[(&str, &str)],
        auth: bool,
    ) -> Result<Value, String> {
        let url = format!("{}/{}", self.base_url, path.trim_start_matches('/'));
        let mut req = self.http.request(method, &url).query(query);
        if auth {
            if let Some(token) = self.token() {
                req = req.header("satoken", token);
            }
        }
        for (k, v) in extra_headers {
            req = req.header(*k, *v);
        }
        if let Some(body) = json_body {
            req = req.json(&body);
        }
        let resp = req.send().await.map_err(|e| format!("Astral 请求失败: {}", sanitize_err(e)))?;
        let status = resp.status();
        let body: Value = resp.json().await.map_err(|e| format!("Astral 响应解析失败({status}): {e}"))?;
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
        self.request(reqwest::Method::GET, path, query, None, &[], auth).await
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
        let headers: Vec<(&str, &str)> =
            extra_headers.iter().map(|(k, v)| (*k, v.as_str())).collect();
        self.request(reqwest::Method::POST, path, &[], Some(body), &headers, auth)
            .await
    }

    // ---------- 账号（接口契约对齐 qt-uniappx services/music-api.ts AccountApi） ----------

    /// 登录。成功即把 token 装进客户端（后续请求自动带 satoken）。
    pub async fn login(&self, username: &str, password: &str) -> Result<AuthSession, String> {
        let data = self
            .post_json("app/user/login", json!({ "username": username, "password": password }), &[], false)
            .await?;
        let session = parse_session(&data)?;
        self.set_token(Some(session.token.clone()));
        Ok(session)
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
    ) -> Result<AuthSession, String> {
        let mut body = json!({
            "username": username,
            "password": password,
            "passwordConfirm": password_confirm,
        });
        if let Some(e) = email.filter(|s| !s.is_empty()) {
            body["email"] = json!(e);
        }
        let data = self
            .post_json("app/user/register", body, &[], false)
            .await?;
        let session = parse_session(&data)?;
        self.set_token(Some(session.token.clone()));
        Ok(session)
    }

    /// 当前登录用户信息（app/user/me）
    pub async fn me(&self) -> Result<Value, String> {
        self.get("app/user/me", &[], true).await
    }

    /// 退出登录：无论后端是否成功，本地 token 都会清掉
    pub async fn logout(&self) -> Result<(), String> {
        let result = self
            .post_json("app/user/logout", json!({}), &[], true)
            .await
            .map(|_| ());
        self.set_token(None);
        result
    }

    /// 用 refresh token 换新会话（需要先装着旧 token，后端按 satoken 识别）
    pub async fn refresh(&self) -> Result<AuthSession, String> {
        let data = self
            .post_json("app/user/refresh", json!({}), &[], true)
            .await?;
        let session = parse_session(&data)?;
        self.set_token(Some(session.token.clone()));
        Ok(session)
    }

    /// 发送邮箱验证码（注册 / 找回密码共用）。body 是邮件正文，由调用方决定文案。
    pub async fn send_email_code(&self, email: &str, body: &str) -> Result<Value, String> {
        self.post_json("app/user/email", json!({ "email": email, "body": body }), &[], false)
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
            .get("app/user/like/changes", &[("since", &since.to_string())], true)
            .await?;
        let changes = data
            .get("changes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let max_seq = data
            .get("maxSeq")
            .and_then(Value::as_i64)
            .unwrap_or(since);
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

    /// 离线队列重放：payload 是入队时序列化好的请求体，直接上送。
    pub async fn post_like_raw(&self, path: &str, payload_json: &str) -> Result<Value, String> {
        let body: Value = serde_json::from_str(payload_json)
            .map_err(|e| format!("离线队列 payload 解析失败: {e}"))?;
        self.post_json(path, body, &[], true).await
    }

    /// 更新个人资料（昵称 / 头像等字段由后端约定，这里原样透传）
    pub async fn update_profile(&self, patch: Value) -> Result<Value, String> {
        self.post_json("app/user/update", patch, &[], true).await
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

    // ---------- 更新（§15.3 / §15.7）：version 传 versionCode 数字字符串 ----------

    pub async fn app_update(&self, version_code: i64, channel: &str) -> Result<Value, String> {
        let code_str = version_code.to_string();
        self.get("app/update", &[("type", UPDATE_TYPE), ("version", &code_str), ("channel", channel)], false)
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
            &[("type", UPDATE_TYPE), ("version", &code_str), ("versionName", version_name)],
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
        for prefix in accels {
            if let Some(latency) = Self::probe_accel(&prefix, download_url).await {
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
    pub async fn download_update_file(
        _http: &reqwest::Client,
        url: &str,
        app: &tauri::AppHandle,
    ) -> Result<std::path::PathBuf, String> {
        use std::io::Write;
        use tauri::Emitter;

        // 专用下载 client（理由见方法注释）；参数保留以兼容现有调用方
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .pool_max_idle_per_host(0)
            .build()
            .map_err(|e| format!("下载客户端初始化失败: {e}"))?;

        let dir = std::env::temp_dir().join("quietmusic-update");
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败: {e}"))?;
        let file_name = url
            .split('/')
            .next_back()
            .filter(|s| !s.is_empty() && !s.contains('?'))
            .unwrap_or("quietmusic-setup.exe");
        let path = dir.join(file_name);

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
            file.write_all(&chunk).map_err(|e| format!("写入失败: {e}"))?;
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
                return Err(format!("文件大小不符：期望 {expect} 字节，实际 {actual} 字节"));
            }
        }
        if let Some(expect) = expect_md5.filter(|s| !s.is_empty()) {
            use md5::Digest;
            let mut file =
                std::fs::File::open(path).map_err(|e| format!("读取文件失败: {e}"))?;
            let mut hasher = md5::Md5::default();
            let mut buf = [0u8; 65536];
            loop {
                let n = file.read(&mut buf).map_err(|e| format!("读取文件失败: {e}"))?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
            }
            let actual = format!("{:x}", hasher.finalize());
            if !actual.eq_ignore_ascii_case(expect) {
                return Err(format!("MD5 校验不符：期望 {expect}，实际 {actual}"));
            }
        }
        Ok(())
    }

    // ---------- 消息（§15.4）：固定 channel=pc ----------

    pub async fn active_messages(&self, version_code: i64) -> Result<Value, String> {
        let code_str = version_code.to_string();
        self.get("app/message/active", &[("versionCode", &code_str), ("channel", MESSAGE_CHANNEL)], false)
            .await
    }

    pub async fn message_center(&self) -> Result<Value, String> {
        self.get("app/message/center", &[("channel", MESSAGE_CHANNEL)], true).await
    }

    pub async fn unread_count(&self) -> Result<Value, String> {
        self.get("app/message/unread-count", &[("channel", MESSAGE_CHANNEL)], true).await
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

    // ---------- 统计（§15.4）：ut 固定 app-windows，单批 ≤200 ----------

    pub async fn report_stats(&self, mut events: Vec<Value>) -> Result<(), String> {
        if events.len() > 200 {
            return Err("单批统计事件不能超过 200".to_string());
        }
        for evt in &mut events {
            if let Some(obj) = evt.as_object_mut() {
                obj.insert("ut".to_string(), Value::String(STAT_UT.to_string()));
            }
        }
        // App 端上报走 AppStatController：/api/v1/app/stat/report（旧 /api/v1/stat/report
        // 已废弃，见该控制器注释）。base_url 已含 /api/v1/，拼相对路径 app/stat/report
        self.post_json("app/stat/report", serde_json::json!({ "events": events }), &[], false)
            .await
            .map(|_| ())
    }

    // ---------- 反馈：X-Platform: windows ----------

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
        let headers = feedback_headers();
        self.post_json("app/feedback/submit", body, &headers, true).await
    }

    pub async fn my_feedback(&self, page_num: i64, page_size: i64) -> Result<Value, String> {
        self.get(
            "app/feedback/my",
            &[("pageNum", &page_num.to_string()), ("pageSize", &page_size.to_string())],
            true,
        )
        .await
    }

    pub async fn public_feedback(&self, page_num: i64, page_size: i64) -> Result<Value, String> {
        self.get(
            "app/feedback/public",
            &[("pageNum", &page_num.to_string()), ("pageSize", &page_size.to_string())],
            true,
        )
        .await
    }

    pub async fn feedback_detail(&self, id: i64) -> Result<Value, String> {
        self.get(&format!("app/feedback/{id}"), &[], true).await
    }

    pub async fn feedback_replies(&self, id: i64) -> Result<Value, String> {
        self.get(&format!("app/feedback/{id}/replies"), &[], true).await
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
}

/// 反馈提交附带的设备信息头（X-Platform 固定 windows，§15.2）
fn feedback_headers() -> Vec<(&'static str, String)> {
    vec![("X-Platform", FEEDBACK_PLATFORM.to_string())]
}

/// versionName：Cargo 包版本（与 tauri.conf.json version 保持一致，单一真值 §15.7）
pub fn version_name() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// versionCode：发版时手动维护的整数（与移动端 manifest.json 的 versionCode 同一约定），
/// 必须和后端 qt_app_update 表里对应版本的记录一致——更新检查就是拿它比大小。
/// 1.0.0 → 100；1.0.1 → 101；1.0.2 → 102；1.0.3 → 103；1.0.4 → 104；1.0.5 → 105；
/// 1.0.6 → 106；1.0.7 → 107；下次发版记得同步 +1。
pub const VERSION_CODE: i64 = 107;

pub fn version_code() -> i64 {
    VERSION_CODE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_code_is_the_manual_release_constant() {
        // versionCode 不再从版本号推导（旧公式 1.0.0 会算出 10000），
        // 而是与后端 qt_app_update 记录对齐的手动常量：1.0.0 → 100 … 1.0.7 → 107
        assert_eq!(VERSION_CODE, 107);
        assert_eq!(version_code(), VERSION_CODE);
        assert_eq!(version_name(), env!("CARGO_PKG_VERSION"));
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
        let other = "https://astral.canace.cn/files/L.exe";
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
        assert_eq!(c.pic_url, "");
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
        assert_eq!(c2.pic_url, "http://x/y.jpg");
        assert_eq!(c2.updated_seq, 42);
    }

    #[test]
    fn stat_events_are_forced_to_windows_ut() {
        // 不起真实请求：只验证常量与构造路径
        assert_eq!(STAT_UT, "app-windows");
        assert_eq!(UPDATE_TYPE, "1103");
        assert_eq!(MESSAGE_CHANNEL, "pc");
        assert_eq!(FEEDBACK_PLATFORM, "windows");
        let events = vec![serde_json::json!({ "evt": "launcher", "ts": 1, "deviceId": "d", "ut": "x" })];
        let mut events = events;
        for evt in events.iter_mut() {
            evt["ut"] = Value::String(STAT_UT.to_string());
        }
        assert_eq!(events[0]["ut"], "app-windows");
    }

    #[test]
    fn parse_session_reads_token_and_falls_back_to_access_token() {
        let data = serde_json::json!({ "token": "abc", "expiresIn": 3600 });
        let s = parse_session(&data).expect("解析会话");
        assert_eq!(s.token, "abc");
        // 后端没单独给 refreshToken → 用 access token 顶上（与移动端降级策略一致）
        assert_eq!(s.refresh_token, "abc");
        assert!(s.is_valid());
        assert!(s.expires_at > now_ms());
    }

    #[test]
    fn parse_session_uses_refresh_token_when_present() {
        let data = serde_json::json!({
            "token": "access",
            "refreshToken": "refresh",
            "expiresIn": 60,
        });
        let s = parse_session(&data).expect("解析会话");
        assert_eq!(s.token, "access");
        assert_eq!(s.refresh_token, "refresh");
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
            refresh_token: "r".to_string(),
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
        let e = "error sending request for url (http://astral.canace.cn/api/v1/app/source/manifest?platform=1103)";
        assert_eq!(sanitize_err(e), "error sending request for url (…)");
        let e2 = "Astral 请求失败: https://storage.canace.icu/p/xyz/1 超时";
        assert_eq!(sanitize_err(e2), "Astral 请求失败: … 超时");
        // 无 URL 原样通过；中文/尾部 URL 也能处理
        assert_eq!(sanitize_err("manifest 解析失败: invalid type"), "manifest 解析失败: invalid type");
        assert_eq!(sanitize_err("拉取 https://x.cn/a 失败"), "拉取 … 失败");
    }
}
