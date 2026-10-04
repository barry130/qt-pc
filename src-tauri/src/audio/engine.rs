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
use super::queue::Queue;
use super::range_reader::{self, RangeShared};
use super::state::{PlayMode, PlaybackStateSnapshot, PlaybackStatus, Quality};

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
    SetQueue {
        tracks: Vec<Track>,
        index: usize,
    },
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
    /// 切换音频输出设备。`None` = 跟随系统默认（设备插拔自动切换）；
    /// `Some(设备名)` = 固定到该设备。切换时当前曲目从原进度无缝续播。
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
    /// 改播放倍速（0.5 ~ 2.0）。rodio Player 的速度控制链全权处理，
    /// 进度 / seek 的内容时间域由引擎在读写两侧换算（见 content_pos_ms / sink_seek_content）。
    SetSpeed(f32),
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
    /// 淡入淡出参数（设置页「音效」）。
    SetFade(FadeParams),
    /// 播放条频谱背景开关：开 = DspSource 采样做 FFT 推 `spectrum` 事件。
    SetSpectrum(bool),
    /// 播放缓存体积上限（MB，0 = 不限）。引擎落 settings 并立即后台修剪一遍。
    SetCacheLimit(u64),
    /// 取址 / 打开流失败的回执：统一置错误态，并决定是否自动跳过（§7.3 恢复策略）。
    LoadFailed {
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
    Shutdown,
}

/// 引擎句柄：clone 后供多个 Tauri 命令使用。
#[derive(Clone)]
pub struct AudioEngine {
    tx: Sender<AudioCmd>,
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
        let fx = Arc::new(AudioFx::new());
        let cache_file = Arc::new(Mutex::new(None));
        // 注册音频线程 panic 上报通道（先于线程启动；重复启动时以第一次为准）
        let _ = AUDIO_THREAD_PANIC_TX.set(tx.clone());

        let tx_thread = tx.clone();
        let queue_thread = Arc::clone(&queue);
        let fx_thread = Arc::clone(&fx);
        let cache_file_thread = Arc::clone(&cache_file);
        let _ = std::thread::Builder::new()
            .name("audio-engine".into())
            .spawn(move || {
                // 引擎是裸循环线程，任一命令处理里 panic 会把整条线程带走，
                // 表现为「播放静默死掉、命令发不进去」。catch_unwind 兜底：
                // panic 细节由 panic 钩子落日志（file_logger），线程退出但进程
                // 还活着，send() 侧能感知并报错，前端不至于无提示闪退。
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                    run_engine(EngineDeps {
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

        Self {
            tx,
            state,
            queue,
            fx,
            cache_file,
        }
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

    /// 当前音效设置快照（cmd_get_fx_state；设置页回读）。
    pub fn fx_state(&self) -> FxState {
        self.fx.state()
    }

    /// 正在播放的流对应的磁盘缓存文件（没有在线流 = None）。
    pub fn current_cache_file(&self) -> Option<PathBuf> {
        self.cache_file.lock().unwrap().clone()
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
}

impl EngineInner {
    fn publish(&self) {
        let snap = self.state.read().unwrap().clone();
        let _ = self.app.emit("playback-state-changed", &snap);
        // 顺带把当前曲目 / 播放状态投到系统媒体面板（Windows SMTC）
        crate::smtc::sync(&self.smtc, &snap);
        // 任务栏缩略图工具栏的播放/暂停按钮图标跟着翻转
        crate::taskbar::sync(snap.status == PlaybackStatus::Playing);
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
        // 锁内只取数据，emit（含整队列序列化）放在锁外：大队列时 json 序列化
        // 可能毫秒级，别拉长临界区（引擎线程与命令线程都会调本函数）
        let (tracks, index) = {
            let q = self.queue.lock().unwrap();
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
        let new_sink = rodio::Player::connect_new(new_stream.mixer());

        // 迁移前记录当前曲目 / 进度 / 播放态
        let (track, pos_ms, was_playing) = {
            let st = self.state.read().unwrap();
            let pos = self.sink.get_pos().as_millis() as u64;
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
        // 新 Player 的速度控制是全新的（controls 随实例创建），倍速必须重挂
        self.sink.set_speed(self.speed);
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
        let st = self.state.read().unwrap().clone();
        let index = self.queue.lock().unwrap().index.unwrap_or(0);
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
        let tracks: Vec<Track> = self.queue.lock().unwrap().tracks.clone();
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

/// settings 中的 play_mode 键值：sequence / listLoop / oneLoop / random
fn mode_key(m: PlayMode) -> String {
    serde_json::to_string(&m).unwrap().trim_matches('"').into()
}

// ---------- 倍速 / 音效的 settings 键（读写都只在引擎线程） ----------

const SETTING_SPEED: &str = "playback.speed";
const SETTING_FX_EQ: &str = "fx.eq";
const SETTING_FX_LOUDNORM: &str = "fx.loudnorm";
const SETTING_FX_FADE: &str = "fx.fade";
const SETTING_FX_SPECTRUM: &str = "fx.spectrum";

/// 倍速允许范围（与前端倍速菜单一致：0.75~2.0，夹紧留点余量）。
const SPEED_MIN: f32 = 0.5;
const SPEED_MAX: f32 = 2.0;

/// 引擎启动时刻以来的单调毫秒（DspSource 的淡入淡出基准与它同源）。
fn epoch_ms(inner: &EngineInner) -> u64 {
    inner.epoch.elapsed().as_millis() as u64
}

/// 当前播放位置，换算回**内容时间域**（歌曲本体的进度，与倍速无关）。
///
/// rodio 的 `get_pos()` 在 Player 的速度控制链下走「真实时间」口径
/// （TrackPosition 包在 Speed 外层，除以 rate×factor）：倍速 f 下
/// 内容位置 = get_pos × f。f=1 时恒等，存量语义不变。
fn content_pos_ms(inner: &EngineInner) -> u64 {
    inner.sink.get_pos().mul_f32(inner.speed).as_millis() as u64
}

/// 按内容时间域 seek：rodio 的 try_seek 会被外层 Speed 再乘一次倍速，
/// 这里先除回去，保证「seek 到歌曲第 N 秒」的语义与倍速无关。
fn sink_seek_content(inner: &EngineInner, pos_ms: u64) -> Result<(), rodio::source::SeekError> {
    inner
        .sink
        .try_seek(Duration::from_millis(pos_ms).div_f32(inner.speed))
}

/// 真正执行暂停（淡出到期 / 无淡出的 Pause 共用）。
fn finish_pause(inner: &mut EngineInner) {
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
    if inner.state.read().unwrap().status == PlaybackStatus::Playing {
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
    app: tauri::AppHandle,
    rx: mpsc::Receiver<AudioCmd>,
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
        default_quality: Quality::default(),
        track_quality: None,
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
    // 启动先修剪一遍缓存（超限时清最旧；后台线程做，不挡引擎起播）
    spawn_cache_prune(&inner);
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

        // 淡出暂停到期：Pause 命令只发起淡出（增益拉到 0），状态仍是 Playing，
        // 到点这里才真正 pause。期间用户 Play/Seek/换曲都会撤销 deadline。
        if let Some(deadline) = inner.pause_deadline {
            if std::time::Instant::now() >= deadline {
                inner.pause_deadline = None;
                inner.fx.clear_fade();
                finish_pause(&mut inner);
            }
        }
        // 睡眠定时到期：暂停播放并清空定时状态（播完当前歌停止的模式
        // 走 advance(auto) 里的分支，不经过这里）
        if let Some(deadline) = inner.sleep_deadline {
            if std::time::Instant::now() >= deadline {
                inner.sleep_deadline = None;
                fire_sleep_timer(&mut inner);
            }
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
                // 位置冻结看门狗：回调线程死了 / 解码卡住时 `sink.empty()` 也是
                // false，只有「位置不再推进」这一个信号能识破（见 watch_pipeline）
                watch_pipeline(&mut inner);
            }
            // 心跳：每 5s 补发一次全量快照。事件是"语义变化才推送"，
            // 前端一旦漏收（启动竞态 / WebView 重载），播放条会停在
            // 「未在播放」而音频其实在响 —— 定期补发自愈。
            if last_publish.elapsed() >= std::time::Duration::from_secs(5) {
                inner.publish();
                last_publish = std::time::Instant::now();
            }
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
            // Error 态下 sink 是空的，裸 sink.play() 是空操作 → 播放键失效。
            // 改为重载当前队列曲目（autoplay=true）：成功即从原进度续播，再失败
            // 走 LoadFailed 的自动跳过链。用户按播放 = 明确意图，重开自动切歌熔断。
            let reload = inner.state.read().unwrap().status == PlaybackStatus::Error;
            if reload {
                let track = inner.queue.lock().unwrap().current().cloned();
                if let Some(track) = track {
                    let pos = inner.state.read().unwrap().position_ms;
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
                inner.mutate(|st| {
                    if st.status == PlaybackStatus::Paused {
                        st.status = PlaybackStatus::Playing;
                    }
                });
            }
        }
        AudioCmd::Pause => {
            // 淡出开启且真的在播：发起淡出但不立即暂停 —— 状态保持 Playing
            // （进度照常走），增益由 DspSource 拉到 0，到期由引擎循环暂停。
            // 淡出已在途时再次 Pause = 用户坚持，直接暂停。
            let fading = inner.pause_deadline.is_none()
                && inner.fx.fade_enabled()
                && inner.state.read().unwrap().status == PlaybackStatus::Playing;
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
            inner.sink.clear();
            inner.current_shared = None;
            inner.pause_deadline = None;
            inner.fx.clear_fade();
            *inner.cache_file.lock().unwrap() = None;
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
            // 失败跳过记录也清空，新的队列重新给每首歌机会；
            // 用户主动发起播放，同时重开自动切歌熔断
            inner.track_quality = None;
            inner.failed_tracks.clear();
            inner.auto_next = true;
            inner.fail_streak = 0;
            inner.stall_retry = 0;
            inner.watch.clear();
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
        AudioCmd::Next => advance(inner, false),
        AudioCmd::Previous => go_previous(inner),
        AudioCmd::SetPlayMode(mode) => {
            inner.mutate(|st| st.play_mode = mode);
            inner.persist_state();
        }
        AudioCmd::ClearQueue => {
            inner.sink.clear();
            inner.current_shared = None;
            inner.pause_deadline = None;
            inner.fx.clear_fade();
            *inner.cache_file.lock().unwrap() = None;
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
        AudioCmd::RemoveIndices(indices) => {
            let removed = inner.queue.lock().unwrap().remove_indices(&indices);
            if removed > 0 {
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
                if let Err(e) = db.with(|c| store::set_setting(c, "audio.outputDevice", &key_val)) {
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
            if let Some(db) = &inner.db {
                if let Err(e) = db.with(|c| store::set_setting(c, "quality", &quality_key(&quality)))
                {
                    log::warn!("[db] 默认音质入库失败: {e}");
                }
            }
            inner.default_quality = quality;
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
        AudioCmd::SetSpeed(v) => {
            let v = v.clamp(SPEED_MIN, SPEED_MAX);
            // 变速重锚：get_pos() 是真实时间口径（rodio 的 TrackPosition 包在 Speed
            // 外层，只数输出采样），content = get_pos × f 只在「本曲全程同速」时成立。
            // 中途变速若只换系数，get_pos 连续计时而 f 已变，内容位置瞬间跳变并从此
            // 偏离真实音频进度（歌词对不上，还原倍速也回不来）。所以先按旧系数取当前
            // 内容位置，换速后 seek 回同一内容位置——f2 下 get_pos 复位为 pos/f2，
            // content = (pos/f2) × f2 = pos，真实时间基准重新对齐。与挂载恢复进度
            // （load_track 里 sink_seek_content）同一套换算路径。
            let pos = content_pos_ms(inner);
            inner.speed = v;
            // rodio 速度控制常驻 Player（controls.speed），5ms 内同步到当前源；
            // seek 消息排在速度控制之后处理，换算系数一致
            inner.sink.set_speed(v);
            if pos > 0 {
                if let Err(e) = sink_seek_content(inner, pos) {
                    log::warn!("[audio] 变速重锚 seek 失败（继续播放，进度显示可能短暂偏移）: {e}");
                }
            }
            if let Some(db) = &inner.db {
                if let Err(e) = db.with(|c| store::set_setting(c, SETTING_SPEED, &v.to_string())) {
                    log::warn!("[db] 倍速入库失败: {e}");
                }
            }
            inner.mutate(|st| st.speed = v);
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
        AudioCmd::SetSpectrum(on) => {
            inner.fx.set_spectrum(on);
            if let Some(db) = &inner.db {
                let val = if on { "true" } else { "false" };
                if let Err(e) = db.with(|c| store::set_setting(c, SETTING_FX_SPECTRUM, val)) {
                    log::warn!("[db] 频谱背景设置入库失败: {e}");
                }
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
        AudioCmd::LoadFailed {
            track_id,
            message,
            autoplay,
            stalled,
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
                log::info!("[queue] 丢弃过期的弱网重试 track={track_id}");
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
                    log::info!("[queue] 弱网重试时当前曲已变，丢弃 track={track_id}");
                } else {
                    // 先出借用再play_queue_track（它要&mut inner）
                    let track = inner.queue.lock().unwrap().current().cloned();
                    if let Some(track) = track {
                        log::info!("[queue] 弱网重试：{track_id}");
                        play_queue_track(inner, track);
                    }
                }
            }
        }
        AudioCmd::Recovered { gen } => {
            if gen != 0 && gen != inner.load_gen {
                log::info!("[queue] 丢弃过期的恢复探测回执");
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
                let track = inner.queue.lock().unwrap().current().cloned();
                if let Some(track) = track {
                    log::info!("[queue] 网络已恢复，重新播放当前曲 {}", track.id);
                    play_queue_track(inner, track);
                } else {
                    log::info!("[queue] 网络已恢复，队列为空不重放");
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
        Some((id, q)) if *id == track.id => q.clone(),
        _ => inner.default_quality.clone(),
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
    // 睡眠定时「播完当前曲目后停止」：只在自然播完时消费，手动切歌不受影响
    if auto && inner.sleep_after_track {
        inner.sleep_after_track = false;
        inner.sleep_deadline = None;
        inner.sink.clear();
        inner.current_shared = None;
        *inner.cache_file.lock().unwrap() = None;
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
                *inner.cache_file.lock().unwrap() = None;
                inner.mutate(|st| {
                    st.status = PlaybackStatus::Stopped;
                    st.position_ms = st.duration_ms;
                });
            }
            // 手动 next 无下一首（空队列）：保持现状
        }
    }
}

/// 自动切歌熔断阈值：连续失败这么多首（每首失败计一次，成功挂载播放清零）
/// 就关闭 auto_next 并发系统通知，防止死歌队列一首接一首白等取链无限空转。
const FAIL_STREAK_LIMIT: u32 = 5;

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
struct StallWatch {
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
    log::info!("[queue] 网络较慢，{delay}ms 后重试同一首（{}/{STALLED_RETRY_LIMIT}）", attempt + 1);

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
    let track = queue.lock().unwrap().current().cloned();
    let Some(track) = track else {
        return;
    };
    let quality = inner.state.read().unwrap().quality.clone();
    tauri::async_runtime::spawn(async move {
        let mut delay = RECOVERY_PROBE_BASE_MS;
        for attempt in 1..=RECOVERY_PROBE_LIMIT {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            // 探测：真取一次链。成功说明网络与音源都回来了。
            let probe =
                crate::resolve_play_url_script(&app, &cache, &track, quality.clone()).await;
            if probe.is_ok() {
                let _ = tx.send(AudioCmd::Recovered { gen: 0 });
                log::info!("[queue] 第{attempt}次恢复探测成功，重开自动切歌");
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
        // 播放条只显示最后一首的单曲错误，用户不知道全队都挂了；这里覆盖成
        // 聚合文案（PlayerBar 的 error 展示位直接显示）
        inner.mutate(|st| {
            st.error = Some(format!("队列内 {len} 首均无法播放，请检查音源或稍后重试"))
        });
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
    let Some(track) = inner.queue.lock().unwrap().current().cloned() else {
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
        quality: inner.state.read().unwrap().quality.clone(),
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
        if self.track.platform.is_local() {
            log::info!("[queue] local track path={}", self.track.id);
            let path = self.track.id.clone();
            self.build_and_dispatch(PlaySource::Local { path }, true, None)
                .await;
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
                    self.build_and_dispatch(PlaySource::Local { path }, true, None)
                        .await;
                    return;
                }
                log::warn!("[queue] 已下载文件已不存在，回落在线取址: {path}");
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
            Ok((url, fetched_at)) => {
                log::info!(
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
                };
                match self.try_build(&source).await {
                    Ok(built) => {
                        self.dispatch_ready(built, false, Some(fetched_at), Some(play_url))
                    }
                    Err(first_err) => {
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
                            Ok((url2, fetched_at2)) => {
                                let source2 = PlaySource::Online {
                                    url: url2.clone(),
                                    fetchedAt: fetched_at2,
                                };
                                match self.try_build(&source2).await {
                                    Ok(built2) => self.dispatch_ready(
                                        built2,
                                        false,
                                        Some(fetched_at2),
                                        Some(url2),
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
    async fn build_and_dispatch(self, source: PlaySource, is_local: bool, fetched_at: Option<u64>) {
        match self.try_build(&source).await {
            Ok(built) => self.dispatch_ready(built, is_local, fetched_at, None),
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
    ) {
        let (decoder, shared, duration_ms) = built;
        let _ = self.tx.send(AudioCmd::LoadReady {
            track: Box::new(self.track.clone()),
            decoder,
            shared,
            duration_ms,
            start_at: if self.start_ms > 0 {
                Some(self.start_ms)
            } else {
                None
            },
            autoplay: self.autoplay,
            is_local,
            url_fetched_at: fetched_at,
            play_url,
            gen: self.gen,
        });
        record_play_start(self.history_db.clone(), self.track.clone());
    }

    /// 回发失败：广播 audio-error + LoadFailed，由引擎统一置错误态并决定跳过。
    ///
    /// `stalled` = 本次失败只是环境问题（弱网/引擎卡），不是「这首歌坏了」。
    /// 引擎侧据此不把这首拉进 `failed_tracks`、不计入连续失败熔断。
    fn dispatch_load_failed(self, kind: &'static str, detail: &str, stalled: bool) {
        let message = if stalled {
            format!("网络较慢，正在重试（{detail}）")
        } else {
            format!("该歌曲暂时无法播放（{detail}）")
        };
        let _ = self.app.emit(
            "audio-error",
            serde_json::json!({
                "trackId": self.track.id,
                "kind": kind,
                "message": message,
                "stalled": stalled,
            }),
        );
        let _ = self.tx.send(AudioCmd::LoadFailed {
            track_id: self.track.id.clone(),
            message,
            autoplay: self.autoplay,
            stalled,
            gen: self.gen,
        });
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
    let keep = inner.cache_file.lock().unwrap().clone();
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
    // 成功挂载 = 这首能播：重开自动切歌熔断（连续失败计数一并清零）
    inner.auto_next = true;
    inner.fail_streak = 0;
    inner.stall_retry = 0;
    // 这里**刻意不动** inner.watch：软恢复（看门狗命中第 1 次）也是走这条挂载路径，
    // 清掉 hits 就变成「每 12s 软重载一次」的无限循环，永远升不到重建输出流那一步。
    // 看门狗判定只由「位置真的推进」或「用户手动发起播放」清零。
    inner.sink.clear();
    // 倍速挂在 rodio Player 的控制链上（对 append 进来的源全局生效）；
    // DspSource 包在解码器外提供 EQ / 响度归一化 / 淡入淡出
    inner.sink.set_speed(inner.speed);
    inner.sink.append(DspSource::new(
        decoder,
        Arc::clone(&inner.fx),
        inner.epoch,
        Some(crate::audio::SpectrumTap::new(Some(inner.app.clone()))),
    ));
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
    *inner.cache_file.lock().unwrap() = shared.as_ref().map(|s| s.path().to_path_buf());
    // 新流落盘后顺手修剪缓存（超上限时清最旧的；后台线程）
    spawn_cache_prune(inner);
    // 恢复现场：加载后先定位到上次进度（暂停态下 try_seek 同样有效）
    if let Some(start) = start_at.filter(|s| *s > 0) {
        if let Err(e) = sink_seek_content(inner, start) {
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
            let file = std::fs::File::open(path).map_err(|e| format!("打开本地文件失败: {e}"))?;
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

    // rodio 的真实播放位置（暂停时冻结）。它走「真实时间」口径（见
    // content_pos_ms 的说明），换算回内容时间域，与倍速无关
    let pos_ms = content_pos_ms(inner);
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
            platform: SourceId::new("kg"),
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
