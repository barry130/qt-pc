//! 本地歌单封面的文件替换策略；数据库登记通过同步回调接入。

use std::fs;
use std::path::{Path, PathBuf};

const COVER_EXTENSIONS: [&str; 3] = ["png", "jpg", "webp"];

#[derive(Debug)]
pub struct CoverReplacement {
    pub path: PathBuf,
    pub cleanup_warnings: Vec<String>,
}

/// 保持 pid.ext 的规范路径。register 返回 Err 时表示数据库登记未提交。
pub fn replace_playlist_cover(
    directory: &Path,
    pid: &str,
    source: &Path,
    extension: &str,
    register: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<CoverReplacement, String> {
    replace_playlist_cover_with_copy(
        directory,
        pid,
        source,
        extension,
        register,
        |source, staged| fs::copy(source, staged),
    )
}

/// The same replacement transaction with a per-call copy adapter; no global IO hook.
/// Production uses `fs::copy`; a failed adapter must leave registration and old covers untouched.
pub fn replace_playlist_cover_with_copy(
    directory: &Path,
    pid: &str,
    source: &Path,
    extension: &str,
    register: impl FnOnce(&Path) -> Result<(), String>,
    copy: impl FnOnce(&Path, &Path) -> std::io::Result<u64>,
) -> Result<CoverReplacement, String> {
    if pid.is_empty()
        || !pid
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        || !COVER_EXTENSIONS.contains(&extension)
    {
        return Err("歌单封面标识或扩展名非法".into());
    }
    // 同进程内的替换必须串行，失败回滚不能覆盖另一轮已经登记成功的图片。
    static REPLACEMENT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _replacement = REPLACEMENT_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    fs::create_dir_all(directory).map_err(|e| format!("创建封面目录失败: {e}"))?;
    let destination = directory.join(format!("{pid}.{extension}"));
    let staged = TemporaryFile::create(directory, pid, extension, "stage")?;
    copy(source, &staged.0).map_err(|e| format!("复制封面文件失败: {e}"))?;
    #[cfg(windows)]
    {
        // CopyFile 会继承源图的只读属性；只调整新建暂存副本，不能改变用户源文件。
        let mut permissions = fs::metadata(&staged.0)
            .map_err(|e| format!("读取暂存封面属性失败: {e}"))?
            .permissions();
        #[expect(
            clippy::permissions_set_readonly_false,
            reason = "Windows-only readonly attribute reset on the new staged copy, never Unix mode bits"
        )]
        permissions.set_readonly(false);
        fs::set_permissions(&staged.0, permissions)
            .map_err(|e| format!("设置暂存封面属性失败: {e}"))?;
    }
    let mut previous = if destination
        .try_exists()
        .map_err(|e| format!("检查原封面失败: {e}"))?
    {
        let backup = TemporaryFile::create(directory, pid, extension, "backup")?;
        fs::rename(&destination, &backup.0).map_err(|e| format!("保存原封面失败: {e}"))?;
        Some(backup)
    } else {
        None
    };
    if let Err(error) = fs::rename(&staged.0, &destination) {
        return Err(rollback_error(
            format!("安装封面文件失败: {error}"),
            &destination,
            &mut previous,
        ));
    }
    if let Err(error) = register(&destination) {
        return Err(rollback_error(
            format!("登记封面失败: {error}"),
            &destination,
            &mut previous,
        ));
    }
    let mut cleanup_warnings = Vec::new();
    if let Some(backup) = previous.as_mut() {
        if let Err(error) = fs::remove_file(&backup.0) {
            if error.kind() != std::io::ErrorKind::NotFound {
                backup.1 = true;
                cleanup_warnings.push(cleanup_warning("旧封面备份", &backup.0, &error));
            }
        }
    }
    for old_extension in COVER_EXTENSIONS {
        let old = directory.join(format!("{pid}.{old_extension}"));
        if old != destination {
            if let Err(error) = fs::remove_file(&old) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    cleanup_warnings.push(cleanup_warning("旧封面", &old, &error));
                }
            }
        }
    }
    Ok(CoverReplacement {
        path: destination,
        cleanup_warnings,
    })
}

fn cleanup_warning(resource: &str, path: &Path, error: &std::io::Error) -> String {
    log::debug!("清理{resource} {} 失败: {error}", path.display());
    let filename = path.file_name().unwrap_or_default().to_string_lossy();
    format!("清理{resource} {filename} 失败: {error}")
}

fn rollback_error(
    primary: String,
    destination: &Path,
    previous: &mut Option<TemporaryFile>,
) -> String {
    let rollback = if let Some(backup) = previous.as_mut() {
        fs::rename(&backup.0, destination).map_err(|error| {
            // 回滚失败时保留原图副本，不允许临时文件 Drop 把唯一有效资源删掉。
            backup.1 = true;
            format!("恢复原封面失败: {error}；原图保留在 {}", backup.0.display())
        })
    } else {
        match fs::remove_file(destination) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("清理未登记封面失败: {error}")),
        }
    };
    match rollback {
        Ok(()) => primary,
        Err(error) => format!("{primary}；{error}"),
    }
}

struct TemporaryFile(PathBuf, bool);

impl TemporaryFile {
    fn create(directory: &Path, pid: &str, extension: &str, role: &str) -> Result<Self, String> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT_FILE: AtomicU64 = AtomicU64::new(0);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        for _ in 0..16 {
            let path = directory.join(format!(
                ".{pid}.{extension}.{role}-{}-{stamp}-{}",
                std::process::id(),
                NEXT_FILE.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(_) => return Ok(Self(path, false)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("创建封面临时文件失败: {error}")),
            }
        }
        Err("无法分配封面临时文件".into())
    }
}

impl Drop for TemporaryFile {
    fn drop(&mut self) {
        if !self.1 {
            let _ = fs::remove_file(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "quietmusic-cover-regression-{}-{}",
                std::process::id(),
                NEXT_TEST.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).expect("create owned synthetic directory");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_successful_registration_installs_then_retires_other_extensions() {
        let directory = TestDirectory::new();
        let old_cover = directory.0.join("playlist-A.jpg");
        let other_cover = directory.0.join("playlist-A.webp");
        let source = directory.0.join("new-source.png");
        fs::write(&old_cover, b"original-cover").unwrap();
        fs::write(&other_cover, b"other-old-cover").unwrap();
        fs::write(&source, b"replacement-cover").unwrap();
        let result = replace_playlist_cover(&directory.0, "playlist-A", &source, "png", |path| {
            assert_eq!(fs::read(path).unwrap(), b"replacement-cover");
            assert!(
                old_cover.is_file() && other_cover.is_file(),
                "retire old resources only after the database commits"
            );
            Ok(())
        })
        .unwrap();
        assert_eq!(result.path, directory.0.join("playlist-A.png"));
        assert!(result.cleanup_warnings.is_empty());
        assert!(!old_cover.exists() && !other_cover.exists());
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 2);
    }

    #[test]
    fn selecting_the_existing_cover_does_not_truncate_it() {
        let directory = TestDirectory::new();
        let source = directory.0.join("playlist-A.jpg");
        fs::write(&source, b"original-cover").unwrap();
        replace_playlist_cover(&directory.0, "playlist-A", &source, "jpg", |_| Ok(())).unwrap();
        assert_eq!(fs::read(&source).unwrap(), b"original-cover");
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[test]
    fn a_failed_concurrent_replacement_does_not_erase_a_successful_one() {
        let directory = TestDirectory::new();
        let old_cover = directory.0.join("playlist-A.jpg");
        let source_a = directory.0.join("source-A.jpg");
        let source_b = directory.0.join("source-B.jpg");
        fs::write(&old_cover, b"original-cover").unwrap();
        fs::write(&source_a, b"replacement-A").unwrap();
        fs::write(&source_b, b"replacement-B").unwrap();
        let barrier = std::sync::Barrier::new(3);
        std::thread::scope(|scope| {
            let failed = scope.spawn(|| {
                barrier.wait();
                replace_playlist_cover(&directory.0, "playlist-A", &source_a, "jpg", |_| {
                    std::thread::yield_now();
                    Err("synthetic A registration failure".into())
                })
            });
            let successful = scope.spawn(|| {
                barrier.wait();
                replace_playlist_cover(&directory.0, "playlist-A", &source_b, "jpg", |path| {
                    assert_eq!(fs::read(path).unwrap(), b"replacement-B");
                    Ok(())
                })
            });
            barrier.wait();
            assert!(failed.join().unwrap().is_err());
            assert!(successful.join().unwrap().is_ok());
        });
        assert_eq!(fs::read(old_cover).unwrap(), b"replacement-B");
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 3);
    }

    #[cfg(windows)]
    #[test]
    fn a_readonly_source_does_not_prevent_rollback_or_change_source_permissions() {
        let directory = TestDirectory::new();
        let old_cover = directory.0.join("playlist-A.jpg");
        let source = directory.0.join("new-source.jpg");
        fs::write(&old_cover, b"original-cover").unwrap();
        fs::write(&source, b"replacement-cover").unwrap();
        let original = fs::metadata(&source).unwrap().permissions();
        let mut readonly = original.clone();
        readonly.set_readonly(true);
        fs::set_permissions(&source, readonly).unwrap();
        let result = replace_playlist_cover(&directory.0, "playlist-A", &source, "jpg", |_| {
            Err("synthetic database failure".into())
        });
        let source_unchanged = fs::metadata(&source).unwrap().permissions().readonly();
        fs::set_permissions(&source, original.clone()).unwrap();
        // 只清理本测试创建的文件属性，确保红测试也能回收自己的临时目录。
        if old_cover.exists() {
            fs::set_permissions(&old_cover, original).unwrap();
        }
        assert!(
            source_unchanged,
            "replacement must not change the selected source"
        );
        assert!(result.unwrap_err().contains("synthetic database failure"));
        assert_eq!(fs::read(&old_cover).unwrap(), b"original-cover");
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 2);
    }

    #[test]
    fn failed_registration_rolls_back_same_and_different_extensions() {
        for extension in ["jpg", "png"] {
            let directory = TestDirectory::new();
            let old_cover = directory.0.join("playlist-A.jpg");
            let source = directory.0.join("new-source.png");
            fs::write(&old_cover, b"original-cover").unwrap();
            fs::write(&source, b"replacement-cover").unwrap();
            let called = std::cell::Cell::new(false);
            let result =
                replace_playlist_cover(&directory.0, "playlist-A", &source, extension, |_| {
                    called.set(true);
                    Err("synthetic database failure".into())
                });
            assert!(called.get());
            assert!(result.unwrap_err().contains("synthetic database failure"));
            assert_eq!(
                fs::read(&old_cover).unwrap(),
                b"original-cover",
                "failed registration replaced the prior image"
            );
            assert_eq!(
                fs::read_dir(&directory.0).unwrap().count(),
                2,
                "failed registration left an unregistered image or staging file"
            );
        }
    }

    #[test]
    fn an_unreadable_new_source_preserves_the_existing_cover() {
        let directory = TestDirectory::new();
        let old_cover = directory.0.join("playlist-A.jpg");
        fs::write(&old_cover, b"original-cover").unwrap();
        let result = replace_playlist_cover(
            &directory.0,
            "playlist-A",
            &directory.0.join("missing-source.png"),
            "png",
            |_| panic!("an unreadable source must not reach database registration"),
        );
        assert!(result.is_err());
        assert!(
            old_cover.is_file(),
            "a failed replacement deleted the valid old cover"
        );
        assert_eq!(fs::read(old_cover).unwrap(), b"original-cover");
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[test]
    fn cleanup_failure_warning_uses_filename_after_actual_cover_registration() {
        use crate::db::{store, Database};
        use crate::lyric_access::native_fixture::NativeFixture;

        let fixture = NativeFixture::new("cover-warning");
        let db = Database::open_in_memory().unwrap();
        let pid = db
            .with(|conn| store::create_playlist(conn, "owned cleanup warning"))
            .unwrap();
        // A directory at an obsolete extension makes actual remove_file fail on every OS.
        let obsolete = fixture.dir(&format!("{pid}.jpg"));
        let source = fixture.file("new-source.png", b"replacement-cover");
        let result = replace_playlist_cover(fixture.path(), &pid, &source, "png", |path| {
            let registered = format!("{}", path.display());
            let updated =
                db.with(|conn| store::set_playlist_cover_path(conn, &pid, &registered))?;
            if updated == 0 {
                return Err(String::from("只有本地自建歌单可以更换封面"));
            }
            Ok(())
        })
        .unwrap();

        assert_eq!(
            db.with(|conn| store::playlist_cover_path(conn, &pid))
                .unwrap(),
            Some(format!("{}", result.path.display()))
        );
        assert_eq!(fs::read(&result.path).unwrap(), b"replacement-cover");
        assert_eq!(fs::read(&source).unwrap(), b"replacement-cover");
        assert!(
            obsolete.is_dir(),
            "a cleanup warning must not turn success into rollback"
        );
        assert_eq!(result.cleanup_warnings.len(), 1);
        let warning = &result.cleanup_warnings[0];
        assert!(
            warning.starts_with(&format!("清理旧封面 {pid}.jpg 失败: ")),
            "warn-level cleanup message must contain only the filename: {warning}"
        );
        assert!(
            !warning.contains(&format!("{}", fixture.path().display())),
            "warn-level cleanup message must not expose the owned data-root path"
        );
    }

    #[test]
    fn interrupted_staged_copy_preserves_existing_cover_and_registered_path() {
        use crate::db::{store, Database};
        use std::io::{Read, Write};

        let directory = TestDirectory::new();
        let db = Database::open_in_memory().unwrap();
        let pid = db
            .with(|conn| store::create_playlist(conn, "owned C14 cover"))
            .unwrap();
        let old_cover = directory.0.join(format!("{pid}.jpg"));
        let other_cover = directory.0.join(format!("{pid}.webp"));
        let source = directory.0.join("new-source.png");
        fs::write(&old_cover, b"original-cover").unwrap();
        fs::write(&other_cover, b"other-old-cover").unwrap();
        fs::write(&source, b"replacement-cover").unwrap();
        let old_path = format!("{}", old_cover.display());
        assert_eq!(
            db.with(|conn| store::set_playlist_cover_path(conn, &pid, &old_path))
                .unwrap(),
            1
        );
        let original_entries = fs::read_dir(&directory.0)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<std::collections::BTreeSet<_>>();
        let copied = std::cell::Cell::new(false);
        let registered = std::cell::Cell::new(false);
        let result = replace_playlist_cover_with_copy(
            &directory.0,
            &pid,
            &source,
            "png",
            |path| {
                registered.set(true);
                let path = path.to_string_lossy().into_owned();
                let updated = db.with(|conn| store::set_playlist_cover_path(conn, &pid, &path))?;
                if updated == 0 {
                    return Err(String::from("只有本地自建歌单可以更换封面"));
                }
                Ok(())
            },
            |source, staged| {
                let mut prefix = [0; 4];
                {
                    let mut reader = fs::File::open(source)?;
                    let mut writer = fs::OpenOptions::new().write(true).open(staged)?;
                    reader.read_exact(&mut prefix)?;
                    writer.write_all(&prefix)?;
                    writer.flush()?;
                }
                assert_eq!(
                    fs::read(staged).unwrap(),
                    b"repl",
                    "the real stage must have been partially written"
                );
                copied.set(true);
                Err(std::io::Error::other("owned-mid-copy-failure"))
            },
        );
        assert!(copied.get() && !registered.get());
        let error = result.unwrap_err();
        assert!(error.contains("复制封面文件失败") && error.contains("owned-mid-copy-failure"));
        assert_eq!(fs::read(&old_cover).unwrap(), b"original-cover");
        assert_eq!(fs::read(&other_cover).unwrap(), b"other-old-cover");
        assert_eq!(fs::read(&source).unwrap(), b"replacement-cover");
        assert_eq!(
            db.with(|conn| store::playlist_cover_path(conn, &pid))
                .unwrap(),
            Some(old_path)
        );
        let entries = fs::read_dir(&directory.0)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            entries, original_entries,
            "failed copy must not leave a new cover, stage or backup"
        );
        drop(db);
    }
}
