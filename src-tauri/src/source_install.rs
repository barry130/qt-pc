//! 播放音源包安装与本地状态（双音源包架构）：
//!
//! - 数据音源包（meta-bundle.js）qtres 内嵌随应用分发，**不经本模块**；
//! - 本模块只管**播放音源包**（play-bundle.js，高风险、不内置）：
//!   - `state.json`（`<bundle_dir>/state.json`）v2：packs[]（多包共存，官方包
//!     单通道 + 用户直链安装的自定义包任意多个）、activeId（其一生效）、
//!     bad[]（冒烟失败的官方 versionCode 黑名单）、previousOfficial（官方包
//!     装载失败的自动回退快照）；
//!   - `source_install`：按 astral manifest 安装/更新官方播放包（diff 下载）；
//!   - `source_install_from_url`：用户粘贴直链安装自定义播放包（不自动更新）；
//!   - `source_activate_pack` / `source_uninstall_pack`：包管理；
//!   - `source_pack_describe`：引擎装配成功后回填真实包名/版本（设置页展示）；
//!   - `source_pack_load_failed`：引擎装配/冒烟失败上报——官方包自动回退到
//!     previousOfficial 并把 versionCode 拉黑，自定义包保留待用户处理；
//!   - `source_report`：装载结果上报后端。
//!
//! 一切包列表/生效包变化都广播 `source-pack-changed`：引擎页监听后热切换
//! （installPlayPack 在同一 JS 上下文里求值新包），**不再重启应用、不再重建
//! 引擎窗口**。
//!
//! v1 → v2 迁移：旧 state 的 installed/previous 是 ESM 全量包，与新的
//! IIFE 播放包格式不兼容（new Function 求值 `export` 语法必炸），迁移时
//! 直接丢弃并清空 install/ 目录，只保留 bad[] / lastCheckAt。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::astral;
use crate::commands::{source_builtin_request, SourceRequestOptions};
use crate::{source_bundle, AppState};

/// 音源包宿主契约版本（bundle 要求更高时拒绝加载）。
pub const HOST_API_VERSION: i64 = 1;

/// 官方播放包的固定 id（manifest 单通道：安装/更新就是原位替换它）
pub const OFFICIAL_PACK_ID: &str = "official";

/// 已安装的播放包（v2 状态条目）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PlayPackMeta {
    /// `official` 或 `custom-<yyyymmdd-hhmmss>`
    pub id: String,
    /// 包自述名（引擎装配成功后回填，如 "play-bundle"；自定义包装配前显示占位名）
    pub name: String,
    /// 包自述版本（引擎回填，如 "chain.11"）
    pub version: String,
    /// official = manifest sourceVersionCode；custom = 0
    pub version_code: i64,
    /// manifest 下发的版本展示名（custom = 直链安装时间）
    pub version_name: String,
    /// `official` = astral manifest（自动更新）；`custom` = 用户直链（不自动更新）
    pub source: String,
    /// install/ 下的目录名（白名单字符，杜绝路径注入）
    pub dir: String,
    /// 安装时间（unix 秒，设置页排序用）
    pub installed_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SourceBundleState {
    /// 状态结构版本（当前 = 2）
    pub schema: i64,
    /// 已安装播放包（多包共存）
    pub packs: Vec<PlayPackMeta>,
    /// 生效包 id（None = 未选任何包，取链按「未安装」口径报错）
    pub active_id: Option<String>,
    /// 冒烟失败过的官方 versionCode：不再自动下载/装载
    pub bad: Vec<i64>,
    pub last_check_at: i64,
    /// 官方包装载失败时的自动回退快照（仍是 packs 里的旧官方包）
    pub previous_official: Option<PlayPackMeta>,
}

impl SourceBundleState {
    fn new_v2() -> Self {
        Self { schema: 2, ..Default::default() }
    }
}

// ---------- v1 结构（仅迁移用） ----------

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct InstalledReleaseV1 {
    source_version_code: i64,
    #[allow(dead_code)]
    dir: String,
    #[allow(dead_code)]
    files: std::collections::BTreeMap<String, i64>,
    #[allow(dead_code)]
    source_version_name: String,
    #[allow(dead_code)]
    source: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SourceBundleStateV1 {
    #[allow(dead_code)]
    installed: Option<InstalledReleaseV1>,
    #[allow(dead_code)]
    previous: Option<InstalledReleaseV1>,
    bad: Vec<i64>,
    last_check_at: i64,
}

// ---------- state.json 读写 ----------

pub(crate) fn state_path(dir: &Path) -> PathBuf {
    dir.join("state.json")
}

/// 读状态（含 v1 → v2 迁移）。v1 的 installed/previous 是不兼容的 ESM 全量包，
/// 迁移时连 install/ 目录一起清掉，只保留 bad[] / lastCheckAt。
pub(crate) fn load_state(dir: &Path) -> SourceBundleState {
    let Ok(text) = std::fs::read_to_string(state_path(dir)) else {
        return SourceBundleState::new_v2();
    };
    let Ok(raw) = serde_json::from_str::<Value>(&text) else {
        // 损坏的状态文件按缺省处理（目录里可能残留旧包文件，但状态里没有
        // packs 就不会被加载，等下次安装覆盖）
        return SourceBundleState::new_v2();
    };
    if raw.get("schema").and_then(|v| v.as_i64()) == Some(2) {
        return serde_json::from_value(raw).unwrap_or_else(|_| SourceBundleState::new_v2());
    }
    // v1（或无 schema 的更早形态）：保留黑名单与检查时间，包与目录全弃
    let v1: SourceBundleStateV1 =
        serde_json::from_value(raw).unwrap_or_default();
    let migrated = SourceBundleState {
        schema: 2,
        packs: Vec::new(),
        active_id: None,
        bad: v1.bad,
        last_check_at: v1.last_check_at,
        previous_official: None,
    };
    let install = dir.join("install");
    if install.exists() {
        let _ = std::fs::remove_dir_all(&install);
        log::info!("[source-bundle] v1→v2 迁移：清空不兼容的旧音源包目录 {}", install.display());
    }
    migrated
}

pub(crate) fn save_state(dir: &Path, state: &SourceBundleState) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(state_path(dir), text).map_err(|e| e.to_string())
}

/// install/ 下的包目录（code 转十进制串；白名单字符，杜绝路径注入）
fn install_dir(dir: &Path, code: i64) -> PathBuf {
    dir.join("install").join(code.to_string())
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 自定义包 id / 目录名：`custom-<yyyymmdd-hhmmss>`（UTC；只用于展示与目录，
/// 撞名也无碍——同秒安装两个直链包本来就极小概率）
fn custom_pack_slug() -> String {
    let secs = unix_now().max(0);
    let (days, rem) = (secs / 86400, secs % 86400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // civil_from_days（Hinnant 算法）：天数 → 年月日
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(mo <= 2);
    format!("custom-{y:04}{mo:02}{d:02}-{h:02}{m:02}{s:02}")
}

/// 包列表/生效包变化广播：引擎页热切换播放包（不重启、不重建窗口）
fn broadcast_packs_changed(app: &AppHandle) {
    let _ = app.emit("source-pack-changed", ());
}

// ---------- manifest 解析（QtRestResp 包装响应，data 字段与 QtSourceManifestVo 对齐） ----------

/// 后端 VO 全是包装类型，可空列会序列化成 null；一个 null 不该让整个 manifest 解析失败。
fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// 公开 manifest 里 `published` 恒为 null（管理端专用字段，`toVo(manage=false)` 显式置空），
/// 且服务端只下发 `is_published=1` 的记录，因此 null/缺失 = 已发布，仅显式 false 视为未发布。
fn null_as_published<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<bool>::deserialize(deserializer)?.unwrap_or(true))
}

fn published_default() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceArtifact {
    pub path: String,
    pub version: i64,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRelease {
    pub source_version_code: i64,
    pub source_version_name: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub platforms: Vec<i64>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub host_api_version: i64,
    #[serde(default, deserialize_with = "null_as_default")]
    pub channel: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub notes: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub artifacts: Vec<SourceArtifact>,
    #[serde(default = "published_default", deserialize_with = "null_as_published")]
    pub published: bool,
    #[serde(default, deserialize_with = "null_as_default")]
    pub bad: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceManifest {
    pub schema: i64,
    pub release: Option<SourceRelease>,
}

/// QtRestResp 包装层（轻听后端统一响应：{code, msg, data}）。
/// 不用 `#[serde(default)]`：serde derive 会借此给泛型 T 平添 `T: Default` bound。
#[derive(Debug, Clone)]
pub struct QtRestRespEnvelope<T> {
    pub code: i64,
    pub data: Option<T>,
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for QtRestRespEnvelope<T> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use serde::de::Error as _;
        let raw = serde_json::Value::deserialize(deserializer)?;
        let code = raw
            .get("code")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| D::Error::missing_field("code"))?;
        let data = match raw.get("data") {
            None | Some(Value::Null) => None,
            Some(v) => Some(T::deserialize(v.clone()).map_err(D::Error::custom)?),
        };
        Ok(QtRestRespEnvelope { code, data })
    }
}

// ---------- 命令 ----------

/// 当前播放包本地状态（引擎页与设置页共用）
#[tauri::command(rename = "source_state")]
pub async fn cmd_source_state(app: AppHandle) -> Result<Value, String> {
    let dir = source_bundle::bundle_dir(&app);
    let state = load_state(&dir);
    serde_json::to_value(&state).map_err(|e| e.to_string())
}

/// 应用版本号（appVersionCodes 准入判定在服务端，客户端只上报）
fn app_version_code() -> i64 {
    astral::version_code()
}

/// 拉取 manifest（免认证；响应为 QtRestResp 包装：{code, data: SourceManifest}；由 cmd_source_manifest 调用）
/// 登录态下附带 satoken（最近登录用户用于识别测试人群，与 app/update 一致）。
async fn fetch_manifest(astral: &astral::AstralClient) -> Result<Option<SourceRelease>, String> {
    let url = format!(
        "{}/app/source/manifest?platform=1103&appVersionCode={}&hostApiVersion={}",
        astral.base_url().trim_end_matches('/'),
        app_version_code(),
        HOST_API_VERSION,
    );
    let options = SourceRequestOptions {
        method: None,
        headers: astral
            .token()
            .map(|t| std::collections::HashMap::from([("satoken".to_string(), t)])),
        body: None,
        timeout_ms: None,
    };
    let res = source_builtin_request(&url, Some(&options)).await?;
    if res.status_code == 304 {
        return Ok(None);
    }
    if res.status_code != 200 {
        return Err(format!("manifest 拉取失败: HTTP {}", res.status_code));
    }
    // QtRestResp 包装响应；body 非 JSON 时是字符串
    let text = match res.body {
        Value::String(s) => s,
        other => serde_json::to_string(&other).map_err(|e| e.to_string())?,
    };
    if text.trim().is_empty() {
        return Ok(None);
    }
    let wrapped: QtRestRespEnvelope<SourceManifest> =
        serde_json::from_str(&text).map_err(|e| format!("manifest 解析失败: {e}"))?;
    // 与安卓端 requestJson 同口径：code 0/200 算业务成功，其余按无包处理
    if wrapped.code != 200 && wrapped.code != 0 {
        return Ok(None);
    }
    Ok(wrapped.data.and_then(|m| m.release))
}

/// 手动/自动检查共用：拉 manifest 并返回远端 release（无发布 = null）
#[tauri::command(rename = "source_manifest")]
pub async fn cmd_source_manifest(
    state: tauri::State<'_, AppState>,
) -> Result<Option<SourceRelease>, String> {
    fetch_manifest(&state.astral).await
}

/// 单文件下载（bytes）；失败返回 Err
async fn download_file(url: &str, timeout_ms: u64) -> Result<Vec<u8>, String> {
    // 音源包下载下来会被引擎 load 成脚本执行，所以只接受"https 或自有 CDN"。
    //（source_builtin_request 内部还会再挡一次内网/非 http 协议。）
    let checked = crate::net_guard::ensure_trusted_download_url(url)?;
    let res = source_builtin_request(
        checked.as_str(),
        Some(&SourceRequestOptions {
            method: Some("GET".to_string()),
            headers: None,
            body: None,
            timeout_ms: Some(timeout_ms),
        }),
    )
    .await?;
    if res.status_code != 200 {
        return Err(format!("HTTP {}", res.status_code));
    }
    match res.body {
        Value::String(s) => Ok(s.into_bytes()),
        other => serde_json::to_vec(&other).map_err(|e| e.to_string()),
    }
}

/// 把 manifest 给的相对路径安全地拼到安装目录下。
///
/// `artifact.path` 与 `artifact.url` 同出一份**远端** manifest，而原实现直接
/// `target.join(&artifact.path)`：绝对路径、盘符、`..`、以及 Windows 下同样是
/// 分隔符的反斜杠都没有防护，一个 `..\..\..\Windows\System32\x.dll` 就能写到
/// 安装目录之外（同仓 `qtres.rs` 的 `/script` 分发早就有段名白名单，这里没有）。
/// 现在只放行"若干个普通路径段"。
fn safe_artifact_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() {
        return Err("artifact.path 为空".to_string());
    }
    if rel.contains('\\') {
        return Err(format!("artifact.path 不允许包含反斜杠：{rel}"));
    }
    if rel.contains(':') {
        return Err(format!("artifact.path 不允许包含盘符：{rel}"));
    }
    if rel.starts_with('/') {
        return Err(format!("artifact.path 不允许是绝对路径：{rel}"));
    }
    let mut out = root.to_path_buf();
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return Err(format!("artifact.path 含非法路径段：{rel}"));
        }
        out.push(seg);
    }
    Ok(out)
}

/// 必须存在的播放包产物（引擎页固定按 `<dir>/play-bundle.js` 取装配）
const PLAY_BUNDLE_FILE: &str = "play-bundle.js";

/// 下载并安装/更新官方播放包（manifest 单通道：原位替换 id=official 的包）。
/// 只下差异文件 → 落盘 install/<code>/ → 旧官方目录删除 → 广播换包。
#[tauri::command(rename = "source_install")]
pub async fn cmd_source_install(app: AppHandle, release: SourceRelease) -> Result<PlayPackMeta, String> {
    if release.bad || !release.published {
        return Err("该版本未发布或已撤回".to_string());
    }
    if !release.platforms.is_empty() && !release.platforms.contains(&1103) {
        return Err("该版本不面向 Windows 平台".to_string());
    }
    if release.host_api_version > HOST_API_VERSION {
        return Err(format!(
            "音源包需要宿主契约 v{}，当前应用仅支持 v{}，请先升级应用",
            release.host_api_version, HOST_API_VERSION
        ));
    }
    if !release.artifacts.iter().any(|a| a.path == PLAY_BUNDLE_FILE) {
        return Err(format!("manifest 缺少 {PLAY_BUNDLE_FILE} 产物"));
    }

    let dir = source_bundle::bundle_dir(&app);
    let mut state = load_state(&dir);
    if state.bad.contains(&release.source_version_code) {
        return Err(format!(
            "版本 {} 此前装载失败，已列入本地黑名单",
            release.source_version_code
        ));
    }

    let target = install_dir(&dir, release.source_version_code);
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;

    for artifact in &release.artifacts {
        let local = safe_artifact_path(&target, &artifact.path)?;
        // 同 code 重装：已有非空文件跳过（上次装到一半/手动重装；产物就一个
        // js，跨版本 diff 无意义——版本变了 code 变、目录也变）
        if local.is_file()
            && std::fs::metadata(&local).map(|m| m.len() > 0).unwrap_or(false)
        {
            continue;
        }
        let bytes = download_file(&artifact.url, 30_000).await?;
        if bytes.is_empty() {
            return Err(format!("{} 下载为空", artifact.path));
        }
        std::fs::write(&local, bytes).map_err(|e| e.to_string())?;
    }
    if !target.join(PLAY_BUNDLE_FILE).is_file() {
        return Err(format!("安装产物缺失 {PLAY_BUNDLE_FILE}"));
    }

    let pack = PlayPackMeta {
        id: OFFICIAL_PACK_ID.to_string(),
        name: String::new(),     // 引擎装配成功后回填
        version: String::new(),  // 引擎装配成功后回填
        version_code: release.source_version_code,
        version_name: release.source_version_name.clone(),
        source: "official".to_string(),
        dir: release.source_version_code.to_string(),
        installed_at: unix_now(),
    };
    // 官方包是单通道：旧的（不同 code）先记入回退快照再删除目录
    let official_was_active =
        state.active_id.as_deref() == Some(OFFICIAL_PACK_ID);
    if let Some(old) = state.packs.iter().find(|p| p.id == OFFICIAL_PACK_ID).cloned() {
        if old.dir != pack.dir {
            state.previous_official = Some(old.clone());
            let _ = std::fs::remove_dir_all(dir.join("install").join(&old.dir));
        }
        state.packs.retain(|p| p.id != OFFICIAL_PACK_ID);
    }
    state.packs.push(pack.clone());
    // 生效规则：官方包本来就在生效位（或当前没有任何生效包）→ 新官方包直接
    // 生效；用户正用着自定义包时不抢生效位（设置页可一键切回）
    if state.active_id.is_none() || official_was_active {
        state.active_id = Some(OFFICIAL_PACK_ID.to_string());
    }
    save_state(&dir, &state)?;
    broadcast_packs_changed(&app);
    log::info!(
        "[source-bundle] 已安装官方播放包 {}（{}）到 {}",
        pack.version_code,
        pack.version_name,
        target.display()
    );
    Ok(pack)
}

/// 用户粘贴直链安装自定义播放包（source=custom，不自动更新）。
///
/// 直链指向 `play-bundle.js`（IIFE 自包含：内置 defaultChainConfig）。轻校验
/// 只挡明显不是播放包的文件（缺 `__qtPlayPackFactory` 挂载点）；完整装配
/// 校验（工厂可调用、getPlayUrl 存在）由引擎页 installPlayPack 做，失败走
/// `source_pack_load_failed`（自定义包保留在列表里，不自动删除）。
#[tauri::command(rename = "source_install_from_url")]
pub async fn cmd_source_install_from_url(app: AppHandle, url: String) -> Result<PlayPackMeta, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("链接不能为空".to_string());
    }
    // 校验并下载（内部会挡内网/非 http(s)；这里再要求必须是 https 或自有 CDN）
    let checked = crate::net_guard::ensure_trusted_download_url(&url)?;
    let bytes = download_file(checked.as_str(), 60_000).await?;
    if bytes.len() < 1024 {
        return Err("下载内容太小，不是有效的播放音源包".to_string());
    }
    // 轻校验：播放包 IIFE 执行后必须挂出的工厂全局
    let text = String::from_utf8_lossy(&bytes);
    if !text.contains("__qtPlayPackFactory") {
        return Err("该链接不是有效的播放音源包（缺少装配入口）".to_string());
    }

    let dir = source_bundle::bundle_dir(&app);
    let mut state = load_state(&dir);
    let id = custom_pack_slug();
    let target = dir.join("install").join(&id);
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    std::fs::write(target.join(PLAY_BUNDLE_FILE), &bytes).map_err(|e| e.to_string())?;

    let pack = PlayPackMeta {
        id: id.clone(),
        name: "自定义播放包".to_string(),
        version: String::new(),
        version_code: 0,
        version_name: format!("custom:{id}"),
        source: "custom".to_string(),
        dir: id,
        installed_at: unix_now(),
    };
    let had_active = state.active_id.is_some();
    state.packs.push(pack.clone());
    // 首个包（此前什么都没装）直接生效；已有生效包则不打扰，用户在设置页切换
    if !had_active {
        state.active_id = Some(pack.id.clone());
    }
    save_state(&dir, &state)?;
    broadcast_packs_changed(&app);
    log::info!(
        "[source-bundle] 直链安装自定义播放包（{}）到 {}",
        pack.id,
        target.display()
    );
    Ok(pack)
}

/// 切换生效播放包（设置页单选）
#[tauri::command(rename = "source_activate_pack")]
pub async fn cmd_source_activate_pack(app: AppHandle, pack_id: String) -> Result<Value, String> {
    let dir = source_bundle::bundle_dir(&app);
    let mut state = load_state(&dir);
    if !state.packs.iter().any(|p| p.id == pack_id) {
        return Err(format!("播放包不存在: {pack_id}"));
    }
    state.active_id = Some(pack_id.clone());
    save_state(&dir, &state)?;
    broadcast_packs_changed(&app);
    Ok(json!({ "activated": pack_id }))
}

/// 卸载播放包（删目录 + 出列表；生效位顺延到剩余第一个包，没有则空）
#[tauri::command(rename = "source_uninstall_pack")]
pub async fn cmd_source_uninstall_pack(app: AppHandle, pack_id: String) -> Result<Value, String> {
    let dir = source_bundle::bundle_dir(&app);
    let mut state = load_state(&dir);
    let Some(idx) = state.packs.iter().position(|p| p.id == pack_id) else {
        return Err(format!("播放包不存在: {pack_id}"));
    };
    let removed = state.packs.remove(idx);
    let _ = std::fs::remove_dir_all(dir.join("install").join(&removed.dir));
    if state.active_id.as_deref() == Some(&pack_id) {
        state.active_id = state.packs.first().map(|p| p.id.clone());
    }
    if state.previous_official.as_ref().is_some_and(|p| p.id == pack_id) {
        state.previous_official = None;
    }
    save_state(&dir, &state)?;
    broadcast_packs_changed(&app);
    Ok(json!({ "uninstalled": pack_id }))
}

/// 引擎装配成功后回填真实包名/版本（纯展示信息，不广播、不触发换包）
#[tauri::command(rename = "source_pack_describe")]
pub async fn cmd_source_pack_describe(
    app: AppHandle,
    pack_id: String,
    name: Option<String>,
    version: Option<String>,
) -> Result<Value, String> {
    let dir = source_bundle::bundle_dir(&app);
    let mut state = load_state(&dir);
    let Some(pack) = state.packs.iter_mut().find(|p| p.id == pack_id) else {
        return Ok(json!({ "described": false }));
    };
    if let Some(n) = name.filter(|v| !v.trim().is_empty()) {
        pack.name = n;
    }
    if let Some(v) = version.filter(|v| !v.trim().is_empty()) {
        pack.version = v;
    }
    save_state(&dir, &state)?;
    Ok(json!({ "described": true }))
}

/// 引擎装配/冒烟失败上报（引擎页调用）：
/// - 官方包：versionCode 进 bad[] 黑名单 + 自动回退到 previousOfficial（没有
///   回退位就摘除官方包，生效位顺延）；广播换包让引擎装载回退包；
/// - 自定义包：保留在列表里等用户处理（引擎侧上次成功装配的包继续顶岗），
///   只记日志 + 上报后端。
#[tauri::command(rename = "source_pack_load_failed")]
pub async fn cmd_source_pack_load_failed(
    app: AppHandle,
    pack_id: String,
    error: String,
) -> Result<Value, String> {
    let dir = source_bundle::bundle_dir(&app);
    let mut state = load_state(&dir);
    let Some(idx) = state.packs.iter().position(|p| p.id == pack_id) else {
        return Ok(json!({ "handled": false }));
    };
    let pack = state.packs[idx].clone();
    report_to_backend(&app, pack.version_code, "load_failed".to_string(), error.clone()).await;
    log::warn!("[source-bundle] 播放包装载失败（{}）: {error}", pack.id);

    if pack.source != "official" {
        // 自定义包：不动状态（用户自己装的文件，可能只是网络抖动），设置页
        // 会显示引擎侧报错详情，用户可卸载或切换其他包
        return Ok(json!({ "handled": true, "reverted": false }));
    }

    // 官方包：拉黑 + 摘除 + 回退
    if !state.bad.contains(&pack.version_code) {
        state.bad.push(pack.version_code);
    }
    state.packs.remove(idx);
    let _ = std::fs::remove_dir_all(dir.join("install").join(&pack.dir));
    let mut reverted: Option<String> = None;
    if let Some(prev) = state.previous_official.take() {
        if state.packs.iter().any(|p| p.id == prev.id) {
            reverted = Some(prev.id);
        }
    }
    if state.active_id.as_deref() == Some(&pack_id) {
        state.active_id = reverted
            .clone()
            .or_else(|| state.packs.first().map(|p| p.id.clone()));
    }
    save_state(&dir, &state)?;
    broadcast_packs_changed(&app);
    Ok(json!({ "handled": true, "reverted": reverted.is_some() }))
}

/// 装载结果上报（引擎页冒烟/装载后调用）
#[tauri::command(rename = "source_report")]
pub async fn cmd_source_report(
    app: AppHandle,
    source_version_code: i64,
    result: String,
    detail: String,
) -> Result<(), String> {
    report_to_backend(&app, source_version_code, result, detail).await;
    Ok(())
}

async fn report_to_backend(app: &AppHandle, code: i64, result: String, detail: String) {
    let client = app.state::<crate::AppState>().astral.clone();
    let payload = json!({
        "platform": 1103,
        "appVersionCode": app_version_code(),
        "sourceVersionCode": code,
        "result": result,
        "detail": detail,
    });
    // 免认证上报：失败只记日志
    if let Err(e) = client.post_json_public("app/source/report", payload).await {
        log::warn!("[source-bundle] 装载结果上报失败: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_roundtrip_and_defaults() {
        let tmp = std::env::temp_dir().join(format!("ll-src-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        // 缺省：v2 空状态（schema=2，无包）
        let st = load_state(&tmp);
        assert_eq!(st.schema, 2);
        assert!(st.packs.is_empty() && st.active_id.is_none() && st.bad.is_empty());
        // 写读回
        let mut st = SourceBundleState::new_v2();
        st.packs.push(PlayPackMeta {
            id: OFFICIAL_PACK_ID.to_string(),
            name: "play-bundle".to_string(),
            version: "chain.11".to_string(),
            version_code: 2026100101,
            version_name: "2026.10.01.1".to_string(),
            source: "official".to_string(),
            dir: "2026100101".to_string(),
            installed_at: 1_800_000_000,
        });
        st.packs.push(PlayPackMeta {
            id: "custom-20261001-120000".to_string(),
            name: "自定义播放包".to_string(),
            version: String::new(),
            version_code: 0,
            version_name: "custom:20261001-120000".to_string(),
            source: "custom".to_string(),
            dir: "custom-20261001-120000".to_string(),
            installed_at: 1_800_000_100,
        });
        st.active_id = Some("custom-20261001-120000".to_string());
        st.bad.push(2026091701);
        save_state(&tmp, &st).unwrap();
        let back = load_state(&tmp);
        assert_eq!(back.schema, 2);
        assert_eq!(back.packs.len(), 2);
        assert_eq!(back.packs[0].version_code, 2026100101);
        assert_eq!(back.active_id.as_deref(), Some("custom-20261001-120000"));
        assert_eq!(back.bad, vec![2026091701]);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn state_tolerates_corrupt_json() {
        let tmp = std::env::temp_dir().join(format!("ll-src2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(state_path(&tmp), "not json").unwrap();
        let st = load_state(&tmp);
        assert_eq!(st.schema, 2, "损坏的状态文件按缺省 v2 处理");
        assert!(st.packs.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn v1_state_migrates_to_v2_and_wipes_install() {
        let tmp = std::env::temp_dir().join(format!("ll-src3-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("install").join("2026091801")).unwrap();
        std::fs::write(
            tmp.join("install").join("2026091801").join("source-bundle.js"),
            b"export const x = 1;",
        )
        .unwrap();
        // v1 形态：installed/previous + bad + lastCheckAt（camelCase）
        let v1 = r#"{
            "installed": {"sourceVersionCode": 2026091801, "dir": "2026091801",
                          "files": {"source-bundle.js": 3}, "sourceVersionName": "2026.09.18.1",
                          "source": "official"},
            "previous": null,
            "bad": [2026091701],
            "lastCheckAt": 1758000000
        }"#;
        std::fs::write(state_path(&tmp), v1).unwrap();
        let st = load_state(&tmp);
        assert_eq!(st.schema, 2);
        assert!(st.packs.is_empty(), "v1 的 ESM 包不迁移");
        assert!(st.active_id.is_none());
        assert_eq!(st.bad, vec![2026091701], "黑名单保留");
        assert_eq!(st.last_check_at, 1758000000);
        assert!(
            !tmp.join("install").exists(),
            "不兼容的旧安装目录整体清掉"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn custom_pack_slug_shape() {
        let slug = custom_pack_slug();
        assert!(slug.starts_with("custom-"), "{slug}");
        // custom-yyyymmdd-hhmmss：仅字母数字与连字符，是合法的路径段/包 id
        assert!(slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-'));
        assert_eq!(slug.len(), "custom-".len() + 8 + 1 + 6);
    }

    #[test]
    fn manifest_parses_backend_shape() {
        // 响应外层是 QtRestResp 包装；data 才与 astral QtSourceManifestVo/QtSourceReleaseVo 对齐（camelCase）
        let raw = r#"{
            "code": 200,
            "msg": "success",
            "data": {
                "schema": 3,
                "generatedAt": "2026-09-18T14:00:00Z",
                "release": {
                    "id": 9,
                    "sourceVersionCode": 2026091801,
                    "sourceVersionName": "2026.09.18.1",
                    "platforms": [1101, 1103],
                    "hostApiVersion": 1,
                    "appVersionCodes": { "1101": [304], "1103": [102, 103] },
                    "channel": "stable",
                    "notes": "酷我母带接口修复",
                    "artifacts": [
                        { "path": "chain.json", "version": 8, "url": "https://x/chain.json" },
                        { "path": "play-bundle.js", "version": 3, "url": "https://x/play-bundle.js" }
                    ],
                    "rollbackTo": null,
                    "bad": false,
                    "published": true,
                    "publishedAt": "2026-09-18T14:00:00Z",
                    "createTime": "2026-09-18T13:00:00Z"
                }
            }
        }"#;
        let wrapped: QtRestRespEnvelope<SourceManifest> = serde_json::from_str(raw).unwrap();
        assert_eq!(wrapped.code, 200);
        let manifest = wrapped.data.unwrap();
        let release = manifest.release.unwrap();
        assert_eq!(manifest.schema, 3);
        assert_eq!(release.source_version_code, 2026091801);
        assert_eq!(release.artifacts.len(), 2);
        assert!(release.artifacts.iter().any(|a| a.path == "play-bundle.js"));
        assert!(release.published && !release.bad);
        // 后端多出的字段（appVersionCodes/rollbackTo…）被 serde 忽略
    }

    #[test]
    fn manifest_parses_public_shape_with_nullable_fields() {
        // 生产环境实测响应：公开 manifest 的 published/id/createTime 为 null，
        // rollbackTo 也可能为 null；可空列（notes/channel）同理，都不能让解析失败
        let raw = r#"{
            "code": 200,
            "msg": "success",
            "data": {
                "schema": 3,
                "generatedAt": "2026-09-19T00:45:11Z",
                "release": {
                    "id": null,
                    "sourceVersionCode": 2026091901,
                    "sourceVersionName": "2026.09.19.1",
                    "platforms": [1103],
                    "hostApiVersion": 1,
                    "appVersionCodes": { "1103": [102, 103] },
                    "channel": "stable",
                    "notes": null,
                    "artifacts": [
                        { "path": "play-bundle.js", "version": 1, "url": "https://x/1" }
                    ],
                    "rollbackTo": null,
                    "bad": false,
                    "published": null,
                    "publishedAt": "2026-09-19T00:42:32Z",
                    "createTime": null
                }
            }
        }"#;
        let wrapped: QtRestRespEnvelope<SourceManifest> = serde_json::from_str(raw).unwrap();
        let manifest = wrapped.data.unwrap();
        let release = manifest.release.unwrap();
        assert_eq!(release.source_version_code, 2026091901);
        // published=null 表示「公开接口不暴露该字段」，不是未发布
        assert!(release.published && !release.bad);
        assert_eq!(release.notes, "");
        assert_eq!(release.artifacts.len(), 1);
    }

    #[test]
    fn manifest_wrapped_null_release_means_nothing_published() {
        // 无可用包：data.release 为 null（data 本身仍在，schema 照常）
        let raw = r#"{"code":200,"msg":"success","data":{"schema":3,"generatedAt":"x","release":null}}"#;
        let wrapped: QtRestRespEnvelope<SourceManifest> = serde_json::from_str(raw).unwrap();
        assert!(wrapped.data.unwrap().release.is_none());
    }

    #[test]
    fn install_dir_is_numeric_only() {
        let base = Path::new("/tmp/x");
        assert_eq!(
            install_dir(base, 2026091801),
            PathBuf::from("/tmp/x/install/2026091801")
        );
        // 负数/0 也只是普通十进制串，不产生 ".." 等危险段
        assert_eq!(install_dir(base, -1), PathBuf::from("/tmp/x/install/-1"));
    }

    #[test]
    fn artifact_path_cannot_escape_install_dir() {
        let root = Path::new("/tmp/x/install/2026091801");
        // 正常形态（manifest 里实际就是这个）照旧可用
        assert_eq!(
            safe_artifact_path(root, "play-bundle.js").unwrap(),
            root.join("play-bundle.js")
        );
        assert_eq!(
            safe_artifact_path(root, "dist/play-bundle.js").unwrap(),
            root.join("dist").join("play-bundle.js")
        );
        for bad in [
            "../evil.dll",
            "..\\..\\evil.dll",
            "a/../../evil.dll",
            "a/..",
            "/abs/evil.dll",
            "C:/Windows/evil.dll",
            "C:\\Windows\\evil.dll",
            "\\\\server\\share\\evil.dll",
            "",
            "a//b",
            "./a",
            "a/./b",
        ] {
            assert!(
                safe_artifact_path(root, bad).is_err(),
                "{bad:?} 属于危险路径，应被拒绝"
            );
        }
    }
}
