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
        log::info!("[db] 已打开 {}（schema v{}）", path.display(), migrations::CURRENT_VERSION);
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// 串行执行一段只读/写操作；错误统一转 String（写库失败不应打断播放链路）。
    pub fn with<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, rusqlite::Error>,
    ) -> Result<T, String> {
        let conn = self.conn.lock().unwrap();
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
        db.with(|c| c.execute("DELETE FROM tracks", []))
            .unwrap();
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
}
