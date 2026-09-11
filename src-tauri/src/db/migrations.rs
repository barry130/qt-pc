//! 版本号迁移（DESIGN §8.4）：schema_migrations 记录已应用版本，
//! 逐版本在事务内执行；失败即回滚并报错，不半途应用。
//!
//! v1 = DESIGN §8.3 全部表（含 R1 修订：tracks 不含 url / url_fetched_at）。

use rusqlite::Connection;

use super::store::{get_setting, set_setting};

/// (版本号, SQL)。按版本升序追加，永不修改已发布条目。
/// v2：收藏的**在线歌单**（DESIGN §5.3）。
/// 之前只有 liked_songs，歌单收藏没有落脚点，跨端同步也就无从谈起。
/// 存的是歌单元信息的快照（不存曲目），点进去再向音源取详情。
const V2: &str = r#"
CREATE TABLE IF NOT EXISTS liked_playlists (
  id          TEXT PRIMARY KEY,
  pid         TEXT NOT NULL,
  platform    TEXT NOT NULL,
  name        TEXT NOT NULL,
  pic_url     TEXT,
  play_count  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_liked_playlists_time ON liked_playlists(created_at DESC);
"#;

/// v3：收藏歌曲与歌单绑定（DESIGN §5.3）。
///
/// 规则：歌单由 `(platform, pid)` 唯一定位 —— `platform = "local"` 是本地歌单，
/// `pid` 用 `playlists.id`；其余是在线收藏的歌单。收藏歌曲通过 `liked_songs.pid`
/// 归属到某个歌单，散装收藏统一挂在默认歌单「我喜欢的音乐」（pid = `favorite`）下。
///
/// 这里只插默认歌单这一行：补列、回填、存量迁移都要引用 `liked_songs.pid`，
/// 而全新库跑完 v1 时还没有这一列，写进 SQL 会直接报错 ——
/// 那些步骤放在 `run()` 的列补齐阶段做（见 `bind_liked_songs_to_playlists`）。
///
/// id 与 platform 都取 `"local"`：和 qt-uniappx 的 `LIKED_PLAYLIST_ID` 对齐，
/// 云端同步回来的「我喜欢的歌曲」卡片也是 (platform=local, pid=local)。
const V3: &str = r#"
INSERT OR IGNORE INTO playlists (id, name, description, is_smart, sort_order, is_favorite, created_at, updated_at)
VALUES ('local', '我喜欢的歌曲', '散装收藏的默认归属歌单', 0, 0, 1,
        strftime('%s','now') * 1000, strftime('%s','now') * 1000);
"#;

/// v4：歌单的 id 与 pid 分离。
///
/// pid 是歌单的**永久全局唯一标识**（UUID v4，创建后不再变化）：
/// 新建歌单时生成并上送云端登记，收藏歌曲 / 查询歌单 / 删除歌单全部按 pid 走；
/// `id` 退化为纯本地主键（playlist_tracks 老表的外键还指着它）。
/// 只 ALTER 加列 + 唯一索引；UUID 回填、默认歌单 pid 定档、liked_songs.pid
/// 存量映射都在 `run()` 的列补齐阶段做（见 `ensure_playlists_pid`）。
const V4: &str = r#"
ALTER TABLE playlists ADD COLUMN pid TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uk_playlists_pid ON playlists(pid);
"#;

/// v5：取消「默认歌单」概念。
///
/// 歌单只有两个来源：**云端同步回来的卡片**（liked_playlists，含
/// platform=local 的「我喜欢的歌曲」）和**本地自建**（playlists）。
/// 收藏歌曲的 pid 若找不到对应歌单（或云端根本没给 pid）→ 不加载。
/// 这里只清掉本地自造的默认歌单行；孤儿归属清理要引用 `liked_songs.pid`，
/// 全新库此时还没有该列，所以放到 `run()` 的列补齐阶段做（见 `purge_orphan_likes`），
/// 并重置全量导入，下次同步按新规则用云端返回的 pid 重建归属。
const V5: &str = r#"
DELETE FROM playlist_tracks WHERE playlist_id = 'local';
DELETE FROM playlists WHERE id = 'local';
DELETE FROM playlist_tracks WHERE playlist_id IN (
  SELECT id FROM playlists WHERE name = '云端歌单'
);
DELETE FROM playlists WHERE name = '云端歌单';
DELETE FROM settings WHERE key = 'like.imported';
"#;

/// v6：一首歌可以同时在多个歌单（收藏选择器多选）。
///
/// 之前 `liked_songs` 一首歌一行、`pid` 单值，天然单归属；
/// 现在归属关系拆到独立的**多对多关联表** `liked_song_playlists`，
/// `liked_songs.pid` 保留为"主归属"（上送云端用 —— 云端 qt_like_song 仍是
/// (uid,sid,platform) 唯一、pid 单值，多端只同步主归属）。
/// 回填存量要引用 `liked_songs.pid`，全新库此时还没有该列，
/// 所以回填放到 `run()` 的列补齐阶段做（见 `backfill_song_playlist_links`）。
const V6: &str = r#"
CREATE TABLE IF NOT EXISTS liked_song_playlists (
  song_id  TEXT NOT NULL,
  pid      TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (song_id, pid)
);
CREATE INDEX IF NOT EXISTS idx_lsp_pid ON liked_song_playlists(pid);
"#;

pub(crate) const MIGRATIONS: &[(i64, &str)] =
  &[(1, V1), (2, V2), (3, V3), (4, V4), (5, V5), (6, V6)];

const V1: &str = r#"
CREATE TABLE tracks (
  id            TEXT PRIMARY KEY,
  platform      TEXT NOT NULL,
  title         TEXT NOT NULL,
  singer        TEXT NOT NULL,
  album         TEXT NOT NULL,
  pic_url       TEXT,
  duration_ms   INTEGER,
  music_id      TEXT,
  local_path    TEXT,
  file_size     INTEGER,
  format        TEXT,
  sample_rate   INTEGER,
  bit_rate      INTEGER,
  mtime         INTEGER,
  content_hash  TEXT,
  title_pinyin  TEXT,
  title_initial TEXT,
  missing       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_tracks_platform ON tracks(platform);
CREATE INDEX idx_tracks_singer   ON tracks(singer);
CREATE INDEX idx_tracks_album    ON tracks(album);
CREATE INDEX idx_tracks_missing  ON tracks(missing);
CREATE UNIQUE INDEX uk_tracks_local_path ON tracks(local_path) WHERE local_path IS NOT NULL;

CREATE TABLE playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  cover_path TEXT,
  is_smart INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  is_favorite INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE playlist_tracks (
  playlist_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, track_id),
  FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);
CREATE INDEX idx_playlist_tracks_position ON playlist_tracks(playlist_id, position);

CREATE TABLE liked_songs (
  id TEXT PRIMARY KEY,
  uid INTEGER NOT NULL,
  sid TEXT NOT NULL,
  platform TEXT NOT NULL,
  name TEXT NOT NULL,
  singer TEXT NOT NULL,
  album TEXT NOT NULL,
  hash TEXT,
  deleted_at INTEGER,
  updated_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(uid, platform, sid)
);
CREATE INDEX idx_liked_songs_uid_seq ON liked_songs(uid, updated_seq);

CREATE TABLE liked_playlists (
  id TEXT PRIMARY KEY,
  uid INTEGER NOT NULL,
  pid TEXT NOT NULL,
  platform TEXT NOT NULL,
  name TEXT NOT NULL,
  pic_url TEXT,
  is_import INTEGER DEFAULT 0,
  deleted_at INTEGER,
  updated_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(uid, platform, pid)
);
CREATE INDEX idx_liked_playlists_uid_seq ON liked_playlists(uid, updated_seq);

CREATE TABLE play_history (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL,
  played_at INTEGER NOT NULL,
  played_duration_ms INTEGER NOT NULL,
  completed INTEGER DEFAULT 0,
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);
CREATE INDEX idx_play_history_time ON play_history(played_at DESC);

CREATE TABLE play_stats (
  track_id TEXT PRIMARY KEY,
  play_count INTEGER NOT NULL DEFAULT 0,
  last_played_at INTEGER NOT NULL,
  total_played_ms INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);
CREATE INDEX idx_play_stats_count ON play_stats(play_count DESC);

CREATE TABLE download_tasks (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  quality TEXT NOT NULL,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  file_path TEXT,
  file_size INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);
CREATE INDEX idx_download_tasks_status ON download_tasks(status);

CREATE TABLE scan_dirs (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  enabled INTEGER DEFAULT 1,
  last_scan_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  config TEXT,
  status TEXT DEFAULT 'disconnected',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE pending_like_ops (
  id TEXT PRIMARY KEY,
  uid INTEGER NOT NULL,
  type TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_pending_like_ops_retry ON pending_like_ops(uid, next_retry_at);

CREATE TABLE like_sync_state (
  uid INTEGER PRIMARY KEY,
  cursor INTEGER NOT NULL DEFAULT 0,
  last_sync_at INTEGER,
  last_error TEXT
);

CREATE TABLE themes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT,
  is_active INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE lyrics (
  track_id     TEXT PRIMARY KEY,
  lrc          TEXT,
  word_lrc     TEXT,
  translation  TEXT,
  romaji       TEXT,
  source       TEXT NOT NULL,
  fetched_at   INTEGER NOT NULL,
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

CREATE TABLE lyric_settings (
  track_id   TEXT PRIMARY KEY,
  offset_ms  INTEGER NOT NULL DEFAULT 0,
  lyric_path TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE play_queue (
  position   INTEGER PRIMARY KEY,
  track_id   TEXT NOT NULL,
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

CREATE TABLE search_history (
  keyword     TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  searched_at INTEGER NOT NULL
);

CREATE TABLE stat_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  payload    TEXT NOT NULL,
  retry      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
"#;

/// 当前程序支持的最新 schema 版本。
pub(crate) const CURRENT_VERSION: i64 = 6;

/// 建表 schema_migrations 并把所有未应用版本按序执行。
pub(crate) fn run(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
           version INTEGER PRIMARY KEY,
           applied_at INTEGER NOT NULL
         );",
    )?;
    let current: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    for &(version, sql) in MIGRATIONS {
        if version <= current {
            continue;
        }
        conn.execute_batch(&format!(
            "BEGIN;
             {sql}
             INSERT INTO schema_migrations (version, applied_at) VALUES ({version}, strftime('%s','now') * 1000);
             COMMIT;"
        ))?;
        log::info!("[db] 迁移 v{version} 已应用");
    }
    ensure_liked_playlists_columns(conn)?;
    ensure_liked_songs_columns(conn)?;
    bind_liked_songs_to_playlists(conn)?;
    ensure_playlists_pid(conn)?;
    backfill_song_playlist_links(conn)?;
    purge_orphan_likes(conn)?;
    Ok(())
}

/// 存量收藏的多归属关联回填（v6 的收尾工作，一次性）：
/// 把 `liked_songs.pid` 里的主归属搬进关联表。
fn backfill_song_playlist_links(conn: &Connection) -> Result<(), rusqlite::Error> {
    let done = get_setting(conn, "db.songPlaylistLinksBackfilled")?
        .as_deref()
        .map(|v| v == "1")
        .unwrap_or(false);
    if done {
        return Ok(());
    }
    let n = conn.execute(
        "INSERT OR IGNORE INTO liked_song_playlists (song_id, pid, added_at)
         SELECT id, pid, COALESCE(updated_at, strftime('%s','now') * 1000)
           FROM liked_songs
          WHERE deleted_at IS NULL AND pid IS NOT NULL AND pid <> ''",
        [],
    )?;
    set_setting(conn, "db.songPlaylistLinksBackfilled", "1")?;
    if n > 0 {
        log::info!("[db] 收藏归属 {n} 条已回填进多归属关联表");
    }
    Ok(())
}

/// 孤儿收藏清理（v5 的收尾工作，"无归属不加载"）：软删那些
/// pid 找不到歌单（云端卡片或本地自建都没有）或没带 pid 的收藏。
/// 幂等：一次清理后不再产生新的孤儿（新收藏落库前都会查歌单存在）。
fn purge_orphan_likes(conn: &Connection) -> Result<(), rusqlite::Error> {
    let has_pid: bool = conn
        .prepare("PRAGMA table_info(liked_songs)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .any(|c| c == "pid");
    if !has_pid {
        return Ok(());
    }
    let n = conn.execute(
        "UPDATE liked_songs SET deleted_at = strftime('%s','now') * 1000
          WHERE deleted_at IS NULL
            AND (pid IS NULL OR pid = '')
            AND id NOT IN (SELECT song_id FROM liked_song_playlists)
            AND id NOT IN (SELECT track_id FROM playlist_tracks)",
        [],
    )?;
    if n > 0 {
        log::info!("[db] 清理无归属收藏 {n} 条（歌单不存在或未指定 pid）");
    }
    Ok(())
}

/// 歌单 pid 回填（v4/v5 的收尾工作）。所有步骤幂等，可重复执行：
/// 1. 每个**缺 pid 的自建歌单行**生成一个 UUID v4 回填（默认歌单行已被 v5 删除）；
/// 2. `liked_songs.pid` 的存量按 `playlists.id → pid` 映射迁移
///    （v3 时代里存的是歌单行 id）。
fn ensure_playlists_pid(conn: &Connection) -> Result<(), rusqlite::Error> {
    let has_playlists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='playlists'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n > 0)
        .unwrap_or(false);
    if !has_playlists {
        return Ok(());
    }
    let has_pid: bool = conn
        .prepare("PRAGMA table_info(playlists)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .any(|c| c == "pid");
    if !has_pid {
        return Ok(());
    }

    // 1) 逐行补 pid（默认歌单行已被 v5 删除，这里只服务自建歌单）
    let rows: Vec<String> = conn
        .prepare("SELECT id FROM playlists WHERE pid IS NULL OR pid = ''")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for id in rows {
        let pid = new_uuid_v4();
        conn.execute(
            "UPDATE playlists SET pid = ?1 WHERE id = ?2",
            rusqlite::params![pid, id],
        )?;
    }
    // 老库若之前手工产生过重复，唯一索引兜底（V4 里的 CREATE UNIQUE INDEX 幂等）
    conn.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS uk_playlists_pid ON playlists(pid);")?;

    // 2) liked_songs.pid 的存量映射：id → pid
    conn.execute_batch(
        "UPDATE liked_songs
            SET pid = (SELECT p.pid FROM playlists p WHERE p.id = liked_songs.pid)
          WHERE pid IN (SELECT id FROM playlists);",
    )?;
    Ok(())
}

/// UUID v4 形态（8-4-4-4-12，32 位随机 + 版本号 4 + 变体位），与
/// qt-uniappx `generateGlobalPid` 同构：本地歌单上送云端的全局唯一 pid 就用它。
pub(crate) fn new_uuid_v4() -> String {
    use std::fmt::Write;
    let mut buf = [0u8; 16];
    fastrand::fill(&mut buf);
    buf[6] = (buf[6] & 0x0f) | 0x40; // version 4
    buf[8] = (buf[8] & 0x3f) | 0x80; // variant 10xx
    let mut out = String::with_capacity(36);
    for (i, b) in buf.iter().enumerate() {
        if matches!(i, 4 | 6 | 8 | 10) {
            out.push('-');
        }
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// 收藏歌曲绑定歌单（v3 的收尾工作）。
///
/// 三步都在**列补齐阶段**做，因为新库跑 v1 时 `liked_songs` 还没有 `pid` 列：
/// 1. 建 `pid` 索引（按歌单取曲目是现在的主查询路径）；
/// 2. 老数据回填：`pid` 为空或历史值 `local` 的一律归到默认歌单 `favorite`；
/// 3. `playlist_tracks` 的存量一次性迁进 `liked_songs`，之后歌单曲目只认 `liked_songs`。
fn bind_liked_songs_to_playlists(conn: &Connection) -> Result<(), rusqlite::Error> {
    let has_pid: bool = conn
        .prepare("PRAGMA table_info(liked_songs)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .any(|c| c == "pid");
    if !has_pid {
        return Ok(());
    }

    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_liked_songs_pid ON liked_songs(pid);",
    )?;

    // 存量只迁一次：迁移完 playlist_tracks 就是历史遗留表，
    // 再迁会把用户后来手动移出去的歌又搬回来。
    // 老数据的 pid 归位也只做这一次 —— v5 起无归属的歌不再加载，
    // 每次启动都回填会把孤儿歌反复挂到某个歌单上。
    let migrated = get_setting(conn, "db.playlistTracksMigrated")?
        .as_deref()
        .map(|v| v == "1")
        .unwrap_or(false);
    if migrated {
        return Ok(());
    }

    conn.execute_batch(
        "-- 默认歌单的 pid 一度写作 'favorite'，统一回 'local'
         UPDATE liked_songs SET pid = 'local'
          WHERE pid IS NULL OR pid = '' OR pid = 'favorite';
         UPDATE OR IGNORE playlists SET id = 'local' WHERE id = 'favorite';
         DELETE FROM playlists WHERE id = 'favorite';",
    )?;

    // tracks.id 形如 `<platform>:<sid>`；UNIQUE(uid, platform, sid) 决定
    // 一首歌只能属于一个歌单，重复的直接 IGNORE（先迁进来的那个歌单胜出）。
    let moved = conn.execute_batch(
        "INSERT OR IGNORE INTO liked_songs
             (id, uid, sid, platform, name, singer, album, hash, pid, updated_seq, updated_at, created_at)
         SELECT t.id, 0,
                CASE WHEN instr(t.id, ':') > 0 THEN substr(t.id, instr(t.id, ':') + 1) ELSE t.id END,
                CASE WHEN instr(t.id, ':') > 0 THEN substr(t.id, 1, instr(t.id, ':') - 1) ELSE 'local' END,
                t.title, t.singer, t.album, t.music_id,
                pt.playlist_id, 0, pt.added_at, pt.added_at
           FROM playlist_tracks pt
           JOIN tracks t ON t.id = pt.track_id;",
    );
    match moved {
        Ok(()) => {
            set_setting(conn, "db.playlistTracksMigrated", "1")?;
            let n: i64 = conn
                .query_row("SELECT changes()", [], |r| r.get(0))
                .unwrap_or(0);
            if n > 0 {
                log::info!("[db] playlist_tracks 存量 {n} 条已迁入 liked_songs");
            }
        }
        Err(e) => log::warn!("[db] playlist_tracks 存量迁移失败（不影响启动）: {e}"),
    }
    Ok(())
}

/// liked_songs 补 pid 列：歌曲归属哪个歌单，散装收藏为 'local'（「我喜欢的歌曲」）。
/// 与 liked_playlists 同理 —— 表在 pid 之前就建好了，只能按实际列清单补。
fn ensure_liked_songs_columns(conn: &Connection) -> Result<(), rusqlite::Error> {
    let exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='liked_songs'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n > 0)
        .unwrap_or(false);
    if !exists {
        return Ok(());
    }

    let names: Vec<String> = conn
        .prepare("PRAGMA table_info(liked_songs)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<_, _>>()?;

    if !names.iter().any(|n| n == "pid") {
        conn.execute_batch(
            "ALTER TABLE liked_songs ADD COLUMN pid TEXT NOT NULL DEFAULT 'local';",
        )?;
        log::info!("[db] liked_songs 补上 pid 列");
    }
    Ok(())
}

/// 补齐 liked_playlists 后加的列。
///
/// `CREATE TABLE IF NOT EXISTS` 对**已经存在**的表什么都不做，
/// 而这张表在建表之后又加过 play_count —— 老库跑 v2 时表已存在、列却没有，
/// 插入就会报 "no column named play_count"。只能按实际列清单补。
fn ensure_liked_playlists_columns(conn: &Connection) -> Result<(), rusqlite::Error> {
    let exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='liked_playlists'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n > 0)
        .unwrap_or(false);
    if !exists {
        return Ok(());
    }

    let names: Vec<String> = conn
        .prepare("PRAGMA table_info(liked_playlists)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<_, _>>()?;

    for (column, ddl) in [("play_count", "TEXT"), ("pic_url", "TEXT")] {
        if !names.iter().any(|n| n == column) {
            conn.execute_batch(&format!(
                "ALTER TABLE liked_playlists ADD COLUMN {column} {ddl};"
            ))?;
            log::info!("[db] liked_playlists 补上 {column} 列");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_idempotent_and_ordered() {
        let conn = Connection::open_in_memory().unwrap();
        run(&conn).unwrap();
        // 重复执行不报错（幂等）
        run(&conn).unwrap();
        let v: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, CURRENT_VERSION);
    }

    #[test]
    fn v1_contains_all_tables() {
        let conn = Connection::open_in_memory().unwrap();
        run(&conn).unwrap();
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap();
        let names: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        for table in [
            "tracks",
            "playlists",
            "playlist_tracks",
            "liked_songs",
            "liked_playlists",
            "play_history",
            "play_stats",
            "download_tasks",
            "scan_dirs",
            "providers",
            "pending_like_ops",
            "like_sync_state",
            "themes",
            "settings",
            "schema_migrations",
            "lyrics",
            "lyric_settings",
            "play_queue",
            "search_history",
            "stat_queue",
        ] {
            assert!(names.iter().any(|n| n == table), "缺少表 {table}");
        }
    }
}
