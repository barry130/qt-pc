//! Source-bound controls at the actual software Player queue boundary.
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rodio::source::SeekError;
use rodio::{ChannelCount, SampleRate, Source};

use super::play_intent::{PlayIntentGate, PlayTarget};
use super::source::{SourceProgress, TrackedSource};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MountStamp {
    pub target: PlayTarget,
    pub mount_nonce: u64,
}

pub struct SourceSeekPort {
    stamp: MountStamp,
    progress: Arc<SourceProgress>,
    retired: AtomicBool,
    drained_eof: AtomicBool,
    ready: AtomicBool,
    selected: AtomicBool,
    paused: AtomicBool,
    pause_controlled: AtomicBool,
    speed: AtomicU32,
    gate: Option<PlayIntentGate>,
    owner: Option<super::engine::SourceControlOwner>,
}

impl SourceSeekPort {
    pub fn new(stamp: MountStamp) -> Arc<Self> {
        Arc::new(Self { stamp, progress: Arc::new(SourceProgress::default()),
            retired: AtomicBool::new(false), drained_eof: AtomicBool::new(false), ready: AtomicBool::new(true), selected: AtomicBool::new(true), paused: AtomicBool::new(false), pause_controlled: AtomicBool::new(false), speed: AtomicU32::new(1.0_f32.to_bits()), gate: None, owner: None })
    }
    pub(super) fn with_gate(stamp: MountStamp, gate: PlayIntentGate) -> Arc<Self> {
        Arc::new(Self { stamp, progress: Arc::new(SourceProgress::default()),
            retired: AtomicBool::new(false), drained_eof: AtomicBool::new(false), ready: AtomicBool::new(true), selected: AtomicBool::new(true), paused: AtomicBool::new(false), pause_controlled: AtomicBool::new(false), speed: AtomicU32::new(1.0_f32.to_bits()), gate: Some(gate), owner: None })
    }
    pub(super) fn reserved(stamp: MountStamp, gate: PlayIntentGate,
        owner: super::engine::SourceControlOwner) -> Arc<Self>
    {
        Self::reserved_with_progress(stamp, gate, owner, Arc::new(SourceProgress::default()))
    }
    pub(super) fn reserved_with_progress(stamp: MountStamp, gate: PlayIntentGate,
        owner: super::engine::SourceControlOwner, progress: Arc<SourceProgress>) -> Arc<Self>
    {
        Arc::new(Self { stamp, progress,
            retired: AtomicBool::new(false), drained_eof: AtomicBool::new(false), ready: AtomicBool::new(false), selected: AtomicBool::new(false), paused: AtomicBool::new(false), pause_controlled: AtomicBool::new(false), speed: AtomicU32::new(1.0_f32.to_bits()),
            gate: Some(gate), owner: Some(owner) })
    }
    pub(super) fn arm(&self) { self.ready.store(true, Ordering::Release); }
    fn has_authority(&self) -> bool {
        if let Some(owner) = &self.owner { return owner.qualifies(self); }
        self.gate.as_ref().is_none_or(|gate|
            gate.with_accepted(self.stamp.target.generation, || ()).is_some())
    }
    fn commit_seek(&self, position_ms: u64) -> bool {
        self.owner.as_ref().is_none_or(|owner| owner.commit_seek(self, position_ms))
    }
    pub(super) fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::Release);
        self.pause_controlled.store(true, Ordering::Release);
    }
    pub(super) fn pause_override(&self) -> Option<bool> {
        self.pause_controlled.load(Ordering::Acquire).then(|| self.is_paused())
    }
    pub fn is_paused(&self) -> bool { self.paused.load(Ordering::Acquire) }
    pub(super) fn set_speed(&self, speed: f32) {
        self.speed.store(speed.to_bits(), Ordering::Release);
    }
    pub fn speed(&self) -> f32 { f32::from_bits(self.speed.load(Ordering::Acquire)) }
    pub(super) fn rate_source(self: &Arc<Self>, inner: Box<dyn Source + Send>) -> Box<dyn Source + Send> {
        Box::new(SourceRate::new(inner, self.clone()))
    }
    pub(super) fn is_ready(&self) -> bool { self.ready.load(Ordering::Acquire) }
    pub fn stamp(&self) -> &MountStamp { &self.stamp }
    /// Only the outer, armed and unpaused source returning None records natural drain.
    pub(super) fn has_drained_eof(&self) -> bool { self.drained_eof.load(Ordering::Acquire) }
    pub(super) fn external_position(&self, position_ms: u64) {
        self.progress.external_position(position_ms);
    }
    pub(super) fn external_finished(&self) -> bool {
        if !self.is_ready() || self.is_paused() || !self.is_live() || !self.has_authority() { return false; }
        !self.drained_eof.swap(true, Ordering::AcqRel)
    }
    pub fn position_ms(&self) -> u64 { self.progress.position_ms() }
    pub fn progress(&self) -> Arc<SourceProgress> { self.progress.clone() }
    pub fn retire(&self) { self.retired.store(true, Ordering::Release); }
    pub fn is_live(&self) -> bool {
        !self.retired.load(Ordering::Acquire) && self.progress.usable()
    }
    pub fn tracked_source(&self, source: Box<dyn Source + Send>, start_ms: u64)
        -> Box<dyn Source + Send>
    {
        Box::new(TrackedSource::new(source, self.progress.clone()).with_position(start_ms))
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PreloadBindingPhase { Pending, Mounted, Cancelled }

struct PreloadBindingState {
    phase: PreloadBindingPhase,
    port: Option<Arc<SourceSeekPort>>,
    outer_eof: bool,
}

pub(super) struct PreloadBinding {
    progress: Arc<SourceProgress>,
    cancelled: AtomicBool,
    state: Mutex<PreloadBindingState>,
}

impl PreloadBinding {
    /// Retain the same Dsp(Tracked(C)) remainder on the actual Player queue.
    /// Source metadata and adapter construction are strictly outside Gate.
    pub(super) fn wrap(inner: Box<dyn Source + Send>, progress: Arc<SourceProgress>)
        -> (Box<dyn Source + Send>, Arc<Self>)
    {
        let channels = inner.channels();
        let rate = inner.sample_rate();
        let binding = Arc::new(Self {
            progress,
            cancelled: AtomicBool::new(false),
            state: Mutex::new(PreloadBindingState {
                phase: PreloadBindingPhase::Pending, port: None, outer_eof: false,
            }),
        });
        let source = LateBoundSource {
            inner: Some(inner), binding: Arc::clone(&binding), mounted: false,
            channels, rate, channel: 0,
        };
        (Box::new(source), binding)
    }

    /// Gate -> Queue -> State -> Mounts -> Binding. The renderer never reverses
    /// this order. The callback is memory-only, constructs the port from the
    /// supplied original progress, and publishes that same Arc. Displaced
    /// ownership is returned in T for retirement/destruction outside all locks.
    pub(super) fn try_bind_with<T>(
        &self,
        factory: impl FnOnce(&Arc<SourceProgress>) -> (Arc<SourceSeekPort>, T),
    ) -> Option<(Arc<SourceSeekPort>, T)> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if self.cancelled.load(Ordering::Acquire)
            || state.phase != PreloadBindingPhase::Pending
            || state.port.is_some() || state.outer_eof || !self.progress.first_some()
        { return None; }
        let (port, result) = factory(&self.progress);
        state.port = Some(Arc::clone(&port));
        Some((port, result))
    }

    pub(super) fn try_admit_unbound<T>(
        &self, commit: impl FnOnce(&Arc<SourceProgress>) -> T,
    ) -> Option<T> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if self.cancelled.load(Ordering::Acquire)
            || state.phase != PreloadBindingPhase::Pending
            || state.port.is_some() || state.outer_eof || !self.progress.first_some()
        { return None; }
        let result = commit(&self.progress);
        state.phase = PreloadBindingPhase::Mounted;
        Some(result)
    }

    pub(super) fn cancel(&self) {
        let port = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            self.cancelled.store(true, Ordering::Release);
            // Active cancellation is private to this original adapter. Never
            // reset the original SourceProgress activation CAS to PENDING.
            self.progress.cancel_pending();
            state.phase = PreloadBindingPhase::Cancelled;
            state.port.take()
        };
        if let Some(port) = port { port.retire(); }
    }

    fn candidate(&self) -> Option<Arc<SourceSeekPort>> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if self.cancelled.load(Ordering::Acquire)
            || state.phase != PreloadBindingPhase::Pending || state.outer_eof
        { return None; }
        state.port.clone()
    }

    fn mounted(&self, port: &Arc<SourceSeekPort>) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.phase == PreloadBindingPhase::Pending
            && state.port.as_ref().is_some_and(|current| Arc::ptr_eq(current, port))
        { state.phase = PreloadBindingPhase::Mounted; }
    }

    /// A genuine raw outer None can race an already admitted factory. Transfer
    /// only that actual witness to the same attached port; Drop is never EOF.
    fn record_outer_none(&self) {
        if !self.progress.first_some() { return; }
        let port = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if self.cancelled.load(Ordering::Acquire)
                || state.phase != PreloadBindingPhase::Pending
            { return; }
            state.outer_eof = true;
            state.port.clone()
        };
        if let Some(port) = port {
            if port.is_ready() && !port.is_paused() && !port.retired.load(Ordering::Acquire) {
                port.drained_eof.store(true, Ordering::Release);
            }
        }
    }
}

struct LateBoundSource {
    inner: Option<Box<dyn Source + Send>>,
    binding: Arc<PreloadBinding>,
    mounted: bool,
    channels: ChannelCount,
    rate: SampleRate,
    channel: usize,
}

impl LateBoundSource {
    fn inner(&self) -> &(dyn Source + Send) {
        self.inner.as_ref().expect("late-bound source owns its original remainder").as_ref()
    }

    fn mount_once(&mut self) {
        if self.mounted || self.binding.cancelled.load(Ordering::Acquire) { return; }
        let channels = self.inner().channels();
        let rate = self.inner().sample_rate();
        if channels != self.channels || rate != self.rate {
            self.channels = channels;
            self.rate = rate;
            self.channel = 0;
        }
        let Some(port) = self.binding.candidate() else { return; };
        // The binding lock has been released before touching the actual Source.
        let inner = self.inner.take().expect("one original source remainder");
        let rated = Box::new(SourceRate::new_at_channel(inner, Arc::clone(&port), self.channel));
        self.inner = Some(Box::new(SeekTargetGuard::new(rated, Arc::clone(&port))));
        self.mounted = true;
        self.binding.mounted(&port);
    }
}

impl Iterator for LateBoundSource {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if self.binding.cancelled.load(Ordering::Acquire) { return None; }
        self.mount_once();
        if self.binding.cancelled.load(Ordering::Acquire) { return None; }
        let sample = self.inner.as_mut().expect("original source remainder").next();
        if self.binding.cancelled.load(Ordering::Acquire) { return None; }
        if !self.mounted {
            if sample.is_some() {
                self.channel = (self.channel + 1) % usize::from(self.channels.get());
            } else {
                self.binding.record_outer_none();
            }
        }
        sample
    }

    fn size_hint(&self) -> (usize, Option<usize>) { self.inner().size_hint() }
}

impl Source for LateBoundSource {
    fn current_span_len(&self) -> Option<usize> { self.inner().current_span_len() }
    fn channels(&self) -> ChannelCount { self.inner().channels() }
    fn sample_rate(&self) -> SampleRate { self.inner().sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.inner().total_duration() }

    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        if self.binding.cancelled.load(Ordering::Acquire) {
            return Err(SeekError::NotSupported { underlying_source: "cancelled preload source" });
        }
        self.mount_once();
        if !self.mounted || self.binding.cancelled.load(Ordering::Acquire) {
            return Err(SeekError::NotSupported { underlying_source: "unbound preload source" });
        }
        self.inner.as_mut().expect("original guarded source remainder").try_seek(pos)
    }
}

impl Drop for LateBoundSource {
    fn drop(&mut self) { self.binding.cancel(); }
}

#[derive(Clone, Debug)]
pub struct BoundSeekReceipt {
    pub stamp: MountStamp,
    pub content_position_ms: u64,
}

#[derive(Debug)]
pub struct BoundSeekFailure {
    pub message: &'static str,
    pub source_intact: bool,
}
impl std::fmt::Display for BoundSeekFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for BoundSeekFailure {}

pub struct BoundSeekRequest {
    stamp: MountStamp,
    port: Arc<SourceSeekPort>,
    content_pos: Duration,
    player_pos: Duration,
    cancelled: Arc<AtomicBool>,
    reply: tokio::sync::oneshot::Sender<Result<BoundSeekReceipt, BoundSeekFailure>>,
}

pub struct BoundSeekPending {
    reply: tokio::sync::oneshot::Receiver<Result<BoundSeekReceipt, BoundSeekFailure>>,
    cancelled: Arc<AtomicBool>,
    completed: bool,
    port: Arc<SourceSeekPort>,
}
impl BoundSeekPending {
    fn qualify(&self, result: Result<BoundSeekReceipt, BoundSeekFailure>)
        -> Result<BoundSeekReceipt, BoundSeekFailure>
    {
        result.and_then(|receipt| {
            if receipt.stamp != *self.port.stamp() || self.cancelled.load(Ordering::Acquire)
                || !self.port.is_live() || !self.port.has_authority()
            {
                Err(BoundSeekFailure { message: "original source receipt superseded", source_intact: true })
            } else { Ok(receipt) }
        })
    }
    pub fn try_recv(&mut self)
        -> Result<Result<BoundSeekReceipt, BoundSeekFailure>, tokio::sync::oneshot::error::TryRecvError>
    {
        let result = self.reply.try_recv();
        self.completed |= result.is_ok();
        result.map(|result| self.qualify(result))
    }
    pub async fn wait(mut self) -> Result<BoundSeekReceipt, BoundSeekFailure> {
        let result = tokio::time::timeout(Duration::from_secs(5), &mut self.reply).await
            .map_err(|_| BoundSeekFailure { message: "render seek timed out", source_intact: true })?
            .map_err(|_| BoundSeekFailure { message: "render output retired", source_intact: true })?;
        self.completed = true;
        self.qualify(result)
    }
}
impl Drop for BoundSeekPending {
    fn drop(&mut self) {
        if !self.completed { self.cancelled.store(true, Ordering::Release); }
    }
}

impl BoundSeekRequest {
    pub(super) fn external_ready(&self) -> bool {
        !self.cancelled.load(Ordering::Acquire) && self.port.is_ready()
            && self.port.is_live() && self.port.has_authority()
    }
    pub(super) fn position_ms(&self) -> u64 { self.content_pos.as_millis() as u64 }
    pub(super) fn original_target(&self) -> &PlayTarget { &self.stamp.target }
    /// Network work has already completed outside Gate; admit only the captured source.
    pub(super) fn external_complete(self, success: bool) {
        let qualified = success && !self.cancelled.load(Ordering::Acquire)
            && self.port.stamp() == &self.stamp && self.port.is_live() && self.port.has_authority();
        let position_ms = self.position_ms();
        let receipt = if qualified && self.port.commit_seek(position_ms) {
            self.port.external_position(position_ms);
            Ok(BoundSeekReceipt { stamp: self.stamp.clone(), content_position_ms: position_ms })
        } else {
            Err(BoundSeekFailure { message: "DLNA seek failed or original source superseded", source_intact: true })
        };
        let _ = self.reply.send(receipt);
    }
    pub fn new(stamp: MountStamp, port: Arc<SourceSeekPort>, content_ms: u64, captured_speed: f32)
        -> Result<(Self, BoundSeekPending), BoundSeekFailure>
    {
        if stamp != *port.stamp() || !captured_speed.is_finite()
            || !(0.5..=2.0).contains(&captured_speed)
        {
            return Err(BoundSeekFailure { message: "invalid source-bound seek", source_intact: true });
        }
        let content_pos = Duration::from_millis(content_ms);
        let cancelled = Arc::new(AtomicBool::new(false));
        let (reply, received) = tokio::sync::oneshot::channel();
        Ok((Self { stamp, port: port.clone(), content_pos, player_pos: content_pos.div_f32(captured_speed),
            cancelled: cancelled.clone(), reply },
            BoundSeekPending { reply: received, cancelled, completed: false, port }))
    }
}

#[derive(Clone)]
pub struct BoundSeekSender { tx: SyncSender<BoundSeekRequest> }

pub struct BoundSeekSubmitError { request: BoundSeekRequest, message: &'static str }
impl BoundSeekSubmitError {
    pub fn reply_outside_gate(self) {
        let _ = self.request.reply.send(Err(BoundSeekFailure {
            message: self.message, source_intact: true,
        }));
    }
}
impl BoundSeekSender {
    pub fn try_submit(&self, request: BoundSeekRequest) -> Result<(), Box<BoundSeekSubmitError>> {
        self.tx.try_send(request).map_err(|error| Box::new(match error {
            TrySendError::Full(request) => BoundSeekSubmitError { request, message: "render seek queue full" },
            TrySendError::Disconnected(request) => BoundSeekSubmitError { request, message: "render output retired" },
        }))
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SeekVisit { Unvisited, Matched, Rejected }

#[derive(Clone)]
struct QualifiedSeek {
    stamp: MountStamp,
    port: Arc<SourceSeekPort>,
    content_pos: Duration,
    cancelled: Arc<AtomicBool>,
    visit: Rc<Cell<SeekVisit>>,
}
thread_local! {
    static QUALIFIED_SEEK: RefCell<Option<QualifiedSeek>> = const { RefCell::new(None) };
}
struct SeekScope { previous: Option<QualifiedSeek> }
impl Drop for SeekScope {
    fn drop(&mut self) {
        QUALIFIED_SEEK.with(|slot| *slot.borrow_mut() = self.previous.take());
    }
}
fn with_qualified_seek(context: QualifiedSeek, seek: impl FnOnce() -> Result<(), SeekError>)
    -> Result<(), SeekError>
{
    let previous = QUALIFIED_SEEK.with(|slot| slot.replace(Some(context)));
    let _scope = SeekScope { previous };
    seek()
}

/// A fixed-format, source-local rate converter. Fractional phase survives output
/// spans and rate changes; a control never resets or seeks the original decoder.
struct SourceRate {
    inner: Box<dyn Source + Send>,
    port: Arc<SourceSeekPort>,
    channels: ChannelCount,
    sample_rate: SampleRate,
    first: Vec<f32>,
    second: Vec<f32>,
    buffered: bool,
    has_next: bool,
    phase: f64,
    output_ch: usize,
    passthrough_ch: usize,
    frame_speed: f64,
}
impl SourceRate {
    fn new(inner: Box<dyn Source + Send>, port: Arc<SourceSeekPort>) -> Self {
        Self::new_at_channel(inner, port, 0)
    }
    fn new_at_channel(inner: Box<dyn Source + Send>, port: Arc<SourceSeekPort>, channel: usize) -> Self {
        let channels = inner.channels();
        let sample_rate = inner.sample_rate();
        let count = channels.get() as usize;
        Self { inner, port, channels, sample_rate, first: vec![0.0; count],
            second: vec![0.0; count], buffered: false, has_next: false,
            phase: 0.0, output_ch: 0, passthrough_ch: channel % count, frame_speed: 1.0 }
    }
    fn read_frame(inner: &mut Box<dyn Source + Send>, frame: &mut [f32]) -> bool {
        for sample in frame {
            let Some(value) = inner.next() else { return false; };
            *sample = value;
        }
        true
    }
}
impl Iterator for SourceRate {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        let count = self.channels.get() as usize;
        if self.output_ch == 0 {
            self.frame_speed = self.port.speed() as f64;
            // Preserve the exact unity-rate path and finish an interleaved frame
            // before a newly requested rate can initialize interpolation.
            if !self.buffered && (self.frame_speed == 1.0 || self.passthrough_ch != 0) {
                let sample = self.inner.next()?;
                self.passthrough_ch = (self.passthrough_ch + 1) % count;
                return Some(sample);
            }
            if !self.buffered {
                if !Self::read_frame(&mut self.inner, &mut self.first) { return None; }
                self.has_next = Self::read_frame(&mut self.inner, &mut self.second);
                self.buffered = true;
            }
            while self.phase >= 1.0 {
                if !self.has_next { return None; }
                std::mem::swap(&mut self.first, &mut self.second);
                self.has_next = Self::read_frame(&mut self.inner, &mut self.second);
                self.phase -= 1.0;
            }
        }
        let first = self.first[self.output_ch];
        let second = if self.has_next { self.second[self.output_ch] } else { first };
        let sample = first + (second - first) * self.phase as f32;
        self.output_ch += 1;
        if self.output_ch == count {
            self.output_ch = 0;
            self.phase += self.frame_speed;
        }
        Some(sample)
    }
}
impl Source for SourceRate {
    fn current_span_len(&self) -> Option<usize> { None }
    fn channels(&self) -> ChannelCount { self.channels }
    fn sample_rate(&self) -> SampleRate { self.sample_rate }
    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration().map(|duration| duration.div_f32(self.port.speed()))
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.inner.try_seek(pos)?;
        self.buffered = false;
        self.has_next = false;
        self.phase = 0.0;
        self.output_ch = 0;
        self.passthrough_ch = 0;
        Ok(())
    }
}

pub struct SeekTargetGuard { inner: Box<dyn Source + Send>, port: Arc<SourceSeekPort> }
impl SeekTargetGuard {
    pub fn new(inner: Box<dyn Source + Send>, port: Arc<SourceSeekPort>) -> Self { Self { inner, port } }
}
impl Iterator for SeekTargetGuard {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        if self.port.retired.load(Ordering::Acquire) { return None; }
        if !self.port.ready.load(Ordering::Acquire) { return Some(0.0); }
        self.port.selected.store(true, Ordering::Release);
        if self.port.is_paused() { return Some(0.0); }
        let sample = self.inner.next();
        if sample.is_none() { self.port.drained_eof.store(true, Ordering::Release); }
        sample
    }
    fn size_hint(&self) -> (usize, Option<usize>) { self.inner.size_hint() }
}
impl Source for SeekTargetGuard {
    fn current_span_len(&self) -> Option<usize> { self.inner.current_span_len() }
    fn channels(&self) -> ChannelCount { self.inner.channels() }
    fn sample_rate(&self) -> SampleRate { self.inner.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.inner.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        let context = QUALIFIED_SEEK.with(|slot| slot.borrow().clone());
        let Some(context) = context else {
            if !self.port.is_live() || !self.port.ready.load(Ordering::Acquire) {
                return Err(SeekError::NotSupported { underlying_source: "unready or retired source" });
            }
            return self.inner.try_seek(pos);
        };
        if context.cancelled.load(Ordering::Acquire) || !context.port.is_live()
            || !context.port.has_authority()
        {
            context.visit.set(SeekVisit::Rejected);
            return Err(SeekError::NotSupported { underlying_source: "cancelled or retired original source" });
        }
        if context.stamp != self.port.stamp || !Arc::ptr_eq(&context.port, &self.port) {
            // A ready reservation may still be behind the retired preceding queue source.
            // Hold that original packet, never seek the preceding decoder or rebind to it.
            context.visit.set(if context.port.selected.load(Ordering::Acquire) {
                SeekVisit::Rejected
            } else { SeekVisit::Unvisited });
            return Err(SeekError::NotSupported { underlying_source: "foreign source" });
        }
        if !self.port.ready.load(Ordering::Acquire) {
            context.visit.set(SeekVisit::Rejected);
            return Err(SeekError::NotSupported { underlying_source: "original source not armed" });
        }
        self.port.selected.store(true, Ordering::Release);
        context.visit.set(SeekVisit::Matched);
        // Before DSP reset and decoder seek; content time is the original captured value.
        self.inner.try_seek(context.content_pos)
    }
}
impl Drop for SeekTargetGuard { fn drop(&mut self) { self.port.retire(); } }

pub struct RenderSeekOutput {
    inner: rodio::queue::SourcesQueueOutput,
    rx: mpsc::Receiver<BoundSeekRequest>,
    pending: Option<BoundSeekRequest>,
}
impl RenderSeekOutput {
    pub fn new(inner: rodio::queue::SourcesQueueOutput) -> (Self, BoundSeekSender) {
        let (tx, rx) = mpsc::sync_channel(16);
        (Self { inner, rx, pending: None }, BoundSeekSender { tx })
    }
    fn service_one(&mut self) {
        let request = match self.pending.take().or_else(|| self.rx.try_recv().ok()) {
            Some(request) => request,
            None => return,
        };
        if request.cancelled.load(Ordering::Acquire) || !request.port.is_live()
            || !request.port.has_authority()
        {
            let _ = request.reply.send(Err(BoundSeekFailure {
                message: "source-bound seek cancelled or retired", source_intact: true,
            }));
            return;
        }
        if !request.port.ready.load(Ordering::Acquire) {
            self.pending = Some(request);
            return;
        }
        let visit = Rc::new(Cell::new(SeekVisit::Unvisited));
        let context = QualifiedSeek {
            stamp: request.stamp.clone(), port: request.port.clone(),
            content_pos: request.content_pos, cancelled: request.cancelled.clone(), visit: visit.clone(),
        };
        let result = with_qualified_seek(context, || self.inner.try_seek(request.player_pos));
        if visit.get() == SeekVisit::Unvisited {
            // One attempt per normal output pull; never wake Player or rebind the packet.
            self.pending = Some(request);
            return;
        }
        if result.is_ok() && (request.cancelled.load(Ordering::Acquire)
            || !request.port.is_live() || !request.port.has_authority()
            || !request.port.commit_seek(request.port.position_ms()))
        {
            let _ = request.reply.send(Err(BoundSeekFailure {
                message: "source-bound seek superseded during execution", source_intact: true,
            }));
            return;
        }
        let receipt = result.map(|_| BoundSeekReceipt {
            stamp: request.stamp.clone(), content_position_ms: request.port.position_ms(),
        }).map_err(|e| BoundSeekFailure { message: "source-bound seek failed", source_intact: e.source_intact() });
        let _ = request.reply.send(receipt);
    }
}
impl Iterator for RenderSeekOutput {
    type Item = f32;
    fn next(&mut self) -> Option<f32> { self.service_one(); self.inner.next() }
    fn size_hint(&self) -> (usize, Option<usize>) { self.inner.size_hint() }
}
impl Source for RenderSeekOutput {
    fn current_span_len(&self) -> Option<usize> { self.inner.current_span_len() }
    fn channels(&self) -> ChannelCount { self.inner.channels() }
    fn sample_rate(&self) -> SampleRate { self.inner.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.inner.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> { self.inner.try_seek(pos) }
}
