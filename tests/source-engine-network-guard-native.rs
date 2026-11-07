//! Standalone public-module regression harness; the production module is never copied.
//! Only Tauri's Invoke/Runtime boundary is fake. Window labels are sourced from the
//! production public contracts by the runner; logging uses the real cached log crate.
//! Final real-Tauri type checking remains the full native crate's responsibility.

extern crate self as tauri;

use std::marker::PhantomData;
use std::sync::{Arc, Mutex};

pub trait Runtime: Send + Sync + 'static {}
pub struct FakeRuntime;
impl Runtime for FakeRuntime {}

pub mod ipc {
    use super::*;

    pub struct Webview<R: Runtime> {
        label: String,
        runtime: PhantomData<R>,
    }
    impl<R: Runtime> Webview<R> {
        pub fn label(&self) -> &str { &self.label }
    }
    pub struct Message<R: Runtime> {
        command: String,
        webview: Webview<R>,
    }
    impl<R: Runtime> Message<R> {
        pub fn command(&self) -> &str { &self.command }
        pub fn webview_ref(&self) -> &Webview<R> { &self.webview }
    }
    pub struct Resolver {
        rejected: Arc<Mutex<Vec<String>>>,
    }
    impl Resolver {
        pub fn reject(self, message: String) { self.rejected.lock().unwrap().push(message); }
    }
    pub struct Invoke<R: Runtime> {
        pub message: Message<R>,
        pub resolver: Resolver,
    }
    impl<R: Runtime> Invoke<R> {
        pub fn new(label: &str, command: &str, rejected: Arc<Mutex<Vec<String>>>) -> Self {
            Self {
                message: Message {
                    command: command.into(),
                    webview: Webview { label: label.into(), runtime: PhantomData },
                },
                resolver: Resolver { rejected },
            }
        }
    }
}

pub mod source_window {
    include!(env!("SOURCE_WINDOW_LABEL_FILE"));
}
pub mod lyric_window {
    include!(env!("LYRIC_WINDOW_LABEL_FILE"));
}

#[path = "../src-tauri/src/ipc_guard.rs"]
mod ipc_guard;

fn dispatch(label: &str, command: &str) -> (Vec<String>, Vec<String>) {
    let called = Arc::new(Mutex::new(Vec::new()));
    let rejected = Arc::new(Mutex::new(Vec::new()));
    let recorded = called.clone();
    let guarded = ipc_guard::guarded::<FakeRuntime, _>(move |invoke| {
        recorded.lock().unwrap().push(invoke.message.command().to_owned());
        true
    });
    assert!(guarded(ipc::Invoke::new(label, command, rejected.clone())));
    let calls = called.lock().unwrap().clone();
    let errors = rejected.lock().unwrap().clone();
    (calls, errors)
}

#[test]
fn production_lyrics_dispatch_rejects_unrelated_native_commands() {
    for command in [
        "run_update_installer", "download_update_file", "delete_local_tracks",
        "delete_downloads", "source_install", "source_uninstall_pack",
        "builtin_request", "astral_login", "astral_upload_avatar", "ai_chat",
        "diagnostics_export", "future_native_command", "source_pack_load_failed",
    ] {
        let (called, rejected) = dispatch(lyric_window::LYRIC_WINDOW_LABEL, command);
        assert!(called.is_empty(), "lyrics dispatched unauthorized command {command}");
        assert_eq!(rejected.len(), 1, "unauthorized command must reject its resolver");
        assert!(rejected[0].contains(command));
    }
}

#[test]
fn production_lyrics_dispatch_keeps_real_entry_and_hook_command_paths() {
    // Explicit matrix from entries/lyric.tsx, entries/boot.ts, LyricWindow,
    // useLyricOffset, localOnline and sourceRegistry; not the implementation's list.
    for command in [
        "write_log", "set_webview_memory_low", "get_playback_state", "get_queue",
        "next", "previous", "pause", "resume", "get_desktop_lyric_state",
        "hide_desktop_lyric", "set_desktop_lyric_locked", "set_desktop_lyric_style",
        "set_desktop_lyric_bounds", "open_lyric_settings", "get_lyric_offset",
        "set_lyric_offset", "get_lyric", "read_local_lyric", "save_lyric",
        "resolve_local_file", "get_setting", "set_setting", "set_source_qualities",
        "plugin:event|listen", "plugin:event|emit_to", "core:window|start_dragging",
        "core:window|set_size", "core:window|outer_position",
    ] {
        let (called, rejected) = dispatch(lyric_window::LYRIC_WINDOW_LABEL, command);
        assert_eq!(called, [command], "lyrics lost entry/hook command {command}");
        assert!(rejected.is_empty());
    }
}

#[test]
fn production_dispatch_keeps_main_and_engine_boundaries_distinct() {
    assert_eq!(dispatch("main", "run_update_installer").0, ["run_update_installer"]);
    assert!(dispatch(source_window::SOURCE_ENGINE_LABEL, "run_update_installer").0.is_empty());
    assert_eq!(dispatch(source_window::SOURCE_ENGINE_LABEL, "builtin_request").0, ["builtin_request"]);
    assert!(dispatch(lyric_window::LYRIC_WINDOW_LABEL, "builtin_request").0.is_empty());
}
