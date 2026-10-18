//! Track-relative intervals and render-thread transition receipts.
//!
//! A queued source claims its activation atomically on its first sample. Cancelling
//! an unstarted source therefore never clears/stops the Player's current source.
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rodio::source::SeekError;
use rodio::{ChannelCount, SampleRate, Source};

const PENDING: u8 = 0;
const ACTIVE: u8 = 1;
const CANCELLED: u8 = 2;
const FINISHED: u8 = 3;

#[derive(Default)]
pub(super) struct SourceProgress {
    state: AtomicU8,
    position_ns: AtomicU64,
}

impl SourceProgress {
    pub fn position_ms(&self) -> u64 {
        self.position_ns.load(Ordering::Acquire) / 1_000_000
    }

    pub fn started(&self) -> bool {
        matches!(self.state.load(Ordering::Acquire), ACTIVE | FINISHED)
    }

    /// False means the render thread already won activation; the engine must
    /// publish that transition before interpreting the next manual command.
    pub fn cancel_pending(&self) -> bool {
        match self.state.compare_exchange(PENDING, CANCELLED, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => true,
            Err(state) => state == CANCELLED,
        }
    }
}

pub(super) struct TrackedSource {
    inner: Box<dyn Source + Send>,
    progress: Arc<SourceProgress>,
    position_ns: u64,
    frames: u64,
    channel: u16,
    channels: ChannelCount,
    rate: SampleRate,
}

impl TrackedSource {
    pub fn new(inner: Box<dyn Source + Send>, progress: Arc<SourceProgress>) -> Self {
        let channels = inner.channels();
        let rate = inner.sample_rate();
        Self { inner, progress, position_ns: 0, frames: 0, channel: 0, channels, rate }
    }

    pub fn with_position(mut self, position_ms: u64) -> Self {
        self.position_ns = position_ms.saturating_mul(1_000_000);
        self.progress.position_ns.store(self.position_ns, Ordering::Release);
        self
    }

    fn position_nanos(&self) -> u64 {
        self.position_ns.saturating_add(
            (u128::from(self.frames) * 1_000_000_000 / u128::from(self.rate.get())) as u64,
        )
    }
}

impl Iterator for TrackedSource {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        let state = self.progress.state.load(Ordering::Acquire);
        if state == CANCELLED || state == FINISHED {
            return None;
        }
        if state == PENDING && self.progress.state.compare_exchange(
            PENDING, ACTIVE, Ordering::AcqRel, Ordering::Acquire,
        ).is_err() {
            return None;
        }
        let rate = self.inner.sample_rate();
        let channels = self.inner.channels();
        if rate != self.rate || channels != self.channels {
            self.position_ns = self.position_nanos();
            self.frames = 0;
            self.channel = 0;
            self.rate = rate;
            self.channels = channels;
        }
        match self.inner.next() {
            Some(sample) => {
                self.channel += 1;
                if self.channel == self.channels.get() {
                    self.channel = 0;
                    self.frames += 1;
                    self.progress.position_ns.store(self.position_nanos(), Ordering::Release);
                }
                Some(sample)
            }
            None => {
                self.progress.position_ns.store(self.position_nanos(), Ordering::Release);
                self.progress.state.store(FINISHED, Ordering::Release);
                None
            }
        }
    }
}

impl Source for TrackedSource {
    fn current_span_len(&self) -> Option<usize> { self.inner.current_span_len() }
    fn channels(&self) -> ChannelCount { self.inner.channels() }
    fn sample_rate(&self) -> SampleRate { self.inner.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.inner.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.inner.try_seek(pos)?;
        self.position_ns = pos.as_nanos().min(u128::from(u64::MAX)) as u64;
        self.frames = 0;
        // Rodio seek preserves the current interleaved channel.
        self.progress.position_ns.store(self.position_ns, Ordering::Release);
        Ok(())
    }
}

/// A physical file interval whose public seek/duration are relative to its start.
/// Construction and the initial seek run on the loader's blocking worker.
pub(super) struct IntervalSource {
    inner: Box<dyn Source + Send>,
    start: Duration,
    duration: Option<Duration>,
    remaining_samples: Option<u64>,
}

impl IntervalSource {
    pub fn new(
        mut inner: Box<dyn Source + Send>,
        start_ms: u64,
        end_ms: Option<u64>,
        physical_duration_ms: u64,
    ) -> Result<Self, String> {
        if end_ms.is_some_and(|end| end <= start_ms)
            || (physical_duration_ms > 0 && start_ms >= physical_duration_ms)
        {
            return Err("CUE interval is outside the audio file".into());
        }
        let end = match (end_ms, physical_duration_ms) {
            (Some(end), 0) => Some(end),
            (Some(end), duration) => Some(end.min(duration)),
            (None, 0) => None,
            (None, duration) => Some(duration),
        };
        let start = Duration::from_millis(start_ms);
        let duration = end.map(|end| Duration::from_millis(end - start_ms));
        if start_ms > 0 {
            inner.try_seek(start).map_err(|e| format!("CUE initial seek failed: {e}"))?;
        }
        let remaining_samples = duration.map(|duration| samples_for(&*inner, duration));
        Ok(Self { inner, start, duration, remaining_samples })
    }
}

fn samples_for(source: &dyn Source, duration: Duration) -> u64 {
    // Round to whole frames so a bounded stereo interval cannot end mid-frame.
    let frames = duration.as_nanos() * u128::from(source.sample_rate().get()) / 1_000_000_000;
    (frames * u128::from(source.channels().get())).min(u128::from(u64::MAX)) as u64
}

impl Iterator for IntervalSource {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        if self.remaining_samples == Some(0) { return None; }
        let sample = self.inner.next()?;
        if let Some(left) = &mut self.remaining_samples { *left -= 1; }
        Some(sample)
    }
    fn size_hint(&self) -> (usize, Option<usize>) {
        (0, self.remaining_samples.map(|n| n.min(usize::MAX as u64) as usize))
    }
}

impl Source for IntervalSource {
    fn current_span_len(&self) -> Option<usize> {
        match (self.inner.current_span_len(), self.remaining_samples) {
            (Some(span), Some(left)) => Some(span.min(left.min(usize::MAX as u64) as usize)),
            (span, None) => span,
            (None, Some(left)) => Some(left.min(usize::MAX as u64) as usize),
        }
    }
    fn channels(&self) -> ChannelCount { self.inner.channels() }
    fn sample_rate(&self) -> SampleRate { self.inner.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.duration }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        let pos = self.duration.map_or(pos, |duration| pos.min(duration));
        self.inner.try_seek(self.start.saturating_add(pos))?;
        self.remaining_samples = self.duration.map(|duration| samples_for(&*self.inner, duration - pos));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rodio::buffer::SamplesBuffer;

    fn audio() -> Box<dyn Source + Send> {
        Box::new(SamplesBuffer::new(
            ChannelCount::new(2).unwrap(), SampleRate::new(1000).unwrap(),
            (0..200).map(|sample| sample as f32).collect::<Vec<_>>(),
        ))
    }

    #[test]
    fn interval_caps_length_and_seeks_relative_to_start() {
        let mut source = IntervalSource::new(audio(), 20, Some(50), 100).unwrap();
        assert_eq!(source.total_duration(), Some(Duration::from_millis(30)));
        assert_eq!(source.next(), Some(40.0));
        assert_eq!(source.next(), Some(41.0));
        source.try_seek(Duration::from_millis(10)).unwrap();
        assert_eq!(source.next(), Some(60.0));
        assert_eq!(source.count(), 39);
    }

    #[test]
    fn interval_last_track_uses_physical_end() {
        let source = IntervalSource::new(audio(), 75, None, 100).unwrap();
        assert_eq!(source.total_duration(), Some(Duration::from_millis(25)));
        assert_eq!(source.count(), 50);
        assert!(IntervalSource::new(audio(), 60, Some(50), 100).is_err());
    }

    #[test]
    fn cancelled_preload_never_starts_or_emits_samples() {
        let progress = Arc::new(SourceProgress::default());
        let mut source = TrackedSource::new(audio(), progress.clone());
        assert!(progress.cancel_pending());
        assert_eq!(source.next(), None);
        assert!(!progress.started());
    }

    #[test]
    fn player_concatenates_cue_intervals_without_silent_samples() {
        let (player, mut output) = rodio::Player::new();
        let first = Arc::new(SourceProgress::default());
        let next = Arc::new(SourceProgress::default());
        player.append(TrackedSource::new(
            Box::new(IntervalSource::new(audio(), 20, Some(50), 100).unwrap()), first.clone(),
        ));
        player.append(TrackedSource::new(
            Box::new(IntervalSource::new(audio(), 50, Some(75), 100).unwrap()), next.clone(),
        ));
        assert!(!next.started());
        let samples: Vec<_> = output.by_ref().take(60).collect();
        assert_eq!(samples, (40..100).map(|sample| sample as f32).collect::<Vec<_>>());
        assert!(!next.started());
        assert_eq!(output.by_ref().take(50).collect::<Vec<_>>(),
            (100..150).map(|sample| sample as f32).collect::<Vec<_>>());
        assert!(next.started());
        assert_eq!(first.position_ms(), 30);
        assert_eq!(next.position_ms(), 25);
    }

    #[test]
    fn player_skips_cancelled_preload_and_plays_replacement() {
        let (player, mut output) = rodio::Player::new();
        let cancelled = Arc::new(SourceProgress::default());
        let replacement = Arc::new(SourceProgress::default());
        let interval = |start, end| -> Box<dyn Source + Send> {
            Box::new(IntervalSource::new(audio(), start, Some(end), 100).unwrap())
        };
        player.append(interval(20, 25));
        player.append(TrackedSource::new(interval(25, 30), cancelled.clone()));
        assert!(cancelled.cancel_pending());
        player.append(TrackedSource::new(interval(30, 35), replacement.clone()));
        assert_eq!(output.by_ref().take(20).collect::<Vec<_>>(),
            (40..50).chain(60..70).map(|sample| sample as f32).collect::<Vec<_>>());
        assert!(!cancelled.started());
        assert!(replacement.started());
        assert_eq!(replacement.position_ms(), 5);
    }

    #[test]
    fn activated_source_cannot_be_cancelled_and_reports_relative_position_nanos() {
        let progress = Arc::new(SourceProgress::default());
        let mut source = TrackedSource::new(audio(), progress.clone());
        assert_eq!(source.next(), Some(0.0));
        assert_eq!(source.next(), Some(1.0));
        assert!(progress.started());
        assert!(!progress.cancel_pending());
        source.try_seek(Duration::from_millis(25)).unwrap();
        assert_eq!(progress.position_ms(), 25);
        assert_eq!(source.count(), 150);
        assert_eq!(progress.position_ms(), 100);
    }
}
