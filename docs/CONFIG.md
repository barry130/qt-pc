# 配置文档（单一配置源 + 发布前必读）

## 0. 一句话

**公开配置只改仓库根的 [`app.config.json`](../app.config.json)，然后跑 `pnpm config:sync`。**
其它配置文件里凡是与它重复的值，都由 [`scripts/sync-config.mjs`](../scripts/sync-config.mjs)
自动写入，**不要手改**（`pnpm config:check` 与单测会拦截手改）。

**自有域名 / 生产后端地址 / 官网地址不进仓库**，只写在 `app.config.local.json`
（被 `.gitignore` 忽略，模板见 [`app.config.local.json.example`](../app.config.local.json.example)），
详见 §2.1。

```bash
pnpm config:sync     # 把 app.config.json 的值写进各工具配置文件（值没变则不落盘）
pnpm config:check    # 只校验，不一致退出码 1（已挂进 pnpm build / pnpm test）
```

`pnpm build`、`pnpm dev`、`pnpm test` 都会自动跑同步/校验，所以正常开发不需要记这两条命令。

## 1. 为什么不是「所有配置文件合成一个」

各工具只认自己的文件名与格式，硬塞进一个文件只会多一层易错的生成步骤。所以口径是：

- **重复出现的值**（版本号、产品名、ID、后端地址、平台号、端口、宿主契约版本）→ 收进 `app.config.json`；
- **某个工具独占的配置** → 留在原文件，`app.config.json` 不重复记录。

| 留在原文件的配置 | 原因 |
|---|---|
| `tsconfig.json` | tsc 只读这个文件名；编译选项没有第二处副本 |
| `vite.config.ts` / `vitest.config.js` | 构建目标、插件、测试池等；**端口已改为读 `app.config.json`** |
| `src-tauri/Cargo.toml` | 依赖与 `[profile.release]`；**只有 `version` 由同步器写入** |
| `src-tauri/tauri.conf.json` | 窗口尺寸、CSP、capabilities、bundle 段；**只有 5 个值由同步器写入** |
| `src-tauri/nsis/installer.nsi` | NSIS 模板（见 §6）；`nsis-hooks.nsh` 同 |
| `pnpm-workspace.yaml` / `.npmrc` | 包管理器行为 |

## 2. `app.config.json` 字段 → 落点 → 谁读

| 字段 | 值 | 同步到 | 谁读 |
|---|---|---|---|
| `product.name` | `QuietMusic` | `tauri.conf.json` `productName` | 安装包名、进程名、开始菜单名 |
| `product.displayName` | `轻听` | `tauri.conf.json` `app.windows[0].title` | 主窗口标题 |
| `product.identifier` | `com.qt.quietmusic` | `tauri.conf.json` `identifier` | 注册表路径、数据目录派生（**发布后不可改**） |
| `version.name` | `1.0.8` | `package.json` / `tauri.conf.json` / `Cargo.toml` / `Cargo.lock` / `app_config.rs` | 安装包版本、关于页、`/app/version/check` |
| `version.code` | `108` | `app_config.rs`（`VERSION_CODE`） | `/app/update?version=`、后台 `qt_app_update` 记录 |
| `sourcePack.hostApiVersion` | `1` | `source-update.ts`、`app_config.rs` | 宿主契约版本（与 Rust `HOST_API_VERSION` 同源） |
| `backend.dev` | `http://localhost:27000/api/v1/` | `app_config.rs`（`DEV_BASE_URL`） | **本机联调**后端地址（公开仓库只留这一个） |
| `backend.active` | `prod` | `app_config.rs`（`DEFAULT_BASE_URL`） | **当前生效**的后端；联调改 `dev` 后同步重编 |
| `platform.windows` / `.linux` / `.macos` | `1103` / `1104` / `1105` | `app_config.rs`（`UPDATE_TYPE` 字符串、`PLATFORM_CODE` 数值，均按 `target_os` 三选一） | 更新/消息/统计的平台号，以及音源包 manifest 请求与装载上报的 `platform` 字段 |
| `devServer.port` / `.hmrPort` | `1420` / `1421` | `tauri.conf.json` `build.devUrl`；vite 直接读 JSON | 开发服务器端口 |

> `backend.prod` **已从本文件移除**：生产后端地址是自有地址，见 §2.1。

派生文件总表（同步器负责的全部落点，共 6 个）：

```text
package.json                                   version
src-tauri/tauri.conf.json                      productName / version / identifier / title / devUrl
src-tauri/Cargo.toml                           [package] version
src-tauri/Cargo.lock                           name = "quietmusic" 那段 version
src/source-scripts/source-update.ts            HOST_API_VERSION
src-tauri/src/app_config.rs                    Rust 侧常量 + 一致性单测（整文件生成）
```

## 2.1 私有配置（自有域名 / 生产后端 / 官网）

**仓库是公开的，所以任何自有地址都不能出现在提交的文件里。** 这类值走一条独立的路：

```text
app.config.local.json          （不提交，模板 app.config.local.json.example）
        │  pnpm config:sync
        ▼
src-tauri/src/private_config.rs （不提交，由同步器整文件生成）
        │
        ▼
runtime_config.rs               （运行期还能被同名的 app.config.local.json 覆盖）
```

| 字段 | 落点 | 谁读 |
|---|---|---|
| `backendBaseUrl` | `private_config.rs` `BACKEND_BASE_URL` | `runtime_config::base_url()` → `AstralClient::new`（在线试听 / 登录 / 云同步 / 更新检查） |
| `officialSiteUrl` | `private_config.rs` `OFFICIAL_SITE_URL` | `runtime_config::official_site_url()` → `official_site_url` 命令 → 设置页「关于」与「如何设置音源」的入口 |
| `ownDomains` | `private_config.rs` `OWN_DOMAINS` | `net_guard::is_own_host()`（明文 http 下载的白名单） |

### 为什么分「编译期」和「运行期」两层

不是重复：**编译期**那层让发布包里带着真实地址（用户机器上没有配置文件也能用）；
**运行期**那层让运维改地址不必重新发版，也让测试能把客户端指向本机服务。

运行期查找顺序（先命中先用，见 `src-tauri/src/runtime_config.rs`）：

1. 环境变量 `QT_CONFIG_FILE` 指向的文件（调试用）；
2. **exe 所在目录**的 `app.config.local.json`（便携部署 / 正常安装）；
3. `%APPDATA%\QuietMusic\app.config.local.json`（数据目录）；
4. 当前工作目录的 `app.config.local.json` —— **最后**：工作目录不可靠（开发时是
   `src-tauri/`，从快捷方式启动时是「起始位置」里填的任意目录）。

自有域名后缀还可以用环境变量 `QT_OWN_DOMAINS`（逗号分隔）临时覆盖。测试**不走**
环境变量：`own_domain_suffixes()` 是 `OnceLock` 缓存的，改环境变量只在第一次读之前
有效，多线程并行跑用例时会变成「看谁先跑」。测试改用
`runtime_config::set_own_domains_for_test()`（线程局部，用例之间天然隔离）。

### 缺配置时会发生什么（刻意不 panic）

| 场景 | 行为 |
|---|---|
| 没有 `app.config.local.json`（公开仓库 / CI 裸构建） | 编译照常通过：`build.rs` 补空壳、同步器写同义空壳；`BACKEND_BASE_URL` 是空串 |
| 运行期也没有任何私有配置 | `runtime_config::base_url()` 打一条 **ERROR**（说明在线能力不可用，而不是"网络有问题"），回落到本机联调地址 |
| `ownDomains` 为空 | `is_own_host()` 永远返回 false ⇒ 明文 http 下载**一律被拒**。这是收紧方向，正是想要的行为 |
| `officialSiteUrl` 为空 | 设置页不渲染官网那几行（宁可没有入口，也不给打不开的链接） |

### 本地开发怎么用

```powershell
Copy-Item app.config.local.json.example app.config.local.json
# 填上 backendBaseUrl / officialSiteUrl / ownDomains，然后
node scripts/sync-config.mjs      # 或 pnpm config:sync
```

不填也能开发：纯前端 / 本地播放功能与后端地址无关；需要联调后端时把
`app.config.json` 的 `backend.active` 改成 `dev` 即可（那条地址是公开的本机地址）。

**改地址不必重新编译**：把填好的 `app.config.local.json` 放到 exe 旁边
（或 `%APPDATA%\QuietMusic\` 下），运行期 `runtime_config` 会覆盖编译期常量。
调试时也可以用 `QT_CONFIG_FILE` 显式指定任意路径。

### 发布构建如何注入私有配置

[`.github/workflows/release.yml`](../.github/workflows/release.yml) 的
**「注入私有配置」**步骤在打包前用仓库 Secret 生成 `app.config.local.json`，
`pnpm build`（`beforeBuildCommand`）再跑同步器把它编译进 `private_config.rs`：

| Secret | 必填 | 内容 |
|---|---|---|
| `QT_BACKEND_BASE_URL` | ✅ | 生产后端地址（`https://<自有域名>/api/v1/`） |
| `QT_OFFICIAL_SITE_URL` | ✅ | 官网根地址（不要带尾斜杠） |
| `QT_OWN_DOMAINS` | ✅ | 自有域名后缀，逗号分隔（如 `example.com,cdn.example.com`） |

缺必填项时该步骤**直接失败**：静默发出一个连不上后端的包，用户侧只表现为
「登录 / 试听全挂」，比构建失败难查得多。注入完还有一步
「校验私有配置已进入编译产物」——它检查 `private_config.rs` 里确实出现了
后端地址与自有域名，挡住"Secret 填了但没编译进去"这种更隐蔽的错。

## 3. 护栏：手改会在哪里失败

| 位置 | 守什么 |
|---|---|
| `tests/config.test.ts` | 6 个派生文件全部与 `app.config.json` 一致；版本名↔版本号自洽；**公开配置里的每个 http(s) 地址都必须指向本机**（断言不写具体域名，否则测试自己就成了泄露点），且 `backend.prod` 字段不存在 |
| `src-tauri/src/app_config.rs` 的 `#[cfg(test)]` | 逐项比对 JSON；`DEFAULT_BASE_URL` 跟随 `backend.active`；`version.name ↔ version.code`；`env!("CARGO_PKG_VERSION")`（Cargo.toml）↔ JSON；`UPDATE_TYPE` / `PLATFORM_CODE` 与 `platform.<当前目标>` 一致且两者同源 |
| `src-tauri/src/runtime_config.rs` 的 `#[cfg(test)]` | 域名后缀归一化；`host_is_own` 的后缀陷阱（`example.com.evil.com` 不算自家域名）；后缀列表为空时谁都匹配不上 |
| `.github/workflows/ci.yml` 的「公开仓库不得出现自有地址」 | `git grep` 扫全仓：出现自有域名直接红。它拦的是测试夹具与注释里手滑写回真实域名 |
| `pnpm test` / `pnpm build` | 前者跑 `--check` 直接失败；后者先同步再构建 |
| `scripts/sync-config.mjs` | 正则未命中会报错（说明文件被改得不像样了），不会静默跳过；`private_config.rs` **不参与 `--check`**（有私有文件时它本来就该与仓库版本不同） |

## 4. 发布一个新版本（PC 应用）

```text
1. 改 app.config.json 的 version.name 与 version.code
   （如 1.0.8 → 1.0.9 对应 code 109；两个必须一起改，单测会校验自洽）
2. pnpm config:sync              # 或直接 pnpm build，它会先同步
3. pnpm config:check && pnpm test && (cd src-tauri && cargo test --lib)
4. 打包（见 docs/PACKAGING.md），产物：
   Windows  src-tauri/target/release/bundle/nsis/QuietMusic_<版本>_x64-setup.exe
   Linux    src-tauri/target/release/bundle/deb|appimage/QuietMusic_<版本>_amd64.*
   macOS    src-tauri/target/release/bundle/dmg/QuietMusic_<版本>_<arch>.dmg
5. 算安装包 MD5 与字节大小
6. 上传安装包（GitHub Release / 对象存储）
7. 后台「版本更新」新增记录（**每个平台一条，type 分别填** 1103 Windows /
   1104 Linux / 1105 macOS）：versionCode、versionName、downloadUrl、
   browserUrl、isGithub=1、md5、fileSize、channel、isForce、isPublished=0
8. 用当前版本自测 /app/version/check 通过（未发布也能校验通过）
9. 确认无误后 isPublished 置 1，客户端开始收到更新

> Linux / macOS 记录同样要建；这两端没有应用内自装，`browserUrl` 是用户真正下载的入口
> （Windows 的 `browserUrl` 只是备用）。
```

> **`version.code` 是发版版本号**（`major*100 + minor*10 + patch`：1.0.0 → 100、1.0.8 → 108），
> 必须与后台 `qt_app_update` 记录一致 —— 更新检查就是拿它比大小。传错等于「永远没有更新」。

## 5. 音源包（`sourcePack`）

应用**不内置任何音源包**：仓库公开定位为本地音乐播放器，第三方音源实现
不入库、不进安装包。在线能力按需获取，有两条路：

- **官方包（`source: "official"`）**：后端 astral manifest 下发 `source-bundle.js`
  直链，客户端校验（https、公网地址、非空、含 `createSourceLayer` 导出）后
  下载安装；后台每次发版生成 `yyyyMMddNN` 版本号，客户端据此自动更新。
- **自定义包（`source: "custom"`）**：用户在「设置 → 音源包」粘贴任意
  `source-bundle.js` 直链安装。**不自动更新**（更新判定直接跳过），升级 =
  重新粘贴链接；目录名用负数时间戳，与官方版本号永不冲突。

`app.config.json` 里 `sourcePack` 只剩 `hostApiVersion` 一个字段：宿主与音源包
之间的接口契约版本（`{request, chain kind, verifyPlayable}`）。**改它等于
换契约**：旧包要求的版本更高时会拒绝加载，后端 manifest 的
`hostApiVersion` 与这里的值必须同源（同步器写进 `source-update.ts` 与
`app_config.rs`，两处一致由单测守着）。

> 安全闸门（两条安装路径共用）：`net_guard` 校验 https + 非内网地址、
> 下载空文件拒绝、外层冒烟（`createSourceLayer` 字样）、安装后引擎窗口
> 真实取链冒烟（`app_restart` 前置）。冒烟失败过的版本进 `bad` 黑名单，
> 不再自动下载。

## 6. 安装包行为（Windows，NSIS 自定义模板）

> Linux 的 deb/AppImage 与 macOS 的 app/dmg 没有安装器脚本，行为见 `docs/PACKAGING.md`。

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
   `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"`
   —— 本机 HTTPS 拉取 crates.io 不可用，依赖走 **默认 `CARGO_HOME`（`~/.cargo`）** 的缓存 +
   `tools/registry-proxy.mjs`（`src-tauri/.cargo/config.toml` 把 crates.io 指向 `127.0.0.1:8650`）。
   仓库根的 `.cargo-home/` **已废弃不用**（历史遗留约 1.3 GB，可删）。
5. 所有带中文的配置文件（`tauri.conf.json`、`app.config.json`）必须 **UTF-8 无 BOM**，
   否则窗口标题/安装包名会乱码。改完用 `Get-Content -Encoding UTF8` 确认。
6. PowerShell 5.1 读 UTF-8 文件会显示乱码（那是**显示**问题，不代表文件坏了）；
   判断文件编码请用编辑器或 `read` 工具，不要凭 `Get-Content` 的输出下结论。
7. 不要用 `>nul` 这类 POSIX 写法 —— 在 PowerShell 里会生成一个名为 `nul` 的垃圾文件
   （已在 `.gitignore` 里，但别制造它）。

## 8. 仓库卫生（哪些是产物、哪些被保留）

`.gitignore` 覆盖：`node_modules/`、`dist/`、`dist-sources/`、`src-tauri/target/`、
`.cargo-home/`、`.pnpm-store/`、`.npm-cache/`、`.vite-cache/`、`tmp/`、`.tmp/`、
`src-tauri/gen/schemas/`、`src-tauri/.cargo/`、`release-pending/`、`diag-*.mjs`、
`diag-live-rank-*.json`、`*.log`、`nul`，以及两个**私有配置**文件
`app.config.local.json` 与 `src-tauri/src/private_config.rs`（见 §2.1）。

**可以随时删（会自动重建）**：`dist/`、`.vite-cache/`、`.npm-cache/`、
`src-tauri/gen/schemas/`、`src-tauri/target/debug/`（debug 产物，删后 `tauri dev` 首次重编较慢）、
`.cargo-home/`（**已废弃**：当前依赖缓存在默认 `~/.cargo`，此目录是历史遗留约 1.3 GB）。

**不要删**：

| 目录 | 原因 |
|---|---|
| `node_modules/`、`.pnpm-store/` | 本机 pnpm 安装不稳，删了可能装不回来 |
| `src-tauri/target/release/` | 保留可让 release 重编只需几分钟；安装包产物也在这里 |

**本地保留、不入库**（已加进 `.gitignore`，`git rm --cached` 过；文件仍在本机）：

| 项 | 说明 |
|---|---|
| `release-pending/` | 历史发布暂存（内置包时代的产物），公开线已不再使用 |
| `diag-live-rank.mjs`、`diag-line-verdict.mjs` | 线路排名复测工具（本机排障用） |
| `diag-live-rank-1101.json`、`diag-live-rank-1101-kw-wyy.json` | 复测原始数据（约 471 KB），本机留存复查用 |
