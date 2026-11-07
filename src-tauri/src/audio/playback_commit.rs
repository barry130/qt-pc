//! 真实 Queue / PlaybackState 的短语义提交与不可变执行计划（C03）。
//!
//! 该模块不创建输出设备、读取数据库或启动加载器。Engine receiver 使用同一入口
//! 提交共享队列与快照，然后在锁外执行计划中的原始目标、事件、加载和资源退休。
//! logical target 是被接受的原票目标，不是已经挂载的 source 证明。

use std::sync::{Arc, Mutex, RwLock};

use crate::provider::types::{Quality, Track};

use super::play_intent::{PlayIntentGate, PlayTarget, QueueCommitReply};
use super::queue::Queue;
use super::state::{PlayMode, PlaybackStateSnapshot, PlaybackStatus};

/// DB 读取之前捕获的原始恢复资格，不是一次用户 pending 注册。
#[derive(Clone, Copy)]
pub struct RestoreStamp {
    generation: u64,
}

pub struct RestoredPlayback {
    pub tracks: Vec<Track>,
    pub index: usize,
    pub position_ms: u64,
    pub play_mode: PlayMode,
    pub volume: f32,
    pub muted: bool,
    pub quality: Quality,
}

enum CommitFence {
    Pending(u64),
    Restore { expected_generation: u64, generation: u64 },
}

#[derive(Clone)]
pub struct PlaybackCommitter {
    gate: PlayIntentGate,
    queue: Arc<Mutex<Queue>>,
    state: Arc<RwLock<PlaybackStateSnapshot>>,
}

/// 在 Gate 外准备；所有字段固定于这个原始候选，不从后来 B 的 queue 重组。
pub struct PreparedPlayback {
    generation: u64,
    queue: Queue,
    snapshot: PlaybackStateSnapshot,
    track: Option<Track>,
    target: Option<PlayTarget>,
    autoplay: bool,
    start_ms: u64,
}

/// 只由真实语义提交返回。资源退休、emit / persist / loader / ACK 均在返回后。
pub struct PlaybackCommitPlan {
    pub reply: QueueCommitReply,
    pub target: Option<PlayTarget>,
    pub port: Option<Arc<super::render_control::SourceSeekPort>>,
    pub track: Option<Track>,
    pub queue: Queue,
    pub snapshot: PlaybackStateSnapshot,
    pub load_gen: u64,
    pub autoplay: bool,
    pub start_ms: u64,
    pub retired_queue: Queue,
    pub retired_snapshot: PlaybackStateSnapshot,
}

/// Actual automatic queue/loading mutations, before device or persistence effects.
pub struct AutomaticAdvance {
    pub sleep_fired: bool,
    pub target: PlayTarget,
    pub track: Option<Track>,
    pub queue: Queue,
    pub snapshot: PlaybackStateSnapshot,
    pub load_gen: u64,
}

/// The loading mutation shared with the existing actor's reload path.
pub fn set_loading_snapshot(state: &mut PlaybackStateSnapshot, track: &Track, start_ms: u64) {
    state.status = PlaybackStatus::Loading;
    state.error = None;
    state.track_id = Some(track.id.clone());
    state.track = Some(track.clone());
    state.position_ms = start_ms;
    state.duration_ms = 0;
    state.buffered_ms = 0;
    state.is_local = false;
    state.bitrate_kbps = None;
}

impl PlaybackCommitter {
    /// Prepare the same auto=true selection/loading outside the authority lock.
    pub fn prepare_automatic(
        &self, original: PlayTarget, load_gen: u64, skip: impl Fn(&Track) -> bool,
    ) -> Option<AutomaticAdvance> {
        let mut snapshot = self.snapshot();
        let mut queue = self.queue_snapshot();
        let sleep_fired = snapshot.sleep_after_track;
        let track = if sleep_fired { None } else {
            queue.next_index_skipping(snapshot.play_mode, true, skip).and_then(|index| {
                queue.commit_index(index);
                queue.current().cloned()
            })
        };
        let (target, load_gen) = if let Some(track) = &track {
            snapshot.queue_index = queue.index;
            snapshot.queue_len = queue.len();
            set_loading_snapshot(&mut snapshot, track, 0);
            snapshot.source_id = Some(track.platform.clone());
            (PlayTarget::new(original.generation.checked_add(1)?, track), load_gen.wrapping_add(1))
        } else {
            snapshot.status = PlaybackStatus::Stopped;
            snapshot.position_ms = snapshot.duration_ms;
            if sleep_fired {
                snapshot.sleep_after_track = false;
                snapshot.sleep_timer_ms = None;
            }
            (original, load_gen)
        };
        Some(AutomaticAdvance { sleep_fired, target, track, queue, snapshot, load_gen })
    }

    /// Gate → Queue → State; the source callback acquires Mounts last.
    /// Snapshot/queue copies and the returned retired resources stay outside Gate.
    pub fn commit_automatic(
        &self, original: &PlayTarget, prepared: AutomaticAdvance, load_gen: &mut u64,
        register_original: impl FnOnce(&PlaybackStateSnapshot) -> bool,
    ) -> Option<AutomaticAdvance> {
        let has_next = prepared.track.is_some();
        let target_generation = prepared.target.generation;
        let mut queue_event = Some(prepared.queue.clone());
        let mut snapshot_event = Some(prepared.snapshot.clone());
        let mut prepared = Some(prepared);
        self.gate.with_automatic(original.generation, has_next, |generation| {
            if target_generation != generation { return None; }
            let mut current_queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
            let mut current_snapshot = self.state.write().unwrap_or_else(|e| e.into_inner());
            if current_snapshot.status != PlaybackStatus::Playing
                || !current_snapshot.track.as_ref().is_some_and(|track| original.matches_track(track))
                || !register_original(&current_snapshot)
            { return None; }
            let AutomaticAdvance { sleep_fired, target, track, queue, mut snapshot, load_gen: _ } =
                prepared.take().expect("one admitted automatic commit");
            let queue_event = queue_event.take().expect("prepared queue event");
            let mut snapshot_event = snapshot_event.take().expect("prepared snapshot event");
            // Source controls admitted before this Gate keep their current scalar settings.
            for next in [&mut snapshot, &mut snapshot_event] {
                next.volume = current_snapshot.volume;
                next.muted = current_snapshot.muted;
                next.speed = current_snapshot.speed;
                next.play_mode = current_snapshot.play_mode;
                if !sleep_fired {
                    next.sleep_timer_ms = current_snapshot.sleep_timer_ms;
                    next.sleep_after_track = current_snapshot.sleep_after_track;
                }
            }
            let retired_queue = std::mem::replace(&mut *current_queue, queue);
            let retired_snapshot = std::mem::replace(&mut *current_snapshot, snapshot);
            if has_next { *load_gen = load_gen.wrapping_add(1); }
            Some((AutomaticAdvance { sleep_fired, target, track, queue: queue_event,
                snapshot: snapshot_event, load_gen: *load_gen }, retired_queue, retired_snapshot))
        }).map(|(advance, _retired_queue, _retired_snapshot)| advance)
    }

    pub fn new(
        gate: PlayIntentGate,
        queue: Arc<Mutex<Queue>>,
        state: Arc<RwLock<PlaybackStateSnapshot>>,
    ) -> Self {
        Self { gate, queue, state }
    }

    pub fn gate(&self) -> &PlayIntentGate {
        &self.gate
    }

    pub fn snapshot(&self) -> PlaybackStateSnapshot {
        self.state.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn queue_snapshot(&self) -> Queue {
        self.queue.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Revalidate an immutable accepted logical owner under Gate → State.
    /// The callback is a short memory-only commit: no IO, awaits, decoder/Player
    /// calls, emits, copying whole snapshots or resource destruction.
    pub fn with_target<T>(
        &self, target: &PlayTarget, commit: impl FnOnce(&mut PlaybackStateSnapshot) -> T,
    ) -> Option<T> {
        self.gate.with_accepted(target.generation, || {
            let mut state = self.state.write().unwrap_or_else(|e| e.into_inner());
            state.track.as_ref().is_some_and(|track| target.matches_track(track))
                .then(|| commit(&mut state))
        }).flatten()
    }

    pub fn capture_restore(&self) -> Option<RestoreStamp> {
        self.gate.with_restore_capture(|generation| {
            let state = self.state.read().unwrap_or_else(|e| e.into_inner());
            state.track_id.is_none().then_some(RestoreStamp { generation })
        }).flatten()
    }

    pub fn commit_restore(
        &self,
        stamp: RestoreStamp,
        session: RestoredPlayback,
        load_gen: &mut u64,
    ) -> Option<PlaybackCommitPlan> {
        let generation = stamp.generation.wrapping_add(1);
        let mut queue = Queue::default();
        queue.set(session.tracks, session.index);
        let mut prepared = self.prepare(
            generation, queue, false, session.position_ms, Some(session.quality),
        );
        prepared.snapshot.play_mode = session.play_mode;
        prepared.snapshot.volume = session.volume.clamp(0.0, 1.0);
        prepared.snapshot.muted = session.muted;
        self.commit_prepared_inner(
            CommitFence::Restore { expected_generation: stamp.generation, generation },
            prepared,
            load_gen,
        )
    }

    pub fn prepare(
        &self,
        generation: u64,
        queue: Queue,
        autoplay: bool,
        start_ms: u64,
        quality: Option<Quality>,
    ) -> PreparedPlayback {
        let track = queue.current().cloned();
        let target = track.as_ref().map(|track| PlayTarget::new(generation, track));
        let mut snapshot = self.snapshot();
        snapshot.queue_index = queue.index;
        snapshot.queue_len = queue.len();
        snapshot.track_id = track.as_ref().map(|track| track.id.clone());
        snapshot.source_id = track.as_ref().map(|track| track.platform.clone());
        snapshot.track = track.clone();
        snapshot.status = if track.is_some() {
            PlaybackStatus::Loading
        } else {
            PlaybackStatus::Stopped
        };
        snapshot.position_ms = start_ms;
        snapshot.duration_ms = 0;
        snapshot.buffered_ms = 0;
        snapshot.is_local = false;
        snapshot.bitrate_kbps = None;
        snapshot.error = None;
        if let Some(quality) = quality {
            snapshot.quality = quality;
        }
        PreparedPlayback { generation, queue, snapshot, track, target, autoplay, start_ms }
    }

    pub fn commit_queue(
        &self,
        generation: u64,
        tracks: Vec<Track>,
        index: usize,
        load_gen: &mut u64,
    ) -> Option<PlaybackCommitPlan> {
        let mut queue = Queue::default();
        queue.set(tracks, index);
        let prepared = self.prepare(generation, queue, true, 0, None);
        self.commit_prepared(generation, prepared, load_gen)
    }

    pub fn commit_prepared(
        &self,
        generation: u64,
        prepared: PreparedPlayback,
        load_gen: &mut u64,
    ) -> Option<PlaybackCommitPlan> {
        if generation != prepared.generation {
            return None;
        }
        self.commit_prepared_inner(CommitFence::Pending(generation), prepared, load_gen)
    }

    fn commit_prepared_inner(
        &self,
        fence: CommitFence,
        prepared: PreparedPlayback,
        load_gen: &mut u64,
    ) -> Option<PlaybackCommitPlan> {
        let PreparedPlayback {
            generation: _, queue, snapshot, track, target, autoplay, start_ms,
        } = prepared;
        // 整队列复制在 Gate 外；锁内仅移动旧资源，返回后才能 drop。
        let queue_event = queue.clone();
        let snapshot_event = snapshot.clone();
        let reply = target.clone().map(QueueCommitReply::applied)
            .unwrap_or_else(QueueCommitReply::accepted_empty);
        let commit = || {
            // 锁顺序固定 Gate → Queue → State；真实三个语义变更在同一提交内。
            let mut current_queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
            let mut current_snapshot = self.state.write().unwrap_or_else(|e| e.into_inner());
            let retired_queue = std::mem::replace(&mut *current_queue, queue);
            let retired_snapshot = std::mem::replace(&mut *current_snapshot, snapshot);
            *load_gen = load_gen.wrapping_add(1);
            PlaybackCommitPlan {
                reply,
                target,
                port: None,
                track,
                queue: queue_event,
                snapshot: snapshot_event,
                load_gen: *load_gen,
                autoplay,
                start_ms,
                retired_queue,
                retired_snapshot,
            }
        };
        match fence {
            CommitFence::Pending(generation) => self.gate.with_pending(generation, commit),
            CommitFence::Restore { expected_generation, generation } => {
                self.gate.with_restore(expected_generation, generation, commit)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::types::SourceId;
    use std::sync::mpsc;
    use std::time::Duration;

    fn track_of(platform: &str, id: &str) -> Track {
        Track {
            id: id.into(),
            platform: SourceId::new(platform),
            title: id.into(),
            singer: String::new(),
            album: String::new(),
            pic_url: String::new(),
            duration: 0.0,
            music_id: None,
            start_ms: None,
            end_ms: None,
        }
    }

    #[test]
    fn held_old_queue_cannot_mutate_real_queue_snapshot_or_load_generation() {
        let gate = PlayIntentGate::new();
        let committer = PlaybackCommitter::new(
            gate.clone(),
            Arc::new(Mutex::new(Queue::default())),
            Arc::new(RwLock::new(PlaybackStateSnapshot::default())),
        );
        let load_gen = Arc::new(Mutex::new(0u64));
        let a = gate.begin();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let (done_tx, done_rx) = mpsc::channel::<bool>();
        let a_committer = committer.clone();
        let a_load_gen = Arc::clone(&load_gen);
        let worker = std::thread::spawn(move || {
            // 合成 DB 回执只在原票已捕获之后释放；没有用户 DB / 网络 / 设备。
            release_rx.recv().unwrap();
            let mut load_gen = a_load_gen.lock().unwrap();
            let applied = a_committer.commit_queue(
                a, vec![track_of("source-a", "A")], 0, &mut load_gen,
            ).is_some();
            done_tx.send(applied).unwrap();
        });
        let b = gate.begin();
        let b_plan = committer.commit_queue(
            b, vec![track_of("source-b", "B")], 0, &mut load_gen.lock().unwrap(),
        ).expect("B is the current original ticket");
        let b_generation = b_plan.load_gen;
        release_tx.send(()).unwrap();
        let old_applied = done_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        worker.join().unwrap();

        let queue = committer.queue_snapshot();
        let snapshot = committer.snapshot();
        assert!(
            !old_applied
                && queue.current().is_some_and(|track| track.platform.as_str() == "source-b" && track.id == "B")
                && snapshot.track.as_ref().is_some_and(|track| track.platform.as_str() == "source-b" && track.id == "B")
                && *load_gen.lock().unwrap() == b_generation,
            "old A changed native shared state: applied={old_applied}, queue={:?}, snapshot={:?}, load_gen={}",
            queue.current().map(|track| (track.platform.as_str(), track.id.as_str())),
            snapshot.track.as_ref().map(|track| (track.platform.as_str(), track.id.as_str())),
            *load_gen.lock().unwrap(),
        );
        assert_eq!(b_plan.reply.target, Some(PlayTarget::new(b, &track_of("source-b", "B"))));
    }

    #[test]
    fn accepted_empty_queue_clears_state_with_true_null_receipt() {
        let gate = PlayIntentGate::new();
        let committer = PlaybackCommitter::new(
            gate.clone(),
            Arc::new(Mutex::new(Queue::default())),
            Arc::new(RwLock::new(PlaybackStateSnapshot::default())),
        );
        let mut load_gen = 0;
        let first = gate.begin();
        let initial = committer.commit_queue(
            first, vec![track_of("source-a", "A")], 0, &mut load_gen,
        ).unwrap();
        let before_clear = initial.load_gen;
        let empty = gate.begin();
        let plan = committer.commit_queue(empty, Vec::new(), usize::MAX, &mut load_gen)
            .expect("a current empty queue is an accepted native action");
        let queue = committer.queue_snapshot();
        let snapshot = committer.snapshot();
        let receipt = serde_json::to_value(&plan.reply).unwrap();
        assert!(
            receipt == serde_json::json!({"applied": true, "target": null})
                && queue.is_empty()
                && queue.index.is_none()
                && snapshot.queue_len == 0
                && snapshot.track.is_none()
                && snapshot.track_id.is_none()
                && snapshot.source_id.is_none()
                && snapshot.status == PlaybackStatus::Stopped
                && load_gen > before_clear,
            "accepted empty queue must not look stale: receipt={receipt}, len={}, status={:?}, load_gen={load_gen}",
            queue.len(), snapshot.status,
        );
        assert!(!gate.abandon(empty), "finally must not revoke the accepted empty action");
    }

    #[test]
    fn an_old_prepared_source_cannot_be_renamed_to_the_current_ticket() {
        let gate = PlayIntentGate::new();
        let committer = PlaybackCommitter::new(
            gate.clone(),
            Arc::new(Mutex::new(Queue::default())),
            Arc::new(RwLock::new(PlaybackStateSnapshot::default())),
        );
        let mut load_gen = 0;
        let seed = gate.begin();
        committer.commit_queue(
            seed, vec![track_of("seed-source", "seed")], 0, &mut load_gen,
        ).unwrap();
        let before = load_gen;
        let a = gate.begin();
        let mut a_queue = Queue::default();
        a_queue.set(vec![track_of("source-a", "7")], 0);
        let prepared_a = committer.prepare(a, a_queue, true, 0, None);
        let b = gate.begin();
        // 真实 receiver 不得把 old A 以 current B 重命名；候选本身必须携带原票。
        let renamed = committer.commit_prepared(b, prepared_a, &mut load_gen);
        let queue = committer.queue_snapshot();
        let snapshot = committer.snapshot();
        assert!(
            renamed.is_none()
                && queue.current().is_some_and(|track| track.platform.as_str() == "seed-source" && track.id == "seed")
                && snapshot.track.as_ref().is_some_and(|track| track.platform.as_str() == "seed-source" && track.id == "seed")
                && load_gen == before,
            "old prepared A accepted as B: target={:?}, queue={:?}, load_gen={load_gen}",
            renamed.as_ref().and_then(|plan| plan.target.as_ref()),
            queue.current().map(|track| (track.platform.as_str(), track.id.as_str())),
        );
        let b_plan = committer.commit_queue(
            b, vec![track_of("source-b", "7")], 0, &mut load_gen,
        ).expect("rejecting foreign A must preserve the original pending B");
        assert_eq!(b_plan.reply.target, Some(PlayTarget::new(b, &track_of("source-b", "7"))));
    }

    #[test]
    fn committed_ticket_cannot_replace_the_queue_a_second_time() {
        let gate = PlayIntentGate::new();
        let committer = PlaybackCommitter::new(
            gate.clone(),
            Arc::new(Mutex::new(Queue::default())),
            Arc::new(RwLock::new(PlaybackStateSnapshot::default())),
        );
        let mut load_gen = 0;
        let original = gate.begin();
        committer.commit_queue(
            original, vec![track_of("source-a", "first")], 0, &mut load_gen,
        ).unwrap();
        let before = load_gen;
        let duplicate = committer.commit_queue(
            original, vec![track_of("source-a", "second")], 0, &mut load_gen,
        );
        let queue = committer.queue_snapshot();
        let snapshot = committer.snapshot();
        assert!(
            duplicate.is_none()
                && queue.current().is_some_and(|track| track.id == "first")
                && snapshot.track_id.as_deref() == Some("first")
                && load_gen == before,
            "committed ticket performed a second semantic commit: track={:?}, load_gen={load_gen}",
            snapshot.track_id,
        );
        assert!(gate.with_current(original, || ()).is_some(), "the accepted actor may still be fenced for its own replies");
        assert!(!gate.abandon(original));
    }

    #[test]
    fn held_startup_restore_cannot_override_a_newer_real_session_or_any_field() {
        let gate = PlayIntentGate::new();
        let state = Arc::new(RwLock::new(PlaybackStateSnapshot::default()));
        let committer = PlaybackCommitter::new(
            gate.clone(), Arc::new(Mutex::new(Queue::default())), state.clone(),
        );
        let stamp = committer.capture_restore().expect("empty startup may capture restore");
        let load_gen = Arc::new(Mutex::new(0));
        let (db_entered_tx, db_entered_rx) = mpsc::channel();
        let (db_release_tx, db_release_rx) = mpsc::channel();
        let worker_committer = committer.clone();
        let worker_gen = load_gen.clone();
        let old_restore = std::thread::spawn(move || {
            db_entered_tx.send(()).unwrap();
            db_release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            worker_committer.commit_restore(
                stamp,
                RestoredPlayback {
                    tracks: vec![track_of("legacy-source", "old")],
                    index: 0,
                    position_ms: 4_321,
                    play_mode: PlayMode::ListLoop,
                    volume: 0.8,
                    muted: false,
                    quality: Quality::default(),
                },
                &mut worker_gen.lock().unwrap(),
            )
        });
        db_entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let b = gate.begin();
        committer.commit_queue(
            b, vec![track_of("source-b", "new")], 0, &mut load_gen.lock().unwrap(),
        ).unwrap();
        {
            let mut current = state.write().unwrap();
            current.volume = 0.15;
            current.muted = true;
            current.play_mode = PlayMode::Random;
            current.quality = Quality::parse("new-source-quality").unwrap();
            current.speed = 1.7;
        }
        let before = serde_json::to_value(committer.snapshot()).unwrap();
        let before_gen = *load_gen.lock().unwrap();
        db_release_tx.send(()).unwrap();
        let old = old_restore.join().unwrap();
        let after = serde_json::to_value(committer.snapshot()).unwrap();
        let queue = committer.queue_snapshot();
        assert!(
            old.is_none()
                && after == before
                && queue.current().is_some_and(|track| track.platform.as_str() == "source-b" && track.id == "new")
                && *load_gen.lock().unwrap() == before_gen,
            "held startup restore replaced a newer real session: applied={}, after={after}",
            old.is_some(),
        );
        assert!(committer.capture_restore().is_none(), "existing track fast path must not create another restore candidate");
        assert_eq!(gate.current(), b);

        let fresh_gate = PlayIntentGate::new();
        let fresh = PlaybackCommitter::new(
            fresh_gate.clone(), Arc::new(Mutex::new(Queue::default())),
            Arc::new(RwLock::new(PlaybackStateSnapshot::default())),
        );
        let before = fresh_gate.current();
        let fresh_stamp = fresh.capture_restore().unwrap();
        assert_eq!(fresh_gate.current(), before, "capture is not a user pending registration");
        let mut fresh_gen = 0;
        let accepted = fresh.commit_restore(
            fresh_stamp,
            RestoredPlayback {
                tracks: vec![track_of("legacy-source", "old")],
                index: 0,
                position_ms: 4_321,
                play_mode: PlayMode::OneLoop,
                volume: 0.4,
                muted: true,
                quality: Quality::default(),
            },
            &mut fresh_gen,
        ).expect("current empty startup should still restore");
        assert_eq!(serde_json::to_value(&accepted.snapshot).unwrap(), serde_json::to_value(fresh.snapshot()).unwrap());
        assert!(!accepted.autoplay);
        assert_eq!(accepted.snapshot.position_ms, 4_321);
        assert!(accepted.target.as_ref().is_some_and(|target| target.generation > before));
        assert!(!fresh_gate.abandon(accepted.target.as_ref().unwrap().generation));
    }

    #[test]
    fn restore_does_not_claim_pending_work_or_revive_before_abandon_aba() {
        let gate = PlayIntentGate::new();
        let committer = PlaybackCommitter::new(
            gate.clone(), Arc::new(Mutex::new(Queue::default())),
            Arc::new(RwLock::new(PlaybackStateSnapshot::default())),
        );
        let initial = committer.capture_restore().unwrap();
        let before = serde_json::to_value(committer.snapshot()).unwrap();
        let pending = gate.begin();
        assert!(
            committer.capture_restore().is_none(),
            "startup restore captured the user's still-pending action",
        );
        assert_eq!(gate.current(), pending);
        assert!(gate.abandon(pending));
        let saved = || RestoredPlayback {
            tracks: vec![track_of("legacy-source", "old")],
            index: 0,
            position_ms: 1_234,
            play_mode: PlayMode::ListLoop,
            volume: 0.9,
            muted: false,
            quality: Quality::default(),
        };
        let mut load_gen = 0;
        assert!(committer.commit_restore(initial, saved(), &mut load_gen).is_none());
        assert_eq!(serde_json::to_value(committer.snapshot()).unwrap(), before);
        assert!(committer.queue_snapshot().is_empty());
        assert_eq!(load_gen, 0);
        assert_eq!(gate.current(), pending, "abandon must not rewind authority");
        let fresh = committer.capture_restore().expect("a new empty capture after abandon is distinct from the old startup work");
        assert_eq!(gate.current(), pending, "fresh capture must not register a user pending action");
        let accepted = committer.commit_restore(fresh, saved(), &mut load_gen).unwrap();
        assert!(accepted.target.as_ref().is_some_and(|target| target.generation > pending));
        assert_eq!(serde_json::to_value(&accepted.snapshot).unwrap(), serde_json::to_value(committer.snapshot()).unwrap());
    }
}
