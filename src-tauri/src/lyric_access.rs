//! 歌词窗口的公有域授权边界（S05）。
//!
//! 独立歌词窗口（`label = "lyrics"`）是与主窗口共命令注册表的第二个 WebView，
//! 但它的正文来自网络歌词 / 音源包返回 / 本地 `.lrc` 文件——一旦这些内容被投毒，
//! 窗口内就有脚本执行面。`ipc_guard::LYRICS_ALLOWED_COMMANDS` 管住「能调哪些
//! 命令」，本模块再管住「参数能指到哪」：
//!
//! 1. **settings**：歌词窗口只读 8 个前端业务键（含 `sourceAuth.*`，这是既有
//!    前端账号业务的例外），只写 2 个按平台音质键；`sourceAuth.accounts`
//!    这类账户数据可读不可写。
//! 2. **Track**：请求曲目必须与 native 当前播放曲目 [`Track::same_identity`]
//!    吻合，并返回 native 曲目克隆——后续 resolve / 落库只能用 native 元数据，
//!    不能用调用方伪造的歌名/时长/平台。
//! 3. **本地文件**：请求的音频路径必须与可信音频（native 当前本地曲目，或
//!    可信 resolve 命中的文件）**canonical 完全相等**（不是前缀），返回可信
//!    路径；旁挂 `.lrc` 的实际 canonical parent 必须等于可信音频词法 parent
//!    的 canonical 目录，防止 symlink/junction 把读盘引到别的目录。
//!
//! 本模块刻意不依赖 Tauri 窗口、音频引擎或 `local.rs`：中央 commands 负责取
//! native 快照、组装参数，再把授权结果交给真正的读盘/DB 函数。这样授权逻辑
//! 可以用合成 tempfile 独立测，也便于以后复用到别的受限窗口。
//!
//! # 中央接线（示意，实际由 `commands.rs` 落地）
//!
//! ```ignore
//! // get_setting / set_setting：按窗口 label 分支，使用返回的规范键读库。
//! let key = if label == LYRIC_WINDOW_LABEL {
//!     lyric_access::setting_read_key(&key).map_err(|e| e.to_string())?
//! } else {
//!     key.as_str()
//! };
//!
//! // resolve_local_file / read_local_lyric：
//! let current = state.engine.snapshot().track;                    // native
//! let track = lyric_access::authorized_track(current.as_ref(), &requested)?;
//! let trusted_audio = /* 本地轨：strip_cue_suffix(track.id)；在线轨：可信 resolve 命中 */;
//! let audio = lyric_access::authorized_audio(&trusted_audio, Path::new(&requested_path))?;
//! let sidecar = local::find_lrc_sidecar(&audio).map(|s| lyric_access::authorized_sidecar(&audio, &s)).transpose()?;
//! let lyric = local::read_authorized_sidecar(&audio, sidecar.as_deref()); // local.rs 新增的公有 Reader
//! ```

use std::path::{Path, PathBuf};

use crate::provider::types::Track;

/// 歌词窗口允许经 `get_setting` 读取的 settings 键（恰好 8 个）。
///
/// `sourceAuth.*` 是既有的前端账号业务键（登录态开关 / 账号表）：歌词窗口的
/// 音源注册表迁移需要读它们；但**只读**，见 [`LYRIC_WRITE_SETTING_KEYS`]。
/// `quality` / `downloadQuality` 是旧全局音质键，迁移回落时读一次。
pub const LYRIC_READ_SETTING_KEYS: [&str; 8] = [
    "sourceAuth.accounts",
    "sourceAuth.toggles",
    "sourceAuth.useMeta",
    "sourceAuth.usePlay",
    "play.sourceQualities",
    "download.sourceQualities",
    "quality",
    "downloadQuality",
];

/// 歌词窗口允许经 `set_setting` 写入的 settings 键（恰好 2 个）。
///
/// 只有按平台音质表：注册表迁移（`migrateStaleQualities`）与音质选择会写它们。
/// 账户、收藏游标、外观等一律不可写。
pub const LYRIC_WRITE_SETTING_KEYS: [&str; 2] =
    ["play.sourceQualities", "download.sourceQualities"];

/// 授权失败原因。中央命令把 [`LyricAccessError::message`] 交给前端/日志。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LyricAccessError {
    /// 请求的 settings 键不在歌词窗口读取白名单内。
    SettingReadDenied,
    /// 请求的 settings 键不在歌词窗口写入白名单内。
    SettingWriteDenied,
    /// native 当前没有正在播放的曲目（歌词窗口没资格解析任意曲目）。
    NoCurrentTrack,
    /// 请求曲目与 native 当前曲目不是同一身份（平台 + id）。
    TrackMismatch,
    /// 可信音频路径本身不可用（不存在 / 无法 canonical 化）。
    TrustedAudioUnavailable,
    /// 请求音频路径不可用（不存在 / 无法 canonical 化）。
    RequestedAudioUnavailable,
    /// 请求音频与可信音频不是同一个文件（canonical 不相等）。
    AudioMismatch,
    /// 可信音频没有父目录（根目录等），无法确定旁挂歌词边界。
    AudioWithoutParent,
    /// 旁挂 `.lrc` 实际不可用（不存在 / 悬空链接 / 无法 canonical 化）。
    SidecarUnavailable,
    /// 旁挂 `.lrc` 的实际 canonical parent 不是可信音频所在目录。
    SidecarOutsideAudioDir,
}

impl LyricAccessError {
    /// 稳定、可直接展示的中文文案（中央命令转 `String` 用）。
    pub fn message(self) -> &'static str {
        match self {
            Self::SettingReadDenied => "歌词窗口无权读取该设置",
            Self::SettingWriteDenied => "歌词窗口无权修改该设置",
            Self::NoCurrentTrack => "当前没有正在播放的曲目",
            Self::TrackMismatch => "请求的曲目不是当前播放的曲目",
            Self::TrustedAudioUnavailable => "无法确认当前曲目的音频文件",
            Self::RequestedAudioUnavailable => "请求的音频文件不可用",
            Self::AudioMismatch => "请求的音频路径不是当前曲目",
            Self::AudioWithoutParent => "音频路径缺少所在目录",
            Self::SidecarUnavailable => "歌词旁挂文件不可用",
            Self::SidecarOutsideAudioDir => "歌词旁挂文件不在音频所在目录",
        }
    }
}

impl std::fmt::Display for LyricAccessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for LyricAccessError {}

/// 校验歌词窗口的 settings 读取请求。
///
/// `Ok` 返回白名单里的**规范键**：中央命令必须拿返回值去读库，而不是继续用
/// 入参，保证「检查的字符串」与「实际使用的字符串」是同一份。比较是严格相等
/// （不 trim、不忽略大小写）：settings 键本身就是大小写敏感的裸字符串。
pub fn setting_read_key(key: &str) -> Result<&'static str, LyricAccessError> {
    LYRIC_READ_SETTING_KEYS
        .iter()
        .copied()
        .find(|allowed| *allowed == key)
        .ok_or(LyricAccessError::SettingReadDenied)
}

/// 校验歌词窗口的 settings 写入请求；返回规范键，用法同 [`setting_read_key`]。
pub fn setting_write_key(key: &str) -> Result<&'static str, LyricAccessError> {
    LYRIC_WRITE_SETTING_KEYS
        .iter()
        .copied()
        .find(|allowed| *allowed == key)
        .ok_or(LyricAccessError::SettingWriteDenied)
}

/// 校验调用方曲目与 native 当前曲目同身份，返回 **native 曲目克隆**。
///
/// 元数据（歌名/专辑/时长/封面/CUE 偏移）不参与身份判断（[`Track::same_identity`]
/// 只比平台 + id）：允许前端用旧列表项来请求，但后续 resolve 必须用返回的
/// native 克隆，不能信任请求里的元数据。
pub fn authorized_track(
    current: Option<&Track>,
    requested: &Track,
) -> Result<Track, LyricAccessError> {
    let current = current.ok_or(LyricAccessError::NoCurrentTrack)?;
    if !current.same_identity(requested) {
        return Err(LyricAccessError::TrackMismatch);
    }
    // 返回 native 克隆：请求里的元数据可能来自旧列表/伪造，不能带进 resolve。
    Ok(current.clone())
}

/// 校验请求音频与可信音频是同一个文件，返回可信路径。
///
/// - 两边都 canonical 化后做**完全相等**比较，不做前缀匹配（`song.mp3.bak`
///   不是 `song.mp3`）。
/// - 返回的是**可信的**那条路径（词法形式，不是 canonical 形式）：后续
///   `find_lrc_sidecar` 必须按应用实际看到的可信路径找旁挂歌词，不能改用
///   调用方传来的 alias 路径。
pub fn authorized_audio(trusted: &Path, requested: &Path) -> Result<PathBuf, LyricAccessError> {
    let trusted_canonical =
        std::fs::canonicalize(trusted).map_err(|_| LyricAccessError::TrustedAudioUnavailable)?;
    let requested_canonical = std::fs::canonicalize(requested)
        .map_err(|_| LyricAccessError::RequestedAudioUnavailable)?;
    if trusted_canonical != requested_canonical {
        return Err(LyricAccessError::AudioMismatch);
    }
    // 返回可信的词法路径：旁挂歌词要找在应用实际看到的这条路径旁边
    // （音频自身是链接时，canonical 形式会把位置换到链接目标那边）。
    Ok(trusted.to_path_buf())
}

/// 校验旁挂歌词文件确实位于可信音频所在目录，返回实际 canonical 文件路径。
///
/// 边界口径：`canonicalize(sidecar 的实际文件).parent()` 必须等于
/// `canonicalize(可信音频的词法 parent)`。比较侧挂文件的**实际**位置，能挡住
/// 指向别的目录的 symlink / junction；比较可信音频的**词法** parent，是因为
/// 旁挂文件本来就放在用户看到的那条路径旁边（音频自身是链接时也一样）。
///
/// 返回 canonical 路径供中央直接读盘：符号链接已被解析，不再按调用方 alias
/// 二次 `find_lrc_sidecar`（避免检查与读取指向不同文件）。
pub fn authorized_sidecar(
    trusted_audio: &Path,
    sidecar: &Path,
) -> Result<PathBuf, LyricAccessError> {
    authorized_sidecar_with_probe(trusted_audio, sidecar, &FilesystemLyricPathProbe)
}

/// Instance metadata boundary. Implementations resolve paths and report file kind;
/// authorization and the returned trusted path remain in the shared guard below.
pub trait LyricPathProbe {
    fn canonicalize(&self, path: &Path) -> std::io::Result<PathBuf>;
    fn is_file(&self, canonical: &Path) -> bool;
}

pub struct FilesystemLyricPathProbe;

impl LyricPathProbe for FilesystemLyricPathProbe {
    fn canonicalize(&self, path: &Path) -> std::io::Result<PathBuf> {
        std::fs::canonicalize(path)
    }

    fn is_file(&self, canonical: &Path) -> bool {
        canonical.is_file()
    }
}

pub fn authorized_sidecar_with_probe(
    trusted_audio: &Path,
    sidecar: &Path,
    probe: &impl LyricPathProbe,
) -> Result<PathBuf, LyricAccessError> {
    // Both the real filesystem and synthetic reparse input use this same policy.
    let audio_parent = trusted_audio
        .parent()
        .ok_or(LyricAccessError::AudioWithoutParent)?;
    let audio_dir = probe
        .canonicalize(audio_parent)
        .map_err(|_| LyricAccessError::TrustedAudioUnavailable)?;
    let sidecar_canonical = probe
        .canonicalize(sidecar)
        .map_err(|_| LyricAccessError::SidecarUnavailable)?;
    if !probe.is_file(&sidecar_canonical) {
        return Err(LyricAccessError::SidecarUnavailable);
    }
    let sidecar_parent = sidecar_canonical
        .parent()
        .ok_or(LyricAccessError::SidecarUnavailable)?;
    if sidecar_parent != audio_dir {
        return Err(LyricAccessError::SidecarOutsideAudioDir);
    }
    Ok(sidecar_canonical)
}

/// Shared by this slice's tests only; allocation never falls back to user paths.
#[cfg(test)]
pub(crate) mod native_fixture {
    use std::path::{Component, Path, PathBuf};

    pub(crate) struct NativeFixture {
        path: PathBuf,
    }

    fn check_directory(path: &Path) {
        assert!(path.is_absolute(), "fixture path must be absolute");
        for ancestor in path.ancestors() {
            let metadata =
                std::fs::symlink_metadata(ancestor).expect("fixture ancestor unavailable");
            assert!(
                metadata.is_dir() && !metadata.file_type().is_symlink(),
                "fixture ancestor is not an ordinary directory: {}",
                ancestor.display()
            );
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                assert_eq!(
                    metadata.file_attributes() & 0x400,
                    0,
                    "fixture reparse ancestor: {}",
                    ancestor.display()
                );
            }
        }
        assert_eq!(path.canonicalize().expect("fixture canonicalize"), path);
    }

    fn check_tree(path: &Path) {
        let metadata = std::fs::symlink_metadata(path).expect("owned fixture metadata");
        assert!(
            !metadata.file_type().is_symlink(),
            "fixture symlink: {}",
            path.display()
        );
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            assert_eq!(
                metadata.file_attributes() & 0x400,
                0,
                "fixture reparse point: {}",
                path.display()
            );
        }
        assert_eq!(
            path.canonicalize().expect("owned fixture canonicalize"),
            path
        );
        if metadata.is_dir() {
            for entry in std::fs::read_dir(path).expect("owned fixture entries") {
                check_tree(&entry.expect("owned fixture entry").path());
            }
        }
    }

    fn owned_relative(path: &Path) -> &Path {
        let root = crate::public_test_fixture::root();
        check_directory(root);
        let relative = path
            .strip_prefix(root)
            .expect("fixture path outside attested root");
        assert!(relative
            .components()
            .all(|c| matches!(c, Component::Normal(_))));
        let first = relative
            .components()
            .next()
            .expect("fixture child required");
        assert!(first
            .as_os_str()
            .to_string_lossy()
            .starts_with("qt-native-owned-"));
        check_directory(&root.join(first.as_os_str()));
        relative
    }

    pub(crate) fn create_owned_dir(path: &Path) {
        let relative = owned_relative(path);
        let mut current = crate::public_test_fixture::root().to_path_buf();
        for component in relative.components() {
            check_directory(&current);
            current.push(component.as_os_str());
            match std::fs::create_dir(&current) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => panic!("owned fixture subdirectory: {error}"),
            }
            check_directory(&current);
        }
    }

    /// Existing test files may be intentionally rewritten; new files are exclusive.
    pub(crate) fn write_owned(
        path: impl AsRef<Path>,
        contents: impl AsRef<[u8]>,
    ) -> std::io::Result<()> {
        use std::io::Write;
        let path = path.as_ref();
        owned_relative(path);
        create_owned_dir(path.parent().expect("owned file parent"));
        let mut options = std::fs::OpenOptions::new();
        options.write(true);
        match std::fs::symlink_metadata(path) {
            Ok(metadata) => {
                assert!(
                    metadata.is_file(),
                    "owned write target must be an ordinary file"
                );
                check_tree(path);
                options.truncate(true);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                options.create_new(true);
            }
            Err(error) => return Err(error),
        }
        options.open(path)?.write_all(contents.as_ref())
    }

    impl NativeFixture {
        pub(crate) fn new(tag: &str) -> Self {
            assert!(!tag.is_empty() && tag.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
            let root = crate::public_test_fixture::root();
            check_directory(root);
            let path = root.join(format!("qt-native-owned-{tag}-{:016x}", fastrand::u64(..)));
            // create_dir is exclusive: an existing child is never adopted or removed.
            std::fs::create_dir(&path).expect("exclusive owned fixture allocation");
            check_directory(&path);
            Self { path }
        }

        pub(crate) fn path(&self) -> &Path {
            &self.path
        }

        pub(crate) fn dir(&self, name: &str) -> PathBuf {
            assert!(Path::new(name)
                .components()
                .all(|c| matches!(c, Component::Normal(_))));
            check_directory(&self.path);
            let path = self.path.join(name);
            create_owned_dir(&path);
            path
        }

        pub(crate) fn file(&self, name: &str, contents: &[u8]) -> PathBuf {
            use std::io::Write;
            assert!(Path::new(name)
                .components()
                .all(|c| matches!(c, Component::Normal(_))));
            check_directory(&self.path);
            let path = self.path.join(name);
            check_directory(path.parent().expect("owned file parent"));
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .expect("exclusive owned fixture file");
            file.write_all(contents).expect("owned fixture contents");
            path
        }

        pub(crate) fn remove_file(&self, path: &Path) {
            check_directory(&self.path);
            assert!(path.starts_with(&self.path) && path != self.path);
            check_directory(path.parent().expect("owned file parent"));
            check_tree(path);
            assert!(std::fs::symlink_metadata(path)
                .expect("owned file metadata")
                .is_file());
            std::fs::remove_file(path).expect("owned fixture file cleanup");
        }

        pub(crate) fn remove(&self) {
            let root = crate::public_test_fixture::root();
            check_directory(root);
            assert_eq!(self.path.parent(), Some(root.as_path()));
            match std::fs::symlink_metadata(&self.path) {
                Ok(_) => {
                    check_directory(&self.path);
                    check_tree(&self.path);
                    std::fs::remove_dir_all(&self.path).expect("owned fixture cleanup");
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => panic!("owned fixture cleanup metadata: {error}"),
            }
        }
    }

    impl std::ops::Deref for NativeFixture {
        type Target = Path;
        fn deref(&self) -> &Path {
            self.path()
        }
    }

    impl Drop for NativeFixture {
        fn drop(&mut self) {
            self.remove();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::native_fixture::{write_owned, NativeFixture};
    use super::*;

    // Keep the existing fixture call sites and assertions, with no fallback root.
    struct TempDir {
        path: PathBuf,
        owned: NativeFixture,
    }

    impl TempDir {
        fn new(tag: &str) -> Self {
            let owned = NativeFixture::new(tag);
            Self {
                path: owned.path().to_path_buf(),
                owned,
            }
        }

        fn dir(&self, name: &str) -> PathBuf {
            self.owned.dir(name)
        }

        fn file(&self, name: &str, contents: &[u8]) -> PathBuf {
            self.owned.file(name, contents)
        }
    }

    fn track(platform: &str, id: &str, title: &str) -> Track {
        Track {
            id: id.into(),
            platform: crate::provider::types::SourceId::new(platform),
            title: title.into(),
            singer: "歌手".into(),
            album: "专辑".into(),
            pic_url: String::new(),
            duration: 200.0,
            recording: Default::default(), music_id: None,
            start_ms: None,
            end_ms: None,
        }
    }

    // ---------- settings：8 READ / 2 WRITE ----------

    #[test]
    fn setting_read_allows_exactly_the_eight_lyric_keys() {
        assert_eq!(LYRIC_READ_SETTING_KEYS.len(), 8);
        for key in LYRIC_READ_SETTING_KEYS {
            assert_eq!(setting_read_key(key), Ok(key), "{key} 应可读");
        }
    }

    #[test]
    fn setting_read_rejects_everything_else() {
        for key in [
            "astral.session",
            "ai.profiles",
            "appearance",
            "lyric.window",
            "like.sync.seq",
            "downloadQuality ",
            "Quality",
            "sourceAuth.accounts.extra",
            "",
        ] {
            assert_eq!(
                setting_read_key(key),
                Err(LyricAccessError::SettingReadDenied),
                "{key} 不应可读"
            );
        }
    }

    #[test]
    fn setting_write_allows_only_the_two_quality_tables() {
        assert_eq!(LYRIC_WRITE_SETTING_KEYS.len(), 2);
        for key in LYRIC_WRITE_SETTING_KEYS {
            assert_eq!(setting_write_key(key), Ok(key), "{key} 应可写");
        }
        // 只读键（尤其账户）一律不可写；写入白名单是读取白名单的真子集。
        for key in LYRIC_READ_SETTING_KEYS {
            if LYRIC_WRITE_SETTING_KEYS.contains(&key) {
                continue;
            }
            assert_eq!(
                setting_write_key(key),
                Err(LyricAccessError::SettingWriteDenied),
                "{key} 不应可写"
            );
        }
        assert_eq!(
            setting_write_key("setting_not_in_any_list"),
            Err(LyricAccessError::SettingWriteDenied)
        );
    }

    // ---------- Track：同身份 + native 克隆 ----------

    #[test]
    fn track_requires_same_identity_and_returns_native_clone() {
        let native = track("wyy", "42", "native 歌名");
        let mut requested = native.clone();
        requested.title = "调用方伪造的歌名".into();
        requested.album = "伪造专辑".into();
        requested.duration = 999.0;
        requested.start_ms = Some(12_345);

        let trusted = authorized_track(Some(&native), &requested).expect("同身份应放行");
        assert_eq!(trusted.title, "native 歌名", "必须返回 native 元数据");
        assert_eq!(trusted.album, "专辑");
        assert_eq!(trusted.duration, 200.0);
        assert_eq!(trusted.start_ms, None);
    }

    #[test]
    fn track_rejects_different_identity_or_missing_current() {
        let native = track("wyy", "42", "歌");
        assert!(matches!(
            authorized_track(Some(&native), &track("wyy", "43", "歌")),
            Err(LyricAccessError::TrackMismatch)
        ));
        // 同裸 id、不同平台：不是同一首（C17 口径）。
        assert!(matches!(
            authorized_track(Some(&native), &track("qq", "42", "歌")),
            Err(LyricAccessError::TrackMismatch)
        ));
        assert!(matches!(
            authorized_track(None, &native),
            Err(LyricAccessError::NoCurrentTrack)
        ));
    }

    // ---------- 音频：canonical 完全相等 ----------

    #[test]
    fn audio_accepts_same_file_and_returns_trusted_path() {
        let tmp = TempDir::new("audio-same");
        let audio = tmp.file("song.mp3", b"audio");
        assert_eq!(
            authorized_audio(&audio, &audio).expect("同一文件应放行"),
            audio,
            "返回可信路径"
        );

        // 文本别名（. 与 ..）canonical 后相同，仍放行；返回值仍是可信路径。
        let sub = tmp.dir("sub");
        let alias = sub.join("..").join("song.mp3");
        assert_eq!(authorized_audio(&audio, &alias), Ok(audio));
    }

    #[test]
    fn audio_rejects_prefix_sibling_and_other_file() {
        let tmp = TempDir::new("audio-reject");
        let audio = tmp.file("song.mp3", b"audio");
        let sibling = tmp.file("song.mp3.bak", b"audio");
        assert_eq!(
            authorized_audio(&audio, &sibling),
            Err(LyricAccessError::AudioMismatch),
            "前缀不是同一文件"
        );

        let other_dir = tmp.dir("other");
        write_owned(other_dir.join("song.mp3"), b"audio").expect("写另一个文件");
        assert_eq!(
            authorized_audio(&audio, &other_dir.join("song.mp3")),
            Err(LyricAccessError::AudioMismatch)
        );
    }

    #[test]
    fn audio_rejects_missing_paths() {
        let tmp = TempDir::new("audio-missing");
        let audio = tmp.file("song.mp3", b"audio");
        let missing = tmp.path.join("missing.mp3");
        assert_eq!(
            authorized_audio(&audio, &missing),
            Err(LyricAccessError::RequestedAudioUnavailable)
        );
        assert_eq!(
            authorized_audio(&missing, &audio),
            Err(LyricAccessError::TrustedAudioUnavailable)
        );
    }

    // ---------- 旁挂歌词：实际 canonical parent 必须就是音频目录 ----------

    #[test]
    fn sidecar_accepts_same_dir_file_and_returns_actual_canonical_path() {
        let tmp = TempDir::new("sidecar-ok");
        let audio = tmp.file("song.mp3", b"audio");
        let lrc = tmp.file("song.lrc", "[00:00.00]词".as_bytes());
        assert_eq!(
            authorized_sidecar(&audio, &lrc).expect("同目录旁挂应放行"),
            std::fs::canonicalize(&lrc).expect("canonical")
        );
    }

    #[test]
    fn sidecar_accepts_textual_escape_that_canonicalizes_into_audio_dir() {
        let tmp = TempDir::new("sidecar-dotdot");
        let audio = tmp.file("song.mp3", b"audio");
        let lrc = tmp.file("song.lrc", "[00:00.00]词".as_bytes());
        let sub = tmp.dir("sub");
        // `sub/../song.lrc` 的 canonical parent 仍是音频目录：放行。
        assert!(authorized_sidecar(&audio, &sub.join("..").join("song.lrc")).is_ok());
        // 可信音频自身带 `..` 时，按它的词法 parent canonical 化后比较。
        let audio_alias = sub.join("..").join("song.mp3");
        assert!(authorized_sidecar(&audio_alias, &lrc).is_ok());
    }

    #[test]
    fn sidecar_rejects_subdirectory_and_unrelated_dir() {
        let tmp = TempDir::new("sidecar-outside");
        let audio = tmp.file("song.mp3", b"audio");
        let lyrics_dir = tmp.dir("lyrics");
        write_owned(lyrics_dir.join("song.lrc"), "[00:00.00]词").expect("写子目录歌词");
        assert_eq!(
            authorized_sidecar(&audio, &lyrics_dir.join("song.lrc")),
            Err(LyricAccessError::SidecarOutsideAudioDir),
            "子目录不是音频同级目录"
        );

        let outside = TempDir::new("sidecar-fully-outside");
        let outside_lrc = outside.file("song.lrc", "[00:00.00]别处的词".as_bytes());
        assert_eq!(
            authorized_sidecar(&audio, &outside_lrc),
            Err(LyricAccessError::SidecarOutsideAudioDir)
        );
    }

    #[test]
    fn sidecar_rejects_missing_or_directory_path() {
        let tmp = TempDir::new("sidecar-missing");
        let audio = tmp.file("song.mp3", b"audio");
        assert_eq!(
            authorized_sidecar(&audio, &tmp.path.join("nope.lrc")),
            Err(LyricAccessError::SidecarUnavailable)
        );
        // 目录的 canonical parent 恰好也等于音频目录，必须按「文件」拒绝。
        let sub = tmp.dir("sub");
        assert_eq!(
            authorized_sidecar(&audio, &sub),
            Err(LyricAccessError::SidecarUnavailable)
        );
    }

    /// Synthetic junction resolution uses the actual trusted-sidecar guard.
    /// This proves the policy for reparse metadata, not a Windows OS junction.
    #[cfg(windows)]
    #[test]
    fn sidecar_rejects_junction_escaping_audio_dir() {
        struct ReparseProbe {
            alias: PathBuf,
            target: PathBuf,
        }
        impl LyricPathProbe for ReparseProbe {
            fn canonicalize(&self, path: &Path) -> std::io::Result<PathBuf> {
                if path == self.alias {
                    std::fs::canonicalize(&self.target)
                } else {
                    std::fs::canonicalize(path)
                }
            }
            fn is_file(&self, path: &Path) -> bool {
                path.is_file()
            }
        }

        let tmp = TempDir::new("sidecar-junction");
        let audio = tmp.file("song.mp3", b"audio");
        let outside = TempDir::new("sidecar-junction-target");
        let target = outside.file("evil.lrc", "[00:00.00]外部歌词".as_bytes());
        let link = tmp.dir("linked");
        let escaped = link.join("evil.lrc");
        let probe = ReparseProbe {
            alias: escaped.clone(),
            target,
        };
        assert_eq!(
            probe.canonicalize(&escaped).unwrap(),
            std::fs::canonicalize(&probe.target).unwrap(),
            "合成 junction 输入必须解析到目标"
        );
        let result = authorized_sidecar_with_probe(&audio, &escaped, &probe);
        assert_eq!(result, Err(LyricAccessError::SidecarOutsideAudioDir));

        // Positive and fail-closed contrasts exercise the very same injected guard.
        let same_dir = tmp.file("safe.lrc", b"[00:00.00]safe");
        let safe_probe = ReparseProbe {
            alias: escaped.clone(),
            target: same_dir.clone(),
        };
        assert_eq!(
            authorized_sidecar_with_probe(&audio, &escaped, &safe_probe),
            Ok(std::fs::canonicalize(&same_dir).unwrap())
        );
        let missing_probe = ReparseProbe {
            alias: escaped.clone(),
            target: outside.path.join("missing.lrc"),
        };
        assert_eq!(
            authorized_sidecar_with_probe(&audio, &escaped, &missing_probe),
            Err(LyricAccessError::SidecarUnavailable)
        );
    }
}
