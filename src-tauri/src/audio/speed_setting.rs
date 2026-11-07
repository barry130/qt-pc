//! Captured source speed persistence and caller receipts.
//!
//! Qualification is persistence admission, not cancellation of an admitted SQLite write.
//! A superseded completion may have stored its original value; it never stores a later
//! snapshot and must never be exposed as a current successful source receipt.

use std::sync::{Arc, atomic::{AtomicBool, AtomicU64, Ordering}};
use std::time::Duration;
use super::engine::SourceControlOwner;
use super::render_control::{MountStamp, SourceSeekPort};
use super::state::PlaybackStateSnapshot;

/// Explicit global transport work, captured at the sender rather than the actor.
/// This carries no source authority and cannot be upgraded into a Some receipt.
pub struct NativeSpeedSetting {
    state: Arc<std::sync::RwLock<PlaybackStateSnapshot>>,
    clock: Arc<AtomicU64>,
    revision: u64,
    speed: f32,
}
impl NativeSpeedSetting {
    pub(super) fn new(state: Arc<std::sync::RwLock<PlaybackStateSnapshot>>,
        clock: Arc<AtomicU64>, revision: u64, speed: f32) -> Self
    {
        Self { state, clock, revision, speed }
    }
    pub fn speed(&self) -> f32 { self.speed }
    pub(super) fn qualifies(&self) -> bool {
        // Both source and Native commits own State while changing this clock.
        // Wait for that commit to finish, without acquiring source Gate/Mounts.
        let _state = self.state.read().unwrap_or_else(|e| e.into_inner());
        self.clock.load(Ordering::Acquire) == self.revision
    }
    pub(super) fn persist(self, db: Option<&Database>) -> Result<bool, String> {
        let Some(db) = db else { return Ok(false); };
        db.with(|conn| {
            if !self.qualifies() { return Ok(false); }
            // Admission ends before SQL. Never read a newer snapshot's speed.
            crate::db::store::set_setting(conn, "playback.speed", &self.speed.to_string())?;
            Ok(true)
        })
    }
}
use crate::db::{Database, store};

#[derive(Clone)]
pub(super) struct SourceSpeedAuthority {
    owner: SourceControlOwner,
    original: Arc<SourceSeekPort>,
    clock: Arc<AtomicU64>,
    revision: u64,
    speed: f32,
    cancelled: Arc<AtomicBool>,
}
impl SourceSpeedAuthority {
    pub(super) fn new(owner: SourceControlOwner, original: Arc<SourceSeekPort>,
        clock: Arc<AtomicU64>, revision: u64, speed: f32) -> Self
    {
        Self { owner, original, clock, revision, speed,
            cancelled: Arc::new(AtomicBool::new(false)) }
    }
    pub(super) fn stamp(&self) -> &MountStamp { self.original.stamp() }
    fn qualifies(&self) -> bool {
        !self.cancelled.load(Ordering::Acquire)
            && self.owner.qualifies_speed(&self.original, &self.clock, self.revision)
    }
}

pub struct SpeedSettingReceipt {
    pub stamp: MountStamp,
    pub speed: f32,
}

/// Nonforgeable queued work: identity, captured value and revision never get rebound.
pub struct SourceSpeedSetting {
    authority: SourceSpeedAuthority,
    reply: tokio::sync::oneshot::Sender<Result<SpeedSettingReceipt, String>>,
}
impl SourceSpeedSetting {
    pub(super) fn new(authority: SourceSpeedAuthority) -> (Self, SpeedSettingPending) {
        let (reply, receiver) = tokio::sync::oneshot::channel();
        let pending = SpeedSettingPending { reply: receiver, authority: authority.clone(), completed: false };
        (Self { authority, reply }, pending)
    }
    pub fn stamp(&self) -> &MountStamp { self.authority.stamp() }
    pub fn speed(&self) -> f32 { self.authority.speed }

    pub(super) fn persist(self, db: Option<&Database>) -> Result<bool, String> {
        // Acquire SQLite's own serialization outside Gate, then authorize this exact
        // request. No SQL or database lock acquisition occurs inside with_original.
        let result = match db {
            Some(db) => db.with(|conn| {
                if !self.authority.qualifies() { return Ok(false); }
                store::set_setting(conn, "playback.speed", &self.authority.speed.to_string())?;
                Ok(true)
            }),
            None => Err(String::from("database unavailable for source speed persistence")),
        };
        // Both the DB mutex and all authority locks have been released before reply/drop.
        let completion = match &result {
            Ok(true) if self.authority.qualifies() => Ok(SpeedSettingReceipt {
                stamp: self.authority.stamp().clone(), speed: self.authority.speed,
            }),
            Ok(true) => Err(String::from("source speed persisted but original receipt superseded")),
            Ok(false) => Err(String::from("original source speed superseded before persistence")),
            Err(error) => Err(format!("source speed persistence failed: {error}")),
        };
        let _ = self.reply.send(completion);
        result
    }
}

pub struct SpeedSettingPending {
    reply: tokio::sync::oneshot::Receiver<Result<SpeedSettingReceipt, String>>,
    authority: SourceSpeedAuthority,
    completed: bool,
}
impl SpeedSettingPending {
    fn qualify(&self, result: Result<SpeedSettingReceipt, String>) -> Result<SpeedSettingReceipt, String> {
        result.and_then(|receipt| {
            if receipt.stamp != *self.authority.stamp() || !self.authority.qualifies() {
                Err(String::from("original source speed receipt superseded"))
            } else { Ok(receipt) }
        })
    }
    pub fn try_recv(&mut self)
        -> Result<Result<SpeedSettingReceipt, String>, tokio::sync::oneshot::error::TryRecvError>
    {
        let result = self.reply.try_recv();
        self.completed |= result.is_ok();
        result.map(|result| self.qualify(result))
    }
    pub async fn wait(mut self) -> Result<SpeedSettingReceipt, String> {
        let result = tokio::time::timeout(Duration::from_secs(5), &mut self.reply).await
            .map_err(|_| String::from("source speed persistence timed out"))?
            .map_err(|_| String::from("audio actor exited before source speed persistence receipt"))?;
        self.completed = true;
        self.qualify(result)
    }
}
impl Drop for SpeedSettingPending {
    fn drop(&mut self) {
        if !self.completed { self.authority.cancelled.store(true, Ordering::Release); }
    }
}
