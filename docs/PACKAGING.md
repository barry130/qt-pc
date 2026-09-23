# 打包文档（Windows / NSIS 安装包）

> 本项目的 `pnpm tauri build` 不可用（CLI 会把 `process.argv[0]` 解析成
> `DSH Desktop.exe`，报 `unrecognized subcommand`），所以打包按下面的
> **手动分步**流程执行，效果与 `tauri build` 完全一致。

## 产物

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
3. 验证基线全绿（可选但建议）：
   ```powershell
   pnpm tsc --noEmit; pnpm vitest run
   # cargo 侧：
   $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
   $env:CARGO_HOME = "F:\qtMusic\qt-pc\.cargo-home"
   cargo clippy --all-targets -- -D warnings; cargo test
   ```

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
$env:CARGO_HOME = "F:\qtMusic\qt-pc\.cargo-home"
Set-Location F:\qtMusic\qt-pc
pnpm exec tauri build --runner cargo
```

**方式 B**：完全手动（等价于 tauri build 的核心动作）：

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
$env:CARGO_HOME = "F:\qtMusic\qt-pc\.cargo-home"
Set-Location F:\qtMusic\qt-pc\src-tauri
cargo build --release --features custom-protocol
```

> `custom-protocol` 特性是 Tauri 生产模式的关键（内嵌 dist 资源）。
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

## 常见失败

| 现象 | 处理 |
|---|---|
| `unrecognized subcommand 'DSH Desktop.exe'` | 用了 `pnpm tauri build`；改方式 A/B |
| `failed to remove file ... os error 5` | 应用还在运行，见前置检查 1 |
| NSIS 下载 makensis 卡住 | Tauri CLI 首次会拉 NSIS 工具链，保持网络通畅或设 `TAURI_NSIS_PATH` 指向已有安装 |
| 前端构建后窗口空白 | 确认走的是 `vite build` 且 `dist/` 已生成（生产模式吃 dist，不吃 1420 端口） |
| 图标/中文乱码 | `tauri.conf.json` / `app.config.json` 保存编码必须 UTF-8 无 BOM |
| 安装时弹「系统中已存在…是否卸载」 | 说明用的不是仓库里的自定义模板。确认 `tauri.conf.json` 的 `bundle.windows.nsis.template` 指向 `nsis/installer.nsi`；升级 Tauri CLI 后需重新提取官方模板并重打补丁（见《配置文档》§6） |
| 启动后挂着一个终端/控制台窗口 | `main.rs` 顶部必须有 `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`（release 不分配控制台，dev 保留看日志）；已修，勿删 |
| NSIS 下载失败（timeout / os error 10054） | Tauri 从 GitHub 拉 NSIS 工具链；网络不通时设代理环境变量再重试，例如 `$env:HTTPS_PROXY = "socks5://127.0.0.1:<socks端口>"`（本机实测 10808 端口可用，HTTP 代理端口不行） |
