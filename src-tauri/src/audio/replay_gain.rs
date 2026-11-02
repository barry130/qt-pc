//! ReplayGain（A1）：把标签里的静态增益换算成播放时要乘的线性系数。
//!
//! 与 [响度归一化](super::fx::AudioFx::set_loudnorm) 的分工：
//! - 响度归一化是**运行时**测 RMS 追目标，不看标签，对没有标签的文件也有效，
//!   但前几秒在"摸索"、也只做粗粒度对齐；
//! - ReplayGain 是**离线扫描**算好的标签（`REPLAYGAIN_TRACK_GAIN` 等），一次乘上去
//!   就对，跨专辑、跨年代的响度差能对齐到 <1 dB，代价是没打标签的文件只能不处理。
//!
//! 两者可以同时开：静态增益在效果链最前面，归一化在后面继续把残余差异拉平。
//!
//! ## 为什么是全局静态表
//!
//! 音频线程（`AudioCmd` 的消费者）**不能碰数据库**：它在实时路径上，一次
//! SQLite 查询就是一帧音频的抖动。所以由命令层在启动时 / 扫描后 / 设置变化后
//! 把「键 → 增益」整表灌进这里（[`replace_all`]），音频线程只做一次哈希查表。
//! 表本身用 `RwLock` 包着，音频线程读、命令层写；写入只在扫描结束时发生，
//! 加锁开销可以忽略。
//!
//! ## 应用口径
//!
//! - 模式 `track`：优先 `REPLAYGAIN_TRACK_GAIN`，没有就退到专辑增益（混编播放
//!   列表里，有单曲标签的按单曲对齐，只有专辑标签的按专辑对齐，总比不处理强）；
//! - 模式 `album`：优先 `REPLAYGAIN_ALBUM_GAIN`，没有就退到单曲增益（同理）；
//! - 增益先钳到 −24 dB ~ +12 dB（ReplayGain 规范的建议区间），再按
//!   `REPLAYGAIN_TRACK_PEAK` 封顶：`peak * gain > 0.99` 时把增益压到
//!   `0.99 / peak`，宁可比目标响度低一点也不削波。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{OnceLock, RwLock};

/// 增益模式（设置项 `fx.replaygain` 的三档）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ReplayGainMode {
    /// 关闭（默认）：完全不改音量，标签读了也不用
    #[default]
    Off,
    /// 单曲：每首歌对齐到同一响度（随机播放、单曲循环都合适）
    Track,
    /// 专辑：同一专辑内的相对响度保持不变（听整张专辑时不破坏作品起伏）
    Album,
}

impl ReplayGainMode {
    /// 设置值 → 模式。未知值一律当关闭（配置被手改坏时不炸）。
    pub fn from_setting(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "track" => Self::Track,
            "album" => Self::Album,
            _ => Self::Off,
        }
    }

    /// 模式 → 设置值（写回 `settings` 表用）。
    pub fn as_setting(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Track => "track",
            Self::Album => "album",
        }
    }

    fn code(self) -> u8 {
        match self {
            Self::Off => 0,
            Self::Track => 1,
            Self::Album => 2,
        }
    }

    fn from_code(code: u8) -> Self {
        match code {
            1 => Self::Track,
            2 => Self::Album,
            _ => Self::Off,
        }
    }
}

/// 一首曲目的增益标签（线性峰值 + 两种 dB 增益），全部可缺。
#[derive(Debug, Clone, Copy, Default)]
pub struct TrackGain {
    pub track_db: Option<f32>,
    pub track_peak: Option<f32>,
    pub album_db: Option<f32>,
}

impl TrackGain {
    /// 这条记录有没有可用的信息（全空的行不该进表）。
    pub fn is_empty(&self) -> bool {
        self.track_db.is_none() && self.album_db.is_none()
    }
}

static MODE: AtomicU8 = AtomicU8::new(0);
static TABLE: OnceLock<RwLock<HashMap<String, TrackGain>>> = OnceLock::new();

fn table() -> &'static RwLock<HashMap<String, TrackGain>> {
    TABLE.get_or_init(|| RwLock::new(HashMap::new()))
}

/// 设置当前模式（命令层调用；同时负责让引擎重算当前曲目的增益）。
pub fn set_mode(mode: ReplayGainMode) {
    MODE.store(mode.code(), Ordering::Relaxed);
}

pub fn mode() -> ReplayGainMode {
    ReplayGainMode::from_code(MODE.load(Ordering::Relaxed))
}

/// 整表替换（启动 / 扫描结束后调用）。没有标签的行不必传进来。
pub fn replace_all(rows: impl IntoIterator<Item = (String, TrackGain)>) {
    let mut next = HashMap::new();
    for (key, gain) in rows {
        if key.is_empty() || gain.is_empty() {
            continue;
        }
        next.insert(key, gain);
    }
    if let Ok(mut guard) = table().write() {
        *guard = next;
    }
}

/// 清空（清库 / 换账号时调用）。
pub fn clear() {
    if let Ok(mut guard) = table().write() {
        guard.clear();
    }
}

/// 从数据库整表重载（启动、扫描结束、手动刷新都走这里）。返回装载条数。
///
/// 参数是 `&Connection` 而不是整个 `Database`：让这个模块不必知道库的形态，
/// 调用方（引擎线程、命令层）各自把 `db.with(...)` 摆好。
pub fn reload(conn: &rusqlite::Connection) -> Result<usize, rusqlite::Error> {
    let rows = crate::db::store::list_replay_gains(conn)?;
    let total = rows.len();
    replace_all(rows.into_iter().map(|row| {
        (
            row.key,
            TrackGain {
                track_db: row.track_gain_db,
                track_peak: row.track_peak,
                album_db: row.album_gain_db,
            },
        )
    }));
    Ok(total)
}

/// 查表拿线性增益（1.0 = 不处理）。音频线程每次挂载曲目调一次。
pub fn gain_for(key: &str) -> f32 {
    let mode = mode();
    if mode == ReplayGainMode::Off {
        return 1.0;
    }
    let gain = {
        let Ok(guard) = table().read() else {
            return 1.0;
        };
        guard.get(key).copied()
    };
    match gain {
        Some(gain) => linear_gain(mode, &gain),
        None => 1.0,
    }
}

/// 纯函数：模式 + 标签 → 线性系数。方便单测，也让「口径」只有一处。
pub fn linear_gain(mode: ReplayGainMode, gain: &TrackGain) -> f32 {
    let db = match mode {
        ReplayGainMode::Off => return 1.0,
        ReplayGainMode::Track => gain.track_db.or(gain.album_db),
        ReplayGainMode::Album => gain.album_db.or(gain.track_db),
    };
    let Some(db) = db else {
        return 1.0;
    };
    let db = db.clamp(MIN_GAIN_DB, MAX_GAIN_DB);
    let mut linear = 10f32.powf(db / 20.0);
    // 峰值封顶：留 1% 余量给软限幅器，避免「归一化后反而削波」——
    // 大声的流行专辑常出现 track_gain > 0 且 peak ≈ 1.0 的情况。
    if let Some(peak) = gain.track_peak.filter(|p| *p > 0.0) {
        let ceiling = PEAK_CEILING / peak;
        if linear > ceiling {
            linear = ceiling;
        }
    }
    linear.clamp(MIN_LINEAR, MAX_LINEAR)
}

/// 增益下限：再小声也不压超过 24 dB（再低就是文件本身有问题，压下去等于静音）。
const MIN_GAIN_DB: f32 = -24.0;
/// 增益上限：+12 dB 已经是「把安静的老录音推到现代响度」的量级。
const MAX_GAIN_DB: f32 = 12.0;
/// 削波余量：峰值乘完增益不超过 0.99。
const PEAK_CEILING: f32 = 0.99;
/// 线性系数的兜底上下限（与 dB 钳制对齐，防浮点意外）。
const MIN_LINEAR: f32 = 0.063;
const MAX_LINEAR: f32 = 4.0;

#[cfg(test)]
mod tests {
    use super::*;

    const TRACK: TrackGain = TrackGain {
        track_db: Some(-7.0),
        track_peak: None,
        album_db: Some(-5.0),
    };

    #[test]
    fn off_mode_is_passthrough() {
        assert!((linear_gain(ReplayGainMode::Off, &TRACK) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn track_mode_prefers_track_gain_and_album_mode_prefers_album_gain() {
        let track = linear_gain(ReplayGainMode::Track, &TRACK);
        let album = linear_gain(ReplayGainMode::Album, &TRACK);
        assert!((track - 10f32.powf(-7.0 / 20.0)).abs() < 1e-4);
        assert!((album - 10f32.powf(-5.0 / 20.0)).abs() < 1e-4);
        assert!(album > track, "专辑增益更小（更响），线性系数更大");
    }

    #[test]
    fn falls_back_to_the_other_gain_when_one_is_missing() {
        let only_album = TrackGain { track_db: None, album_db: Some(-3.0), track_peak: None };
        assert!((linear_gain(ReplayGainMode::Track, &only_album) - 10f32.powf(-3.0 / 20.0)).abs() < 1e-4);
        let only_track = TrackGain { track_db: Some(-3.0), album_db: None, track_peak: None };
        assert!((linear_gain(ReplayGainMode::Album, &only_track) - 10f32.powf(-3.0 / 20.0)).abs() < 1e-4);
        // 两个都没有 = 不处理
        let empty = TrackGain::default();
        assert!((linear_gain(ReplayGainMode::Track, &empty) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn gain_is_clamped_to_the_spec_range() {
        let loud = TrackGain { track_db: Some(30.0), album_db: None, track_peak: None };
        // +30 dB 被钳到 +12 dB
        assert!(
            (linear_gain(ReplayGainMode::Track, &loud) - 10f32.powf(MAX_GAIN_DB / 20.0)).abs()
                < 1e-4
        );
        let quiet = TrackGain { track_db: Some(-60.0), album_db: None, track_peak: None };
        assert!((linear_gain(ReplayGainMode::Track, &quiet) - MIN_LINEAR).abs() < 1e-3);
    }

    #[test]
    fn peak_caps_positive_gain_to_avoid_clipping() {
        // +6 dB（≈2.0×）但峰值已经 0.9：乘完会到 1.8，必须被压到 0.99/0.9 = 1.1
        let hot = TrackGain { track_db: Some(6.0), album_db: None, track_peak: Some(0.9) };
        let linear = linear_gain(ReplayGainMode::Track, &hot);
        assert!((linear - 1.1).abs() < 1e-3, "got {linear}");
        // 负增益不受峰值影响（越乘越小，不会削波）
        let soft = TrackGain { track_db: Some(-6.0), album_db: None, track_peak: Some(0.9) };
        assert!((linear_gain(ReplayGainMode::Track, &soft) - 10f32.powf(-6.0 / 20.0)).abs() < 1e-4);
    }

    #[test]
    fn mode_setting_roundtrip() {
        for mode in [ReplayGainMode::Off, ReplayGainMode::Track, ReplayGainMode::Album] {
            assert_eq!(ReplayGainMode::from_setting(mode.as_setting()), mode);
        }
        // 手改坏了也当关闭，不 panic
        assert_eq!(ReplayGainMode::from_setting("loud"), ReplayGainMode::Off);
        assert_eq!(ReplayGainMode::from_setting(""), ReplayGainMode::Off);
    }
}
