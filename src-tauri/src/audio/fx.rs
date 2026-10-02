//! 播放链音频效果（DESIGN §7.4 扩展）：均衡器 / 响度归一化 / 淡入淡出 / 频谱采样。
//!
//! 结构：`DspSource` 是挂在解码器外的 `Source` 包装器（`mount_decoder` 里
//! `sink.append(DspSource::new(decoder, fx, epoch, spectrum_tap))`），rodio 在它外层再包
//! speed/track_position/amplify 控制链 —— 所以：
//! - `try_seek` 收到的是**解码器时间域**的位置（外层 rodio Speed 已按倍速换算），
//!   直接转发即可；转发同时必须复位滤波器状态，否则 seek 后有爆音；
//! - 采样率 / 声道数如实透传解码器（均衡器系数按解码率设计，位置统计由
//!   外层 TrackPosition 完成）。
//!
//! 线程模型：`AudioFx` 由引擎线程（命令处理）写、**音频渲染线程**读。
//! 渲染线程上任何阻塞都会直接出声卡欠载，所以读取一律 `try_read`/`try_lock`，
//! 拿不到锁就用上一块的参数快照继续（参数变化最多晚一块生效，约 25ms）。
//! rodio 自己在渲染线程上也用 Mutex 同步音量/倍速（5ms 周期），先例一致。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use rodio::source::SeekError;
use rodio::{ChannelCount, SampleRate, Source};
use tauri::Emitter;

/// 十段均衡器中心频率（ISO 一倍频程），前后端共用同一组值。
pub const EQ_BAND_HZ: [f32; 10] = [
    31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
];

/// 峰值滤波器品质因数：一倍频程间隔下 1.2 的带间交叠适中，共振不过分。
const EQ_Q: f32 = 1.2;

/// 单段增益的夹紧范围（±12 dB），前端滑条范围与此一致。
pub const EQ_GAIN_LIMIT_DB: f32 = 12.0;

/// 前置放大夹紧范围（dB）。
pub const EQ_PREAMP_LIMIT_DB: f32 = 12.0;

// ---------- 可持久化参数（serde camelCase，与前端 types 对齐） ----------

/// 均衡器参数（settings["fx.eq"]，前端 EqParams 同构）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EqParams {
    pub enabled: bool,
    /// 前置放大（dB）。均衡器开启时自动再叠加 -max(正增益) 防削波。
    pub preamp_db: f32,
    /// 十段增益（dB），与 EQ_BAND_HZ 一一对应。
    pub gains_db: [f32; 10],
}

impl Default for EqParams {
    fn default() -> Self {
        Self {
            enabled: false,
            preamp_db: 0.0,
            gains_db: [0.0; 10],
        }
    }
}

/// 淡入淡出参数（settings["fx.fade"]，前端 FadeParams 同构）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FadeParams {
    pub enabled: bool,
    /// 单次淡入 / 淡出时长（ms）。
    pub duration_ms: u64,
}

impl Default for FadeParams {
    fn default() -> Self {
        Self {
            enabled: false,
            duration_ms: 300,
        }
    }
}

/// 音效现状快照（cmd_get_fx_state 回给设置页）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FxState {
    pub eq: EqParams,
    pub loudnorm: bool,
    pub fade: FadeParams,
    /// 播放条频谱背景（前端画方块，数据来自 SpectrumTap 的实时频谱）
    pub spectrum: bool,
}

// ---------- 共享设置 ----------

/// 淡入淡出当前指令：引擎线程在 Play/Pause/Seek 时写入，渲染线程逐块读取。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FadeKind {
    None,
    In,
    Out,
}

#[derive(Debug, Clone, Copy)]
struct FadeCommand {
    kind: FadeKind,
    /// 指令发起时刻（epoch 单调毫秒，与引擎 epoch 同源）
    start_ms: u64,
}

/// 引擎线程与音频渲染线程共享的音效设置。所有字段独立加锁：
/// 改均衡器不该跟改响度归一化互相排队。
pub struct AudioFx {
    eq: RwLock<EqParams>,
    loudnorm: AtomicBool,
    /// 播放条频谱背景开关：关掉时 DspSource 的采样路径零开销直通
    spectrum: AtomicBool,
    fade: RwLock<FadeParams>,
    fade_cmd: RwLock<FadeCommand>,
}

impl AudioFx {
    pub fn new() -> Self {
        Self {
            eq: RwLock::new(EqParams::default()),
            loudnorm: AtomicBool::new(false),
            spectrum: AtomicBool::new(false),
            fade: RwLock::new(FadeParams::default()),
            fade_cmd: RwLock::new(FadeCommand {
                kind: FadeKind::None,
                start_ms: 0,
            }),
        }
    }

    /// 整体替换均衡器参数（cmd_set_eq）。
    pub fn set_eq(&self, p: EqParams) {
        if let Ok(mut g) = self.eq.write() {
            *g = p;
        }
    }

    pub fn eq_params(&self) -> EqParams {
        self.eq.read().map(|g| g.clone()).unwrap_or_default()
    }

    pub fn set_loudnorm(&self, on: bool) {
        self.loudnorm.store(on, Ordering::Relaxed);
    }

    pub fn loudnorm(&self) -> bool {
        self.loudnorm.load(Ordering::Relaxed)
    }

    pub fn set_spectrum(&self, on: bool) {
        self.spectrum.store(on, Ordering::Relaxed);
    }

    pub fn spectrum_enabled(&self) -> bool {
        self.spectrum.load(Ordering::Relaxed)
    }

    pub fn set_fade(&self, p: FadeParams) {
        if let Ok(mut g) = self.fade.write() {
            *g = p;
        }
    }

    pub fn fade_params(&self) -> FadeParams {
        self.fade.read().map(|g| g.clone()).unwrap_or_default()
    }

    /// 发起淡入（恢复播放 / 新曲自动播放）。
    pub fn begin_fade_in(&self, now_ms: u64) {
        if let Ok(mut cmd) = self.fade_cmd.write() {
            *cmd = FadeCommand {
                kind: FadeKind::In,
                start_ms: now_ms,
            };
        }
    }

    /// 发起淡出（暂停）。到期后引擎线程真正 pause 并调 [`Self::clear_fade`]。
    pub fn begin_fade_out(&self, now_ms: u64) {
        if let Ok(mut cmd) = self.fade_cmd.write() {
            *cmd = FadeCommand {
                kind: FadeKind::Out,
                start_ms: now_ms,
            };
        }
    }

    /// 取消淡入淡出，增益立即回到 1（seek / 换曲 / 暂停完成时调用）。
    pub fn clear_fade(&self) {
        if let Ok(mut cmd) = self.fade_cmd.write() {
            *cmd = FadeCommand {
                kind: FadeKind::None,
                start_ms: 0,
            };
        }
    }

    /// 淡入淡出是否启用（引擎在 Play/Pause 时查，决定要不要走渐变路径）。
    pub fn fade_enabled(&self) -> bool {
        self.fade.read().map(|f| f.enabled).unwrap_or(false)
    }

    /// 淡入淡出时长（ms；读不到锁时按 300 兜底，仅影响 deadline 精度）。
    pub fn fade_duration_ms(&self) -> u64 {
        self.fade
            .read()
            .map(|f| f.duration_ms.max(1))
            .unwrap_or(300)
    }

    /// 当前音效状态快照（设置页回读）。
    pub fn state(&self) -> FxState {
        FxState {
            eq: self.eq_params(),
            loudnorm: self.loudnorm(),
            fade: self.fade_params(),
            spectrum: self.spectrum_enabled(),
        }
    }
}

impl Default for AudioFx {
    fn default() -> Self {
        Self::new()
    }
}

// ---------- 双二阶滤波器（RBJ cookbook，peaking EQ） ----------

/// Transposed Direct Form II 双二阶段。系数在换参数 / 换采样率时整体重建。
#[derive(Debug, Clone, Copy)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f64,
    z2: f64,
}

impl Biquad {
    fn peaking(fs: f32, f0: f32, gain_db: f32, q: f32) -> Self {
        let a = 10f32.powf(gain_db / 40.0);
        // f0 超过奈奎斯特（低采样率 + 高频段）时夹回去：alpha 变大 → 趋近恒等
        let w0 = 2.0 * std::f32::consts::PI * f0.min(fs / 2.0 - 1.0) / fs;
        let alpha = w0.sin() / (2.0 * q);
        let a0 = 1.0 + alpha / a;
        Self {
            b0: (1.0 + alpha * a) / a0,
            b1: (-2.0 * w0.cos()) / a0,
            b2: (1.0 - alpha * a) / a0,
            a1: (-2.0 * w0.cos()) / a0,
            a2: (1.0 - alpha / a) / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        // Transposed Direct Form II，全 f64 状态（十段级联下数值余量更足）
        let xf = x as f64;
        let y = self.b0 as f64 * xf + self.z1;
        self.z1 = self.b1 as f64 * xf - self.a1 as f64 * y + self.z2;
        self.z2 = self.b2 as f64 * xf - self.a2 as f64 * y;
        y as f32
    }

    fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
}

/// 一条声道上的整条均衡器链。
struct EqChannel {
    bands: Vec<Biquad>,
}

impl EqChannel {
    fn build(fs: f32, gains_db: &[f32; 10]) -> Self {
        Self {
            bands: EQ_BAND_HZ
                .iter()
                .zip(gains_db.iter())
                .map(|(&f0, &g)| Biquad::peaking(fs, f0, g, EQ_Q))
                .collect(),
        }
    }

    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let mut s = x;
        for b in &mut self.bands {
            s = b.process(s);
        }
        s
    }

    fn reset(&mut self) {
        for b in &mut self.bands {
            b.reset();
        }
    }
}

/// 均衡器是否实际在处理信号（关着或十段全 0 且前置放大为 0 时走零开销直通）。
fn eq_active(p: &EqParams) -> bool {
    if !p.enabled {
        return false;
    }
    p.preamp_db.abs() > 0.01 || p.gains_db.iter().any(|g| g.abs() > 0.01)
}

// ---------- 响度归一化 ----------

/// 响度归一化目标（RMS，线性）：约 -19 dBFS。主流流媒体的响度目标在
/// -14 ~ -19 LUFS 之间；RMS 与 LUFS 在多数音乐上接近，取保守的 -19 免得
/// 把动态大的曲目顶得太响。
const LOUDNORM_TARGET_RMS: f64 = 0.112;
/// 响度测量时间常数（秒）：足够长才不会随乐句起伏「抽吸」，
/// 足够短才能在几秒内跟上不同源之间的响度差。
const LOUDNORM_TAU_SECS: f64 = 8.0;
/// 增益平滑时间常数（秒）：听感上增益变化应是「缓缓推上去」。
const LOUDNORM_GAIN_TAU_SECS: f64 = 0.8;
/// 静音门限（RMS 平方）：低于它的块不参与测量（曲间空白不能把增益顶上天）。
/// 取 RMS ≈ 0.01（-40 dBFS）：只排除数字静音 / 房间底噪，
/// 真正安静的音乐（-35 dBFS 左右）仍会被归一化。
const LOUDNORM_FLOOR_SQ: f64 = 1.0e-4;
/// 增益夹紧范围：-12 ~ +12 dB。
const LOUDNORM_MAX_BOOST: f64 = 3.981;
const LOUDNORM_MAX_CUT: f64 = 0.251;

/// 响度归一化状态机：逐块测量输入响度 → 目标增益（慢）→ 施加增益（更慢）。
#[derive(Debug, Clone)]
struct LoudNormState {
    /// 长期平均信号功率（EMA of mean-square）
    mean_sq: f64,
    /// 当前施加的增益（线性）
    gain: f64,
    /// 本块累积：sum(x²) 与样本数（测的是**输入**响度，与增益解耦）
    acc_sq: f64,
    acc_n: u64,
}

impl LoudNormState {
    fn new() -> Self {
        Self {
            mean_sq: 0.0,
            gain: 1.0,
            acc_sq: 0.0,
            acc_n: 0,
        }
    }

    #[inline]
    fn accumulate(&mut self, x: f32) {
        let v = x as f64;
        self.acc_sq += v * v;
        self.acc_n += 1;
    }

    /// 块边界：用刚累积的块更新响度估计与目标增益。`span_secs` 是块时长。
    fn finish_span(&mut self, span_secs: f64) {
        if self.acc_n == 0 {
            return;
        }
        let rms_sq = self.acc_sq / self.acc_n as f64;
        self.acc_sq = 0.0;
        self.acc_n = 0;
        if rms_sq > LOUDNORM_FLOOR_SQ {
            let alpha = (span_secs / LOUDNORM_TAU_SECS).min(1.0);
            self.mean_sq += alpha * (rms_sq - self.mean_sq);
        }
        let target = if self.mean_sq > 0.0 {
            (LOUDNORM_TARGET_RMS * LOUDNORM_TARGET_RMS / self.mean_sq)
                .sqrt()
                .clamp(LOUDNORM_MAX_CUT, LOUDNORM_MAX_BOOST)
        } else {
            1.0
        };
        let k = (span_secs / LOUDNORM_GAIN_TAU_SECS).min(1.0);
        self.gain += k * (target - self.gain);
    }

    fn reset(&mut self) {
        *self = Self::new();
    }
}

/// 软限幅：|x| ≤ 0.95 直通，超出部分用 tanh 膝点压回 ±1。
/// 只在有可能抬增益的处理（EQ / 响度归一化）生效时调用，
/// 纯直通 / 纯衰减路径保持逐位不变。
#[inline]
fn soft_limit(x: f32) -> f32 {
    const KNEE: f32 = 0.95;
    if x > KNEE {
        let over = (x - KNEE) / (1.0 - KNEE);
        KNEE + (1.0 - KNEE) * over.tanh()
    } else if x < -KNEE {
        let over = (-x - KNEE) / (1.0 - KNEE);
        -(KNEE + (1.0 - KNEE) * over.tanh())
    } else {
        x
    }
}

// ---------- 频谱采样（播放条背景的实时频谱） ----------

/// FFT 窗长：2048 点 @44.1kHz ≈ 46ms，频率分辨率 ~21.5Hz，够分出低音乐器
const SPECTRUM_FFT_SIZE: usize = 2048;
/// 对数频段数（40Hz ~ 16kHz），前端按播放条宽度插值成更多方块
const SPECTRUM_BANDS: usize = 48;
/// 事件节流：约 22fps，肉眼已流畅，IPC 与 FFT 开销都可忽略
const SPECTRUM_EMIT_INTERVAL_MS: u64 = 45;
/// 频段范围：40Hz 以下的次声只有直流漂移，16kHz 以上人耳基本无感
const SPECTRUM_F_MIN_HZ: f32 = 40.0;
const SPECTRUM_F_MAX_HZ: f32 = 16_000.0;
/// 满幅正弦经 hann 窗后的峰值 bin 幅度 ≈ N/4（窗增益 0.5 × 实信号系数 2），
/// 归一化基准用它，dB 映射到 [SPECTRUM_DB_FLOOR, SPECTRUM_DB_CEIL] → 0..1
const SPECTRUM_DB_FLOOR: f32 = -48.0;
const SPECTRUM_DB_CEIL: f32 = -3.0;

/// 推给前端的单帧频谱：bands 里是 0..1 的归一化能量
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpectrumEvent {
    pub bands: Vec<f32>,
}

/// 手写迭代式 radix-2 Cooley-Tukey FFT（N 为 2 的幂）。
/// 不引入 rustfft：定点 2048 点、无分配、约 40 行，配对拍单测保证正确性。
fn fft_inplace(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    debug_assert!(n.is_power_of_two());
    debug_assert_eq!(n, im.len());
    // 位反转重排
    let bits = n.trailing_zeros();
    for i in 0..n {
        let rev = (i.reverse_bits() >> (usize::BITS - bits)) as usize;
        if i < rev {
            re.swap(i, rev);
            im.swap(i, rev);
        }
    }
    // 蝶形：len 为当前子 DFT 长度
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * std::f32::consts::PI / len as f32;
        let (step_re, step_im) = (ang.cos(), ang.sin());
        for start in (0..n).step_by(len) {
            let mut wr = 1.0f32;
            let mut wi = 0.0f32;
            for k in 0..len / 2 {
                let a = start + k;
                let b = a + len / 2;
                let tr = re[b] * wr - im[b] * wi;
                let ti = re[b] * wi + im[b] * wr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                let (nwr, nwi) = (wr * step_re - wi * step_im, wr * step_im + wi * step_re);
                wr = nwr;
                wi = nwi;
            }
        }
        len <<= 1;
    }
}

/// 对数频段的 bin 边界（半开区间 [lo, hi)），rate 变化时重算。
fn band_edges(rate: u32) -> Vec<(usize, usize)> {
    let half = SPECTRUM_FFT_SIZE / 2;
    let nyquist = rate as f32 / 2.0;
    let f_lo = SPECTRUM_F_MIN_HZ.min(nyquist * 0.5);
    let f_hi = SPECTRUM_F_MAX_HZ.min(nyquist * 0.95);
    let ratio = (f_hi / f_lo).powf(1.0 / SPECTRUM_BANDS as f32);
    (0..SPECTRUM_BANDS)
        .map(|b| {
            let lo_hz = f_lo * ratio.powi(b as i32);
            let hi_hz = f_lo * ratio.powi(b as i32 + 1);
            let lo = ((lo_hz / nyquist) * half as f32).floor() as usize;
            let hi = (((hi_hz / nyquist) * half as f32).ceil() as usize).max(lo + 1);
            (lo.min(half - 1), hi.min(half))
        })
        .collect()
}

/// 挂在 DspSource 上的频谱采样器：解码域样本混成单声道进环形缓冲，
/// 攒满一个窗就做 FFT 分频段，节流后经 AppHandle 推 `spectrum` 事件。
///
/// 线程约束：所有方法都在音频渲染线程（DspSource::next）上调用；
/// FFT 固定 2048 点、零分配，单次几十微秒，对实时路径安全。
/// `app` 为 None 时（单测）只算不发。
pub struct SpectrumTap {
    app: Option<tauri::AppHandle>,
    ring: Vec<f32>,
    /// 环形缓冲写位置
    write_pos: usize,
    /// 自上次 FFT 以来累计的样本数（帧间隔一到就分析）
    pending: usize,
    window: Vec<f32>,
    re: Vec<f32>,
    im: Vec<f32>,
    edges: Vec<(usize, usize)>,
    rate: u32,
    last_emit: Option<std::time::Instant>,
}

impl SpectrumTap {
    pub fn new(app: Option<tauri::AppHandle>) -> Self {
        let mut tap = Self {
            app,
            ring: vec![0.0; SPECTRUM_FFT_SIZE],
            write_pos: 0,
            pending: 0,
            window: Vec::new(),
            re: Vec::new(),
            im: Vec::new(),
            edges: band_edges(44_100),
            rate: 44_100,
            last_emit: None,
        };
        tap.build_window();
        tap
    }

    fn build_window(&mut self) {
        // hann 窗：抑制 FFT 截断的频谱泄漏
        let n = SPECTRUM_FFT_SIZE as f32;
        self.window = (0..SPECTRUM_FFT_SIZE)
            .map(|i| 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / n).cos()))
            .collect();
        self.re = vec![0.0; SPECTRUM_FFT_SIZE];
        self.im = vec![0.0; SPECTRUM_FFT_SIZE];
    }

    /// 采样率变化时重算窗与频段边界（DspSource::refresh_span 调）。
    fn set_rate(&mut self, rate: u32) {
        if rate != self.rate {
            self.rate = rate;
            self.edges = band_edges(rate);
            self.build_window();
        }
    }

    /// seek 后旧样本已失效：清空累计，避免下一帧混入跳变前的历史。
    fn reset(&mut self) {
        self.write_pos = 0;
        self.pending = 0;
    }

    /// 喂入一个样本（解码域、多声道交织流）。攒满一个 FFT 窗时返回
    /// 归一化频段能量（节流窗口内返回 None）。
    fn push(&mut self, sample: f32) -> Option<Vec<f32>> {
        self.ring[self.write_pos] = sample;
        self.write_pos = (self.write_pos + 1) % SPECTRUM_FFT_SIZE;
        self.pending += 1;
        if self.pending < SPECTRUM_FFT_SIZE {
            return None;
        }
        self.pending = 0;

        // 节流：窗口间隔内直接丢弃这次分析
        let now = std::time::Instant::now();
        if let Some(last) = self.last_emit {
            if (now.duration_since(last).as_millis() as u64) < SPECTRUM_EMIT_INTERVAL_MS {
                return None;
            }
        }
        self.last_emit = Some(now);

        // 环形缓冲按正确时序展开 + 加窗
        for i in 0..SPECTRUM_FFT_SIZE {
            let idx = (self.write_pos + i) % SPECTRUM_FFT_SIZE;
            self.re[i] = self.ring[idx] * self.window[i];
            self.im[i] = 0.0;
        }
        fft_inplace(&mut self.re, &mut self.im);

        let norm_base = SPECTRUM_FFT_SIZE as f32 / 4.0;
        let bands: Vec<f32> = self
            .edges
            .iter()
            .map(|(lo, hi)| {
                let mut peak = 0.0f32;
                for bin in *lo..*hi {
                    let m = (self.re[bin] * self.re[bin] + self.im[bin] * self.im[bin]).sqrt();
                    peak = peak.max(m);
                }
                let db = 20.0 * (peak / norm_base + 1e-9).log10();
                ((db - SPECTRUM_DB_FLOOR) / (SPECTRUM_DB_CEIL - SPECTRUM_DB_FLOOR)).clamp(0.0, 1.0)
            })
            .collect();
        Some(bands)
    }

    /// 推送一帧频谱给前端（app 为 None 时静默丢弃，单测用）。
    fn emit(&self, bands: Vec<f32>) {
        if let Some(app) = &self.app {
            let _ = app.emit("spectrum", SpectrumEvent { bands });
        }
    }
}

// ---------- DspSource ----------

/// 挂在解码器外的效果链 Source。见模块注释的线程与时间域约定。
pub struct DspSource {
    inner: Box<dyn Source + Send>,
    fx: Arc<AudioFx>,
    epoch: std::time::Instant,

    // 每块刷新的参数快照（try_lock 失败沿用旧值）
    span_left: usize,
    /// 块内已消费的样本数（淡入淡出的块内插值基准）
    span_elapsed: usize,
    /// 块起始时刻（epoch 单调毫秒）
    span_now_ms: u64,
    channels: usize,
    eq: Option<Vec<EqChannel>>,
    /// 当前均衡器链对应的 (参数, 采样率, 声道数)：任一变化都重建系数
    eq_sig: Option<(EqParams, u32, usize)>,
    preamp: f32,
    loudnorm: bool,
    fade_kind: FadeKind,
    fade_start_ms: u64,
    fade_dur_ms: u64,
    norm: LoudNormState,
    /// 频谱采样器（None = 无处推送，如单测）；开关状态缓存在 spectrum_on，
    /// 关闭时 next() 里的采样路径零开销
    spectrum: Option<SpectrumTap>,
    spectrum_on: bool,
    /// 频谱混音累加器：交织流按帧（所有声道）求和取均值后再进采样器
    spectrum_acc: f32,
    /// 帧内声道游标（采样按声道交织到达）
    ch_pos: usize,
}

impl DspSource {
    pub fn new(
        inner: Box<dyn Source + Send>,
        fx: Arc<AudioFx>,
        epoch: std::time::Instant,
        spectrum: Option<SpectrumTap>,
    ) -> Self {
        let spectrum_on = fx.spectrum_enabled();
        Self {
            inner,
            fx,
            epoch,
            span_left: 0,
            span_elapsed: 0,
            span_now_ms: 0,
            channels: 2,
            eq: None,
            eq_sig: None,
            preamp: 1.0,
            loudnorm: false,
            fade_kind: FadeKind::None,
            fade_start_ms: 0,
            fade_dur_ms: 0,
            norm: LoudNormState::new(),
            spectrum,
            spectrum_on,
            spectrum_acc: 0.0,
            ch_pos: 0,
        }
    }

    /// 块边界：读参数、必要时重建滤波器、结算响度块。
    fn refresh_span(&mut self) {
        let rate = self.inner.sample_rate().get();
        let channels = (self.inner.channels().get() as usize).max(1);
        self.channels = channels;
        self.span_now_ms = self.epoch.elapsed().as_millis() as u64;
        self.span_elapsed = 0;

        // 频谱采样：跟随采样率；开关状态这里统一快照，刚开启时清一次
        // 残留样本（关着的那些秒里 ring 里存的是旧音频）
        if let Some(tap) = &mut self.spectrum {
            tap.set_rate(rate);
        }
        let on = self.fx.spectrum_enabled();
        if on && !self.spectrum_on {
            if let Some(tap) = &mut self.spectrum {
                tap.reset();
            }
        }
        self.spectrum_on = on;

        // 均衡器：参数 / 采样率 / 声道数任一变化都重建系数
        if let Ok(p) = self.fx.eq.try_read() {
            let p = p.clone();
            let active = eq_active(&p);
            let rebuild = match &self.eq_sig {
                Some((cp, cr, cc)) => *cp != p || *cr != rate || *cc != channels,
                None => true,
            };
            if active {
                if rebuild || self.eq.is_none() {
                    self.eq = Some(
                        (0..channels)
                            .map(|_| EqChannel::build(rate as f32, &p.gains_db))
                            .collect(),
                    );
                }
                // 自动防削波前置放大：用户值 - 最大正增益（全负增益不补偿）
                let max_boost = p.gains_db.iter().copied().fold(0.0f32, f32::max);
                self.preamp = 10f32.powf((p.preamp_db - max_boost) / 20.0);
            } else {
                // 关闭 = 直通；链留着不重建，eq_sig 照常记录，重开时按需重建
                self.eq = None;
                self.preamp = 1.0;
            }
            self.eq_sig = Some((p, rate, channels));
        }

        self.loudnorm = self.fx.loudnorm();
        if let Ok(fp) = self.fx.fade.try_read() {
            self.fade_dur_ms = fp.duration_ms.max(1);
        }
        if let Ok(cmd) = self.fx.fade_cmd.try_read() {
            self.fade_kind = cmd.kind;
            self.fade_start_ms = cmd.start_ms;
        }

        // 响度块结算 + 增益向目标靠拢（先测上一块，再按块长平滑）
        let span_len = self.inner.current_span_len().unwrap_or(4096).max(1);
        let span_secs = span_len as f64 / rate as f64 / channels as f64;
        self.norm.finish_span(span_secs);
        if !self.loudnorm {
            self.norm.reset();
        }

        self.span_left = span_len;
    }

    /// 当前样本的淡入淡出增益（块内按样本推进，块间无跳变）。
    #[inline]
    fn fade_gain(&self) -> f32 {
        match self.fade_kind {
            FadeKind::None => 1.0,
            FadeKind::In | FadeKind::Out => {
                if self.fade_dur_ms == 0 {
                    return 1.0;
                }
                let per_sample_ms =
                    1000.0 / self.inner.sample_rate().get() as f32 / self.channels as f32;
                let elapsed_ms = self.span_now_ms as f32 + self.span_elapsed as f32 * per_sample_ms
                    - self.fade_start_ms as f32;
                let t = (elapsed_ms.max(0.0) / self.fade_dur_ms as f32).clamp(0.0, 1.0);
                match self.fade_kind {
                    FadeKind::In => t,
                    FadeKind::Out => 1.0 - t,
                    FadeKind::None => 1.0,
                }
            }
        }
    }
}

impl Iterator for DspSource {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        let x = self.inner.next()?;
        if self.span_left == 0 {
            self.refresh_span();
        }
        self.span_left = self.span_left.saturating_sub(1);

        let ch = self.ch_pos;
        self.ch_pos = (self.ch_pos + 1) % self.channels;

        // 频谱采样（解码域样本：效果关闭时与输出逐位相同；开 EQ/归一化时
        // 装饰背景不跟随效果，换取快路径零成本和固定的视觉标尺）。
        // 交织的多声道样本先按帧混成单声道（直接喂交织流会让频谱按奈奎斯特折叠）。
        // FFT 在攒满一个窗的那次 next() 里做（几十微秒），实时路径可承受。
        if self.spectrum_on {
            self.spectrum_acc += x;
            if self.ch_pos == 0 {
                let frame = self.spectrum_acc / self.channels as f32;
                self.spectrum_acc = 0.0;
                if let Some(tap) = &mut self.spectrum {
                    if let Some(bands) = tap.push(frame) {
                        tap.emit(bands);
                    }
                }
            }
        }

        // 直通快路径：三种效果都没开，逐位透传
        if self.eq.is_none() && !self.loudnorm && self.fade_kind == FadeKind::None {
            return Some(x);
        }

        let mut s = x;
        if let Some(chs) = &mut self.eq {
            if let Some(c) = chs.get_mut(ch) {
                s = c.process(s);
            }
            s *= self.preamp;
        }
        let boosting = self.eq.is_some() || self.loudnorm;
        if self.loudnorm {
            self.norm.accumulate(x);
            s = (s as f64 * self.norm.gain) as f32;
        }
        s *= self.fade_gain();
        self.span_elapsed += 1;
        if boosting {
            s = soft_limit(s);
        }
        Some(s)
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        self.inner.size_hint()
    }
}

impl Source for DspSource {
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }

    fn channels(&self) -> ChannelCount {
        self.inner.channels()
    }

    fn sample_rate(&self) -> SampleRate {
        self.inner.sample_rate()
    }

    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        // seek 落点之外的历史样本不能再进滤波器（IIR 状态对应旧位置），
        // 全部清零 —— 否则拖动进度条后有一声「啵」。
        if let Some(chs) = &mut self.eq {
            for c in chs {
                c.reset();
            }
        }
        // 响度估计保留（同一首曲子的响度不因 seek 改变），只丢未结算的半块
        self.norm.acc_sq = 0.0;
        self.norm.acc_n = 0;
        self.spectrum_acc = 0.0;
        if let Some(tap) = &mut self.spectrum {
            tap.reset();
        }
        self.span_left = 0;
        self.span_elapsed = 0;
        self.ch_pos = 0;
        self.inner.try_seek(pos)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- 频谱采样 ----------

    /// FFT 与朴素 DFT 对拍：N=64 随机信号，误差应在 f32 精度量级
    #[test]
    fn fft_matches_naive_dft() {
        let n = 64;
        let mut re: Vec<f32> = (0..n)
            .map(|i| ((i * 37) % 13) as f32 * 0.17 - 1.0)
            .collect();
        let mut im: Vec<f32> = (0..n).map(|i| ((i * 11) % 7) as f32 * 0.23 - 0.5).collect();
        fft_inplace(&mut re, &mut im);
        for k in 0..n {
            let mut expect_re = 0.0f32;
            let mut expect_im = 0.0f32;
            for t in 0..n {
                let ang = -2.0 * std::f32::consts::PI * (k * t) as f32 / n as f32;
                let (x, y) = (
                    ((t * 37) % 13) as f32 * 0.17 - 1.0,
                    ((t * 11) % 7) as f32 * 0.23 - 0.5,
                );
                expect_re += x * ang.cos() - y * ang.sin();
                expect_im += x * ang.sin() + y * ang.cos();
            }
            assert!(
                (re[k] - expect_re).abs() < 1e-3 && (im[k] - expect_im).abs() < 1e-3,
                "bin {k}: got ({}, {}), want ({}, {})",
                re[k],
                im[k],
                expect_re,
                expect_im
            );
        }
    }

    /// 1kHz 满幅正弦应主要落在对应频段且归一化后接近满格
    #[test]
    fn spectrum_band_energy_maps_to_unit_range() {
        let rate = 44_100u32;
        let mut tap = SpectrumTap::new(None);
        tap.set_rate(rate);
        // 首窗无节流拦截：喂满 2048 个样本后 push 一定返回一帧频段
        let mut bands = None;
        for i in 0..SPECTRUM_FFT_SIZE {
            let t = i as f32 / rate as f32;
            bands = tap.push((2.0 * std::f32::consts::PI * 1000.0 * t).sin());
        }
        let bands = bands.expect("第一个满窗应产出频段");
        // 1kHz 对应的 bin 落在哪个频段
        let half = SPECTRUM_FFT_SIZE / 2;
        let bin = (1000.0 / (rate as f32 / 2.0) * half as f32).round() as usize;
        let idx = tap
            .edges
            .iter()
            .position(|(lo, hi)| bin >= *lo && bin < *hi)
            .expect("1kHz 必须落在频段范围内");
        assert!(
            bands[idx] > 0.9,
            "1kHz 满幅正弦应接近满格，实际 {}",
            bands[idx]
        );
    }

    /// 频段边界单调不重叠，覆盖 40Hz..16kHz
    #[test]
    fn band_edges_are_monotonic_and_covered() {
        let edges = band_edges(44_100);
        assert_eq!(edges.len(), SPECTRUM_BANDS);
        for w in edges.windows(2) {
            assert!(w[0].1 <= w[1].0 + 1, "频段应首尾衔接不重叠");
            assert!(w[0].0 < w[0].1, "每个频段至少一个 bin");
        }
        // 首段有效；末段封顶在 16kHz（< 奈奎斯特），终点不得越过半谱 bin 数
        assert!(edges[0].0 < edges[0].1);
        assert!(edges.last().unwrap().1 <= SPECTRUM_FFT_SIZE / 2);
    }

    // ---------- 均衡器 ----------

    #[test]
    fn eq_inactive_when_disabled_or_flat() {
        let mut p = EqParams::default();
        assert!(!eq_active(&p), "默认关闭");

        p.enabled = true;
        assert!(!eq_active(&p), "十段全 0 且前置放大 0 = 直通");

        p.gains_db[3] = 0.001;
        assert!(!eq_active(&p), "微小于阈值视为 0");

        p.gains_db[3] = 3.0;
        assert!(eq_active(&p));
        p.gains_db[3] = 0.0;
        p.preamp_db = -2.0;
        assert!(eq_active(&p), "只动前置放大也算开启");
    }

    #[test]
    fn peaking_at_zero_gain_is_unity() {
        // 0 dB 峰值滤波器 b1==a1、b2==a2、b0==1：TDF2 下应逐样本恒等
        let mut b = Biquad::peaking(44100.0, 1000.0, 0.0, EQ_Q);
        for i in 0..64 {
            let x = ((i as f32) * 0.1).sin();
            assert!((b.process(x) - x).abs() < 1e-6, "0dB 滤波器不改变样本");
        }
    }

    #[test]
    fn peaking_boosts_band_frequency() {
        // +12dB @1kHz：稳态 1kHz 正弦的峰值应 ≈ 4（+12dB）；31Hz 处几乎不变。
        // 注意必须测**稳态峰值**——单个样本点的值由相位决定，不代表幅度。
        let fs = 44100.0f32;
        let mut b = Biquad::peaking(fs, 1000.0, 12.0, EQ_Q);
        let mut peak = 0.0f32;
        for i in 0..fs as usize / 10 {
            let x = (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / fs).sin();
            let y = b.process(x);
            if i > fs as usize / 10 - 1000 {
                peak = peak.max(y.abs());
            }
        }
        assert!(
            (peak - 10f32.powf(12.0 / 20.0)).abs() < 0.1,
            "1kHz 增益段稳态峰值应 ≈ 4（实际 {peak}）"
        );

        let mut b2 = Biquad::peaking(fs, 1000.0, 12.0, EQ_Q);
        let mut low_peak = 0.0f32;
        for i in 0..fs as usize / 10 {
            let x = (2.0 * std::f32::consts::PI * 31.0 * i as f32 / fs).sin();
            let y = b2.process(x);
            if i > fs as usize / 10 - 1000 {
                low_peak = low_peak.max(y.abs());
            }
        }
        assert!(
            low_peak < 1.05,
            "31Hz 远离 1kHz 峰值，增益应接近 1（实际 {low_peak}）"
        );
    }

    // ---------- 响度归一化 ----------

    #[test]
    fn loudnorm_gain_clamped() {
        // 极响的块（RMS≈1）→ 目标增益应压到下限而不是无限削
        let mut st = LoudNormState::new();
        for _ in 0..512 {
            st.accumulate(0.999);
        }
        st.finish_span(0.01);
        for _ in 0..2000 {
            for _ in 0..512 {
                st.accumulate(0.999);
            }
            st.finish_span(0.01);
        }
        assert!(
            (st.gain - LOUDNORM_MAX_CUT).abs() < 1e-6,
            "极响输入增益应收敛到 -12dB 下限（实际 {}）",
            st.gain
        );

        // 极轻的块（RMS 0.02，目标增益 +15dB 超上限）→ 增益收敛到 +12dB 上限
        let mut st2 = LoudNormState::new();
        for _ in 0..4000 {
            for _ in 0..512 {
                st2.accumulate(0.02);
            }
            st2.finish_span(0.01);
        }
        assert!(
            (st2.gain - LOUDNORM_MAX_BOOST).abs() < 1e-6,
            "极轻输入增益应收敛到 +12dB 上限（实际 {}）",
            st2.gain
        );
    }

    #[test]
    fn loudnorm_silence_does_not_adapt() {
        let mut st = LoudNormState::new();
        // 先测一段正常响度
        for _ in 0..512 {
            st.accumulate(0.15);
        }
        st.finish_span(0.01);
        let g_before = st.gain;
        // 静音块：不参与测量，增益不应被推向 Boost
        for _ in 0..2000 {
            st.finish_span(0.01);
        }
        assert!(st.mean_sq > 0.0, "静音块不能清空已测响度");
        assert!(
            (st.gain - g_before).abs() < 1e-9,
            "纯静音期间增益应冻结（{} → {}）",
            g_before,
            st.gain
        );
    }

    // ---------- 软限幅 ----------

    #[test]
    fn soft_limit_passthrough_below_knee() {
        for x in [-0.94f32, -0.5, 0.0, 0.5, 0.94] {
            assert_eq!(soft_limit(x), x, "膝点内应逐位直通");
        }
    }

    #[test]
    fn soft_limit_tames_peaks() {
        assert!(soft_limit(1.7) <= 1.0, "削峰不超过满幅");
        assert!(soft_limit(-1.7) >= -1.0);
        assert!(soft_limit(1.7) > 0.95, "削峰不改变符号且保留响度");
        // 连续性：膝点处不跳变
        assert!((soft_limit(0.95) - 0.95).abs() < 1e-6);
    }
}
