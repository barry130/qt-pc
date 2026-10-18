//! 「外部打开」入口的共享状态与命令行解析：拖拽入窗 / 命令行参数 / 第二实例转发。
//!
//! 三条路径最终都落到同一个动作（`cmd_open_local_paths` → 前端入队播放），区别只在
//! 谁先知道要打开什么：
//! - 拖拽：前端直接拿到路径，不需要经过这里；
//! - 命令行：首个实例启动时进程就有 argv，但**前端那时还没注册事件监听**；
//! - 第二实例：转发给已在运行的主实例，同样可能早于前端就绪。
//!
//! 所以这里用**待取队列 + 事件唤醒**两件套，而不是把路径塞进事件载荷：
//! 事件只是「来拿」的提醒，路径放在队列里由前端 `take_pending_open_paths` 一次性取空。
//! 这样既不会因为「前端还没监听」丢掉参数，也不会因为「事件和启动时各取一次」
//! 把同一首播两遍（取空是原子的）。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 通知前端「队列里有东西了」的事件名（前端 `ipc.ts` 的 `OPEN_LOCAL_PATHS_EVENT`）。
/// 载荷为空 —— 见模块头注释，路径不进事件。
pub const EVENT_OPEN_LOCAL_PATHS: &str = "open-local-paths";

/// 待打开的路径（绝对值）。用 `Mutex` 而不是 channel：取空是 O(1) 的，且不需要
/// 额外的消费者线程；中毒按「拿到里层数据继续」处理，这类队列没有不变式可破坏。
static PENDING: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// 追加待打开路径（重复路径由扫描侧去重），返回队列当前长度。
pub fn push(paths: Vec<String>) -> usize {
    if paths.is_empty() {
        return 0;
    }
    let mut queue = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    queue.extend(paths);
    queue.len()
}

/// 取空队列。前端每次收到事件、以及主窗口挂载时各调一次。
pub fn take() -> Vec<String> {
    let mut queue = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    std::mem::take(&mut *queue)
}

/// 唤醒前端来取（emit 失败不致命：前端挂载时还会主动取一次）。
pub fn notify(app: &tauri::AppHandle) {
    use tauri::Emitter as _;
    let _ = app.emit_to(crate::MAIN_WINDOW_LABEL, EVENT_OPEN_LOCAL_PATHS, ());
}

/// 进程启动时的命令行参数（含程序自身，形状与单实例插件回传的一致）。
///
/// 用 `args_os` 而不是 `args`：Windows 上带非 UTF-8 字节的路径会让 `args` 直接 panic，
/// 而「文件名里有乱码」恰恰是本地音乐库的常态。
pub fn argv_from_env() -> Vec<String> {
    std::env::args_os()
        .map(|a| a.to_string_lossy().into_owned())
        .collect()
}

/// 从命令行参数里挑出「要打开的本地文件 / 文件夹」，顺序与入参一致。
///
/// 约定：
/// - 第 0 项是程序自身（`std::env::args_os` 与单实例插件回传的 argv 都是这个形状），跳过；
/// - `-` 开头的是开关，跳过；`--play` 是显式入口，其后所有参数都当路径（给「路径本身
///   以 `-` 开头」这种极端情况留的后路）；
/// - 相对路径按 `cwd` 展开（Windows 上从「打开方式」拉起时 cwd 是随机的）；
/// - **不校验存在性**：不存在的路径交给 `local::scan_files` 记进 `skipped`，
///   用户因此能看到「这 1 个条目没打开」，而不是静默无反应。
pub fn paths_from_args(args: &[String], cwd: Option<&Path>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest_are_paths = false;
    for (index, raw) in args.iter().enumerate() {
        if index == 0 {
            continue;
        }
        let arg = raw.trim();
        if arg.is_empty() {
            continue;
        }
        if !rest_are_paths {
            if arg == "--play" {
                rest_are_paths = true;
                continue;
            }
            if arg.starts_with('-') {
                continue;
            }
        }
        let path = PathBuf::from(arg);
        let resolved = match (path.is_absolute(), cwd) {
            (false, Some(dir)) => dir.join(path),
            _ => path,
        };
        let text = resolved.to_string_lossy().into_owned();
        if !out.contains(&text) {
            out.push(text);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("quietmusic-open-{tag}-{}", fastrand::u64(..)));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    fn touch(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, b"x").expect("写临时文件");
        path
    }

    #[test]
    fn paths_from_args_keeps_order_and_skips_switches() {
        let root = temp_dir("args");
        let song = touch(&root, "a.flac");
        let other = touch(&root, "b.mp3");
        let text = touch(&root, "readme.txt");
        let sub = root.join("album");
        std::fs::create_dir_all(&sub).expect("建子目录");

        let args = vec![
            "QuietMusic.exe".to_string(),
            text.to_string_lossy().into_owned(),
            song.to_string_lossy().into_owned(),
            "--flag".to_string(),
            sub.to_string_lossy().into_owned(),
            other.to_string_lossy().into_owned(),
            song.to_string_lossy().into_owned(), // 重复项只留一次
            "   ".to_string(),
        ];
        let paths = paths_from_args(&args, None);
        assert_eq!(
            paths,
            vec![
                text.to_string_lossy().into_owned(),
                song.to_string_lossy().into_owned(),
                sub.to_string_lossy().into_owned(),
                other.to_string_lossy().into_owned(),
            ]
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn paths_from_args_resolves_relative_and_honours_play_flag() {
        let root = temp_dir("relative");
        touch(&root, "song.mp3");

        let relative = paths_from_args(&["app.exe".into(), "song.mp3".into()], Some(&root));
        assert_eq!(
            relative,
            vec![root.join("song.mp3").to_string_lossy().into_owned()]
        );

        // --play 之后连 `-` 开头的参数也当路径（不校验存在性，交给 scan_files 报）
        let forced = paths_from_args(
            &["app.exe".into(), "--play".into(), "-weird.mp3".into()],
            Some(&root),
        );
        assert_eq!(
            forced,
            vec![root.join("-weird.mp3").to_string_lossy().into_owned()]
        );

        // 没有 cwd 时保留原样，不做推测
        assert_eq!(
            paths_from_args(&["app.exe".into(), "song.mp3".into()], None),
            vec!["song.mp3".to_string()]
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pending_queue_push_then_take_drains() {
        assert!(take().is_empty(), "每个测试开始时队列应为空");
        assert_eq!(push(Vec::new()), 0, "空入参不该让队列「有东西」");
        assert_eq!(push(vec!["a".into(), "b".into()]), 2);
        assert_eq!(push(vec!["c".into()]), 3);
        assert_eq!(take(), vec!["a".to_string(), "b".into(), "c".into()]);
        assert!(take().is_empty(), "取空之后不能重复给出同一批路径");
    }
}
