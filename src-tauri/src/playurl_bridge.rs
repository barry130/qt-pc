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
//!
//! P2-5：在途请求表原来是"每个调用方一条 + 只靠超时清理"，
//! 前端长时间不响应期间会一直堆。现在：
//! - **同键单飞合并**：同一 `platform:trackId:quality` 的并发取链只发一次
//!   前端事件，多个调用方共享同一次应答（前端本来就是按 requestId 配对的
//!   一问一答，我们这边一个 id 挂 N 个等待方，谁也踩不掉谁）；
//! - **容量上限 32 条**：满了淘汰最旧的一条（它的等待方立刻按失败处理），
//!   保证表不会无限增长；
//! - **清理时机明确**：应答到达、事件发送失败、调用方超时、容量淘汰，
//!   四条路径都会把 `by_key` / `by_id` 两条记录一起摘掉。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::provider::types::{Quality, Track};
use tauri::{AppHandle, Emitter};

/// 前端脚本桥是否已就绪（主窗口挂载后由 `script_bridge_ready` 置位）
static BRIDGE_READY: AtomicBool = AtomicBool::new(false);
/// 在途请求自增 id
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// 在途取链表。
///
/// - `by_key`：单飞键（= 播放地址缓存的键，见 `PlayUrlCache::cache_key`）→ 在途请求；
/// - `by_id`：request_id → 单飞键，供 `reply` 反查。
///
/// 两条记录始终同生同死（`take_flight` / `evict_oldest` 是唯一的删除口）。
struct Pending {
    by_key: HashMap<String, Flight>,
    by_id: HashMap<u64, String>,
}

/// 一次在途的前端取链请求（一个 request_id = 一次 `play_url_request` 事件）
struct Flight {
    request_id: u64,
    /// 共享同一次应答的等待方；整批唤醒，被丢弃即"本次取链失败"
    waiters: Vec<tokio::sync::oneshot::Sender<(String, bool)>>,
    /// 建立时刻：超过 `ASK_TIMEOUT` 的在途请求已经注定失败，不再接受搭车
    started_at: Instant,
}

/// 在途请求（不同单飞键）上限。
///
/// 为什么是 32：引擎主导的换歌是单线程串行的，真实并发只有"当前播放 + 预取"
/// 个位数；32 已经高出一个数量级，超过它只可能是前端脚本包整体卡死/未响应。
/// 这时按"最旧"淘汰：最旧的本来就快超时了，牺牲它让最新的取链还有机会，
/// 同时保证表有硬上限（旧实现只有 15s 超时清理，长期不响应会一直堆）。
const MAX_INFLIGHT: usize = 32;

/// 在途请求全局表；应答迟到（超时后才回来）时条目已被移除，直接丢弃
static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

/// 引擎等待前端应答的上限。
///
/// **这里必须严格大于前端 `RESOLVE_TIMEOUT_MS`（现 9.5s）加两次 IPC 往返余量。**
/// 前端应答要走的完整路径是
///   引擎 → play_url_request → 前端 resolvePlayUrl → engineResolve
///   （等引擎窗口，见 qt-pc/src/source-engine/client.ts）→ set_resolved_play_url
///   → resolve_play_url_reply
/// 即"前端等引擎" + 两次 IPC 往返。两边相等就是零余量：只要引擎侧链预算被跑满，
/// 应答必然晚于本超时到达，被当成"前端没答"丢弃，慢但能成功的取链就一律变成
/// "该歌曲暂时无法播放"，连挂 5 首还会停掉自动切歌。
///
/// 取值 14s = 9.5s + 4.5s（两次 IPC + 引擎页调度抖动）。改 client.ts 的
/// `RESOLVE_TIMEOUT_MS` 时必须同步复核这里。
///
/// 为什么不再放大到 20s：链内真实预算只有 `CHAIN_BUDGET_MS = 9s` + 宽限 250ms
/// （= 9250ms，见 qt-sources/src/budget.ts），外层等 14s 已覆盖 9250ms 预算 +
/// 调度抖动。再大只是让「网络慢」变成「白等」——用户看到的是每首卡十几秒才失败，
/// 5 首就是一分钟起步，那正是弱网下「疯狂不可用」的手感来源。
const ASK_TIMEOUT: Duration = Duration::from_secs(14);

/// 引擎取链的结果（`ask_frontend` 的返回）。
///
/// 分级是弱网修复的关键（2026-10-03）：「等超时了」与「前端明确回空串」
/// 过去都压成 `Option::None`，引擎无从区分，于是把弱网超时记成
/// 「这首歌没有播放地址」并计入熔断，连挂 5 首把自动切歌关掉。
#[derive(Debug, PartialEq)]
pub enum AskOutcome {
    /// 前端给出了可播地址
    Url(String),
    /// 前端应答了，但脚本链整体没给出地址（音源确实没有 / 线路全灭）
    NoUrl,
    /// 等待超时 / 事件发不出去 / 前端未就绪 —— **环境问题，可能重试就好**
    Stalled,
}

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

/// 单飞键：与播放地址缓存同口径（platform:trackId:quality）。
/// 复用 `PlayUrlCache::cache_key` 是为了让"缓存未命中 → 问前端"和"同键合并"
/// 永远是同一个键，改一处不会漏另一处。
fn flight_key(track: &Track, quality: &Quality) -> String {
    crate::provider::url_cache::PlayUrlCache::cache_key(
        track.platform.as_str(),
        &track.id,
        crate::quality_str(quality),
    )
}

/// 摘掉一次在途请求（应答到达 / 超时 / 事件发送失败共用）。
///
/// 只认 `by_id` 里记着的那次 request_id：如果这条已经被淘汰、同键又新建了
/// 一次请求，旧调用方晚到的清理**不能**把新请求删掉（否则那个键会白等到 ASK_TIMEOUT）。
fn take_flight(table: &mut Pending, request_id: u64) -> Option<Flight> {
    let key = table.by_id.remove(&request_id)?;
    match table.by_key.get(&key) {
        Some(f) if f.request_id == request_id => table.by_key.remove(&key),
        _ => None,
    }
}

/// 容量满时淘汰最旧的一条在途请求（丢弃它的等待方 → 调用方立刻按失败处理）。
/// 用 `(started_at, request_id)` 排序而不是只看 `started_at`：
/// 同一微秒内建立的请求靠自增 id 兜底，淘汰结果确定（也可测）。
fn evict_oldest(table: &mut Pending) {
    let Some(oldest) = table
        .by_key
        .iter()
        .min_by_key(|(_, f)| (f.started_at, f.request_id))
        .map(|(k, _)| k.clone())
    else {
        return;
    };
    if let Some(flight) = table.by_key.remove(&oldest) {
        table.by_id.remove(&flight.request_id);
        log::warn!(
            "[playurl] 在途取链请求已达上限 {MAX_INFLIGHT}，淘汰最旧的一条 {oldest}（其调用方按取链失败处理）"
        );
        // flight 在这里 drop：它的等待方收到通道关闭，立刻按失败处理
    }
}

/// 登记一次取链请求。返回 `(request_id, 是否需要自己发事件)`：
/// 同键已有在途请求时挂到它下面搭车（返回 `false`，不再发第二个事件）。
/// `None` = 全局表锁不可用（持锁线程 panic 过），本次取链按失败处理。
fn register(key: String, tx: tokio::sync::oneshot::Sender<(String, bool)>) -> Option<(u64, bool)> {
    let mut guard = PENDING.lock().ok()?;
    let table = guard.get_or_insert_with(|| Pending {
        by_key: HashMap::new(),
        by_id: HashMap::new(),
    });
    let now = Instant::now();
    if !table.by_key.contains_key(&key) && table.by_key.len() >= MAX_INFLIGHT {
        evict_oldest(table);
    }
    if let Some(flight) = table.by_key.get_mut(&key) {
        if flight.started_at.elapsed() < ASK_TIMEOUT {
            // 搭车：共享同一次前端应答
            flight.waiters.push(tx);
            return Some((flight.request_id, false));
        }
    }
    // 走到这里：要么本来没有在途请求，要么是一条死条目
    //（持有它的那次 ask 任务被取消，没人来清理）。死条目不能永久挡住这个键，
    // 连同它的等待方一起作废后重建。
    if let Some(stale) = table.by_key.remove(&key) {
        log::warn!("[playurl] 在途取链请求已超过等待上限，丢弃并重建: {key}");
        table.by_id.remove(&stale.request_id);
        // stale 在这里 drop：它的等待方收到通道关闭，按取链失败处理
        drop(stale);
    }
    let request_id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    table.by_id.insert(request_id, key.clone());
    table.by_key.insert(
        key,
        Flight {
            request_id,
            waiters: vec![tx],
            started_at: now,
        },
    );
    Some((request_id, true))
}

/// 摘掉整条在途请求（连同其它搭车的等待方）：超时 / 发送失败时用。
fn drop_flight(request_id: u64) {
    let flight = {
        let mut guard = match PENDING.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        match guard.as_mut() {
            Some(table) => take_flight(table, request_id),
            None => None,
        }
    };
    // flight 被 drop：搭车的等待方收到通道关闭，按取链失败处理
    drop(flight);
}

/// 前端应答入口（`resolve_play_url_reply` 命令）。
///
/// 空串 = 前端解析失败或脚本链整体无地址；`stalled` = 该失败是环境问题
/// （弱网/引擎未就绪），不是「这首歌没有地址」。同键搭车的所有等待方拿到
/// 同一个应答 —— 包括 stalled 标记：它们等的是同一次解析，结论必然一致。
pub fn reply(request_id: u64, url: String, stalled: bool) {
    let flight = {
        let mut guard = match PENDING.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        match guard.as_mut() {
            Some(table) => take_flight(table, request_id),
            None => None,
        }
    };
    if let Some(flight) = flight {
        // 一个 id 对应 N 个调用方：整批发出，单飞合并在这里收口
        for sender in flight.waiters {
            let _ = sender.send((url.clone(), stalled));
        }
    }
}

/// 引擎取链前问一次前端脚本线路。
/// 返回分级结果：地址 / 明确无地址 / 等待超时（见 `AskOutcome`）。
pub async fn ask_frontend(app: &AppHandle, track: &Track, quality: Quality) -> AskOutcome {
    if !is_ready() {
        // 前端主窗口还没挂载：这是启动期的正常状态，不是「这首歌没地址」，
        // 也不能计入熔断（否则冷启动弱网会一路熔断到停止自动切歌）。
        return AskOutcome::Stalled;
    }
    let key = flight_key(track, &quality);
    let (tx, rx) = tokio::sync::oneshot::channel::<(String, bool)>();
    let (request_id, need_emit) = match register(key, tx) {
        Some(v) => v,
        // 全局表锁不可用（持锁线程 panic 过）：同样按环境问题处理，不算内容失败
        None => return AskOutcome::Stalled,
    };
    if need_emit {
        let payload = PlayUrlRequest {
            request_id,
            track: track.clone(),
            quality,
        };
        if let Err(e) = app.emit("play_url_request", &payload) {
            log::warn!("[playurl] 取链请求发送失败，本次取链按失败处理: {e}");
            // 事件都没发出去：整条作废（搭车的等待方同样按失败处理）
            drop_flight(request_id);
            return AskOutcome::Stalled;
        }
    }
    match tokio::time::timeout(ASK_TIMEOUT, rx).await {
        // 前端带了 stalled 标记上来：它已判定这是环境问题，优先采信
        Ok(Ok((url, true))) if !url.is_empty() => AskOutcome::Url(url),
        Ok(Ok((_, true))) => AskOutcome::Stalled,
        Ok(Ok((url, false))) if !url.is_empty() => AskOutcome::Url(url),
        // 前端明确回空且没标 stalled：脚本链跑完了但没给出地址 —— 这才是「歌没地址」
        Ok(Ok(_)) => AskOutcome::NoUrl,
        // 应答通道被丢弃（超时清理 / 容量淘汰 / 同键已作废）：环境问题
        Ok(Err(_)) => AskOutcome::Stalled,
        Err(_) => {
            log::warn!(
                "[playurl] 前端取链应答超时（{}s），本次取链按环境问题处理（不计入熔断）",
                ASK_TIMEOUT.as_secs()
            );
            // 超时清理：正常情况下最早超时的是发起那条 ask（事件就是它发的），
            // 它会连带唤醒同键搭车的等待方；如果发起方任务被取消没人清理，
            // 搭车方超时也会摘掉这条，绝不会留下永久挡路的死条目
            //（take_flight 核对 request_id，不会误删同键的新请求）。
            drop_flight(request_id);
            AskOutcome::Stalled
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 在途表是进程级静态：并发跑的测试必须串行访问它，
    /// 否则"容量淘汰"测试会把别的测试正在等的在途请求当成最旧淘汰掉。
    static TABLE_LOCK: Mutex<()> = Mutex::new(());

    fn lock_table() -> std::sync::MutexGuard<'static, ()> {
        TABLE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

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
        let _table = lock_table();
        reply(987654321, "http://x".into(), false);
    }

    /// 同键并发取链合并成一次前端请求，应答整批发给所有等待方
    #[test]
    fn same_key_merges_into_one_flight() {
        let _table = lock_table();
        let (tx1, mut rx1) = tokio::sync::oneshot::channel::<(String, bool)>();
        let (tx2, mut rx2) = tokio::sync::oneshot::channel::<(String, bool)>();
        let (id1, emit1) = register("t-merge:a".into(), tx1).expect("register");
        let (id2, emit2) = register("t-merge:a".into(), tx2).expect("register");
        assert!(emit1, "第一个调用方负责发事件");
        assert!(!emit2, "同键第二个调用方搭车，不能再发一个事件");
        assert_eq!(id1, id2, "两个调用方共享同一个 request_id（前端按它配对）");
        reply(id1, "http://u".into(), false);
        assert_eq!(rx1.try_recv().expect("第一个等待方").0, "http://u");
        assert_eq!(rx2.try_recv().expect("搭车的等待方").0, "http://u");
    }

    /// 清理（超时 / 发送失败）会整条作废，之后同键可以重新建一条新请求
    #[test]
    fn drop_flight_clears_table_and_allows_new_request() {
        let _table = lock_table();
        let (tx1, mut rx1) = tokio::sync::oneshot::channel::<(String, bool)>();
        let (tx2, mut rx2) = tokio::sync::oneshot::channel::<(String, bool)>();
        let (id1, _) = register("t-drop:a".into(), tx1).expect("register");
        register("t-drop:a".into(), tx2).expect("register");
        drop_flight(id1);
        assert!(rx1.try_recv().is_err(), "发起方等待被唤醒为失败");
        assert!(rx2.try_recv().is_err(), "搭车方同样立刻失败");
        // 作废后同键可重建，且是新的 request_id
        let (tx3, mut rx3) = tokio::sync::oneshot::channel::<(String, bool)>();
        let (id3, emit3) = register("t-drop:a".into(), tx3).expect("register");
        assert!(emit3, "旧条目已清理，新请求必须重新发事件");
        assert_ne!(id3, id1);
        reply(id3, "http://new".into(), false);
        assert_eq!(rx3.try_recv().expect("新请求应答").0, "http://new");
        // 迟到的旧 id 应答：条目已不在，静默丢弃（不得影响新请求）
        reply(id1, "http://late".into(), false);
        assert!(rx3.try_recv().is_err(), "新请求不会收到旧 id 的应答");
    }

    /// 表满时淘汰最旧的一条，新的请求仍然能正常应答
    #[test]
    fn capacity_evicts_oldest_flight() {
        let _table = lock_table();
        let mut waiting = Vec::new();
        let mut first_id = 0u64;
        for i in 0..MAX_INFLIGHT {
            let (tx, rx) = tokio::sync::oneshot::channel::<(String, bool)>();
            let (id, _) = register(format!("t-cap:{i}"), tx).expect("register");
            if i == 0 {
                first_id = id;
            }
            waiting.push(rx);
        }
        assert_eq!(
            PENDING.lock().unwrap().as_ref().unwrap().by_key.len(),
            MAX_INFLIGHT
        );
        let (tx, mut rx) = tokio::sync::oneshot::channel::<(String, bool)>();
        let (last_id, emit) = register("t-cap:new".into(), tx).expect("register");
        assert!(emit);
        assert!(
            waiting[0].try_recv().is_err(),
            "最旧的在途请求被淘汰，其调用方立刻按失败处理"
        );
        {
            let guard = PENDING.lock().unwrap();
            let table = guard.as_ref().unwrap();
            assert_eq!(table.by_key.len(), MAX_INFLIGHT, "淘汰后仍然守着上限");
            assert!(
                !table.by_id.contains_key(&first_id),
                "淘汰项的 id 索引也清掉"
            );
        }
        reply(last_id, "http://ok".into(), false);
        assert_eq!(rx.try_recv().expect("新请求应答").0, "http://ok");
    }

    /// 发起方任务被取消留下的死条目不会被无限复用：超过等待上限后同键重建
    #[test]
    fn stale_flight_is_rebuilt() {
        let _table = lock_table();
        let (tx1, mut rx1) = tokio::sync::oneshot::channel::<(String, bool)>();
        let (id1, _) = register("t-stale:a".into(), tx1).expect("register");
        {
            let mut guard = PENDING.lock().unwrap();
            let flight = guard
                .as_mut()
                .unwrap()
                .by_key
                .get_mut("t-stale:a")
                .expect("flight exists");
            flight.started_at = Instant::now() - ASK_TIMEOUT - Duration::from_secs(1);
        }
        let (tx2, mut rx2) = tokio::sync::oneshot::channel::<(String, bool)>();
        let (id2, emit2) = register("t-stale:a".into(), tx2).expect("register");
        assert!(emit2, "死条目要被重建，新请求必须自己发事件");
        assert_ne!(id1, id2);
        assert!(rx1.try_recv().is_err(), "旧等待方被唤醒为失败");
        reply(id2, "http://fresh".into(), false);
        assert_eq!(rx2.try_recv().expect("新请求应答").0, "http://fresh");
    }
}
