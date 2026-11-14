//! 播放意图提交闸门（C03）。
//!
//! 所有队列提交通过同一个公有入口检查原始意图；检查与短提交必须共用注册锁，
//! 不能把耗时 I/O、解码、emit、持久化、资源析构或 await 放入提交回调。
//!
//! `with_current` 在注册使用的同一 Mutex 内检查原票并执行短提交；
//! 后续引擎接线同样不能把检查和真实 queue/state 变更拆开。

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::provider::types::Track;

/// 一次被接受的播放提交的原始目标，不拼接 platform/id。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayTarget {
    pub generation: u64,
    pub platform: String,
    pub id: String,
}

impl PlayTarget {
    pub fn new(generation: u64, track: &Track) -> Self {
        Self {
            generation,
            platform: track.platform.as_str().into(),
            id: track.id.clone(),
        }
    }

    pub fn matches_track(&self, track: &Track) -> bool {
        self.platform == track.platform.as_str() && self.id == track.id
    }
}

/// 区分接受的空队列、过时拒绝与实际参数/数据库错误。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueCommitReply {
    pub applied: bool,
    pub target: Option<PlayTarget>,
}

impl QueueCommitReply {
    pub fn applied(target: PlayTarget) -> Self {
        Self { applied: true, target: Some(target) }
    }

    pub fn accepted_empty() -> Self {
        Self { applied: true, target: None }
    }

    pub fn rejected() -> Self {
        Self { applied: false, target: None }
    }
}

/// 手动播放、媒体键和异步队列提交共用的意图闸门。
#[derive(Clone)]
pub struct PlayIntentGate {
    state: Arc<Mutex<IntentState>>,
}

struct IntentState {
    generation: u64,
    valid: bool,
    pending: bool,
}

impl Default for PlayIntentGate {
    fn default() -> Self {
        Self::new()
    }
}

impl PlayIntentGate {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(IntentState {
                generation: 0,
                valid: true,
                pending: false,
            })),
        }
    }

    pub fn register(&self) -> u64 {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.generation = state.generation.wrapping_add(1);
        state.valid = true;
        state.pending = true;
        state.generation
    }

    /// IPC 和原生入口共用的新意图声明，不接收已存在的原票。
    pub fn begin(&self) -> u64 {
        self.register()
    }

    /// 只取消自己的未提交原票，不回退代次，也不撤销已经提交的目标。
    pub fn abandon(&self, generation: u64) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.generation != generation || !state.pending {
            return false;
        }
        state.pending = false;
        state.valid = false;
        true
    }

    pub fn current(&self) -> u64 {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).generation
    }

    pub fn is_current(&self, generation: u64) -> bool {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.generation == generation && state.valid
    }

    /// A mounted source may advance only its accepted generation, with no pending user.
    /// The next accepted generation and semantic/source registration share this lock.
    pub fn with_automatic<T>(
        &self, original: u64, has_next: bool, commit: impl FnOnce(u64) -> Option<T>,
    ) -> Option<T> {
        let result = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.generation != original || !state.valid || state.pending { return None; }
            let generation = if has_next { original.checked_add(1)? } else { original };
            let result = commit(generation)?;
            state.generation = generation;
            state.valid = true;
            state.pending = false;
            result
        };
        Some(result)
    }

    /// 与字段检查共用 Gate 的只读恢复捕获；不改变代次或 pending。
    pub fn with_restore_capture<T>(&self, capture: impl FnOnce(u64) -> T) -> Option<T> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.pending {
            return None;
        }
        Some(capture(state.generation))
    }

    /// 启动恢复只在原资格仍在、且没有用户 pending 时提交，不注册 pending。
    pub fn with_restore<T>(
        &self,
        expected_generation: u64,
        generation: u64,
        f: impl FnOnce() -> T,
    ) -> Option<T> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.generation != expected_generation || state.pending {
            return None;
        }
        state.generation = generation;
        state.valid = true;
        state.pending = false;
        Some(f())
    }

    /// 手动队列语义提交只消费自己的未提交原票一次。
    pub fn with_pending<T>(&self, generation: u64, f: impl FnOnce() -> T) -> Option<T> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.generation != generation || !state.valid || !state.pending {
            return None;
        }
        state.pending = false;
        Some(f())
    }

    /// 已提交原票的短只读回执栅栏；不接纳或消费任何 pending。
    /// 回调不可 await、I/O 或重入 Gate。
    pub fn with_accepted<T>(&self, generation: u64, f: impl FnOnce() -> T) -> Option<T> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.generation != generation || !state.valid || state.pending {
            return None;
        }
        Some(f())
    }

    /// 同步、短提交入口。回调不可 await、I/O 或重入 register。
    /// 注册无法在检查通过与真实提交之间穿插。
    pub fn with_current<T>(&self, generation: u64, f: impl FnOnce() -> T) -> Option<T> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.generation != generation || !state.valid {
            return None;
        }
        state.pending = false;
        Some(f())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::types::{SourceId, Track};
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
            recording: Default::default(), music_id: None,
            start_ms: None,
            end_ms: None,
        }
    }

    /// A 的实际提交被合成 DB 边界挂住；通过公有 register 注册 B 后，
    /// 放行 A 不得产生 SetQueue 副作用，B 仍可经同一入口提交原始目标。
    #[test]
    fn db_held_queue_commit_is_dropped_after_a_newer_intent() {
        let gate = PlayIntentGate::new();
        let effects: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));
        let a_generation = gate.register();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let (done_tx, done_rx) = mpsc::channel::<bool>();

        let worker = {
            let gate = gate.clone();
            let effects = Arc::clone(&effects);
            std::thread::spawn(move || {
                release_rx.recv().expect("A 等待放行");
                let applied = gate.with_current(a_generation, || {
                    effects.lock().unwrap_or_else(|e| e.into_inner()).push("A SetQueue");
                    true
                });
                done_tx.send(applied.is_some()).expect("回传 A 是否提交");
            })
        };

        let b_generation = gate.register();
        assert_ne!(b_generation, a_generation, "B 必须拿到新代次");
        assert!(gate.is_current(b_generation));
        assert!(!gate.is_current(a_generation));
        release_tx.send(()).expect("放行 A");
        let a_committed = done_rx.recv_timeout(Duration::from_secs(5)).expect("A 完成");
        worker.join().expect("join A");

        assert!(!a_committed, "A 的 SetQueue 不得在 B 之后实际提交");
        assert!(
            effects.lock().unwrap_or_else(|e| e.into_inner()).is_empty(),
            "A 的提交副作用（SetQueue 实际生效）不得发生"
        );

        let b_result = gate
            .with_current(b_generation, || {
                effects.lock().unwrap_or_else(|e| e.into_inner()).push("B SetQueue");
                Some(PlayTarget::new(b_generation, &track_of("wyy", "b")))
            })
            .expect("B 的提交应当执行");
        let b_target = b_result.expect("B 应产生 target");
        assert_eq!(b_target, PlayTarget::new(b_generation, &track_of("wyy", "b")));
        assert!(b_target.matches_track(&track_of("wyy", "b")));
        assert_eq!(
            *effects.lock().unwrap_or_else(|e| e.into_inner()),
            vec!["B SetQueue"]
        );
    }

    #[test]
    fn abandoned_pending_intent_cannot_commit_or_cancel_other_owners() {
        let gate = PlayIntentGate::new();
        let mut effects = Vec::new();
        let a = gate.begin();
        let _ = gate.abandon(a);
        let abandoned_commit = gate.with_current(a, || effects.push("abandoned A"));
        assert!(
            abandoned_commit.is_none() && effects.is_empty(),
            "abandoned pending ticket reached the real commit: {effects:?}"
        );

        let b = gate.begin();
        assert!(b > a, "abandon must not rewind or reuse an intent ticket");
        assert!(!gate.abandon(a), "A cannot cancel B's pending ownership");
        let b_target = gate.with_current(b, || {
            effects.push("committed B");
            PlayTarget::new(b, &track_of("qq", "b"))
        }).expect("B remains able to commit through the public gate");
        assert_eq!(b_target, PlayTarget::new(b, &track_of("qq", "b")));
        assert!(!gate.abandon(b), "finally cannot cancel a committed ticket");
        assert!(gate.is_current(b), "committed B must survive its caller's finally");
        assert_eq!(effects, vec!["committed B"]);
    }
}
