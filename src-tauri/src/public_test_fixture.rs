//! Process-owned filesystem boundary for offline native gates (test builds only).
use std::path::PathBuf;
use std::sync::OnceLock;

pub(crate) fn root() -> &'static PathBuf {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        let requested = PathBuf::from(std::env::var_os("QT_NATIVE_FIXTURE_ROOT")
            .expect("run native tests through the owned fixture gate"));
        let parent = PathBuf::from(std::env::var_os("QT_NATIVE_FIXTURE_PARENT")
            .expect("native fixture parent is mandatory"));
        assert!(requested.is_absolute() && parent.is_absolute());
        assert_eq!(requested.parent(), Some(parent.as_path()));
        assert!(requested.file_name().unwrap().to_string_lossy().starts_with("qt-native-run-"));
        for path in requested.ancestors() {
            let metadata = std::fs::symlink_metadata(path).expect("fixture ancestor unavailable");
            assert!(metadata.is_dir() && !metadata.file_type().is_symlink(), "fixture symlink: {}", path.display());
            #[cfg(windows)] {
                use std::os::windows::fs::MetadataExt;
                assert_eq!(metadata.file_attributes() & 0x400, 0, "fixture reparse point: {}", path.display());
            }
        }
        let requested = requested.canonicalize().unwrap();
        let parent = parent.canonicalize().unwrap();
        assert_eq!(requested.parent(), Some(parent.as_path()));
        let actual = std::env::temp_dir().canonicalize().expect("process temp directory unavailable");
        assert_eq!(actual, requested, "Rust process temp does not match the owned gate root");
        requested
    })
}

#[test]
fn process_temp_is_owned_fixture_root() {
    println!("Native Rust temp attested: {}", root().display());
}
