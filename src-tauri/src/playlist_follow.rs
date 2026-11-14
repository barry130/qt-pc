//! Source-follow commits: membership, checkpoint and pending cloud operations share one transaction.
use rusqlite::Connection;

use crate::db::store;
use crate::provider::types::Track;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowCommit {
    pub pid: String,
    pub owner: String,
    pub expected_local_keys: Option<Vec<String>>,
    pub added: Vec<Track>,
    pub removed: Vec<Track>,
    pub expected_json: Option<String>,
    pub next_json: String,
}

fn conflict(message: &str) -> rusqlite::Error {
    rusqlite::Error::InvalidParameterName(message.into())
}

pub fn commit(conn: &Connection, input: &FollowCommit) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    let owner = store::get_setting(&tx, "like.sync.owner")?.unwrap_or_default();
    if owner != input.owner {
        return Err(conflict("账号已变化，请重新检查"));
    }
    let editable = store::list_my_playlists(&tx)?.iter().any(|p| {
        p.pid == input.pid && p.platform == "local" && !p.is_smart
    });
    if !editable {
        return Err(conflict("歌单已删除或不支持跟随"));
    }
    let key = format!("playlist.follow.v1:{}", if owner.is_empty() { "guest" } else { &owner });
    if store::get_setting(&tx, &key)? != input.expected_json {
        return Err(conflict("跟随设置已变化，请重新检查"));
    }
    let next: serde_json::Value = serde_json::from_str(&input.next_json)
        .map_err(|_| conflict("跟随设置无效"))?;
    if !next.is_array() || input.next_json.len() > 4_000_000 {
        return Err(conflict("跟随设置无效或过大"));
    }
    if let Some(expected) = &input.expected_local_keys {
        let tracks = store::get_playlist_tracks(&tx, &input.pid)?;
        let keys: Vec<String> = tracks.iter().map(|t| {
            serde_json::json!([t.platform.to_string(), t.id]).to_string()
        }).collect();
        if keys != *expected {
            return Err(conflict("歌单歌曲已变化，请重新检查差异"));
        }
    } else if !input.added.is_empty() || !input.removed.is_empty() {
        return Err(conflict("缺少歌单快照"));
    }
    if !input.added.is_empty() { store::add_tracks_to_playlist(&tx, &input.pid, &input.added)?; }
    for track in &input.removed {
        store::remove_track_from_playlist(&tx, &input.pid, track)?;
    }
    if !owner.is_empty() {
        for (tracks, action) in [(&input.added, "add"), (&input.removed, "remove")] {
            for track in tracks {
                let platform = track.platform.to_string();
                let payload = crate::astral::LikeSongPayload {
                    action, sid: &track.id, platform: &platform, name: &track.title,
                    singer: &track.singer, album: &track.album,
                    hash: track.music_id.as_deref().and_then(|v| v.split('|').next()),
                    pid: Some(&input.pid), pic_url: Some(&track.pic_url),
                };
                let target = format!("song:{platform}:{}:{}", track.id, input.pid);
                store::enqueue_pending_like_op(&tx, "song", action, &target,
                    &crate::astral::like_song_body_for_queue(&payload))?;
            }
        }
    }
    store::set_setting(&tx, &key, &input.next_json)?;
    tx.commit()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::store::tests::{new_conn, sample_track_with};

    #[test]
    fn membership_checkpoint_and_outbox_commit_together() {
        let conn = new_conn();
        store::set_setting(&conn, "like.sync.owner", "alice").unwrap();
        let pid = store::create_playlist(&conn, "follow").unwrap();
        let track = sample_track_with("new song", "artist");
        let mut input = FollowCommit { pid: pid.clone(), owner: "alice".into(),
            expected_local_keys: Some(vec![]), added: vec![track.clone()], removed: vec![],
            expected_json: None, next_json: "[]".into() };
        // Even a storage failure after membership/outbox changes must roll everything back.
        conn.execute_batch("CREATE TRIGGER fail_follow BEFORE INSERT ON settings WHEN NEW.key LIKE 'playlist.follow.%' BEGIN SELECT RAISE(ABORT, 'disk failure'); END;").unwrap();
        assert!(commit(&conn, &input).is_err());
        assert!(store::get_playlist_tracks(&conn, &pid).unwrap().is_empty());
        assert!(store::list_pending_like_ops(&conn).unwrap().is_empty());
        conn.execute_batch("DROP TRIGGER fail_follow;").unwrap();
        commit(&conn, &input).unwrap();
        assert_eq!(store::get_playlist_tracks(&conn, &pid).unwrap().len(), 1);
        assert_eq!(store::list_pending_like_ops(&conn).unwrap().len(), 1);
        assert!(commit(&conn, &input).is_err(), "stale checkpoint must fail");
        input.expected_json = Some("[]".into());
        assert!(commit(&conn, &input).is_err(), "changed membership must fail");
        input.expected_local_keys = Some(vec![serde_json::json!([track.platform, track.id]).to_string()]);
        input.owner = "bob".into();
        assert!(commit(&conn, &input).is_err(), "wrong account must fail");
    }

    #[test]
    fn membership_outbox_is_scoped_and_manual_edits_supersede_follow() {
        let conn = new_conn();
        let a = store::create_playlist(&conn, "a").unwrap();
        let b = store::create_playlist(&conn, "b").unwrap();
        let track = sample_track_with("song", "artist");
        for pid in [&a, &b] {
            store::add_tracks_to_playlist(&conn, pid, std::slice::from_ref(&track)).unwrap();
            let body = serde_json::json!({"sid": track.id, "platform": "wyy", "pid": pid, "action": "add"}).to_string();
            store::enqueue_pending_like_op(&conn, "song", "add", "old-song-key", &body).unwrap();
        }
        assert_eq!(store::list_pending_like_ops(&conn).unwrap().len(), 2);
        store::remove_track_from_playlist(&conn, &a, &track).unwrap();
        let pending = crate::playlist_cloud::filter_pending_cloud_ops(&conn, store::list_pending_like_ops(&conn).unwrap()).unwrap();
        assert_eq!(pending.len(), 1);
        assert!(pending[0].payload_json.contains(&b));
    }
}
