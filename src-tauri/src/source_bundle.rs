//! 音源包本地目录（source-bundle）。
//!
//! P0：chain.json 本地 overlay 读取（前端 chain-store.ts 经 source_chain_overlay
//! 命令取原文；读取失败/文件不存在返回 null，由前端回退内置默认配置）。
//! P2 起该目录扩展为安装根（state.json、source/<code>/* 下载落盘）。
//!
//! 目录口径与 lib.rs 的 db_root 一致：`app_paths::data_root`
//! （Windows = %APPDATA%/QuietMusic，其他平台跟随 app_cache_dir）。

use std::path::{Path, PathBuf};

/// 音源包本地根目录（<数据根>/source-bundle）
pub(crate) fn bundle_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    crate::app_paths::data_root(app).join("source-bundle")
}

/// 读 chain.json overlay 原文；文件不存在/不可读/超 1 MiB（防呆）返回 None
pub(crate) fn read_chain_overlay(dir: &Path) -> Option<String> {
    let path = dir.join("chain.json");
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > 1024 * 1024 {
        return None;
    }
    std::fs::read_to_string(&path).ok()
}

/// chain.json 本地覆盖层原文（无 overlay = null；内容由前端 parseChainConfig 校验）
#[tauri::command]
pub async fn cmd_source_chain_overlay(app: tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(read_chain_overlay(&bundle_dir(&app)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_chain_overlay_missing_or_oversized_returns_none() {
        let tmp = std::env::temp_dir().join(format!("ll-chain-{}", std::process::id()));
        let dir = tmp.join("source-bundle");
        let _ = std::fs::remove_dir_all(&tmp);
        // 文件不存在
        assert!(read_chain_overlay(&dir).is_none());
        // 正常读取
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("chain.json"), r#"{"chainRevision":2}"#).unwrap();
        assert_eq!(
            read_chain_overlay(&dir).as_deref(),
            Some(r#"{"chainRevision":2}"#)
        );
        // 超限防呆
        let big = "x".repeat(1024 * 1024 + 1);
        std::fs::write(dir.join("chain.json"), big).unwrap();
        assert!(read_chain_overlay(&dir).is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
