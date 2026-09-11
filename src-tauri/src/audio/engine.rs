//! 播放引擎实现：专属音频线程 + mpsc（DESIGN §7.4）。
//!
//! M2 范围：Load / Play / Pause / Stop / Seek / SetVolume / SetMuted / Shutdown
//! + 播放队列（SetQueue / PlayAt / Next / Previous / SetPlayMode）与自然播完自动切歌。
//!
//! 队列推进的纯逻辑见 `queue.rs`；引擎线程独占处理，自动切歌的取址在 tokio 任务里
//! 异步完成后再回发 Load（音频线程不做网络 IO 等待）。
//!
//! 位置口径：`sink.get_pos()` 是 rodio 对当前源的真实播放位置（暂停时冻结），
//! tick 时以它为准并回写快照，避免自增累计漂移。

use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use rodio::{Decoder, Player, Source};

// 设备枚举 / 名称查询都挂在 trait 上，必须显式引入
use cpal::traits::{DeviceTrait, HostTrait};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use crate::db::store::{self, PlayState};
use crate::db::Database;
use crate::provider::registry::{PlayUrlCache, ProviderRegistry};
use crate::provider::types::{self, Track};

use super::queue::Queue;
use super::range_reader::{self, RangeShared};
use super::state::{PlaybackStateSnapshot, PlaybackStatus, PlayMode, Quality};

/// 播放来源：在线 URL（走 HttpRangeReader）或本地文件。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[allow(non_snake_case)]
pub enum PlaySource {
    Online { url: String, fetchedAt: u64 },
    Local { path: String },
}

/// 音频命令（DESIGN §7.4 AudioCmd 的 M2 子集）。
pub enum AudioCmd {
    Load {
        track: Box<Track>,
        source: Box<PlaySource>,
        start_at: Option<u64>,
        autoplay: bool,
    },
    Play,
    Pause,
    Stop,
    Seek(u64),
    SetVolume(f32),
    SetMuted(bool),
    /// 整表替换队列并从 index 开始播放
    SetQueue { tracks: Vec<Track>, index: usize },
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
    /// 切换音频输出设备。`None` = 跟随系统默认（设备插拔自动切换）；
    /// `Some(设备名)` = 固定到该设备。切换时当前曲目从原进度无缝续播。
    SetOutputDevice { name: Option<String> },
    /// 改「默认播放音质」（设置页入口）：写进 settings，重启后保持；
    /// 当前曲目没被单独指定音质时，立即按新音质重新取址续播。
    SetDefaultQuality { quality: Quality },
    /// 只改当前这首的音质（播放条入口）：不写 settings，切到别的歌自动回到默认。
    SetTrackQuality { quality: Quality },
    Shutdown,
}

/// 引擎句柄：clone 后供多个 Tauri 命令使用。
#[derive(Clone)]
pub struct AudioEngine {
    tx: Sender<AudioCmd>,
    state: Arc<RwLock<PlaybackStateSnapshot>>,
    queue: Arc<Mutex<Queue>>,
}

impl AudioEngine {
    /// 启动专属音频线程。registry / url_cache 供自动切歌时异步取址；
    /// db 供队列/播放状态持久化（None = 数据库不可用，播放不受影响）。
    pub fn spawn(
        app: tauri::AppHandle,
        cache_dir: PathBuf,
        registry: Arc<ProviderRegistry>,
        url_cache: Arc<PlayUrlCache>,
        db: Option<Arc<Database>>,
    ) -> Self {
        let (tx, rx) = mpsc::channel::<AudioCmd>();
        let state = Arc::new(RwLock::new(PlaybackStateSnapshot::default()));
        let state_clone = Arc::clone(&state);
        let queue = Arc::new(Mutex::new(Queue::default()));

        let tx_thread = tx.clone();
        let queue_thread = Arc::clone(&queue);
        let _ = std::thread::Builder::new()
            .name("audio-engine".into())
            .spawn(move || {
                run_engine(
                    EngineDeps {
                        app,
                        rx,
                        state: state_clone,
                        cache_dir,
                        registry,
                        url_cache,
                        tx: tx_thread,
                        queue: queue_thread,
                        db,
                    },
                );
            });

        Self { tx, state, queue }
    }

    pub fn send(&self, cmd: AudioCmd) {
        // 引擎线程死亡时发送失败仅记录，不打断前端
        if self.tx.send(cmd).is_err() {
            log::error!("audio engine 已退出，命令丢弃");
        }
    }

    pub fn snapshot(&self) -> PlaybackStateSnapshot {
        self.state.read().unwrap().clone()
    }

    /// 队列快照（cmd_get_queue 用；引擎线程是唯一写者）
    pub fn queue_snapshot(&self) -> Queue {
        self.queue.lock().unwrap().clone()
    }
}

struct EngineInner {
    app: tauri::AppHandle,
    tx: Sender<AudioCmd>,
    state: Arc<RwLock<PlaybackStateSnapshot>>,
    queue: Arc<Mutex<Queue>>,
    cache_dir: PathBuf,
    http: reqwest::blocking::Client,
    registry: Arc<ProviderRegistry>,
    url_cache: Arc<PlayUrlCache>,
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
    /// 当前实际挂接的输出设备名（快照里展示用）
    current_device: String,
    current_shared: Option<Arc<RangeShared>>,
    volume_before_mute: f32,
    tick_anchor: Option<std::time::Instant>,
    /// 上次把 position 持久化到 settings 的时刻（5s 节流）
    last_persist: Option<std::time::Instant>,
    /// 引擎启动时刻，monotonicMs 以此为原点（DESIGN §7.11）
    epoch: std::time::Instant,
    db: Option<Arc<Database>>,
}

impl EngineInner {
    fn publish(&self) {
        let snap = self.state.read().unwrap().clone();
        let _ = self.app.emit("playback-state-changed", &snap);
    }

    fn mutate(&self, f: impl FnOnce(&mut PlaybackStateSnapshot)) {
        {
            let mut st = self.state.write().unwrap();
            f(&mut st);
        }
        self.publish();
    }

    fn effective_volume(&self) -> f32 {
        let st = self.state.read().unwrap();
        if st.muted {
            0.0
        } else {
            st.volume.clamp(0.0, 1.0)
        }
    }

    fn queue_emit(&self) {
        let q = self.queue.lock().unwrap();
        let _ = self.app.emit(
            "queue-changed",
            serde_json::json!({
                "tracks": q.tracks,
                "index": q.index.map(|i| i as u32),
            }),
        );
    }

    fn sync_queue_to_snapshot(&self) {
        let q = self.queue.lock().unwrap();
        let mut st = self.state.write().unwrap();
        st.queue_index = q.index;
        st.queue_len = q.len();
    }

    /// 在指定设备上重建输出流 + Sink。`None` = 跟随系统默认设备。
    ///
    /// 重建后当前曲目从原进度无缝续播：重走 load 链路（resolve 走 10 分钟
    /// URL 缓存，几乎瞬时），音量/播放态一并迁移。失败时保留旧流不动 ——
    /// 切设备失败不该让播放中断。
    fn rebuild_output(&mut self, choice: Option<&str>) -> Result<(), String> {
        let new_stream = match choice {
            Some(name) => {
                let device = cpal::default_host()
                    .output_devices()
                    .map_err(|e| e.to_string())?
                    .find(|d| d.description().map(|desc| desc.name() == name).unwrap_or(false))
                    .ok_or_else(|| format!("找不到输出设备：{name}"))?;
                rodio::DeviceSinkBuilder::from_device(device)
                    .map_err(|e| e.to_string())?
                    .open_stream()
                    .map_err(|e| e.to_string())?
            }
            None => rodio::DeviceSinkBuilder::open_default_sink().map_err(|e| e.to_string())?,
        };
        let new_sink = rodio::Player::connect_new(new_stream.mixer());

        // 迁移前记录当前曲目 / 进度 / 播放态
        let (track, pos_ms, was_playing) = {
            let st = self.state.read().unwrap();
            let pos = self.sink.get_pos().as_millis() as u64;
            (
                st.track.clone(),
                pos,
                st.status == PlaybackStatus::Playing,
            )
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
        self.current_shared = None;
        self.tick_anchor = None;

        {
            let mut st = self.state.write().unwrap();
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
            log::info!("[device] 输出设备切换到「{}」（无播放中的曲目）", self.current_device);
        }
        Ok(())
    }

    /// 播放状态（index/position/quality/mode/volume/muted）写 settings。
    fn persist_state(&self) {
        let Some(db) = &self.db else { return };
        let st = self.state.read().unwrap().clone();
        let index = self.queue.lock().unwrap().index.unwrap_or(0);
        let s = PlayState {
            index,
            position_ms: st.position_ms,
            quality: quality_key(self.default_quality),
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
        let tracks: Vec<Track> = self.queue.lock().unwrap().tracks.clone();
        if let Err(e) = db.with(|c| store::save_queue(c, &tracks)) {
            log::warn!("[db] 队列入库失败: {e}");
            return;
        }
        self.persist_state();
    }
}

/// settings 中的 quality 键值：128 / 320 / flac
fn quality_key(q: Quality) -> String {
    serde_json::to_string(&q).unwrap().trim_matches('"').into()
}

/// `quality_key` 的反操作：settings 里的字符串 → Quality，认不出来返回 None。
/// 与 commands.rs 里恢复播放现场用的是同一套 serde 表示。
fn parse_quality(s: &str) -> Option<Quality> {
    serde_json::from_value::<Quality>(serde_json::json!(s)).ok()
}

/// settings 中的 play_mode 键值：sequence / listLoop / oneLoop / random
fn mode_key(m: PlayMode) -> String {
    serde_json::to_string(&m).unwrap().trim_matches('"').into()
}

/// 音频线程初始化依赖（OutputStream 仍在线程内创建）
struct EngineDeps {
    app: tauri::AppHandle,
    rx: mpsc::Receiver<AudioCmd>,
    state: Arc<RwLock<PlaybackStateSnapshot>>,
    cache_dir: PathBuf,
    registry: Arc<ProviderRegistry>,
    url_cache: Arc<PlayUrlCache>,
    tx: Sender<AudioCmd>,
    queue: Arc<Mutex<Queue>>,
    db: Option<Arc<Database>>,
}

fn run_engine(deps: EngineDeps) {
    let EngineDeps {
        app,
        rx,
        state,
        cache_dir,
        registry,
        url_cache,
        tx,
        queue,
        db,
    } = deps;
    // MixerDeviceSink / Player 只能在音频线程创建和持有（非 Send）
    let _stream = match rodio::DeviceSinkBuilder::open_default_sink() {
        Ok(s) => s,
        Err(e) => {
            log::error!("音频输出设备初始化失败: {e}");
            {
                let mut st = state.write().unwrap();
                st.status = PlaybackStatus::Error;
                st.error = Some(format!("音频输出设备初始化失败: {e}"));
            }
            let _ = app.emit("playback-state-changed", state.read().unwrap().clone());
            return;
        }
    };
    let sink = rodio::Player::connect_new(_stream.mixer());
    sink.pause();

    let http = reqwest::blocking::Client::builder()
        .user_agent("Mozilla/5.0")
        // 假死防护由 range_reader 的 per-request 15s 总超时承担（超时→重试→重连）
        // 这里禁用 client 级整体超时（流式读取不能整体超时）
        .build()
        .expect("blocking http client init");

    let inner = EngineInner {
        app,
        tx,
        state,
        queue,
        cache_dir,
        http,
        registry,
        url_cache,
        sink,
        _stream,
        // None = 跟随系统默认；启动时从 settings 恢复用户上次的选择
        output_choice: None,
        // 真正的默认值在下面从 settings 读；这里与 PlaybackStateSnapshot 的默认值对齐
        default_quality: Quality::High,
        track_quality: None,
        current_device: String::new(),
        current_shared: None,
        volume_before_mute: 0.8,
        tick_anchor: None,
        last_persist: None,
        epoch: std::time::Instant::now(),
        db,
    };

    let mut inner = inner;
    // 恢复用户上次选择的输出设备（存 settings：audio.outputDevice，空 = 跟随默认）
    if let Some(db) = &inner.db {
        if let Ok(saved) = db.with(|c| store::get_setting(c, "audio.outputDevice")) {
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
                        let mut st = inner.state.write().unwrap();
                        st.output_device = inner.current_device.clone();
                    }
                }
            }
        }
    }
    // 恢复设置里的默认播放音质（settings["quality"]：128 / 320 / flac）
    if let Some(db) = &inner.db {
        if let Ok(saved) = db.with(|c| store::get_setting(c, "quality")) {
            if let Some(q) = saved.as_deref().and_then(parse_quality) {
                inner.default_quality = q;
                inner.mutate(|st| st.quality = q);
            }
        }
    }
    // 心跳用：上次补发全量快照的时刻（防前端漏收事件后状态停死）
    let mut last_publish = std::time::Instant::now();
    // 输出设备变化检测用（跟随默认模式下每 2s 对比一次设备名）
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

        match rx.recv_timeout(timeout) {
            Ok(cmd) => {
                if handle_cmd(&mut inner, cmd) {
                    return;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }

        // 输出设备变化检测（仅"跟随系统默认"模式）：默认设备变了
        // （插拔蓝牙耳机 / HDMI 等）就重建输出流并从原进度无缝续播 ——
        // 否则旧流被系统拆除后 sink 照常推进，声音却写进了死端点。
        if inner.output_choice.is_none()
            && last_device_check.elapsed() >= std::time::Duration::from_secs(2)
        {
            last_device_check = std::time::Instant::now();
            if let Some(dev) = cpal::default_host().default_output_device() {
                if let Ok(desc) = dev.description() {
                    let name = desc.name().to_string();
                    if name != inner.current_device && !name.is_empty() {
                        log::info!(
                            "[device] 默认输出设备变化：{} → {}，重建输出流",
                            inner.current_device,
                            name
                        );
                        if let Err(e) = inner.rebuild_output(None) {
                            log::warn!("[device] 重建输出流失败: {e}");
                        }
                    }
                }
            }
        }

        if playing {
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
                advance(&mut inner, true);
            } else if is_still_playing {
                emit_position_tick(&mut inner);
            }
            // 心跳：每 5s 补发一次全量快照。事件是"语义变化才推送"，
            // 前端一旦漏收（启动竞态 / WebView 重载），播放条会停在
            // 「未在播放」而音频其实在响 —— 定期补发自愈。
            if last_publish.elapsed() >= std::time::Duration::from_secs(5) {
                inner.publish();
                last_publish = std::time::Instant::now();
            }
        }
    }
}

fn handle_cmd(inner: &mut EngineInner, cmd: AudioCmd) -> bool {
    match cmd {
        AudioCmd::Load { track, source, start_at, autoplay } => {
            handle_load(inner, &track, &source, start_at, autoplay);
        }
        AudioCmd::Play => {
            inner.sink.play();
            inner.mutate(|st| {
                if st.status == PlaybackStatus::Paused {
                    st.status = PlaybackStatus::Playing;
                }
            });
        }
        AudioCmd::Pause => {
            inner.sink.pause();
            let pos = inner.sink.get_pos().as_millis() as u64;
            inner.mutate(|st| {
                if st.status == PlaybackStatus::Playing {
                    st.status = PlaybackStatus::Paused;
                    st.position_ms = pos;
                }
            });
            inner.persist_state();
        }
        AudioCmd::Stop => {
            inner.sink.clear();
            inner.current_shared = None;
            inner.mutate(|st| {
                st.status = PlaybackStatus::Stopped;
                st.position_ms = 0;
                st.duration_ms = 0;
                st.buffered_ms = 0;
                st.track_id = None;
                st.track = None;
            });
            inner.persist_state();
        }
        AudioCmd::Seek(pos) => {
            // rodio try_seek 对 MP3/FLAC 可用（DESIGN §3.3 边界）；失败报错不崩
            match inner.sink.try_seek(Duration::from_millis(pos)) {
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
            let muted = inner.state.read().unwrap().muted;
            inner.sink.set_volume(if muted { 0.0 } else { v });
            if !muted {
                inner.volume_before_mute = v;
            }
            inner.mutate(|st| st.volume = v);
            inner.persist_state();
        }
        AudioCmd::SetMuted(m) => {
            let v = inner.state.read().unwrap().volume;
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
            // 播放新列表 = 新一轮播放：上一首的临时音质作废，回到默认音质
            inner.track_quality = None;
            let mut q = inner.queue.lock().unwrap();
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
        AudioCmd::PlayAt(index) => {
            let track = {
                let mut q = inner.queue.lock().unwrap();
                if index >= q.len() {
                    None
                } else {
                    q.index = Some(index);
                    q.current().cloned()
                }
            };
            inner.sync_queue_to_snapshot();
            inner.queue_emit();
            if let Some(track) = track {
                play_queue_track(inner, track);
            }
            inner.persist_queue();
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
            {
                let mut q = inner.queue.lock().unwrap();
                q.tracks.clear();
                q.index = None;
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
                let mut q = inner.queue.lock().unwrap();
                q.set(tracks, index);
            }
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
            let track = inner.queue.lock().unwrap().current().cloned();
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
                if let Err(e) = db.with(|c| store::set_setting(c, "audio.outputDevice", &key_val))
                {
                    log::warn!("[db] 输出设备选择入库失败: {e}");
                }
            }
            inner.output_choice = name.clone();
            if let Err(e) = inner.rebuild_output(name.as_deref()) {
                log::warn!("[device] 切换输出设备失败: {e}");
                inner.mutate(|st| st.error = Some(format!("切换输出设备失败: {e}")));
            }
        }
        AudioCmd::SetDefaultQuality { quality } => {
            // 默认音质（设置页）：写 settings 以便重启保持，并对当前这首立即生效
            inner.default_quality = quality;
            if let Some(db) = &inner.db {
                if let Err(e) = db.with(|c| store::set_setting(c, "quality", &quality_key(quality)))
                {
                    log::warn!("[db] 默认音质入库失败: {e}");
                }
            }
            let current = inner.queue.lock().unwrap().current().cloned();
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
            let current = inner.queue.lock().unwrap().current().cloned();
            if let Some(track) = current {
                let (autoplay, pos) = playback_resume_point(inner);
                inner.track_quality = Some((track.id.clone(), quality));
                load_queue_track(inner, track, autoplay, pos);
            }
        }
        AudioCmd::Shutdown => return true,
    }
    false
}

/// 切音质 / 换输出设备这类「原地重取」用的续播参数：
/// 原来在播（或正在缓冲）就继续播，并从原进度续；暂停态则保持暂停。
fn playback_resume_point(inner: &EngineInner) -> (bool, u64) {
    let st = inner.state.read().unwrap();
    let autoplay = matches!(
        st.status,
        PlaybackStatus::Playing | PlaybackStatus::Loading | PlaybackStatus::Buffering
    );
    (autoplay, st.position_ms)
}

/// 播放队列中的指定曲目：置 Loading 后异步取址，成功回发 Load。
fn play_queue_track(inner: &mut EngineInner, track: Track) {
    load_queue_track(inner, track, true, 0);
}

/// 暂停态变体：恢复现场用（autoplay=false，start_ms>0 时加载后定位）。
fn load_queue_track(inner: &mut EngineInner, track: Track, autoplay: bool, start_ms: u64) {
    // 有效音质：这首歌被播放条单独指定过就用指定的，否则用设置里的默认
    let quality = match &inner.track_quality {
        Some((id, q)) if *id == track.id => *q,
        _ => inner.default_quality,
    };
    inner.mutate(|st| {
        st.quality = quality;
        st.status = PlaybackStatus::Loading;
        st.error = None;
        st.track_id = Some(track.id.clone());
        st.track = Some(track.clone());
        st.position_ms = start_ms;
        st.duration_ms = 0;
        st.buffered_ms = 0;
        st.is_local = false;
    });
    spawn_resolve_and_load(inner, track, autoplay, start_ms);
}

/// 按播放模式切到下一首。`auto` = 自然播完触发。
fn advance(inner: &mut EngineInner, auto: bool) {
    let mode = inner.state.read().unwrap().play_mode;
    let next = {
        let q = inner.queue.lock().unwrap();
        q.next_index(mode, auto)
    };
    log::info!("[queue] advance(auto={auto}, mode={mode:?}) -> {next:?}");
    match next {
        Some(i) => {
            let track = {
                let mut q = inner.queue.lock().unwrap();
                q.index = Some(i);
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
                // 顺序播放到末尾：停止并保留最后一曲信息
                inner.sink.clear();
                inner.current_shared = None;
                inner.mutate(|st| {
                    st.status = PlaybackStatus::Stopped;
                    st.position_ms = st.duration_ms;
                });
            }
            // 手动 next 无下一首（空队列）：保持现状
        }
    }
}

fn go_previous(inner: &mut EngineInner) {
    let mode = inner.state.read().unwrap().play_mode;
    let prev = {
        let mut q = inner.queue.lock().unwrap();
        q.previous_index(mode).map(|i| {
            q.index = Some(i);
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

/// 播放开始即计入播放历史与听歌统计（DESIGN §5.3）。
/// 写库失败只记 warn 日志 —— 历史与统计都是旁路数据，绝不能影响播放。
fn record_play_start(db: Option<Arc<Database>>, track: Track) {
    let Some(db) = db else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(move || {
            db.with(|conn| {
                crate::db::store::record_play_history(conn, &track)?;
                // 时长按曲目时长累计：起播即计一次，中途切歌不回写实际听完的秒数
                let played_ms = (track.duration * 1000.0).round() as i64;
                crate::db::store::record_play_stat(conn, &track, played_ms)
            })
        })
        .await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => log::warn!("[history] 写入失败: {e}"),
            Err(e) => log::warn!("[history] 任务异常: {e}"),
        }
    });
}

/// 异步取播放地址（内存缓存 10 分钟），成功后回发 Load 到音频线程。
/// 失败：作废缓存重取一次（§7.3），仍失败则置 Error 并广播 audio-error。
fn spawn_resolve_and_load(
    inner: &EngineInner,
    track: Track,
    autoplay: bool,
    start_ms: u64,
) {
    let app = inner.app.clone();
    let tx = inner.tx.clone();
    let registry = Arc::clone(&inner.registry);
    let cache = Arc::clone(&inner.url_cache);
    let quality = inner
        .state
        .read()
        .unwrap()
        .quality
        .into_provider();
    // 播放历史（§5.3）：取址成功后写入，db 不可用时静默跳过
    let history_db = inner.db.clone();

    tauri::async_runtime::spawn(async move {
        // 本地曲目：Track.id 即文件绝对路径，无需 Provider 取址（DESIGN §13）
        if track.platform == types::SourceId::Local {
            log::info!("[queue] local track path={}", track.id);
            let _ = tx.send(AudioCmd::Load {
                track: Box::new(track.clone()),
                source: Box::new(PlaySource::Local { path: track.id.clone() }),
                start_at: if start_ms > 0 { Some(start_ms) } else { None },
                autoplay,
            });
            record_play_start(history_db, track);
            return;
        }
        let resolved = resolve_with_retry(&registry, &cache, &track, quality).await;
        match resolved {
            Ok((url, fetched_at)) => {
                log::info!(
                    "[queue] resolve ok track={} url_host={}",
                    track.id,
                    url.split("//").nth(1).unwrap_or("").split('/').next().unwrap_or("")
                );
                let _ = tx.send(AudioCmd::Load {
                    track: Box::new(track.clone()),
                    source: Box::new(PlaySource::Online { url, fetchedAt: fetched_at }),
                    start_at: Some(start_ms),
                    autoplay,
                });
                record_play_start(history_db, track);
            }
            Err(e) => {
                log::error!("自动取址失败: {e}");
                let _ = app.emit(
                    "audio-error",
                    serde_json::json!({
                        "trackId": track.id,
                        "kind": "resolve",
                        "message": format!("该歌曲暂时无法播放（{e}）"),
                    }),
                );
            }
        }
    });
}

async fn resolve_with_retry(
    registry: &ProviderRegistry,
    cache: &PlayUrlCache,
    track: &Track,
    quality: types::Quality,
) -> Result<(String, u64), types::ProviderError> {
    match crate::resolve_play_url_with(registry, cache, track, quality).await {
        Ok(pair) => Ok(pair),
        Err(types::ProviderError::NoPlayableUrl) | Err(types::ProviderError::Empty) => {
            let key = PlayUrlCache::cache_key(
                &track.platform.to_string(),
                &track.id,
                crate::quality_str(quality),
            );
            cache.invalidate(&key);
            crate::resolve_play_url_with(registry, cache, track, quality).await
        }
        Err(e) => Err(e),
    }
}

fn handle_load(
    inner: &mut EngineInner,
    track: &Track,
    source: &PlaySource,
    start_at: Option<u64>,
    autoplay: bool,
) {
    inner.mutate(|st| {
        st.status = PlaybackStatus::Loading;
        st.error = None;
        st.track_id = Some(track.id.clone());
        st.track = Some(track.clone());
        st.buffered_ms = 0;
        st.position_ms = start_at.unwrap_or(0);
        st.is_local = matches!(source, PlaySource::Local { .. });
        st.url_fetched_at = match &source {
            PlaySource::Online { fetchedAt, .. } => Some(*fetchedAt),
            PlaySource::Local { .. } => None,
        };
    });

    match build_decoder(source, &inner.http, &inner.cache_dir, track) {
        Ok((decoder, shared, duration_ms)) => {
            inner.sink.clear();
            inner.sink.append(decoder);
            inner.sink.set_volume(inner.effective_volume());
            // 恢复现场：加载后先定位到上次进度（暂停态下 try_seek 同样有效）
            if let Some(start) = start_at.filter(|s| *s > 0) {
                if let Err(e) = inner.sink.try_seek(Duration::from_millis(start)) {
                    log::warn!("[queue] 恢复定位到 {start}ms 失败: {e:?}，从头播放");
                }
            }
            if autoplay {
                inner.sink.play();
            } else {
                inner.sink.pause();
            }
            inner.current_shared = shared;

            inner.mutate(|st| {
                st.status = if autoplay {
                    PlaybackStatus::Playing
                } else {
                    PlaybackStatus::Paused
                };
                st.duration_ms = duration_ms;
                st.position_ms = start_at.unwrap_or(0);
            });
            inner.tick_anchor = None;
            emit_position_tick(inner);
            inner.persist_state();
        }
        Err(e) => {
            log::error!("load 失败: {e}");
            inner.current_shared = None;
            inner.mutate(|st| {
                st.status = PlaybackStatus::Error;
                st.error = Some(format!("该歌曲暂时无法播放（{e}）"));
            });
            let _ = inner.app.emit(
                "audio-error",
                serde_json::json!({
                    "trackId": track.id,
                    "kind": "load",
                    "message": format!("该歌曲暂时无法播放（{e}）"),
                }),
            );
        }
    }
}

/// 构建 Decoder：在线走 HttpRangeReader（磁盘缓冲 + Range 下载线程），
/// 本地直接 File::open。返回 (boxed source, range_shared, duration_ms)。
/// 注意：Decoder::new 探针首包可能阻塞至多 FIRST_PACKET_TIMEOUT(8s)。
#[allow(clippy::type_complexity)]
fn build_decoder(
    source: &PlaySource,
    http: &reqwest::blocking::Client,
    cache_dir: &Path,
    track: &Track,
) -> Result<(Box<dyn Source + Send>, Option<Arc<RangeShared>>, u64), String> {
    match source {
        PlaySource::Local { path } => {
            let file =
                std::fs::File::open(path).map_err(|e| format!("打开本地文件失败: {e}"))?;
            // TryFrom<File> 会用文件长度自动填 byte_len，FLAC 的二分定位才可用
            let decoder = Decoder::try_from(file).map_err(|e| format!("解码失败: {e}"))?;
            let duration = decoder
                .total_duration()
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0)
                .max((track.duration * 1000.0) as u64);
            Ok((Box::new(decoder), None, duration))
        }
        PlaySource::Online { url, .. } => {
            let (reader, shared) =
                range_reader::open(url, http, cache_dir).map_err(|e| e.to_string())?;
            // 总字节数（Content-Length）是 symphonia FLAC 二分定位的必要输入：
            // 缺了它 demuxer 会直接判 Unseekable。注意 with_byte_len 同时置 seekable=true；
            // 服务端没给长度时保持默认不可 seek（前向仍可线性扫描，回退才会失败）。
            let builder = Decoder::builder().with_data(BufReader::new(reader));
            let builder = match shared.total_len() {
                Some(len) => builder.with_byte_len(len),
                None => builder,
            };
            let decoder = builder.build().map_err(|e| format!("解码失败: {e}"))?;
            let duration = decoder
                .total_duration()
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0)
                .max((track.duration * 1000.0) as u64);
            Ok((Box::new(decoder), Some(shared), duration))
        }
    }
}

/// 250ms 节流 tick：position-changed { positionMs, durationMs, bufferedMs, monotonicMs }（§7.11）
fn emit_position_tick(inner: &mut EngineInner) {
    let now = std::time::Instant::now();
    if let Some(t) = inner.tick_anchor {
        if now.duration_since(t) < Duration::from_millis(250) {
            return;
        }
    }

    // rodio 的真实播放位置（暂停时冻结），避免自增累计漂移
    let pos_ms = inner.sink.get_pos().as_millis() as u64;
    let buffered_ms = inner
        .current_shared
        .as_ref()
        .map(|s| {
            // 已就绪字节 / 总字节 × 时长；总长未知时按 128kbps 粗估（缓冲条展示用途）
            let ready = s.ready_bytes();
            match s.total_len() {
                Some(total) if total > 0 => {
                    let dur = inner.state.read().unwrap().duration_ms;
                    ((ready as f64 / total as f64) * dur as f64) as u64
                }
                _ => (ready / 128_000) * 1000,
            }
        })
        .unwrap_or(0);

    let duration_ms = inner.state.read().unwrap().duration_ms;
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
