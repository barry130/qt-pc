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

**打包全部在 GitHub Actions 完成，CNB 只做镜像。** 只有 push 了 `v*` 形态的 tag
才触发，普通 push 只跑 ci.yml 的测试门，不出包。

`.github/workflows/release.yml` 分四个 job：

| job | runner | 动作 |
|---|---|---|
| `gate` | `ubuntu-latest` | 校验 tag 与 `app.config.json` 版本一致 → `pnpm install` → `pnpm test`。不过门不构建 |
| `windows` | `windows-latest` **矩阵 x64/x86/arm64** | 原生 MSVC `--target <triple>` 构建 NSIS → ed25519 签名并自验 → 各自上传产物 |
| `linux` | `ubuntu-22.04` | 装系统依赖 → `--bundles deb,appimage` → 上传 `.deb` / `.AppImage` |
| `macos` | `macos-14` | `--bundles app,dmg`（不签名不公证）→ 上传 `.dmg` |
| `publish` | `ubuntu-latest` | **唯一发布点**：汇总三个 job 的产物 → 校验齐全（3 exe / 3 sig / deb / AppImage / dmg）→ 生成说明 → 建 GitHub Release |

三个 Windows 架构用**原生 MSVC 目标**并行构建（`x86_64-pc-windows-msvc` /
`i686-pc-windows-msvc` / `aarch64-pc-windows-msvc`），不是交叉编译，因此不再需要
cargo-xwin、`mt.exe` 垫片和自定义构建镜像。

**单一发布点**：只有 `publish` job 会创建 Release，三个构建 job 只上传中间产物。
任何一个平台构建失败都不会留下「半个 Release」，`.sig` 缺一个也会在发版前被拦下。

CNB 侧 `.cnb.yml` 的 `v*` 流水线**不再构建任何东西**，退化成镜像发布：
查 GitHub Release 的资产清单 → 齐了下载产物（`.cnb/fetch-github-release.mjs`）→
逐个校验 sha256 与结构校验签名 → `make-release-notes.mjs` 生成说明 →
`git:release` 建 CNB Release → `cnbcool/attachments` 上传与 GitHub **完全一致**的
附件（含 `.dmg`）。

资产清单抓的是 `https://github.com/<repo>/releases/expanded_assets/<tag>` —— github.com
网页端的一段 HTML，**不占** `api.github.com` 那个 60 次/小时/IP 的匿名配额（CNB 托管
节点是共享出口 IP，REST 配额很容易被别人的构建耗光，撞上就白等）。REST API 留作兜底。
这段 HTML 里带每个资产的 sha256，下载时边写边算，对不上就重下；拿不到 sha256 时才
退回比对字节数。

> CNB 侧拿不到签名私钥（私钥只存在于 GitHub 的 `QT_UPDATE_SIGNING_KEY`），
> 因此 CNB 只做**结构校验**（ed25519 签名恒为 64 字节 → base64 单行恒 88 字符），
> 密码学验签在 GitHub 构建阶段就已由 `update-sign.mjs sign` + `verify` 完成。

```powershell
# 发版动作（版本号已在 app.config.json 改好并与 tag 一致，两侧工作流都会校验）
git tag v1.1.3
git push origin v1.1.3      # origin 配了 GitHub + CNB 两个 pushurl，一条命令推两边
```

两侧流水线是独立触发的：GitHub 负责出包并发 Release，CNB 轮询到产物齐了才建
CNB Release。CNB 侧的等待窗口默认 45 分钟（`.cnb.yml` 里 `WAIT_SECONDS`），
GitHub 构建超时的话把它调大。

> `git remote -v` 里只有一个 `origin`，但它有两个 pushurl：
> `https://github.com/barry130/qt-pc.git` 和 `https://cnb.cool/canace/qt-pc.git`，
> 所以 `git push origin <tag>` 会同时推两个远端；没有名为 `cnb` 的 remote。
> 推不动的时候先确认 `git config --get-all remote.origin.pushurl`。
> 只想重跑某一侧（比如只想让 CNB 镜像重试、又不想让 GitHub 重构建一遍）时：
> `git push https://cnb.cool/canace/qt-pc.git refs/tags/v1.1.3`。

### CNB 镜像流水线失败时怎么看日志

CNB **没有可读的阶段日志接口**：`build/logs` 系列匿名 401，带 token 也只回
`{"code":204,"message":"We couldn't find information on that stage."}`，日志网页
是前端 SPA，`cnb build get-build-logs` 需要 `repo-cnb-history:r` 权限（本地
拿到的 git 凭据没有这个 scope）。所以公开能看到的只有 commit-status 里的
`cnb/tag_push/pipeline-1(镜像 GitHub Release 产物) | error | error [27.5s]`，
连卡在哪一步都看不出来。

为此镜像流水线把下载、校验、生成说明这几个阶段改成**只记录退出码、不直接失败**
（日志 `tee` 到 `.cnb-debug.log`），排在最后的「失败诊断快照」阶段会在失败时把
日志包成 `.cnb-debug.md` 推到一条只用于排查的 `ci-debug` 分支，然后才由
「按前面的结果判定成败」把流水线判红：

```powershell
# 拿到 CNB 镜像流水线的完整日志
git fetch https://cnb.cool/canace/qt-pc.git ci-debug
git show FETCH_HEAD:.cnb-debug.md > cnbfail.md
```

> 只读 commit-status（不登录网页）也可以确认跑到哪了：
> `GET https://api.cnb.cool/canace/qt-pc/-/git/commit-statuses/<完整 sha>`（需带
> `Authorization: Bearer <CNB token>`，匿名 401），返回里的 `description` 形如
> `error [10m 39s]`，时长能大致倒推卡在哪一步。

阶段顺序是：`校验 tag → 下载 → 校验产物 → 生成说明 → git:release → 上传附件
→ 核对 CNB Release → 失败诊断快照 → 按结果判定成败`。最后那个「核对」是唯一
能自证镜像真的成功的手段 —— `git:release` 和 `cnbcool/attachments` 既不给日志
也接不到退出码，所以 `.cnb/verify-cnb-release.mjs` 拿着 `$CNB_TOKEN` 回查
`GET /canace/qt-pc/-/releases/tags/<tag>`，要求附件和 `artifacts/` 一一对应。

> **CNB 的 stage 脚本是用 `sh`（Debian 上是 dash）跑的，不是 bash。**
> dash 不认识 `set -o pipefail`（直接 "set: Illegal option -o pipefail" 并终止
> 脚本）和 `${PIPESTATUS[0]}`（Bad substitution）。症状是容器刚起来就
> `error [4~5 秒]`，一个 stage 都跑不完，看着像 runner/镜像问题其实是自己写的
> shell 干掉了自己。要拿管道左边命令的退出码，用 POSIX 写法
> `{ cmd; echo $? > .cnb-rc; } | tee log` 再读文件；需要子作用域（里面的 `exit`
> 只结束子作用域）用 `( ... )` 而不是 `{ ... }`。改动 `.cnb.yml` 的 stage 脚本
> 前先看一眼这段。

> 还有一个副作用：`overlying: false` 的 `git:release` 是「先删再建」，所以一旦
> 这一步之后失败，CNB 上会留下一个没有附件的 Release。下一次重推同一个 tag 会
> 重新建一遍。

**一次性前置**（做一次就够）：把签名私钥的 base64 配进 **GitHub 仓库** secret：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("F:\qtMusic\qt-pc\.signing\ed25519.key")) | Set-Clipboard
# 粘贴到 GitHub 仓库 → Settings → Secrets and variables → Actions →
# New repository secret，名字填 QT_UPDATE_SIGNING_KEY
```

> CNB 侧**不再需要**任何签名密钥配置：私钥只在 GitHub 的构建阶段使用，
> CNB 拿到的已经是签好名的 `.exe` + `.sig`。

发完 Release 后，把说明页里的「下载地址 / MD5 / fileSize」填进后端管理后台的
更新记录（应用内更新检查走的是后端 `app_update`，Release 只是托管安装包）。
面向国内用户时下载地址建议填 **CNB** 的
`https://cnb.cool/canace/qt-pc/-/releases/download/<tag>/<文件名>`，
GitHub 的地址在 Release 说明里同时给出。

> macOS 说明：CI 只出 **arm64** 的 dmg（`macos-14` 是 Apple Silicon 运行器）。
> Intel 的 `_x64.dmg` 需要在 Intel Mac 上本地 `pnpm tauri build --target x86_64-apple-darwin --bundles dmg`
> 打出后手动上传。deb 是 glibc 构建，装在较老的发行版上可能报缺 `GLIBC_2.32` 一类的错。

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

**不公签（决策）**：不做 Developer ID 签名与 Apple 公证，**产物是未签名的** ——
tauri 在既无 `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` 又无 `signingIdentity`
时会整段跳过签名（`tauri-bundler` 的 `bundle/macos/sign.rs` 里 `keychain()` 返回
`Ok(None)`），**不会自动 ad-hoc 签名**。所以下面的手动重签不是"补签"，而是首次签名。

- 首次打开：右键 App →「打开」→ 再点「打开」；或
  `xattr -dr com.apple.quarantine /Applications/QuietMusic.app`。
- 想让它有签名（减少 Gatekeeper 反复拦截）：自己签一次
  `codesign --force --deep --sign - /Applications/QuietMusic.app`。
- 手动替换或重新编译二进制会破坏已有签名，需重签同一条命令。

数据与日志：数据 `~/Library/Application Support/QuietMusic`，日志 `~/Library/Logs/QuietMusic`。

其余能力与 Windows 对齐：系统媒体控制走 macOS 的「正在播放」（souvlaki 原生后端，无需额外
feature）、托盘、开机自启（LaunchAgent）、全局快捷键均可用；同样**没有应用内自装**。

**架构覆盖**：`release.yml` 的 `macos` job 跑在 `macos-14`（Apple Silicon）上，
**CI 只产 `_aarch64.dmg`**；Intel 机器需要的 `_x64.dmg` 要在 Intel Mac 上本地执行
上面的构建命令自行产出。

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
| Linux：deb 装不上（依赖版本不满足） | deb 在 GitHub 的 `ubuntu-22.04` 上构建（glibc 2.35），很老的发行版装不上。发行版较旧时改用 AppImage |
| macOS：提示「已损坏，无法打开」/「无法验证开发者」 | 未公证导致的 Gatekeeper 拦截（预期）：右键 →「打开」，或 `xattr -dr com.apple.quarantine /Applications/QuietMusic.app` |
| macOS：替换二进制后「应用已损坏」 | 原本就没有签名（tauri 不自动 ad-hoc），替换后自行签一次：`codesign --force --deep --sign - /Applications/QuietMusic.app` |
| macOS：`pnpm install` 报 `Unsupported Platform: @esbuild/win32-x64` | `package.json` 里 esbuild 平台包被硬钉成 win32 了（历史坑，已移除硬钉），确认没有重新加回 |
| CNB 侧没有触发 `v*` tag 流水线 | ① 仓库「设置 → 云原生构建」勾了「允许自动触发」；② 覆盖同一个 tag 时，**先删 tag、等两分钟再推** —— 删完立刻重推同一秒，CNB 可能不产生 `tag_push` 事件；③ 用 `GET https://api.cnb.cool/{repo}/-/git/commit-statuses/{sha}` 看有没有 `cnb/tag_push/...` 的状态 |
| CNB 镜像报「等待 GitHub Release 超时」 | GitHub 侧构建失败了，去 https://github.com/barry130/qt-pc/actions 看日志；确实只是慢就把 `.cnb.yml` 的 `WAIT_SECONDS`（默认 2700 = 45 分钟）调大 |
| CNB 镜像报 `下载 xxx 失败（n/20 次）` | CNB 节点直连 github.com 会 TCP 超时（脚本已重试 20 次、退避封顶 30s、共享 45 分钟墙钟预算）。持续失败就是节点侧故障，等一会儿重推同一个 tag 重跑即可 |
| 想知道 CNB 流水线到底卡在哪一步 | `GET https://api.cnb.cool/{repo}/-/git/commit-statuses/<完整 sha>` 返回 `cnb/tag_push/pipeline-1(镜像 GitHub Release 产物) | error | error [10m 39s]`，其中的时长能倒推大概卡在哪一步（秒级 = 早期阶段，分钟级 = 轮询或下载）。完整日志在 `ci-debug` 分支，见上面「CNB 镜像流水线失败时怎么看日志」 |
| CNB 镜像报 `…不是合法的 base64 单行签名` | ed25519 签名恒为 64 字节，base64 之后恒为 **88 个字符、结尾是两个 `=`**（64 = 3×21 + 1，多出 1 个字节要补两个 `=`）。按 `{88}=` 去匹配会误判成非法，正确写法是 `{86}==` |
| tag 流水线几秒就红（`error [4~5s]`） | 多半是 stage 脚本里用了 bash 专有语法（`set -o pipefail`、`${PIPESTATUS[0]}`），CNB 是用 dash 跑的，见上面 CNB 一节的提醒 |
