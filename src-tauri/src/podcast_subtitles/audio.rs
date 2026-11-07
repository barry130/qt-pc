use rodio::{source::UniformSourceIterator, Source};
use sha1::{Digest, Sha1};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::io::AsyncWriteExt;

pub const CHUNK_MS: i64 = 300_000;
pub const WINDOW_MS: i64 = 20_000;

#[derive(Default)]
pub(super) struct Cancellation {
    cancelled: AtomicBool,
    notify: tokio::sync::Notify,
}
impl Cancellation {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_one();
    }
    pub fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::SeqCst) {
            Err("已取消，已完成的字幕会保留".into())
        } else {
            Ok(())
        }
    }
    pub async fn wait(&self) {
        loop {
            let notified = self.notify.notified();
            if self.cancelled.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
        }
    }
}

pub(super) fn public_client() -> Result<reqwest::Client, String> {
    crate::net_config::configure(reqwest::Client::builder())
        .timeout(Duration::from_secs(600))
        .connect_timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5
                || crate::net_guard::ensure_public_http_url(attempt.url().as_str()).is_err()
            {
                attempt.error("不支持的重定向地址")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| "网络客户端初始化失败".into())
}

pub(super) async fn read_response(
    mut response: reqwest::Response,
    max: usize,
) -> Result<String, String> {
    if !response.status().is_success() {
        return Err(format!("服务返回 HTTP {}", response.status().as_u16()));
    }
    if response.content_length().is_some_and(|n| n > max as u64) {
        return Err("服务响应超过大小上限".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取服务响应失败")? {
        if bytes.len() + chunk.len() > max {
            return Err("服务响应超过大小上限".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "字幕需要 UTF-8 编码".into())
}

/// 先完整缓存压缩音频，再按绝对时间切 WAV。不会把播放速度、系统声音或其他应用录进去。
pub(super) async fn download(
    url: &str,
    root: &Path,
    cancel: &Cancellation,
) -> Result<PathBuf, String> {
    download_with_progress(url, root, cancel, |_, _| {}).await
}

pub(super) async fn download_with_progress(
    url: &str,
    root: &Path,
    cancel: &Cancellation,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<PathBuf, String> {
    cancel.check()?;
    crate::net_guard::ensure_public_http_url(url)?;
    tokio::fs::create_dir_all(root)
        .await
        .map_err(|_| "无法创建播客字幕缓存")?;
    let path = cache_path(url, root);
    if let Ok(meta) = tokio::fs::metadata(&path).await {
        if meta.is_file() && meta.len() > 0 {
            progress(meta.len(), Some(meta.len()));
            return Ok(path);
        }
    }
    prune_cache(root, &path).await;
    let part = root.join(format!("audio-{:016x}.part", fastrand::u64(..)));
    let mut file = tokio::fs::File::create(&part)
        .await
        .map_err(|_| "无法创建音频缓存文件")?;
    let work = async {
        let mut response = public_client()?
            .get(url)
            .send()
            .await
            .map_err(|_| "播客音频下载失败")?;
        if !response.status().is_success() {
            return Err(format!("音频下载返回 HTTP {}", response.status().as_u16()));
        }
        const MAX: u64 = 512 * 1024 * 1024;
        if response.content_length().is_some_and(|n| n > MAX) {
            return Err("音频超过 512 MB，请导入字幕或使用较短节目".into());
        }
        let total = response.content_length();
        progress(0, total);
        let mut reported = std::time::Instant::now();
        let mut size = 0;
        while let Some(chunk) = response.chunk().await.map_err(|_| "音频下载中断，可重试")?
        {
            cancel.check()?;
            size += chunk.len() as u64;
            if size > MAX {
                return Err("音频超过 512 MB".into());
            }
            file.write_all(&chunk)
                .await
                .map_err(|_| "音频缓存写入失败")?;
            if reported.elapsed() >= Duration::from_millis(200) {
                progress(size, total);
                reported = std::time::Instant::now();
            }
        }
        file.flush().await.map_err(|_| "音频缓存写入失败")?;
        if size == 0 {
            return Err("播客音频为空".into());
        }
        progress(size, total);
        Ok(())
    };
    let result =
        tokio::select! { result = work => result, _ = cancel.wait() => Err("已取消".into()) };
    drop(file);
    if result.is_err() {
        let _ = tokio::fs::remove_file(&part).await;
    }
    result?;
    if tokio::fs::rename(&part, &path).await.is_err() {
        let _ = tokio::fs::remove_file(&part).await;
        return Err("音频缓存保存失败".into());
    }
    Ok(path)
}

fn cache_path(url: &str, root: &Path) -> PathBuf {
    let hash = Sha1::digest(url.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    root.join(format!("{hash}.audio"))
}

/// 离线模式只能读取已选择文件或完成的下载，绝不隐式发起 HTTP 请求。
pub(super) fn offline_path(url: &str, selected: &str, root: &Path) -> Result<PathBuf, String> {
    let path = if selected.is_empty() {
        cache_path(url, root)
    } else {
        PathBuf::from(selected)
    };
    if !path.is_absolute()
        || !std::fs::metadata(&path).is_ok_and(|meta| meta.is_file() && meta.len() > 0)
    {
        return Err(if selected.is_empty() {
            "尚无本地节目音频，请先点击「缓存节目音频」或「选择本地音频」"
        } else {
            "所选节目音频已移动或无法访问，请重新选择本地音频"
        }
        .into());
    }
    Ok(path)
}

// 给本次下载预留 512 MB；只清理专用目录里本模块产生的普通文件，不跟随符号链接。
async fn prune_cache(root: &Path, keep: &Path) {
    let Ok(mut entries) = tokio::fs::read_dir(root).await else {
        return;
    };
    let mut cached = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path == keep || !entry.file_type().await.is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        let age = modified.elapsed().unwrap_or_default();
        let extension = path.extension().and_then(|value| value.to_str());
        if extension == Some("part") && age > Duration::from_secs(86400) {
            let _ = tokio::fs::remove_file(path).await;
        } else if extension == Some("audio") {
            cached.push((path, meta.len(), modified));
        }
    }
    cached.sort_by_key(|(_, _, modified)| *modified);
    let mut total: u64 = cached.iter().map(|(_, size, _)| size).sum();
    for (path, size, modified) in cached {
        if (total > 1536 * 1024 * 1024
            || modified.elapsed().unwrap_or_default() > Duration::from_secs(7 * 86400))
            && tokio::fs::remove_file(path).await.is_ok()
        {
            total = total.saturating_sub(size);
        }
    }
}

pub(super) struct AudioChunk {
    pub wav: Vec<u8>,
    pub start_ms: i64,
    pub end_ms: i64,
    pub duration_ms: i64,
}

/// Rodio 的默认降声道会丢弃右声道；访谈两位嘉宾可能分在左右两侧，必须先混合。
struct Mono<S>(S);
impl<S: Source> Iterator for Mono<S> {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        let channels = self.0.channels().get();
        let mut sum = self.0.next()?;
        for _ in 1..channels {
            sum += self.0.next().unwrap_or(0.0);
        }
        Some(sum / f32::from(channels))
    }
}
impl<S: Source> Source for Mono<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.0
            .current_span_len()
            .map(|n| n / self.0.channels().get() as usize)
    }
    fn channels(&self) -> rodio::ChannelCount {
        rodio::ChannelCount::new(1).unwrap()
    }
    fn sample_rate(&self) -> rodio::SampleRate {
        self.0.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.0.total_duration()
    }
}

pub(super) fn decode_chunk(
    path: &Path,
    chunk: i64,
    cancel: Arc<Cancellation>,
) -> Result<AudioChunk, String> {
    let decoder = crate::audio::engine::decode_local_file(path)?;
    extract(decoder, chunk, cancel)
}

fn extract<S: Source>(
    decoder: S,
    chunk: i64,
    cancel: Arc<Cancellation>,
) -> Result<AudioChunk, String> {
    extract_with_overlap(decoder, chunk, cancel, 2000)
}

/// 文字稿没有句子时间，无法按中点消除上下文重叠；按五分钟边界切片。
pub(super) fn decode_transcript_chunk(path: &Path, chunk: i64, cancel: Arc<Cancellation>) -> Result<AudioChunk, String> {
    let decoder = crate::audio::engine::decode_local_file(path)?;
    extract_with_overlap(decoder, chunk, cancel, 0)
}

pub(super) fn decode_window(path: &Path, window: i64, cancel: Arc<Cancellation>) -> Result<AudioChunk, String> {
    let decoder = crate::audio::engine::decode_local_file(path)?;
    extract_range(decoder, (window * WINDOW_MS - 1000).max(0), (window + 1) * WINDOW_MS + 1000, cancel)
}

fn extract_with_overlap<S: Source>(
    decoder: S,
    chunk: i64,
    cancel: Arc<Cancellation>,
    overlap_ms: i64,
) -> Result<AudioChunk, String> {
    extract_range(decoder, (chunk * CHUNK_MS - overlap_ms).max(0), (chunk + 1) * CHUNK_MS + overlap_ms, cancel)
}

fn extract_range<S: Source>(mut decoder: S, start_ms: i64, requested_end: i64, cancel: Arc<Cancellation>) -> Result<AudioChunk, String> {
    let duration_ms = decoder
        .total_duration()
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    if duration_ms > 0 && start_ms >= duration_ms {
        return Err("这个位置已超过节目时长".into());
    }
    if start_ms > 0 {
        decoder
            .try_seek(Duration::from_millis(start_ms as u64))
            .map_err(|_| "该音频不支持精确定位，暂时无法分段生成字幕")?;
    }
    let source = UniformSourceIterator::new(
        Mono(decoder),
        rodio::ChannelCount::new(1).unwrap(),
        rodio::SampleRate::new(16_000).unwrap(),
    );
    let max_samples = ((requested_end - start_ms) * 16) as usize;
    let mut pcm = Vec::with_capacity(max_samples * 2);
    for (index, sample) in source.take(max_samples).enumerate() {
        if index % 16000 == 0 {
            cancel.check()?;
        }
        pcm.extend_from_slice(&((sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16).to_le_bytes());
    }
    if pcm.is_empty() {
        return Err("该位置没有可识别的音频".into());
    }
    let end_ms = start_ms + pcm.len() as i64 / 32;
    let duration_ms = if pcm.len() / 2 < max_samples {
        end_ms
    } else {
        duration_ms
    };
    let wav = pcm_wav(&pcm);
    Ok(AudioChunk {
        wav,
        start_ms,
        end_ms,
        duration_ms,
    })
}

/// 生产解码固定输出 16 kHz / mono / PCM16 的 44 字节 WAV 头。
/// 小识别窗口只复制已解码 PCM，不重复 seek，避免窗口间的解码偏移。
impl AudioChunk {
    pub(super) fn window_wav(&self, start_ms: i64, end_ms: i64) -> Result<Vec<u8>, String> {
        if start_ms < 0 || end_ms <= start_ms || end_ms > self.end_ms - self.start_ms {
            return Err("本地识别音频窗口超出范围".into());
        }
        let start = 44 + start_ms as usize * 32;
        let end = 44 + end_ms as usize * 32;
        let pcm = self.wav.get(start..end).ok_or("本地识别音频不完整")?;
        Ok(pcm_wav(pcm))
    }
}

fn pcm_wav(pcm: &[u8]) -> Vec<u8> {
    let mut wav = Vec::with_capacity(pcm.len() + 44);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(pcm.len() as u32 + 36).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&16000u32.to_le_bytes());
    wav.extend_from_slice(&32000u32.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    fn test_root() -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("_tmp")
            .join(format!("audio-unit-{:016x}", fastrand::u64(..)));
        std::fs::create_dir_all(&root).unwrap();
        root
    }
    #[test]
    fn cached_download_reports_bytes_without_network_and_cancel_is_terminal() {
        let root = test_root();
        let url = "https://fixture.invalid/progress-test.mp3";
        let path = cache_path(url, &root);
        std::fs::write(&path, b"cached-audio").unwrap();
        let mut events = Vec::new();
        let cancel = Cancellation::default();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let result = runtime.block_on(download_with_progress(url, &root, &cancel, |size, total| events.push((size, total)))).unwrap();
        assert_eq!(result, path);
        assert_eq!(events, vec![(12, Some(12))]);
        cancel.cancel();
        assert!(runtime.block_on(download_with_progress(url, &root, &cancel, |_, _| panic!("cancelled download reported progress"))).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"cached-audio");
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn offline_audio_uses_only_completed_cache_or_selected_file() {
        let root = test_root();
        // 有效 URL 也不能触发下载；这里只能读取本地文件。
        let url = "https://fixture.invalid/offline-path-test.mp3";
        assert!(offline_path(url, "", &root)
            .unwrap_err()
            .contains("尚无本地节目音频"));
        let cached = cache_path(url, &root);
        std::fs::write(&cached, b"audio").unwrap();
        assert_eq!(offline_path(url, "", &root).unwrap(), cached);
        let selected = root.join("selected-offline-audio.wav");
        std::fs::write(&selected, b"selected audio").unwrap();
        assert_eq!(
            offline_path(url, selected.to_str().unwrap(), &root).unwrap(),
            selected
        );
        std::fs::remove_file(&selected).unwrap();
        // 选定文件消失时不能默默改用另一个版本的缓存音频。
        assert!(offline_path(url, selected.to_str().unwrap(), &root)
            .unwrap_err()
            .contains("已移动"));
        std::fs::remove_file(cached).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn real_decoder_produces_bounded_mono_wav_and_honors_cancel() {
        let bytes = include_bytes!("../../tests/fixtures/self-authored-silence.wav");
        let source = rodio::Decoder::try_from(Cursor::new(bytes.to_vec())).unwrap();
        let result = extract(source, 0, Arc::new(Cancellation::default())).unwrap();
        assert_eq!(&result.wav[..4], b"RIFF");
        let decoded = rodio::Decoder::try_from(Cursor::new(result.wav)).unwrap();
        assert_eq!(decoded.channels().get(), 1);
        assert_eq!(decoded.sample_rate().get(), 16000);
        let cancel = Arc::new(Cancellation::default());
        cancel.cancel();
        let source = rodio::Decoder::try_from(Cursor::new(bytes.to_vec())).unwrap();
        assert!(extract(source, 0, cancel).is_err());
    }
    #[test]
    fn recognition_windows_keep_pcm_samples_and_real_duration() {
        let samples: Vec<f32> = (0..3 * 16000).map(|i| (i % 101) as f32 / 101.0).collect();
        let source = rodio::buffer::SamplesBuffer::new(
            rodio::ChannelCount::new(1).unwrap(), rodio::SampleRate::new(16000).unwrap(), samples,
        );
        let chunk = extract(source, 0, Arc::new(Cancellation::default())).unwrap();
        let wav = chunk.window_wav(1000, 2100).unwrap();
        assert_eq!(&wav[44..], &chunk.wav[44 + 32000..44 + 67200]);
        let decoder = rodio::Decoder::try_from(Cursor::new(wav)).unwrap();
        assert_eq!(decoder.channels().get(), 1);
        assert_eq!(decoder.sample_rate().get(), 16000);
        assert_eq!(decoder.count(), 17600);
        assert!(chunk.window_wav(-1, 100).is_err());
        assert!(chunk.window_wav(1000, 1000).is_err());
        assert!(chunk.window_wav(2000, 4000).is_err());
    }
    #[test]
    fn short_decode_preserves_absolute_time_and_real_end() {
        let source = rodio::buffer::SamplesBuffer::new(rodio::ChannelCount::new(1).unwrap(), rodio::SampleRate::new(16000).unwrap(), vec![0.25; 47 * 16000]);
        let chunk = extract_range(source, 39000, 61000, Arc::new(Cancellation::default())).unwrap();
        assert_eq!(chunk.start_ms, 39000);
        assert_eq!(chunk.end_ms, 47000);
        assert_eq!(chunk.duration_ms, 47000);
        assert_eq!(chunk.wav.len(), 44 + 8000 * 32);
    }
    #[test]
    fn seek_and_resample_preserve_absolute_time() {
        let samples = vec![0.2_f32; 310 * 8000];
        let source = rodio::buffer::SamplesBuffer::new(
            rodio::ChannelCount::new(1).unwrap(),
            rodio::SampleRate::new(8000).unwrap(),
            samples,
        );
        let result = extract(source, 1, Arc::new(Cancellation::default())).unwrap();
        assert_eq!(result.start_ms, 298000);
        assert!((result.end_ms - 310000).abs() <= 1);
        assert_eq!(result.duration_ms, result.end_ms);
        assert!(result.wav.len() < 25 * 1024 * 1024);
    }
    #[test]
    fn transcript_chunks_have_no_context_overlap() {
        let source = || rodio::buffer::SamplesBuffer::new(
            rodio::ChannelCount::new(1).unwrap(),
            rodio::SampleRate::new(8000).unwrap(),
            vec![0.2_f32; 310 * 8000],
        );
        let first = extract_with_overlap(source(), 0, Arc::new(Cancellation::default()), 0).unwrap();
        let second = extract_with_overlap(source(), 1, Arc::new(Cancellation::default()), 0).unwrap();
        assert_eq!(first.start_ms, 0);
        assert_eq!(first.end_ms, 300000);
        assert_eq!(second.start_ms, first.end_ms);
        assert!((second.end_ms - 310000).abs() <= 1);
    }
    #[test]
    fn speech_in_right_channel_survives_mono_conversion() {
        let source = rodio::buffer::SamplesBuffer::new(
            rodio::ChannelCount::new(2).unwrap(),
            rodio::SampleRate::new(16000).unwrap(),
            [0.0_f32, 0.8].repeat(16000),
        );
        let result = extract(source, 0, Arc::new(Cancellation::default())).unwrap();
        let decoded = rodio::Decoder::try_from(Cursor::new(result.wav)).unwrap();
        let peak = decoded.fold(0.0_f32, |max, sample| max.max(sample.abs()));
        assert!(peak > 0.39, "右侧嘉宾不能被丢弃");
    }
}
