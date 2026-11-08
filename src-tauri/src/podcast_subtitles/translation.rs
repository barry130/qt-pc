//! Lightweight dedicated translation, installed on explicit request; no service or system Python.
use super::{audio::Cancellation, install::{self, Asset, Staging}};
use serde::Serialize;
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}, process::{Command, Stdio}, sync::{Arc, Mutex, OnceLock}, time::{Duration, Instant}};
use tauri::AppHandle;

const VERSION: &str = "argos-en-zh-1.9-ct2-4.8.5";
const WORKER: &str = include_str!("translate_worker.py");
const ASSETS: [Asset; 6] = [
    Asset { name: "python.zip", url: "https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip", bytes: 11_249_023, sha256: "009d6bf7e3b2ddca3d784fa09f90fe54336d5b60f0e0f305c37f400bf83cfd3b" },
    Asset { name: "ctranslate2.whl", url: "https://files.pythonhosted.org/packages/46/ff/e49f8d0b32c855e50a0995d4d0babe49b804fd8636f120738daa145a0737/ctranslate2-4.8.5-cp311-cp311-win_amd64.whl", bytes: 20_405_543, sha256: "cb918ee10fd228c2aa2a5fde3e62999a4617cb11dae51644d5286a1b6d6783dd" },
    Asset { name: "sentencepiece.whl", url: "https://files.pythonhosted.org/packages/c1/ed/8c25ed68a0e9380813f880b0bc3d986f232191e0989d035253c8deb8cfbf/sentencepiece-0.2.3-cp311-cp311-win_amd64.whl", bytes: 1_653_925, sha256: "a01e76cf49a0c1abc527c4e5fd6d3a87a3139a1d3ad2d5761567179a70805cce" },
    Asset { name: "numpy.whl", url: "https://files.pythonhosted.org/packages/aa/44/9fe81ae1dcc29c531843852e2874080dc441338574ccc4306b39e2ff6e59/numpy-2.3.5-cp311-cp311-win_amd64.whl", bytes: 13_078_442, sha256: "a414504bef8945eae5f2d7cb7be2d4af77c5d1cb5e20b296c2c25b61dff2900c" },
    Asset { name: "pyyaml.whl", url: "https://files.pythonhosted.org/packages/da/e3/ea007450a105ae919a72393cb06f122f288ef60bba2dc64b26e2646fa315/pyyaml-6.0.3-cp311-cp311-win_amd64.whl", bytes: 158_763, sha256: "9f3bfb4965eb874431221a3ff3fdcddc7e74e3b07799e0e84ca4a0f867d449bf" },
    Asset { name: "translate-en_zh-1_9.argosmodel", url: "https://argos-net.com/v1/translate-en_zh-1_9.argosmodel", bytes: 70_743_021, sha256: "433e7c4f034d87fbe2353161e05f18646d7999452f801a4e1f0378522b9850ab" },
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationStatus { supported: bool, ready: bool, bytes: u64, problem: String, progress: Option<Progress> }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress { id: String, running: bool, label: String, downloaded_bytes: u64, total_bytes: u64, error: String }
struct Job { progress: Progress, cancel: Arc<Cancellation> }
fn job() -> &'static Mutex<Option<Job>> { static JOB: OnceLock<Mutex<Option<Job>>> = OnceLock::new(); JOB.get_or_init(Mutex::default) }
fn root(app: &AppHandle) -> PathBuf { crate::app_paths::data_root(app).join("offline-translate") }
fn installed(root: &Path) -> Result<PathBuf, String> {
    let directory = root.join(VERSION);
    for name in ["ready", "runtime/python.exe", "runtime/worker.py", "runtime/ctranslate2/__init__.py", "translate-en_zh-1_9/sentencepiece.model", "translate-en_zh-1_9/model/model.bin"] {
        if !directory.join(name).is_file() { return Err("请先下载英译中模型与运行组件".into()); }
    }
    Ok(directory)
}
#[tauri::command(rename = "podcast_translation_status")]
pub fn cmd_podcast_translation_status(app: AppHandle) -> TranslationStatus {
    let result = installed(&root(&app));
    TranslationStatus { supported: cfg!(all(windows, target_arch = "x86_64")), ready: result.is_ok(), bytes: ASSETS.iter().map(|a| a.bytes).sum(), problem: result.err().unwrap_or_default(), progress: job().lock().unwrap_or_else(|p| p.into_inner()).as_ref().map(|j| j.progress.clone()) }
}
#[tauri::command(rename = "podcast_translation_install_cancel")]
pub fn cmd_podcast_translation_install_cancel(job_id: String) {
    if let Some(j) = job().lock().unwrap_or_else(|p| p.into_inner()).as_mut().filter(|j| j.progress.id == job_id && j.progress.running) {
        j.cancel.cancel(); j.progress.label = "正在取消下载…".into();
    }
}
#[tauri::command(rename = "podcast_translation_install")]
pub async fn cmd_podcast_translation_install(app: AppHandle) -> Result<(), String> {
    if !cfg!(all(windows, target_arch = "x86_64")) { return Err("轻量本地翻译目前支持 Windows x64".into()); }
    let root = root(&app);
    let cancel = Arc::new(Cancellation::default());
    let id = format!("{:016x}", fastrand::u64(..));
    {
        let mut guard = job().lock().unwrap_or_else(|p| p.into_inner());
        if guard.as_ref().is_some_and(|j| j.progress.running) { return Err("翻译模型正在下载".into()); }
        *guard = Some(Job { progress: Progress { id: id.clone(), running: true, label: "正在准备本地翻译…".into(), downloaded_bytes: 0, total_bytes: ASSETS.iter().map(|a| a.bytes).sum(), error: String::new() }, cancel: cancel.clone() });
    }
    tauri::async_runtime::spawn(async move {
        let result = install_runtime(&root, cancel.clone(), |label, downloaded| {
            if let Some(j) = job().lock().unwrap_or_else(|p| p.into_inner()).as_mut().filter(|j| j.progress.id == id) {
                j.progress.label = label; j.progress.downloaded_bytes = downloaded;
            }
        }).await;
        if let Some(j) = job().lock().unwrap_or_else(|p| p.into_inner()).as_mut().filter(|j| j.progress.id == id) {
            j.progress.running = false;
            match result {
                Ok(_) => j.progress.label = "英译中模型已就绪，可以离线翻译".into(),
                Err(_) if cancel.check().is_err() => j.progress.label = "已取消，完整下载的文件可复用".into(),
                Err(e) => { j.progress.label = "下载或安装失败，可重试".into(); j.progress.error = e; }
            }
        }
    });
    Ok(())
}

async fn install_runtime(root: &Path, cancel: Arc<Cancellation>, update: impl Fn(String, u64)) -> Result<PathBuf, String> {
    if let Ok(path) = installed(root) { return Ok(path); }
    let stage = Staging::new(root)?;
    let destination = stage.path.join("package");
    fs::create_dir(&destination).map_err(|_| "无法创建翻译目录")?;
    let mut completed = 0;
    for (index, asset) in ASSETS.iter().copied().enumerate() {
        let cached = root.join(format!("{}-{}", &asset.sha256[..16], asset.name));
        let check = cached.clone(); let stop = cancel.clone();
        let valid = tokio::task::spawn_blocking(move || install::verify(&check, asset, &stop)).await.map_err(|_| "校验失败")??;
        let source = if valid { cached } else {
            let part = stage.path.join(asset.name);
            install::download(asset, &part, &cancel, |bytes| update(format!("正在下载本地翻译（{}/{}）…", index + 1, ASSETS.len()), completed + bytes)).await?;
            // Do not overwrite files that might still be in use.
            if !cached.exists() { fs::rename(&part, &cached).map_err(|_| "保存翻译下载失败")?; cached } else { part }
        };
        completed += asset.bytes;
        update(format!("正在校验并解压（{}/{}）…", index + 1, ASSETS.len()), completed);
        let output = if index == 5 { destination.clone() } else { destination.join("runtime") };
        let stop = cancel.clone();
        tokio::task::spawn_blocking(move || extract_archive(&source, &output, &stop)).await.map_err(|_| "解压任务失败")??;
    }
    fs::write(destination.join("runtime/python311._pth"), "python311.zip\n.\nimport site\n").map_err(|_| "无法配置翻译运行环境")?;
    fs::write(destination.join("runtime/worker.py"), WORKER).map_err(|_| "无法配置翻译引擎")?;
    // Exercise both tokenizer and native DLLs before declaring installation ready.
    let check_dir = destination.clone(); let check_cancel = cancel.clone();
    let test = tokio::task::spawn_blocking(move || translate_at(&check_dir, r#"[{"id":0,"text":"Hello, world."}]"#, check_cancel)).await.map_err(|_| "翻译引擎检测失败")??;
    super::commands::parse_translations(&test, &[0])?;
    cancel.check()?;
    fs::write(destination.join("ready"), VERSION).map_err(|_| "无法保存翻译状态")?;
    let final_dir = root.join(VERSION);
    if final_dir.exists() { return Err("已安装的翻译组件不完整，请关闭应用后移走 offline-translate 中的版本目录再重试".into()); }
    fs::rename(destination, &final_dir).map_err(|_| "无法保存翻译组件")?;
    Ok(final_dir)
}

fn extract_archive(archive: &Path, output: &Path, cancel: &Cancellation) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(fs::File::open(archive).map_err(|_| "读取翻译压缩包失败")?).map_err(|_| "翻译压缩包无效")?;
    if zip.len() > 6000 { return Err("翻译压缩包文件过多".into()); }
    let mut total = 0u64;
    let mut names = std::collections::HashSet::new();
    for i in 0..zip.len() {
        cancel.check()?;
        let mut file = zip.by_index(i).map_err(|_| "读取翻译组件失败")?;
        let name = file.name().map_err(|_| "读取翻译组件失败")?.into_owned();
        if name.contains(['\\', ':']) || name.split('/').any(|part| part == ".." || part == ".") || file.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
            return Err("翻译压缩包包含不安全路径".into());
        }
        let relative = file.enclosed_name().ok_or("翻译组件路径无效")?;
        if !names.insert(name.to_lowercase()) { return Err("翻译压缩包包含重复文件".into()); }
        total += file.size();
        if file.size() > 200 * 1024 * 1024 || total > 512 * 1024 * 1024 { return Err("翻译组件解压大小超过上限".into()); }
        let path = output.join(relative);
        if file.is_dir() { fs::create_dir_all(path).map_err(|_| "创建翻译目录失败")?; continue; }
        fs::create_dir_all(path.parent().ok_or("组件目录无效")?).map_err(|_| "创建翻译目录失败")?;
        let mut writer = fs::OpenOptions::new().create_new(true).write(true).open(path).map_err(|_| "写入翻译组件失败")?;
        let mut buffer = [0u8; 65536];
        loop {
            cancel.check()?;
            let n = file.read(&mut buffer).map_err(|_| "解压翻译组件失败")?;
            if n == 0 { break; }
            writer.write_all(&buffer[..n]).map_err(|_| "保存翻译组件失败")?;
        }
    }
    Ok(())
}

pub(super) fn translate(app: &AppHandle, input: &str, cancel: Arc<Cancellation>) -> Result<String, String> {
    translate_at(&installed(&root(app))?, input, cancel)
}
fn translate_at(directory: &Path, input: &str, cancel: Arc<Cancellation>) -> Result<String, String> {
    cancel.check()?;
    if input.len() > 24_000 { return Err("本批字幕过长".into()); }
    let work = Staging::new(directory)?;
    let input_path = work.path.join("input.json");
    let output_path = work.path.join("output.json");
    fs::write(&input_path, input).map_err(|_| "写入待翻译字幕失败")?;
    let mut command = Command::new(directory.join("runtime/python.exe"));
    command.arg("-I").arg(directory.join("runtime/worker.py")).arg("--model").arg(directory.join("translate-en_zh-1_9"))
        .arg("--input").arg(input_path).arg("--output").arg(&output_path)
        .current_dir(directory.join("runtime")).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x0800_0000); }
    let mut child = super::offline::OwnedChild(command.spawn().map_err(|_| "无法启动轻量翻译引擎，请重新下载组件")?);
    let started = Instant::now();
    loop {
        cancel.check()?;
        match child.0.try_wait().map_err(|_| "读取翻译进程失败")? {
            Some(status) if status.success() => break,
            Some(_) => return Err("本地翻译失败，原文已保留；请检查组件完整性或减少待翻译内容".into()),
            None => {}
        }
        if started.elapsed() > Duration::from_secs(60) { return Err("本批本地翻译超过 60 秒，已停止并保留完成的译文".into()); }
        std::thread::sleep(Duration::from_millis(30));
    }
    cancel.check()?;
    let file = fs::File::open(&output_path).map_err(|_| "本地翻译未生成结果")?;
    let mut text = String::new();
    file.take(512 * 1024 + 1).read_to_string(&mut text).map_err(|_| "无法读取本地译文")?;
    if text.len() > 512 * 1024 { return Err("译文超过大小上限".into()); }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn translation_archive_rejects_traversal_symlinks_and_duplicate_files() {
        let root = crate::public_test_fixture::root().join(format!("translate-archive-{:016x}", fastrand::u64(..)));
        fs::create_dir(&root).unwrap();
        for (index, name) in ["../outside.txt", "C:/outside.txt", "folder\\outside.txt"].iter().enumerate() {
            let path = root.join(format!("bad-{index}.zip"));
            let mut writer = zip::ZipWriter::new(fs::File::create(&path).unwrap());
            writer.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            writer.write_all(b"data").unwrap(); writer.finish().unwrap();
            assert!(extract_archive(&path, &root.join(format!("out-{index}")), &Cancellation::default()).is_err());
        }
        let path = root.join("valid.zip");
        let mut writer = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        writer.start_file("nested/model.bin", zip::write::SimpleFileOptions::default()).unwrap();
        writer.write_all(b"model-data").unwrap(); writer.finish().unwrap();
        extract_archive(&path, &root.join("out"), &Cancellation::default()).unwrap();
        assert_eq!(fs::read(root.join("out/nested/model.bin")).unwrap(), b"model-data");
        assert!(extract_archive(&path, &root.join("out"), &Cancellation::default()).is_err());
        let stop = Cancellation::default(); stop.cancel();
        assert!(extract_archive(&path, &root.join("cancelled"), &stop).unwrap_err().contains("取消"));
        assert!(!root.join("cancelled").exists());
    }
    /// 中央目录（CDFH）与本地头（LFH）声明不同文件名的「双头」归档：解压只认中央目录，
    /// 本地头里的路径绝不能被写到磁盘，越界路径更不能逃出输出目录。
    #[test]
    fn dual_header_names_cannot_redirect_extraction() {
        let root = crate::public_test_fixture::root()
            .join(format!("translate-dual-{:016x}", fastrand::u64(..)));
        fs::create_dir(&root).unwrap();
        // 等长替换，避免改动归档里其它字段的偏移。
        let benign = b"payload.txt";
        let hostile = b"../escape.t";
        assert_eq!(benign.len(), hostile.len());
        let path = root.join("dual.zip");
        let mut writer = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        writer
            .start_file("payload.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"data").unwrap();
        writer.finish().unwrap();
        let mut bytes = fs::read(&path).unwrap();
        let lfh = bytes
            .windows(4)
            .position(|window| window == b"PK\x03\x04")
            .expect("local file header");
        assert_eq!(&bytes[lfh + 30..lfh + 30 + benign.len()], benign);
        bytes[lfh + 30..lfh + 30 + hostile.len()].copy_from_slice(hostile);
        fs::write(&path, &bytes).unwrap();
        let output = root.join("out");
        let result = extract_archive(&path, &output, &Cancellation::default());
        // 允许新版 zip 直接拒绝该归档；无论如何本地头声明的路径都不得落盘。
        assert!(
            !root.join("escape.t").exists(),
            "local header name must never be extracted"
        );
        if result.is_ok() {
            assert_eq!(fs::read(output.join("payload.txt")).unwrap(), b"data");
        }
    }
    #[test]
    #[ignore = "explicit offline translation download and native inference"]
    fn translation_real_smoke() {
        let root = PathBuf::from(std::env::var_os("QT_TRANSLATE_TEST_ROOT").expect("explicit translation fixture"));
        let cancel = Arc::new(Cancellation::default());
        let rt = tokio::runtime::Runtime::new().unwrap();
        let directory = rt.block_on(install_runtime(&root, cancel.clone(), |label, size| println!("{label} {size}"))).unwrap();
        let started = Instant::now();
        let reply = translate_at(&directory, r#"[{"id":2,"text":"Welcome to today's daily tech briefing."},{"id":5,"text":"Elon Musk outlines ambitious plans for SpaceX to build massive orbital data centers."},{"id":8,"text":"欢迎收听今天的播客。"}]"#, cancel.clone()).unwrap();
        let result = super::super::commands::parse_translations(&reply, &[2, 5, 8]).unwrap();
        assert!(result[0].1.contains('今'));
        assert_eq!(result[2].1, "欢迎收听今天的播客。");
        assert!(!reply.contains('▁'));
        println!("{}", serde_json::json!({ "elapsedMs": started.elapsed().as_millis(), "translations": result }));
        cancel.cancel();
        assert!(translate_at(&directory, "[]", cancel).unwrap_err().contains("取消"));
    }
}
