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

use std::collections::HashSet;
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
use crate::provider::url_cache::PlayUrlCache;
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
    /// 解码器已构建完成，可以挂载播放。构建（HTTP open + 首包探测）在
    /// blocking 线程池完成 —— 引擎线程全程不做网络 IO。
    LoadReady {
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
        /// 加载代次：与引擎当前代次不一致说明等待期间用户又切了歌，结果丢弃
        gen: u64,
    },
    Play,
    Pause,
    Stop,
    Seek(u64),
    SetVolume(f32),
    SetMuted(bool),
    /// 整表替换队列并从 index 开始播放
    SetQueue { tracks: Vec<Track>, index: usize },
    /// 下一首播放：插到当前曲目之后（不打断当前播放）
    AddNext(Box<Track>),
    /// 加入队尾（不打断当前播放）
    Append(Vec<Track>),
    /// 移除队列中某一项（不打断当前播放）
    RemoveAt(usize),
    /// 拖动排序：把 from 位置的曲目移到 to
    MoveItem { from: usize, to: usize },
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
    /// 切换音频输出设备。`None` = 跟随系统默认（设备插拔自动切换）；
    /// `Some(设备名)` = 固定到该设备。切换时当前曲目从原进度无缝续播。
    SetOutputDevice { name: Option<String> },
    /// 改「默认播放音质」（设置页入口）：写进 settings，重启后保持；
    /// 当前曲目没被单独指定音质时，立即按新音质重新取址续播。
    SetDefaultQuality { quality: Quality },
    /// 只改当前这首的音质（播放条入口）：不写 settings，切到别的歌自动回到默认。
    SetTrackQuality { quality: Quality },
    /// 取址 / 打开流失败的回执：统一置错误态，并决定是否自动跳过（§7.3 恢复策略）。
    LoadFailed {
        track_id: String,
        message: String,
        /// 触发时是否处于「应当继续播放」的语义（自动切歌 / 在播时换曲）
        autoplay: bool,
        /// 加载代次：过期的失败回执直接丢弃（用户早已切到别的歌）
        gen: u64,
    },
    /// 装配 / 卸载系统媒体控制（SMTC）。启动时由 lib.rs 注入。
    SetSmtc(Option<crate::smtc::SmtcHandle>),
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
    /// 启动专属音频线程。url_cache 供自动切歌时异步取址；
    /// db 供队列/播放状态持久化（None = 数据库不可用，播放不受影响）。
    pub fn spawn(
        app: tauri::AppHandle,
        cache_dir: PathBuf,
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

    /// 注入系统媒体控制句柄（Windows SMTC；不可用时传 None）。
    pub fn set_smtc(&self, handle: Option<crate::smtc::SmtcHandle>) {
        self.send(AudioCmd::SetSmtc(handle));
    }
}

struct EngineInner {
    app: tauri::AppHandle,
    tx: Sender<AudioCmd>,
    state: Arc<RwLock<PlaybackStateSnapshot>>,
    queue: Arc<Mutex<Queue>>,
    cache_dir: PathBuf,
    http: reqwest::blocking::Client,
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
    /// 本轮队列里已经播放失败过的曲目（自动跳过用；换队列时清空）。
    /// 有它才能保证「队列全挂」时不会无限互相跳过。
    failed_tracks: HashSet<String>,
    /// 系统媒体控制（SMTC）句柄；None = 不可用（非 Windows / 初始化失败）
    smtc: Option<crate::smtc::SmtcHandle>,
    /// 加载代次：每次发起新的「取址+构建解码器」链就 +1。LoadReady /
    /// LoadFailed 回执带的代次与当前不一致 → 等待期间用户又切了歌，丢弃。
    /// 没有它，连点切歌后旧歌的加载结果会把新歌顶掉。
    load_gen: u64,
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
        // 顺带把当前曲目 / 播放状态投到系统媒体面板（Windows SMTC）
        crate::smtc::sync(&self.smtc, &snap);
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
        // 禁用连接池：休眠唤醒后池里的 keep-alive 连接是半死的（进程冻结期间
        // pool_idle_timeout 计时器不走，醒来后池仍认为连接"新鲜"），新请求复用
        // 它们就挂满超时才报错。pool_max_idle_per_host(0) 让每个请求建新连接，
        // 醒来后要么立刻连成功、要么 connect_timeout 快速失败 —— 不再复用死连接。
        // 假死防护另由 range_reader 的 per-request 8s 总超时兜底（超时→重试→重连）。
        .pool_max_idle_per_host(0)
        .connect_timeout(Duration::from_secs(8))
        .build()
        .expect("blocking http client init");

    let inner = EngineInner {
        app,
        tx,
        state,
        queue,
        cache_dir,
        http,
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
        failed_tracks: HashSet::new(),
        smtc: None,
        load_gen: 0,
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
        AudioCmd::LoadReady {
            track,
            decoder,
            shared,
            duration_ms,
            start_at,
            autoplay,
            is_local,
            url_fetched_at,
            play_url,
            gen,
        } => {
            // 过期结果丢弃：等待取址/构建期间用户又切了歌，这条是旧歌的
            if gen != inner.load_gen {
                log::info!(
                    "[queue] 丢弃过期的加载结果 track={} (gen={gen} != {})",
                    track.id,
                    inner.load_gen
                );
            } else {
                mount_decoder(
                    inner,
                    &track,
                    decoder,
                    shared,
                    duration_ms,
                    start_at,
                    autoplay,
                    is_local,
                    url_fetched_at,
                    play_url,
                );
            }
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
            // 播放新列表 = 新一轮播放：上一首的临时音质作废，回到默认音质；
            // 失败跳过记录也清空，新的队列重新给每首歌机会
            inner.track_quality = None;
            inner.failed_tracks.clear();
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
        AudioCmd::Next => advance(inner, false),        AudioCmd::Previous => go_previous(inner),
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
        AudioCmd::AddNext(track) => {
            inner.queue.lock().unwrap().insert_next(*track);
            inner.sync_queue_to_snapshot();
            inner.queue_emit();
            inner.persist_queue();
        }
        AudioCmd::Append(tracks) => {
            if !tracks.is_empty() {
                inner.queue.lock().unwrap().append(tracks);
                inner.sync_queue_to_snapshot();
                inner.queue_emit();
                inner.persist_queue();
            }
        }
        AudioCmd::RemoveAt(index) => {
            let removed = inner.queue.lock().unwrap().remove_at(index).is_some();
            if removed {
                inner.sync_queue_to_snapshot();
                inner.queue_emit();
                inner.persist_queue();
            }
        }
        AudioCmd::MoveItem { from, to } => {
            let moved = inner.queue.lock().unwrap().move_item(from, to);
            if moved {
                inner.sync_queue_to_snapshot();
                inner.queue_emit();
                inner.persist_queue();
            }
        }
        AudioCmd::ClearAfter => {
            let removed = inner.queue.lock().unwrap().clear_after_current();
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
                let mut q = inner.queue.lock().unwrap();
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
        AudioCmd::LoadFailed {
            track_id,
            message,
            autoplay,
            gen,
        } => {
            if gen != inner.load_gen {
                // 过期的失败回执：用户已切到别的歌，不能把当前状态置错
                log::info!("[queue] 丢弃过期的失败回执 track={track_id}");
            } else {
                log::error!("[queue] 曲目 {track_id} 播放失败: {message}");
                inner.mutate(|st| {
                    st.status = PlaybackStatus::Error;
                    st.error = Some(message);
                });
                // 事件已由取址方（含原消息）发出，这里只负责状态与跳过决策
                skip_if_recoverable(inner, &track_id, autoplay);
            }
        }
        AudioCmd::SetSmtc(handle) => {
            inner.smtc = handle;
            // 立即把当前状态推给系统面板，避免注入前已播的曲目信息缺失
            inner.publish();
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

/// 播放队列中的指定曲目：置 Loading 后异步取址+构建，成功回发 LoadReady。
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
    // 每次新加载推进代次：在途的旧加载结果回来时据此丢弃
    inner.load_gen += 1;
    let gen = inner.load_gen;
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
    spawn_resolve_and_load(inner, track, autoplay, start_ms, gen);
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
        let q = inner.queue.lock().unwrap();
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
        return;
    };
    log::info!("[queue] 曲目 {track_id} 失败，跳过到队列第 {} 首", i + 1);

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

fn go_previous(inner: &mut EngineInner) {    let mode = inner.state.read().unwrap().play_mode;
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
    inner: &EngineInner,
    track: Track,
    autoplay: bool,
    start_ms: u64,
    gen: u64,
) {
    let job = LoadJob {
        app: inner.app.clone(),
        tx: inner.tx.clone(),
        cache: Arc::clone(&inner.url_cache),
        http: inner.http.clone(),
        cache_dir: inner.cache_dir.clone(),
        history_db: inner.db.clone(),
        quality: inner.state.read().unwrap().quality.into_provider(),
        track,
        autoplay,
        start_ms,
        gen,
    };
    tauri::async_runtime::spawn(job.run());
}

/// 一次「取址 → 构建解码器 → 回发引擎」的全部上下文。
struct LoadJob {
    app: tauri::AppHandle,
    tx: Sender<AudioCmd>,
    cache: Arc<PlayUrlCache>,
    http: reqwest::blocking::Client,
    cache_dir: PathBuf,
    history_db: Option<Arc<Database>>,
    quality: types::Quality,
    track: Track,
    autoplay: bool,
    start_ms: u64,
    gen: u64,
}

impl LoadJob {
    async fn run(self) {
        // 本地曲目：Track.id 即文件绝对路径，无需 Provider 取址（DESIGN §13）
        if self.track.platform == types::SourceId::Local {
            log::info!("[queue] local track path={}", self.track.id);
            let path = self.track.id.clone();
            self.build_and_dispatch(PlaySource::Local { path }, true, None).await;
            return;
        }

        // 离线优先：这首歌若已下载完成且文件还在，直接当本地文件播放。
        // 断网、播放地址失效都不影响，下载功能才算真正闭环（§5.3 下载 2.0）。
        if let Some(db) = self.history_db.clone() {
            let db_id = crate::db::store::db_track_id(&self.track);
            let found = tauri::async_runtime::spawn_blocking(move || {
                db.with(|c| crate::db::store::downloaded_file_for(c, &db_id))
            })
            .await;
            if let Ok(Ok(Some(path))) = found {
                if std::path::Path::new(&path).exists() {
                    log::info!("[queue] 命中已下载文件，离线播放: {path}");
                    self.build_and_dispatch(PlaySource::Local { path }, true, None).await;
                    return;
                }
                log::warn!("[queue] 已下载文件已不存在，回落在线取址: {path}");
            }
        }

        // 取链（脚本线路）：缓存命中直接用（前端切歌时预解析回填）；未命中经
        // playurl_bridge 问前端脚本包，前端按「换源顺序」跨源解析后回填缓存。
        // 原生 Rust Provider 已删除，前端脚本线路是唯一的第三方取链路径。
        let resolved =
            crate::resolve_play_url_script(&self.app, &self.cache, &self.track, self.quality)
                .await;
        match resolved {
            Ok((url, fetched_at)) => {
                log::info!(
                    "[queue] resolve ok track={} url_host={}",
                    self.track.id,
                    url.split("//").nth(1).unwrap_or("").split('/').next().unwrap_or("")
                );
                let play_url = url.clone();
                let source = PlaySource::Online { url, fetchedAt: fetched_at };
                match self.try_build(&source).await {
                    Ok(built) => self.dispatch_ready(built, false, Some(fetched_at), Some(play_url)),
                    Err(first_err) => {
                        // 打开流失败最常见两种：休眠唤醒后的半死连接、缓存的
                        // 签名 URL 已过期 —— 作废缓存重取一次再打开，仍失败才算真失败
                        log::warn!("[queue] 打开音频流失败（{first_err}），作废缓存 URL 重取一次");
                        let key = PlayUrlCache::cache_key(
                            &self.track.platform.to_string(),
                            &self.track.id,
                            crate::quality_str(self.quality),
                        );
                        self.cache.invalidate(&key);
                        match crate::resolve_play_url_script(
                            &self.app,
                            &self.cache,
                            &self.track,
                            self.quality,
                        )
                        .await
                        {
                            Ok((url2, fetched_at2)) => {
                                let source2 = PlaySource::Online { url: url2.clone(), fetchedAt: fetched_at2 };
                                match self.try_build(&source2).await {
                                    Ok(built2) => self.dispatch_ready(built2, false, Some(fetched_at2), Some(url2)),
                                    Err(e2) => self.dispatch_load_failed(
                                        "load",
                                        &format!("打开音频流失败: {first_err}；重取后仍失败: {e2}"),
                                    ),
                                }
                            }
                            Err(e2) => self.dispatch_load_failed(
                                "load",
                                &format!("打开音频流失败: {first_err}；重取播放地址失败: {e2}"),
                            ),
                        }
                    }
                }
            }
            Err(e) => {
                log::error!("自动取址失败: {e}");
                self.dispatch_load_failed("resolve", &format!("{e}"));
            }
        }
    }

    /// 在 blocking 线程池里构建解码器（HTTP open + 首包探测都是阻塞 IO）。
    async fn try_build(&self, source: &PlaySource) -> Result<BuiltDecoder, String> {
        let http = self.http.clone();
        let cache_dir = self.cache_dir.clone();
        let track = self.track.clone();
        let source = source.clone();
        tauri::async_runtime::spawn_blocking(move || {
            build_decoder(&source, &http, &cache_dir, &track)
        })
        .await
        .map_err(|e| format!("构建任务异常: {e}"))?
    }

    /// 构建并回发（本地/离线文件路径，不重试）。
    async fn build_and_dispatch(
        self,
        source: PlaySource,
        is_local: bool,
        fetched_at: Option<u64>,
    ) {
        match self.try_build(&source).await {
            Ok(built) => self.dispatch_ready(built, is_local, fetched_at, None),
            Err(e) => self.dispatch_load_failed("load", &e),
        }
    }

    /// 回发构建好的解码器。gen 与引擎当前代次不一致时引擎侧丢弃。
    fn dispatch_ready(
        self,
        built: BuiltDecoder,
        is_local: bool,
        fetched_at: Option<u64>,
        play_url: Option<String>,
    ) {
        let (decoder, shared, duration_ms) = built;
        let _ = self.tx.send(AudioCmd::LoadReady {
            track: Box::new(self.track.clone()),
            decoder,
            shared,
            duration_ms,
            start_at: if self.start_ms > 0 { Some(self.start_ms) } else { None },
            autoplay: self.autoplay,
            is_local,
            url_fetched_at: fetched_at,
            play_url,
            gen: self.gen,
        });
        record_play_start(self.history_db.clone(), self.track.clone());
    }

    /// 回发失败：广播 audio-error + LoadFailed，由引擎统一置错误态并决定跳过。
    fn dispatch_load_failed(self, kind: &'static str, detail: &str) {
        let message = format!("该歌曲暂时无法播放（{detail}）");
        let _ = self.app.emit(
            "audio-error",
            serde_json::json!({
                "trackId": self.track.id,
                "kind": kind,
                "message": message,
            }),
        );
        let _ = self.tx.send(AudioCmd::LoadFailed {
            track_id: self.track.id.clone(),
            message,
            autoplay: self.autoplay,
            gen: self.gen,
        });
    }
}

/// 挂载已构建好的解码器（LoadReady 到达时调用）。
/// 网络 IO（打开流 + 首包探测）已在 blocking 线程池完成，这里只剩纯内存
/// 操作 —— 引擎线程绝不能阻塞，否则休眠唤醒后的死连接会卡死整个控制面。
#[allow(clippy::too_many_arguments)]
fn mount_decoder(
    inner: &mut EngineInner,
    track: &Track,
    decoder: Box<dyn Source + Send>,
    shared: Option<Arc<RangeShared>>,
    duration_ms: u64,
    start_at: Option<u64>,
    autoplay: bool,
    is_local: bool,
    url_fetched_at: Option<u64>,
    play_url: Option<String>,
) {
    inner.failed_tracks.remove(&track.id);
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
        st.track_id = Some(track.id.clone());
        st.track = Some(track.clone());
        st.duration_ms = duration_ms;
        st.position_ms = start_at.unwrap_or(0);
        st.error = None;
        st.is_local = is_local;
        st.url_fetched_at = url_fetched_at;
        st.play_url = play_url;
    });
    inner.tick_anchor = None;
    emit_position_tick(inner);
    inner.persist_state();
}

/// 构建好的解码器三元组：(boxed source, range 共享态, 时长 ms)。
type BuiltDecoder = (Box<dyn Source + Send>, Option<Arc<RangeShared>>, u64);

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
    meta_duration_ms(track)
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
        PlaySource::Local { path } => {
            let file =
                std::fs::File::open(path).map_err(|e| format!("打开本地文件失败: {e}"))?;
            // TryFrom<File> 会用文件长度自动填 byte_len，FLAC 的二分定位才可用
            let decoder = Decoder::try_from(file).map_err(|e| format!("解码失败: {e}"))?;
            let duration = resolve_duration_ms(&decoder, track);
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
            let duration = resolve_duration_ms(&decoder, track);
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

#[cfg(test)]
mod duration_tests {
    use super::meta_duration_ms;
    use crate::provider::types::{SourceId, Track};

    fn track_with_duration(seconds: f64) -> Track {
        Track {
            id: "1".into(),
            platform: SourceId::Kg,
            title: "测试".into(),
            singer: "".into(),
            album: "".into(),
            pic_url: String::new(),
            duration: seconds,
            music_id: None,
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
