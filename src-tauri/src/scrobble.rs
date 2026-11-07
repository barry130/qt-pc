//! 外部 scrobble：Last.fm / ListenBrainz（A8，2026-11-01）。
//!
//! ## 分工
//! 引擎只负责**判定「这次收听算不算数」**（`should_scrobble`）并把结果写进
//! `scrobbles` 队列表（`db/store/scrobbles.rs`）；真正的 HTTP 由本模块的冲刷器
//! 做。播放线程永远不因为第三方服务慢/挂而卡住，失败的收听也不会丢。
//!
//! ## 两个目标、两套协议
//! · Last.fm：`ws.audioscrobbler.com/2.0/`，**全部参数参与 MD5 签名**
//!   （`api_sig` = md5(按 key 排序的 key+value 串接 + api_secret)），写操作要
//!   `sk`（session key）。桌面端没有回调地址，所以走 token 流程：
//!   先 `auth.getToken` 拿 token，让用户去 `last.fm/api/auth` 点授权，
//!   再 `auth.getSession` 把 token 换成 session key。用户得自己在 Last.fm
//!   申请一对 api key/secret（开源播放器通行做法：key 不是本项目的资产）。
//! · ListenBrainz：`api.listenbrainz.org/1/`，只要一个 user token 走
//!   `Authorization: Token <token>`（**不是 `Bearer`**；用错方案对方会回
//!   400 `You need to provide an Authorization token.`），请求体是 JSON。
//!   `validate-token` 只接受 **GET**，POST 会拿到 405 HTML，所以校验与上报
//!   走两个不同的请求方法。
//!
//! ## 上报时机
//! 播放开始发 now playing（可选，失败无所谓）；收听**跨过阈值**时入队一次。
//! 阈值口径与 Last.fm 官方一致：曲目至少 30 秒，且听了「一半或 4 分钟」。
//! 入队幂等靠 `(target, track_id, played_at)` 唯一键 —— 引擎每 30 秒结算一次，
//! 同一会话只会入队一次。

use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock, RwLock};

use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};

use crate::db::store::{
    self, ScrobbleQueueStats, ScrobbleRow, TARGET_LASTFM, TARGET_LISTENBRAINZ,
};
use crate::db::Database;
use crate::provider::types::Track;

// ---------- 设置键（本模块私有，不进 settings_keys.rs：只有这里读写） ----------

/// 是否把收听上报到 Last.fm（"1"/"0"，缺省 = 关：涉及第三方账号，必须显式开）
pub(crate) const KEY_LASTFM_ENABLED: &str = "scrobble.lastfm.enabled";
/// Last.fm 应用的 api key（用户自备）
pub(crate) const KEY_LASTFM_API_KEY: &str = "scrobble.lastfm.apiKey";
/// Last.fm 应用的 shared secret（用户自备，明文存 settings 表，设置页有提示）
pub(crate) const KEY_LASTFM_SECRET: &str = "scrobble.lastfm.apiSecret";
/// Last.fm session key（授权完成后写入，等价于登录态）
pub(crate) const KEY_LASTFM_SESSION: &str = "scrobble.lastfm.session";
/// Last.fm 用户名（授权后对方返回，仅展示）
pub(crate) const KEY_LASTFM_USER: &str = "scrobble.lastfm.user";
/// 授权流程中间态：`auth.getToken` 拿到的 token，等用户去网页点授权
pub(crate) const KEY_LASTFM_TOKEN: &str = "scrobble.lastfm.token";
/// 是否把收听上报到 ListenBrainz
pub(crate) const KEY_LISTENBRAINZ_ENABLED: &str = "scrobble.listenbrainz.enabled";
/// ListenBrainz user token
pub(crate) const KEY_LISTENBRAINZ_TOKEN: &str = "scrobble.listenbrainz.token";
/// ListenBrainz 用户名（校验 token 时对方返回）
pub(crate) const KEY_LISTENBRAINZ_USER: &str = "scrobble.listenbrainz.user";

pub(crate) const LASTFM_API: &str = "https://ws.audioscrobbler.com/2.0/";
pub(crate) const LASTFM_AUTH_PAGE: &str = "https://www.last.fm/api/auth/";
pub(crate) const LISTENBRAINZ_API: &str = "https://api.listenbrainz.org/1";

/// 单次冲刷最多带几首（Last.fm 官方上限 50）。
pub(crate) const BATCH: usize = 50;
/// 短于这个时长的曲目不 scrobble（Last.fm 规则）。
pub(crate) const MIN_TRACK_MS: i64 = 30_000;
/// 阈值上限：听满 4 分钟就算数，不管曲目多长。
pub(crate) const MAX_SCROBBLE_MS: i64 = 240_000;
/// 阈值下限：再短的曲目也要真听够 15 秒（挡住"点开就切"）。
pub(crate) const MIN_LISTEN_MS: i64 = 15_000;

// ---------- 纯逻辑：判定 / 签名 / 请求体 ----------

/// 这次收听够不够 scrobble 的资格。
///
/// 口径对齐 Last.fm：曲目短于 30 秒不上报；听了「一半」或「4 分钟」（取小者）
/// 就算一次收听。`duration_ms = 0`（时长未知）时按 4 分钟算，避免长短曲误判。
pub(crate) fn should_scrobble(listened_ms: i64, duration_ms: i64) -> bool {
    if duration_ms > 0 && duration_ms < MIN_TRACK_MS {
        return false;
    }
    let threshold = if duration_ms > 0 {
        (duration_ms / 2).min(MAX_SCROBBLE_MS)
    } else {
        MAX_SCROBBLE_MS
    };
    listened_ms >= threshold.max(MIN_LISTEN_MS)
}

/// Last.fm 的 `api_sig`：按 key 字典序把 `key + value` 依次串接，末尾接 secret，取 MD5。
///
/// 空值的参数**不参与**签名（Last.fm 官方口径），调用方传进来的
/// `BTreeMap` 已按 key 排好序。
pub(crate) fn lastfm_signature(params: &BTreeMap<String, String>, secret: &str) -> String {
    let mut buf = String::new();
    for (k, v) in params {
        if v.is_empty() {
            continue;
        }
        buf.push_str(k);
        buf.push_str(v);
    }
    buf.push_str(secret);
    use md5::Digest;
    let mut hasher = md5::Md5::default();
    hasher.update(buf.as_bytes());
    // md-5 0.11 的 finalize() 返回 hybrid_array::Array，不实现 LowerHex，
    // `format!("{:x}")` 编译不过（astral.rs 里同样的坑）。自己转十六进制。
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// 把参数表变成带签名的表单（含 `api_sig`，且补上 `format=json`）。
///
/// `format` 不参与签名（Last.fm 明确说明），所以先算签名再插。
pub(crate) fn sign_form(
    mut params: BTreeMap<String, String>,
    secret: &str,
) -> Vec<(String, String)> {
    let sig = lastfm_signature(&params, secret);
    params.insert("api_sig".to_string(), sig);
    params.insert("format".to_string(), "json".to_string());
    params.into_iter().collect()
}

/// 一次收听转成 Last.fm `track.scrobble` 的**下标参数**（`artist[0]` 这类）。
///
/// 批量上报时下标必须连续从 0 开始，否则对方会静默丢掉第 2 首之后的部分。
pub(crate) fn lastfm_scrobble_params(
    rows: &[ScrobbleRow],
    api_key: &str,
    session: &str,
) -> BTreeMap<String, String> {
    let mut p = BTreeMap::new();
    p.insert("method".into(), "track.scrobble".into());
    p.insert("api_key".into(), api_key.to_string());
    p.insert("sk".into(), session.to_string());
    for (i, row) in rows.iter().enumerate() {
        p.insert(format!("artist[{i}]"), row.artist.clone());
        p.insert(format!("track[{i}]"), row.title.clone());
        p.insert(format!("timestamp[{i}]"), row.played_at.to_string());
        if !row.album.trim().is_empty() {
            p.insert(format!("album[{i}]"), row.album.clone());
        }
        if row.duration_ms > 0 {
            // Last.fm 要的是**秒**
            p.insert(format!("duration[{i}]"), (row.duration_ms / 1000).to_string());
        }
    }
    p
}

/// now playing 的参数（`track.updateNowPlaying`）。
pub(crate) fn lastfm_now_playing_params(
    track: &Track,
    api_key: &str,
    session: &str,
) -> BTreeMap<String, String> {
    let mut p = BTreeMap::new();
    p.insert("method".into(), "track.updateNowPlaying".into());
    p.insert("api_key".into(), api_key.to_string());
    p.insert("sk".into(), session.to_string());
    p.insert("artist".into(), track.singer.trim().to_string());
    p.insert("track".into(), track.title.trim().to_string());
    if !track.album.trim().is_empty() {
        p.insert("album".into(), track.album.trim().to_string());
    }
    if track.duration > 0.0 {
        p.insert("duration".into(), (track.duration.round() as i64).to_string());
    }
    p
}

/// ListenBrainz 的 `track_metadata`。
fn listenbrainz_metadata(row_artist: &str, row_title: &str, row_album: &str) -> Value {
    let mut meta = json!({
        "artist_name": row_artist,
        "track_name": row_title,
        "submission_client": "QuietMusic",
    });
    if !row_album.trim().is_empty() {
        meta["release_name"] = json!(row_album);
    }
    meta
}

/// ListenBrainz `submit-listens`（import）的请求体。
///
/// `listen_type` 必须是 `import`：服务端 `webserver/views/api.py` 只认
/// `('playing_now', 'single', 'import')`，其中 `single`/`playing_now` 还限制
/// payload 只能 1 条；`import` 就是「批量补报历史 listens」的正式语义，没有
/// payload 长度限制。发 `multiple` 会被 400
/// "JSON document requires a valid listen_type key." 拒掉（2026-11-02 实测）。
pub(crate) fn listenbrainz_payload(rows: &[ScrobbleRow]) -> Value {
    let payload: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mut item = json!({
                "listened_at": row.played_at,
                "track_metadata": listenbrainz_metadata(&row.artist, &row.title, &row.album),
            });
            if row.duration_ms > 0 {
                item["track_metadata"]["additional_info"] = json!({ "duration_ms": row.duration_ms });
            }
            item
        })
        .collect();
    json!({ "listen_type": "import", "payload": payload })
}

/// ListenBrainz now playing 的请求体。
pub(crate) fn listenbrainz_now_playing_payload(track: &Track) -> Value {
    let mut meta = listenbrainz_metadata(
        track.singer.trim(),
        track.title.trim(),
        track.album.trim(),
    );
    if track.duration > 0.0 {
        meta["additional_info"] = json!({ "duration_ms": (track.duration * 1000.0).round() as i64 });
    }
    json!({
        "listen_type": "playing_now",
        "payload": [{ "track_metadata": meta }],
    })
}

/// Last.fm 错误响应解析：`{"error":9,"message":"Invalid session key"}`。
///
/// 成功响应各方法形状不同（`auth.getSession` 有 `session`、`track.scrobble` 有
/// `scrobbles`），所以这里只判错；没错就当成功。
pub(crate) fn lastfm_error(body: &str) -> Option<String> {
    let v: Value = serde_json::from_str(body).ok()?;
    let code = v.get("error")?.as_i64()?;
    let msg = v
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("未知错误");
    Some(format!("Last.fm 错误 {code}：{msg}"))
}

/// 这些 Last.fm 错误码重试一百次也没用（key/secret/session 不对），直接判死。
pub(crate) fn lastfm_error_is_terminal(body: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        return false;
    };
    matches!(v.get("error").and_then(|c| c.as_i64()), Some(4 | 9 | 10 | 13 | 26))
}

/// 授权页地址（用户点完「允许」再回来完成授权）。
pub(crate) fn lastfm_auth_url(api_key: &str, token: &str) -> String {
    format!("{LASTFM_AUTH_PAGE}?api_key={api_key}&token={token}")
}

/// ListenBrainz `validate-token` 的响应：`{ "code": 200, "message": "...", "valid": true, "user_name": "x" }`
pub(crate) fn listenbrainz_user(body: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(body).map_err(|e| format!("响应不是 JSON：{e}"))?;
    if v.get("valid").and_then(|b| b.as_bool()) != Some(true) {
        let msg = v
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("token 无效");
        return Err(format!("ListenBrainz 拒绝了该 token：{msg}"));
    }
    Ok(v
        .get("user_name")
        .and_then(|u| u.as_str())
        .unwrap_or("")
        .to_string())
}

/// 从 `auth.getSession` 响应里取 `(session_key, user_name)`。
pub(crate) fn lastfm_session(body: &str) -> Result<(String, String), String> {
    if let Some(err) = lastfm_error(body) {
        return Err(err);
    }
    let v: Value = serde_json::from_str(body).map_err(|e| format!("响应不是 JSON：{e}"))?;
    let session = v.get("session").ok_or("响应里没有 session")?;
    let key = session
        .get("key")
        .and_then(|k| k.as_str())
        .ok_or("session 里没有 key")?;
    let name = session
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .to_string();
    Ok((key.to_string(), name))
}

/// 从 `auth.getToken` 响应里取 token。
pub(crate) fn lastfm_token(body: &str) -> Result<String, String> {
    if let Some(err) = lastfm_error(body) {
        return Err(err);
    }
    let v: Value = serde_json::from_str(body).map_err(|e| format!("响应不是 JSON：{e}"))?;
    v.get("token")
        .and_then(|t| t.as_str())
        .map(|t| t.to_string())
        .ok_or_else(|| "响应里没有 token".to_string())
}

// ---------- 设置读写（全部走 settings 表，单键单值） ----------

fn read_setting(conn: &Connection, key: &str) -> Option<String> {
    store::get_setting(conn, key)
        .ok()
        .flatten()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn write_setting(conn: &Connection, key: &str, value: &str) -> Result<(), rusqlite::Error> {
    store::set_setting(conn, key, value)
}

/// 布尔开关：键缺省视为关闭（第三方账号默认不上报）。
fn read_flag(conn: &Connection, key: &str) -> bool {
    read_setting(conn, key)
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// Last.fm 是否「已连接」（有 session key 才算）。
pub(crate) fn lastfm_connected(conn: &Connection) -> bool {
    read_setting(conn, KEY_LASTFM_SESSION).is_some()
}

/// ListenBrainz 是否「已连接」（有 token 才算）。
pub(crate) fn listenbrainz_connected(conn: &Connection) -> bool {
    read_setting(conn, KEY_LISTENBRAINZ_TOKEN).is_some()
}

// ---------- 界面视图 ----------

/// Last.fm 一栏。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LastfmView {
    /// 是否已授权（有 session key）
    pub connected: bool,
    /// 是否填了 api key + secret（没填时授权按钮应该禁用）
    pub has_credentials: bool,
    /// 是否开启上报（连接与开关分开：连过但关掉 = 保留凭据不上报）
    pub enabled: bool,
    /// 授权后对方返回的用户名
    pub user: String,
    /// 授权进行中（已拿到 token，等用户去网页点允许）
    pub awaiting_auth: bool,
}

/// ListenBrainz 一栏。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListenBrainzView {
    pub connected: bool,
    pub enabled: bool,
    pub user: String,
}

/// 最近一条上报记录。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScrobbleRecentView {
    pub target: String,
    pub artist: String,
    pub title: String,
    pub played_at: i64,
}

/// 队列概览。
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScrobbleQueueView {
    pub pending: i64,
    pub sent: i64,
    pub dead: i64,
    pub last_error: Option<String>,
    pub recent: Vec<ScrobbleRecentView>,
}

/// 设置页一次读齐的视图。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScrobbleView {
    pub lastfm: LastfmView,
    pub listenbrainz: ListenBrainzView,
    pub queue: ScrobbleQueueView,
}

fn queue_view(conn: &Connection) -> Result<ScrobbleQueueView, rusqlite::Error> {
    let ScrobbleQueueStats {
        pending,
        sent,
        dead,
        last_error,
    } = store::scrobble_stats(conn)?;
    let recent = store::scrobble_recent(conn, 5)?
        .into_iter()
        .map(|(target, artist, title, played_at)| ScrobbleRecentView {
            target,
            artist,
            title,
            played_at,
        })
        .collect();
    Ok(ScrobbleQueueView {
        pending,
        sent,
        dead,
        last_error,
        recent,
    })
}

/// 读整个视图（命令与冲刷器共用）。
pub(crate) fn view(conn: &Connection) -> Result<ScrobbleView, rusqlite::Error> {
    Ok(ScrobbleView {
        lastfm: LastfmView {
            connected: lastfm_connected(conn),
            has_credentials: read_setting(conn, KEY_LASTFM_API_KEY).is_some()
                && read_setting(conn, KEY_LASTFM_SECRET).is_some(),
            enabled: read_flag(conn, KEY_LASTFM_ENABLED),
            user: read_setting(conn, KEY_LASTFM_USER).unwrap_or_default(),
            awaiting_auth: read_setting(conn, KEY_LASTFM_TOKEN).is_some(),
        },
        listenbrainz: ListenBrainzView {
            connected: listenbrainz_connected(conn),
            enabled: read_flag(conn, KEY_LISTENBRAINZ_ENABLED),
            user: read_setting(conn, KEY_LISTENBRAINZ_USER).unwrap_or_default(),
        },
        queue: queue_view(conn)?,
    })
}

// ---------- 入队 / 冲刷 ----------

/// 冲刷结果（手动重试与后台冲刷共用）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct FlushOutcome {
    pub sent: usize,
    pub retrying: usize,
    pub dead: usize,
    /// 本次冲刷的第一个错误（界面提示用；不阻断其它目标）
    pub error: Option<String>,
}

/// 网络层抽象：生产环境是 reqwest，测试里换成假实现。
#[async_trait::async_trait]
pub(crate) trait Transport: Send + Sync {
    async fn post_form(&self, url: &str, form: &[(String, String)]) -> Result<String, String>;
    /// GET 并带上 ListenBrainz 的 `Authorization: Token <token>`。
    ///
    /// 单独开一个方法而不是给 `post_json` 加方法名参数：ListenBrainz 的
    /// `validate-token` **只接受 GET**（POST 返回 405 HTML），而 `submit-listens`
    /// 只接受 POST，两者的鉴权头写法又必须一致，分开放最不容易写错。
    async fn get_authed(&self, url: &str, token: &str) -> Result<String, String>;
    async fn post_json(
        &self,
        url: &str,
        body: &Value,
        token: Option<&str>,
    ) -> Result<String, String>;
}

/// ListenBrainz 的鉴权头取值。**必须是 `Token` 方案**：写成 `Bearer` 时对方
/// 当作「没提供 Authorization token」回 400，而不是 401，坑过一次。
fn listenbrainz_auth(token: &str) -> String {
    format!("Token {token}")
}

/// 把非 2xx 的 JSON API 响应变成一句人话。ListenBrainz 失败时常见
/// `{"code":401,"error":"Invalid token"}`，取 `error` 再退 `message`。
fn json_api_error(status: reqwest::StatusCode, text: &str) -> String {
    let msg = serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.as_str())
                .map(|e| e.to_string())
                .or_else(|| v.get("message").and_then(|m| m.as_str()).map(|m| m.to_string()))
        })
        .unwrap_or_else(|| text.chars().take(120).collect());
    format!("HTTP {status}：{msg}")
}

/// reqwest 实现。走 `net_config` 的代理配置（与音源请求同一套代理设置）。
pub(crate) struct HttpTransport;

static CLIENT: OnceLock<RwLock<(u64, reqwest::Client)>> = OnceLock::new();

fn client() -> reqwest::Client {
    crate::net_config::shared_async_client(&CLIENT, || {
        crate::net_config::configure(
            reqwest::Client::builder()
                .user_agent(format!("QuietMusic/{}", env!("CARGO_PKG_VERSION")))
                .timeout(std::time::Duration::from_secs(15)),
        )
        .build()
        .unwrap_or_default()
    })
}

#[async_trait::async_trait]
impl Transport for HttpTransport {
    async fn post_form(&self, url: &str, form: &[(String, String)]) -> Result<String, String> {
        // reqwest 0.13 关掉默认特性后 `RequestBuilder::form` 不可用（要额外
        // 的 urlencoded 依赖）；Last.fm 接受把参数放 query 的 POST，这里就把
        // 签名后的参数表当 query 发，body 留空。
        let resp = client()
            .post(url)
            .query(form)
            .send()
            .await
            .map_err(|e| format!("请求失败：{e}"))?;
        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| format!("读取响应失败：{e}"))?;
        // Last.fm 的写操作成功时回 200 + JSON；鉴权错误也回 200，靠 body 里的
        // `error` 字段判，所以这里只在真正的 HTTP 层失败时用状态码兜底。
        if !status.is_success() && lastfm_error(&body).is_none() {
            return Err(format!("HTTP {status}：{}", body.chars().take(120).collect::<String>()));
        }
        Ok(body)
    }

    async fn get_authed(&self, url: &str, token: &str) -> Result<String, String> {
        let resp = client()
            .get(url)
            .header(reqwest::header::AUTHORIZATION, listenbrainz_auth(token))
            .send()
            .await
            .map_err(|e| format!("请求失败：{e}"))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("读取响应失败：{e}"))?;
        if status.is_success() {
            Ok(text)
        } else {
            Err(json_api_error(status, &text))
        }
    }

    async fn post_json(
        &self,
        url: &str,
        body: &Value,
        token: Option<&str>,
    ) -> Result<String, String> {
        let mut req = client().post(url).json(body);
        if let Some(token) = token {
            req = req.header(reqwest::header::AUTHORIZATION, listenbrainz_auth(token));
        }
        let resp = req.send().await.map_err(|e| format!("请求失败：{e}"))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("读取响应失败：{e}"))?;
        if status.is_success() {
            return Ok(text);
        }
        Err(json_api_error(status, &text))
    }
}

/// 读冲刷所需的凭据（一次读齐，避免每条语句都碰库）。
struct Credentials {
    lastfm: Option<(String, String, String)>, // (api_key, secret, session)
    listenbrainz: Option<String>,             // token
}

fn credentials(conn: &Connection) -> Credentials {
    let lastfm = if read_flag(conn, KEY_LASTFM_ENABLED) && lastfm_connected(conn) {
        match (
            read_setting(conn, KEY_LASTFM_API_KEY),
            read_setting(conn, KEY_LASTFM_SECRET),
            read_setting(conn, KEY_LASTFM_SESSION),
        ) {
            (Some(k), Some(s), Some(sess)) => Some((k, s, sess)),
            _ => None,
        }
    } else {
        None
    };
    let listenbrainz = if read_flag(conn, KEY_LISTENBRAINZ_ENABLED) && listenbrainz_connected(conn) {
        read_setting(conn, KEY_LISTENBRAINZ_TOKEN)
    } else {
        None
    };
    Credentials {
        lastfm,
        listenbrainz,
    }
}

/// 冲刷一次队列。
///
/// 逐目标发送：Last.fm 与 ListenBrainz 互不影响 —— 一边鉴权过期不该让另一边
/// 的收听滞留。每个目标内部按批次走，单批失败只标记该批的行。
pub(crate) async fn flush_with(
    transport: &dyn Transport,
    db: &Database,
    now: i64,
) -> Result<FlushOutcome, String> {
    let creds = db.with(|conn| Ok(credentials(conn)))?;
    let mut out = FlushOutcome::default();
    // 没开任何目标时不该把行一直留在 pending 里发霉：清掉，等用户开开关后重新听。
    if creds.lastfm.is_none() && creds.listenbrainz.is_none() {
        db.with(|conn| store::scrobble_clear(conn, None).map(|_| ()))?;
        db.with(|conn| store::scrobble_prune_sent(conn).map(|_| ()))?;
        return Ok(out);
    }

    // 只取「已开启目标」的行，且每个目标各取一批（C15）：先全局 LIMIT 再按
    // 开关过滤时，关闭目标的 50 条旧行就能让另一个目标永远排不上。
    let mut targets: Vec<&str> = Vec::with_capacity(2);
    if creds.lastfm.is_some() {
        targets.push(TARGET_LASTFM);
    }
    if creds.listenbrainz.is_some() {
        targets.push(TARGET_LISTENBRAINZ);
    }
    let rows: Vec<ScrobbleRow> =
        db.with(|conn| store::scrobble_due_for_targets(conn, now, BATCH, &targets))?;
    if rows.is_empty() {
        return Ok(out);
    }

    if let Some((key, secret, session)) = creds.lastfm.as_ref() {
        let batch: Vec<ScrobbleRow> = rows
            .iter()
            .filter(|r| r.target == TARGET_LASTFM)
            .cloned()
            .collect();
        if !batch.is_empty() {
            let form = sign_form(lastfm_scrobble_params(&batch, key, session), secret);
            let result = transport.post_form(LASTFM_API, &form).await;
            apply_result(db, &batch, result, &mut out, true)?;
        }
    }

    if let Some(token) = creds.listenbrainz.as_ref() {
        let batch: Vec<ScrobbleRow> = rows
            .iter()
            .filter(|r| r.target == TARGET_LISTENBRAINZ)
            .cloned()
            .collect();
        if !batch.is_empty() {
            let body = listenbrainz_payload(&batch);
            let result = transport
                .post_json(
                    &format!("{LISTENBRAINZ_API}/submit-listens"),
                    &body,
                    Some(token.as_str()),
                )
                .await;
            apply_result(db, &batch, result, &mut out, false)?;
        }
    }

    db.with(|conn| store::scrobble_prune_sent(conn).map(|_| ()))?;
    Ok(out)
}

/// 把一次发送结果落到队列行上。
fn apply_result(
    db: &Database,
    batch: &[ScrobbleRow],
    result: Result<String, String>,
    out: &mut FlushOutcome,
    lastfm: bool,
) -> Result<(), String> {
    match result {
        Ok(body) => {
            let bad = if lastfm { lastfm_error(&body) } else { None };
            match bad {
                None => {
                    db.with(|conn| store::scrobble_mark_sent(conn, &ids_of(batch)))?;
                    out.sent += batch.len();
                }
                Some(err) => {
                    // 判死要看**原始响应体**：`err` 已经是给人看的中文串，
                    // 拿它去解析 JSON 永远解析不出来（曾经因此把 9 号错误
                    // 当成可重试，队列里堆满必然失败的记录）。
                    let terminal = lastfm && lastfm_error_is_terminal(&body);
                    record_failure(db, batch, err, terminal, out)?;
                }
            }
        }
        Err(err) => record_failure(db, batch, err, false, out)?,
    }
    Ok(())
}

fn ids_of(batch: &[ScrobbleRow]) -> Vec<i64> {
    batch.iter().map(|r| r.id).collect()
}

/// 记一次失败：鉴权类错误直接判死，其余退避重试。
///
/// `terminal` 由调用方判断（必须拿原始响应体判，见 `apply_result`）。
fn record_failure(
    db: &Database,
    batch: &[ScrobbleRow],
    err: String,
    terminal: bool,
    out: &mut FlushOutcome,
) -> Result<(), String> {
    for row in batch {
        let given_up = if terminal {
            db.with(|conn| store::scrobble_mark_dead(conn, row.id, &err))?
        } else {
            db.with(|conn| store::scrobble_mark_failure(conn, row.id, row.attempts, &err))?
        };
        if given_up {
            out.dead += 1;
        } else {
            out.retrying += 1;
        }
    }
    if out.error.is_none() {
        out.error = Some(err);
    }
    Ok(())
}

// ---------- 引擎钩子 ----------

/// 记一次「够格的收听」：按已开启的目标入队，然后立刻试着发一次。
///
/// 全部在后台任务里做，调用方（引擎线程）只 clone 几个 Arc 就返回。
pub(crate) fn record_listen(
    app: tauri::AppHandle,
    db: Option<Arc<Database>>,
    track: Track,
    started_at: i64,
    duration_ms: i64,
) {
    let Some(db) = db else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let target_db = db.clone();
        let enqueued = tauri::async_runtime::spawn_blocking(move || {
            target_db.with(|conn| {
                let mut n = 0;
                if read_flag(conn, KEY_LASTFM_ENABLED) && lastfm_connected(conn) {
                    n += usize::from(store::scrobble_enqueue(
                        conn,
                        TARGET_LASTFM,
                        &track,
                        started_at,
                        duration_ms,
                    )?);
                }
                if read_flag(conn, KEY_LISTENBRAINZ_ENABLED) && listenbrainz_connected(conn) {
                    n += usize::from(store::scrobble_enqueue(
                        conn,
                        TARGET_LISTENBRAINZ,
                        &track,
                        started_at,
                        duration_ms,
                    )?);
                }
                Ok(n)
            })
        })
        .await;
        match enqueued {
            Ok(Ok(0)) => return,
            Ok(Ok(_)) => {}
            Ok(Err(e)) => {
                log::warn!("[scrobble] 入队失败: {e}");
                return;
            }
            Err(e) => {
                log::warn!("[scrobble] 入队任务异常: {e}");
                return;
            }
        }
        if let Err(e) = flush_with(&HttpTransport, &db, crate::db::store::now_unix()).await {
            log::warn!("[scrobble] 冲刷失败: {e}");
        }
        let _ = app; // 目前不需要发事件：状态由设置页按需拉取
    });
}

/// 播放开始上报 now playing（可选功能，失败只记日志）。
pub(crate) fn now_playing(
    db: Option<Arc<Database>>,
    track: Track,
) {
    let Some(db) = db else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let read = db.clone();
        let creds = tauri::async_runtime::spawn_blocking(move || {
            read.with(|conn| Ok(credentials(conn)))
        })
        .await;
        let Ok(Ok(creds)) = creds else {
            return;
        };
        let http = HttpTransport;
        if let Some((key, secret, session)) = creds.lastfm {
            let form = sign_form(lastfm_now_playing_params(&track, &key, &session), &secret);
            if let Err(e) = http.post_form(LASTFM_API, &form).await {
                log::debug!("[scrobble] Last.fm now playing 失败: {e}");
            }
        }
        if let Some(token) = creds.listenbrainz {
            let body = listenbrainz_now_playing_payload(&track);
            if let Err(e) = http
                .post_json(
                    &format!("{LISTENBRAINZ_API}/submit-listens"),
                    &body,
                    Some(token.as_str()),
                )
                .await
            {
                log::debug!("[scrobble] ListenBrainz now playing 失败: {e}");
            }
        }
    });
}

/// 手动冲刷（设置页「立即重试」按钮）。
pub(crate) async fn flush_now(db: &Database) -> Result<FlushOutcome, String> {
    flush_with(&HttpTransport, db, crate::db::store::now_unix()).await
}

/// 后台定时冲刷：启动时起一个线程，每 [`RETRY_EVERY`] 秒把到点的行发一次。
///
/// 为什么不用 tokio interval：这个循环要活到进程结束，跟应用生命周期同寿，
/// 独立线程最省心（且不会因为某次 spawn 失败而丢调度）。
pub(crate) const RETRY_EVERY: std::time::Duration = std::time::Duration::from_secs(300);

/// 起后台冲刷线程（幂等：只起一次）。
pub(crate) fn spawn_retry_loop(db: Arc<Database>) {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    std::thread::Builder::new()
        .name("scrobble-retry".into())
        .spawn(move || loop {
            std::thread::sleep(RETRY_EVERY);
            let has_work = db
                .with(store::scrobble_pending_count)
                .map(|n| n > 0)
                .unwrap_or(false);
            if !has_work {
                continue;
            }
            let rt = tauri::async_runtime::handle();
            match rt.block_on(flush_with(&HttpTransport, &db, crate::db::store::now_unix())) {
                Ok(out) if out.sent > 0 || out.retrying > 0 || out.dead > 0 => {
                    log::info!(
                        "[scrobble] 定时冲刷：已发 {} / 待重试 {} / 放弃 {}",
                        out.sent,
                        out.retrying,
                        out.dead
                    );
                }
                Ok(_) => {}
                Err(e) => log::warn!("[scrobble] 定时冲刷失败: {e}"),
            }
        })
        .ok();
}

// ---------- 授权 / 连接 ----------

/// Last.fm 第一步：拿 token（命令层会把它拼成授权页地址给前端打开）。
pub(crate) async fn lastfm_begin(
    transport: &dyn Transport,
    db: &Database,
) -> Result<String, String> {
    let (key, secret) = db.with(|conn| {
        Ok((
            read_setting(conn, KEY_LASTFM_API_KEY),
            read_setting(conn, KEY_LASTFM_SECRET),
        ))
    })?;
    let (Some(key), Some(secret)) = (key, secret) else {
        return Err("请先填写 Last.fm 的 API key 与 Secret".into());
    };
    let mut params = BTreeMap::new();
    params.insert("method".to_string(), "auth.getToken".to_string());
    params.insert("api_key".to_string(), key.clone());
    let form = sign_form(params, &secret);
    let body = transport.post_form(LASTFM_API, &form).await?;
    let token = lastfm_token(&body)?;
    let store_db = db;
    let token_for_db = token.clone();
    store_db.with(move |conn| write_setting(conn, KEY_LASTFM_TOKEN, &token_for_db))?;
    Ok(lastfm_auth_url(&key, &token))
}

/// Last.fm 第二步：用 token 换 session key（用户点完授权回来触发）。
pub(crate) async fn lastfm_finish(
    transport: &dyn Transport,
    db: &Database,
) -> Result<String, String> {
    let (key, secret, token) = db.with(|conn| {
        Ok((
            read_setting(conn, KEY_LASTFM_API_KEY),
            read_setting(conn, KEY_LASTFM_SECRET),
            read_setting(conn, KEY_LASTFM_TOKEN),
        ))
    })?;
    let (Some(key), Some(secret), Some(token)) = (key, secret, token) else {
        return Err("还没有开始授权，请先点「连接 Last.fm」".into());
    };
    let mut params = BTreeMap::new();
    params.insert("method".to_string(), "auth.getSession".to_string());
    params.insert("api_key".to_string(), key);
    params.insert("token".to_string(), token);
    let form = sign_form(params, &secret);
    let body = transport.post_form(LASTFM_API, &form).await?;
    let (session, user) = lastfm_session(&body)?;
    let session_for_db = session.clone();
    let user_for_db = user.clone();
    db.with(move |conn| {
        write_setting(conn, KEY_LASTFM_SESSION, &session_for_db)?;
        write_setting(conn, KEY_LASTFM_USER, &user_for_db)?;
        write_setting(conn, KEY_LASTFM_ENABLED, "1")?;
        conn.execute(
            "DELETE FROM settings WHERE key = ?1",
            [KEY_LASTFM_TOKEN],
        )?;
        Ok(())
    })?;
    Ok(user)
}

/// ListenBrainz：校验 token 并保存。
pub(crate) async fn listenbrainz_connect(
    transport: &dyn Transport,
    db: &Database,
    token: &str,
) -> Result<String, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("请填写 ListenBrainz 的 user token".into());
    }
    // `validate-token` 只接受 GET + `Authorization: Token`：写成 POST JSON
    // 会被对方回 405 + HTML，前端只会看到「响应不是 JSON」这种莫名其妙的错。
    let body = transport
        .get_authed(&format!("{LISTENBRAINZ_API}/validate-token"), token)
        .await?;
    let user = listenbrainz_user(&body)?;
    let owned = token.to_string();
    let user_for_db = user.clone();
    db.with(move |conn| {
        write_setting(conn, KEY_LISTENBRAINZ_TOKEN, &owned)?;
        write_setting(conn, KEY_LISTENBRAINZ_USER, &user_for_db)?;
        write_setting(conn, KEY_LISTENBRAINZ_ENABLED, "1")?;
        Ok(())
    })?;
    Ok(user)
}

/// 断开 Last.fm：清 session / 用户名 / 开关，保留 api key 与 secret（重连不用重填）。
pub(crate) fn disconnect_lastfm(db: &Database) -> Result<(), String> {
    db.with(|conn| {
        conn.execute(
            "DELETE FROM settings WHERE key IN (?1, ?2, ?3, ?4)",
            rusqlite::params![
                KEY_LASTFM_SESSION,
                KEY_LASTFM_USER,
                KEY_LASTFM_ENABLED,
                KEY_LASTFM_TOKEN
            ],
        )?;
        Ok(())
    })?;
    db.with(|conn| store::scrobble_clear(conn, Some(TARGET_LASTFM)).map(|_| ()))
}

/// 断开 ListenBrainz：清 token / 用户名 / 开关与该目标的待发行。
pub(crate) fn disconnect_listenbrainz(db: &Database) -> Result<(), String> {
    db.with(|conn| {
        conn.execute(
            "DELETE FROM settings WHERE key IN (?1, ?2, ?3)",
            rusqlite::params![KEY_LISTENBRAINZ_TOKEN, KEY_LISTENBRAINZ_USER, KEY_LISTENBRAINZ_ENABLED],
        )?;
        Ok(())
    })?;
    db.with(|conn| store::scrobble_clear(conn, Some(TARGET_LISTENBRAINZ)).map(|_| ()))
}

/// 是否存在「授权中但没完成」的 Last.fm token（只有测试用；设置页那侧的
/// `awaiting_auth` 直接在 `view()` 里读，不需要这个包装）。
#[cfg(test)]
fn lastfm_awaiting_auth(conn: &Connection) -> bool {
    read_setting(conn, KEY_LASTFM_TOKEN).is_some()
}

/// 读一条设置（测试用）。
#[cfg(test)]
fn test_setting(conn: &Connection, key: &str) -> Option<String> {
    use rusqlite::OptionalExtension;
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        [key],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::store::tests::sample_track_with;
    use std::sync::Mutex;

    fn track() -> Track {
        sample_track_with("晴天", "周杰伦")
    }

    fn row(id: i64, target: &str, played_at: i64) -> ScrobbleRow {
        ScrobbleRow {
            id,
            target: target.to_string(),
            track_id: "wyy:1".into(),
            artist: "周杰伦".into(),
            title: "晴天".into(),
            album: "叶惠美".into(),
            duration_ms: 269_000,
            played_at,
            attempts: 0,
        }
    }

    fn test_db() -> Database {
        let dir = std::env::temp_dir().join(format!(
            "quietmusic-scrobble-{}-{}",
            std::process::id(),
            fastrand::u64(..)
        ));
        Database::open(&dir.join("music.db")).expect("open test db")
    }

    /// 假网络层：按预设脚本返回，并记下所有请求。
    #[derive(Default)]
    struct FakeTransport {
        #[allow(clippy::type_complexity)] // (url, form 参数表)：测试替身，不值得抽别名
        forms: Mutex<Vec<(String, Vec<(String, String)>)>>,
        json_body: Mutex<Vec<(String, Value)>>,
        /// (url, token)：GET 请求，用来断言校验 token 走的是 GET 而不是 POST。
        gets: Mutex<Vec<(String, String)>>,
        form_reply: Mutex<Vec<String>>,
        json_reply: Mutex<Option<Result<String, String>>>,
        get_reply: Mutex<Option<Result<String, String>>>,
    }

    impl FakeTransport {
        fn ok_json(body: &str) -> Self {
            let t = Self::default();
            *t.json_reply.lock().unwrap() = Some(Ok(body.to_string()));
            *t.get_reply.lock().unwrap() = Some(Ok(body.to_string()));
            t
        }
        fn fail_json(err: &str) -> Self {
            let t = Self::default();
            *t.json_reply.lock().unwrap() = Some(Err(err.to_string()));
            *t.get_reply.lock().unwrap() = Some(Err(err.to_string()));
            t
        }
    }

    #[async_trait::async_trait]
    impl Transport for FakeTransport {
        async fn post_form(&self, url: &str, form: &[(String, String)]) -> Result<String, String> {
            self.forms
                .lock()
                .unwrap()
                .push((url.to_string(), form.to_vec()));
            let mut replies = self.form_reply.lock().unwrap();
            if replies.is_empty() {
                Ok("{}".to_string())
            } else {
                Ok(replies.remove(0))
            }
        }

        async fn get_authed(&self, url: &str, token: &str) -> Result<String, String> {
            self.gets
                .lock()
                .unwrap()
                .push((url.to_string(), token.to_string()));
            self.get_reply
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| Ok("{}".to_string()))
        }

        async fn post_json(
            &self,
            url: &str,
            body: &Value,
            _token: Option<&str>,
        ) -> Result<String, String> {
            self.json_body
                .lock()
                .unwrap()
                .push((url.to_string(), body.clone()));
            self.json_reply
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| Ok("{}".to_string()))
        }
    }

    // ---------- 阈值 ----------

    #[test]
    fn scrobble_threshold_matches_lastfm_rules() {
        // 少于 30 秒的曲目永远不报
        assert!(!should_scrobble(30_000, 25_000));
        // 听了不到一半不报
        assert!(!should_scrobble(60_000, 269_000));
        // 一半就够
        assert!(should_scrobble(135_000, 269_000));
        // 长曲目 4 分钟封顶
        assert!(!should_scrobble(200_000, 900_000));
        assert!(should_scrobble(240_000, 900_000));
        // 时长未知按 4 分钟算
        assert!(!should_scrobble(200_000, 0));
        assert!(should_scrobble(240_000, 0));
        // 20 秒的短曲听完也只有 20 秒，仍不到 15 秒下限？——20 秒 > 15 秒，报
        // 40 秒曲目听一半 = 20 秒，够 15 秒下限 → 报
        assert!(should_scrobble(20_000, 40_000));
        // 20 秒的曲目太短，听完整首也不报
        assert!(!should_scrobble(20_000, 20_000));
    }

    // ---------- 签名 ----------

    #[test]
    fn signature_is_md5_of_sorted_key_value_pairs_plus_secret() {
        let mut p = BTreeMap::new();
        p.insert("a".to_string(), "b".to_string());
        assert_eq!(
            lastfm_signature(&p, "s"),
            "f9ac6b05beccb0fc5837b6a7fef4c1d3",
            "md5('a' + 'b' + 's')"
        );
        // 空值参数不参与签名
        let mut q = p.clone();
        q.insert("empty".to_string(), String::new());
        assert_eq!(lastfm_signature(&q, "s"), lastfm_signature(&p, "s"));
        // 排序与插入顺序无关
        let mut r = BTreeMap::new();
        r.insert("b".to_string(), "2".to_string());
        r.insert("a".to_string(), "1".to_string());
        let mut s = BTreeMap::new();
        s.insert("a".to_string(), "1".to_string());
        s.insert("b".to_string(), "2".to_string());
        assert_eq!(lastfm_signature(&r, "k"), lastfm_signature(&s, "k"));
    }

    #[test]
    fn signed_form_carries_signature_and_json_format() {
        let mut p = BTreeMap::new();
        p.insert("method".into(), "auth.getToken".into());
        p.insert("api_key".into(), "abc123".into());
        let form = sign_form(p, "");
        let map: BTreeMap<String, String> = form.into_iter().collect();
        assert_eq!(map.get("format").map(String::as_str), Some("json"));
        assert_eq!(
            map.get("api_sig").map(String::as_str),
            Some("c2fcc36bf3593ccd31adf94446b2603a"),
            "md5('api_key'+'abc123'+'method'+'auth.getToken')"
        );
    }

    // ---------- 请求体 ----------

    #[test]
    fn scrobble_params_use_contiguous_indices() {
        let rows = vec![
            row(1, TARGET_LASTFM, 1_700_000_000),
            row(2, TARGET_LASTFM, 1_700_000_100),
        ];
        let p = lastfm_scrobble_params(&rows, "key", "session");
        assert_eq!(p.get("method").map(String::as_str), Some("track.scrobble"));
        assert_eq!(p.get("sk").map(String::as_str), Some("session"));
        assert_eq!(p.get("artist[0]").map(String::as_str), Some("周杰伦"));
        assert_eq!(p.get("timestamp[1]").map(String::as_str), Some("1700000100"));
        assert_eq!(p.get("duration[1]").map(String::as_str), Some("269"), "秒");
        assert!(!p.contains_key("artist[2]"));
    }

    #[test]
    fn listenbrainz_payload_is_import_with_listened_at() {
        let rows = vec![row(1, TARGET_LISTENBRAINZ, 1_700_000_000)];
        let body = listenbrainz_payload(&rows);
        assert_eq!(body["listen_type"], "import");
        assert_eq!(body["payload"][0]["listened_at"], 1_700_000_000i64);
        assert_eq!(
            body["payload"][0]["track_metadata"]["artist_name"],
            "周杰伦"
        );
        assert_eq!(
            body["payload"][0]["track_metadata"]["additional_info"]["duration_ms"],
            269_000
        );
    }

    #[test]
    fn listenbrainz_now_playing_has_no_timestamp() {
        let body = listenbrainz_now_playing_payload(&track());
        assert_eq!(body["listen_type"], "playing_now");
        assert!(
            body["payload"][0].get("listened_at").is_none(),
            "now playing 没有时间戳"
        );
        assert_eq!(
            body["payload"][0]["track_metadata"]["additional_info"]["duration_ms"],
            210_000
        );
    }

    // ---------- 响应解析 ----------

    #[test]
    fn lastfm_errors_are_parsed_and_classified() {
        assert_eq!(
            lastfm_error(r#"{"error":9,"message":"Invalid session key"}"#).as_deref(),
            Some("Last.fm 错误 9：Invalid session key")
        );
        assert!(lastfm_error(r#"{"scrobbles":{"@attr":{"accepted":1}}}"#).is_none());
        assert!(lastfm_error_is_terminal(r#"{"error":9,"message":"x"}"#));
        assert!(!lastfm_error_is_terminal(r#"{"error":11,"message":"Service Offline"}"#));
        assert!(!lastfm_error_is_terminal("not json"));
    }

    #[test]
    fn auth_responses_are_parsed() {
        assert_eq!(
            lastfm_token(r#"{"token":"tok123"}"#).unwrap(),
            "tok123"
        );
        assert!(lastfm_token(r#"{"error":10,"message":"Invalid API key"}"#).is_err());
        assert_eq!(
            lastfm_session(r#"{"session":{"name":"小明","key":"sk1","subscriber":0}}"#).unwrap(),
            ("sk1".to_string(), "小明".to_string())
        );
        assert!(lastfm_session(r#"{"error":4,"message":"Unauthorized"}"#).is_err());
        assert_eq!(
            listenbrainz_user(r#"{"code":200,"valid":true,"user_name":"lb_user"}"#).unwrap(),
            "lb_user"
        );
        assert!(listenbrainz_user(r#"{"valid":false,"message":"Invalid token"}"#)
            .unwrap_err()
            .contains("Invalid token"));
        assert_eq!(
            lastfm_auth_url("k", "t"),
            "https://www.last.fm/api/auth/?api_key=k&token=t"
        );
    }

    // ---------- 入队 ----------

    #[test]
    fn settings_flags_default_to_off() {
        let db = test_db();
        db.with(|conn| {
            assert!(!read_flag(conn, KEY_LASTFM_ENABLED));
            assert!(!lastfm_connected(conn));
            assert!(!listenbrainz_connected(conn));
            assert!(!lastfm_awaiting_auth(conn));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn credentials_only_apply_when_enabled_and_connected() {
        let db = test_db();
        db.with(|conn| {
            write_setting(conn, KEY_LASTFM_API_KEY, "k")?;
            write_setting(conn, KEY_LASTFM_SECRET, "s")?;
            write_setting(conn, KEY_LASTFM_SESSION, "sess")?;
            // 只连接、没开开关 → 不该冲刷
            assert!(credentials(conn).lastfm.is_none());
            write_setting(conn, KEY_LASTFM_ENABLED, "1")?;
            assert_eq!(credentials(conn).lastfm.map(|c| c.0), Some("k".to_string()));
            // ListenBrainz 只有 token 没有开关也不算
            write_setting(conn, KEY_LISTENBRAINZ_TOKEN, "tok")?;
            assert!(credentials(conn).listenbrainz.is_none());
            write_setting(conn, KEY_LISTENBRAINZ_ENABLED, "1")?;
            assert_eq!(credentials(conn).listenbrainz.as_deref(), Some("tok"));
            Ok(())
        })
        .unwrap();
    }

    // ---------- 冲刷 ----------

    #[tokio::test]
    async fn flush_sends_both_targets_and_marks_sent() {
        let db = test_db();
        db.with(|conn| {
            write_setting(conn, KEY_LASTFM_API_KEY, "k")?;
            write_setting(conn, KEY_LASTFM_SECRET, "s")?;
            write_setting(conn, KEY_LASTFM_SESSION, "sess")?;
            write_setting(conn, KEY_LASTFM_ENABLED, "1")?;
            write_setting(conn, KEY_LISTENBRAINZ_TOKEN, "tok")?;
            write_setting(conn, KEY_LISTENBRAINZ_ENABLED, "1")?;
            store::scrobble_enqueue(conn, TARGET_LASTFM, &track(), 1_700_000_000, 269_000)?;
            store::scrobble_enqueue(conn, TARGET_LISTENBRAINZ, &track(), 1_700_000_000, 269_000)?;
            Ok(())
        })
        .unwrap();

        let transport = FakeTransport::ok_json("{}");
        let out = flush_with(&transport, &db, 1_700_000_100).await.unwrap();
        assert_eq!(out.sent, 2, "两个目标各发一条");
        assert!(out.error.is_none());

        let forms = transport.forms.lock().unwrap();
        assert_eq!(forms.len(), 1, "Last.fm 一次批量");
        let map: BTreeMap<String, String> = forms[0].1.clone().into_iter().collect();
        assert_eq!(map.get("method").map(String::as_str), Some("track.scrobble"));
        assert!(map.contains_key("api_sig"));
        let js = transport.json_body.lock().unwrap();
        assert_eq!(js.len(), 1);
        assert!(js[0].0.ends_with("/submit-listens"));

        let pending = db.with(store::scrobble_pending_count).unwrap();
        assert_eq!(pending, 0);
    }

    /// 关闭目标的积压不能饿死开启的目标（C15）。
    #[tokio::test]
    async fn disabled_target_backlog_does_not_starve_enabled_one() {
        let db = test_db();
        db.with(|conn| {
            // Last.fm 没开（但队列里有 50 条更老的待发行），ListenBrainz 开着
            write_setting(conn, KEY_LISTENBRAINZ_TOKEN, "tok")?;
            write_setting(conn, KEY_LISTENBRAINZ_ENABLED, "1")?;
            for i in 0..50 {
                store::scrobble_enqueue(conn, TARGET_LASTFM, &track(), 1_700_000_000 + i, 269_000)?;
            }
            store::scrobble_enqueue(conn, TARGET_LISTENBRAINZ, &track(), 1_700_001_000, 269_000)?;
            Ok(())
        })
        .unwrap();

        let transport = FakeTransport::ok_json("{}");
        let out = flush_with(&transport, &db, 1_700_000_100).await.unwrap();
        assert_eq!(out.sent, 1, "开启的 ListenBrainz 必须发得出去");
        assert!(out.error.is_none());
        assert!(
            transport.forms.lock().unwrap().is_empty(),
            "Last.fm 关着，不该发它的积压"
        );
        assert_eq!(transport.json_body.lock().unwrap().len(), 1);

        db.with(|conn| {
            assert_eq!(
                store::scrobble_pending_count(conn)?,
                50,
                "关闭目标的待发行保持原状，等用户重新打开"
            );
            Ok(())
        })
        .unwrap();
    }

    #[tokio::test]
    async fn flush_retries_on_network_error_and_gives_up_on_auth_error() {
        let db = test_db();
        db.with(|conn| {
            write_setting(conn, KEY_LISTENBRAINZ_TOKEN, "tok")?;
            write_setting(conn, KEY_LISTENBRAINZ_ENABLED, "1")?;
            store::scrobble_enqueue(conn, TARGET_LISTENBRAINZ, &track(), 1_700_000_000, 269_000)?;
            Ok(())
        })
        .unwrap();
        let out = flush_with(&FakeTransport::fail_json("网络断了"), &db, 1_700_000_100)
            .await
            .unwrap();
        assert_eq!((out.sent, out.retrying, out.dead), (0, 1, 0));
        assert_eq!(out.error.as_deref(), Some("网络断了"));

        // Last.fm 的 9 号错误（session 失效）重试无意义 → 直接判死
        let db2 = test_db();
        db2.with(|conn| {
            write_setting(conn, KEY_LASTFM_API_KEY, "k")?;
            write_setting(conn, KEY_LASTFM_SECRET, "s")?;
            write_setting(conn, KEY_LASTFM_SESSION, "sess")?;
            write_setting(conn, KEY_LASTFM_ENABLED, "1")?;
            store::scrobble_enqueue(conn, TARGET_LASTFM, &track(), 1_700_000_000, 269_000)?;
            Ok(())
        })
        .unwrap();
        let t = FakeTransport::default();
        t.form_reply
            .lock()
            .unwrap()
            .push(r#"{"error":9,"message":"Invalid session key"}"#.to_string());
        let out = flush_with(&t, &db2, 1_700_000_100).await.unwrap();
        assert_eq!((out.sent, out.retrying, out.dead), (0, 0, 1));
        assert_eq!(
            db2.with(store::scrobble_stats).unwrap().dead,
            1,
            "鉴权错误应直接标 dead"
        );
    }

    #[tokio::test]
    async fn flush_clears_queue_when_no_target_enabled() {
        let db = test_db();
        db.with(|conn| {
            store::scrobble_enqueue(conn, TARGET_LASTFM, &track(), 1_700_000_000, 269_000)?;
            Ok(())
        })
        .unwrap();
        let out = flush_with(&FakeTransport::default(), &db, 1_700_000_100)
            .await
            .unwrap();
        assert_eq!(out.sent, 0);
        assert_eq!(db.with(store::scrobble_pending_count).unwrap(), 0);
    }

    #[tokio::test]
    async fn lastfm_begin_and_finish_store_session() {
        let db = test_db();
        db.with(|conn| {
            write_setting(conn, KEY_LASTFM_API_KEY, "k")?;
            write_setting(conn, KEY_LASTFM_SECRET, "s")?;
            Ok(())
        })
        .unwrap();

        let t = FakeTransport::default();
        t.form_reply
            .lock()
            .unwrap()
            .push(r#"{"token":"tok9"}"#.to_string());
        t.form_reply
            .lock()
            .unwrap()
            .push(r#"{"session":{"name":"小明","key":"sk9"}}"#.to_string());

        let url = lastfm_begin(&t, &db).await.unwrap();
        assert_eq!(
            url,
            "https://www.last.fm/api/auth/?api_key=k&token=tok9",
            "授权页地址要带上 key 与 token"
        );
        db.with(|conn| {
            assert_eq!(test_setting(conn, KEY_LASTFM_TOKEN).as_deref(), Some("tok9"));
            assert!(lastfm_awaiting_auth(conn));
            Ok(())
        })
        .unwrap();

        let user = lastfm_finish(&t, &db).await.unwrap();
        assert_eq!(user, "小明");
        db.with(|conn| {
            assert_eq!(test_setting(conn, KEY_LASTFM_SESSION).as_deref(), Some("sk9"));
            assert_eq!(test_setting(conn, KEY_LASTFM_USER).as_deref(), Some("小明"));
            assert!(lastfm_connected(conn));
            assert!(read_flag(conn, KEY_LASTFM_ENABLED), "授权完成应自动打开上报");
            assert!(!lastfm_awaiting_auth(conn), "拿到 session 后 token 该清掉");
            Ok(())
        })
        .unwrap();
    }

    #[tokio::test]
    async fn listenbrainz_connect_validates_and_disconnect_clears() {
        let db = test_db();
        let t = FakeTransport::ok_json(r#"{"code":200,"valid":true,"user_name":"lb_user"}"#);
        let user = listenbrainz_connect(&t, &db, " tok ").await.unwrap();
        assert_eq!(user, "lb_user");
        db.with(|conn| {
            assert!(listenbrainz_connected(conn));
            assert!(read_flag(conn, KEY_LISTENBRAINZ_ENABLED));
            assert_eq!(read_setting(conn, KEY_LISTENBRAINZ_USER).as_deref(), Some("lb_user"));
            Ok(())
        })
        .unwrap();

        disconnect_listenbrainz(&db).unwrap();
        db.with(|conn| {
            assert!(!listenbrainz_connected(conn));
            assert!(!read_flag(conn, KEY_LISTENBRAINZ_ENABLED));
            Ok(())
        })
        .unwrap();

        // 空 token 直接拒绝，不发请求
        let t2 = FakeTransport::ok_json("{}");
        assert!(listenbrainz_connect(&t2, &db, "  ").await.is_err());
        assert!(t2.json_body.lock().unwrap().is_empty());
        assert!(t2.gets.lock().unwrap().is_empty(), "没填 token 就不该打网络");
    }

    #[tokio::test]
    async fn listenbrainz_validates_via_get_with_token_scheme() {
        let db = test_db();
        let t = FakeTransport::ok_json(r#"{"code":200,"valid":true,"user_name":"canace"}"#);
        let user = listenbrainz_connect(&t, &db, " abc ").await.unwrap();
        assert_eq!(user, "canace");

        // 校验必须是 GET：ListenBrainz 对 POST /validate-token 回 405 HTML，
        // 前端只会看到「响应不是 JSON」（这正是「连接不生效」的根因）。
        let gets = t.gets.lock().unwrap().clone();
        assert_eq!(gets.len(), 1);
        assert_eq!(
            gets[0].0,
            "https://api.listenbrainz.org/1/validate-token"
        );
        assert_eq!(gets[0].1, "abc", "token 要 trim 后原样放鉴权头");
        assert!(
            t.json_body.lock().unwrap().is_empty(),
            "校验不能把 token 塞进 POST body"
        );

        // 鉴权头方案必须是 `Token`：写成 `Bearer` 对方回 400「没有提供 token」。
        assert_eq!(listenbrainz_auth("abc"), "Token abc");
    }

    #[test]
    fn view_reports_connection_and_queue_state() {
        let db = test_db();
        db.with(|conn| {
            store::scrobble_enqueue(conn, TARGET_LASTFM, &track(), 1_700_000_000, 269_000)?;
            write_setting(conn, KEY_LASTFM_API_KEY, "k")?;
            write_setting(conn, KEY_LASTFM_SECRET, "s")?;
            let v = view(conn)?;
            assert!(v.lastfm.has_credentials);
            assert!(!v.lastfm.connected);
            assert!(!v.listenbrainz.connected);
            assert_eq!(v.queue.pending, 1);
            assert_eq!(v.queue.recent.len(), 1);
            assert_eq!(v.queue.recent[0].title, "晴天");
            Ok(())
        })
        .unwrap();
    }
}
