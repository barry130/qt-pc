//! 音频引擎（DESIGN §7.4）：专属音频线程 + mpsc 命令通道。
//!
//! `cpal::Stream`（rodio 的 `MixerDeviceSink`）不是 `Send`，不能放进 Tauri `State`。
//! 结构：Tauri 命令（任意线程）→ `mpsc::Sender<AudioCmd>` → 专属线程独占
//! `MixerDeviceSink` + `Player` 串行处理；状态放 `Arc<RwLock<PlaybackStateSnapshot>>`。

pub mod engine;
pub mod fx;
pub mod listening;
pub mod play_intent;
pub mod playback_commit;
pub mod queue;
pub mod render_control;
pub mod range_reader;
pub mod replay_gain;
pub mod state;
mod device_source;
mod source;
mod speed_setting;

#[cfg(test)]
mod playback_speed_tests;

pub use engine::{AudioCmd, AudioEngine, PlaySource};
pub use fx::{AudioFx, DspSource, EqParams, FadeParams, FxState, SpectrumTap, EQ_BAND_HZ};
pub use queue::Queue;
pub use replay_gain::{ReplayGainMode, TrackGain};
pub use state::{PlayMode, PlaybackStateSnapshot, PlaybackStatus, Quality};
