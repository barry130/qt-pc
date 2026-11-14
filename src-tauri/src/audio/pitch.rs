//! 流式独立保速升降调 Source。
//!
//! `pitch_shift` 的固定 hop 是 128 个样本，内部分析窗带 896 个样本
//! lookahead。包装器先消费七个真实输入 hop，丢弃对应的启动延迟输出；EOF
//! 再用零 hop 冲洗，并以真实读到的样本总数截断输出，因此输出时长与输入
//! 完全一致。半音为 0 时不经过算法，首个样本无延迟且逐位透传。

use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use pitch_shift::{RawState, Shifter, TOTAL_F32};
use rodio::source::SeekError;
use rodio::{ChannelCount, SampleRate, Source};

use super::fx::AudioFx;

const HOP: usize = 128;
const LATENCY_HOPS: usize = 7;
const BUFFER_HOPS: usize = LATENCY_HOPS + 4;

/// The library keeps its working state in the user-provided container. A reset
/// flag lets us clear that preallocated container on the next `shift` call;
/// changing pitch or seeking therefore never allocates on the audio thread.
struct ResettableState {
    state: Box<RawState>,
    reset: Arc<AtomicBool>,
}

impl AsMut<RawState> for ResettableState {
    fn as_mut(&mut self) -> &mut RawState {
        if self.reset.swap(false, Ordering::AcqRel) {
            self.state.fill(0.0);
        }
        &mut self.state
    }
}

/// Decoder 外层的独立变调源.
///
/// 每个声道拥有独立相位声码器。所有缓冲在构造时预分配，音频线程只做
/// 原子参数读取，不等待锁；`Source` 的采样率、声道数和总时长保持原值。
pub(super) struct PitchSource {
    inner: Box<dyn Source + Send>,
    fx: Arc<AudioFx>,
    channels: ChannelCount,
    sample_rate: SampleRate,
    channel_count: usize,
    frame_samples: usize,
    input_hop: Vec<f32>,
    channel_input: Vec<f32>,
    interleaved_output: Vec<f32>,
    /// 已从 inner 读出、但尚未交付给调用者的真实输入样本。
    /// 变调切回 0 时从此处衔接，不重复读取或丢失 lookahead。
    bridge: VecDeque<f32>,
    output: VecDeque<f32>,
    shifters: Vec<Shifter<ResettableState>>,
    reset_flags: Vec<Arc<AtomicBool>>,
    source_eof: bool,
    /// 已从 inner 读出的真实样本数（不包括冲洗零样本）。
    input_read: usize,
    output_sent: usize,
    /// `bridge` 前端已经送入当前声码器的样本数。
    bridge_processed: usize,
    active_pitch: i32,
    prime_hops_remaining: usize,
    flush_hops_remaining: usize,
    direct_frame_pos: usize,
}

impl PitchSource {
    pub(super) fn new(inner: Box<dyn Source + Send>, fx: Arc<AudioFx>) -> Self {
        let channels = inner.channels();
        let sample_rate = inner.sample_rate();
        let channel_count = usize::from(channels.get()).max(1);
        let frame_samples = channel_count * HOP;
        let reset_flags: Vec<_> = (0..channel_count)
            .map(|_| Arc::new(AtomicBool::new(false)))
            .collect();
        let shifters = reset_flags
            .iter()
            .map(|reset| Self::new_shifter(Arc::clone(reset)))
            .collect();
        Self {
            inner,
            fx,
            channels,
            sample_rate,
            channel_count,
            frame_samples,
            input_hop: vec![0.0; frame_samples],
            channel_input: vec![0.0; HOP],
            interleaved_output: vec![0.0; frame_samples],
            // Seven lookahead hops, one processing hop, plus a transition hop.
            bridge: VecDeque::with_capacity(frame_samples * BUFFER_HOPS),
            output: VecDeque::with_capacity(frame_samples * 2),
            shifters,
            reset_flags,
            source_eof: false,
            input_read: 0,
            output_sent: 0,
            bridge_processed: 0,
            active_pitch: 0,
            prime_hops_remaining: 0,
            flush_hops_remaining: 0,
            direct_frame_pos: 0,
        }
    }

    #[inline]
    fn new_shifter(reset: Arc<AtomicBool>) -> Shifter<ResettableState> {
        let state: Box<RawState> = vec![0.0; TOTAL_F32]
            .try_into()
            .expect("pitch_shift state has a fixed size");
        Shifter::new(ResettableState { state, reset })
    }

    fn reset_shifters(&mut self) {
        for reset in &self.reset_flags {
            reset.store(true, Ordering::Release);
        }
    }

    #[inline]
    fn pending_samples(&self) -> usize {
        self.input_read.saturating_sub(self.output_sent)
    }

    /// Fill the next algorithm hop from the unprocessed bridge tail and inner.
    /// Returns the number of real samples; the remainder of `input_hop` is zero.
    fn fill_hop(&mut self) -> usize {
        let mut available = self.bridge.len().saturating_sub(self.bridge_processed);
        while available < self.frame_samples && !self.source_eof {
            match self.inner.next() {
                Some(sample) => {
                    self.bridge.push_back(sample);
                    self.input_read += 1;
                    available += 1;
                }
                None => self.source_eof = true,
            }
        }
        self.input_hop.fill(0.0);
        let valid = available.min(self.frame_samples);
        for index in 0..valid {
            self.input_hop[index] = self.bridge[self.bridge_processed + index];
        }
        valid
    }

    fn shift_hop(&mut self, pitch: i32, valid: usize) {
        let rate = self.sample_rate.get() as f32;
        for channel in 0..self.channel_count {
            for frame in 0..HOP {
                self.channel_input[frame] = self.input_hop[frame * self.channel_count + channel];
            }
            let shifted =
                self.shifters[channel].shift(&self.channel_input, pitch as f32, HOP, rate);
            for (frame, sample) in shifted.iter().copied().enumerate() {
                self.interleaved_output[frame * self.channel_count + channel] = sample;
            }
        }
        self.bridge_processed += valid;
        self.output.extend(self.interleaved_output.iter().copied());
    }

    fn begin_nonzero(&mut self, pitch: i32) {
        self.active_pitch = pitch;
        self.prime_hops_remaining = LATENCY_HOPS;
        self.flush_hops_remaining = 0;
        self.bridge_processed = 0;
        self.input_hop.fill(0.0);
        self.reset_shifters();
    }

    /// Return one direct sample, consuming a previously read bridge sample first.
    fn next_direct(&mut self) -> Option<f32> {
        let sample = if let Some(sample) = self.bridge.pop_front() {
            Some(sample)
        } else if self.source_eof {
            None
        } else {
            match self.inner.next() {
                Some(sample) => {
                    self.input_read += 1;
                    Some(sample)
                }
                None => {
                    self.source_eof = true;
                    None
                }
            }
        };
        if sample.is_some() {
            self.output_sent += 1;
            self.direct_frame_pos = (self.direct_frame_pos + 1) % self.frame_samples;
            if self.bridge_processed > 0 {
                self.bridge_processed -= 1;
            }
        }
        sample
    }

    fn reset_after_seek(&mut self) {
        self.bridge.clear();
        self.output.clear();
        self.source_eof = false;
        self.input_read = 0;
        self.output_sent = 0;
        self.bridge_processed = 0;
        self.active_pitch = 0;
        self.prime_hops_remaining = 0;
        self.flush_hops_remaining = 0;
        self.direct_frame_pos = 0;
        self.input_hop.fill(0.0);
        self.channel_input.fill(0.0);
        self.interleaved_output.fill(0.0);
        self.reset_shifters();
    }
}

impl Iterator for PitchSource {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some(sample) = self.output.pop_front() {
                // Algorithm output and source timeline are one-for-one. Drop
                // padded flush output once all real source samples are sent.
                if self.output_sent >= self.input_read {
                    self.output.clear();
                    return None;
                }
                let _ = self.bridge.pop_front();
                self.bridge_processed = self.bridge_processed.saturating_sub(1);
                self.output_sent += 1;
                return Some(sample);
            }

            let requested = self.fx.pitch_semitones();
            if self.active_pitch == 0 {
                if self.direct_frame_pos == 0 && requested != 0 {
                    self.begin_nonzero(requested);
                    continue;
                }
                return self.next_direct();
            }

            if requested == 0 && self.prime_hops_remaining == 0 {
                // A change is observed after the current output hop has drained;
                // all source samples already read remain in `bridge`.
                self.active_pitch = 0;
                self.flush_hops_remaining = 0;
                self.bridge_processed = 0;
                continue;
            }
            if requested != 0 {
                self.active_pitch = requested;
            }

            if self.prime_hops_remaining > 0 {
                let valid = self.fill_hop();
                self.shift_hop(self.active_pitch, valid);
                self.output.clear();
                self.prime_hops_remaining -= 1;
                continue;
            }

            if self.flush_hops_remaining > 0 {
                self.input_hop.fill(0.0);
                self.shift_hop(self.active_pitch, 0);
                self.flush_hops_remaining -= 1;
                continue;
            }

            let valid = self.fill_hop();
            if valid > 0 {
                self.shift_hop(self.active_pitch, valid);
                continue;
            }
            if self.source_eof {
                self.flush_hops_remaining = LATENCY_HOPS;
                continue;
            }
        }
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        let pending = self.pending_samples();
        let (lower, upper) = self.inner.size_hint();
        (
            pending.saturating_add(lower),
            upper.map(|value| pending.saturating_add(value)),
        )
    }
}

impl Source for PitchSource {
    fn current_span_len(&self) -> Option<usize> {
        let pending = self.pending_samples();
        if pending > 0 {
            Some(pending)
        } else {
            self.inner.current_span_len()
        }
    }

    fn channels(&self) -> ChannelCount {
        self.channels
    }

    fn sample_rate(&self) -> SampleRate {
        self.sample_rate
    }

    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        // Do not mutate any state before the inner source confirms the seek.
        self.inner.try_seek(pos)?;
        self.reset_after_seek();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rodio::buffer::SamplesBuffer;
    use std::f32::consts::TAU;

    fn wrapped(channels: u16, rate: u32, samples: Vec<f32>, fx: Arc<AudioFx>) -> PitchSource {
        let source = SamplesBuffer::new(
            ChannelCount::new(channels).unwrap(),
            SampleRate::new(rate).unwrap(),
            samples,
        );
        PitchSource::new(Box::new(source), fx)
    }

    fn sine(rate: u32, frequency: f32, len: usize, phase: f32) -> Vec<f32> {
        (0..len)
            .map(|n| (TAU * frequency * n as f32 / rate as f32 + phase).sin())
            .collect()
    }

    fn frequency(samples: &[f32], rate: u32) -> f32 {
        let crossings = samples
            .windows(2)
            .filter(|pair| pair[0] <= 0.0 && pair[1] > 0.0)
            .count();
        crossings as f32 * rate as f32 / samples.len() as f32
    }

    fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt()
    }

    #[test]
    fn zero_semitones_is_bit_exact_and_has_no_latency() {
        let input: Vec<f32> = (0..513).map(|n| (n as f32 * 0.017).sin()).collect();
        let fx = Arc::new(AudioFx::new());
        let output: Vec<_> = wrapped(1, 48_000, input.clone(), fx).collect();
        assert_eq!(output, input);
    }

    #[test]
    fn octave_up_and_down_keep_count_and_change_frequency() {
        let input = sine(48_000, 220.0, 48_000, 0.0);
        for (semitones, expected) in [(12, 440.0), (-12, 110.0)] {
            let fx = Arc::new(AudioFx::new());
            fx.set_pitch_semitones(semitones);
            let output: Vec<_> = wrapped(1, 48_000, input.clone(), fx).collect();
            assert_eq!(output.len(), input.len());
            let measured = frequency(&output[4096..], 48_000);
            assert!(
                (measured - expected).abs() < 18.0,
                "{semitones}: {measured}"
            );
            assert!(rms(&output[4096..]) > 0.15);
        }
    }

    #[test]
    fn stereo_channels_are_shifted_independently() {
        let left = sine(48_000, 220.0, 12_288, 0.0);
        let mut input = Vec::with_capacity(left.len() * 2);
        for sample in left {
            input.extend([sample, 0.0]);
        }
        let fx = Arc::new(AudioFx::new());
        fx.set_pitch_semitones(5);
        let output: Vec<_> = wrapped(2, 48_000, input, fx).collect();
        assert_eq!(output.len(), 24_576);
        let left_values: Vec<_> = output[4096..].iter().step_by(2).copied().collect();
        let right_values: Vec<_> = output[4097..].iter().step_by(2).copied().collect();
        assert!(rms(&left_values) > 0.1);
        assert!(
            rms(&right_values) < 0.02,
            "right leakage: {}",
            rms(&right_values)
        );
    }

    #[test]
    fn short_partial_and_empty_streams_finish_without_extra_samples() {
        for length in [0, 1, 17, 127, 129, 1025] {
            let input: Vec<f32> = (0..length).map(|n| n as f32 / 100.0).collect();
            let fx = Arc::new(AudioFx::new());
            fx.set_pitch_semitones(3);
            let output: Vec<_> = wrapped(1, 44_100, input, fx).collect();
            assert_eq!(output.len(), length);
        }
    }

    #[test]
    fn dynamic_zero_transition_consumes_lookahead_once() {
        let input: Vec<f32> = (0..4096).map(|n| n as f32).collect();
        let fx = Arc::new(AudioFx::new());
        fx.set_pitch_semitones(5);
        let mut pitch = wrapped(1, 48_000, input.clone(), Arc::clone(&fx));
        let first: Vec<_> = (0..HOP).map(|_| pitch.next().unwrap()).collect();
        assert_eq!(first.len(), HOP);
        fx.set_pitch_semitones(0);
        let direct: Vec<_> = (0..HOP).map(|_| pitch.next().unwrap()).collect();
        assert_eq!(direct, input[HOP..2 * HOP]);
        fx.set_pitch_semitones(-4);
        let rest: Vec<_> = pitch.collect();
        assert_eq!(first.len() + direct.len() + rest.len(), input.len());
    }

    #[test]
    fn seek_success_resets_history_to_the_new_source_position() {
        let input = sine(48_000, 220.0, 8192, 0.3);
        let fx = Arc::new(AudioFx::new());
        fx.set_pitch_semitones(4);
        let mut pitch = wrapped(1, 48_000, input.clone(), Arc::clone(&fx));
        let _: Vec<_> = pitch.by_ref().take(73).collect();
        pitch.try_seek(Duration::from_millis(25)).unwrap();
        let output: Vec<_> = pitch.take(2048).collect();
        let expected: Vec<_> = wrapped(1, 48_000, input[1200..].to_vec(), fx)
            .take(2048)
            .collect();
        assert_eq!(output, expected);
    }

    struct NoSeek(SamplesBuffer);

    impl Iterator for NoSeek {
        type Item = f32;
        fn next(&mut self) -> Option<f32> {
            self.0.next()
        }
        fn size_hint(&self) -> (usize, Option<usize>) {
            self.0.size_hint()
        }
    }

    impl Source for NoSeek {
        fn current_span_len(&self) -> Option<usize> {
            self.0.current_span_len()
        }
        fn channels(&self) -> ChannelCount {
            self.0.channels()
        }
        fn sample_rate(&self) -> SampleRate {
            self.0.sample_rate()
        }
        fn total_duration(&self) -> Option<Duration> {
            self.0.total_duration()
        }
    }

    #[test]
    fn failed_seek_keeps_the_complete_buffer_and_dsp_history() {
        let input = sine(48_000, 330.0, 8192, 0.8);
        let fx = Arc::new(AudioFx::new());
        fx.set_pitch_semitones(-5);
        let samples = SamplesBuffer::new(
            ChannelCount::new(1).unwrap(),
            SampleRate::new(48_000).unwrap(),
            input.clone(),
        );
        let mut pitch = PitchSource::new(Box::new(NoSeek(samples)), Arc::clone(&fx));
        let mut reference = wrapped(1, 48_000, input, fx);
        for _ in 0..73 {
            assert_eq!(pitch.next(), reference.next());
        }
        let before = pitch.size_hint();
        assert!(pitch.try_seek(Duration::from_millis(25)).is_err());
        assert_eq!(pitch.size_hint(), before);
        assert_eq!(pitch.collect::<Vec<_>>(), reference.collect::<Vec<_>>());
    }

    #[test]
    fn alternate_sample_rates_and_non_octave_shifts_keep_duration_and_frequency() {
        for rate in [8_000, 44_117, 96_000] {
            for semitones in [-7, 5] {
                let input = sine(rate, 330.0, rate as usize + 37, 0.2);
                let fx = Arc::new(AudioFx::new());
                fx.set_pitch_semitones(semitones);
                let output: Vec<_> = wrapped(1, rate, input.clone(), fx).collect();
                assert_eq!(output.len(), input.len());
                let expected = 330.0 * 2.0_f32.powf(semitones as f32 / 12.0);
                let measured = frequency(&output[2048..], rate);
                assert!(
                    (measured - expected).abs() < 8.0,
                    "rate={rate}, semitones={semitones}, expected={expected}, measured={measured}"
                );
            }
        }
    }

    #[test]
    fn final_signal_survives_the_vocoder_tail_flush() {
        let mut input = vec![0.0; 6144];
        input.extend(sine(48_000, 330.0, 2048 + 37, 0.4));
        let fx = Arc::new(AudioFx::new());
        fx.set_pitch_semitones(7);
        let output: Vec<_> = wrapped(1, 48_000, input.clone(), fx).collect();
        assert_eq!(output.len(), input.len());
        assert!(output.iter().all(|sample| sample.is_finite()));
        assert!(
            rms(&output[output.len() - 512..]) > 0.1,
            "tail must remain audible"
        );
    }

    #[test]
    fn buffered_source_reports_format_duration_and_all_remaining_samples() {
        let fx = Arc::new(AudioFx::new());
        fx.set_pitch_semitones(7);
        let mut pitch = wrapped(2, 44_117, vec![0.25; 600], Arc::clone(&fx));
        assert_eq!(pitch.channels().get(), 2);
        assert_eq!(pitch.sample_rate().get(), 44_117);
        assert_eq!(
            pitch.total_duration(),
            Some(Duration::from_nanos(600_000_000_000 / 44_117 / 2))
        );
        assert_eq!(pitch.size_hint(), (600, Some(600)));
        pitch.next().unwrap();
        assert_eq!(pitch.size_hint(), (599, Some(599)));
        assert!(pitch.current_span_len().unwrap() > 0);
        // The decoder is already at EOF, but its buffered audio is still live.
        fx.set_pitch_semitones(0);
        assert_eq!(pitch.by_ref().count(), 599);
        assert_eq!(pitch.current_span_len(), Some(0));
        assert_eq!(pitch.size_hint(), (0, Some(0)));
        assert_eq!(pitch.next(), None);
    }

    #[test]
    fn runtime_changes_reach_the_public_output_without_a_duration_change() {
        let input = sine(16_000, 220.0, 32_013, 0.7);
        let fx = Arc::new(AudioFx::new());
        let mut pitch = wrapped(1, 16_000, input.clone(), Arc::clone(&fx));
        assert_eq!(pitch.by_ref().take(4096).collect::<Vec<_>>(), input[..4096]);
        fx.set_pitch_semitones(12);
        let high: Vec<_> = pitch.by_ref().take(8192).collect();
        assert!((frequency(&high[2048..], 16_000) - 440.0).abs() < 5.0);
        fx.set_pitch_semitones(-12);
        let low: Vec<_> = pitch.by_ref().take(8192).collect();
        assert!((frequency(&low[2048..], 16_000) - 110.0).abs() < 5.0);
        fx.set_pitch_semitones(0);
        let tail: Vec<_> = pitch.collect();
        assert_eq!(tail, input[4096 + 8192 + 8192..]);
    }
}
