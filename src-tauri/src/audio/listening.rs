//! Instance-owned listening lifecycle (DESIGN §5.3).
//!
//! The engine and public regressions share the original session, thresholds and concrete
//! database writes. Only clock sampling, final reporting and execution scheduling vary.

use std::sync::{mpsc, Arc};
use std::time::Instant;

use crate::db::Database;
use crate::provider::types::Track;

const LISTEN_TICK_MAX_MS: i64 = 1_000;
const LISTEN_JUMP_MAX_MS: u64 = 3_000;
const LISTEN_FLUSH_MS: i64 = 30_000;

/// Samples the two original clock inputs; it cannot modify a listening session.
pub trait ListenClock: Send + Sync {
    fn instant(&self) -> Instant;
    fn unix_seconds(&self) -> i64;
}

struct SystemListenClock;
impl ListenClock for SystemListenClock {
    fn instant(&self) -> Instant {
        Instant::now()
    }
    fn unix_seconds(&self) -> i64 {
        crate::db::store::now_unix()
    }
}

/// Only the final external reporting calls are replaceable, not database accounting.
pub trait ListenReporter: Send + Sync {
    fn now_playing(&self, track: Track);
    fn record_listen(&self, track: Track, started_at: i64, duration_ms: i64);
}

struct SystemListenReporter {
    app: tauri::AppHandle,
    db: Option<Arc<Database>>,
}
impl ListenReporter for SystemListenReporter {
    fn now_playing(&self, track: Track) {
        crate::scrobble::now_playing(self.db.clone(), track);
    }
    fn record_listen(&self, track: Track, started_at: i64, duration_ms: i64) {
        crate::scrobble::record_listen(
            self.app.clone(),
            self.db.clone(),
            track,
            started_at,
            duration_ms,
        );
    }
}

/// Both adapters execute the same concrete database closure. Production remains detached.
#[derive(Clone, Copy)]
pub enum ListenSchedule {
    Tauri,
    Joinable,
}

/// Completion comes only after the actual database closure; dropping it does not cancel writes.
pub struct ListenWriteAck {
    completion: mpsc::Receiver<Result<(), String>>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl ListenWriteAck {
    /// Blocking observation for joined regressions, never the production audio actor.
    pub fn join(self) -> Result<(), String> {
        let completion = self
            .completion
            .recv()
            .map_err(|_| "listening database completion channel closed".to_owned());
        if let Some(worker) = self.worker {
            worker
                .join()
                .map_err(|_| "listening database worker panicked".to_owned())?;
        }
        completion?
    }
}

struct ListenSession {
    track: Track,
    last_pos_ms: u64,
    last_seen: Instant,
    pending_ms: i64,
    listened_ms: i64,
    duration_ms: i64,
    finished: bool,
    counted: bool,
    finished_written: bool,
    started_at: i64,
    scrobbled: bool,
}

struct ListenSettle {
    track: Track,
    listened_ms: i64,
    plays: i64,
    finished_plays: i64,
    session_ms: i64,
    finished: bool,
}

enum ListenWrite {
    Start(Track),
    Settle(ListenSettle),
}

fn schedule_write(
    db: Option<Arc<Database>>,
    write: ListenWrite,
    schedule: ListenSchedule,
) -> Option<ListenWriteAck> {
    let db = db?;
    let role = match &write {
        ListenWrite::Start(_) => "history",
        ListenWrite::Settle(_) => "stats",
    };
    let job = move || {
        db.with(|conn| match write {
            ListenWrite::Start(track) => crate::db::store::record_play_history(conn, &track),
            ListenWrite::Settle(s) => {
                crate::db::store::record_listen(
                    conn,
                    &s.track,
                    s.listened_ms,
                    s.plays,
                    s.finished_plays,
                )?;
                crate::db::store::update_play_history_progress(
                    conn,
                    &s.track,
                    s.session_ms,
                    s.finished,
                )
            }
        })
    };
    let (sent, completion) = mpsc::sync_channel(1);
    let worker = match schedule {
        ListenSchedule::Tauri => {
            tauri::async_runtime::spawn(async move {
                let result = tauri::async_runtime::spawn_blocking(job).await;
                let result = match result {
                    Ok(result) => {
                        if let Err(error) = &result {
                            log::warn!("[{role}] 写入失败: {error}");
                        }
                        result
                    }
                    Err(error) => {
                        log::warn!("[{role}] 任务异常: {error}");
                        Err(error.to_string())
                    }
                };
                let _ = sent.send(result);
            });
            None
        }
        ListenSchedule::Joinable => Some(std::thread::spawn(move || {
            let result = job();
            if let Err(error) = &result {
                log::warn!("[{role}] 写入失败: {error}");
            }
            let _ = sent.send(result);
        })),
    };
    Some(ListenWriteAck { completion, worker })
}

/// A separate history ticket preserves the owner check between begin and history publication.
/// Dropping an uncommitted ticket writes no history, including the reopen-without-next path.
pub struct ListenMount {
    db: Option<Arc<Database>>,
    track: Track,
    schedule: ListenSchedule,
}
impl ListenMount {
    pub fn record_play_start(self) -> Option<ListenWriteAck> {
        schedule_write(self.db, ListenWrite::Start(self.track), self.schedule)
    }
}

pub struct ListenLifecycle {
    session: Option<ListenSession>,
    db: Option<Arc<Database>>,
    clock: Arc<dyn ListenClock>,
    reporter: Arc<dyn ListenReporter>,
    schedule: ListenSchedule,
}
impl ListenLifecycle {
    pub fn new(
        db: Option<Arc<Database>>,
        clock: Arc<dyn ListenClock>,
        reporter: Arc<dyn ListenReporter>,
        schedule: ListenSchedule,
    ) -> Self {
        Self {
            session: None,
            db,
            clock,
            reporter,
            schedule,
        }
    }

    pub(crate) fn production(app: tauri::AppHandle, db: Option<Arc<Database>>) -> Self {
        let reporter = Arc::new(SystemListenReporter {
            app,
            db: db.clone(),
        });
        Self::new(
            db,
            Arc::new(SystemListenClock),
            reporter,
            ListenSchedule::Tauri,
        )
    }

    /// Mechanical equivalent of the original identity check followed by end settlement.
    /// Begin itself deliberately does not settle a mismatching previous session.
    pub fn before_load(&mut self, track: &Track) -> Option<ListenWriteAck> {
        if self
            .session
            .as_ref()
            .is_some_and(|s| !s.track.same_identity(track))
        {
            self.settle(false, true)
        } else {
            None
        }
    }

    pub fn begin_mount(
        &mut self,
        track: &Track,
        duration_ms: u64,
        position_ms: u64,
    ) -> ListenMount {
        if let Some(s) = self.session.as_mut() {
            if s.track.same_identity(track) {
                s.last_pos_ms = position_ms;
                s.last_seen = self.clock.instant();
                if duration_ms > 0 {
                    s.duration_ms = duration_ms as i64;
                }
                return ListenMount {
                    db: self.db.clone(),
                    track: track.clone(),
                    schedule: self.schedule,
                };
            }
        }
        self.session = Some(ListenSession {
            track: track.clone(),
            last_pos_ms: position_ms,
            last_seen: self.clock.instant(),
            pending_ms: 0,
            listened_ms: 0,
            duration_ms: duration_ms as i64,
            finished: false,
            counted: false,
            finished_written: false,
            started_at: self.clock.unix_seconds(),
            scrobbled: false,
        });
        self.reporter.now_playing(track.clone());
        ListenMount {
            db: self.db.clone(),
            track: track.clone(),
            schedule: self.schedule,
        }
    }

    pub fn accrue(&mut self, pos_ms: u64) -> Option<ListenWriteAck> {
        let due = {
            let s = self.session.as_mut()?;
            let now = self.clock.instant();
            let dt = now.saturating_duration_since(s.last_seen).as_millis() as i64;
            let advanced = pos_ms > s.last_pos_ms && pos_ms - s.last_pos_ms <= LISTEN_JUMP_MAX_MS;
            s.last_pos_ms = pos_ms;
            s.last_seen = now;
            if advanced {
                let dt = dt.clamp(0, LISTEN_TICK_MAX_MS);
                s.pending_ms += dt;
                s.listened_ms += dt;
            }
            s.pending_ms >= LISTEN_FLUSH_MS
        };
        if due {
            self.settle(false, false)
        } else {
            None
        }
    }

    pub fn settle(&mut self, finished: bool, end: bool) -> Option<ListenWriteAck> {
        let (payload, scrobble) = {
            let s = self.session.as_mut()?;
            if finished {
                s.finished = true;
            }
            let plays = if !s.counted
                && crate::db::store::counts_as_play(s.finished, s.listened_ms, s.duration_ms)
            {
                s.counted = true;
                1
            } else {
                0
            };
            let finished_plays = if s.finished && !s.finished_written {
                s.finished_written = true;
                1
            } else {
                0
            };
            // Preserve the independent existing accounting and reporting thresholds.
            let scrobble =
                if !s.scrobbled && crate::scrobble::should_scrobble(s.listened_ms, s.duration_ms) {
                    s.scrobbled = true;
                    Some((s.track.clone(), s.started_at, s.duration_ms))
                } else {
                    None
                };
            (
                ListenSettle {
                    track: s.track.clone(),
                    listened_ms: std::mem::take(&mut s.pending_ms),
                    plays,
                    finished_plays,
                    session_ms: s.listened_ms,
                    finished: s.finished,
                },
                scrobble,
            )
        };
        if end {
            self.session = None;
        }
        let ack = if payload.listened_ms > 0 || payload.plays > 0 || payload.finished_plays > 0 {
            schedule_write(self.db.clone(), ListenWrite::Settle(payload), self.schedule)
        } else {
            None
        };
        if let Some((track, started_at, duration_ms)) = scrobble {
            self.reporter.record_listen(track, started_at, duration_ms);
        }
        ack
    }
}

#[cfg(test)]
mod tests;
