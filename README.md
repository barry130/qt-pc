# 轻听 PC 版（QuietMusic）

Windows 桌面端轻量级聚合音乐播放器。基于 **Tauri 2 + React 19 + Rust**，把 QQ 音乐、网易云音乐、酷我、酷狗四个音源聚合到一个原生窗口里，支持在线播放、本地音乐库、无损音质、桌面歌词、下载与云同步收藏。

> 仅供学习与技术交流使用。音源接口均来自第三方公开接口，本项目不存储、不分发任何音乐内容，请勿用于商业用途，并请尊重音乐版权。

## 功能特性

- **四音源聚合**：QQ / 网易云 / 酷我 / 酷狗统一搜索、播放、歌词、歌单，跨源自动回退取址
- **音质切换**：128K / 320K / 无损（FLAC），播放与下载音质相互独立
- **本地音乐库**：扫描本地目录，读取元数据（MP3 / FLAC / WAV / OGG / AAC / M4A），支持目录级管理
- **在线播放**：HTTP Range 流式读取 + 边下边播，拖动进度条即时定位
- **播放体验**：播放队列、四种播放模式（顺序 / 列表循环 / 单曲循环 / 随机）、音量与静音
- **桌面歌词**：独立置顶歌词窗口，支持锁定 / 穿透与自定义样式
- **下载管理**：无损 / 高音质下载，进度写库、任务列表、去重命名
- **收藏与歌单**：与后端账号云同步，本地 / 在线歌单统一组织
- **听歌统计**：播放次数、时长、热门曲目与歌手排行
- **自动更新**：官方版本校验 + 加速节点下载 + MD5 校验
- **外观与快捷键**：浅色 / 深色 / 跟随系统、封面色取色主题、全局快捷键

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

- Windows 10 / 11（需要 WebView2，Win11 自带）
- [Node.js](https://nodejs.org/) ≥ 20 + [pnpm](https://pnpm.io/)
- Rust ≥ 1.87（rodio 0.22.2 的 MSRV）
- Tauri 的 Windows 构建依赖（MSVC 工具链、WebView2）

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

后端地址由单一配置源生成，落点在 `src-tauri/src/app_config.rs`（`astral.rs` 转指到它）：

- 开发：`http://localhost:27000/api/v1/`
- 生产：`https://astral.canace.cn/api/v1/`（**当前生效**，`backend.active = "prod"`）

> 切换环境只改 `app.config.json` 的 `backend.active`（`dev` / `prod`）再跑 `pnpm config:sync` 重新编译，
> 不要手改 `app_config.rs` / `astral.rs` 里的地址字面量。详见 [`docs/CONFIG.md`](docs/CONFIG.md)。
>
> 生产链路必须是 HTTPS：更新包下载与安装器启动都依赖它，明文 HTTP 会让 MD5 校验形同虚设。

## 配置

**所有配置只在仓库根的 [`app.config.json`](app.config.json) 里改一处**，其余文件由
[`scripts/sync-config.mjs`](scripts/sync-config.mjs) 自动写入 —— 版本号、产品名、应用 ID、
后端地址、平台号、开发端口、音源包版本都在那里：

```bash
pnpm config:sync     # 同步到 package.json / tauri.conf.json / Cargo.toml / Cargo.lock /
                     # src-tauri/src/app_config.rs / builtin-sources/version.json / source-update.ts
pnpm config:check    # 只校验（已挂进 pnpm build / pnpm test：手改派生文件会直接失败）
```

- 发版只改 `version.name` 与 `version.code` 两行（如 `1.0.8` / `108`），二者自洽性由单测校验。
- 工具独占的配置（tsconfig 选项、vite 构建目标、Cargo 依赖与 profile、NSIS 模板）留在各自文件，
  不重复记录；完整字段表、护栏位置、音源包换号流程、安装包行为见 [`docs/CONFIG.md`](docs/CONFIG.md)。

## 测试

```bash
# 前端（Vitest，20 个测试文件）
pnpm test
pnpm typecheck

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
> 解析成 `DSH Desktop.exe`，报 `unrecognized subcommand`。完整安装包（NSIS）走
> [`docs/PACKAGING.md`](docs/PACKAGING.md) 里的手动分步流程，效果与 `tauri build` 一致。

版本号等发布前必须同步修改的配置见 [`docs/CONFIG.md`](docs/CONFIG.md)。

## 目录结构

```
qt-pc/
├── app.config.json          # ★ 唯一配置源：版本号 / 产品名 / ID / 后端地址 / 端口 / 音源包版本
├── src/                     # 前端（React）
│   ├── components/          # UI 组件：common / layout / discovery / library / lyric / mine / player / update …
│   │   └── common/ErrorBoundary.tsx  # 渲染异常兜底（路由级 + 常驻页级）
│   ├── hooks/               # 位置插值、播放事件订阅、分页列表等
│   ├── lib/                 # 工具：router / lazyPage（路由级代码分割）/ lrc / skins / storageKeys …
│   ├── services/ipc.ts      # 所有 Tauri invoke 的唯一出口
│   ├── source-scripts/      # 音源包宿主 facade（3 个文件）：统一入口 / 命中线路记账 / 版本检查
│   ├── source-engine/       # 引擎页客户端（跑音源包取链）
│   ├── stores/              # Zustand：播放状态 / 队列 / 认证 / 外观
│   └── types/               # 与 Rust serde 模型一一对应的 TS 类型
├── src-tauri/               # Rust 后端
│   ├── src/audio/           # 音频引擎（专属线程 + 命令通道）、队列、HTTP Range 读取
│   ├── src/provider/        # 音源类型 / 取址缓存（原生 Provider 已删除，取链走音源包线路）
│   ├── src/db/              # SQLite 存储与迁移
│   │   └── store/           # 存取层按域拆分：tracks / local / likes / playlists / history / stats / downloads / session / settings
│   ├── src/app_config.rs    # 配置生成物（唯一读取入口，勿手改）
│   ├── src/ipc_guard.rs     # 命令调用来源校验（危险命令只允许主窗口调用）
│   ├── src/net_guard.rs     # 出网请求校验（scheme / 私网地址 / host 白名单）
│   ├── src/commands.rs      # Tauri 命令层
│   ├── src/source_engine_page.html  # 引擎页（装载 bundle、注入 request 与 chain overlay）
│   ├── builtin-sources/     # ★ 内置音源包（由 ../qt-sources 构建交付，勿手改）
│   └── tests/               # 集成测试（真实链路 live_astral + FLAC 定位回归 flac_seek）
├── scripts/                 # 构建与配置脚本：sync-config / check-builtin-sources（内置包体检，只读）
├── tests/                   # 前端测试（含 config.test.ts 配置护栏）
├── docs/                    # CONFIG.md（配置）/ PACKAGING.md（打包）/ 审查与优化报告 / 重构方案
├── tools/                   # 开发辅助脚本（registry-proxy.mjs）
├── DESIGN.md                # 设计文档
└── REQUIREMENTS.md          # 需求文档
```

> **音源包实现在同级独立工程 [`../qt-sources`](../qt-sources)**（第 4 个 git 仓库）：
> 平台无关的第三方音源实现 + 打包流程 + 逐字节还原/挂死守卫，一次构建同时交付
> qt-pc 内置包与 qt-uniappx 内置包。qt-pc 只保留宿主侧 facade（`src/source-scripts/`
> 的 3 个文件）与 Rust 的 `builtin_request`。详见 [`../qt-sources/README.md`](../qt-sources/README.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [`DESIGN.md`](DESIGN.md) | 架构设计、模块边界、接口契约 |
| [`REQUIREMENTS.md`](REQUIREMENTS.md) | 功能需求与验收标准 |
| [`docs/CONFIG.md`](docs/CONFIG.md) | **唯一配置源 `app.config.json`**：字段表、同步器用法、发布流程、安装包行为与护栏 |
| [`docs/PACKAGING.md`](docs/PACKAGING.md) | Windows 安装包打包流程 |
| [`docs/plan-playlist-merge.md`](docs/plan-playlist-merge.md) | 收藏 / 歌单模型重构方案 |
| [`docs/代码审查与优化报告-20260927.md`](docs/代码审查与优化报告-20260927.md) | 全仓代码审查：安全问题、稳定性、性能与工程卫生（含修复路线图） |

## 已知限制

- 音频格式不支持 APE / WMA / DSD（解码依赖 symphonia）
- 部分音源的无损取址在无无损源时会回退到有损（下载扩展名按实际返回的 URL 决定）
- 逐字歌词、音译歌词仅在音源支持时可用（QQ qrc / 酷狗 krc 需解密，暂未实现）

## 排障

### cargo 无法通过 HTTPS 拉取依赖

若本机 schannel 客户端凭据异常（`SEC_E_NO_CREDENTIALS`），cargo 的 HTTPS 下载栈会完全不可用。`tools/registry-proxy.mjs` 用 Node 的 TLS 把 crates.io 稀疏索引与 tarball 转发到本地纯 HTTP 端口，配合 `src-tauri/.cargo/config.toml` 即可构建：

```bash
node tools/registry-proxy.mjs   # 监听 127.0.0.1:8650
```

该配置文件是本机绕行方案，已在 `.gitignore` 中排除，请勿提交。

## 协议

本项目未附带开源协议文件。如需开源发布，请先补充 LICENSE。代码仅供学习交流，使用者需自行承担因使用第三方接口产生的风险。
