//! whisper.cpp CLI 通过原生选择器或校验后的官方下载配置；启动不经 shell。
use super::{
    audio::{AudioChunk, Cancellation},
    Cue,
};
use crate::{
    db::{store, Database},
    AppState,
};
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, State};

const CONFIG_KEY: &str = "native.podcastWhisper";
const MAX_OUTPUT: u64 = 4 * 1024 * 1024;

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Config {
    engine_path: String,
    model_path: String,
    cpu_only: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineStatus {
    engine_path: String,
    model_path: String,
    ready: bool,
    problem: String,
    cpu_only: bool,
}

pub(super) struct Runtime {
    engine: PathBuf,
    model: PathBuf,
    cpu_only: bool,
}

fn config(db: &Database) -> Result<Config, String> {
    let raw = db.with(|c| store::get_setting(c, CONFIG_KEY))?;
    raw.map(|value| {
        serde_json::from_str(&value)
            .map_err(|_| "本地识别设置无法读取，请重新选择引擎和模型".into())
    })
    .unwrap_or_else(|| Ok(Config::default()))
}

fn checked_file(raw: &str, name: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(format!("请先选择{name}"));
    }
    let path = path
        .canonicalize()
        .map_err(|_| format!("{name}不存在或无法访问，请重新选择"))?;
    if !path.is_file() {
        return Err(format!("{name}需要是一个文件"));
    }
    Ok(path)
}

fn engine_path(raw: &str) -> Result<PathBuf, String> {
    let path = checked_file(raw, "whisper.cpp 引擎")?;
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if !name.eq_ignore_ascii_case(if cfg!(windows) {
        "whisper-cli.exe"
    } else {
        "whisper-cli"
    }) {
        return Err("请选择解压后的 whisper-cli 引擎，保留同目录的依赖文件".into());
    }
    Ok(path)
}

fn model_path(raw: &str) -> Result<PathBuf, String> {
    let path = checked_file(raw, "Whisper 模型")?;
    let mut file = std::fs::File::open(&path).map_err(|_| "无法读取 Whisper 模型")?;
    let length = file.metadata().map_err(|_| "无法检查 Whisper 模型")?.len();
    let mut header = [0u8; 4];
    file.read_exact(&mut header).map_err(|_| "模型文件不完整")?;
    if header != *b"lmgg" || !(1_000_000..=5_000_000_000).contains(&length) {
        return Err(
            "需要 whisper.cpp 的 GGML .bin 模型，请勿选择下载网页、GGUF 或未完成的文件".into(),
        );
    }
    Ok(path)
}

pub(super) fn runtime(db: &Database) -> Result<Runtime, String> {
    let config = config(db)?;
    Ok(Runtime {
        engine: engine_path(&config.engine_path)?,
        model: model_path(&config.model_path)?,
        cpu_only: config.cpu_only,
    })
}

pub(super) fn status(db: &Database) -> Result<OfflineStatus, String> {
    let config = config(db)?;
    let result = engine_path(&config.engine_path).and_then(|_| model_path(&config.model_path));
    Ok(OfflineStatus {
        engine_path: config.engine_path,
        model_path: config.model_path,
        ready: result.is_ok(),
        problem: result.err().unwrap_or_default(),
        cpu_only: config.cpu_only,
    })
}

pub(super) fn configure_install(db: &Database, engine: &Path, model: &Path) -> Result<(), String> {
    let engine = engine_path(&format!("{}", engine.display()))?;
    let model = model_path(&format!("{}", model.display()))?;
    let json = serde_json::to_string(&Config {
        engine_path: format!("{}", engine.display()),
        model_path: format!("{}", model.display()),
        cpu_only: true,
    })
    .map_err(|_| "本地识别设置保存失败")?;
    db.with(|c| store::set_setting(c, CONFIG_KEY, &json))
}

#[tauri::command(rename = "podcast_whisper_status")]
pub async fn cmd_podcast_whisper_status(
    state: State<'_, AppState>,
) -> Result<OfflineStatus, String> {
    status(state.db.as_ref().ok_or("数据库不可用")?)
}

#[tauri::command(rename = "podcast_whisper_pick")]
pub async fn cmd_podcast_whisper_pick(
    app: AppHandle,
    state: State<'_, AppState>,
    kind: String,
) -> Result<Option<OfflineStatus>, String> {
    use tauri_plugin_dialog::DialogExt;
    super::install::with_idle(|| Ok(()))?;
    if !["engine", "model"].contains(&kind.as_str()) {
        return Err("未知的本地识别文件类型".into());
    }
    let engine = kind == "engine";
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let dialog = app.dialog().file().set_title(if engine {
            "选择 whisper-cli 引擎（保留同目录 DLL）"
        } else {
            "选择 Whisper GGML 模型（.bin）"
        });
        let dialog = if engine {
            if cfg!(windows) {
                dialog.add_filter("whisper-cli", &["exe"])
            } else {
                dialog
            }
        } else {
            dialog.add_filter("Whisper GGML", &["bin"])
        };
        dialog.blocking_pick_file()
    })
    .await
    .map_err(|_| "无法打开文件选择框")?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|_| "文件路径无效")?;
    let raw = path.to_str().ok_or("文件路径无法编码")?;
    if engine {
        engine_path(raw)?;
    } else {
        model_path(raw)?;
    }
    let db = state.db.as_ref().ok_or("数据库不可用")?;
    super::install::with_idle(|| {
        // 文件选择器打开期间可能选过另一项；回读后只修改这一项。
        let mut config = config(db)?;
        if engine {
            config.engine_path = raw.into();
            config.cpu_only = false;
        } else {
            config.model_path = raw.into();
        }
        let json = serde_json::to_string(&config).map_err(|_| "本地识别设置保存失败")?;
        db.with(|c| store::set_setting(c, CONFIG_KEY, &json))?;
        status(db).map(Some)
    })
}

/// 任务只使用私有、随机的工作文件；Drop 不递归删除任何目录。
struct WorkFiles {
    directory: PathBuf,
}
impl WorkFiles {
    fn new(root: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(root).map_err(|_| "无法创建本地识别缓存目录")?;
        let directory = root.join(format!("whisper-{:016x}", fastrand::u64(..)));
        std::fs::create_dir(&directory).map_err(|_| "无法创建本地识别工作目录")?;
        Ok(Self { directory })
    }
}
impl Drop for WorkFiles {
    fn drop(&mut self) {
        for name in ["input.wav", "result.json"] {
            let _ = std::fs::remove_file(self.directory.join(name));
        }
        let _ = std::fs::remove_dir(&self.directory);
    }
}

pub(super) struct OwnedChild(pub Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn command(
    runtime: &Runtime,
    input: &Path,
    output: &Path,
    language: &str,
    threads: u8,
    use_gpu: bool,
) -> Command {
    let mut command = Command::new(&runtime.engine);
    command
        .args(["-m"])
        .arg(&runtime.model)
        .arg("-f")
        .arg(input)
        .arg("-of")
        .arg(output)
        .args([
            "-oj",
            "-np",
            "-l",
            if language.is_empty() {
                "auto"
            } else {
                language
            },
        ])
        // 长播客的错误上下文会让小模型持续重复同一句话。
        .args(["-mc", "0"])
        .arg("-t")
        .arg(threads.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if !use_gpu || runtime.cpu_only {
        command.arg("-ng");
    }
    // DLL / 动态库从所选引擎目录解析；不修改当前应用的工作目录。
    if let Some(parent) = runtime.engine.parent() {
        command.current_dir(parent);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

fn wait(child: &mut OwnedChild, cancel: &Cancellation, timeout: Duration) -> Result<(), String> {
    let started = Instant::now();
    loop {
        cancel.check()?;
        match child.0.try_wait().map_err(|_| "无法读取本地识别进程状态")? {
            Some(status) if status.success() => return Ok(()),
            Some(status) => return Err(format!("本地识别引擎退出（{}）。请检查模型是否完整、引擎旁 DLL 是否齐全；启用加速时请尝试关闭。", status.code().map(|value| value.to_string()).unwrap_or_else(|| "异常".into()))),
            None => {}
        }
        if started.elapsed() > timeout {
            return Err("本地识别超时，已停止进程；请使用较小模型或调整线程数后重试".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

pub(super) fn transcribe(
    runtime: Runtime,
    chunk: AudioChunk,
    language: String,
    threads: u8,
    use_gpu: bool,
    root: PathBuf,
    cancel: Arc<Cancellation>,
) -> Result<Vec<Cue>, String> {
    cancel.check()?;
    let files = WorkFiles::new(&root)?;
    let duration = chunk.end_ms - chunk.start_ms;
    let options = RecognitionOptions { language: &language, threads, use_gpu };
    let result = transcribe_windows(&runtime, &chunk, &options, &files, &cancel, recognition_windows(duration));
    // A short window that straddles a language switch may produce invalid timing or
    // a loop. Retry once with fresh language detection per half; never save the bad attempt.
    if result.is_err() && duration > 10_000 && duration <= 22_000 && cancel.check().is_ok() {
        return transcribe_windows(&runtime, &chunk, &options, &files, &cancel, vec![(0, 10_000), (10_000, duration)]);
    }
    result
}

struct RecognitionOptions<'a> {
    language: &'a str,
    threads: u8,
    use_gpu: bool,
}

fn transcribe_windows(runtime: &Runtime, chunk: &AudioChunk, options: &RecognitionOptions<'_>, files: &WorkFiles, cancel: &Cancellation, windows: Vec<(i64, i64)>) -> Result<Vec<Cue>, String> {
    let input = files.directory.join("input.wav");
    let output = files.directory.join("result");
    let duration = chunk.end_ms - chunk.start_ms;
    let mut cues = Vec::new();
    for (core_start, core_end) in windows {
        cancel.check()?;
        let start = (core_start - 1000).max(0);
        let end = (core_end + 1000).min(duration);
        let wav = chunk.window_wav(start, end)?;
        std::fs::write(&input, wav).map_err(|_| "写入本地识别音频失败")?;
        // 重用文件前清除上次结果，不能把本次未产出的结果误当作成功。
        let result = files.directory.join("result.json");
        if result.exists() {
            std::fs::remove_file(&result).map_err(|_| "清理本地识别临时结果失败")?;
        }
        let window = recognize_window(runtime, &input, &output, &result, options, end - start, cancel)
            .map_err(|error| format!("{}–{} 秒：{error}", (chunk.start_ms + start) / 1000, (chunk.start_ms + end) / 1000))?;
        if has_repetition_loop(&window) {
            return Err("本地识别出现连续重复，未替换这一段字幕；请尝试 small 模型或指定节目语言后重新生成".into());
        }
        merge_window(&mut cues, window, start, core_start, core_end);
    }
    Ok(cues)
}

/// 自动语言只针对短窗口判断，避免五分钟内中英切换时把全部音频套用一种语言。
fn recognition_windows(duration_ms: i64) -> Vec<(i64, i64)> {
    let mut windows = Vec::new();
    let mut start = 0;
    while start < duration_ms {
        let mut end = (start + 20_000).min(duration_ms);
        // 过短尾段缺少上下文，合并到前窗，避免把音乐/半个词识别成正文。
        if duration_ms - end < 10_000 {
            end = duration_ms;
        }
        windows.push((start, end));
        start = end;
    }
    windows
}

fn merge_window(cues: &mut Vec<Cue>, window: Vec<Cue>, start: i64, core_start: i64, core_end: i64) {
    for mut cue in window {
        cue.start_ms += start;
        cue.end_ms += start;
        let midpoint = cue.start_ms + (cue.end_ms - cue.start_ms) / 2;
        if midpoint < core_start || midpoint >= core_end {
            continue;
        }
        // 两侧重叠上下文可能识别到同一句，只合并时间相交且正文相同的结果。
        if let Some(previous) = cues.last_mut() {
            let normalized = |text: &str| text.chars().filter(|ch| ch.is_alphanumeric()).flat_map(char::to_lowercase).collect::<String>();
            if normalized(&previous.text) == normalized(&cue.text) && previous.end_ms > cue.start_ms {
                previous.end_ms = previous.end_ms.max(cue.end_ms);
                continue;
            }
        }
        cues.push(cue);
    }
}

fn has_repetition_loop(cues: &[Cue]) -> bool {
    let mut previous = String::new();
    let mut count = 0;
    for cue in cues {
        let key: String = cue.text.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect();
        count = if key == previous { count + 1 } else { 1 };
        if count >= 4 && key.chars().count() >= 8 {
            return true;
        }
        previous = key;
    }
    false
}

fn recognize_window(
    runtime: &Runtime,
    input: &Path,
    output: &Path,
    result: &Path,
    options: &RecognitionOptions<'_>,
    duration_ms: i64,
    cancel: &Cancellation,
) -> Result<Vec<Cue>, String> {
    let mut child = OwnedChild(
        command(runtime, input, output, options.language, options.threads, options.use_gpu)
            .spawn()
            .map_err(|_| "无法启动 whisper-cli，请检查引擎和同目录依赖文件")?,
    );
    wait(&mut child, cancel, Duration::from_secs(3600))?;
    cancel.check()?;
    let file = std::fs::File::open(result)
        .map_err(|_| "本地引擎未生成字幕，请确认选择的是支持 JSON 输出的 whisper-cli")?;
    if file.metadata().map_err(|_| "无法检查本地字幕")?.len() > MAX_OUTPUT {
        return Err("本地字幕超过大小上限".into());
    }
    let mut raw = String::new();
    file.take(MAX_OUTPUT + 1)
        .read_to_string(&mut raw)
        .map_err(|_| "本地字幕不是有效 UTF-8")?;
    if raw.len() as u64 > MAX_OUTPUT {
        return Err("本地字幕超过大小上限".into());
    }
    parse_output(&raw, duration_ms)
}

fn parse_output(raw: &str, duration_ms: i64) -> Result<Vec<Cue>, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| "本地识别返回的 JSON 无法解析")?;
    let segments = value
        .get("transcription")
        .and_then(|v| v.as_array())
        .ok_or("本地识别缺少 transcription 时间轴，请更新 whisper.cpp 引擎")?;
    if segments.len() > 5000 {
        return Err("本地字幕超过句数上限".into());
    }
    let mut cues: Vec<Cue> = Vec::with_capacity(segments.len());
    let mut pending_points = Vec::new();
    let missing_timing = "本地引擎返回了没有有效时长的文字，请指定节目语言或更换模型后重试";
    for (index, segment) in segments.iter().enumerate() {
        let start = segment
            .pointer("/offsets/from")
            .and_then(|v| v.as_i64())
            .ok_or("本地字幕缺少开始时间")?;
        let end = segment
            .pointer("/offsets/to")
            .and_then(|v| v.as_i64())
            .ok_or("本地字幕缺少结束时间")?;
        let text = segment
            .get("text")
            .and_then(|v| v.as_str())
            .ok_or("本地字幕缺少正文")?
            .trim();
        if duration_ms <= 0
            || start < 0
            || end < start
            || start > duration_ms
            || (start == duration_ms && end > start)
            // 短窗最后一句的解码终点可能落在内部补齐的音频上；
            // 仅最后一项允许多 2 秒，开始时间必须仍处于真实音频中。
            || end > duration_ms.saturating_add(if index + 1 == segments.len() { 2000 } else { 1000 })
            || text.len() > 16000
        {
            return Err("本地字幕时间轴或正文超出范围".into());
        }
        if text.is_empty() {
            continue;
        }
        if end == start {
            // whisper.cpp 偶尔在句子边界输出多条同文、零时长片段。
            // 只忽略已有相邻有效字幕覆盖的重复文字，不为独有文字编造时间轴。
            if !cues
                .last()
                .is_some_and(|cue| cue.end_ms == start && cue.text == text)
            {
                pending_points.push((start, text));
            }
            continue;
        }
        if pending_points
            .iter()
            .any(|&(time, pending)| time != start || pending != text)
        {
            return Err(missing_timing.into());
        }
        pending_points.clear();
        cues.push(Cue {
            start_ms: start,
            end_ms: end.min(duration_ms),
            text: text.into(),
            translation: String::new(),
            chunk_index: None,
        });
    }
    if !pending_points.is_empty() {
        return Err(missing_timing.into());
    }
    Ok(cues)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_root() -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("_tmp")
            .join(format!("offline-unit-{:016x}", fastrand::u64(..)));
        std::fs::create_dir_all(&root).unwrap();
        root
    }
    #[test]
    fn model_validation_and_work_files_cleanup() {
        use std::io::Write;
        let root = test_root();
        let files = WorkFiles::new(&root).unwrap();
        let directory = files.directory.clone();
        let path = directory.join("input.wav");
        std::fs::write(&path, b"<html>download page</html>").unwrap();
        assert!(model_path(path.to_str().unwrap()).is_err());
        std::fs::write(&path, b"lmgg").unwrap();
        assert!(model_path(path.to_str().unwrap()).is_err());
        let mut model = std::fs::File::create(&path).unwrap();
        model.write_all(b"lmgg").unwrap();
        model.set_len(1_000_000).unwrap();
        drop(model);
        assert!(model_path(path.to_str().unwrap()).is_ok());
        assert!(engine_path(path.to_str().unwrap()).is_err());
        drop(files);
        assert!(!directory.exists());
        assert!(model_path(path.to_str().unwrap()).is_err());
        assert!(crate::ipc_guard::authorize_generic_setting(CONFIG_KEY).is_err());
        std::fs::remove_dir(root).unwrap();
    }

    // 专用子进程不接触网络或用户文件，由父测试持有 stdin 和进程所有权。
    #[test]
    #[ignore = "helper process for cancellation test"]
    fn offline_process_fixture() {
        if std::env::var_os("QT_WHISPER_CHILD_FIXTURE").is_none() {
            return;
        }
        use std::io::Write;
        println!("ASR_CHILD_READY");
        std::io::stdout().flush().unwrap();
        std::io::stdin().read_to_end(&mut Vec::new()).unwrap();
    }

    #[test]
    fn cancel_and_timeout_reap_the_owned_process() {
        use std::io::{BufRead, BufReader};
        for cancelled in [true, false] {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "podcast_subtitles::offline::tests::offline_process_fixture",
                    "--ignored",
                    "--nocapture",
                ])
                .env("QT_WHISPER_CHILD_FIXTURE", "1")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x0800_0000);
            }
            let mut child = OwnedChild(command.spawn().unwrap());
            let stdout = child.0.stdout.take().unwrap();
            let (sender, receiver) = std::sync::mpsc::channel();
            let reader = std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    if line.unwrap().contains("ASR_CHILD_READY") {
                        let _ = sender.send("ready");
                    }
                }
                let _ = sender.send("exited");
            });
            assert_eq!(
                receiver.recv_timeout(Duration::from_secs(10)).unwrap(),
                "ready"
            );
            let cancel = Cancellation::default();
            if cancelled {
                cancel.cancel();
            }
            let result = wait(&mut child, &cancel, Duration::from_millis(1));
            assert!(result
                .unwrap_err()
                .contains(if cancelled { "已取消" } else { "超时" }));
            assert!(child.0.try_wait().unwrap().is_none());
            drop(child);
            assert_eq!(
                receiver.recv_timeout(Duration::from_secs(2)).unwrap(),
                "exited"
            );
            reader.join().unwrap();
        }
    }
    #[test]
    fn whisper_offsets_are_milliseconds_and_silence_is_valid() {
        let cues = parse_output(
            r#"{"transcription":[{"offsets":{"from":1230,"to":2500},"text":" Hello 世界 "}]}"#,
            3000,
        )
        .unwrap();
        assert_eq!(cues[0].start_ms, 1230);
        assert_eq!(cues[0].text, "Hello 世界");
        assert!(parse_output(r#"{"transcription":[]}"#, 3000)
            .unwrap()
            .is_empty());
        assert!(parse_output(
            r#"{"transcription":[{"offsets":{"from":-1,"to":2},"text":"bad"}]}"#,
            3000
        )
        .is_err());
        assert!(parse_output(r#"{"text":"missing timestamps"}"#, 3000).is_err());
    }
    #[test]
    fn whisper_boundary_duplicates_do_not_discard_valid_subtitles() {
        // 重现长音频中连续 4 条、2 条零时长重复项；正文为自编测试文本。
        let raw = serde_json::json!({ "transcription": [
            { "offsets": { "from": 21800, "to": 29800 }, "text": " A repeated phrase. " },
            { "offsets": { "from": 29800, "to": 29800 }, "text": "A repeated phrase." },
            { "offsets": { "from": 29800, "to": 29800 }, "text": "A repeated phrase." },
            { "offsets": { "from": 29800, "to": 29800 }, "text": "A repeated phrase." },
            { "offsets": { "from": 29800, "to": 29800 }, "text": "A repeated phrase." },
            { "offsets": { "from": 29800, "to": 30800 }, "text": "A repeated phrase." },
            { "offsets": { "from": 30800, "to": 30800 }, "text": "A repeated phrase." },
            { "offsets": { "from": 30800, "to": 30800 }, "text": "A repeated phrase." },
            { "offsets": { "from": 303800, "to": 304800 }, "text": "The last phrase." }
        ] });
        let cues = parse_output(&format!("{raw}"), 304000).unwrap();
        assert_eq!(cues.len(), 3);
        assert_eq!((cues[0].start_ms, cues[0].end_ms), (21800, 29800));
        // 真正有时长的重复句仍然保留。
        assert_eq!((cues[1].start_ms, cues[1].end_ms), (29800, 30800));
        assert_eq!(cues[0].text, cues[1].text);
        assert_eq!((cues[2].start_ms, cues[2].end_ms), (303800, 304000));
    }
    #[test]
    fn whisper_empty_points_and_duplicates_before_a_sentence_are_safe() {
        let raw = serde_json::json!({ "transcription": [
            { "offsets": { "from": 0, "to": 0 }, "text": " \n " },
            { "offsets": { "from": 0, "to": 0 }, "text": "Hello." },
            { "offsets": { "from": 0, "to": 0 }, "text": " Hello. " },
            { "offsets": { "from": 0, "to": 1000 }, "text": "Hello." },
            { "offsets": { "from": 1000, "to": 1000 }, "text": "Hello." },
            { "offsets": { "from": 1000, "to": 1000 }, "text": "" }
        ] });
        let cues = parse_output(&format!("{raw}"), 1000).unwrap();
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "Hello.");
        assert_eq!((cues[0].start_ms, cues[0].end_ms), (0, 1000));
        assert!(parse_output(
            r#"{"transcription":[{"offsets":{"from":1000,"to":1000},"text":" "}]}"#,
            1000
        ).unwrap().is_empty());
    }
    #[test]
    fn whisper_does_not_drop_unique_or_unrelated_zero_duration_text() {
        for segments in [
            serde_json::json!([
                { "offsets": { "from": 0, "to": 1000 }, "text": "First." },
                { "offsets": { "from": 1000, "to": 1000 }, "text": "Do not lose me." },
                { "offsets": { "from": 1000, "to": 2000 }, "text": "Next." }
            ]),
            serde_json::json!([
                { "offsets": { "from": 0, "to": 0 }, "text": "Only untimed text." }
            ]),
            serde_json::json!([
                { "offsets": { "from": 0, "to": 500 }, "text": "Hello." },
                { "offsets": { "from": 1000, "to": 1000 }, "text": "Hello." },
                { "offsets": { "from": 1500, "to": 2000 }, "text": "Hello." }
            ]),
        ] {
            let raw = serde_json::json!({ "transcription": segments });
            assert!(parse_output(&format!("{raw}"), 3000)
                .unwrap_err().contains("没有有效时长"));
        }
    }
    #[test]
    fn whisper_still_rejects_corrupt_or_out_of_bounds_segments() {
        for (start, end, text) in [
            (-1, 0, "".into()),
            (1000, 999, "Reversed.".into()),
            (3000, 3100, "After the end.".into()),
            (3001, 3001, "".into()),
            (2900, 5001, "Too far beyond the end.".into()),
            (0, i64::MAX, "Overflow.".into()),
            (0, 1000, "字".repeat(5334)),
        ] {
            let raw = serde_json::json!({ "transcription": [
                { "offsets": { "from": start, "to": end }, "text": text }
            ] });
            assert!(parse_output(&format!("{raw}"), 3000).is_err());
        }
        for raw in [
            r#"{"transcription":[{"offsets":{"from":0},"text":"Missing end."}]}"#,
            r#"{"transcription":[{"offsets":{"from":0,"to":1.5},"text":"Wrong unit."}]}"#,
            r#"{"transcription":[{"offsets":{"from":0,"to":1000}}]}"#,
        ] {
            assert!(parse_output(raw, 3000).is_err());
        }
        let clipped = parse_output(r#"{"transcription":[{"offsets":{"from":21320,"to":23320},"text":"At the boundary."}]}"#, 22000).unwrap();
        assert_eq!(clipped[0].end_ms, 22000);
        assert!(parse_output(r#"{"transcription":[{"offsets":{"from":21320,"to":23320},"text":"Not last."},{"offsets":{"from":21400,"to":22000},"text":"Last."}]}"#, 22000).is_err());
    }
    #[test]
    fn short_windows_cover_audio_without_tiny_tails() {
        assert_eq!(recognition_windows(49_008), vec![(0, 20000), (20000, 49008)]);
        assert_eq!(recognition_windows(10_000), vec![(0, 10000)]);
        let windows = recognition_windows(304_000);
        assert_eq!(windows.last(), Some(&(280000, 304000)));
        assert!(windows.windows(2).all(|w| w[0].1 == w[1].0));
        assert_eq!(windows.iter().map(|(start, end)| end - start).sum::<i64>(), 304000);
        assert!(windows.iter().all(|(start, end)| end - start <= 30000));
    }
    fn test_cue(start: i64, end: i64, text: &str) -> Cue {
        Cue { start_ms: start, end_ms: end, text: text.into(), translation: String::new(), chunk_index: None }
    }
    #[test]
    fn window_context_is_owned_once_and_actual_repetitions_are_preserved() {
        let mut cues = Vec::new();
        merge_window(&mut cues, vec![test_cue(18000, 20500, "Boundary."), test_cue(20500, 21000, "Next.")], 0, 0, 20000);
        merge_window(&mut cues, vec![test_cue(0, 2500, "Boundary."), test_cue(2500, 4000, "Next."), test_cue(4000, 5000, "Next.")], 19000, 20000, 40000);
        assert_eq!(cues.len(), 3);
        assert_eq!((cues[0].start_ms, cues[0].end_ms), (18000, 21500));
        assert_eq!((cues[1].start_ms, cues[1].end_ms), (21500, 23000));
        assert_eq!((cues[2].start_ms, cues[2].end_ms), (23000, 24000));
    }
    #[test]
    fn repetitive_hallucinations_are_rejected_instead_of_deleted() {
        let mut cues = vec![test_cue(0, 1000, "Welcome to the briefing."); 3];
        assert!(!has_repetition_loop(&cues));
        cues.push(test_cue(3000, 4000, "welcome to the briefing!"));
        assert!(has_repetition_loop(&cues));
        assert!(!has_repetition_loop(&vec![test_cue(0, 1000, "Yes!"); 8]));
        assert!(!has_repetition_loop(&[test_cue(0, 1000, "First sentence."), test_cue(1000, 2000, "A different sentence.")]));
    }
    #[test]
    fn command_keeps_paths_as_arguments_and_does_not_translate_to_english() {
        let runtime = Runtime {
            engine: PathBuf::from("C:/tools/whisper-cli.exe"),
            model: PathBuf::from("C:/模型 带空格/ggml-small.bin"),
            cpu_only: true,
        };
        let command = command(
            &runtime,
            Path::new("C:/音频/a.wav"),
            Path::new("C:/work/result"),
            "zh",
            4,
            false,
        );
        let arguments: Vec<_> = command
            .get_args()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        assert!(arguments.contains(&"C:/模型 带空格/ggml-small.bin".into()));
        assert!(arguments.contains(&"-ng".into()));
        assert!(arguments.windows(2).any(|args| args == ["-mc", "0"]));
        assert!(!arguments.contains(&"-tr".into()));
    }
    #[test]
    #[ignore = "requires explicitly downloaded whisper.cpp engine, model and public speech fixture"]
    fn offline_real_engine_smoke() {
        let root =
            PathBuf::from(std::env::var_os("QT_WHISPER_TEST_ROOT").expect("explicit fixture root"));
        let runtime = Runtime {
            engine: engine_path(
                root.join("engine/Release/whisper-cli.exe")
                    .to_str()
                    .unwrap(),
            )
            .unwrap(),
            model: model_path(root.join("ggml-tiny.bin").to_str().unwrap()).unwrap(),
            cpu_only: true,
        };
        let cancel = Arc::new(Cancellation::default());
        let started = Instant::now();
        let chunk =
            super::super::audio::decode_chunk(&root.join("jfk.wav"), 0, cancel.clone()).unwrap();
        let cues = transcribe(
            runtime,
            chunk,
            "en".into(),
            4,
            false,
            root.join("真实识别 输出"),
            cancel,
        )
        .unwrap();
        let text = cues
            .iter()
            .map(|c| c.text.as_str())
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
        assert!(
            text.contains("country"),
            "public fixture speech should be recognized"
        );
        assert!(cues.iter().all(|c| c.end_ms > c.start_ms));
        println!(
            "{}",
            serde_json::json!({ "model": "tiny", "threads": 4, "gpu": false, "elapsedMs": started.elapsed().as_millis(), "cues": cues })
        );
        assert_eq!(
            std::fs::read_dir(root.join("真实识别 输出"))
                .unwrap()
                .count(),
            0,
            "temporary audio/result cleaned"
        );
    }

    #[test]
    #[ignore = "explicit short-window real-time recognition performance test"]
    fn offline_short_window_smoke() {
        let input = PathBuf::from(std::env::var_os("QT_WHISPER_LONG_AUDIO").expect("explicit audio"));
        let root = crate::public_test_fixture::root().join("short-windows");
        std::fs::create_dir(&root).unwrap();
        for index in [0, 1, 15, 16, 32] {
            let runtime = Runtime {
                engine: PathBuf::from(std::env::var_os("QT_WHISPER_ENGINE").expect("explicit engine")),
                model: PathBuf::from(std::env::var_os("QT_WHISPER_MODEL").expect("explicit model")), cpu_only: true,
            };
            let cancel = Arc::new(Cancellation::default());
            let started = Instant::now();
            let chunk = super::super::audio::decode_window(&input, index, cancel.clone()).unwrap();
            let duration = chunk.end_ms - chunk.start_ms;
            std::fs::write(root.join(format!("window-{index}.wav")), &chunk.wav).unwrap();
            let cues = transcribe(runtime, chunk, String::new(), 4, false, root.join("work"), cancel).unwrap();
            assert!(!cues.is_empty());
            assert!(cues.iter().all(|cue| cue.end_ms > cue.start_ms && cue.end_ms <= duration));
            assert!(!has_repetition_loop(&cues));
            println!("{}", serde_json::json!({ "window": index, "audioMs": duration, "elapsedMs": started.elapsed().as_millis(), "cues": cues }));
        }
    }
    #[test]
    #[ignore = "requires explicit local engine, model and long audio fixture"]
    fn offline_long_audio_smoke() {
        let input = PathBuf::from(std::env::var_os("QT_WHISPER_LONG_AUDIO").expect("explicit audio"));
        let root = crate::public_test_fixture::root().join("long-audio");
        std::fs::create_dir(&root).unwrap();
        let cancel = Arc::new(Cancellation::default());
        for index in [0, 1, 2] {
            let runtime = Runtime {
                engine: PathBuf::from(std::env::var_os("QT_WHISPER_ENGINE").expect("explicit engine")),
                model: PathBuf::from(std::env::var_os("QT_WHISPER_MODEL").expect("explicit model")),
                cpu_only: true,
            };
            let started = Instant::now();
            let chunk = super::super::audio::decode_chunk(&input, index, cancel.clone()).unwrap();
            let duration = chunk.end_ms - chunk.start_ms;
            std::fs::write(root.join(format!("chunk-{index}.wav")), &chunk.wav).unwrap();
            let cues = transcribe(runtime, chunk, String::new(), 4, false, root.join("work"), cancel.clone()).unwrap();
            assert!(!cues.is_empty());
            assert!(cues.iter().all(|cue| cue.start_ms >= 0 && cue.end_ms > cue.start_ms && cue.end_ms <= duration));
            assert!(!has_repetition_loop(&cues));
            assert_eq!(std::fs::read_dir(root.join("work")).unwrap().count(), 0);
            let unique = cues.iter().map(|cue| cue.text.as_str()).collect::<std::collections::HashSet<_>>().len();
            println!("{}", serde_json::json!({ "chunk": index, "durationMs": duration, "cues": cues.len(), "unique": unique, "elapsedMs": started.elapsed().as_millis() }));
            // 输出只在显式指定的隔离目录中，便于人工检查质量，不写入真实字幕库。
            std::fs::write(root.join(format!("cues-{index}.json")), serde_json::to_vec(&cues).unwrap()).unwrap();
        }
    }
}
