//! 歌单封面清除的"云端 / 本地缓存"接缝（C13）。
//!
//! 旧实现（`commands.rs::cmd_clear_playlist_cover`）只删本地封面文件并请求云端清除，
//! 没有同步 `liked_playlists.pic_url` 这份"卡片缓存" —— 云端清掉后 UI 仍会回落到
//! 旧的共享封面 URL。这里把"云清除 + 缓存失效"的顺序与错误分类提取成公开 helper：
//!
//! - `clear`：调用方绑定真实 Astral 请求（`astral.cover_clear`），成功才算云端已清；
//! - `invalidate`：调用方绑定当前 DB / 缓存更新（通常是 `set_liked_playlist_pic(..., "")`）。
//!
//! **错误语义**：云清除失败 → `Err`（缓存保持原样）；云清除成功但缓存失效失败 →
//! `Ok(CloudCoverClear { cache_error: Some(_) })`，由调用方单独展示，不能谎称云端没清。
//!
//! 本模块不持有 DB、不联网、不加依赖：只负责顺序和错误分类，便于在中央接线前
//! 用真实 DB + fake 网络回调做回归。

use std::future::Future;

/// 云封面清除结果。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CloudCoverClear {
    /// 云端已清除、但本地缓存失效失败时的错误；`None` 表示两边都成功。
    ///
    /// 与 `Err` 分开：调用方不能把它当成"云端没清"，否则 UI 会显示假的云失败。
    pub cache_error: Option<String>,
}

/// 清除云端封面并让本地卡片缓存失效（C13）。
///
/// `clear`：真实云端清除请求；`invalidate`：清掉本地缓存（通常是
/// `liked_playlists.pic_url`）。本函数不持有 DB、不联网，只负责顺序与错误分类。
///
/// 云清除成功后调用 `invalidate` 清本地缓存；缓存失效失败放进
/// `cache_error`，整体仍返回 `Ok`，不谎报云端失败。
pub async fn clear_cloud_cover<C, F, I>(clear: C, invalidate: I) -> Result<CloudCoverClear, String>
where
    C: FnOnce() -> F,
    F: Future<Output = Result<(), String>>,
    I: FnOnce() -> Result<(), String>,
{
    let _ = invalidate;
    clear().await?;
    // 云清除已成功；本地缓存失效失败只进 `cache_error`，
    // 不能把 DB 失效失败谎报成云端清除失败。
    let cache_error = invalidate().err();
    Ok(CloudCoverClear { cache_error })
}

/// 判定一个歌单是否允许参与云端同步（C12）。
///
/// 智能歌单是纯本地视图（DESIGN §R66）：规则只存在本机，单条 metadata push
/// 与云端 apply 都不能把它当普通收藏歌单发出去。`platform` 与 `pid` 一起定位：
/// - `local` 平台：`pid` 是 `playlists.pid`（对外唯一标识；`id` 只是本地主键），
///   命中且 `is_smart = 1` 时返回 `false`；
/// - 其它平台：那是云端收藏歌单卡片，本机恰好有同 id 的智能歌单与它无关，允许同步；
/// - 本机没有这条歌单（例如云端新导入的卡片）：没有本地智能标记，允许同步。
///
/// 实现：只有 `local` 平台会去查本机 `playlists.is_smart`，其它平台一律允许；
/// 查不到行（missing）按"没有智能标记"处理，允许导入。
/// DB 错误必须原样返回 `Err`，不能被当成"允许同步"。
///
/// 调用方：push helper 用 `db.with(|conn| playlist_can_sync(conn, platform, pid))`；
/// apply 已经在 `conn` 锁内，直接调用，不要再套一层 `db.with`（会死锁）。
pub fn playlist_can_sync(
    conn: &rusqlite::Connection,
    platform: &str,
    pid: &str,
) -> rusqlite::Result<bool> {
    if platform != crate::db::store::LOCAL_PLATFORM {
        return Ok(true);
    }
    let smart: i64 = match conn.query_row(
        // `playlists.id` 是纯本地主键（pl_…），对外/云端一律用 `pid`（UUID）；
        // 调用方传进来的就是 pid，别拿它去比 id。
        "SELECT COALESCE(is_smart, 0) FROM playlists WHERE pid = ?1",
        rusqlite::params![pid],
        |row| row.get(0),
    ) {
        Ok(value) => value,
        // 本机没有这条歌单：没有智能标记，允许云端卡片导入。
        Err(rusqlite::Error::QueryReturnedNoRows) => 0,
        Err(error) => return Err(error),
    };
    Ok(smart == 0)
}

/// 过滤离线队列里的歌单 metadata 操作（C12 的遗留队列接缝）。
///
/// `like_flush_pending` 读出的旧 op 可能入队于智能歌单规则生效之前：payload 带着
/// 本地智能歌单的 pid，直接重放会给云端建出空卡片。这里在 flush 的数据库段把
/// "确定不该发"的 op 一并 ack（同样清 `pending_like_targets`），返回其余待发 op。
///
/// 行为约定：
/// - 有效本地智能歌单：ack + drop（规则永久不上云，留着只会无限积压）；
/// - 普通 / foreign / missing：保留，照旧交给发送路径；
/// - payload 不是 JSON 对象或缺 `platform` / `pid`：保留，由既有损坏退避路径处理；
/// - DB 错误原样返回 `Err`，不能默默当成"允许发送"。
///
/// 调用方：Root 在 `like_flush_pending` 的单个 `spawn_blocking` +
/// `with_like_session_epoch` 内调用（DB 锁已在手，不要再套 `db.with`）。
pub fn filter_pending_cloud_ops(
    conn: &rusqlite::Connection,
    ops: Vec<crate::db::store::PendingLikeOp>,
) -> rusqlite::Result<Vec<crate::db::store::PendingLikeOp>> {
    let mut kept = Vec::with_capacity(ops.len());
    for op in ops {
        // 只有歌单 metadata 需要按智能标记过滤；歌曲 op 原样保留。
        if op.kind != "playlist" {
            kept.push(op);
            continue;
        }
        // 解析不出对象 / 缺 platform、pid：无法判定，保留给既有损坏退避路径。
        let Ok(body) = serde_json::from_str::<serde_json::Value>(&op.payload_json) else {
            kept.push(op);
            continue;
        };
        let (Some(platform), Some(pid)) = (
            body.get("platform").and_then(|value| value.as_str()),
            body.get("pid").and_then(|value| value.as_str()),
        ) else {
            kept.push(op);
            continue;
        };
        if playlist_can_sync(conn, platform, pid)? {
            kept.push(op);
        } else {
            // 有效本地智能歌单：规则永久不上云，ack 掉避免无限积压。
            crate::db::store::ack_pending_like_op(conn, &op.id)?;
        }
    }
    Ok(kept)
}

/// 一次按真实歌单状态捕获的不可变云同步资格（C12）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PlaylistSyncPermit {
    allowed: bool,
}

impl PlaylistSyncPermit {
    pub fn allowed(self) -> bool {
        self.allowed
    }
}

/// 在调用方已持有的 DB 锁中捕获资格；错误必须原样返回，不能默认放行。
pub fn capture_playlist_permit(
    conn: &rusqlite::Connection,
    platform: &str,
    pid: &str,
) -> rusqlite::Result<PlaylistSyncPermit> {
    Ok(PlaylistSyncPermit {
        allowed: playlist_can_sync(conn, platform, pid)?,
    })
}

/// 共用短同步副作用闸门；调用方在回调中构造 future，仅 Some 时 await。
pub fn run_if_allowed<T>(permit: PlaylistSyncPermit, effect: impl FnOnce() -> T) -> Option<T> {
    permit.allowed().then(effect)
}

/// 本地 metadata mutation 的生产接缝；调用方已持有 State→DB 锁。
/// 结果与同步上下文一并返回，异步发送阶段不再重做本地 mutation。
pub fn prepare_playlist_metadata<T>(
    conn: &rusqlite::Connection,
    platform: &str,
    pid: &str,
    mutate: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T>,
) -> rusqlite::Result<(T, Option<PlaylistSyncPermit>)> {
    let permit = capture_playlist_permit(conn, platform, pid)?;
    Ok((mutate(conn)?, Some(permit)))
}

/// shared push 的惰性许可解析接缝；已有许可时不得执行 late lookup。
pub fn resolve_playlist_permit<E>(
    permit: Option<PlaylistSyncPermit>,
    capture: impl FnOnce() -> Result<PlaylistSyncPermit, E>,
) -> Result<PlaylistSyncPermit, E> {
    match permit {
        Some(permit) => Ok(permit),
        None => capture(),
    }
}

/// 删除本地歌单并返回删除前捕获的云同步资格（C12）。
/// 调用方已持有 State→DB 锁；不得在内部重新取得 State 或 DB。
pub fn delete_playlist_and_capture_permit(
    conn: &rusqlite::Connection,
    pid: &str,
) -> rusqlite::Result<PlaylistSyncPermit> {
    let tx = conn.unchecked_transaction()?;
    let permit = capture_playlist_permit(&tx, crate::db::store::LOCAL_PLATFORM, pid)?;
    let pending = crate::db::store::list_pending_like_ops(&tx)?;
    filter_pending_cloud_ops(&tx, pending)?;
    crate::db::store::delete_playlist(&tx, pid)?;
    tx.commit()?;
    Ok(permit)
}

/// 对账云快照缺失的收藏卡片；调用方已持有 State→DB 锁（C12）。
/// `true` 才计入实际移除数量和成员补推排除集；DB 错误不伪装成移除成功。
pub fn remove_card_absent_from_cloud(
    conn: &rusqlite::Connection,
    platform: &str,
    pid: &str,
) -> rusqlite::Result<bool> {
    if !playlist_can_sync(conn, platform, pid)? {
        return Ok(false);
    }
    if platform == crate::db::store::LOCAL_PLATFORM {
        crate::db::store::delete_playlist_follow_cloud(conn, pid)?;
    } else {
        crate::db::store::remove_liked_playlist(conn, platform, pid)?;
    }
    Ok(true)
}

/// 对账 confirmed 删除的真实双层结果接缝。
/// 仅阻塞任务及 State→DB 删除均成功后计数；任一错误原样返回，
/// 由生产调用方的 `?` 终止整轮，不得进入后续成员 backfill。
pub fn finish_confirmed_delete(
    result: Result<Result<(), String>, String>,
    removed: &mut u32,
) -> Result<(), String> {
    result??;
    *removed += 1;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use crate::db::{store, Database};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    #[test]
    fn confirmed_delete_success_and_task_errors_preserve_natural_results() {
        let (dir, db) = temp_db("confirmed-delete-result-compat");
        let pid = db.with(|conn| {
            let pid = store::create_playlist(conn, "正常 confirmed 删除")?;
            store::mark_playlist_cloud_seq(conn, &pid, 9)?;
            Ok::<_, rusqlite::Error>(pid)
        }).unwrap();
        let deletion = db.with(|conn| store::delete_playlist_follow_cloud(conn, &pid));
        let mut removed = 0;
        let backfill_calls = std::cell::Cell::new(0usize);
        let round = finish_confirmed_delete(Ok(deletion), &mut removed).map(|()| {
            backfill_calls.set(backfill_calls.get() + 1);
        });
        assert!(round.is_ok());
        assert_eq!(removed, 1);
        assert_eq!(backfill_calls.get(), 1);
        assert!(!db.with(|conn| store::playlist_pid_exists(conn, &pid)).unwrap());

        // Fake blocking/native-owner error boundaries preserve the exact error.
        type NativeDeleteResult = Result<Result<(), String>, String>;
        let failures: [(NativeDeleteResult, &str); 2] = [
            (Err("synthetic-blocking-task-failure".into()), "synthetic-blocking-task-failure"),
            (Ok(Err("synthetic-native-owner-revoked".into())), "synthetic-native-owner-revoked"),
        ];
        for (result, message) in failures {
            let round = finish_confirmed_delete(result, &mut removed).map(|()| {
                backfill_calls.set(backfill_calls.get() + 1);
            });
            assert_eq!(round, Err(message.to_string()));
            assert_eq!(removed, 1, "错误不能增加已成功删除的累计数");
            assert_eq!(backfill_calls.get(), 1, "错误不能进入本轮后续 backfill");
        }
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn confirmed_delete_sql_failure_stops_the_round_without_count_or_backfill() {
        let (dir, db) = temp_db("confirmed-delete-abort");
        let pid = db.with(|conn| {
            let pid = store::create_playlist(conn, "云端已确认的普通歌单")?;
            store::mark_playlist_cloud_seq(conn, &pid, 42)?;
            conn.execute_batch(
                "CREATE TRIGGER synthetic_confirmed_delete_failure BEFORE DELETE ON playlists
                 BEGIN SELECT RAISE(ABORT, 'synthetic-confirmed-delete-failure'); END;",
            )?;
            Ok::<_, rusqlite::Error>(pid)
        }).expect("真实迁移DB、confirmed 普通歌单及实际 DELETE ABORT 边界");
        let rows = db.with(store::list_playlist_sync_rows).unwrap();
        assert!(rows.iter().any(|(p, seq)| p == &pid && *seq == Some(42)));

        // Same SQL deletion and two-layer result passed by the production caller.
        let deletion = db.with(|conn| store::delete_playlist_follow_cloud(conn, &pid));
        assert!(deletion.as_ref().unwrap_err().contains("synthetic-confirmed-delete-failure"));
        let mut removed = 0;
        let backfill_calls = std::cell::Cell::new(0usize);
        let round = finish_confirmed_delete(Ok(deletion), &mut removed).map(|()| {
            // Only the external backfill boundary is fake; never issue production HTTP.
            backfill_calls.set(backfill_calls.get() + 1);
        });
        let exists = db.with(|conn| store::playlist_pid_exists(conn, &pid)).unwrap();
        assert!(
            round.is_err() && removed == 0 && backfill_calls.get() == 0 && exists,
            "confirmed delete failure was reported as success: round={round:?}, removed={removed}, backfill_calls={}, exists={exists}",
            backfill_calls.get(),
        );
        assert!(round.unwrap_err().contains("synthetic-confirmed-delete-failure"));
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn metadata_prepare_preserves_favorite_and_unfavorite_for_each_playlist_kind() {
        let (dir, db) = temp_db("metadata-favorite-compatibility");
        let (ordinary_pid, smart_pid) = db.with(|conn| {
            let ordinary = store::create_playlist(conn, "普通本地歌单")?;
            let smart = crate::smart_playlist::create_smart_playlist(
                conn, "本地智能歌单", &crate::smart_playlist::SmartRules::default(),
                None, "added_desc",
            )?;
            Ok::<_, rusqlite::Error>((ordinary, smart))
        }).unwrap();
        let cases = [
            (store::LOCAL_PLATFORM, ordinary_pid.as_str(), true),
            ("foreign-source", smart_pid.as_str(), true),
            (store::LOCAL_PLATFORM, "missing-cloud-card", true),
            (store::LOCAL_PLATFORM, smart_pid.as_str(), false),
        ];
        for (platform, pid, may_sync) in cases {
            let (_, favorite_permit) = db.with(|conn| {
                prepare_playlist_metadata(conn, platform, pid, |conn| {
                    store::add_liked_playlist(conn, platform, pid, "合法本地收藏", None, "23")
                })
            }).unwrap();
            assert!(db.with(|conn| store::is_liked_playlist(conn, platform, pid)).unwrap());
            let (_, unfavorite_permit) = db.with(|conn| {
                prepare_playlist_metadata(conn, platform, pid, |conn| {
                    store::remove_liked_playlist(conn, platform, pid)
                })
            }).unwrap();
            assert!(!db.with(|conn| store::is_liked_playlist(conn, platform, pid)).unwrap());
            for (action, permit) in [("add", favorite_permit), ("remove", unfavorite_permit)] {
                let late_lookups = AtomicUsize::new(0);
                let resolved = resolve_playlist_permit(permit, || {
                    late_lookups.fetch_add(1, Ordering::SeqCst);
                    db.with(|conn| capture_playlist_permit(conn, platform, pid))
                }).unwrap();
                let sends = AtomicUsize::new(0);
                let dispatched = run_if_allowed(resolved, || {
                    sends.fetch_add(1, Ordering::SeqCst);
                    action
                });
                assert_eq!(dispatched, may_sync.then_some(action), "{platform}/{pid}/{action}");
                assert_eq!(sends.load(Ordering::SeqCst), usize::from(may_sync));
                assert_eq!(late_lookups.load(Ordering::SeqCst), 0);
            }
        }
        assert!(db.with(|conn| crate::smart_playlist::smart_playlist(conn, &smart_pid))
            .unwrap().is_some(), "合法本地收藏/取消收藏不得破坏智能规则");
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn prepared_smart_metadata_cannot_send_after_a_same_session_delete() {
        let (dir, db) = temp_db("metadata-delete-race");
        let pid = db.with(|conn| {
            crate::smart_playlist::create_smart_playlist(
                conn, "原智能名称", &crate::smart_playlist::SmartRules::default(),
                None, "added_desc",
            )
        }).expect("建立真实智能歌单");
        let (touched, permit) = db.with(|conn| {
            prepare_playlist_metadata(conn, store::LOCAL_PLATFORM, &pid, |conn| {
                if store::adopt_card_playlist(conn, &pid)? == 0 {
                    return Ok(0usize);
                }
                store::rename_playlist(conn, &pid, "本地新智能名称")
            })
        }).expect("实际生产 prepare 内完成本地 rename");
        assert_eq!(touched, 1);
        let meta = db.with(|conn| crate::smart_playlist::smart_playlist(conn, &pid))
            .unwrap().unwrap();
        assert_eq!(meta.name, "本地新智能名称", "智能歌单仍能合法本地改名");

        // 同一 DB、没有换号或生命周期变化：真实 local delete 发生在 prepare 和 dispatch 之间。
        db.with(|conn| delete_playlist_and_capture_permit(conn, &pid))
            .expect("经过真实用户删除接缝");
        assert!(!db.with(|conn| store::playlist_pid_exists(conn, &pid)).unwrap());
        let late_lookups = AtomicUsize::new(0);
        let resolved = resolve_playlist_permit(permit, || {
            late_lookups.fetch_add(1, Ordering::SeqCst);
            db.with(|conn| capture_playlist_permit(conn, store::LOCAL_PLATFORM, &pid))
        }).expect("实际 shared push resolver");
        let cloud_calls = AtomicUsize::new(0);
        let effect = run_if_allowed(resolved, || {
            // fake 云适配器只记录出站和模拟失败入队，绝不请求网络。
            cloud_calls.fetch_add(1, Ordering::SeqCst);
            let body = serde_json::json!({
                "platform": store::LOCAL_PLATFORM, "pid": pid,
                "action": "add", "name": "本地新智能名称",
            });
            db.with(|conn| store::enqueue_pending_like_op(
                conn, "playlist", "add",
                &format!("playlist:{}:{pid}", store::LOCAL_PLATFORM), &body.to_string(),
            )).expect("fake 失败适配器的真实 pending 边界");
        });
        let pending = db.with(store::list_pending_like_ops).unwrap();
        assert!(
            effect.is_none() && cloud_calls.load(Ordering::SeqCst) == 0
                && late_lookups.load(Ordering::SeqCst) == 0 && pending.is_empty(),
            "prepared smart metadata escaped after deletion: cloud_calls={}, late_lookups={}, pending={}",
            cloud_calls.load(Ordering::SeqCst), late_lookups.load(Ordering::SeqCst), pending.len(),
        );
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn cloud_absence_keeps_smart_playlist_rules_legacy_card_and_pending() {
        let (dir, db) = temp_db("reconcile-smart-card");
        let rules = crate::smart_playlist::SmartRules {
            match_all: false,
            rules: vec![crate::smart_playlist::SmartRule {
                field: "title".to_owned(),
                op: "contains".to_owned(),
                value: "saved local filter".to_owned(),
            }],
        };
        let pid = db
            .with(|conn| {
                let pid = crate::smart_playlist::create_smart_playlist(
                    conn, "保留智能视图", &rules, Some(12), "added_desc",
                )?;
                store::add_liked_playlist(
                    conn, store::LOCAL_PLATFORM, &pid, "遗留智能卡片",
                    Some("synthetic-local-cover"), "0",
                )?;
                let body = serde_json::json!({
                    "platform": store::LOCAL_PLATFORM,
                    "pid": pid,
                    "action": "add",
                    "name": "遗留智能卡片",
                });
                store::enqueue_pending_like_op(
                    conn, "playlist", "add",
                    &format!("playlist:{}:{pid}", store::LOCAL_PLATFORM),
                    &body.to_string(),
                )?;
                Ok::<_, rusqlite::Error>(pid)
            })
            .expect("真实迁移 DB 中建立智能规则、legacy 卡片与旧 pending");
        let observe = || {
            db.with(|conn| {
                let meta = serde_json::to_value(
                    crate::smart_playlist::smart_playlist(conn, &pid)?,
                ).unwrap();
                let cards = serde_json::to_value(store::list_liked_playlists(conn)?).unwrap();
                let pending: Vec<_> = store::list_pending_like_ops(conn)?
                    .into_iter()
                    .map(|op| (op.id, op.kind, op.action, op.payload_json))
                    .collect();
                let mut stmt = conn.prepare(
                    "SELECT target_key, target_id FROM pending_like_targets ORDER BY target_key",
                )?;
                let targets = stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?.collect::<rusqlite::Result<Vec<_>>>()?;
                Ok::<_, rusqlite::Error>((meta, cards, pending, targets))
            }).expect("观察实际本地规则、卡片和两张 pending 表")
        };
        let before = observe();
        let removed = db.with(|conn| {
            remove_card_absent_from_cloud(conn, store::LOCAL_PLATFORM, &pid)
        }).expect("经过实际生产对账删除接缝");
        let exists = db.with(|conn| store::playlist_pid_exists(conn, &pid)).unwrap();
        let after = observe();
        assert!(
            !removed && exists && after == before,
            "cloud absence deleted local smart data: removed={removed}, exists={exists}, meta={}, cards={}",
            after.0, after.1,
        );
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn deleted_smart_playlist_never_sends_or_replays_cloud_metadata() {
        let (dir, db) = temp_db("delete-smart-permit");
        let (smart_pid, normal_pid) = db
            .with(|conn| {
                let smart_pid = crate::smart_playlist::create_smart_playlist(
                    conn,
                    "智能歌单",
                    &crate::smart_playlist::SmartRules::default(),
                    None,
                    "added_desc",
                )?;
                let normal_pid = store::create_playlist(conn, "普通歌单")?;
                for (pid, name) in [(&smart_pid, "智能歌单"), (&normal_pid, "普通歌单")] {
                    let body = serde_json::json!({
                        "action": "add",
                        "pid": pid,
                        "platform": store::LOCAL_PLATFORM,
                        "name": name,
                    });
                    store::enqueue_pending_like_op(
                        conn,
                        "playlist",
                        "add",
                        &format!("playlist:{}:{pid}", store::LOCAL_PLATFORM),
                        &body.to_string(),
                    )?;
                }
                Ok::<_, rusqlite::Error>((smart_pid, normal_pid))
            })
            .expect("建立真实歌单和旧待发操作");

        let permit = db
            .with(|conn| delete_playlist_and_capture_permit(conn, &smart_pid))
            .expect("经过生产删除与资格捕获接缝");
        assert!(!db
            .with(|conn| store::playlist_pid_exists(conn, &smart_pid))
            .unwrap());
        let cloud_calls = AtomicUsize::new(0);
        run_if_allowed(permit, || cloud_calls.fetch_add(1, Ordering::SeqCst));
        assert_eq!(
            cloud_calls.load(Ordering::SeqCst),
            0,
            "删除后也不得发送智能歌单的云 metadata"
        );

        let pending = db.with(store::list_pending_like_ops).unwrap();
        assert_eq!(pending.len(), 1, "删除前须同时清掉智能歌单旧待发操作");
        let body: serde_json::Value = serde_json::from_str(&pending[0].payload_json).unwrap();
        assert_eq!(body["pid"].as_str(), Some(normal_pid.as_str()));
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn failed_playlist_delete_preserves_playlist_and_pending_operation() {
        let (dir, db) = temp_db("delete-smart-rollback");
        let pid = db
            .with(|conn| {
                let pid = crate::smart_playlist::create_smart_playlist(
                    conn,
                    "回滚智能歌单",
                    &crate::smart_playlist::SmartRules::default(),
                    None,
                    "added_desc",
                )?;
                let body = serde_json::json!({
                    "action": "add", "pid": pid, "platform": store::LOCAL_PLATFORM,
                });
                store::enqueue_pending_like_op(
                    conn,
                    "playlist",
                    "add",
                    &format!("playlist:{}:{pid}", store::LOCAL_PLATFORM),
                    &body.to_string(),
                )?;
                conn.execute_batch(
                    "CREATE TRIGGER synthetic_delete_failure BEFORE DELETE ON playlists
                 BEGIN SELECT RAISE(ABORT, 'synthetic-delete-failure'); END;",
                )?;
                Ok::<_, rusqlite::Error>(pid)
            })
            .expect("建立实际待发操作与删除故障边界");

        let result = db.with(|conn| delete_playlist_and_capture_permit(conn, &pid));
        assert!(
            result.is_err(),
            "删除故障必须返回 Err，而不是资格拒绝或成功"
        );
        assert!(db
            .with(|conn| store::playlist_pid_exists(conn, &pid))
            .unwrap());
        let pending = db.with(store::list_pending_like_ops).unwrap();
        assert_eq!(pending.len(), 1, "删除失败不能把旧 pending 先 ack 掉");
        let body: serde_json::Value = serde_json::from_str(&pending[0].payload_json).unwrap();
        assert_eq!(body["pid"].as_str(), Some(pid.as_str()));
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn temp_db(tag: &str) -> (std::path::PathBuf, Database) {
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "qt-playlist-cloud-{tag}-{}-{seq}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let db = Database::open(&dir.join("music.db")).expect("建库");
        (dir, db)
    }

    #[test]
    fn smart_playlist_cover_side_effect_is_blocked_before_presign() {
        let (dir, db) = temp_db("permit-cover-gate");
        let smart_pid = db
            .with(|conn| {
                crate::smart_playlist::create_smart_playlist(
                    conn,
                    "智能歌单",
                    &crate::smart_playlist::SmartRules::default(),
                    None,
                    "added_desc",
                )
            })
            .expect("建智能歌单");
        let ordinary_pid = db
            .with(|conn| store::create_playlist(conn, "普通歌单"))
            .expect("建普通歌单");
        let uploads = std::sync::Arc::new(AtomicUsize::new(0));
        let smart_permit = db
            .with(|conn| capture_playlist_permit(conn, store::LOCAL_PLATFORM, &smart_pid))
            .expect("判定智能歌单资格");
        assert!(!smart_permit.allowed(), "智能歌单不允许云同步");
        let smart_effect = run_if_allowed(smart_permit, || {
            uploads.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(
            uploads.load(Ordering::SeqCst),
            0,
            "智能歌单（含 presign）不得发出任何封面副作用"
        );
        assert!(smart_effect.is_none(), "被拦截的副作用不应返回结果");
        let ordinary_permit = db
            .with(|conn| capture_playlist_permit(conn, store::LOCAL_PLATFORM, &ordinary_pid))
            .expect("判定普通歌单资格");
        assert!(ordinary_permit.allowed(), "普通歌单允许云同步");
        let ordinary_effect = run_if_allowed(ordinary_permit, || {
            uploads.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(uploads.load(Ordering::SeqCst), 1, "普通歌单继续同步");
        assert!(ordinary_effect.is_some(), "普通副作用应当放行");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 建一个带旧封面的收藏歌单（走真实 store 写入，不手拼 SQL）。
    fn seed_favorite_with_cover(db: &Database, pid: &str, cover: &str) {
        db.with(|conn| store::add_liked_playlist(conn, "local", pid, "测试歌单", Some(cover), "0"))
            .expect("写收藏歌单");
    }

    fn card_cover(db: &Database, pid: &str) -> Option<String> {
        db.with(store::list_liked_playlists)
            .expect("读收藏歌单")
            .into_iter()
            .find(|p| p.id == pid)
            .map(|p| p.pic_url)
    }

    /// 云清除成功后必须让本地卡片缓存失效（C13 的最小回归）。
    ///
    /// 旧行为（v0）只清云、不调用 `invalidate`：本用例会红在"旧封面还在"。
    #[tokio::test]
    async fn cloud_clear_success_invalidates_the_cached_cover() {
        let (dir, db) = temp_db("clear-success");
        let pid = "cloud-clear-1";
        seed_favorite_with_cover(&db, pid, "https://cdn.example.com/old.png");

        let result = clear_cloud_cover(
            || async { Ok::<(), String>(()) },
            || {
                db.with(|conn| store::set_liked_playlist_pic(conn, "local", pid, ""))
                    .map(|_| ())
            },
        )
        .await
        .expect("云端清除成功");

        assert!(
            result.cache_error.is_none(),
            "缓存失效成功时不应报错误：{:?}",
            result.cache_error
        );
        assert_eq!(
            card_cover(&db, pid).as_deref(),
            Some(""),
            "云清除成功后旧封面缓存必须失效（C13）"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 云清除失败时不能动本地缓存：云请求返回 Err，缓存原值必须原样保留。
    ///
    /// 顺序守卫：`invalidate` 只能在 `clear` 成功之后跑，失败路径不得先清缓存。
    #[tokio::test]
    async fn cloud_clear_failure_keeps_the_cached_cover() {
        let (dir, db) = temp_db("cloud-failure");
        let pid = "cloud-clear-failure";
        let cover = "https://cdn.example.com/keep.png";
        seed_favorite_with_cover(&db, pid, cover);

        let invalidate_called = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = invalidate_called.clone();
        let result = clear_cloud_cover(
            || async { Err::<(), String>(String::from("网络不可用")) },
            || {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            },
        )
        .await;

        assert_eq!(result, Err(String::from("网络不可用")));
        assert!(
            !invalidate_called.load(std::sync::atomic::Ordering::SeqCst),
            "云清除失败时不得调用本地缓存失效"
        );
        assert_eq!(
            card_cover(&db, pid).as_deref(),
            Some(cover),
            "云清除失败必须保留旧封面缓存"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 云已清、缓存更新失败：整体仍算云成功，但必须带回独立 `cache_error`，
    /// 不能把 DB 失效失败谎报成云端清除失败。
    #[tokio::test]
    async fn cache_failure_is_reported_without_failing_the_cloud_clear() {
        let (dir, db) = temp_db("cache-failure");
        let pid = "cloud-clear-cache-failure";
        let cover = "https://cdn.example.com/stale.png";
        seed_favorite_with_cover(&db, pid, cover);

        let result = clear_cloud_cover(
            || async { Ok::<(), String>(()) },
            || Err(String::from("数据库被占用")),
        )
        .await
        .expect("云清除成功时整体必须是 Ok");

        assert_eq!(result.cache_error.as_deref(), Some("数据库被占用"));
        assert_eq!(
            card_cover(&db, pid).as_deref(),
            Some(cover),
            "失效回调失败不应假装缓存已经被清掉"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 智能歌单是本地视图，不能参与云同步（C12 的最小回归）。
    ///
    /// 走真实迁移 + 真实 `playlists.is_smart` 标记（`create_smart_playlist`
    /// 写库），v0 不区分智能歌单会红在"允许同步"。
    #[test]
    fn smart_playlists_cannot_sync_to_the_cloud() {
        let (dir, db) = temp_db("can-sync-smart");
        let pid = db
            .with(|conn| {
                crate::smart_playlist::create_smart_playlist(
                    conn,
                    "智能歌单",
                    &crate::smart_playlist::SmartRules::default(),
                    None,
                    "added_desc",
                )
            })
            .expect("建智能歌单");

        let allowed = db
            .with(|conn| playlist_can_sync(conn, "local", &pid))
            .expect("判定同步资格");

        assert!(
            !allowed,
            "本地智能歌单只存在于本机，不应参与云同步（C12）：{pid}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 普通（非智能）本地歌单仍应允许同步（C12 边界守卫）。
    #[test]
    fn normal_local_playlists_can_sync() {
        let (dir, db) = temp_db("can-sync-normal");
        let pid = db
            .with(|conn| store::create_playlist(conn, "普通歌单"))
            .expect("建普通歌单");

        let allowed = db
            .with(|conn| playlist_can_sync(conn, store::LOCAL_PLATFORM, &pid))
            .expect("判定同步资格");

        assert!(allowed, "普通歌单应允许同步（C12）：{pid}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 其它平台的云卡片即使 pid 与本机某张智能歌单相同，也照样允许同步
    /// （C12 边界守卫：别把本地智能标记误伤到云端同 id 卡片）。
    #[test]
    fn foreign_platform_playlists_can_sync_even_with_the_same_pid() {
        let (dir, db) = temp_db("can-sync-foreign");
        let pid = db
            .with(|conn| {
                crate::smart_playlist::create_smart_playlist(
                    conn,
                    "智能歌单",
                    &crate::smart_playlist::SmartRules::default(),
                    None,
                    "added_desc",
                )
            })
            .expect("建智能歌单");

        let allowed = db
            .with(|conn| playlist_can_sync(conn, "qq", &pid))
            .expect("判定同步资格");

        assert!(
            allowed,
            "别的平台同 pid 与本机智能歌单无关，应允许同步（C12）：{pid}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 本机还没有这条歌单（云端新卡片）应允许导入，不能被当成智能歌单拦掉
    /// （C12 边界守卫）。
    #[test]
    fn missing_local_playlist_can_be_imported() {
        let (dir, db) = temp_db("can-sync-missing");
        let pid = "cloud-card-not-in-local-db";

        let allowed = db
            .with(|conn| playlist_can_sync(conn, store::LOCAL_PLATFORM, pid))
            .expect("判定同步资格");

        assert!(allowed, "本机没有的云端卡片应允许导入（C12）：{pid}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 查询失败必须把 `Err` 交给调用方，不能被当成"允许同步"
    /// （C12 边界守卫：DB 错误不能默默 true）。
    #[test]
    fn broken_playlist_table_is_an_error_not_a_permission() {
        let (dir, db) = temp_db("can-sync-db-error");
        db.with(|conn| {
            conn.execute_batch("DROP TABLE playlists")?;
            Ok::<(), rusqlite::Error>(())
        })
        .expect("删掉 playlists 表制造查询失败");

        let result = db.with(|conn| playlist_can_sync(conn, store::LOCAL_PLATFORM, "any-pid"));

        assert!(
            result.is_err(),
            "DB 错误必须原样返回 Err，不能默默 true（C12）：{result:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 旧离线队列里的智能歌单 metadata 必须被 ack 掉，不能重放给云端建空卡片
    /// （C12 遗留队列接缝的最小回归）。
    ///
    /// 真实走 `Database` + `create_smart_playlist` / `create_playlist` +
    /// `enqueue_pending_like_op`，再用 flush 同款 `list_pending_like_ops` 读待发队列。
    /// 旧行为（v0）原样返回全部 op：会红在"智能歌单仍待发"。
    #[test]
    fn smart_playlist_pending_op_is_acknowledged_and_dropped() {
        let (dir, db) = temp_db("pending-filter-smart");
        let (smart_pid, normal_pid) = db
            .with(|conn| {
                let smart_pid = crate::smart_playlist::create_smart_playlist(
                    conn,
                    "智能歌单",
                    &crate::smart_playlist::SmartRules::default(),
                    None,
                    "added_desc",
                )?;
                let normal_pid = store::create_playlist(conn, "普通歌单")?;
                let smart_body = serde_json::json!({
                    "action": "add",
                    "pid": smart_pid,
                    "platform": store::LOCAL_PLATFORM,
                    "name": "智能歌单",
                });
                store::enqueue_pending_like_op(
                    conn,
                    "playlist",
                    "add",
                    &format!("playlist:{}:{smart_pid}", store::LOCAL_PLATFORM),
                    &smart_body.to_string(),
                )?;
                let normal_body = serde_json::json!({
                    "action": "add",
                    "pid": normal_pid,
                    "platform": store::LOCAL_PLATFORM,
                    "name": "普通歌单",
                });
                store::enqueue_pending_like_op(
                    conn,
                    "playlist",
                    "add",
                    &format!("playlist:{}:{normal_pid}", store::LOCAL_PLATFORM),
                    &normal_body.to_string(),
                )?;
                Ok::<_, rusqlite::Error>((smart_pid, normal_pid))
            })
            .expect("建歌单并入队旧的待发操作");

        let pending = db
            .with(store::list_pending_like_ops)
            .expect("读 flush 同款待发队列");
        assert_eq!(pending.len(), 2, "前置：两条歌单操作都在队列里");

        let kept = db
            .with(|conn| filter_pending_cloud_ops(conn, pending))
            .expect("过滤待发操作");

        assert_eq!(
            kept.len(),
            1,
            "智能歌单的旧操作不应再上送，普通歌单操作必须保留"
        );
        assert!(
            kept[0].payload_json.contains(&normal_pid),
            "留下的必须是普通歌单操作：{}",
            kept[0].payload_json
        );
        assert!(
            !kept[0].payload_json.contains(&smart_pid),
            "智能歌单操作不能留在待发列表：{}",
            kept[0].payload_json
        );

        let remaining = db.with(store::list_pending_like_ops).expect("复查队列");
        assert_eq!(
            remaining.len(),
            1,
            "被丢弃的智能歌单操作必须同时从数据库 ack 掉"
        );
        assert!(
            remaining[0].payload_json.contains(&normal_pid),
            "数据库里剩下的应是普通歌单操作：{}",
            remaining[0].payload_json
        );
        assert_eq!(
            db.with(store::count_pending_like_ops)
                .expect("统计剩余队列"),
            1
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 无法判定为"有效本地智能歌单"的操作一律保留：foreign 同 pid、坏 JSON、
    /// 缺字段、歌曲 op 都交给既有发送 / 损坏退避路径（C12 边界守卫）。
    #[test]
    fn non_smart_or_unparsable_pending_ops_are_retained() {
        let (dir, db) = temp_db("pending-filter-retain");
        let smart_pid = db
            .with(|conn| {
                crate::smart_playlist::create_smart_playlist(
                    conn,
                    "智能歌单",
                    &crate::smart_playlist::SmartRules::default(),
                    None,
                    "added_desc",
                )
            })
            .expect("建智能歌单");

        db.with(|conn| {
            // 其它平台同 pid：与本机智能标记无关，必须保留。
            let foreign = serde_json::json!({
                "action": "add",
                "pid": smart_pid,
                "platform": "qq",
                "name": "云端歌单",
            });
            store::enqueue_pending_like_op(
                conn,
                "playlist",
                "add",
                &format!("playlist:qq:{smart_pid}"),
                &foreign.to_string(),
            )?;
            // 坏 JSON：留给既有损坏退避路径。
            store::enqueue_pending_like_op(
                conn,
                "playlist",
                "add",
                "playlist:local:bad-json",
                "{not json",
            )?;
            // 缺 platform / pid：无法判定，保留。
            store::enqueue_pending_like_op(
                conn,
                "playlist",
                "add",
                "playlist:local:no-pid",
                "{\"action\":\"add\"}",
            )?;
            // 歌曲 op 不受歌单过滤影响。
            let song = serde_json::json!({
                "action": "like",
                "sid": "s1",
                "platform": store::LOCAL_PLATFORM,
                "pid": smart_pid,
            });
            store::enqueue_pending_like_op(
                conn,
                "song",
                "like",
                "song:local:s1",
                &song.to_string(),
            )?;
            Ok::<(), rusqlite::Error>(())
        })
        .expect("入队各类待发操作");

        let pending = db.with(store::list_pending_like_ops).expect("读待发队列");
        assert_eq!(pending.len(), 4, "前置：四类操作都在队列里");

        let kept = db
            .with(|conn| filter_pending_cloud_ops(conn, pending))
            .expect("过滤待发操作");

        assert_eq!(
            kept.len(),
            4,
            "foreign / 坏 JSON / 缺字段 / 歌曲 op 都必须保留"
        );
        assert_eq!(
            db.with(store::count_pending_like_ops)
                .expect("统计剩余队列"),
            4,
            "保留的操作不能被误 ack"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 判定过程遇到 DB 错误必须原样 `Err`，不能默默放行或悄悄 ack 掉操作
    /// （C12 边界守卫：错误不能变成许可）。
    #[test]
    fn pending_op_filter_surfaces_db_errors_without_dropping() {
        let (dir, db) = temp_db("pending-filter-db-error");
        db.with(|conn| {
            let body = serde_json::json!({
                "action": "add",
                "pid": "missing-pid",
                "platform": store::LOCAL_PLATFORM,
                "name": "云端歌单",
            });
            store::enqueue_pending_like_op(
                conn,
                "playlist",
                "add",
                "playlist:local:missing-pid",
                &body.to_string(),
            )?;
            conn.execute_batch("DROP TABLE playlists")?;
            Ok::<(), rusqlite::Error>(())
        })
        .expect("入队并删表制造查询失败");

        let pending = db.with(store::list_pending_like_ops).expect("读待发队列");
        let result = db.with(|conn| filter_pending_cloud_ops(conn, pending));

        assert!(
            result.is_err(),
            "DB 错误必须原样返回 Err，不能默默放行（C12）：{result:?}"
        );
        assert_eq!(
            db.with(store::count_pending_like_ops)
                .expect("统计剩余队列"),
            1,
            "出错时不能悄悄 ack/drop 待发操作"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
