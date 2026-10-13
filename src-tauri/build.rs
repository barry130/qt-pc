fn main() {
    // 私有值（自有域名 / 生产后端地址 / 官网地址）**不在仓库里**：
    // `src/private_config.rs` 由 `scripts/sync-config.mjs` 从 `app.config.local.json`
    // （被 .gitignore 忽略）生成，而 `cargo test` / `cargo check` 不经过前端脚本，
    // 没有它就编不过。这里补一个空壳兜底。
    //
    // **只在文件不存在时创建**，绝不覆盖生成器的产物 —— 否则每次重建都会把真实值
    // 清掉，打出来的包会静默退化成"连不上后端"。空壳的语义就是"没有私有配置"：
    // 编译期默认为空，运行期 `runtime_config` 仍会去读 app.config.local.json 覆盖，
    // 所以只影响编译期默认值，不影响本地运行。
    let private_config = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("src")
        .join("private_config.rs");
    if !private_config.exists() {
        // 与 `scripts/sync-config.mjs` 在"没有 app.config.local.json"时生成的常量
        // 语义一致（值全空），但正文不同：这份是 build.rs 的兜底，别把两处正文
        // 当同一份东西去比对。同步器一旦跑过就会用它的版本覆盖这里。
        let stub = "//! 兜底空壳：`scripts/sync-config.mjs` 没有跑过（例如裸 `cargo test` /\n\
                    //! `cargo check`）时由 `src-tauri/build.rs` 补上，语义 = 没有私有配置。\n\
                    //! 跑一次 `pnpm config:sync` 就会变成同步器生成的版本。**不提交。**\n\
                    \n\
                    /// 生产后端地址（形如 `https://<自有域名>/api/v1/`；空 = 未配置）\n\
                    pub const BACKEND_BASE_URL: &str = \"\";\n\
                    \n\
                    /// 官网地址（关于页的教程 / 协议 / 隐私 / 反馈入口；空 = 设置页不显示这几项）\n\
                    pub const OFFICIAL_SITE_URL: &str = \"\";\n\
                    \n\
                    /// 自有域名后缀（明文 http 放行的唯一依据；空数组 = 没有任何自有域名，\n\
                    /// 于是所有明文下载都会被拒 —— 收紧而非放松，正是缺配置时想要的行为）\n\
                    pub const OWN_DOMAINS: &[&str] = &[];\n\
                    \n\
                    /// 内存中直接覆盖自有域名后缀（调试 / 测试用，逗号分隔；留空则用 OWN_DOMAINS）\n\
                    pub const OWN_DOMAINS_ENV: &str = \"QT_OWN_DOMAINS\";\n";
        if let Err(e) = std::fs::write(&private_config, stub) {
            panic!("无法生成 {}: {e}", private_config.display());
        }
    }
    // 本脚本会**写出** src/private_config.rs，所以必须显式声明重编条件：
    // 否则 cargo 默认的"包内任何文件变化就重跑"会把这次写入当成新变更，白跑一轮。
    println!("cargo:rerun-if-changed=src/private_config.rs");

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
