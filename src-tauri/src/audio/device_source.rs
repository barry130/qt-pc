//! Convert the persistent Player queue to the device's fixed format.
//!
//! A queue can switch formats even when its current track reports an unbounded
//! span. Rodio 0.22's UniformSourceIterator then keeps the old conversion until
//! EOF; imposing artificial spans instead loses resampling phase repeatedly.
//! Read complete frames and retain fractional phase until the format changes.
use std::time::Duration;

use rodio::source::SeekError;
use rodio::{ChannelCount, SampleRate, Source};

pub(super) struct DeviceSource<S> {
    inner: S,
    channels: ChannelCount,
    sample_rate: SampleRate,
    first: Vec<f32>,
    second: Vec<f32>,
    first_rate: SampleRate,
    second_rate: SampleRate,
    initialized: bool,
    has_next: bool,
    phase: f64,
    output_channel: usize,
}

impl<S: Source> DeviceSource<S> {
    pub(super) fn new(inner: S, channels: ChannelCount, sample_rate: SampleRate) -> Self {
        let count = usize::from(channels.get());
        Self {
            inner,
            channels,
            sample_rate,
            first: vec![0.0; count],
            second: vec![0.0; count],
            first_rate: sample_rate,
            second_rate: sample_rate,
            initialized: false,
            has_next: false,
            phase: 0.0,
            output_channel: 0,
        }
    }

    fn read_frame(inner: &mut S, frame: &mut [f32]) -> Option<SampleRate> {
        // The queue peeks at the following source's metadata once a finite
        // source is exhausted. Its last sample (notably idle mono silence)
        // still belongs to the old format; don't steal the next track's left
        // channel to finish that frame. Otherwise next() may switch sources or
        // decode a new packet, so query the actual format AFTER the first pull.
        let last_format =
            (inner.current_span_len() == Some(1)).then(|| (inner.channels(), inner.sample_rate()));
        let first = inner.next()?;
        let (channels, rate) =
            last_format.unwrap_or_else(|| (inner.channels(), inner.sample_rate()));
        frame.fill(0.0);
        frame[0] = first;
        // Match Rodio's channel mapping: duplicate mono into L/R, keep existing
        // channels in order, and silence additional device channels.
        if channels.get() == 1 && frame.len() > 1 {
            frame[1] = first;
        }
        for channel in 1..usize::from(channels.get()) {
            let sample = inner.next().unwrap_or(0.0);
            if let Some(output) = frame.get_mut(channel) {
                *output = sample;
            }
        }
        Some(rate)
    }
}

impl<S: Source> Iterator for DeviceSource<S> {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if self.output_channel == 0 {
            if !self.initialized {
                self.first_rate = Self::read_frame(&mut self.inner, &mut self.first)?;
                let rate = Self::read_frame(&mut self.inner, &mut self.second);
                self.has_next = rate.is_some();
                self.second_rate = rate.unwrap_or(self.first_rate);
                self.initialized = true;
            }
            while self.phase >= 1.0 {
                if !self.has_next {
                    return None;
                }
                self.phase -= 1.0;
                // Carry elapsed time across a rate change, rather than keeping
                // a fraction measured in the previous track's sample frames.
                if self.first_rate != self.second_rate {
                    self.phase *=
                        f64::from(self.second_rate.get()) / f64::from(self.first_rate.get());
                }
                std::mem::swap(&mut self.first, &mut self.second);
                self.first_rate = self.second_rate;
                let rate = Self::read_frame(&mut self.inner, &mut self.second);
                self.has_next = rate.is_some();
                self.second_rate = rate.unwrap_or(self.first_rate);
            }
        }
        let first = self.first[self.output_channel];
        let second = if self.has_next {
            self.second[self.output_channel]
        } else {
            first
        };
        let sample = first + (second - first) * self.phase as f32;
        self.output_channel += 1;
        if self.output_channel == self.first.len() {
            self.output_channel = 0;
            self.phase += f64::from(self.first_rate.get()) / f64::from(self.sample_rate.get());
        }
        Some(sample)
    }
}

impl<S: Source> Source for DeviceSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        None
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
        self.inner.try_seek(pos)?;
        self.initialized = false;
        self.has_next = false;
        self.phase = 0.0;
        self.output_channel = 0;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rodio::buffer::SamplesBuffer;

    fn buffer(channels: u16, rate: u32, samples: Vec<f32>) -> SamplesBuffer {
        SamplesBuffer::new(
            ChannelCount::new(channels).unwrap(),
            SampleRate::new(rate).unwrap(),
            samples,
        )
    }

    fn device(source: impl Source, channels: u16, rate: u32) -> DeviceSource<impl Source> {
        DeviceSource::new(
            source,
            ChannelCount::new(channels).unwrap(),
            SampleRate::new(rate).unwrap(),
        )
    }

    #[test]
    fn same_format_preserves_each_stereo_sample_and_eof() {
        let samples = vec![0.1, -0.1, 0.2, -0.2, 0.3, -0.3];
        let output: Vec<_> = device(buffer(2, 48_000, samples.clone()), 2, 48_000).collect();
        assert_eq!(output, samples);
    }

    #[test]
    fn idle_silence_to_stereo_keeps_left_and_right_channels_aligned() {
        let (input, queue) = rodio::queue::queue(true);
        let mut output = device(queue, 2, 48_000);
        // Enter the mono idle block before stereo audio is available.
        assert_eq!(output.next(), Some(0.0));
        input.append(buffer(2, 48_000, [0.25, -0.75].repeat(1_024)));
        assert_eq!(output.next(), Some(0.0));
        let mut heard_audio = false;
        for _ in 0..1_500 {
            let left = output.next().unwrap();
            let right = output.next().unwrap();
            if left == 0.25 {
                heard_audio = true;
                assert_eq!(right, -0.75);
            } else {
                assert_eq!((left, right), (0.0, 0.0));
            }
        }
        assert!(heard_audio);
    }

    #[test]
    fn natural_queue_transition_rechecks_rate_and_mono_channel_count() {
        let (input, queue) = rodio::queue::queue(false);
        input.append(buffer(2, 44_100, [0.1, -0.1].repeat(44_100)));
        input.append(buffer(1, 32_000, vec![0.5; 32_000]));
        let samples: Vec<_> = device(queue, 2, 48_000).collect();
        assert!(samples.len().abs_diff(48_000 * 2 * 2) <= 2);
        assert_eq!(&samples[10_000..10_004], &[0.1, -0.1, 0.1, -0.1]);
        assert_eq!(&samples[150_000..150_004], &[0.5, 0.5, 0.5, 0.5]);
    }

    #[test]
    fn interpolation_stays_continuous_across_finite_source_spans() {
        struct Spans {
            position: usize,
        }
        impl Iterator for Spans {
            type Item = f32;
            fn next(&mut self) -> Option<f32> {
                if self.position == 6_000 {
                    return None;
                }
                let sample = self.position as f32;
                self.position += 1;
                Some(sample)
            }
        }
        impl Source for Spans {
            fn current_span_len(&self) -> Option<usize> {
                Some(31 - self.position % 31)
            }
            fn channels(&self) -> ChannelCount {
                ChannelCount::new(1).unwrap()
            }
            fn sample_rate(&self) -> SampleRate {
                SampleRate::new(32_000).unwrap()
            }
            fn total_duration(&self) -> Option<Duration> {
                None
            }
        }
        for (index, value) in device(Spans { position: 0 }, 1, 48_000)
            .take(8_000)
            .enumerate()
        {
            let expected = index as f32 * 2.0 / 3.0;
            assert!(
                (value - expected).abs() < 0.001,
                "discontinuity at sample {index}"
            );
        }
    }
}
