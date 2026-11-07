//! Agreed public lifecycle + actual database boundary; no private sessions or seeded SQL.
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::audio::listening::{
    ListenClock, ListenLifecycle, ListenReporter, ListenSchedule, ListenWriteAck,
};
use crate::db::Database;
use crate::provider::types::Track;

struct OwnedListenDirectory(PathBuf);
impl OwnedListenDirectory {
    fn new() -> Self {
        let path = crate::public_test_fixture::root().join(format!(
            "c17-listen-{}-{:x}",
            std::process::id(),
            fastrand::u64(..),
        ));
        std::fs::create_dir(&path).expect("exclusive listening fixture directory");
        Self(path)
    }
}
impl Drop for OwnedListenDirectory {
    fn drop(&mut self) {
        assert_eq!(
            self.0.parent(),
            Some(crate::public_test_fixture::root().as_path())
        );
        let metadata = std::fs::symlink_metadata(&self.0).expect("owned directory remains present");
        assert!(metadata.is_dir() && !metadata.file_type().is_symlink());
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            assert_eq!(metadata.file_attributes() & 0x400, 0);
        }
        assert_eq!(self.0.canonicalize().unwrap(), self.0);
        std::fs::remove_dir_all(&self.0).expect("remove only the created owned directory");
    }
}

struct OwnedClock {
    origin: Instant,
    unix_origin: i64,
    elapsed_ms: Mutex<u64>,
}
impl OwnedClock {
    fn new() -> Self {
        Self {
            origin: Instant::now(),
            unix_origin: 1_800_000_000,
            elapsed_ms: Mutex::new(0),
        }
    }
    fn advance_wall(&self, ms: u64) {
        *self.elapsed_ms.lock().unwrap() += ms;
    }
}
impl ListenClock for OwnedClock {
    fn instant(&self) -> Instant {
        self.origin + Duration::from_millis(*self.elapsed_ms.lock().unwrap())
    }
    fn unix_seconds(&self) -> i64 {
        self.unix_origin + (*self.elapsed_ms.lock().unwrap() / 1_000) as i64
    }
}

type TrackKey = (String, String);
type ReportedListen = (TrackKey, i64, i64);
#[derive(Default)]
struct Reports {
    now_playing: Mutex<Vec<TrackKey>>,
    listens: Mutex<Vec<ReportedListen>>,
}
impl ListenReporter for Reports {
    fn now_playing(&self, track: Track) {
        self.now_playing
            .lock()
            .unwrap()
            .push((track.platform.as_str().to_owned(), track.id));
    }
    fn record_listen(&self, track: Track, started_at: i64, duration_ms: i64) {
        self.listens.lock().unwrap().push((
            (track.platform.as_str().to_owned(), track.id),
            started_at,
            duration_ms,
        ));
    }
}

fn track(platform: &str, title: &str) -> Track {
    Track {
        id: "42".into(),
        platform: crate::provider::types::SourceId::parse(platform).expect("owned source ID"),
        title: title.into(),
        singer: "owned singer".into(),
        album: "owned album".into(),
        pic_url: String::new(),
        duration: 60.0,
        music_id: None,
        start_ms: None,
        end_ms: None,
    }
}
fn join(ack: Option<ListenWriteAck>) {
    if let Some(ack) = ack {
        ack.join().expect("actual database write completed");
    }
}
fn ticks(lifecycle: &mut ListenLifecycle, clock: &OwnedClock, position: &mut u64, count: u32) {
    for _ in 0..count {
        clock.advance_wall(1_000);
        *position += 1_000;
        join(lifecycle.accrue(*position));
    }
}
fn progress(db: &Database, track: &Track, ms: i64, completed: bool) {
    let progress = db
        .history_progress(track)
        .unwrap()
        .expect("actual history row");
    assert_eq!(
        (progress.played_duration_ms, progress.completed),
        (ms, completed)
    );
    assert!(progress.played_at > 0);
    let history = db
        .play_history(0)
        .unwrap()
        .into_iter()
        .find(|item| item.track.same_identity(track))
        .expect("public history contains track");
    assert_eq!(history.played_at, progress.played_at);
}
fn empty(db: &Database, wyy: &Track, qq: &Track) {
    let overview = db.play_overview().unwrap();
    assert_eq!(
        (
            overview.total_plays,
            overview.total_ms,
            overview.track_count,
            overview.finished_plays,
            overview.active_days
        ),
        (0, 0, 0, 0, 0)
    );
    assert_eq!(overview.last_played_at, None);
    assert!(db.top_tracks(0).unwrap().is_empty());
    assert!(db.play_history(0).unwrap().is_empty());
    assert_eq!(db.history_progress(wyy).unwrap(), None);
    assert_eq!(db.history_progress(qq).unwrap(), None);
}
fn close(db: Arc<Database>) {
    let Ok(db) = Arc::try_unwrap(db) else {
        panic!("all actual database writers must be joined");
    };
    drop(db);
}

#[test]
fn listen_lifecycle_keeps_identity_sessions_and_resets_actual_database_across_reopen() {
    let owned = OwnedListenDirectory::new();
    let file = owned.0.join("listening.sqlite");
    let db = Arc::new(Database::open(&file).unwrap());
    let clock = Arc::new(OwnedClock::new());
    let reports = Arc::new(Reports::default());
    let mut lifecycle = ListenLifecycle::new(
        Some(db.clone()),
        clock.clone(),
        reports.clone(),
        ListenSchedule::Joinable,
    );
    let wyy = track("wyy", "original WYY");
    let qq = track("qq", "original QQ");
    empty(&db, &wyy, &qq);

    let wyy_start = clock.unix_seconds();
    // An uncommitted ticket writes no history; this does not prove the owner gate or device.
    drop(lifecycle.begin_mount(&wyy, 60_000, 0));
    assert_eq!(db.history_progress(&wyy).unwrap(), None);
    join(lifecycle.begin_mount(&wyy, 60_000, 0).record_play_start());
    progress(&db, &wyy, 0, false);
    let mut pos = 0;
    ticks(&mut lifecycle, &clock, &mut pos, 30);
    progress(&db, &wyy, 30_000, false);
    assert_eq!(db.top_tracks(0).unwrap()[0].play_count, 1);
    ticks(&mut lifecycle, &clock, &mut pos, 2);
    join(lifecycle.settle(false, false));
    progress(&db, &wyy, 32_000, false);
    clock.advance_wall(10_000);
    join(lifecycle.accrue(pos));
    join(lifecycle.settle(false, false));
    progress(&db, &wyy, 32_000, false);
    ticks(&mut lifecycle, &clock, &mut pos, 3);
    join(lifecycle.before_load(&qq));
    progress(&db, &wyy, 35_000, false);

    let qq_start = clock.unix_seconds();
    pos = 0;
    join(lifecycle.begin_mount(&qq, 60_000, pos).record_play_start());
    ticks(&mut lifecycle, &clock, &mut pos, 20);
    let reload = Track {
        title: "QQ reloaded metadata".into(),
        duration: 80.0,
        ..qq.clone()
    };
    clock.advance_wall(10_000);
    assert!(lifecycle.before_load(&reload).is_none());
    join(
        lifecycle
            .begin_mount(&reload, 80_000, pos)
            .record_play_start(),
    );
    progress(&db, &qq, 0, false);
    assert_eq!(reports.now_playing.lock().unwrap().len(), 2);
    ticks(&mut lifecycle, &clock, &mut pos, 10);
    progress(&db, &qq, 30_000, false);
    let qq_stat = db
        .top_tracks(0)
        .unwrap()
        .into_iter()
        .find(|item| item.track.same_identity(&qq))
        .unwrap();
    assert_eq!((qq_stat.play_count, qq_stat.total_played_ms), (0, 30_000));
    assert_eq!(reports.listens.lock().unwrap().len(), 1);
    ticks(&mut lifecycle, &clock, &mut pos, 10);
    join(lifecycle.settle(false, false));
    progress(&db, &qq, 40_000, false);

    let reload_again = Track {
        title: "QQ metadata after qualification".into(),
        ..reload.clone()
    };
    clock.advance_wall(20_000);
    assert!(lifecycle.before_load(&reload_again).is_none());
    join(
        lifecycle
            .begin_mount(&reload_again, 80_000, pos)
            .record_play_start(),
    );
    progress(&db, &qq, 0, false);
    assert_eq!(
        db.play_history(0)
            .unwrap()
            .into_iter()
            .find(|item| item.track.same_identity(&qq))
            .unwrap()
            .track
            .title,
        reload_again.title
    );
    ticks(&mut lifecycle, &clock, &mut pos, 30);
    progress(&db, &qq, 70_000, false);
    // Original session metadata, pending duration, start and one-shot flags survive reloads.
    assert_eq!(
        db.play_history(0)
            .unwrap()
            .into_iter()
            .find(|item| item.track.same_identity(&qq))
            .unwrap()
            .track
            .title,
        qq.title
    );
    assert!(lifecycle.settle(false, false).is_none());
    join(lifecycle.settle(true, true));
    assert!(lifecycle.settle(true, true).is_none());
    progress(&db, &qq, 70_000, true);
    let stats: BTreeMap<_, _> = db
        .top_tracks(0)
        .unwrap()
        .into_iter()
        .map(|item| {
            (
                item.track.platform.as_str().to_owned(),
                (item.play_count, item.total_played_ms),
            )
        })
        .collect();
    assert_eq!(
        stats,
        BTreeMap::from([
            ("wyy".to_owned(), (1, 35_000)),
            ("qq".to_owned(), (1, 70_000)),
        ])
    );
    let overview = db.play_overview().unwrap();
    assert_eq!(
        (
            overview.total_plays,
            overview.total_ms,
            overview.track_count,
            overview.finished_plays
        ),
        (2, 105_000, 2, 1)
    );
    assert_eq!(
        *reports.now_playing.lock().unwrap(),
        vec![
            ("wyy".to_owned(), "42".to_owned()),
            ("qq".to_owned(), "42".to_owned()),
        ]
    );
    assert_eq!(
        *reports.listens.lock().unwrap(),
        vec![
            (("wyy".to_owned(), "42".to_owned()), wyy_start, 60_000),
            (("qq".to_owned(), "42".to_owned()), qq_start, 80_000),
        ]
    );

    assert_eq!(db.clear_listen_stats().unwrap(), 2);
    empty(&db, &wyy, &qq);
    drop(lifecycle);
    close(db);
    let db = Arc::new(Database::open(&file).unwrap());
    empty(&db, &wyy, &qq);
    let mut lifecycle = ListenLifecycle::new(
        Some(db.clone()),
        clock.clone(),
        reports.clone(),
        ListenSchedule::Joinable,
    );
    clock.advance_wall(1_000);
    let restarted_qq_start = clock.unix_seconds();
    pos = 0;
    join(lifecycle.begin_mount(&qq, 80_000, pos).record_play_start());
    ticks(&mut lifecycle, &clock, &mut pos, 40);
    join(lifecycle.settle(false, true));
    progress(&db, &qq, 40_000, false);
    let overview = db.play_overview().unwrap();
    assert_eq!(
        (
            overview.total_plays,
            overview.total_ms,
            overview.track_count,
            overview.finished_plays
        ),
        (1, 40_000, 1, 0)
    );
    assert_eq!(db.play_history(0).unwrap().len(), 1);
    assert_eq!(db.top_tracks(0).unwrap()[0].track.platform.as_str(), "qq");
    assert_eq!(db.history_progress(&wyy).unwrap(), None);
    assert_eq!(reports.now_playing.lock().unwrap().len(), 3);
    assert_eq!(
        *reports.listens.lock().unwrap(),
        vec![
            (("wyy".to_owned(), "42".to_owned()), wyy_start, 60_000),
            (("qq".to_owned(), "42".to_owned()), qq_start, 80_000),
            (
                ("qq".to_owned(), "42".to_owned()),
                restarted_qq_start,
                80_000
            ),
        ]
    );
    drop(lifecycle);
    close(db);
}
