//! 可选文件关联：只注册候选播放器，不写扩展名默认值或 Windows UserChoice。
//! 默认应用由用户在系统设置中确认；双击打开沿用 external_open 的单实例转发。

use serde::Serialize;

pub const PROG_ID: &str = "QuietMusic.AudioFile";
pub const APPLICATION_NAME: &str = "QuietMusic";
pub const EXTENSIONS: [&str; 5] = ["mp3", "flac", "wav", "ogg", "m4a"];
const CAPABILITIES: &str = r"Software\QuietMusic\Capabilities";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAssociationState {
    pub supported: bool,
    pub registered: bool,
    pub extensions: Vec<String>,
    pub default_extensions: Vec<String>,
}

#[cfg(any(windows, test))]
fn registration_entries(executable: &std::path::Path) -> Result<Vec<(String, String, String)>, String> {
    let exe = executable.to_string_lossy();
    if !executable.is_absolute() || exe.contains(['"', '\0']) {
        return Err("播放器路径必须是绝对路径且不能含引号或空字符".into());
    }
    let class = format!(r"Software\Classes\{PROG_ID}");
    let mut entries = vec![
        (class.clone(), "".into(), "轻听音频文件".into()),
        (format!(r"{class}\DefaultIcon"), "".into(), format!("\"{exe}\",0")),
        (format!(r"{class}\shell\open\command"), "".into(), format!("\"{exe}\" --play \"%1\"")),
        (CAPABILITIES.into(), "ApplicationName".into(), "轻听".into()),
        (CAPABILITIES.into(), "ApplicationDescription".into(), "轻听本地音乐播放器".into()),
        (r"Software\RegisteredApplications".into(), APPLICATION_NAME.into(), CAPABILITIES.into()),
    ];
    for ext in EXTENSIONS {
        entries.push((format!(r"Software\Classes\.{ext}\OpenWithProgids"), PROG_ID.into(), String::new()));
        entries.push((format!(r"{CAPABILITIES}\FileAssociations"), format!(".{ext}"), PROG_ID.into()));
    }
    Ok(entries)
}

#[cfg(windows)]
mod platform {
    use super::*;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS, WIN32_ERROR};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyW, RegDeleteKeyValueW, RegDeleteTreeW, RegGetValueW,
        RegSetKeyValueW, HKEY, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ,
    };
    use windows::Win32::UI::Shell::{ShellExecuteW, SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }

    fn check(code: WIN32_ERROR, operation: &str) -> Result<(), String> {
        if code == ERROR_SUCCESS { Ok(()) } else { Err(format!("{operation}: Windows 错误 {}", code.0)) }
    }

    fn check_delete(code: WIN32_ERROR) -> Result<(), String> {
        if code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND { Ok(()) }
        else { check(code, "取消文件关联失败") }
    }

    fn write_string(key: &str, name: &str, value: &str) -> Result<(), String> {
        let key_w = wide(key);
        let name_w = wide(name);
        let value_w = wide(value);
        let mut handle = HKEY::default();
        unsafe {
            check(RegCreateKeyW(HKEY_CURRENT_USER, PCWSTR(key_w.as_ptr()), &mut handle), "注册播放器失败")?;
            let result = RegSetKeyValueW(handle, PCWSTR::null(), PCWSTR(name_w.as_ptr()), REG_SZ.0,
                Some(value_w.as_ptr().cast()), (value_w.len() * 2) as u32);
            let _ = RegCloseKey(handle);
            check(result, "写入播放器注册信息失败")
        }
    }

    fn read_string(key: &str, name: &str) -> Result<Option<String>, String> {
        let key_w = wide(key);
        let name_w = wide(name);
        let mut bytes = 0u32;
        unsafe {
            let result = RegGetValueW(HKEY_CURRENT_USER, PCWSTR(key_w.as_ptr()), PCWSTR(name_w.as_ptr()),
                RRF_RT_REG_SZ, None, None, Some(&mut bytes));
            if result == ERROR_FILE_NOT_FOUND || result == ERROR_PATH_NOT_FOUND { return Ok(None); }
            check(result, "读取播放器注册信息失败")?;
            let mut buffer = vec![0u16; bytes as usize / 2 + 1];
            check(RegGetValueW(HKEY_CURRENT_USER, PCWSTR(key_w.as_ptr()), PCWSTR(name_w.as_ptr()),
                RRF_RT_REG_SZ, None, Some(buffer.as_mut_ptr().cast()), Some(&mut bytes)), "读取播放器注册信息失败")?;
            let length = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
            Ok(Some(String::from_utf16_lossy(&buffer[..length])))
        }
    }

    fn delete_value(key: &str, name: &str) -> Result<(), String> {
        let key = wide(key);
        let name = wide(name);
        unsafe { check_delete(RegDeleteKeyValueW(HKEY_CURRENT_USER, PCWSTR(key.as_ptr()), PCWSTR(name.as_ptr()))) }
    }

    fn delete_tree(key: &str) -> Result<(), String> {
        let key = wide(key);
        unsafe { check_delete(RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(key.as_ptr()))) }
    }

    fn notify() {
        unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None); }
    }

    pub fn state() -> Result<FileAssociationState, String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let entries = registration_entries(&exe)?;
        let mut registered = true;
        for (key, name, value) in entries {
            if read_string(&key, &name)?.as_deref() != Some(value.as_str()) { registered = false; }
        }
        let mut default_extensions = Vec::new();
        for ext in EXTENSIONS {
            let key = format!(r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.{ext}\UserChoice");
            if read_string(&key, "ProgId")?.is_some_and(|id| id.eq_ignore_ascii_case(PROG_ID)) {
                default_extensions.push(ext.into());
            }
        }
        Ok(FileAssociationState { supported: true, registered, extensions: EXTENSIONS.map(str::to_owned).to_vec(), default_extensions })
    }

    pub fn register() -> Result<FileAssociationState, String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        for (key, name, value) in registration_entries(&exe)? { write_string(&key, &name, &value)?; }
        notify();
        state()
    }

    pub fn unregister() -> Result<FileAssociationState, String> {
        if !state()?.default_extensions.is_empty() {
            open_settings()?;
            return Err("轻听仍是部分音频格式的默认播放器。请先在 Windows 默认应用中改选其他播放器，再取消关联。".into());
        }
        for ext in EXTENSIONS {
            delete_value(&format!(r"Software\Classes\.{ext}\OpenWithProgids"), PROG_ID)?;
        }
        delete_value(r"Software\RegisteredApplications", APPLICATION_NAME)?;
        delete_tree(CAPABILITIES)?;
        delete_tree(&format!(r"Software\Classes\{PROG_ID}"))?;
        notify();
        state()
    }

    pub fn open_settings() -> Result<(), String> {
        // URI 由程序固定，不执行用户提供的命令或 URI。Windows 10/11 均支持此入口。
        let result = unsafe { ShellExecuteW(None, w!("open"), w!("ms-settings:defaultapps"),
            PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
        if result.0 as isize <= 32 { Err("无法打开 Windows 默认应用设置".into()) } else { Ok(()) }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn registry_helpers_roundtrip_only_in_isolated_test_key() {
            let key = format!(r"Software\QuietMusic\Tests\FileAssoc-{}-{}", std::process::id(), fastrand::u64(..));
            write_string(&key, "中文名", "C:\\音乐\\轻听.exe").unwrap();
            let value = read_string(&key, "中文名");
            let cleaned = delete_tree(&key);
            assert_eq!(value.unwrap().as_deref(), Some("C:\\音乐\\轻听.exe"));
            cleaned.unwrap();
            assert_eq!(read_string(&key, "中文名").unwrap(), None);
        }
    }
}

#[cfg(windows)]
pub use platform::{open_settings, register, state, unregister};

#[cfg(not(windows))]
pub fn state() -> Result<FileAssociationState, String> {
    Ok(FileAssociationState { supported: false, registered: false,
        extensions: EXTENSIONS.map(str::to_owned).to_vec(), default_extensions: Vec::new() })
}
#[cfg(not(windows))]
pub fn register() -> Result<FileAssociationState, String> { Err("当前平台暂不支持文件关联设置".into()) }
#[cfg(not(windows))]
pub fn unregister() -> Result<FileAssociationState, String> { Err("当前平台暂不支持文件关联设置".into()) }
#[cfg(not(windows))]
pub fn open_settings() -> Result<(), String> { Err("当前平台暂不支持默认应用设置".into()) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registration_never_writes_extension_default_or_user_choice() {
        let exe = std::env::current_exe().unwrap();
        let entries = registration_entries(&exe).unwrap();
        for (key, name, _) in &entries {
            assert!(!key.contains("UserChoice"));
            for ext in EXTENSIONS {
                assert!(!(key == &format!(r"Software\Classes\.{ext}") && name.is_empty()));
            }
        }
        let command = entries.iter().find(|(k, _, _)| k.ends_with(r"shell\open\command")).unwrap();
        assert_eq!(command.2, format!("\"{}\" --play \"%1\"", exe.display()));
        assert_eq!(entries.iter().filter(|(k, _, _)| k.ends_with("OpenWithProgids")).count(), 5);
    }
}
