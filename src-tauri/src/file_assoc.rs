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

fn registration_entries(
    executable: &std::path::Path,
) -> Result<Vec<(String, String, String)>, String> {
    let exe = executable.to_string_lossy();
    if !executable.is_absolute() || exe.contains(['"', '\0']) {
        return Err("播放器路径必须是绝对路径且不能含引号或空字符".into());
    }
    let class = format!(r"Software\Classes\{PROG_ID}");
    let mut entries = vec![
        (class.clone(), "".into(), "轻听音频文件".into()),
        (
            format!(r"{class}\DefaultIcon"),
            "".into(),
            format!("\"{exe}\",0"),
        ),
        (
            format!(r"{class}\shell\open\command"),
            "".into(),
            format!("\"{exe}\" --play \"%1\""),
        ),
        (CAPABILITIES.into(), "ApplicationName".into(), "轻听".into()),
        (
            CAPABILITIES.into(),
            "ApplicationDescription".into(),
            "轻听本地音乐播放器".into(),
        ),
        (
            r"Software\RegisteredApplications".into(),
            APPLICATION_NAME.into(),
            CAPABILITIES.into(),
        ),
    ];
    for ext in EXTENSIONS {
        entries.push((
            format!(r"Software\Classes\.{ext}\OpenWithProgids"),
            PROG_ID.into(),
            String::new(),
        ));
        entries.push((
            format!(r"{CAPABILITIES}\FileAssociations"),
            format!(".{ext}"),
            PROG_ID.into(),
        ));
    }
    Ok(entries)
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn decode_wide(buffer: &[u16]) -> String {
    let length = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..length])
}

/// One registry instance; UTF-16 buffers use the exact same conversion as WinAPI.
/// No process-global hook or test substitution of registration/default policy.
pub trait RegistryBoundary {
    fn write_utf16(&self, key: &[u16], name: &[u16], value: &[u16]) -> Result<(), String>;
    fn read_utf16(&self, key: &[u16], name: &[u16]) -> Result<Option<Vec<u16>>, String>;
    fn delete_value_utf16(&self, key: &[u16], name: &[u16]) -> Result<(), String>;
    fn delete_tree_utf16(&self, key: &[u16]) -> Result<(), String>;
    fn notify(&self);
    fn open_settings(&self) -> Result<(), String>;
}

/// Public instance entry point for registration, state and Unicode roundtrips.
pub struct FileAssociations<R> {
    executable: std::path::PathBuf,
    registry: R,
}

impl<R: RegistryBoundary> FileAssociations<R> {
    pub fn new(executable: std::path::PathBuf, registry: R) -> Self {
        Self {
            executable,
            registry,
        }
    }

    pub fn write_string(&self, key: &str, name: &str, value: &str) -> Result<(), String> {
        self.registry
            .write_utf16(&wide(key), &wide(name), &wide(value))
    }

    pub fn read_string(&self, key: &str, name: &str) -> Result<Option<String>, String> {
        self.registry
            .read_utf16(&wide(key), &wide(name))
            .map(|value| value.map(|buffer| decode_wide(&buffer)))
    }

    pub fn delete_tree(&self, key: &str) -> Result<(), String> {
        self.registry.delete_tree_utf16(&wide(key))
    }

    pub fn state(&self) -> Result<FileAssociationState, String> {
        let entries = registration_entries(&self.executable)?;
        let mut registered = true;
        for (key, name, value) in entries {
            if self.read_string(&key, &name)?.as_deref() != Some(value.as_str()) {
                registered = false;
            }
        }
        let mut default_extensions = Vec::new();
        for ext in EXTENSIONS {
            let key = format!(
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.{ext}\UserChoice"
            );
            if self
                .read_string(&key, "ProgId")?
                .is_some_and(|id| id.eq_ignore_ascii_case(PROG_ID))
            {
                default_extensions.push(ext.into());
            }
        }
        Ok(FileAssociationState {
            supported: true,
            registered,
            extensions: EXTENSIONS.map(str::to_owned).to_vec(),
            default_extensions,
        })
    }

    pub fn register(&self) -> Result<FileAssociationState, String> {
        self.register_with_state(|| self.state())
    }

    fn register_with_state(
        &self,
        state: impl FnOnce() -> Result<FileAssociationState, String>,
    ) -> Result<FileAssociationState, String> {
        for (key, name, value) in registration_entries(&self.executable)? {
            self.write_string(&key, &name, &value)?;
        }
        self.registry.notify();
        state()
    }

    pub fn unregister(&self) -> Result<FileAssociationState, String> {
        self.unregister_with_state(|| self.state())
    }

    fn unregister_with_state(
        &self,
        state: impl FnOnce() -> Result<FileAssociationState, String>,
    ) -> Result<FileAssociationState, String> {
        if !self.state()?.default_extensions.is_empty() {
            self.registry.open_settings()?;
            return Err("轻听仍是部分音频格式的默认播放器。请先在 Windows 默认应用中改选其他播放器，再取消关联。".into());
        }
        for ext in EXTENSIONS {
            self.registry.delete_value_utf16(
                &wide(&format!(r"Software\Classes\.{ext}\OpenWithProgids")),
                &wide(PROG_ID),
            )?;
        }
        self.registry.delete_value_utf16(
            &wide(r"Software\RegisteredApplications"),
            &wide(APPLICATION_NAME),
        )?;
        self.delete_tree(CAPABILITIES)?;
        self.delete_tree(&format!(r"Software\Classes\{PROG_ID}"))?;
        self.registry.notify();
        state()
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{
        ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS, WIN32_ERROR,
    };
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyW, RegDeleteKeyValueW, RegDeleteTreeW, RegGetValueW,
        RegSetKeyValueW, HKEY, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ,
    };
    use windows::Win32::UI::Shell::{
        SHChangeNotify, ShellExecuteW, SHCNE_ASSOCCHANGED, SHCNF_IDLIST,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    fn check(code: WIN32_ERROR, operation: &str) -> Result<(), String> {
        if code == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(format!("{operation}: Windows 错误 {}", code.0))
        }
    }

    fn check_delete(code: WIN32_ERROR) -> Result<(), String> {
        if code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND {
            Ok(())
        } else {
            check(code, "取消文件关联失败")
        }
    }

    struct WindowsRegistry;

    impl RegistryBoundary for WindowsRegistry {
        fn write_utf16(&self, key: &[u16], name: &[u16], value: &[u16]) -> Result<(), String> {
            let mut handle = HKEY::default();
            unsafe {
                check(
                    RegCreateKeyW(HKEY_CURRENT_USER, PCWSTR(key.as_ptr()), &mut handle),
                    "注册播放器失败",
                )?;
                let result = RegSetKeyValueW(
                    handle,
                    PCWSTR::null(),
                    PCWSTR(name.as_ptr()),
                    REG_SZ.0,
                    Some(value.as_ptr().cast()),
                    (value.len() * 2) as u32,
                );
                let _ = RegCloseKey(handle);
                check(result, "写入播放器注册信息失败")
            }
        }

        fn read_utf16(&self, key: &[u16], name: &[u16]) -> Result<Option<Vec<u16>>, String> {
            let mut bytes = 0u32;
            unsafe {
                let result = RegGetValueW(
                    HKEY_CURRENT_USER,
                    PCWSTR(key.as_ptr()),
                    PCWSTR(name.as_ptr()),
                    RRF_RT_REG_SZ,
                    None,
                    None,
                    Some(&mut bytes),
                );
                if result == ERROR_FILE_NOT_FOUND || result == ERROR_PATH_NOT_FOUND {
                    return Ok(None);
                }
                check(result, "读取播放器注册信息失败")?;
                let mut buffer = vec![0u16; bytes as usize / 2 + 1];
                check(
                    RegGetValueW(
                        HKEY_CURRENT_USER,
                        PCWSTR(key.as_ptr()),
                        PCWSTR(name.as_ptr()),
                        RRF_RT_REG_SZ,
                        None,
                        Some(buffer.as_mut_ptr().cast()),
                        Some(&mut bytes),
                    ),
                    "读取播放器注册信息失败",
                )?;
                Ok(Some(buffer))
            }
        }

        fn delete_value_utf16(&self, key: &[u16], name: &[u16]) -> Result<(), String> {
            unsafe {
                check_delete(RegDeleteKeyValueW(
                    HKEY_CURRENT_USER,
                    PCWSTR(key.as_ptr()),
                    PCWSTR(name.as_ptr()),
                ))
            }
        }

        fn delete_tree_utf16(&self, key: &[u16]) -> Result<(), String> {
            unsafe { check_delete(RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(key.as_ptr()))) }
        }

        fn notify(&self) {
            unsafe {
                SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
            }
        }

        fn open_settings(&self) -> Result<(), String> {
            open_settings()
        }
    }

    fn instance() -> Result<FileAssociations<WindowsRegistry>, String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        Ok(FileAssociations::new(exe, WindowsRegistry))
    }

    pub fn state() -> Result<FileAssociationState, String> {
        instance()?.state()
    }
    // Re-read current_exe in the post-write state call, just as the original API did.
    pub fn register() -> Result<FileAssociationState, String> {
        instance()?.register_with_state(state)
    }
    pub fn unregister() -> Result<FileAssociationState, String> {
        instance()?.unregister_with_state(state)
    }

    pub fn open_settings() -> Result<(), String> {
        // URI 由程序固定，不执行用户提供的命令或 URI。Windows 10/11 均支持此入口。
        let result = unsafe {
            ShellExecuteW(
                None,
                w!("open"),
                w!("ms-settings:defaultapps"),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        if result.0 as isize <= 32 {
            Err("无法打开 Windows 默认应用设置".into())
        } else {
            Ok(())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn registry_helpers_roundtrip_only_in_isolated_test_key() {
            let key = r"Software\QuietMusic\Tests\FileAssoc-Owned";
            let registry = FileAssociations::new(
                super::super::tests::executable(),
                super::super::tests::SyntheticRegistry::default(),
            );
            registry
                .write_string(key, "中文名", "C:\\音乐\\轻听.exe")
                .unwrap();
            let value = registry.read_string(key, "中文名");
            let cleaned = registry.delete_tree(key);
            assert_eq!(value.unwrap().as_deref(), Some("C:\\音乐\\轻听.exe"));
            cleaned.unwrap();
            assert_eq!(registry.read_string(key, "中文名").unwrap(), None);
        }
    }
}

#[cfg(windows)]
pub use platform::{open_settings, register, state, unregister};

#[cfg(not(windows))]
pub fn state() -> Result<FileAssociationState, String> {
    Ok(FileAssociationState {
        supported: false,
        registered: false,
        extensions: EXTENSIONS.map(str::to_owned).to_vec(),
        default_extensions: Vec::new(),
    })
}
#[cfg(not(windows))]
pub fn register() -> Result<FileAssociationState, String> {
    Err("当前平台暂不支持文件关联设置".into())
}
#[cfg(not(windows))]
pub fn unregister() -> Result<FileAssociationState, String> {
    Err("当前平台暂不支持文件关联设置".into())
}
#[cfg(not(windows))]
pub fn open_settings() -> Result<(), String> {
    Err("当前平台暂不支持默认应用设置".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::BTreeMap;

    type RegistryValues = BTreeMap<(Vec<u16>, Vec<u16>), Vec<u16>>;

    #[derive(Default)]
    pub(super) struct SyntheticRegistry {
        values: RefCell<RegistryValues>,
        notifications: Cell<usize>,
        settings_opened: Cell<usize>,
    }

    impl RegistryBoundary for SyntheticRegistry {
        fn write_utf16(&self, key: &[u16], name: &[u16], value: &[u16]) -> Result<(), String> {
            assert_eq!(key.last(), Some(&0));
            assert_eq!(name.last(), Some(&0));
            assert_eq!(value.last(), Some(&0));
            self.values
                .borrow_mut()
                .insert((key.to_vec(), name.to_vec()), value.to_vec());
            Ok(())
        }
        fn read_utf16(&self, key: &[u16], name: &[u16]) -> Result<Option<Vec<u16>>, String> {
            Ok(self
                .values
                .borrow()
                .get(&(key.to_vec(), name.to_vec()))
                .cloned())
        }
        fn delete_value_utf16(&self, key: &[u16], name: &[u16]) -> Result<(), String> {
            self.values
                .borrow_mut()
                .remove(&(key.to_vec(), name.to_vec()));
            Ok(())
        }
        fn delete_tree_utf16(&self, key: &[u16]) -> Result<(), String> {
            let key = decode_wide(key);
            self.values.borrow_mut().retain(|(stored, _), _| {
                let stored = decode_wide(stored);
                stored != key && !stored.starts_with(&format!("{key}\\"))
            });
            Ok(())
        }
        fn notify(&self) {
            self.notifications.set(self.notifications.get() + 1);
        }
        fn open_settings(&self) -> Result<(), String> {
            self.settings_opened.set(self.settings_opened.get() + 1);
            Ok(())
        }
    }

    pub(super) fn executable() -> std::path::PathBuf {
        #[cfg(windows)]
        {
            std::path::PathBuf::from(r"C:\SyntheticMusic\轻听.exe")
        }
        #[cfg(not(windows))]
        {
            std::path::PathBuf::from("/synthetic-music/轻听")
        }
    }

    #[test]
    fn registration_never_writes_extension_default_or_user_choice() {
        let exe = executable();
        let entries = registration_entries(&exe).unwrap();
        for (key, name, _) in &entries {
            assert!(!key.contains("UserChoice"));
            for ext in EXTENSIONS {
                assert!(!(key == &format!(r"Software\Classes\.{ext}") && name.is_empty()));
            }
        }
        let command = entries
            .iter()
            .find(|(k, _, _)| k.ends_with(r"shell\open\command"))
            .unwrap();
        assert_eq!(command.2, format!("\"{}\" --play \"%1\"", exe.display()));
        assert_eq!(
            entries
                .iter()
                .filter(|(k, _, _)| k.ends_with("OpenWithProgids"))
                .count(),
            5
        );
    }

    #[test]
    fn synthetic_instance_preserves_unicode_and_registration_policy() {
        let instance = FileAssociations::new(executable(), SyntheticRegistry::default());
        let other = FileAssociations::new(executable(), SyntheticRegistry::default());
        instance
            .write_string("owned", "中文名🎵", "C:\\音乐\\轻听🎵.exe")
            .unwrap();
        assert_eq!(
            instance
                .read_string("owned", "中文名🎵")
                .unwrap()
                .as_deref(),
            Some("C:\\音乐\\轻听🎵.exe")
        );
        assert_eq!(other.read_string("owned", "中文名🎵").unwrap(), None);
        instance.delete_tree("owned").unwrap();
        assert_eq!(instance.read_string("owned", "中文名🎵").unwrap(), None);
        assert!(instance.register().unwrap().registered);
        assert_eq!(instance.registry.notifications.get(), 1);
        for (key, name) in instance.registry.values.borrow().keys() {
            let key = decode_wide(key);
            assert!(!key.contains("UserChoice"));
            for ext in EXTENSIONS {
                assert!(
                    !(key == format!(r"Software\Classes\.{ext}") && decode_wide(name).is_empty())
                );
            }
        }
        let choice = r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.mp3\UserChoice";
        instance
            .write_string(choice, "ProgId", &PROG_ID.to_ascii_lowercase())
            .unwrap();
        let before = instance.registry.values.borrow().clone();
        assert_eq!(instance.state().unwrap().default_extensions, vec!["mp3"]);
        assert!(instance.unregister().unwrap_err().contains("默认播放器"));
        assert_eq!(*instance.registry.values.borrow(), before);
        assert_eq!(instance.registry.settings_opened.get(), 1);
        assert_eq!(instance.registry.notifications.get(), 1);
        instance
            .registry
            .delete_value_utf16(&wide(choice), &wide("ProgId"))
            .unwrap();
        assert!(!instance.unregister().unwrap().registered);
        assert_eq!(instance.registry.notifications.get(), 2);
        assert!(instance.registry.values.borrow().is_empty());
    }
}
