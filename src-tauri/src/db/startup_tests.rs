use std::path::{Path, PathBuf};

use super::{store, Database};

struct FixtureDirectory(PathBuf);

impl FixtureDirectory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "qt-startup-hygiene-{}-{}",
            std::process::id(),
            fastrand::u64(..)
        ));
        std::fs::create_dir_all(&path).expect("create owned fixture directory");
        Self(path)
    }
}

impl Drop for FixtureDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn backup_paths(directory: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(directory)
        .expect("read owned fixture directory")
        .map(|entry| entry.expect("fixture entry").path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("music.db.bak-"))
        })
        .collect()
}

#[test]
fn opening_checked_waits_for_storage_hygiene_before_backup() {
    let directory = FixtureDirectory::new();
    let path = directory.0.join("music.db");
    {
        let db = Database::open(&path).expect("open synthetic legacy database");
        db.with(|conn| {
            store::set_setting(
                conn,
                crate::astral::SETTING_ASTRAL_SESSION,
                r#"{"token":"STARTUP_LEGACY_TOKEN_CANARY","expiresAt":2000}"#,
            )
        })
        .expect("seed synthetic legacy session");
    }
    let (_db, notice) = Database::open_checked(&path).expect("healthy open");
    assert!(notice.is_none());
    assert!(
        backup_paths(&directory.0).is_empty(),
        "opening copied a legacy token into a new backup before session cleanup"
    );
}
