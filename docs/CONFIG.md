# 配置文档（单一配置源 + 发布前必读）

## 0. 一句话

**改配置只改仓库根的 [`app.config.json`](../app.config.json)，然后跑 `pnpm config:sync`。**
其它配置文件里凡是与它重复的值，都由 [`scripts/sync-config.mjs`](../scripts/sync-config.mjs)
自动写入，**不要手改**（`pnpm config:check` 与单测会拦截手改）。

```bash
pnpm config:sync     # 把 app.config.json 的值写进各工具配置文件（值没变则不落盘）
pnpm config:check    # 只校验，不一致退出码 1（已挂进 pnpm build / pnpm test）
```

`pnpm build`、`pnpm dev`、`pnpm test` 都会自动跑同步/校验，所以正常开发不需要记这两条命令。

## 1. 为什么不是「所有配置文件合成一个」

各工具只认自己的文件名与格式，硬塞进一个文件只会多一层易错的生成步骤。所以口径是：

- **重复出现的值**（版本号、产品名、ID、后端地址、平台号、端口、音源包版本）→ 收进 `app.config.json`；
- **某个工具独占的配置** → 留在原文件，`app.config.json` 不重复记录。

| 留在原文件的配置 | 原因 |
|---|---|
| `tsconfig.json` | tsc 只读这个文件名；编译选项没有第二处副本 |
| `vite.config.ts` / `vitest.config.js` | 构建目标、插件、测试池等；**端口已改为读 `app.config.json`** |
| `src-tauri/Cargo.toml` | 依赖与 `[profile.release]`；**只有 `version` 由同步器写入** |
| `src-tauri/tauri.conf.json` | 窗口尺寸、CSP、capabilities、bundle 段；**只有 5 个值由同步器写入** |
| `src-tauri/nsis/installer.nsi` | NSIS 模板（见 §6）；`nsis-hooks.nsh` 同 |
| `pnpm-workspace.yaml` / `.npmrc` | 包管理器行为 |
| `src/source-scripts/chain-config.ts` | **音源引擎包源码**（会打进 1.77 MB 的 bundle），平台枚举 `PLATFORMS` 与取链顺序都在里面，改动等于换包（见 §5） |

## 2. `app.config.json` 字段 → 落点 → 谁读

| 字段 | 值 | 同步到 | 谁读 |
|---|---|---|---|
| `product.name` | `QuietMusic` | `tauri.conf.json` `productName` | 安装包名、进程名、开始菜单名 |
| `product.displayName` | `轻听` | `tauri.conf.json` `app.windows[0].title` | 主窗口标题 |
| `product.identifier` | `com.qt.quietmusic` | `tauri.conf.json` `identifier` | 注册表路径、数据目录派生（**发布后不可改**） |
| `version.name` | `1.0.7` | `package.json` / `tauri.conf.json` / `Cargo.toml` / `Cargo.lock` / `app_config.rs` | 安装包版本、关于页、`/app/version/check` |
| `version.code` | `107` | `app_config.rs`（`VERSION_CODE`） | `/app/update?version=`、后台 `qt_app_update` 记录 |
| `sourcePack.code` / `.name` | `2026092301` / `2026.09.23.1` | `src/source-scripts/source-update.ts`、`src-tauri/builtin-sources/version.json`、`app_config.rs` | 内置音源包版本、更新判定基线 |
| `sourcePack.hostApiVersion` | `1` | `source-update.ts`、`app_config.rs` | 宿主契约版本（与 Rust `HOST_API_VERSION` 同源） |
| `backend.dev` / `.prod` | 见文件 | `app_config.rs`（`DEV_BASE_URL` / `PROD_BASE_URL`） | Astral 后端地址 |
| `backend.active` | `prod` | `app_config.rs`（`DEFAULT_BASE_URL`） | **当前生效**的后端；联调改 `dev` 后同步重编 |
| `platform.windows` | `1103` | `app_config.rs`（`UPDATE_TYPE`） | 更新/消息/统计的平台号 |
| `feedback.platform` | `windows` | `app_config.rs`（`FEEDBACK_PLATFORM`） | 反馈接口 `X-Platform` 头 |
| `devServer.port` / `.hmrPort` | `1420` / `1421` | `tauri.conf.json` `build.devUrl`；vite 直接读 JSON | 开发服务器端口 |

派生文件总表（同步器负责的全部落点，共 7 个）：

```text
package.json                                   version
src-tauri/tauri.conf.json                      productName / version / identifier / title / devUrl
src-tauri/Cargo.toml                           [package] version
src-tauri/Cargo.lock                           name = "quietmusic" 那段 version
src/source-scripts/source-update.ts            BUILTIN_SOURCE_VERSION / HOST_API_VERSION
src-tauri/builtin-sources/version.json         内嵌音源包版本清单
src-tauri/src/app_config.rs                    Rust 侧常量 + 一致性单测（整文件生成）
```

## 3. 护栏：手改会在哪里失败

| 位置 | 守什么 |
|---|---|
| `tests/config.test.ts` | 7 个派生文件全部与 `app.config.json` 一致；版本名↔版本号自洽 |
| `src-tauri/src/app_config.rs` 的 `#[cfg(test)]` | 逐项比对 JSON；`DEFAULT_BASE_URL` 跟随 `backend.active`；`version.name ↔ version.code`；`env!("CARGO_PKG_VERSION")`（Cargo.toml）↔ JSON |
| `pnpm test` / `pnpm build` | 前者跑 `--check` 直接失败；后者先同步再构建 |
| `scripts/sync-config.mjs` | 正则未命中会报错（说明文件被改得不像样了），不会静默跳过 |

## 4. 发布一个新版本（PC 应用）

```text
1. 改 app.config.json 的 version.name 与 version.code
   （1.0.7 → 1.0.8 对应 code 108；两个必须一起改，单测会校验自洽）
2. pnpm config:sync              # 或直接 pnpm build，它会先同步
3. pnpm config:check && pnpm test && (cd src-tauri && cargo test --lib)
4. 打包（见 docs/PACKAGING.md），产物：
   src-tauri/target/release/bundle/nsis/QuietMusic_<版本>_x64-setup.exe
5. 算安装包 MD5 与字节大小
6. 上传安装包（GitHub Release / 对象存储）
7. 后台「版本更新」新增记录：type=1103、versionCode、versionName、downloadUrl、
   browserUrl、isGithub=1、md5、fileSize、channel、isForce、isPublished=0
8. 用当前版本自测 /app/version/check 通过（未发布也能校验通过）
9. 确认无误后 isPublished 置 1，客户端开始收到更新
```

> **`version.code` 是发版版本号**（`major*100 + minor*10 + patch`：1.0.0 → 100、1.0.7 → 107），
> 必须与后台 `qt_app_update` 记录一致 —— 更新检查就是拿它比大小。传错等于「永远没有更新」。

## 5. 音源包版本（`sourcePack`）

- 号规则：**镜像「最新一次正式发布」的后端发号**（后端新建 release 时生成 `yyyyMMddNN`），
  内置包随后同步为同号同物。安卓端 `qt-uniappx/services/source-bundle-fs.uts` 的
  `BUILTIN_VERSION_CODE` 必须同号。
- 换号流程：改 `app.config.json` 的 `sourcePack` → `pnpm config:sync`
  → `pnpm build:sources`（产出 `dist-sources/`）→ `pnpm sync:builtin`
  （同步进 `src-tauri/builtin-sources/`，`version.json` 由它生成）→ 重新编译。
- **同号换内容**会让设备上已解包的旧副本一直盖住新实现，所以内置包内容一变就必须换号。
- 同步器对 `source-update.ts` 是**写前比对**：值没变绝不碰文件 —— 该文件参与构建，
  无意义改动会污染产物哈希（发布说明里记了 bundle 的 SHA256）。

## 6. 安装包行为（NSIS 自定义模板）

`tauri.conf.json` 的 `bundle.windows.nsis.template` 指向 `src-tauri/nsis/installer.nsi`
（Tauri 2.5.0 官方模板 + 18 行补丁）：

- **升级 / 同版本重装 → 不再弹「系统中已存在…是否卸载」页**，直接原地覆盖安装；
  用户数据（`%APPDATA%\QuietMusic`）不受影响。
- 仍会弹的两种情况：从 WiX/MSI 安装迁移（旧 MSI 必须先卸）、降级（需用户确认回退）。
- 原理：`PageReinstall` 的 create 回调里 `Abort` 会跳过整页，leave 回调不执行
  （模板自身的「无既有安装」分支就依赖这个语义），因此不会触发卸载；
  安装目录在 `.onInit` 的 `RestorePreviousInstallLocation` 里从注册表恢复，
  与这个页面无关，自定义安装目录照旧沿用。
- ⚠️ **升级 Tauri CLI 后必须重新提取模板并重打补丁**：模板正文藏在
  `node_modules/@tauri-apps/cli/cli.win32-x64-msvc.node` 里（搜
  `Custom page to ask user if he wants to reinstall`，向前找到 `Unicode true`），
  重新提取后把那段 `Abort` 补丁再插到 `${If} $R0 = -1 … ${EndIf}` 之后。

## 7. 常见坑（本项目实测）

1. **`pnpm tauri build` / `pnpm tauri dev` 在本机不可用** —— Tauri CLI 会把
   `process.argv[0]` 解析成 `DSH Desktop.exe`，报 `unrecognized subcommand`。
   打包走手动分步（见《打包文档》）。
2. **`pnpm <script>` 在本机可能被 pnpm 自己拦**（`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`）。
   绕行：直接调 node 入口，例如
   `node node_modules/typescript/bin/tsc --noEmit`、`node node_modules/vitest/vitest.mjs run`、
   `node node_modules/vite/bin/vite.js build`。脚本本身与 CI 不受影响。
3. 打包前**必须关掉正在运行的 QuietMusic 进程**，否则链接 `quietmusic.exe` 报 `os error 5 拒绝访问`。
4. cargo 命令统一加环境变量：
   `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"; $env:CARGO_HOME = "F:\qtMusic\qt-pc\.cargo-home"`
   —— 本机 HTTPS 拉取 crates.io 不可用，依赖走 `.cargo-home` 缓存 + `tools/registry-proxy.mjs`，
   **不要删 `.cargo-home/`**。
5. 所有带中文的配置文件（`tauri.conf.json`、`app.config.json`）必须 **UTF-8 无 BOM**，
   否则窗口标题/安装包名会乱码。改完用 `Get-Content -Encoding UTF8` 确认。
6. PowerShell 5.1 读 UTF-8 文件会显示乱码（那是**显示**问题，不代表文件坏了）；
   判断文件编码请用编辑器或 `read` 工具，不要凭 `Get-Content` 的输出下结论。
7. 不要用 `>nul` 这类 POSIX 写法 —— 在 PowerShell 里会生成一个名为 `nul` 的垃圾文件
   （已在 `.gitignore` 里，但别制造它）。

## 8. 仓库卫生（哪些是产物、哪些被保留）

`.gitignore` 覆盖：`node_modules/`、`dist/`、`dist-sources/`、`src-tauri/target/`、
`.cargo-home/`、`.pnpm-store/`、`.npm-cache/`、`.vite-cache/`、`tmp/`、`.tmp/`、
`src-tauri/gen/schemas/`、`src-tauri/.cargo/`、`*.log`、`nul` 等。

**可以随时删（会自动重建）**：`dist/`、`dist-sources/`、`.vite-cache/`、`.npm-cache/`、
`src-tauri/gen/schemas/`、`src-tauri/target/debug/`（debug 产物，删后 `tauri dev` 首次重编较慢）。

**不要删**：

| 目录 | 原因 |
|---|---|
| `.cargo-home/` | 本机唯一的 crates.io 缓存，删了在本机无法构建 |
| `node_modules/`、`.pnpm-store/` | 本机 pnpm 安装不稳，删了可能装不回来 |
| `src-tauri/target/release/` | 保留可让 release 重编只需几分钟；安装包产物也在这里 |

根目录保留的 4 个诊断文件（**不是垃圾，勿删**，被源码注释与发布说明引用）：
`diag-live-rank.mjs`、`diag-line-verdict.mjs`（线路排名复测工具）、
`diag-live-rank-1101.json`、`diag-live-rank-1101-kw-wyy.json`（复测原始数据，
见 `src/source-scripts/chain-config.ts` 里「摘除两条线路」的依据）。
