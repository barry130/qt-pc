//! Explicit, managed installation of pinned official whisper.cpp assets.
//! No model-supplied URLs, shell commands, or executable downloads at startup.
use super::{audio::Cancellation, offline};
use crate::AppState;
use ring::digest::{Context, SHA256};
use serde::Serialize;
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, State};
use tokio::io::AsyncWriteExt;

const ENGINE: Asset = Asset {
    name: "whisper-bin-x64.zip",
    url: "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip",
    bytes: 8_928_640,
    sha256: "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb",
};
#[derive(Clone, Copy)]
pub(super) struct Asset {
    pub name: &'static str,
    pub url: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}
// Model repository revision 5359861c739e955e79d9a303bcbc70fb988958b1; LFS SHA-256.
const MODELS: [(&str, &str, Asset); 3] = [
    ("tiny", "tiny · 轻量快速", Asset { name: "ggml-tiny.bin", url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.bin", bytes: 77_691_713, sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21" }),
    ("base", "base · 推荐", Asset { name: "ggml-base.bin", url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin", bytes: 147_951_465, sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe" }),
    ("small", "small · 更准确，较慢", Asset { name: "ggml-small.bin", url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.bin", bytes: 487_601_967, sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b" }),
];
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadModel {
    id: &'static str,
    label: &'static str,
    bytes: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadCatalog {
    supported: bool,
    engine_bytes: u64,
    models: Vec<DownloadModel>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    id: String,
    model_id: String,
    running: bool,
    phase: String,
    label: String,
    downloaded_bytes: u64,
    total_bytes: u64,
    error: String,
}
struct InstallJob {
    progress: InstallProgress,
    cancel: Arc<Cancellation>,
}
fn job() -> &'static Mutex<Option<InstallJob>> {
    static JOB: OnceLock<Mutex<Option<InstallJob>>> = OnceLock::new();
    JOB.get_or_init(Mutex::default)
}
pub(super) fn with_idle<T>(work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let guard = job().lock().unwrap_or_else(|p| p.into_inner());
    if guard.as_ref().is_some_and(|j| j.progress.running) {
        return Err("正在安装离线识别，请等待完成或取消".into());
    }
    work()
}
fn progress(id: &str, phase: &str, label: &str, downloaded: u64, total: u64) {
    let mut guard = job().lock().unwrap_or_else(|p| p.into_inner());
    if let Some(j) = guard.as_mut().filter(|j| j.progress.id == id) {
        j.progress.phase = phase.into();
        j.progress.label = label.into();
        j.progress.downloaded_bytes = downloaded;
        j.progress.total_bytes = total;
    }
}
#[tauri::command(rename = "podcast_whisper_catalog")]
pub fn cmd_podcast_whisper_catalog() -> DownloadCatalog {
    DownloadCatalog {
        supported: cfg!(all(windows, target_arch = "x86_64")),
        engine_bytes: ENGINE.bytes,
        models: MODELS
            .iter()
            .map(|(id, label, a)| DownloadModel {
                id,
                label,
                bytes: a.bytes,
            })
            .collect(),
    }
}
#[tauri::command(rename = "podcast_whisper_install_progress")]
pub fn cmd_podcast_whisper_install_progress() -> Option<InstallProgress> {
    job()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(|j| j.progress.clone())
}
#[tauri::command(rename = "podcast_whisper_install_cancel")]
pub fn cmd_podcast_whisper_install_cancel(job_id: String) {
    let mut guard = job().lock().unwrap_or_else(|p| p.into_inner());
    if let Some(j) = guard
        .as_mut()
        .filter(|j| j.progress.id == job_id && j.progress.running)
    {
        j.cancel.cancel();
        j.progress.label = "正在取消下载…".into();
    }
}
#[tauri::command(rename = "podcast_whisper_install")]
pub async fn cmd_podcast_whisper_install(
    app: AppHandle,
    state: State<'_, AppState>,
    model_id: String,
) -> Result<InstallProgress, String> {
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return Err("自动安装目前支持 Windows x64；此系统请手动选择引擎与模型".into());
    }
    let asset = MODELS
        .iter()
        .find(|(id, _, _)| *id == model_id)
        .map(|(_, _, a)| *a)
        .ok_or("不支持的模型")?;
    let db = state.db.as_ref().ok_or("数据库不可用")?.clone();
    let root = crate::app_paths::data_root(&app).join("offline-whisper");
    let cancel = Arc::new(Cancellation::default());
    let initial = InstallProgress {
        id: format!("{:016x}", fastrand::u64(..)),
        model_id,
        running: true,
        phase: "prepare".into(),
        label: "正在检查已下载文件…".into(),
        downloaded_bytes: 0,
        total_bytes: 0,
        error: String::new(),
    };
    {
        let mut guard = job().lock().unwrap_or_else(|p| p.into_inner());
        if guard.as_ref().is_some_and(|j| j.progress.running) {
            return Err("已有离线模型正在下载".into());
        }
        *guard = Some(InstallJob {
            progress: initial.clone(),
            cancel: cancel.clone(),
        });
    }
    let id = initial.id.clone();
    tauri::async_runtime::spawn(async move {
        let result = install(&root, asset, &cancel, &id).await;
        // Serialize cancellation/configuration: cancellation never activates partial assets.
        let mut guard = job().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(j) = guard.as_mut().filter(|j| j.progress.id == id) {
            let result = result.and_then(|(engine, model)| {
                cancel.check()?;
                offline::configure_install(&db, &engine, &model)
            });
            j.progress.running = false;
            match result {
                Ok(()) => {
                    j.progress.phase = "done".into();
                    j.progress.label = "安装完成，已自动配置引擎和模型".into();
                }
                Err(_) if cancel.check().is_err() => {
                    j.progress.phase = "cancelled".into();
                    j.progress.label = "已取消；完整下载的文件已保留，重试可复用".into();
                }
                Err(e) => {
                    j.progress.phase = "error".into();
                    j.progress.label = "下载或安装失败，可重试".into();
                    j.progress.error = e;
                }
            }
        }
    });
    Ok(initial)
}

/// Only this job's exclusively created directory is ever recursively removed.
pub(super) struct Staging {
    pub path: PathBuf,
    parent: PathBuf,
}
impl Staging {
    pub(super) fn new(root: &Path) -> Result<Self, String> {
        fs::create_dir_all(root).map_err(|_| "无法创建离线模型目录，请检查磁盘空间和权限")?;
        let parent = root.canonicalize().map_err(|_| "无法访问离线模型目录")?;
        let path = parent.join(format!(".install-{:016x}", fastrand::u64(..)));
        fs::create_dir(&path).map_err(|_| "无法创建下载临时目录")?;
        Ok(Self { path, parent })
    }
}
impl Drop for Staging {
    fn drop(&mut self) {
        if self.path.parent() == Some(self.parent.as_path())
            && self.path.canonicalize().is_ok_and(|p| p == self.path)
        {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
pub(super) fn verify(path: &Path, asset: Asset, cancel: &Cancellation) -> Result<bool, String> {
    cancel.check()?;
    let Ok(mut file) = File::open(path) else {
        return Ok(false);
    };
    if file.metadata().map_err(|_| "无法检查下载文件")?.len() != asset.bytes {
        return Ok(false);
    }
    let mut hash = Context::new(&SHA256);
    let mut buffer = [0u8; 128 * 1024];
    loop {
        cancel.check()?;
        let n = file.read(&mut buffer).map_err(|_| "无法读取下载文件")?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(hex(hash.finish().as_ref()) == asset.sha256)
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
async fn asset_file(
    root: &Path,
    stage: &Path,
    asset: Asset,
    cancel: &Arc<Cancellation>,
    id: &str,
    phase: &str,
) -> Result<PathBuf, String> {
    let final_path = root.join(format!("{}-{}", &asset.sha256[..16], asset.name));
    let checked = final_path.clone();
    let stop = cancel.clone();
    progress(id, "verify", "正在校验本地文件…", 0, 0);
    if tokio::task::spawn_blocking(move || verify(&checked, asset, &stop))
        .await
        .map_err(|_| "文件校验任务失败")??
    {
        return Ok(final_path);
    }
    let part = stage.join(asset.name);
    progress(
        id,
        phase,
        if phase == "engine" {
            "正在下载识别引擎…"
        } else {
            "正在下载语音模型…"
        },
        0,
        asset.bytes,
    );
    download(asset, &part, cancel, |bytes| {
        progress(
            id,
            phase,
            if phase == "engine" {
                "正在下载识别引擎…"
            } else {
                "正在下载语音模型…"
            },
            bytes,
            asset.bytes,
        )
    })
    .await?;
    cancel.check()?;
    // A corrupt old asset is never removed in case it is still in use by a recognizer.
    let final_path = if final_path.exists() {
        root.join(format!("{:016x}-{}", fastrand::u64(..), asset.name))
    } else {
        final_path
    };
    tokio::fs::rename(&part, &final_path)
        .await
        .map_err(|_| "无法保存下载文件，请检查磁盘空间和权限")?;
    Ok(final_path)
}
pub(super) async fn download(
    asset: Asset,
    part: &Path,
    cancel: &Cancellation,
    update: impl Fn(u64),
) -> Result<(), String> {
    cancel.check()?;
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(part)
        .await
        .map_err(|_| "无法创建下载文件")?;
    let work = async {
        let client = crate::net_config::configure(reqwest::Client::builder())
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(3600))
            .read_timeout(Duration::from_secs(45))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 8
                    || attempt.url().scheme() != "https"
                    || crate::net_guard::ensure_public_http_url(attempt.url().as_str()).is_err()
                {
                    attempt.error("不支持的下载重定向")
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .map_err(|_| "下载客户端初始化失败")?;
        let mut response = client
            .get(asset.url)
            .send()
            .await
            .map_err(|_| "连接官方下载源失败，请检查网络或「设置 → 网络」代理后重试")?;
        if !response.status().is_success() {
            return Err(format!(
                "官方下载返回 HTTP {}，请稍后重试",
                response.status().as_u16()
            ));
        }
        if response.content_length().is_some_and(|n| n != asset.bytes) {
            return Err("下载文件大小与官方记录不符".into());
        }
        let mut bytes = 0;
        let mut hash = Context::new(&SHA256);
        let mut last = Instant::now();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "下载中断或超过 45 秒未收到数据，请检查网络后重试")?
        {
            cancel.check()?;
            bytes += chunk.len() as u64;
            if bytes > asset.bytes {
                return Err("下载文件超过预期大小".into());
            }
            file.write_all(&chunk)
                .await
                .map_err(|_| "下载写入失败，请检查磁盘空间")?;
            hash.update(&chunk);
            if last.elapsed() >= Duration::from_millis(200) {
                update(bytes);
                last = Instant::now();
            }
        }
        if bytes != asset.bytes || hex(hash.finish().as_ref()) != asset.sha256 {
            return Err("下载文件 SHA-256 校验失败，请重试".into());
        }
        file.sync_all().await.map_err(|_| "下载文件保存失败")?;
        update(bytes);
        Ok(())
    };
    let result = tokio::select! { r = work => r, _ = cancel.wait() => Err("已取消".into()) };
    drop(file);
    if result.is_err() {
        let _ = tokio::fs::remove_file(part).await;
    }
    result
}

/// Flat allowlist under Release: retain the CLI and its DLLs; reject unsafe entries.
fn engine_entries(
    archive: &Path,
    output: &Path,
    cancel: &Cancellation,
    extract: bool,
) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(File::open(archive).map_err(|_| "无法读取引擎压缩包")?)
        .map_err(|_| "引擎压缩包无效")?;
    if zip.len() > 256 {
        return Err("引擎压缩包文件过多".into());
    }
    let mut total = 0;
    let mut names = std::collections::HashSet::new();
    for i in 0..zip.len() {
        cancel.check()?;
        let mut item = zip.by_index(i).map_err(|_| "无法读取引擎压缩包内容")?;
        // zip 9.x 起 name() 返回 Result<Cow<str>>：中央目录名读取/解码失败不再被静默忽略。
        let name = item.name().map_err(|_| "无法读取引擎压缩包内容")?.into_owned();
        if name.contains('\\')
            || name.contains(':')
            || name.split('/').any(|p| p == ".." || p == ".")
            || item.enclosed_name().is_none()
            || item.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
        {
            return Err("引擎压缩包包含不安全路径".into());
        }
        if item.is_dir() {
            continue;
        }
        let Some(base) = name.strip_prefix("Release/") else {
            return Err("引擎压缩包目录结构不匹配".into());
        };
        if base.is_empty()
            || !base
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        {
            return Err("引擎文件名称无效".into());
        }
        if base != "whisper-cli.exe" && !base.ends_with(".dll") {
            continue;
        }
        if !names.insert(base.to_ascii_lowercase()) {
            return Err("引擎压缩包包含重复文件".into());
        }
        total += item.size();
        if item.size() > 16 * 1024 * 1024 || total > 64 * 1024 * 1024 {
            return Err("引擎解压大小超过上限".into());
        }
        let mut bytes = Vec::new();
        (&mut item)
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "引擎解压校验失败")?;
        if bytes.len() as u64 != item.size() {
            return Err("引擎解压长度不匹配".into());
        }
        let target = output.join(base);
        if extract {
            File::options()
                .write(true)
                .create_new(true)
                .open(&target)
                .and_then(|mut f| {
                    f.write_all(&bytes)?;
                    f.sync_all()
                })
                .map_err(|_| "引擎解压写入失败")?;
        } else {
            if fs::symlink_metadata(&target).is_err()
                || fs::symlink_metadata(&target).is_ok_and(|m| m.file_type().is_symlink())
            {
                return Err("已安装引擎文件需要修复".into());
            }
            let mut existing = File::open(target).map_err(|_| "已安装引擎文件缺失")?;
            if existing.metadata().map_err(|_| "无法检查引擎")?.len() != bytes.len() as u64 {
                return Err("引擎文件需要修复".into());
            }
            let mut saved = Vec::new();
            existing
                .read_to_end(&mut saved)
                .map_err(|_| "无法读取引擎")?;
            if saved != bytes {
                return Err("引擎文件校验失败".into());
            }
        }
    }
    if ![
        "whisper-cli.exe",
        "whisper.dll",
        "ggml.dll",
        "ggml-base.dll",
    ]
    .iter()
    .all(|n| names.contains(*n))
    {
        return Err("引擎压缩包缺少必要文件".into());
    }
    Ok(())
}
async fn install(
    root: &Path,
    model: Asset,
    cancel: &Arc<Cancellation>,
    id: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let stage = Staging::new(root)?;
    let archive = asset_file(&stage.parent, &stage.path, ENGINE, cancel, id, "engine").await?;
    let model = asset_file(&stage.parent, &stage.path, model, cancel, id, "model").await?;
    progress(id, "install", "正在校验并安装引擎…", 0, 0);
    let engine_dir = stage.parent.join("engine-b5454");
    let stop = cancel.clone();
    // The blocking worker owns staging so cancellation never deletes a directory in use.
    tokio::task::spawn_blocking(move || {
        stop.check()?;
        if engine_entries(&archive, &engine_dir, &stop, false).is_ok() {
            return Ok((engine_dir.join("whisper-cli.exe"), model));
        }
        stop.check()?;
        let temp_engine = stage.path.join("engine");
        fs::create_dir(&temp_engine).map_err(|_| "无法创建引擎目录")?;
        engine_entries(&archive, &temp_engine, &stop, true)?;
        stop.check()?;
        let engine_dir = if engine_dir.exists() {
            stage
                .parent
                .join(format!("engine-b5454-{:016x}", fastrand::u64(..)))
        } else {
            engine_dir
        };
        fs::rename(&temp_engine, &engine_dir).map_err(|_| "无法保存引擎文件")?;
        Ok((engine_dir.join("whisper-cli.exe"), model))
    })
    .await
    .map_err(|_| "引擎安装任务失败")?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Staging {
        Staging::new(crate::public_test_fixture::root()).unwrap()
    }
    fn archive(root: &Path, extra: Option<&str>) -> PathBuf {
        let path = root.join("fixture.zip");
        let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
        for name in [
            "Release/whisper-cli.exe",
            "Release/whisper.dll",
            "Release/ggml.dll",
            "Release/ggml-base.dll",
            "Release/unused.exe",
        ]
        .into_iter()
        .chain(extra)
        {
            zip.start_file(
                name,
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
            zip.write_all(b"fixture data").unwrap();
        }
        zip.finish().unwrap();
        path
    }
    #[test]
    fn extraction_retains_dependencies_detects_tampering_and_rejects_traversal() {
        let stage = fixture();
        let output = stage.path.join("engine");
        fs::create_dir(&output).unwrap();
        let zip = archive(&stage.path, None);
        let cancel = Cancellation::default();
        engine_entries(&zip, &output, &cancel, true).unwrap();
        engine_entries(&zip, &output, &cancel, false).unwrap();
        assert!(!output.join("unused.exe").exists());
        fs::write(output.join("ggml.dll"), b"tampered").unwrap();
        assert!(engine_entries(&zip, &output, &cancel, false).is_err());
        fs::write(output.join("ggml.dll"), b"fixture data").unwrap();
        for unsafe_name in [
            "../escape.dll",
            "Release/../escape.dll",
            "Release/escape.dll:stream",
            "Release/a\\escape.dll",
        ] {
            let zip = archive(&stage.path, Some(unsafe_name));
            assert!(engine_entries(&zip, &output, &cancel, false).is_err());
            assert!(!stage.parent.join("escape.dll").exists());
        }
    }
    #[test]
    fn hash_verification_and_cancelled_staging_do_not_modify_previous_configuration() {
        let stage = fixture();
        let db = crate::db::Database::open_in_memory().unwrap();
        let engine = stage.path.join(if cfg!(windows) {
            "whisper-cli.exe"
        } else {
            "whisper-cli"
        });
        let model = stage.path.join("valid.bin");
        fs::write(&engine, b"fixture").unwrap();
        let mut file = File::create(&model).unwrap();
        file.write_all(b"lmgg").unwrap();
        file.set_len(1_000_000).unwrap();
        drop(file);
        offline::configure_install(&db, &engine, &model).unwrap();
        let before = serde_json::to_value(offline::status(&db).unwrap()).unwrap();
        assert!(offline::configure_install(&db, &engine, &stage.path.join("missing.bin")).is_err());
        assert_eq!(
            before,
            serde_json::to_value(offline::status(&db).unwrap()).unwrap()
        );
        let fixture_asset = Asset {
            name: "hash.txt",
            url: "https://example.invalid/",
            bytes: 3,
            sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        };
        let hash_file = stage.path.join("hash.txt");
        fs::write(&hash_file, b"abc").unwrap();
        let cancel = Cancellation::default();
        assert!(verify(&hash_file, fixture_asset, &cancel).unwrap());
        fs::write(&hash_file, b"bad").unwrap();
        assert!(!verify(&hash_file, fixture_asset, &cancel).unwrap());
        cancel.cancel();
        assert!(verify(&hash_file, fixture_asset, &cancel).is_err());
        let temp = Staging::new(&stage.path).unwrap();
        let dir = temp.path.clone();
        fs::write(dir.join("partial.bin"), b"partial").unwrap();
        drop(temp);
        assert!(!dir.exists());
        assert!(model.exists());
        assert!(engine.exists());
    }
    #[tokio::test]
    async fn pre_cancelled_download_creates_no_file() {
        let stage = fixture();
        let part = stage.path.join("download.part");
        let cancel = Cancellation::default();
        cancel.cancel();
        assert!(download(ENGINE, &part, &cancel, |_| {}).await.is_err());
        assert!(!part.exists());
    }
    #[tokio::test]
    #[ignore = "explicit official download and speech fixture only"]
    async fn official_download_install_and_offline_recognition() {
        let source = PathBuf::from(
            std::env::var_os("QT_WHISPER_TEST_ROOT").expect("explicit public speech fixture"),
        );
        let stage = fixture();
        let cancel = Arc::new(Cancellation::default());
        let (engine, model) = install(&stage.path, MODELS[0].2, &cancel, "smoke")
            .await
            .unwrap();
        let reused = install(&stage.path, MODELS[0].2, &cancel, "smoke-reuse")
            .await
            .unwrap();
        assert_eq!(reused, (engine.clone(), model.clone()));
        let db = crate::db::Database::open_in_memory().unwrap();
        offline::configure_install(&db, &engine, &model).unwrap();
        let status = serde_json::to_value(offline::status(&db).unwrap()).unwrap();
        assert_eq!(status["ready"], true);
        let audio =
            super::super::audio::decode_chunk(&source.join("jfk.wav"), 0, cancel.clone()).unwrap();
        let cues = offline::transcribe(
            offline::runtime(&db).unwrap(),
            audio,
            "en".into(),
            4,
            false,
            stage.path.join("speech"),
            cancel,
        )
        .unwrap();
        assert!(cues
            .iter()
            .any(|cue| cue.text.to_lowercase().contains("country")));
        assert!(cues.iter().all(|cue| cue.end_ms > cue.start_ms));
        println!(
            "official engine + tiny verified; install reused; {} timestamped cues",
            cues.len()
        );
    }
}
