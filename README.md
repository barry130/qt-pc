# 轻听 PC 版（QuietMusic）

Windows / Linux / macOS 桌面端轻量级**本地音乐播放器**。基于 **Tauri 2 + React 19 + Rust**（同一份代码按平台编译打包）：本地音乐库开箱即用，无损音质、桌面歌词、下载与云同步收藏；另提供可选的「音源包」机制，安装音源包后可扩展在线试听（本项目**不内置、不分发任何音源实现**）。

> 仅供学习与技术交流使用。本项目不存储、不分发任何音乐内容；音源包由使用者自行获取并自担风险，请勿用于商业用途，并请尊重音乐版权。
> **音源包及其接口、内容均来源于网络、由第三方提供**，本项目不内置、不分发，也不提供任何在线音源包服务。

## 功能特性

- **本地音乐库**：扫描本地目录，读取元数据（MP3 / FLAC / WAV / OGG / AAC / M4A），支持目录级管理——**开箱即用，无需任何音源包**
- **可扩展在线试听**：通过「设置 → 音源包」从链接安装音源包（官方包支持自动更新；也可粘贴自定义直链），统一搜索、播放、歌词、歌单，跨源自动回退取址，当前源不支持时自动换源匹配同一首歌
- **音质切换**：128K / 320K / 无损（FLAC），播放与下载音质相互独立
- **音效 DSP**：十段均衡器（±12dB 防削波，含预设）、响度归一化、淡入淡出，倍速播放（默认倍速全局记忆）
- **在线播放**：HTTP Range 流式读取 + 边下边播，拖动进度条即时定位
- **播放体验**：播放队列、三种播放模式（列表循环 / 单曲循环 / 随机）、音量与静音、播放条工具按钮自定义
- **桌面歌词**：独立置顶歌词窗口，支持锁定 / 穿透、快捷键呼出（Ctrl+Alt+K）与自定义样式，逐行 / 逐字同步
- **系统集成**：系统媒体控制（Windows SMTC / Linux MPRIS / macOS 正在播放，媒体键与蓝牙耳机按键可用）、任务栏缩略图播放控制按钮（Windows）、托盘菜单、开机自启
- **屏蔽规则**：按歌手 / 关键词屏蔽不喜欢的歌曲（歌名 / 歌手拆词匹配，与移动端同口径）
- **下载管理**：无损 / 高音质下载，进度写库、任务列表、去重命名
- **收藏与歌单**：与后端账号云同步，本地 / 在线歌单统一组织，收藏「同名不同源」查重提示，歌单分享链接导入
- **听歌统计**：播放次数、时长、热门曲目与歌手排行；分享卡片（歌曲 / 歌词卡片导出）
- **自动更新**：官方版本校验 + 加速节点下载 + MD5 校验；首次启动引导页
- **外观与快捷键**：浅色 / 深色 / 跟随系统、封面色取色主题、全局快捷键、缓存管理（上限与分项清理）
- **列表体验**：歌单 / 榜单 / 专辑 / 歌手 / 搜索等列表一次性加载完毕（不再滑动续页、没有「已经到底了」），可按歌名 / 专辑名 / 歌手名正倒序排序
- **通知与更新**：站内通告栏 + 消息中心；更新说明按富文本渲染（标题、列表、加粗、可点链接）
- **低占用**：空闲时单核 1%–3%；迷你窗与桌面歌词窗隐藏即销毁，播放条频谱按需刷新
- **界面入口**：标题栏「头像 → 通知 → 设置 → 皮肤」；外观（皮肤 / 背景图 / 字体缩放）是独立一级页

## 界面预览

> 以下均为真实客户端截图（Windows 版，1280 宽）。**截图里出现的在线内容全部来自使用者自行安装的音源包**：
> 音源包及其接口、内容均**来源于网络**，由第三方提供；本项目**不内置、不分发，也不提供任何在线音源包服务**。
> 未安装音源包时，应用是一个完整的本地音乐播放器。

| 发现页 · 每日整理 / 榜单精选 | 歌单广场 · 分类浏览 |
|---|---|
| ![发现页](docs/screenshots/01-home.jpg) | ![歌单广场](docs/screenshots/02-playlists.jpg) |
| **排行榜 · 多源热榜** | **播放页 · 唱片封面与逐行歌词** |
| ![排行榜](docs/screenshots/03-charts.jpg) | ![播放页](docs/screenshots/05-playing.jpg) |
| **每日推荐 · 按听歌口味** | **音源账号 · 扫码 / 网页登录** |
| ![每日推荐](docs/screenshots/08-daily-recommend.jpg) | ![音源账号](docs/screenshots/04-source-accounts.jpg) |
| **音源包 · 安装与更新** | **外观 · 皮肤与背景图** |
| ![音源包设置](docs/screenshots/06-settings-source-pack.jpg) | ![外观](docs/screenshots/07-appearance.jpg) |

## 技术栈

| 层 | 选型 |
|---|---|
| 应用框架 | Tauri 2 |
| 前端 | React 19 + TypeScript 5.8 + Vite 6 + Tailwind CSS v4 + Zustand |
| 路由 | TanStack Router |
| 音频 | rodio 0.22（解码 symphonia 0.5）+ cpal 0.17 |
| 后端 | Rust 2021（MSRV 1.87）· rusqlite（SQLite）· reqwest |
| 测试 | Vitest + Testing Library（前端）· cargo test（Rust） |

## 环境要求

同一份代码三平台编译，按 `target_os` 分平台打包：

- 通用：[Node.js](https://nodejs.org/) ≥ 20 + [pnpm](https://pnpm.io/)、Rust ≥ 1.87（rodio 0.22.2 的 MSRV）
- Windows 10 / 11：WebView2（Win11 自带）+ MSVC 工具链
- Linux（Ubuntu 22.04+，`webkit2gtk-4.1` 自 22.04 起提供）：
  `libwebkit2gtk-4.1-dev`、`libgtk-3-dev`、`libayatana-appindicator3-dev`、`librsvg2-dev`、`libasound2-dev`
- macOS 10.15+：Xcode Command Line Tools（`xcode-select --install`）

各平台的构建命令、产物、运行期依赖与已知限制见
[`docs/PACKAGING.md`](docs/PACKAGING.md)。

## 快速开始

```bash
# 依赖
pnpm install

# 开发模式（前端 Vite + Rust 后端，热重载）
pnpm tauri dev
```

Vite 开发服务器固定监听 `http://localhost:1420` —— 端口单源于 `app.config.json` 的
`devServer.port`（`vite.config.ts` 直接读它，`tauri.conf.json` 的 `devUrl` 由同步器写入）。

前端单独调试：`pnpm dev`（会先同步配置再起 vite）。

### 可选：账号与云同步后端

收藏同步、歌单、自动更新、反馈、统计等能力依赖后端服务 `astral`。播放与本地音乐库不依赖它。

**后端地址不写死在代码里，也不进仓库**（仓库公开，自有域名属于私有信息）。真值来自
[`app.config.local.json`](app.config.local.json.example)（被 `.gitignore` 忽略，模板见
`app.config.local.json.example`），由 `scripts/sync-config.mjs` 编译进
`src-tauri/src/private_config.rs`，运行期再由 `src-tauri/src/runtime_config.rs` 按同名文件覆盖：

- 开发：`http://localhost:27000/api/v1/`（唯一写进公开配置的地址，见 `app.config.json` 的 `backend.dev`）
- 生产：自有域名，**不在仓库里出现**；取值见你本机的 `app.config.local.json` 的 `backendBaseUrl`
- 当前生效哪一条由 `app.config.json` 的 `backend.active` 决定（`dev` / `prod`）

> 本地开发复制一份私有配置即可：`Copy-Item app.config.local.json.example app.config.local.json`
> 再填值，然后跑 `pnpm config:sync`。不填也能开发 —— 本地播放与后端无关，只有在线能力不可用
> （启动日志会打一条说明原因的 ERROR）。
>
> 发布构建由 [`.github/workflows/release.yml`](.github/workflows/release.yml) 的
> 「注入私有配置」步骤用仓库 Secret 生成这个文件，缺 Secret 直接构建失败。
>
> 生产链路必须是 HTTPS：更新包下载与安装器启动都依赖它，明文 HTTP 会让 MD5 校验形同虚设。

## 配置

**公开配置只在仓库根的 [`app.config.json`](app.config.json) 里改一处**，其余文件由
[`scripts/sync-config.mjs`](scripts/sync-config.mjs) 自动写入 —— 版本号、产品名、应用 ID、
平台号、开发端口、宿主契约版本都在那里：

```bash
pnpm config:sync     # 同步到 package.json / tauri.conf.json / Cargo.toml / Cargo.lock /
                     # src/source-scripts/source-update.ts / src-tauri/src/app_config.rs
                     # 有 app.config.local.json 时还会生成 src-tauri/src/private_config.rs
pnpm config:check    # 只校验（已挂进 pnpm build / pnpm test：手改派生文件会直接失败）
```

- 发版只改 `version.name` 与 `version.code` 两行（如 `1.0.8` / `108`），二者自洽性由单测校验。
- 自有域名、生产后端地址、官网地址走**另一条独立的私有链路**（`app.config.local.json`
  → `private_config.rs` → `runtime_config.rs`），既不进仓库，也不参与一致性校验。
- 工具独占的配置（tsconfig 选项、vite 构建目标、Cargo 依赖与 profile、NSIS 模板）留在各自文件，
  不重复记录；完整字段表、护栏位置、私有配置查找顺序、音源包机制、安装包行为见
  [`docs/CONFIG.md`](docs/CONFIG.md)。

## 测试

提交前跑这两条就够（都当门禁用，警告即失败）：

```bash
pnpm check                                    # 配置一致性 → tsc → 字号/动效令牌 → eslint --max-warnings 0 → vitest
cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test --lib
```

```bash
# 只跑前端测试（Vitest，129 个测试文件 / 1242 条用例）
pnpm test
pnpm typecheck
pnpm lint                                     # 只跑 eslint（pnpm check 里带 --max-warnings 0）

# Rust 单元测试
cd src-tauri && cargo test --lib

# FLAC 定位回归测试（含负例，锁定 rodio 的 Unseekable 行为）
cd src-tauri && cargo test --test flac_seek

# 真实链路测试（依赖外网，默认 #[ignore]）
cd src-tauri && cargo test --test live_astral -- --ignored --nocapture
```

## 构建与打包

```bash
pnpm build          # 仅前端产物（会先跑 config:sync）
```

> **本机不能直接跑 `pnpm tauri build` / `pnpm tauri dev`**：Tauri CLI 会把 `process.argv[0]`
> 解析成 `DSH Desktop.exe`，报 `unrecognized subcommand`。三平台安装包（Windows NSIS /
> Linux deb+AppImage / macOS app+dmg）都走 [`docs/PACKAGING.md`](docs/PACKAGING.md)
> 里的手动分步流程（`pnpm exec tauri build --runner cargo --bundles <目标>`），与 `tauri build` 等价。

版本号等发布前必须同步修改的配置见 [`docs/CONFIG.md`](docs/CONFIG.md)。

## 目录结构

```
qt-pc/
├── app.config.json          # ★ 唯一配置源：版本号 / 产品名 / ID / 后端地址 / 端口 / 宿主契约版本
├── src/                     # 前端（React）
│   ├── components/          # UI 组件：common / layout / discovery / library / lyric / mine / music-source / notice / onboarding / player / update …
│   │   └── common/ErrorBoundary.tsx  # 渲染异常兜底（路由级 + 常驻页级）
│   ├── hooks/               # 位置插值、播放事件订阅、分页列表、歌词偏移等
│   ├── lib/                 # 工具：router / lazyPage（路由级代码分割）/ lrc / skins / storageKeys / source-switch …
│   ├── services/ipc.ts      # 所有 Tauri invoke 的唯一出口
│   ├── source-scripts/      # 音源包宿主 facade：统一入口 / 命中线路记账 / 版本检查 / qt-contract（宿主契约）
│   ├── source-engine/       # 引擎页客户端（跑音源包取链）
│   ├── stores/              # Zustand：播放 / 队列 / 认证 / 外观 / 屏蔽规则 / 下载 / 数据包注册 …
│   └── types/               # 与 Rust serde 模型一一对应的 TS 类型
├── src-tauri/               # Rust 后端
│   ├── src/audio/           # 音频引擎（专属线程 + 命令通道）、DSP 音效、队列、HTTP Range 读取
│   ├── src/provider/        # 音源类型 / 取址缓存（原生 Provider 已删除，取链走音源包线路）
│   ├── src/db/              # SQLite 存储与迁移
│   │   └── store/           # 存取层按域拆分：tracks / local / likes / playlists / history / stats / downloads / session / settings
│   ├── src/app_config.rs    # 配置生成物（唯一读取入口，勿手改）
│   ├── src/ipc_guard.rs     # 命令调用来源校验（危险命令只允许主窗口调用）
│   ├── src/net_guard.rs     # 出网请求校验（scheme / 私网地址 / host 白名单）
│   ├── src/app_paths.rs     # 数据 / 日志根目录（Windows / Linux / macOS 三平台口径）
│   ├── src/smtc.rs          # 系统媒体控制（Windows SMTC / Linux MPRIS / macOS 正在播放）与硬件媒体键
│   ├── src/taskbar.rs       # 任务栏缩略图工具栏（播放控制三按钮，Windows）
│   ├── src/lyric_window.rs  # 桌面歌词窗口（动态创建 / 锁定穿透 / 位置校验）
│   ├── src/commands.rs      # Tauri 命令层
│   ├── src/source_engine_page.html  # 引擎页（装载 bundle、注入 request 与 chain overlay）
│   └── tests/               # 集成测试（真实链路 live_astral + FLAC 定位回归 flac_seek）
├── scripts/                 # 构建与配置脚本：sync-config（唯一配置源同步）
├── tests/                   # 前端测试（含 config.test.ts 配置护栏）
├── docs/                    # CONFIG.md（配置）/ PACKAGING.md（打包）/ UI-COMPONENTS.md / screenshots（界面截图）
├── tools/                   # 开发辅助脚本（registry-proxy.mjs）
├── DESIGN.md                # 设计文档
└── REQUIREMENTS.md          # 需求文档
```

> **仓库不含任何第三方音源实现**（版权原因）：在线试听依赖运行时安装的音源包
> （官方 manifest 自动更新，或用户粘贴 `source-bundle.js` 直链自装），仓库里只有
> 宿主侧 facade（`src/source-scripts/`）与引擎装载层（`src/source-engine/`、
> `src-tauri/src/source_*.rs`）。卸载音源包后应用仍是完整的本地音乐播放器。

## 文档

| 文档 | 内容 |
|---|---|
| [`DESIGN.md`](DESIGN.md) | 架构设计、模块边界、接口契约 |
| [`REQUIREMENTS.md`](REQUIREMENTS.md) | 功能需求与验收标准 |
| [`docs/CONFIG.md`](docs/CONFIG.md) | **唯一配置源 `app.config.json`**：字段表、同步器用法、发布流程、音源包机制、安装包行为与护栏 |
| [`docs/PACKAGING.md`](docs/PACKAGING.md) | 三平台打包流程（Windows NSIS / Linux deb+AppImage / macOS app+dmg）、自动发版与常见失败 |
| [`docs/plan-playlist-merge.md`](docs/plan-playlist-merge.md) | 收藏 / 歌单模型重构方案 |
| [`docs/UI-COMPONENTS.md`](docs/UI-COMPONENTS.md) | **共享 UI 组件清单与使用规则**：写界面前先查这里，按钮/输入/弹窗/空态/骨架全部走 `@/components/ui` |
| [`docs/screenshots/`](docs/screenshots/) | 界面截图（JPEG，1280 宽），与上文「界面预览」对应；在线内容均来自使用者自行安装的音源包 |

## 已知限制

- 音频格式不支持 APE / WMA / DSD（解码依赖 symphonia）
- 在线能力依赖音源包：未安装时搜索/榜单/在线歌单不可用（本地音乐不受影响）
- 部分音源的无损取址在无无损源时会回退到有损（下载扩展名按实际返回的 URL 决定）
- 逐字歌词、音译歌词仅在音源包支持时可用（qrc / krc 加密歌词暂未实现）

平台相关：

- **应用内更新只在 Windows 可用**：Linux / macOS 没有安装器，`supportsInAppUpdate()` 返回 false，
  新版本走浏览器下载手动安装；后端更新清单按平台（1103 / 1104 / 1105）分别下发。
- **Linux 托盘**依赖桌面的 AppIndicator/StatusNotifier 宿主：GNOME 未装扩展时不显示，
  此时按「关窗即退出」运行（托盘不可用时不留后台进程）。
- **Linux Wayland** 下桌面歌词的置顶/穿透受限（tao 无 layer-shell）、全局快捷键不可用；切 X11 会话正常。
- **macOS 未签名未公证**：首次打开需右键 →「打开」，或 `xattr -dr com.apple.quarantine`；
  手动替换二进制后 ad-hoc 签名失效需重签（见 `docs/PACKAGING.md`）。

## 排障

### cargo 无法通过 HTTPS 拉取依赖

若本机 schannel 客户端凭据异常（`SEC_E_NO_CREDENTIALS`），cargo 的 HTTPS 下载栈会完全不可用。`tools/registry-proxy.mjs` 用 Node 的 TLS 把 crates.io 稀疏索引与 tarball 转发到本地纯 HTTP 端口，配合 `src-tauri/.cargo/config.toml` 即可构建：

```bash
node tools/registry-proxy.mjs   # 监听 127.0.0.1:8650
```

该配置文件是本机绕行方案，已在 `.gitignore` 中排除，请勿提交。

## 协议

本项目以 [Apache-2.0](LICENSE) 协议发布，并附带[补充条款](LICENSE-SUPPLEMENTARY.md)
（仓库不含音源实现、音源包风险由使用者自担等内容）。代码仅供学习交流，
使用者需自行承担因使用第三方接口产生的风险。
