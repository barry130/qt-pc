# 打包文档（Windows / Linux / macOS）

> 本项目的 `pnpm tauri build` 在**本机 Windows 上**不可用（CLI 会把 `process.argv[0]` 解析成
> `DSH Desktop.exe`，报 `unrecognized subcommand`），所以本地打包按下面的
> **手动分步**流程执行，效果与 `tauri build` 完全一致。Linux / macOS 与 CI 里
> `pnpm exec tauri build --runner cargo` 正常可用（发版流水线就是这么调的）。
>
> 三平台共用同一份代码：平台差异集中在 `src-tauri/src` 的 `cfg(target_os)` 门控
> 与 `app.config.json` 的 platform 字典，打包只需换 `--bundles`。

## 平台与产物一览

| 平台 | 打包命令（`--bundles`） | 产物 | 应用内自装 |
|---|---|---|---|
| Windows | `nsis`（`tauri.conf.json` 默认值） | `QuietMusic_<版本>_x64-setup.exe` + `.sig` | ✅ ed25519 签名后应用内更新可自装 |
| Linux | `deb,appimage` | `QuietMusic_<版本>_amd64.deb`、`QuietMusic_<版本>_amd64.AppImage` | ❌ 浏览器下载手动安装 |
| macOS | `app,dmg` | `QuietMusic.app`、`QuietMusic_<版本>_aarch64.dmg`（Intel 跑则是 `_x64`） | ❌ 浏览器下载手动安装 |

> `--bundles` 覆盖是刻意的：`tauri.conf.json` 里 `bundle.targets` 固定为 `["nsis"]`，
> 避免本地/CI 在不同平台上依赖 Tauri 的平台 conf 合并行为。

## 产物（Windows）

| 文件 | 路径 |
|---|---|
| NSIS 安装包 | `src-tauri/target/release/bundle/nsis/QuietMusic_<版本>_x64-setup.exe` |
| 主程序 | `src-tauri/target/release/quietmusic.exe` |
| 前端产物 | `dist/`（打进二进制，无需分发） |

## 前置检查

1. **关掉正在运行的 QuietMusic**（含托盘），否则链接报 `os error 5 拒绝访问`：
   ```powershell
   Get-Process quietmusic -ErrorAction SilentlyContinue | Stop-Process -Force
   ```
2. **配置已同步**：`pnpm config:check`（版本号等只在仓库根 `app.config.json` 改一处，
   见《配置文档》）。发版前确认 `version.name` 与 `version.code` 已一起改。
3. **启动 crates 镜像代理**（仅当 cargo 需要联网拉索引/tarball 时必需）：
   ```powershell
   node tools/registry-proxy.mjs   # 保持运行；构建完成可停
   ```
   `src-tauri/.cargo/config.toml` 把 crates.io 替换为 `127.0.0.1:8650` 的本地 HTTP
   镜像（本机 schannel TLS 损坏，cargo 的 HTTPS 下载栈不可用）。代理没起时
   构建报 `local-mirror … 连接失败 (os error 10061)`。依赖已全部缓存时
   `cargo check` 可离线通过，但 release 构建通常触发索引更新，务必先起代理。
4. 验证基线全绿（可选但建议；本机 `pnpm <script>` 可能被 pnpm 拦，直接调 node 入口，见《配置文档》§7.2）：
   ```powershell
   node node_modules/typescript/bin/tsc --noEmit
   node node_modules/vitest/vitest.mjs run
   # cargo 侧：
   $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
   cargo clippy --all-targets -- -D warnings; cargo test
   ```

## 自动发版（打 tag 即发布，推荐）

`.github/workflows/release.yml` 已配置：**只有 push 了 `v*` 形态的 tag 才触发**，
普通 push 只跑 ci.yml 的测试门，不出包。流水线分三个 job：

| job | runner | 动作 |
|---|---|---|
| `windows` | `windows-latest` | 构建 NSIS → ed25519 签名并自验 → **创建** GitHub Release（exe + `.sig` + 安装包 MD5/大小信息） |
| `linux` | `ubuntu-22.04` | 装系统依赖 → `--bundles deb,appimage` → 上传 `.deb` / `.AppImage` 到同一个 Release（`needs: windows`，只上传不建 Release） |
| `macos` | `macos-14` | `--bundles app,dmg`（不签名不公证）→ 上传 `.dmg` |

Release 说明会自动生成，并带一段「Linux/macOS 产物无应用内自装，浏览器下载手动安装」
与「macOS 未公证首次打开方式」的说明。

CNB 侧 `.cnb.yml` 的 `v*` 流水线另有「构建 Linux deb + AppImage」stage（原生
`.cnb/windows-build.Dockerfile` 已补 Linux 构建依赖层），产物走 attachments 上传。

```powershell
# 发版动作（版本号已在 app.config.json 改好并与 tag 一致，工作流会校验）
git tag v1.1.1
git push origin v1.1.1
```

**一次性前置**（做一次就够）：把签名私钥的 base64 配进仓库 secret：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("F:\qtMusic\qt-pc\.signing\ed25519.key")) | Set-Clipboard
# 粘贴到 GitHub 仓库 → Settings → Secrets and variables → Actions →
# New repository secret，名字填 QT_UPDATE_SIGNING_KEY
```

发完 Release 后，把说明页里的「下载地址 / MD5 / fileSize」填进后端管理后台的
更新记录（应用内更新检查走的是后端 `app_update`，GitHub Release 只是托管安装包）。

## 步骤 1：构建前端

```powershell
Set-Location F:\qtMusic\qt-pc
node scripts/sync-config.mjs    # 配置同步（pnpm build 也会先跑；本机 pnpm 可能被拦，直接调 node）
node node_modules/typescript/bin/tsc --noEmit          # 类型检查
node node_modules/vite/bin/vite.js build               # 产出 dist/
```

> 若 `pnpm build` 出现 `Terminate batch job (Y/N)?` 挂起，就是组合命令的
> 交互问题；分两条命令执行即可。

## 步骤 2：用 Tauri CLI 构建（绕过 argv[0] 的两种方式）

**方式 A（推荐）**：直接调 CLI 的 node 入口，显式传 cargo 路径：

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
Set-Location F:\qtMusic\qt-pc
pnpm exec tauri build --runner cargo
```

> 镜像配置在 `src-tauri/.cargo/config.toml`，`CARGO_HOME` 用默认 `~/.cargo` 即可
> （仓库根的 `.cargo-home` 已废弃不用）。

**方式 B**：完全手动（等价于 tauri build 的核心动作）：

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
Set-Location F:\qtMusic\qt-pc\src-tauri
cargo build --release --features tauri/custom-protocol
```

> `custom-protocol` 特性是 Tauri 生产模式的关键（内嵌 dist 资源）。
> **注意必须写成 `tauri/custom-protocol`**：Tauri 2 里该特性挂在 `tauri` crate 上
> （`tauri = { features = ["custom-protocol"] }` → `tauri-macros/custom-protocol`），
> 本项目 `Cargo.toml` 并没有自己声明 `custom-protocol` 特性，
> 所以写裸名 `--features custom-protocol` 会直接报
> `the package 'quietmusic' does not contain this feature: custom-protocol`。
> 方式 B 只出主程序，不出 NSIS 安装包；需要安装包时用方式 A
> （NSIS 由 tauri-build 驱动 makensis 完成）。

## 步骤 3：验证

```powershell
# 产物存在
Get-ChildItem "F:\qtMusic\qt-pc\src-tauri\target\release\bundle\nsis"

# 启动冒烟：release 版直接跑起来、能播一首歌、收藏同步正常
Start-Process "F:\qtMusic\qt-pc\src-tauri\target\release\quietmusic.exe"
```

冒烟清单：
- [ ] 主窗口标题「轻听」正常显示（无乱码）
- [ ] 播放一首歌，播放条显示曲名/进度
- [ ] 收藏按钮弹出本地歌单，勾选生效
- [ ] 收藏页「同步云端收藏」成功（连后端时）
- [ ] 数据目录沿用 `%APPDATA%\QuietMusic`（升级覆盖后数据还在）

## 步骤 4：给安装包签名（ed25519，必做）

应用内更新在安装前会强制验签（`astral.rs::UPDATE_SIGN_PUBKEY_B64` 内嵌公钥）：
**没有 `.sig` 或验签失败的包一律拒绝安装**。所以发版必须签：

```powershell
# 一次性：生成密钥对（私钥 .signing/ed25519.key 已 gitignore，务必备份；丢了只能换钥重发版）
node scripts/update-sign.mjs keygen

# 每次发版：签出 .sig（与安装包同名 + .sig）
node scripts/update-sign.mjs sign "src-tauri\target\release\bundle\nsis\QuietMusic_<版本>_x64-setup.exe"

# 本地自验（用私钥复核，可选）
node scripts/update-sign.mjs verify "src-tauri\target\release\bundle\nsis\QuietMusic_<版本>_x64-setup.exe"
```

发布时把 `.exe` 与 `.exe.sig` **放在同一目录一起上传**（GitHub Release 加
`.sig` 资产 / 对象存储同名键）：应用按「下载 URL + `.sig`」取签名，加速节点
对 `.sig` 不可达时会自动降级原始直链取一次。签名不匹配时安装被拒绝并提示。

## Linux 打包（deb + AppImage）

**系统依赖**（Ubuntu 22.04+；`webkit2gtk-4.1` 自 22.04 才有，20.04 只有 4.0，不支持）：

```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev libasound2-dev
```

**构建**：

```bash
node scripts/sync-config.mjs
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build
pnpm exec tauri build --runner cargo --bundles deb,appimage
```

**产物**：

| 文件 | 路径 |
|---|---|
| deb | `src-tauri/target/release/bundle/deb/QuietMusic_<版本>_amd64.deb` |
| AppImage | `src-tauri/target/release/bundle/appimage/QuietMusic_<版本>_amd64.AppImage` |
| 主程序 | `src-tauri/target/release/quietmusic` |

运行期依赖：deb 走系统 `webkit2gtk-4.1` / GTK3 / ALSA；AppImage 自带运行时但需要 FUSE
（无 FUSE 时用 `./QuietMusic_*.AppImage --appimage-extract-and-run`）。

数据与日志：数据 `$XDG_DATA_HOME/QuietMusic`（缺省 `~/.local/share/QuietMusic`），
日志 `$XDG_STATE_HOME/QuietMusic/logs`（缺省 `~/.local/state/QuietMusic/logs`）。

已知限制（代码侧已按此降级，非缺陷）：

- **托盘**依赖 StatusNotifier/AppIndicator 宿主，GNOME 未装扩展时不显示。托盘原本是唯一
  退出入口，因此 `tray.rs::create_tray()` 改为返回是否成功、`lib.rs` 用 `TRAY_READY` 记录：
  托盘不可用时「关闭窗口」就是真退出（不再隐藏到托盘）。
- **桌面歌词**窗口依赖合成器透明与置顶：X11 下基本可用；Wayland 下 tao 不支持 layer-shell，
  置顶/穿透能力受限。
- **全局快捷键**在 Wayland 会话下不可用（X11 正常）。
- **系统媒体控制**走 MPRIS（souvlaki + `use_zbus`，纯 Rust，不需要 `libdbus-1`），
  需要桌面环境提供 D-Bus。
- **无应用内自装**：`supportsInAppUpdate()` 在非 Windows 返回 false，新版本走浏览器下载安装。

## macOS 打包（app + dmg，不签名不公证）

前置：Xcode Command Line Tools（`xcode-select --install`）、Rust 工具链、pnpm。

```bash
node scripts/sync-config.mjs
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build
pnpm exec tauri build --runner cargo --bundles app,dmg
```

**产物**：`src-tauri/target/release/bundle/macos/QuietMusic.app` 与
`src-tauri/target/release/bundle/dmg/QuietMusic_<版本>_aarch64.dmg`
（Intel 机器上是 `_x64`）。

**必须保留的两处配置**：`tauri.conf.json` 的 `app.macOSPrivateApi: true` 与
`Cargo.toml` 里 `tauri` 的 `macos-private-api` feature —— 桌面歌词是无边框透明窗口，
macOS 需要 NSWindowPrivateApi，缺了直接起不来（Windows/Linux 忽略该特性）。

**不公签（决策）**：不做 Developer ID 签名与 Apple 公证；tauri 对 macOSPrivateApi 构建
会自动做 ad-hoc 签名（`codesign -`）。

- 首次打开：右键 App →「打开」→ 再点「打开」；或
  `xattr -dr com.apple.quarantine /Applications/QuietMusic.app`。
- 手动替换或重新编译二进制会让 ad-hoc 签名失效，需重签：
  `codesign --force --deep --sign - /Applications/QuietMusic.app`。

数据与日志：数据 `~/Library/Application Support/QuietMusic`，日志 `~/Library/Logs/QuietMusic`。

其余能力与 Windows 对齐：系统媒体控制走 macOS 的「正在播放」（souvlaki 原生后端，无需额外
feature）、托盘、开机自启（LaunchAgent）、全局快捷键均可用；同样**没有应用内自装**。

## 常见失败

| 现象 | 处理 |
|---|---|
| `unrecognized subcommand 'DSH Desktop.exe'` | 用了 `pnpm tauri build`；改方式 A/B（仅本机 Windows 的 argv[0] 问题） |
| `failed to remove file ... os error 5` | 应用还在运行，见前置检查 1 |
| NSIS 下载 makensis 卡住 | Tauri CLI 首次会拉 NSIS 工具链，保持网络通畅或设 `TAURI_NSIS_PATH` 指向已有安装 |
| 前端构建后窗口空白 | 确认走的是 `vite build` 且 `dist/` 已生成（生产模式吃 dist，不吃 1420 端口） |
| 图标/中文乱码 | `tauri.conf.json` / `app.config.json` 保存编码必须 UTF-8 无 BOM |
| 安装时弹「系统中已存在…是否卸载」 | 说明用的不是仓库里的自定义模板。确认 `tauri.conf.json` 的 `bundle.windows.nsis.template` 指向 `nsis/installer.nsi`；升级 Tauri CLI 后需重新提取官方模板并重打补丁（见《配置文档》§6） |
| 启动后挂着一个终端/控制台窗口 | `main.rs` 顶部必须有 `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`（release 不分配控制台，dev 保留看日志）；已修，勿删 |
| NSIS 下载失败（timeout / os error 10054） | Tauri 从 GitHub 拉 NSIS 工具链；网络不通时设代理环境变量再重试，例如 `$env:HTTPS_PROXY = "socks5://127.0.0.1:<socks端口>"`（本机实测 10808 端口可用，HTTP 代理端口不行） |
| Linux：`error: failed to run custom build command for 'webkit2gtk-sys'` / `Package webkit2gtk-4.1 was not found` | 缺系统依赖或系统过旧；按「Linux 打包」装 `libwebkit2gtk-4.1-dev`（Ubuntu 20.04 无 4.1，需升到 22.04+） |
| Linux：托盘图标不显示 | GNOME 未启用 AppIndicator 扩展；应用此时按「关窗即退出」运行，装扩展或换桌面环境即可恢复托盘 |
| Linux：Wayland 下置顶/快捷键失效 | 已知限制（tao 无 layer-shell、Wayland 不提供全局快捷键），切 X11 会话可用 |
| Linux：AppImage 报 `dlopen(): error loading libfuse.so.2` | 未装 FUSE；`sudo apt install libfuse2` 或改用 `--appimage-extract-and-run` |
| macOS：提示「已损坏，无法打开」/「无法验证开发者」 | 未公证导致的 Gatekeeper 拦截（预期）：右键 →「打开」，或 `xattr -dr com.apple.quarantine /Applications/QuietMusic.app` |
| macOS：替换二进制后「应用已损坏」 | ad-hoc 签名失效，重签：`codesign --force --deep --sign - /Applications/QuietMusic.app` |
| macOS：`pnpm install` 报 `Unsupported Platform: @esbuild/win32-x64` | `package.json` 里 esbuild 平台包被硬钉成 win32 了（历史坑，已移除硬钉），确认没有重新加回 |
