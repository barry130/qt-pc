//! 引擎 → 前端取链桥。
//!
//! 背景：取链方案（scheme）只在前端生效——脚本包解析出的地址靠
//! `set_resolved_play_url` 预先写进 `PlayUrlCache`，引擎只在缓存命中时用。
//! 引擎主导的换歌（自然播完自动切歌、随机模式下一首、打开流失败后的重取）
//! 前端无法预判，缓存必然未命中。
//!
//! 本模块补上这条通道：引擎取链前发 `play_url_request` 事件问前端，
//! 前端脚本包解析后经 `resolve_play_url_reply` 应答；前端未就绪、应答
//! 超时或回空串时，本次取链失败（原生 Rust Provider 已删除，
//! 前端脚本线路是唯一的第三方取链路径）。
//!
//! 就绪语义：前端主窗口挂载后调 `script_bridge_ready` 置位。启动恢复
//! 播放等早于前端挂载的取链不等待、直接按失败处理。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use crate::provider::types::{Quality, Track};
use tauri::{AppHandle, Emitter};

/// 前端脚本桥是否已就绪（主窗口挂载后由 `script_bridge_ready` 置位）
static BRIDGE_READY: AtomicBool = AtomicBool::new(false);
/// 在途请求自增 id
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
/// request_id → 应答通道；应答迟到（超时后才回来）时条目已被移除，直接丢弃
static PENDING: Mutex<Option<HashMap<u64, tokio::sync::oneshot::Sender<String>>>> = Mutex::new(None);

/// 引擎等待前端应答的上限。
/// 2026-09-17 架构收敛后前端是「音质档内 ≤5 条线路 + 跨源」的聚合链，
/// VIP 歌要走完多级线路 + 跨源搜索，5s 预算不够（实测在 5s 整点成批失败），
/// 放宽到 15s；成功的前端预解析仍会先回填缓存，常态命中不受影响。
const ASK_TIMEOUT: Duration = Duration::from_secs(15);

/// 引擎发给前端脚本包的取链请求（track/quality 原样透传，
/// 前端用它调 `resolvePlayUrl` 后按 requestId 应答）。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayUrlRequest {
    request_id: u64,
    track: Track,
    quality: Quality,
}

/// 前端主窗口挂载后调用：置就绪标志
pub fn set_ready() {
    BRIDGE_READY.store(true, Ordering::Release);
}

fn is_ready() -> bool {
    BRIDGE_READY.load(Ordering::Acquire)
}

/// 前端应答入口（`resolve_play_url_reply` 命令）。空串 = 前端解析失败
/// 或脚本链整体无地址，本次取链按失败处理。
pub fn reply(request_id: u64, url: String) {
    let sender = {
        let mut guard = match PENDING.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        guard
            .as_mut()
            .and_then(|map| map.remove(&request_id))
    };
    if let Some(sender) = sender {
        let _ = sender.send(url);
    }
}

/// 引擎取链前问一次前端脚本线路。
/// 返回 `Some(url)` = 前端给出的播放地址；`None` = 未就绪 / 超时 / 空串，
/// 本次取链按失败处理。
pub async fn ask_frontend(app: &AppHandle, track: &Track, quality: Quality) -> Option<String> {
    if !is_ready() {
        return None;
    }
    let request_id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = tokio::sync::oneshot::channel();
    if let Ok(mut guard) = PENDING.lock() {
        guard
            .get_or_insert_with(HashMap::new)
            .insert(request_id, tx);
    } else {
        return None;
    }
    let payload = PlayUrlRequest {
        request_id,
        track: track.clone(),
        quality,
    };
    if let Err(e) = app.emit("play_url_request", &payload) {
        log::warn!("[playurl] 取链请求发送失败，本次取链按失败处理: {e}");
        if let Ok(mut guard) = PENDING.lock() {
            if let Some(map) = guard.as_mut() {
                map.remove(&request_id);
            }
        }
        return None;
    }
    match tokio::time::timeout(ASK_TIMEOUT, rx).await {
        Ok(Ok(url)) if !url.is_empty() => Some(url),
        Ok(Ok(_)) => None,  // 前端明确回空（scheme=rust / 解析失败）
        Ok(Err(_)) => None, // 应答通道被丢弃
        Err(_) => {
            log::warn!(
                "[playurl] 前端取链应答超时（{}s），本次取链按失败处理",
                ASK_TIMEOUT.as_secs()
            );
            if let Ok(mut guard) = PENDING.lock() {
                if let Some(map) = guard.as_mut() {
                    map.remove(&request_id);
                }
            }
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 未就绪时 ask 不发事件（无 AppHandle 可造，这里只验证标志语义与
    /// reply 对未知 id 的容忍）
    #[test]
    fn ready_flag_defaults_false() {
        assert!(!is_ready());
        set_ready();
        assert!(is_ready());
    }

    #[test]
    fn reply_unknown_id_is_ignored() {
        reply(987654321, "http://x".into());
    }
}
