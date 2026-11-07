//! Exercise the production queue, DSP, source controls and device converter
//! without opening a sound device or touching the user's settings.
use std::io::Cursor;
use std::sync::Arc;
use std::time::{Duration, Instant};

use rodio::source::UniformSourceIterator;
use rodio::{ChannelCount, Player, SampleRate, Source};

use super::device_source::DeviceSource;
use super::engine::{AudioCommandInbox, AudioEngine};
use super::render_control::{RenderSeekOutput, SourceSeekPort};
use super::AudioFx;
use crate::provider::types::{SourceId, Track};

struct Playback {
    engine: AudioEngine,
    inbox: AudioCommandInbox,
    player: Player,
    output: UniformSourceIterator<DeviceSource<RenderSeekOutput>>,
    device_samples_per_second: usize,
    load_gen: u64,
}

impl Playback {
    fn new(device_rate: u32, device_channels: u16) -> Self {
        let (engine, inbox) = AudioEngine::command_channel();
        let (player, output) = engine.player_channel();
        // A real device pulls silence before the first decoder is mounted.
        let output = DeviceSource::new(
            output,
            ChannelCount::new(device_channels).unwrap(),
            SampleRate::new(device_rate).unwrap(),
        );
        // The device mixer still adds Rodio's outer converter; DeviceSource
        // already emits the exact device format, so this must be a passthrough.
        let output = UniformSourceIterator::new(
            output,
            ChannelCount::new(device_channels).unwrap(),
            SampleRate::new(device_rate).unwrap(),
        );
        let mut playback = Self {
            engine,
            inbox,
            player,
            output,
            load_gen: 0,
            device_samples_per_second: device_rate as usize * usize::from(device_channels),
        };
        playback.render_samples(playback.device_samples_per_second / 20);
        playback
    }

    fn mount(&mut self, source: Box<dyn Source + Send>) -> Arc<SourceSeekPort> {
        let id = format!(
            "format-{}-{}-{}",
            source.sample_rate(),
            source.channels(),
            self.load_gen
        );
        let track = Track {
            id: id.clone(),
            platform: SourceId::new("podcast"),
            title: id,
            singer: String::new(),
            album: String::new(),
            pic_url: String::new(),
            duration: 0.0,
            music_id: None,
            start_ms: None,
            end_ms: None,
        };
        let mut reply = self.engine.send_queue(vec![track], 0, None);
        self.inbox
            .recv_timeout(Duration::from_secs(5), &mut self.load_gen)
            .unwrap();
        let target = reply.try_recv().unwrap().target.unwrap();
        let port = self.engine.source_mount(&target).unwrap();
        // send_queue retires the old source; rendering consumes that boundary.
        // Player::clear would block without an independently running device.
        self.player.append(self.engine.bind_source(
            port.clone(),
            source,
            0,
            Arc::new(AudioFx::new()),
            Instant::now(),
            None,
        ));
        assert!(self.engine.complete_source_mount(&port));
        port
    }

    fn render_samples(&mut self, samples: usize) {
        for _ in 0..samples {
            assert!(self.output.next().unwrap().is_finite());
        }
    }

    fn settle(&mut self) {
        self.render_samples(self.device_samples_per_second / 10);
    }

    fn measure_second(&mut self, port: &SourceSeekPort, speed: f32) {
        let before = port.position_ms();
        self.render_samples(self.device_samples_per_second);
        let advanced = port.position_ms() - before;
        let expected = (1_000.0 * speed) as u64;
        assert!(
            advanced.abs_diff(expected) <= 8,
            "{speed}x advanced {advanced}ms during 1000ms device output; expected {expected}ms"
        );
        println!(
            "{} Hz / {} ch device, {speed}x: 1000ms output -> {advanced}ms content",
            self.output.sample_rate(),
            self.output.channels()
        );
    }
}

fn pcm(rate: u32, channels: u16, seconds: usize) -> Box<dyn Source + Send> {
    Box::new(rodio::buffer::SamplesBuffer::new(
        ChannelCount::new(channels).unwrap(),
        SampleRate::new(rate).unwrap(),
        vec![0.25; rate as usize * usize::from(channels) * seconds],
    ))
}

#[test]
fn switching_music_and_podcast_formats_preserves_content_time() {
    for (device_rate, device_channels) in [(44_100, 2), (48_000, 2), (96_000, 2), (48_000, 1)] {
        let mut playback = Playback::new(device_rate, device_channels);
        for (rate, channels) in [
            (44_100, 2),
            (32_000, 1),
            (48_000, 2),
            (44_100, 1),
            (16_000, 1),
        ] {
            let port = playback.mount(pcm(rate, channels, 4));
            playback.settle();
            assert_eq!(port.speed(), 1.0);
            assert_eq!(playback.engine.snapshot().speed, 1.0);
            assert_eq!(playback.player.speed(), 1.0);
            playback.measure_second(&port, 1.0);
        }
    }
}

#[test]
fn format_refresh_does_not_accumulate_resampling_clock_drift() {
    for (source_rate, source_channels, device_rate) in [
        (48_000, 2, 44_100),
        (44_100, 2, 48_000),
        (32_000, 1, 44_100),
        (11_025, 1, 48_000),
    ] {
        let mut playback = Playback::new(device_rate, 2);
        let port = playback.mount(pcm(source_rate, source_channels, 65));
        playback.settle();
        let before = port.position_ms();
        playback.render_samples(playback.device_samples_per_second * 60);
        let advanced = port.position_ms() - before;
        println!("{source_rate} Hz -> {device_rate} Hz: 60000ms output -> {advanced}ms content");
        assert!(
            advanced.abs_diff(60_000) <= 5,
            "{source_rate} Hz -> {device_rate} Hz advanced {advanced}ms during 60000ms output"
        );
    }
}

#[test]
fn decoded_mono_aac_preserves_pause_seek_and_explicit_speeds_after_music() {
    let mut playback = Playback::new(48_000, 2);
    playback.mount(pcm(44_100, 2, 4));
    playback.settle();
    let decoder = rodio::Decoder::new(Cursor::new(
        include_bytes!("../../tests/fixtures/playback-speed-mono-32k.m4a").to_vec(),
    ))
    .unwrap();
    assert_eq!(decoder.channels().get(), 1);
    assert_eq!(decoder.sample_rate().get(), 32_000);
    let port = playback.mount(Box::new(decoder));
    let target = port.stamp().target.clone();
    playback.settle();
    playback.measure_second(&port, 1.0);

    playback.engine.set_source_paused(&target, true).unwrap();
    playback.settle();
    let frozen = port.position_ms();
    for _ in 0..playback.device_samples_per_second / 10 {
        assert_eq!(playback.output.next(), Some(0.0));
    }
    assert_eq!(port.position_ms(), frozen);
    playback.engine.set_source_paused(&target, false).unwrap();
    for speed in [0.5, 1.25, 2.0, 1.0] {
        playback.engine.set_source_speed(&target, speed).unwrap();
        playback.settle();
        playback.measure_second(&port, speed);
    }

    let mut seek = playback.engine.begin_source_seek(&target, 2_000).unwrap();
    playback.settle();
    let receipt = seek.try_recv().unwrap().unwrap();
    assert_eq!(receipt.content_position_ms, 2_000);
    assert!((2_000..2_200).contains(&port.position_ms()));
    playback.measure_second(&port, 1.0);
}
