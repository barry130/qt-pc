//! 播放引擎实现：专属音频线程 + mpsc（DESIGN §7.4）。
//!
//! M2 范围：Load / Play / Pause / Stop / Seek / SetVolume / SetMuted / Shutdown
//! + 播放队列（SetQueue / PlayAt / Next / Previous / SetPlayMode）与自然播完自动切歌。
//!
//! 队列推进的纯逻辑见 `queue.rs`；引擎线程独占处理，取址与解码器构建
//! （网络 IO）都在 tokio / blocking 线程池异步完成，回发 LoadReady 后
//! 引擎线程只做纯内存挂载 —— 命令通道永不被网络阻塞。
//!
//! 位置口径：`sink.get_pos()` 是 rodio 对当前源的真实播放位置（暂停时冻结），
//! tick 时以它为准并回写快照，避免自增累计漂移。

use std::collections::{HashMap, HashSet};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use rodio::{Decoder, Player, Source};

// 设备枚举 / 名称查询都挂在 trait 上，必须显式引入
use crate::db::store::{self, PlayState};
use crate::db::Database;
use crate::provider::types::{self, Track};
use crate::provider::url_cache::PlayUrlCache;
use cpal::traits::{DeviceTrait, HostTrait};
use serde::{Deserialize, Serialize};
use tauri::Emitter;

use super::fx::{AudioFx, DspSource, EqParams, FadeParams, FxState};
use super::device_source::DeviceSource;
use super::play_intent::{PlayTarget, QueueCommitReply};
use super::playback_commit::{PlaybackCommitPlan, PlaybackCommitter};
use super::speed_setting::SourceSpeedAuthority;
pub use super::speed_setting::{NativeSpeedSetting, SourceSpeedSetting, SpeedSettingPending};
use super::queue::Queue;
pub use super::source::SourceProgress;
use super::source::{IntervalSource, TrackedSource};
use super::range_reader::{self, RangeShared};
use super::state::{PlayMode, PlaybackStateSnapshot, PlaybackStatus, Quality};
#[path = "dlna_adapter.rs"]
mod dlna_adapter;

/// 播放来源：在线 URL（走 HttpRangeReader）或本地文件。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[allow(non_snake_case)]
pub enum PlaySource {
    Online {
        url: String,
        fetchedAt: u64,
        /// 取这个地址时要带的 Referer（音源包按源声明，空串 = 不发）。
        ///
        /// 由音源包下发、随地址一起缓存：range_reader 自己向 CDN 取字节，
        /// 拿不到"声明它的那一侧"；B 站部分 CDN 节点没有它直接 403。
        /// `serde(default)` 让旧前端/旧缓存快照（没有这个字段）仍能反序列化。
        #[serde(default)]
        referer: String,
    },
    Local { path: String },
}

/// 音频命令（DESIGN §7.4 AudioCmd 的 M2 子集）。
pub enum AudioCmd {
    DlnaConnect {
        device_id: String,
        reply: tokio::sync::oneshot::Sender<Result<crate::dlna::CastState, String>>,
    },
    DlnaDisconnect {
        return_to_local: bool,
        reply: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
    DlnaDisconnected(Box<dlna_adapter::DisconnectResult>),
    DlnaLoaded(Box<dlna_adapter::LoadResult>),
    DlnaPoll(Box<dlna_adapter::PollResult>),
    DlnaAction(Box<dlna_adapter::ActionResult>),
    DlnaBoundPause {
        target: PlayTarget,
        original: Arc<super::render_control::SourceSeekPort>,
        session_id: u64,
        generation: u64,
        paused: bool,
    },
    DlnaBoundSeek {
        request: super::render_control::BoundSeekRequest,
        session_id: u64,
        generation: u64,
    },
    /// Produced only after the actual mounted source and Player naturally drain.
    SourceFinished(Arc<super::render_control::SourceSeekPort>),
    /// 解码器已构建完成，可以挂载播放。构建（HTTP open + 首包探测）在
    /// blocking 线程池完成 —— 引擎线程全程不做网络 IO。
    LoadReady {
        /// The logical owner captured before resolving or constructing this source.
        target: Option<PlayTarget>,
        port: Option<Arc<super::render_control::SourceSeekPort>>,
        track: Box<Track>,
        decoder: Box<dyn Source + Send>,
        shared: Option<Arc<RangeShared>>,
        duration_ms: u64,
        start_at: Option<u64>,
        autoplay: bool,
        is_local: bool,
        url_fetched_at: Option<u64>,
        /// 当前实际播放地址（在线源才有）。换源兜底后它指向目标源，
        /// 歌词按它查换源记录换源取词（DESIGN 换源一致性）
        play_url: Option<String>,
        /// 取链侧 Range 探测出的文件总字节数（None = 没测出来）。挂载时优先用它，
        /// 缺了才回落到已挂载流自己的 Content-Length —— 分块传输（无长度）的流
        /// 只有取链侧这份探测结果，丢了就等于播放条永远不显示码率。
        size_bytes: Option<u64>,
        /// 加载代次：与引擎当前代次不一致说明等待期间用户又切了歌，结果丢弃
        gen: u64,
        /// gapless 预载回执（true = 这是预载的「下一首」，就绪后存进预载槽，
        /// **不**直接挂载播放；gen 与发起时一致且开关仍开才会被接收）
        preload: bool,
    },
    Play,
    Pause,
    Stop,
    Seek(u64),
    SetVolume(f32),
    SetMuted(bool),
    /// 整表替换队列并从 index 开始播放
    SetQueue {
        tracks: Vec<Track>,
        index: usize,
    },
    /// Sender captures the original intent before this message enters the channel.
    QueuedSetQueue {
        tracks: Vec<Track>,
        index: usize,
        play_intent: u64,
        reply: tokio::sync::oneshot::Sender<QueueCommitReply>,
    },
    QueuedPlayAt {
        index: usize,
        play_intent: u64,
        reply: tokio::sync::oneshot::Sender<QueueCommitReply>,
    },
    QueuedNext {
        play_intent: u64,
        reply: tokio::sync::oneshot::Sender<QueueCommitReply>,
    },
    QueuedPrevious {
        play_intent: u64,
        reply: tokio::sync::oneshot::Sender<QueueCommitReply>,
    },
    QueuedPlayTrack {
        track: Box<Track>,
        play_intent: u64,
        reply: tokio::sync::oneshot::Sender<QueueCommitReply>,
    },
    StampedRestore {
        stamp: super::playback_commit::RestoreStamp,
        session: super::playback_commit::RestoredPlayback,
        reply: tokio::sync::oneshot::Sender<Option<(PlayTarget, PlaybackStateSnapshot)>>,
    },
    /// 单曲播放：**不替换队列** —— 队里已有这首（同 id + 同 platform）就播它原来那条，
    /// 否则追加到队尾再播。用户点某一首不该冲掉正在排队的整张列表。
    PlayTrack(Box<Track>),
    /// 下一首播放：插到当前曲目之后（不打断当前播放）
    AddNext(Box<Track>),
    /// 加入队尾（不打断当前播放）
    Append(Vec<Track>),
    /// 移除队列中某一项（不打断当前播放）
    RemoveAt(usize),
    /// 批量移除（批量管理）：一次移除多个下标，只发一次队列事件
    RemoveIndices(Vec<usize>),
    /// 拖动排序：把 from 位置的曲目移到 to
    MoveItem {
        from: usize,
        to: usize,
    },
    /// 清空当前曲目之后的所有曲目
    ClearAfter,
    PlayAt(usize),
    Next,
    Previous,
    SetPlayMode(PlayMode),
    ClearQueue,
    /// 恢复上次播放现场：置队列 + 应用播放模式/音质/音量，并以暂停态加载
    /// index 处曲目、定位到 position_ms（restore_last_session IPC）。
    RestoreSession {
        tracks: Vec<Track>,
        index: usize,
        position_ms: u64,
        play_mode: PlayMode,
        volume: f32,
        muted: bool,
        quality: Quality,
    },
    /// 切换音频输出设备。`None` = 跟随系统默认（默认设备变化时自动跟随）；
    /// `Some(设备名)` = 固定到该设备。用户主动切换时当前曲目从原进度无缝续播；
    /// 而被固定的设备当前不可用（或跟随默认时旧设备被拔掉）则暂停播放并说明
    /// —— 见 `pause_for_device_loss`。
    SetOutputDevice {
        name: Option<String>,
    },
    /// 改「默认播放音质」（设置页入口）：写进 settings，重启后保持；
    /// 当前曲目没被单独指定音质时，立即按新音质重新取址续播。
    SetDefaultQuality {
        quality: Quality,
    },
    /// 只改当前这首的音质（播放条入口）：不写 settings，切到别的歌自动回到默认。
    SetTrackQuality {
        quality: Quality,
    },
    /// 各平台独立音质（音源账号页）：前端全量推送 {平台: 档位}，只更新运行时
    /// 副本（持久化在前端设置库，引擎重启后由前端重灌）。
    SetSourceQualities {
        qualities: HashMap<String, Quality>,
    },
    /// 改播放倍速（0.5 ~ 2.0）。rodio Player 的速度控制链全权处理，
    /// 进度 / seek 的内容时间域由引擎在读写两侧换算（见 content_pos_ms / sink_seek_content）。
    SetSpeed(f32),
    /// Persistence only: retains the original source and control revision, never Player.
    SourceSpeedSetting(Box<SourceSpeedSetting>),
    /// Explicit Native control retains its sender value and shared speed revision.
    NativeSpeedSetting(Box<NativeSpeedSetting>),
    /// 睡眠定时：`Some(ms)` = 定时武装（到点暂停并清空）；None = 取消。
    /// `after_track` = 播完当前曲目后停止（无倒计时）。
    SetSleepTimer {
        remaining_ms: Option<u64>,
        after_track: bool,
    },
    /// 整体替换均衡器参数（设置页「音效」）。
    SetEq(EqParams),
    /// 响度归一化开关（设置页「音效」）。
    SetLoudNorm(bool),
    /// ReplayGain 静态增益模式（关闭 / 单曲 / 专辑，A1）。切模式会立刻按当前
    /// 曲目重算增益，正在播的那首当场变响度。
    SetReplayGain(crate::audio::ReplayGainMode),
    /// 淡入淡出参数（设置页「音效」）。
    SetFade(FadeParams),
    /// 播放条频谱背景开关：开 = DspSource 采样做 FFT 推 `spectrum` 事件。
    SetSpectrum(bool),
    /// Append the prepared next source to the current Player without a stop/restart.
    SetGapless(bool),
    /// 播放缓存体积上限（MB，0 = 不限）。引擎落 settings 并立即后台修剪一遍。
    SetCacheLimit(u64),
    /// 切换播放缓存目录（设置页「通用 → 缓存位置」）。之后的取流按新目录落盘；
    /// 已在播的那条流保持原文件不变（文件句柄正被读）。
    SetCacheDir(PathBuf),
    /// 取址 / 打开流失败的回执：统一置错误态，并决定是否自动跳过（§7.3 恢复策略）。
    LoadFailed {
        original: Option<Arc<super::render_control::SourceSeekPort>>,
        kind: &'static str,
        track_id: String,
        message: String,
        /// 触发时是否处于「应当继续播放」的语义（自动切歌 / 在播时换曲）
        autoplay: bool,
        /// 本次失败是否只是**环境问题**（弱网 / 引擎卡 / 取链等待超时）。
        /// true 时不把这首拉进 `failed_tracks`、不计入连续失败熔断 ——
        /// 「等久了」不等于「这首歌坏了」。见 `ProviderError::is_stalled`。
        stalled: bool,
        /// 加载代次：过期的失败回执直接丢弃（用户早已切到别的歌）
        gen: u64,
    },
    /// 装配 / 卸载系统媒体控制（SMTC）。启动时由 lib.rs 注入。
    SetSmtc(Option<crate::smtc::SmtcHandle>),    /// 弱网原地重试：延迟到达后重试**同一首**（`schedule_stalled_retry` 投递）。
    /// 与 `LoadFailed` 不同，它不换歌、不动熔断计数。
    StalledRetry {
        track_id: String,
        /// 投递时的加载代次：不匹配说明期间用户已切歌/重载，直接丢弃
        gen: u64,
    },
    /// 恢复探测成功（`schedule_recovery_probe` 投递）：重开自动切歌并把
    /// 当前曲重新拉起来。gen == 0 表示不校验代次（探测针对队列当前曲）。
    Recovered { gen: u64 },
    /// 输出流/音频回调线程出事（cpal 流错误，或 panic 钩子捕获到 cpal 线程 panic）。
    ///
    /// 这两种情况下 `PlaybackStatus` 仍然是 Playing、位置却已经冻住，前端和
    /// 指标都看不出任何异常 —— 必须由引擎主动兜底（见 `watch_pipeline`）。
    StreamError {
        /// 原始错误文案（只进日志与错误态，不含 URL）
        message: String,
        /// true = 音频回调线程已经 panic 退出。此时输出流不可能再出声音，
        /// 软重载（重新挂源）也拉不动它（没有回调来拉样本）→ 必须直接重建输出流。
        fatal: bool,
    },
    /// 不喜欢列表变了（加/删/清空）：重新装载内存镜像。
    /// 屏蔽规则一改就把自动切歌立刻对齐，不用等下一轮播完。
    ReloadDislikes,
    /// A failed speculative load must never change the current playback state.
    PreloadFailed { gen: u64 },
    Shutdown,
}

/// Immutable source-loader inputs, prepared by the same factory used by the actor.
/// Preparation only reserves the original target; it opens no device, file or URL.
pub struct SourceLoadRequest {
    pub target: Option<PlayTarget>,
    pub port: Option<Arc<super::render_control::SourceSeekPort>>,
    pub track: Track,
    pub autoplay: bool,
    pub start_ms: u64,
    pub gen: u64,
}

impl SourceLoadRequest {
    fn ready_command(
        &self, preload: bool, built: BuiltDecoder, is_local: bool,
        fetched_at: Option<u64>, play_url: Option<String>, size_bytes: Option<u64>,
    ) -> AudioCmd {
        let BuiltDecoder { source: decoder, shared, duration_ms, physical_duration_ms } = built;
        // A CUE track covers part of the physical file. Scale its byte count as
        // well, so dividing by the interval duration preserves the file bitrate.
        let size_bytes = size_bytes.or_else(|| shared.as_ref().and_then(|shared| shared.total_len()));
        let size_bytes = if self.track.start_ms.is_some() || self.track.end_ms.is_some() {
            size_bytes.and_then(|size| (physical_duration_ms > 0).then(|| {
                (u128::from(size) * u128::from(duration_ms) / u128::from(physical_duration_ms)) as u64
            }))
        } else {
            size_bytes
        };
        let start_at = if duration_ms > 0 { self.start_ms.min(duration_ms) } else { self.start_ms };
        AudioCmd::LoadReady {
            target: self.target.clone(),
            port: self.port.clone(),
            track: Box::new(self.track.clone()),
            decoder,
            shared,
            duration_ms,
            start_at: (start_at > 0).then_some(start_at),
            autoplay: self.autoplay,
            is_local,
            url_fetched_at: fetched_at,
            play_url,
            size_bytes,
            gen: self.gen,
            preload,
        }
    }

    fn failure_command(&self, kind: &'static str, message: String, stalled: bool) -> AudioCmd {
        AudioCmd::LoadFailed {
            original: self.port.clone(), kind, track_id: self.track.id.clone(),
            message, autoplay: self.autoplay, stalled, gen: self.gen,
        }
    }

    /// Drive the same local decoder and failure packet without constructing a provider or device.
    pub fn decode_local_or_report(
        &self, owner: &AudioEngine, path: &Path,
    ) -> Result<Decoder<BufReader<std::fs::File>>, String> {
        decode_local_file(path).inspect_err(|detail| {
            let _ = owner.tx.send(self.failure_command(
                "load", load_failure_message(detail, false), false,
            ));
        })
    }
}

fn load_failure_message(detail: &str, stalled: bool) -> String {
    if stalled { format!("网络较慢，正在重试（{detail}）") }
    else { format!("该歌曲暂时无法播放（{detail}）") }
}

/// Actual failed-loader inputs; the original reservation is not a current-source lookup.
pub struct SourceFailureInput {
    pub original: Arc<super::render_control::SourceSeekPort>,
    pub kind: &'static str,
    pub track_id: String,
    pub message: String,
    pub autoplay: bool,
    pub stalled: bool,
    pub gen: u64,
}

/// Raw actor recovery policy, not an authored failure result or replacement state machine.
pub struct SourceRecoveryContext {
    pub auto_next: bool,
    pub fail_streak: u32,
    pub failed_tracks: std::collections::HashSet<String>,
}

pub enum SourceFailureEffect {
    Error,
    Retry,
    Circuit { notice: String },
    Advance { track: Box<Track>, target: PlayTarget, request: Option<Box<SourceLoadRequest>> },
}

pub struct SourceFailureApplied {
    pub input: SourceFailureInput,
    pub updates: Vec<PlaybackStateSnapshot>,
    pub effect: SourceFailureEffect,
}

/// The production channel's accepted semantic work, separated from device/IO effects.
pub enum AudioDelivery {
    Command(AudioCmd),
    SourceSpeedSetting(Box<SourceSpeedSetting>),
    /// Explicit Native control retains its sender value and shared speed revision.
    NativeSpeedSetting(Box<NativeSpeedSetting>),
    Playback(Box<PlaybackCommitPlan>),
    /// Index/track navigation retains per-track quality and the existing failed-track set.
    ManualPlayback(Box<PlaybackCommitPlan>),
    /// Next preserves navigation's existing listening and failure context.
    NavigationPlayback(Box<PlaybackCommitPlan>),
    /// Previous does not force Next's listening settlement or skip dislikes.
    PreviousPlayback(Box<PlaybackCommitPlan>),
    AutomaticPlayback {
        advance: Box<super::playback_commit::AutomaticAdvance>,
        request: Option<Box<SourceLoadRequest>>,
    },
    /// Raw original-loader receipt; the shared failure body decides its effects.
    SourceFailure(Box<SourceFailureInput>),
    Rejected,
}

impl AudioDelivery {
    /// The real actor and headless settings boundary execute this same persistence step.
    /// Bound requests authorize their captured source after the DB wait and never Player.
    pub fn persist_speed(self, db: Option<&Database>) -> Result<bool, String> {
        match self {
            Self::SourceSpeedSetting(setting) => setting.persist(db),
            Self::NativeSpeedSetting(setting) => setting.persist(db),
            Self::Command(AudioCmd::SetSpeed(_)) =>
                Err(String::from("unstamped Native speed persistence rejected")),
            _ => Ok(false),
        }
    }
}

/// The same receiver used by `spawn`; constructing a channel never opens a device.
pub struct AudioCommandInbox {
    rx: mpsc::Receiver<AudioCmd>,
    core: PlaybackCommitter,
    owner: AudioEngine,
}

impl AudioCommandInbox {
    fn reserve_plan(&self, plan: Option<PlaybackCommitPlan>) -> Option<PlaybackCommitPlan> {
        let mut plan = plan?;
        if let Some(target) = &plan.target {
            plan.port = Some(self.owner.reserve_source_mount(target.clone())?);
        }
        Some(plan)
    }

    pub fn recv_timeout(
        &self,
        timeout: Duration,
        load_gen: &mut u64,
    ) -> Result<AudioDelivery, mpsc::RecvTimeoutError> {
        self.recv_timeout_skipping(timeout, load_gen, |_| false)
    }

    /// The production actor supplies its existing in-memory dislike matcher, never DB IO.
    pub fn recv_timeout_skipping(
        &self,
        timeout: Duration,
        load_gen: &mut u64,
        skip: impl Fn(&Track) -> bool,
    ) -> Result<AudioDelivery, mpsc::RecvTimeoutError> {
        let cmd = self.rx.recv_timeout(timeout)?;
        if let AudioCmd::LoadReady { target: Some(target), gen, preload, .. } = &cmd {
            let eligible = (*preload || *gen == *load_gen)
                && self.core.with_target(target, |_| ()).is_some();
            if !eligible {
                // Decoder/resource destruction occurs only after the short Gate read ends.
                return Ok(AudioDelivery::Rejected);
            }
        }
        match cmd {
            AudioCmd::LoadFailed {
                original: Some(original), kind, track_id, message, autoplay, stalled, gen,
            } => Ok(AudioDelivery::SourceFailure(Box::new(SourceFailureInput {
                original, kind, track_id, message, autoplay, stalled, gen,
            }))),
            AudioCmd::SourceFinished(original) => {
                let Some((advance, port)) = self.owner.advance_finished_source(&original, load_gen, skip)
                    else { return Ok(AudioDelivery::Rejected); };
                let request = advance.track.clone().and_then(|track| self.owner.prepare_source_load(
                    track, Some(advance.target.clone()), port, advance.load_gen, true, 0,
                )).map(Box::new);
                Ok(AudioDelivery::AutomaticPlayback { advance: Box::new(advance), request })
            }
            AudioCmd::QueuedSetQueue { tracks, index, play_intent, reply } => {
                // The receiver commits only the ticket captured by the sender.
                let plan = self.core.commit_queue(play_intent, tracks, index, load_gen);
                let plan = self.reserve_plan(plan);
                let receipt = plan.as_ref().map(|plan| plan.reply.clone())
                    .unwrap_or_else(QueueCommitReply::rejected);
                let _ = reply.send(receipt);
                Ok(plan.map(|plan| AudioDelivery::Playback(Box::new(plan)))
                    .unwrap_or(AudioDelivery::Rejected))
            }
            AudioCmd::QueuedPlayAt { index, play_intent, reply } => {
                let generation = play_intent;
                let mut queue = self.core.queue_snapshot();
                let plan = if index >= queue.len() {
                    None
                } else {
                    queue.commit_index(index);
                    let prepared = self.core.prepare(generation, queue, true, 0, None);
                    self.core.commit_prepared(generation, prepared, load_gen)
                };
                let plan = self.reserve_plan(plan);
                let receipt = plan.as_ref().map(|plan| plan.reply.clone())
                    .unwrap_or_else(QueueCommitReply::rejected);
                let _ = reply.send(receipt);
                Ok(plan.map(|plan| AudioDelivery::ManualPlayback(Box::new(plan)))
                    .unwrap_or(AudioDelivery::Rejected))
            }
            AudioCmd::QueuedNext { play_intent, reply } => {
                let generation = play_intent;
                let mut queue = self.core.queue_snapshot();
                let mode = self.core.snapshot().play_mode;
                let plan = queue.next_index_skipping(mode, false, skip).and_then(|index| {
                    queue.commit_index(index);
                    let prepared = self.core.prepare(generation, queue, true, 0, None);
                    self.core.commit_prepared(generation, prepared, load_gen)
                });
                let plan = self.reserve_plan(plan);
                let receipt = plan.as_ref().map(|plan| plan.reply.clone())
                    .unwrap_or_else(QueueCommitReply::rejected);
                let _ = reply.send(receipt);
                Ok(plan.map(|plan| AudioDelivery::NavigationPlayback(Box::new(plan)))
                    .unwrap_or(AudioDelivery::Rejected))
            }
            AudioCmd::QueuedPrevious { play_intent, reply } => {
                let generation = play_intent;
                let mut queue = self.core.queue_snapshot();
                let mode = self.core.snapshot().play_mode;
                let plan = queue.previous_index(mode).and_then(|index| {
                    queue.commit_index(index);
                    let prepared = self.core.prepare(generation, queue, true, 0, None);
                    self.core.commit_prepared(generation, prepared, load_gen)
                });
                let plan = self.reserve_plan(plan);
                let receipt = plan.as_ref().map(|plan| plan.reply.clone())
                    .unwrap_or_else(QueueCommitReply::rejected);
                let _ = reply.send(receipt);
                Ok(plan.map(|plan| AudioDelivery::PreviousPlayback(Box::new(plan)))
                    .unwrap_or(AudioDelivery::Rejected))
            }
            AudioCmd::QueuedPlayTrack { track, play_intent, reply } => {
                let mut candidate = self.core.queue_snapshot();
                let index = candidate.append_or_find(*track);
                candidate.commit_index(index);
                let prepared = self.core.prepare(play_intent, candidate, true, 0, None);
                let plan = self.core.commit_prepared(play_intent, prepared, load_gen);
                let plan = self.reserve_plan(plan);
                let receipt = plan.as_ref().map(|plan| plan.reply.clone())
                    .unwrap_or_else(QueueCommitReply::rejected);
                let _ = reply.send(receipt);
                Ok(plan.map(|plan| AudioDelivery::ManualPlayback(Box::new(plan)))
                    .unwrap_or(AudioDelivery::Rejected))
            }
            AudioCmd::StampedRestore { stamp, session, reply } => {
                let plan = self.core.commit_restore(stamp, session, load_gen);
                let plan = self.reserve_plan(plan);
                let receipt = plan.as_ref().and_then(|plan| plan.target.clone()
                    .map(|target| (target, plan.snapshot.clone())));
                let _ = reply.send(receipt);
                Ok(plan.map(|plan| AudioDelivery::Playback(Box::new(plan)))
                    .unwrap_or(AudioDelivery::Rejected))
            }
            AudioCmd::SourceSpeedSetting(setting) => Ok(AudioDelivery::SourceSpeedSetting(setting)),
            AudioCmd::NativeSpeedSetting(setting) => Ok(AudioDelivery::NativeSpeedSetting(setting)),
            cmd => Ok(AudioDelivery::Command(cmd)),
        }
    }
}

/// A queue caller releases only its original, still-uncommitted ticket on every exit.
struct PendingQueueIntent {
    gate: super::play_intent::PlayIntentGate,
    generation: u64,
}

impl Drop for PendingQueueIntent {
    fn drop(&mut self) {
        self.gate.abandon(self.generation);
    }
}

#[derive(Default)]
struct SourceMounts {
    reserved: Option<Arc<super::render_control::SourceSeekPort>>,
    current: Option<Arc<super::render_control::SourceSeekPort>>,
}

/// Source callbacks retain original authority without keeping the mount registry alive.
#[derive(Clone)]
pub(super) struct SourceControlOwner {
    core: PlaybackCommitter,
    mounts: std::sync::Weak<Mutex<SourceMounts>>,
}
impl SourceControlOwner {
    fn with_original<T>(&self, original: &super::render_control::SourceSeekPort,
        current_only: bool, apply: impl FnOnce(&mut PlaybackStateSnapshot) -> T) -> Option<T>
    {
        let mounts = self.mounts.upgrade()?;
        self.core.with_target(&original.stamp().target, |state| {
            let mounts = mounts.lock().unwrap_or_else(|e| e.into_inner());
            let current = mounts.current.as_ref()
                .is_some_and(|port| std::ptr::eq(port.as_ref(), original));
            let reserved = !current_only && mounts.reserved.as_ref()
                .is_some_and(|port| std::ptr::eq(port.as_ref(), original));
            if original.is_live() && (current || reserved) { Some(apply(state)) } else { None }
        }).flatten()
    }
    pub(super) fn qualifies(&self, original: &super::render_control::SourceSeekPort) -> bool {
        self.with_original(original, false, |_| ()).is_some()
    }
    pub(super) fn commit_seek(&self, original: &super::render_control::SourceSeekPort, position_ms: u64) -> bool {
        self.with_original(original, true, |state| state.position_ms = position_ms).is_some()
    }
    pub(super) fn qualifies_speed(&self, original: &super::render_control::SourceSeekPort,
        clock: &AtomicU64, revision: u64) -> bool
    {
        self.with_original(original, false, |_| clock.load(Ordering::Acquire) == revision)
            .unwrap_or(false)
    }
    fn commit_speed(&self, original: &super::render_control::SourceSeekPort, speed: f32,
        clock: &AtomicU64) -> Option<u64>
    {
        self.with_original(original, false, |state| {
            // All clock mutations own State; exhaustion rejects without changing speed.
            let revision = clock.load(Ordering::Acquire).checked_add(1)?;
            original.set_speed(speed);
            state.speed = speed;
            clock.store(revision, Ordering::Release);
            Some(revision)
        }).flatten()
    }
    fn commit_pause(&self, original: &super::render_control::SourceSeekPort, paused: bool) -> bool {
        self.with_original(original, false, |state| {
            original.set_paused(paused);
            if original.is_ready() { state.position_ms = original.position_ms(); }
            state.status = if paused { PlaybackStatus::Paused }
                else if original.is_ready() { PlaybackStatus::Playing } else { PlaybackStatus::Loading };
        }).is_some()
    }
}

/// 引擎句柄：clone 后供多个 Tauri 命令使用。
#[derive(Clone)]
pub struct AudioEngine {
    tx: Sender<AudioCmd>,
    dlna: crate::dlna::DlnaManager,
    core: PlaybackCommitter,
    source_mounts: Arc<Mutex<SourceMounts>>,
    mount_nonce: Arc<AtomicU64>,
    speed_revision: Arc<AtomicU64>,
    render_seek: Arc<Mutex<Option<super::render_control::BoundSeekSender>>>,
    state: Arc<RwLock<PlaybackStateSnapshot>>,
    queue: Arc<Mutex<Queue>>,
    /// 音效设置（EQ / 响度归一化 / 淡入淡出）：命令线程写、渲染线程读
    fx: Arc<AudioFx>,
    /// 正在播放的流所对应的磁盘缓存文件（cmd_clear_audio_cache 跳过它，
    /// Windows 上删被占用的文件会失败）
    cache_file: Arc<Mutex<Option<PathBuf>>>,
}

/// 音频回调线程（cpal 的 `cpal_wasapi_out` / `cpal_wasapi_in` 等）panic 的上报通道。
///
/// 为什么单独留这条：cpal 的输出流线程跑的就是**拉样本回调**
/// （`run_output(run_context, &mut data_callback, ..)`），解码器 panic 会顺着回调
/// 打死整条线程 —— 而 cpal 既不会重建线程，也不会调 error callback。结果
/// rodio 的 `Player::get_pos()`（位置）与 `Player::empty()`（曲终判定）双双冻结，
/// 引擎收不到任何信号，表现为「播到一半卡死，按播放键也没反应」。
/// file_logger 的全局 panic 钩子认出线程名后经这里投一条 StreamError 进来。
static AUDIO_THREAD_PANIC_TX: std::sync::OnceLock<Sender<AudioCmd>> = std::sync::OnceLock::new();

/// 由全局 panic 钩子调用（见 `file_logger::install_panic_hook`）。
///
/// **只能在 panic 钩子里用**：不加锁、不写日志、不分配大对象，只往无界 channel
/// 投一条消息（引擎线程收到后做重活）。`msg` 形如
/// `cpal_wasapi_out: attempt to subtract with overflow at ...`。
pub fn notify_audio_thread_panic(msg: &str) {
    let Some(tx) = AUDIO_THREAD_PANIC_TX.get() else {
        return;
    };
    let _ = tx.send(AudioCmd::StreamError {
        message: msg.to_string(),
        fatal: true,
    });
}

impl AudioEngine {
    /// Allocate the production message/state boundary without any device, DB or network.
    pub fn command_channel() -> (Self, AudioCommandInbox) {
        let (tx, rx) = mpsc::channel();
        let state = Arc::new(RwLock::new(PlaybackStateSnapshot::default()));
        let queue = Arc::new(Mutex::new(Queue::default()));
        let core = PlaybackCommitter::new(
            super::play_intent::PlayIntentGate::new(), Arc::clone(&queue), Arc::clone(&state),
        );
        let engine = Self {
            tx, core: core.clone(), state, queue, fx: Arc::new(AudioFx::new()),
            dlna: crate::dlna::DlnaManager::default(),
            source_mounts: Arc::new(Mutex::new(SourceMounts::default())),
            mount_nonce: Arc::new(AtomicU64::new(0)),
            speed_revision: Arc::new(AtomicU64::new(0)),
            render_seek: Arc::new(Mutex::new(None)),
            cache_file: Arc::new(Mutex::new(None)),
        };
        let inbox = AudioCommandInbox { rx, core, owner: engine.clone() };
        (engine, inbox)
    }

    /// Queue the original mounted source; no new ticket or latest-source lookup here.
    pub fn source_finished(&self, original: Arc<super::render_control::SourceSeekPort>) {
        let _ = self.tx.send(AudioCmd::SourceFinished(original));
    }

    /// The production deletion command and software driver share the original Queue gap policy.
    /// Removing an entry updates only queue metadata, not the physical/logical playing track.
    pub fn remove_queue_indices(&self, indices: &[usize]) -> usize {
        let mut queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        let removed = queue.remove_indices(indices);
        if removed > 0 {
            let mut state = self.state.write().unwrap_or_else(|e| e.into_inner());
            state.queue_index = queue.index;
            state.queue_len = queue.len();
        }
        removed
    }

    /// Prepare the existing failure policy outside Gate, then admit its original reservation once.
    /// A failed loader may own reserved A while the physical current source is still Z.
    pub fn apply_source_failure(
        &self, input: SourceFailureInput, context: &mut SourceRecoveryContext,
        load_gen: &mut u64,
    ) -> Option<SourceFailureApplied> {
        if input.gen != *load_gen { return None; }
        let original = input.original.stamp().target.clone();
        if input.track_id != original.id { return None; }
        let mut state = self.snapshot();
        let mut queue = self.queue_snapshot();
        let mut policy = SourceRecoveryContext {
            auto_next: context.auto_next, fail_streak: context.fail_streak,
            failed_tracks: context.failed_tracks.clone(),
        };
        state.status = PlaybackStatus::Error;
        state.error = Some(input.message.clone());
        let mut updates = vec![state.clone()];
        let mut effect = SourceFailureEffect::Error;
        let mut port = None;
        if input.autoplay && policy.auto_next {
            if input.stalled {
                effect = SourceFailureEffect::Retry;
            } else {
                policy.fail_streak += 1;
                if policy.fail_streak >= FAIL_STREAK_LIMIT {
                    policy.auto_next = false;
                    policy.fail_streak = 0;
                    let notice = format!("连续{FAIL_STREAK_LIMIT}首播放失败，已停止自动切歌");
                    state.error = Some(notice.clone());
                    updates.push(state.clone());
                    effect = SourceFailureEffect::Circuit { notice };
                } else {
                    policy.failed_tracks.insert(input.track_id.clone());
                    let len = queue.len();
                    if len > 1 {
                        if let Some(current) = queue.index {
                            let selected = (1..=len).map(|offset| (current + offset) % len)
                                .find(|index| queue.tracks.get(*index)
                                    .is_some_and(|track| !policy.failed_tracks.contains(&track.id)));
                            if let Some(index) = selected {
                                queue.commit_index(index);
                                if let Some(track) = queue.current().cloned() {
                                    let target = PlayTarget::new(original.generation.checked_add(1)?, &track);
                                    state.queue_index = queue.index;
                                    state.queue_len = queue.len();
                                    super::playback_commit::set_loading_snapshot(&mut state, &track, 0);
                                    updates.push(state.clone());
                                    let stamp = super::render_control::MountStamp {
                                        target: target.clone(),
                                        mount_nonce: self.mount_nonce.fetch_add(1, Ordering::Relaxed).wrapping_add(1),
                                    };
                                    let owner = SourceControlOwner {
                                        core: self.core.clone(), mounts: Arc::downgrade(&self.source_mounts),
                                    };
                                    let candidate = super::render_control::SourceSeekPort::reserved(
                                        stamp, self.core.gate().clone(), owner,
                                    );
                                    // The same factory receives the exact candidate registered by the commit.
                                    let request = self.prepare_source_load(track.clone(), Some(target.clone()),
                                        Some(candidate.clone()), input.gen.wrapping_add(1), true, 0).map(Box::new);
                                    port = Some(candidate);
                                    effect = SourceFailureEffect::Advance { track: Box::new(track), target, request };
                                }
                            } else {
                                state.error = Some(format!(
                                    "队列内 {len} 首均无法播放，请检查音源或稍后重试",
                                ));
                                updates.push(state.clone());
                            }
                        }
                    }
                }
            }
        }
        let has_next = port.is_some();
        let target_generation = port.as_ref().map_or(original.generation, |port| port.stamp().target.generation);
        let mut registration = port.clone();
        let mut retired = None;
        self.core.gate().with_automatic(original.generation, has_next, |generation| {
            if generation != target_generation || *load_gen != input.gen { return None; }
            // Lock order is Gate → Queue → State → Mounts. No IO or resource drops here.
            let mut current_queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
            let mut current_state = self.state.write().unwrap_or_else(|e| e.into_inner());
            if !current_state.track.as_ref().is_some_and(|track| original.matches_track(track)) {
                return None;
            }
            let mut mounts = self.source_mounts.lock().unwrap_or_else(|e| e.into_inner());
            let same = |port: &Arc<super::render_control::SourceSeekPort>| {
                Arc::ptr_eq(port, &input.original) && port.stamp() == input.original.stamp()
            };
            let owns_reservation = mounts.reserved.as_ref().is_some_and(same);
            let owns_current = mounts.reserved.is_none() && mounts.current.as_ref().is_some_and(same);
            if !owns_reservation && !owns_current { return None; }
            for next in std::iter::once(&mut state).chain(updates.iter_mut()) {
                next.volume = current_state.volume;
                next.muted = current_state.muted;
                next.speed = current_state.speed;
                next.play_mode = current_state.play_mode;
                next.sleep_timer_ms = current_state.sleep_timer_ms;
                next.sleep_after_track = current_state.sleep_after_track;
            }
            if let Some(port) = &port {
                port.set_speed(current_state.speed);
                retired = std::mem::replace(&mut mounts.reserved, registration.take());
                std::mem::swap(&mut *current_queue, &mut queue);
                std::mem::swap(&mut *current_state, &mut state);
                *load_gen = input.gen.wrapping_add(1);
            } else {
                // An error-only/retry/circuit receipt does not replace unrelated transport metadata.
                current_state.status = PlaybackStatus::Error;
                std::mem::swap(&mut current_state.error, &mut state.error);
            }
            std::mem::swap(context, &mut policy);
            Some(())
        })?;
        if let Some(retired) = retired { retired.retire(); }
        Some(SourceFailureApplied { input, updates, effect })
    }

    pub fn begin_play_intent(&self) -> u64 {
        self.core.gate().begin()
    }

    pub fn dlna_manager(&self) -> crate::dlna::DlnaManager { self.dlna.clone() }

    pub async fn connect_dlna(&self, device_id: String) -> Result<crate::dlna::CastState, String> {
        let (reply, result) = tokio::sync::oneshot::channel();
        self.tx.send(AudioCmd::DlnaConnect { device_id, reply }).map_err(|_| "播放引擎已退出")?;
        result.await.map_err(|_| "播放引擎已退出".to_string())?
    }

    pub async fn disconnect_dlna(&self, return_to_local: bool) -> Result<(), String> {
        let (reply, result) = tokio::sync::oneshot::channel();
        self.tx.send(AudioCmd::DlnaDisconnect { return_to_local, reply }).map_err(|_| "播放引擎已退出")?;
        result.await.map_err(|_| "播放引擎已退出".to_string())?
    }

    pub fn abandon_play_intent(&self, play_intent: u64) -> bool {
        self.core.gate().abandon(play_intent)
    }

    /// A source adapter retains the same engine authority as its original target.
    pub fn source_seek_port(&self, stamp: super::render_control::MountStamp)
        -> Arc<super::render_control::SourceSeekPort>
    {
        super::render_control::SourceSeekPort::with_gate(stamp, self.core.gate().clone())
    }

    /// Reserve one physical source incarnation, without running a decoder or Player.
    pub fn reserve_source_mount(&self, target: PlayTarget)
        -> Option<Arc<super::render_control::SourceSeekPort>>
    {
        let stamp = super::render_control::MountStamp {
            target,
            mount_nonce: self.mount_nonce.fetch_add(1, Ordering::Relaxed).wrapping_add(1),
        };
        let owner = SourceControlOwner { core: self.core.clone(), mounts: Arc::downgrade(&self.source_mounts) };
        let port = super::render_control::SourceSeekPort::reserved(stamp, self.core.gate().clone(), owner);
        let retired = self.core.with_target(&port.stamp().target, |state| {
            let mut mounts = self.source_mounts.lock().unwrap_or_else(|e| e.into_inner());
            port.set_speed(state.speed);
            mounts.reserved.replace(port.clone())
        })?;
        if let Some(retired) = retired { retired.retire(); }
        Some(port)
    }

    /// Qualify the original EOF and register C in the same automatic Core commit.
    fn advance_finished_source(
        &self, original: &Arc<super::render_control::SourceSeekPort>, load_gen: &mut u64,
        skip: impl Fn(&Track) -> bool,
    ) -> Option<(super::playback_commit::AutomaticAdvance,
        Option<Arc<super::render_control::SourceSeekPort>>)> {
        let prepared = self.core.prepare_automatic(original.stamp().target.clone(), *load_gen, skip)?;
        let port = prepared.track.as_ref().map(|_| {
            let stamp = super::render_control::MountStamp { target: prepared.target.clone(),
                mount_nonce: self.mount_nonce.fetch_add(1, Ordering::Relaxed).wrapping_add(1) };
            let owner = SourceControlOwner { core: self.core.clone(), mounts: Arc::downgrade(&self.source_mounts) };
            super::render_control::SourceSeekPort::reserved(stamp, self.core.gate().clone(), owner)
        });
        let mut registration = port.clone();
        let mut retired = None;
        let advance = self.core.commit_automatic(&original.stamp().target, prepared, load_gen, |state| {
            let mut mounts = self.source_mounts.lock().unwrap_or_else(|e| e.into_inner());
            // EOF may already have retired the source; is_live is deliberately not used.
            if !original.has_drained_eof() || !mounts.current.as_ref().is_some_and(|current|
                Arc::ptr_eq(current, original) && current.stamp() == original.stamp())
                || mounts.reserved.as_ref().is_some_and(|reserved| !Arc::ptr_eq(reserved, original))
            { return false; }
            if let Some(port) = &port { port.set_speed(state.speed); }
            retired = std::mem::replace(&mut mounts.reserved, registration.take());
            true
        });
        if let Some(retired) = retired { retired.retire(); }
        advance.map(|advance| (advance, port))
    }

    /// The actor and public software boundary retain the same original loader inputs.
    /// This is the existing loader preparation, including its fail-closed reservation.
    pub fn prepare_source_load(
        &self, track: Track, target: Option<PlayTarget>,
        original_port: Option<Arc<super::render_control::SourceSeekPort>>,
        gen: u64, autoplay: bool, start_ms: u64,
    ) -> Option<SourceLoadRequest> {
        let port = original_port.or_else(|| target.as_ref()
            .and_then(|target| self.reserve_source_mount(target.clone())));
        if target.is_some() && port.is_none() { return None; }
        Some(SourceLoadRequest { target, port, track, autoplay, start_ms, gen })
    }

    /// Prepare the actor's existing speculative selection; no source reservation or IO.
    pub fn prepare_preload(
        &self, p: &mut PreloadState, input: PreloadPrepare<'_>,
        skip: impl Fn(&Track) -> bool,
    ) -> Option<PreloadRequest> {
        let (playing, mode, original_track) = {
            let state = self.state.read().unwrap_or_else(|e| e.into_inner());
            (state.status == PlaybackStatus::Playing, state.play_mode, state.track.clone())
        };
        let facts = PreloadFacts {
            gapless: input.flags.gapless,
            sleep_after_track: input.flags.sleep_after_track,
            auto_next: input.flags.auto_next,
            has_slot: p.slot.is_some(),
            pausing: input.pausing,
            playing,
            has_progress: input.current_progress.is_some(),
            retries_left: p.retries < PRELOAD_RETRY_LIMIT,
        };
        if let Some(reason) = preload_block(facts) {
            log::trace!("[gapless] 跳过预热：{reason}");
            return None;
        }
        let original_track = original_track?;
        let original_progress = Arc::clone(input.current_progress?);
        match (input.target, input.current_mount) {
            (Some(target), Some(port))
                if target.matches_track(&original_track) && &port.stamp().target == target
                    && Arc::ptr_eq(&original_progress, &port.progress()) => {}
            (None, None) => {}
            _ => return None,
        }
        let candidate = {
            let queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
            queue.next_index_skipping(mode, true, skip).and_then(|index| {
                Some((index, queue.tracks.get(index)?.clone(),
                    queue.current().cloned(), queue.selection_cursor()))
            })
        };
        let (index, track, original_queue_track, original_queue_cursor) = candidate?;
        p.gen = p.gen.wrapping_add(1);
        let gen = p.gen;
        // Choose Random exactly once; the retained index is committed on activation.
        p.slot = Some(PreloadSlot {
            gen, index, track: track.clone(), ready: None,
            original_track, original_progress, original_target: input.target.cloned(),
            original_queue_track, original_queue_cursor,
            original_mount: input.current_mount.cloned(),
            original_stamp: input.current_mount.map(|mount| mount.stamp().clone()),
            original_load_gen: input.load_gen,
        });
        log::debug!("[gapless] 开始预热下一首 {}（mode={mode:?}, index={index}）", track.id);
        let quality = input.quality.effective_for(&track);
        Some(PreloadRequest {
            request: SourceLoadRequest {
                target: input.target.cloned(), port: None,
                track, autoplay: true, start_ms: 0, gen,
            },
            quality,
        })
    }

    /// Complete only the original reservation after append, never a reconstructed target.
    pub fn complete_source_mount(&self, original: &Arc<super::render_control::SourceSeekPort>) -> bool {
        let completed = self.core.with_target(&original.stamp().target, |_| {
            let mut mounts = self.source_mounts.lock().unwrap_or_else(|e| e.into_inner());
            if !original.is_live() || !mounts.reserved.as_ref()
                .is_some_and(|port| Arc::ptr_eq(port, original))
            {
                return None;
            }
            let reservation = mounts.reserved.take().expect("the original reservation exists");
            original.arm();
            Some(mounts.current.replace(reservation))
        }).flatten();
        if let Some(retired) = completed {
            if let Some(retired) = retired { retired.retire(); }
            return true;
        }
        let (retire, discarded) = {
            let mut mounts = self.source_mounts.lock().unwrap_or_else(|e| e.into_inner());
            let retire = !mounts.current.as_ref().is_some_and(|port| Arc::ptr_eq(port, original));
            let discarded = if mounts.reserved.as_ref().is_some_and(|port| Arc::ptr_eq(port, original)) {
                mounts.reserved.take()
            } else { None };
            (retire, discarded)
        };
        if retire { original.retire(); }
        drop(discarded);
        false
    }

    pub fn current_source_mount(&self) -> Option<Arc<super::render_control::SourceSeekPort>> {
        self.source_mounts.lock().unwrap_or_else(|e| e.into_inner()).current.clone()
    }

    /// The software Player and render inbox used by normal construction and rebuild.
    pub fn player_channel(&self) -> (Player, super::render_control::RenderSeekOutput) {
        let (player, output) = Player::new();
        let (output, sender) = super::render_control::RenderSeekOutput::new(output);
        let retired = self.render_seek.lock().unwrap_or_else(|e| e.into_inner()).replace(sender);
        drop(retired);
        (player, output)
    }

    /// Capture the original source incarnation, never a later current target.
    pub fn source_mount(&self, target: &PlayTarget) -> Option<Arc<super::render_control::SourceSeekPort>> {
        self.core.with_target(target, |_| {
            let mounts = self.source_mounts.lock().unwrap_or_else(|e| e.into_inner());
            mounts.current.as_ref().filter(|port| port.stamp().target == *target && port.is_live())
                .or_else(|| mounts.reserved.as_ref().filter(|port| port.stamp().target == *target && port.is_live())).cloned()
        }).flatten()
    }

    /// Source-local control entry; no Player or decoder operations run under the gate.
    pub fn set_source_paused(&self, target: &PlayTarget, paused: bool)
        -> Result<super::render_control::MountStamp, super::render_control::BoundSeekFailure>
    {
        use super::render_control::BoundSeekFailure;
        let original = self.source_mount(target).ok_or(BoundSeekFailure {
            message: "original source not mounted", source_intact: true,
        })?;
        let owner = SourceControlOwner { core: self.core.clone(), mounts: Arc::downgrade(&self.source_mounts) };
        if let Some(connection) = self.dlna.selected() {
            if !owner.qualifies(&original) {
                return Err(BoundSeekFailure { message: "original source superseded", source_intact: true });
            }
            let stamp = original.stamp().clone();
            self.tx.send(AudioCmd::DlnaBoundPause {
                target: target.clone(), original, session_id: connection.id,
                generation: connection.generation.load(Ordering::Acquire), paused,
            })
                .map_err(|_| BoundSeekFailure { message: "audio actor exited", source_intact: true })?;
            return Ok(stamp);
        }
        if !owner.commit_pause(&original, paused) {
            return Err(BoundSeekFailure { message: "original source superseded", source_intact: true });
        }
        Ok(original.stamp().clone())
    }

    fn commit_source_speed(&self, target: &PlayTarget, speed: f32)
        -> Result<SourceSpeedAuthority, super::render_control::BoundSeekFailure>
    {
        use super::render_control::BoundSeekFailure;
        if self.dlna.selected().is_some() {
            return Err(BoundSeekFailure { message: "DLNA does not support playback speed", source_intact: true });
        }
        if !speed.is_finite() || !(SPEED_MIN..=SPEED_MAX).contains(&speed) {
            return Err(BoundSeekFailure { message: "invalid source speed", source_intact: true });
        }
        let original = self.source_mount(target).ok_or(BoundSeekFailure {
            message: "original source not mounted", source_intact: true,
        })?;
        let owner = SourceControlOwner { core: self.core.clone(), mounts: Arc::downgrade(&self.source_mounts) };
        let revision = owner.commit_speed(&original, speed, &self.speed_revision)
            .ok_or(BoundSeekFailure { message: "original source superseded or speed revision exhausted", source_intact: true })?;
        Ok(SourceSpeedAuthority::new(owner, original, self.speed_revision.clone(), revision, speed))
    }

    /// Runtime primitive: no shared Player or persistence work for a bound target.
    pub fn set_source_speed(&self, target: &PlayTarget, speed: f32)
        -> Result<super::render_control::MountStamp, super::render_control::BoundSeekFailure>
    {
        self.commit_source_speed(target, speed).map(|authority| authority.stamp().clone())
    }

    /// Commit once, then queue the exact captured authority outside Gate/State/Mounts.
    pub fn begin_source_speed_setting(&self, target: &PlayTarget, speed: f32)
        -> Result<SpeedSettingPending, String>
    {
        let authority = self.commit_source_speed(target, speed).map_err(|error| error.to_string())?;
        let (setting, pending) = SourceSpeedSetting::new(authority);
        self.tx.send(AudioCmd::SourceSpeedSetting(Box::new(setting)))
            .map_err(|_| String::from("audio actor exited before source speed persistence"))?;
        Ok(pending)
    }

    pub fn begin_source_seek(&self, target: &PlayTarget, position_ms: u64)
        -> Result<super::render_control::BoundSeekPending, super::render_control::BoundSeekFailure>
    {
        use super::render_control::{BoundSeekFailure, BoundSeekRequest};
        let binding = self.core.with_target(target, |_| {
            let mounts = self.source_mounts.lock().unwrap_or_else(|e| e.into_inner());
            mounts.current.as_ref().filter(|port| port.stamp().target == *target && port.is_live())
                .or_else(|| mounts.reserved.as_ref().filter(|port| port.stamp().target == *target && port.is_live()))
                .map(|port| (port.clone(), port.speed()))
        }).flatten().ok_or(BoundSeekFailure { message: "original source not mounted", source_intact: true })?;
        let (port, speed) = binding;
        let (request, pending) = BoundSeekRequest::new(port.stamp().clone(), port, position_ms, speed)?;
        if let Some(connection) = self.dlna.selected() {
            self.tx.send(AudioCmd::DlnaBoundSeek {
                request, session_id: connection.id, generation: connection.generation.load(Ordering::Acquire),
            })
                .map_err(|_| BoundSeekFailure { message: "audio actor exited", source_intact: true })?;
            return Ok(pending);
        }
        let sender = self.render_seek.lock().unwrap_or_else(|e| e.into_inner()).clone()
            .ok_or(BoundSeekFailure { message: "render output unavailable", source_intact: true })?;
        if let Err(error) = sender.try_submit(request) { error.reply_outside_gate(); }
        Ok(pending)
    }

    /// Construct the production track-local DSP and outer ownership guard.
    pub fn bind_source(&self, port: Arc<super::render_control::SourceSeekPort>,
        decoder: Box<dyn Source + Send>, start_ms: u64, fx: Arc<AudioFx>,
        epoch: Instant, spectrum: Option<crate::audio::SpectrumTap>) -> Box<dyn Source + Send>
    {
        let source = DspSource::new(port.tracked_source(decoder, start_ms), fx, epoch, spectrum);
        let source = port.rate_source(Box::new(source));
        Box::new(super::render_control::SeekTargetGuard::new(source, port))
    }

    /// Metadata publish rechecks the original completed physical incarnation.
    pub fn publish_source_state(&self, original: &Arc<super::render_control::SourceSeekPort>,
        prepared: PlaybackStateSnapshot) -> bool
    {
        let mut prepared = Some(prepared);
        let retired = self.core.with_target(&original.stamp().target, |state| {
            let mounts = self.source_mounts.lock().unwrap_or_else(|e| e.into_inner());
            if !original.is_live() || !mounts.current.as_ref()
                .is_some_and(|port| Arc::ptr_eq(port, original))
            { return None; }
            let mut prepared = prepared.take().expect("one original metadata commit");
            prepared.position_ms = original.position_ms();
            if let Some(paused) = original.pause_override() {
                prepared.status = if paused { PlaybackStatus::Paused } else { PlaybackStatus::Playing };
            }
            prepared.volume = state.volume;
            prepared.muted = state.muted;
            prepared.speed = state.speed;
            prepared.play_mode = state.play_mode;
            std::mem::swap(&mut prepared.quality, &mut state.quality);
            prepared.queue_index = state.queue_index;
            prepared.queue_len = state.queue_len;
            prepared.sleep_timer_ms = state.sleep_timer_ms;
            prepared.sleep_after_track = state.sleep_after_track;
            std::mem::swap(&mut prepared.output_device, &mut state.output_device);
            std::mem::swap(&mut prepared.track, &mut state.track);
            std::mem::swap(&mut prepared.track_id, &mut state.track_id);
            std::mem::swap(&mut prepared.source_id, &mut state.source_id);
            Some(std::mem::replace(state, prepared))
        }).flatten();
        let published = retired.is_some();
        drop(retired);
        published
    }

    /// `Some` is an immutable caller-owned ticket; only a native `None` begins work.
    pub fn send_queue(
        &self,
        tracks: Vec<Track>,
        index: usize,
        play_intent: Option<u64>,
    ) -> tokio::sync::oneshot::Receiver<QueueCommitReply> {
        let play_intent = play_intent.unwrap_or_else(|| self.begin_play_intent());
        let (reply, receipt) = tokio::sync::oneshot::channel();
        let _ = self.tx.send(AudioCmd::QueuedSetQueue { tracks, index, play_intent, reply });
        receipt
    }

    pub fn send_play_at(
        &self,
        index: usize,
        play_intent: Option<u64>,
    ) -> tokio::sync::oneshot::Receiver<QueueCommitReply> {
        let play_intent = play_intent.unwrap_or_else(|| self.begin_play_intent());
        let (reply, receipt) = tokio::sync::oneshot::channel();
        let _ = self.tx.send(AudioCmd::QueuedPlayAt { index, play_intent, reply });
        receipt
    }

    /// The production index-play IPC boundary shares original-ticket cleanup and ACK rules.
    pub async fn play_at_with_receipt(
        &self,
        index: usize,
        play_intent: Option<u64>,
    ) -> Result<QueueCommitReply, String> {
        let play_intent = play_intent.unwrap_or_else(|| self.begin_play_intent());
        let _pending = PendingQueueIntent { gate: self.core.gate().clone(), generation: play_intent };
        let receipt = self.send_play_at(index, Some(play_intent)).await
            .map_err(|_| "播放引擎未返回索引提交回执".to_string())?;
        Ok(self.core.gate().with_accepted(play_intent, || receipt)
            .unwrap_or_else(QueueCommitReply::rejected))
    }

    pub fn send_next(
        &self,
        play_intent: Option<u64>,
    ) -> tokio::sync::oneshot::Receiver<QueueCommitReply> {
        let play_intent = play_intent.unwrap_or_else(|| self.begin_play_intent());
        let (reply, receipt) = tokio::sync::oneshot::channel();
        let _ = self.tx.send(AudioCmd::QueuedNext { play_intent, reply });
        receipt
    }

    /// Native `None`, including the lyrics window, declares ownership before queue preparation.
    pub async fn next_with_receipt(
        &self,
        play_intent: Option<u64>,
    ) -> Result<QueueCommitReply, String> {
        let play_intent = play_intent.unwrap_or_else(|| self.begin_play_intent());
        let _pending = PendingQueueIntent { gate: self.core.gate().clone(), generation: play_intent };
        let receipt = self.send_next(Some(play_intent)).await
            .map_err(|_| String::from("播放引擎未返回下一首提交回执"))?;
        Ok(self.core.gate().with_accepted(play_intent, || receipt)
            .unwrap_or_else(QueueCommitReply::rejected))
    }

    /// The production queue IPC boundary; the adapter only supplies DB filtering.
    pub async fn queue_after_filter<F, Fut>(
        &self,
        tracks: Vec<Track>,
        index: usize,
        play_intent: Option<u64>,
        filter: F,
    ) -> Result<QueueCommitReply, String>
    where
        F: FnOnce(Vec<Track>, usize) -> Fut,
        Fut: std::future::Future<Output = Result<(Vec<Track>, usize), String>>,
    {
        if tracks.is_empty() {
            return Err("队列为空".into());
        }
        let play_intent = play_intent.unwrap_or_else(|| self.begin_play_intent());
        let _pending = PendingQueueIntent { gate: self.core.gate().clone(), generation: play_intent };
        let (tracks, index) = filter(tracks, index).await?;
        if tracks.is_empty() {
            return Err("队列为空".into());
        }
        let receipt = self.send_queue(tracks, index, Some(play_intent)).await
            .map_err(|_| "播放引擎未返回队列提交回执".to_string())?;
        Ok(self.core.gate().with_accepted(play_intent, || receipt)
            .unwrap_or_else(QueueCommitReply::rejected))
    }

    pub fn send_previous(
        &self, play_intent: Option<u64>,
    ) -> tokio::sync::oneshot::Receiver<QueueCommitReply> {
        let play_intent = play_intent.unwrap_or_else(|| self.begin_play_intent());
        let (reply, receipt) = tokio::sync::oneshot::channel();
        let _ = self.tx.send(AudioCmd::QueuedPrevious { play_intent, reply });
        receipt
    }

    pub async fn previous_with_receipt(
        &self, play_intent: Option<u64>,
    ) -> Result<QueueCommitReply, String> {
        let play_intent = play_intent.unwrap_or_else(|| self.begin_play_intent());
        let _pending = PendingQueueIntent {
            gate: self.core.gate().clone(), generation: play_intent,
        };
        let receipt = self.send_previous(Some(play_intent)).await
            .map_err(|_| "播放引擎未返回上一首提交回执".to_string())?;
        Ok(self.core.gate().with_accepted(play_intent, || receipt)
            .unwrap_or_else(QueueCommitReply::rejected))
    }

    pub fn send_play_track(
        &self, track: Track, play_intent: Option<u64>,
    ) -> tokio::sync::oneshot::Receiver<QueueCommitReply> {
        let play_intent = play_intent.unwrap_or_else(|| self.begin_play_intent());
        let (reply, receipt) = tokio::sync::oneshot::channel();
        let _ = self.tx.send(AudioCmd::QueuedPlayTrack {
            track: Box::new(track), play_intent, reply,
        });
        receipt
    }

    /// Captures startup eligibility before calling any storage/async loader.
    pub async fn restore_after_load<F, Fut>(
        &self, loader: F,
    ) -> Result<Option<PlaybackStateSnapshot>, String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<Option<super::playback_commit::RestoredPlayback>, String>>,
    {
        let current = self.snapshot();
        if current.track_id.is_some() {
            return Ok(Some(current));
        }
        let Some(stamp) = self.core.capture_restore() else { return Ok(None); };
        let Some(session) = loader().await? else { return Ok(None); };
        if session.tracks.is_empty() { return Ok(None); }
        let (reply, received) = tokio::sync::oneshot::channel();
        self.tx.send(AudioCmd::StampedRestore { stamp, session, reply })
            .map_err(|_| "audio engine 已退出，恢复请求未送达".to_string())?;
        let receipt = tokio::time::timeout(Duration::from_secs(5), received).await
            .map_err(|_| "等待原恢复回执超时".to_string())?
            .map_err(|_| "audio engine 未返回原恢复回执".to_string())?;
        Ok(receipt.and_then(|(target, snapshot)|
            self.core.gate().with_accepted(target.generation, || snapshot)))
    }

    pub async fn play_track_with_receipt(
        &self, track: Track, play_intent: Option<u64>,
    ) -> Result<QueueCommitReply, String> {
        let play_intent = play_intent.unwrap_or_else(|| self.begin_play_intent());
        let _pending = PendingQueueIntent {
            gate: self.core.gate().clone(), generation: play_intent,
        };
        let receipt = self.send_play_track(track, Some(play_intent)).await
            .map_err(|_| String::from("播放引擎未返回单曲提交回执"))?;
        Ok(self.core.gate().with_accepted(play_intent, || receipt)
            .unwrap_or_else(QueueCommitReply::rejected))
    }

    /// 启动专属音频线程。url_cache 供自动切歌时异步取址；
    /// db 供队列/播放状态持久化（None = 数据库不可用，播放不受影响）。
    pub fn spawn(
        app: tauri::AppHandle,
        cache_dir: PathBuf,
        url_cache: Arc<PlayUrlCache>,
        db: Option<Arc<Database>>,
    ) -> Self {
        let (engine, rx) = Self::command_channel();
        let tx = engine.tx.clone();
        let state_clone = Arc::clone(&engine.state);
        let queue = Arc::clone(&engine.queue);
        let fx = Arc::clone(&engine.fx);
        let cache_file = Arc::clone(&engine.cache_file);
        // 注册音频线程 panic 上报通道（先于线程启动；重复启动时以第一次为准）
        let _ = AUDIO_THREAD_PANIC_TX.set(tx.clone());

        let tx_thread = tx.clone();
        let queue_thread = Arc::clone(&queue);
        let fx_thread = Arc::clone(&fx);
        let cache_file_thread = Arc::clone(&cache_file);
        let owner_thread = engine.clone();
        let _ = std::thread::Builder::new()
            .name("audio-engine".into())
            .spawn(move || {
                // 引擎是裸循环线程，任一命令处理里 panic 会把整条线程带走，
                // 表现为「播放静默死掉、命令发不进去」。catch_unwind 兜底：
                // panic 细节由 panic 钩子落日志（file_logger），线程退出但进程
                // 还活着，send() 侧能感知并报错，前端不至于无提示闪退。
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                    run_engine(EngineDeps {
                        owner: owner_thread,
                        app,
                        rx,
                        state: state_clone,
                        cache_dir,
                        url_cache,
                        tx: tx_thread,
                        queue: queue_thread,
                        fx: fx_thread,
                        cache_file: cache_file_thread,
                        db,
                    });
                }));
                if let Err(payload) = result {
                    let msg = payload
                        .downcast_ref::<&str>()
                        .copied()
                        .or_else(|| payload.downcast_ref::<String>().map(|s| s.as_str()))
                        .unwrap_or("未知 panic 载荷");
                    log::error!("[audio] 音频线程 panic 退出: {msg}");
                }
            });

        engine
    }

    /// Explicit unbound transport resume updates source controls at the sender.
    /// State -> Mounts is a suffix of the qualification lock order; no gate is acquired here.
    fn resume_source_transport(&self) {
        let mut state = self.state.write().unwrap_or_else(|e| e.into_inner());
        let mounts = self.source_mounts.lock().unwrap_or_else(|e| e.into_inner());
        for original in mounts.current.iter().chain(mounts.reserved.iter()) {
            if !original.is_live() { continue; }
            original.set_paused(false);
            if state.status == PlaybackStatus::Paused
                && state.track_id.as_deref() == Some(original.stamp().target.id.as_str())
                && state.source_id.as_ref().map(|source| source.as_str()) == Some(original.stamp().target.platform.as_str())
            {
                if original.is_ready() { state.position_ms = original.position_ms(); }
                state.status = if original.is_ready() { PlaybackStatus::Playing } else { PlaybackStatus::Loading };
            }
        }
    }

    /// Explicit Native transport speed is unbound and may control both live sources.
    /// It takes only State -> Mounts, never source authority from a later snapshot.
    fn set_source_transport_speed(&self, speed: f32) -> Option<u64> {
        let mut state = self.state.write().unwrap_or_else(|e| e.into_inner());
        let mounts = self.source_mounts.lock().unwrap_or_else(|e| e.into_inner());
        let revision = self.speed_revision.load(Ordering::Acquire).checked_add(1)?;
        state.speed = speed;
        for original in mounts.current.iter().chain(mounts.reserved.iter()) {
            if original.is_live() { original.set_speed(speed); }
        }
        self.speed_revision.store(revision, Ordering::Release);
        Some(revision)
    }

    pub fn send(&self, cmd: AudioCmd) {
        if self.dlna.selected().is_some() && matches!(&cmd, AudioCmd::SetSpeed(_)) {
            let _ = self.tx.send(cmd);
            return;
        }
        let cmd = match cmd {
            AudioCmd::SetSpeed(speed) => {
                if !speed.is_finite() { return; }
                let speed = speed.clamp(SPEED_MIN, SPEED_MAX);
                let Some(revision) = self.set_source_transport_speed(speed) else { return; };
                // Value and revision come from this commit, never a later State read.
                AudioCmd::NativeSpeedSetting(Box::new(NativeSpeedSetting::new(
                    self.state.clone(), self.speed_revision.clone(), revision, speed)))
            }
            cmd => cmd,
        };
        match cmd {
            AudioCmd::SetQueue { tracks, index } => {
                // Legacy native entries still begin a ticket at the sender, never at receive.
                let _receipt = self.send_queue(tracks, index, None);
            }
            AudioCmd::PlayAt(index) => { let _receipt = self.send_play_at(index, None); }
            AudioCmd::Next => { let _receipt = self.send_next(None); }
            AudioCmd::Previous => { let _receipt = self.send_previous(None); }
            AudioCmd::PlayTrack(track) => { let _receipt = self.send_play_track(*track, None); }
            cmd => {
                if matches!(&cmd, AudioCmd::Play) && self.dlna.selected().is_none() { self.resume_source_transport(); }
                if self.tx.send(cmd).is_err() {
                    log::error!("audio engine 已退出，命令丢弃");
                }
            }
        }
    }

    pub fn set_gapless(&self, enabled: bool) {
        self.send(AudioCmd::SetGapless(enabled));
    }

    pub fn snapshot(&self) -> PlaybackStateSnapshot {
        self.state.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// 队列快照（cmd_get_queue 用；引擎线程是唯一写者）
    pub fn queue_snapshot(&self) -> Queue {
        self.queue.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// 注入系统媒体控制句柄（Windows SMTC；不可用时传 None）。
    pub fn set_smtc(&self, handle: Option<crate::smtc::SmtcHandle>) {
        self.send(AudioCmd::SetSmtc(handle));
    }

    /// 当前音效设置快照（cmd_get_fx_state；设置页回读）。
    pub fn fx_state(&self) -> FxState {
        self.fx.state()
    }

    /// 正在播放的流对应的磁盘缓存文件（没有在线流 = None）。
    pub fn current_cache_file(&self) -> Option<PathBuf> {
        self.cache_file.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

struct PreloadSlot {
    gen: u64,
    index: usize,
    track: Track,
    ready: Option<PreparedTrack>,
    original_track: Track,
    original_progress: Arc<SourceProgress>,
    original_target: Option<PlayTarget>,
    original_queue_track: Option<Track>,
    original_queue_cursor: (Option<usize>, Option<usize>, Option<usize>),
    original_mount: Option<Arc<super::render_control::SourceSeekPort>>,
    original_stamp: Option<super::render_control::MountStamp>,
    original_load_gen: u64,
}

/// The actor's single speculative-load state; its actual slot remains opaque.
#[derive(Default)]
pub struct PreloadState {
    gen: u64,
    /// 本曲内已用掉的预载失败重试次数（换曲/切歌边界归零，见 PRELOAD_RETRY_LIMIT）
    retries: u32,
    slot: Option<PreloadSlot>,
}

impl PreloadState {
    pub fn prepared_progress(&self) -> Option<&Arc<SourceProgress>> {
        self.slot.as_ref().and_then(|slot| slot.ready.as_ref()).map(|ready| &ready.progress)
    }
    pub fn original_mount(&self) -> Option<&Arc<super::render_control::SourceSeekPort>> {
        self.slot.as_ref().and_then(|slot| slot.original_mount.as_ref())
    }
    pub fn original_stamp(&self) -> Option<&super::render_control::MountStamp> {
        self.slot.as_ref().and_then(|slot| slot.original_stamp.as_ref())
    }
    pub fn original_load_gen(&self) -> Option<u64> {
        self.slot.as_ref().map(|slot| slot.original_load_gen)
    }

    /// Take only the actual slot whose original render receipt has started.
    pub fn take_started(&mut self) -> Option<StartedPreload> {
        let started = self.slot.as_ref().and_then(|slot| slot.ready.as_ref())
            .is_some_and(|ready| ready.progress.first_some());
        if !started { return None; }
        Some(StartedPreload {
            slot: self.slot.take().unwrap(),
        })
    }
}

/// Raw actor policy flags; mounted/playing/slot/retry facts stay derived.
#[derive(Debug, Clone, Copy)]
pub struct PreloadFlags {
    pub gapless: bool,
    pub sleep_after_track: bool,
    pub auto_next: bool,
}

/// Borrow the existing quality policy; selected Quality is cloned, not Copy.
pub struct PreloadQuality<'a> {
    pub default_quality: &'a Quality,
    pub track_quality: &'a Option<(String, Quality)>,
    pub source_qualities: &'a HashMap<String, Quality>,
}

impl PreloadQuality<'_> {
    fn effective_for(&self, track: &Track) -> Quality {
        if let Some((id, q)) = self.track_quality {
            if *id == track.id {
                return q.clone();
            }
        }
        if let Some(q) = self.source_qualities.get(track.platform.as_str()) {
            return q.clone();
        }
        self.default_quality.clone()
    }
}

/// Original actor inputs, not a lookup of a later physical source.
pub struct PreloadPrepare<'a> {
    pub flags: PreloadFlags,
    pub pausing: bool,
    pub current_progress: Option<&'a Arc<SourceProgress>>,
    pub current_mount: Option<&'a Arc<super::render_control::SourceSeekPort>>,
    pub target: Option<&'a PlayTarget>,
    pub load_gen: u64,
    pub quality: PreloadQuality<'a>,
}

pub struct PreloadRequest {
    pub request: SourceLoadRequest,
    pub quality: Quality,
}

impl PreloadRequest {
    /// Run the actual local preload decoder/receipt using an owned path.
    /// Call on the loader worker, never under Gate or on the audio actor.
    pub fn dispatch_local(self, owner: &AudioEngine, path: PathBuf) -> Result<(), String> {
        let size_bytes = std::fs::metadata(&path).ok().map(|m| m.len());
        match build_local_decoder(&path, &self.request.track) {
            Ok(built) => {
                let _ = owner.tx.send(self.request.ready_command(true, built, true, None, None, size_bytes));
                Ok(())
            }
            Err(detail) => {
                let message = load_failure_message(&detail, false);
                log::debug!("[gapless] speculative load failed for {}: {message}", self.request.track.id);
                let _ = owner.tx.send(AudioCmd::PreloadFailed { gen: self.request.gen });
                Err(detail)
            }
        }
    }
}

struct PreparedTrack {
    progress: Arc<SourceProgress>,
    binding: Arc<super::render_control::PreloadBinding>,
    shared: Option<Arc<RangeShared>>,
    duration_ms: u64,
    is_local: bool,
    url_fetched_at: Option<u64>,
    play_url: Option<String>,
    bitrate_kbps: Option<u32>,
}

/// Actual started slot, obtainable only through the original progress receipt.
pub struct StartedPreload {
    slot: PreloadSlot,
}

impl StartedPreload {
    fn ready(&self) -> &PreparedTrack {
        self.slot.ready.as_ref().expect("a started preload has its prepared receipt")
    }

    pub fn track(&self) -> &Track { &self.slot.track }
    pub fn progress(&self) -> &Arc<SourceProgress> { &self.ready().progress }
    pub fn duration_ms(&self) -> u64 { self.ready().duration_ms }
    pub fn shared(&self) -> Option<&Arc<RangeShared>> {
        self.ready().shared.as_ref()
    }
    pub fn is_local(&self) -> bool { self.ready().is_local }
    pub fn url_fetched_at(&self) -> Option<u64> { self.ready().url_fetched_at }
    pub fn play_url(&self) -> Option<&str> { self.ready().play_url.as_deref() }
    pub fn bitrate_kbps(&self) -> Option<u32> { self.ready().bitrate_kbps }
    pub fn original_mount(&self) -> Option<&Arc<super::render_control::SourceSeekPort>> {
        self.slot.original_mount.as_ref()
    }
    pub fn original_stamp(&self) -> Option<&super::render_control::MountStamp> {
        self.slot.original_stamp.as_ref()
    }
    pub fn original_load_gen(&self) -> u64 { self.slot.original_load_gen }
}

struct PreloadMount {
    port: Arc<super::render_control::SourceSeekPort>,
    stamp: super::render_control::MountStamp,
}

/// Consuming physical admission; never rebuilt from a later snapshot.
pub struct AdmittedPreload {
    started: StartedPreload,
    mount: Option<PreloadMount>,
    accepted_generation: u64,
    accepted_load_gen: u64,
}

impl AdmittedPreload {
    pub fn started(&self) -> &StartedPreload { &self.started }
    pub fn track(&self) -> &Track { self.started.track() }
    pub fn mount(&self) -> Option<&Arc<super::render_control::SourceSeekPort>> {
        self.mount.as_ref().map(|mount| &mount.port)
    }
    pub fn stamp(&self) -> Option<&super::render_control::MountStamp> {
        self.mount.as_ref().map(|mount| &mount.stamp)
    }
}

/// Current/Queue synchronization consumes the physical admission once.
pub struct PreloadMetadata {
    admitted: AdmittedPreload,
}

impl PreloadMetadata {
    pub fn started(&self) -> &StartedPreload { self.admitted.started() }
    pub fn track(&self) -> &Track { self.admitted.track() }
    pub fn duration_ms(&self) -> u64 { self.started().duration_ms() }
}

/// The same consuming C receipt after its metadata has committed.
pub struct PublishedPreload {
    metadata: PreloadMetadata,
}

impl PublishedPreload {
    pub fn track(&self) -> &Track { self.metadata.track() }
    pub fn duration_ms(&self) -> u64 { self.metadata.duration_ms() }
}

/// Borrow the actual Player and shared DSP parameters; no replacement Player.
pub struct PreloadRender<'a> {
    pub player: &'a Player,
    pub fx: &'a Arc<AudioFx>,
    pub epoch: Instant,
}

/// Borrow disjoint fields of the real actor's current-source/recovery state.
/// No physical mount, target, load clock or authored candidate is supplied here.
pub struct PreloadCurrent<'a> {
    pub current_progress: &'a mut Option<Arc<SourceProgress>>,
    pub current_shared: &'a mut Option<Arc<RangeShared>>,
    pub failed_tracks: &'a mut HashSet<String>,
    pub fail_streak: &'a mut u32,
    pub stall_retry: &'a mut u32,
    pub watch: &'a mut StallWatch,
}

struct EngineInner {
    owner: AudioEngine,
    app: tauri::AppHandle,
    tx: Sender<AudioCmd>,
    state: Arc<RwLock<PlaybackStateSnapshot>>,
    queue: Arc<Mutex<Queue>>,
    cache_dir: PathBuf,
    url_cache: Arc<PlayUrlCache>,
    remote: Option<dlna_adapter::RemotePlayback>,
    route_resume: Option<(u64, u64, bool)>,
    gapless: bool,
    preload: PreloadState,
    current_progress: Option<Arc<SourceProgress>>,
    /// Original physical source installed by mount_decoder, never reconstructed at EOF.
    current_mount: Option<Arc<super::render_control::SourceSeekPort>>,
    eof_queued: bool,
    sink: Player,
    /// 持有输出流（丢掉它会立即关闭音频端点）
    _stream: rodio::MixerDeviceSink,
    /// 用户选择的输出设备：None = 跟随系统默认
    output_choice: Option<String>,
    /// 设置里的默认播放音质（settings["quality"]，启动时恢复；换歌取址用它）
    default_quality: Quality,
    /// 播放条上对「当前这首」的临时音质 (track_id, quality)：按曲目 id 绑定，
    /// 不落 settings，切到别的歌就自动回到 default_quality。
    track_quality: Option<(String, Quality)>,
    /// 各平台的独立播放音质（音源账号页按平台设置）：前端启动/变更时全量推送的
    /// 运行时副本，不落 settings——持久化在前端设置库里，引擎重启后由前端重灌。
    /// 查找顺序见 effective_quality_for：本曲临时 → 平台独立 → 全局默认。
    source_qualities: HashMap<String, Quality>,
    /// 当前实际挂接的输出设备名（快照里展示用）
    current_device: String,
    current_shared: Option<Arc<RangeShared>>,
    volume_before_mute: f32,
    tick_anchor: Option<std::time::Instant>,
    /// 本轮队列里已经播放失败过的曲目（自动跳过用；换队列时清空）。
    /// 有它才能保证「队列全挂」时不会无限互相跳过。
    failed_tracks: HashSet<String>,
    /// 自动下一首标识：播放失败且为 true 时自动跳下一首（skip_if_recoverable）。
    /// 连续失败 FAIL_STREAK_LIMIT 首自动关闭（熔断，防止死歌队列无限空转）并通知；
    /// 任一成功播放或用户手动发起播放（SetQueue/PlayAt/Play）时重新打开。
    auto_next: bool,
    /// 连续播放失败计数（成功挂载播放或手动播放时清零）
    fail_streak: u32,
    /// 弱网（取链等待超时）连续重试同一首的次数（成功播放 / 换歌 / 手动播放时清零）。
    /// 与 `fail_streak` 分开：前者是「网络还没好，再等等」，后者是「歌有问题，换下一首」。
    stall_retry: u32,
    /// 系统媒体控制（SMTC）句柄；None = 不可用（非 Windows / 初始化失败）
    smtc: Option<crate::smtc::SmtcHandle>,
    /// 加载代次：每次发起新的「取址+构建解码器」链就 +1。LoadReady /
    /// LoadFailed 回执带的代次与当前不一致 → 等待期间用户又切了歌，丢弃。
    /// 没有它，连点切歌后旧歌的加载结果会把新歌顶掉。
    load_gen: u64,
    /// Original accepted owner; never reconstructed from the latest Gate at load completion.
    play_target: Option<PlayTarget>,
    play_mount: Option<Arc<super::render_control::SourceSeekPort>>,
    /// 上次把 position 持久化到 settings 的时刻（5s 节流）
    last_persist: Option<std::time::Instant>,
    /// 引擎启动时刻，monotonicMs 以此为原点（DESIGN §7.11）
    epoch: std::time::Instant,
    db: Option<Arc<Database>>,
    /// 音效设置：命令线程改、渲染线程（DspSource）读
    fx: Arc<AudioFx>,
    /// 播放倍速（内容时间域换算系数；rodio 侧由 Player::set_speed 生效）
    speed: f32,
    /// 淡出暂停到期时刻：Pause 命令在淡出开启时不立即暂停，
    /// 而是先让 DspSource 把增益拉到 0，到点这里真正 pause。
    pause_deadline: Option<std::time::Instant>,
    /// 睡眠定时到期时刻（与 sleep_after_track 二选一或并存）
    sleep_deadline: Option<std::time::Instant>,
    /// 「播完当前曲目后停止」武装旗标（advance(auto) 时消费）
    sleep_after_track: bool,
    /// 正在播放的流对应的磁盘缓存文件（命令线程经 AudioEngine 句柄读）
    cache_file: Arc<Mutex<Option<PathBuf>>>,
    /// 播放缓存体积上限（MB，0 = 不限；启动从 settings 恢复，SetCacheLimit 改）
    cache_limit_mb: u64,
    /// 位置冻结看门狗：回调线程死了 / 解码卡住时唯一的破裂信号（见 StallWatch）
    watch: StallWatch,
    /// 不喜欢列表的内存镜像（`db::store::DislikeMatcher`）。
    ///
    /// **为什么是内存镜像而不是每次现查库**：`advance` 在播放线程里跑，
    /// 每次自然播完切歌都 `db.with()` 会引入 SQLite 锁竞争 —— 而这条路径是
    /// 「每首歌播完都要走一次」的热路径。规则改动由 `ReloadDislikes` 命令推过来，
    /// 改的又是几十条的小表，成本可以忽略。库不可用时保持空集：**宁可多放一首，
    /// 也不能把自动切歌弄坏**。
    dislikes: crate::db::store::DislikeMatcher,
    /// 当前这次收听的会话（挂载成功时开始，切歌 / 停止 / 播完时结算落库）。
    /// 听歌统计的「次数 / 时长 / 完播」全部由它记账，见 [`ListenSession`]。
    listen: super::listening::ListenLifecycle,
}

impl EngineInner {
    fn publish(&self) {
        let snap = self.state.read().unwrap_or_else(|e| e.into_inner()).clone();
        self.publish_snapshot(&snap);
    }

    fn publish_snapshot(&self, snap: &PlaybackStateSnapshot) {
        let _ = self.app.emit("playback-state-changed", snap);
        // 顺带把当前曲目 / 播放状态投到系统媒体面板（Windows SMTC）
        crate::smtc::sync(&self.smtc, snap);
        // 任务栏缩略图工具栏的播放/暂停按钮图标跟着翻转
        crate::taskbar::sync(snap.status == PlaybackStatus::Playing);
    }

    fn mutate(&self, f: impl FnOnce(&mut PlaybackStateSnapshot)) {
        {
            let mut st = self.state.write().unwrap_or_else(|e| e.into_inner());
            f(&mut st);
        }
        self.publish();
    }

    fn effective_volume(&self) -> f32 {
        let st = self.state.read().unwrap_or_else(|e| e.into_inner());
        if st.muted {
            0.0
        } else {
            st.volume.clamp(0.0, 1.0)
        }
    }

    /// 从库里重装不喜欢列表的内存镜像。
    ///
    /// 失败时保留旧集合（而不是清空）：一次偶发的 SQLite 忙不该让刚屏蔽的歌
    /// 立刻又冒出来。
    fn reload_dislikes(&mut self) {
        if let Some(db) = &self.db {
            match db.with(crate::db::store::DislikeMatcher::load) {
                Ok(set) => {
                    let n = set.len();
                    self.dislikes = set;
                    log::info!("[dislike] 已装载 {n} 条屏蔽规则");
                }
                Err(e) => log::warn!("[dislike] 装载不喜欢列表失败，保留旧集合: {e}"),
            }
        }
    }

    fn queue_emit(&self) {
        // 锁内只取数据，emit（含整队列序列化）放在锁外：大队列时 json 序列化
        // 可能毫秒级，别拉长临界区（引擎线程与命令线程都会调本函数）
        let (tracks, index) = {
            let q = self.queue.lock().unwrap_or_else(|e| e.into_inner());
            (q.tracks.clone(), q.index)
        };
        let _ = self.app.emit(
            "queue-changed",
            serde_json::json!({
                "tracks": tracks,
                "index": index.map(|i| i as u32),
            }),
        );
    }

    fn sync_queue_to_snapshot(&self) {
        let q = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        let mut st = self.state.write().unwrap_or_else(|e| e.into_inner());
        st.queue_index = q.index;
        st.queue_len = q.len();
    }

    /// 在指定设备上重建输出流 + Sink。`None` = 跟随系统默认设备。
    ///
    /// 重建后当前曲目从原进度无缝续播：重走 load 链路（resolve 走 10 分钟
    /// URL 缓存，几乎瞬时），音量/播放态一并迁移。失败时保留旧流不动 ——
    /// 切设备失败不该让播放中断。
    ///
    /// 用于「用户主动切设备」「看门狗重建」「掉设备后兜底」三条路径；按重建前
    /// 的播放态续播，所以掉设备那条必须**先** `finish_pause`（见 pause_for_device_loss）。
    fn rebuild_output(&mut self, choice: Option<&str>) -> Result<(), String> {
        invalidate_preload(self);
        // 重建出来的流同样要挂错误回调：否则「看门狗重建过的流」又变成哑巴
        let new_stream = match choice {
            Some(name) => {
                let device = cpal::default_host()
                    .output_devices()
                    .map_err(|e| e.to_string())?
                    .find(|d| {
                        d.description()
                            .map(|desc| desc.name() == name)
                            .unwrap_or(false)
                    })
                    .ok_or_else(|| format!("找不到输出设备：{name}"))?;
                rodio::DeviceSinkBuilder::from_device(device)
                    .map_err(|e| e.to_string())?
                    .with_error_callback(stream_error_callback(self.tx.clone()))
                    .open_stream()
                    .map_err(|e| e.to_string())?
            }
            None => open_default_stream(self.tx.clone())?,
        };
        let (new_sink, output) = self.owner.player_channel();
        new_stream.mixer().add(DeviceSource::new(output,
            new_stream.config().channel_count(), new_stream.config().sample_rate()));

        // 迁移前记录当前曲目 / 进度 / 播放态
        let (track, pos_ms, was_playing) = {
            let st = self.state.read().unwrap_or_else(|e| e.into_inner());
            // Playing 时以 sink 实时位置为准（快照 tick 有节流，最多落后 250ms）；
            // 其余状态用快照里的 position_ms —— Loading 期间 sink 里还是**上一首**
            // （新流要等 mount_decoder 才 clear），get_pos() 取到的是上一首的位置，
            // 会把新曲定位到错误的地方；暂停/错误态两者等价，快照更权威。
            let pos = if st.status == PlaybackStatus::Playing {
                content_pos_ms(self)
            } else {
                st.position_ms
            };
            (st.track.clone(), pos, st.status == PlaybackStatus::Playing)
        };

        new_sink.pause();
        // 旧流在新流就绪后才丢弃，切换间隙不出声的时间窗最短
        self._stream = new_stream;
        self.current_device = choice
            .map(|s| s.to_string())
            .or_else(|| {
                cpal::default_host()
                    .default_output_device()
                    .and_then(|d| d.description().ok().map(|desc| desc.name().to_string()))
            })
            .unwrap_or_default();
        self.sink = new_sink;
        self.sink.set_volume(self.effective_volume());
        // Source-bound playback owns its rate; legacy playback restores Player's rate.
        let bound = self.owner.current_source_mount().is_some_and(|port| port.is_live());
        self.sink.set_speed(if bound { 1.0 } else { self.speed });
        self.current_shared = None;
        self.current_progress = None;
        self.tick_anchor = None;

        {
            let mut st = self.state.write().unwrap_or_else(|e| e.into_inner());
            st.output_device = self.current_device.clone();
        }

        if let Some(t) = track {
            // 走完整 load 链路：Loading 状态照常发布，定位到原进度后按原播放态续播
            load_queue_track(self, t, was_playing, pos_ms);
            log::info!(
                "[device] 输出设备切换到「{}」，曲目从 {pos_ms}ms 续播（playing={was_playing}）",
                self.current_device
            );
        } else {
            log::info!(
                "[device] 输出设备切换到「{}」（无播放中的曲目）",
                self.current_device
            );
        }
        Ok(())
    }

    /// 播放状态（index/position/quality/mode/volume/muted）写 settings。
    fn persist_state(&self) {
        let Some(db) = &self.db else { return };
        let st = self.state.read().unwrap_or_else(|e| e.into_inner()).clone();
        let index = self.queue.lock().unwrap_or_else(|e| e.into_inner()).index.unwrap_or(0);
        let s = PlayState {
            index,
            position_ms: st.position_ms,
            quality: quality_key(&self.default_quality),
            play_mode: mode_key(st.play_mode),
            volume: st.volume,
            muted: st.muted,
        };
        if let Err(e) = db.with(|c| store::save_play_state(c, &s)) {
            log::warn!("[db] 播放状态入库失败: {e}");
        }
    }

    /// 队列整表入库（连带 tracks）+ 播放状态。队列语义变化时调用。
    fn persist_queue(&self) {
        let Some(db) = &self.db else { return };
        let tracks: Vec<Track> = self.queue.lock().unwrap_or_else(|e| e.into_inner()).tracks.clone();
        if let Err(e) = db.with(|c| store::save_queue(c, &tracks)) {
            log::warn!("[db] 队列入库失败: {e}");
            return;
        }
        self.persist_state();
    }
}

/// settings 中的 quality 键值：`128` / `320` / `flac` / 音源包声明的任意档位。
///
/// 宿主不再持有档位白名单，所以这里就是透传（serde 表示本身是透明字符串）。
fn quality_key(q: &Quality) -> String {
    q.as_str().to_string()
}

/// `quality_key` 的反操作：settings 里的字符串 → Quality，认不出来返回 None。
/// 与 commands.rs 里恢复播放现场用的是同一套解析口径。
fn parse_quality(s: &str) -> Option<Quality> {
    Quality::parse(s)
}

/// 一首歌的有效请求音质：本曲被播放条单独指定过就用指定的；否则按平台独立
/// 音质（音源账号页，前端启动/变更时经 SetSourceQualities 推送）；都没配再
/// 落到全局默认（settings["quality"] 旧键，兼容升级前的存量设置）。
fn effective_quality_for(inner: &EngineInner, track: &Track) -> Quality {
    PreloadQuality {
        default_quality: &inner.default_quality,
        track_quality: &inner.track_quality,
        source_qualities: &inner.source_qualities,
    }.effective_for(track)
}

/// settings 中的 play_mode 键值：listLoop / oneLoop / random
fn mode_key(m: PlayMode) -> String {
    serde_json::to_string(&m).unwrap().trim_matches('"').into()
}

// ---------- 倍速 / 音效的 settings 键（读写都只在引擎线程） ----------

pub const SETTING_GAPLESS: &str = "playback.gapless";
const SETTING_SPEED: &str = "playback.speed";
const SETTING_FX_EQ: &str = "fx.eq";
const SETTING_FX_LOUDNORM: &str = "fx.loudnorm";
/// ReplayGain 静态增益模式：off / track / album（A1）
const SETTING_FX_REPLAYGAIN: &str = "fx.replaygain";
const SETTING_FX_FADE: &str = "fx.fade";
const SETTING_FX_SPECTRUM: &str = "fx.spectrum";

/// 倍速允许范围（与前端倍速菜单一致：0.75~2.0，夹紧留点余量）。
const SPEED_MIN: f32 = 0.5;
const SPEED_MAX: f32 = 2.0;

/// 引擎启动时刻以来的单调毫秒（DspSource 的淡入淡出基准与它同源）。
fn epoch_ms(inner: &EngineInner) -> u64 {
    inner.epoch.elapsed().as_millis() as u64
}

/// Track-relative content position, measured at the decoder before Player's
/// speed control. A queued successor has a separate receipt, so concatenation
/// never carries the previous track's position into its snapshot.
fn content_pos_ms(inner: &EngineInner) -> u64 {
    inner.current_progress.as_ref().map_or_else(
        || inner.sink.get_pos().mul_f32(inner.speed).as_millis() as u64,
        |progress| progress.position_ms(),
    )
}

/// Source-bound decoders seek in original content time. Only legacy Player
/// speed still multiplies seek offsets and requires division here.
fn sink_seek_content(inner: &EngineInner, pos_ms: u64) -> Result<(), rodio::source::SeekError> {
    let bound = inner.owner.current_source_mount().is_some_and(|port| port.is_live());
    let factor = if bound { 1.0 } else { inner.speed };
    inner.sink.try_seek(Duration::from_millis(pos_ms).div_f32(factor))
}

/// 真正执行暂停（淡出到期 / 无淡出的 Pause 共用）。
fn finish_pause(inner: &mut EngineInner) {
    if inner.remote.is_some() {
        let _ = dlna_adapter::route(inner, AudioCmd::Pause);
        return;
    }
    invalidate_preload(inner);
    // 暂停是天然的落库时机：先把这段收听结算掉（会话不结束，继续播还能接着记）
    inner.settle_listen(false, false);
    inner.sink.pause();
    let pos = content_pos_ms(inner);
    inner.mutate(|st| {
        if st.status == PlaybackStatus::Playing {
            st.status = PlaybackStatus::Paused;
            st.position_ms = pos;
        }
    });
    inner.persist_state();
}

/// 睡眠定时到期：暂停播放、清掉快照里的定时状态并发事件（前端提示）。
fn fire_sleep_timer(inner: &mut EngineInner) {
    log::info!("[sleep] 睡眠定时到点，停止播放");
    if inner.state.read().unwrap_or_else(|e| e.into_inner()).status == PlaybackStatus::Playing {
        finish_pause(inner);
    }
    inner.mutate(|st| {
        st.sleep_timer_ms = None;
        st.sleep_after_track = false;
    });
    let _ = inner.app.emit("sleep-timer-fired", ());
}

/// 音频线程初始化依赖（OutputStream 仍在线程内创建）
struct EngineDeps {
    owner: AudioEngine,
    app: tauri::AppHandle,
    rx: AudioCommandInbox,
    state: Arc<RwLock<PlaybackStateSnapshot>>,
    cache_dir: PathBuf,
    url_cache: Arc<PlayUrlCache>,
    tx: Sender<AudioCmd>,
    queue: Arc<Mutex<Queue>>,
    fx: Arc<AudioFx>,
    cache_file: Arc<Mutex<Option<PathBuf>>>,
    db: Option<Arc<Database>>,
}

/// 输出流错误回调：转成引擎命令。
///
/// rodio 的默认回调只 `eprintln!`（`stream.rs::default_error_callback`），应用侧
/// 对「输出流坏死」一无所知 —— 这正是播放静默卡死能瞒过所有监控的原因。
/// 回调里**不写日志**（可能跑在音频实时线程上），只投一条 channel 消息。
fn stream_error_callback(tx: Sender<AudioCmd>) -> impl FnMut(cpal::StreamError) + Send + 'static {
    move |e| {
        let _ = tx.send(AudioCmd::StreamError {
            message: e.to_string(),
            fatal: false,
        });
    }
}

/// 打开默认输出流：首选「默认设备 + 错误回调」，失败再回落到 rodio 的设备枚举兜底
/// （兜底路径用的是 rodio 默认错误回调，只打 stderr —— 但「能出声」优先于「能上报」）。
fn open_default_stream(tx: Sender<AudioCmd>) -> Result<rodio::MixerDeviceSink, String> {
    match rodio::DeviceSinkBuilder::from_default_device()
        .map_err(|e| e.to_string())
        .and_then(|b| {
            b.with_error_callback(stream_error_callback(tx))
                .open_stream()
                .map_err(|e| e.to_string())
        }) {
        Ok(s) => Ok(s),
        Err(e) => {
            log::warn!("[device] 默认设备直开失败（{e}），回落到设备枚举兜底");
            rodio::DeviceSinkBuilder::open_default_sink().map_err(|e| e.to_string())
        }
    }
}

fn run_engine(deps: EngineDeps) {
    let EngineDeps {
        owner,
        app,
        rx,
        state,
        cache_dir,
        url_cache,
        tx,
        queue,
        fx,
        cache_file,
        db,
    } = deps;
    // MixerDeviceSink / Player 只能在音频线程创建和持有（非 Send）
    let _stream = match open_default_stream(tx.clone()) {
        Ok(s) => s,
        Err(e) => {
            log::error!("音频输出设备初始化失败: {e}");
            {
                let mut st = state.write().unwrap_or_else(|e| e.into_inner());
                st.status = PlaybackStatus::Error;
                st.error = Some(format!("音频输出设备初始化失败: {e}"));
            }
            let _ = app.emit("playback-state-changed", state.read().unwrap_or_else(|e| e.into_inner()).clone());
            return;
        }
    };
    let (sink, output) = owner.player_channel();
    _stream.mixer().add(DeviceSource::new(output,
        _stream.config().channel_count(), _stream.config().sample_rate()));
    sink.pause();

    let listen = super::listening::ListenLifecycle::production(app.clone(), db.clone());
    let inner = EngineInner {
        owner,
        app,
        tx,
        state,
        queue,
        cache_dir,
        url_cache,
        remote: None,
        route_resume: None,
        gapless: false,
        preload: PreloadState::default(),
        current_progress: None,
        current_mount: None,
        eof_queued: false,
        sink,
        _stream,
        // None = 跟随系统默认；启动时从 settings 恢复用户上次的选择
        output_choice: None,
        // 真正的默认值在下面从 settings 读；这里与 PlaybackStateSnapshot 的默认值对齐
        default_quality: Quality::default(),
        track_quality: None,
        source_qualities: HashMap::new(),
        current_device: String::new(),
        current_shared: None,
        volume_before_mute: 0.8,
        tick_anchor: None,
        failed_tracks: HashSet::new(),
        auto_next: true,
        fail_streak: 0,
        stall_retry: 0,
        smtc: None,
        load_gen: 0,
        play_target: None,
        play_mount: None,
        last_persist: None,
        epoch: std::time::Instant::now(),
        db,
        fx,
        // 与 PlaybackStateSnapshot::default 的 speed 对齐；真正的值从 settings 恢复
        speed: 1.0,
        pause_deadline: None,
        sleep_deadline: None,
        sleep_after_track: false,
        cache_file,
        // 真正的值从 settings 恢复；这里与 cache::DEFAULT_AUDIO_CACHE_LIMIT_MB 对齐
        cache_limit_mb: crate::cache::DEFAULT_AUDIO_CACHE_LIMIT_MB,
        watch: StallWatch::default(),
        dislikes: crate::db::store::DislikeMatcher::empty(),
        listen,
    };

    let mut inner = inner;
    // 恢复用户上次选择的输出设备（存 settings：audio.outputDevice，空 = 跟随默认）
    if let Some(db) = &inner.db {
        if let Ok(saved) =
            db.with(|c| store::get_setting(c, crate::settings_keys::SETTING_OUTPUT_DEVICE))
        {
            match saved.as_deref() {
                Some(name) if !name.is_empty() => {
                    if let Err(e) = inner.rebuild_output(Some(name)) {
                        log::warn!("[device] 恢复上次输出设备「{name}」失败，跟随系统默认: {e}");
                    }
                }
                _ => {
                    // 记下当前默认设备名，后续插拔靠它对比
                    inner.current_device = cpal::default_host()
                        .default_output_device()
                        .and_then(|d| d.description().ok().map(|desc| desc.name().to_string()))
                        .unwrap_or_default();
                    {
                        let mut st = inner.state.write().unwrap_or_else(|e| e.into_inner());
                        st.output_device = inner.current_device.clone();
                    }
                }
            }
        }
    }
    // 恢复设置里的默认播放音质（settings["quality"]：128 / 320 / flac）
    if let Some(db) = &inner.db {
        if let Ok(saved) = db.with(|c| store::get_setting(c, crate::settings_keys::SETTING_QUALITY)) {
            if let Some(q) = saved.as_deref().and_then(parse_quality) {
                inner.default_quality = q.clone();
                inner.mutate(|st| st.quality = q);
            }
        }
    }
    // 恢复倍速与音效设置（settings：playback.speed / fx.eq / fx.loudnorm / fx.fade）
    if let Some(db) = &inner.db {
        let load = |key: &str| -> Option<String> {
            db.with(|c| store::get_setting(c, key)).ok().flatten()
        };
        inner.gapless = load(SETTING_GAPLESS).is_some_and(|raw| raw.trim() == "true");
        // Materialize the default as well, so settings readers observe false.
        if load(SETTING_GAPLESS).is_none() {
            let _ = db.with(|c| store::set_setting(c, SETTING_GAPLESS, "false"));
        }
        if let Some(raw) = load(SETTING_SPEED) {
            if let Ok(v) = raw.parse::<f32>() {
                let v = v.clamp(SPEED_MIN, SPEED_MAX);
                inner.speed = v;
                inner.mutate(|st| st.speed = v);
            }
        }
        if let Some(raw) = load(SETTING_FX_EQ) {
            match serde_json::from_str::<EqParams>(&raw) {
                Ok(p) => inner.fx.set_eq(p),
                Err(e) => log::warn!("[fx] 均衡器设置解析失败，用默认值: {e}"),
            }
        }
        if let Some(raw) = load(SETTING_FX_LOUDNORM) {
            inner.fx.set_loudnorm(raw.trim() == "true");
        }
        // ReplayGain：先恢复模式，再把整张「键 → 增益」表灌进内存
        // （音频线程查表，不碰数据库）
        crate::audio::replay_gain::set_mode(crate::audio::ReplayGainMode::from_setting(
            load(SETTING_FX_REPLAYGAIN).unwrap_or_default().as_str(),
        ));
        match db.with(crate::audio::replay_gain::reload) {
            Ok(total) => log::debug!("[fx] ReplayGain 表已装载：{total} 首带增益"),
            Err(e) => log::warn!("[fx] ReplayGain 表装载失败: {e}"),
        }
        if let Some(raw) = load(SETTING_FX_SPECTRUM) {
            inner.fx.set_spectrum(raw.trim() == "true");
        }
        if let Some(raw) = load(SETTING_FX_FADE) {
            match serde_json::from_str::<FadeParams>(&raw) {
                Ok(p) => inner.fx.set_fade(p),
                Err(e) => log::warn!("[fx] 淡入淡出设置解析失败，用默认值: {e}"),
            }
        }
        if let Ok(saved) =
            db.with(|c| store::get_setting(c, crate::cache::SETTING_AUDIO_CACHE_LIMIT_MB))
        {
            inner.cache_limit_mb = crate::cache::parse_cache_limit_mb(saved.as_deref());
        }
    }
    // 装载不喜欢列表（空 Tableau = 什么都不屏蔽）
    inner.reload_dislikes();
    // 启动先修剪一遍缓存（超限时清最旧；后台线程做，不挡引擎起播）
    spawn_cache_prune(&inner);
    // 心跳用：上次补发全量快照的时刻（防前端漏收事件后状态停死）
    let mut last_publish = std::time::Instant::now();
    // 输出设备变化检测用（每 2s 对比一次默认设备名；被动掉设备 → 暂停）
    let mut last_device_check = std::time::Instant::now();
    loop {
        // playing 时以 25ms 粒度轮询（发 250ms 节流 tick + 检测自然播完），
        // 非播放态长等待，命令到达即醒
        let playing = inner
            .state
            .read()
            .map(|st| st.status == PlaybackStatus::Playing)
            .unwrap_or(false);
        let timeout = if playing {
            Duration::from_millis(25)
        } else {
            Duration::from_secs(1)
        };

        let dislikes = &inner.dislikes;
        match rx.recv_timeout_skipping(timeout, &mut inner.load_gen, |track| dislikes.matches(track)) {
            Ok(AudioDelivery::Command(cmd)) => {
                if handle_cmd(&mut inner, cmd) {
                    return;
                }
            }
            Ok(AudioDelivery::NativeSpeedSetting(setting)) => {
                if handle_cmd(&mut inner, AudioCmd::NativeSpeedSetting(setting)) { return; }
            }
            Ok(delivery @ AudioDelivery::SourceSpeedSetting(_)) => {
                // Persistence only. Never reapply Player speed, seek or a later snapshot.
                if let Err(error) = delivery.persist_speed(inner.db.as_deref()) {
                    log::warn!("[db] source speed persistence failed: {error}");
                }
            }
            Ok(AudioDelivery::Playback(plan)) => handle_committed_queue(&mut inner, *plan),
            Ok(AudioDelivery::ManualPlayback(plan)) => handle_committed_playback(&mut inner, *plan, false),
            Ok(AudioDelivery::NavigationPlayback(plan)) => {
                inner.settle_listen(false, true);
                handle_committed_playback_kind(&mut inner, *plan, false, false);
            }
            Ok(AudioDelivery::PreviousPlayback(plan)) => {
                handle_committed_playback_kind(&mut inner, *plan, false, false);
            }
            Ok(AudioDelivery::AutomaticPlayback { advance, request }) => {
                handle_automatic_playback(&mut inner, *advance, request.map(|request| *request));
            }
            Ok(AudioDelivery::SourceFailure(input)) => handle_source_failure(&mut inner, *input),
            Ok(AudioDelivery::Rejected) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }

        // 到期检查（淡出暂停 / 睡眠定时）与设备热插拔检测，详见各函数注释
        apply_expired_deadlines(&mut inner);
        if inner.remote.is_some() {
            dlna_adapter::tick(&mut inner);
        } else {
            check_output_device(&mut inner, &mut last_device_check);
            if playing { playing_cycle(&mut inner, &mut last_publish); }
        }

        // 只有「此刻确实在播」才该看到位置推进。其余状态（暂停 / 缓冲 / 加载中 /
        // 错误 / 停止）位置本来就不动，一律重建看门狗窗口基准 —— 否则
        // 「暂停 30s 再按播放」会被当成冻结 30s 直接触发恢复。
        // reset 只清窗口：hits 与 dead 判定跨重载延续，恢复阶梯才不会被自己打断。
        if inner
            .state
            .read()
            .map(|st| st.status != PlaybackStatus::Playing)
            .unwrap_or(true)
        {
            inner.watch.reset();
        }
    }
}

/// 到期检查（run_engine 每圈跑一遍）：淡出暂停与睡眠定时。
fn apply_expired_deadlines(inner: &mut EngineInner) {
    // 淡出暂停到期：Pause 命令只发起淡出（增益拉到 0），状态仍是 Playing，
    // 到点这里才真正 pause。期间用户 Play/Seek/换曲都会撤销 deadline。
    if let Some(deadline) = inner.pause_deadline {
        if std::time::Instant::now() >= deadline {
            inner.pause_deadline = None;
            inner.fx.clear_fade();
            finish_pause(inner);
        }
    }
    // 睡眠定时到期：暂停播放并清空定时状态（播完当前歌停止的模式
    // 走 advance(auto) 里的分支，不经过这里）
    if let Some(deadline) = inner.sleep_deadline {
        if std::time::Instant::now() >= deadline {
            inner.sleep_deadline = None;
            fire_sleep_timer(inner);
        }
    }
}

/// 系统默认输出设备名。取不到（无输出设备）或名字为空时返回 None。
fn default_output_device_name() -> Option<String> {
    cpal::default_host()
        .default_output_device()
        .and_then(|d| d.description().ok().map(|desc| desc.name().to_string()))
        .filter(|n| !n.is_empty())
}

/// 设备是否仍在输出设备枚举里。
///
/// WASAPI 只枚举 `DEVICE_STATE_ACTIVE` 端点，所以「拔耳机 / 蓝牙断开 / 设备被禁用」
/// 之后这个设备名会直接消失 —— 这就是「被动移除」的判据。
/// 枚举本身失败时保守地当作「还在」：宁可不动，也不要因为一次枚举失败把播放停掉。
fn device_present(name: &str) -> bool {
    cpal::default_host()
        .output_devices()
        .map(|it| {
            it.into_iter().any(|d| {
                d.description()
                    .map(|desc| desc.name() == name)
                    .unwrap_or(false)
            })
        })
        .unwrap_or(true)
}

/// 一次输出设备轮询的判定结果。
///
/// 抽成纯枚举是为了可单测：`cpal` 那几行调用在单元测试里跑不起来
/// （没有音频端点），但「该不该暂停」的规则本身很容易写错，
/// 也最容易在后续维护中被改回无缝续播。
#[derive(Debug, PartialEq, Eq)]
enum DeviceAction {
    /// 无需动作
    None,
    /// 旧设备从枚举里消失（被动移除）→ 暂停。`fallback` = 接下来会用的兜底设备
    Lost { fallback: Option<String> },
    /// 默认设备换了人且当前跟随默认 → 重建续播
    Follow { name: String },
    /// 启动时没拿到设备名（当时没有任何输出设备）→ 补记当前默认
    Adopt { name: String },
}

/// 输出设备轮询的判定规则（纯函数）。
///
/// - `old`：引擎当前挂着的设备名（空串 = 启动时就没有）
/// - `old_present`：`old` 是否仍在输出设备枚举里（枚举失败时调用方传 `true`）
/// - `default_name`：系统当前默认输出设备名（取不到传 `None`）
/// - `pinned`：用户是否固定了设备（`output_choice.is_some()`）
fn decide_device_action(
    old: &str,
    old_present: bool,
    default_name: Option<&str>,
    pinned: bool,
) -> DeviceAction {
    // 旧设备消失 = 被动移除，优先级最高。这里**不**以 `default_name` 为前提：
    // 只剩一个 USB DAC 时拔掉它，`default_output_device()` 会返回 None，
    // 若要求先取到默认设备名，这种「最后一个设备也没了」的情况就漏判了。
    if !old.is_empty() && !old_present {
        return DeviceAction::Lost {
            fallback: default_name.map(str::to_string),
        };
    }
    // 一次没取到默认设备（枚举瞬时失败 / 正好没有输出设备）：不当作变化
    let Some(name) = default_name else {
        return DeviceAction::None;
    };
    if name == old {
        return DeviceAction::None;
    }
    if !pinned {
        // 旧设备还在，只是默认换了人（插耳机 / 插 HDMI）→ 维持无缝续播
        DeviceAction::Follow {
            name: name.to_string(),
        }
    } else if old.is_empty() {
        // 固定设备模式下默认换人与本应用无关（流还挂在用户指定的设备上）
        DeviceAction::Adopt {
            name: name.to_string(),
        }
    } else {
        DeviceAction::None
    }
}

/// 设备不可用时的说明文案。`verb` 区分「已断开」（曾连上、现在没了）
/// 与「不可用」（选定的设备当前就不在）；`active` 决定要不要带「播放已暂停」
/// —— 本来就没在播时，说「播放已暂停」是误导。
fn device_gone_reason(name: &str, verb: &str, active: bool) -> String {
    if active {
        format!("输出设备「{name}」{verb}，播放已暂停")
    } else {
        format!("输出设备「{name}」{verb}")
    }
}

/// 输出设备热插拔检测（每 2s 轮询一次）。
fn check_output_device(inner: &mut EngineInner, last_check: &mut std::time::Instant) {
    if last_check.elapsed() < std::time::Duration::from_secs(2) {
        return;
    }
    *last_check = std::time::Instant::now();
    let old = inner.current_device.clone();
    let action = decide_device_action(
        &old,
        old.is_empty() || device_present(&old),
        default_output_device_name().as_deref(),
        inner.output_choice.is_some(),
    );
    match action {
        DeviceAction::None => {}
        DeviceAction::Lost { fallback } => {
            pause_for_device_loss(inner, &old, fallback.as_deref());
        }
        DeviceAction::Follow { name } => {
            log::info!("[device] 默认输出设备变化：{old} → {name}，重建输出流");
            if let Err(e) = inner.rebuild_output(None) {
                log::warn!("[device] 重建输出流失败: {e}");
            }
        }
        DeviceAction::Adopt { name } => {
            inner.current_device = name.clone();
            inner.mutate(|st| st.output_device = name);
        }
    }
}

/// 输出设备被动移除：暂停播放（轮询检测到旧设备从枚举里消失）。
///
/// 与 `rebuild_output` 的无缝续播刻意相反。旧行为是「设备变了就重建并续播」，
/// 拔耳机后声音从扬声器接着响；而设备真消失时旧流其实已经写进死端点 ——
/// 声音早就没了，状态却还是 Playing、位置还在走，等于骗人。
///
/// `fallback` = 系统当前默认设备（也就是接下来实际会用的那个），可能没有
/// （一个输出设备都不剩）。
fn pause_for_device_loss(inner: &mut EngineInner, old: &str, fallback: Option<&str>) {
    let reason = device_gone_reason(old, "已断开", is_active_playback(inner));
    pause_playback_for_device(inner, reason, fallback, false);
}

/// 用户（或启动恢复）选定的固定设备当前不存在：同样暂停并说明。
///
/// 过去这里只是 `rebuild_output` 失败后写一条错误行，播放态照旧停在 Playing ——
/// 界面显示在播、实际一个采样都出不去。与掉设备是同一种处境，用同一条路径处理。
fn pause_for_device_loss_named(inner: &mut EngineInner, name: &str) {
    let reason = device_gone_reason(name, "不可用", is_active_playback(inner));
    let fallback = default_output_device_name();
    // 用户主动选了不存在的设备，即使没在播也要给个回执
    pause_playback_for_device(inner, reason, fallback.as_deref(), true);
}

/// 此刻是否真的在出声音（正在播 / 正在为播放取址）。
fn is_active_playback(inner: &EngineInner) -> bool {
    matches!(
        inner.state.read().unwrap_or_else(|e| e.into_inner()).status,
        PlaybackStatus::Playing | PlaybackStatus::Loading
    )
}

/// 掉设备的公共收尾：先暂停、再换到兜底设备、写错误、发通知。
///
/// 顺序是「先暂停、再重建」：`rebuild_output` 按重建**前**的播放态决定是否续播，
/// 所以暂停必须发生在它之前，否则兜底设备会接着把这首放下去。
/// 重建顺带把 `load_gen` 推进一格，在途的 `LoadReady` 作废 —— 否则异步取址
/// 回来后会把曲目挂到刚死掉的那条流上自动播（正是本次要消除的行为）。
///
/// `announce`：没在播也要报错（用户主动选了不存在的设备，必须给个回执）。
/// 被动掉设备时没在播就完全静默 —— 那时弹一条「播放已暂停」纯属噪音。
fn pause_playback_for_device(
    inner: &mut EngineInner,
    reason: String,
    fallback: Option<&str>,
    announce: bool,
) {
    let (status, pos_ms) = {
        let st = inner.state.read().unwrap_or_else(|e| e.into_inner());
        (st.status, st.position_ms)
    };
    let active = matches!(status, PlaybackStatus::Playing | PlaybackStatus::Loading);
    log::info!(
        "[device] {reason}（兜底设备：{}）",
        fallback.unwrap_or("无")
    );
    match status {
        // 正在响：走标准暂停（结算收听 + 落库 + 位置取实时值）
        PlaybackStatus::Playing => finish_pause(inner),
        // 取址途中掉设备：`finish_pause` 只在 Playing 时改状态，这里必须自己落
        // Paused —— 否则重建后 `load_queue_track` 会把状态推成 Loading，
        // 而位置沿用加载目标（`position_ms` 此刻正是 start_at，不能取 sink
        // 实时值，那条流还是上一首的）
        PlaybackStatus::Loading => {
            inner.sink.pause();
            inner.mutate(|st| {
                st.status = PlaybackStatus::Paused;
                st.position_ms = pos_ms;
            });
            inner.persist_state();
        }
        // 本来就是暂停 / 停止：位置已经是冻结的，重建即可
        _ => {}
    }
    // 再换到兜底设备：否则 sink 还挂在死流上，用户按播放既没声音也不推进位置，
    // 只能等看门狗 12s 软重载 + 再 12s 重建输出流
    if let Err(e) = inner.rebuild_output(None) {
        log::warn!("[device] 断开后重建到兜底设备失败: {e}");
        // 记下系统当前的兜底设备名（没有就记空）：否则下一轮轮询仍判定
        // 「设备变了」，每 2s 重试一次并重复弹通知
        inner.current_device = fallback.unwrap_or_default().to_string();
    }
    let dev = inner.current_device.clone();
    inner.mutate(|st| {
        st.output_device = dev;
        if active || announce {
            // 应用内原因。这条文案的寿命取决于上面的重建：
            // - 重建**成功** → 发起一次暂停态重载，异步挂载成功时 `mount_decoder`
            //   会清空 `error`（新流就位 = 旧问题已了结），这里只是一闪而过；
            // - 重建**失败**（一个输出设备都不剩）→ 不重载，文案持续显示，
            //   这正是用户最需要看到原因的情况。
            // 所以持久的告知靠下面那条系统通知，不能只指望这一行。
            st.error = Some(reason.clone());
        }
    });
    // 管线换了一条新的：旧的冻结判定不该带过来
    inner.watch.clear();
    // 淡出状态与 deadline 一并作废：重建若失败，残留的 FadeState::Out 会让
    // 下一次播放走静音路径，过期的 pause_deadline 还会补一枪假暂停
    inner.fx.clear_fade();
    inner.pause_deadline = None;
    if active {
        // 最小化到托盘时应用内错误条看不到，必须走系统通知
        notify_failure(&inner.app, &reason);
    }
}

/// playing 态的每圈工作：自然播完检测 + 位置 tick + 冻结看门狗 + 5s 心跳补发。
/// 不改变 run_engine 的单线程模型 —— 三段都只借这一处调用，时序语义与
/// 原地展开完全一致（last_publish 由调用方持有，圈与圈之间延续）。
fn playing_cycle(inner: &mut EngineInner, last_publish: &mut std::time::Instant) {
    sync_gapless_transition(inner);
    maybe_preload(inner);
    // 自然播完检测：只认**实时**的 Playing 状态 + sink 已空。
    // 设备切换重建后 sink 暂时是空的、状态是 Loading（等待异步取址
    // 回发 Load 续播原曲）—— 若按循环开头的旧 playing 判定，
    // 会把这次重建误判成"播完了"而自动切歌。
    let is_still_playing = inner
        .state
        .read()
        .map(|st| st.status == PlaybackStatus::Playing)
        .unwrap_or(false);
    if is_still_playing && inner.sink.empty() {
        advance(inner, true);
    } else if is_still_playing {
        emit_position_tick(inner);
        // 位置冻结看门狗：回调线程死了 / 解码卡住时 `sink.empty()` 也是
        // false，只有「位置不再推进」这一个信号能识破（见 watch_pipeline）
        watch_pipeline(inner);
    }
    // 心跳：每 5s 补发一次全量快照。事件是"语义变化才推送"，
    // 前端一旦漏收（启动竞态 / WebView 重载），播放条会停在
    // 「未在播放」而音频其实在响 —— 定期补发自愈。
    if last_publish.elapsed() >= std::time::Duration::from_secs(5) {
        inner.publish();
        *last_publish = std::time::Instant::now();
    }
}

fn handle_committed_queue(inner: &mut EngineInner, plan: PlaybackCommitPlan) {
    let selected = plan.autoplay;
    if !selected {
        inner.default_quality = plan.snapshot.quality.clone();
    }
    handle_committed_playback_kind(inner, plan, true, selected);
}

fn handle_committed_playback(inner: &mut EngineInner, plan: PlaybackCommitPlan, reset_queue: bool) {
    handle_committed_playback_kind(inner, plan, reset_queue, true);
}

fn handle_committed_playback_kind(
    inner: &mut EngineInner, plan: PlaybackCommitPlan, reset_queue: bool, selected: bool,
) {
    invalidate_preload(inner);
    if reset_queue {
        inner.track_quality = None;
        inner.failed_tracks.clear();
    }
    if selected {
        inner.auto_next = true;
        inner.fail_streak = 0;
        inner.stall_retry = 0;
        inner.watch.clear();
    }
    // Gate has already moved the real queue/snapshot. All effects and retired drops are outside it.
    inner.play_target = plan.target.clone();
    inner.play_mount = plan.port;
    let _ = inner.app.emit("queue-changed", serde_json::json!({
        "tracks": plan.queue.tracks,
        "index": plan.queue.index.map(|index| index as u32),
    }));
    inner.publish();
    if let Some(track) = plan.track {
        if selected {
            inner.failed_tracks.remove(&track.id);
        }
        let resume = inner.route_resume.take().filter(|(generation, _, _)| plan.target.as_ref()
            .is_some_and(|target| target.generation == *generation));
        let (start_ms, autoplay) = resume.map_or((plan.start_ms, plan.autoplay), |(_, position, autoplay)| (position, autoplay));
        load_queue_track_for_generation(inner, track, autoplay, start_ms, plan.load_gen);
    } else {
        inner.settle_listen(false, true);
        inner.sink.clear();
        inner.current_shared = None;
        inner.current_progress = None;
        inner.pause_deadline = None;
        inner.fx.clear_fade();
        inner.fx.set_static_gain(1.0);
        *inner.cache_file.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
    inner.persist_queue();
}

fn handle_cmd(inner: &mut EngineInner, cmd: AudioCmd) -> bool {
    let Some(cmd) = dlna_adapter::route(inner, cmd) else { return false; };
    sync_gapless_transition(inner);
    // 作废预载：凡可能改变「下一首是谁」或「它的音质」的命令都要重选目标。
    // 刻意不在名单里的两条：
    // - `Seek` / `SetSpeed` 只作用于当前这条流，改不了队列下标也改不了下一首的
    //   取链参数，作废它只会白丢一次已取好的地址（随机模式下还要重掷一次骰子，
    //   等于「拖了下进度条，下一首就换成别的歌」）。
    // - 暂停不在这里，但 `finish_pause` 会主动作废：暂停期间不该继续预取带宽。
    if matches!(&cmd,
        AudioCmd::Play | AudioCmd::Pause | AudioCmd::Stop
        | AudioCmd::SetQueue { .. } | AudioCmd::PlayTrack(_) | AudioCmd::PlayAt(_)
        | AudioCmd::Next | AudioCmd::Previous | AudioCmd::SetPlayMode(_)
        | AudioCmd::ClearQueue | AudioCmd::AddNext(_) | AudioCmd::Append(_)
        | AudioCmd::RemoveAt(_) | AudioCmd::RemoveIndices(_) | AudioCmd::MoveItem { .. }
        | AudioCmd::ClearAfter | AudioCmd::RestoreSession { .. }
        | AudioCmd::SetOutputDevice { .. } | AudioCmd::SetDefaultQuality { .. }
        | AudioCmd::SetTrackQuality { .. }
        | AudioCmd::SetSleepTimer { .. } | AudioCmd::SetGapless(_)
        | AudioCmd::ReloadDislikes | AudioCmd::SetCacheDir(_) | AudioCmd::Shutdown
    ) {
        invalidate_preload(inner);
    }
    if matches!(&cmd, AudioCmd::Stop | AudioCmd::ClearQueue | AudioCmd::SetQueue { .. }) {
        inner.load_gen = inner.load_gen.wrapping_add(1);
    }
    match cmd {
        AudioCmd::DlnaConnect { .. } | AudioCmd::DlnaDisconnect { .. } | AudioCmd::DlnaDisconnected(_)
        | AudioCmd::DlnaLoaded(_) | AudioCmd::DlnaPoll(_) | AudioCmd::DlnaAction(_)
        | AudioCmd::DlnaBoundPause { .. } | AudioCmd::DlnaBoundSeek { .. } => unreachable!("DLNA adapter handles its commands"),
        // Source lifecycle semantics are consumed by the same production inbox.
        AudioCmd::SourceFinished(_) => {}
        AudioCmd::StampedRestore { reply, .. } => {
            let _ = reply.send(None);
        }
        AudioCmd::QueuedSetQueue { reply, .. } | AudioCmd::QueuedPlayAt { reply, .. }
            | AudioCmd::QueuedNext { reply, .. } | AudioCmd::QueuedPrevious { reply, .. }
            | AudioCmd::QueuedPlayTrack { reply, .. } => {
            // Ticketed commands are consumed by the production inbox, never reinterpreted here.
            let _ = reply.send(QueueCommitReply::rejected());
        }
        cmd @ AudioCmd::LoadReady { preload: true, .. } => {
            let app = &inner.app;
            let _ = inner.owner.append_preloaded(
                cmd, &mut inner.preload,
                PreloadFlags {
                    gapless: inner.gapless, sleep_after_track: inner.sleep_after_track,
                    auto_next: inner.auto_next,
                },
                PreloadRender {
                    player: &inner.sink, fx: &inner.fx, epoch: inner.epoch,
                },
                || Some(crate::audio::SpectrumTap::new(Some(app.clone()))),
            );
            return false;
        }
        AudioCmd::LoadReady {
            target,
            port,
            track,
            decoder,
            shared,
            duration_ms,
            start_at,
            autoplay,
            is_local,
            url_fetched_at,
            play_url,
            size_bytes,
            gen,
            preload: _,
        } => {
            // 过期结果丢弃：等待取址/构建期间用户又切了歌，这条是旧歌的
            if gen != inner.load_gen {
                log::debug!(
                    "[queue] 丢弃过期的加载结果 track={} (gen={gen} != {})",
                    track.id,
                    inner.load_gen
                );
            } else {
                mount_decoder(
                    inner,
                    target,
                    port,
                    &track,
                    decoder,
                    shared,
                    duration_ms,
                    start_at,
                    autoplay,
                    is_local,
                    url_fetched_at,
                    play_url,
                    size_bytes,
                );
            }
        }
        AudioCmd::Play => {
            // Error 态下 sink 是空的，裸 sink.play() 是空操作 → 播放键失效。
            // 改为重载当前队列曲目（autoplay=true）：成功即从原进度续播，再失败
            // 走 LoadFailed 的自动跳过链。用户按播放 = 明确意图，重开自动切歌熔断。
            let reload = inner.state.read().unwrap_or_else(|e| e.into_inner()).status == PlaybackStatus::Error;
            if reload {
                let track = inner.queue.lock().unwrap_or_else(|e| e.into_inner()).current().cloned();
                if let Some(track) = track {
                    let pos = inner.state.read().unwrap_or_else(|e| e.into_inner()).position_ms;
                    inner.auto_next = true;
                    inner.fail_streak = 0;
                    inner.stall_retry = 0;
                    // 用户手动播 = 明确意图：看门狗判定也清零（给这条管线一次干净的机会）
                    inner.watch.clear();
                    load_queue_track(inner, track, true, pos);
                } else {
                    inner.mutate(|st| st.status = PlaybackStatus::Stopped);
                }
            } else {
                // 取消在途的淡出（有的话），再按需给一次淡入
                inner.pause_deadline = None;
                if inner.fx.fade_enabled() {
                    inner.fx.begin_fade_in(epoch_ms(inner));
                } else {
                    inner.fx.clear_fade();
                }
                inner.sink.play();
                let source_mounts = inner.owner.source_mounts.clone();
                inner.mutate(|st| {
                    let mounts = source_mounts.lock().unwrap_or_else(|e| e.into_inner());
                    let source_paused = mounts.current.iter().chain(mounts.reserved.iter()).any(|port|
                        port.is_live() && port.is_paused()
                            && st.track_id.as_deref() == Some(port.stamp().target.id.as_str())
                            && st.source_id.as_ref().map(|source| source.as_str()) == Some(port.stamp().target.platform.as_str()));
                    if st.status == PlaybackStatus::Paused && !source_paused {
                        st.status = PlaybackStatus::Playing;
                    }
                    // 恢复播放 = 用户已经看到并接受了那条说明（掉设备暂停等）。
                    // 不清掉的话，之后任何一次普通暂停都会把旧文案重新顶出来。
                    st.error = None;
                });
            }
        }
        AudioCmd::Pause => {
            // 淡出开启且真的在播：发起淡出但不立即暂停 —— 状态保持 Playing
            // （进度照常走），增益由 DspSource 拉到 0，到期由引擎循环暂停。
            // 淡出已在途时再次 Pause = 用户坚持，直接暂停。
            let fading = inner.pause_deadline.is_none()
                && inner.fx.fade_enabled()
                && inner.state.read().unwrap_or_else(|e| e.into_inner()).status == PlaybackStatus::Playing;
            if fading {
                let dur = inner.fx.fade_duration_ms();
                inner.fx.begin_fade_out(epoch_ms(inner));
                inner.pause_deadline = Some(std::time::Instant::now() + Duration::from_millis(dur));
            } else {
                inner.pause_deadline = None;
                finish_pause(inner);
            }
        }
        AudioCmd::Stop => {
            // 停止 = 这次收听结束：先把真实收听结算进统计（没播完就不算完播）
            inner.settle_listen(false, true);
            inner.sink.clear();
            inner.current_shared = None;
            inner.current_progress = None;
            inner.pause_deadline = None;
            inner.fx.clear_fade();
            // 没歌在播了，静态增益回中性（下次挂载时再按曲目设）
            inner.fx.set_static_gain(1.0);
            *inner.cache_file.lock().unwrap_or_else(|e| e.into_inner()) = None;
            inner.mutate(|st| {
                st.status = PlaybackStatus::Stopped;
                st.position_ms = 0;
                st.duration_ms = 0;
                st.buffered_ms = 0;
                st.track_id = None;
                st.track = None;
                st.bitrate_kbps = None;
            });
            inner.persist_state();
        }
        AudioCmd::Seek(pos) => {
            // 取消在途的淡出并复位增益；内容时间域 → rodio 域换算见 sink_seek_content
            inner.pause_deadline = None;
            inner.fx.clear_fade();
            // rodio try_seek 对 MP3/FLAC 可用（DESIGN §3.3 边界）；失败报错不崩
            match sink_seek_content(inner, pos) {
                Ok(()) => {
                    inner.mutate(|st| {
                        st.position_ms = pos;
                        st.error = None;
                    });
                    // 立即补发一次 tick，让前端取消旧插值（DESIGN §7.11）
                    inner.tick_anchor = None;
                    inner.last_persist = None;
                    emit_position_tick(inner);
                }
                Err(_) => {
                    log::error!("try_seek 失败 pos={pos}");
                    inner.mutate(|st| st.error = Some("进度拖动失败".into()));
                }
            }
        }
        AudioCmd::SetVolume(v) => {
            let v = v.clamp(0.0, 1.0);
            let muted = inner.state.read().unwrap_or_else(|e| e.into_inner()).muted;
            inner.sink.set_volume(if muted { 0.0 } else { v });
            if !muted {
                inner.volume_before_mute = v;
            }
            inner.mutate(|st| st.volume = v);
            inner.persist_state();
        }
        AudioCmd::SetMuted(m) => {
            let v = inner.state.read().unwrap_or_else(|e| e.into_inner()).volume;
            if m {
                inner.volume_before_mute = v;
                inner.sink.set_volume(0.0);
            } else {
                inner
                    .sink
                    .set_volume(inner.volume_before_mute.clamp(0.01, 1.0));
            }
            inner.mutate(|st| st.muted = m);
            inner.persist_state();
        }
        AudioCmd::SetQueue { tracks, index } => {
            // 播放新列表 = 新一轮播放：上一首的临时音质作废，回到默认音质；
            // 失败跳过记录也清空，新的队列重新给每首歌机会；
            // 用户主动发起播放，同时重开自动切歌熔断
            inner.track_quality = None;
            inner.failed_tracks.clear();
            inner.auto_next = true;
            inner.fail_streak = 0;
            inner.stall_retry = 0;
            inner.watch.clear();
            let mut q = inner.queue.lock().unwrap_or_else(|e| e.into_inner());
            q.set(tracks, index);
            let current = q.current().cloned();
            drop(q);
            inner.sync_queue_to_snapshot();
            inner.queue_emit();
            if let Some(track) = current {
                play_queue_track(inner, track);
            }
            inner.persist_queue();
        }
        AudioCmd::PlayTrack(track) => {
            // 与 PlayAt 同源：用户明确点了某一首 = 新一轮手动播放，
            // 重开熔断、清失败记录、给这首歌第二次机会。
            // 不碰 track_quality（那是「这首单独指定音质」，与队列无关）。
            let track = {
                let mut q = inner.queue.lock().unwrap_or_else(|e| e.into_inner());
                let i = q.append_or_find(*track);
                q.commit_index(i);
                q.current().cloned()
            };
            inner.sync_queue_to_snapshot();
            inner.queue_emit();
            if let Some(track) = track {
                inner.auto_next = true;
                inner.fail_streak = 0;
                inner.stall_retry = 0;
                inner.watch.clear();
                inner.failed_tracks.remove(&track.id);
                play_queue_track(inner, track);
            }
            inner.persist_queue();
        }
        AudioCmd::PlayAt(index) => {
            let track = {
                let mut q = inner.queue.lock().unwrap_or_else(|e| e.into_inner());
                if index >= q.len() {
                    None
                } else {
                    q.commit_index(index);
                    q.current().cloned()
                }
            };
            inner.sync_queue_to_snapshot();
            inner.queue_emit();
            if let Some(track) = track {
                // 用户手动点播 = 明确意图：重开熔断，并给失败过的歌第二次机会
                // （覆盖「线路恢复后老歌被永久跳过」）
                inner.auto_next = true;
                inner.fail_streak = 0;
                inner.stall_retry = 0;
                inner.watch.clear();
                inner.failed_tracks.remove(&track.id);
                play_queue_track(inner, track);
            }
            inner.persist_queue();
        }
        AudioCmd::ReloadDislikes => {
            inner.reload_dislikes();
        }
        AudioCmd::Next => advance(inner, false),
        AudioCmd::Previous => go_previous(inner),
        AudioCmd::SetPlayMode(mode) => {
            inner.mutate(|st| st.play_mode = mode);
            inner.persist_state();
        }
        AudioCmd::ClearQueue => {
            inner.sink.clear();
            inner.current_shared = None;
            inner.current_progress = None;
            inner.pause_deadline = None;
            inner.fx.clear_fade();
            inner.fx.set_static_gain(1.0);
            *inner.cache_file.lock().unwrap_or_else(|e| e.into_inner()) = None;
            {
                let mut q = inner.queue.lock().unwrap_or_else(|e| e.into_inner());
                q.set(Vec::new(), 0);
            }
            inner.sync_queue_to_snapshot();
            inner.queue_emit();
            inner.mutate(|st| {
                st.status = PlaybackStatus::Stopped;
                st.position_ms = 0;
                st.track_id = None;
                st.track = None;
            });
            inner.persist_queue();
        }
        AudioCmd::AddNext(track) => {
            inner.queue.lock().unwrap_or_else(|e| e.into_inner()).insert_next(*track);
            inner.sync_queue_to_snapshot();
            inner.queue_emit();
            inner.persist_queue();
        }
        AudioCmd::Append(tracks) => {
            if !tracks.is_empty() {
                inner.queue.lock().unwrap_or_else(|e| e.into_inner()).append(tracks);
                inner.sync_queue_to_snapshot();
                inner.queue_emit();
                inner.persist_queue();
            }
        }
        AudioCmd::RemoveAt(index) => {
            if inner.owner.remove_queue_indices(&[index]) > 0 {
                inner.queue_emit();
                inner.persist_queue();
            }
        }
        AudioCmd::RemoveIndices(indices) => {
            if inner.owner.remove_queue_indices(&indices) > 0 {
                inner.queue_emit();
                inner.persist_queue();
            }
        }
        AudioCmd::MoveItem { from, to } => {
            let moved = inner.queue.lock().unwrap_or_else(|e| e.into_inner()).move_item(from, to);
            if moved {
                inner.sync_queue_to_snapshot();
                inner.queue_emit();
                inner.persist_queue();
            }
        }
        AudioCmd::ClearAfter => {
            let removed = inner.queue.lock().unwrap_or_else(|e| e.into_inner()).clear_after_current();
            if removed > 0 {
                inner.sync_queue_to_snapshot();
                inner.queue_emit();
                inner.persist_queue();
            }
        }
        AudioCmd::RestoreSession {
            tracks,
            index,
            position_ms,
            play_mode,
            volume,
            muted,
            quality,
        } => {
            {
                let mut q = inner.queue.lock().unwrap_or_else(|e| e.into_inner());
                q.set(tracks, index);
            }
            inner.failed_tracks.clear();
            inner.sync_queue_to_snapshot();
            inner.queue_emit();
            inner.mutate(|st| {
                st.play_mode = play_mode;
                st.volume = volume;
                st.muted = muted;
                st.quality = quality;
                st.error = None;
            });
            inner.sink.set_volume(inner.effective_volume());
            let track = inner.queue.lock().unwrap_or_else(|e| e.into_inner()).current().cloned();
            if let Some(track) = track {
                // 暂停态加载并定位到上次进度；用户点播放即续播
                load_queue_track(inner, track, false, position_ms);
            }
            inner.persist_queue();
        }
        AudioCmd::SetOutputDevice { name } => {
            // 选择存进 settings，重启后保持；切设备时重建输出流并续播当前曲
            if let Some(db) = &inner.db {
                let key_val = name.clone().unwrap_or_default();
                if let Err(e) = db.with(|c| {
                    store::set_setting(c, crate::settings_keys::SETTING_OUTPUT_DEVICE, &key_val)
                }) {
                    log::warn!("[db] 输出设备选择入库失败: {e}");
                }
            }
            inner.output_choice = name.clone();
            // 选定的固定设备当前不在枚举里（拔了 / 蓝牙没连上）：与「被动掉设备」
            // 同一种处境 —— 继续显示 Playing 却一个采样都出不去。走暂停路径说明。
            let missing = name.as_deref().is_some_and(|n| !device_present(n));
            if missing {
                if let Some(n) = name.as_deref() {
                    pause_for_device_loss_named(inner, n);
                }
            } else if let Err(e) = inner.rebuild_output(name.as_deref()) {
                log::warn!("[device] 切换输出设备失败: {e}");
                inner.mutate(|st| st.error = Some(format!("切换输出设备失败: {e}")));
            }
        }
        AudioCmd::SetDefaultQuality { quality } => {
            // 默认音质（设置页）：写 settings 以便重启保持，并对当前这首立即生效
            if let Some(db) = &inner.db {
                if let Err(e) = db.with(|c| {
                    store::set_setting(
                        c,
                        crate::settings_keys::SETTING_QUALITY,
                        &quality_key(&quality),
                    )
                })
                {
                    log::warn!("[db] 默认音质入库失败: {e}");
                }
            }
            inner.default_quality = quality;
            let current = inner.queue.lock().unwrap_or_else(|e| e.into_inner()).current().cloned();
            if inner.track_quality.is_none() {
                if let Some(track) = current {
                    let (autoplay, pos) = playback_resume_point(inner);
                    load_queue_track(inner, track, autoplay, pos);
                }
            }
            inner.persist_state();
        }
        AudioCmd::SetTrackQuality { quality } => {
            // 只针对当前这首（播放条入口）：按曲目 id 绑定，换歌自动回到默认，不写 settings
            let current = inner.queue.lock().unwrap_or_else(|e| e.into_inner()).current().cloned();
            if let Some(track) = current {
                let (autoplay, pos) = playback_resume_point(inner);
                inner.track_quality = Some((track.id.clone(), quality));
                load_queue_track(inner, track, autoplay, pos);
            }
        }
        AudioCmd::SetSourceQualities { qualities } => {
            // 平台独立音质（音源账号页）：只更新运行时副本，不触发重取——选择器
            // 变更后前端对当前曲目按需走 setTrackQuality 立即生效。
            inner.source_qualities = qualities;
        }
        AudioCmd::SourceSpeedSetting(setting) => {
            // Defensive direct dispatch shares the same bound-only executor.
            if let Err(error) = AudioDelivery::SourceSpeedSetting(setting).persist_speed(inner.db.as_deref()) {
                log::warn!("[db] source speed persistence failed: {error}");
            }
        }
        AudioCmd::NativeSpeedSetting(setting) => {
            // Admission only: State is released before Player/decoder or SQLite IO.
            // A superseded packet never borrows a newer snapshot's value or receipt.
            if !setting.qualifies() { return false; }
            let v = setting.speed();
            let bound = inner.owner.current_source_mount().is_some_and(|port| port.is_live());
            let pos = content_pos_ms(inner);
            inner.speed = v;
            inner.sink.set_speed(if bound { 1.0 } else { v });
            // Only legacy unbound decoders still need Player-domain reanchoring.
            if !bound && pos > 0 {
                if let Err(e) = sink_seek_content(inner, pos) {
                    log::warn!("[audio] legacy speed seek failed: {e}");
                }
            }
            // Requalify after any decoder work and after the DB mutex wait.
            if let Err(e) = AudioDelivery::NativeSpeedSetting(setting).persist_speed(inner.db.as_deref()) {
                log::warn!("[db] 倍速入库失败: {e}");
            }
        }
        AudioCmd::SetSpeed(_) => {
            // Only send() may convert raw Native input into captured semantic work.
            log::warn!("[audio] unstamped Native speed command rejected");
        }
        AudioCmd::SetSleepTimer {
            remaining_ms,
            after_track,
        } => {
            inner.sleep_deadline =
                remaining_ms.map(|ms| std::time::Instant::now() + Duration::from_millis(ms.max(1)));
            inner.sleep_after_track = after_track;
            inner.mutate(|st| {
                st.sleep_timer_ms = remaining_ms;
                st.sleep_after_track = after_track;
            });
            inner.persist_state();
        }
        AudioCmd::SetEq(params) => {
            inner.fx.set_eq(params);
            if let Some(db) = &inner.db {
                let json = serde_json::to_string(&inner.fx.eq_params()).unwrap_or_default();
                if let Err(e) = db.with(|c| store::set_setting(c, SETTING_FX_EQ, &json)) {
                    log::warn!("[db] 均衡器设置入库失败: {e}");
                }
            }
        }
        AudioCmd::SetLoudNorm(on) => {
            inner.fx.set_loudnorm(on);
            if let Some(db) = &inner.db {
                let val = if on { "true" } else { "false" };
                if let Err(e) = db.with(|c| store::set_setting(c, SETTING_FX_LOUDNORM, val)) {
                    log::warn!("[db] 响度归一化设置入库失败: {e}");
                }
            }
        }
        AudioCmd::SetReplayGain(mode) => {
            crate::audio::replay_gain::set_mode(mode);
            // 立刻按当前曲目重算：正在播的那首当场变响度，不用等下一首
            let current = inner.state.read().ok().and_then(|st| st.track.clone());
            match current {
                Some(track) => apply_replay_gain(inner, &track),
                None => inner.fx.set_static_gain(1.0),
            }
            if let Some(db) = &inner.db {
                if let Err(e) =
                    db.with(|c| store::set_setting(c, SETTING_FX_REPLAYGAIN, mode.as_setting()))
                {
                    log::warn!("[db] ReplayGain 模式入库失败: {e}");
                }
            }
        }
        AudioCmd::SetSpectrum(on) => {
            inner.fx.set_spectrum(on);
            if let Some(db) = &inner.db {
                let val = if on { "true" } else { "false" };
                if let Err(e) = db.with(|c| store::set_setting(c, SETTING_FX_SPECTRUM, val)) {
                    log::warn!("[db] 频谱背景设置入库失败: {e}");
                }
            }
        }
        AudioCmd::SetGapless(enabled) => {
            inner.gapless = enabled;
            if let Some(db) = &inner.db {
                let value = if enabled { "true" } else { "false" };
                if let Err(error) = db.with(|c| store::set_setting(c, SETTING_GAPLESS, value)) {
                    log::warn!("[db] gapless setting failed: {error}");
                }
            }
            maybe_preload(inner);
        }
        AudioCmd::PreloadFailed { gen } => {
            // 预载失败立刻作废槽位并记一次重试：下一圈预热会重新选目标
            // （随机模式重新掷骰），不必再死等到曲末才由 advance() 现场取链。
            // 次数上限见 PRELOAD_RETRY_LIMIT —— 连续失败时不再反复拉流。
            if inner.preload.slot.as_ref().is_some_and(|slot| slot.gen == gen) {
                inner.preload.slot = None;
                inner.preload.gen = inner.preload.gen.wrapping_add(1);
                inner.preload.retries = inner.preload.retries.saturating_add(1);
                log::debug!(
                    "[gapless] 预热失败，换目标重试（{}/{}）",
                    inner.preload.retries,
                    PRELOAD_RETRY_LIMIT
                );
            }
        }
        AudioCmd::SetFade(params) => {
            // 正在淡出时改参数：直接收尾暂停，避免 deadline 与新时长不一致
            if inner.pause_deadline.is_some() {
                inner.pause_deadline = None;
                inner.fx.clear_fade();
                finish_pause(inner);
            }
            inner.fx.set_fade(params);
            if let Some(db) = &inner.db {
                let json = serde_json::to_string(&inner.fx.fade_params()).unwrap_or_default();
                if let Err(e) = db.with(|c| store::set_setting(c, SETTING_FX_FADE, &json)) {
                    log::warn!("[db] 淡入淡出设置入库失败: {e}");
                }
            }
        }
        AudioCmd::SetCacheLimit(mb) => {
            inner.cache_limit_mb = mb;
            if let Some(db) = &inner.db {
                if let Err(e) = db.with(|c| {
                    store::set_setting(
                        c,
                        crate::cache::SETTING_AUDIO_CACHE_LIMIT_MB,
                        &mb.to_string(),
                    )
                }) {
                    log::warn!("[db] 播放缓存上限入库失败: {e}");
                }
            }
            // 调低上限立即生效：后台修剪到新上限以内
            spawn_cache_prune(inner);
        }
        AudioCmd::SetCacheDir(dir) => {
            // 只换目录本身：正在读的那条流仍指着旧文件（句柄已打开），
            // 后续取流 / 修剪走新目录。
            //
            // 这里**不**写 settings：`cache.dir` 存的是缓存**根目录**（音频缓存
            // 是它下面的 `audio`，见 lib.rs setup），而引擎只知道传进来的
            // `audio` 子目录 —— 由引擎落库就会把 `<根>/audio` 存进去，下次启动
            // 再 join 一次 `audio`，缓存跑到 `<根>/audio/audio`。落库归调用方
            // （commands::cmd_choose_cache_dir）。
            log::info!("[cache] 缓存目录已切换到 {}", dir.display());
            inner.cache_dir = dir;
        }
        AudioCmd::LoadFailed {
            original: _,
            kind: _,
            track_id,
            message,
            autoplay,
            stalled,
            gen,
        } => {
            if gen != inner.load_gen {
                // 过期的失败回执：用户已切到别的歌，不能把当前状态置错
                log::debug!("[queue] 丢弃过期的失败回执 track={track_id}");
            } else {
                log::error!("[queue] 曲目 {track_id} 播放失败: {message}");
                inner.mutate(|st| {
                    st.status = PlaybackStatus::Error;
                    st.error = Some(message);
                });
                // 事件已由取址方（含原消息）发出，这里只负责状态与跳过决策
                // 自动下一首标识关闭（熔断已触发）就不跳，保持错误态等用户处理；
                // autoplay=false 的加载（启动恢复/暂停态重载）本来就不在自动链上
                if autoplay && inner.auto_next {
                    if stalled {
                        // 环境问题：原地重试同一首，绝不换歌、绝不计入熔断。
                        // 这是弱网修复的核心——过去弱网超时被当成「歌坏了」，
                        // 于是连跳 5 首把自动切歌关掉，再也回不来。
                        schedule_stalled_retry(inner, &track_id);
                    } else {
                        inner.fail_streak += 1;
                        if inner.fail_streak >= FAIL_STREAK_LIMIT {
                            inner.auto_next = false;
                            inner.fail_streak = 0;
                            let notice = format!(
                                "连续{FAIL_STREAK_LIMIT}首播放失败，已停止自动切歌"
                            );
                            log::warn!("[queue] {notice}");
                            inner.mutate(|st| st.error = Some(notice.clone()));
                            // 自动切歌多发生在后台，应用内错误条看不到，走系统通知告知
                            notify_failure(&inner.app, &notice);
                            // 网络/音源恢复后自动重开（不强求用户手动操作）
                            schedule_recovery_probe(inner);
                        } else {
                            skip_if_recoverable(inner, &track_id, autoplay);
                        }
                    }
                }
            }
        }
        AudioCmd::StalledRetry { track_id, gen } => {
            if gen != inner.load_gen {
                log::debug!("[queue] 丢弃过期的弱网重试 track={track_id}");
            } else {
                // 只在仍是当前曲时才重试（用户在延迟期间手动切了别的歌就不动）
                let is_current = inner
                    .queue
                    .lock()
                    .unwrap()
                    .current()
                    .map(|t| t.id == track_id)
                    .unwrap_or(false);
                if !is_current {
                    log::debug!("[queue] 弱网重试时当前曲已变，丢弃 track={track_id}");
                } else {
                    // 先出借用再play_queue_track（它要&mut inner）
                    let track = inner.queue.lock().unwrap_or_else(|e| e.into_inner()).current().cloned();
                    if let Some(track) = track {
                        log::debug!("[queue] 弱网重试：{track_id}");
                        play_queue_track(inner, track);
                    }
                }
            }
        }
        AudioCmd::Recovered { gen } => {
            if gen != 0 && gen != inner.load_gen {
                log::debug!("[queue] 丢弃过期的恢复探测回执");
            } else {
                // 网络/音源已恢复：重开自动切歌并把当前曲重新拉起来。
                // 过去熔断是单向门，只能靠用户手动操作，这里让它自愈。
                inner.auto_next = true;
                inner.fail_streak = 0;
                inner.stall_retry = 0;
                inner.watch.clear();
                inner.failed_tracks.clear();
                inner.mutate(|st| {
                    st.error = None;
                });
                let track = inner.queue.lock().unwrap_or_else(|e| e.into_inner()).current().cloned();
                if let Some(track) = track {
                    log::debug!("[queue] 网络已恢复，重新播放当前曲 {}", track.id);
                    play_queue_track(inner, track);
                } else {
                    log::debug!("[queue] 网络已恢复，队列为空不重放");
                }
            }
        }
        AudioCmd::SetSmtc(handle) => {
            inner.smtc = handle;
            // 立即把当前状态推给系统面板，避免注入前已播的曲目信息缺失
            inner.publish();
        }
        AudioCmd::StreamError { message, fatal } => {
            log::error!("[audio] 输出流不可用（fatal={fatal}）：{message}");
            // 这一刻 PlaybackStatus 可能仍是 Playing、位置也已经冻住，前端完全
            // 看不出异常。交给看门狗：缩短判定窗口，fatal（回调线程已死）时跳过
            // 软重载直接重建输出流 —— 没有回调来拉样本，重新挂源是白费。
            inner.watch.mark_dead(fatal);
        }
        AudioCmd::Shutdown => {
            // 退出前把这段收听落库（异步写，尽力而为：进程可能先一步结束，
            // 兜底是每 30s 一次的定期落库，最多丢 30 秒）
            inner.settle_listen(false, true);
            return true;
        }
    }
    // 每条命令处理完立刻补一次预热：挂载完成（LoadReady）/ 恢复播放 / 重新开
    // 无缝，都在这一条命令里把状态推到可预热，不必再等播放圈的下一次轮询
    // （非播放态那一圈要等满 1s，等于白等一秒才开始预取）。
    maybe_preload(inner);
    false
}

/// 切音质 / 换输出设备这类「原地重取」用的续播参数：
/// 原来在播（或正在缓冲）就继续播，并从原进度续；暂停态则保持暂停。
fn playback_resume_point(inner: &EngineInner) -> (bool, u64) {
    let st = inner.state.read().unwrap_or_else(|e| e.into_inner());
    let autoplay = matches!(
        st.status,
        PlaybackStatus::Playing | PlaybackStatus::Loading | PlaybackStatus::Buffering
    );
    (autoplay, st.position_ms)
}

fn handle_source_failure(inner: &mut EngineInner, input: SourceFailureInput) {
    let mut context = SourceRecoveryContext {
        auto_next: inner.auto_next, fail_streak: inner.fail_streak,
        failed_tracks: std::mem::take(&mut inner.failed_tracks),
    };
    let applied = inner.owner.apply_source_failure(input, &mut context, &mut inner.load_gen);
    inner.auto_next = context.auto_next;
    inner.fail_streak = context.fail_streak;
    inner.failed_tracks = context.failed_tracks;
    let Some(mut applied) = applied else { return; };
    let _ = inner.app.emit("audio-error", serde_json::json!({
        "trackId": applied.input.track_id,
        "kind": applied.input.kind,
        "message": applied.input.message,
        "stalled": applied.input.stalled,
    }));
    log::error!("[queue] 曲目 {} 播放失败: {}", applied.input.track_id, applied.input.message);
    // Loading is published with the real effective quality below, just as in the actor loader.
    if matches!(&applied.effect, SourceFailureEffect::Advance { .. }) {
        applied.updates.pop();
    }
    for snapshot in &applied.updates { inner.publish_snapshot(snapshot); }
    match applied.effect {
        SourceFailureEffect::Error => {}
        SourceFailureEffect::Retry => schedule_stalled_retry(inner, &applied.input.track_id),
        SourceFailureEffect::Circuit { notice } => {
            log::warn!("[queue] {notice}");
            notify_failure(&inner.app, &notice);
            schedule_recovery_probe(inner);
        }
        SourceFailureEffect::Advance { track, target, request } => {
            inner.queue_emit();
            invalidate_preload(inner);
            let _ = inner.listen.before_load(&track);
            let quality = effective_quality_for(inner, &track);
            inner.play_target = Some(target);
            inner.play_mount = None;
            inner.mutate(|state| state.quality = quality);
            if let Some(request) = request { spawn_prepared_source_load(inner, *request); }
            inner.persist_queue();
        }
    }
}

/// 播放队列中的指定曲目：置 Loading 后异步取址+构建，成功回发 LoadReady。
fn play_queue_track(inner: &mut EngineInner, track: Track) {
    load_queue_track(inner, track, true, 0);
}

/// 暂停态变体：恢复现场用（autoplay=false，start_ms>0 时加载后定位）。
fn load_queue_track(inner: &mut EngineInner, track: Track, autoplay: bool, start_ms: u64) {
    inner.load_gen = inner.load_gen.wrapping_add(1);
    let generation = inner.load_gen;
    load_queue_track_for_generation(inner, track, autoplay, start_ms, generation);
}

fn load_queue_track_for_generation(
    inner: &mut EngineInner,
    track: Track,
    autoplay: bool,
    start_ms: u64,
    gen: u64,
) {
    invalidate_preload(inner);
    // 切换到别的曲目 = 这次收听结束，先结算（同曲**重载**不结算：弱网原地重试 /
    // 恢复现场 / 换音质续播都还是同一次收听，见 begin_listen）。
    // 身份按 platform + 裸 id 判定：不同音源的相同裸 id 是两首歌（C17）。
    let _ = inner.listen.before_load(&track);
    // 有效音质：本曲临时指定 → 平台独立音质 → 全局默认（见 effective_quality_for）
    let quality = effective_quality_for(inner, &track);
    // The receiver has already committed the accepted generation; do not increment twice.
    inner.mutate(|st| {
        st.quality = quality;
        super::playback_commit::set_loading_snapshot(st, &track, start_ms);
    });
    spawn_resolve_and_load(inner, track, autoplay, start_ms, gen);
}

/// 按播放模式切到下一首。`auto` = 自然播完触发。
/// Device/IO effects for the same automatic mutation delivered by the real inbox.
fn handle_automatic_playback(
    inner: &mut EngineInner, advance: super::playback_commit::AutomaticAdvance,
    request: Option<SourceLoadRequest>,
) {
    if let Some(track) = advance.track {
        inner.queue_emit();
        invalidate_preload(inner);
        let _ = inner.listen.before_load(&track);
        inner.play_target = Some(advance.target);
        inner.play_mount = None;
        let quality = effective_quality_for(inner, &track);
        inner.mutate(|state| state.quality = quality);
        if let Some(request) = request { spawn_prepared_source_load(inner, request); }
        inner.persist_queue();
    } else {
        inner.sink.clear();
        inner.current_shared = None;
        inner.current_progress = None;
        *inner.cache_file.lock().unwrap_or_else(|e| e.into_inner()) = None;
        inner.publish();
        if advance.sleep_fired {
            inner.sleep_after_track = false;
            inner.sleep_deadline = None;
            let _ = inner.app.emit("sleep-timer-fired", ());
            inner.persist_state();
        }
    }
}

fn advance(inner: &mut EngineInner, auto: bool) {
    // 切歌即这次收听的结束：先按真实收听结算（auto = 自然播完，算一次完播）。
    // 放在最前面，睡眠定时「播完停止」那条提前 return 的路径才不会被漏掉。
    inner.settle_listen(auto, true);
    if auto {
        if let Some(original) = &inner.current_mount {
            if !inner.eof_queued {
                inner.eof_queued = true;
                inner.owner.source_finished(original.clone());
            }
            // Retain the original even on rejection: never fall back on a later tick.
            return;
        }
    }
    // 睡眠定时「播完当前曲目后停止」：只在自然播完时消费，手动切歌不受影响
    if auto && inner.sleep_after_track {
        inner.sleep_after_track = false;
        inner.sleep_deadline = None;
        inner.sink.clear();
        inner.current_shared = None;
        inner.current_progress = None;
        *inner.cache_file.lock().unwrap_or_else(|e| e.into_inner()) = None;
        inner.mutate(|st| {
            st.status = PlaybackStatus::Stopped;
            st.position_ms = st.duration_ms;
            st.sleep_timer_ms = None;
            st.sleep_after_track = false;
        });
        let _ = inner.app.emit("sleep-timer-fired", ());
        inner.persist_state();
        return;
    }
    let mode = inner.state.read().unwrap_or_else(|e| e.into_inner()).play_mode;
    let next = {
        let q = inner.queue.lock().unwrap_or_else(|e| e.into_inner());
        q.next_index_skipping(mode, auto, |t| inner.dislikes.matches(t))
    };
    log::debug!("[queue] advance(auto={auto}, mode={mode:?}) -> {next:?}");
    match next {
        Some(i) => {
            let track = {
                let mut q = inner.queue.lock().unwrap_or_else(|e| e.into_inner());
                q.commit_index(i);
                q.current().cloned()
            };
            inner.sync_queue_to_snapshot();
            inner.queue_emit();
            if let Some(track) = track {
                play_queue_track(inner, track);
            }
            inner.persist_queue();
        }
        None => {
            if auto {
                // 自然播完却算不出下一首：随机模式下除了当前这首全被屏蔽（列表循环
                // 永远能绕回开头，不会走到这里）。停下并保留最后一曲信息。
                inner.sink.clear();
                inner.current_shared = None;
                inner.current_progress = None;
                *inner.cache_file.lock().unwrap_or_else(|e| e.into_inner()) = None;
                inner.mutate(|st| {
                    st.status = PlaybackStatus::Stopped;
                    st.position_ms = st.duration_ms;
                });
            } else {
                // 手动 next 无下一首（空队列）：保持现状继续播。会话在上面结算过，
                // 重开一段继续记账，不因为一次空操作丢掉后面的收听。
                inner.reopen_listen();
            }
        }
    }
}

/// 自动切歌熔断阈值：连续失败这么多首（每首失败计一次，成功挂载播放清零）
/// 就关闭 auto_next 并发系统通知，防止死歌队列一首接一首白等取链无限空转。
const FAIL_STREAK_LIMIT: u32 = 5;

/// 文件超出单曲缓冲上限（`range_reader::MAX_BUFFER_BYTES`）时给用户的整条文案。
///
/// 不套「该歌曲暂时无法播放（…）」的壳：那不是暂时故障，重取地址/换源/等一会儿
/// 都不会改变文件长度。见 `LoadJob::run` 里的 `is_buffer_limit_error` 短路。
const MSG_FILE_TOO_LARGE: &str = "该歌曲文件过大，暂不支持在线播放";

/// 弱网原地重试：首次失败后等这么久再试**同一首**（指数退避，封顶见下）。
const STALLED_RETRY_BASE_MS: u64 = 3_000;
/// 弱网连续重试上限：超过就不再自动重试（避免网络长时间不可用时空转）。
const STALLED_RETRY_LIMIT: u32 = 3;
/// 弱网重试的退避封顶。
const STALLED_RETRY_MAX_MS: u64 = 20_000;

// ---------- 位置冻结看门狗（2026-10-03「播到一半卡死」修复） ----------

/// 位置冻结的正常判定窗口。
///
/// **必须大于 `range_reader::FIRST_PACKET_TIMEOUT`（8s）**：解码发生在 cpal 回调
/// 线程里，等网络数据时回调会阻塞在 `HttpRangeReader::read` 上（单次上限 8s），
/// 那段时间位置本来就不会动 —— 窗口比它短会把「正常的网络等待」误判成死流。
const STALL_POS_TIMEOUT: Duration = Duration::from_secs(12);
/// 已判明输出流出过事（cpal 流错误 / 回调线程 panic）后的加速窗口。
/// 仍取 8s：一次正常的阻塞读可能就要等满 8s，不能再短。
const STALL_DEAD_TIMEOUT: Duration = Duration::from_secs(8);
/// 冻结恢复的尝试上限：命中 1 次软重载、2 次重建输出流、3 次放弃。
const STALL_RECOVER_LIMIT: u32 = 3;

/// 播放位置冻结看门狗状态。
///
/// rodio 0.22 的样本拉取发生在 cpal 音频回调线程里，于是「回调线程死了」与
/// 「解码器卡住」在引擎侧是**同一个症状**：墙上时钟在走、`get_pos()` 不动、
/// `sink.empty()` 永远 false。唯一可靠的判据只有「位置多久没变了」。
#[derive(Default)]
pub struct StallWatch {
    /// 上次观测到的位置与观测时刻；None = 还没有基准（离开 Playing 后重建）
    probe: Option<(u64, Instant)>,
    /// 连续冻结命中次数：位置一推进就清零（恢复阶梯要跨重载延续，见 reset）
    hits: u32,
    /// 输出流已报错/回调线程已 panic，且**此后没有再产出过样本**。
    /// 置位后判定窗口缩短，并跳过软重载（没有回调来拉新源，软重载是白费）。
    /// 唯一的清除方式：位置真的又推进了（poll 里），或用户手动发起播放（clear）。
    dead: bool,
}

impl StallWatch {
    /// 判定窗口：报过错的流用 8s，正常流用 12s
    fn window(&self) -> Duration {
        if self.dead {
            STALL_DEAD_TIMEOUT
        } else {
            STALL_POS_TIMEOUT
        }
    }

    /// 离开 Playing（Loading / Paused / Stopped / Error）时重建窗口基准。
    /// **不清 hits、不清 dead** —— 恢复阶梯必须跨「重载 → Loading → Playing」延续，
    /// 清掉就变成「无限软重载」。
    fn reset(&mut self) {
        self.probe = None;
    }

    /// 用户手动发起播放：整条管线给一次干净判定（连 hits 一起清）。
    fn clear(&mut self) {
        *self = Self::default();
    }

    /// 输出流报错 / 回调线程 panic。
    /// `fatal` 时把 hits 预置到 1，让下一次命中直接落到「重建输出流」——
    /// 回调线程已经死掉的情况下软重载纯属浪费一个窗口。
    fn mark_dead(&mut self, fatal: bool) {
        self.dead = true;
        if fatal && self.hits == 0 {
            self.hits = 1;
        }
    }

    /// 录入一次观测。返回 `Some(hits)` = 已判定冻结并已消费窗口（调用方去做恢复）。
    fn poll(&mut self, pos_ms: u64, now: Instant) -> Option<u32> {
        match self.probe {
            // 位置变了（前进，或用户往回拖）→ 管线是活的
            Some((last, _)) if pos_ms != last => {
                self.probe = Some((pos_ms, now));
                self.hits = 0;
                self.dead = false;
                None
            }
            Some((_, at)) if now.duration_since(at) >= self.window() => {
                self.hits += 1;
                self.probe = Some((pos_ms, now));
                Some(self.hits)
            }
            Some(_) => None,
            None => {
                // 首次观测只建基准：不知道位置静止了多久，不能立刻开火
                self.probe = Some((pos_ms, now));
                None
            }
        }
    }
}

/// 弱网原地重试同一首（2026-10-03 弱网修复）。
///
/// 与 `skip_if_recoverable` 的根本区别：**不换歌、不计入熔断**。
/// 取链等待超时是环境问题（弱网/引擎卡），换一首大概率同样超时 ——
/// 过去正是「换 5 首 → 打满熔断 → 自动切歌关死」把弱网放大成永久不可用。
/// 这里改成等网络缓一会儿再试同一首，弱网下的真实体验从「连跳 5 首后停摆」
/// 变成「这一首多等几秒」。
///
/// 退避且限次：网络长时间不可用时不会无限空转；`stall_retry` 达到上限后
/// 停在错误态等用户操作（此时不拉黑本首，用户手动播即可再试）。
fn schedule_stalled_retry(inner: &mut EngineInner, track_id: &str) {
    let attempt = inner.stall_retry;
    if attempt >= STALLED_RETRY_LIMIT {
        log::warn!(
            "[queue] 曲目 {track_id} 连续{STALLED_RETRY_LIMIT}次因网络超时，已停止自动重试"
        );
        return;
    }
    let delay = STALLED_RETRY_BASE_MS.saturating_mul(1u64 << attempt).min(STALLED_RETRY_MAX_MS);
    inner.stall_retry = attempt + 1;
    log::debug!("[queue] 网络较慢，{delay}ms 后重试同一首（{}/{STALLED_RETRY_LIMIT}）", attempt + 1);

    // 重试要走引擎命令通道（load_queue_track 需要 &mut EngineInner），
    // 且必须带代次：延迟期间用户可能已切歌/暂停，到时由 gen 不匹配丢弃。
    let tx = inner.tx.clone();
    let id = track_id.to_string();
    let gen = inner.load_gen;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        let _ = tx.send(AudioCmd::StalledRetry {
            track_id: id,
            gen,
        });
    });
}

/// 熔断后的恢复探测：网络/音源恢复时自动重开自动切歌。
///
/// 过去熔断是单向门——只有用户手动播歌才会重开（`Play`/`SetQueue`/`PlayAt`
/// 里的 `auto_next = true`）。用户反馈「网络一差整晚都放不回来」正是这条：
/// 网络在 20:24 恢复，但 20:16 已经熔断，没人操作就永远停在错误态。
///
/// 这里挂一个后台探测：按 `RECOVERY_PROBE_BASE_MS` 起指数退避，探测到
/// 取链成功（真拿到地址）就重开 `auto_next` 并把当前曲重新拉起来。
/// 探测本身是**真的取一次链**，不是空转计时器——判据可靠，也顺带验证恢复。
const RECOVERY_PROBE_BASE_MS: u64 = 15_000;
const RECOVERY_PROBE_MAX_MS: u64 = 120_000;
/// 恢复探测的尝试上限：超过就彻底交给用户（避免长期不可用时反复取链）。
const RECOVERY_PROBE_LIMIT: u32 = 8;

fn schedule_recovery_probe(inner: &EngineInner) {
    let app = inner.app.clone();
    let tx = inner.tx.clone();
    let cache = Arc::clone(&inner.url_cache);
    let queue = Arc::clone(&inner.queue);
    let track = queue.lock().unwrap_or_else(|e| e.into_inner()).current().cloned();
    let Some(track) = track else {
        return;
    };
    let quality = inner.state.read().unwrap_or_else(|e| e.into_inner()).quality.clone();
    tauri::async_runtime::spawn(async move {
        let mut delay = RECOVERY_PROBE_BASE_MS;
        for attempt in 1..=RECOVERY_PROBE_LIMIT {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            // 探测：真取一次链。成功说明网络与音源都回来了。
            let probe =
                crate::resolve_play_url_script(&app, &cache, &track, quality.clone()).await;
            if probe.is_ok() {
                let _ = tx.send(AudioCmd::Recovered { gen: 0 });
                log::debug!("[queue] 第{attempt}次恢复探测成功，重开自动切歌");
                return;
            }
            delay = (delay * 2).min(RECOVERY_PROBE_MAX_MS);
        }
        log::warn!("[queue] 恢复探测 {RECOVERY_PROBE_LIMIT} 次仍未成功，等待用户手动播放");
    });
}

/// 发系统通知（Windows toast 等）。自动切歌熔断发生在后台，应用内错误条看不到。
/// 未安装/未初始化通知插件时 show() 返回 Err，静默忽略即可。
fn notify_failure(app: &tauri::AppHandle, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title("轻听").body(body).show();
}

/// 播放失败后的恢复策略：仍处于「应当继续播放」的语义（自动切歌 / 在播时换曲）
/// 且队列里还有没失败过的曲目，就跳过当前这首继续播；全部失败则停下 ——
/// 否则整个队列都播不出来时会无限互相跳过。
///
/// 这里刻意不走 `advance`：单曲循环 / 列表循环会算回当前这首，
/// 对一首坏歌会形成「失败 → 重试同一首」的死循环。改成向前扫描第一个
/// 没失败过的曲目；找不到就停。
fn skip_if_recoverable(inner: &mut EngineInner, track_id: &str, autoplay: bool) {
    inner.failed_tracks.insert(track_id.to_string());
    let (len, cur) = {
        let q = inner.queue.lock().unwrap_or_else(|e| e.into_inner());
        (q.len(), q.index)
    };
    if !autoplay || len <= 1 {
        return;
    }
    let Some(cur) = cur else {
        return;
    };

    let mut target: Option<usize> = None;
    for offset in 1..=len {
        let i = (cur + offset) % len;
        let id = inner
            .queue
            .lock()
            .unwrap()
            .tracks
            .get(i)
            .map(|t| t.id.clone());
        if let Some(id) = id {
            if !inner.failed_tracks.contains(&id) {
                target = Some(i);
                break;
            }
        }
    }

    let Some(i) = target else {
        log::warn!("[queue] 队列内 {len} 首均播放失败，停止自动跳过");
        // 播放条只显示最后一首的单曲错误，用户不知道全队都挂了；这里覆盖成
        // 聚合文案（PlayerBar 的 error 展示位直接显示）
        inner.mutate(|st| {
            st.error = Some(format!("队列内 {len} 首均无法播放，请检查音源或稍后重试"))
        });
        return;
    };
    log::debug!("[queue] 曲目 {track_id} 失败，跳过到队列第 {} 首", i + 1);

    let track = {
        let mut q = inner.queue.lock().unwrap_or_else(|e| e.into_inner());
        q.commit_index(i);
        q.current().cloned()
    };
    inner.sync_queue_to_snapshot();
    inner.queue_emit();
    if let Some(track) = track {
        play_queue_track(inner, track);
    }
    inner.persist_queue();
}

/// 位置冻结看门狗（2026-10-03「播到一半卡死、无任何报错」修复）。
///
/// 只在 Playing 时调用。命中后按软 → 硬阶梯恢复：
/// ① `load_queue_track` 软重载（换新连接、不动输出流）
/// ② `rebuild_output` 重建输出流（回调线程已死时的唯一出路，也会重建 Player 状态）
/// ③ 放弃：置错误态 + 系统通知，等用户操作（不再是无声无息地钉死）
///
/// ②会 drop 旧的 cpal `Stream`，而 cpal 的 `Drop` 会 `join` 流线程 —— 若回调正卡在
/// 网络读上，引擎线程会被短暂阻塞（上限 = `FIRST_PACKET_TIMEOUT` 8s）。回调线程已经
/// panic 死掉时 join 立即返回，也就是**最需要重建的那种情况不会阻塞**。
fn watch_pipeline(inner: &mut EngineInner) {
    let window = inner.watch.window();
    let frozen_ms = content_pos_ms(inner);
    let Some(hits) = inner.watch.poll(frozen_ms, Instant::now()) else {
        return;
    };
    let Some(track) = inner.queue.lock().unwrap_or_else(|e| e.into_inner()).current().cloned() else {
        log::warn!("[watchdog] 播放位置冻结在 {frozen_ms}ms，但队列为空，跳过恢复");
        return;
    };

    if hits >= STALL_RECOVER_LIMIT {
        // 软重载 + 重建输出流都没救回来：停在错误态并发系统通知（后台播放时
        // 应用内错误条看不见），用户手动播一次即重新走一遍完整链路。
        let notice = format!(
            "播放卡住（位置停在 {}s）且自动恢复失败，请重新播放",
            frozen_ms / 1000
        );
        log::error!("[watchdog] {notice}");
        inner.watch.clear();
        inner.mutate(|st| {
            st.status = PlaybackStatus::Error;
            st.error = Some(notice.clone());
        });
        notify_failure(&inner.app, &notice);
        return;
    }

    if hits == 1 {
        log::warn!(
            "[watchdog] 播放位置停在 {frozen_ms}ms 已 {}s 未推进，重走加载链（软恢复）track={}",
            window.as_secs(),
            track.id
        );
        // start_ms 用冻结位置：救回来之后就地从原进度续播，不用用户重听
        load_queue_track(inner, track, true, frozen_ms);
        return;
    }

    log::warn!(
        "[watchdog] 软恢复后位置仍未推进，重建输出流（音频回调线程疑似已死）track={}",
        track.id
    );
    let choice = inner.output_choice.clone();
    if let Err(e) = inner.rebuild_output(choice.as_deref()) {
        // 重建失败不在这里重试：下一个窗口（hits=3）会走放弃分支
        log::error!("[watchdog] 重建输出流失败: {e}");
    }
}

fn go_previous(inner: &mut EngineInner) {
    let mode = inner.state.read().unwrap_or_else(|e| e.into_inner()).play_mode;
    let prev = {
        let mut q = inner.queue.lock().unwrap_or_else(|e| e.into_inner());
        q.previous_index(mode).map(|i| {
            q.commit_index(i);
            q.current().cloned()
        })
    };
    inner.sync_queue_to_snapshot();
    inner.queue_emit();
    if let Some(Some(track)) = prev {
        play_queue_track(inner, track);
    }
    inner.persist_queue();
}

// ---------- 听歌统计：共享实例生命周期（DESIGN §5.3） ----------

impl EngineInner {
    /// 曲目挂载成功 = 收听会话开始。
    ///
    /// 同一首的**重载**（弱网原地重试 / 启动恢复现场 / 输出流重建续播）不重开会话：
    /// 那还是同一次收听，重开会让「听了一半」永远攒不够有效播放的门槛。
    fn begin_listen(&mut self, track: &Track, duration_ms: u64) -> super::listening::ListenMount {
        let pos = self.state.read().unwrap_or_else(|e| e.into_inner()).position_ms;
        self.listen.begin_mount(track, duration_ms, pos)
    }

    /// 位置 tick 里累计收听：只有位置**在推进**时才按墙钟时间记账。
    /// 暂停（位置冻结）不计；seek 跳变（一步推进过大）不计；倍速无关（按墙钟算）。
    fn accrue_listen(&mut self, pos_ms: u64) {
        let _ = self.listen.accrue(pos_ms);
    }

    /// 结算收听。`finished` = 自然播完；`end` = 会话就此结束（切歌 / 停止）。
    ///
    /// 可反复调用：只有没落过库的增量会被写（pending 清零、两个旗标各管一次 +1），
    /// 所以「每 30 秒落一次 + 暂停时落一次 + 结束时落最后一次」不会重复计数。
    fn settle_listen(&mut self, finished: bool, end: bool) {
        let _ = self.listen.settle(finished, end);
    }

    /// 结算后仍在播同一首（手动 next 却没有下一首）：重开一段会话，
    /// 尾巴上的收听照常计入，不因为一次空操作丢掉。
    fn reopen_listen(&mut self) {
        let track = self
            .queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .current()
            .cloned();
        let Some(track) = track else {
            return;
        };
        let duration_ms = self
            .state
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .duration_ms;
        self.begin_listen(&track, duration_ms);
    }
}

/// 异步取播放地址（内存缓存 10 分钟）+ 构建解码器，完成后回发 LoadReady。
///
/// 取址在 tokio 任务、构建（HTTP open + 首包探测）在 blocking 线程池：
/// 引擎线程不做任何网络/阻塞 IO。休眠唤醒后旧 TCP 连接是半死的，每个
/// 请求都要挂满超时才报错 —— 若让引擎线程亲自 open，所有播放控制命令
/// （切歌/暂停）会排队等到超时链走完，表现为「卡死几分钟」。
///
/// 失败：取址失败作废缓存重取一次（§7.3）；打开流失败同样作废缓存重开一次
/// （休眠唤醒后缓存的签名 URL 过期 / 半死连接是常态）；仍失败回发 LoadFailed。
fn spawn_resolve_and_load(
    inner: &mut EngineInner,
    track: Track,
    autoplay: bool,
    start_ms: u64,
    gen: u64,
) {
    let Some(request) = inner.owner.prepare_source_load(
        track, inner.play_target.clone(), inner.play_mount.take(), gen, autoplay, start_ms,
    ) else { return; };
    spawn_prepared_source_load(inner, request);
}

fn spawn_prepared_source_load(inner: &mut EngineInner, request: SourceLoadRequest) {
    if let Some(remote) = &mut inner.remote {
        remote.connection.begin_load(request.gen, request.autoplay);
        remote.loaded = false;
        if let Some(request) = remote.pending_seek.take() { request.external_complete(false); }
    }
    let cast = inner.remote.as_ref().map(|remote| remote.connection.state());
    if cast.is_some() { inner.mutate(|state| state.cast = cast); }
    let job = LoadJob {
        app: inner.app.clone(),
        tx: inner.tx.clone(),
        cache: Arc::clone(&inner.url_cache),
        cache_dir: inner.cache_dir.clone(),
        history_db: inner.db.clone(),
        quality: inner.state.read().unwrap_or_else(|e| e.into_inner()).quality.clone(),
        target: request.target,
        port: request.port,
        track: request.track,
        autoplay: request.autoplay,
        start_ms: request.start_ms,
        gen: request.gen,
        preload: false,
        remote: inner.remote.as_ref().map(|remote| remote.connection.clone()),
    };
    tauri::async_runtime::spawn(job.run());
}

/// 一次「取址 → 构建解码器 → 回发引擎」的全部上下文。
struct LoadJob {
    app: tauri::AppHandle,
    tx: Sender<AudioCmd>,
    cache: Arc<PlayUrlCache>,
    cache_dir: PathBuf,
    history_db: Option<Arc<Database>>,
    quality: types::Quality,
    target: Option<PlayTarget>,
    port: Option<Arc<super::render_control::SourceSeekPort>>,
    track: Track,
    autoplay: bool,
    start_ms: u64,
    gen: u64,
    preload: bool,
    remote: Option<crate::dlna::Connection>,
}

/// 异步自递归的断环点：`LoadJob::run` 内部会为在线替身再起一个
/// `LoadJob`（见 run() 的 `Substitute::Online` 分支）。若在 run() 里直接
/// `spawn(job.run())`，匿名 generator 类型会在自己内部再包含自己，
/// rustc 无法证明其 `Send`（E0283）。抽成普通同步函数后，`Gen: Send`
/// 的检查脱离任何生成器作用域独立完成，类型递归被打断。
fn spawn_load_job(job: LoadJob) {
    tauri::async_runtime::spawn(job.run());
}

impl LoadJob {
    async fn dispatch_remote(self, source: PlaySource) {
        let Some(connection) = self.remote.clone() else { return; };
        let session_id = connection.id;
        let track = self.track.clone();
        let gen = self.gen;
        let start_ms = self.start_ms;
        let retryable = matches!(&source, PlaySource::Online { .. }) && !self.track.platform.is_podcast();
        let first_connection = connection.clone();
        let mut result = tauri::async_runtime::spawn_blocking(move ||
            first_connection.load(gen, source, &track, start_ms)).await
            .map_err(|error| error.to_string()).and_then(|result| result);
        if retryable && connection.matches(session_id, gen)
            && result.as_ref().is_err_and(|error| error.starts_with("媒体地址不可读取"))
        {
            self.cache.invalidate(&PlayUrlCache::cache_key(self.track.platform.as_str(), &self.track.id, crate::quality_str(&self.quality)));
            match crate::resolve_play_url_script(&self.app, &self.cache, &self.track, self.quality.clone()).await {
                Ok(hit) => {
                    let source = PlaySource::Online { url: hit.url, fetchedAt: hit.fetched_at, referer: hit.referer };
                    let track = self.track.clone();
                    result = tauri::async_runtime::spawn_blocking(move ||
                        connection.load(gen, source, &track, start_ms)).await
                        .map_err(|error| error.to_string()).and_then(|result| result);
                }
                Err(error) => result = Err(format!("重新获取投屏地址失败：{error}")),
            }
        }
        let request = SourceLoadRequest {
            target: self.target, port: self.port, track: self.track,
            autoplay: self.autoplay, start_ms: self.start_ms, gen: self.gen,
        };
        let _ = self.tx.send(AudioCmd::DlnaLoaded(Box::new(dlna_adapter::LoadResult { session_id, request, result })));
    }
    async fn run(self) {
        // 本地曲目：Track.id 即文件绝对路径，无需 Provider 取址（DESIGN §13）。
        // 文件不在了（被移动/改名/删除——收藏死条目的主要来源）时走替身链
        // （DESIGN §7.13）：池 A 本地曲库 → 池 B 账本/孤儿 → 池 C 前端搜索，
        // 顶上一首接着播。预热任务不找替身（投机加载，真点播时才值得找）；
        // 总开关关（play.localFirst=false，find_local_substitute 内部查）
        // 也直接按原样失败。
        // 播客单集（B9）：Track.id 就是 RSS 里给出的音频直链，平台记为
        // `podcast`（见 provider::types::PODCAST_SOURCE）。这里直接当在线流
        // 交给 range_reader —— 边播边缓存、可 seek，正是播客需要的行为。
        //
        // 不走 `resolve_play_url_script`：那不是用户订阅的音源包，没有换源顺序，
        // 也不该进熔断/黑名单（一次网络抖动就把整档节目拉黑是不可接受的）。
        // `referer` 留空串即「不发 Referer」，直链不需要防盗链头。
        if self.track.platform.is_podcast() && self.track.id.starts_with("http") {
            let fetched_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            log::debug!("[queue] podcast episode track={}", self.track.id);
            let source = PlaySource::Online {
                url: self.track.id.clone(),
                fetchedAt: fetched_at,
                referer: String::new(),
            };
            self.build_and_dispatch(source, false, Some(fetched_at)).await;
            return;
        }

        if self.track.platform.is_local() {
            let path = crate::cue::strip_cue_suffix(&self.track.id).to_string();
            if std::path::Path::new(&path).exists() {
                log::debug!("[queue] local track path={}", self.track.id);
                self.build_and_dispatch(PlaySource::Local { path }, true, None)
                    .await;
                return;
            }
            log::warn!("[queue] 本地文件不存在，尝试替身链: {path}");
            if let Some(db) = self.history_db.clone() {
                if !self.preload {
                    match crate::local_first::find_local_substitute(&self.app, &db, &self.track)
                        .await
                    {
                        Some(crate::local_first::Substitute::Local { track, kind }) => {
                            log::info!(
                                "[queue] 替身链命中（{kind}）：{} -> {}",
                                self.track.id,
                                track.id
                            );
                            // 只换本次播放，不改收藏（用户定案 2026-10-28）。
                            let file = track.id.clone();
                            self.build_and_dispatch(PlaySource::Local { path: file }, true, None)
                                .await;
                            return;
                        }
                        Some(crate::local_first::Substitute::Online { track }) => {
                            log::info!(
                                "[queue] 替身链命中在线替身：{} -> {}:{}",
                                self.track.title,
                                track.platform.as_str(),
                                track.id
                            );
                            // 在线替身按一次新的 LoadJob 走完整在线链
                            //（取链→构建→回发，失败提示也复用）；gen/tx 对引擎
                            // 侧就是同一次换歌，行为与原曲目在线播完全一致。
                            // 必须经 spawn_load_job 间接递归：run() 里直接
                            // spawn(job.run()) 是异步自递归，匿名 future 类型
                            // 无限自嵌，rustc 证不出 Send（E0283）；经同步
                            // 函数转一道后，Send 检查脱离生成器作用域，
                            // 环被断开。
                            let job = LoadJob {
                                app: self.app.clone(),
                                tx: self.tx.clone(),
                                cache: Arc::clone(&self.cache),
                                cache_dir: self.cache_dir.clone(),
                                history_db: self.history_db.clone(),
                                quality: self.quality.clone(),
                                target: self.target.clone(),
                                port: self.port.clone(),
                                track,
                                autoplay: self.autoplay,
                                start_ms: 0,
                                gen: self.gen,
                                preload: self.preload,
                                remote: self.remote.clone(),
                            };
                            spawn_load_job(job);
                            return;
                        }
                        None => {
                            log::info!("[queue] 替身链无替身，按本地文件缺失失败: {path}");
                        }
                    }
                }
            }
            self.dispatch_failed_message("load", format!("本地文件不存在：{path}"), false);
            return;
        }

        // 本地优先解析链（DESIGN §7.13）：在线歌播之前先全本地找一遍文件
        //（① 账本 → ② done 任务 → ④ 孤儿索引 → ⑤ 本地曲库，见
        // local_first.rs），命中且文件在就直接当本地文件播——断网、播放地址
        // 失效都不影响，下载/导入的文件才算真正闭环（§5.3 下载 2.0 的扩展）。
        // 总开关 `play.localFirst=false` 时整段跳过（find_online_local_file
        // 内部查库）：用户要在线高音质时不能被本地文件截和（连老的
        // 「已下载文件离线播」一起关）。
        if let Some(db) = self.history_db.clone() {
            if let Some(hit) = crate::local_first::find_online_local_file(&db, &self.track).await
            {
                log::debug!(
                    "[queue] 本地优先解析链命中（{}）：{} -> {}",
                    hit.kind,
                    self.track.id,
                    hit.path
                );
                self.build_and_dispatch(PlaySource::Local { path: hit.path }, true, None)
                    .await;
                return;
            }
        }

        // 取链（脚本线路）：缓存命中直接用（前端切歌时预解析回填）；未命中经
        // playurl_bridge 问前端脚本包，前端按「换源顺序」跨源解析后回填缓存。
        // 原生 Rust Provider 已删除，前端脚本线路是唯一的第三方取链路径。
        let resolved = crate::resolve_play_url_script(
            &self.app,
            &self.cache,
            &self.track,
            self.quality.clone(),
        )
        .await;
        match resolved {
            Ok(hit) => {
                let url = hit.url;
                let referer = hit.referer;
                let fetched_at = hit.fetched_at;
                // 取链侧已经用 Range 探到了文件真实长度，这是播放条显示"实际码率"
                // 的一条来源（分块传输的流自己读不到 Content-Length），别在这里丢掉。
                let size_bytes = hit.size;
                log::debug!(
                    "[queue] resolve ok track={} url_host={}",
                    self.track.id,
                    url.split("//")
                        .nth(1)
                        .unwrap_or("")
                        .split('/')
                        .next()
                        .unwrap_or("")
                );
                let play_url = url.clone();
                let source = PlaySource::Online {
                    url,
                    fetchedAt: fetched_at,
                    referer,
                };
                if self.remote.is_some() {
                    self.dispatch_remote(source).await;
                    return;
                }
                match self.try_build(&source).await {
                    Ok(built) => self.dispatch_ready(
                        built,
                        false,
                        Some(fetched_at),
                        Some(play_url),
                        size_bytes,
                    ),
                    Err(first_err) => {
                        // 文件本身就超出单曲缓冲上限：这不是地址问题 —— 重取地址、
                        // 换线路都改变不了文件长度，白跑一轮还会把这首的地址缓存
                        // 白白作废。直接按内容问题报错，给一句看得懂的提示。
                        if range_reader::is_buffer_limit_error(&first_err) {
                            log::warn!(
                                "[queue] 曲目 {} 文件超出单曲缓冲上限，跳过重取: {first_err}",
                                self.track.id
                            );
                            self.dispatch_failed_message(
                                "load",
                                MSG_FILE_TOO_LARGE.to_string(),
                                false,
                            );
                            return;
                        }
                        // 打开流失败最常见两种：休眠唤醒后的半死连接、缓存的
                        // 签名 URL 已过期 —— 作废缓存重取一次再打开，仍失败才算真失败
                        log::warn!("[queue] 打开音频流失败（{first_err}），作废缓存 URL 重取一次");
                        let key = PlayUrlCache::cache_key(
                            self.track.platform.as_str(),
                            &self.track.id,
                            crate::quality_str(&self.quality),
                        );
                        self.cache.invalidate(&key);
                        match crate::resolve_play_url_script(
                            &self.app,
                            &self.cache,
                            &self.track,
                            self.quality.clone(),
                        )
                        .await
                        {
                            Ok(hit2) => {
                                let url2 = hit2.url;
                                let referer2 = hit2.referer;
                                let fetched_at2 = hit2.fetched_at;
                                let size_bytes2 = hit2.size;
                                let source2 = PlaySource::Online {
                                    url: url2.clone(),
                                    fetchedAt: fetched_at2,
                                    referer: referer2,
                                };
                                match self.try_build(&source2).await {
                                    Ok(built2) => self.dispatch_ready(
                                        built2,
                                        false,
                                        Some(fetched_at2),
                                        Some(url2),
                                        size_bytes2,
                                    ),
                                    Err(e2) => self.dispatch_load_failed(
                                        "load",
                                        &format!("打开音频流失败: {first_err}；重取后仍失败: {e2}"),
                                        // 两次开流都失败：地址拿到了却读不出流，属内容/
                                        // 死链问题（拉黑这首），不算环境问题
                                        false,
                                    ),
                                }
                            }
                            Err(e2) => self.dispatch_load_failed(
                                "load",
                                &format!("打开音频流失败: {first_err}；重取播放地址失败: {e2}"),
                                // 重取时若等链超时，说明弱网仍在延续 —— 按环境问题处理，
                                // 不把这首拉黑（否则弱网批量歌曲被永久列黑名单）
                                e2.is_stalled(),
                            ),
                        }
                    }
                }
            }
            Err(e) => {
                // 弱网（Stalled）与「音源没这首」（NoPlayableUrl）分开走：
                // 前者不拉黑本首、不计熔断，只提示网络慢并原地重试。
                let stalled = e.is_stalled();
                if stalled {
                    log::warn!("[queue] 取链等待超时（环境问题，不计入熔断）: {e}");
                } else {
                    log::error!("自动取址失败: {e}");
                }
                self.dispatch_load_failed("resolve", &format!("{e}"), stalled);
            }
        }
    }

    /// 在 blocking 线程池里构建解码器（HTTP open + 首包探测都是阻塞 IO）。
    async fn try_build(&self, source: &PlaySource) -> Result<BuiltDecoder, String> {
        let cache_dir = self.cache_dir.clone();
        let track = self.track.clone();
        let source = source.clone();
        let start_ms = self.start_ms;
        tauri::async_runtime::spawn_blocking(move || {
            let http = audio_http_client();
            let mut built = build_decoder(&source, &http, &cache_dir, &track)?;
            if start_ms > 0 {
                let position = if built.duration_ms > 0 { start_ms.min(built.duration_ms) } else { start_ms };
                built.source.try_seek(Duration::from_millis(position))
                    .map_err(|error| format!("恢复进度失败: {error}"))?;
            }
            Ok(built)
        })
        .await
        .map_err(|e| format!("构建任务异常: {e}"))?
    }

    /// 构建并回发（本地/离线文件路径，不重试）。
    async fn build_and_dispatch(self, source: PlaySource, is_local: bool, fetched_at: Option<u64>) {
        if self.remote.is_some() {
            self.dispatch_remote(source).await;
            return;
        }
        // 本地文件 / 已下载文件的体积直接取文件长度（在线流由取链侧的探测结果带回来），
        // 播放条据此算实际码率 —— 本地无损和在线 128k 的差别是靠这个数看出来的。
        let size_bytes = match &source {
            PlaySource::Local { path } => std::fs::metadata(path).ok().map(|m| m.len()),
            PlaySource::Online { .. } => None,
        };
        match self.try_build(&source).await {
            Ok(built) => self.dispatch_ready(built, is_local, fetched_at, None, size_bytes),
            // 本地文件读不出来是内容问题，不算环境问题
            Err(e) => self.dispatch_load_failed("load", &e, false),
        }
    }

    /// 回发构建好的解码器。gen 与引擎当前代次不一致时引擎侧丢弃。
    fn dispatch_ready(
        self,
        built: BuiltDecoder,
        is_local: bool,
        fetched_at: Option<u64>,
        play_url: Option<String>,
        size_bytes: Option<u64>,
    ) {
        let request = SourceLoadRequest {
            target: self.target, port: self.port, track: self.track,
            autoplay: self.autoplay, start_ms: self.start_ms, gen: self.gen,
        };
        let _ = self.tx.send(request.ready_command(
            self.preload, built, is_local, fetched_at, play_url, size_bytes,
        ));
    }

    /// 回发失败：广播 audio-error + LoadFailed，由引擎统一置错误态并决定跳过。
    ///
    /// `stalled` = 本次失败只是环境问题（弱网/引擎卡），不是「这首歌坏了」。
    /// 引擎侧据此不把这首拉进 `failed_tracks`、不计入连续失败熔断。
    fn dispatch_load_failed(self, kind: &'static str, detail: &str, stalled: bool) {
        let message = load_failure_message(detail, stalled);
        self.dispatch_failed_message(kind, message, stalled);
    }

    /// 回发失败（整条文案由调用方给定）。
    ///
    /// 与 `dispatch_load_failed` 的差别只在文案：后者会把 `detail` 套进
    /// 「暂时无法播放」的壳，而这个壳暗示「过会儿再试可能就好了」。文件超出
    /// 单曲缓冲上限属于确定的放不了 —— 重取地址、换源、等一会儿都不会改变
    /// 文件长度，套那个壳只会让用户反复重试。`stalled` 仍然照传，引擎侧
    /// 据此决定是否拉黑、是否计入连续失败熔断。
    fn dispatch_failed_message(self, kind: &'static str, message: String, stalled: bool) {
        if let Some(connection) = self.remote {
            let request = SourceLoadRequest {
                target: self.target, port: self.port, track: self.track,
                autoplay: self.autoplay, start_ms: self.start_ms, gen: self.gen,
            };
            let _ = self.tx.send(AudioCmd::DlnaLoaded(Box::new(dlna_adapter::LoadResult {
                session_id: connection.id, request, result: Err(message),
            })));
            return;
        }
        if self.preload {
            log::debug!("[gapless] speculative load failed for {}: {message}", self.track.id);
            let _ = self.tx.send(AudioCmd::PreloadFailed { gen: self.gen });
            return;
        }
        // Original source receipts publish only after the actor's shared admission.
        // Keep the existing targetless/legacy notification path unchanged.
        if self.port.is_none() {
            let _ = self.app.emit(
                "audio-error",
                serde_json::json!({
                    "trackId": self.track.id,
                    "kind": kind,
                    "message": message,
                    "stalled": stalled,
                }),
            );
        }
        let request = SourceLoadRequest {
            target: self.target.clone(), port: self.port.clone(), track: self.track.clone(),
            autoplay: self.autoplay, start_ms: self.start_ms, gen: self.gen,
        };
        let _ = self.tx.send(request.failure_command(kind, message, stalled));
    }
}

/// 两次后台修剪的最小间隔：修剪本身很快，但每次换曲挂载都起一条 OS 线程
/// 纯属 churn；连点换曲的挂载风暴只需一次修剪兜底
const PRUNE_MIN_INTERVAL_MS: u64 = 5_000;
static LAST_PRUNE: std::sync::Mutex<Option<std::time::Instant>> =
    std::sync::Mutex::new(None);

/// 后台跑一遍缓存修剪（换曲挂载新流 / 上限调低 / 启动时都会调）：
/// 磁盘 IO 不进引擎线程，免得卡 25ms 的播放节拍。
/// 上限为 0（不限）时直接不做事；在播流的缓存文件经 cache_file 传入永不删。
fn spawn_cache_prune(inner: &EngineInner) {
    if inner.cache_limit_mb == 0 {
        return;
    }
    {
        let mut last = LAST_PRUNE.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(t) = *last {
            if t.elapsed() < std::time::Duration::from_millis(PRUNE_MIN_INTERVAL_MS) {
                return;
            }
        }
        *last = Some(std::time::Instant::now());
    }
    let dir = inner.cache_dir.clone();
    let limit = inner.cache_limit_mb;
    let keep = inner.cache_file.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let _ = std::thread::Builder::new()
        .name("cache-prune".into())
        .spawn(move || {
            let (freed, removed) = crate::cache::prune_audio_cache(&dir, limit, keep.as_deref());
            if removed > 0 {
                // 稳态下这行每次换曲都会出现：流缓存文件一落盘就是**全长**
                // （range_reader 按 Content-Length 预分配，见 open() 的 set_len），
                // 而 total 把删不掉的在播文件也算在内 —— 于是每次挂载新流都会把
                // 最旧的一个挤出去。不是异常，把口径一起打出来省得再被问一次。
                log::info!(
                    "[cache] 流缓存超出上限（{limit}MB），清理最旧的：释放 {freed} 字节 / {removed} 个文件"
                );
            }
        });
}

/// Cancel only the pending source; current audio remains on the same Player.
/// The activation CAS closes the race between a manual command and render pull.
fn invalidate_preload(inner: &mut EngineInner) {
    let progress = inner.preload.slot.as_ref()
        .and_then(|slot| slot.ready.as_ref()).map(|ready| Arc::clone(&ready.progress));
    if let Some(progress) = progress {
        if !progress.cancel_pending() {
            sync_gapless_transition(inner);
        }
    }
    let retired = inner.preload.slot.take();
    if let Some(ready) = retired.as_ref().and_then(|slot| slot.ready.as_ref()) {
        ready.binding.cancel();
    }
    drop(retired);
    inner.preload.gen = inner.preload.gen.wrapping_add(1);
}

/// 同一首曲目内预载失败的容忍次数：失败即作废槽位换目标重试（见
/// `AudioCmd::PreloadFailed`），超过这个次数就不再白试 —— 宁可到点现场取链，
/// 也不要每 25ms 反复拉一次注定失败的流。
const PRELOAD_RETRY_LIMIT: u32 = 2;

/// 预热闸门的输入：全是纯数据，逐条否决理由都可单测（见 `preload_gate_tests`）。
#[derive(Debug, Clone, Copy)]
struct PreloadFacts {
    gapless: bool,
    sleep_after_track: bool,
    auto_next: bool,
    has_slot: bool,
    pausing: bool,
    playing: bool,
    has_progress: bool,
    retries_left: bool,
}

/// `None` = 这一圈可以预热；`Some(理由)` = 不预热（理由同时用于调试日志与断言）。
fn preload_block(facts: PreloadFacts) -> Option<&'static str> {
    if !facts.gapless {
        return Some("gapless-off");
    }
    if facts.sleep_after_track {
        return Some("sleep-after-track");
    }
    if !facts.auto_next {
        return Some("auto-next-off");
    }
    if facts.has_slot {
        return Some("already-preloading");
    }
    if facts.pausing {
        return Some("pausing");
    }
    if !facts.playing {
        return Some("not-playing");
    }
    if !facts.has_progress {
        return Some("not-mounted");
    }
    if !facts.retries_left {
        return Some("retry-exhausted");
    }
    None
}

/// 预载下一首（无缝播放的「预热」）。
///
/// 触发点有三个，都要求「当前曲目已经加载完成」：挂载成功当场
/// （`mount_decoder` 末尾，不必等 25ms 的播放圈）、每条命令处理完之后
/// （`handle_cmd` 末尾，恢复播放 / 开关无缝也走这里），以及播放圈的常规巡检。
fn maybe_preload(inner: &mut EngineInner) {
    if inner.remote.is_some() { return; }
    let dislikes = &inner.dislikes;
    let Some(preload) = inner.owner.prepare_preload(
        &mut inner.preload,
        PreloadPrepare {
            flags: PreloadFlags {
                gapless: inner.gapless, sleep_after_track: inner.sleep_after_track,
                auto_next: inner.auto_next,
            },
            pausing: inner.pause_deadline.is_some(),
            current_progress: inner.current_progress.as_ref(),
            current_mount: inner.current_mount.as_ref(),
            target: inner.play_target.as_ref(),
            load_gen: inner.load_gen,
            quality: PreloadQuality {
                default_quality: &inner.default_quality,
                track_quality: &inner.track_quality,
                source_qualities: &inner.source_qualities,
            },
        },
        |track| dislikes.matches(track),
    ) else { return; };
    let PreloadRequest { request, quality } = preload;
    let job = LoadJob {
        app: inner.app.clone(), tx: inner.tx.clone(), cache: Arc::clone(&inner.url_cache),
        cache_dir: inner.cache_dir.clone(), history_db: inner.db.clone(), quality,
        target: request.target,
        port: request.port,
        track: request.track, autoplay: request.autoplay, start_ms: request.start_ms,
        gen: request.gen, preload: true,
        remote: None,
    };
    tauri::async_runtime::spawn(job.run());
}

impl AudioEngine {
    pub fn admit_started_preload(
        &self,
        started: StartedPreload,
        preload: &PreloadState,
        current_mount: Option<&Arc<super::render_control::SourceSeekPort>>,
        current_progress: Option<&Arc<SourceProgress>>,
        load_gen: &mut u64,
    ) -> Option<AdmittedPreload> {
        let binding = Arc::clone(&started.ready().binding);
        let result = (|| {
            let original_track = started.slot.original_track.clone();
            let original_progress = Arc::clone(&started.slot.original_progress);
            let original_mount = started.original_mount().cloned();
            let original_stamp = started.original_stamp().cloned();
            let original_target = started.slot.original_target.clone();
            let original_load_gen = started.original_load_gen();
            let (original_generation, native, next_load_gen) =
                match (&original_mount, &original_stamp, &original_target) {
                    (Some(port), Some(stamp), Some(target))
                        if stamp == port.stamp() && &stamp.target == target
                            && target.generation != 0
                            && target.matches_track(&original_track)
                            && Arc::ptr_eq(&original_progress, &port.progress()) =>
                    {
                        (target.generation, true, load_gen.wrapping_add(1))
                    }
                    (None, None, None) => (0, false, *load_gen),
                    _ => return None,
                };
            let mut next_target = if native {
                Some(PlayTarget::new(original_generation.checked_add(1)?, started.track()))
            } else { None };
            let owner = SourceControlOwner {
                core: self.core.clone(), mounts: Arc::downgrade(&self.source_mounts),
            };
            let mut pending = Some(started);
            self.core.gate().with_automatic(original_generation, native, |generation| {
                let queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
                let state = self.state.write().unwrap_or_else(|e| e.into_inner());
                let mut mounts = self.source_mounts.lock().unwrap_or_else(|e| e.into_inner());
                let candidate = pending.as_ref().expect("one original started preload");
                if preload.gen != candidate.slot.gen || preload.slot.is_some()
                    || *load_gen != original_load_gen
                    || !current_progress.is_some_and(|progress|
                        Arc::ptr_eq(progress, &original_progress))
                    || !Self::preload_queue_matches(&candidate.slot, &queue)
                    || !state.track.as_ref().is_some_and(|track| track.same_identity(&original_track))
                    || state.track_id.as_deref() != Some(original_track.id.as_str())
                    || !queue.tracks.get(candidate.slot.index)
                        .is_some_and(|track| track.same_identity(candidate.track()))
                { return None; }
                if native {
                    let original = original_mount.as_ref().expect("qualified native A");
                    let stamp = original_stamp.as_ref().expect("qualified original stamp");
                    if !current_mount.is_some_and(|port|
                        Arc::ptr_eq(port, original) && port.stamp() == stamp)
                        || !mounts.current.as_ref().is_some_and(|port|
                            Arc::ptr_eq(port, original) && port.stamp() == stamp)
                        || mounts.reserved.as_ref().is_some_and(|port|
                            !Arc::ptr_eq(port, original) || port.stamp() != stamp)
                        || next_target.as_ref().map(|target| target.generation) != Some(generation)
                    { return None; }
                    // Naturally finished A may already be retired; retain its original identity.
                    binding.try_bind_with(|progress| {
                        let stamp = super::render_control::MountStamp {
                            target: next_target.take().expect("the fixed prepared C target"),
                            mount_nonce: self.mount_nonce.fetch_add(1, Ordering::Relaxed).wrapping_add(1),
                        };
                        let port = super::render_control::SourceSeekPort::reserved_with_progress(
                            stamp, self.core.gate().clone(), owner, Arc::clone(progress),
                        );
                        port.set_speed(state.speed);
                        port.set_paused(state.status == PlaybackStatus::Paused);
                        port.arm();
                        let retired_current = mounts.current.replace(port.clone());
                        let retired_reserved = mounts.reserved.take();
                        *load_gen = next_load_gen;
                        let admitted = AdmittedPreload {
                            started: pending.take().expect("consume the actual qualified slot once"),
                            mount: Some(PreloadMount { stamp: port.stamp().clone(), port: port.clone() }),
                            accepted_generation: generation, accepted_load_gen: *load_gen,
                        };
                        (port, (admitted, retired_current, retired_reserved))
                    }).map(|(_same_published_port, result)| result)
                } else {
                    if generation != 0 || current_mount.is_some()
                        || mounts.current.is_some() || mounts.reserved.is_some()
                    { return None; }
                    binding.try_admit_unbound(|_| {
                        (AdmittedPreload {
                            started: pending.take().expect("consume the actual unbound slot once"),
                            mount: None, accepted_generation: 0, accepted_load_gen: *load_gen,
                        }, None, None)
                    })
                }
            })
        })();
        let Some((admitted, retired_current, retired_reserved)) = result else {
            binding.cancel();
            return None;
        };
        for retired in [retired_current, retired_reserved].into_iter().flatten() {
            retired.retire();
        }
        Some(admitted)
    }

    /// Consume the actual preload receipt; return all other commands untouched.
    /// Ok(true) means appended, Ok(false) means rejected by the original guards.
    /// Defer the concrete optional tap until acceptance, as in the original actor.
    pub fn append_preloaded(
        &self, cmd: AudioCmd, preload: &mut PreloadState, flags: PreloadFlags,
        render: PreloadRender<'_>,
        spectrum: impl FnOnce() -> Option<crate::audio::SpectrumTap>,
    ) -> Result<bool, Box<AudioCmd>> {
        let (track, decoder, shared, duration_ms, is_local, url_fetched_at,
            play_url, size_bytes, gen) = match cmd {
            AudioCmd::LoadReady {
                track, decoder, shared, duration_ms, is_local, url_fetched_at,
                play_url, size_bytes, gen, preload: true, ..
            } => (track, decoder, shared, duration_ms, is_local, url_fetched_at,
                play_url, size_bytes, gen),
            cmd => return Err(Box::new(cmd)),
        };
        if !flags.gapless || flags.sleep_after_track || !flags.auto_next {
            return Ok(false);
        }
        let Some(slot) = preload.slot.as_ref() else { return Ok(false); };
        if slot.gen != gen || slot.track.id != track.id || slot.track.platform != track.platform
            || slot.ready.is_some()
        {
            return Ok(false);
        }
        let valid = self.queue.lock().unwrap_or_else(|e| e.into_inner()).tracks.get(slot.index)
            .is_some_and(|item| item.id == track.id && item.platform == track.platform);
        if !valid { return Ok(false); }
        let bitrate_kbps = measured_bitrate_kbps(
            size_bytes.or_else(|| shared.as_ref().and_then(|shared| shared.total_len())), duration_ms,
        );
        let progress = Arc::new(SourceProgress::default());
        let source: Box<dyn Source + Send> = Box::new(DspSource::new(
            Box::new(TrackedSource::new(decoder, Arc::clone(&progress))),
            Arc::clone(render.fx), render.epoch, spectrum(),
        ));
        let (source, binding) = super::render_control::PreloadBinding::wrap(
            source, Arc::clone(&progress),
        );
        preload.slot.as_mut().unwrap().ready = Some(PreparedTrack {
            progress, binding, shared, duration_ms, is_local,
            url_fetched_at, play_url, bitrate_kbps,
        });
        // No clear(), new Player, fade or second output stream at this boundary.
        render.player.append(source);
        Ok(true)
    }

    fn preload_mount_matches(admitted: &AdmittedPreload, mounts: &SourceMounts) -> bool {
        match &admitted.mount {
            Some(mount) => {
                mount.stamp == *mount.port.stamp()
                    && mount.stamp.target.generation == admitted.accepted_generation
                    && mount.stamp.target.matches_track(admitted.track())
                    && mounts.current.as_ref().is_some_and(|current|
                        Arc::ptr_eq(current, &mount.port) && current.stamp() == &mount.stamp)
                    && !mounts.reserved.as_ref().is_some_and(|reserved|
                        !Arc::ptr_eq(reserved, &mount.port) || reserved.stamp() != &mount.stamp)
            }
            None => admitted.accepted_generation == 0
                && mounts.current.is_none() && mounts.reserved.is_none(),
        }
    }

    fn preload_queue_matches(slot: &PreloadSlot, queue: &Queue) -> bool {
        queue.selection_cursor() == slot.original_queue_cursor
            && match (queue.current(), slot.original_queue_track.as_ref()) {
                (Some(current), Some(original)) => current.same_identity(original),
                (None, None) => true,
                _ => false,
            }
    }

    /// C is physically current, while semantic current is still A.
    fn with_admitted_preload<T>(
        &self, admitted: &AdmittedPreload, load_gen: &u64,
        commit: impl FnOnce(&mut Queue, &mut PlaybackStateSnapshot) -> T,
    ) -> Option<T> {
        self.core.gate().with_accepted(admitted.accepted_generation, || {
            let mut queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
            let mut state = self.state.write().unwrap_or_else(|e| e.into_inner());
            let mounts = self.source_mounts.lock().unwrap_or_else(|e| e.into_inner());
            let original = &admitted.started.slot.original_track;
            if *load_gen != admitted.accepted_load_gen
                || !Self::preload_mount_matches(admitted, &mounts)
                || !Self::preload_queue_matches(&admitted.started.slot, &queue)
                || !state.track.as_ref().is_some_and(|track| track.same_identity(original))
                || state.track_id.as_deref() != Some(original.id.as_str())
                || !queue.tracks.get(admitted.started.slot.index)
                    .is_some_and(|track| track.same_identity(admitted.track()))
            { return None; }
            Some(commit(&mut queue, &mut state))
        }).flatten()
    }

    fn admitted_preload_is_current(&self, admitted: &AdmittedPreload, load_gen: &u64) -> bool {
        self.with_admitted_preload(admitted, load_gen, |_, _| ()).is_some()
    }

    /// Re-fence the same C after semantic identity becomes C, even at its actual EOF.
    fn with_preload_metadata<T>(
        &self, metadata: &PreloadMetadata, load_gen: &u64,
        commit: impl FnOnce(&mut PlaybackStateSnapshot) -> T,
    ) -> Option<T> {
        let admitted = &metadata.admitted;
        let apply = |state: &mut PlaybackStateSnapshot| {
            let mounts = self.source_mounts.lock().unwrap_or_else(|e| e.into_inner());
            if *load_gen != admitted.accepted_load_gen
                || !Self::preload_mount_matches(admitted, &mounts)
                || !state.track.as_ref().is_some_and(|track| track.same_identity(metadata.track()))
                || state.track_id.as_deref() != Some(metadata.track().id.as_str())
            { return None; }
            Some(commit(state))
        };
        match &admitted.mount {
            Some(mount) => self.core.with_target(&mount.stamp.target, apply).flatten(),
            None => self.core.gate().with_accepted(admitted.accepted_generation, || {
                let mut state = self.state.write().unwrap_or_else(|e| e.into_inner());
                apply(&mut state)
            }).flatten(),
        }
    }

    fn preload_metadata_is_current(&self, metadata: &PreloadMetadata, load_gen: &u64) -> bool {
        self.with_preload_metadata(metadata, load_gen, |_| ()).is_some()
    }

    /// Consume physical C at the original post-old-listen Queue/current phase.
    pub fn sync_preload_current(
        &self, admitted: AdmittedPreload, load_gen: &u64, current: PreloadCurrent<'_>,
    ) -> Option<PreloadMetadata> {
        let mut next_progress = Some(Arc::clone(admitted.started().progress()));
        let mut next_shared = admitted.started().shared().cloned();
        let mut next_cache = next_shared.as_ref().map(|shared| shared.path().to_path_buf());
        let mut next_track = Some(admitted.track().clone());
        let mut next_id = Some(admitted.track().id.clone());
        let retired_failed = self.with_admitted_preload(&admitted, load_gen, |queue, state| {
            queue.commit_index(admitted.started.slot.index);
            std::mem::swap(current.current_progress, &mut next_progress);
            std::mem::swap(current.current_shared, &mut next_shared);
            {
                let mut cache = self.cache_file.lock().unwrap_or_else(|e| e.into_inner());
                std::mem::swap(&mut *cache, &mut next_cache);
            }
            let retired_failed = current.failed_tracks.take(&admitted.track().id);
            *current.fail_streak = 0;
            *current.stall_retry = 0;
            current.watch.clear();
            state.queue_index = queue.index;
            state.queue_len = queue.len();
            std::mem::swap(&mut state.track, &mut next_track);
            std::mem::swap(&mut state.track_id, &mut next_id);
            retired_failed
        });
        let committed = retired_failed.is_some();
        drop((retired_failed, next_progress, next_shared, next_cache, next_track, next_id));
        committed.then_some(PreloadMetadata { admitted })
    }

    /// Consume the same C metadata under its new target/full stamp/actual actor clock.
    /// Emit/device/listen/persist remain outside this short memory-only fence.
    pub fn sync_preload_metadata(
        &self, metadata: PreloadMetadata, load_gen: &u64,
        position_ms: u64, quality: Quality,
    ) -> Option<PublishedPreload> {
        let ready = metadata.started().ready();
        let mut next_quality = quality;
        let mut next_url = ready.play_url.clone();
        let mut next_source = Some(metadata.track().platform.clone());
        let mut next_error: Option<String> = None;
        let written = self.with_preload_metadata(&metadata, load_gen, |state| {
            std::mem::swap(&mut state.quality, &mut next_quality);
            std::mem::swap(&mut state.play_url, &mut next_url);
            std::mem::swap(&mut state.source_id, &mut next_source);
            std::mem::swap(&mut state.error, &mut next_error);
            state.duration_ms = ready.duration_ms;
            state.position_ms = metadata.admitted.mount.as_ref()
                .map_or(position_ms, |mount| mount.port.position_ms());
            state.buffered_ms = 0;
            state.is_local = ready.is_local;
            state.url_fetched_at = ready.url_fetched_at;
            state.bitrate_kbps = ready.bitrate_kbps;
        }).is_some();
        drop((next_quality, next_url, next_source, next_error));
        written.then_some(PublishedPreload { metadata })
    }
}

fn sync_gapless_actor_identity(inner: &mut EngineInner, metadata: &PreloadMetadata) -> bool {
    let owner = inner.owner.clone();
    let next_current = metadata.admitted.mount().cloned();
    let next_play = next_current.clone();
    let next_target = metadata.admitted.stamp().map(|stamp| stamp.target.clone());
    let EngineInner {
        current_mount, play_mount, play_target, eof_queued, load_gen, ..
    } = inner;
    let retired = owner.with_preload_metadata(metadata, load_gen, |_| {
        *eof_queued = false;
        (
            std::mem::replace(current_mount, next_current),
            std::mem::replace(play_mount, next_play),
            std::mem::replace(play_target, next_target),
        )
    });
    let committed = retired.is_some();
    drop(retired);
    committed
}

fn sync_gapless_transition(inner: &mut EngineInner) {
    let Some(started) = inner.preload.take_started() else { return; };
    let owner = inner.owner.clone();
    let Some(admitted) = owner.admit_started_preload(
        started, &inner.preload, inner.current_mount.as_ref(),
        inner.current_progress.as_ref(), &mut inner.load_gen,
    ) else { return; };
    if !owner.admitted_preload_is_current(&admitted, &inner.load_gen) { return; }
    // gapless 接力同样是换曲：把预载那首的 ReplayGain 换上（否则会沿用上一首的）
    apply_replay_gain(inner, admitted.track());
    // The old progress handle still points at the old source's final position.
    inner.accrue_listen(content_pos_ms(inner));
    inner.settle_listen(true, true);
    let Some(metadata) = owner.sync_preload_current(
        admitted, &inner.load_gen,
        PreloadCurrent {
            current_progress: &mut inner.current_progress,
            current_shared: &mut inner.current_shared,
            failed_tracks: &mut inner.failed_tracks,
            fail_streak: &mut inner.fail_streak,
            stall_retry: &mut inner.stall_retry,
            watch: &mut inner.watch,
        },
    ) else { return; };
    if !sync_gapless_actor_identity(inner, &metadata)
        || !owner.preload_metadata_is_current(&metadata, &inner.load_gen)
    { return; }
    inner.queue_emit();
    let position_ms = content_pos_ms(inner);
    let quality = effective_quality_for(inner, metadata.track());
    let track = metadata.track().clone();
    let duration_ms = metadata.duration_ms();
    let Some(published) = owner.sync_preload_metadata(
        metadata, &inner.load_gen, position_ms, quality,
    ) else { return; };
    if !owner.preload_metadata_is_current(&published.metadata, &inner.load_gen) { return; }
    inner.publish();
    if !owner.preload_metadata_is_current(&published.metadata, &inner.load_gen) { return; }
    let listen_mount = inner.begin_listen(&track, duration_ms);
    if !owner.preload_metadata_is_current(&published.metadata, &inner.load_gen) { return; }
    let _ = listen_mount.record_play_start();
    {
        let EngineInner { load_gen, tick_anchor, .. } = inner;
        if owner.with_preload_metadata(&published.metadata, load_gen, |_| *tick_anchor = None)
            .is_none()
        { return; }
    }
    if !owner.preload_metadata_is_current(&published.metadata, &inner.load_gen) { return; }
    inner.persist_state();
    // 换曲边界：这是新一首，预载重试额度归零
    {
        let EngineInner { load_gen, preload, .. } = inner;
        if owner.with_preload_metadata(&published.metadata, load_gen, |_| preload.retries = 0)
            .is_none()
        { return; }
    }
    if !owner.preload_metadata_is_current(&published.metadata, &inner.load_gen) { return; }
    spawn_cache_prune(inner);
}

/// 把这首曲目的 ReplayGain 静态增益写进共享效果参数（A1）。
///
/// 查的是 `audio::replay_gain` 的内存表（启动 / 扫描后整表灌入），
/// 引擎线程不碰数据库。没标签的曲目查不到 → 1.0（不处理）。
fn apply_replay_gain(inner: &mut EngineInner, track: &Track) {
    let key = crate::db::store::db_track_id(track);
    inner
        .fx
        .set_static_gain(crate::audio::replay_gain::gain_for(&key));
}

/// 挂载已构建好的解码器（LoadReady 到达时调用）。
/// 网络 IO（打开流 + 首包探测）已在 blocking 线程池完成，这里只剩纯内存
/// 操作 —— 引擎线程绝不能阻塞，否则休眠唤醒后的死连接会卡死整个控制面。
#[allow(clippy::too_many_arguments)]
fn mount_decoder(
    inner: &mut EngineInner,
    target: Option<PlayTarget>,
    port: Option<Arc<super::render_control::SourceSeekPort>>,
    track: &Track,
    decoder: Box<dyn Source + Send>,
    shared: Option<Arc<RangeShared>>,
    duration_ms: u64,
    start_at: Option<u64>,
    autoplay: bool,
    is_local: bool,
    url_fetched_at: Option<u64>,
    play_url: Option<String>,
    probed_size: Option<u64>,
) {
    let port = match (target, port) {
        (Some(target), Some(port)) if port.stamp().target == target && port.is_live() => Some(port),
        (None, None) => None,
        _ => return,
    };
    let autoplay = port.as_ref().and_then(|port| port.pause_override()).map_or(autoplay, |paused| !paused);
    inner.failed_tracks.remove(&track.id);
    // 成功挂载 = 这首能播：重开自动切歌熔断（连续失败计数一并清零）
    inner.auto_next = true;
    inner.fail_streak = 0;
    inner.stall_retry = 0;
    // 这里**刻意不动** inner.watch：软恢复（看门狗命中第 1 次）也是走这条挂载路径，
    // 清掉 hits 就变成「每 12s 软重载一次」的无限循环，永远升不到重建输出流那一步。
    // 看门狗判定只由「位置真的推进」或「用户手动发起播放」清零。
    inner.sink.clear();
    // Bound sources carry their original rate. Never multiply it again in Player.
    // Legacy unbound sources still use Player's transport rate.
    if let Some(port) = &port { inner.speed = port.speed(); }
    inner.sink.set_speed(if port.is_some() { 1.0 } else { inner.speed });
    // ReplayGain：挂载前把这支曲子该乘的静态增益放进共享效果参数，
    // DspSource 在下一个块边界快照到它（换曲不漏、不早）
    apply_replay_gain(inner, track);
    let progress = port.as_ref().map_or_else(
        || Arc::new(SourceProgress::default()), |port| port.progress(),
    );
    if let Some(port) = &port {
        let source = inner.owner.bind_source(port.clone(), decoder, start_at.unwrap_or(0),
            Arc::clone(&inner.fx), inner.epoch,
            Some(crate::audio::SpectrumTap::new(Some(inner.app.clone()))));
        inner.sink.append(source);
        if !inner.owner.complete_source_mount(port) { return; }
    } else {
        inner.sink.append(DspSource::new(
            Box::new(TrackedSource::new(decoder, Arc::clone(&progress))
                .with_position(start_at.unwrap_or(0))),
            Arc::clone(&inner.fx), inner.epoch,
            Some(crate::audio::SpectrumTap::new(Some(inner.app.clone())))));
    }
    inner.sink.set_volume(inner.effective_volume());
    // 新曲自动播放且开了淡入淡出 → 淡入；否则清掉可能残留的淡出指令。
    // 换曲同时作废在途的「淡出暂停」deadline（新曲已经开始播了）
    if autoplay && inner.fx.fade_enabled() {
        inner.fx.begin_fade_in(epoch_ms(inner));
    } else {
        inner.fx.clear_fade();
    }
    inner.pause_deadline = None;
    // 记下这条流的磁盘缓存文件（清理缓存时跳过它，Windows 上删被占用文件会失败）
    *inner.cache_file.lock().unwrap_or_else(|e| e.into_inner()) = shared.as_ref().map(|s| s.path().to_path_buf());
    // 新流落盘后顺手修剪缓存（超上限时清最旧的；后台线程）
    spawn_cache_prune(inner);
    // Initial CUE/restore seeks were performed on the blocking loader worker.
    inner.current_progress = Some(progress);
    inner.current_mount = port.clone();
    inner.eof_queued = false;
    if autoplay {
        inner.sink.play();
    } else {
        inner.sink.pause();
    }
    // 码率必须在 shared 被移进 inner 之前算：优先用取链侧 Range 探测到的长度
    // （分块传输的流没有 Content-Length，只有探测结果这一份），缺了才回落到
    // 已挂载流自己读到的长度。duration_ms 用解码器报的时长 —— 它才是真正在
    // 播的那条流的时长，元数据时长在某些平台上不可靠。
    let size_bytes = probed_size.or_else(|| shared.as_ref().and_then(|s| s.total_len()));
    let bitrate_kbps = measured_bitrate_kbps(size_bytes, duration_ms);
    inner.current_shared = shared;

    let mut prepared = inner.owner.snapshot();
    prepared.status = if autoplay { PlaybackStatus::Playing } else { PlaybackStatus::Paused };
    prepared.track_id = Some(track.id.clone());
    prepared.track = Some(track.clone());
    prepared.duration_ms = duration_ms;
    prepared.position_ms = start_at.unwrap_or(0);
    prepared.error = None;
    prepared.is_local = is_local;
    prepared.url_fetched_at = url_fetched_at;
    prepared.play_url = play_url;
    prepared.bitrate_kbps = bitrate_kbps;
    if let Some(port) = &port {
        if !inner.owner.publish_source_state(port, prepared) { return; }
        inner.publish();
    } else {
        inner.mutate(|st| *st = prepared);
    }
    // 收听会话从挂载成功这一刻开始（同曲重载不重开：那还是同一次收听）。
    // duration_ms 用解码器报的时长，有效播放的「听满一半」按它算。
    let listen_mount = inner.begin_listen(track, duration_ms);
    let _ = listen_mount.record_play_start();
    inner.tick_anchor = None;
    emit_position_tick(inner);
    inner.persist_state();
    // 「当前这首加载完成」= 预热的最佳时机：地址/缓存/解码器都已经就位，
    // 下一首的取链现在开始，离真正换曲还有整首歌的时间可以失败重试。
    inner.preload.retries = 0;
    maybe_preload(inner);
}

static AUDIO_HTTP: std::sync::OnceLock<RwLock<(u64, reqwest::blocking::Client)>> =
    std::sync::OnceLock::new();

/// Called on blocking loader workers: proxy changes take effect for each new load.
fn audio_http_client() -> reqwest::blocking::Client {
    crate::net_config::shared_blocking_client(&AUDIO_HTTP, || {
        crate::net_config::configure_blocking(
            reqwest::blocking::Client::builder()
                .user_agent("Mozilla/5.0")
                .pool_max_idle_per_host(0)
                .connect_timeout(Duration::from_secs(8)),
        )
        .build()
        .expect("blocking audio http client init")
    })
}

/// A prepared decoder keeps physical duration for interval bitrate calculation.
struct BuiltDecoder {
    source: Box<dyn Source + Send>,
    shared: Option<Arc<RangeShared>>,
    duration_ms: u64,
    physical_duration_ms: u64,
}

/// 构建 Decoder：在线走 HttpRangeReader（磁盘缓冲 + Range 下载线程），
/// 播放总时长（毫秒）：以解码器为准 —— 它才是真正在播的那条流。
/// 解码器拿不到时长（流式 / 缺头部信息）时才回落到曲目元数据；
/// 元数据单位在部分平台不可靠（酷狗曾出现毫秒被当秒用 → 时长暴涨成几十小时），
/// 超过 6 小时的一律当脏数据丢弃：宁可显示 0（进度条按未知处理）也不让时长爆表。
fn resolve_duration_ms<R: std::io::Read + std::io::Seek>(
    decoder: &Decoder<R>,
    track: &Track,
) -> u64 {
    let decoded = decoder
        .total_duration()
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if decoded > 0 {
        return decoded;
    }
    // CUE metadata duration is relative to the interval, not the physical file.
    if track.start_ms.is_some() || track.end_ms.is_some() { 0 } else { meta_duration_ms(track) }
}

/// 元数据兜底时长（毫秒）。曲目元数据的单位在部分平台不可靠
/// （酷狗曾把毫秒当秒 → 197s 的曲子算出 197098s），超过 6 小时一律丢弃。
fn meta_duration_ms(track: &Track) -> u64 {
    const MAX_REASONABLE_MS: u64 = 6 * 60 * 60 * 1000;
    let meta = (track.duration * 1000.0) as u64;
    if meta > MAX_REASONABLE_MS {
        0
    } else {
        meta
    }
}

/// 实测码率（kbps）= 总字节数 × 8 ÷ 时长。任一输入缺失/为 0 一律返回 None：
/// 显示 "0 kbps" 会被读成"码率极低"，那是假消息；不显示才是诚实的。
///
/// 这里的口径与取链侧 `measured_kbps`（qt-sources 的 play-guard）一致 ——
/// 同一份数据在两处算出的档位必须一样，否则播放条和取链日志会互相矛盾。
fn measured_bitrate_kbps(size_bytes: Option<u64>, duration_ms: u64) -> Option<u32> {
    let size = size_bytes?;
    if size == 0 || duration_ms == 0 {
        return None;
    }
    let kbps = ((size as f64 * 8.0) / (duration_ms as f64 / 1000.0) / 1000.0).round() as u32;
    // 四舍五入到 0 的只可能是垃圾数据（几个字节配上极长时长）；显示 "0 kbps"
    // 会被读成"码率极低"，与"测不出来"是两个完全不同的结论，一律按测不出处理。
    if kbps == 0 {
        None
    } else {
        Some(kbps)
    }
}

/// The production local decoder branch, without constructing HTTP or device state.
pub fn decode_local_file(path: &Path) -> Result<Decoder<BufReader<std::fs::File>>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("打开本地文件失败: {e}"))?;
    // File length remains available to the actual decoder and FLAC seeking.
    Decoder::try_from(file).map_err(|e| format!("解码失败: {e}"))
}

fn build_local_decoder(path: &Path, track: &Track) -> Result<BuiltDecoder, String> {
    let decoder = decode_local_file(path)?;
    let duration = resolve_duration_ms(&decoder, track);
    track_interval(maybe_downmix(Box::new(decoder)), None, duration, track)
}

/// 本地直接 File::open。返回 (boxed source, range_shared, duration_ms)。
/// 只允许在 blocking 线程池里调用 —— HTTP open 最多阻塞一个请求超时，
/// Decoder::build 探针首包最多再阻塞 FIRST_PACKET_TIMEOUT(8s)。
fn build_decoder(
    source: &PlaySource,
    http: &reqwest::blocking::Client,
    cache_dir: &Path,
    track: &Track,
) -> Result<BuiltDecoder, String> {
    match source {
        PlaySource::Local { path } => build_local_decoder(Path::new(path), track),
        PlaySource::Online { url, referer, .. } => {
            let (reader, shared) =
                range_reader::open(url, referer, http, cache_dir).map_err(|e| e.to_string())?;
            // 总字节数（Content-Length）是 symphonia FLAC 二分定位的必要输入：
            // 缺了它 demuxer 会直接判 Unseekable。注意 with_byte_len 同时置 seekable=true；
            // 服务端没给长度时保持默认不可 seek（前向仍可线性扫描，回退才会失败）。
            let builder = Decoder::builder().with_data(BufReader::new(reader));
            let builder = match shared.total_len() {
                Some(len) => builder.with_byte_len(len),
                None => builder,
            };
            let decoder = builder.build().map_err(|e| format!("解码失败: {e}"))?;
            let duration = resolve_duration_ms(&decoder, track);
            track_interval(maybe_downmix(Box::new(decoder)), Some(shared), duration, track)
        }
    }
}

/// 多声道源先降混到立体声再进效果链。
///
/// rodio 的声道转换只会丢掉多余声道（见 `fx::DownmixToStereo` 的注释），
/// 5.1/7.1 曲目必须在这里桥接，否则中置/环绕全丢、电平低 6~10 dB。
fn maybe_downmix(source: Box<dyn Source + Send>) -> Box<dyn Source + Send> {
    let channels = source.channels().get();
    if channels > 2 {
        log::info!("[audio] 多声道源 {channels}ch → 立体声降混");
        Box::new(crate::audio::fx::DownmixToStereo::new(source))
    } else {
        source
    }
}

fn track_interval(
    decoder: Box<dyn Source + Send>,
    shared: Option<Arc<RangeShared>>,
    physical_duration_ms: u64,
    track: &Track,
) -> Result<BuiltDecoder, String> {
    if track.start_ms.is_none() && track.end_ms.is_none() {
        return Ok(BuiltDecoder { source: decoder, shared, duration_ms: physical_duration_ms, physical_duration_ms });
    }
    let source = IntervalSource::new(
        decoder, track.start_ms.unwrap_or(0), track.end_ms, physical_duration_ms,
    )?;
    let duration_ms = source.total_duration().map_or(0, |duration| duration.as_millis() as u64);
    Ok(BuiltDecoder { source: Box::new(source), shared, duration_ms, physical_duration_ms })
}

/// 250ms 节流 tick：position-changed { positionMs, durationMs, bufferedMs, monotonicMs }（§7.11）
fn emit_position_tick(inner: &mut EngineInner) {
    let now = std::time::Instant::now();
    if let Some(t) = inner.tick_anchor {
        if now.duration_since(t) < Duration::from_millis(250) {
            return;
        }
    }

    // rodio 的真实播放位置（暂停时冻结）。它走「真实时间」口径（见
    // content_pos_ms 的说明），换算回内容时间域，与倍速无关
    let pos_ms = content_pos_ms(inner);
    // 收听时长按「位置真的在推进」的墙钟时间累计（暂停 / seek 跳过的不计）
    inner.accrue_listen(pos_ms);
    let buffered_ms = inner
        .current_shared
        .as_ref()
        .map(|s| {
            // 已就绪字节 / 总字节 × 时长；总长未知时按 128kbps 粗估（缓冲条展示用途）
            let ready = s.ready_bytes();
            match s.total_len() {
                Some(total) if total > 0 => {
                    let dur = inner.state.read().unwrap_or_else(|e| e.into_inner()).duration_ms;
                    ((ready as f64 / total as f64) * dur as f64) as u64
                }
                _ => (ready / 128_000) * 1000,
            }
        })
        .unwrap_or(0);

    let duration_ms = inner.state.read().unwrap_or_else(|e| e.into_inner()).duration_ms;
    // monotonicMs：发送时刻单调时钟（原点 = 引擎启动），歌词窗口检测漂移用（§7.11）
    let monotonic_ms = inner.epoch.elapsed().as_millis() as u64;
    let payload = serde_json::json!({
        "positionMs": pos_ms,
        "durationMs": duration_ms,
        "bufferedMs": buffered_ms,
        "monotonicMs": monotonic_ms,
    });
    let _ = inner.app.emit("position-changed", &payload);
    inner.tick_anchor = Some(now);

    if let Ok(mut st) = inner.state.write() {
        st.position_ms = pos_ms;
        st.buffered_ms = buffered_ms;
    }

    // 播放进度每 5s 落一次 settings（恢复现场用，避免 250ms 高频写库）
    let due = inner
        .last_persist
        .map(|t| now.duration_since(t) >= Duration::from_secs(5))
        .unwrap_or(true);
    if due {
        inner.last_persist = Some(now);
        inner.persist_state();
    }
}

#[cfg(test)]
mod duration_tests {
    use super::meta_duration_ms;
    use crate::provider::types::{SourceId, Track};

    fn track_with_duration(seconds: f64) -> Track {
        Track {
            id: "1".into(),
            platform: SourceId::new("kg"),
            title: "测试".into(),
            singer: "".into(),
            album: "".into(),
            pic_url: String::new(),
            duration: seconds,
            recording: Default::default(), music_id: None,
            start_ms: None,
            end_ms: None,
        }
    }

    #[test]
    fn metadata_duration_uses_seconds() {
        assert_eq!(meta_duration_ms(&track_with_duration(197.0)), 197_000);
    }

    /// 单位错的脏数据（毫秒被当秒）不能进进度条：曾显示成 3284:58
    #[test]
    fn metadata_duration_drops_absurd_values() {
        assert_eq!(meta_duration_ms(&track_with_duration(197_098.0)), 0);
        assert_eq!(meta_duration_ms(&track_with_duration(274_285.0)), 0);
    }

    #[test]
    fn metadata_duration_keeps_long_tracks() {
        // 3 小时的现场集：仍在合理范围内，保留
        assert_eq!(meta_duration_ms(&track_with_duration(10_800.0)), 10_800_000);
    }
}

#[cfg(test)]
mod bitrate_tests {
    use super::measured_bitrate_kbps;

    /// 320k 的曲子：4 分钟 ≈ 9.6MB → 320kbps
    #[test]
    fn bitrate_from_size_and_duration() {
        assert_eq!(measured_bitrate_kbps(Some(9_600_000), 240_000), Some(320));
    }

    #[test]
    fn bitrate_flac_is_higher_than_lossy() {
        let flac = measured_bitrate_kbps(Some(30_000_000), 240_000).unwrap();
        let k320 = measured_bitrate_kbps(Some(9_600_000), 240_000).unwrap();
        assert!(flac > k320, "无损实测码率应高于 320k: {flac} vs {k320}");
    }

    /// 测不出来就返回 None —— 前端整行不渲染，绝不让 0 冒充"码率极低"
    #[test]
    fn bitrate_is_none_when_unknown() {
        assert_eq!(measured_bitrate_kbps(None, 240_000), None);
        assert_eq!(measured_bitrate_kbps(Some(0), 240_000), None);
        assert_eq!(measured_bitrate_kbps(Some(9_600_000), 0), None);
    }
}

#[cfg(test)]
mod stall_watch_tests {
    use super::{StallWatch, STALL_DEAD_TIMEOUT, STALL_POS_TIMEOUT};

    /// 位置持续推进 → 永不命中（正常播放不能被看门狗打扰）
    #[test]
    fn progressing_position_never_fires() {
        let mut w = StallWatch::default();
        let t0 = std::time::Instant::now();
        for step in 0..40u32 {
            let at = t0 + STALL_POS_TIMEOUT * 10 * step;
            assert_eq!(w.poll(u64::from(step) * 250, at), None);
        }
    }

    /// 首次观测只建基准，不立刻开火（不知道已经静止了多久）
    #[test]
    fn first_observation_only_baselines() {
        let mut w = StallWatch::default();
        let t0 = std::time::Instant::now();
        assert_eq!(w.poll(1_000, t0), None);
        // 窗口内不动：仍然不动手
        assert_eq!(w.poll(1_000, t0 + STALL_POS_TIMEOUT - std::time::Duration::from_millis(1)), None);
        // 满窗口 → 命中第 1 次
        assert_eq!(w.poll(1_000, t0 + STALL_POS_TIMEOUT), Some(1));
        // 再等一个窗口 → 命中第 2 次（阶梯要能升级）
        assert_eq!(w.poll(1_000, t0 + STALL_POS_TIMEOUT * 2), Some(2));
    }

    /// 位置恢复推进 → hits 清零，重新开始计数
    #[test]
    fn progress_resets_hits() {
        let mut w = StallWatch::default();
        let t0 = std::time::Instant::now();
        w.poll(0, t0);
        assert_eq!(w.poll(0, t0 + STALL_POS_TIMEOUT), Some(1));
        // 救回来了一点点：判定必须清零
        assert_eq!(w.poll(500, t0 + STALL_POS_TIMEOUT), None);
        assert_eq!(w.poll(500, t0 + STALL_POS_TIMEOUT * 3), Some(1));
    }

    /// 用户往回拖（位置变小）也算「管线活着」，不能被当成冻结
    #[test]
    fn backward_jump_counts_as_alive() {
        let mut w = StallWatch::default();
        let t0 = std::time::Instant::now();
        w.poll(60_000, t0);
        assert_eq!(w.poll(5_000, t0 + STALL_POS_TIMEOUT), None);
    }

    /// reset 只清窗口基准，不清 hits/dead —— 恢复阶梯必须跨 Loading 延续
    #[test]
    fn reset_keeps_verdict() {
        let mut w = StallWatch::default();
        let t0 = std::time::Instant::now();
        w.mark_dead(true);
        w.poll(0, t0);
        w.reset();
        assert_eq!(w.hits, 1, "reset 不能清掉恢复进度");
        assert!(w.dead, "reset 不能清掉死流判定");
        // 用户手动播才允许整条清零
        w.clear();
        assert_eq!(w.hits, 0);
        assert!(!w.dead);
    }

    /// fatal（回调线程 panic）→ 窗口缩短，且下一次命中直接落在「重建输出流」档
    #[test]
    fn fatal_panic_shifts_to_rebuild_window() {
        let mut w = StallWatch::default();
        let t0 = std::time::Instant::now();
        w.poll(0, t0);
        w.mark_dead(true);
        assert_eq!(w.window(), STALL_DEAD_TIMEOUT);
        // 短窗口即可命中，且 hits 已经是 2 = 重建档
        assert_eq!(w.poll(0, t0 + STALL_DEAD_TIMEOUT), Some(2));
    }

    /// 非 fatal（cpal 流错误）只缩短窗口，不跳过软重载
    #[test]
    fn non_fatal_error_keeps_soft_reload() {
        let mut w = StallWatch::default();
        let t0 = std::time::Instant::now();
        w.poll(0, t0);
        w.mark_dead(false);
        assert_eq!(w.window(), STALL_DEAD_TIMEOUT);
        assert_eq!(w.poll(0, t0 + STALL_DEAD_TIMEOUT), Some(1));
    }
}

/// 超单曲缓冲上限的失败分类（2026-10-13 真机：flac24bit 141238577 字节被拒播）。
///
/// 这组断言守的是「别把这类失败当弱网」：一旦被当成环境问题，`LoadJob` 会白跑
/// 一轮「作废地址 + 重取」，而结果注定一样。
#[cfg(test)]
mod buffer_limit_tests {
    use super::*;
    use crate::audio::range_reader;

    /// 真机原样文案必须被认出来（判据来自 `range_reader::BUFFER_LIMIT_PREFIX`）。
    #[test]
    fn real_device_message_is_classified_as_too_large() {
        let real = format!(
            "{}（141238577 字节，上限 {} 字节）",
            range_reader::BUFFER_LIMIT_PREFIX,
            range_reader::MAX_BUFFER_BYTES
        );
        assert!(range_reader::is_buffer_limit_error(&real));
    }

    /// 给用户的文案不套「暂时无法播放」的壳 —— 那暗示等一会儿就好。
    #[test]
    fn file_too_large_message_promises_no_retry() {
        assert!(!MSG_FILE_TOO_LARGE.contains("暂时"));
        assert!(MSG_FILE_TOO_LARGE.contains("过大"));
    }

    /// 上限判据不能把可重取的失败一起吃进去（否则白白放弃可救的地址）。
    #[test]
    fn retryable_failures_are_not_classified_as_too_large() {
        for other in [
            "HTTP 状态 503",
            "Content-Range 起点异常",
            "连接中断: connection reset by peer",
            "首包超时",
        ] {
            assert!(
                !range_reader::is_buffer_limit_error(other),
                "「{other}」不该被判成文件过大"
            );
        }
    }
}

#[cfg(test)]
mod device_action_tests {
    use super::{decide_device_action, device_gone_reason, DeviceAction};

    /// 拔耳机（旧设备消失）→ 暂停，哪怕系统已经换好兜底设备。
    #[test]
    fn removed_device_pauses() {
        assert_eq!(
            decide_device_action("耳机", false, Some("扬声器"), false),
            DeviceAction::Lost {
                fallback: Some("扬声器".into())
            }
        );
    }

    /// 最后一个输出设备也被拔掉：`default_output_device()` 此时返回 None，
    /// 仍然必须判定为「掉设备」。若把「能取到默认设备名」当作前提，
    /// 这种只剩一个 USB DAC 的场景就会漏判、继续假装在播。
    #[test]
    fn removed_last_device_pauses_without_fallback() {
        assert_eq!(
            decide_device_action("USB DAC", false, None, false),
            DeviceAction::Lost { fallback: None }
        );
    }

    /// 被动移除的判定与「是否固定设备」无关：固定设备被拔掉同样要暂停。
    #[test]
    fn removed_pinned_device_also_pauses() {
        assert_eq!(
            decide_device_action("耳机", false, Some("扬声器"), true),
            DeviceAction::Lost {
                fallback: Some("扬声器".into())
            }
        );
    }

    /// 插上耳机 / HDMI：旧设备还在，只是默认换了人 → 跟随默认时重建续播。
    #[test]
    fn default_switch_while_following_rebuilds() {
        assert_eq!(
            decide_device_action("扬声器", true, Some("耳机"), false),
            DeviceAction::Follow {
                name: "耳机".into()
            }
        );
    }

    /// 固定设备模式下默认换人与本应用无关：流还挂在用户指定的设备上，不动。
    #[test]
    fn default_switch_while_pinned_is_ignored() {
        assert_eq!(
            decide_device_action("DAC", true, Some("耳机"), true),
            DeviceAction::None
        );
    }

    /// 枚举瞬时失败（拿不到默认设备名）不能当成设备变化 —— 否则会误暂停。
    #[test]
    fn transient_missing_default_is_not_a_change() {
        assert_eq!(decide_device_action("耳机", true, None, false), DeviceAction::None);
    }

    /// 名字没变：什么都不做。
    #[test]
    fn unchanged_device_is_a_noop() {
        assert_eq!(
            decide_device_action("耳机", true, Some("耳机"), false),
            DeviceAction::None
        );
    }

    /// 启动时没有任何输出设备（old 为空）：等系统有默认设备了就接管，
    /// 绝不走「掉设备」分支（那时根本没设备可掉）。
    #[test]
    fn empty_old_never_counts_as_device_loss() {
        // 跟随默认：直接重建到新出现的默认设备
        assert_eq!(
            decide_device_action("", false, Some("扬声器"), false),
            DeviceAction::Follow {
                name: "扬声器".into()
            }
        );
        // 固定设备：只补记设备名，不动流
        assert_eq!(
            decide_device_action("", false, Some("扬声器"), true),
            DeviceAction::Adopt {
                name: "扬声器".into()
            }
        );
        // 一个都没有：什么都不做
        assert_eq!(decide_device_action("", false, None, false), DeviceAction::None);
    }

    /// 文案：没在播时不能说「播放已暂停」（用户只是选了个没插上的设备）。
    #[test]
    fn reason_only_mentions_pause_when_playback_was_active() {
        let active = device_gone_reason("耳机", "已断开", true);
        assert!(active.contains("耳机") && active.contains("播放已暂停"));
        let idle = device_gone_reason("耳机", "不可用", false);
        assert!(idle.contains("耳机") && !idle.contains("播放已暂停"));
    }
}

#[cfg(test)]
mod command_channel_tests {
    use super::{AudioDelivery, AudioEngine};
    use crate::provider::types::{SourceId, Track};
    use std::time::Duration;

    fn track(platform: &str, id: &str) -> Track {
        Track {
            id: id.into(), platform: SourceId::new(platform), title: id.into(),
            singer: String::new(), album: String::new(), pic_url: String::new(),
            duration: 0.0, recording: Default::default(), music_id: None, start_ms: None, end_ms: None,
        }
    }

    #[test]
    fn gapless_output_promotes_the_preloaded_track_to_the_current_source_mount() {
        exercise_gapless_current_source(true);
    }

    #[test]
    fn gapless_output_promotes_the_preloaded_track_to_the_current_source_mount_then_loads_its_successor() {
        exercise_gapless_current_source(false);
    }

    fn exercise_gapless_current_source(no_next: bool) {
        use super::{
            AudioCmd, PreloadCurrent, PreloadFlags, PreloadPrepare, PreloadQuality,
            PreloadRender, PreloadState, SourceRecoveryContext, StallWatch,
        };
        use crate::audio::{AudioFx, PlaybackStatus, Quality};
        use rodio::{ChannelCount, SampleRate, Source};
        use std::collections::{HashMap, HashSet};
        use std::io::Write;
        use std::sync::Arc;
        use std::time::Instant;

        let wav = include_bytes!("../../tests/fixtures/self-authored-silence.wav");
        let root = crate::public_test_fixture::root();
        let path_a = root.join(format!("gapless-current-mount-original-a-{no_next}.wav"));
        let path_c = root.join(format!("gapless-current-mount-preloaded-c-{no_next}.wav"));
        for path in [&path_a, &path_c] {
            let mut file = std::fs::OpenOptions::new()
                .write(true).create_new(true).open(path).expect("create an owned WAV fixture");
            file.write_all(wav).expect("write the existing self-authored WAV bytes");
            file.flush().expect("flush the owned WAV fixture");
        }

        let (engine, inbox) = AudioEngine::command_channel();
        let (player, output) = engine.player_channel();
        let mut output = rodio::source::UniformSourceIterator::new(output,
            ChannelCount::new(1).unwrap(), SampleRate::new(1_000).unwrap());
        let fx = Arc::new(AudioFx::new());
        let epoch = Instant::now();
        let mut load_gen = 0;
        let original_a = engine.begin_play_intent();
        let mut reply = engine.send_queue(
            vec![track("source-a", "A"), track("source-c", "C")], 0, Some(original_a),
        );
        let AudioDelivery::Playback(plan) = inbox
            .recv_timeout(Duration::from_secs(5), &mut load_gen).expect("receive the original A queue")
            else { panic!("the real original A queue must commit"); };
        let receipt = reply.try_recv().expect("the original A queue receipt");
        assert!(receipt.applied);
        let a = receipt.target.expect("the actual accepted A target");
        assert_eq!(a.generation, original_a);
        assert_eq!(plan.target.as_ref(), Some(&a));
        let port_a = plan.port.clone().expect("A's actual original reserved mount");
        assert_eq!(port_a.stamp().target, a);
        let request_a = engine.prepare_source_load(
            plan.track.clone().expect("actual A loader track"), Some(a.clone()), Some(port_a.clone()),
            load_gen, true, 0,
        ).expect("prepare A with its actual original source reservation");
        assert!(Arc::ptr_eq(request_a.port.as_ref().unwrap(), &port_a));
        let decoder_a = request_a.decode_local_or_report(&engine, &path_a)
            .expect("the actual local A decoder must open the owned WAV");
        assert_eq!(decoder_a.channels().get(), 1);
        assert_eq!(decoder_a.sample_rate().get(), 8_000);
        assert_eq!(decoder_a.total_duration(), Some(Duration::from_millis(384)));
        player.append(engine.bind_source(port_a.clone(), Box::new(decoder_a), 0,
            fx.clone(), epoch, None));
        assert!(engine.complete_source_mount(&port_a));
        let mut playing = engine.snapshot();
        playing.status = PlaybackStatus::Playing;
        playing.duration_ms = 384;
        playing.is_local = true;
        assert!(engine.publish_source_state(&port_a, playing));
        for _ in 0..128 { assert!(output.next().is_some()); }
        assert!(port_a.is_live() && port_a.position_ms() > 0 && !player.empty());
        let current_mount = engine.current_source_mount().expect("real physical current A");
        assert!(Arc::ptr_eq(&current_mount, &port_a));
        assert!(Arc::ptr_eq(&engine.source_mount(&a).unwrap(), &port_a));
        assert_eq!(engine.snapshot().track_id.as_deref(), Some("A"));
        assert_eq!(engine.queue_snapshot().index, Some(0));
        let original_stamp = port_a.stamp().clone();
        let original_load_gen = load_gen;
        assert_eq!(original_load_gen, 1);
        let mut current_progress = Some(current_mount.progress());
        assert!(Arc::ptr_eq(current_progress.as_ref().unwrap(), &port_a.progress()));
        // A was decoded by the real Local branch, which has no RangeShared.
        let mut current_shared = None;
        let mut recovery = SourceRecoveryContext {
            auto_next: true, fail_streak: 0, failed_tracks: HashSet::new(),
        };
        let mut stall_retry = 0;
        let mut watch = StallWatch::default();
        let flags = PreloadFlags {
            gapless: true, sleep_after_track: engine.snapshot().sleep_after_track,
            auto_next: recovery.auto_next,
        };
        let default_quality = engine.snapshot().quality;
        let track_quality = Some((a.id.clone(), Quality::new("a-only")));
        let source_qualities = HashMap::from([("source-c".to_owned(), Quality::new("flac"))]);
        let mut preload = PreloadState::default();
        let request_c = engine.prepare_preload(
            &mut preload, PreloadPrepare {
                flags, pausing: current_mount.is_paused(),
                current_progress: current_progress.as_ref(), current_mount: Some(&current_mount),
                target: Some(&a), load_gen,
                quality: PreloadQuality {
                    default_quality: &default_quality, track_quality: &track_quality,
                    source_qualities: &source_qualities,
                },
            }, |_| false,
        ).expect("the real playing A must prepare its existing queue successor C");
        assert_eq!(request_c.request.track.id, "C");
        assert_eq!(request_c.request.track.platform.as_str(), "source-c");
        assert_eq!(request_c.request.target.as_ref(), Some(&a));
        assert!(request_c.request.port.is_none(), "speculation must not reserve a normal C mount");
        assert!(request_c.request.autoplay && request_c.request.start_ms == 0);
        assert_eq!(request_c.quality, Quality::new("flac"));
        let selected_quality = request_c.quality.clone();
        let preload_gen = request_c.request.gen;
        assert!(Arc::ptr_eq(preload.original_mount().unwrap(), &port_a));
        assert_eq!(preload.original_stamp(), Some(&original_stamp));
        assert_eq!(preload.original_load_gen(), Some(original_load_gen));
        assert!(Arc::ptr_eq(&engine.current_source_mount().unwrap(), &port_a));
        assert_eq!(load_gen, original_load_gen);
        request_c.dispatch_local(&engine, path_c).expect("dispatch the real owned C local preload");
        let AudioDelivery::Command(cmd) = inbox
            .recv_timeout(Duration::from_secs(5), &mut load_gen).expect("receive the real C preload packet")
            else { panic!("the actual preload must reach the ordinary command delivery"); };
        match &cmd {
            AudioCmd::LoadReady { target, port, track, shared, duration_ms, start_at, autoplay,
                is_local, url_fetched_at, play_url, size_bytes, gen, preload: true, .. } => {
                assert_eq!(target.as_ref(), Some(&a));
                assert!(port.is_none() && shared.is_none());
                assert_eq!((track.platform.as_str(), track.id.as_str()), ("source-c", "C"));
                assert_eq!(*duration_ms, 384);
                assert!(start_at.is_none() && *autoplay && *is_local);
                assert!(url_fetched_at.is_none() && play_url.is_none());
                assert_eq!(*size_bytes, Some(wav.len() as u64));
                assert_eq!(*gen, preload_gen);
            }
            _ => panic!("dispatch_local must produce the actual preload:true LoadReady receipt"),
        }
        assert!(matches!(engine.append_preloaded(
            cmd, &mut preload, flags, PreloadRender { player: &player, fx: &fx, epoch }, || None,
        ), Ok(true)), "the actual accepted preload receipt must append to the same real Player");
        let c_progress = Arc::clone(preload.prepared_progress().expect("the actual prepared C slot"));
        assert_eq!(c_progress.position_ms(), 0);
        assert!(preload.take_started().is_none(), "no transition before normal C output");
        // started() alone can precede decoder.next(); it is not first-Some proof.
        // Positive content position requires actual decoder Some through ordinary output.
        for _ in 0..2_048 {
            assert!(output.next().is_some(), "pull the ordinary software output");
            if c_progress.position_ms() > 0 { break; }
        }
        assert!(c_progress.position_ms() > 0, "owned C decoder never reached ordinary output");
        assert!(port_a.position_ms() >= 384, "the original owned A really reached EOF");
        assert!(!player.empty(), "C is still physically playing");
        let started = preload.take_started().expect("take the actual C slot after real C content");
        assert_eq!((started.track().platform.as_str(), started.track().id.as_str()), ("source-c", "C"));
        assert!(Arc::ptr_eq(started.progress(), &c_progress));
        assert!(Arc::ptr_eq(started.original_mount().unwrap(), &port_a));
        assert_eq!(started.original_stamp(), Some(&original_stamp));
        assert_eq!(started.original_load_gen(), original_load_gen);
        let admitted = engine.admit_started_preload(
            started, &preload, Some(&current_mount), current_progress.as_ref(), &mut load_gen,
        ).expect("admit the actual C slot against A and the real inbox actor clock");
        let metadata = engine.sync_preload_current(admitted, &load_gen, PreloadCurrent {
            current_progress: &mut current_progress, current_shared: &mut current_shared,
            failed_tracks: &mut recovery.failed_tracks, fail_streak: &mut recovery.fail_streak,
            stall_retry: &mut stall_retry, watch: &mut watch,
        }).expect("consume the original physical C admission at current/Queue sync");
        assert!(Arc::ptr_eq(current_progress.as_ref().unwrap(), &c_progress));
        let content_position_ms = current_progress.as_ref().unwrap().position_ms();
        let _published = engine.sync_preload_metadata(
            metadata, &load_gen, content_position_ms, selected_quality,
        ).expect("publish the original C metadata under its actual advanced actor clock");
        let snapshot = engine.snapshot();
        let queue = engine.queue_snapshot();
        assert_eq!(snapshot.track_id.as_deref(), Some("C"));
        assert_eq!(snapshot.track.as_ref().unwrap().id, "C");
        assert_eq!(snapshot.status, PlaybackStatus::Playing);
        assert_eq!(snapshot.position_ms, content_position_ms);
        assert!(snapshot.position_ms > 0 && snapshot.is_local);
        assert_eq!((snapshot.queue_index, queue.index), (Some(1), Some(1)));
        assert_eq!(queue.current().unwrap().id, "C");
        let physical = engine.current_source_mount().expect("current physical source after C output");

        // First regression assertion: logical C must own the physical current-source boundary.
        assert_eq!(
            physical.stamp().target.id.as_str(), snapshot.track_id.as_deref().unwrap(),
            "gapless C produced samples but current mount is still A: original={original_stamp:?}, original_load_gen={original_load_gen}, load_gen={load_gen}",
        );
        assert!(Arc::ptr_eq(&physical.progress(), &c_progress));
        assert_eq!(load_gen, original_load_gen.wrapping_add(1));
        let c = physical.stamp().target.clone();
        assert!(Arc::ptr_eq(&engine.source_mount(&c).unwrap(), &physical));
        assert!(engine.begin_source_seek(&a, 120).is_err(), "old A cannot seek the actual C remainder");
        let a_position = port_a.position_ms();
        let mut pending_seek = engine.begin_source_seek(&c, 120)
            .expect("actual gapless C must retain its original source-bound seek entry");
        let mut seek_receipt = None;
        for _ in 0..64 {
            assert!(output.next().is_some());
            if let Ok(result) = pending_seek.try_recv() {
                seek_receipt = Some(result.expect("the real C remainder must accept its original seek"));
                break;
            }
        }
        let seek_receipt = seek_receipt.expect("ordinary output must finish the actual C bound seek");
        assert_eq!(&seek_receipt.stamp, physical.stamp());
        assert_eq!(seek_receipt.content_position_ms, 120);
        assert_eq!(engine.snapshot().position_ms, 120);
        assert!(c_progress.position_ms() >= 120);
        assert_eq!(port_a.position_ms(), a_position, "C seek cannot reset A's exhausted decoder");
        assert!(Arc::ptr_eq(&engine.current_source_mount().unwrap(), &physical));
        assert!(Arc::ptr_eq(&physical.progress(), &c_progress));

        let paused_c_position = c_progress.position_ms();
        assert_eq!(engine.set_source_paused(&c, true).expect("pause the original gapless C"), *physical.stamp());
        assert_eq!(engine.snapshot().status, PlaybackStatus::Paused);
        for _ in 0..16 { assert!(output.next().is_some()); }
        assert_eq!(c_progress.position_ms(), paused_c_position, "paused C must not pull its original decoder");
        assert!(engine.set_source_paused(&a, false).is_err(), "exhausted A cannot resume C");
        assert_eq!(engine.snapshot().status, PlaybackStatus::Paused);
        assert_eq!(engine.set_source_paused(&c, false).expect("resume the original gapless C"), *physical.stamp());
        assert_eq!(engine.snapshot().status, PlaybackStatus::Playing);
        assert!(Arc::ptr_eq(&engine.current_source_mount().unwrap(), &physical));
        assert_eq!(port_a.position_ms(), a_position);

        let speed_c_position = c_progress.position_ms();
        assert_eq!(engine.set_source_speed(&c, 2.0).expect("speed the original gapless C"), *physical.stamp());
        assert!(engine.set_source_speed(&a, 0.5).is_err(), "exhausted A cannot change C's rate");
        assert_eq!(engine.snapshot().speed, 2.0);
        for _ in 0..16 { assert!(output.next().is_some()); }
        let content_advance = c_progress.position_ms() - speed_c_position;
        assert!((24..=48).contains(&content_advance),
            "2x C must consume about 32 content ms through sixteen real 1000Hz mono output pulls, got {content_advance}");
        assert!(Arc::ptr_eq(&engine.current_source_mount().unwrap(), &physical));
        assert!(Arc::ptr_eq(&physical.progress(), &c_progress));
        assert_eq!(port_a.position_ms(), a_position);

        let mut sleep_after_c = engine.snapshot();
        sleep_after_c.sleep_after_track = true;
        assert!(engine.publish_source_state(&physical, sleep_after_c));
        assert!(!engine.snapshot().sleep_after_track, "source metadata must preserve the actual user sleep scalar");
        if no_next { assert_eq!(engine.remove_queue_indices(&[0, 1]), 2); }
        assert_eq!(engine.snapshot().track_id.as_deref(), Some("C"));
        assert_eq!(engine.snapshot().status, PlaybackStatus::Playing);
        for _ in 0..2_048 {
            if player.empty() { break; }
            assert!(output.next().is_some());
        }
        assert!(player.empty(), "the same Player must naturally drain C's actual remainder");
        assert!(physical.has_drained_eof(), "only the actual outer None can qualify C EOF");
        assert!(c_progress.position_ms() >= 384);
        let c_eof_load_gen = load_gen;
        engine.source_finished(physical.clone());
        let AudioDelivery::AutomaticPlayback { advance, request } =
            inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap()
            else { panic!("the same original C must commit its actual drained EOF"); };
        if no_next {
            assert!(!advance.sleep_fired && advance.track.is_none() && request.is_none(),
                "the actual empty queue stops at C EOF; metadata cannot arm sleep-after-track");
            assert_eq!(advance.target, c);
            assert_eq!(load_gen, c_eof_load_gen, "stopping at C EOF must not invent a successor load");
            let stopped = serde_json::to_value(&advance.snapshot).unwrap();
            assert_eq!(stopped["trackId"], "C");
            assert_eq!(stopped["status"], "stopped");
            assert_eq!(stopped["positionMs"], 384);
            assert_eq!(stopped["durationMs"], 384);
            assert_eq!(stopped["sleepAfterTrack"], false);
            assert_eq!(engine.snapshot().status, PlaybackStatus::Stopped);
            assert!(engine.queue_snapshot().is_empty());
        } else {
            assert!(!advance.sleep_fired);
            assert_eq!(advance.track.as_ref().unwrap().id, "A");
            assert_eq!(load_gen, c_eof_load_gen.wrapping_add(1));
            assert_eq!(advance.target.generation, c.generation + 1);
            assert_eq!((advance.target.platform.as_str(), advance.target.id.as_str()), ("source-a", "A"));
            assert_eq!(engine.queue_snapshot().current().unwrap().id, "A");
            let request = request.expect("C's actual successor must retain its original loader");
            assert_eq!(request.target.as_ref(), Some(&advance.target));
            let fresh_a = request.port.clone().expect("the actual successor reservation");
            assert_eq!(fresh_a.stamp().target, advance.target);
            assert_ne!(fresh_a.stamp().mount_nonce, port_a.stamp().mount_nonce);
            assert!(!Arc::ptr_eq(&fresh_a, &port_a));
            let decoder = request.decode_local_or_report(&engine, &path_a)
                .expect("decode the actual successor from the same owned A file");
            player.append(engine.bind_source(fresh_a.clone(), Box::new(decoder), 0,
                fx.clone(), epoch, None));
            assert!(engine.complete_source_mount(&fresh_a));
            let mut playing = engine.snapshot();
            playing.status = PlaybackStatus::Playing;
            playing.duration_ms = 384;
            playing.is_local = true;
            assert!(engine.publish_source_state(&fresh_a, playing));
            for _ in 0..2_048 {
                assert!(output.next().is_some());
                if fresh_a.position_ms() > 0 { break; }
            }
            assert!(fresh_a.position_ms() > 0);
            assert!(Arc::ptr_eq(&engine.current_source_mount().unwrap(), &fresh_a));
            assert!(engine.set_source_paused(&a, true).is_err(), "earlier same-identity A cannot pause the fresh A mount");
            assert!(engine.set_source_speed(&c, 0.5).is_err(), "finished C cannot change its actual successor");
            assert_eq!(fresh_a.stamp().target, advance.target);
        }
        assert_eq!(port_a.position_ms(), a_position);
    }

    #[test]
    fn failed_original_reserved_loader_advances_while_the_predecessor_is_still_current() {
        use super::{SourceFailureEffect, SourceRecoveryContext};
        use crate::audio::{AudioFx, PlaybackStatus};
        use std::io::{Cursor, Write};
        use std::sync::Arc;
        use std::time::Instant;

        let (engine, inbox) = AudioEngine::command_channel();
        let (player, mut output) = engine.player_channel();
        let mut load_gen = 0;
        let z_ticket = engine.begin_play_intent();
        let mut z_reply = engine.send_queue(vec![track("source-z", "Z")], 0, Some(z_ticket));
        let AudioDelivery::Playback(z_plan) = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen)
            .unwrap() else { panic!("the real predecessor queue must commit"); };
        let z = z_reply.try_recv().unwrap().target.unwrap();
        let port_z = z_plan.port.clone().unwrap();
        let wav = include_bytes!("../../tests/fixtures/self-authored-silence.wav");
        let decoder = rodio::Decoder::new(Cursor::new(wav.to_vec())).unwrap();
        player.append(engine.bind_source(port_z.clone(), Box::new(decoder), 0,
            Arc::new(AudioFx::new()), Instant::now(), None));
        assert!(engine.complete_source_mount(&port_z));
        let mut metadata = engine.snapshot();
        metadata.status = PlaybackStatus::Playing;
        metadata.duration_ms = 384;
        assert!(engine.publish_source_state(&port_z, metadata));
        for _ in 0..128 { assert!(output.next().is_some()); }
        assert!(port_z.position_ms() > 0, "Z really plays before A starts loading");
        assert!(!player.empty(), "the predecessor has not naturally drained");

        let a_ticket = engine.begin_play_intent();
        let mut a_reply = engine.send_queue(vec![track("source-a", "A"), track("source-c", "C")],
            0, Some(a_ticket));
        let AudioDelivery::Playback(a_plan) = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen)
            .unwrap() else { panic!("A must commit its original loading request"); };
        let a = a_reply.try_recv().unwrap().target.unwrap();
        let port_a = a_plan.port.clone().unwrap();
        assert_eq!(load_gen, 2);
        assert!(Arc::ptr_eq(&engine.current_source_mount().unwrap(), &port_z));
        assert!(!Arc::ptr_eq(&port_a, &port_z));
        let request_a = engine.prepare_source_load(a_plan.track.clone().unwrap(), Some(a.clone()),
            Some(port_a.clone()), load_gen, true, 0).expect("the original reserved A loader");
        let bad_path = crate::public_test_fixture::root().join("failed-original-reserved-loader-invalid-audio.bin");
        let mut bad = std::fs::OpenOptions::new().write(true).create_new(true).open(&bad_path).unwrap();
        bad.write_all(b"owned fixture: this is deliberately not an audio container").unwrap();
        bad.flush().unwrap();
        drop(bad);
        let detail = request_a.decode_local_or_report(&engine, &bad_path).err()
            .expect("the actual local decoder must reject the owned invalid bytes");
        assert!(detail.contains("解码失败"), "File::open succeeded; the decoder really failed: {detail}");
        let AudioDelivery::SourceFailure(input) = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen)
            .unwrap() else { panic!("the real failure packet must reach the production inbox"); };
        assert!(Arc::ptr_eq(&input.original, &port_a));
        assert_eq!(input.original.stamp().target, a);
        assert_eq!((input.kind, input.track_id.as_str(), input.gen, input.autoplay, input.stalled),
            ("load", "A", 2, true, false));
        assert!(input.message.contains(&detail));
        assert!(Arc::ptr_eq(&engine.current_source_mount().unwrap(), &port_z));
        let mut recovery = SourceRecoveryContext {
            auto_next: true, fail_streak: 0, failed_tracks: std::collections::HashSet::new(),
        };
        let applied = engine.apply_source_failure(*input, &mut recovery, &mut load_gen)
            .expect("the original reserved A failure is valid even when physical current is Z");
        assert_eq!(engine.queue_snapshot().current().unwrap().id, "C");
        assert_eq!(engine.snapshot().track_id.as_deref(), Some("C"));
        assert_eq!(engine.snapshot().status, PlaybackStatus::Loading);
        assert_eq!(load_gen, 3, "only one real loading generation is added for C");
        assert_eq!(recovery.fail_streak, 1);
        assert!(recovery.failed_tracks.contains("A"));
        assert!(recovery.auto_next);
        let SourceFailureEffect::Advance { track: selected, target, request } = applied.effect
            else { panic!("ordinary original failure must recover to the real next candidate"); };
        assert_eq!(selected.id, "C");
        let request = request.expect("actual failure-selected C has no valid original C loader/port");
        let c = request.target.clone().unwrap();
        let port_c = request.port.clone().unwrap();
        assert_eq!((c.platform.as_str(), c.id.as_str()), ("source-c", "C"));
        assert_eq!(target, c);
        assert!(c.generation > a.generation && a.generation > z.generation);
        assert_eq!(port_c.stamp().target, c);
        assert_ne!(port_c.stamp().mount_nonce, port_a.stamp().mount_nonce);
        assert_ne!(port_c.stamp().mount_nonce, port_z.stamp().mount_nonce);
        assert!(!Arc::ptr_eq(&port_c, &port_a) && !Arc::ptr_eq(&port_c, &port_z));
        assert!(Arc::ptr_eq(&engine.current_source_mount().unwrap(), &port_z));
        let decoder = rodio::Decoder::new(Cursor::new(wav.to_vec())).unwrap();
        player.append(engine.bind_source(port_c.clone(), Box::new(decoder), 0,
            Arc::new(AudioFx::new()), Instant::now(), None));
        assert!(engine.complete_source_mount(&port_c), "complete the same actual C reservation");
        assert!(Arc::ptr_eq(&engine.current_source_mount().unwrap(), &port_c));
        assert!(engine.set_source_speed(&c, 2.0).is_ok());
        assert_eq!(port_c.speed(), 2.0);
        for _ in 0..8_192 {
            assert!(output.next().is_some());
            if port_c.position_ms() > 0 { break; }
        }
        assert!(port_c.position_ms() > 0, "the actual failure-selected C reaches software output");
    }

    #[test]
    fn original_reserved_loader_failure_cannot_mutate_or_consume_a_preceding_pending_b() {
        use super::SourceRecoveryContext;
        use std::io::Write;
        use std::sync::Arc;

        let (engine, inbox) = AudioEngine::command_channel();
        let mut load_gen = 0;
        let a_ticket = engine.begin_play_intent();
        let mut a_reply = engine.send_queue(vec![track("source-a", "A"), track("source-c", "C")],
            0, Some(a_ticket));
        let AudioDelivery::Playback(a_plan) = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen)
            .unwrap() else { panic!("the original A loading request must commit"); };
        let a = a_reply.try_recv().unwrap().target.unwrap();
        let port_a = a_plan.port.clone().unwrap();
        let request_a = engine.prepare_source_load(a_plan.track.clone().unwrap(), Some(a.clone()),
            Some(port_a.clone()), load_gen, true, 0).unwrap();
        let b = engine.begin_play_intent();
        let before = serde_json::to_value(engine.snapshot()).unwrap();
        let before_queue = engine.queue_snapshot();
        let before_tracks = serde_json::to_value(&before_queue.tracks).unwrap();
        let before_gen = load_gen;
        let mut recovery = SourceRecoveryContext {
            auto_next: true, fail_streak: 0, failed_tracks: std::collections::HashSet::new(),
        };
        let bad_path = crate::public_test_fixture::root().join("pending-b-before-original-loader-failure.bin");
        let mut bad = std::fs::OpenOptions::new().write(true).create_new(true).open(&bad_path).unwrap();
        bad.write_all(b"owned invalid audio bytes for the original pending loader").unwrap();
        bad.flush().unwrap();
        drop(bad);
        let detail = request_a.decode_local_or_report(&engine, &bad_path).err().unwrap();
        assert!(detail.contains("解码失败"));
        let AudioDelivery::SourceFailure(input) = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen)
            .unwrap() else { panic!("consume the actual original failure packet while B is still pending"); };
        assert!(Arc::ptr_eq(&input.original, &port_a));
        assert_eq!(input.gen, before_gen);
        assert!(engine.apply_source_failure(*input, &mut recovery, &mut load_gen).is_none());
        // Assert before B is submitted, so its later commit cannot hide an A mutation.
        assert_eq!(serde_json::to_value(engine.snapshot()).unwrap(), before);
        let after_queue = engine.queue_snapshot();
        assert_eq!(after_queue.index, before_queue.index);
        assert_eq!(serde_json::to_value(&after_queue.tracks).unwrap(), before_tracks);
        assert_eq!(load_gen, before_gen);
        assert!(recovery.auto_next);
        assert_eq!(recovery.fail_streak, 0);
        assert!(recovery.failed_tracks.is_empty());
        assert!(engine.current_source_mount().is_none());
        let mut b_reply = engine.send_queue(vec![track("source-b", "B")], 0, Some(b));
        let AudioDelivery::Playback(b_plan) = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen)
            .unwrap() else { panic!("the same original pending B ticket must remain usable"); };
        let ack = b_reply.try_recv().unwrap();
        assert!(ack.applied);
        let target_b = ack.target.unwrap();
        assert_eq!(target_b.generation, b);
        assert_eq!((target_b.platform.as_str(), target_b.id.as_str()), ("source-b", "B"));
        assert_eq!(b_plan.target.as_ref(), Some(&target_b));
        assert_eq!(b_plan.port.as_ref().unwrap().stamp().target, target_b);
        assert_eq!(engine.snapshot().track_id.as_deref(), Some("B"));
        assert_eq!(load_gen, before_gen + 1, "only original B adds one loading generation");
    }

    #[test]
    fn queued_original_loader_failure_cannot_mutate_or_consume_a_later_pending_b() {
        use super::SourceRecoveryContext;
        use std::io::Write;
        use std::sync::Arc;

        let (engine, inbox) = AudioEngine::command_channel();
        let mut load_gen = 0;
        let a_ticket = engine.begin_play_intent();
        let mut a_reply = engine.send_queue(vec![track("source-a", "A"), track("source-c", "C")],
            0, Some(a_ticket));
        let AudioDelivery::Playback(a_plan) = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen)
            .unwrap() else { panic!("the original A loader must be prepared first"); };
        let a = a_reply.try_recv().unwrap().target.unwrap();
        let port_a = a_plan.port.clone().unwrap();
        let request_a = engine.prepare_source_load(a_plan.track.clone().unwrap(), Some(a),
            Some(port_a.clone()), load_gen, true, 0).unwrap();
        let bad_path = crate::public_test_fixture::root().join("original-loader-failure-queued-before-pending-b.bin");
        let mut bad = std::fs::OpenOptions::new().write(true).create_new(true).open(&bad_path).unwrap();
        bad.write_all(b"owned invalid audio: A fails before the original B ticket begins").unwrap();
        bad.flush().unwrap();
        drop(bad);
        let detail = request_a.decode_local_or_report(&engine, &bad_path).err().unwrap();
        assert!(detail.contains("解码失败"));
        // A's real failure is already queued. B then begins, but is not submitted yet.
        let b = engine.begin_play_intent();
        let before = serde_json::to_value(engine.snapshot()).unwrap();
        let before_queue = engine.queue_snapshot();
        let before_tracks = serde_json::to_value(&before_queue.tracks).unwrap();
        let before_gen = load_gen;
        let mut recovery = SourceRecoveryContext {
            auto_next: true, fail_streak: 0, failed_tracks: std::collections::HashSet::new(),
        };
        let AudioDelivery::SourceFailure(input) = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen)
            .unwrap() else { panic!("receive the same A failure after original B begins"); };
        assert!(Arc::ptr_eq(&input.original, &port_a));
        assert_eq!(input.gen, before_gen);
        assert!(engine.apply_source_failure(*input, &mut recovery, &mut load_gen).is_none());
        assert_eq!(serde_json::to_value(engine.snapshot()).unwrap(), before);
        let after_queue = engine.queue_snapshot();
        assert_eq!(after_queue.index, before_queue.index);
        assert_eq!(serde_json::to_value(&after_queue.tracks).unwrap(), before_tracks);
        assert_eq!(load_gen, before_gen);
        assert!(recovery.auto_next && recovery.failed_tracks.is_empty());
        assert_eq!(recovery.fail_streak, 0);
        let mut b_reply = engine.send_queue(vec![track("source-b", "B")], 0, Some(b));
        let AudioDelivery::Playback(b_plan) = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen)
            .unwrap() else { panic!("A's queued failure must not consume the original pending B ticket"); };
        let ack = b_reply.try_recv().unwrap();
        assert!(ack.applied);
        let target_b = ack.target.unwrap();
        assert_eq!(target_b.generation, b);
        assert_eq!((target_b.platform.as_str(), target_b.id.as_str()), ("source-b", "B"));
        assert_eq!(b_plan.target.as_ref(), Some(&target_b));
        assert_eq!(b_plan.port.as_ref().unwrap().stamp().target, target_b);
        assert_eq!(engine.snapshot().track_id.as_deref(), Some("B"));
        assert_eq!(load_gen, before_gen + 1, "only B starts a new loading generation");
    }

    #[test]
    fn late_original_loader_failure_cannot_replace_a_same_target_remount() {
        use super::SourceRecoveryContext;
        use crate::audio::{AudioFx, PlaybackStatus};
        use std::io::{Cursor, Write};
        use std::sync::Arc;
        use std::time::Instant;

        let (engine, inbox) = AudioEngine::command_channel();
        let (player, mut output) = engine.player_channel();
        let mut load_gen = 0;
        let ticket = engine.begin_play_intent();
        let mut reply = engine.send_queue(vec![track("source-a", "A"), track("source-c", "C")],
            0, Some(ticket));
        let AudioDelivery::Playback(plan) = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen)
            .unwrap() else { panic!("prepare original A through the real channel"); };
        let a = reply.try_recv().unwrap().target.unwrap();
        let old_port = plan.port.clone().unwrap();
        let request = engine.prepare_source_load(plan.track.clone().unwrap(), Some(a.clone()),
            Some(old_port.clone()), load_gen, true, 0).unwrap();
        let path = crate::public_test_fixture::root().join("old-loader-failure-before-same-target-remount.bin");
        let mut bad = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).unwrap();
        bad.write_all(b"owned invalid audio for the old physical incarnation of A").unwrap();
        bad.flush().unwrap();
        drop(bad);
        assert!(request.decode_local_or_report(&engine, &path).err().unwrap().contains("解码失败"));
        let replacement = engine.reserve_source_mount(a.clone()).unwrap();
        assert_eq!(replacement.stamp().target, old_port.stamp().target);
        assert_ne!(replacement.stamp().mount_nonce, old_port.stamp().mount_nonce);
        assert!(!Arc::ptr_eq(&replacement, &old_port));
        let wav = include_bytes!("../../tests/fixtures/self-authored-silence.wav");
        let decoder = rodio::Decoder::new(Cursor::new(wav.to_vec())).unwrap();
        player.append(engine.bind_source(replacement.clone(), Box::new(decoder), 0,
            Arc::new(AudioFx::new()), Instant::now(), None));
        assert!(engine.complete_source_mount(&replacement));
        let mut playing = engine.snapshot();
        playing.status = PlaybackStatus::Playing;
        playing.duration_ms = 384;
        assert!(engine.publish_source_state(&replacement, playing));
        for _ in 0..128 { assert!(output.next().is_some()); }
        assert!(replacement.position_ms() > 0 && !player.empty());
        engine.set_source_speed(&a, 0.5).unwrap();
        assert_eq!(engine.set_source_paused(&a, true).unwrap(), *replacement.stamp());
        let before = serde_json::to_value(engine.snapshot()).unwrap();
        let queue_before = engine.queue_snapshot();
        let tracks_before = serde_json::to_value(&queue_before.tracks).unwrap();
        let before_gen = load_gen;
        let position_before = replacement.position_ms();
        let mut recovery = SourceRecoveryContext {
            auto_next: true, fail_streak: 0, failed_tracks: std::collections::HashSet::new(),
        };
        let AudioDelivery::SourceFailure(input) = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen)
            .unwrap() else { panic!("receive the old A failure, not a replacement packet"); };
        assert!(Arc::ptr_eq(&input.original, &old_port));
        assert_eq!(input.gen, before_gen, "a loading-generation mismatch must not conceal physical ABA");
        assert!(engine.apply_source_failure(*input, &mut recovery, &mut load_gen).is_none());
        assert_eq!(serde_json::to_value(engine.snapshot()).unwrap(), before);
        let after = engine.queue_snapshot();
        assert_eq!(after.index, queue_before.index);
        assert_eq!(serde_json::to_value(&after.tracks).unwrap(), tracks_before);
        assert_eq!(load_gen, before_gen);
        assert!(recovery.auto_next && recovery.failed_tracks.is_empty());
        assert_eq!(recovery.fail_streak, 0);
        assert!(Arc::ptr_eq(&engine.current_source_mount().unwrap(), &replacement));
        for _ in 0..128 { assert!(output.next().is_some()); }
        assert_eq!(replacement.position_ms(), position_before, "the replacement remains paused");
        assert_eq!(engine.set_source_paused(&a, false).unwrap(), *replacement.stamp());
        for _ in 0..512 { assert!(output.next().is_some()); }
        assert!(replacement.position_ms() > position_before, "the same replacement resumes real output");
        assert!(!player.empty());
    }

    #[test]
    fn deleting_playing_a_advances_to_its_existing_queue_successor_after_real_eof() {
        use super::AudioCmd;
        use crate::audio::{AudioFx, PlaybackStatus};
        use std::io::Cursor;
        use std::sync::Arc;
        use std::time::Instant;

        let (engine, inbox) = AudioEngine::command_channel();
        let (player, mut output) = engine.player_channel();
        let mut load_gen = 0;
        let ticket = engine.begin_play_intent();
        let mut reply = engine.send_queue(vec![track("source-a", "A"), track("source-b", "B"),
            track("source-c", "C")], 0, Some(ticket));
        let AudioDelivery::Playback(plan) = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen)
            .unwrap() else { panic!("the original A queue must commit"); };
        let a = reply.try_recv().unwrap().target.unwrap();
        let port_a = plan.port.clone().unwrap();
        let wav = include_bytes!("../../tests/fixtures/self-authored-silence.wav");
        let decoder = rodio::Decoder::new(Cursor::new(wav.to_vec())).unwrap();
        player.append(engine.bind_source(port_a.clone(), Box::new(decoder), 0,
            Arc::new(AudioFx::new()), Instant::now(), None));
        assert!(engine.complete_source_mount(&port_a));
        let mut playing = engine.snapshot();
        playing.status = PlaybackStatus::Playing;
        playing.duration_ms = 384;
        assert!(engine.publish_source_state(&port_a, playing));
        for _ in 0..128 { assert!(output.next().is_some()); }
        assert!(port_a.position_ms() > 0 && !player.empty());
        engine.send(AudioCmd::RemoveAt(0));
        let AudioDelivery::Command(AudioCmd::RemoveAt(index)) =
            inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap()
            else { panic!("receive the actual deletion command"); };
        assert_eq!(engine.remove_queue_indices(&[index]), 1);
        assert_eq!(engine.queue_snapshot().current().unwrap().id, "B");
        assert_eq!(engine.queue_snapshot().len(), 2);
        assert_eq!(engine.snapshot().track_id.as_deref(), Some("A"));
        assert_eq!(engine.snapshot().status, PlaybackStatus::Playing);
        assert_eq!(engine.snapshot().queue_len, 2);
        assert_eq!(load_gen, 1, "deleting the queue entry does not select or reload B");
        assert!(Arc::ptr_eq(&engine.current_source_mount().unwrap(), &port_a));
        for _ in 0..8_192 {
            if player.empty() { break; }
            assert!(output.next().is_some());
        }
        assert!(player.empty());
        assert!(port_a.position_ms() >= 384, "the deleted physical A really reaches EOF");
        engine.source_finished(port_a.clone());
        let AudioDelivery::AutomaticPlayback { advance, request } =
            inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap()
            else { panic!("advance the original deleted A through the shared EOF commit"); };
        assert_eq!(advance.track.as_ref().unwrap().id, "B", "do not skip the existing successor to C");
        assert_eq!(advance.target.generation, a.generation + 1);
        assert_eq!((advance.target.platform.as_str(), advance.target.id.as_str()), ("source-b", "B"));
        assert_eq!(load_gen, 2);
        assert_eq!(engine.snapshot().track_id.as_deref(), Some("B"));
        assert_eq!(engine.snapshot().status, PlaybackStatus::Loading);
        assert_eq!(engine.queue_snapshot().current().unwrap().id, "B");
        let request = request.expect("the existing successor B needs its actual original loader");
        assert_eq!(request.target.as_ref(), Some(&advance.target));
        let port_b = request.port.clone().unwrap();
        assert_ne!(port_b.stamp().mount_nonce, port_a.stamp().mount_nonce);
        assert_eq!(port_b.stamp().target, advance.target);
        let decoder = rodio::Decoder::new(Cursor::new(wav.to_vec())).unwrap();
        player.append(engine.bind_source(port_b.clone(), Box::new(decoder), 0,
            Arc::new(AudioFx::new()), Instant::now(), None));
        assert!(engine.complete_source_mount(&port_b));
        engine.set_source_speed(&advance.target, 2.0).unwrap();
        // Player/render buffering is not an immediate 128-pull activation contract.
        // Use the same bounded normal-output budget as the existing genuine EOF loader test.
        for _ in 0..2_048 {
            assert!(output.next().is_some());
            if port_b.position_ms() > 0 { break; }
        }
        assert!(port_b.position_ms() > 0, "the same selected successor B reaches actual output");
    }

    #[test]
    fn batch_deleting_a_middle_playing_track_retains_its_original_successor_after_real_eof() {
        use super::AudioCmd;
        use crate::audio::{AudioFx, PlaybackStatus};
        use std::io::Cursor;
        use std::sync::Arc;
        use std::time::Instant;

        let (engine, inbox) = AudioEngine::command_channel();
        let (player, mut output) = engine.player_channel();
        let mut load_gen = 0;
        let ticket = engine.begin_play_intent();
        let mut reply = engine.send_queue(vec![track("source-x", "X"), track("source-y", "Y"),
            track("source-a", "A"), track("source-b", "B"), track("source-c", "C")],
            2, Some(ticket));
        let AudioDelivery::Playback(plan) = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen)
            .unwrap() else { panic!("the original middle A queue must commit"); };
        let a = reply.try_recv().unwrap().target.unwrap();
        let port_a = plan.port.clone().unwrap();
        let wav = include_bytes!("../../tests/fixtures/self-authored-silence.wav");
        let decoder = rodio::Decoder::new(Cursor::new(wav.to_vec())).unwrap();
        player.append(engine.bind_source(port_a.clone(), Box::new(decoder), 0,
            Arc::new(AudioFx::new()), Instant::now(), None));
        assert!(engine.complete_source_mount(&port_a));
        let mut playing = engine.snapshot();
        playing.status = PlaybackStatus::Playing;
        playing.duration_ms = 384;
        assert!(engine.publish_source_state(&port_a, playing));
        for _ in 0..128 { assert!(output.next().is_some()); }
        assert!(port_a.position_ms() > 0 && !player.empty());
        // Delete the tail, the physical-current middle A, and a predecessor;
        // duplicates and an out-of-range index must retain the original B choice.
        engine.send(AudioCmd::RemoveIndices(vec![4, 0, 2, 2, 99]));
        let AudioDelivery::Command(AudioCmd::RemoveIndices(indices)) =
            inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap()
            else { panic!("receive the actual batch deletion command"); };
        assert_eq!(engine.remove_queue_indices(&indices), 3);
        let remaining = engine.queue_snapshot();
        assert_eq!(remaining.len(), 2);
        assert_eq!(remaining.current().unwrap().id, "B");
        assert_eq!(engine.snapshot().track_id.as_deref(), Some("A"));
        assert_eq!(engine.snapshot().status, PlaybackStatus::Playing);
        assert_eq!(engine.snapshot().queue_len, 2);
        assert_eq!(load_gen, 1, "batch deletion does not select or reload B");
        assert!(Arc::ptr_eq(&engine.current_source_mount().unwrap(), &port_a));
        for _ in 0..8_192 {
            if player.empty() { break; }
            assert!(output.next().is_some());
        }
        assert!(player.empty());
        assert!(port_a.position_ms() >= 384, "the deleted middle A actually finishes");
        engine.source_finished(port_a.clone());
        let AudioDelivery::AutomaticPlayback { advance, request } =
            inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap()
            else { panic!("advance the original batch-deleted A through the shared EOF commit"); };
        assert_eq!(advance.track.as_ref().unwrap().id, "B", "retain B, not the preceding Y");
        assert_eq!(advance.target.generation, a.generation + 1);
        assert_eq!((advance.target.platform.as_str(), advance.target.id.as_str()), ("source-b", "B"));
        assert_eq!(load_gen, 2);
        assert_eq!(engine.snapshot().track_id.as_deref(), Some("B"));
        assert_eq!(engine.snapshot().status, PlaybackStatus::Loading);
        let request = request.expect("the original batch successor B needs its actual loader");
        assert_eq!(request.target.as_ref(), Some(&advance.target));
        let port_b = request.port.clone().unwrap();
        assert_ne!(port_b.stamp().mount_nonce, port_a.stamp().mount_nonce);
        assert_eq!(port_b.stamp().target, advance.target);
        let decoder = rodio::Decoder::new(Cursor::new(wav.to_vec())).unwrap();
        player.append(engine.bind_source(port_b.clone(), Box::new(decoder), 0,
            Arc::new(AudioFx::new()), Instant::now(), None));
        assert!(engine.complete_source_mount(&port_b));
        engine.set_source_speed(&advance.target, 2.0).unwrap();
        for _ in 0..2_048 {
            assert!(output.next().is_some());
            if port_b.position_ms() > 0 { break; }
        }
        assert!(port_b.position_ms() > 0, "the original batch successor B reaches actual output");
    }

    #[test]
    fn naturally_drained_original_source_advances_to_a_new_owned_loader_and_controls() {
        use crate::audio::{AudioFx, PlaybackStatus};
        use std::io::Cursor;
        use std::sync::Arc;
        use std::time::Instant;

        let (engine, inbox) = AudioEngine::command_channel();
        let (player, mut output) = engine.player_channel();
        let original_a = engine.begin_play_intent();
        let mut reply = engine.send_queue(vec![track("source-a", "A"), track("source-c", "C")],
            0, Some(original_a));
        let mut load_gen = 0;
        let AudioDelivery::Playback(plan) = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen)
            .unwrap() else { panic!("the real A queue must commit"); };
        let a = reply.try_recv().unwrap().target.unwrap();
        let port_a = plan.port.clone().expect("A's actual reserved physical incarnation");
        let wav = include_bytes!("../../tests/fixtures/self-authored-silence.wav");
        let decoder = rodio::Decoder::new(Cursor::new(wav.to_vec())).unwrap();
        player.append(engine.bind_source(port_a.clone(), Box::new(decoder), 0,
            Arc::new(AudioFx::new()), Instant::now(), None));
        assert!(engine.complete_source_mount(&port_a));
        let mut metadata = engine.snapshot();
        metadata.status = PlaybackStatus::Playing;
        metadata.duration_ms = 384; // 3072 owned mono samples / 8000 Hz.
        assert!(engine.publish_source_state(&port_a, metadata));
        for _ in 0..8_192 {
            if player.empty() { break; }
            assert!(output.next().is_some(), "software output must be consumed normally");
        }
        assert!(player.empty(), "finite owned WAV must naturally drain, without clear or retire");
        assert!(port_a.position_ms() >= 384, "the original decoder's samples really played");
        assert_eq!(load_gen, 1);

        engine.source_finished(port_a.clone());
        let AudioDelivery::AutomaticPlayback { advance, request } = inbox
            .recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap()
            else { panic!("natural EOF must select C through the production inbox"); };
        assert_eq!(engine.queue_snapshot().current().unwrap().id, "C");
        assert_eq!(engine.snapshot().track_id.as_deref(), Some("C"));
        assert_eq!(load_gen, 2, "one real loading generation for C");
        let request = request.expect("actual auto-selected C has no valid original C loader/port");
        let c = request.target.clone().expect("C loader owns its logical target");
        let port_c = request.port.clone().expect("C loader owns its physical reservation");
        assert_eq!((c.platform.as_str(), c.id.as_str()), ("source-c", "C"));
        assert!(c.generation > a.generation);
        assert_eq!(advance.target, c);
        assert_eq!(port_c.stamp().target, c);
        assert_ne!(port_c.stamp().mount_nonce, port_a.stamp().mount_nonce);
        assert!(!Arc::ptr_eq(&port_a, &port_c));
        let decoder = rodio::Decoder::new(Cursor::new(wav.to_vec())).unwrap();
        player.append(engine.bind_source(port_c.clone(), Box::new(decoder), 0,
            Arc::new(AudioFx::new()), Instant::now(), None));
        assert!(engine.complete_source_mount(&port_c), "complete the same actual C request");
        assert!(Arc::ptr_eq(&engine.current_source_mount().unwrap(), &port_c));
        assert!(engine.set_source_speed(&c, 2.0).is_ok(), "Some(C) controls its own new port");
        assert_eq!(port_c.speed(), 2.0);
        for _ in 0..2_048 {
            output.next();
            if port_c.position_ms() > 0 { break; }
        }
        assert!(port_c.position_ms() > 0, "the same C port reaches the real software output");
    }

    fn assert_drained_a_does_not_consume_pending_b(event_before_b: bool) {
        use crate::audio::{AudioFx, PlaybackStatus};
        use std::io::Cursor;
        use std::sync::Arc;
        use std::time::Instant;

        let (engine, inbox) = AudioEngine::command_channel();
        let (player, mut output) = engine.player_channel();
        let a = engine.begin_play_intent();
        let mut a_reply = engine.send_queue(vec![track("source-a", "A"), track("source-c", "C")], 0, Some(a));
        let mut load_gen = 0;
        let AudioDelivery::Playback(a_plan) = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen)
            .unwrap() else { panic!("actual original A queue"); };
        assert_eq!(a_reply.try_recv().unwrap().target.unwrap().generation, a);
        let port = a_plan.port.clone().unwrap();
        let decoder = rodio::Decoder::new(Cursor::new(
            include_bytes!("../../tests/fixtures/self-authored-silence.wav").to_vec())).unwrap();
        player.append(engine.bind_source(port.clone(), Box::new(decoder), 0,
            Arc::new(AudioFx::new()), Instant::now(), None));
        assert!(engine.complete_source_mount(&port));
        let mut metadata = engine.snapshot();
        metadata.status = PlaybackStatus::Playing;
        metadata.duration_ms = 384;
        assert!(engine.publish_source_state(&port, metadata));
        for _ in 0..8_192 {
            if player.empty() { break; }
            assert!(output.next().is_some());
        }
        assert!(player.empty());
        assert!(port.position_ms() >= 384, "A genuinely drained before either pending ordering");

        if event_before_b { engine.source_finished(port.clone()); }
        let b = engine.begin_play_intent();
        if !event_before_b { engine.source_finished(port.clone()); }
        let before = serde_json::to_value(engine.snapshot()).unwrap();
        let before_queue = engine.queue_snapshot();
        let before_tracks = serde_json::to_value(&before_queue.tracks).unwrap();
        let before_gen = load_gen;
        assert!(matches!(inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap(),
            AudioDelivery::Rejected));
        // Observe before submitting B: a later B commit cannot conceal an A mutation.
        assert_eq!(serde_json::to_value(engine.snapshot()).unwrap(), before);
        let after_queue = engine.queue_snapshot();
        assert_eq!(after_queue.index, before_queue.index);
        assert_eq!(serde_json::to_value(&after_queue.tracks).unwrap(), before_tracks);
        assert_eq!(load_gen, before_gen);
        assert!(Arc::ptr_eq(&engine.current_source_mount().unwrap(), &port));

        let mut b_reply = engine.send_queue(vec![track("source-b", "B")], 0, Some(b));
        let AudioDelivery::Playback(b_plan) = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen)
            .unwrap() else { panic!("the same original pending B ticket must still commit"); };
        let b_ack = b_reply.try_recv().unwrap();
        assert!(b_ack.applied);
        let b_target = b_ack.target.unwrap();
        assert_eq!(b_target.generation, b, "A EOF must not consume or replace original B");
        assert_eq!((b_target.platform.as_str(), b_target.id.as_str()), ("source-b", "B"));
        assert_eq!(b_plan.target.as_ref(), Some(&b_target));
        assert_eq!(b_plan.port.as_ref().unwrap().stamp().target, b_target);
        assert_eq!(engine.snapshot().track_id.as_deref(), Some("B"));
        assert_eq!(load_gen, before_gen + 1, "only B commits a new loading generation");
    }

    #[test]
    fn naturally_drained_a_cannot_advance_if_original_b_begins_before_its_event() {
        assert_drained_a_does_not_consume_pending_b(false);
    }

    #[test]
    fn naturally_drained_a_cannot_advance_if_original_b_begins_after_its_event_is_queued() {
        assert_drained_a_does_not_consume_pending_b(true);
    }

    #[tokio::test]
    async fn native_queue_filter_wait_cannot_register_a_late_intent_over_b() {
        let (engine, inbox) = AudioEngine::command_channel();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let (filtered_tx, filtered_rx) = tokio::sync::oneshot::channel();
        let engine_a = engine.clone();
        let a_work = tokio::spawn(async move {
            engine_a.queue_after_filter(
                vec![track("source-a", "7")], 0, None,
                move |tracks, index| async move {
                    entered_tx.send(()).expect("A entered the fake DB adapter");
                    release_rx.await.expect("the DB hold was released");
                    filtered_tx.send(()).expect("A's filtered result was observed");
                    Ok((tracks, index))
                },
            ).await
        });
        entered_rx.await.expect("A is waiting in the production filtering boundary");

        let original_b = engine.begin_play_intent();
        let mut b_reply = engine.send_queue(vec![track("source-b", "7")], 0, Some(original_b));
        let mut load_gen = 0;
        let b_delivery = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let b_receipt = b_reply.try_recv().expect("B got its own production receipt");
        assert!(b_receipt.applied && matches!(b_delivery, AudioDelivery::Playback(_)));
        let b_target = b_receipt.target.expect("B's accepted logical target");
        assert_eq!((b_target.generation, b_target.platform.as_str(), b_target.id.as_str()),
            (original_b, "source-b", "7"));
        let before = serde_json::to_value(engine.snapshot()).unwrap();
        assert_eq!(load_gen, 1);

        release_tx.send(()).expect("release A's fake DB filter");
        filtered_rx.await.expect("A's public queue operation reached the real sender");
        let a_delivery = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let a_receipt = a_work.await.expect("A's native queue task completed")
            .expect("a stale queue is a rejected receipt, not a DB error");
        let queue = engine.queue_snapshot();
        let current = queue.current().expect("the accepted B queue is retained");
        assert!(
            !a_receipt.applied && matches!(a_delivery, AudioDelivery::Rejected)
                && (current.platform.as_str(), current.id.as_str()) == ("source-b", "7")
                && serde_json::to_value(engine.snapshot()).unwrap() == before
                && load_gen == 1,
            "filtered native A registered too late and replaced accepted B: receipt={a_receipt:?}, track={:?}, load_gen={load_gen}",
            engine.snapshot().track_id,
        );
        assert!(!engine.abandon_play_intent(original_b), "A must not revoke committed B");
    }

    #[tokio::test]
    async fn failed_queue_filter_releases_only_its_original_pending_intent() {
        let (engine, inbox) = AudioEngine::command_channel();
        let before = serde_json::to_value(engine.snapshot()).unwrap();
        let original_a = engine.begin_play_intent();
        let error = engine.queue_after_filter(
            vec![track("source-a", "7")], 0, Some(original_a),
            |_, _| async { Err("synthetic-db-filter-failure".to_string()) },
        ).await;
        assert_eq!(error.unwrap_err(), "synthetic-db-filter-failure");

        // A failed action is finished: resending its original ticket cannot revive it.
        let mut late_a_reply = engine.send_queue(vec![track("source-a", "7")], 0, Some(original_a));
        let mut load_gen = 0;
        let late_a_delivery = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let late_a_receipt = late_a_reply.try_recv().expect("the old A message was answered");
        assert!(
            !late_a_receipt.applied && matches!(late_a_delivery, AudioDelivery::Rejected)
                && engine.queue_snapshot().is_empty()
                && serde_json::to_value(engine.snapshot()).unwrap() == before
                && load_gen == 0,
            "failed native DB filtering left A pending and revivable: receipt={late_a_receipt:?}, load_gen={load_gen}",
        );
        assert!(!engine.abandon_play_intent(original_a), "A's finally already released its ticket");

        // A's late failure must not release a newer B that has not committed yet.
        let original_a2 = engine.begin_play_intent();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let engine_a2 = engine.clone();
        let a2_work = tokio::spawn(async move {
            engine_a2.queue_after_filter(
                vec![track("source-a2", "7")], 0, Some(original_a2),
                move |_, _| async move {
                    entered_tx.send(()).expect("A2 entered its DB hold");
                    release_rx.await.expect("A2's hold was released");
                    Err("synthetic-late-db-failure".to_string())
                },
            ).await
        });
        entered_rx.await.expect("A2 is waiting");
        let original_b = engine.begin_play_intent();
        release_tx.send(()).expect("release A2 after B declares ownership");
        assert_eq!(a2_work.await.unwrap().unwrap_err(), "synthetic-late-db-failure");
        let mut b_reply = engine.send_queue(vec![track("source-b", "7")], 0, Some(original_b));
        let b_delivery = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let b_receipt = b_reply.try_recv().expect("B still owns its pending ticket");
        assert!(b_receipt.applied && matches!(b_delivery, AudioDelivery::Playback(_)));
        let b_target = b_receipt.target.expect("B's real accepted target");
        assert_eq!((b_target.generation, b_target.platform.as_str(), b_target.id.as_str()),
            (original_b, "source-b", "7"));
        assert_eq!(load_gen, 1);
        assert!(!engine.abandon_play_intent(original_b), "finally does not revoke committed B");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn queued_index_play_cannot_commit_under_a_newer_pending_intent() {
        use std::future::Future;
        let (engine, inbox) = AudioEngine::command_channel();
        let seed_receipt = engine.send_queue(
            vec![track("source-seed", "0"), track("source-a", "7")], 0, None,
        );
        let mut load_gen = 0;
        let seed = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        assert!(matches!(seed, AudioDelivery::Playback(_)));
        assert!(seed_receipt.await.unwrap().applied);
        assert_eq!(load_gen, 1);
        let before = serde_json::to_value(engine.snapshot()).unwrap();

        let original_a = engine.begin_play_intent();
        let a_work = engine.play_at_with_receipt(1, Some(original_a));
        tokio::pin!(a_work);
        let a_waiting = std::future::poll_fn(|cx| {
            std::task::Poll::Ready(a_work.as_mut().poll(cx).is_pending())
        }).await;
        assert!(a_waiting, "the real A index command is queued before B begins");
        let original_b = engine.begin_play_intent();
        let a_delivery = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let a_receipt = a_work.await.unwrap();
        assert!(
            !a_receipt.applied && matches!(a_delivery, AudioDelivery::Rejected)
                && serde_json::to_value(engine.snapshot()).unwrap() == before
                && engine.queue_snapshot().index == Some(0) && load_gen == 1,
            "old queued play_at changed the real native session: receipt={a_receipt:?}, index={:?}, load_gen={load_gen}",
            engine.queue_snapshot().index,
        );

        let b_work = engine.play_at_with_receipt(1, Some(original_b));
        tokio::pin!(b_work);
        assert!(std::future::poll_fn(|cx| {
            std::task::Poll::Ready(b_work.as_mut().poll(cx).is_pending())
        }).await);
        let b_delivery = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let b_receipt = b_work.await.unwrap();
        assert!(b_receipt.applied && matches!(b_delivery, AudioDelivery::ManualPlayback(_)));
        let target = b_receipt.target.unwrap();
        assert_eq!((target.generation, target.platform.as_str(), target.id.as_str()),
            (original_b, "source-a", "7"));
        assert_eq!(engine.queue_snapshot().index, Some(1));
        assert_eq!(load_gen, 2);
        assert!(!engine.abandon_play_intent(original_b));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn queued_next_cannot_rebind_to_b_or_bypass_the_original_skip_rules() {
        use std::future::Future;
        let (engine, inbox) = AudioEngine::command_channel();
        let seed_receipt = engine.send_queue(vec![
            track("source-seed", "0"), track("source-a", "7"), track("source-b", "7"),
        ], 0, None);
        let mut load_gen = 0;
        assert!(matches!(inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap(),
            AudioDelivery::Playback(_)));
        assert!(seed_receipt.await.unwrap().applied);
        let before = serde_json::to_value(engine.snapshot()).unwrap();

        let original_a = engine.begin_play_intent();
        let a_work = engine.next_with_receipt(Some(original_a));
        tokio::pin!(a_work);
        assert!(std::future::poll_fn(|cx| {
            std::task::Poll::Ready(a_work.as_mut().poll(cx).is_pending())
        }).await, "the actual Next message is queued before B begins");
        let original_b = engine.begin_play_intent();
        let a_delivery = inbox.recv_timeout_skipping(Duration::from_secs(5), &mut load_gen,
            |track| track.platform == SourceId::new("source-a")).unwrap();
        let a_receipt = a_work.await.unwrap();
        assert!(
            !a_receipt.applied && matches!(a_delivery, AudioDelivery::Rejected)
                && serde_json::to_value(engine.snapshot()).unwrap() == before
                && engine.queue_snapshot().index == Some(0) && load_gen == 1,
            "old queued next changed the real native session: receipt={a_receipt:?}, index={:?}, load_gen={load_gen}",
            engine.queue_snapshot().index,
        );

        let b_work = engine.next_with_receipt(Some(original_b));
        tokio::pin!(b_work);
        assert!(std::future::poll_fn(|cx| {
            std::task::Poll::Ready(b_work.as_mut().poll(cx).is_pending())
        }).await);
        let b_delivery = inbox.recv_timeout_skipping(Duration::from_secs(5), &mut load_gen,
            |track| track.platform == SourceId::new("source-a")).unwrap();
        let b_receipt = b_work.await.unwrap();
        assert!(b_receipt.applied && matches!(b_delivery, AudioDelivery::NavigationPlayback(_)));
        let b_target = b_receipt.target.unwrap();
        assert_eq!((b_target.generation, b_target.platform.as_str(), b_target.id.as_str()),
            (original_b, "source-b", "7"));
        assert_eq!(engine.queue_snapshot().index, Some(2), "Next skips A, not the other source's id 7");
        assert_eq!(load_gen, 2);
        assert!(!engine.abandon_play_intent(original_b));

        let native_work = engine.next_with_receipt(None);
        tokio::pin!(native_work);
        assert!(std::future::poll_fn(|cx| {
            std::task::Poll::Ready(native_work.as_mut().poll(cx).is_pending())
        }).await);
        assert!(matches!(inbox.recv_timeout_skipping(Duration::from_secs(5), &mut load_gen,
            |track| track.platform == SourceId::new("source-a")).unwrap(),
            AudioDelivery::NavigationPlayback(_)));
        let native_receipt = native_work.await.unwrap();
        assert!(native_receipt.applied, "native/lyrics None begins its own legitimate ticket");
        let native_target = native_receipt.target.unwrap();
        assert!(native_target.generation > original_b);
        assert_eq!((native_target.platform.as_str(), native_target.id.as_str()), ("source-seed", "0"));
        assert_eq!(load_gen, 3);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn queued_previous_keeps_its_original_ticket_and_does_not_apply_next_skip_rules() {
        use std::future::Future;

        let (engine, inbox) = AudioEngine::command_channel();
        let seed = engine.begin_play_intent();
        let seed_receipt = engine.send_queue(
            vec![track("source-seed", "0"), track("source-a", "7"), track("source-b", "7")],
            0, Some(seed),
        );
        let mut load_gen = 0;
        assert!(matches!(inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap(),
            AudioDelivery::Playback(_)));
        assert!(seed_receipt.await.unwrap().applied);
        let before = serde_json::to_value(engine.snapshot()).unwrap();
        assert_eq!(load_gen, 1);

        let original_a = engine.begin_play_intent();
        let a_work = engine.previous_with_receipt(Some(original_a));
        tokio::pin!(a_work);
        assert!(std::future::poll_fn(|cx| {
            std::task::Poll::Ready(a_work.as_mut().poll(cx).is_pending())
        }).await);
        let original_b = engine.begin_play_intent();
        let a_delivery = inbox.recv_timeout_skipping(Duration::from_secs(5), &mut load_gen,
            |_| true).unwrap();
        let a_receipt = a_work.await.unwrap();
        assert!(
            !a_receipt.applied && a_receipt.target.is_none()
                && matches!(a_delivery, AudioDelivery::Rejected)
                && engine.queue_snapshot().index == Some(0)
                && serde_json::to_value(engine.snapshot()).unwrap() == before
                && load_gen == 1,
            "old queued previous changed the real native session: receipt={a_receipt:?}, index={:?}, load_gen={load_gen}",
            engine.queue_snapshot().index,
        );

        let b_work = engine.previous_with_receipt(Some(original_b));
        tokio::pin!(b_work);
        assert!(std::future::poll_fn(|cx| {
            std::task::Poll::Ready(b_work.as_mut().poll(cx).is_pending())
        }).await);
        assert!(matches!(inbox.recv_timeout_skipping(Duration::from_secs(5), &mut load_gen,
            |_| true).unwrap(), AudioDelivery::PreviousPlayback(_)));
        let b_receipt = b_work.await.unwrap();
        assert!(b_receipt.applied, "Previous must retain B and must not skip every disliked track");
        let b_target = b_receipt.target.unwrap();
        assert_eq!((b_target.generation, b_target.platform.as_str(), b_target.id.as_str()),
            (original_b, "source-b", "7"));
        assert_eq!(engine.queue_snapshot().index, Some(2));
        assert_eq!(load_gen, 2);
        assert!(!engine.abandon_play_intent(original_b));

        let native_work = engine.previous_with_receipt(None);
        tokio::pin!(native_work);
        assert!(std::future::poll_fn(|cx| {
            std::task::Poll::Ready(native_work.as_mut().poll(cx).is_pending())
        }).await);
        assert!(matches!(inbox.recv_timeout_skipping(Duration::from_secs(5), &mut load_gen,
            |_| true).unwrap(), AudioDelivery::PreviousPlayback(_)));
        let native_receipt = native_work.await.unwrap();
        assert!(native_receipt.applied, "native/lyrics Previous begins its own legitimate ticket");
        let native_target = native_receipt.target.unwrap();
        assert!(native_target.generation > original_b);
        assert_eq!((native_target.platform.as_str(), native_target.id.as_str()), ("source-a", "7"));
        assert_eq!(engine.queue_snapshot().index, Some(1));
        assert_eq!(load_gen, 3);
    }

    #[test]
    fn queued_single_track_preserves_its_original_ticket_and_source_identity() {
        let (engine, inbox) = AudioEngine::command_channel();
        let mut load_gen = 0;
        let mut seed = engine.send_queue(
            vec![track("seed-source", "seed"), track("source-a", "7")], 0, None,
        );
        assert!(matches!(inbox.recv_timeout(Duration::from_secs(5), &mut load_gen)
            .unwrap(), AudioDelivery::Playback(_)));
        assert!(seed.try_recv().unwrap().applied);
        let original_a = engine.begin_play_intent();
        let mut old = engine.send_play_track(track("source-a", "7"), Some(original_a));
        let original_b = engine.begin_play_intent();
        let before = serde_json::to_value(engine.snapshot()).unwrap();
        assert!(matches!(inbox.recv_timeout(Duration::from_secs(5), &mut load_gen)
            .unwrap(), AudioDelivery::Rejected));
        assert!(!old.try_recv().unwrap().applied);
        assert_eq!(serde_json::to_value(engine.snapshot()).unwrap(), before);
        assert_eq!(load_gen, 1);

        let mut current = engine.send_play_track(track("source-b", "7"), Some(original_b));
        let delivery = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let receipt = current.try_recv().unwrap();
        assert!(receipt.applied && matches!(delivery, AudioDelivery::ManualPlayback(_)),
            "current original B single-track play was not committed: {receipt:?}");
        let target = receipt.target.unwrap();
        assert_eq!((target.generation, target.platform.as_str(), target.id.as_str()),
            (original_b, "source-b", "7"));
        let queue = engine.queue_snapshot();
        assert_eq!(queue.len(), 3, "different sources with the same id must not alias");
        assert_eq!(queue.index, Some(2));
        assert_eq!(engine.snapshot().source_id.as_ref().map(|id| id.as_str()), Some("source-b"));
        assert_eq!(load_gen, 2);
        assert!(!engine.abandon_play_intent(original_b));

        let mut native = engine.send_play_track(track("source-a", "7"), None);
        assert!(matches!(inbox.recv_timeout(Duration::from_secs(5), &mut load_gen)
            .unwrap(), AudioDelivery::ManualPlayback(_)));
        let native_target = native.try_recv().unwrap().target.unwrap();
        assert!(native_target.generation > original_b);
        assert_eq!(native_target.platform, "source-a");
        assert_eq!(engine.queue_snapshot().index, Some(1));
        assert_eq!(engine.queue_snapshot().len(), 3, "existing same-identity track is reused");
        assert_eq!(load_gen, 3);
    }

    #[test]
    fn native_resume_releases_source_pause_and_old_metadata_cannot_pause_it_again() {
        use crate::audio::AudioFx;
        use std::sync::{Arc, atomic::{AtomicU64, Ordering}};
        use std::time::Instant;
        use rodio::{ChannelCount, SampleRate, Source};
        struct Probe(Arc<AtomicU64>);
        impl Iterator for Probe { type Item = f32;
            fn next(&mut self) -> Option<f32> { self.0.fetch_add(1, Ordering::SeqCst); Some(0.25) }
        }
        impl Source for Probe {
            fn current_span_len(&self) -> Option<usize> { None }
            fn channels(&self) -> ChannelCount { ChannelCount::new(1).unwrap() }
            fn sample_rate(&self) -> SampleRate { SampleRate::new(1_000).unwrap() }
            fn total_duration(&self) -> Option<Duration> { None }
        }
        let (engine, inbox) = AudioEngine::command_channel();
        let mut load_gen = 0;
        let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let a = seed.try_recv().unwrap().target.unwrap();
        let port = engine.source_mount(&a).unwrap();
        let reads = Arc::new(AtomicU64::new(0));
        let (player, mut output) = engine.player_channel();
        player.append(engine.bind_source(port.clone(), Box::new(Probe(reads.clone())), 0,
            Arc::new(AudioFx::new()), Instant::now(), None));
        assert!(engine.complete_source_mount(&port));
        for _ in 0..16 { output.next(); }
        engine.set_source_paused(&a, true).unwrap();
        let old_metadata = engine.snapshot();
        let frozen = reads.load(Ordering::SeqCst);
        for _ in 0..16 { assert_eq!(output.next(), Some(0.0)); }
        engine.send(crate::audio::AudioCmd::Play);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        for _ in 0..16 { output.next(); }
        assert!(reads.load(Ordering::SeqCst) > frozen,
            "ordinary native resume left the original source permanently paused");
        assert_eq!(engine.snapshot().status, super::PlaybackStatus::Playing);
        assert!(engine.publish_source_state(&port, old_metadata));
        assert_eq!(engine.snapshot().status, super::PlaybackStatus::Playing,
            "old same-source paused metadata overrode the later native resume");
        let playing_metadata = engine.snapshot();
        engine.set_source_paused(&a, true).unwrap();
        assert!(engine.publish_source_state(&port, playing_metadata));
        assert_eq!(engine.snapshot().status, super::PlaybackStatus::Paused);
        let frozen_again = reads.load(Ordering::SeqCst);
        for _ in 0..16 { assert_eq!(output.next(), Some(0.0)); }
        assert_eq!(reads.load(Ordering::SeqCst), frozen_again);
    }

    #[test]
    fn original_pause_cue_and_status_survive_late_original_load_metadata() {
        use crate::audio::AudioFx;
        use std::sync::Arc;
        use std::time::Instant;
        use rodio::{ChannelCount, SampleRate, Source};
        struct Probe;
        impl Iterator for Probe { type Item = f32; fn next(&mut self) -> Option<f32> { Some(0.25) } }
        impl Source for Probe {
            fn current_span_len(&self) -> Option<usize> { None }
            fn channels(&self) -> ChannelCount { ChannelCount::new(1).unwrap() }
            fn sample_rate(&self) -> SampleRate { SampleRate::new(1_000).unwrap() }
            fn total_duration(&self) -> Option<Duration> { None }
        }
        let (engine, inbox) = AudioEngine::command_channel();
        let mut load_gen = 0;
        let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let a = seed.try_recv().unwrap().target.unwrap();
        let mut metadata = engine.snapshot();
        metadata.status = super::PlaybackStatus::Playing;
        let port = engine.source_mount(&a).unwrap();
        let (player, mut output) = engine.player_channel();
        player.append(engine.bind_source(port.clone(), Box::new(Probe), 0,
            Arc::new(AudioFx::new()), Instant::now(), None));
        assert!(engine.complete_source_mount(&port));
        for _ in 0..64 { output.next(); }
        engine.set_source_paused(&a, true).unwrap();
        assert!(engine.snapshot().position_ms >= 64,
            "original pause exposed the old cue instead of its frozen content position");
        assert!(engine.publish_source_state(&port, metadata));
        assert_eq!(engine.snapshot().status, super::PlaybackStatus::Paused,
            "late original LoadReady replaced the original pause state");
        for _ in 0..16 { assert_eq!(output.next(), Some(0.0)); }
        assert!(engine.snapshot().position_ms >= 64);
    }

    #[test]
    fn podcast_unity_speed_after_stereo_track_keeps_real_time() {
        use crate::audio::AudioFx;
        use rodio::{ChannelCount, SampleRate};
        use std::sync::Arc;
        use std::time::Instant;

        let (engine, inbox) = AudioEngine::command_channel();
        let (player, output) = engine.player_channel();
        let mut load_gen = 0;
        // 和真实设备一样，输出转换器先建立，再异步挂载节目。
        let mut output = super::DeviceSource::new(output,
            ChannelCount::new(2).unwrap(), SampleRate::new(48_000).unwrap());
        for _ in 0..4_800 { output.next(); }

        let mut first = engine.send_queue(vec![track("local", "stereo")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let first = first.try_recv().unwrap().target.unwrap();
        let first_port = engine.source_mount(&first).unwrap();
        let stereo = rodio::buffer::SamplesBuffer::new(ChannelCount::new(2).unwrap(),
            SampleRate::new(44_100).unwrap(), vec![0.2; 44_100 * 2 * 20]);
        player.append(engine.bind_source(first_port.clone(), Box::new(stereo), 0,
            Arc::new(AudioFx::new()), Instant::now(), None));
        assert!(engine.complete_source_mount(&first_port));
        for _ in 0..96_000 { output.next(); }

        let mut next = engine.send_queue(vec![track("podcast", "mono-32k")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let next = next.try_recv().unwrap().target.unwrap();
        let port = engine.source_mount(&next).unwrap();
        // send_queue retires the previous source; let the render iterator
        // consume that boundary without blocking on Player::clear().
        let mono = rodio::buffer::SamplesBuffer::new(ChannelCount::new(1).unwrap(),
            SampleRate::new(32_000).unwrap(), vec![0.3; 32_000 * 20]);
        player.append(engine.bind_source(port.clone(), Box::new(mono), 0,
            Arc::new(AudioFx::new()), Instant::now(), None));
        assert!(engine.complete_source_mount(&port));
        assert_eq!(engine.snapshot().speed, 1.0);
        assert_eq!(player.speed(), 1.0);
        assert_eq!(port.speed(), 1.0);
        // 切换过渡结束后，输出 1 秒立体声，内容时间也必须只前进 1 秒。
        for _ in 0..9_600 { output.next(); }
        let before = port.position_ms();
        for _ in 0..96_000 { assert!(output.next().is_some()); }
        let advanced = port.position_ms() - before;
        assert!((980..=1020).contains(&advanced),
            "1.0x mono podcast advanced {advanced}ms during 1000ms device output");
    }

    #[test]
    fn original_fractional_source_speed_preserves_content_across_render_spans() {
        use crate::audio::AudioFx;
        use std::sync::{Arc, atomic::{AtomicU64, Ordering}};
        use std::time::Instant;
        use rodio::{ChannelCount, SampleRate, Source};
        struct Probe(Arc<AtomicU64>);
        impl Iterator for Probe {
            type Item = f32;
            fn next(&mut self) -> Option<f32> { self.0.fetch_add(1, Ordering::SeqCst); Some(0.25) }
        }
        impl Source for Probe {
            fn current_span_len(&self) -> Option<usize> { None }
            fn channels(&self) -> ChannelCount { ChannelCount::new(1).unwrap() }
            fn sample_rate(&self) -> SampleRate { SampleRate::new(1_000).unwrap() }
            fn total_duration(&self) -> Option<Duration> { None }
        }
        let (engine, inbox) = AudioEngine::command_channel();
        let (player, output) = engine.player_channel();
        let mut load_gen = 0;
        let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let a = seed.try_recv().unwrap().target.unwrap();
        let port = engine.source_mount(&a).unwrap();
        let reads = Arc::new(AtomicU64::new(0));
        engine.set_source_speed(&a, 1.25).unwrap();
        player.append(engine.bind_source(port.clone(), Box::new(Probe(reads.clone())), 0,
            Arc::new(AudioFx::new()), Instant::now(), None));
        assert!(engine.complete_source_mount(&port));
        let mut output = rodio::source::UniformSourceIterator::new(output,
            ChannelCount::new(1).unwrap(), SampleRate::new(1_000).unwrap());
        for _ in 0..128 { output.next(); }
        let before = reads.load(Ordering::SeqCst);
        for _ in 0..4_096 { assert_eq!(output.next(), Some(0.25)); }
        let rendered = reads.load(Ordering::SeqCst) - before;
        assert!((5_118..=5_122).contains(&rendered),
            "fractional source rate lost content at artificial span boundaries: {rendered}");
    }

    #[test]
    fn native_speed_control_updates_original_render_rate_without_waiting_for_actor() {
        use crate::audio::{AudioCmd, AudioFx};
        use std::sync::{Arc, atomic::{AtomicU64, Ordering}};
        use std::time::Instant;
        use rodio::{ChannelCount, SampleRate, Source};
        struct Probe(Arc<AtomicU64>);
        impl Iterator for Probe {
            type Item = f32;
            fn next(&mut self) -> Option<f32> { self.0.fetch_add(1, Ordering::SeqCst); Some(0.25) }
        }
        impl Source for Probe {
            fn current_span_len(&self) -> Option<usize> { None }
            fn channels(&self) -> ChannelCount { ChannelCount::new(1).unwrap() }
            fn sample_rate(&self) -> SampleRate { SampleRate::new(1_000).unwrap() }
            fn total_duration(&self) -> Option<Duration> { None }
        }
        let (engine, inbox) = AudioEngine::command_channel();
        let (player, output) = engine.player_channel();
        let mut load_gen = 0;
        let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let a = seed.try_recv().unwrap().target.unwrap();
        let port = engine.source_mount(&a).unwrap();
        let reads = Arc::new(AtomicU64::new(0));
        player.append(engine.bind_source(port.clone(), Box::new(Probe(reads.clone())), 0,
            Arc::new(AudioFx::new()), Instant::now(), None));
        assert!(engine.complete_source_mount(&port));
        engine.set_source_speed(&a, 2.0).unwrap();
        let mut output = rodio::source::UniformSourceIterator::new(output,
            ChannelCount::new(1).unwrap(), SampleRate::new(1_000).unwrap());
        for _ in 0..128 { output.next(); }
        let original_cue = port.position_ms();
        engine.send(AudioCmd::SetSpeed(0.5));
        assert_eq!(port.position_ms(), original_cue,
            "native rate change sought or reset original content before rendering");
        // Exercise the sender, deliberately before the actor receives the packet.
        for _ in 0..128 { output.next(); }
        let before = reads.load(Ordering::SeqCst);
        for _ in 0..4_096 { assert!(output.next().is_some()); }
        let rendered = reads.load(Ordering::SeqCst) - before;
        assert!((1_920..=2_176).contains(&rendered),
            "ordinary native speed left the original 2x source unchanged: {rendered}");
        assert_eq!(engine.snapshot().speed, 0.5);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
    }

    #[test]
    fn targeted_speed_command_persists_captured_original_speed_through_public_settings() {
        use crate::{db::Database, audio::AudioCmd};
        let db = Database::open_in_memory().unwrap();
        let (engine, inbox) = AudioEngine::command_channel();
        let mut load_gen = 0;
        let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let target = seed.try_recv().unwrap().target.unwrap();
        let original = engine.source_mount(&target).unwrap();
        assert_eq!(crate::commands::read_public_setting(&db, "playback.speed").unwrap(), None);
        let mut pending = crate::commands::set_speed_for_target(&engine, 1.25, Some(&target)).unwrap().expect("source persistence receipt");
        assert_eq!(original.speed(), 1.25);
        assert_eq!(engine.snapshot().speed, 1.25);
        let delivery = inbox.recv_timeout(Duration::ZERO, &mut load_gen)
            .expect("bound speed commit disappeared before its captured persistence delivery");
        assert!(!matches!(&delivery, AudioDelivery::Command(AudioCmd::SetSpeed(_))),
            "bound persistence escaped through the unbound transport");
        assert!(delivery.persist_speed(Some(&db)).unwrap());
        let receipt = pending.try_recv().unwrap().unwrap();
        assert_eq!(receipt.stamp, *original.stamp());
        assert_eq!(receipt.speed, 1.25);
        assert_eq!(crate::commands::read_public_setting(&db, "playback.speed").unwrap().as_deref(), Some("1.25"));
        assert_eq!(original.speed(), 1.25);
        assert_eq!(load_gen, 1);
    }

    #[test]
    fn queued_source_speed_persistence_rejects_new_intent_and_same_target_mount_aba() {
        use crate::db::Database;
        for physical_aba in [false, true] {
            let db = Database::open_in_memory().unwrap();
            let (engine, inbox) = AudioEngine::command_channel();
            let mut load_gen = 0;
            let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
            inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
            let target = seed.try_recv().unwrap().target.unwrap();
            let original = engine.source_mount(&target).unwrap();
            let mut pending = crate::commands::set_speed_for_target(&engine, 1.25, Some(&target))
                .unwrap().unwrap();
            // Retain B's pending receipt until the obsolete A delivery has been checked.
            let mut newer = None;
            let replacement = if physical_aba {
                let replacement = engine.reserve_source_mount(target.clone()).unwrap();
                assert_ne!(replacement.stamp(), original.stamp());
                assert!(engine.complete_source_mount(&replacement));
                engine.set_source_paused(&target, true).unwrap();
                Some(replacement)
            } else {
                newer = Some(engine.send_queue(vec![track("source-b", "7")], 0, None));
                None
            };
            let before = engine.snapshot();
            let delivery = inbox.recv_timeout(Duration::ZERO, &mut load_gen).unwrap();
            assert!(!delivery.persist_speed(Some(&db)).unwrap());
            assert!(pending.try_recv().unwrap().is_err());
            assert_eq!(crate::commands::read_public_setting(&db, "playback.speed").unwrap(), None);
            assert_eq!(engine.snapshot().speed, before.speed);
            assert_eq!(engine.snapshot().position_ms, before.position_ms);
            assert_eq!(engine.snapshot().status, before.status);
            assert_eq!(load_gen, 1);
            if let Some(replacement) = replacement {
                assert!(replacement.is_live());
                assert!(replacement.is_paused());
                assert_eq!(replacement.position_ms(), 0);
                assert_eq!(replacement.speed(), 1.25);
            }
            if let Some(mut newer) = newer {
                inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
                assert_eq!(newer.try_recv().unwrap().target.unwrap().platform, "source-b");
                assert_eq!(load_gen, 2);
            }
        }
    }

    #[test]
    fn source_speed_persistence_rejects_older_controls_including_speed_value_aba() {
        use crate::db::Database;
        for speeds in [vec![1.25, 0.5], vec![1.25, 0.5, 1.25]] {
            let db = Database::open_in_memory().unwrap();
            let (engine, inbox) = AudioEngine::command_channel();
            let mut load_gen = 0;
            let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
            inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
            let target = seed.try_recv().unwrap().target.unwrap();
            let original = engine.source_mount(&target).unwrap();
            let pending: Vec<_> = speeds.iter().map(|speed| {
                crate::commands::set_speed_for_target(&engine, *speed, Some(&target)).unwrap().unwrap()
            }).collect();
            let last_index = pending.len() - 1;
            let last_speed = *speeds.last().unwrap();
            for (index, mut pending) in pending.into_iter().enumerate() {
                let delivery = inbox.recv_timeout(Duration::ZERO, &mut load_gen).unwrap();
                assert_eq!(delivery.persist_speed(Some(&db)).unwrap(), index == last_index);
                let receipt = pending.try_recv().unwrap();
                if index == last_index {
                    let receipt = receipt.unwrap();
                    assert_eq!(receipt.stamp, *original.stamp());
                    assert_eq!(receipt.speed, last_speed);
                    assert_eq!(crate::commands::read_public_setting(&db, "playback.speed").unwrap(),
                        Some(last_speed.to_string()));
                } else {
                    assert!(receipt.is_err());
                    assert_eq!(crate::commands::read_public_setting(&db, "playback.speed").unwrap(), None);
                }
                assert_eq!(original.speed(), last_speed);
                assert_eq!(engine.snapshot().speed, last_speed);
                assert_eq!(load_gen, 1);
            }
        }
    }

    #[tokio::test]
    async fn source_speed_persistence_propagates_sql_failure_and_missing_database_to_caller() {
        use crate::db::Database;
        for missing_database in [false, true] {
            let db = Database::open_in_memory().unwrap();
            if !missing_database {
                db.with(|conn| conn.execute_batch("CREATE TEMP TRIGGER bound_speed_abort BEFORE INSERT ON settings WHEN NEW.key = 'playback.speed' BEGIN SELECT RAISE(ABORT, 'bound_speed_write_denied'); END;")).unwrap();
            }
            let (engine, inbox) = AudioEngine::command_channel();
            let mut load_gen = 0;
            let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
            inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
            let target = seed.try_recv().unwrap().target.unwrap();
            let original = engine.source_mount(&target).unwrap();
            let pending = crate::commands::set_speed_for_target(&engine, 1.25, Some(&target)).unwrap().unwrap();
            let delivery = inbox.recv_timeout(Duration::ZERO, &mut load_gen).unwrap();
            let expected_error = if missing_database { "database unavailable" } else { "bound_speed_write_denied" };
            assert!(delivery.persist_speed((!missing_database).then_some(&db)).unwrap_err().contains(expected_error));
            assert!(pending.wait().await.err().expect("failed persistence returned caller success").contains(expected_error));
            assert_eq!(crate::commands::read_public_setting(&db, "playback.speed").unwrap(), None);
            assert_eq!(original.speed(), 1.25);
            assert_eq!(engine.snapshot().speed, 1.25);
            assert_eq!(load_gen, 1);
        }
    }

    #[tokio::test]
    async fn completed_source_speed_receipt_rejects_new_intent_and_physical_aba_at_both_caller_entries() {
        use crate::db::Database;
        for physical_aba in [false, true] {
            for wait_for_receipt in [false, true] {
                let db = Database::open_in_memory().unwrap();
                let (engine, inbox) = AudioEngine::command_channel();
                let mut load_gen = 0;
                let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
                inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
                let target = seed.try_recv().unwrap().target.unwrap();
                let original = engine.source_mount(&target).unwrap();
                let mut pending = crate::commands::set_speed_for_target(&engine, 1.25, Some(&target)).unwrap().unwrap();
                let delivery = inbox.recv_timeout(Duration::ZERO, &mut load_gen).unwrap();
                assert!(delivery.persist_speed(Some(&db)).unwrap());
                // The write and ACK are complete before source authority is superseded.
                let mut newer = None;
                let replacement = if physical_aba {
                    let replacement = engine.reserve_source_mount(target.clone()).unwrap();
                    assert_ne!(replacement.stamp(), original.stamp());
                    assert!(engine.complete_source_mount(&replacement));
                    engine.set_source_paused(&target, true).unwrap();
                    Some(replacement)
                } else {
                    newer = Some(engine.send_queue(vec![track("source-b", "7")], 0, None));
                    None
                };
                let before = engine.snapshot();
                let result = if wait_for_receipt { pending.wait().await } else { pending.try_recv().unwrap() };
                assert!(result.is_err(), "completed obsolete persistence was exposed as current success");
                // Revocation cannot undo a previously committed SQL write.
                assert_eq!(crate::commands::read_public_setting(&db, "playback.speed").unwrap().as_deref(), Some("1.25"));
                assert_eq!(engine.snapshot().speed, before.speed);
                assert_eq!(engine.snapshot().position_ms, before.position_ms);
                assert_eq!(engine.snapshot().status, before.status);
                assert_eq!(load_gen, 1);
                if let Some(replacement) = replacement {
                    assert!(replacement.is_live());
                    assert!(replacement.is_paused());
                    assert_eq!(replacement.position_ms(), 0);
                    assert_eq!(replacement.speed(), 1.25);
                }
                if let Some(mut newer) = newer {
                    inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
                    assert_eq!(newer.try_recv().unwrap().target.unwrap().platform, "source-b");
                }
            }
        }
    }

    #[tokio::test]
    async fn source_speed_pending_drop_and_channel_closure_never_report_persistence_success() {
        use crate::db::Database;
        for mode in ["drop_pending", "drop_delivery", "closed_inbox"] {
            let db = Database::open_in_memory().unwrap();
            let (engine, inbox) = AudioEngine::command_channel();
            let mut load_gen = 0;
            let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
            inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
            let target = seed.try_recv().unwrap().target.unwrap();
            let original = engine.source_mount(&target).unwrap();
            if mode == "closed_inbox" {
                drop(inbox);
                assert!(crate::commands::set_speed_for_target(&engine, 1.25, Some(&target))
                    .err().expect("closed actor returned source persistence success").contains("audio actor exited"));
            } else {
                let pending = crate::commands::set_speed_for_target(&engine, 1.25, Some(&target)).unwrap().unwrap();
                let delivery = inbox.recv_timeout(Duration::ZERO, &mut load_gen).unwrap();
                if mode == "drop_pending" {
                    drop(pending);
                    assert!(!delivery.persist_speed(Some(&db)).unwrap());
                } else {
                    drop(delivery);
                    assert!(pending.wait().await.err().expect("dropped writer returned caller success")
                        .contains("audio actor exited"));
                }
            }
            assert_eq!(crate::commands::read_public_setting(&db, "playback.speed").unwrap(), None);
            assert!(original.is_live());
            assert_eq!(original.speed(), 1.25);
            assert_eq!(engine.snapshot().speed, 1.25);
            assert_eq!(load_gen, 1);
        }
    }

    #[test]
    fn source_speed_persistence_is_invalidated_by_newer_explicit_native_transport_control() {
        use crate::db::Database;
        let db = Database::open_in_memory().unwrap();
        let (engine, inbox) = AudioEngine::command_channel();
        let mut load_gen = 0;
        let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let target = seed.try_recv().unwrap().target.unwrap();
        let original = engine.source_mount(&target).unwrap();
        let mut pending = crate::commands::set_speed_for_target(&engine, 1.25, Some(&target)).unwrap().unwrap();
        assert!(crate::commands::set_speed_for_target(&engine, 0.5, None).unwrap().is_none());
        let old_bound_delivery = inbox.recv_timeout(Duration::ZERO, &mut load_gen).unwrap();
        assert!(!old_bound_delivery.persist_speed(Some(&db)).unwrap());
        assert!(pending.try_recv().unwrap().is_err());
        assert_eq!(crate::commands::read_public_setting(&db, "playback.speed").unwrap(), None);
        assert_eq!(original.speed(), 0.5);
        assert_eq!(engine.snapshot().speed, 0.5);
        // Native remains an explicit global packet, never a source-qualified receipt.
        assert!(matches!(inbox.recv_timeout(Duration::ZERO, &mut load_gen).unwrap(),
            AudioDelivery::NativeSpeedSetting(setting) if setting.speed() == 0.5));
        assert_eq!(load_gen, 1);
    }

    #[test]
    fn native_speed_persistence_rejects_older_global_message_after_newer_source_control() {
        use crate::db::Database;
        let db = Database::open_in_memory().unwrap();
        let (engine, inbox) = AudioEngine::command_channel();
        let mut load_gen = 0;
        let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let target = seed.try_recv().unwrap().target.unwrap();
        let original = engine.source_mount(&target).unwrap();
        assert!(crate::commands::set_speed_for_target(&engine, 0.5, None).unwrap().is_none());
        let mut latest = crate::commands::set_speed_for_target(&engine, 1.25, Some(&target))
            .unwrap().unwrap();
        let obsolete = inbox.recv_timeout(Duration::ZERO, &mut load_gen).unwrap();
        assert!(!obsolete.persist_speed(Some(&db)).unwrap(),
            "obsolete Native speed message wrote a setting after a newer source control");
        assert_eq!(crate::commands::read_public_setting(&db, "playback.speed").unwrap(), None);
        assert_eq!(original.speed(), 1.25);
        assert_eq!(engine.snapshot().speed, 1.25);
        let current = inbox.recv_timeout(Duration::ZERO, &mut load_gen).unwrap();
        assert!(current.persist_speed(Some(&db)).unwrap());
        let receipt = latest.try_recv().unwrap().unwrap();
        assert_eq!(receipt.stamp, *original.stamp());
        assert_eq!(receipt.speed, 1.25);
        assert_eq!(crate::commands::read_public_setting(&db, "playback.speed").unwrap().as_deref(), Some("1.25"));
        assert_eq!(load_gen, 1);
    }

    #[test]
    fn native_speed_persistence_keeps_only_latest_control_across_source_and_value_aba() {
        use crate::db::Database;
        for source_control in [false, true] {
            let db = Database::open_in_memory().unwrap();
            let (engine, inbox) = AudioEngine::command_channel();
            let mut load_gen = 0;
            let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
            inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
            let target = seed.try_recv().unwrap().target.unwrap();
            let original = engine.source_mount(&target).unwrap();
            assert!(crate::commands::set_speed_for_target(&engine, 1.25, None).unwrap().is_none());
            let mut middle = crate::commands::set_speed_for_target(&engine, 0.5,
                source_control.then_some(&target)).unwrap();
            assert!(crate::commands::set_speed_for_target(&engine, 1.25, None).unwrap().is_none());
            // Equal values do not restore the first message's authority.
            for _ in 0..2 {
                let old = inbox.recv_timeout(Duration::ZERO, &mut load_gen).unwrap();
                assert!(!old.persist_speed(Some(&db)).unwrap());
                assert_eq!(crate::commands::read_public_setting(&db, "playback.speed").unwrap(), None);
            }
            if let Some(pending) = &mut middle { assert!(pending.try_recv().unwrap().is_err()); }
            let current = inbox.recv_timeout(Duration::ZERO, &mut load_gen).unwrap();
            assert!(current.persist_speed(Some(&db)).unwrap());
            assert_eq!(crate::commands::read_public_setting(&db, "playback.speed").unwrap().as_deref(), Some("1.25"));
            assert!(original.is_live());
            assert_eq!(original.speed(), 1.25);
            assert_eq!(engine.snapshot().speed, 1.25);
            assert_eq!(load_gen, 1);
        }
    }

    #[test]
    fn native_speed_waiting_for_database_rejects_superseded_controls_without_locking_playback() {
        use crate::db::Database;
        use std::sync::{Arc, mpsc};
        for source_control in [false, true] {
            let db = Arc::new(Database::open_in_memory().unwrap());
            let (engine, inbox) = AudioEngine::command_channel();
            let mut load_gen = 0;
            let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
            inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
            let target = seed.try_recv().unwrap().target.unwrap();
            let original = engine.source_mount(&target).unwrap();
            crate::commands::set_speed_for_target(&engine, 2.0, None).unwrap();
            assert!(inbox.recv_timeout(Duration::ZERO, &mut load_gen).unwrap()
                .persist_speed(Some(&db)).unwrap());
            crate::commands::set_speed_for_target(&engine, 0.5, None).unwrap();
            let old = inbox.recv_timeout(Duration::ZERO, &mut load_gen).unwrap();
            let (held_tx, held_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let holder_db = Arc::clone(&db);
            let holder = std::thread::spawn(move || holder_db.with(|_| {
                held_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(())
            }));
            held_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let (started_tx, started_rx) = mpsc::channel();
            let (done_tx, done_rx) = mpsc::channel();
            let writer_db = Arc::clone(&db);
            let writer = std::thread::spawn(move || {
                started_tx.send(()).unwrap();
                done_tx.send(old.persist_speed(Some(&writer_db))).unwrap();
            });
            started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(matches!(done_rx.recv_timeout(Duration::from_millis(50)),
                Err(mpsc::RecvTimeoutError::Timeout)), "writer escaped held database serialization");
            // The real DB mutex stays held while a public playback control completes.
            let control_engine = engine.clone();
            let control_target = target.clone();
            let (control_tx, control_rx) = mpsc::channel();
            let controller = std::thread::spawn(move || {
                control_tx.send(crate::commands::set_speed_for_target(&control_engine, 1.25,
                    source_control.then_some(&control_target))).unwrap();
            });
            let control = control_rx.recv_timeout(Duration::from_secs(1));
            // Always release external blocking work before asserting a failed lock order.
            release_tx.send(()).unwrap();
            holder.join().unwrap().unwrap();
            let mut latest = control.expect("database wait held playback State or Gate").unwrap();
            controller.join().unwrap();
            assert!(!done_rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap(),
                "obsolete speed passed admission before waiting for database");
            writer.join().unwrap();
            assert_eq!(crate::commands::read_public_setting(&db, "playback.speed").unwrap().as_deref(), Some("2"));
            assert_eq!(original.speed(), 1.25);
            assert_eq!(engine.snapshot().speed, 1.25);
            assert!(inbox.recv_timeout(Duration::ZERO, &mut load_gen).unwrap()
                .persist_speed(Some(&db)).unwrap());
            if let Some(pending) = &mut latest {
                assert_eq!(pending.try_recv().unwrap().unwrap().stamp, *original.stamp());
            }
            assert_eq!(crate::commands::read_public_setting(&db, "playback.speed").unwrap().as_deref(), Some("1.25"));
            assert_eq!(load_gen, 1);
        }
    }

    #[test]
    fn targeted_speed_command_does_not_change_the_live_predecessor_or_enqueue_global_effects() {
        use crate::audio::AudioFx;
        use std::sync::{Arc, atomic::{AtomicU64, Ordering}};
        use std::time::Instant;
        use rodio::{ChannelCount, SampleRate, Source};
        struct Probe(Arc<AtomicU64>);
        impl Iterator for Probe {
            type Item = f32;
            fn next(&mut self) -> Option<f32> { self.0.fetch_add(1, Ordering::SeqCst); Some(0.25) }
        }
        impl Source for Probe {
            fn current_span_len(&self) -> Option<usize> { None }
            fn channels(&self) -> ChannelCount { ChannelCount::new(1).unwrap() }
            fn sample_rate(&self) -> SampleRate { SampleRate::new(1_000).unwrap() }
            fn total_duration(&self) -> Option<Duration> { None }
        }
        let (engine, inbox) = AudioEngine::command_channel();
        let (player, output) = engine.player_channel();
        let mut output = rodio::source::UniformSourceIterator::new(output,
            ChannelCount::new(1).unwrap(), SampleRate::new(1_000).unwrap());
        let mut load_gen = 0;
        let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let a = seed.try_recv().unwrap().target.unwrap();
        let a_port = engine.source_mount(&a).unwrap();
        let reads = Arc::new(AtomicU64::new(0));
        player.append(engine.bind_source(a_port.clone(), Box::new(Probe(reads.clone())), 0,
            Arc::new(AudioFx::new()), Instant::now(), None));
        assert!(engine.complete_source_mount(&a_port));
        crate::commands::set_speed_for_target(&engine, 0.5, None).unwrap();
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        for _ in 0..128 { output.next(); }

        // B is accepted/reserved, while the physical predecessor A is still rendering.
        let mut next = engine.send_queue(vec![track("source-b", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let b = next.try_recv().unwrap().target.unwrap();
        let b_port = engine.source_mount(&b).unwrap();
        let _pending = crate::commands::set_speed_for_target(&engine, 2.0, Some(&b)).unwrap();
        for _ in 0..128 { output.next(); }
        let before = reads.load(Ordering::SeqCst);
        for _ in 0..4_096 { assert!(output.next().is_some()); }
        let rendered = reads.load(Ordering::SeqCst) - before;
        assert!((1_920..=2_176).contains(&rendered),
            "targeted B speed escaped into the live predecessor A: {rendered}");
        assert_eq!(a_port.speed(), 0.5);
        assert_eq!(b_port.speed(), 2.0);
        assert_eq!(engine.snapshot().speed, 2.0);
        match inbox.recv_timeout(Duration::ZERO, &mut load_gen).unwrap() {
            AudioDelivery::SourceSpeedSetting(setting) => {
                assert_eq!(setting.stamp(), b_port.stamp());
                assert_eq!(setting.speed(), 2.0);
            }
            _ => panic!("a bound speed control queued unbound Player/persistence effects"),
        }
        assert!(crate::commands::set_speed_for_target(&engine, 1.25, Some(&a)).is_err());
        assert_eq!(b_port.speed(), 2.0);
        assert!(matches!(inbox.recv_timeout(Duration::ZERO, &mut load_gen),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)));
    }

    #[test]
    fn original_source_speed_changes_rendered_content_and_late_a_cannot_speed_up_b() {
        use crate::audio::AudioFx;
        use std::sync::{Arc, atomic::{AtomicU64, Ordering}};
        use std::time::Instant;
        use rodio::{ChannelCount, SampleRate, Source};
        struct Probe(Arc<AtomicU64>);
        impl Iterator for Probe {
            type Item = f32;
            fn next(&mut self) -> Option<f32> { self.0.fetch_add(1, Ordering::SeqCst); Some(0.25) }
        }
        impl Source for Probe {
            fn current_span_len(&self) -> Option<usize> { Some(16) }
            fn channels(&self) -> ChannelCount { ChannelCount::new(1).unwrap() }
            fn sample_rate(&self) -> SampleRate { SampleRate::new(1_000).unwrap() }
            fn total_duration(&self) -> Option<Duration> { None }
        }
        let (engine, inbox) = AudioEngine::command_channel();
        let (player, output) = engine.player_channel();
        // The actual software queue is rendered at a fixed device-format rate.
        let mut output = rodio::source::UniformSourceIterator::new(output,
            ChannelCount::new(1).unwrap(), SampleRate::new(1_000).unwrap());
        let mut load_gen = 0;
        let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let a = seed.try_recv().unwrap().target.unwrap();
        let a_port = engine.source_mount(&a).unwrap();
        let a_reads = Arc::new(AtomicU64::new(0));
        engine.set_source_speed(&a, 2.0).expect("qualified original source speed was unavailable");
        player.append(engine.bind_source(a_port.clone(), Box::new(Probe(a_reads.clone())), 0,
            Arc::new(AudioFx::new()), Instant::now(), None));
        assert!(engine.complete_source_mount(&a_port));
        for _ in 0..64 { output.next(); }
        let before = a_reads.load(Ordering::SeqCst);
        for _ in 0..4_096 { assert!(output.next().is_some()); }
        let rendered = a_reads.load(Ordering::SeqCst) - before;
        assert!((8_064..=8_320).contains(&rendered),
            "2x source speed did not render twice the original content: {rendered}");

        let mut next = engine.send_queue(vec![track("source-b", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let b = next.try_recv().unwrap().target.unwrap();
        let b_port = engine.source_mount(&b).unwrap();
        let b_reads = Arc::new(AtomicU64::new(0));
        engine.set_source_speed(&b, 0.5).unwrap();
        player.append(engine.bind_source(b_port.clone(), Box::new(Probe(b_reads.clone())), 0,
            Arc::new(AudioFx::new()), Instant::now(), None));
        assert!(engine.complete_source_mount(&b_port));
        assert!(engine.set_source_speed(&a, 2.0).is_err());
        for _ in 0..128 { output.next(); }
        let before = b_reads.load(Ordering::SeqCst);
        let a_frozen = a_reads.load(Ordering::SeqCst);
        for _ in 0..4_096 { assert!(output.next().is_some()); }
        let rendered = b_reads.load(Ordering::SeqCst) - before;
        assert!((1_920..=2_176).contains(&rendered),
            "late A speed changed B's independently selected 0.5x content: {rendered}");
        assert_eq!(a_reads.load(Ordering::SeqCst), a_frozen);
    }

    #[test]
    fn source_pause_freezes_original_decoder_and_late_a_cannot_resume_or_pause_b() {
        use crate::audio::AudioFx;
        use std::sync::{Arc, atomic::{AtomicU64, Ordering}};
        use std::time::Instant;
        use rodio::{ChannelCount, SampleRate, Source};
        struct Probe(Arc<AtomicU64>);
        impl Iterator for Probe {
            type Item = f32;
            fn next(&mut self) -> Option<f32> { self.0.fetch_add(1, Ordering::SeqCst); Some(0.25) }
        }
        impl Source for Probe {
            fn current_span_len(&self) -> Option<usize> { None }
            fn channels(&self) -> ChannelCount { ChannelCount::new(1).unwrap() }
            fn sample_rate(&self) -> SampleRate { SampleRate::new(1_000).unwrap() }
            fn total_duration(&self) -> Option<Duration> { None }
        }
        let (engine, inbox) = AudioEngine::command_channel();
        let (player, mut output) = engine.player_channel();
        let mut load_gen = 0;
        let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let a = seed.try_recv().unwrap().target.unwrap();
        let a_port = engine.source_mount(&a).unwrap();
        let a_reads = Arc::new(AtomicU64::new(0));
        player.append(engine.bind_source(a_port.clone(), Box::new(Probe(a_reads.clone())), 0,
            Arc::new(AudioFx::new()), Instant::now(), None));
        assert!(engine.complete_source_mount(&a_port));
        for _ in 0..16 { output.next(); }
        assert_eq!(engine.set_source_paused(&a, true).unwrap(), *a_port.stamp());
        let a_before = a_reads.load(Ordering::SeqCst);
        let a_pos = a_port.position_ms();
        for _ in 0..16 { assert_eq!(output.next(), Some(0.0)); }
        assert_eq!(a_reads.load(Ordering::SeqCst), a_before, "paused original A entered DSP/decoder");
        assert_eq!(a_port.position_ms(), a_pos, "paused original A advanced content");
        let mut next = engine.send_queue(vec![track("source-b", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let b = next.try_recv().unwrap().target.unwrap();
        let b_port = engine.source_mount(&b).unwrap();
        let b_reads = Arc::new(AtomicU64::new(0));
        player.append(engine.bind_source(b_port.clone(), Box::new(Probe(b_reads.clone())), 0,
            Arc::new(AudioFx::new()), Instant::now(), None));
        assert!(engine.complete_source_mount(&b_port));
        assert!(engine.set_source_paused(&a, true).is_err());
        assert!(engine.set_source_paused(&a, false).is_err());
        assert_eq!(engine.set_source_paused(&b, true).unwrap(), *b_port.stamp());
        for _ in 0..16 { assert_eq!(output.next(), Some(0.0)); }
        assert_eq!(b_reads.load(Ordering::SeqCst), 0, "late A control or paused B entered B decoder");
        assert_eq!(engine.snapshot().status, super::PlaybackStatus::Paused);
        assert_eq!(engine.set_source_paused(&b, false).unwrap(), *b_port.stamp());
        for _ in 0..16 { output.next(); }
        assert!(b_reads.load(Ordering::SeqCst) > 0, "original B did not resume");
        assert_eq!(a_reads.load(Ordering::SeqCst), a_before);
    }

    #[test]
    fn late_original_load_metadata_preserves_successful_source_seek_cue() {
        use crate::audio::AudioFx;
        use std::sync::Arc;
        use std::time::Instant;
        use rodio::{ChannelCount, SampleRate, Source};
        use rodio::source::SeekError;
        struct Probe;
        impl Iterator for Probe { type Item = f32; fn next(&mut self) -> Option<f32> { Some(0.25) } }
        impl Source for Probe {
            fn current_span_len(&self) -> Option<usize> { None }
            fn channels(&self) -> ChannelCount { ChannelCount::new(1).unwrap() }
            fn sample_rate(&self) -> SampleRate { SampleRate::new(1_000).unwrap() }
            fn total_duration(&self) -> Option<Duration> { Some(Duration::from_secs(60)) }
            fn try_seek(&mut self, _: Duration) -> Result<(), SeekError> { Ok(()) }
        }
        let (engine, inbox) = AudioEngine::command_channel();
        let mut load_gen = 0;
        let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let a = seed.try_recv().unwrap().target.unwrap();
        let prepared_metadata = engine.snapshot();
        let port = engine.source_mount(&a).unwrap();
        let (player, mut output) = engine.player_channel();
        player.append(engine.bind_source(port.clone(), Box::new(Probe), 0,
            Arc::new(AudioFx::new()), Instant::now(), None));
        assert!(engine.complete_source_mount(&port));
        for _ in 0..16 { output.next(); }
        let mut pending = engine.begin_source_seek(&a, 790).unwrap();
        output.next();
        assert_eq!(pending.try_recv().unwrap().unwrap().content_position_ms, 790);
        assert!(engine.publish_source_state(&port, prepared_metadata));
        assert!(engine.snapshot().position_ms >= 790,
            "late original LoadReady metadata reset the successfully sought original source cue");
    }

    #[test]
    fn source_seek_ack_publishes_original_cue_before_post_seek_decoder_pull() {
        use crate::audio::AudioFx;
        use std::sync::Arc;
        use std::time::Instant;
        use rodio::{ChannelCount, SampleRate, Source};
        use rodio::source::SeekError;
        struct Probe { engine: AudioEngine, sought: bool }
        impl Iterator for Probe {
            type Item = f32;
            fn next(&mut self) -> Option<f32> {
                if self.sought {
                    assert!(self.engine.snapshot().position_ms >= 790,
                        "decoder continued before the original successful seek cue became visible");
                }
                Some(0.25)
            }
        }
        impl Source for Probe {
            fn current_span_len(&self) -> Option<usize> { None }
            fn channels(&self) -> ChannelCount { ChannelCount::new(1).unwrap() }
            fn sample_rate(&self) -> SampleRate { SampleRate::new(1_000).unwrap() }
            fn total_duration(&self) -> Option<Duration> { Some(Duration::from_secs(60)) }
            fn try_seek(&mut self, _: Duration) -> Result<(), SeekError> { self.sought = true; Ok(()) }
        }
        let (engine, inbox) = AudioEngine::command_channel();
        let mut load_gen = 0;
        let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let a = seed.try_recv().unwrap().target.unwrap();
        let port = engine.source_mount(&a).unwrap();
        let (player, mut output) = engine.player_channel();
        player.append(engine.bind_source(port.clone(), Box::new(Probe { engine: engine.clone(), sought: false }),
            0, Arc::new(AudioFx::new()), Instant::now(), None));
        assert!(engine.complete_source_mount(&port));
        for _ in 0..16 { output.next(); }
        let mut pending = engine.begin_source_seek(&a, 790).unwrap();
        output.next();
        let receipt = pending.try_recv().unwrap().unwrap();
        assert_eq!(receipt.stamp, *port.stamp());
        assert_eq!(receipt.content_position_ms, 790);
        assert!(engine.snapshot().position_ms >= 790);
    }

    #[test]
    fn loading_source_seek_survives_preceding_physical_source_until_original_selection() {
        use crate::audio::AudioFx;
        use rodio::{ChannelCount, SampleRate, Source};
        use rodio::source::SeekError;
        use std::sync::Arc;
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::time::Instant;
        struct Probe { seeks: Arc<AtomicU64> }
        impl Iterator for Probe {
            type Item = f32;
            fn next(&mut self) -> Option<f32> { Some(0.25) }
        }
        impl Source for Probe {
            fn current_span_len(&self) -> Option<usize> { None }
            fn channels(&self) -> ChannelCount { ChannelCount::new(1).unwrap() }
            fn sample_rate(&self) -> SampleRate { SampleRate::new(1_000).unwrap() }
            fn total_duration(&self) -> Option<Duration> { Some(Duration::from_secs(60)) }
            fn try_seek(&mut self, _: Duration) -> Result<(), SeekError> {
                self.seeks.fetch_add(1, Ordering::Relaxed); Ok(())
            }
        }
        let (engine, inbox) = AudioEngine::command_channel();
        let mut load_gen = 0;
        let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let a = seed.try_recv().unwrap().target.unwrap();
        let a_port = engine.source_mount(&a).unwrap();
        let (player, mut output) = engine.player_channel();
        let a_seeks = Arc::new(AtomicU64::new(0));
        let b_seeks = Arc::new(AtomicU64::new(0));
        player.append(engine.bind_source(a_port.clone(), Box::new(Probe { seeks: a_seeks.clone() }),
            0, Arc::new(AudioFx::new()), Instant::now(), None));
        assert!(engine.complete_source_mount(&a_port));
        for _ in 0..16 { output.next(); }
        let mut seed = engine.send_queue(vec![track("source-b", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let b = seed.try_recv().unwrap().target.unwrap();
        let b_port = engine.source_mount(&b).unwrap();
        let mut pending = engine.begin_source_seek(&b, 740).unwrap();
        player.append(engine.bind_source(b_port.clone(), Box::new(Probe { seeks: b_seeks.clone() }),
            0, Arc::new(AudioFx::new()), Instant::now(), None));
        for _ in 0..16 { output.next(); }
        assert_eq!(a_seeks.load(Ordering::Relaxed), 0);
        assert_eq!(b_seeks.load(Ordering::Relaxed), 0);
        assert!(matches!(pending.try_recv(), Err(tokio::sync::oneshot::error::TryRecvError::Empty)));
        assert!(engine.complete_source_mount(&b_port));
        for _ in 0..16 { output.next(); }
        let receipt = pending.try_recv().unwrap()
            .expect("original loading B seek must survive the preceding A output tail");
        assert_eq!(receipt.stamp, *b_port.stamp());
        assert_eq!(receipt.content_position_ms, 740);
        assert_eq!(a_seeks.load(Ordering::Relaxed), 0);
        assert_eq!(b_seeks.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn source_seek_before_load_ready_retains_original_port_and_content_until_mount() {
        use crate::audio::AudioFx;
        use rodio::{ChannelCount, SampleRate, Source};
        use rodio::source::SeekError;
        use std::sync::Arc;
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::time::Instant;
        struct Probe { pulls: Arc<AtomicU64>, seeks: Arc<std::sync::Mutex<Vec<Duration>>> }
        impl Iterator for Probe {
            type Item = f32;
            fn next(&mut self) -> Option<f32> { self.pulls.fetch_add(1, Ordering::Relaxed); Some(0.25) }
        }
        impl Source for Probe {
            fn current_span_len(&self) -> Option<usize> { None }
            fn channels(&self) -> ChannelCount { ChannelCount::new(1).unwrap() }
            fn sample_rate(&self) -> SampleRate { SampleRate::new(1_000).unwrap() }
            fn total_duration(&self) -> Option<Duration> { Some(Duration::from_secs(60)) }
            fn try_seek(&mut self, position: Duration) -> Result<(), SeekError> {
                self.seeks.lock().unwrap().push(position); Ok(())
            }
        }
        let (engine, inbox) = AudioEngine::command_channel();
        let mut load_gen = 0;
        let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let original = seed.try_recv().unwrap().target.unwrap();
        let (player, mut output) = engine.player_channel();
        let mut pending = engine.begin_source_seek(&original, 790)
            .expect("accepted A seek must retain its loading source, not fail before LoadReady");
        let port = engine.source_mount(&original).expect("loading A has an original source lease");
        let pulls = Arc::new(AtomicU64::new(0));
        let seeks = Arc::new(std::sync::Mutex::new(Vec::new()));
        player.append(engine.bind_source(port.clone(),
            Box::new(Probe { pulls: pulls.clone(), seeks: seeks.clone() }), 0,
            Arc::new(AudioFx::new()), Instant::now(), None));
        for _ in 0..16 { output.next(); }
        assert_eq!(pulls.load(Ordering::Relaxed), 0);
        assert!(seeks.lock().unwrap().is_empty(), "unarmed original seek crossed DSP into decoder");
        assert!(matches!(pending.try_recv(), Err(tokio::sync::oneshot::error::TryRecvError::Empty)));
        assert!(engine.complete_source_mount(&port));
        for _ in 0..16 { output.next(); }
        let receipt = pending.try_recv().unwrap().unwrap();
        assert_eq!(receipt.stamp, *port.stamp());
        assert_eq!(receipt.content_position_ms, 790);
        assert_eq!(*seeks.lock().unwrap(), vec![Duration::from_millis(790)]);
        assert!(pulls.load(Ordering::Relaxed) > 0);
    }

    #[test]
    fn reserved_source_outputs_silence_until_original_completion_and_then_continues_while_b_loads() {
        use crate::audio::AudioFx;
        use rodio::{ChannelCount, SampleRate, Source};
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::sync::Arc;
        use std::time::Instant;
        struct Probe { pulls: Arc<AtomicU64> }
        impl Iterator for Probe {
            type Item = f32;
            fn next(&mut self) -> Option<f32> { self.pulls.fetch_add(1, Ordering::Relaxed); Some(0.25) }
        }
        impl Source for Probe {
            fn current_span_len(&self) -> Option<usize> { None }
            fn channels(&self) -> ChannelCount { ChannelCount::new(1).unwrap() }
            fn sample_rate(&self) -> SampleRate { SampleRate::new(1_000).unwrap() }
            fn total_duration(&self) -> Option<Duration> { Some(Duration::from_secs(60)) }
        }
        let (engine, inbox) = AudioEngine::command_channel();
        let mut load_gen = 0;
        let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let port = engine.reserve_source_mount(seed.try_recv().unwrap().target.unwrap()).unwrap();
        let pulls = Arc::new(AtomicU64::new(0));
        let (player, mut output) = engine.player_channel();
        player.append(engine.bind_source(port.clone(), Box::new(Probe { pulls: pulls.clone() }), 0,
            Arc::new(AudioFx::new()), Instant::now(), None));
        let held: Vec<_> = (0..32).filter_map(|_| output.next()).collect();
        assert_eq!(pulls.load(Ordering::Relaxed), 0,
            "uncompleted candidate entered DSP/decoder before its original mount was armed");
        assert!(held.iter().all(|sample| *sample == 0.0));
        assert!(engine.complete_source_mount(&port));
        let original_b = engine.begin_play_intent();
        let playing: Vec<_> = (0..32).filter_map(|_| output.next()).collect();
        assert!(pulls.load(Ordering::Relaxed) > 0, "completed A was silenced by B merely becoming pending");
        assert!(playing.iter().any(|sample| *sample != 0.0));
        let mut b_reply = engine.send_queue(vec![track("source-b", "7")], 0, Some(original_b));
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        assert_eq!(b_reply.try_recv().unwrap().target.unwrap().generation, original_b);
        assert_eq!(load_gen, 2);
    }

    #[test]
    fn rejected_source_mount_never_enters_dsp_or_decoder_on_normal_output_pull() {
        use crate::audio::AudioFx;
        use rodio::{ChannelCount, SampleRate, Source};
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::sync::Arc;
        use std::time::Instant;
        struct Probe { pulls: Arc<AtomicU64> }
        impl Iterator for Probe {
            type Item = f32;
            fn next(&mut self) -> Option<f32> {
                self.pulls.fetch_add(1, Ordering::Relaxed);
                Some(0.25)
            }
        }
        impl Source for Probe {
            fn current_span_len(&self) -> Option<usize> { None }
            fn channels(&self) -> ChannelCount { ChannelCount::new(1).unwrap() }
            fn sample_rate(&self) -> SampleRate { SampleRate::new(1_000).unwrap() }
            fn total_duration(&self) -> Option<Duration> { Some(Duration::from_secs(60)) }
        }
        let (engine, inbox) = AudioEngine::command_channel();
        let mut load_gen = 0;
        let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let port = engine.reserve_source_mount(seed.try_recv().unwrap().target.unwrap()).unwrap();
        let pulls = Arc::new(AtomicU64::new(0));
        let (player, mut output) = engine.player_channel();
        player.append(engine.bind_source(port.clone(), Box::new(Probe { pulls: pulls.clone() }), 0,
            Arc::new(AudioFx::new()), Instant::now(), None));
        let before = engine.snapshot();
        let original_b = engine.begin_play_intent();
        assert!(!engine.complete_source_mount(&port));
        assert!(!engine.publish_source_state(&port, before.clone()));
        for _ in 0..64 { output.next(); }
        assert_eq!(pulls.load(Ordering::Relaxed), 0,
            "retired original A crossed the physical outer guard and entered DSP/decoder");
        assert_eq!(serde_json::to_value(engine.snapshot()).unwrap(), serde_json::to_value(before).unwrap());
        let mut b_reply = engine.send_queue(vec![track("source-b", "7")], 0, Some(original_b));
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        assert_eq!(b_reply.try_recv().unwrap().target.unwrap().generation, original_b);
        assert_eq!(load_gen, 2);
    }

    #[test]
    fn original_source_mount_completion_cannot_replace_b_or_reuse_an_aba_stamp() {
        use std::sync::Arc;
        let (engine, inbox) = AudioEngine::command_channel();
        let mut load_gen = 0;
        let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let target_a = seed.try_recv().unwrap().target.unwrap();
        let first_a = engine.reserve_source_mount(target_a.clone()).unwrap();
        assert!(engine.complete_source_mount(&first_a));
        let reloaded_a = engine.reserve_source_mount(target_a).unwrap();
        assert_ne!(first_a.stamp().mount_nonce, reloaded_a.stamp().mount_nonce);
        let before = serde_json::to_value(engine.snapshot()).unwrap();
        let original_b = engine.begin_play_intent();
        assert!(!engine.complete_source_mount(&reloaded_a),
            "old A source completed after original B began and replaced the physical mount");
        assert!(!reloaded_a.is_live(), "a rejected original candidate must be retired");
        assert!(first_a.is_live(), "rejecting a candidate must not retire another physical source");
        assert!(Arc::ptr_eq(&engine.current_source_mount().unwrap(), &first_a));
        assert_eq!(serde_json::to_value(engine.snapshot()).unwrap(), before);
        assert_eq!(load_gen, 1);
        let mut b_reply = engine.send_queue(vec![track("source-b", "7")], 0, Some(original_b));
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let b_target = b_reply.try_recv().unwrap().target.unwrap();
        assert_eq!(b_target.generation, original_b);
        let original_b_mount = engine.reserve_source_mount(b_target).unwrap();
        assert!(engine.complete_source_mount(&original_b_mount));
        assert!(!first_a.is_live());
        assert!(!engine.complete_source_mount(&reloaded_a));
        assert!(Arc::ptr_eq(&engine.current_source_mount().unwrap(), &original_b_mount));
        assert!(original_b_mount.is_live());
        assert_eq!(load_gen, 2);
    }

    #[test]
    fn load_ready_cannot_mount_accepted_a_while_original_b_is_pending() {
        let (engine, inbox) = AudioEngine::command_channel();
        let mut load_gen = 0;
        let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
        assert!(matches!(inbox.recv_timeout(Duration::from_secs(5), &mut load_gen)
            .unwrap(), AudioDelivery::Playback(_)));
        let original_a = seed.try_recv().unwrap().target.unwrap();
        let before = serde_json::to_value(engine.snapshot()).unwrap();
        let original_b = engine.begin_play_intent();
        engine.send(super::AudioCmd::LoadReady {
            target: Some(original_a), port: None, track: Box::new(track("source-a", "7")),
            decoder: Box::new(rodio::source::Zero::new(
                rodio::ChannelCount::new(1).unwrap(), rodio::SampleRate::new(1_000).unwrap(),
            )),
            shared: None, duration_ms: 60_000, start_at: Some(61_000), autoplay: false,
            is_local: false, url_fetched_at: None, play_url: None, size_bytes: None,
            gen: load_gen, preload: false,
        });
        let delivery = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        assert!(matches!(delivery, AudioDelivery::Rejected),
            "the real production inbox delivered an old A decoder for mounting after B began");
        assert_eq!(serde_json::to_value(engine.snapshot()).unwrap(), before);
        assert_eq!(load_gen, 1);
        let mut b_reply = engine.send_queue(vec![track("source-b", "7")], 0, Some(original_b));
        assert!(matches!(inbox.recv_timeout(Duration::from_secs(5), &mut load_gen)
            .unwrap(), AudioDelivery::Playback(_)));
        let b_target = b_reply.try_recv().unwrap().target.unwrap();
        assert_eq!(b_target.generation, original_b, "rejecting old A must not consume pending B");
        assert_eq!(b_target.platform, "source-b");
        assert_eq!(load_gen, 2);
    }

    #[tokio::test]
    async fn same_target_aba_rejects_completed_source_receipts_at_both_caller_entries() {
        use crate::audio::AudioFx;
        use rodio::source::SeekError;
        use rodio::{ChannelCount, SampleRate, Source};
        use std::sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}};
        struct Decoder { seeks: Arc<Mutex<Vec<Duration>>>, reads: Arc<AtomicU64> }
        impl Iterator for Decoder {
            type Item = f32;
            fn next(&mut self) -> Option<f32> { self.reads.fetch_add(1, Ordering::SeqCst); Some(0.1) }
        }
        impl Source for Decoder {
            fn current_span_len(&self) -> Option<usize> { None }
            fn channels(&self) -> ChannelCount { ChannelCount::new(1).unwrap() }
            fn sample_rate(&self) -> SampleRate { SampleRate::new(1_000).unwrap() }
            fn total_duration(&self) -> Option<Duration> { Some(Duration::from_secs(60)) }
            fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
                self.seeks.lock().unwrap().push(pos);
                Ok(())
            }
        }
        let (engine, inbox) = AudioEngine::command_channel();
        let (player, mut output) = engine.player_channel();
        let mut load_gen = 0;
        let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let target = seed.try_recv().unwrap().target.unwrap();
        let old = engine.source_mount(&target).unwrap();
        let old_seeks = Arc::new(Mutex::new(Vec::new()));
        let old_reads = Arc::new(AtomicU64::new(0));
        player.append(engine.bind_source(old.clone(), Box::new(Decoder {
            seeks: old_seeks.clone(), reads: old_reads.clone(),
        }), 0, Arc::new(AudioFx::new()), std::time::Instant::now(), None));
        assert!(engine.complete_source_mount(&old));
        output.next();
        let mut first = engine.begin_source_seek(&target, 80).unwrap();
        output.next();
        let second = engine.begin_source_seek(&target, 120).unwrap();
        output.next();
        // Both decoder ACKs are already queued, but neither caller consumed one yet.
        assert_eq!(*old_seeks.lock().unwrap(), vec![Duration::from_millis(80), Duration::from_millis(120)]);
        assert_eq!(engine.snapshot().position_ms, 120);

        let new = engine.reserve_source_mount(target.clone()).unwrap();
        assert_ne!(new.stamp().mount_nonce, old.stamp().mount_nonce);
        assert!(!Arc::ptr_eq(&new, &old));
        let new_seeks = Arc::new(Mutex::new(Vec::new()));
        let new_reads = Arc::new(AtomicU64::new(0));
        player.append(engine.bind_source(new.clone(), Box::new(Decoder {
            seeks: new_seeks.clone(), reads: new_reads.clone(),
        }), 900, Arc::new(AudioFx::new()), std::time::Instant::now(), None));
        assert!(engine.complete_source_mount(&new));
        engine.set_source_speed(&target, 0.5).unwrap();
        engine.set_source_paused(&target, true).unwrap();
        let before = serde_json::to_value(engine.snapshot()).unwrap();
        assert!(first.try_recv().unwrap().expect_err("try_recv accepted an old physical source ACK").source_intact);
        assert!(second.wait().await.expect_err("wait accepted an old physical source ACK").source_intact);
        for _ in 0..32 { output.next(); }
        assert_eq!(new.position_ms(), 900);
        assert_eq!(new.speed(), 0.5);
        assert!(new.is_paused());
        assert!(new_seeks.lock().unwrap().is_empty());
        assert_eq!(new_reads.load(Ordering::SeqCst), 0);
        assert_eq!(serde_json::to_value(engine.snapshot()).unwrap(), before);
        assert_eq!(new.stamp().target, target);
        assert_eq!(load_gen, 1);
        assert_eq!(engine.begin_play_intent(), 2, "physical ABA unexpectedly advanced logical authority");
    }

    #[tokio::test]
    async fn caller_does_not_expose_completed_a_source_receipt_after_original_b_begins() {
        use crate::audio::render_control::{BoundSeekRequest, MountStamp, RenderSeekOutput, SeekTargetGuard};
        use crate::audio::{AudioFx, DspSource};
        use rodio::source::SeekError;
        use rodio::{ChannelCount, Player, SampleRate, Source};
        use std::sync::{Arc, Mutex};
        struct Decoder { seeks: Arc<Mutex<Vec<Duration>>> }
        impl Iterator for Decoder {
            type Item = f32;
            fn next(&mut self) -> Option<f32> { Some(0.1) }
        }
        impl Source for Decoder {
            fn current_span_len(&self) -> Option<usize> { None }
            fn channels(&self) -> ChannelCount { ChannelCount::new(1).unwrap() }
            fn sample_rate(&self) -> SampleRate { SampleRate::new(1_000).unwrap() }
            fn total_duration(&self) -> Option<Duration> { Some(Duration::from_secs(60)) }
            fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
                self.seeks.lock().unwrap().push(pos);
                Ok(())
            }
        }
        let (engine, inbox) = AudioEngine::command_channel();
        let mut load_gen = 0;
        let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let stamp = MountStamp { target: seed.try_recv().unwrap().target.unwrap(), mount_nonce: 1 };
        let port = engine.source_seek_port(stamp.clone());
        let seeks = Arc::new(Mutex::new(Vec::new()));
        let (player, output) = Player::new();
        let (mut output, sender) = RenderSeekOutput::new(output);
        let dsp = DspSource::new(port.tracked_source(Box::new(Decoder { seeks: seeks.clone() }), 0),
            Arc::new(AudioFx::new()), std::time::Instant::now(), None);
        player.append(SeekTargetGuard::new(Box::new(dsp), port.clone()));
        output.next();
        let (original_a, a_reply) = BoundSeekRequest::new(stamp, port, 80, 1.0).unwrap();
        let before = serde_json::to_value(engine.snapshot()).unwrap();
        assert!(sender.try_submit(original_a).is_ok());
        output.next();
        assert_eq!(*seeks.lock().unwrap(), vec![Duration::from_millis(80)]);
        let original_b = engine.begin_play_intent();
        assert_eq!(original_b, 2);
        let error = a_reply.wait().await.expect_err("caller exposed an already completed A ACK after B began");
        assert!(error.source_intact);
        assert_eq!(serde_json::to_value(engine.snapshot()).unwrap(), before);
        let mut b_reply = engine.send_queue(vec![track("source-b", "7")], 0, Some(original_b));
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let b_reply = b_reply.try_recv().unwrap();
        assert!(b_reply.applied);
        assert_eq!(b_reply.target.unwrap().generation, original_b);
        assert_eq!(load_gen, 2);
    }

    #[test]
    fn same_target_aba_during_decoder_seek_rejects_old_ack_without_holding_authority_gate() {
        use crate::audio::AudioFx;
        use rodio::source::SeekError;
        use rodio::{ChannelCount, SampleRate, Source};
        use std::sync::{Arc, Condvar, Mutex, atomic::{AtomicU64, Ordering}};
        struct Decoder {
            entered: Option<std::sync::mpsc::Sender<()>>,
            release: Arc<(Mutex<bool>, Condvar)>,
            seeks: Arc<Mutex<Vec<Duration>>>,
            reads: Arc<AtomicU64>,
        }
        impl Iterator for Decoder {
            type Item = f32;
            fn next(&mut self) -> Option<f32> { self.reads.fetch_add(1, Ordering::SeqCst); Some(0.1) }
        }
        impl Source for Decoder {
            fn current_span_len(&self) -> Option<usize> { None }
            fn channels(&self) -> ChannelCount { ChannelCount::new(1).unwrap() }
            fn sample_rate(&self) -> SampleRate { SampleRate::new(1_000).unwrap() }
            fn total_duration(&self) -> Option<Duration> { Some(Duration::from_secs(60)) }
            fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
                self.seeks.lock().unwrap().push(pos);
                if let Some(entered) = &self.entered {
                    entered.send(()).unwrap();
                    let (lock, wake) = &*self.release;
                    let mut released = lock.lock().unwrap();
                    while !*released { released = wake.wait(released).unwrap(); }
                }
                Ok(())
            }
        }
        struct AbaPullWorker {
            release: Arc<(Mutex<bool>, Condvar)>,
            thread: Option<std::thread::JoinHandle<crate::audio::render_control::RenderSeekOutput>>,
        }
        impl AbaPullWorker {
            fn finish(&mut self) -> crate::audio::render_control::RenderSeekOutput {
                let (lock, wake) = &*self.release;
                *lock.lock().unwrap() = true;
                wake.notify_all();
                self.thread.take().unwrap().join().unwrap()
            }
        }
        impl Drop for AbaPullWorker {
            fn drop(&mut self) {
                let (lock, wake) = &*self.release;
                *lock.lock().unwrap() = true;
                wake.notify_all();
                if let Some(thread) = self.thread.take() { let _ = thread.join(); }
            }
        }
        let (engine, inbox) = AudioEngine::command_channel();
        let engine = Arc::new(engine);
        let (player, mut output) = engine.player_channel();
        let player = Arc::new(player);
        let mut load_gen = 0;
        let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let target = seed.try_recv().unwrap().target.unwrap();
        let old = engine.source_mount(&target).unwrap();
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let old_seeks = Arc::new(Mutex::new(Vec::new()));
        player.append(engine.bind_source(old.clone(), Box::new(Decoder {
            entered: Some(entered_tx), release: release.clone(), seeks: old_seeks.clone(),
            reads: Arc::new(AtomicU64::new(0)),
        }), 0, Arc::new(AudioFx::new()), std::time::Instant::now(), None));
        assert!(engine.complete_source_mount(&old));
        output.next();
        let mut pending = engine.begin_source_seek(&target, 80).unwrap();
        let mut worker = AbaPullWorker { release: release.clone(),
            thread: Some(std::thread::spawn(move || { output.next(); output })) };
        assert!(entered_rx.recv_timeout(Duration::from_secs(5)).is_ok(), "old decoder seek was not entered");
        let new_seeks = Arc::new(Mutex::new(Vec::new()));
        let new_reads = Arc::new(AtomicU64::new(0));
        let (swap_tx, swap_rx) = std::sync::mpsc::channel();
        let swap_engine = engine.clone();
        let swap_player = player.clone();
        let swap_target = target.clone();
        let swap_seeks = new_seeks.clone();
        let swap_reads = new_reads.clone();
        let swap_thread = std::thread::spawn(move || {
            let new = swap_engine.reserve_source_mount(swap_target.clone()).unwrap();
            swap_player.append(swap_engine.bind_source(new.clone(), Box::new(Decoder {
                entered: None, release, seeks: swap_seeks, reads: swap_reads,
            }), 900, Arc::new(AudioFx::new()), std::time::Instant::now(), None));
            assert!(swap_engine.complete_source_mount(&new));
            swap_engine.set_source_speed(&swap_target, 0.5).unwrap();
            swap_engine.set_source_paused(&swap_target, true).unwrap();
            swap_tx.send(new).unwrap();
        });
        let swapped = swap_rx.recv_timeout(Duration::from_secs(5));
        let before = swapped.as_ref().ok().map(|_| serde_json::to_value(engine.snapshot()).unwrap());
        // Always release/join the decoder before diagnosing a blocked Gate.
        // Keep the software output alive so destruction cannot retire the new source.
        let mut output = worker.finish();
        swap_thread.join().unwrap();
        let new = swapped.expect("blocked decoder seek held the shared source authority Gate");
        let before = before.unwrap();
        assert_eq!(engine.snapshot().position_ms, 900);
        assert_ne!(new.stamp().mount_nonce, old.stamp().mount_nonce);
        assert!(!Arc::ptr_eq(&new, &old));
        assert_eq!(*old_seeks.lock().unwrap(), vec![Duration::from_millis(80)]);
        assert!(pending.try_recv().unwrap().expect_err("decoder returned an applied old source ACK after same-target remount").source_intact);
        for _ in 0..32 { output.next(); }
        assert!(new.is_live());
        assert_eq!(new.position_ms(), 900);
        assert_eq!(new.speed(), 0.5);
        assert!(new.is_paused());
        assert!(new_seeks.lock().unwrap().is_empty());
        assert_eq!(new_reads.load(Ordering::SeqCst), 0);
        assert_eq!(serde_json::to_value(engine.snapshot()).unwrap(), before);
        assert_eq!(new.stamp().target, target);
        assert_eq!(load_gen, 1);
        assert_eq!(engine.begin_play_intent(), 2, "physical ABA unexpectedly advanced logical authority");
    }

    #[test]
    fn slow_source_seek_leaves_gate_open_and_returns_no_stale_a_receipt() {
        use crate::audio::render_control::{BoundSeekRequest, MountStamp, RenderSeekOutput, SeekTargetGuard};
        use crate::audio::{AudioFx, DspSource};
        use rodio::source::SeekError;
        use rodio::{ChannelCount, Player, SampleRate, Source};
        use std::sync::{Arc, Condvar, Mutex};
        struct Decoder {
            entered: std::sync::mpsc::Sender<()>,
            release: Arc<(Mutex<bool>, Condvar)>,
        }
        impl Iterator for Decoder {
            type Item = f32;
            fn next(&mut self) -> Option<f32> { Some(0.1) }
        }
        impl Source for Decoder {
            fn current_span_len(&self) -> Option<usize> { None }
            fn channels(&self) -> ChannelCount { ChannelCount::new(1).unwrap() }
            fn sample_rate(&self) -> SampleRate { SampleRate::new(1_000).unwrap() }
            fn total_duration(&self) -> Option<Duration> { Some(Duration::from_secs(60)) }
            fn try_seek(&mut self, _: Duration) -> Result<(), SeekError> {
                self.entered.send(()).unwrap();
                let (lock, wake) = &*self.release;
                let mut released = lock.lock().unwrap();
                while !*released { released = wake.wait(released).unwrap(); }
                Ok(())
            }
        }
        struct PullWorker {
            release: Arc<(Mutex<bool>, Condvar)>,
            thread: Option<std::thread::JoinHandle<()>>,
        }
        impl PullWorker {
            fn finish(&mut self) {
                let (lock, wake) = &*self.release;
                *lock.lock().unwrap() = true;
                wake.notify_all();
                self.thread.take().unwrap().join().unwrap();
            }
        }
        impl Drop for PullWorker {
            fn drop(&mut self) {
                let (lock, wake) = &*self.release;
                *lock.lock().unwrap() = true;
                wake.notify_all();
                if let Some(thread) = self.thread.take() { let _ = thread.join(); }
            }
        }
        let (engine, inbox) = AudioEngine::command_channel();
        let engine = Arc::new(engine);
        let mut load_gen = 0;
        let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let stamp = MountStamp { target: seed.try_recv().unwrap().target.unwrap(), mount_nonce: 1 };
        let port = engine.source_seek_port(stamp.clone());
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (player, output) = Player::new();
        let (mut output, sender) = RenderSeekOutput::new(output);
        let dsp = DspSource::new(port.tracked_source(Box::new(Decoder {
            entered: entered_tx, release: release.clone(),
        }), 0), Arc::new(AudioFx::new()), std::time::Instant::now(), None);
        player.append(SeekTargetGuard::new(Box::new(dsp), port.clone()));
        output.next();
        let (original_a, mut a_reply) = BoundSeekRequest::new(stamp, port, 80, 1.0).unwrap();
        let before = serde_json::to_value(engine.snapshot()).unwrap();
        assert!(sender.try_submit(original_a).is_ok());
        let thread = std::thread::spawn(move || { output.next(); });
        let mut worker = PullWorker { release, thread: Some(thread) };
        assert!(entered_rx.recv_timeout(Duration::from_secs(5)).is_ok(), "A did not reach its decoder seek");
        let (b_tx, b_rx) = std::sync::mpsc::channel();
        let b_engine = engine.clone();
        let b_thread = std::thread::spawn(move || { b_tx.send(b_engine.begin_play_intent()).unwrap(); });
        let b_ticket = b_rx.recv_timeout(Duration::from_secs(5));
        worker.finish();
        b_thread.join().unwrap();
        let original_b = b_ticket.expect("blocking decoder seek held the shared intent Gate");
        assert_eq!(original_b, 2);
        assert!(a_reply.try_recv().unwrap().is_err(), "A returned an applied receipt after B began during decoder seek");
        assert_eq!(serde_json::to_value(engine.snapshot()).unwrap(), before);
        let mut b_reply = engine.send_queue(vec![track("source-b", "7")], 0, Some(original_b));
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let b_reply = b_reply.try_recv().unwrap();
        assert!(b_reply.applied);
        assert_eq!(b_reply.target.unwrap().generation, original_b);
        assert_eq!(load_gen, 2);
    }

    #[test]
    fn source_bound_render_seek_rejects_a_without_consuming_pending_original_b() {
        use crate::audio::render_control::{BoundSeekRequest, MountStamp, RenderSeekOutput, SeekTargetGuard};
        use crate::audio::{AudioFx, DspSource};
        use rodio::source::SeekError;
        use rodio::{ChannelCount, Player, SampleRate, Source};
        use std::sync::{Arc, Mutex};
        struct Decoder { seeks: Arc<Mutex<Vec<Duration>>> }
        impl Iterator for Decoder {
            type Item = f32;
            fn next(&mut self) -> Option<f32> { Some(0.1) }
        }
        impl Source for Decoder {
            fn current_span_len(&self) -> Option<usize> { None }
            fn channels(&self) -> ChannelCount { ChannelCount::new(1).unwrap() }
            fn sample_rate(&self) -> SampleRate { SampleRate::new(1_000).unwrap() }
            fn total_duration(&self) -> Option<Duration> { Some(Duration::from_secs(60)) }
            fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
                self.seeks.lock().unwrap().push(pos);
                Ok(())
            }
        }
        let (engine, inbox) = AudioEngine::command_channel();
        let mut load_gen = 0;
        let mut seed = engine.send_queue(vec![track("source-a", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let stamp = MountStamp { target: seed.try_recv().unwrap().target.unwrap(), mount_nonce: 1 };
        let port = engine.source_seek_port(stamp.clone());
        let seeks = Arc::new(Mutex::new(Vec::new()));
        let (player, output) = Player::new();
        let (mut output, sender) = RenderSeekOutput::new(output);
        let dsp = DspSource::new(port.tracked_source(Box::new(Decoder { seeks: seeks.clone() }), 0),
            Arc::new(AudioFx::new()), std::time::Instant::now(), None);
        player.append(SeekTargetGuard::new(Box::new(dsp), port.clone()));
        output.next();
        let (original_a, mut a_reply) = BoundSeekRequest::new(stamp, port.clone(), 80, 1.0).unwrap();
        let original_b = engine.begin_play_intent();
        assert_eq!(original_b, 2, "source factory re-registered the already accepted A");
        let before = serde_json::to_value(engine.snapshot()).unwrap();
        assert!(sender.try_submit(original_a).is_ok());
        output.next();
        assert!(seeks.lock().unwrap().is_empty(), "stale A reached its decoder while original B was pending");
        assert!(a_reply.try_recv().unwrap().unwrap_err().source_intact);
        assert_eq!(serde_json::to_value(engine.snapshot()).unwrap(), before);
        assert_eq!(load_gen, 1);
        let mut b_reply = engine.send_queue(vec![track("source-b", "7")], 0, Some(original_b));
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let b_reply = b_reply.try_recv().unwrap();
        assert!(b_reply.applied, "stale A consumed the original pending B");
        assert_eq!(b_reply.target.unwrap().generation, original_b);
        assert_eq!(load_gen, 2);
        assert_eq!(engine.snapshot().source_id.as_ref().map(|id| id.as_str()), Some("source-b"));
    }

    #[test]
    fn initial_paused_source_seek_retains_original_request_until_normal_output_pull() {
        use crate::audio::render_control::{BoundSeekRequest, MountStamp, RenderSeekOutput,
            SeekTargetGuard, SourceSeekPort};
        use crate::audio::{AudioFx, DspSource};
        use rodio::source::SeekError;
        use rodio::{ChannelCount, Player, SampleRate, Source};
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::sync::{Arc, Mutex};

        struct PausedDecoder { samples: Arc<AtomicU64>, seeks: Arc<Mutex<Vec<Duration>>> }
        impl Iterator for PausedDecoder {
            type Item = f32;
            fn next(&mut self) -> Option<f32> {
                self.samples.fetch_add(1, Ordering::SeqCst);
                Some(0.1)
            }
        }
        impl Source for PausedDecoder {
            fn current_span_len(&self) -> Option<usize> { None }
            fn channels(&self) -> ChannelCount { ChannelCount::new(1).unwrap() }
            fn sample_rate(&self) -> SampleRate { SampleRate::new(1_000).unwrap() }
            fn total_duration(&self) -> Option<Duration> { Some(Duration::from_secs(60)) }
            fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
                self.seeks.lock().unwrap().push(pos);
                Ok(())
            }
        }
        let (engine, inbox) = AudioEngine::command_channel();
        let mut load_gen = 0;
        let mut receipt = engine.send_queue(vec![track("source-a", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let stamp = MountStamp { target: receipt.try_recv().unwrap().target.unwrap(), mount_nonce: 1 };
        let port = SourceSeekPort::new(stamp.clone());
        let samples = Arc::new(AtomicU64::new(0));
        let seeks = Arc::new(Mutex::new(Vec::new()));
        let (player, output) = Player::new();
        player.pause();
        let (mut output, sender) = RenderSeekOutput::new(output);
        let dsp = DspSource::new(port.tracked_source(Box::new(PausedDecoder {
            samples: samples.clone(), seeks: seeks.clone(),
        }), 0), Arc::new(AudioFx::new()), std::time::Instant::now(), None);
        player.append(SeekTargetGuard::new(Box::new(dsp), port.clone()));
        let (request, mut received) = BoundSeekRequest::new(stamp.clone(), port.clone(), 80, 1.0).unwrap();
        assert!(sender.try_submit(request).is_ok());
        output.next();
        assert!(matches!(received.try_recv(), Err(tokio::sync::oneshot::error::TryRecvError::Empty)),
            "initial paused seek completed before the queue selected its original source");
        let mut accepted = None;
        for _ in 0..64 {
            output.next();
            match received.try_recv() {
                Ok(receipt) => { accepted = Some(receipt); break; }
                Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {}
                Err(error) => panic!("original paused-source receipt closed: {error}"),
            }
        }
        let accepted = accepted.expect("normal paused output pulls never serviced the original request")
            .expect("original paused source was not sought");
        assert_eq!(accepted.stamp, stamp);
        assert_eq!(accepted.content_position_ms, 80);
        assert_eq!(*seeks.lock().unwrap(), vec![Duration::from_millis(80)]);
        assert_eq!(samples.load(Ordering::SeqCst), 0);
        assert!(player.is_paused());
        assert_eq!(port.position_ms(), 80);
    }

    #[test]
    fn render_bound_seek_does_not_reset_the_current_foreign_dsp_or_decoder() {
        use crate::audio::fx::SpectrumTap;
        use crate::audio::render_control::{BoundSeekRequest, MountStamp, RenderSeekOutput,
            SeekTargetGuard, SourceSeekPort};
        use crate::audio::{AudioFx, DspSource};
        use rodio::source::SeekError;
        use rodio::{ChannelCount, Player, SampleRate, Source};
        use std::sync::{Arc, Mutex};

        struct DecoderTracer { seeks: Arc<Mutex<Vec<Duration>>> }
        impl Iterator for DecoderTracer {
            type Item = f32;
            fn next(&mut self) -> Option<f32> { Some(0.1) }
        }
        impl Source for DecoderTracer {
            fn current_span_len(&self) -> Option<usize> { None }
            fn channels(&self) -> ChannelCount { ChannelCount::new(1).unwrap() }
            fn sample_rate(&self) -> SampleRate { SampleRate::new(1_000).unwrap() }
            fn total_duration(&self) -> Option<Duration> { Some(Duration::from_secs(60)) }
            fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
                self.seeks.lock().unwrap().push(pos);
                Ok(())
            }
        }
        let (engine, inbox) = AudioEngine::command_channel();
        let mut load_gen = 0;
        let mut seed = engine.send_queue(vec![track("source-b", "7"), track("source-a", "7")], 0, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let b_target = seed.try_recv().unwrap().target.unwrap();
        let mut selecting_a = engine.send_play_at(1, None);
        inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let a_target = selecting_a.try_recv().unwrap().target.unwrap();
        let b_stamp = MountStamp { target: b_target, mount_nonce: 1 };
        let a_stamp = MountStamp { target: a_target, mount_nonce: 2 };
        let b_port = SourceSeekPort::new(b_stamp);
        let a_port = SourceSeekPort::new(a_stamp.clone());
        let b_seeks = Arc::new(Mutex::new(Vec::new()));
        let a_seeks = Arc::new(Mutex::new(Vec::new()));
        let fx = Arc::new(AudioFx::new());
        let (player, output) = Player::new();
        let (mut output, sender) = RenderSeekOutput::new(output);
        let b_dsp = DspSource::new(b_port.tracked_source(Box::new(DecoderTracer {
            seeks: b_seeks.clone(),
        }), 0), fx.clone(), std::time::Instant::now(), Some(SpectrumTap::new(None)));
        player.append(SeekTargetGuard::new(Box::new(b_dsp), b_port.clone()));
        output.next();
        assert!(b_port.position_ms() > 0);
        let a_dsp = DspSource::new(a_port.tracked_source(Box::new(DecoderTracer {
            seeks: a_seeks.clone(),
        }), 0), fx, std::time::Instant::now(), Some(SpectrumTap::new(None)));
        player.append(SeekTargetGuard::new(Box::new(a_dsp), a_port.clone()));
        let (request, mut received) = BoundSeekRequest::new(a_stamp.clone(), a_port.clone(), 80, 1.0).unwrap();
        assert!(sender.try_submit(request).is_ok());
        output.next();
        assert!(b_seeks.lock().unwrap().is_empty(),
            "logical Loading A caused a seek/reset of the physically current B DSP/decoder");
        let rejected = received.try_recv().unwrap().unwrap_err();
        assert!(rejected.source_intact);
        assert!(a_seeks.lock().unwrap().is_empty());
        assert_eq!(a_port.position_ms(), 0);

        player.skip_one();
        for _ in 0..512 {
            output.next();
            if a_port.position_ms() > 0 { break; }
        }
        assert!(a_port.position_ms() > 0);
        let (request, mut received) = BoundSeekRequest::new(a_stamp.clone(), a_port.clone(), 80, 1.0).unwrap();
        assert!(sender.try_submit(request).is_ok());
        output.next();
        let accepted = received.try_recv().unwrap().unwrap();
        assert_eq!(accepted.stamp, a_stamp);
        assert_eq!(accepted.content_position_ms, 80);
        assert_eq!(*a_seeks.lock().unwrap(), vec![Duration::from_millis(80)]);
        assert!(b_seeks.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn startup_restore_uses_its_captured_eligibility_and_real_commit_receipt() {
        use crate::audio::state::PlayMode;
        use crate::provider::types::Quality;
        fn saved() -> super::super::playback_commit::RestoredPlayback {
            super::super::playback_commit::RestoredPlayback {
                tracks: vec![track("saved-source", "7")], index: 0, position_ms: 8_123,
                play_mode: PlayMode::Random, volume: 0.25, muted: true,
                quality: Quality::default(),
            }
        }
        let (engine, inbox) = AudioEngine::command_channel();
        let (loaded_tx, loaded_rx) = tokio::sync::oneshot::channel();
        let restoring_engine = engine.clone();
        let restoring = tokio::spawn(async move {
            restoring_engine.restore_after_load(|| async {
                let _ = loaded_tx.send(());
                Ok(Some(saved()))
            }).await
        });
        loaded_rx.await.unwrap();
        let mut load_gen = 0;
        let delivery = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let restored = restoring.await.unwrap().unwrap();
        assert!(restored.is_some(), "eligible startup restore returned no accepted snapshot");
        assert!(matches!(delivery, AudioDelivery::Playback(_)));
        let restored = restored.unwrap();
        assert_eq!(restored.source_id.as_ref().map(|id| id.as_str()), Some("saved-source"));
        assert_eq!(restored.position_ms, 8_123);
        assert_eq!(restored.play_mode, PlayMode::Random);
        assert_eq!(restored.volume, 0.25);
        assert!(restored.muted);
        assert_eq!(load_gen, 1);
        let read_only = engine.restore_after_load(|| async {
            Err("existing track must not invoke the storage loader".to_string())
        }).await.unwrap();
        assert_eq!(serde_json::to_value(read_only.unwrap()).unwrap(),
            serde_json::to_value(restored).unwrap());

        let (held_engine, held_inbox) = AudioEngine::command_channel();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let (loaded_tx, loaded_rx) = tokio::sync::oneshot::channel();
        let delayed_engine = held_engine.clone();
        let delayed = tokio::spawn(async move {
            delayed_engine.restore_after_load(|| async {
                let _ = entered_tx.send(());
                release_rx.await.unwrap();
                let _ = loaded_tx.send(());
                Ok(Some(saved()))
            }).await
        });
        entered_rx.await.unwrap();
        let original_b = held_engine.begin_play_intent();
        let before = serde_json::to_value(held_engine.snapshot()).unwrap();
        release_tx.send(()).unwrap();
        loaded_rx.await.unwrap();
        let mut held_gen = 0;
        assert!(matches!(held_inbox.recv_timeout(Duration::from_secs(5), &mut held_gen)
            .unwrap(), AudioDelivery::Rejected));
        assert!(delayed.await.unwrap().unwrap().is_none());
        assert_eq!(serde_json::to_value(held_engine.snapshot()).unwrap(), before);
        assert_eq!(held_gen, 0);
        let mut b = held_engine.send_queue(vec![track("new-source", "7")], 0, Some(original_b));
        assert!(matches!(held_inbox.recv_timeout(Duration::from_secs(5), &mut held_gen)
            .unwrap(), AudioDelivery::Playback(_)));
        assert_eq!(b.try_recv().unwrap().target.unwrap().generation, original_b);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn late_queue_ack_is_rejected_without_consuming_new_pending_b() {
        let (engine, inbox) = AudioEngine::command_channel();
        let original_a = engine.begin_play_intent();
        let (filtered_tx, filtered_rx) = tokio::sync::oneshot::channel();
        let engine_a = engine.clone();
        let a_work = tokio::spawn(async move {
            engine_a.queue_after_filter(
                vec![track("source-a", "7")], 0, Some(original_a),
                move |tracks, index| async move {
                    filtered_tx.send(()).expect("A reached the real sender");
                    Ok((tracks, index))
                },
            ).await
        });
        filtered_rx.await.expect("A has sent its real queue command");
        let mut load_gen = 0;
        let a_delivery = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        assert!(matches!(a_delivery, AudioDelivery::Playback(_)));
        assert_eq!(load_gen, 1, "A's semantic commit really happened first");
        let before = serde_json::to_value(engine.snapshot()).unwrap();

        // No await between sending A's receipt and beginning B on this single-thread runtime.
        // A has committed, but its IPC future has not yet returned to its caller.
        let original_b = engine.begin_play_intent();
        let a_receipt = a_work.await.unwrap().unwrap();
        assert!(
            !a_receipt.applied && a_receipt.target.is_none()
                && serde_json::to_value(engine.snapshot()).unwrap() == before
                && load_gen == 1,
            "late A queue ACK remained usable after B began: receipt={a_receipt:?}, load_gen={load_gen}",
        );

        let (b_filtered_tx, b_filtered_rx) = tokio::sync::oneshot::channel();
        let engine_b = engine.clone();
        let b_work = tokio::spawn(async move {
            engine_b.queue_after_filter(
                vec![track("source-b", "7")], 0, Some(original_b),
                move |tracks, index| async move {
                    b_filtered_tx.send(()).expect("B reached the same real sender");
                    Ok((tracks, index))
                },
            ).await
        });
        b_filtered_rx.await.expect("B still has its original pending authority");
        let b_delivery = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let b_receipt = b_work.await.unwrap().unwrap();
        assert!(b_receipt.applied && matches!(b_delivery, AudioDelivery::Playback(_)));
        let b_target = b_receipt.target.expect("accepted B retains its own ACK target");
        assert_eq!((b_target.generation, b_target.platform.as_str(), b_target.id.as_str()),
            (original_b, "source-b", "7"));
        assert_eq!(load_gen, 2, "the ACK check cannot consume B before its semantic commit");
        assert!(!engine.abandon_play_intent(original_b), "B survives its caller's finally");
    }

    #[test]
    fn queued_original_a_cannot_be_rebound_to_pending_b_by_real_receiver() {
        let (engine, inbox) = AudioEngine::command_channel();
        let original_a = engine.begin_play_intent();
        let mut a_reply = engine.send_queue(vec![track("source-a", "7")], 0, Some(original_a));
        // The actual A message is already queued before B declares a newer action.
        let original_b = engine.begin_play_intent();
        let before = serde_json::to_value(engine.snapshot()).unwrap();
        let mut load_gen = 0;
        let a_delivery = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let a_receipt = a_reply.try_recv().expect("the production receiver replied to A");
        assert!(
            !a_receipt.applied && matches!(a_delivery, AudioDelivery::Rejected)
                && engine.queue_snapshot().is_empty()
                && serde_json::to_value(engine.snapshot()).unwrap() == before
                && load_gen == 0,
            "real receiver rebound queued A to B: receipt={a_receipt:?}, track={:?}, load_gen={load_gen}",
            engine.snapshot().track_id,
        );

        // The rejected old message must not consume B; identical bare ids are different sources.
        let mut b_reply = engine.send_queue(vec![track("source-b", "7")], 0, Some(original_b));
        let b_delivery = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
        let b_receipt = b_reply.try_recv().expect("B got its own production receipt");
        assert!(b_receipt.applied && matches!(b_delivery, AudioDelivery::Playback(_)));
        let target = b_receipt.target.expect("B's logical accepted target");
        assert_eq!((target.generation, target.platform.as_str(), target.id.as_str()),
            (original_b, "source-b", "7"));
        let queue = engine.queue_snapshot();
        let current = queue.current().expect("B committed the actual shared queue");
        assert_eq!((current.platform.as_str(), current.id.as_str()), ("source-b", "7"));
        assert_eq!(load_gen, 1, "only accepted B allocates a real load generation");
        assert!(!engine.abandon_play_intent(original_b), "finally cannot revoke accepted B");
    }
}

#[cfg(test)]
mod preload_gate_tests {
    use super::{preload_block, PreloadFacts};

    /// 全部条件满足的对照组：当前曲目已挂载且在播、无缝开着、有预载额度。
    fn facts() -> PreloadFacts {
        PreloadFacts {
            gapless: true,
            sleep_after_track: false,
            auto_next: true,
            has_slot: false,
            pausing: false,
            playing: true,
            has_progress: true,
            retries_left: true,
        }
    }

    #[test]
    fn all_clear_allows_preload() {
        assert_eq!(preload_block(facts()), None);
    }

    /// 每个条件单独破坏都必须被拦住，且理由不串台 —— 日志里那串就是排查依据。
    #[test]
    fn each_condition_blocks_with_its_own_reason() {
        assert_eq!(
            preload_block(PreloadFacts { gapless: false, ..facts() }),
            Some("gapless-off")
        );
        assert_eq!(
            preload_block(PreloadFacts { sleep_after_track: true, ..facts() }),
            Some("sleep-after-track")
        );
        assert_eq!(
            preload_block(PreloadFacts { auto_next: false, ..facts() }),
            Some("auto-next-off")
        );
        assert_eq!(
            preload_block(PreloadFacts { has_slot: true, ..facts() }),
            Some("already-preloading")
        );
        assert_eq!(
            preload_block(PreloadFacts { pausing: true, ..facts() }),
            Some("pausing")
        );
        assert_eq!(
            preload_block(PreloadFacts { playing: false, ..facts() }),
            Some("not-playing")
        );
        assert_eq!(
            preload_block(PreloadFacts { has_progress: false, ..facts() }),
            Some("not-mounted")
        );
        assert_eq!(
            preload_block(PreloadFacts { retries_left: false, ..facts() }),
            Some("retry-exhausted")
        );
    }

    /// 加载完成但还没开始播（暂停态加载 / 恢复现场）不该预热：
    /// 预取会白占带宽，且取来的地址可能等不到用就过期了。
    #[test]
    fn loaded_but_paused_does_not_preload() {
        let paused = PreloadFacts { playing: false, ..facts() };
        assert_eq!(preload_block(paused), Some("not-playing"));
    }

    /// 重试额度是最后一道闸：前七条都放行，只有它能把重试用光的局面拦住，
    /// 免得每 25ms 反复拉一次注定失败的流。
    #[test]
    fn retry_budget_is_the_last_gate() {
        let exhausted = PreloadFacts { retries_left: false, ..facts() };
        assert_eq!(preload_block(exhausted), Some("retry-exhausted"));
        // 额度还在就继续试 —— 失败一次不等于放弃这一首的预热
        let ready = PreloadFacts { retries_left: true, ..facts() };
        assert_eq!(preload_block(ready), None);
    }
}
