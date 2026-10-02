fn main() {
    // manifest 不走 tauri-build 的资源嵌入（那只对 bin 生效，测试 exe 会因缺
    // comctl32 v6 依赖在加载期 STATUS_ENTRYPOINT_NOT_FOUND —— rfd / muda /
    // tauri-runtime-wry 引用的 TaskDialogIndirect 只存在于 v6）：
    // 对本 crate 的所有链接产物（bin / test / cdylib）统一嵌入
    // windows-app-manifest.xml，链接器会把它与 rustc 默认 manifest 合并。
    // rustc-link-arg 天然不作用于 build script 自身，且必须用绝对路径
    // （链接时 mt.exe 的工作目录不保证是包根目录）。
    if std::env::var("CARGO_CFG_TARGET_OS")
        .map(|v| v == "windows")
        .unwrap_or(false)
    {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-app-manifest.xml");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
    )
    .expect("tauri build failed");
}
