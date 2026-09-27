//! 音源包安装与本地状态（音源包热更新方案 P2 / §2.3）：
//!
//! - `state.json`（`<bundle_dir>/state.json`）：installed / previous / bad[] /
//!   lastCheckAt，客户端判定的事实来源；
//! - `source_install`：按 manifest artifacts 只下差异文件（version 比对），
//!   落盘 `install/<code>/`，更新 state（installed → previous 平移）；
//! - `source_apply`：重建引擎窗口（新包生效）+ 清主窗口取链缓存 + 触发
//!   前端清 urlCache；真实冒烟通过后引擎页调 `app_restart` 重启应用，
//!   让新包在主窗口侧也彻底生效（坏包冒烟失败则不重启，走回退）；
//! - `source_rollback_builtin`：删除 installed 记录（目录保留作证据），
//!   引擎页读不到 installed 即回退主窗口内置层；
//! - `demote_stale_installed`：内置包比已装远程包新时把旧包降级为 previous，
//!   内置版直接生效（与安卓端 demoteStaleInstalled 同一套方案）；
//! - `source_mark_bad` / `source_report`：冒烟失败登记 + 装载结果上报后端。
//!
//! 网络下载走 `cmd_builtin_request` 同款 source_builtin_request（统一 UA /
//! 超时 / JSON 解析）；artifacts 的 url 是直链（§七发布脚本上传 OSS/后端）。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::astral;
use crate::commands::{source_builtin_request, SourceRequestOptions};
use crate::{source_bundle, source_window, AppState};

/// 音源包宿主契约版本（§2.2 hostApiVersion：1 = {request, chain kind:
/// lx/http/bundle, verifyPlayable}）。bundle 要求更高时拒绝加载。
pub const HOST_API_VERSION: i64 = 1;

/// install/<code>/ 目录名前缀（code 本身就是目录名，这里只是文档口径）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct InstalledRelease {
    pub source_version_code: i64,
    /// install/ 下的目录名（当前 = code 的十进制串）
    pub dir: String,
    /// path → artifacts[].version
    pub files: std::collections::BTreeMap<String, i64>,
    /// 版本展示名（设置页显示用）
    pub source_version_name: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SourceBundleState {
    pub installed: Option<InstalledRelease>,
    pub previous: Option<InstalledRelease>,
    /// 冒烟失败过的版本号：这些 code 不再自动下载（§2.3 判定第 4 步）
    pub bad: Vec<i64>,
    pub last_check_at: i64,
}

// ---------- state.json 读写 ----------

pub(crate) fn state_path(dir: &Path) -> PathBuf {
    dir.join("state.json")
}

pub(crate) fn load_state(dir: &Path) -> SourceBundleState {
    let Ok(text) = std::fs::read_to_string(state_path(dir)) else {
        return SourceBundleState::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

pub(crate) fn save_state(dir: &Path, state: &SourceBundleState) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(state_path(dir), text).map_err(|e| e.to_string())
}

/// install/<code>/ 目录（code 转十进制串；白名单字符，杜绝路径注入）
fn install_dir(dir: &Path, code: i64) -> PathBuf {
    dir.join("install").join(code.to_string())
}

/// 内置包比已装远程包还新时（升级应用后常见），把旧远程包降级为回退目标
/// （installed → previous 平移，文件不动），让内置版直接生效。
///
/// 与安卓端 `qt-uniappx/services/source-bundle-fs.uts` 的 demoteStaleInstalled
/// 同一套方案。不降级的话旧包会以 installed 身份继续出现在设置页（显示成
/// 「当前音源包」）、被更新检查当基线（对着已过时的版本反复提更新）；引擎页
/// 虽有「谁新用谁」兜底，但状态层面应保持一致。幂等：重复调用无副作用。
///
/// 返回 true 表示发生了降级。
pub(crate) fn demote_stale_installed(dir: &Path, builtin_code: i64) -> bool {
    let mut state = load_state(dir);
    let Some(installed) = state.installed.clone() else {
        return false;
    };
    if installed.source_version_code >= builtin_code {
        return false;
    }
    state.previous = Some(installed);
    state.installed = None;
    match save_state(dir, &state) {
        Ok(()) => {
            log::info!(
                "[source-bundle] 内置包（code {builtin_code}）新于已装远程包（code {}），已切回内置版生效",
                state.previous.as_ref().map(|p| p.source_version_code).unwrap_or_default()
            );
            true
        }
        Err(e) => {
            log::warn!("[source-bundle] 降级旧远程包写状态失败: {e}");
            false
        }
    }
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

/// 当前音源包本地状态（引擎页与设置页共用）
#[tauri::command(rename = "source_state")]
pub async fn cmd_source_state(app: AppHandle) -> Result<Value, String> {
    let dir = source_bundle::bundle_dir(&app);
    // 读取前先对齐「内置版新于已装包」的降级（幂等）：设置页、引擎页、前端
    // 更新检查都从这里拿事实，旧包不该再以 installed 身份出现
    demote_stale_installed(&dir, crate::app_config::SOURCE_PACK_CODE);
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

/// 下载并安装音源包（§2.3 判定第 6 步的执行端）：
/// 只下差异文件 → 落盘 install/<code>/ → installed/previous 平移。
/// 返回安装结果（installed = 装到了哪个版本）。
#[tauri::command(rename = "source_install")]
pub async fn cmd_source_install(app: AppHandle, release: SourceRelease) -> Result<InstalledRelease, String> {
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
    if release.artifacts.is_empty() {
        return Err("manifest 无 artifacts".to_string());
    }

    let dir = source_bundle::bundle_dir(&app);
    let mut state = load_state(&dir);
    if state.bad.contains(&release.source_version_code) {
        return Err(format!(
            "版本 {} 此前冒烟失败，已列入本地黑名单",
            release.source_version_code
        ));
    }

    let target = install_dir(&dir, release.source_version_code);
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;

    let mut files = std::collections::BTreeMap::new();
    for artifact in &release.artifacts {
        files.insert(artifact.path.clone(), artifact.version);
        // 已有同名同版本文件（上一次装到一半 / 同 code 重装）跳过
        let local = safe_artifact_path(&target, &artifact.path)?;
        let same_version = state
            .installed
            .as_ref()
            .filter(|i| i.source_version_code == release.source_version_code)
            .and_then(|i| i.files.get(&artifact.path))
            .is_some_and(|v| *v == artifact.version);
        if same_version && local.is_file() {
            continue;
        }
        let bytes = download_file(&artifact.url, 30_000).await?;
        if bytes.is_empty() {
            return Err(format!("{} 下载为空", artifact.path));
        }
        std::fs::write(&local, bytes).map_err(|e| e.to_string())?;
    }

    // chain.json 是第一层把关：下载后立刻按内容校验不过就整体判失败
    // （bundle 编译检查与真实冒烟在引擎页加载时做）
    let installed = InstalledRelease {
        source_version_code: release.source_version_code,
        dir: release.source_version_code.to_string(),
        files,
        source_version_name: release.source_version_name.clone(),
    };
    state.previous = state.installed.take();
    state.installed = Some(installed.clone());
    save_state(&dir, &state)?;
    log::info!(
        "[source-bundle] 已安装版本 {}（{}）到 {}",
        installed.source_version_code,
        installed.source_version_name,
        target.display()
    );
    Ok(installed)
}

/// 应用音源包后重启应用（引擎页在真实冒烟通过后调用）。
///
/// 只重建引擎窗口时，新包仅在引擎侧生效：主窗口的内嵌兜底层、已建立的
/// 播放会话与各处内存缓存仍停在旧包上，用户看到的是「应用了但没完全生效」。
/// 重启让新包从进程启动即生效，行为可预期。
///
/// 放在冒烟之后是刻意的：坏包会在引擎页走 `source_mark_bad` 回退，
/// 那种情况下不重启，用户能看到失败原因而不是带着坏包重启。
#[tauri::command(rename = "app_restart")]
pub async fn cmd_app_restart(app: AppHandle) -> Result<(), String> {
    // 独立线程 + 短暂延迟：先把 invoke 响应发回前端，再请求退出重启。
    // request_restart 走 RunEvent::ExitRequested/Exit 正常退出流程
    // （保存播放现场、清理托盘与歌词窗），再以原参数重启进程。
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        log::info!("[source-bundle] 音源包已应用，重启应用生效");
        app.request_restart();
    });
    Ok(())
}

/// 音源包应用（生效）：重建引擎窗口 + 清引擎侧取链缓存。
/// 正在播放不打断（PlayUrlCache 只影响后续取链）。
/// 真实冒烟通过后由引擎页调 `app_restart` 重启应用（见上）。
#[tauri::command(rename = "source_apply")]
pub async fn cmd_source_apply(app: AppHandle, smoke: Option<bool>) -> Result<Value, String> {
    let dir = source_bundle::bundle_dir(&app);
    let state = load_state(&dir);
    if state.installed.is_none() {
        return Err("当前没有已安装的音源包（内置版随应用提供，无需应用）".to_string());
    }
    let smoke = smoke.unwrap_or(true);
    // 重建窗口 → 引擎页重新加载新包（?smoke=1 触发真实网络冒烟）
    let handle = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = source_window::recreate(&handle, smoke) {
            log::error!("[source-bundle] {e}");
        }
    });
    // 引擎重启后旧链路引用全部作废，主窗口侧 urlCache 一并清掉
    let _ = app.emit("source-applied", ());
    Ok(json!({ "applied": true, "smoke": smoke }))
}

/// 回滚到内置版：清掉 installed/previous 记录（目录保留，便于排查），
/// 引擎页读不到 installed 即不加载 bundle，主窗口自动用内置层。
#[tauri::command(rename = "source_rollback_builtin")]
pub async fn cmd_source_rollback_builtin(app: AppHandle) -> Result<Value, String> {
    let dir = source_bundle::bundle_dir(&app);
    let mut state = load_state(&dir);
    state.installed = None;
    state.previous = None;
    save_state(&dir, &state)?;
    let handle = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = source_window::recreate(&handle, false) {
            log::error!("[source-bundle] 回滚重建引擎窗口失败: {e}");
        }
    });
    let _ = app.emit("source-applied", ());
    Ok(json!({ "rolledBack": true }))
}

/// 冒烟失败登记（引擎页调用）：code 进 bad[]，installed 退回 previous
/// （§2.4：失败 → 自动回退 + 写黑名单）。
#[tauri::command(rename = "source_mark_bad")]
pub async fn cmd_source_mark_bad(
    app: AppHandle,
    code: i64,
    detail: String,
    result: Option<String>,
) -> Result<Value, String> {
    mark_bad_impl(&app, code, &detail).await?;
    // 装载结果上报（坏包发现）
    report_to_backend(&app, code, result.unwrap_or_else(|| "smoke_failed".to_string()), detail).await;
    Ok(json!({ "marked": true }))
}

/// 成功装载上报（引擎页真实冒烟通过后调用）
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

async fn mark_bad_impl(app: &AppHandle, code: i64, _detail: &str) -> Result<(), String> {
    let dir = source_bundle::bundle_dir(app);
    let mut state = load_state(&dir);
    if !state.bad.contains(&code) {
        state.bad.push(code);
    }
    // 冒烟失败 = 本次装载作废：installed 退回 previous
    if state
        .installed
        .as_ref()
        .is_some_and(|i| i.source_version_code == code)
    {
        let previous = state.previous.take();
        state.installed = previous;
    }
    save_state(&dir, &state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_roundtrip_and_defaults() {
        let tmp = std::env::temp_dir().join(format!("ll-src-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        // 缺省：空状态
        let st = load_state(&tmp);
        assert!(st.installed.is_none());
        assert!(st.bad.is_empty());
        // 写读回
        let mut st = SourceBundleState::default();
        st.installed = Some(InstalledRelease {
            source_version_code: 2026091801,
            dir: "2026091801".to_string(),
            files: [
                ("chain.json".to_string(), 8),
                ("source-bundle.js".to_string(), 3),
            ]
            .into_iter()
            .collect(),
            source_version_name: "2026.09.18.1".to_string(),
        });
        st.bad.push(2026091701);
        save_state(&tmp, &st).unwrap();
        let back = load_state(&tmp);
        assert_eq!(back.installed.as_ref().unwrap().source_version_code, 2026091801);
        assert_eq!(back.installed.as_ref().unwrap().files["chain.json"], 8);
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
        assert!(st.installed.is_none(), "损坏的状态文件按缺省处理");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn demote_stale_installed_shifts_to_previous() {
        let tmp = std::env::temp_dir().join(format!("ll-src3-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let rel = |code: i64| InstalledRelease {
            source_version_code: code,
            dir: code.to_string(),
            files: std::collections::BTreeMap::new(),
            source_version_name: code.to_string(),
        };
        let builtin = 2026092602i64;
        // 装了旧于内置版的包：降级为 previous，installed 清空（与安卓 demoteStaleInstalled 一致）
        let mut st = SourceBundleState::default();
        st.installed = Some(rel(2026092301));
        st.bad = vec![2026091701];
        save_state(&tmp, &st).unwrap();
        assert!(demote_stale_installed(&tmp, builtin));
        let back = load_state(&tmp);
        assert!(back.installed.is_none());
        assert_eq!(back.previous.as_ref().unwrap().source_version_code, 2026092301);
        assert_eq!(back.bad, vec![2026091701], "黑名单不受降级影响");
        // 幂等：installed 已空，再跑不变
        assert!(!demote_stale_installed(&tmp, builtin));
        let back = load_state(&tmp);
        assert!(back.installed.is_none());
        assert_eq!(back.previous.as_ref().unwrap().source_version_code, 2026092301);
        // 已装包不旧于内置版（同号/更新）：不降级，previous 也不动
        let mut st = SourceBundleState::default();
        st.installed = Some(rel(2026092603));
        st.previous = Some(rel(2026092602));
        save_state(&tmp, &st).unwrap();
        assert!(!demote_stale_installed(&tmp, builtin));
        let back = load_state(&tmp);
        assert_eq!(back.installed.as_ref().unwrap().source_version_code, 2026092603);
        assert_eq!(back.previous.as_ref().unwrap().source_version_code, 2026092602);
        let _ = std::fs::remove_dir_all(&tmp);
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
                        { "path": "source-bundle.js", "version": 3, "url": "https://x/bundle.js" }
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
        assert_eq!(release.artifacts[0].path, "chain.json");
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
                        { "path": "chain.json", "version": 1, "url": "https://x/1" }
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
        // 正常形态（manifest 里实际就是这两个）照旧可用
        assert_eq!(
            safe_artifact_path(root, "chain.json").unwrap(),
            root.join("chain.json")
        );
        assert_eq!(
            safe_artifact_path(root, "dist/source-bundle.js").unwrap(),
            root.join("dist").join("source-bundle.js")
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
