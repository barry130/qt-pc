//! 自定义 URI scheme（`quietmusic://`）：浏览器、脚本、快捷方式能直接唤起并播放。
//!
//! 只做**一条**动作，够用且不会变成任意命令入口：
//!
//! - `quietmusic://play?path=D%3A%5CMusic%5Csong.flac` —— 打开并播放这个本地文件。
//!   `path` 支持 `%XX` 百分号编码（浏览器 JS 的 `encodeURIComponent` 结果直接可用）；
//!   也接受 `id=local:<路径>`（曲库里的本地曲目 id 就是 `local:{路径}` 形式）。
//!
//! 为什么不是 `quietmusic://shell?cmd=...`：注册表里写的是 `"exe" "%1"`，任何拿到
//! 链接的人都能唤起播放器。动作面越窄越安全 —— 播放一个**已存在且是音频扩展名**的
//! 文件是唯一副作用，其余参数一律忽略并在日志里记一笔。
//!
//! 注册走与 `file_assoc` 同一套口径：只写 `HKCU\Software\Classes\`（当前用户，无需
//! 管理员），不碰系统级 `HKCR`；取消注册就删掉整棵子树。Windows 之外没有系统级
//! scheme 注册表，`supported` 直接报 false（与 `file_assoc` 一致）。
//!
//! 唤起路径复用既有单实例转发：第二个实例把参数交给已在运行的主实例
//! （`lib.rs` 的 `tauri_plugin_single_instance` 回调），再由 [`dispatch`] 入队给前端打开
//! —— 与「双击音频文件」是同一条链路，不另开一套进度/队列逻辑。

use serde::Serialize;

/// scheme 名（注册表类名、日志前缀都用它）
pub const SCHEME: &str = "quietmusic";

/// 注册表里给这个协议起的名字（资源管理器「打开方式」里显示）
const PROTOCOL_LABEL: &str = "URL:轻听链接";

/// 设置页展示给用户的示例链接（真实可用，指向一个不存在的占位路径也没关系 ——
/// 用户会替换掉 `path`）
pub fn example_link() -> String {
    format!("{SCHEME}://play?path=D%3A%5CMusic%5Csong.flac")
}

/// 一条可执行的 URI 动作。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UriAction {
    /// 打开并播放一个本地文件（已解码、已确认扩展名）
    Play { path: String },
}

/// 注册状态快照（设置页回显用）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UriSchemeState {
    /// 当前平台是否支持注册（只有 Windows）
    pub supported: bool,
    /// 注册表里四条记录是否与当前 exe 一致
    pub registered: bool,
    /// 示例链接
    pub example: String,
}

/// 从命令行参数里挑出 URI 动作。
///
/// 参数里混着 `--play`、文件路径是常态，认不出来的直接跳过（不报错、不打断启动）。
pub fn actions_from_args(args: &[String]) -> Vec<UriAction> {
    args.iter().filter_map(|a| parse(a)).collect()
}

/// 解析一条 `quietmusic://...` 链接；不是本 scheme 或参数不达标时返回 `None`。
pub fn parse(raw: &str) -> Option<UriAction> {
    let rest = strip_scheme(raw.trim())?;
    let (target, query) = rest.split_once('?').unwrap_or((rest, ""));
    let target = target.trim_end_matches('/');
    if !target.eq_ignore_ascii_case("play") {
        return None;
    }
    // path 优先；没有就退到 id，并把曲库本地 id 前缀 `local:` 去掉
    let path = match query_param(query, "path") {
        Some(p) if !p.is_empty() => p,
        _ => {
            let id = query_param(query, "id")?;
            let trimmed = id
                .strip_prefix("local:")
                .or_else(|| id.strip_prefix("LOCAL:"))
                .unwrap_or(&id)
                .to_string();
            if trimmed.is_empty() {
                return None;
            }
            trimmed
        }
    };
    Some(UriAction::Play { path })
}

/// 校验并把动作交给前端（与「打开方式」共用待取队列）。
///
/// 只放行**磁盘上真的存在**、且扩展名在白名单里的文件：链接是外部输入，不能让它
/// 变成「任意路径都能塞进播放队列」。被拒的记一条 warn —— 用户反馈「点了链接没反应」
/// 时，日志里能直接看到是哪一条。
pub fn dispatch(app: &tauri::AppHandle, actions: Vec<UriAction>) {
    let mut paths: Vec<String> = Vec::new();
    for action in actions {
        match action {
            UriAction::Play { path } => {
                if !std::path::Path::new(&path).is_file() {
                    log::warn!("[uri] 链接里的文件不存在，忽略：{path}");
                    continue;
                }
                if !has_audio_ext(&path) {
                    log::warn!("[uri] 链接不是支持的音频格式，忽略：{path}");
                    continue;
                }
                paths.push(path);
            }
        }
    }
    if paths.is_empty() {
        return;
    }
    log::info!("[uri] 链接待打开 {} 个条目", paths.len());
    crate::external_open::push(paths);
    crate::external_open::notify(app);
}

/// 扩展名白名单与「打开方式」同一份口径（`file_assoc::EXTENSIONS`）。
fn has_audio_ext(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    crate::file_assoc::EXTENSIONS
        .iter()
        .any(|ext| lower.ends_with(&format!(".{ext}")))
}

/// 去掉 scheme 前缀（大小写不敏感，`quietmusic:play?...` 这种没 `//` 的也认）。
fn strip_scheme(raw: &str) -> Option<&str> {
    let (scheme, rest) = raw.split_once(':')?;
    if !scheme.eq_ignore_ascii_case(SCHEME) {
        return None;
    }
    Some(rest.trim_start_matches('/'))
}

/// 取查询参数（键名大小写不敏感），返回值已做百分号解码。
fn query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if k.eq_ignore_ascii_case(key) {
            return Some(percent_decode(v));
        }
    }
    None
}

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// `%XX` 解码 + `+` → 空格（查询串口径）。
///
/// 不完整的转义（末尾单个 `%`、`%zz`）**原样保留**：宁可让路径带着 `%` 去找文件
/// 失败，也不能把用户路径里的合法字符吃掉。
fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => match (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                (Some(hi), Some(lo)) => {
                    out.push(hi * 16 + lo);
                    i += 3;
                }
                _ => {
                    out.push(bytes[i]);
                    i += 1;
                }
            },
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 注册表条目（与 `file_assoc::registration_entries` 同一形态：键、值名、值）。
///
/// 写成独立的纯函数是为了单测能在不碰注册表的前提下断言「写了哪些键、命令行长什么样」。
#[cfg(any(windows, test))]
fn registration_entries(
    executable: &std::path::Path,
) -> Result<Vec<(String, String, String)>, String> {
    let exe = executable.to_string_lossy();
    if !executable.is_absolute() || exe.contains(['"', '\0']) {
        return Err("程序路径必须是绝对路径且不能含引号或空字符".into());
    }
    let class = format!(r"Software\Classes\{SCHEME}");
    Ok(vec![
        (class.clone(), "".into(), PROTOCOL_LABEL.into()),
        (class.clone(), "URL Protocol".into(), String::new()),
        (format!(r"{class}\DefaultIcon"), "".into(), format!("\"{exe}\",0")),
        (
            format!(r"{class}\shell\open\command"),
            "".into(),
            format!("\"{exe}\" \"%1\""),
        ),
    ])
}

#[cfg(windows)]
mod platform {
    use super::*;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{
        ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS, WIN32_ERROR,
    };
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyW, RegDeleteTreeW, RegGetValueW, RegSetKeyValueW, HKEY,
        HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ,
    };

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    fn check(code: WIN32_ERROR, operation: &str) -> Result<(), String> {
        if code == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(format!("{operation}：Windows 错误 {}", code.0))
        }
    }

    fn check_delete(code: WIN32_ERROR) -> Result<(), String> {
        if code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND {
            Ok(())
        } else {
            check(code, "取消 URI 注册失败")
        }
    }

    fn write_string(key: &str, name: &str, value: &str) -> Result<(), String> {
        let key_w = wide(key);
        let name_w = wide(name);
        let value_w = wide(value);
        let mut handle = HKEY::default();
        unsafe {
            check(
                RegCreateKeyW(HKEY_CURRENT_USER, PCWSTR(key_w.as_ptr()), &mut handle),
                "注册 URI scheme 失败",
            )?;
            let result = RegSetKeyValueW(
                handle,
                PCWSTR::null(),
                PCWSTR(name_w.as_ptr()),
                REG_SZ.0,
                Some(value_w.as_ptr().cast()),
                (value_w.len() * 2) as u32,
            );
            let _ = RegCloseKey(handle);
            check(result, "写入 URI 注册信息失败")
        }
    }

    fn read_string(key: &str, name: &str) -> Result<Option<String>, String> {
        let key_w = wide(key);
        let name_w = wide(name);
        let mut bytes = 0u32;
        unsafe {
            let result = RegGetValueW(
                HKEY_CURRENT_USER,
                PCWSTR(key_w.as_ptr()),
                PCWSTR(name_w.as_ptr()),
                RRF_RT_REG_SZ,
                None,
                None,
                Some(&mut bytes),
            );
            if result == ERROR_FILE_NOT_FOUND || result == ERROR_PATH_NOT_FOUND {
                return Ok(None);
            }
            check(result, "读取 URI 注册信息失败")?;
            let mut buffer = vec![0u16; bytes as usize / 2 + 1];
            check(
                RegGetValueW(
                    HKEY_CURRENT_USER,
                    PCWSTR(key_w.as_ptr()),
                    PCWSTR(name_w.as_ptr()),
                    RRF_RT_REG_SZ,
                    None,
                    Some(buffer.as_mut_ptr().cast()),
                    Some(&mut bytes),
                ),
                "读取 URI 注册信息失败",
            )?;
            let length = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
            Ok(Some(String::from_utf16_lossy(&buffer[..length])))
        }
    }

    fn delete_tree(key: &str) -> Result<(), String> {
        let key = wide(key);
        unsafe { check_delete(RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(key.as_ptr()))) }
    }

    pub fn state() -> Result<UriSchemeState, String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let mut registered = true;
        for (key, name, value) in registration_entries(&exe)? {
            if read_string(&key, &name)?.as_deref() != Some(value.as_str()) {
                registered = false;
            }
        }
        Ok(UriSchemeState {
            supported: true,
            registered,
            example: example_link(),
        })
    }

    pub fn register() -> Result<UriSchemeState, String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        for (key, name, value) in registration_entries(&exe)? {
            write_string(&key, &name, &value)?;
        }
        state()
    }

    pub fn unregister() -> Result<UriSchemeState, String> {
        delete_tree(&format!(r"Software\Classes\{SCHEME}"))?;
        state()
    }
}

#[cfg(windows)]
pub use platform::{register, state, unregister};

#[cfg(not(windows))]
pub fn state() -> Result<UriSchemeState, String> {
    Ok(UriSchemeState {
        supported: false,
        registered: false,
        example: example_link(),
    })
}

#[cfg(not(windows))]
pub fn register() -> Result<UriSchemeState, String> {
    Err("当前平台暂不支持 URI scheme 注册".into())
}

#[cfg(not(windows))]
pub fn unregister() -> Result<UriSchemeState, String> {
    Err("当前平台暂不支持 URI scheme 注册".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn play(path: &str) -> Option<UriAction> {
        Some(UriAction::Play {
            path: path.to_string(),
        })
    }

    #[test]
    fn parses_percent_encoded_path() {
        assert_eq!(
            parse("quietmusic://play?path=D%3A%5CMusic%5C%E8%BD%BB%E5%90%AC%5Ca.flac"),
            play(r"D:\Music\轻听\a.flac")
        );
        // 空格既可能是 %20 也可能是 +（表单口径）
        assert_eq!(
            parse("quietmusic://play?path=C%3A%2FDemo%20Songs%2Fa+b.mp3"),
            play("C:/Demo Songs/a b.mp3")
        );
    }

    #[test]
    fn parses_local_track_id() {
        assert_eq!(
            parse("quietmusic://play?id=local:D%3A%5Cm%5Cb.flac"),
            play(r"D:\m\b.flac")
        );
        // 编码后的 local: 前缀同样认
        assert_eq!(
            parse("quietmusic://play?id=local%3AD%3A%5Cm%5Cb.flac"),
            play(r"D:\m\b.flac")
        );
    }

    #[test]
    fn rejects_unknown_or_incomplete_links() {
        assert_eq!(parse("https://example.com/play?path=a.mp3"), None);
        assert_eq!(parse("quietmusic://search?q=abc"), None, "未实现的动作要拒");
        assert_eq!(parse("quietmusic://play"), None, "没有参数");
        assert_eq!(parse("quietmusic://play?path="), None, "空参数");
        assert_eq!(parse("quietmusic://play?id=local:"), None, "空 id");
        assert_eq!(parse("quietmusic://"), None);
    }

    #[test]
    fn scheme_and_keys_are_case_insensitive() {
        assert_eq!(
            parse("QuietMusic://Play?Path=C%3A%5Ca.mp3"),
            play(r"C:\a.mp3")
        );
        // 没有 `//` 的形态（部分启动器/手打）
        assert_eq!(parse("quietmusic:play?path=/music/a.flac"), play("/music/a.flac"));
    }

    #[test]
    fn keeps_path_with_other_params() {
        assert_eq!(
            parse("quietmusic://play?from=web&path=C%3A%5Ca.mp3&autoplay=1"),
            play(r"C:\a.mp3")
        );
    }

    #[test]
    fn percent_decode_keeps_broken_escapes() {
        assert_eq!(percent_decode("a%zzb"), "a%zzb");
        assert_eq!(percent_decode("abc%"), "abc%");
        assert_eq!(percent_decode("100%25"), "100%");
        assert_eq!(percent_decode("a+b"), "a b");
    }

    #[test]
    fn actions_from_args_skips_non_uris() {
        let args = vec![
            "QuietMusic.exe".to_string(),
            "--play".to_string(),
            r"C:\music\a.flac".to_string(),
            "quietmusic://play?path=C%3A%5Cmusic%5Cb.flac".to_string(),
        ];
        assert_eq!(actions_from_args(&args), vec![UriAction::Play { path: r"C:\music\b.flac".into() }]);
    }

    #[test]
    fn audio_extension_whitelist_matches_file_assoc() {
        assert!(has_audio_ext(r"C:\a.FLAC"));
        assert!(has_audio_ext("/music/a.mp3"));
        assert!(!has_audio_ext(r"C:\a.exe"));
        assert!(!has_audio_ext(r"C:\a.mp3.txt"));
        assert!(!has_audio_ext(r"C:\a.flac.bak"));
        // 只看后缀是够的：dispatch 里先过 is_file()，「磁盘上真实存在的音频」是合取条件
    }

    #[cfg(any(windows, test))]
    #[test]
    fn registration_entries_use_hkcu_classes_and_percent_one() {
        let exe = std::env::current_exe().unwrap();
        let entries = registration_entries(&exe).unwrap();
        assert!(entries.iter().all(|(key, _, _)| key.starts_with(r"Software\Classes\quietmusic")));
        let command = entries
            .iter()
            .find(|(key, _, _)| key.ends_with(r"shell\open\command"))
            .unwrap();
        assert_eq!(command.2, format!("\"{}\" \"%1\"", exe.display()));
        assert!(entries
            .iter()
            .any(|(_, name, value)| name == "URL Protocol" && value.is_empty()));
    }

    #[cfg(any(windows, test))]
    #[test]
    fn registration_rejects_quotes_in_path() {
        let weird = std::path::Path::new(r#"C:\bad"name\app.exe"#);
        assert!(registration_entries(weird).is_err());
    }
}
