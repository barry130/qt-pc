//! SQLite 数据层（DESIGN §8）。
//!
//! - 单连接 + Mutex 串行访问（本应用写入频率低，无需连接池）。
//! - `PRAGMA foreign_keys = ON` 必须显式开启（§8.3 末尾要求），否则 CASCADE 不生效。
//! - WAL + busy_timeout，避免偶发 SQLITE_BUSY。
//! - R1：播放地址只进进程内存缓存，任何表都不落播放 URL。

pub(crate) mod migrations;
pub(crate) mod store;

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

pub use store::{PlayState, SavedSession};

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    /// 打开（不存在则创建）并执行迁移。
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建数据目录失败 {parent:?}: {e}"))?;
        }
        let conn = Connection::open(path).map_err(|e| format!("打开数据库失败: {e}"))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| format!("开启 WAL 失败: {e}"))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| format!("设置 busy_timeout 失败: {e}"))?;
        // §8.3：外键必须显式开启
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| format!("开启 foreign_keys 失败: {e}"))?;
        migrations::run(&conn).map_err(|e| format!("数据库迁移失败: {e}"))?;
        log::info!(
            "[db] 已打开 {}（schema v{}）",
            path.display(),
            migrations::CURRENT_VERSION
        );
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// 取连接锁，**容忍互斥锁毒化**。
    ///
    /// 为什么不能用 `lock().unwrap()`：`Cargo.toml` 已恢复默认的 panic=unwind
    /// （见其注释），于是任何一次在持锁期间 panic 都会把 `Mutex` 标记为中毒，
    /// 之后**所有**取锁点都会 `unwrap()` 失败 —— 一次偶发 panic 会让整个数据层
    /// 在本次运行里永久不可用（设置存不下、歌单读不出、播放现场丢），
    /// 而这正是 "一个线程的 panic 不该升级成整个库的死亡" 的典型场景。
    ///
    /// 为什么 `into_inner()` 是安全的：毒化只表示"上次持锁者 panic 了"，
    /// 不表示 `Connection` 本身损坏。SQLite 连接在事务未提交时会自动回滚
    /// （rusqlite 的 `Transaction` 在 Drop 时回滚），拿回连接继续用不会读到
    /// 半提交状态；最坏情况是那一笔写没落库，而这是 panic 本身已造成的结果，
    /// 与"连库都打不开"相比是明显更好的降级。
    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 串行执行一段只读/写操作；错误统一转 String（写库失败不应打断播放链路）。
    pub fn with<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, rusqlite::Error>,
    ) -> Result<T, String> {
        let conn = self.conn();
        f(&conn).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::types::{SourceId, Track};

    fn test_db() -> Database {
        let dir = std::env::temp_dir().join(format!(
            "quietmusic-test-{}-{}",
            std::process::id(),
            fastrand::u64(..)
        ));
        Database::open(&dir.join("music.db")).expect("open test db")
    }

    fn track(id: &str, title: &str) -> Track {
        Track {
            id: id.into(),
            platform: SourceId::Wyy,
            title: title.into(),
            singer: "歌手".into(),
            album: "专辑".into(),
            pic_url: String::new(),
            duration: 210.0,
            music_id: None,
        }
    }

    #[test]
    fn foreign_keys_are_on_and_cascade_works() {
        let db = test_db();
        let fk: i64 = db
            .with(|c| c.query_row("PRAGMA foreign_keys", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(fk, 1, "foreign_keys 必须显式开启（§8.3）");

        let t = track("1", "歌");
        db.with(|c| store::upsert_tracks(c, &[&t])).unwrap();
        db.with(|c| {
            c.execute(
                "INSERT INTO play_history (id, track_id, played_at, played_duration_ms, completed)
                 VALUES ('h1', 'wyy:1', 0, 1000, 0)",
                [],
            )
        })
        .unwrap();
        // 删除曲目 → play_history 级联删除
        db.with(|c| c.execute("DELETE FROM tracks", [])).unwrap();
        let n: i64 = db
            .with(|c| c.query_row("SELECT COUNT(*) FROM play_history", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(n, 0, "CASCADE 未生效");
    }

    #[test]
    fn queue_and_state_roundtrip() {
        let db = test_db();
        let tracks = [track("1", "海阔天空"), track("2", "光辉岁月")];
        db.with(|c| store::save_queue(c, &tracks)).unwrap();
        db.with(|c| {
            store::save_play_state(
                c,
                &store::PlayState {
                    index: 1,
                    position_ms: 0,
                    quality: "320".into(),
                    play_mode: "listLoop".into(),
                    volume: 0.8,
                    muted: false,
                },
            )
        })
        .unwrap();

        let saved = db.with(store::load_session).unwrap().expect("应有存档");
        assert_eq!(saved.tracks.len(), 2);
        assert_eq!(saved.tracks[1].title, "光辉岁月");
        assert_eq!(saved.state.index, 1);

        // 整表替换：新队列覆盖旧队列
        let tracks2 = [track("3", "真的爱你")];
        db.with(|c| store::save_queue(c, &tracks2)).unwrap();
        let saved2 = db.with(store::load_session).unwrap().unwrap();
        assert_eq!(saved2.tracks.len(), 1);
        assert_eq!(saved2.tracks[0].id, "3");

        // 空队列 → 无存档
        db.with(|c| store::save_queue(c, &[])).unwrap();
        assert!(db.with(store::load_session).unwrap().is_none());
    }

    #[test]
    fn play_state_persists() {
        let db = test_db();
        let t = track("1", "歌");
        db.with(|c| store::upsert_tracks(c, &[&t])).unwrap();
        db.with(|c| store::save_queue(c, &[t])).unwrap();
        let state = PlayState {
            index: 0,
            position_ms: 42_000,
            quality: "320".into(),
            play_mode: "oneLoop".into(),
            volume: 0.65,
            muted: true,
        };
        db.with(|c| store::save_play_state(c, &state)).unwrap();
        let saved = db.with(store::load_session).unwrap().unwrap();
        assert_eq!(saved.state.position_ms, 42_000);
        assert_eq!(saved.state.play_mode, "oneLoop");
        assert!(saved.state.muted);
    }

    #[test]
    fn wal_is_actually_enabled() {
        // P2-7 第 3 项：`pragma_update(.., "journal_mode", "WAL")` 走的是
        // execute_batch（忽略语句返回值），所以"设了但没生效"在代码上是看不出来的，
        // 这里实测一次 journal_mode 的返回值。
        let db = test_db();
        let mode: String = db
            .with(|c| c.query_row("PRAGMA journal_mode", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal", "WAL 必须真的生效（§8.3）");
    }

    #[test]
    fn lock_survives_a_panicking_holder() {
        // P1-1：持锁线程 panic 会把 Mutex 标记为中毒，旧代码的 `lock().unwrap()`
        // 之后每次取锁都失败 —— 一次偶发 panic 就让整个数据层在本次运行里永久不可用。
        // 这里实测"毒化之后仍能取锁、仍能读写"。
        let db = std::sync::Arc::new(test_db());
        let holder = db.clone();
        let _ = std::thread::spawn(move || {
            let _guard = holder.conn(); // 持有锁不放，然后 panic（_guard 在栈展开时释放）
            panic!("模拟持锁线程 panic，用于制造 Mutex 毒化");
        })
        .join();

        // 已经中毒，但取锁不应失败
        let one: i64 = db
            .with(|c| c.query_row("SELECT 1", [], |r| r.get(0)))
            .expect("毒化后仍应能取锁并查询");
        assert_eq!(one, 1);

        // 写路径也要能用：说明连接本身没被 panic 弄坏
        let t = track("1", "毒化后仍可写");
        db.with(|c| store::upsert_tracks(c, &[&t]))
            .expect("毒化后仍应能写库");
        let n: i64 = db
            .with(|c| c.query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(n, 1);
    }
}
