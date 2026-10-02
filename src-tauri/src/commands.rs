//! Tauri 命令函数，与 lib.rs 分离以规避宏展开冲突。

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use crate::astral::AuthSession;
use crate::audio::engine::AudioCmd;
use crate::audio::fx::{EqParams, FadeParams, FxState};
use crate::audio::state::PlayMode;
use crate::download::{self, DownloadJob, DownloadManager, DownloadOutcome};
use crate::provider::types::{Quality, SourceId, Track};
use crate::provider::url_cache::PlayUrlCache;
use crate::provider::ProviderError;
use crate::{quality_str, resolve_play_url_script};
use tauri::{Emitter, State};

use crate::db::store::{DownloadTask, HistoryItem, PlaylistSummary};
use crate::AppState;

// ---------- 音源脚本内置方法（插件化方案 v3 · 试点） ----------
//
// 音源脚本包（运行时安装，不入仓库）不含 HTTP 实现，由本命令作为唯一内置
// request 执行：URL/请求头/请求体全由脚本拼装（对齐蓝本 http.ts 的
// makeHeaders/directRequest 职责划分），本命令只负责发出请求并回传
// 状态码/响应头/已解析的 body。前端不直接发外部网络（CSP 不变）。

/// 音源脚本的请求选项（前端以 camelCase 传入；引擎页注入 bundle 的 request）
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRequestOptions {
    pub method: Option<String>,
    pub headers: Option<std::collections::HashMap<String, String>>,
    pub body: Option<String>,
    pub timeout_ms: Option<u64>,
}

/// 音源脚本的响应（契约见 src/source-scripts/qt-contract/contract.ts）
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceResponse {
    pub status_code: u16,
    pub headers: std::collections::HashMap<String, String>,
    /// JSON 响应为已解析值；非 JSON 为字符串
    pub body: serde_json::Value,
}

/// builtin_request 允许的请求方法（脚本只会用到这些；CONNECT/TRACE 之类没有正当用途）
const ALLOWED_REQUEST_METHODS: [&str; 7] =
    ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"];

/// 单次响应正文的上限：脚本可能被诱导去拉一个巨大文件，而正文是一次性读进内存的
const MAX_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;

/// 内置 HTTP 客户端：桌面浏览器 UA 兜底（各平台特殊头由脚本按需覆盖）
fn source_builtin_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
            .build()
            .expect("source builtin client")
    })
}

/// builtin_request 的可直调实现（供命令与测试共用）
pub(crate) async fn source_builtin_request(
    url: &str,
    options: Option<&SourceRequestOptions>,
) -> Result<SourceResponse, String> {
    // 音源脚本可能来自第三方音源包，URL 由脚本自己拼装：先把"本机能被指使去访问什么"
    // 收敛到公网 http(s)。原实现原样发出去，脚本可以让本机去打 127.0.0.1 的端口
    // （拿本机服务当跳板）、云元数据地址 169.254.169.254，或直接用 file: 读本地文件。
    let target = crate::net_guard::ensure_public_http_url(url)?;
    let method = options
        .and_then(|o| o.method.as_deref())
        .unwrap_or("GET")
        .to_uppercase();
    if !ALLOWED_REQUEST_METHODS.contains(&method.as_str()) {
        return Err(format!("不支持的请求方法 {method}"));
    }
    let timeout =
        std::time::Duration::from_millis(options.and_then(|o| o.timeout_ms).unwrap_or(15_000));
    let mut req = source_builtin_client()
        .request(
            reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?,
            target.as_str(),
        )
        .timeout(timeout);
    if let Some(headers) = options.and_then(|o| o.headers.as_ref()) {
        for (key, value) in headers {
            req = req.header(key, value);
        }
    }
    if let Some(body) = options.and_then(|o| o.body.as_deref()) {
        req = req.body(body.to_string());
    }
    let res = req.send().await.map_err(crate::astral::sanitize_err)?;
    // 正文是一次性读进内存的：先按 content-length 拦一次超大响应
    if let Some(len) = res.content_length() {
        if len > MAX_RESPONSE_BYTES {
            return Err(format!("响应过大（{len} 字节），已拒绝"));
        }
    }
    let status = res.status().as_u16();
    let mut headers = std::collections::HashMap::new();
    for (name, value) in res.headers() {
        if let Ok(v) = value.to_str() {
            headers.insert(name.as_str().to_lowercase(), v.to_string());
        }
    }
    // 上游 content-type 不可靠（网易歌单接口回 text/plain、QQ 回 x-javascript、
    // 酷狗回 text/html），对齐蓝本 http.ts 的行为：不看 content-type 直接尝试
    // JSON 解析，失败则原样字符串。
    let text = res.text().await.map_err(crate::astral::sanitize_err)?;
    let body =
        serde_json::from_str::<serde_json::Value>(&text).unwrap_or(serde_json::Value::String(text));
    Ok(SourceResponse {
        status_code: status,
        headers,
        body,
    })
}

#[tauri::command(rename = "builtin_request")]
pub async fn cmd_builtin_request(
    url: String,
    options: Option<SourceRequestOptions>,
) -> Result<SourceResponse, String> {
    source_builtin_request(&url, options.as_ref()).await
}

/// 取链脚本化（方案 v3）：前端共享脚本包解析出的播放地址回填引擎缓存。
///
/// 引擎侧取链的缓存键为 `{platform}:{trackId}:{quality}`，
/// 回填后播放/预取直接命中缓存；未回填（解析失败）时引擎经
/// playurl_bridge 现问前端，仍失败则本次取链按失败处理。
#[tauri::command(rename = "set_resolved_play_url")]
pub async fn cmd_set_resolved_play_url(
    state: State<'_, AppState>,
    track: Track,
    quality: Quality,
    url: String,
) -> Result<(), ProviderError> {
    if url.is_empty() {
        return Ok(());
    }
    let key = PlayUrlCache::cache_key(
        &track.platform.to_string(),
        &track.id,
        crate::quality_str(quality),
    );
    state.url_cache.set(key, url);
    Ok(())
}

/// 引擎 → 前端取链桥（playurl_bridge）：主窗口挂载后置就绪标志。
/// 未就绪期间引擎的取链不等待，直接按失败处理（前端未挂载时必然无答案）。
#[tauri::command(rename = "script_bridge_ready")]
pub async fn cmd_script_bridge_ready() {
    crate::playurl_bridge::set_ready();
}

/// 引擎 → 前端取链桥（playurl_bridge）：前端脚本包按 requestId 应答播放地址；
/// 空串 = 前端解析失败，引擎把本次取链按失败处理。
#[tauri::command(rename = "resolve_play_url_reply")]
pub async fn cmd_resolve_play_url_reply(request_id: u64, url: String) {
    crate::playurl_bridge::reply(request_id, url);
}

#[tauri::command(rename = "invalidate_play_url")]
pub async fn cmd_invalidate_play_url(
    state: State<'_, AppState>,
    track: Track,
    quality: Quality,
) -> Result<(), String> {
    let key = crate::provider::url_cache::PlayUrlCache::cache_key(
        &track.platform.to_string(),
        &track.id,
        quality_str(quality),
    );
    state.url_cache.invalidate(&key);
    Ok(())
}

// ---------- 播放控制 ----------

/// 单曲播放（队列替换为 [track]）；列表播放请用 play_queue。
#[tauri::command(rename = "play_track")]
pub async fn cmd_play_track(
    state: State<'_, AppState>,
    track: Track,
    quality: Quality,
) -> Result<(), ProviderError> {
    state.engine.send(AudioCmd::SetQueue {
        tracks: vec![track.clone()],
        index: 0,
    });
    // SetQueue 已含取址链路（play_queue_track），quality 这里仅作缓存键一致性
    let _ = quality;
    Ok(())
}

/// 设置「默认播放音质」（设置页入口，DESIGN §7.3）：写进 settings 重启后保持，
/// 并对当前曲目立即生效（当前这首被单独指定过音质时除外）。
#[tauri::command(rename = "set_default_quality")]
pub async fn cmd_set_default_quality(
    state: State<'_, AppState>,
    quality: crate::audio::state::Quality,
) -> Result<(), String> {
    state.engine.send(AudioCmd::SetDefaultQuality { quality });
    Ok(())
}

/// 只改当前这首的音质（播放条入口）：不写 settings，切到别的歌自动回到默认音质。
#[tauri::command(rename = "set_track_quality")]
pub async fn cmd_set_track_quality(
    state: State<'_, AppState>,
    quality: crate::audio::state::Quality,
) -> Result<(), String> {
    state.engine.send(AudioCmd::SetTrackQuality { quality });
    Ok(())
}

/// 列表入队并播放 startIndex（DESIGN §11.2 play_queue）
#[tauri::command(rename = "play_queue")]
pub async fn cmd_play_queue(
    state: State<'_, AppState>,
    tracks: Vec<Track>,
    start_index: u32,
) -> Result<(), String> {
    if tracks.is_empty() {
        return Err("队列为空".into());
    }
    state.engine.send(AudioCmd::SetQueue {
        tracks,
        index: start_index as usize,
    });
    Ok(())
}

#[tauri::command(rename = "play_at")]
pub async fn cmd_play_at(state: State<'_, AppState>, index: u32) -> Result<(), String> {
    state.engine.send(AudioCmd::PlayAt(index as usize));
    Ok(())
}

#[tauri::command(rename = "next")]
pub async fn cmd_next(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.send(AudioCmd::Next);
    Ok(())
}

#[tauri::command(rename = "previous")]
pub async fn cmd_previous(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.send(AudioCmd::Previous);
    Ok(())
}

#[tauri::command(rename = "set_play_mode")]
pub async fn cmd_set_play_mode(state: State<'_, AppState>, mode: PlayMode) -> Result<(), String> {
    state.engine.send(AudioCmd::SetPlayMode(mode));
    Ok(())
}

#[tauri::command(rename = "get_queue")]
pub async fn cmd_get_queue(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let q = state.engine.queue_snapshot();
    Ok(serde_json::json!({
        "tracks": q.tracks,
        "index": q.index.map(|i| i as u32),
    }))
}

#[tauri::command(rename = "clear_queue")]
pub async fn cmd_clear_queue(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.send(AudioCmd::ClearQueue);
    Ok(())
}

// ---------- 队列编辑（DESIGN §11.5 队列 2.0） ----------

/// 下一首播放：插到当前曲目之后，不打断当前播放。
#[tauri::command(rename = "queue_add_next")]
pub async fn cmd_queue_add_next(state: State<'_, AppState>, track: Track) -> Result<(), String> {
    state.engine.send(AudioCmd::AddNext(Box::new(track)));
    Ok(())
}

/// 加入队尾（不打断当前播放）；空队列时只入队，等用户点播。
#[tauri::command(rename = "queue_append")]
pub async fn cmd_queue_append(
    state: State<'_, AppState>,
    tracks: Vec<Track>,
) -> Result<(), String> {
    state.engine.send(AudioCmd::Append(tracks));
    Ok(())
}

/// 移除队列中的某一项。
#[tauri::command(rename = "queue_remove_at")]
pub async fn cmd_queue_remove_at(state: State<'_, AppState>, index: u32) -> Result<(), String> {
    state.engine.send(AudioCmd::RemoveAt(index as usize));
    Ok(())
}

/// 拖动排序：把 from 位置的曲目移到 to。
#[tauri::command(rename = "queue_move")]
pub async fn cmd_queue_move(state: State<'_, AppState>, from: u32, to: u32) -> Result<(), String> {
    state.engine.send(AudioCmd::MoveItem {
        from: from as usize,
        to: to as usize,
    });
    Ok(())
}

/// 清空当前曲目之后的所有曲目。
#[tauri::command(rename = "queue_clear_after")]
pub async fn cmd_queue_clear_after(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.send(AudioCmd::ClearAfter);
    Ok(())
}

/// 批量移除队列中的多项（队列批量管理）。下标全部按移除前的位置给出；
/// 引擎侧一次重排只发一次 queue-changed 事件，列表以事件回灌为准。
#[tauri::command(rename = "queue_remove_indices")]
pub async fn cmd_queue_remove_indices(
    state: State<'_, AppState>,
    indices: Vec<u32>,
) -> Result<(), String> {
    let idx = indices.into_iter().map(|i| i as usize).collect::<Vec<_>>();
    state.engine.send(AudioCmd::RemoveIndices(idx));
    Ok(())
}

// ---------- 基础控制 ----------

#[tauri::command(rename = "set_volume")]
pub async fn cmd_set_volume(state: State<'_, AppState>, volume: f32) -> Result<(), String> {
    state.engine.send(AudioCmd::SetVolume(volume));
    Ok(())
}

#[tauri::command(rename = "set_muted")]
pub async fn cmd_set_muted(state: State<'_, AppState>, muted: bool) -> Result<(), String> {
    state.engine.send(AudioCmd::SetMuted(muted));
    Ok(())
}

#[tauri::command(rename = "get_playback_state")]
pub async fn cmd_get_playback_state(
    state: State<'_, AppState>,
) -> Result<crate::audio::state::PlaybackStateSnapshot, String> {
    Ok(state.engine.snapshot())
}

/// 恢复上次播放现场（DESIGN §8.3 / §11.2）：读 play_queue + settings，
/// 引擎置队列、应用播放模式/音质/音量，并暂停态加载当前曲定位到上次进度。
/// 无存档返回 null。
#[tauri::command(rename = "restore_last_session")]
pub async fn cmd_restore_last_session(
    state: State<'_, AppState>,
) -> Result<Option<crate::audio::state::PlaybackStateSnapshot>, String> {
    // 引擎已有现场（比如正在播放）→ 直接回当前快照，**绝不**再发 RestoreSession
    // 把它替换成暂停态。WebView 重挂/重载时前端会重调本命令，
    // 之前版本会因此把播放中的歌打断并回一个"未在播放"的空快照。
    let current = state.engine.snapshot();
    if current.track_id.is_some() {
        return Ok(Some(current));
    }
    let Some(db) = &state.db else {
        return Ok(None);
    };
    let Some(session) = db.with(crate::db::store::load_session)? else {
        return Ok(None);
    };
    let s = &session.state;
    let play_mode: PlayMode =
        serde_json::from_value(serde_json::json!(s.play_mode)).unwrap_or(PlayMode::ListLoop);
    let quality: Quality =
        serde_json::from_value(serde_json::json!(s.quality)).unwrap_or(Quality::High);
    // 引擎应装上的那一曲（RestoreSession 处理完 track_id 就位）
    let expected_track = session.tracks.get(s.index).map(|t| t.id.clone());
    state.engine.send(AudioCmd::RestoreSession {
        tracks: session.tracks,
        index: s.index,
        position_ms: s.position_ms,
        play_mode,
        volume: s.volume.clamp(0.0, 1.0),
        muted: s.muted,
        quality: quality.into(),
    });
    // mpsc 是异步的：这里**立刻** snapshot 会拿到 track=null 的默认快照，
    // 前端拿它 applySnapshot 会把引擎刚推的带曲目事件盖掉 ——
    // 播放条从此停在「未在播放」而音频其实在响。等引擎把当前曲装上再回。
    let engine = state.engine.clone();
    let snap = tauri::async_runtime::spawn_blocking(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        loop {
            let cur = engine.snapshot();
            let loaded = match &expected_track {
                Some(id) => cur.track_id.as_deref() == Some(id.as_str()),
                None => true,
            };
            if loaded || std::time::Instant::now() >= deadline {
                break cur;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    })
    .await
    .map_err(|e| format!("等待恢复播放现场失败: {e}"))?;
    Ok(Some(snap))
}

#[tauri::command(rename = "pause")]
pub async fn cmd_pause(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.send(AudioCmd::Pause);
    Ok(())
}

#[tauri::command(rename = "resume")]
pub async fn cmd_resume(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.send(AudioCmd::Play);
    Ok(())
}

#[tauri::command(rename = "stop")]
pub async fn cmd_stop(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.send(AudioCmd::Stop);
    Ok(())
}

#[tauri::command(rename = "seek")]
pub async fn cmd_seek(state: State<'_, AppState>, position_ms: u64) -> Result<(), String> {
    state.engine.send(AudioCmd::Seek(position_ms));
    Ok(())
}

// ---------- 倍速 / 睡眠定时 / 音效（EQ / 响度归一化 / 淡入淡出） ----------

/// 改播放倍速（0.5 ~ 2.0，引擎侧夹紧）。立即对当前曲目生效并持久化。
#[tauri::command(rename = "set_speed")]
pub async fn cmd_set_speed(state: State<'_, AppState>, speed: f32) -> Result<(), String> {
    state.engine.send(AudioCmd::SetSpeed(speed));
    Ok(())
}

/// 武装 / 取消睡眠定时。`remainingMs` = 倒计时剩余毫秒（None = 取消）；
/// `afterTrack` = 播完当前曲目后停止。到点引擎暂停播放并广播 sleep-timer-fired。
#[tauri::command(rename = "set_sleep_timer")]
pub async fn cmd_set_sleep_timer(
    state: State<'_, AppState>,
    remaining_ms: Option<u64>,
    after_track: bool,
) -> Result<(), String> {
    state.engine.send(AudioCmd::SetSleepTimer {
        remaining_ms,
        after_track,
    });
    Ok(())
}

/// 当前音效设置（设置页「音效」分区回读）。
#[tauri::command(rename = "get_fx_state")]
pub async fn cmd_get_fx_state(state: State<'_, AppState>) -> Result<FxState, String> {
    Ok(state.engine.fx_state())
}

/// 整体替换均衡器参数并持久化（含开关 / 前置放大 / 十段增益）。
#[tauri::command(rename = "set_eq")]
pub async fn cmd_set_eq(state: State<'_, AppState>, eq: EqParams) -> Result<(), String> {
    state.engine.send(AudioCmd::SetEq(eq));
    Ok(())
}

/// 响度归一化开关并持久化。
#[tauri::command(rename = "set_loudnorm")]
pub async fn cmd_set_loudnorm(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    state.engine.send(AudioCmd::SetLoudNorm(enabled));
    Ok(())
}

/// 淡入淡出参数（开关 + 时长）并持久化。
#[tauri::command(rename = "set_fade")]
pub async fn cmd_set_fade(state: State<'_, AppState>, fade: FadeParams) -> Result<(), String> {
    state.engine.send(AudioCmd::SetFade(fade));
    Ok(())
}

/// 播放条频谱背景开关并持久化（开 = 引擎侧 FFT 推 `spectrum` 事件）。
#[tauri::command(rename = "set_spectrum")]
pub async fn cmd_set_spectrum(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    state.engine.send(AudioCmd::SetSpectrum(enabled));
    Ok(())
}

// ---------- 播放缓存（在线流的磁盘缓冲，cache/audio/<sha1>.part） ----------

/// 缓存统计（设置页「通用」显示体积）：audio_* = 播放流缓存，
/// web_* = WebView2 的纯缓存子目录（封面 / 脚本 / HTTP 资源，可再生）。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioCacheStats {
    pub total_bytes: u64,
    pub file_count: u64,
    pub web_bytes: u64,
    pub web_count: u64,
}

/// 缓存清理结果：freed = 实际删掉的字节；failed = 被占用等原因删不掉的文件数。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioCacheClearResult {
    pub freed_bytes: u64,
    pub failed_count: u64,
}

/// 递归统计目录体积。缓存目录通常只有一层 `.part` 文件，按通用目录处理以兜底。
fn dir_stats(dir: &std::path::Path) -> (u64, u64) {
    crate::cache::dir_stats(dir)
}

/// WebView2 用户数据目录（EBWebView，app_local_data_dir 下）。
fn webview_profile_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_local_data_dir()
        .map(|p| p.join("EBWebView"))
        .map_err(|e| format!("取应用数据目录失败: {e}"))
}

#[tauri::command(rename = "audio_cache_stats")]
pub async fn cmd_audio_cache_stats(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<AudioCacheStats, String> {
    let dir = state.audio_cache_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (total_bytes, file_count) = dir_stats(&dir);
        // 网页缓存只统计「纯缓存」子目录（与 clear_web_cache 的清理范围一致），
        // Local Storage / Cookies 等用户数据既不统计也不清理
        let mut web_bytes = 0u64;
        let mut web_count = 0u64;
        if let Ok(base) = webview_profile_dir(&app) {
            for rel in crate::cache::WEBVIEW_CACHE_DIRS {
                let (b, c) = dir_stats(&base.join(rel));
                web_bytes += b;
                web_count += c;
            }
        }
        Ok(AudioCacheStats {
            total_bytes,
            file_count,
            web_bytes,
            web_count,
        })
    })
    .await
    .map_err(|e| format!("统计缓存失败: {e}"))?
}

/// 清理播放缓存。正在播放的那条流对应的文件会被跳过（Windows 上删被占用
/// 的文件必然失败），其余逐个删除；删除失败的文件计入 failedCount。
#[tauri::command(rename = "clear_audio_cache")]
pub async fn cmd_clear_audio_cache(
    state: State<'_, AppState>,
) -> Result<AudioCacheClearResult, String> {
    let dir = state.audio_cache_dir.clone();
    // 引擎侧拿「正在使用」的缓存文件（正在播放的在线流）
    let engine = state.engine.clone();
    let busy = tauri::async_runtime::spawn_blocking(move || engine.current_cache_file())
        .await
        .unwrap_or(None);
    tauri::async_runtime::spawn_blocking(move || {
        let (freed, failed) = crate::cache::clear_dir_files(&dir, busy.as_deref());
        Ok(AudioCacheClearResult {
            freed_bytes: freed,
            failed_count: failed,
        })
    })
    .await
    .map_err(|e| format!("清理缓存失败: {e}"))?
}

/// 清理网页缓存（WebView2 的封面 / 脚本 / HTTP 资源缓存）。
///
/// 只删 crate::cache::WEBVIEW_CACHE_DIRS 里的文件：这些目录 Chromium 会
/// 按需重建，删掉的都是可再生内容；Local Storage / Cookies / IndexedDB
/// 存着界面设置与登录态，绝不能碰 —— 所以不走 WebView2 的
/// ClearBrowsingDataAll（那会把用户数据一起清掉）。
/// 正在运行时个别文件被占用删不掉，计入 failedCount。
#[tauri::command(rename = "clear_web_cache")]
pub async fn cmd_clear_web_cache(app: tauri::AppHandle) -> Result<AudioCacheClearResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = webview_profile_dir(&app)?;
        let mut freed = 0u64;
        let mut failed = 0u64;
        for rel in crate::cache::WEBVIEW_CACHE_DIRS {
            let (f, fl) = crate::cache::clear_dir_files(&base.join(rel), None);
            freed += f;
            failed += fl;
        }
        Ok(AudioCacheClearResult {
            freed_bytes: freed,
            failed_count: failed,
        })
    })
    .await
    .map_err(|e| format!("清理网页缓存失败: {e}"))?
}

/// 设置播放缓存体积上限（MB，0 = 不限）。引擎侧落 settings 并立即修剪；
/// 之后每挂载一条新流都会自动检查（LRU 清最旧，跳过在播文件）。
#[tauri::command(rename = "set_audio_cache_limit")]
pub async fn cmd_set_audio_cache_limit(state: State<'_, AppState>, mb: u64) -> Result<(), String> {
    state.engine.send(AudioCmd::SetCacheLimit(mb));
    Ok(())
}

// ---------- 开机自启（tauri-plugin-autostart，Windows 走注册表 Run 键） ----------

#[tauri::command(rename = "autostart_state")]
pub async fn cmd_autostart_state(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command(rename = "set_autostart")]
pub async fn cmd_set_autostart(app: tauri::AppHandle, enable: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let launcher = app.autolaunch();
    if enable {
        launcher.enable().map_err(|e| e.to_string())
    } else {
        launcher.disable().map_err(|e| e.to_string())
    }
}

// ---------- 音频输出设备（蓝牙耳机 / HDMI 插拔时无缝切换） ----------

/// 枚举系统输出设备（设置页下拉用）。
#[tauri::command(rename = "list_output_devices")]
pub async fn cmd_list_output_devices() -> Result<Vec<String>, String> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    let mut names: Vec<String> = host
        .output_devices()
        .map_err(|e| e.to_string())?
        .filter_map(|d| d.description().ok().map(|desc| desc.name().to_string()))
        .collect();
    names.sort();
    names.dedup();
    Ok(names)
}

/// 切换输出设备。`name` 不传/空 = 跟随系统默认（插拔蓝牙自动跟随）；
/// 传入具体设备名 = 固定到该设备。切换时当前曲目从原进度无缝续播。
#[tauri::command(rename = "set_output_device")]
pub async fn cmd_set_output_device(
    state: State<'_, AppState>,
    name: Option<String>,
) -> Result<(), String> {
    state.engine.send(AudioCmd::SetOutputDevice { name });
    Ok(())
}

// ---------- 全局快捷键（DESIGN §14.2：可改键 / 可禁用） ----------

/// 当前生效的快捷键表（默认值 + 用户自定义 + 启用状态）。
#[tauri::command(rename = "list_shortcuts")]
pub async fn cmd_list_shortcuts(
    state: State<'_, AppState>,
) -> Result<Vec<crate::shortcuts::ShortcutEntry>, String> {
    let db = state.db.clone();
    let entries = tauri::async_runtime::spawn_blocking(move || {
        let entries: Vec<crate::shortcuts::ShortcutEntry> =
            crate::shortcuts::load_shortcuts(db.as_deref())
                .into_iter()
                .map(
                    |(action, accelerator, enabled)| crate::shortcuts::ShortcutEntry {
                        id: action.id().to_string(),
                        accelerator,
                        enabled,
                    },
                )
                .collect();
        entries
    })
    .await
    .map_err(|e| format!("读取快捷键失败: {e}"))?;
    Ok(entries)
}

/// 保存快捷键配置（整份快照）并热重载：先注销旧的，再按新表注册。
#[tauri::command(rename = "save_shortcuts")]
pub async fn cmd_save_shortcuts(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    config: serde_json::Value,
) -> Result<Vec<crate::shortcuts::ShortcutEntry>, String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let db = state.db.clone();
    let keymap = tauri::async_runtime::spawn_blocking(move || {
        let Some(db) = db else {
            return Err("数据库不可用".to_string());
        };
        crate::shortcuts::save_shortcuts(&db, &config)
    })
    .await
    .map_err(|e| format!("保存快捷键失败: {e}"))??;

    // 热重载：全量注销后按新表注册（注册失败的项只记日志）
    let gs = app.global_shortcut();
    if let Err(e) = gs.unregister_all() {
        log::warn!("[shortcuts] 重载时注销旧快捷键失败: {e}");
    }
    crate::shortcuts::register_shortcuts(&app, &keymap);

    Ok(keymap
        .into_iter()
        .map(
            |(action, accelerator, enabled)| crate::shortcuts::ShortcutEntry {
                id: action.id().to_string(),
                accelerator,
                enabled,
            },
        )
        .collect())
}

// ---------- 外观偏好（DESIGN §9.2 AppearancePreference，存 settings 表） ----------

/// 读外观偏好；未设置过返回默认值（跟随系统 + 默认皮肤）。
#[tauri::command(rename = "get_appearance")]
pub async fn cmd_get_appearance(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let Some(db) = &state.db else {
        return Ok(default_appearance());
    };
    let saved = db.with(|c| crate::db::store::get_setting(c, "appearance"))?;
    match saved {
        Some(json) => serde_json::from_str(&json).map_err(|e| format!("外观偏好解析失败: {e}")),
        None => Ok(default_appearance()),
    }
}

/// 写外观偏好（整体覆盖，与 §9.2 的单对象结构一致）。
#[tauri::command(rename = "set_appearance")]
pub async fn cmd_set_appearance(
    state: State<'_, AppState>,
    appearance: serde_json::Value,
) -> Result<(), String> {
    let json =
        serde_json::to_string(&appearance).map_err(|e| format!("外观偏好序列化失败: {e}"))?;
    let Some(db) = &state.db else {
        return Ok(()); // 数据库不可用时只保持本次会话内存值
    };
    db.with(|c| crate::db::store::set_setting(c, "appearance", &json))
}

fn default_appearance() -> serde_json::Value {
    serde_json::json!({
        "mode": "system",
        "skinId": "default",
        "followCoverColor": false,
        "reduceMotion": false,
        "fontScale": 1.0,
    })
}

// ---------- Astral：更新 / 消息 / 统计 / 反馈（DESIGN §15） ----------
// 平台参数固定：type=1103、channel=pc、ut=app-windows；
// 每个请求的 X-App-Ut / X-App-Version / X-Device / X-OS 由 astral.rs::client_headers() 统一注入

#[tauri::command(rename = "astral_app_update")]
pub async fn cmd_astral_app_update(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    state.astral.app_update(crate::astral::version_code()).await
}

#[tauri::command(rename = "astral_check_official_version")]
pub async fn cmd_astral_check_official_version(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    state
        .astral
        .check_official_version(crate::astral::version_code(), crate::astral::version_name())
        .await
}

#[tauri::command(rename = "astral_github_accels")]
pub async fn cmd_astral_github_accels(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    state.astral.github_accels().await
}

/// 组装更新下载地址：GitHub 直链时自动探测加速节点选最快的拼接。
#[tauri::command(rename = "resolve_update_url")]
pub async fn cmd_resolve_update_url(
    state: State<'_, AppState>,
    download_url: String,
) -> Result<serde_json::Value, String> {
    let update = serde_json::json!({ "downloadUrl": download_url });
    Ok(state.astral.resolve_download_url(&update).await)
}

/// 下载更新包：流式写入 + `update-download-progress` 进度事件 + MD5/大小校验。
/// 完成返回落盘路径；启动安装器走 `run_update_installer`。
/// 加速节点中途劣化（探测时可用、下载时挂）时自动降级原始直链重试一次，
/// 不让更新卡死在垃圾节点上。
#[tauri::command(rename = "download_update_file")]
pub async fn cmd_download_update_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    url: String,
    md5: Option<String>,
    file_size: Option<i64>,
) -> Result<String, String> {
    let http_client = state.astral.http();
    // 安装包会被本机执行，所以先审"从哪下"：协议、是否公网、明文链路是否可以接受
    //（后端给了 MD5 或目标是自有 CDN 才允许明文 —— 见 net_guard 的规则说明）
    let has_hash = md5.as_deref().is_some_and(|s| !s.trim().is_empty());
    let checked = crate::net_guard::ensure_installer_url(&url, has_hash)?;
    let result =
        crate::astral::AstralClient::download_update_file(&http_client, checked.as_str(), &app)
            .await;
    let (path, final_url) = match result {
        Ok(p) => (p, checked),
        Err(first_err) => {
            // 加速链接失败且原始 GitHub 链接和它不同 → 降级直链重试
            //（拼前缀的链接失败几乎都是加速节点劣化；直链本身失败时重试同样没坏处）
            let original_raw = crate::astral::AstralClient::strip_accel_prefix(&url);
            if original_raw != url {
                let original = crate::net_guard::ensure_installer_url(&original_raw, has_hash)?;
                log::warn!("[update] 加速下载失败（{first_err}），降级原始直链重试");
                let p = crate::astral::AstralClient::download_update_file(
                    &http_client,
                    original.as_str(),
                    &app,
                )
                .await
                .map_err(|e| format!("加速链接与原始直链均失败：{e} / {first_err}"))?;
                (p, original)
            } else {
                return Err(first_err);
            }
        }
    };
    crate::astral::AstralClient::verify_update_file(&path, md5.as_deref(), file_size)?;
    // ed25519 签名校验：MD5 只能防传输损坏，防不了分发链路被掉包。签名文件与
    // 安装包同址（URL + ".sig"）；缺 .sig / 验签失败都拒绝安装（否则攻击者
    // 换掉安装包再删掉 .sig 就绕过了）。
    let sig_url = format!("{}.sig", final_url);
    let sig = match crate::astral::AstralClient::fetch_update_signature(&http_client, &sig_url)
        .await
    {
        Ok(s) => s,
        Err(e) => {
            // .sig 与安装包同源：加速域名对签名文件不可达时降级原始直链再试一次
            let original_raw = crate::astral::AstralClient::strip_accel_prefix(final_url.as_str());
            if original_raw != final_url.as_str() {
                crate::astral::AstralClient::fetch_update_signature(
                    &http_client,
                    &format!("{}.sig", original_raw),
                )
                .await
                .map_err(|e2| format!("签名校验不可用：{e} / {e2}"))?
            } else {
                return Err(format!("签名校验不可用：{e}"));
            }
        }
    };
    crate::astral::AstralClient::verify_installer_signature(&path, &sig)?;
    crate::astral::mark_installer_signature_verified();
    log::info!("[update] 安装包 ed25519 签名校验通过");
    Ok(path.to_string_lossy().to_string())
}

/// 运行已下载的更新安装器，并随后退出本应用（让安装器接管覆盖安装）。
///
/// 关键点：
/// - 传 `/UPDATE`：Tauri 的 NSIS 安装器识别到该参数后跳过「维护页」，
///   不再默认走「先卸载再安装」，而是就地覆盖（安装目录由安装器自己从注册表恢复）。
///   不加这个参数时，升级会停在“建议先卸载当前版本”的选项页。
/// - 启动后延时退出：安装器会检测 `quietmusic.exe` 是否在运行，运行中就弹
///   「Click OK to kill it」；同时运行中的 exe 会锁住自己要覆盖的文件。
///   延时是为了让前端先把「正在退出」渲染出来，再走正常退出流程（含托盘/清理）。
#[tauri::command(rename = "run_update_installer")]
pub async fn cmd_run_update_installer(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW：不闪控制台
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // 只执行"本次进程内通过了 ed25519 签名校验"的安装包：标记由
    // download_update_file 校验通过后置位，重启归零（重新下载才可能再置位）
    if !crate::astral::installer_signature_verified() {
        return Err("安装包未通过签名校验，请重新走应用内更新流程下载".to_string());
    }
    // 只允许执行"我们自己刚下载到固定路径"的那个安装包。
    // path 虽然来自前端的 download_update_file 返回值，但命令入口不能假设调用方诚实：
    // 命令一旦能执行任意路径 + 传参，就等于把"启动本机任意程序"开放出去
    //（这也是 ipc_guard 里必须把本命令挡在音源引擎窗口之外的原因）。
    let expected = crate::astral::update_installer_path();
    let got = std::fs::canonicalize(&path).map_err(|e| format!("安装包路径无效（{path}）：{e}"))?;
    let want = std::fs::canonicalize(&expected)
        .map_err(|e| format!("更新临时目录里没有安装包（{}）：{e}", expected.display()))?;
    if got != want {
        return Err(format!("拒绝执行非更新安装包：{}", got.display()));
    }
    // 直接 spawn 安装器。不能走 `cmd /C start`：实测 start 会把 `/UPDATE`
    // 当成自己的路径参数吞掉（转成 `E:/Git/UPDATE`），安装器收不到就
    // 走全新安装流程（「先卸载再安装」维护页）。
    std::process::Command::new(&got)
        .arg("/UPDATE")
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("启动安装器失败: {e}"))?;

    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(900));
        app.exit(0);
    });
    Ok(())
}

/// 用系统默认浏览器打开链接（更新页 browserUrl 兜底）。
///
/// 原来走 `cmd /C start "" <url>`：URL 是被**拼进命令行**的，`&`、`^`、引号都能
/// 变成第二条命令（命令注入）。改用 `ShellExecuteW` 直接调 ShellExecute，
/// 不经过任何 shell；同时把协议收敛到 http/https（挡掉 `file:` / 自定义协议）。
#[tauri::command(rename = "run_update_browser")]
pub async fn cmd_run_update_browser(url: String) -> Result<(), String> {
    let target = crate::net_guard::ensure_http_url(&url)?;
    #[cfg(target_os = "windows")]
    {
        use windows::core::{HSTRING, PCWSTR};
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let op = HSTRING::from("open");
        let file = HSTRING::from(target.as_str());
        // SAFETY: 两个 PCWSTR 都在本调用期间有效（HSTRING 是自有缓冲），
        // ShellExecuteW 只在调用内读取它们，不保留引用。
        let ret = unsafe {
            ShellExecuteW(
                None,
                &op,
                &file,
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        // 该 API 的约定：返回值 <= 32 表示失败（32 以后的整数才是成功句柄）
        if ret.0 as isize <= 32 {
            return Err(format!(
                "打开浏览器失败（ShellExecuteW 返回 {}）",
                ret.0 as isize
            ));
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = target;
        Err("当前平台未实现「用默认浏览器打开链接」".to_string())
    }
}

#[tauri::command(rename = "astral_active_messages")]
pub async fn cmd_astral_active_messages(
    state: State<'_, AppState>,
    version_code: Option<i64>,
) -> Result<serde_json::Value, String> {
    let code = version_code.unwrap_or_else(crate::astral::version_code);
    state.astral.active_messages(code).await
}

#[tauri::command(rename = "astral_message_center")]
pub async fn cmd_astral_message_center(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    state.astral.message_center().await
}

#[tauri::command(rename = "astral_unread_count")]
pub async fn cmd_astral_unread_count(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    state.astral.unread_count().await
}

#[tauri::command(rename = "astral_ack_messages")]
pub async fn cmd_astral_ack_messages(
    state: State<'_, AppState>,
    ids: Vec<i64>,
) -> Result<serde_json::Value, String> {
    state.astral.ack_messages(&ids).await
}

/// 匿名批量统计上报；失败时前端/调用方负责进入本地队列重试（§15.4）
#[tauri::command(rename = "astral_report_stats")]
pub async fn cmd_astral_report_stats(
    state: State<'_, AppState>,
    events: Vec<serde_json::Value>,
) -> Result<(), String> {
    state.astral.report_stats(events).await
}

#[tauri::command(rename = "astral_submit_feedback")]
pub async fn cmd_astral_submit_feedback(
    state: State<'_, AppState>,
    kind: String,
    title: String,
    content: String,
    contact: String,
) -> Result<serde_json::Value, String> {
    state
        .astral
        .submit_feedback(&kind, &title, &content, &contact)
        .await
}

#[tauri::command(rename = "astral_my_feedback")]
pub async fn cmd_astral_my_feedback(
    state: State<'_, AppState>,
    page_num: i64,
    page_size: i64,
) -> Result<serde_json::Value, String> {
    state.astral.my_feedback(page_num, page_size).await
}

#[tauri::command(rename = "astral_public_feedback")]
pub async fn cmd_astral_public_feedback(
    state: State<'_, AppState>,
    page_num: i64,
    page_size: i64,
) -> Result<serde_json::Value, String> {
    state.astral.public_feedback(page_num, page_size).await
}

#[tauri::command(rename = "astral_feedback_detail")]
pub async fn cmd_astral_feedback_detail(
    state: State<'_, AppState>,
    id: i64,
) -> Result<serde_json::Value, String> {
    state.astral.feedback_detail(id).await
}

#[tauri::command(rename = "astral_feedback_replies")]
pub async fn cmd_astral_feedback_replies(
    state: State<'_, AppState>,
    id: i64,
) -> Result<serde_json::Value, String> {
    state.astral.feedback_replies(id).await
}

#[tauri::command(rename = "astral_reply_feedback")]
pub async fn cmd_astral_reply_feedback(
    state: State<'_, AppState>,
    feedback_id: i64,
    content: String,
) -> Result<serde_json::Value, String> {
    state.astral.reply_feedback(feedback_id, &content).await
}

/// 当前版本（§15.7 单一真值：Cargo 包版本派生，前端不手写）
#[tauri::command(rename = "get_app_version")]
pub async fn cmd_get_app_version() -> std::collections::HashMap<String, serde_json::Value> {
    let mut map = std::collections::HashMap::new();
    map.insert(
        "versionName".to_string(),
        serde_json::json!(crate::astral::version_name()),
    );
    map.insert(
        "versionCode".to_string(),
        serde_json::json!(crate::astral::version_code()),
    );
    map
}

// ---------- 桌面歌词窗口（DESIGN §4.2 / §10 / §11.7） ----------

#[tauri::command(rename = "show_desktop_lyric")]
pub async fn cmd_show_desktop_lyric(
    app: tauri::AppHandle,
) -> Result<crate::lyric_window::LyricWindowState, String> {
    crate::lyric_window::show(&app)
}

#[tauri::command(rename = "hide_desktop_lyric")]
pub async fn cmd_hide_desktop_lyric(
    app: tauri::AppHandle,
) -> Result<crate::lyric_window::LyricWindowState, String> {
    crate::lyric_window::hide(&app)
}

#[tauri::command(rename = "get_desktop_lyric_state")]
pub async fn cmd_get_desktop_lyric_state(
    app: tauri::AppHandle,
) -> Result<crate::lyric_window::LyricWindowState, String> {
    Ok(crate::lyric_window::get_state(&app))
}

#[tauri::command(rename = "set_desktop_lyric_locked")]
pub async fn cmd_set_desktop_lyric_locked(
    app: tauri::AppHandle,
    locked: bool,
) -> Result<crate::lyric_window::LyricWindowState, String> {
    crate::lyric_window::set_locked(&app, locked)
}

#[tauri::command(rename = "set_desktop_lyric_style")]
pub async fn cmd_set_desktop_lyric_style(
    app: tauri::AppHandle,
    patch: serde_json::Value,
) -> Result<crate::lyric_window::LyricWindowState, String> {
    crate::lyric_window::set_style(&app, patch)
}

#[tauri::command(rename = "set_desktop_lyric_bounds")]
pub async fn cmd_set_desktop_lyric_bounds(
    app: tauri::AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<crate::lyric_window::LyricWindowState, String> {
    crate::lyric_window::set_bounds(&app, x, y, width, height)
}

#[tauri::command(rename = "reset_desktop_lyric")]
pub async fn cmd_reset_desktop_lyric(
    app: tauri::AppHandle,
) -> Result<crate::lyric_window::LyricWindowState, String> {
    crate::lyric_window::reset(&app)
}

/// 歌词工具条「打开歌词设置」：唤起主窗口并跳到桌面歌词设置页
#[tauri::command(rename = "open_lyric_settings")]
pub async fn cmd_open_lyric_settings(app: tauri::AppHandle) -> Result<(), String> {
    crate::lyric_window::open_main_settings(&app);
    Ok(())
}

// ---------- 本地音乐库（DESIGN §13） ----------
//
// 约定：本地曲目 `Track.id` = 音频文件绝对路径，`platform = SourceId::Local`。
// 数据库不可用（state.db == None）时一律返回空结果，不 panic。

/// 扫描目录 → 读元数据 → 入库，返回库内全部本地曲目（DESIGN §13.1 / §13.2）。
/// 实际的文件遍历与元数据读取放进 `spawn_blocking`，避免阻塞 UI 线程。
#[tauri::command(rename = "scan_library")]
pub async fn cmd_scan_library(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    dirs: Vec<String>,
    // 时长下限（秒）：> 0 时忽略时长不足的音频（0 = 不过滤）。缺省 0，
    // 实际默认值由前端「扫描配置」给出（默认 60）。
    min_duration_secs: Option<u64>,
    // 体积下限（字节）：> 0 时忽略小于该值的文件（0 = 不过滤）。
    // 同样由前端「扫描配置」给出（默认 1 MiB）。
    min_size_bytes: Option<u64>,
) -> Result<Vec<Track>, String> {
    let filter = crate::local::ScanFilter {
        min_duration_secs: min_duration_secs.unwrap_or(0),
        min_size_bytes: min_size_bytes.unwrap_or(0),
    };
    // §13 安全：路径来自前端输入，先校验存在性
    for dir in &dirs {
        if !std::path::Path::new(dir).exists() {
            return Err(format!("目录不存在: {dir}"));
        }
    }
    let Some(db) = state.db.clone() else {
        log::warn!("[local] 数据库不可用，跳过本次扫描");
        return Ok(Vec::new());
    };
    // 命中的目录同时登记进 scan_dirs（幂等），保证清单与曲库一致
    let result = tauri::async_runtime::spawn_blocking(move || {
        // 整盘扫描可能上万文件，进度按 200ms 节流广播，避免刷爆前端
        let mut last_emit: Option<std::time::Instant> = None;
        let rows =
            crate::local::scan_dirs_with_progress(&dirs, filter, |visited, found, current| {
                let due = last_emit.map_or(true, |t| {
                    t.elapsed() >= std::time::Duration::from_millis(200)
                });
                if due {
                    last_emit = Some(std::time::Instant::now());
                    let _ = app.emit(
                        crate::local::EVENT_LIBRARY_SCAN_PROGRESS,
                        serde_json::json!({
                            "visited": visited,
                            "found": found,
                            "current": current.to_string_lossy(),
                        }),
                    );
                }
            });
        let present: std::collections::HashSet<String> =
            rows.iter().map(|r| r.path.clone()).collect();
        db.with(|conn| {
            crate::db::store::touch_scan_dirs(conn, &dirs)?;
            crate::db::store::upsert_local_tracks(conn, &rows)?;
            let missing = crate::db::store::mark_missing_local_tracks(conn, &dirs, &present)?;
            if missing > 0 {
                log::info!("[local] 标记缺失曲目 {missing} 条");
            }
            crate::db::store::query_local_tracks(conn)
        })
    })
    .await
    .map_err(|e| format!("扫描任务失败: {e}"))?;
    result
}

/// 可扫描的盘符根目录（如 `C:\`、`D:\`），供本地曲库「扫描整个磁盘」用。
#[tauri::command(rename = "list_drives")]
pub async fn cmd_list_drives() -> Result<Vec<String>, String> {
    Ok(crate::local::list_drives())
}

/// 读库内已有本地曲目（不扫磁盘）。
#[tauri::command(rename = "get_local_tracks")]
pub async fn cmd_get_local_tracks(state: State<'_, AppState>) -> Result<Vec<Track>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || db.with(crate::db::store::query_local_tracks))
        .await
        .map_err(|e| format!("读取本地曲目失败: {e}"))?
}

/// 读本地曲目的文件大小 / 修改时间（供按大小、修改时间排序）。
#[tauri::command(rename = "get_local_track_files")]
pub async fn cmd_get_local_track_files(
    state: State<'_, AppState>,
) -> Result<Vec<crate::db::store::LocalTrackFileMeta>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || db.with(crate::db::store::query_local_track_files))
        .await
        .map_err(|e| format!("读取本地曲目文件属性失败: {e}"))?
}

/// 读缺失的本地曲目（扫描后文件已不在的记录），供本地曲库「体检」用。
#[tauri::command(rename = "get_missing_local_tracks")]
pub async fn cmd_get_missing_local_tracks(
    state: State<'_, AppState>,
) -> Result<Vec<Track>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(crate::db::store::query_missing_local_tracks)
    })
    .await
    .map_err(|e| format!("读取缺失曲目失败: {e}"))?
}

/// 清理所有缺失的本地记录（连带级联删除关联行），返回删除条数。
#[tauri::command(rename = "purge_missing_local_tracks")]
pub async fn cmd_purge_missing_local_tracks(state: State<'_, AppState>) -> Result<usize, String> {
    let Some(db) = state.db.clone() else {
        return Ok(0);
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(crate::db::store::purge_missing_local_tracks)
    })
    .await
    .map_err(|e| format!("清理缺失曲目失败: {e}"))?
}

/// 读本地音频的内嵌封面，返回 data URL（没有封面返回 None）。
#[tauri::command(rename = "get_local_cover")]
pub async fn cmd_get_local_cover(path: String) -> Result<Option<String>, String> {
    use base64::Engine as _;
    tauri::async_runtime::spawn_blocking(move || {
        crate::local::read_cover(std::path::Path::new(&path)).map(|(mime, bytes)| {
            format!(
                "data:{mime};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )
        })
    })
    .await
    .map_err(|e| format!("读取封面失败: {e}"))
}

/// 扫描目录清单（scan_dirs 表）。
#[tauri::command(rename = "get_scan_dirs")]
pub async fn cmd_get_scan_dirs(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || db.with(crate::db::store::list_scan_dirs))
        .await
        .map_err(|e| format!("读取扫描目录失败: {e}"))?
}

/// 添加扫描目录（已存在则幂等刷新 last_scan_at）。
#[tauri::command(rename = "add_scan_dir")]
pub async fn cmd_add_scan_dir(state: State<'_, AppState>, path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Err(format!("目录不存在: {path}"));
    }
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::add_scan_dir(conn, &path))
    })
    .await
    .map_err(|e| format!("添加扫描目录失败: {e}"))?
}

/// 移除扫描目录（只删清单条目，不动已入库曲目）。
#[tauri::command(rename = "remove_scan_dir")]
pub async fn cmd_remove_scan_dir(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::remove_scan_dir(conn, &path))
    })
    .await
    .map_err(|e| format!("移除扫描目录失败: {e}"))?
}

/// 在资源管理器中定位本地曲目文件（本地 Track.id 即文件绝对路径）。
#[tauri::command(rename = "reveal_local_track")]
pub async fn cmd_reveal_local_track(path: String) -> Result<(), String> {
    reveal_in_file_manager(&path)
}

/// 删除本地曲目。`delete_file = true` 时先删磁盘文件，再删库内记录
/// （记录删除会级联清掉歌单归属 / 收藏 / 历史等关联行）；
/// `delete_file = false` 只删记录，文件留在磁盘上。
/// 文件删不掉（占用 / 权限）时报错并保留记录，用户可稍后重试。
#[tauri::command(rename = "delete_local_track")]
pub async fn cmd_delete_local_track(
    state: State<'_, AppState>,
    path: String,
    delete_file: bool,
) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("曲目路径为空".to_string());
    }
    let Some(db) = state.db.clone() else {
        // 库不可用：只删文件的请求仍然照做，避免留下清理不掉的孤儿文件
        return if delete_file {
            remove_local_file(&path).map(|_| ())
        } else {
            Ok(())
        };
    };
    tauri::async_runtime::spawn_blocking(move || {
        if delete_file {
            remove_local_file(&path)?;
        }
        db.with(|conn| crate::db::store::delete_local_track(conn, &path))?;
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| format!("删除本地曲目失败: {e}"))?
}

/// 批量删除本地曲目（多选后用）。语义同 `cmd_delete_local_track`：
/// `delete_file = true` 时先把磁盘文件都删掉，再在一个事务里删记录。
/// 返回删除的记录条数。中途有文件删不掉会直接报错，已处理的部分不回滚，
/// 用户看到错误后可重试剩余项。
#[tauri::command(rename = "delete_local_tracks")]
pub async fn cmd_delete_local_tracks(
    state: State<'_, AppState>,
    paths: Vec<String>,
    delete_file: bool,
) -> Result<usize, String> {
    let paths: Vec<String> = paths.into_iter().filter(|p| !p.trim().is_empty()).collect();
    if paths.is_empty() {
        return Ok(0);
    }
    let Some(db) = state.db.clone() else {
        return if delete_file {
            Ok(paths
                .iter()
                .filter(|p| remove_local_file(p).unwrap_or(false))
                .count())
        } else {
            Ok(0)
        };
    };
    tauri::async_runtime::spawn_blocking(move || {
        if delete_file {
            for p in &paths {
                remove_local_file(p)?;
            }
        }
        db.with(|conn| crate::db::store::delete_local_tracks(conn, &paths))
    })
    .await
    .map_err(|e| format!("批量删除本地曲目失败: {e}"))?
}

// ---------- 收藏 / 播放历史（DESIGN §5.3） ----------
// 播放历史由引擎在播放开始时自动写入（见 audio/engine.rs 的 spawn_resolve_and_load），
// 这里只提供读取与清空；收藏的写入走 add_favorite。

/// 收藏一首歌（幂等，重复收藏不报错）。
///
/// `pid` 指定归属歌单（歌单的永久全局唯一标识，创建后不变），**必传**：
/// 无默认歌单（v5 起无归属不加载），没传 pid 直接报参数错误。
/// 推送云端并上送 pid，云端 (uid, sid, platform) 唯一、pid 随之更新。
#[tauri::command(rename = "add_favorite")]
pub async fn cmd_add_favorite(
    state: State<'_, AppState>,
    track: Track,
    pid: Option<String>,
) -> Result<(), String> {
    let Some(pid) = pid.filter(|p| !p.is_empty()) else {
        return Err("收藏必须指定歌单（pid）".into());
    };
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    // 闭包要 move 走一份，推送还得用原值
    let for_db = track.clone();
    let target = pid.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| {
            crate::db::store::add_tracks_to_playlist(conn, &target, std::slice::from_ref(&for_db))
        })
    })
    .await
    .map_err(|e| format!("收藏失败: {e}"))?;
    result.map_err(|e| format!("收藏失败: {e}"))?;
    push_like_song(&state, &track, "add", Some(&pid)).await;
    Ok(())
}

/// 取消收藏，语义与 `add_favorite` 对称。云端 remove 不涉及 pid。
///
/// 多归属下的云端策略：摘的是主归属且还有其他归属 → push add(新主归属)，
/// 云端跟着切；摘光/整首取消 → push remove；只摘非主归属 → 云端无感。
#[tauri::command(rename = "remove_favorite")]
pub async fn cmd_remove_favorite(
    state: State<'_, AppState>,
    track: Track,
    pid: Option<String>,
) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    let for_db = track.clone();
    let target = pid.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::remove_liked_song(conn, &for_db, target.as_deref()))
    })
    .await
    .map_err(|e| format!("取消收藏失败: {e}"))?
    .map_err(|e| format!("取消收藏失败: {e}"))?;
    match outcome {
        crate::db::store::LikeRemoveOutcome::RemovedAll => {
            push_like_song(&state, &track, "remove", None).await;
        }
        crate::db::store::LikeRemoveOutcome::Rebound(next) => {
            push_like_song(&state, &track, "add", Some(&next)).await;
        }
        crate::db::store::LikeRemoveOutcome::DetachedOnly => {}
    }
    Ok(())
}

/// 这首歌挂在哪些歌单下（pid 列表），收藏选择器据此打勾。
#[tauri::command(rename = "list_track_playlists")]
pub async fn cmd_list_track_playlists(
    state: State<'_, AppState>,
    track: Track,
) -> Result<Vec<String>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::list_track_playlists(conn, &track))
    })
    .await
    .map_err(|e| format!("读取收藏归属失败: {e}"))?
}

/// 本地收藏写库成功后推一份到云端。
/// 未登录**静默跳过**；推送失败（断网 / 后端不可达）入 pending_like_ops
/// 离线队列，启动和网络恢复时 flush_pending_like_ops 按序重放（LIKE_SYNC_DESIGN.md §3）。
/// 本地仍是权威：同步失败不影响收藏本身。
///
/// `pid` = 歌曲在本地归属的歌单 id，add 时上送云端落库（后端 like/song 新增可选字段）。
async fn push_like_song(
    state: &State<'_, AppState>,
    track: &Track,
    action: &str,
    pid: Option<&str>,
) {
    if !state.astral.has_token() {
        return;
    }
    let platform = track.platform.to_string();
    let payload = crate::astral::LikeSongPayload {
        action,
        sid: &track.id,
        platform: &platform,
        name: &track.title,
        singer: &track.singer,
        album: &track.album,
        hash: track.music_id.as_deref(),
        pid,
        // 收藏时带上封面 URL 快照（LIKE_SONG_PIC_SYNC_DESIGN §8.3）；
        // 为空时 like_song 不会上送，服务端保留已有图片
        pic_url: Some(track.pic_url.as_str()),
    };
    // 请求体先序列化好再上送：失败时离线队列存的就是它（与上送内容一字不差）
    let queued_body = crate::astral::like_song_body_for_queue(&payload);
    if let Err(e) = state.astral.like_song(payload).await {
        // 失败入队：同目标键只留最新操作，断网重放后即最终状态
        enqueue_like_op_on_error(state, "song", action, &platform, &track.id, move || {
            queued_body
        });
        log::warn!("[like] 推送收藏({action})失败，已入离线队列: {e}");
    }
}

/// 批量推送的单批上限（与后端 /like/batch 的 200 对齐）
const LIKE_BATCH_LIMIT: usize = 200;

/// 批量推送歌曲收藏操作（分批走 /like/batch，每批 ≤ LIKE_BATCH_LIMIT）。
/// items 为 (track, action, 归属 pid)；某批失败 → 整批入离线队列
/// （同目标键只留最新，断网重放后即最终状态），与单曲推送失败同款兜底。
/// 本地仍是权威：同步失败不影响收藏本身。
async fn push_like_songs_batch(
    state: &State<'_, AppState>,
    items: Vec<(Track, String, Option<String>)>,
) {
    if items.is_empty() || !state.astral.has_token() {
        return;
    }
    for chunk in items.chunks(LIKE_BATCH_LIMIT) {
        // 一次构建批内 op 与失败兜底要入队的单条请求体（同源 payload，字段一字不差）
        let mut ops = Vec::with_capacity(chunk.len());
        let mut queued: Vec<(String, String, String, String)> = Vec::with_capacity(chunk.len());
        for (track, action, pid) in chunk {
            let platform = track.platform.to_string();
            let payload = crate::astral::LikeSongPayload {
                action: action.as_str(),
                sid: &track.id,
                platform: &platform,
                name: &track.title,
                singer: &track.singer,
                album: &track.album,
                hash: track.music_id.as_deref(),
                pid: pid.as_deref(),
                pic_url: Some(track.pic_url.as_str()),
            };
            ops.push(crate::astral::like_song_op_for_batch(&payload));
            queued.push((
                action.clone(),
                platform.clone(),
                track.id.clone(),
                crate::astral::like_song_body_for_queue(&payload),
            ));
        }
        if let Err(e) = state.astral.like_batch(ops).await {
            log::warn!(
                "[like] 批量推送收藏失败 {} 条，整批入离线队列: {e}",
                queued.len()
            );
            for (action, platform, sid, body) in queued {
                enqueue_like_op_on_error(state, "song", &action, &platform, &sid, move || body);
            }
        }
    }
}

/// 推送失败时的统一入队：写库失败本身只打日志（本地收藏不能被同步问题阻塞）。
fn enqueue_like_op_on_error(
    state: &State<'_, AppState>,
    kind: &str,
    action: &str,
    platform: &str,
    target_id: &str,
    build_payload: impl FnOnce() -> String,
) {
    let Some(db) = state.db.clone() else {
        return;
    };
    let target_key = format!("{kind}:{platform}:{target_id}");
    let payload_json = build_payload();
    let (k, a) = (kind.to_string(), action.to_string());
    if let Err(e) = db.with(move |conn| {
        crate::db::store::enqueue_pending_like_op(conn, &k, &a, &target_key, &payload_json)
    }) {
        log::warn!("[like] 离线队列入队失败: {e}");
    }
}

/// 收藏在线歌单（幂等）。只存元信息，曲目点开时再向音源取。
#[tauri::command(rename = "favorite_playlist")]
pub async fn cmd_favorite_playlist(
    state: State<'_, AppState>,
    platform: String,
    id: String,
    name: String,
    pic_url: Option<String>,
    play_count: Option<String>,
) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    let pic = pic_url.clone().unwrap_or_default();
    let count = play_count.unwrap_or_default();
    let (p, pid, title) = (platform.clone(), id.clone(), name.clone());
    let result = tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::add_liked_playlist(conn, &p, &pid, &title, &pic, &count))
    })
    .await
    .map_err(|e| format!("收藏歌单失败: {e}"))?;
    result.map_err(|e| format!("收藏歌单失败: {e}"))?;
    push_like_playlist(&state, &platform, &id, &name, pic_url.as_deref(), "add").await;
    Ok(())
}

/// 取消收藏歌单。
#[tauri::command(rename = "unfavorite_playlist")]
pub async fn cmd_unfavorite_playlist(
    state: State<'_, AppState>,
    platform: String,
    id: String,
    name: String,
    pic_url: Option<String>,
) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    let (p, pid) = (platform.clone(), id.clone());
    let result = tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::remove_liked_playlist(conn, &p, &pid))
    })
    .await
    .map_err(|e| format!("取消收藏歌单失败: {e}"))?;
    result.map_err(|e| format!("取消收藏歌单失败: {e}"))?;
    push_like_playlist(&state, &platform, &id, &name, pic_url.as_deref(), "remove").await;
    Ok(())
}

/// 收藏的在线歌单（按收藏时间倒序）
#[tauri::command(rename = "list_favorite_playlists")]
pub async fn cmd_list_favorite_playlists(
    state: State<'_, AppState>,
) -> Result<Vec<crate::db::store::LikedPlaylist>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || db.with(crate::db::store::list_liked_playlists))
        .await
        .map_err(|e| format!("读取收藏歌单失败: {e}"))?
}

#[tauri::command(rename = "is_playlist_favorited")]
pub async fn cmd_is_playlist_favorited(
    state: State<'_, AppState>,
    platform: String,
    id: String,
) -> Result<bool, String> {
    let Some(db) = state.db.clone() else {
        return Ok(false);
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::is_liked_playlist(conn, &platform, &id))
    })
    .await
    .map_err(|e| format!("读取收藏状态失败: {e}"))?
}

/// 与 push_like_song 同款：未登录或推送失败都静默，本地收藏不受影响。
/// 自建歌单（platform=local）add 成功后把服务器 seq 记为云端确认点
///（cloud_seq），对账据此识别「他端已删除」（机制 B，v8）。
async fn push_like_playlist(
    state: &State<'_, AppState>,
    platform: &str,
    pid: &str,
    name: &str,
    pic: Option<&str>,
    action: &str,
) {
    if !state.astral.has_token() {
        return;
    }
    match state
        .astral
        .like_playlist(action, pid, platform, name, pic)
        .await
    {
        Ok(seq) => {
            if action == "add" && platform == crate::db::store::LOCAL_PLATFORM {
                if let Some(db) = state.db.clone() {
                    let p = pid.to_string();
                    if let Err(e) = tauri::async_runtime::spawn_blocking(move || {
                        db.with(|conn| crate::db::store::mark_playlist_cloud_seq(conn, &p, seq))
                    })
                    .await
                    {
                        log::warn!("[like] 记录歌单云端确认点失败: {e}");
                    }
                }
            }
        }
        Err(e) => {
            // picUrl 空不上送（后端 COALESCE 保护云端已有封面），与 like_playlist 一致
            let mut body = serde_json::json!({
                "action": action,
                "pid": pid,
                "platform": platform,
                "name": name,
            });
            if let Some(p) = pic.filter(|s| !s.is_empty()) {
                body["picUrl"] = serde_json::json!(p);
            }
            let body_str = body.to_string();
            enqueue_like_op_on_error(state, "playlist", action, platform, pid, move || body_str);
            log::warn!("[like] 推送歌单收藏({action})失败，已入离线队列: {e}");
        }
    }
}

/// 收藏列表（按收藏时间倒序）。`pid` 为 Some 时只取该歌单的曲目。
#[tauri::command(rename = "list_favorites")]
pub async fn cmd_list_favorites(
    state: State<'_, AppState>,
    pid: Option<String>,
) -> Result<Vec<Track>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::list_liked_songs(conn, pid.as_deref()))
    })
    .await
    .map_err(|e| format!("读取收藏失败: {e}"))?
}

/// 单曲是否已收藏（播放页收藏按钮态）。
#[tauri::command(rename = "is_favorite")]
pub async fn cmd_is_favorite(state: State<'_, AppState>, track: Track) -> Result<bool, String> {
    let Some(db) = state.db.clone() else {
        return Ok(false);
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::is_liked_song(conn, &track))
    })
    .await
    .map_err(|e| format!("读取收藏状态失败: {e}"))?
}

/// 最近播放（去重、按时间倒序）。`limit = 0` 时取默认 100 条。
#[tauri::command(rename = "list_history")]
pub async fn cmd_list_history(
    state: State<'_, AppState>,
    limit: u32,
) -> Result<Vec<HistoryItem>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::list_play_history(conn, limit))
    })
    .await
    .map_err(|e| format!("读取播放历史失败: {e}"))?
}

/// 清空播放历史。
#[tauri::command(rename = "clear_history")]
pub async fn cmd_clear_history(state: State<'_, AppState>) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || db.with(crate::db::store::clear_play_history))
        .await
        .map_err(|e| format!("清空播放历史失败: {e}"))?
}

// ---------- 我的歌单（DESIGN §5.3） ----------
// 本地自建歌单（区别于音源侧的在线歌单），曲目通过 add_tracks_to_playlist 加入。
// 歌单对外一律用 pid（UUID，创建后永不变）：新建时生成并上送云端登记，
// 收藏歌曲 / 查询歌单 / 删除歌单都按 pid 走。

/// 新建歌单，返回歌单 pid（本地已落库；已登录时顺带登记到云端，失败静默）。
#[tauri::command(rename = "create_playlist")]
pub async fn cmd_create_playlist(
    state: State<'_, AppState>,
    name: String,
) -> Result<String, String> {
    let Some(db) = state.db.clone() else {
        return Err("数据库不可用".to_string());
    };
    let reg_name = name.clone();
    let pid = tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::create_playlist(conn, &reg_name))
    })
    .await
    .map_err(|e| format!("新建歌单失败: {e}"))??;
    // 登记：歌单元数据（名字）只有这里能上送，云端 qt_like_playlist 有
    // (uid, platform, pid) 唯一键，upsert 幂等；失败不阻塞本地建单
    push_like_playlist(&state, "local", &pid, &name, None, "add").await;
    Ok(pid)
}

#[tauri::command(rename = "rename_playlist")]
pub async fn cmd_rename_playlist(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    let (for_db, id) = (id.clone(), id);
    let value = name.clone();
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::rename_playlist(conn, &for_db, &value))
    })
    .await
    .map_err(|e| format!("重命名歌单失败: {e}"))?
    .map_err(|e| format!("重命名歌单失败: {e}"))?;
    // 歌单名是云端 qt_like_playlist 的元数据，改名要上送（后端按 pid upsert、
    // 非空覆盖）；不推的话其他端永远显示旧名 —— uniappx 没有改名功能，
    // 这是设计文档 §2 操作表里缺失的一行
    push_like_playlist(&state, "local", &id, &name, None, "add").await;
    Ok(())
}

/// 设置本地自建歌单封面：把选中的图片复制进应用数据目录
/// （playlist-covers/{pid}.{ext}，覆盖式；扩展名变化时清掉旧文件避免残留），
/// 再登记 playlists.cover_path，返回封面文件新路径。
/// 只对本地自建歌单生效；云端卡片 / 在线歌单没有本地封面字段，会拒绝。
#[tauri::command(rename = "set_playlist_cover")]
pub async fn cmd_set_playlist_cover(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    pid: String,
    file_path: String,
) -> Result<String, String> {
    // pid 直接拼文件名，先收紧字符集防路径穿越（本地 pid 本就是 [A-Za-z0-9_-]）
    if pid.is_empty()
        || pid.len() > 128
        || !pid
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("歌单标识非法".to_string());
    }
    // 只认 png/jpg/webp（与选择对话框的过滤一致）
    let ext = std::path::Path::new(&file_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let mime_ext = match ext.as_str() {
        "png" => "png",
        "jpg" | "jpeg" => "jpg",
        "webp" => "webp",
        other => {
            return Err(format!(
                "暂不支持的图片格式 .{other}，仅支持 png / jpg / webp"
            ))
        }
    };
    let covers_dir = crate::app_paths::data_root(&app).join("playlist-covers");
    let dest = covers_dir.join(format!("{pid}.{mime_ext}"));

    let (pid_copy, file_path_copy, dest_copy) = (pid.clone(), file_path.clone(), dest.clone());
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&covers_dir).map_err(|e| format!("创建封面目录失败: {e}"))?;
        // 新封面扩展名可能与旧的不同：同 pid 其他扩展名的旧文件一并清掉
        for old_ext in ["png", "jpg", "webp"] {
            let old = covers_dir.join(format!("{pid_copy}.{old_ext}"));
            if old != dest_copy {
                let _ = std::fs::remove_file(&old);
            }
        }
        std::fs::copy(&file_path_copy, &dest_copy).map_err(|e| format!("复制封面文件失败: {e}"))?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("复制封面失败: {e}"))??;

    let Some(db) = state.db.clone() else {
        return Err("数据库不可用".to_string());
    };
    let dest_str = dest.to_string_lossy().to_string();
    let updated = tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::set_playlist_cover_path(conn, &pid, &dest_str))
    })
    .await
    .map_err(|e| format!("登记封面失败: {e}"))?
    .map_err(|e| format!("登记封面失败: {e}"))?;
    if updated == 0 {
        // 不是本地自建歌单：清掉刚复制的文件，别留孤儿
        let _ = std::fs::remove_file(&dest);
        return Err("只有本地自建歌单可以更换封面".to_string());
    }
    Ok(dest.to_string_lossy().to_string())
}

/// 读本地歌单封面（playlists.cover_path 指向的图片），转 data URL 返回。
/// 未设置 / 不是本地自建歌单 / 文件已不在，都返回 null（前端回退默认图）。
#[tauri::command(rename = "get_playlist_cover")]
pub async fn cmd_get_playlist_cover(
    state: State<'_, AppState>,
    pid: String,
) -> Result<Option<String>, String> {
    use base64::Engine as _;
    let Some(db) = state.db.clone() else {
        return Ok(None);
    };
    let path = tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::playlist_cover_path(conn, &pid))
    })
    .await
    .map_err(|e| format!("读取封面失败: {e}"))?
    .map_err(|e| format!("读取封面失败: {e}"))?
    .filter(|p| !p.is_empty());
    let Some(path) = path else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&path).ok()?;
        let ext = std::path::Path::new(&path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        let mime = match ext.as_str() {
            "png" => "image/png",
            "webp" => "image/webp",
            _ => "image/jpeg",
        };
        Some(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    })
    .await
    .map_err(|e| format!("读取封面失败: {e}"))
}

/// 删除本地歌单（id 参数传歌单 pid）。已登录时上送云端 remove（失败静默）。
#[tauri::command(rename = "delete_playlist")]
pub async fn cmd_delete_playlist(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    let push_id = id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::delete_playlist(conn, &id))
    })
    .await
    .map_err(|e| format!("删除歌单失败: {e}"))?
    .map_err(|e| format!("删除歌单失败: {e}"))?;
    push_like_playlist(&state, "local", &push_id, "", None, "remove").await;
    Ok(())
}

#[tauri::command(rename = "list_my_playlists")]
pub async fn cmd_list_my_playlists(
    state: State<'_, AppState>,
) -> Result<Vec<PlaylistSummary>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(Vec::new());
    };
    // 合并视图：本地歌单（platform=local）+ 收藏的在线歌单
    let result =
        tauri::async_runtime::spawn_blocking(move || db.with(crate::db::store::list_my_playlists))
            .await
            .map_err(|e| format!("读取我的歌单失败: {e}"))?;
    match &result {
        Ok(v) => log::info!(
            "[db] 我的歌单 {} 条（本地 {} / 在线 {}）",
            v.len(),
            v.iter().filter(|p| p.platform == "local").count(),
            v.iter().filter(|p| p.platform != "local").count()
        ),
        Err(e) => log::warn!("[db] 读取我的歌单失败: {e}"),
    }
    result.map_err(|e| format!("读取我的歌单失败: {e}"))
}

#[tauri::command(rename = "get_playlist_tracks")]
pub async fn cmd_get_playlist_tracks(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<Track>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::get_playlist_tracks(conn, &id))
    })
    .await
    .map_err(|e| format!("读取歌单曲目失败: {e}"))?
}

#[tauri::command(rename = "add_tracks_to_playlist")]
pub async fn cmd_add_tracks_to_playlist(
    state: State<'_, AppState>,
    id: String,
    tracks: Vec<Track>,
) -> Result<usize, String> {
    let Some(db) = state.db.clone() else {
        return Ok(0);
    };
    // id 参数 = 歌单 pid（收藏进哪个歌单，云端就记哪个 pid）
    let for_db = tracks.clone();
    let push_id = id.clone();
    let added = tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::add_tracks_to_playlist(conn, &id, &for_db))
    })
    .await
    .map_err(|e| format!("添加歌曲到歌单失败: {e}"))?
    .map_err(|e| format!("添加歌曲到歌单失败: {e}"))?;
    let items: Vec<(Track, String, Option<String>)> = tracks
        .iter()
        .map(|t| (t.clone(), "add".to_string(), Some(push_id.clone())))
        .collect();
    push_like_songs_batch(&state, items).await;
    Ok(added)
}

#[tauri::command(rename = "remove_track_from_playlist")]
pub async fn cmd_remove_track_from_playlist(
    state: State<'_, AppState>,
    id: String,
    track: Track,
) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    let for_db = track.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::remove_track_from_playlist(conn, &id, &for_db))
    })
    .await
    .map_err(|e| format!("从歌单移除歌曲失败: {e}"))?
    .map_err(|e| format!("从歌单移除歌曲失败: {e}"))?;
    // 多归属下的云端策略与 remove_favorite 一致
    match outcome {
        crate::db::store::LikeRemoveOutcome::RemovedAll => {
            push_like_song(&state, &track, "remove", None).await;
        }
        crate::db::store::LikeRemoveOutcome::Rebound(next) => {
            push_like_song(&state, &track, "add", Some(&next)).await;
        }
        crate::db::store::LikeRemoveOutcome::DetachedOnly => {}
    }
    Ok(())
}

/// 批量从歌单移除曲目（歌单批量管理）。单首失败不中断整批（逐条记日志），
/// 返回实际移除的数量；云端推送策略与单曲版一致（逐首按 outcome 推）。
#[tauri::command(rename = "remove_tracks_from_playlist")]
pub async fn cmd_remove_tracks_from_playlist(
    state: State<'_, AppState>,
    id: String,
    tracks: Vec<Track>,
) -> Result<u32, String> {
    if tracks.is_empty() {
        return Ok(0);
    }
    let Some(db) = state.db.clone() else {
        return Ok(0);
    };
    // playlist_tracks 关联行在 remove_track_from_playlist 里无条件删除，
    // outcome 只决定云端怎么推（与单曲版同一条代码路径）
    let outcomes = tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| {
            let mut out: Vec<(Track, crate::db::store::LikeRemoveOutcome)> =
                Vec::with_capacity(tracks.len());
            for t in &tracks {
                match crate::db::store::remove_track_from_playlist(conn, &id, t) {
                    Ok(o) => out.push((t.clone(), o)),
                    Err(e) => log::warn!("[playlist] 批量移除单曲失败 {}: {e}", t.id),
                }
            }
            Ok(out)
        })
    })
    .await
    .map_err(|e| format!("从歌单批量移除歌曲失败: {e}"))?
    .map_err(|e| format!("从歌单批量移除歌曲失败: {e}"))?;
    let removed = outcomes.len() as u32;
    // outcome 决定云端怎么推（与单曲版同一条策略），整批收集后分批上送：
    // remove 与 add 混在批里也安全——后端按数组顺序执行，批内后写必胜
    let mut items: Vec<(Track, String, Option<String>)> = Vec::with_capacity(outcomes.len());
    for (track, outcome) in outcomes {
        match outcome {
            crate::db::store::LikeRemoveOutcome::RemovedAll => {
                items.push((track, "remove".to_string(), None));
            }
            crate::db::store::LikeRemoveOutcome::Rebound(next) => {
                items.push((track, "add".to_string(), Some(next)));
            }
            crate::db::store::LikeRemoveOutcome::DetachedOnly => {}
        }
    }
    push_like_songs_batch(&state, items).await;
    Ok(removed)
}

// ---------- 下载管理（DESIGN §5.3） ----------
// 取址复用播放链路（含 10 分钟内存缓存），落盘走流式写入，进度写回 download_tasks。
//
// 下载目录：settings `download.dir` 优先；未设置时默认 `<安装目录>/Download`
// （exe 所在目录，currentUser 安装无需管理员即可写）。

/// 下载目录的 settings 键
const SETTING_DOWNLOAD_DIR: &str = "download.dir";

/// 下载状态变化事件名（与 download 模块保持一致）
const EVENT_DOWNLOADS_CHANGED: &str = download::EVENT_DOWNLOADS_CHANGED;

/// 默认下载目录：安装目录（exe 所在目录）/ Download
fn default_download_dir() -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("定位安装目录失败: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "定位安装目录失败".to_string())?
        .join("Download");
    Ok(dir)
}

/// 当前生效的下载目录：用户自选 > 安装目录/Download
fn download_dir(state: &AppState) -> Result<std::path::PathBuf, String> {
    if let Some(db) = &state.db {
        if let Ok(Some(saved)) =
            db.with(|conn| crate::db::store::get_setting(conn, SETTING_DOWNLOAD_DIR))
        {
            if !saved.trim().is_empty() {
                return Ok(std::path::PathBuf::from(saved));
            }
        }
    }
    default_download_dir()
}

/// 文件名安全化：去掉 Windows 非法字符与控制符，保留中文，截断 80 字符。
fn sanitize_file_name(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .filter(|c| {
            !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control()
        })
        .collect();
    let trimmed = cleaned.trim().to_string();
    if trimmed.is_empty() {
        String::new()
    } else {
        trimmed.chars().take(80).collect()
    }
}

/// 从取址 URL 推断音频扩展名；URL 没有可用后缀时按音质兜底。
///
/// 无损地址各源都会带明确的 `.flac`，但 kw 的 `format=flac|mp3|aac` 在无无损源时
/// 会真的回退成 mp3，所以优先信 URL，信不过再退回音质映射。
fn audio_ext_from_url(url: &str, quality: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let segment = path.rsplit('/').next().unwrap_or("");
    if let Some((_, ext)) = segment.rsplit_once('.') {
        let ext = ext.to_ascii_lowercase();
        if matches!(
            ext.as_str(),
            "flac" | "mp3" | "m4a" | "aac" | "wav" | "ogg" | "opus" | "wma" | "ape" | "mp4"
        ) {
            return ext;
        }
    }
    if quality == "flac" {
        "flac".to_string()
    } else {
        "mp3".to_string()
    }
}

/// 读取「下载文件名格式」设置：artist=歌手-歌名（默认），song=歌名-歌手。
/// 仅影响设置变更后新开始的下载；已存在的任务沿用原保存路径。
fn download_name_format(state: &AppState) -> String {
    let v = state.db.clone().and_then(|db| {
        db.with(|c| crate::db::store::get_setting(c, "downloadNameFormat"))
            .ok()
            .flatten()
    });
    match v.as_deref() {
        Some("song") => "song".to_string(),
        _ => "artist".to_string(),
    }
}

/// 生成不与现有文件冲突的下载路径：`歌手 - 歌名.<ext>`（或按 name_format 反转），重名加 (2) (3)…
/// 扩展名由取址 URL 决定，避免无损内容被写成 `.mp3`。
///
/// `name_format == "song"` 时用 `歌名 - 歌手`，其余（默认 "artist"）用 `歌手 - 歌名`。
fn unique_download_path(
    dir: &std::path::Path,
    track: &Track,
    quality: &str,
    url: &str,
    name_format: &str,
) -> std::path::PathBuf {
    let ext = audio_ext_from_url(url, quality);
    let base = {
        let named = if name_format == "song" {
            format!(
                "{} - {}",
                sanitize_file_name(&track.title),
                sanitize_file_name(&track.singer)
            )
        } else {
            format!(
                "{} - {}",
                sanitize_file_name(&track.singer),
                sanitize_file_name(&track.title)
            )
        };
        let name = if named.trim_matches([' ', '-']).is_empty() {
            // 歌名/歌手全被过滤掉时退回老格式（platform_id_quality）
            format!(
                "{}_{}_{}",
                track.platform,
                sanitize_file_name(&track.id),
                quality
            )
        } else {
            named
        };
        dir.join(format!("{name}.{ext}"))
    };
    if !base.exists() {
        return base;
    }
    for n in 2..=99 {
        let stem = base.file_stem().and_then(|s| s.to_str()).unwrap_or("track");
        let candidate = dir.join(format!("{stem} ({n}).{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    base
}

#[tauri::command(rename = "get_download_dir")]
pub async fn cmd_get_download_dir(state: State<'_, AppState>) -> Result<String, String> {
    download_dir(&state).map(|p| p.to_string_lossy().to_string())
}

/// 弹出系统文件夹选择框，选中后保存为下载目录并返回新路径（取消返回 None）。
#[tauri::command(rename = "choose_download_dir")]
pub async fn cmd_choose_download_dir(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择下载保存位置")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| format!("打开文件夹选择框失败: {e}"))?;

    let Some(picked) = picked else {
        return Ok(None); // 用户取消
    };
    let path = match picked.into_path() {
        Ok(p) => p,
        Err(e) => return Err(format!("无效的文件夹路径: {e:?}")),
    };
    let path_str = path.to_string_lossy().to_string();
    if let Some(db) = &state.db {
        db.with(|conn| crate::db::store::set_setting(conn, SETTING_DOWNLOAD_DIR, &path_str))
            .map_err(|e| e.to_string())?;
    }
    Ok(Some(path_str))
}

/// 重置下载目录为默认（安装目录/Download），返回重置后的路径。
#[tauri::command(rename = "reset_download_dir")]
pub async fn cmd_reset_download_dir(state: State<'_, AppState>) -> Result<String, String> {
    if let Some(db) = &state.db {
        db.with(|conn| crate::db::store::set_setting(conn, SETTING_DOWNLOAD_DIR, ""))
            .map_err(|e| e.to_string())?;
    }
    let dir = download_dir(&state)?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command(rename = "list_downloads")]
pub async fn cmd_list_downloads(state: State<'_, AppState>) -> Result<Vec<DownloadTask>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || db.with(crate::db::store::list_download_tasks))
        .await
        .map_err(|e| format!("读取下载列表失败: {e}"))?
}

/// 删除下载任务。`delete_file = true` 时连同成品文件与未写完的 `.part` 一起删。
/// 任务仍在下载中时先请求取消，避免删了记录后台还在写文件。
#[tauri::command(rename = "delete_download")]
pub async fn cmd_delete_download(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    delete_file: bool,
) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    state.downloads.request_stop(&id);

    let (path, part) = tauri::async_runtime::spawn_blocking({
        let id = id.clone();
        let db = Arc::clone(&db);
        move || {
            db.with(|conn| {
                let task = crate::db::store::download_task_by_id(conn, &id)?;
                let part = task.as_ref().and_then(|t| t.part_path.clone());
                let removed = crate::db::store::delete_download_task(conn, &id)?;
                Ok::<_, rusqlite::Error>((removed, part))
            })
        }
    })
    .await
    .map_err(|e| format!("删除下载任务失败: {e}"))??;

    if delete_file {
        if let Some(p) = path {
            let _ = std::fs::remove_file(&p);
        }
    }
    // 无论是否删成品，临时文件都该清掉：任务已经不存在了，留着只是垃圾
    if let Some(p) = part {
        let _ = std::fs::remove_file(&p);
    }
    let _ = app.emit(EVENT_DOWNLOADS_CHANGED, ());
    Ok(())
}

/// 批量删除下载任务（多选后用）。语义同 `cmd_delete_download`：
/// `delete_file = true` 时连成品文件一起删，`.part` 临时文件一律清掉。
/// 返回删除的记录条数（已在列表里不存在的 id 不计入）。
#[tauri::command(rename = "delete_downloads")]
pub async fn cmd_delete_downloads(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
    delete_file: bool,
) -> Result<usize, String> {
    let ids: Vec<String> = ids.into_iter().filter(|s| !s.trim().is_empty()).collect();
    if ids.is_empty() {
        return Ok(0);
    }
    // 下载中的先请求取消，避免删了记录后台还在写文件
    for id in &ids {
        state.downloads.request_stop(id);
    }
    let Some(db) = state.db.clone() else {
        return Ok(0);
    };

    let files = tauri::async_runtime::spawn_blocking({
        let ids = ids.clone();
        let db = Arc::clone(&db);
        move || db.with(|conn| crate::db::store::delete_download_tasks(conn, &ids))
    })
    .await
    .map_err(|e| format!("批量删除下载任务失败: {e}"))??;

    for (path, part) in &files {
        if delete_file {
            if let Some(p) = path {
                let _ = std::fs::remove_file(p);
            }
        }
        if let Some(p) = part {
            let _ = std::fs::remove_file(p);
        }
    }
    let _ = app.emit(EVENT_DOWNLOADS_CHANGED, ());
    Ok(files.len())
}

/// 已下载完成的曲目 db 主键集合（形如 `wyy:123`），前端据此给列表打「已下载」标。
#[tauri::command(rename = "list_downloaded_track_ids")]
pub async fn cmd_list_downloaded_track_ids(
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || db.with(crate::db::store::downloaded_track_ids))
        .await
        .map_err(|e| format!("读取已下载列表失败: {e}"))?
}

/// 开始下载一首歌，返回任务 id。
///
/// 顺序刻意是「先取址成功再建任务」：早前版本先建 pending 任务再取址，
/// 取址失败时任务会永远停在「等待中」。
/// 去重：同曲目同音质已有未取消的任务（含已完成）直接复用，不重复下载。
#[tauri::command(rename = "start_download")]
pub async fn cmd_start_download(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    track: Track,
    quality: Quality,
) -> Result<String, String> {
    if track.platform == SourceId::Local {
        return Err("本地歌曲无需下载".to_string());
    }
    let Some(db) = state.db.clone() else {
        return Err("数据库不可用".to_string());
    };
    let q_str = quality_str(quality).to_string();

    // 去重先查：命中就复用原任务（已完成也复用，避免重复占空间）
    let db_id = crate::db::store::db_track_id(&track);
    let existing = tauri::async_runtime::spawn_blocking({
        let db = Arc::clone(&db);
        let db_id = db_id.clone();
        let q = q_str.clone();
        move || db.with(|c| crate::db::store::find_download_task(c, &db_id, &q))
    })
    .await
    .map_err(|e| format!("查询下载任务失败: {e}"))??;
    if let Some(task) = existing {
        log::info!(
            "[download] 已有任务 {}，复用（status={}）",
            task.id,
            task.status
        );
        return Ok(task.id);
    }

    // 取址放在建任务之前：失败就干净报错，不留悬挂任务
    let (url, _fetched) = resolve_play_url_script(&app, &state.url_cache, &track, quality)
        .await
        .map_err(|e| format!("取播放地址失败: {e}"))?;

    let dir = download_dir(&state)?;
    let name_fmt = download_name_format(&state);
    let final_path = unique_download_path(&dir, &track, &q_str, &url, &name_fmt);
    let part_path = download::part_path_for(&final_path);
    let part_str = part_path.to_string_lossy().to_string();

    let task_id = tauri::async_runtime::spawn_blocking({
        let db = Arc::clone(&db);
        let t = track.clone();
        let q = q_str.clone();
        move || db.with(|conn| crate::db::store::create_download_task(conn, &t, &q, &part_str))
    })
    .await
    .map_err(|e| format!("创建下载任务失败: {e}"))??;

    let app_for_job = app.clone();
    let db_for_job = Arc::clone(&db);
    let manager = Arc::clone(&state.downloads);
    let task_for_job = task_id.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = download::run_job(
            app_for_job,
            Arc::clone(&db_for_job),
            manager,
            DownloadJob {
                task_id: task_for_job,
                url,
                final_path,
                part_path,
            },
        )
        .await;
        if let DownloadOutcome::Failed(msg) = outcome {
            log::warn!("[download] 任务失败: {msg}");
        }
    });

    Ok(task_id)
}

/// 暂停下载：请求停止后台写入，状态落 `paused`，保留 `.part` 以便续传。
#[tauri::command(rename = "pause_download")]
pub async fn cmd_pause_download(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Err("数据库不可用".to_string());
    };
    state.downloads.request_stop(&id);
    set_download_state(
        &db,
        &id,
        download::status::PAUSED,
        Some("已暂停，点击「继续」接着下载"),
    )
    .await?;
    let _ = app.emit(EVENT_DOWNLOADS_CHANGED, ());
    Ok(())
}

/// 继续 / 重试下载：重置进度后按原 `.part` 断点续传（服务端不支持则整包重来）。
#[tauri::command(rename = "resume_download")]
pub async fn cmd_resume_download(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    relaunch_download(app, &state, id).await
}

/// 重试失败 / 已取消的下载（与「继续」同一条链路，语义上区分便于前端文案）。
#[tauri::command(rename = "retry_download")]
pub async fn cmd_retry_download(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    relaunch_download(app, &state, id).await
}

/// 取消下载：请求停止并删除 `.part`，状态落 `canceled`。
#[tauri::command(rename = "cancel_download")]
pub async fn cmd_cancel_download(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Err("数据库不可用".to_string());
    };
    state.downloads.request_stop(&id);
    if let Ok(Some(task)) = db.with(|c| crate::db::store::download_task_by_id(c, &id)) {
        if let Some(p) = task.part_path {
            let _ = std::fs::remove_file(p);
        }
    }
    set_download_state(&db, &id, download::status::CANCELED, None).await?;
    let _ = app.emit(EVENT_DOWNLOADS_CHANGED, ());
    Ok(())
}

/// 生成 explorer 的 `/select,` 参数。explorer 不按标准 argv 解析：路径必须
/// **紧跟逗号**并被双引号包住，写成 `/select,<裸路径>` 会被空格截断，
/// 资源管理器退回默认目录而不选中文件。
#[cfg(any(target_os = "windows", test))]
fn explorer_select_arg(path: &str) -> String {
    format!("/select,\"{path}\"")
}

/// 在系统文件管理器中定位文件（Windows 用 `explorer /select,`）。
/// 文件不存在直接返回 Err，由调用方给出可读提示；下载管理与本地曲库共用。
fn reveal_in_file_manager(path: &str) -> Result<(), String> {
    if !std::path::Path::new(path).exists() {
        return Err("文件已不存在（可能被移动或删除）".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .raw_arg(explorer_select_arg(path))
            .spawn()
            .map_err(|e| format!("打开资源管理器失败: {e}"))?;
    }
    Ok(())
}

/// 打开日志文件夹（设置页「通用 → 诊断」用；运维排查的入口）。
#[tauri::command(rename = "reveal_logs")]
pub async fn cmd_reveal_logs() -> Result<(), String> {
    let Some(dir) = crate::file_logger::logs_dir() else {
        return Err("本次运行未启用文件日志（日志目录不可用）".to_string());
    };
    if !dir.exists() {
        let _ = std::fs::create_dir_all(&dir);
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("打开日志文件夹失败: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = &dir;
        Err("仅支持 Windows".to_string())
    }
}

/// 前端日志落盘：全局错误浮层（main.tsx）把 JS 侧错误转写进文件日志，
/// release 下前端崩溃才不只有 settings 表里一条 lastError。
#[tauri::command(rename = "write_log")]
pub async fn cmd_write_log(level: String, message: String) -> Result<(), String> {
    // 截断防线：异常时的循环报错或超大 stack 不能把日志文件刷爆
    let message: String = message.chars().take(4000).collect();
    match level.as_str() {
        "error" => log::error!("[frontend] {message}"),
        "warn" => log::warn!("[frontend] {message}"),
        _ => log::info!("[frontend] {message}"),
    }
    Ok(())
}

/// 删除本地音频文件（幂等：文件本就不在视为已删除）。返回本次是否真的删掉了文件。
fn remove_local_file(path: &str) -> Result<bool, String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("删除文件失败: {e}")),
    }
}

/// 在资源管理器中定位已下载文件（Windows 用 explorer /select）。
#[tauri::command(rename = "reveal_download")]
pub async fn cmd_reveal_download(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Err("数据库不可用".to_string());
    };
    let task = tauri::async_runtime::spawn_blocking(move || {
        db.with(|c| crate::db::store::download_task_by_id(c, &id))
    })
    .await
    .map_err(|e| format!("读取下载任务失败: {e}"))??;
    let path = task
        .and_then(|t| t.file_path)
        .ok_or_else(|| "文件尚未下载完成".to_string())?;
    reveal_in_file_manager(&path)
}

/// 把任务状态写库（暂停 / 取消这类由命令层决定的状态）。
async fn set_download_state(
    db: &Arc<crate::db::Database>,
    id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), String> {
    let id = id.to_string();
    let status = status.to_string();
    let error = error.map(str::to_string);
    let db = Arc::clone(db);
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|c| crate::db::store::set_download_status(c, &id, &status, error.as_deref()))
    })
    .await
    .map_err(|e| format!("更新下载状态失败: {e}"))?
}

/// 「继续 / 重试」共用实现：读原任务参数 → 重置 → 重新取址并断点续传。
async fn relaunch_download(
    app: tauri::AppHandle,
    state: &State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Err("数据库不可用".to_string());
    };
    let task = tauri::async_runtime::spawn_blocking({
        let db = Arc::clone(&db);
        let id = id.clone();
        move || db.with(|c| crate::db::store::download_task_by_id(c, &id))
    })
    .await
    .map_err(|e| format!("读取下载任务失败: {e}"))??
    .ok_or_else(|| "下载任务不存在".to_string())?;

    if task.status == download::status::DONE {
        return Err("该歌曲已下载完成".to_string());
    }
    if state.downloads.is_active(&id) {
        return Ok(()); // 已经在下载，忽略重复点击
    }

    let quality = parse_provider_quality(&task.quality)
        .ok_or_else(|| format!("未知音质: {}", task.quality))?;
    let dir = download_dir(state)?;

    tauri::async_runtime::spawn_blocking({
        let db = Arc::clone(&db);
        let id = id.clone();
        move || db.with(|c| crate::db::store::reset_download_for_retry(c, &id))
    })
    .await
    .map_err(|e| format!("重置下载任务失败: {e}"))??;

    let app_for_job = app.clone();
    let db_for_job = Arc::clone(&db);
    let manager = Arc::clone(&state.downloads);
    let url_cache = Arc::clone(&state.url_cache);
    let track = task.track.clone();
    let existing_part = task.part_path.clone();
    let task_id = id.clone();

    tauri::async_runtime::spawn(async move {
        let result = launch_download(
            app_for_job,
            db_for_job,
            manager,
            url_cache,
            task_id,
            track,
            quality,
            dir,
            existing_part,
        )
        .await;
        if let Err(e) = result {
            log::warn!("[download] 续传失败: {e}");
        }
    });

    Ok(())
}

/// 「继续 / 重试」的实际执行：取址 → 定路径 → 交给下载器。
#[allow(clippy::too_many_arguments)]
async fn launch_download(
    app: tauri::AppHandle,
    db: Arc<crate::db::Database>,
    manager: Arc<DownloadManager>,
    url_cache: Arc<PlayUrlCache>,
    task_id: String,
    track: Track,
    quality: Quality,
    dir: PathBuf,
    existing_part: Option<String>,
) -> Result<(), String> {
    let (url, _) = resolve_play_url_script(&app, &url_cache, &track, quality)
        .await
        .map_err(|e| format!("取播放地址失败: {e}"))?;

    // 有历史 `.part` 就沿用（路径里含原扩展名，成品名也据此还原，保持一致）
    let (final_path, part_path) = match existing_part.filter(|p| !p.trim().is_empty()) {
        Some(p) => {
            let final_path = PathBuf::from(p.strip_suffix(".part").unwrap_or(&p));
            (final_path, PathBuf::from(&p))
        }
        None => {
            let name_fmt = db
                .with(|c| crate::db::store::get_setting(c, "downloadNameFormat"))
                .ok()
                .flatten()
                .unwrap_or_else(|| "artist".to_string());
            let final_path =
                unique_download_path(&dir, &track, quality_str(quality), &url, &name_fmt);
            let part = download::part_path_for(&final_path);
            (final_path, part)
        }
    };
    let part_str = part_path.to_string_lossy().to_string();
    let id_for_db = task_id.clone();
    let db_part = Arc::clone(&db);
    let _ = tauri::async_runtime::spawn_blocking(move || {
        db_part.with(|c| crate::db::store::set_download_part_path(c, &id_for_db, &part_str))
    })
    .await;

    download::run_job(
        app,
        db,
        manager,
        DownloadJob {
            task_id,
            url,
            final_path,
            part_path,
        },
    )
    .await;

    Ok(())
}

/// 任务里存的音质字符串（"128" / "320" / "flac"）→ provider Quality。
fn parse_provider_quality(s: &str) -> Option<Quality> {
    match s {
        "128" => Some(Quality::Standard),
        "320" => Some(Quality::High),
        "flac" => Some(Quality::Lossless),
        _ => None,
    }
}

// ---------- Astral 账号（DESIGN §2.3.4；接口契约同 qt-uniappx AccountApi） ----------
//
// 会话存在本地 settings 表（key = astral.session），启动时由 lib.rs 回填 satoken，
// 免得每次开应用都要重新登录。

const SETTING_ASTRAL_SESSION: &str = crate::astral::SETTING_ASTRAL_SESSION;

async fn persist_session(db: &Option<Arc<crate::db::Database>>, session: &AuthSession) {
    let Some(db) = db.clone() else {
        return;
    };
    let value = match serde_json::to_string(session) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[astral] 会话序列化失败: {e}");
            return;
        }
    };
    let _ = tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::set_setting(conn, SETTING_ASTRAL_SESSION, &value))
    })
    .await;
}

async fn clear_session(db: &Option<Arc<crate::db::Database>>) {
    let Some(db) = db.clone() else {
        return;
    };
    let _ = tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::set_setting(conn, SETTING_ASTRAL_SESSION, ""))
    })
    .await;
}

#[tauri::command(rename = "astral_login")]
pub async fn cmd_astral_login(
    state: State<'_, AppState>,
    username: String,
    password: String,
) -> Result<AuthSession, String> {
    let session = state.astral.login(&username, &password).await?;
    persist_session(&state.db, &session).await;
    Ok(session)
}

#[tauri::command(rename = "astral_register")]
pub async fn cmd_astral_register(
    state: State<'_, AppState>,
    username: String,
    password: String,
    password_confirm: String,
    email: Option<String>,
    nickname: Option<String>,
) -> Result<AuthSession, String> {
    let session = state
        .astral
        .register(
            &username,
            &password,
            &password_confirm,
            email.as_deref(),
            nickname.as_deref(),
        )
        .await?;
    persist_session(&state.db, &session).await;
    Ok(session)
}

#[tauri::command(rename = "astral_logout")]
pub async fn cmd_astral_logout(state: State<'_, AppState>) -> Result<(), String> {
    // 后端失败也要清本地：否则用户永远退不出去
    let result = state.astral.logout().await;
    clear_session(&state.db).await;
    result
}

/// 当前登录用户信息。同时是启动时"确认会话是否仍被服务端承认"的探针：
/// 拿回 401（HTTP 或业务码）说明 token 只是本地没过期、服务端早不认了，
/// 顺手清掉本地会话和 satoken，界面才不会一直显示「已登录」而接口全 401。
/// 网络不可达属于另一类错误，不清会话——断网不该把人登出。
#[tauri::command(rename = "astral_me")]
pub async fn cmd_astral_me(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    match state.astral.me().await {
        Ok(v) if !v.is_null() => Ok(v),
        Ok(v) => {
            // 服务端收下了请求却没给用户信息（success(null)）：同样按会话无效处理
            if state.astral.has_token() {
                clear_session(&state.db).await;
                state.astral.set_token(None);
                log::info!("[astral] /me 返回空，判定会话失效并清除本地登录态");
            }
            Ok(v)
        }
        Err(e) => {
            if crate::astral::is_auth_error(&e) {
                clear_session(&state.db).await;
                state.astral.set_token(None);
                log::info!("[astral] 服务端否认会话（401），已清除本地登录态");
            }
            Err(e)
        }
    }
}

/// 用旧 token 换新会话（satoken 过期时前端调这个，不用重新输密码）
#[tauri::command(rename = "astral_refresh")]
pub async fn cmd_astral_refresh(state: State<'_, AppState>) -> Result<AuthSession, String> {
    let session = state.astral.refresh().await?;
    persist_session(&state.db, &session).await;
    Ok(session)
}

/// 本地保存的会话（可能已过期，是否过期看 `is_valid`）
#[tauri::command(rename = "astral_session")]
pub async fn cmd_astral_session(state: State<'_, AppState>) -> Result<Option<AuthSession>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::get_setting(conn, SETTING_ASTRAL_SESSION))
    })
    .await
    .map_err(|e| format!("读取本地会话失败: {e}"))?
    .map(|v| v.and_then(|s| serde_json::from_str::<AuthSession>(&s).ok()))
}

/// 发邮箱验证码（当前唯一场景：邮箱改密码）。
///
/// 第二个参数是**邮件模板业务标识**，不是邮件正文。以前这里传的是一句中文文案，
/// 后端拿它当 template_code 去 sys_mail_template 查模板，必然 MAIL002 发不出信；
/// 而且验证码按 `qt:email:code:{email}:{scene}` 存，与 changePass 校验用的 scene
/// 不一致，就算发出去了也校验不过——整条找回密码链路是断的。
/// scene 由 Rust 侧持有：前端不该知道后端的模板编码。
#[tauri::command(rename = "astral_send_email_code")]
pub async fn cmd_astral_send_email_code(
    state: State<'_, AppState>,
    email: String,
) -> Result<serde_json::Value, String> {
    state
        .astral
        .send_email_code(&email, crate::astral::MAIL_SCENE_CHANGE_PW)
        .await
}

#[tauri::command(rename = "astral_change_password")]
pub async fn cmd_astral_change_password(
    state: State<'_, AppState>,
    email: String,
    password: String,
    code: String,
) -> Result<serde_json::Value, String> {
    state.astral.change_password(&email, &password, &code).await
}

#[tauri::command(rename = "astral_update_profile")]
pub async fn cmd_astral_update_profile(
    state: State<'_, AppState>,
    patch: serde_json::Value,
) -> Result<serde_json::Value, String> {
    state.astral.update_profile(patch).await
}

/// 头像上传（UPDATE_DESIGN.md §5.2）：预检→凭证→直传→登记一条龙，返回头像 URL。
/// 文件正文不经过 Astral 服务器，这里在 Rust 侧直传存储端（CSP 不放开外部域名）。
#[tauri::command(rename = "astral_upload_avatar")]
pub async fn cmd_astral_upload_avatar(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<serde_json::Value, String> {
    let url = state.astral.upload_avatar_file(&file_path).await?;
    Ok(serde_json::json!({ "url": url }))
}

/// 歌单封面上传（UPDATE_DESIGN.md §5.3），返回封面 URL。
#[tauri::command(rename = "astral_upload_playlist_cover")]
pub async fn cmd_astral_upload_playlist_cover(
    state: State<'_, AppState>,
    pid: String,
    platform: String,
    file_path: String,
) -> Result<serde_json::Value, String> {
    let url = state
        .astral
        .upload_cover_file(&pid, &platform, &file_path)
        .await?;
    Ok(serde_json::json!({ "url": url }))
}

/// 清除歌单封面（回到默认本地资源）。
#[tauri::command(rename = "astral_clear_playlist_cover")]
pub async fn cmd_astral_clear_playlist_cover(
    state: State<'_, AppState>,
    pid: String,
    platform: String,
) -> Result<(), String> {
    state.astral.cover_clear(&pid, &platform).await
}

// ---------- 收藏同步（DESIGN §5.3；契约同 qt-uniappx services/like.ts） ----------
//
// 收藏两边都存：本地是权威（离线可用），云端做多端同步。
// 这里只提供原语（推送 / 拉增量 / 拉全量 / 落本地），编排交给前端，
// 免得同步策略写死在 Rust 里不好调。

#[tauri::command(rename = "like_push_song")]
pub async fn cmd_like_push_song(
    state: State<'_, AppState>,
    track: Track,
    action: String,
    pid: Option<String>,
) -> Result<i64, String> {
    let platform = track.platform.to_string();
    state
        .astral
        .like_song(crate::astral::LikeSongPayload {
            action: &action,
            sid: &track.id,
            platform: &platform,
            name: &track.title,
            singer: &track.singer,
            album: &track.album,
            hash: track.music_id.as_deref(),
            pid: pid.as_deref(),
            pic_url: Some(track.pic_url.as_str()),
        })
        .await
}

#[tauri::command(rename = "like_push_playlist")]
pub async fn cmd_like_push_playlist(
    state: State<'_, AppState>,
    id: String,
    platform: String,
    name: String,
    pic_url: Option<String>,
    action: String,
) -> Result<i64, String> {
    state
        .astral
        .like_playlist(&action, &id, &platform, &name, pic_url.as_deref())
        .await
}

/// 增量拉取收藏变更（since 为 0 时视作从头开始）
#[tauri::command(rename = "like_pull")]
pub async fn cmd_like_pull(
    state: State<'_, AppState>,
    since: i64,
) -> Result<serde_json::Value, String> {
    let (changes, max_seq) = state.astral.like_changes(since).await?;
    Ok(serde_json::json!({ "changes": changes, "maxSeq": max_seq }))
}

/// 全量分页拉取（游标丢失时的兜底）。返回后端原样 { songs, playlists, maxSeq }。
#[tauri::command(rename = "like_pull_all")]
pub async fn cmd_like_pull_all(
    state: State<'_, AppState>,
    page: i64,
    size: i64,
) -> Result<serde_json::Value, String> {
    state
        .astral
        .like_list(page, if size <= 0 { 100 } else { size })
        .await
}

/// 把云端变更落到本地收藏表。**不回推**云端，否则推送和拉取会来回震荡。
/// 云端记录不带封面和时长，落库前先用本地已有值补齐，避免把攒下的信息抹掉。
#[tauri::command(rename = "like_apply")]
pub async fn cmd_like_apply(
    state: State<'_, AppState>,
    changes: Vec<crate::astral::LikeChange>,
) -> Result<usize, String> {
    let Some(db) = state.db.clone() else {
        return Ok(0);
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| {
            let mut applied = 0usize;
            for c in changes {
                if c.id.is_empty() {
                    continue;
                }
                // 歌单收藏：云端只给元信息，够用了（曲目点开时再取）
                if c.kind == "playlist" {
                    if c.deleted {
                        // local 平台 = 自建歌单：本地行、归属、云端卡片一起清，
                        // 否则下次对账会把这个已被他端删除的歌单重新推上去（机制 B）
                        if c.platform == crate::db::store::LOCAL_PLATFORM {
                            crate::db::store::delete_playlist_follow_cloud(conn, &c.id)?;
                        } else {
                            crate::db::store::remove_liked_playlist(conn, &c.platform, &c.id)?;
                        }
                    } else {
                        let name = if c.name.is_empty() {
                            c.id.as_str()
                        } else {
                            c.name.as_str()
                        };
                        crate::db::store::add_liked_playlist(
                            conn,
                            &c.platform,
                            &c.id,
                            name,
                            &c.pic_url,
                            "",
                        )?;
                        // 自建歌单的云端回声：记确认点，对账据此识别「他端删除」
                        if c.platform == crate::db::store::LOCAL_PLATFORM && c.updated_seq > 0 {
                            crate::db::store::mark_playlist_cloud_seq(conn, &c.id, c.updated_seq)?;
                        }
                    }
                    applied += 1;
                    continue;
                }
                // 本期只同步 song / playlist 两类，其余（未知类型）跳过
                if c.kind != "song" {
                    continue;
                }
                // local（另一台设备上的本地曲目）同样要收：手机端收藏的本地歌
                // 会带 platform="local" 推到云端，这里放过才落得进 PC 的收藏表。
                // 认不出来的平台才是真脏数据，跳过。
                let Some(platform) = crate::provider::types::SourceId::parse(&c.platform) else {
                    log::info!("[like] 云端歌曲 {} 平台 {} 未知，跳过", c.id, c.platform);
                    continue;
                };
                let db_id = format!("{platform}:{}", c.id);
                let existing: Option<(Option<String>, Option<i64>)> = match conn.query_row(
                    "SELECT pic_url, duration_ms FROM tracks WHERE id = ?1",
                    rusqlite::params![db_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                ) {
                    Ok(v) => Some(v),
                    Err(rusqlite::Error::QueryReturnedNoRows) => None,
                    Err(e) => return Err(e),
                };
                let (local_pic, local_duration_ms) = existing.unwrap_or((None, None));

                let track = Track {
                    id: c.id.clone(),
                    platform,
                    title: if c.name.is_empty() {
                        c.id.clone()
                    } else {
                        c.name.clone()
                    },
                    singer: c.singer.clone(),
                    album: c.album.clone(),
                    pic_url: if c.pic_url.is_empty() {
                        local_pic.unwrap_or_default()
                    } else {
                        c.pic_url.clone()
                    },
                    duration: local_duration_ms.unwrap_or(0) as f64 / 1000.0,
                    music_id: if c.hash.is_empty() {
                        None
                    } else {
                        Some(c.hash.clone())
                    },
                };

                if c.deleted {
                    // 云端只摘掉变更里指定的那一个 pid（后端删歌单级联软删
                    // (sid,pid) 行时，每行都带 pid）：歌还有别的归属就留着。
                    // 没带 pid 的删除（整首取消收藏）才整首下线。
                    let pid = if c.pid.is_empty() {
                        None
                    } else {
                        Some(c.pid.as_str())
                    };
                    crate::db::store::remove_liked_song(conn, &track, pid)?;
                    applied += 1;
                } else if c.pid.is_empty() {
                    // 云端没带 pid（无归属）：不加载（v5 起无默认歌单）
                    log::info!("[like] 云端歌曲 {} 未归属歌单，跳过", c.id);
                } else {
                    // 必须有对应歌单（云端卡片或本地自建）才加载；
                    // pid 找不到歌单 → 不加载，等歌单同步过来后的全量重导再进
                    let known = crate::db::store::playlist_pid_exists(conn, &c.pid)?;
                    if !known {
                        log::info!("[like] 云端歌曲 {} 的歌单 {} 不存在，跳过", c.id, c.pid);
                    } else {
                        crate::db::store::add_liked_song(conn, &track, &c.pid)?;
                        applied += 1;
                    }
                }
            }
            Ok(applied)
        })
    })
    .await
    .map_err(|e| format!("应用收藏变更失败: {e}"))?
}

/// 重放收藏推送离线队列（LIKE_SYNC_DESIGN.md §3 pendingOps）。
/// 登录后 / 启动时 / 网络恢复时调用；按队列序分批走 /like/batch（每批 ≤ LIKE_BATCH_LIMIT），
/// 成功整批移除、失败整批退避保留（批内 op 共享同一次网络结果，同命运）。
/// 遇到 401（会话失效）或后端不可达立即停：留着等恢复后重放，避免无意义打接口。
#[tauri::command(rename = "like_flush_pending")]
pub async fn cmd_like_flush_pending(state: State<'_, AppState>) -> Result<u32, String> {
    if !state.astral.has_token() {
        return Ok(0);
    }
    let Some(db) = state.db.clone() else {
        return Ok(0);
    };
    let db_for_list = db.clone();
    let ops = tauri::async_runtime::spawn_blocking(move || {
        db_for_list.with(crate::db::store::list_pending_like_ops)
    })
    .await
    .map_err(|e| format!("读取离线队列失败: {e}"))??;
    let now = crate::astral::now_ms();
    // 退避中的条目本轮不动（保持原有 next_retry_at），其余按入队序进批
    let eligible: Vec<crate::db::store::PendingLikeOp> = ops
        .into_iter()
        .filter(|op| !matches!(op.next_retry_at, Some(t) if t > now))
        .collect();
    // payload 存的是单条接口请求体，批量接口要补 type 判别字段；
    // 解析不出对象的坏 payload 无法上送，单独退避保留（与旧逐条路径同命运）
    let mut ready: Vec<(String, String, String, String, i64, serde_json::Value)> = Vec::new();
    let mut corrupt: Vec<(String, i64)> = Vec::new();
    for op in eligible {
        match serde_json::from_str::<serde_json::Value>(&op.payload_json) {
            Ok(mut body) if body.is_object() => {
                body["type"] = serde_json::json!(op.kind.clone());
                ready.push((
                    op.id,
                    op.kind,
                    op.action,
                    op.payload_json,
                    op.retry_count,
                    body,
                ));
            }
            _ => {
                log::warn!("[like] 离线队列 payload 损坏 id={} 退避保留", op.id);
                corrupt.push((op.id, op.retry_count));
            }
        }
    }
    if !corrupt.is_empty() {
        let db2 = db.clone();
        if let Err(e) = tauri::async_runtime::spawn_blocking(move || {
            db2.with(|conn| {
                for (id, retries) in &corrupt {
                    if let Err(e) = crate::db::store::defer_pending_like_op(conn, id, *retries) {
                        log::warn!("[like] 离线队列退避登记失败: {e}");
                    }
                }
                Ok(())
            })
        })
        .await
        {
            log::warn!("[like] 离线队列退避登记失败: {e}");
        }
    }
    let mut pushed = 0u32;
    for chunk in ready.chunks(LIKE_BATCH_LIMIT) {
        let batch_ops: Vec<serde_json::Value> =
            chunk.iter().map(|(.., body)| body.clone()).collect();
        match state.astral.like_batch(batch_ops).await {
            Ok(seq) => {
                pushed += chunk.len() as u32;
                let ack_ids: Vec<String> = chunk.iter().map(|(id, ..)| id.clone()).collect();
                let db2 = db.clone();
                if let Err(e) = tauri::async_runtime::spawn_blocking(move || {
                    db2.with(|conn| {
                        for id in &ack_ids {
                            if let Err(e) = crate::db::store::ack_pending_like_op(conn, id) {
                                log::warn!("[like] 离线队列出队失败: {e}");
                            }
                        }
                        Ok(())
                    })
                })
                .await
                {
                    log::warn!("[like] 离线队列出队失败: {e}");
                }
                // 自建歌单 add 重放成功 → 回写云端确认点（机制 B）。批内共用整批
                // 最大 seq：该歌单在 maxSeq 前已确认存在，确认点单调推进，安全
                let marks: Vec<(String, i64)> = chunk
                    .iter()
                    .filter(|(_, kind, action, ..)| {
                        kind.as_str() == "playlist" && action.as_str() == "add"
                    })
                    .filter_map(|(.., payload, _, _)| {
                        serde_json::from_str::<serde_json::Value>(payload)
                            .ok()
                            .filter(|body| {
                                body.get("platform").and_then(serde_json::Value::as_str)
                                    == Some("local")
                            })
                            .and_then(|body| {
                                body.get("pid")
                                    .and_then(serde_json::Value::as_str)
                                    .map(str::to_string)
                            })
                    })
                    .map(|pid| (pid, seq))
                    .collect();
                if !marks.is_empty() {
                    let db2 = db.clone();
                    if let Err(e) = tauri::async_runtime::spawn_blocking(move || {
                        db2.with(|conn| {
                            for (pid, s) in &marks {
                                if let Err(e) =
                                    crate::db::store::mark_playlist_cloud_seq(conn, pid, *s)
                                {
                                    log::warn!("[like] 记录歌单云端确认点失败: {e}");
                                }
                            }
                            Ok(())
                        })
                    })
                    .await
                    {
                        log::warn!("[like] 记录歌单云端确认点失败: {e}");
                    }
                }
            }
            Err(e) => {
                // 整批退避保留。批内 op 顺序语义被中断，后续批次也不能越过它上送
                //（否则后端按到达序分配 seq 会乱序），整轮停，等恢复后重放
                log::warn!(
                    "[like] 离线批量重放失败 {} 条，整批退避保留: {e}",
                    chunk.len()
                );
                let deferral: Vec<(String, i64)> = chunk
                    .iter()
                    .map(|(id, .., retries, _)| (id.clone(), *retries))
                    .collect();
                let db2 = db.clone();
                if let Err(e2) = tauri::async_runtime::spawn_blocking(move || {
                    db2.with(|conn| {
                        for (id, retries) in &deferral {
                            if let Err(e) =
                                crate::db::store::defer_pending_like_op(conn, id, *retries)
                            {
                                log::warn!("[like] 离线队列退避登记失败: {e}");
                            }
                        }
                        Ok(())
                    })
                })
                .await
                {
                    log::warn!("[like] 离线队列退避登记失败: {e2}");
                }
                break;
            }
        }
    }
    Ok(pushed)
}

/// 启动对账（LIKE_SYNC_DESIGN.md §5）：全量拉取云端收藏做存在性 diff。
/// 增量拉取先跑（调用方保证），其他端删除的收藏先在本地移除。
///
/// 歌单按「云端确认点」（playlists.cloud_seq，v8）三分，修复原方案里
/// 「本机建、他端删 → 对账无条件补推 → 云端复活 → 全端收回」的死循环：
/// - 从未确认（cloud_seq IS NULL）→ 补推 add（老客户端从未上送的存量）；
/// - 云端有 → 刷新确认点；
/// - 云端没有、但确认点已存在且本地游标已推进到本次快照的 maxSeq
///   → 删除事件要么已消费（apply 已级联）、要么曾被截断丢过，
///   总之云端确实没有它了 → **本地跟随删除**，不再复活。
///   游标未跟上 maxSeq 时不动它：删除可能还在增量通道里，先让增量处理。
///
/// 云端卡片歌单（收藏的在线歌单）缺失 = 其他端取消收藏，同样跟随移除
/// （不再只是「不补推」——卡片留在本地列表就不会消失，正是「别端取消
/// 了收藏、本地却一直显示」的根因）。
///
/// 歌曲补推仍按 (platform, sid) 整档判断、只补主归属 pid，不按 pid 行级 diff。
#[tauri::command(rename = "like_reconcile")]
pub async fn cmd_like_reconcile(state: State<'_, AppState>) -> Result<u32, String> {
    if !state.astral.has_token() {
        return Ok(0);
    }
    let Some(db) = state.db.clone() else {
        return Ok(0);
    };

    // 1) 云端键集合（分页拉全量；后端单页上限 1000）+ 本次快照的 maxSeq
    let mut server_pids: HashSet<String> = HashSet::new();
    let mut server_sids: HashSet<String> = HashSet::new();
    let mut server_max_seq: i64 = 0;
    for page in 1..=200 {
        let list = state.astral.like_list(page, 1000).await?;
        let songs = list
            .get("songs")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        let playlists = list
            .get("playlists")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        if let Some(seq) = list.get("maxSeq").and_then(serde_json::Value::as_i64) {
            if seq > server_max_seq {
                server_max_seq = seq;
            }
        }
        if songs.is_empty() && playlists.is_empty() {
            break;
        }
        for p in &playlists {
            if let Some(pid) = p.get("pid").and_then(serde_json::Value::as_str) {
                server_pids.insert(pid.to_string());
            }
        }
        for s in &songs {
            if let (Some(sid), Some(plat)) = (
                s.get("sid").and_then(serde_json::Value::as_str),
                s.get("platform").and_then(serde_json::Value::as_str),
            ) {
                server_sids.insert(format!("{plat}:{sid}"));
            }
        }
    }

    // 2) 本地数据 + 同步游标（判定「删除事件是否已被增量通道消费过」的界尺）
    let db_for_read = db.clone();
    let locals = tauri::async_runtime::spawn_blocking(move || {
        db_for_read.with(|conn| {
            // (pid, cloud_seq)：自建歌单 + 云端确认点（机制 B）
            let pls = crate::db::store::list_playlist_sync_rows(conn)?;
            // 云端卡片歌单（收藏的在线歌单 + 他端建的自建歌单）
            let cards = crate::db::store::list_liked_playlists(conn)?;
            let cursor = crate::db::store::get_setting(conn, "like.sync.seq")?
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(0);
            // (sid, platform, name, singer, album, hash, pic, 主归属 pid)
            let songs = crate::db::store::list_liked_songs_raw(conn)?;
            Ok::<_, rusqlite::Error>((pls, cards, cursor, songs))
        })
    })
    .await
    .map_err(|e| format!("读本地收藏失败: {e}"))?
    .map_err(|e| format!("读本地收藏失败: {e}"))?;
    let (pls, cards, cursor, songs) = locals;
    // 游标没跟上本次快照 → 删除事件可能还在增量通道里，跟随删除一律不做
    let deletions_settled = cursor >= server_max_seq && server_max_seq > 0;

    let mut missing = 0u32;
    let mut removed = 0u32;

    // 3) 自建歌单三分（机制 B，见函数 doc）
    for (pid, cloud_seq) in &pls {
        if server_pids.contains(pid) {
            // 云端有：刷新确认点（单调推进）
            let p = pid.clone();
            let seq = server_max_seq;
            let db2 = db.clone();
            if let Err(e) = tauri::async_runtime::spawn_blocking(move || {
                db2.with(|conn| crate::db::store::mark_playlist_cloud_seq(conn, &p, seq))
            })
            .await
            {
                log::warn!("[like] 刷新歌单确认点失败: {e}");
            }
            continue;
        }
        match cloud_seq {
            None => {
                // 从未上送：补推歌单元数据
                let name = tauri::async_runtime::spawn_blocking({
                    let db2 = db.clone();
                    let p = pid.clone();
                    move || db2.with(|conn| playlist_name_by_pid(conn, &p))
                })
                .await
                .unwrap_or_else(|e| {
                    log::warn!("[like] 读歌单名失败: {e}");
                    Err(String::new())
                })
                .unwrap_or_default();
                if name.is_empty() {
                    continue;
                }
                missing += 1;
                push_like_playlist(
                    &state,
                    crate::db::store::LOCAL_PLATFORM,
                    pid,
                    &name,
                    None,
                    "add",
                )
                .await;
            }
            Some(confirmed) if deletions_settled && *confirmed <= server_max_seq => {
                // 云端确认过、现在没了 → 他端已删，本地跟随删除
                removed += 1;
                log::info!("[like] 歌单 {pid} 已被其他端删除，本地跟随移除");
                let p = pid.clone();
                let db2 = db.clone();
                if let Err(e) = tauri::async_runtime::spawn_blocking(move || {
                    db2.with(|conn| crate::db::store::delete_playlist_follow_cloud(conn, &p))
                })
                .await
                {
                    log::warn!("[like] 跟随删除歌单失败: {e}");
                }
            }
            Some(_) => {
                // 游标未跟上：增量通道可能还没消费删除事件，本轮不动
            }
        }
    }

    // 4) 云端卡片缺失 = 其他端取消收藏 → 跟随移除（同样只在删除尘埃落定后）。
    //    platform=local 的卡片是自建歌单的镜像 → 整歌单级联（防僵尸成员数据）；
    //    其余是在线歌单收藏 → 只删卡片。
    let mut removed_pids: HashSet<String> = HashSet::new();
    if deletions_settled {
        for card in &cards {
            if server_pids.contains(&card.id) {
                continue;
            }
            removed += 1;
            removed_pids.insert(card.id.clone());
            let (p, pid) = (card.platform.clone(), card.id.clone());
            let db2 = db.clone();
            let follow = p == crate::db::store::LOCAL_PLATFORM;
            if let Err(e) = tauri::async_runtime::spawn_blocking(move || {
                db2.with(|conn| {
                    if follow {
                        crate::db::store::delete_playlist_follow_cloud(conn, &pid)
                    } else {
                        crate::db::store::remove_liked_playlist(conn, &p, &pid)
                    }
                })
            })
            .await
            {
                log::warn!("[like] 跟随移除云端卡片失败: {e}");
            }
        }
    }

    // 5) 本地收藏歌曲不在云端集合里 → 补推 add（带主归属 pid），整批收集后分批上送
    let mut backfill: Vec<(Track, String, Option<String>)> = Vec::new();
    for (sid, platform, name, singer, album, hash, pic, pid) in &songs {
        if pid.is_empty() {
            continue; // 无归属不加载（v5 规则），云端同样不需要
        }
        if server_sids.contains(&format!("{platform}:{sid}")) {
            continue;
        }
        // 主归属歌单刚被跟随删除的：它的成员行云端已级联软删，
        // 再补推会把刚删的歌单连歌一起复活（云端 upsert 会复活软删行）
        if removed_pids.contains(pid) {
            continue;
        }
        // 自建歌单在前面的三分里被跟随删除的，同样跳过其成员
        if removed > 0 && !server_pids.contains(pid) && !pls_cloud_alive(pid, &pls, &server_pids) {
            continue;
        }
        // local 也在收藏同步范围内：一端收藏的本地歌要能在对账时补推回云端，
        // 与落库侧（cmd_like_apply）保持对称，否则只有「收」没有「补」。
        let Some(source) = crate::provider::types::SourceId::parse(platform) else {
            continue; // 真脏数据：平台认不出来
        };
        let track = crate::provider::types::Track {
            id: sid.clone(),
            platform: source,
            title: name.clone(),
            singer: singer.clone(),
            album: album.clone(),
            pic_url: pic.clone(),
            duration: 0.0,
            music_id: if hash.is_empty() {
                None
            } else {
                Some(hash.clone())
            },
        };
        missing += 1;
        backfill.push((track, "add".to_string(), Some(pid.clone())));
    }
    push_like_songs_batch(&state, backfill).await;
    if missing > 0 || removed > 0 {
        log::info!("[like] 启动对账补推 {missing} 项、跟随云端移除 {removed} 项");
    }
    Ok(missing)
}

/// 按 pid 读自建歌单名（对账补推元数据用）。空串 = 没这行。
fn playlist_name_by_pid(conn: &rusqlite::Connection, pid: &str) -> Result<String, rusqlite::Error> {
    use rusqlite::OptionalExtension;
    conn.query_row(
        "SELECT name FROM playlists WHERE pid = ?1",
        rusqlite::params![pid],
        |r| r.get(0),
    )
    .optional()
    .map(|v| v.unwrap_or_default())
}

/// 对账第 5 步的准入检查：歌曲的主归属 pid 对应的歌单是否仍活着。
/// 云端集合有它、或本地自建行里还有它（且它没被本轮跟随删除）才算活着。
fn pls_cloud_alive(
    pid: &str,
    pls: &[(String, Option<i64>)],
    server_pids: &HashSet<String>,
) -> bool {
    server_pids.contains(pid) || pls.iter().any(|(p, _)| p == pid && server_pids.contains(p))
}

/// 换账号登录时清空本地收藏（LIKE_SYNC_DESIGN.md §6 的 PC 版）：
/// 登录页检测到归属变化调用。收藏歌曲/歌单/多归属关联/离线队列全清，
/// 游标与全量导入标记复位，随后的 pullLikes 自动全量拉取新账号数据。
/// 播放历史、下载等设备级数据不动。返回清掉的行数。
#[tauri::command(rename = "like_clear_local")]
pub async fn cmd_like_clear_local(state: State<'_, AppState>) -> Result<i64, String> {
    let Some(db) = state.db.clone() else {
        return Ok(0);
    };
    tauri::async_runtime::spawn_blocking(move || db.with(crate::db::store::clear_like_local))
        .await
        .map_err(|e| format!("清理本地收藏失败: {e}"))?
        .map_err(|e| format!("清理本地收藏失败: {e}"))
}

/// 退出登录时重置收藏同步状态（LIKE_SYNC_DESIGN.md §6）：
/// 清离线队列 + 游标 + 全量导入标记；收藏数据与账号归属标记保留，
/// 同账号重登时无缝恢复（下次同步自动全量拉取合并）。
#[tauri::command(rename = "like_reset_sync")]
pub async fn cmd_like_reset_sync(state: State<'_, AppState>) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || db.with(crate::db::store::reset_like_sync_state))
        .await
        .map_err(|e| format!("重置同步状态失败: {e}"))?
        .map_err(|e| format!("重置同步状态失败: {e}"))
}

// ---------- 通用设置项（settings 表，供引导、小开关等零散状态用） ----------

#[tauri::command(rename = "get_setting")]
pub async fn cmd_get_setting(
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<String>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::get_setting(conn, &key))
    })
    .await
    .map_err(|e| format!("读取设置失败: {e}"))?
}

#[tauri::command(rename = "set_setting")]
pub async fn cmd_set_setting(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::set_setting(conn, &key, &value))
    })
    .await
    .map_err(|e| format!("保存设置失败: {e}"))?
}

// ---------- 听歌统计（DESIGN §5.3） ----------
// 数据由播放引擎在起播时写入 play_stats，这里只做查询。

#[tauri::command(rename = "get_play_overview")]
pub async fn cmd_get_play_overview(
    state: State<'_, AppState>,
) -> Result<crate::db::store::PlayOverview, String> {
    let Some(db) = state.db.clone() else {
        return Ok(crate::db::store::PlayOverview {
            total_plays: 0,
            total_ms: 0,
            track_count: 0,
            last_played_at: None,
        });
    };
    tauri::async_runtime::spawn_blocking(move || db.with(crate::db::store::play_overview))
        .await
        .map_err(|e| format!("读取听歌统计失败: {e}"))?
}

#[tauri::command(rename = "get_top_tracks")]
pub async fn cmd_get_top_tracks(
    state: State<'_, AppState>,
    limit: u32,
) -> Result<Vec<crate::db::store::PlayStatItem>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::list_top_tracks(conn, limit))
    })
    .await
    .map_err(|e| format!("读取热门曲目失败: {e}"))?
}

#[tauri::command(rename = "get_top_singers")]
pub async fn cmd_get_top_singers(
    state: State<'_, AppState>,
    limit: u32,
) -> Result<Vec<crate::db::store::SingerStat>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::list_top_singers(conn, limit))
    })
    .await
    .map_err(|e| format!("读取热门歌手失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::{
        audio_ext_from_url, explorer_select_arg, remove_local_file, reveal_in_file_manager,
        unique_download_path,
    };
    use crate::provider::types::{SourceId, Track};

    #[test]
    fn ext_comes_from_url_path() {
        // 无损地址（四源实测都是 .flac），即使音质串是 320 也按 URL 走
        assert_eq!(
            audio_ext_from_url(
                "http://kw-er.kuwo.cn/abc/resource/1/trackmedia/F000.flac",
                "flac"
            ),
            "flac"
        );
        assert_eq!(
            audio_ext_from_url("https://m701.music.126.net/2026/x/y.e69f.flac", "320"),
            "flac"
        );
        // 查询串/片段不参与后缀截取
        assert_eq!(
            audio_ext_from_url("https://cdn/a.mp3?k=v#frag", "320"),
            "mp3"
        );
        // 大小写归一
        assert_eq!(audio_ext_from_url("https://cdn/A.FLAC", "flac"), "flac");
    }

    #[test]
    fn ext_falls_back_to_quality() {
        // 无后缀
        assert_eq!(audio_ext_from_url("https://cdn/track/file", "flac"), "flac");
        assert_eq!(audio_ext_from_url("https://cdn/track/file", "320"), "mp3");
        // 非音频后缀（如已失效的重定向地址）也走音质兜底
        assert_eq!(audio_ext_from_url("https://cdn/x.html", "flac"), "flac");
        assert_eq!(audio_ext_from_url("https://cdn/x.html", "128"), "mp3");
    }

    #[test]
    fn explorer_select_arg_quotes_path_right_after_comma() {
        let arg = explorer_select_arg(r"D:\Music\周杰伦 - 晴天 (Live).flac");
        assert_eq!(arg, "/select,\"D:\\Music\\周杰伦 - 晴天 (Live).flac\"");
        // 逗号后不能有空格、首尾必须有引号——explorer 的硬要求
        assert!(arg.starts_with("/select,\""));
        assert!(arg.ends_with('"'));
    }

    #[test]
    fn reveal_rejects_missing_file_without_spawning() {
        // 文件不存在时直接报错（这条路径不会拉起资源管理器，测试无副作用）
        let missing = std::env::temp_dir().join("ll-no-such-file-99.flac");
        let err = reveal_in_file_manager(&missing.to_string_lossy()).unwrap_err();
        assert!(err.contains("不存在"), "错误提示应说明文件不存在: {err}");
    }

    #[test]
    fn remove_local_file_is_idempotent() {
        let dir = std::env::temp_dir().join(format!("ll-rm-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let f = dir.join("tone.flac");
        std::fs::write(&f, b"x").expect("写入");

        let path = f.to_string_lossy().to_string();
        assert!(
            remove_local_file(&path).expect("首次删除"),
            "首次应真的删掉文件"
        );
        assert!(!f.exists(), "文件应已不存在");
        // 再删一次：幂等，返回 false 而不是报错
        assert!(
            !remove_local_file(&path).expect("重复删除应静默"),
            "文件已不在应返回 false"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn sample_track() -> Track {
        Track {
            id: "1".to_string(),
            platform: SourceId::Kw,
            title: "晴天".to_string(),
            singer: "周杰伦".to_string(),
            album: String::new(),
            pic_url: String::new(),
            duration: 0.0,
            music_id: None,
        }
    }

    #[test]
    fn lossless_download_path_renames_to_flac_and_keeps_suffix_on_collision() {
        let dir = std::env::temp_dir().join(format!("ll-dl-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录");

        let url = "http://kw-er.kuwo.cn/abc/resource/1/trackmedia/F000.flac";
        let first = unique_download_path(&dir, &sample_track(), "flac", url, "artist");
        assert_eq!(
            first.file_name().and_then(|s| s.to_str()),
            Some("周杰伦 - 晴天.flac")
        );

        std::fs::write(&first, b"x").expect("占位");
        let second = unique_download_path(&dir, &sample_track(), "flac", url, "artist");
        assert_eq!(
            second.file_name().and_then(|s| s.to_str()),
            Some("周杰伦 - 晴天 (2).flac")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 音源脚本内置 request 通路验证（真实网络，对齐脚本 wyy 分支的接口）：
    /// 走 builtin_request 发网易歌单列表请求，断言 200 + JSON body 有 playlists。
    /// 与音源包 wyy 推荐分支共用同一上游。
    #[tokio::test]
    async fn builtin_request_fetches_wyy_playlist_list() {
        let url = "https://music.163.com/api/playlist/list?cat=%E5%85%A8%E9%83%A8&limit=5&offset=0&total=true";
        let res = super::source_builtin_request(
            url,
            Some(&super::SourceRequestOptions {
                method: Some("GET".into()),
                headers: Some(
                    [
                        ("Content-Type".to_string(), "application/json".to_string()),
                        ("Referer".to_string(), "https://music.163.com/".to_string()),
                    ]
                    .into_iter()
                    .collect(),
                ),
                body: None,
                timeout_ms: Some(15_000),
            }),
        )
        .await
        .expect("builtin_request 应成功");
        assert_eq!(res.status_code, 200, "上游接口应返回 200");
        assert!(
            res.headers.contains_key("content-type"),
            "响应头必须透传（酷我 Cookie 流程依赖）"
        );
        let playlists = res
            .body
            .get("playlists")
            .and_then(|v| v.as_array())
            .expect("JSON body 应包含 playlists 数组");
        assert!(!playlists.is_empty(), "歌单列表不应为空");
        let first = &playlists[0];
        assert!(first.get("id").is_some(), "歌单应有 id 字段");
    }
}
