//! 引擎 → 前端搜索桥（本地优先播放的池 C，DESIGN §7.13）。
//!
//! 背景：本地曲目打不开、本地曲库/账本/孤儿都没有替身时，最后一层是
//! 「在线搜一首同名的替身接着播」。搜索能力只在前端（脚本包线路），
//! 引擎侧没有搜索 Provider——和取链桥（playurl_bridge）同构。
//!
//! 就绪语义与取链桥共用：前端主窗口挂载后调 `script_bridge_ready`
//! 同时置位两座桥（见 commands.rs）；未就绪期间池 C 直接按「无替身」
//! 处理（启动恢复播放期不搜，本来也不该搜）。
//!
//! 与取链桥的差别（刻意简化）：
//! - **无单飞合并**：替身搜索一次播放只会发起一条，并发来自池 C 的
//!   调用方只有一个（LoadJob），没有「同键 N 个等待方」的合并需求；
//! - **超时 12s**：取链桥 14s 是因为要覆盖前端 9.5s 链预算 + 两次 IPC；
//!   搜索走 `searchAll` 聚合（包内预算，见 source-scripts/index.ts），12s
//!   已覆盖正常聚合往返，再大只是让「音源全灭」变成白等；
//! - **应答容忍**：前端异常 / 超时 / 空结果都折叠成 `None`（无替身），
//!   不区分「环境问题」与「搜不到」——池 C 本来就是最后一层兜底，
//!   两者的后续动作一样（播不了就报错），分级没有消费者。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use crate::provider::types::Track;
use tauri::{AppHandle, Emitter};

/// 前端就绪标志（与 playurl_bridge 分开置位但同一命令触发，见模块注释）。
static BRIDGE_READY: AtomicBool = AtomicBool::new(false);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// 在途请求表：request_id → 应答通道。应答迟到（超时后到达）时条目
/// 已被移除，直接丢弃（reply 查不到 id 就什么都不做，天然幂等）。
static PENDING: Mutex<Option<HashMap<u64, Pending>>> = Mutex::new(None);

struct Pending {
    tx: tokio::sync::oneshot::Sender<Vec<Track>>,
}

/// 前端挂载后置位（commands.rs `script_bridge_ready` 同时置两座桥）。
pub fn set_ready() {
    BRIDGE_READY.store(true, Ordering::Release);
}

fn is_ready() -> bool {
    BRIDGE_READY.load(Ordering::Acquire)
}

/// 引擎发给前端的替身搜索请求（前端用 `title singer` 调聚合搜索后
/// 按 requestId 应答；`duration_ms` 供前端记录日志，挑选在引擎侧做）。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchRequest {
    request_id: u64,
    title: String,
    singer: String,
    duration_ms: i64,
}

/// 前端应答入口（`search_substitute_reply` 命令）。
/// `tracks` 为空 = 搜不到 / 搜索失败，都按「无替身」处理。
pub fn reply(request_id: u64, tracks: Vec<Track>) {
    let pending = {
        let mut guard = match PENDING.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        match guard.as_mut() {
            Some(table) => table.remove(&request_id),
            None => None,
        }
    };
    if let Some(p) = pending {
        let _ = p.tx.send(tracks);
    }
}

/// 超时/发送失败时摘掉在途条目（等待方收通道关闭，按 None 处理）。
fn drop_pending(request_id: u64) {
    let mut guard = match PENDING.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if let Some(table) = guard.as_mut() {
        table.remove(&request_id);
    }
}

/// 等前端应答的上限（见模块注释的取值依据）。
const ASK_TIMEOUT: Duration = Duration::from_secs(12);

/// 池 C：问前端要一首在线替身。
/// `None` = 前端未就绪 / 发送失败 / 超时 / 搜不到（对调用方等价：
/// 池 C 无替身）。`Some(vec)` = 搜索结果（挑选逻辑在 local_first.rs
/// `pick_best_search`，这里只管搬运）。
pub async fn ask(app: &AppHandle, title: &str, singer: &str, duration_ms: i64) -> Option<Vec<Track>> {
    if !is_ready() {
        return None;
    }
    let request_id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = tokio::sync::oneshot::channel::<Vec<Track>>();
    {
        let mut guard = PENDING.lock().ok()?;
        let table = guard.get_or_insert_with(HashMap::new);
        // 容量护栏：在途搜索表不该有并发（LoadJob 串行），超了说明
        // 有调用方泄漏，硬上限防堆积
        if table.len() >= 8 {
            let oldest = *table.keys().min().unwrap_or(&0);
            table.remove(&oldest);
            log::warn!("[local-first] 替身搜索在途表已达上限，丢弃最旧一条（id={oldest}）");
        }
        table.insert(request_id, Pending { tx });
    }
    let payload = SearchRequest {
        request_id,
        title: title.to_string(),
        singer: singer.to_string(),
        duration_ms,
    };
    if let Err(e) = app.emit("search_substitute_request", &payload) {
        log::warn!("[local-first] 替身搜索请求发送失败: {e}");
        drop_pending(request_id);
        return None;
    }
    match tokio::time::timeout(ASK_TIMEOUT, rx).await {
        Ok(Ok(tracks)) => Some(tracks),
        Ok(Err(_)) => None,
        Err(_) => {
            log::warn!(
                "[local-first] 替身搜索应答超时（{}s），按无替身处理",
                ASK_TIMEOUT.as_secs()
            );
            drop_pending(request_id);
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_flag_defaults_false() {
        assert!(!is_ready());
        set_ready();
        assert!(is_ready());
    }

    /// 未知 id 的应答必须被静默容忍（前端迟到应答不应 panic）
    #[test]
    fn reply_unknown_id_is_ignored() {
        reply(987654321, vec![]);
    }
}
