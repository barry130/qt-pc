//! 播客字幕独立于歌曲歌词：保留句子结束时间、分段覆盖范围与版本，避免换集/导入竞态。
mod audio;
mod commands;
mod install;
mod models;
mod offline;
mod parse;
mod translation;
pub use commands::*;
pub use install::*;
pub use models::*;
pub use offline::*;
pub use translation::*;
pub use parse::transcript_links;

use crate::db::Database;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TranscriptLink {
    pub url: String,
    #[serde(default)]
    pub mime: String,
    #[serde(default)]
    pub language: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cue {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    #[serde(default)]
    pub translation: String,
    /// 仅用于生成片段的阅读排序；无时间轴文字稿的 start/end 保持为零。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk_index: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SubtitleDocument {
    pub revision: i64,
    pub source: String,
    pub timed: bool,
    pub cues: Vec<Cue>,
    pub completed_chunks: Vec<i64>,
    /// 20-second local windows; only fully covered five-minute batches enter completed_chunks.
    pub completed_windows: Vec<i64>,
    pub duration_ms: i64,
    pub recognizer: String,
}
impl Default for SubtitleDocument {
    fn default() -> Self {
        Self {
            revision: 0,
            source: String::new(),
            timed: true,
            cues: Vec::new(),
            completed_chunks: Vec::new(),
            completed_windows: Vec::new(),
            duration_ms: 0,
            recognizer: String::new(),
        }
    }
}

pub(super) struct Episode {
    id: String,
    url: String,
    feed_url: String,
    links: Vec<TranscriptLink>,
    local_audio_path: String,
}

fn episode(db: &Database, audio_url: &str) -> Result<Episode, String> {
    db.with(|conn| conn.query_row(
        "SELECT e.id,e.audio_url,s.url,e.transcripts_json,e.subtitle_audio_path FROM podcast_episodes e JOIN podcast_shows s ON s.id=e.show_id WHERE e.audio_url=?1 ORDER BY s.created_at DESC LIMIT 1",
        [audio_url], |row| Ok(Episode { id: row.get(0)?, url: row.get(1)?, feed_url: row.get(2)?, links: serde_json::from_str(&row.get::<_, String>(3)?).unwrap_or_default(), local_audio_path: row.get(4)? }),
    )).map_err(|_| "未找到这集播客，请刷新订阅后重试".into())
}

fn load(db: &Database, episode_id: &str) -> Result<SubtitleDocument, String> {
    let raw: Option<String> = db.with(|conn| {
        conn.query_row(
            "SELECT document_json FROM podcast_subtitles WHERE episode_id=?1",
            [episode_id],
            |row| row.get(0),
        )
        .optional()
    })?;
    raw.map(|text| serde_json::from_str(&text).map_err(|_| "已保存的字幕无法读取".into()))
        .unwrap_or_else(|| Ok(SubtitleDocument::default()))
}

fn save(
    db: &Database,
    id: &str,
    mut document: SubtitleDocument,
    expected: i64,
) -> Result<SubtitleDocument, String> {
    document.revision = expected + 1;
    let json = serde_json::to_string(&document).map_err(|_| "字幕保存失败")?;
    if json.len() > 16 * 1024 * 1024 {
        return Err("字幕内容超过保存上限".into());
    }
    let changed = db.with(|conn| conn.execute(
        "INSERT INTO podcast_subtitles(episode_id,revision,document_json) SELECT ?1,?2,?3 WHERE ?4=0 OR EXISTS(SELECT 1 FROM podcast_subtitles WHERE episode_id=?1) ON CONFLICT(episode_id) DO UPDATE SET revision=excluded.revision, document_json=excluded.document_json WHERE podcast_subtitles.revision=?4",
        params![id, document.revision, json, expected],
    ))?;
    if changed != 1 {
        return Err("字幕已被更新，请重新加载后再试".into());
    }
    Ok(document)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn revision_guard_and_delete_cascade() {
        let db = Database::open_in_memory().unwrap();
        db.with(|c| c.execute_batch("INSERT INTO podcast_shows(id,url,title,author,description,image,last_fetched_at,created_at) VALUES('s','https://a.test/rss','S','','','',0,0); INSERT INTO podcast_episodes(id,show_id,title,description,audio_url,duration_ms,published_at,played,position_ms,created_at) VALUES('e','s','E','','https://a.test/e.mp3',0,0,0,0,0);")).unwrap();
        let first = save(&db, "e", SubtitleDocument::default(), 0).unwrap();
        assert_eq!(load(&db, "e").unwrap().revision, first.revision);
        assert!(save(&db, "e", SubtitleDocument::default(), 0).is_err());
        // 取消订阅先删 episodes，再删 shows（旧 schema 的 show_id 无外键）。
        db.with(|c| c.execute_batch("DELETE FROM podcast_episodes WHERE show_id='s'; DELETE FROM podcast_shows WHERE id='s';")).unwrap();
        assert!(save(&db, "e", first, 1).is_err());
        assert_eq!(load(&db, "e").unwrap().revision, 0);
    }
}
