/**
 * 窗口 label 常量 —— Tauri 前后端跨窗口通信的隐式契约，调用点不要散写字面量。
 * 与 Rust 侧对齐：lib.rs `MAIN_WINDOW_LABEL`、lyric_window.rs `LYRIC_WINDOW_LABEL`、
 * source_window.rs `SOURCE_ENGINE_LABEL`；主窗口 label 同时等于 tauri.conf.json
 * `app.windows[0].label`。契约由 tests/window-labels-contract.test.ts 守护。
 */
export const MAIN_WINDOW_LABEL = "main";
export const LYRICS_WINDOW_LABEL = "lyrics";
export const SOURCE_ENGINE_WINDOW_LABEL = "source-engine";
