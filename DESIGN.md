# 轻听 PC 端设计文档

- 项目名称：轻听 PC 版
- 目标平台：Windows 10 / Windows 11
- 技术栈：Tauri 2 + React 19 + TypeScript + Tailwind CSS v4 + shadcn/ui + Rust
- 文档版本：v1.3
- 更新日期：2026-09-05
- 关联文档：`qt-pc/REQUIREMENTS.md`、`UPDATE_DESIGN.md`、`LIKE_SYNC_DESIGN.md`、`STATS_DESIGN.md`、`FEEDBACK_DESIGN.md`

---

## 0. 基线核对与修订记录

### 0.1 后端基线核对结论（已对照 astral 源码逐项验证）

| 断言 | 核对结果 | 依据 |
|---|---|---|
| App 接口前缀 `/api/v1/app/**` | ✅ 成立 | `QtAppController`、`QtAppUserController` 的 `@RequestMapping` |
| 认证使用 `satoken` 请求头 | ✅ 成立（**不是** `Authorization: Bearer`） | 所有 App 控制器 `@RequestHeader("satoken")`；`QtAuthInterceptor` 亦读该头 |
| 响应包装器 | ✅ 三种并存，字段一致 `{code,msg,data}` | `QtRestResp`（qt）、`FeedbackRestResp`（反馈/消息）、`Result`（统计/宿主） |
| `type=1101/1102/1103` | ✅ 成立 | `QtAppUpdate.TYPE_WINDOWS = 1103L`、`isSupportedType()` |
| `channel=app/pc/web/all` | ✅ 成立 | `SysNotice.CHANNEL_PC = "pc"`、`FeedbackNoticeService.listForPc()` |
| `ut=app-windows` | ✅ 成立 | `StatEventDTO.ut` 注释 + `dict-init.sql` 字典 `stat_platform` |
| 单批统计 ≤ 200 | ✅ 成立 | `StatReportRequest` `@Size(max = 200)` |
| `like/changes?since=` + `like/list?page=&size=` | ✅ 成立（`size` 默认 500） | `QtAppUserController` |
| 反馈平台头 `X-Platform` | ✅ 成立，后端不做枚举校验，可直接传 `windows` | `AppFeedbackController.submit()` |
| 更新包校验字段 | ✅ **已存在** `md5` 与 `fileSize` | `QtAppUpdate` 实体 |
| 双链接下载 `browserUrl` / `isGithub` | ✅ **已落地**（非待开发） | `QtAppUpdate` 实体 + `QtAppService.getUpdate()` 注释 |
| 旧通知接口 `/api/v1/user/notice/**` | ⚠️ 已 `@Deprecated`，PC 不得使用 | `QtUserNoticeController` |
| Astral 提供音乐内容代理 | ❌ 不提供，结论正确 | 全量 Mapping 扫描无音乐内容接口 |

**新增结论（原文未写明，实现前必须知道）：**

1. `GET /app/update` 的 `version` 参数是**版本号数字的字符串形式**（`Long.parseLong(version)`），不是 `versionName`。传 `"3.0.0"` 会被判为格式错误并返回 `null`。
2. `/app/update` 只返回 `is_published=1` 且 `version_code >` 当前值的记录；`/app/version/check` **不过滤** `is_published`，因此本地未发布版本也能通过官方校验。
3. `channel=beta` 的客户端会同时取 beta 与 stable 的更高版本；`channel=stable` 只取 stable。
4. 移动端调用 `app/message/active` / `center` / `unread-count` 时**未传** `channel`，走后端默认值 `app`。PC 传 `channel=pc` 与后端能力一致，不会互相污染。

### 0.2 本次修订项

| # | 修订 | 位置 |
|---|---|---|
| R1 | 播放地址**不得持久化**到 SQLite，改为进程内缓存（与移动端 `types/music.ts` 注释一致） | §8.3 `tracks` |
| R2 | 补齐在线音频**流式播放链路**（HTTP Range → 磁盘缓冲 → 解码器），原文缺失 | §6.12 |
| R3 | 补齐封面 / MV 的 **Referer 限制**与自定义协议方案，原文缺失 | §6.13 |
| R4 | 桌面歌词改为**歌词窗口自行插值计算**，不再由主窗口中转（主窗口隐藏时定时器会被节流，无法满足 50ms） | §10.2 |
| R5 | 修正「锁定后鼠标穿透」与「悬停解锁」的**逻辑冲突** | §10.4 |
| R6 | 主题变量改用 **shadcn/ui 令牌名 + `@theme inline` 桥接**，否则 shadcn 组件不跟随皮肤 | §9.3 |
| R7 | `ThemeConfig` 拆分为「外观偏好」与「皮肤定义」，皮肤须同时携带 light/dark 两套色板 | §9.2 |
| R8 | `MusicProvider` trait 增加 `#[async_trait]` 与 `Result` 返回，否则无法 `dyn` 分发且丢失错误语义 | §6.4 |
| R9 | 补齐 IPC：`next/previous/play_at/set_quality/switch_source`、主题、桌面歌词、频谱、EQ、睡眠定时 | §11 |
| R10 | 补齐音频核心实现路径：频谱采样点、EQ 实现、输出设备热切换、无缝与淡入淡出、时间轴精度 | §7.7–§7.11 |
| R11 | 本地库补 **FTS5 + 拼音索引**，否则 10 万首规模下「1 秒内返回」无法保证 | §8.6 |
| R12 | 明确外键与「失效文件清理」的**数据安全边界**（`ON DELETE CASCADE` 会连带删除歌单与历史） | §8.7 |
| R13 | 补 `tauri.conf.json` / `capabilities` / CSP 骨架与无边框窗口的代价说明 | §4.1、§17.4 |
| R14 | 补 PC `versionCode` 规则与发布流程 | §15.7 |
| R15 | 路由表、事件表、状态结构补全至与 §19 目录结构一致 | §5.2、§11.8、§12.1 |

---

## 1. 设计目标

### 1.1 核心目标

1. 使用 Tauri 2 构建轻量桌面壳。
2. 使用 React 19 + Tailwind CSS v4 + shadcn/ui 构建现代界面。
3. 将音频播放、扫描、频谱、系统集成交给 Rust 实现。
4. 通过 SQLite 管理歌单、收藏、历史、扫描结果和设置。
5. 支持完整皮肤自定义体系。
6. 支持独立桌面歌词窗口。
7. 通过 Provider 架构支持音源切换与后续扩展。
8. 保持 Windows 10/11 下的高性能和稳定性。

### 1.2 架构原则

| 原则 | 说明 |
|---|---|
| 前端轻 | React 只负责界面和交互 |
| Rust 重 | 音频、文件、系统集成、数据层由 Rust 处理 |
| 单向数据流 | Rust 推送状态，前端订阅渲染 |
| 音源抽象 | 所有音乐来源统一 Provider 接口 |
| 主题 token 化 | 所有视觉参数通过 CSS Variables 控制 |
| 数据分层 | 永久数据、缓存数据、内存数据明确分离 |
| 可降级 | 高级视觉效果可关闭，核心播放优先保障 |

---

## 2. 总体架构

## 2.1 架构图

```text
┌────────────────────────────────────────────┐
│              React 主窗口 UI                │
│ 首页 / 搜索 / 歌单 / 榜单 / 新歌 / 歌手 / MV │
└──────────────────┬─────────────────────────┘
                   │ Tauri invoke / event
┌──────────────────▼─────────────────────────┐
│                 Tauri 2 IPC                 │
└──────────────────┬─────────────────────────┘
┌──────────────────▼─────────────────────────┐
│                 Rust Core                   │
│  ┌──────────────────────────────────────┐  │
│  │              音频引擎                 │  │
│  │  播放 / 暂停 / seek / 队列 / 无缝播放  │  │
│  │  淡入淡出 / EQ / 频谱 / 输出设备       │  │
│  └──────────────────────────────────────┘  │
│  ┌──────────────────────────────────────┐  │
│  │            音源适配层                  │  │
│  │ wyy / qq / kw / kg 四大音源 Rust Provider │  │
│  └──────────────────────────────────────┘  │
│  ┌──────────────────────────────────────┐  │
│  │            Astral 服务层               │  │
│  │  账号 / 收藏同步 / 反馈 / 通知 / 统计    │  │
│  └──────────────────────────────────────┘  │
│  ┌──────────────────────────────────────┐  │
│  │            元数据处理                  │  │
│  │  lofty / 封面 / LRC / 逐字歌词          │  │
│  └──────────────────────────────────────┘  │
│  ┌──────────────────────────────────────┐  │
│  │              数据层                    │  │
│  │  SQLite / 缓存目录 / 设置 / 日志        │  │
│  └──────────────────────────────────────┘  │
│  ┌──────────────────────────────────────┐  │
│  │            系统集成                    │  │
│  │  托盘 / 快捷键 / 媒体键 / 自启动 / 更新 │  │
│  └──────────────────────────────────────┘  │
└────────────────────────────────────────────┘
```

## 2.2 前后端职责划分

| 职责 | 归属 |
|---|---|
| 页面布局和路由 | React |
| 播放控制 UI | React |
| 歌词渲染 | React / 桌面歌词窗口 |
| 主题应用 | React |
| 音频解码播放 | Rust |
| 四大音源 HTTP 请求、请求头、签名和响应归一 | Rust |
| Astral HTTP 请求、satoken 和自动刷新 | Rust |
| 下载队列和离线文件管理 | Rust |
| 播放队列逻辑 | Rust |
| 文件扫描 | Rust |
| 元数据读取 | Rust |
| SQLite 读写 | Rust |
| 桌面歌词窗口管理 | Rust |
| 托盘、快捷键、媒体键 | Rust |
| 更新下载和安装 | Rust + Tauri Updater |
| 频谱计算 | Rust |
| 频谱渲染 | React Canvas |
---

## 2.3 现有接口基线与移植策略

### 2.3.1 扫描结论

| 目录 | 结论 |
|---|---|
| `qt-uniappx` | 已实现四大音源 `wyy / qq / kw / kg` 的搜索、歌单、榜单、新歌、MV、歌词、播放地址、封面补全、换源和音质选择 |
| `qt-uniappx` | 已实现本地歌单、最近播放、下载队列、收藏同步、Astral 账号、反馈、通知、更新和统计 |
| `astral` | 已实现轻听账号、收藏增量同步、签到、反馈、消息、更新、GitHub 加速和匿名统计 |
| `astral` | 不提供音乐内容代理，音乐内容请求仍在客户端音源适配层完成 |

### 2.3.2 PC 架构决策

1. **音乐内容请求全部下沉 Rust**
   - 移动端的 `services/music-api.ts` 不能直接在 React WebView 中复用。
   - PC 需要将四大音源适配逻辑移植为 Rust Provider。
   - Rust 负责 User-Agent、Referer、Cookie、签名、编码、重试、超时和缓存。
   - React 只消费统一后的 JSON 模型。

2. **Astral 服务直接复用**
   - 账号、收藏、反馈、通知、统计继续请求现有 `/api/v1/app/**`。
   - PC 不新建账号体系。
   - 认证继续使用 `satoken` 请求头。
   - 响应继续按 `QtRestResp{code,msg,data}` 和 `Result{code,msg,data}` 解析。

3. **数据模型保持兼容**
   - 前端内部可以使用 `Track / Playlist / Artist / Album`。
   - 与 Astral 收藏接口交互时保留 `platform` 字段名。
   - 源 ID 保持 `wyy / qq / kw / kg`。
   - 收藏游标继续使用 `updatedSeq`。

4. **移动端行为保留**
   - 播放地址 10 分钟失效。
   - 音质支持 `128 / 320 / flac`。
   - 支持手动换源和跨音源替代。
   - 本地歌单与收藏歌单分离。
   - 最近播放与播放次数独立记录。

### 2.3.3 Rust 移植范围

来自 `qt-uniappx/services/music-api.ts` 的能力：

| 分类 | 方法 |
|---|---|
| 发现 | `playlistCategories`、`recommendations`、`latest`、`allLatest` |
| 榜单 | `charts`、`allCharts`、`chartDetail` |
| 搜索 | `search`、`allSearch`、`searchPlaylists`、`searchArtists`、`searchAlbums`、`artistSongs` |
| 歌单 | `playlist` |
| 热词 | `hotWords`、`allHotWords` |
| MV | `videos`、`videoUrl` |
| 歌词 | `lyrics`、`lyricTranslation` |
| 播放 | `playUrl`、`invalidatePlayUrl` |
| 封面 | `songCover` |

来自 `qt-uniappx/services/http.ts`、`kw-encode.uts`、`kg-sign.ts` 的能力：

1. 直连音源请求
2. 酷我请求编码
3. 酷狗签名
4. 响应 JSON 归一
5. 请求重试
6. 播放地址缓存

### 2.3.4 Astral HTTP 客户端设计

Rust 侧建立一个独立 `AstralClient`：

```text
AstralClient
 ├─ base_url
 ├─ satoken
 ├─ refresh_queue
 ├─ QtRestResp 解析
 ├─ Result 解析
 ├─ 401 自动刷新
 ├─ 请求重试
 └─ 日志脱敏
```

必须实现：

1. 登录后保存 token。
2. 请求前自动附带 `satoken`。
3. 收到 401 时调用 `/app/user/refresh`。
4. 刷新期间的请求进入等待队列。
5. 刷新失败后清理 token 并广播登出事件。
6. token 和敏感信息不写入日志。

### 2.3.5 接口适配状态

| 项目 | 当前状态 | PC 设计 |
|---|---|---|
| 通知渠道 | 后端已支持 `channel=app/pc/web/all` | 消息接口固定传 `channel=pc` |
| 统计平台 | 后端已支持 `ut=app-android/app-ios/app-windows/web` | 统计事件固定传 `ut=app-windows` |
| 更新平台 | 后端已支持 `type=1101/1102/1103` | 更新和官方版本校验固定传 `type=1103` |
| 反馈平台 | 后端接收 `X-Platform` 字符串 | PC 传 `X-Platform: windows` |
| Astral 不代理音乐内容 | 音乐内容仍在客户端适配层请求 | PC Rust Provider 直连现有音源接口 |
| 当前音源接口为公开接口 | 与现有移动端保持一致 | 第一版仅限个人学习交流，商业发行需替换为官方或授权接口 |
---

## 3. 技术选型

## 3.1 前端

| 技术 | 版本 | 用途 |
|---|---|---|
| React | 19 | UI 框架 |
| TypeScript | 5.x | 类型系统 |
| Tailwind CSS | v4 | 样式系统（CSS-first，`@tailwindcss/vite`） |
| shadcn/ui | 最新 | 基础组件（源码复制，不作为运行时依赖） |
| Radix UI | 最新 | 无障碍交互组件 |
| Zustand | v5 | 全局 UI 状态 |
| TanStack Router | v1 | 路由 |
| TanStack Query | v5 | 异步数据管理 |
| `@tanstack/react-virtual` | v3 | 虚拟列表（§12.3 的实现依赖，原文缺失） |
| `dnd-kit` | 最新 | 歌单 / 队列拖拽排序（§3.5 需求依赖，原文缺失） |
| `tw-animate-css` | 最新 | Tailwind v4 下替代 `tailwindcss-animate` |
| lucide-react | 最新 | 图标 |
| Vitest + Testing Library | 最新 | 前端单测（§20.2 的执行载体） |

前端使用的 Tauri JS 包：`@tauri-apps/api`，以及 `plugin-dialog`、`plugin-opener`、`plugin-os`、`plugin-global-shortcut`、`plugin-updater`、`plugin-window-state`、`plugin-autostart`（按启用的 Rust 插件一一对应）。

## 3.2 Rust

| 技术 | 用途 |
|---|---|
| tauri 2 | 桌面应用框架 |
| rodio | 播放图（Sink / Source / 音量 / seek） |
| cpal | 输出设备枚举与流创建（经 rodio 间接使用） |
| symphonia | 解码（通过 rodio 的 `symphonia-all` feature 启用） |
| lofty | 音频元数据与内嵌封面读取 |
| serde / serde_json | 序列化 |
| reqwest | Astral 与音源 HTTP 请求（`rustls-tls` + `cookies` + `stream`） |
| tokio | 异步任务、并发请求、下载队列 |
| biquad | 均衡器滤波器（rodio 无内置 EQ，原文缺失） |
| rustfft | 频谱分析 |
| ringbuf | 音频线程 → 分析线程的无锁采样传递（原文缺失） |
| souvlaki | Windows SMTC 系统媒体控制（原文只提需求未定实现，缺失） |
| keyring | Windows 凭据管理器读写 satoken（§17.1 依赖，原文缺失） |
| image / palette | 封面缩略图与取色 |
| pinyin | 中文库拼音 / 首字母搜索（§8.6 依赖，原文缺失） |
| rusqlite | SQLite（`bundled` + `functions`；FTS5 需开启 `bundled-full` 或确认编译带 FTS5） |
| notify | 文件夹监听 |
| walkdir | 目录遍历 |
| tracing / tracing-appender | 日志与滚动文件 |
| tauri-plugin-updater | 应用更新（备选实现） |
| tauri-plugin-autostart | 开机自启动 |
| tauri-plugin-global-shortcut | 全局快捷键 |
| tauri-plugin-single-instance | 单实例 |
| tauri-plugin-window-state | 主窗口位置 / 尺寸持久化（替代自研 `window-state.json`） |
| tauri-plugin-dialog / opener / os | 文件选择、打开目录、系统信息 |
| windows | 少量 Win32 调用（光标位置轮询、任务栏缩略图工具栏） |

> 具体依赖版本在项目初始化时以当时最新稳定版为准，锁定精确版本并提交 `Cargo.lock` / `pnpm-lock.yaml`。

## 3.3 依赖能力边界（必须在需求阶段确认）

| 事项 | 结论 |
|---|---|
| 解码格式 | symphonia 覆盖 MP3 / FLAC / WAV / OGG(Vorbis) / AAC(ADTS) / M4A(ALAC、AAC in ISO-MP4)，满足 §3.3 需求全部「必须」项 |
| **不支持**的格式 | APE、WMA、DSF/DFF、TAK。若后续要支持，需外挂解码器或 FFmpeg，属范围外 |
| rodio 的 seek | `try_seek()` 对 MP3/FLAC 可用；MP4/AAC 容器上的精度较差，需要按需重建解码器兜底 |
| rodio 的 EQ / 频谱 | **均无内置能力**，需自行实现 `Source` 包装器（§7.7、§7.8） |
| 输出设备热切换 | cpal 不支持在既有流上换设备，必须重建输出流（§7.9） |
| Windows 构建前置 | 需 Rust MSVC 工具链 + VS Build Tools（C++ 桌面开发）+ WebView2 Runtime（Win11 内置，Win10 需引导安装） |

---

## 4. 窗口设计

## 4.1 主窗口

| 配置项 | 设计 |
|---|---|
| 窗口类型 | 无边框窗口 |
| 默认宽度 | 1200 |
| 默认高度 | 760 |
| 最小宽度 | 980 |
| 最小高度 | 640 |
| 标题栏 | 前端自定义 |
| 窗口控制 | 最小化、最大化、关闭 |
| 位置记忆 | 保存位置和大小 |
| 关闭行为 | 默认最小化到托盘 |
| DPI | 支持系统缩放 |
| 多显示器 | 支持在副屏显示 |

### 窗口状态持久化

使用 `tauri-plugin-window-state` 持久化主窗口位置 / 尺寸 / 最大化状态，不再自研 `settings/window-state.json`（自研方案要额外处理副屏拔出、DPI 变化、坐标越界，插件已覆盖）。

需要额外自管的只有一项：**窗口恢复时校验目标显示器是否仍存在**，不存在则回落到主显示器居中。

### 无边框窗口的代价与对策（原文未评估）

`decorations: false` 会同时失去 Windows 的原生能力，必须显式补齐，否则会被用户当成 Bug：

| 失去的能力 | 对策 |
|---|---|
| 边缘拖拽调整大小 | 四边 + 四角共 8 个 6px 命中区，调用 `window.startResizeDragging(direction)` |
| 标题栏拖动 / 双击最大化 | 拖动区用 `data-tauri-drag-region`；双击事件自行切换 `toggleMaximize()` |
| Win11 Snap Layouts（悬停最大化按钮弹出布局） | 无边框下不可用。方案 A：接受缺失；方案 B：引入 `tauri-plugin-decorum` 保留原生按钮区。**建议 v1 选 A 并在需求中标注** |
| 窗口圆角与投影 | Win11 由 DWM 自动圆角；Win10 需自绘 1px 边框，避免与白色背景融为一体 |
| 最大化时贴边 | 监听最大化状态，最大化时移除窗口圆角与外边距（否则会露出桌面） |

### tauri.conf.json 骨架（关键字段）

```json
{
  "productName": "LightListen",
  "identifier": "com.qt.lightlisten",
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "轻听",
        "width": 1200, "height": 760,
        "minWidth": 980, "minHeight": 640,
        "decorations": false,
        "transparent": false,
        "dragDropEnabled": true,
        "visible": false
      }
    ],
    "security": {
      "csp": "default-src 'self'; img-src 'self' asset: http://asset.localhost qtres: data: blob:; media-src 'self' asset: http://asset.localhost qtres: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost",
      "assetProtocol": { "enable": true, "scope": ["$APPDATA/**", "$APPCACHE/**"] }
    }
  },
  "bundle": {
    "targets": ["nsis"],
    "windows": {
      "nsis": { "installMode": "perUser", "languages": ["SimpChinese"] },
      "webviewInstallMode": { "type": "downloadBootstrapper" }
    }
  }
}
```

说明：

1. `identifier` 决定数据目录实际落点为 `%APPDATA%\com.qt.lightlisten\`，与 §8.1 的 `LightListen` 命名需二选一，**建议统一用 identifier**，文档中的 `%APPDATA%/LightListen/` 改为示意。
2. `visible: false` + 前端首帧渲染完成后 `show()`，避免白屏闪烁（§18.1 启动优化的必要条件）。
3. `productName` 用 ASCII，避免安装路径与注册表键出现中文；界面标题用中文「轻听」。
4. 网络请求全部在 Rust 侧发起，因此 `connect-src` 不需要放开任何外部域名，这是把 Provider 下沉 Rust 的额外收益。
5. `dragDropEnabled: true` 用于「拖拽音频文件到窗口即播放」（见 REQUIREMENTS §3.21）。

## 4.2 桌面歌词窗口

| 配置项 | 设计 |
|---|---|
| 窗口类型 | 独立 WebviewWindow |
| 背景 | 透明 |
| 置顶 | 开启 |
| 任务栏 | 不显示 |
| 可拖拽 | 是 |
| 鼠标穿透 | 支持锁定 |
| 尺寸 | 默认 900×140 |
| 位置 | 用户可调整并记忆 |

### 桌面歌词窗口配置

```json
{
  "visible": true,
  "locked": true,
  "x": 120,
  "y": 940,
  "width": 900,
  "height": 140,
  "fontSize": 24,
  "fontWeight": 700,
  "opacity": 0.9,
  "backgroundOpacity": 0,
  "stroke": false,
  "shadow": true,
  "gradient": ["#5b8cff", "#b18cff"],
  "lineMode": "two-lines",
  "offset": 0
}
```

### 窗口创建参数（Tauri，运行时创建而非配置文件声明）

桌面歌词窗口不写进 `tauri.conf.json` 的 `windows` 数组，而是在用户首次开启时由 Rust 动态创建，避免冷启动即创建透明置顶窗口拖慢启动。

```rust
WebviewWindowBuilder::new(app, "lyrics", WebviewUrl::App("index.html#/lyrics".into()))
    .title("轻听桌面歌词")
    .inner_size(900.0, 140.0)
    .decorations(false)
    .transparent(true)       // 必须与 decorations(false) 同时使用
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)           // 透明窗口保留阴影会出现灰色矩形
    .resizable(true)
    .focused(false)          // 创建时不抢焦点，避免打断用户输入
    .visible(false)          // 首帧就绪后再 show()
    .build()?;
```

Windows 平台注意事项（原文未覆盖，均为实测坑点）：

1. **`transparent: true` 必须搭配 `decorations: false`**，否则 Windows 下会出现黑色背景块。
2. 透明窗口内**不能**使用 `backdrop-filter` 做毛玻璃，Win 上 WebView2 对透明层的 backdrop 支持不稳定；需要毛玻璃时改用 `window_effects` 的 Acrylic，且此时 `transparent` 需要让位。**桌面歌词默认走全透明 + 文字描边，不用毛玻璃**。
3. `always_on_top` 会被其他应用的全屏独占（游戏、视频全屏）覆盖，这是系统行为，不视为缺陷；可选提供「检测到前台全屏时自动隐藏」开关（P3）。
4. 多显示器下 `x/y` 是虚拟桌面坐标，可能为负值；恢复位置前必须校验落点仍在某个显示器可见区域内。
5. DPI 变化（跨屏拖动）时窗口尺寸按逻辑像素保持，字体不需要额外缩放。
6. 歌词窗口的 capability 单独授权，只允许订阅歌词与播放位置事件（§17.4）。

## 4.3 迷你播放器窗口

作为后续扩展形态，本期仅保留设计空间。

| 能力 | 说明 |
|---|---|
| 小窗口 | 只显示封面、歌名、基础控制 |
| 可拖拽 | 支持拖动 |
| 可切换 | 主窗口与迷你模式互切 |
| 队列 | 提供简化队列入口 |

---

## 5. 页面与交互设计

## 5.1 全局布局

```text
┌──────────────────────────────────────────────────────┐
│ 标题栏：Logo / 音源切换 / 搜索 / 窗口控制              │
├───────────────┬──────────────────────────────────────┤
│               │                                      │
│   侧边栏       │               内容区                 │
│               │                                      │
│  首页          │ 搜索 / 歌单 / 榜单 / 新歌 / 歌手 / MV │
│  全部音源      │
│  网易云 / QQ   │
│  酷我 / 酷狗   │
│  本地音乐      │
│  歌单          │                                      │
│  收藏          │                                      │
│  最近播放      │                                      │
│  设置          │                                      │
│               │                                      │
├───────────────┴──────────────────────────────────────┤
│ 播放条：歌曲信息 / 控制 / 进度 / 音量 / 队列 / 歌词     │
└──────────────────────────────────────────────────────┘
```

## 5.2 路由设计

原文路由表缺失 §19.1 已声明的 `charts / daily / artist / mv / downloads / messages / feedback / profile / stats` 等 feature，此处补全。除歌词窗口外全部挂在主窗口 `AppShell` 下。

| 路由 | 页面 | 说明 |
|---|---|---|
| `/` | 首页 | 恢复上次播放、最近播放、推荐歌单、新歌速递入口 |
| `/daily` | 每日推荐 | 对齐移动端 `pages/daily`（原文缺失） |
| `/search?q=&type=&scope=` | 搜索页 | 歌曲 / 歌单 / 歌手 / 专辑 分页签，`scope=current\|all` |
| `/playlists` | 歌单广场 | 分类 + 分页推荐歌单 |
| `/playlist/:platform/:id` | 歌单详情 | **必须带 platform**，否则跨音源同 ID 会撞车（原文缺失） |
| `/charts` | 排行榜列表 | 当前音源 / 聚合 |
| `/chart/:platform/:id` | 榜单详情 | 榜单歌曲 |
| `/artist/:platform/:id` | 歌手页 | 歌手歌曲分页 |
| `/album/:platform/:id` | 专辑页 | 专辑曲目 |
| `/mv` | MV 列表 | 分页 MV |
| `/mv/:platform/:id` | MV 播放 | 视频播放页 |
| `/library` | 本地音乐 | 本地歌曲列表 |
| `/library/folders` | 文件夹视图 | 按目录查看 |
| `/my/playlists` | 我的歌单 | 本地歌单管理 |
| `/my/playlist/:id` | 本地歌单详情 | 本地歌单曲目 |
| `/favorites` | 收藏 | 收藏歌曲 / 收藏歌单双页签 |
| `/history` | 播放历史 | 最近播放与完整历史 |
| `/downloads` | 下载管理 | 下载队列与已完成 |
| `/playing` | 播放页 | 大封面、滚动歌词、频谱、队列预览 |
| `/stats` | 听歌报告 | 本地播放统计（对齐移动端 `pages/stats`，原文缺失） |
| `/messages` | 消息中心 | 公告与消息，未读角标 |
| `/feedback` | 意见反馈 | 提交、我的、公开反馈 |
| `/profile` | 个人中心 | 资料、签到、退出登录 |
| `/login` | 登录 / 注册 | 含邮箱验证码、忘记密码（`changePass`） |
| `/settings/:section` | 设置 | `appearance \| audio \| lyric \| library \| download \| shortcut \| network \| storage \| update \| about` |
| `/onboarding` | 首次启动引导 | 对齐 REQUIREMENTS §5.1，原文缺失 |
| `/lyrics` | 桌面歌词 | **仅供歌词窗口加载**，不在主窗口导航中出现 |

路由约定：

1. 所有涉及音源内容的详情页路由都携带 `platform`，与 §6.6 数据模型的 `platform` 字段一一对应。
2. 搜索关键字走 URL query，保证前进 / 后退可复现结果。
3. `/playing` 与 `/lyrics` 共用歌词渲染组件，但状态来源不同（见 §10.2）。

## 5.3 标题栏

组成：

1. 应用 Logo
2. 当前音源切换器
3. 全局搜索框
4. 返回 / 前进按钮（可选）
5. 主页按钮
6. 设置入口
7. 最小化按钮
8. 最大化 / 还原按钮
9. 关闭按钮

## 5.4 侧边栏

**原文冲突修正**：原设计把「网易云 / QQ / 酷我 / 酷狗」同时放进侧边栏导航和标题栏音源切换器，等于同一状态有两个入口，切换后两处都要同步高亮，且「点侧边栏的酷狗」和「用切换器选酷狗」语义无法区分。

结论：**音源是全局状态，只保留标题栏切换器一个入口**；侧边栏只做内容导航。

侧边栏分四组：

### 在线（跟随当前音源）

- 首页 / 每日推荐
- 歌单广场
- 排行榜
- MV

### 我的

- 收藏（歌曲 / 歌单）
- 本地音乐
- 下载管理
- 最近播放
- 听歌报告

### 我的歌单

- 本地歌单列表（可拖拽排序）
- 新建歌单按钮

### 底部固定区

- 消息中心（带未读角标）
- 设置
- 账号头像（未登录显示「登录」）

交互细则：

1. 侧边栏可折叠为 64px 图标条，折叠状态持久化。
2. 「在线」分组标题右侧显示当前音源名，点击等价于打开标题栏切换器，避免用户在侧边栏找不到音源。
3. 未登录时「收藏」仍可用（本地收藏），登录后与 Astral 合并（§8.5）。

## 5.5 播放条

```text
┌──────────────────────────────────────────────────────┐
│ 封面 │ 歌名 / 歌手 │ 上一首 播放 下一首 │ 进度条 │ 音量 │ 队列 歌词 频谱 │
└──────────────────────────────────────────────────────┘
```

### 播放条组件

| 组件 | 功能 |
|---|---|
| TrackInfo | 封面、标题、歌手 |
| SourceBadge | 当前音源标识，点击可换源 |
| QualityButton | 音质选择：128 / 320 / FLAC |
| TransportControls | 播放、暂停、上一首、下一首 |
| ProgressBar | 进度显示和拖动 |
| VolumeControl | 音量和静音 |
| PlayModeControl | 播放模式切换 |
| QueueButton | 打开播放队列 |
| LyricButton | 开关桌面歌词 |
| SpectrumToggle | 开关频谱 |

---

## 6. 音源切换设计（Music Source）

## 6.1 当前音源范围

PC 版第一版严格对齐 `qt-uniappx` 当前支持的四大音源：

| 源 ID | 音源 | 默认显示名 | 当前能力来源 |
|---|---|---|---|
| `wyy` | 网易云音乐 | 音源一 | `qt-uniappx/services/music-api.ts` |
| `qq` | QQ音乐 | 音源二 | `qt-uniappx/services/music-api.ts` |
| `kw` | 酷我音乐 | 音源三 | `qt-uniappx/services/music-api.ts` |
| `kg` | 酷狗音乐 | 音源四 | `qt-uniappx/services/music-api.ts` |

WebDAV、自建音乐服务、咪咕等不进入第一版实现，只保留 Provider 架构扩展位。

## 6.2 音源切换入口

音源切换器位于标题栏中间区域，显示当前音源名称和图标。

支持三种模式：

1. 当前音源模式
2. 全部音源聚合模式
3. 音源设置入口

切换规则：

1. 切换后当前播放不中断。
2. 首页、搜索、歌单广场、排行榜、新歌、MV 数据按新音源刷新。
3. 聚合模式用于 `allCharts`、`allLatest`、`allHotWords`、`allSearch`。
4. 单个音源请求失败时，聚合结果继续返回其他音源数据。
5. 音源状态在 UI 中显示为可用、请求中、失败。
6. 音源状态与 Astral 账号登录状态分离。

## 6.3 Provider 抽象

前端不直接请求音源接口。所有音源请求都由 Rust Provider 统一处理，原因：

1. Rust 可以设置 User-Agent、Referer、Cookie 等请求头。
2. Rust 可以实现酷我编码、酷狗签名等现有移动端兼容逻辑。
3. Rust 可以绕开 WebView CORS 限制。
4. Rust 可以统一缓存、重试、超时和播放地址失效策略。
5. Rust 可以将不同音源的响应归一为统一模型。

```ts
export type SourceId = 'wyy' | 'qq' | 'kw' | 'kg'

export interface MusicSourceProvider {
  id: SourceId
  name: string
  displayName: string
  status: 'available' | 'loading' | 'error'
  capabilities: ProviderCapabilities
}

export interface ProviderCapabilities {
  playlistCategories: boolean
  recommendations: boolean
  latest: boolean
  charts: boolean
  chartDetail: boolean
  playlistDetail: boolean
  searchSong: boolean
  searchPlaylist: boolean
  searchArtist: boolean
  searchAlbum: boolean
  artistSongs: boolean
  mvList: boolean
  mvUrl: boolean
  lyric: boolean
  lyricTranslation: boolean
  playUrl: boolean
  cover: boolean
}
```

## 6.4 Rust Provider Trait

**原文问题**：`trait` 里直接写 `async fn` 在 Rust 中不是对象安全的，无法 `Box<dyn MusicProvider>` 或放进 `HashMap<SourceId, Arc<dyn MusicProvider>>` 做运行时分发；同时所有方法返回裸 `Vec<T>` / `Option<T>`，会把 §6.10 要求的错误分类（网络失败 / 超时 / 格式异常 / 无结果）全部压成空值，前端无法区分「没搜到」和「音源挂了」。

修正后签名：

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceId { Wyy, Qq, Kw, Kg, Local }

#[derive(Debug, thiserror::Error, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProviderError {
    #[error("网络请求失败")]        Network { message: String },
    #[error("请求超时")]            Timeout { after_ms: u64 },
    #[error("响应格式异常")]        Decode  { message: String },
    #[error("音源限流或风控")]      RateLimited,
    #[error("该能力不支持")]        Unsupported,
    #[error("无可用播放地址")]      NoPlayableUrl,
    #[error("无结果")]              Empty,
}

pub type ProviderResult<T> = Result<T, ProviderError>;

#[async_trait::async_trait]
pub trait MusicProvider: Send + Sync {
    fn id(&self) -> SourceId;
    fn name(&self) -> &'static str;
    fn capabilities(&self) -> ProviderCapabilities;

    async fn playlist_categories(&self) -> ProviderResult<Vec<PlaylistCategory>>;
    async fn recommendations(&self, category: Option<&str>, page: u32) -> ProviderResult<Vec<Playlist>>;
    async fn latest(&self, limit: u32, offset: u32) -> ProviderResult<Vec<Track>>;
    async fn charts(&self) -> ProviderResult<Vec<Chart>>;
    async fn chart_detail(&self, chart: &Chart, page: u32, size: u32) -> ProviderResult<Vec<Track>>;
    async fn playlist(&self, id: &str, page: u32, size: u32) -> ProviderResult<Playlist>;
    async fn hot_words(&self) -> ProviderResult<Vec<String>>;

    async fn search_tracks(&self, kw: &str, page: u32, size: u32) -> ProviderResult<Vec<Track>>;
    async fn search_playlists(&self, kw: &str, page: u32, size: u32) -> ProviderResult<Vec<Playlist>>;
    async fn search_artists(&self, kw: &str, page: u32, size: u32) -> ProviderResult<Vec<Artist>>;
    async fn search_albums(&self, kw: &str, page: u32, size: u32) -> ProviderResult<Vec<Album>>;
    async fn artist_songs(&self, name: &str, page: u32, size: u32) -> ProviderResult<Vec<Track>>;

    async fn videos(&self, page: u32, size: u32) -> ProviderResult<Vec<Video>>;
    async fn video_url(&self, id: &str, quality: &str) -> ProviderResult<String>;

    async fn lyric(&self, track: &Track) -> ProviderResult<Lyric>;
    async fn play_url(&self, track: &Track, quality: Quality) -> ProviderResult<PlayUrl>;
    async fn cover(&self, track: &Track) -> ProviderResult<String>;
}
```

要点：

1. `#[async_trait]` 保证 `Arc<dyn MusicProvider>` 可注册到 `ProviderRegistry`，聚合调用用 `futures::future::join_all` 并发执行。
2. `chart_detail` / `playlist` 补上分页参数：移动端这两个能力在酷我、酷狗上本来就是分页拉取，原签名无法表达。
3. `ProviderStatus` 从 trait 中移除——状态是「最近一次调用的结果」，属于运行期数据，由 `ProviderRegistry` 维护并通过 `provider-status-changed` 广播，Provider 自身无状态。
4. `capabilities()` 返回常量，用于前端灰置不支持的入口（例如只有 `wyy` 有歌词翻译）。
5. 聚合调用的失败策略：单源 `Err` 只记录并广播状态，不影响其他源结果；全部失败才向前端返回错误。

## 6.5 现有 MusicApi 方法映射

| 现有 `MusicApi` 方法 | Rust Provider 方法 | 前端 IPC |
|---|---|---|
| `playlistCategories(source)` | `playlist_categories` | `get_playlist_categories` |
| `recommendations(source, category, page)` | `recommendations` | `get_recommendations` |
| `latest(source, limit, offset)` | `latest` | `get_latest_songs` |
| `allLatest(limit, offset)` | 聚合调用四个 Provider | `get_all_latest_songs` |
| `charts(source)` | `charts` | `get_charts` |
| `allCharts()` | 聚合调用四个 Provider | `get_all_charts` |
| `chartDetail(chart)` | `chart_detail` | `get_chart_detail` |
| `playlist(id, source)` | `playlist` | `get_playlist_detail` |
| `hotWords(source)` | `hot_words` | `get_hot_words` |
| `allHotWords()` | 聚合调用四个 Provider | `get_all_hot_words` |
| `search(keyword, source, type, page, size)` | 按类型调用搜索方法 | `search_music` |
| `allSearch(keyword, page, size)` | 聚合调用四个 Provider | `search_all_music_sources` |
| `searchPlaylists(...)` | `search_playlists` | `search_playlists` |
| `searchArtists(...)` | `search_artists` | `search_artists` |
| `artistSongs(...)` | `artist_songs` | `get_artist_songs` |
| `searchAlbums(...)` | `search_albums` | `search_albums` |
| `videos(page, size, source)` | `videos` | `get_videos` |
| `videoUrl(id, source, quality)` | `video_url` | `get_video_url` |
| `lyrics(song)` | `lyric` | `get_lyric` |
| `lyricTranslation(song)` | `lyric_translation` | `get_lyric_translation` |
| `playUrl(song, quality)` | `play_url` | `get_play_url` |
| `songCover(song)` | `cover` | `get_track_cover` |
| `invalidatePlayUrl(song, quality)` | `invalidate_play_url` | `invalidate_play_url` |

## 6.6 统一数据模型

### Track

```ts
export interface Track {
  id: string
  platform: SourceId
  title: string
  singer: string
  album: string
  picUrl: string
  url?: string
  urlFetchedAt?: number
  duration?: number
  musicId?: string
  likeSeq?: number
}
```

> `platform` 字段名必须与 Astral 收藏接口和移动端现有模型保持一致，UI 层可以显示为“音源”。

### Playlist

```ts
export interface Playlist {
  id: string
  platform: SourceId
  name: string
  picUrl: string
  playCount: string
  description?: string | null
  tracks?: Track[]
  likeSeq?: number
}
```

### Artist

```ts
export interface Artist {
  id: string
  platform: SourceId
  name: string
  picUrl: string
}
```

### Album

```ts
export interface Album {
  id: string
  platform: SourceId
  name: string
  artist: string
  picUrl: string
  publishTime?: number
}
```

### Chart

```ts
export interface Chart {
  id: string
  platform: SourceId
  name: string
  picUrl: string
  description?: string
}
```

### Video

```ts
export interface Video {
  id: string
  platform: SourceId
  name: string
  picUrl: string
  singer: string
}
```

## 6.7 播放地址与音质

沿用移动端行为：

1. 支持音质 `128`、`320`、`flac`。
2. 远程播放地址缓存 10 分钟。
3. `PlayUrl` 必须携带 `fetchedAt`。
4. 播放失败时作废缓存并重新获取。
5. 重取失败后提示“该歌曲暂时无法播放”。
6. 本地下载文件不应用 10 分钟失效规则。

```ts
export interface PlayUrl {
  url: string
  quality: '128' | '320' | 'flac'
  fetchedAt: number
  expiresAt: number
}
```

## 6.8 同歌换源与跨音源替代

当前移动端播放页已有换源逻辑，PC 需要保留并增强。

流程：

```text
当前歌曲播放失败 / 用户手动换源
   │
   ▼
使用 歌曲名 + 歌手 在目标音源搜索
   │
   ▼
返回候选列表
   │
   ├── 自动模式：取第一个可播放结果
   └── 手动模式：用户选择结果
   │
   ▼
替换 Track 的 id / platform / musicId / 封面 / 元数据
   │
   ▼
保持当前播放进度
   │
   ▼
获取新播放地址并继续播放
```

音质切换失败时的降级策略：

1. 先在当前音源重新获取目标音质。
2. 当前音源失败后，按 `wyy → qq → kw → kg` 顺序搜索替代版本。
3. 找到替代版本后获取目标音质播放地址。
4. 全部失败时提示“未找到可替代的歌曲”。

## 6.9 Astral 账号与音源的关系

Astral 账号不等同于音源账号。

| 类型 | 用途 | 当前状态 |
|---|---|---|
| Astral 轻听账号 | 收藏同步、反馈、签到、消息中心、头像资料 | 已有 `/api/v1/app/user/**` |
| 四大音源账号 | 登录网易云、QQ、酷我、酷狗 | 当前移动端未实现，PC 第一版也不实现 |

因此 PC 第一版：

1. 不提供音源平台登录。
2. 不保存音源平台 Cookie。
3. 不访问音源会员接口。
4. 只使用当前移动端已有的匿名公开接口能力。
5. Astral 登录只影响收藏同步、反馈、消息等服务能力。

## 6.10 播放可用性设计

当前音源接口没有统一的结构化错误码，PC 需要在 Provider 层归一：

| 状态 | 判定 |
|---|---|
| 可播放 | `play_url` 返回非空地址 |
| 暂不可播放 | 请求失败或返回空地址 |
| 音质不可用 | 指定音质取址失败 |
| 音源异常 | 网络失败、超时、响应格式异常 |
| 未找到替代 | 跨音源搜索无结果 |

处理策略：

1. 不可播放歌曲不进入播放状态。
2. 点击后显示“该歌曲暂时无法播放”。
3. 提供手动换源入口。
4. 可开启自动换源尝试。
5. 播放队列中的失效歌曲保留原位置并标记状态。

## 6.11 合规边界

1. 第一版沿用 `qt-uniappx` 当前公开音源接口，定位为个人学习交流。
2. 不绕过 DRM、会员限制、验证码或风控。
3. 不提供版权规避和破解功能。
4. 不将当前公开接口能力用于商业发行。
5. 后续商业发行前，应将 Provider 替换为官方或授权接口。

## 6.12 在线音频流式播放与本地缓冲（原文缺失的关键链路）

原文只写到「音频引擎解码」，但没有说明**网络音频如何喂给解码器**。这是整条播放链路最容易出问题的一环，必须定稿：symphonia 的解码器需要一个 `Read + Seek` 的输入，而 HTTP 响应体只有 `Read`，直接把响应流交给解码器会导致无法 seek、无法读取 FLAC 尾部元数据。

### 设计：HttpRangeReader（边下边播 + 磁盘缓冲）

```text
play_url
   │
   ▼
HEAD / 首个 Range 请求（bytes=0-）
   │  读取 Content-Length、Accept-Ranges、Content-Type
   ▼
在 cache/audio/ 下创建稀疏缓冲文件 <sha1(url)>.part
   │
   ├── 后台下载线程：顺序写入缓冲文件，更新「已就绪区间」位图
   └── HttpRangeReader（实现 Read + Seek）：
         read()  → 若目标区间已就绪则本地读；否则阻塞等待（带超时）
         seek()  → 落在未就绪区间且服务端支持 Range → 发起新 Range 请求并重定位下载点
   │
   ▼
rodio::Decoder::new(BufReader::new(HttpRangeReader))
   │
   ▼
Sink.append(source)
```

关键规则：

| 场景 | 处理 |
|---|---|
| 服务端 `Accept-Ranges: none` 或返回 200 而非 206 | 退化为「先下完再播」，播放前显示缓冲进度 |
| 首包超时（默认 8s） | 判定为不可播放，触发 `invalidate_play_url` + 重取一次 |
| 播放中断流 | 已缓冲部分继续播放，同时后台重试；连续失败 3 次广播 `audio-error` |
| 缓冲区大小 | 单曲上限 100MB（覆盖 FLAC），LRU 淘汰，总量上限在设置中可调（默认 2GB） |
| 与下载功能的关系 | 用户点「下载」时若缓冲文件已完整，直接 `rename` 到下载目录，不重复拉流 |
| 本地文件 | 直接 `File::open`，不进入该链路，也不参与 10 分钟失效判断 |
| 起播延迟目标 | 首包到达即起播，目标 < 800ms（不含取址耗时）；不等整曲下载完 |

事件补充：`audio-buffering { trackId, bufferedMs, downloadedBytes, totalBytes }`，前端用于进度条的二级缓冲条与「缓冲中」状态。

## 6.13 封面与 MV 资源访问（原文缺失）

音频走 Rust 没问题，但**图片和视频是 WebView 直接加载的**，这里存在原文未评估的两个硬约束：

1. 部分音源的封面 / MV CDN 校验 `Referer` 或 `User-Agent`，`<img src>` / `<video src>` 直连会 403。
2. 即使能直连，也等于把用户 IP 暴露给音源 CDN，并绕过了「网络请求统一走 Rust」的架构约定，CSP 也必须为此放开外部域名。

### 方案：自定义协议 `qtres://`

Rust 注册 `qtres` 协议（`tauri::Builder::register_asynchronous_uri_scheme_protocol`），前端一律使用 `qtres://cover/<base64url(原始URL)>` 与 `qtres://mv/<...>`：

| 能力 | 说明 |
|---|---|
| 请求头 | Rust 按音源补齐 `Referer` / `User-Agent`，与 Provider 复用同一套规则 |
| 封面缓存 | 命中 `cache/covers/<sha1>.<ext>`；未命中则拉取 + 落盘 + 生成 `@2x` 缩略图（列表用缩略图，播放页用原图） |
| MV / 视频 | **必须支持 Range 透传**，否则 `<video>` 无法拖动进度；把浏览器的 `Range` 头透传给上游，并原样回传 `206` + `Content-Range` |
| 失败兜底 | 返回内置占位图（1×1 透明或默认封面），不让 `<img>` 触发 onerror 抖动 |
| 白名单 | 只允许四大音源已知 CDN 域名 + Astral 域名，防止被歌词 / 皮肤等外部数据当作任意请求代理 |
| CSP | `img-src` / `media-src` 放开 `qtres:`，无需放开任何外部域名（见 §4.1） |

> 备选方案是在 `127.0.0.1` 上起临时 HTTP 代理，但会占用端口、需处理防火墙提示，且暴露给本机其他进程，**不推荐**。

---

## 7. 音频核心设计

## 7.1 模块划分

```text
audio/
 ├─ engine.rs        # 播放引擎
 ├─ queue.rs         # 播放队列
 ├─ output.rs        # 输出设备
 ├─ decoder.rs       # 解码封装
 ├─ gapless.rs       # 无缝播放
 ├─ crossfade.rs     # 淡入淡出
 ├─ equalizer.rs     # 均衡器
 ├─ spectrum.rs      # 频谱
 └─ media_control.rs # 系统媒体控制
```

## 7.2 播放状态

```rust
#[derive(serde::Serialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackStatus { Stopped, Loading, Buffering, Playing, Paused, Error }

#[derive(serde::Serialize, serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum PlayMode { Sequence, ListLoop, OneLoop, Random }

/// 序列化值直接对齐前端与移动端使用的 "128" / "320" / "flac"，
/// 避免出现两套音质命名（原文 Standard/High/Lossless 与 §6.7 的 '128'|'320'|'flac' 不一致）
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy)]
pub enum Quality {
    #[serde(rename = "128")]  Standard,
    #[serde(rename = "320")]  High,
    #[serde(rename = "flac")] Lossless,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackState {
    pub track_id: Option<String>,
    pub source_id: Option<SourceId>,
    pub status: PlaybackStatus,
    pub position_ms: u64,
    pub duration_ms: u64,
    /// 已缓冲毫秒数，在线曲目用于进度条二级缓冲条
    pub buffered_ms: u64,
    pub volume: f32,
    pub muted: bool,
    pub play_mode: PlayMode,
    pub quality: Quality,
    /// 当前曲目在队列中的下标，前端队列面板高亮依赖它（原文缺失）
    pub queue_index: Option<usize>,
    pub queue_len: usize,
    /// 是否本地文件（决定是否走 10 分钟失效与缓冲逻辑）
    pub is_local: bool,
    pub url_fetched_at: Option<u64>,
    /// 最近一次错误，供前端展示「该歌曲暂时无法播放」
    pub error: Option<String>,
    /// 睡眠定时剩余毫秒，None 表示未启用
    pub sleep_timer_ms: Option<u64>,
}
```

约定：

1. 所有跨 IPC 结构统一 `#[serde(rename_all = "camelCase")]`，前端 TS 类型与之一一对应，不做手工字段映射。
2. `Loading`（取址中）与 `Buffering`（已起播但等数据）必须区分：前者可取消，后者不可取消，UI 表现也不同。
3. `PlaybackState` 是**全量快照**，只在状态语义变化时推送；高频的进度更新走独立的轻量事件（§7.11）。

## 7.3 播放流程

```text
前端 play_track(trackId)
   │
   ▼
Rust 查询 Track
   │
   ├── local：直接读取本地文件
   └── online：检查播放地址缓存
   │
   ▼
缓存有效？
   ├── 是：继续播放
   └── 否：Provider 获取 play_url
   │
   ▼
获取失败？
   ├── 是：作废缓存 → 重新获取 → 仍失败则提示不可播放
   └── 否：继续
   │
   ▼
音频引擎解码
   │
   ▼
输出到当前设备
   │
   ▼
推送 playback-state / position-changed
   │
   ▼
React 更新播放条和播放页
```

远程播放地址缓存规则：

1. 缓存键：`platform + trackId + quality`。
2. 有效期：10 分钟。
3. 缓存命中时必须使用缓存条目自身的 `fetchedAt`，不能刷新为当前时间。
4. 播放失败时调用 `invalidate_play_url`。
5. 本地文件不判断过期。
## 7.4 引擎线程模型（原文缺失，实现前必须定稿）

`cpal::Stream`（rodio 的 `OutputStream`）**不是 `Send`**，不能直接放进 Tauri 的 `State` 里跨线程共享。必须用「专属音频线程 + 命令通道」结构，否则编译期就会卡住。

```text
Tauri 命令 (任意线程)
   │  mpsc::Sender<AudioCmd>
   ▼
音频控制线程（独占 OutputStream + Sink，单线程内串行处理命令）
   │
   ├─ 下载/解码线程（每曲一个，产出 HttpRangeReader）
   ├─ 采样旁路 → ringbuf → 频谱线程（FFT）
   └─ Arc<RwLock<PlaybackState>> ← 供 get_playback_state 同步读取
         │
         └─ 变化时 app.emit("playback-state-changed", snapshot)
```

```rust
enum AudioCmd {
    Load { track: Track, url: PlaySource, start_at: Option<u64>, autoplay: bool },
    Play, Pause, Stop,
    Seek(u64),
    SetVolume(f32), SetMuted(bool),
    SetPlayMode(PlayMode),
    Preload(Track),                 // 无缝播放预解码
    SetOutputDevice(Option<String>),
    SetEq(Option<EqSettings>),
    SetCrossfade { enabled: bool, ms: u32 },
    SetSleepTimer(Option<u64>),
    Shutdown,
}
```

## 7.5 无缝播放（gapless）

实现路径：

1. 当前曲目剩余时长 < 15s 时，向队列下一首发 `Preload`，在后台完成取址 + 首包缓冲 + 构建 `Decoder`。
2. 预解码结果暂存为 `Option<Box<dyn Source>>`；当前曲目自然结束前，直接 `sink.append(next)` 到**同一个 Sink**，由 rodio 连续消费，不重建输出流——这是达到 <20ms 间隙的唯一可行路径。
3. 队列变更（切歌、清空、改播放模式）时丢弃预解码结果并重新计算目标。
4. 「随机播放」模式下预取需要先固定下一首（预生成随机序列），否则无法预加载。
5. 无缝仅在**同采样率**曲目间生效；采样率不同必须重建输出流，此时退化为普通切歌并在设置中说明。
6. 单曲循环模式下不做预加载，直接 `seek(0)`。

## 7.6 淡入淡出（crossfade）

| 场景 | 行为 |
|---|---|
| 播放开始 | 音量从 0 线性渐变到目标音量 |
| 暂停 | 渐变到 0 后暂停（避免爆音） |
| 切歌（用户主动） | 旧曲淡出、新曲淡入 |
| 切歌（自然结束） | 由 §7.5 无缝接续，**不做**淡入淡出 |
| 拖动进度 | 不做，保持即时响应 |
| 停止 / 退出 | 淡出后停止 |

实现要点：淡入淡出与无缝互斥，同时开启时**淡入淡出优先**并自动禁用无缝（两者都要控制同一段尾部音频，不能叠加）。真正的交叉淡化需要两个 Sink 同时出声，因此实现上维护 `sink_a` / `sink_b` 双 Sink 轮换，各自 `set_volume()` 做斜坡。默认时长 300ms，可配 0–3000ms。

## 7.7 频谱采样链路

rodio **没有**输出采样的旁路接口，「从音频输出流获取采样数据」需要自己造：

```rust
/// 透明包装：转发所有采样，同时复制一份写入无锁环形缓冲
struct TapSource<S: Source<Item = f32>> { inner: S, tx: ringbuf::Producer<f32> }
```

链路：`Decoder → EqSource → TapSource → Sink`。

| 环节 | 设计 |
|---|---|
| 缓冲 | `ringbuf` 容量 8192 采样；写满即丢弃最旧数据，**绝不阻塞音频线程** |
| FFT | 独立线程，2048 点 Hann 窗，`rustfft` 实数变换 |
| 频段 | 输出 32 / 64 段（可配），按对数频率分箱（20Hz–16kHz） |
| 幅度 | 转 dB 后归一化到 0–1，做峰值保持 + 指数衰减（衰减系数可配） |
| 推送 | 默认 30 FPS；窗口不可见 / 播放页未打开 / 用户关闭时**完全停止 FFT 线程**（不是只停推送） |
| 事件 | `spectrum-data: Vec<f32>`，用 `f32` 数组而非对象，减少序列化开销 |

前端只做 Canvas 绘制与颜色映射，不做任何 DSP。

## 7.8 均衡器

rodio 无内置 EQ，实现为 `EqSource`：10 段 `biquad` peaking filter 串联（31 / 62 / 125 / 250 / 500 / 1k / 2k / 4k / 8k / 16k Hz），增益范围 ±12dB，另设总 preamp。

| 事项 | 设计 |
|---|---|
| 系数更新 | 参数变更时重算系数并热替换，不重建播放链，避免切歌 |
| 削波保护 | 总增益为正时自动衰减 preamp，或接软限幅器，防止 FLAC 上溢出爆音 |
| 预设 | 流行 / 摇滚 / 古典 / 人声 / 低音增强 / 自定义，存 `settings` 表 |
| 音量归一化 | 优先读文件内 ReplayGain / `R128_TRACK_GAIN` 标签（lofty 可读）；无标签则不做实时分析（实时 LUFS 计算成本过高，v1 不做） |

## 7.9 输出设备切换

cpal 无法在既有流上换设备，必须重建：

```text
记录当前 position / status
   │
   ▼
停止旧 Sink → drop 旧 OutputStream
   │
   ▼
按 device_id 建新 OutputStream + Sink（失败则回落默认设备并提示）
   │
   ▼
重建解码器 → seek 到记录位置 → 恢复原 status
```

补充：监听默认设备变化（耳机插拔）。设备消失时自动回落默认设备并保持播放；找不到任何输出设备时进入 `Error` 状态，不崩溃（对应 REQUIREMENTS §4.3）。

## 7.10 播放地址缓存（修正：不落库）

缓存实现为 `Arc<RwLock<HashMap<PlayUrlKey, PlayUrl>>>`，**进程内存**，进程退出即失效。

```rust
struct PlayUrlKey { platform: SourceId, track_id: String, quality: Quality }
```

1. 键：`platform + track_id + quality`（与原文一致）。
2. 有效期 10 分钟，命中时使用条目自身的 `fetched_at`，不刷新。
3. 播放失败即 `invalidate` 并重取一次。
4. **不写入 SQLite**：播放地址是短时凭据，落库既无收益（重启必然过期）又扩大泄露面。这与移动端 `types/music.ts` 中 `urlFetchedAt` 的注释（不持久化）保持一致。
5. 本地文件路径不进该缓存，直接从 `tracks.local_path` 读。

## 7.11 时间轴精度（如何达成 50ms 同步误差）

| 层 | 频率 | 说明 |
|---|---|---|
| Rust `sink.get_pos()` | 250ms | 发 `position-changed { positionMs, monotonicMs }`，`monotonicMs` 为发送时刻单调时钟 |
| 前端插值 | `requestAnimationFrame` | `pos = lastPos + (performance.now() - lastRecvAt)`，播放中才插值 |
| 校正 | 每次收到 tick | 若插值值与真实值偏差 > 120ms 则硬跳，否则在 200ms 内平滑收敛，避免歌词抖动 |
| seek / 切歌 | 立即 | 立即发一次 tick，取消插值 |

误差来源与预算：音频输出缓冲延迟（约 20–40ms，可用固定偏移补偿）+ 事件传递（<5ms）+ 插值误差（<16ms），合计可控在 50ms 内。**桌面歌词窗口必须自行插值**，不能依赖主窗口转发（见 §10.2）。

---

## 8. 数据存储设计

## 8.1 数据目录

```text
%APPDATA%/LightListen/
 ├─ data/
 │   └─ music.db
 ├─ cache/
 │   ├─ covers/
 │   ├─ lyrics/
 │   └─ waveform/
 ├─ themes/
 │   ├─ default-light.ltskin.json
 │   └─ default-dark.ltskin.json
 ├─ logs/
 │   └─ app.log
 ├─ settings/
 │   └─ window-state.json
 └─ backups/
     └─ music-2026-09-05.db
```

## 8.2 数据分层

| 层 | 保存内容 | 生命周期 |
|---|---|---|
| SQLite | 歌单、收藏、历史、扫描结果、设置 | 永久 |
| Cache | 封面、歌词缓存、波形 | 可删除可重建 |
| Memory | 播放状态、UI 状态 | 进程内 |
| Logs | 运行日志、错误日志 | 保留最近 30 天 |

## 8.3 SQLite 表设计

### tracks

在线歌曲与本地歌曲统一入库。`id` 使用 `platform:原始id` 生成，保证跨音源唯一。

**修正（R1）**：原设计包含 `url` 与 `url_fetched_at` 两列。播放地址是 10 分钟即失效的短时凭据，落库后重启必然过期，只会带来「读到脏地址 → 播放失败 → 再取址」的额外分支，且扩大了泄露面。改为**只放进程内缓存**（§7.10），表中去掉这两列。

```sql
CREATE TABLE tracks (
  id            TEXT PRIMARY KEY,          -- platform:原始id，如 wyy:1234567
  platform      TEXT NOT NULL,             -- wyy / qq / kw / kg / local
  title         TEXT NOT NULL,
  singer        TEXT NOT NULL,
  album         TEXT NOT NULL,
  pic_url       TEXT,
  duration_ms   INTEGER,
  music_id      TEXT,                      -- 音源侧二级 ID（kw 的 musicrid、kg 的 hash 等）
  -- 本地文件属性（在线曲目为 NULL）
  local_path    TEXT,
  file_size     INTEGER,
  format        TEXT,
  sample_rate   INTEGER,
  bit_rate      INTEGER,
  mtime         INTEGER,                    -- 增量扫描依据（§13.2 要求，原文表中缺失）
  content_hash  TEXT,                       -- 可选，用于重命名/移动识别
  -- 排序与检索
  title_pinyin  TEXT,                       -- 全拼，用于拼音搜索与排序（§8.6）
  title_initial TEXT,                       -- 首字母缩写，如「qingting」→「qt」
  missing       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX idx_tracks_platform ON tracks(platform);
CREATE INDEX idx_tracks_singer   ON tracks(singer);
CREATE INDEX idx_tracks_album    ON tracks(album);
CREATE INDEX idx_tracks_missing  ON tracks(missing);
CREATE UNIQUE INDEX uk_tracks_local_path ON tracks(local_path) WHERE local_path IS NOT NULL;
```

`platform` 保存 `wyy / qq / kw / kg` 或 `local`，与 Astral 收藏接口的 `platform` 字段直接兼容。

**入库时机**：在线曲目只在「进入队列 / 被收藏 / 被加入歌单 / 产生播放历史」时落库，搜索结果与榜单列表**不入库**，否则 `tracks` 会被浏览行为迅速膨胀到几十万行。

### playlists

```sql
CREATE TABLE playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  cover_path TEXT,
  is_smart INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  is_favorite INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### playlist_tracks

```sql
CREATE TABLE playlist_tracks (
  playlist_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, track_id),
  FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

CREATE INDEX idx_playlist_tracks_position
ON playlist_tracks(playlist_id, position);
```

### liked_songs

与 Astral `qt_like_song` 对齐，用于收藏增量同步。

```sql
CREATE TABLE liked_songs (
  id TEXT PRIMARY KEY,
  uid INTEGER NOT NULL,
  sid TEXT NOT NULL,
  platform TEXT NOT NULL,
  name TEXT NOT NULL,
  singer TEXT NOT NULL,
  album TEXT NOT NULL,
  hash TEXT,
  deleted_at INTEGER,
  updated_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(uid, platform, sid)
);

CREATE INDEX idx_liked_songs_uid_seq ON liked_songs(uid, updated_seq);
```

### liked_playlists

与 Astral `qt_like_playlist` 对齐。

```sql
CREATE TABLE liked_playlists (
  id TEXT PRIMARY KEY,
  uid INTEGER NOT NULL,
  pid TEXT NOT NULL,
  platform TEXT NOT NULL,
  name TEXT NOT NULL,
  pic_url TEXT,
  is_import INTEGER DEFAULT 0,
  deleted_at INTEGER,
  updated_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(uid, platform, pid)
);

CREATE INDEX idx_liked_playlists_uid_seq ON liked_playlists(uid, updated_seq);
```
### play_history

```sql
CREATE TABLE play_history (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL,
  played_at INTEGER NOT NULL,
  played_duration_ms INTEGER NOT NULL,
  completed INTEGER DEFAULT 0,
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

CREATE INDEX idx_play_history_time ON play_history(played_at DESC);
```

### play_stats

```sql
CREATE TABLE play_stats (
  track_id TEXT PRIMARY KEY,
  play_count INTEGER NOT NULL DEFAULT 0,
  last_played_at INTEGER NOT NULL,
  total_played_ms INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

CREATE INDEX idx_play_stats_count ON play_stats(play_count DESC);
```
### download_tasks

```sql
CREATE TABLE download_tasks (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  quality TEXT NOT NULL,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  file_path TEXT,
  file_size INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

CREATE INDEX idx_download_tasks_status ON download_tasks(status);
```
### scan_dirs

```sql
CREATE TABLE scan_dirs (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  enabled INTEGER DEFAULT 1,
  last_scan_at INTEGER,
  created_at INTEGER NOT NULL
);
```

### providers

```sql
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  config TEXT,
  status TEXT DEFAULT 'disconnected',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### pending_like_ops

```sql
CREATE TABLE pending_like_ops (
  id TEXT PRIMARY KEY,
  uid INTEGER NOT NULL,
  type TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_pending_like_ops_retry ON pending_like_ops(uid, next_retry_at);
```
### like_sync_state

```sql
CREATE TABLE like_sync_state (
  uid INTEGER PRIMARY KEY,
  cursor INTEGER NOT NULL DEFAULT 0,
  last_sync_at INTEGER,
  last_error TEXT
);
```
### themes

```sql
CREATE TABLE themes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT,
  is_active INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### settings

```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### schema_migrations

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
```

### 补充表（原文缺失，但被 IPC / 需求直接依赖）

```sql
-- 歌词缓存：在线歌词不能每次切歌都重新请求（IPC load_lyric / §10.3 依赖）
CREATE TABLE lyrics (
  track_id     TEXT PRIMARY KEY,
  lrc          TEXT,                       -- 逐行 LRC
  word_lrc     TEXT,                       -- 逐字（yrc/qrc/krc 归一后的 JSON），无则 NULL
  translation  TEXT,
  romaji       TEXT,
  source       TEXT NOT NULL,              -- provider / embedded / file / manual
  fetched_at   INTEGER NOT NULL,
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

-- 歌词偏移（IPC set_lyric_offset / get_lyric_setting 依赖）
CREATE TABLE lyric_settings (
  track_id   TEXT PRIMARY KEY,
  offset_ms  INTEGER NOT NULL DEFAULT 0,
  lyric_path TEXT,                          -- 用户手动关联的歌词文件
  updated_at INTEGER NOT NULL
);

-- 播放队列持久化（需求「记忆上次播放状态 / 恢复播放现场」依赖）
CREATE TABLE play_queue (
  position   INTEGER PRIMARY KEY,
  track_id   TEXT NOT NULL,
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

-- 搜索历史（需求 §3.7 依赖）
CREATE TABLE search_history (
  keyword     TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,                -- current / all / local
  searched_at INTEGER NOT NULL
);

-- 统计上报失败队列（需求 §3.19「上报失败进入本地队列重试」依赖）
CREATE TABLE stat_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  payload    TEXT NOT NULL,                 -- StatEventDTO 的 JSON
  retry      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
```

> `play_queue` 用 `position` 做主键便于整表替换；恢复现场所需的 `queue_index / position_ms / quality / play_mode / volume` 存入 `settings`。

## 8.4 数据迁移策略

1. SQLite 使用版本号迁移。
2. 应用启动时检查 `schema_migrations`。
3. 新版本迁移前自动备份数据库。
4. 迁移失败则回滚并提示用户。
5. 不允许直接删除旧字段，旧字段保留至少一个版本。

---

## 8.5 收藏同步设计

### 同步模型

沿用 Astral 现有收藏同步协议：

1. 每次收藏或取消收藏返回 `seq`。
2. `seq` 是用户维度递增游标。
3. 客户端保存本地 `cursor`。
4. 常规同步调用 `GET /app/user/like/changes?since=cursor`。
5. 首次登录或游标丢失时调用 `GET /app/user/like/list?page=&size=` 全量分页拉取。

### 启动同步流程

```text
应用启动
   │
   ▼
检查 Astral 登录状态
   ├── 未登录：只使用本地收藏
   └── 已登录：继续
   │
   ▼
读取本地 like cursor
   ├── 无游标：全量分页拉取
   └── 有游标：增量拉取
   │
   ▼
应用服务端变更
   │
   ▼
更新本地 cursor = maxSeq
```

### 本地收藏流程

```text
用户点击收藏 / 取消收藏
   │
   ▼
立即更新本地 UI 和 SQLite
   │
   ▼
写入 pending operation 队列
   │
   ▼
调用 Astral 单条接口
   ├── 成功：更新 likeSeq，移除 pending
   └── 失败：保留 pending，稍后重试
```

### 冲突处理

1. 以 `platform + id` 作为业务唯一键。
2. 本地记录与服务端变更都携带 `updatedSeq`。
3. 只应用 `updatedSeq` 大于本地记录的变更。
4. 相同 `updatedSeq` 时以服务端为准。
5. 删除使用软删除，不物理删除本地记录。
6. 待同步操作与远端变更冲突时，以时间较新的操作为准。

### 重试策略

1. 网络失败后保留待同步队列。
2. 使用指数退避重试。
3. 应用回到前台时触发一次同步。
4. 网络恢复事件触发一次同步。
5. 连续失败超过阈值后降低同步频率。
6. 用户手动刷新收藏时立即重试。

---

## 8.6 本地检索索引（原文缺失）

需求要求「10 万首规模、搜索 1 秒内返回本地结果」，仅靠 `LIKE '%kw%'` 无法达成（全表扫描且无法用索引）。设计如下：

```sql
CREATE VIRTUAL TABLE tracks_fts USING fts5(
  title, singer, album, pinyin, initial,
  content = 'tracks',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);
```

| 事项 | 设计 |
|---|---|
| 同步 | `tracks` 上建 INSERT / UPDATE / DELETE 触发器同步 FTS 表；批量扫描时先 `DROP` 触发器、导入完再重建并 `rebuild`，避免逐行开销 |
| 中文分词 | FTS5 的 `unicode61` 不做中文分词，因此中文靠 **前缀匹配 + 拼音列** 兜底：查询串同时按原文、全拼、首字母三路匹配后合并去重 |
| 拼音生成 | 入库时由 Rust `pinyin` crate 生成 `title_pinyin` / `title_initial`，多音字取常用读音，不追求 100% 准确 |
| 排序 | 命中优先级：标题精确 > 标题前缀 > 歌手 > 专辑 > 拼音 > 首字母；同级按 `bm25()` |
| 编译前置 | rusqlite 需确认启用 FTS5（`bundled-full`，或 `bundled` + `SQLITE_ENABLE_FTS5`）；缺失时降级为 `LIKE` 并在日志告警 |

## 8.7 外键与清理安全边界（原文风险点）

原文多张表使用 `FOREIGN KEY ... ON DELETE CASCADE` 指向 `tracks`。配合「清理失效文件」功能会造成**静默数据丢失**：删掉一行 `tracks`，会连带删除该曲目的歌单条目、播放历史、播放统计、下载记录。

约束：

1. `remove_missing_tracks` **只允许**把 `missing` 置 1，或删除「未被任何歌单 / 历史 / 下载引用」的行；被引用的行永不物理删除。
2. `PRAGMA foreign_keys = ON` 必须显式开启（SQLite 默认关闭），否则上述 CASCADE 根本不生效，会留下悬挂引用——这是比误删更隐蔽的问题。
3. `playlist_tracks` 删除歌单时 CASCADE 是期望行为；删除曲目时应改为 `ON DELETE RESTRICT`，由业务层显式处理。
4. 所有破坏性操作（清理失效、清空历史、重置数据、恢复数据库）执行前先落一份备份到 `backups/`，并在 UI 二次确认。
5. `restore_database` 必须校验目标文件是合法 SQLite 且 `schema_migrations.version` ≤ 当前程序支持版本，否则拒绝恢复。

## 8.8 配置项的唯一归属（原文存在双写风险）

原文同时存在 `settings` 表、`settings/window-state.json`、`themes` 表、`providers` 表，职责有重叠。定稿：

| 数据 | 唯一存放位置 |
|---|---|
| 用户偏好（音质、播放模式、音量、快捷键、EQ、下载目录、统计开关等） | `settings` 表 |
| 窗口位置 / 尺寸 / 最大化 | `tauri-plugin-window-state` 自有存储 |
| 桌面歌词窗口位置与样式 | `settings` 表（键 `lyric.window`），**不与主窗口混存** |
| 当前皮肤 ID + 外观模式 | `settings` 表；皮肤内容存 `themes/*.ltskin.json` 文件，`themes` 表只做索引 |
| 音源启用状态 | `settings` 表；`providers` 表在第一版**不建**（四大音源硬编码注册，无用户配置），留到 WebDAV 阶段再加 |
| Astral satoken / refreshToken | Windows 凭据管理器（§17.1），不入库 |

## 9. 主题与皮肤设计

## 9.1 主题系统架构

```text
主题 JSON 文件
   │
   ▼
Rust 读取并校验
   │
   ▼
前端 ThemeStore
   │
   ▼
转换为 CSS Variables
   │
   ▼
Tailwind + shadcn/ui 响应渲染
```

## 9.2 主题配置结构（修正 R7：拆分「外观偏好」与「皮肤定义」）

**原文问题**：`ThemeConfig.mode: 'light' | 'dark' | 'system'` 把「用户偏好」写进了皮肤文件，同时 `colors` 只有一套。结果是：

- 用户导入一个 `mode: 'dark'` 的皮肤，会连带覆盖他的「跟随系统」设置；
- 皮肤只有一套色板，切到系统深色时没有对应颜色，只能整体反色或直接失效。

修正为两层：**外观偏好（用户级、不随皮肤走）** + **皮肤定义（含 light/dark 两套色板）**。

```ts
/** 用户级外观偏好，存 settings 表，不随皮肤导入导出 */
export interface AppearancePreference {
  mode: 'light' | 'dark' | 'system'
  skinId: string
  followCoverColor: boolean     // 是否启用封面取色
  reduceMotion: boolean         // 低性能设备关闭动画
  fontScale: number             // 0.9 ~ 1.3
}

/** 皮肤定义，即 .ltskin.json 文件内容 */
export interface Skin {
  schema: 1                     // 结构版本，用于兼容判断
  id: string                    // 唯一标识，导入冲突时按 id 覆盖或改名
  name: string
  author?: string
  version: string
  /** 两套色板必填；单色板皮肤可让 dark 直接复用 light，但必须显式写出 */
  tokens: { light: SkinTokens; dark: SkinTokens }
  radius: number                // px，映射到 --radius
  fontFamily?: string           // 仅允许本地已安装字体名或内置字体名
  playerBar: { height: number; blur: boolean; opacity: number }
  background?: SkinBackground   // 背景图（原文缺失，见 §9.6）
  lyric: LyricStyle             // 应用内歌词默认样式（桌面歌词样式独立，见 §10）
}

export interface SkinTokens {
  // —— shadcn/ui 标准令牌（必须原名，否则 shadcn 组件不跟随皮肤）——
  background: string; foreground: string
  card: string; cardForeground: string
  popover: string; popoverForeground: string
  primary: string; primaryForeground: string
  secondary: string; secondaryForeground: string
  muted: string; mutedForeground: string
  accent: string; accentForeground: string
  destructive: string; destructiveForeground: string
  border: string; input: string; ring: string
  // —— 轻听业务扩展令牌 ——
  sidebar: string; sidebarForeground: string
  playerBar: string
  lyricActive: string; lyricIdle: string
  spectrumFrom: string; spectrumTo: string
}

export interface SkinBackground {
  image?: string                // 相对皮肤目录的路径，或用户本地绝对路径
  blur: number                  // 0 ~ 40 px
  opacity: number               // 0 ~ 1
  fit: 'cover' | 'contain' | 'tile'
  tint?: string                 // 叠加色，保证前景文字对比度
}

export interface LyricStyle {
  fontSize: number
  fontWeight: number
  opacity: number
  shadow: boolean
  stroke: boolean
  gradient: [string, string]
}
```

### 默认主题基线

PC 默认皮肤延续移动端品牌色（取自 `qt-uniappx/uni.scss` 与 `theme.json`）：

| Token | 浅色 | 深色 |
|---|---|---|
| primary | `#e5484d` | `#ff5c63` |
| background | `#f6f7f9` | `#12151c` |
| card | `#ffffff` | `#161a23` |
| foreground | `#191d26` | `#e8ecf7` |
| mutedForeground | `#6b7385` | `#8a93a6` |
| border | `#edeff3` | `#252a35` |
| sidebar | `#ffffff` | `#161a23` |

> 颜色值内部统一转 **OKLCH** 存储与运算（Tailwind v4 与 shadcn 默认色彩空间），皮肤文件允许写 hex / rgb / oklch，导入时归一。OKLCH 下调明度和做透明叠加不会出现灰脏色，这是选它的原因。

## 9.3 CSS Variables（修正 R6：必须使用 shadcn 令牌名）

**原文问题**：变量命名为 `--app-background` / `--app-primary`。shadcn/ui 的组件源码写的是 `bg-background`、`text-foreground`、`bg-primary`，这些工具类在 Tailwind v4 下解析到 `--color-background` / `--color-primary`。用 `--app-*` 自定义名会导致**所有 shadcn 组件完全不跟随皮肤**，只有自研组件生效——这是会在集成阶段才暴露的返工点。

正确做法：变量用标准名，再用 `@theme inline` 把变量桥接成 Tailwind 的颜色令牌。

```css
/* src/index.css */
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

:root {
  --radius: 0.75rem;
  --background: oklch(0.976 0.002 264);
  --foreground: oklch(0.219 0.017 267);
  --card: oklch(1 0 0);
  --card-foreground: var(--foreground);
  --primary: oklch(0.606 0.196 19.4);        /* #e5484d */
  --primary-foreground: oklch(1 0 0);
  --muted: oklch(0.962 0.004 264);
  --muted-foreground: oklch(0.512 0.021 265);
  --border: oklch(0.945 0.004 264);
  --input: var(--border);
  --ring: var(--primary);
  /* 业务扩展 */
  --sidebar: oklch(1 0 0);
  --player-bar: oklch(1 0 0 / 0.96);
  --player-bar-height: 84px;
  --lyric-active: var(--primary);
  --lyric-idle: var(--muted-foreground);
}

.dark {
  --background: oklch(0.196 0.014 267);
  --foreground: oklch(0.925 0.011 265);
  --card: oklch(0.232 0.017 267);
  --primary: oklch(0.681 0.181 18.6);        /* #ff5c63 */
  --border: oklch(0.297 0.017 267);
  --sidebar: oklch(0.232 0.017 267);
  --player-bar: oklch(0.232 0.017 267 / 0.86);
}

/* 关键桥接：让 bg-background / text-primary 等工具类落到上面的变量 */
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-sidebar: var(--sidebar);
  --color-lyric-active: var(--lyric-active);
  --radius-lg: var(--radius);
}
```

### 皮肤应用流程

```text
用户选择皮肤 / 修改外观偏好
   │
   ▼
Rust 读取 .ltskin.json → 结构校验 + 颜色归一 → 返回 Skin
   │
   ▼
前端 ThemeStore：按 AppearancePreference.mode 选 tokens.light 或 tokens.dark
   │  （mode = system 时监听 matchMedia('(prefers-color-scheme: dark)')）
   ▼
写入 document.documentElement.style.setProperty('--xxx', value)
   │  + 切换 .dark class
   ▼
广播 theme-changed → 桌面歌词窗口同步应用（两个窗口共享同一套写入逻辑）
```

要点：

1. 皮肤切换**只改 CSS 变量**，不重挂载组件，因此无需重启也不闪屏；过渡动画对 `background-color` / `color` 加 150ms transition，且在 `reduceMotion` 下关闭。
2. 首帧前必须先写入变量（从 `settings` 同步读取，走 Rust 的启动快照），否则会出现浅色闪一下再变深色。
3. 桌面歌词窗口独立应用主题，禁止依赖主窗口 DOM。

### 封面取色的优先级（原文未定义）

封面取色与用户自定义皮肤会争夺同一批变量，必须定优先级：

| 层级 | 覆盖范围 |
|---|---|
| 1. 皮肤 tokens | 全量令牌，基础层 |
| 2. 封面取色（`followCoverColor = true` 时） | **只覆盖** `--primary`、`--lyric-active`、`--spectrum-*`、播放页背景色；不覆盖 `--background` / `--card` / `--border`，避免整体界面随每首歌跳色 |
| 3. 用户在皮肤编辑器中显式锁定的令牌 | 最高优先级，取色不覆盖 |

取色还必须保证对比度：生成的 `--primary` 与 `--primary-foreground` 的 APCA / WCAG 对比度不足时自动调整明度，直到达标（对应 REQUIREMENTS §3.8 验收第 5 条）。


## 9.4 封面取色流程

```text
当前歌曲切换
   │
   ▼
Rust 读取封面
   │
   ▼
提取主色 / 辅助色 / 暗色
   │
   ▼
发送 cover-color-changed 事件
   │
   ▼
React 更新 CSS Variables
   │
   ▼
背景 / 按钮 / 进度条 / 频谱联动变化
```

颜色提取规则：

1. 忽略过亮和过暗区域。
2. 优先选择饱和度适中的颜色。
3. 生成可读的前景色。
4. 深色模式自动加深背景。
5. 浅色模式自动提亮背景。

## 9.5 主题文件校验（白名单式）

导入是**唯一的外部数据入口**，必须按白名单校验，而不是「检查有没有脚本」这种黑名单思路：

| 校验项 | 规则 | 失败处理 |
|---|---|---|
| 文件大小 | `.ltskin.json` ≤ 256KB；`.ltskin` 包 ≤ 8MB | 拒绝导入 |
| 结构 | `schema` 必须等于当前支持版本；未知字段**直接丢弃**而非报错（向前兼容） | 丢弃未知字段 |
| 必填 | `id / name / version / tokens.light / tokens.dark / radius` | 拒绝导入 |
| `id` | `^[a-z0-9][a-z0-9-]{1,31}$`，用于目录名，杜绝路径穿越 | 拒绝导入 |
| 颜色值 | 只接受 `#RGB(A) / #RRGGBB(AA) / rgb() / rgba() / oklch() / hsl()`，正则匹配后再解析；解析失败回落该令牌的默认值 | 单令牌回落 |
| 数值范围 | `radius 0~24`、`opacity 0~1`、`blur 0~40`、`fontSize 8~72`、`playerBar.height 64~120` | 钳制到区间 |
| `fontFamily` | 只接受字体族名字符串，且必须在「本地已安装字体 + 内置字体」列表中；不接受 `url()` | 回落默认字体 |
| 资源路径 | 只允许皮肤目录内的相对路径，禁止 `..`、绝对路径、UNC 路径、符号链接；扩展名限 `png/jpg/jpeg/webp` | 拒绝该资源 |
| 图片 | 单图 ≤ 4MB，像素 ≤ 4096×4096，须能被 `image` crate 正常解码 | 拒绝该资源 |
| 远程引用 | 任何 `http(s)://` 引用**一律拒绝**（不是「不自动加载」，而是不允许出现） | 拒绝导入 |
| 对比度 | `foreground` 与 `background` 对比度低于阈值时**警告但不拦截**，在编辑器中标红 | 提示 |

失败一律回落到内置默认皮肤，并保留原皮肤文件供用户排查（对应 REQUIREMENTS §3.8 验收第 4 条）。校验逻辑放在 Rust，前端只消费已校验结构。

## 9.6 皮肤包与资源（原文缺失）

原文只定义了 `.ltskin.json` 单文件，但需求里的「自定义字体 / 播放条毛玻璃」以及主流播放器普遍具备的**自定义背景图**都需要携带资源。定两种形态：

| 形态 | 内容 | 用途 |
|---|---|---|
| `.ltskin.json` | 纯配置，单文件 | 最常见的分享形式，可直接贴文本 |
| `.ltskin` | ZIP 包：`skin.json` + `preview.png` + `assets/*` | 需要携带背景图的皮肤 |

存放位置：`<APPDATA>/<identifier>/themes/<skinId>/`，导入时解压到该目录；前端通过 `convertFileSrc()` 走 asset 协议读取图片，`assetProtocol.scope` 已限定在 `$APPDATA/**`（§4.1）。

背景图渲染：使用**独立的绝对定位层**（`背景图 → blur+opacity 层 → tint 层 → 内容层`），不要用 `body { background-image }` 叠 `backdrop-filter`，后者在 WebView2 上滚动时会掉帧。

Windows 11 云母 / 亚克力：作为**皮肤之外的独立开关**（`settings.appearance.windowEffect = none | mica | acrylic`），因为它依赖系统能力而非皮肤内容。开启时窗口背景需设为半透明，与「背景图」互斥；Win10 上不可用则自动降级为 `none` 并置灰选项。

## 9.7 皮肤编辑器

| 能力 | 说明 |
|---|---|
| 分基础 / 高级两档 | 基础只暴露 主色 / 圆角 / 深浅 / 背景图 4 项；高级暴露全部令牌（对应风险表「主题配置过多导致复杂」的应对） |
| 实时预览 | 直接写 CSS 变量，无需保存即生效；「取消」时还原快照 |
| 令牌锁 | 可锁定单个令牌，使封面取色不覆盖它（§9.4） |
| 派生色 | 修改 `primary` 时自动推导 `primary-foreground` / `ring` / hover 态，减少手工配色 |
| 导出 | 导出为 `.ltskin.json`；含背景图时打包为 `.ltskin` |
| 内置皮肤 | 默认浅色、默认深色、纯黑（OLED）、封面动态 4 套，内置皮肤只读，修改时自动另存副本 |

---

## 10. 桌面歌词设计

## 10.1 窗口结构

```text
桌面歌词 WebviewWindow
 ├─ 歌词文字层
 ├─ 歌词翻译层
 ├─ 拖拽区域
 └─ 设置浮层（未锁定时显示）
```

## 10.2 歌词渲染流程（修正 R4：歌词窗口自行计算）

**原文问题**：原流程是「Rust 发进度 → 主窗口计算当前行 → emit 给歌词窗口 → 歌词窗口渲染」。这条链路在最常见的使用场景下会失效：用户开着桌面歌词、把主窗口最小化或切到别的应用去做事。此时主窗口的 WebView 被系统 / WebView2 降频，`requestAnimationFrame` 基本停摆、定时器被节流到秒级，主窗口算出来的「当前行」会卡住或跳变，**50ms 同步误差的验收标准不可能达成**。而且多绕一跳，多一次序列化。

修正后：**Rust 是唯一状态源，歌词窗口直接订阅并自行插值计算**，与主窗口完全解耦。

```text
切歌
 │  Rust 加载歌词（provider / 缓存 / 本地文件）→ 解析为 LyricDoc
 ▼
emit_to("lyrics", "lyric-loaded", LyricDoc)   ── 整篇歌词只下发一次
emit_to("main",   "lyric-loaded", LyricDoc)
 │
 ▼
播放中 Rust 每 250ms emit "position-changed" { positionMs, monotonicMs }
 │
 ├─ 主窗口：插值 → 计算当前行 → 播放页滚动歌词
 └─ 歌词窗口：插值 → 计算当前行/当前字 → 渲染（互不依赖）
```

要点：

1. 整篇歌词（含翻译、音译、逐字时间轴）**一次性下发**，之后只传进度，避免每 250ms 序列化文本。
2. 当前行 / 当前字的计算是纯函数：`(LyricDoc, positionMs + offsetMs) → { lineIndex, wordIndex, wordProgress }`，主窗口与歌词窗口共用同一份 TS 实现。
3. 歌词窗口不可见时不注册 `rAF`，可见时才启动。
4. 偏移（§10.5）在计算函数内生效，两个窗口读同一份偏移值，通过 `lyric-setting-changed` 事件同步。

### LyricDoc 结构

```ts
export interface LyricDoc {
  trackId: string
  /** 无歌词 / 纯音乐时为空数组，由 UI 决定展示文案 */
  lines: LyricLine[]
  hasWordTiming: boolean
  hasTranslation: boolean
  hasRomaji: boolean
  source: 'provider' | 'embedded' | 'file' | 'manual' | 'none'
}

export interface LyricLine {
  timeMs: number
  durationMs?: number
  text: string
  translation?: string
  romaji?: string
  /** 逐字时间轴，缺失时按整行渐变降级 */
  words?: { timeMs: number; durationMs: number; text: string }[]
}
```

## 10.3 歌词获取与匹配规则

原文的匹配顺序只考虑了本地文件，漏了在线曲目（PC 版主场景是在线播放）。补全后按曲目类型分流：

**在线曲目**

```text
lyrics 表缓存命中且未过期 → 用缓存
   │ 否
   ▼
Provider.lyric() （wyy 额外取 translation）
   │ 失败或为空
   ▼
跨音源兜底：按 标题 + 歌手 在其他音源搜歌词
   │ 仍失败
   ▼
显示「暂无歌词」，并提供「手动关联本地 .lrc」入口
```

**本地曲目**

```text
同目录同名 .lrc  →  文件内嵌歌词（lofty）  →  lyrics 表缓存
   →  按 标题+歌手 到当前音源在线搜索  →  仅标题搜索  →  暂无歌词 / 纯音乐
```

### 逐字歌词的可得性（原文未加限定，需求会落空）

「逐字歌词」不是客户端能力问题，而是**音源是否提供**：

| 音源 | 逐字格式 | 结论 |
|---|---|---|
| wyy | `yrc` | 部分热门曲目提供，可解析 |
| qq | `qrc` | 需解密，第一版**不做** |
| kg | `krc` | 需解密，第一版**不做** |
| kw | 无稳定逐字接口 | 不支持 |

因此：**逐字歌词按「有则用、无则整行渐变降级」实现**，需求文档需把「逐字歌词」标注为「音源支持时可用」，不能作为无条件验收项。音译（罗马音）同理，仅 wyy 的 `romalrc` 提供。

## 10.4 锁定与穿透（修正 R5：消除逻辑冲突）

**原文冲突**：同时写了「锁定 → 鼠标穿透，不可交互」和「悬停解锁 → 鼠标移动到安全区域可临时解锁」。这两条不能共存——`set_ignore_cursor_events(true)` 之后窗口**收不到任何鼠标消息**，包括 hover，前端无从感知「鼠标移到了安全区」。

三种可选方案与结论：

| 方案 | 做法 | 评价 |
|---|---|---|
| A. 纯穿透 + 外部解锁（**推荐 v1**） | 锁定后完全穿透，解锁只能通过托盘菜单、全局快捷键（`Ctrl+Alt+L` 系列）、主窗口按钮 | 零风险、实现最简，行为可预期 |
| B. Rust 轮询光标位置 | 后台每 100–150ms 调 `GetCursorPos`，判断是否进入歌词窗口矩形，进入则临时 `set_ignore_cursor_events(false)` 显示工具条，离开则恢复 | 可实现「悬停解锁」，代价是常驻轮询；空闲时可降频到 300ms |
| C. 全局鼠标钩子 | `SetWindowsHookEx(WH_MOUSE_LL)` | 易被安全软件误判、影响全局输入延迟，**不采用** |

定稿：**v1 采用 A**，把 B 作为「悬停显示控制条」的可选增强（设置项，默认关闭）。需求文档中「悬停解锁」需相应改写。

状态机：

| 状态 | 鼠标事件 | 表现 |
|---|---|---|
| 未锁定 | 接收 | 显示半透明容器边框 + 拖动区 + 悬浮工具条（上一首 / 播放 / 下一首 / 字号 / 锁定 / 关闭） |
| 已锁定 | 穿透 | 只有文字，无背景无边框，点击直达桌面图标 |
| 锁定 + 悬停增强（可选） | 轮询模拟 | 鼠标进入区域时临时恢复交互 2s |

补充：锁定状态需持久化；进入锁定时给一次 Toast 提示解锁快捷键，避免用户找不回控制入口。


## 10.5 歌词偏移

1. 支持每次 ±100ms 微调。
2. 支持直接输入偏移值。
3. 偏移按歌曲保存（`lyric_settings.offset_ms`），另设一个全局偏移，最终生效值 = 全局 + 单曲。
4. 偏移不影响原歌词文件。
5. 偏移变更通过 `lyric-setting-changed` 同时广播给主窗口与歌词窗口。

## 10.6 桌面歌词渲染性能（原文缺失）

桌面歌词是**常驻置顶**组件，性能问题会被用户长期感知，需明确约束：

| 约束 | 做法 |
|---|---|
| 只用 GPU 友好属性 | 逐字进度用 `background-clip: text` + `background-size` 或 `clip-path` 的百分比推进；**禁止**每帧改 `width` / 触发布局 |
| 帧率 | 有逐字时间轴时 60fps；仅逐行时降到「行切换才重绘」，空闲期 0 重绘 |
| 不可见即停 | 窗口隐藏 / 暂停播放时取消 `rAF` |
| 文本描边 | 用 `paint-order: stroke fill` + `-webkit-text-stroke`，不要用 4 层 `text-shadow` 模拟（后者开销高） |
| DOM 规模 | 只渲染当前行与下一行（双行模式），不渲染整篇 |
| CPU 目标 | 歌词窗口自身 CPU < 1%，与 REQUIREMENTS §4.1「播放 CPU ≤ 3%」共享预算 |

## 10.7 桌面歌词快捷键与交互

| 操作 | 行为 |
|---|---|
| `Ctrl+Alt+L` | 显示 / 隐藏桌面歌词 |
| `Ctrl+Alt+K` | 锁定 / 解锁（新增，原文只有显示隐藏，锁死后无解锁快捷键） |
| 鼠标滚轮（未锁定） | 调整字号 |
| 拖动（未锁定） | 移动窗口，松开后写回位置 |
| 拖动左右边缘 | 调整宽度，高度按行数与字号自动计算 |
| 双击（未锁定） | 切换单行 / 双行模式 |
| 右键（未锁定） | 弹出样式菜单 |

---

## 11. IPC 接口设计

## 11.1 音源相关

**原文问题**：§11.1 只有 6 个命令（含 `search_music_source`），而 §6.5 的映射表用的是另一套命名（`search_music`、`get_charts`…），两处对不上。此处以 §6.5 为准统一，并去掉 `connect_music_source`（第一版四大音源无用户配置，等 WebDAV 阶段再加）。

音源管理：

| Command | 入参 | 出参 |
|---|---|---|
| `get_music_sources` | 无 | `MusicSourceInfo[]`（含 capabilities） |
| `set_active_source` | `sourceId` | `Settings` |
| `get_source_status` | 无 | `Record<SourceId, ProviderStatus>` |

音乐内容（与 §6.5 一一对应，全部返回 `Result<T, ProviderError>`）：

| Command | 入参 |
|---|---|
| `get_playlist_categories` | `sourceId` |
| `get_recommendations` | `sourceId, category?, page` |
| `get_latest_songs` / `get_all_latest_songs` | `sourceId?, limit, offset` |
| `get_charts` / `get_all_charts` | `sourceId?` |
| `get_chart_detail` | `sourceId, chartId, page, size` |
| `get_playlist_detail` | `sourceId, playlistId, page, size` |
| `get_hot_words` / `get_all_hot_words` | `sourceId?` |
| `search_music` | `sourceId, keyword, type, page, size` |
| `search_all_music_sources` | `keyword, type, page, size` |
| `search_playlists` / `search_artists` / `search_albums` | `sourceId, keyword, page, size` |
| `get_artist_songs` | `sourceId, name, page, size` |
| `get_videos` | `sourceId, page, size` |
| `get_video_url` | `sourceId, videoId, quality` |
| `get_lyric` / `get_lyric_translation` | `track` |
| `get_play_url` | `track, quality` |
| `invalidate_play_url` | `track, quality` |
| `get_track_cover` | `track` |
| `find_alternative_tracks` | `track, targetSourceId?`（换源候选，§6.8 依赖，原文缺失） |

## 11.2 音频相关

| Command | 入参 | 出参 |
|---|---|---|
| `play_track` | `trackId` | `PlaybackState` |
| `play_queue` | `trackIds, startIndex, startPositionMs?` | `PlaybackState` |
| `play_at` | `queueIndex` | `PlaybackState` |
| `next` | 无 | `PlaybackState` |
| `previous` | 无 | `PlaybackState` |
| `pause` / `resume` / `toggle_play` / `stop` | 无 | `PlaybackState` |
| `seek` | `positionMs` | `PlaybackState` |
| `set_volume` | `volume` | `PlaybackState` |
| `set_muted` | `muted` | `PlaybackState` |
| `set_play_mode` | `mode` | `PlaybackState` |
| `set_quality` | `quality` | `PlaybackState` |
| `switch_source` | `targetSourceId, candidateTrack?, keepPosition` | `PlaybackState` |
| `set_sleep_timer` | `minutes \| null \| 'afterCurrentTrack'` | `PlaybackState` |
| `get_playback_state` | 无 | `PlaybackState` |
| `restore_last_session` | 无 | `PlaybackState`（恢复上次现场，需求依赖） |
| `set_crossfade` | `enabled, durationMs` | `AudioSettings` |
| `set_gapless` | `enabled` | `AudioSettings` |
| `set_equalizer` | `enabled, preamp, bands[10]` | `AudioSettings` |
| `get_equalizer_presets` | 无 | `EqPreset[]` |
| `set_spectrum_enabled` | `enabled, fps, bands` | `AudioSettings` |
| `get_output_devices` | 无 | `OutputDevice[]` |
| `set_output_device` | `deviceId \| null` | `AudioSettings` |

> `next` / `previous` 在原文 IPC 表中完全缺失，但播放条、托盘菜单、全局快捷键、SMTC 四处都要用，属必补项。

## 11.2.1 主题与桌面歌词窗口（原文缺失）

| Command | 入参 | 出参 |
|---|---|---|
| `get_appearance` | 无 | `AppearancePreference` |
| `set_appearance` | `patch` | `AppearancePreference` |
| `list_skins` | 无 | `SkinSummary[]` |
| `get_skin` | `skinId` | `Skin` |
| `apply_skin` | `skinId` | `Skin` |
| `import_skin` | `path` | `Skin`（含校验错误明细） |
| `export_skin` | `skinId, path` | `boolean` |
| `save_skin` | `skin`（编辑器另存） | `Skin` |
| `delete_skin` | `skinId` | `boolean` |
| `reset_skin` | 无 | `Skin` |
| `pick_cover_color` | `trackId` | `CoverColor` |
| `show_desktop_lyric` / `hide_desktop_lyric` | 无 | `LyricWindowState` |
| `set_desktop_lyric_locked` | `locked` | `LyricWindowState` |
| `set_desktop_lyric_style` | `patch` | `LyricWindowState` |
| `set_desktop_lyric_bounds` | `x, y, width, height` | `LyricWindowState` |
| `reset_desktop_lyric` | 无 | `LyricWindowState` |


## 11.3 音乐库相关

| Command | 入参 | 出参 |
|---|---|---|
| `add_scan_dir` | `path` | `ScanDir` |
| `remove_scan_dir` | `dirId` | `boolean` |
| `set_scan_dir_enabled` | `dirId, enabled` | `ScanDir` |
| `scan_music_dirs` | `fullScan` | `ScanTask` |
| `cancel_scan` | 无 | `boolean` |
| `get_tracks` | `filter, page` | `TrackPage` |
| `get_track_metadata` | `trackId` | `TrackMetadata` |
| `open_file_location` | `trackId` | `boolean` |
| `remove_missing_tracks` | 无 | `RemoveResult` |

## 11.4 歌词相关

| Command | 入参 | 出参 |
|---|---|---|
| `load_lyric` | `trackId` | `Lyric` |
| `save_lyric` | `trackId, lyric` | `boolean` |
| `import_lyric_file` | `trackId, path` | `Lyric` |
| `set_lyric_offset` | `trackId, offsetMs` | `LyricSetting` |
| `get_lyric_setting` | `trackId` | `LyricSetting` |

## 11.5 队列相关

| Command | 入参 | 出参 |
|---|---|---|
| `get_queue` | 无 | `Track[]` |
| `set_queue` | `trackIds` | `Track[]` |
| `add_to_queue` | `trackIds, position` | `Track[]` |
| `remove_from_queue` | `trackId` | `Track[]` |
| `move_queue_item` | `from, to` | `Track[]` |
| `clear_queue` | 无 | `Track[]` |

## 11.6 系统相关

| Command | 入参 | 出参 |
|---|---|---|
| `get_settings` | 无 | `Settings` |
| `set_setting` | `key, value` | `Settings` |
| `set_autostart` | `enabled` | `boolean` |
| `check_update` | 无 | `UpdateInfo` |
| `install_update` | 无 | `boolean` |
| `open_data_folder` | 无 | `boolean` |
| `open_cache_folder` | 无 | `boolean` |
| `get_cache_size` | 无 | `CacheInfo` |
| `clear_cache` | `types` | `CacheInfo` |
| `get_download_tasks` | 无 | `DownloadTask[]` |
| `enqueue_download` | `trackId, quality` | `DownloadTask` |
| `cancel_download` | `taskId` | `DownloadTask` |
| `retry_download` | `taskId` | `DownloadTask` |
| `remove_download` | `taskId, deleteFile` | `boolean` |
| `clear_downloads` | `deleteFiles` | `boolean` |
| `set_download_dir` | `path` | `Settings` |
| `open_download_folder` | 无 | `boolean` |
| `backup_database` | `path` | `boolean` |
| `restore_database` | `path` | `boolean` |
## 11.7 Astral 服务相关

Rust `AstralClient` 统一封装以下接口，前端不直接使用 `fetch` 请求 Astral。

### 账号

| Command | 对应接口 |
|---|---|
| `astral_login` | `POST /app/user/login` |
| `astral_register` | `POST /app/user/register` |
| `astral_logout` | `POST /app/user/logout` |
| `astral_refresh` | `POST /app/user/refresh` |
| `astral_me` | `GET /app/user/me` |
| `astral_update_profile` | `POST /app/user/update` |
| `astral_upload_avatar` | `POST /app/user/upload` |
| `astral_send_email_code` | `POST /app/user/email` |
| `astral_change_password` | `POST /app/user/changePass` |

### 签到

| Command | 对应接口 |
|---|---|
| `astral_check_in` | `POST /app/user/daka` |
| `astral_check_in_info` | `GET /app/user/dakaInfo` |
| `astral_check_in_month` | `GET /app/user/dakaInfoByMonth` |

### 收藏同步

| Command | 对应接口 |
|---|---|
| `astral_like_song` | `POST /app/user/like/song` |
| `astral_like_playlist` | `POST /app/user/like/playlist` |
| `astral_like_changes` | `GET /app/user/like/changes` |
| `astral_like_page` | `GET /app/user/like/list` |

### 反馈

| Command | 对应接口 |
|---|---|
| `astral_submit_feedback` | `POST /app/feedback/submit` |
| `astral_my_feedback` | `GET /app/feedback/my` |
| `astral_public_feedback` | `GET /app/feedback/public` |
| `astral_feedback_detail` | `GET /app/feedback/{id}` |
| `astral_feedback_replies` | `GET /app/feedback/{id}/replies` |
| `astral_reply_feedback` | `POST /app/feedback/reply` |

### 消息

| Command | 对应接口 |
|---|---|
| `astral_active_messages` | `GET /app/message/active?versionCode=&channel=pc` |
| `astral_message_center` | `GET /app/message/center?channel=pc` |
| `astral_unread_count` | `GET /app/message/unread-count?channel=pc` |
| `astral_ack_messages` | `POST /app/message/read-ack` |

### 更新与统计

| Command | 对应接口 |
|---|---|
| `astral_app_update` | `GET /app/update?type=1103&version=&channel=` |
| `astral_check_official_version` | `GET /app/version/check?type=1103&version=&versionName=` |
| `astral_github_accels` | `GET /app/github/accels` |
| `astral_report_stats` | `POST /app/stat/report`，事件 `ut=app-windows` |

## 11.8 事件设计

| Event | 载荷 | 频率 | 目标窗口 |
|---|---|---|---|
| `playback-state-changed` | `PlaybackState` | 状态语义变化时 | main + lyrics |
| `position-changed` | `{ positionMs, durationMs, monotonicMs }` | 250ms（仅播放中） | main + lyrics |
| `audio-buffering` | `{ trackId, bufferedMs, downloadedBytes, totalBytes }` | 500ms（仅缓冲中） | main |
| `audio-error` | `{ trackId, kind, message }` | 事件驱动 | main |
| `track-changed` | `Track` | 切歌 | main + lyrics |
| `queue-changed` | `{ tracks, index }` | 队列变化 | main |
| `lyric-loaded` | `LyricDoc` | 切歌 / 手动关联后 | main + lyrics |
| `lyric-setting-changed` | `{ trackId, offsetMs, globalOffsetMs }` | 偏移变化 | main + lyrics |
| `lyric-window-changed` | `LyricWindowState` | 显示 / 锁定 / 样式 / 位置变化 | main + lyrics |
| `theme-changed` | `{ appearance, skin }` | 皮肤或外观变化 | main + lyrics |
| `cover-color-changed` | `CoverColor` | 切歌取色完成 | main + lyrics |
| `spectrum-data` | `Float32Array`（`number[]`） | 30fps（可关） | main |
| `scan-progress` | `{ current, total, path }` | 200ms 节流 | main |
| `scan-finished` | `ScanSummary` | 扫描结束 | main |
| `library-changed` | `{ added, updated, missing }` | 文件监听触发 | main |
| `provider-status-changed` | `{ sourceId, status, error? }` | 状态变化 | main |
| `download-progress` | `DownloadProgress` | 500ms 节流 | main |
| `download-finished` | `DownloadTask` | 任务结束 | main |
| `astral-auth-changed` | `AuthState` | 登录 / 登出 / 刷新失败 | main |
| `like-sync-changed` | `LikeSyncState` | 同步状态变化 | main |
| `message-unread-changed` | `{ count }` | 拉取 / 已读后 | main |
| `update-available` | `UpdateInfo` | 检查到新版本 | main |
| `update-progress` | `{ downloaded, total, phase }` | 500ms 节流 | main |
| `media-command` | `{ action }` | 媒体键 / SMTC / 托盘触发 | main |
| `single-instance` | `{ argv, cwd }` | 重复启动时 | main |
| `sleep-timer-changed` | `{ remainingMs \| null }` | 1s（启用时） | main |

**原文缺失项说明**：`lyric-current` 被移除（改为歌词窗口自算，§10.2）；新增 `audio-buffering` / `audio-error`（在线播放必需）、`theme-changed`（皮肤热切换与歌词窗口同步）、`media-command`（媒体键与托盘）、`single-instance`（重复启动激活 + 命令行传入的音频文件）、`library-changed`（文件监听）。

事件约定：

1. 高频事件（`position-changed` / `spectrum-data` / 各类 progress）**只发增量与节流后的值**，不夹带 `Track` 等大对象。
2. 事件按窗口定向下发（`emit_to`），歌词窗口只收到上表标注 `lyrics` 的 6 个事件，与 §17.2 的最小授权一致。
3. 所有事件名用 kebab-case，与命令的 snake_case 区分开，便于检索。


---

## 12. 前端设计

## 12.1 状态管理

使用 Zustand 管理全局状态，TanStack Query 管理服务数据。

### PlayerStore

前端**不持有播放真值**，只镜像 Rust 推送的 `PlaybackState`，再叠加插值后的本地进度：

```ts
export interface PlayerStore {
  // —— 来自 Rust 的镜像，只读 ——
  snapshot: PlaybackState | null
  currentTrack: Track | null
  queue: Track[]
  queueIndex: number | null
  // —— 本地派生 ——
  displayPositionMs: number     // rAF 插值结果，仅用于渲染，不回写 Rust
  isSeeking: boolean            // 拖动进度时冻结插值，松手才 seek
  lastTickAt: number            // performance.now()，插值基准
  // —— 动作，全部转为 invoke ——
  play(trackId: string): Promise<void>
  playQueue(trackIds: string[], startIndex: number): Promise<void>
  next(): Promise<void>
  previous(): Promise<void>
  toggle(): Promise<void>
  seek(ms: number): Promise<void>
  setVolume(v: number): Promise<void>
  setPlayMode(m: PlayMode): Promise<void>
  setQuality(q: Quality): Promise<void>
  switchSource(target: SourceId): Promise<void>
}
```

三条纪律：

1. **单向数据流**：UI 只 `invoke`，状态只从事件回流；禁止前端本地先改 `isPlaying` 再发命令（会与 Rust 状态打架，产生按钮闪烁）。
2. 拖动进度条时用 `isSeeking` 冻结插值与事件覆盖，`onPointerUp` 才发 `seek`。
3. `displayPositionMs` 不入持久化，也不参与相等性比较，避免每帧触发全局重渲染（用 selector 订阅或独立轻量 store）。


### MusicSourceStore

```ts
export interface MusicSourceStore {
  sources: MusicSourceProvider[]
  activeSourceId: string
  aggregateMode: boolean
  sourceStatus: Record<string, ProviderStatus>
}
```

### AstralAuthStore

```ts
export interface AstralAuthStore {
  user: AstralUser | null
  loggedIn: boolean
  refreshing: boolean
}
```

### LikeSyncStore

```ts
export interface LikeSyncStore {
  cursor: number
  syncing: boolean
  pendingCount: number
  lastError: string | null
}
```

### DownloadStore

```ts
export interface DownloadStore {
  tasks: DownloadTask[]
  quality: '128' | '320' | 'flac'
  downloadDir: string
}
```
### ThemeStore

```ts
export interface ThemeStore {
  theme: ThemeConfig
  coverColor: CoverColor | null
  applyTheme(theme: ThemeConfig): void
  applyCoverColor(color: CoverColor | null): void
  resetTheme(): void
}
```

### LyricStore

```ts
export interface LyricStore {
  visible: boolean
  locked: boolean
  currentLine: number
  currentWord: number
  offset: number
  style: LyricStyle
}
```

## 12.2 组件结构

```text
components/
 ├─ ui/                 # shadcn/ui 基础组件
 ├─ layout/
 │   ├─ AppShell.tsx
 │   ├─ TitleBar.tsx
 │   ├─ Sidebar.tsx
 │   └─ PageContainer.tsx
 ├─ music-source/
 │   ├─ MusicSourceSwitcher.tsx
 │   ├─ ProviderStatusBadge.tsx
 │   └─ ProviderSettingsDialog.tsx
 ├─ player/
 │   ├─ PlayerBar.tsx
 │   ├─ TrackInfo.tsx
 │   ├─ TransportControls.tsx
 │   ├─ ProgressBar.tsx
 │   ├─ VolumeControl.tsx
 │   ├─ QueuePanel.tsx
 │   └─ SpectrumCanvas.tsx
 ├─ lyric/
 │   ├─ LyricView.tsx
 │   ├─ DesktopLyricWindow.tsx
 │   └─ LyricStyleEditor.tsx
 ├─ library/
 │   ├─ TrackTable.tsx
 │   ├─ FolderTree.tsx
 │   └─ ScanProgressBar.tsx
 └─ settings/
     ├─ SettingsPage.tsx
     ├─ AppearanceSettings.tsx
     ├─ LyricSettings.tsx
     ├─ AudioSettings.tsx
     ├─ ShortcutSettings.tsx
     ├─ StorageSettings.tsx
     └─ UpdateSettings.tsx
```

## 12.3 虚拟列表设计

音乐库可能达到 10 万首歌曲，必须使用虚拟列表：

1. 只渲染可视区域和缓冲区域。
2. 行高固定，便于快速计算。
3. 支持键盘导航。
4. 支持批量选择。
5. 排序和筛选由 Rust 查询完成。

---

## 13. 扫描设计

## 13.1 扫描流程

```text
读取启用目录
   │
   ▼
遍历目录
   │
   ▼
过滤支持的音频格式
   │
   ▼
读取元数据
   │
   ▼
计算文件指纹
   │
   ▼
写入 SQLite
   │
   ▼
发送 scan-progress
   │
   ▼
完成后发送 scan-finished
```

## 13.2 增量扫描

优先依据：

1. 文件路径
2. 文件大小
3. 修改时间
4. 文件哈希

策略：

1. 文件不存在，标记 `missing = 1`。
2. 文件大小和修改时间不变，跳过。
3. 文件变化，重新读取元数据。
4. 新文件，插入数据。
5. 老文件恢复，取消缺失标记。

## 13.3 文件监听

使用 `notify` 监听目录变化：

| 事件 | 处理 |
|---|---|
| 新增文件 | 加入扫描队列 |
| 修改文件 | 更新元数据 |
| 删除文件 | 标记缺失 |
| 重命名 | 路径变化时重新关联或新增 |
| 目录删除 | 标记该目录下歌曲缺失 |

---

## 13.4 下载设计

### 下载任务状态

```ts
export interface DownloadTask {
  id: string
  trackId: string
  platform: SourceId
  quality: '128' | '320' | 'flac'
  status: 'pending' | 'downloading' | 'completed' | 'failed' | 'canceled'
  progress: number
  filePath?: string
  fileSize?: number
  error?: string
  createdAt: number
  updatedAt: number
}
```

### 下载流程

```text
用户点击下载
   │
   ▼
获取远程播放地址
   │
   ▼
创建下载任务
   │
   ▼
写入临时文件
   │
   ▼
流式下载并更新进度
   │
   ▼
完成后移动到下载目录
   │
   ▼
写入本地音乐库
   │
   ▼
更新任务状态为 completed
```

### 设计规则

1. 下载队列默认低并发执行，避免占用过多带宽。
2. 下载使用临时文件，完成后原子移动到目标目录。
3. 下载过程中应用退出后，下次启动将未完成任务标记为失败并支持重试。
4. 远程播放地址超过 10 分钟未开始下载时重新获取。
5. 本地已存在同 `platform + trackId + quality` 文件时不重复下载。
6. 离线播放时优先匹配本地文件。
7. 删除下载记录时可选择是否删除文件。
8. 下载目录可在设置中修改。
## 14. 系统集成设计

## 14.1 托盘

托盘菜单：

```text
轻听
├─ 播放 / 暂停
├─ 上一首
├─ 下一首
├─ 显示桌面歌词
├─ 显示主窗口
└─ 退出
```

## 14.2 快捷键

快捷键需要支持用户自定义，默认值如下：

| 功能 | 默认快捷键 |
|---|---|
| 播放 / 暂停 | Ctrl + Alt + P |
| 上一首 | Ctrl + Alt + Left |
| 下一首 | Ctrl + Alt + Right |
| 音量加 | Ctrl + Alt + Up |
| 音量减 | Ctrl + Alt + Down |
| 静音 | Ctrl + Alt + M |
| 桌面歌词 | Ctrl + Alt + L |
| 搜索 | Ctrl + F |

## 14.3 Windows 媒体控制

集成 Windows System Media Transport Controls：

1. 显示歌曲标题。
2. 显示艺术家。
3. 显示封面。
4. 支持播放 / 暂停。
5. 支持上一首 / 下一首。
6. 支持进度显示。

---

## 15. 更新、通知与统计平台设计

## 15.1 当前接口基线

Astral 已提供：

| 接口 | 说明 |
|---|---|
| `GET /api/v1/app/update?type=1103&version=&channel=` | 获取 Windows 版本更新信息 |
| `GET /api/v1/app/version/check?type=1103&version=&versionName=` | 校验 Windows 官方版本 |
| `GET /api/v1/app/github/accels` | 获取 GitHub 加速节点 |
| `GET /api/v1/app/message/active?versionCode=&channel=pc` | 获取 PC 当前生效通知 |
| `GET /api/v1/app/message/center?channel=pc` | 获取 PC 消息中心 |
| `GET /api/v1/app/message/unread-count?channel=pc` | 获取 PC 未读数 |
| `POST /api/v1/app/stat/report` | 匿名批量统计上报 |

## 15.2 平台枚举

### 通知渠道 `channel`

| 值 | 说明 |
|---|---|
| `app` | App 端 |
| `pc` | PC / 桌面端 |
| `web` | Web 端 |
| `all` | 全部端 |

PC 端消息接口固定传：

```text
channel=pc
```

### 统计平台 `ut`

| 值 | 说明 |
|---|---|
| `app-android` | Android App |
| `app-ios` | iOS App |
| `app-windows` | Windows 桌面端 |
| `web` | Web 端 |

PC 端统计事件固定传：

```text
ut=app-windows
```

### 更新平台 `type`

| 值 | 说明 |
|---|---|
| `1101` | Android |
| `1102` | iOS |
| `1103` | Windows |

PC 端更新和官方版本校验固定传：

```text
type=1103
```

## 15.3 PC 更新流程

```text
启动或用户手动检查
   │
   ▼
调用 Astral /app/update，携带 type=1103
   │
   ▼
比较 versionCode
   │
   ▼
获取 GitHub 加速节点（可选）
   │
   ▼
并发探测加速节点
   │
   ▼
下载 Windows 更新包
   │
   ▼
校验 MD5 / 签名
   │
   ▼
启动安装器
   │
   ▼
退出当前应用
```

Tauri Updater 可作为备选实现：

1. 更新清单由 Astral 或静态文件服务提供。
2. 更新包签名遵循 Tauri Updater 规范。
3. 前端仍通过 Rust Command 获取更新状态。
4. 即使使用 Tauri Updater，Astral 中的 Windows 版本记录仍应使用 `type=1103`。

## 15.4 通知与统计上报设计

### 通知

1. PC 启动后调用 `active?versionCode=&channel=pc`。
2. 消息中心调用 `center?channel=pc`。
3. 未读数调用 `unread-count?channel=pc`。
4. 已读回执调用 `read-ack`。
5. 后端配置为 `app` 或 `web` 的通知不展示在 PC。
6. 后端配置为 `pc` 或 `all` 的通知正常展示。

### 统计

事件结构沿用 `StatEventDTO`：

```ts
export interface StatEvent {
  evt: 'launcher' | 'show' | 'hide' | 'page' | 'error' | 'custom'
  ts: number
  deviceId: string
  ut: 'app-windows'
  appVersion: string
  model?: string
  os?: string
  page?: string
  duration?: number
  ch?: string
  errorType?: 'js' | 'network' | 'biz'
  message?: string
  stack?: string
  release?: string
  extra?: Record<string, unknown>
}
```

PC 端规则：

1. 所有事件 `ut` 固定为 `app-windows`。
2. 单批事件数量不超过 200。
3. 上报失败进入本地队列重试。
4. 统计失败不影响播放。
5. 用户关闭匿名统计后停止上报。

## 15.5 配置

| 配置 | 默认值 |
|---|---|
| 自动检查更新 | 开启 |
| 自动下载 | 关闭 |
| 更新通道 | stable |
| 更新平台类型 | 1103 |
| 通知渠道 | pc |
| 统计平台 | app-windows |
| 跳过当前版本 | 不跳过 |
| GitHub 加速 | 开启 |

## 15.6 安全要求

1. 更新源使用 HTTPS。
2. 更新包必须校验 MD5 或签名。
3. 校验失败禁止安装。
4. 下载失败保留当前版本。
5. 安装前提示用户。
6. 强制更新时不允许跳过。
7. 非官方版本校验失败时提示，但不自动退出 PC 应用，除非产品明确要求。

## 15.7 版本号规则与发布流程（原文缺失）

`GET /app/update` 的比较依据是 `version_code`（整数），而 PC 与 Android 共用同一张 `qt_app_update` 表、按 `type` 区分平台，因此 **PC 必须有自己独立的 versionCode 序列**，且不能与移动端的 300 系列混淆。

| 项 | 规则 |
|---|---|
| `versionName` | 语义化版本 `major.minor.patch`，如 `1.0.0` |
| `versionCode` | `major*10000 + minor*100 + patch`，如 `1.0.0` → `10000`、`1.2.3` → `10203` |
| 起始值 | PC 首个版本 `1.0.0` / `10000`，与移动端 `3.0.0 / 300` 天然不冲突（同 `type` 内单调即可） |
| 请求参数 | `GET /app/update?type=1103&version=10000&channel=stable`，注意 **`version` 传的是 versionCode 的字符串**，不是 `versionName` |
| 官方校验 | `GET /app/version/check?type=1103&version=10000&versionName=1.0.0`，三者必须与后台记录完全一致 |
| 单一真值 | `versionCode` / `versionName` 由 `tauri.conf.json` 的 `version` 派生，构建时注入到 Rust 常量与前端 `import.meta.env`，禁止三处手写 |

### 发布流程

```text
1. 更新 tauri.conf.json 的 version（如 1.0.1）
2. CI：pnpm build → cargo tauri build（NSIS）
3. CI：计算安装包 MD5 与字节大小
4. 上传安装包（GitHub Release 或对象存储）
5. 后台「版本更新」新增记录：type=1103、versionCode、versionName、
   downloadUrl（GitHub 原始链接）、browserUrl、isGithub=1、md5、fileSize、
   channel、isForce、isPublished=0
6. 用当前版本自测 /app/version/check 通过（未发布也能校验通过）
7. 确认无误后将 isPublished 置 1，客户端开始收到更新
```

### 安装与替换

| 事项 | 做法 |
|---|---|
| 安装器 | NSIS，`installMode: perUser`（免管理员，避免 UAC 拦截自动更新） |
| 静默参数 | 更新时以 `/S`（或 Tauri Updater 默认参数）启动新安装器，安装完成后重启应用 |
| 退出时机 | 先落盘播放现场与数据库（`PRAGMA wal_checkpoint`），再启动安装器并退出，避免 SQLite 被强杀导致 `-wal` 残留 |
| 校验 | 下载完成后先比对 `md5` 与 `fileSize`，任一不符即删除临时文件并报错，**不进入安装** |
| GitHub 加速 | 复用 `UPDATE_DESIGN.md` 的方案：`isGithub=1` 时取 `/app/github/accels`，并发探测（`Range: bytes=0-0`，4s 超时），首个 200/206 的前缀胜出；全失败回落原始 `downloadUrl` |
| 双链接 | `browserUrl` 存在时提供「浏览器下载」按钮（走系统默认浏览器），与「直接下载」并存 |
| 更新失败 | 保留当前版本可用，记录日志，允许重试或转浏览器下载 |

> 与 `tauri-plugin-updater` 的关系：Updater 需要自己的签名清单（`latest.json` + minisign 私钥）。如果采用它，则 Astral 侧的 `qt_app_update` 记录退化为「展示更新日志 + 官方校验」，**下载与安装由 Updater 负责**，两套流程不要同时开启。第一版建议先做自建流程（与移动端一致、可控），Updater 作为后续增量。

---

## 16. 日志设计

## 16.1 日志文件

```text
logs/
 ├─ app-2026-09-05.log
 └─ errors.log
```

## 16.2 日志级别

| 级别 | 用途 |
|---|---|
| trace | 调试细节 |
| debug | 开发调试 |
| info | 常规运行信息 |
| warn | 可恢复异常 |
| error | 错误 |
| fatal | 严重错误 |

## 16.3 记录内容

1. 应用启动和退出
2. 数据库迁移
3. 扫描开始和结束
4. 音源连接状态
5. 音频设备变化
6. 更新流程
7. 异常堆栈

日志不记录：

1. Astral `satoken` / `refreshToken`（出现时以 `***` 掩码）
2. 用户账号密码、邮箱验证码
3. 歌词正文
4. 完整播放地址（含签名参数的 URL 只记录 host + path，去掉 query）
5. WebDAV 密码、在线音源令牌（后续扩展）
6. 用户完整文件路径仅在 `debug` 级别记录，`info` 及以上只记录文件名

---

## 17. 安全设计

## 17.1 凭据存储

当前第一版只有 Astral 轻听账号凭据，不保存网易云、QQ、酷我、酷狗的音源平台账号。

1. Astral `satoken` 优先使用 Windows Credential Manager 存储。
2. token 不写入 SQLite。
3. token 不写入日志。
4. 界面显示时使用掩码。
5. 退出登录时清理 token。
6. token 过期时由 Rust 自动刷新。
7. 后续若增加 WebDAV 或授权音源登录，同样必须使用系统凭据管理器。
## 17.2 IPC 安全

1. Tauri Capability 按窗口最小授权。
2. 桌面歌词窗口只订阅歌词事件。
3. 文件访问范围限制在用户选择的目录。
4. 高危命令需要显式用户操作触发。

## 17.3 主题安全

主题文件只允许声明视觉属性：

1. 不允许脚本。
2. 不允许远程资源（不是「不自动加载」，而是出现即拒绝导入）。
3. 不允许任意文件路径读取，资源只能落在皮肤自身目录内（§9.5 路径校验）。
4. 字体只能使用本地已安装字体或应用内置字体。

## 17.4 Capability 与 CSP 落地（原文缺失）

Tauri 2 的权限是**按窗口授权**的，§17.2 提出了「最小授权」原则但没有落到配置。定稿如下。

`src-tauri/capabilities/main.json`：

```json
{
  "identifier": "main-window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-start-dragging",
    "core:window:allow-start-resize-dragging",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-hide",
    "core:window:allow-close",
    "core:event:default",
    "dialog:allow-open",
    "opener:allow-open-path",
    "opener:allow-open-url",
    "os:default",
    "global-shortcut:default",
    "updater:default",
    "autostart:default",
    { "identifier": "core:webview:allow-set-webview-zoom", "allow": [] }
  ]
}
```

`src-tauri/capabilities/lyrics.json`（**显著小于主窗口**）：

```json
{
  "identifier": "lyrics-window",
  "windows": ["lyrics"],
  "permissions": [
    "core:event:allow-listen",
    "core:window:allow-start-dragging",
    "core:window:allow-set-size",
    "core:window:allow-set-position",
    "core:window:allow-hide"
  ]
}
```

配套约束：

1. 歌词窗口**不授予** `dialog` / `opener` / `fs` / `shell` 任何权限，即使歌词内容被污染也无法触发文件或外链操作。
2. 自定义 command 也要按窗口区分：歌词窗口只允许调用 `get_playback_state`、`toggle_play`、`next`、`previous`、`set_desktop_lyric_*`；其余 command 在 handler 入口用 `window.label()` 校验并拒绝。
3. CSP（§4.1）不放开任何外部域名；`img-src` / `media-src` 只放开 `asset:` 与 `qtres:`。
4. `assetProtocol.scope` 限定 `$APPDATA/**` 与 `$APPCACHE/**`；用户添加的音乐目录**不加入 asset scope**（本地音频由 Rust 读取后走播放链路，不需要 WebView 直接访问）。
5. 本地封面同样经 `qtres://local/<trackId>` 读取，避免为了显示内嵌封面而把整个音乐目录暴露给 WebView。
6. `dangerousDisableAssetCspModification` 保持默认（不禁用）。

---

## 18. 性能设计

## 18.1 启动优化

1. 延迟初始化非核心模块。
2. 数据库迁移在启动早期完成。
3. 大列表首屏只查询第一页。
4. 封面缩略图异步加载。
5. 主题使用缓存配置。

## 18.2 播放优化

1. 音频线程与 UI 线程隔离。
2. 避免频繁全量序列化播放状态。
3. 进度事件节流。
4. 频谱事件频率可配置。
5. 不在前端计算音频数据。

## 18.3 大列表优化

1. 虚拟滚动。
2. 分页查询。
3. 数据库索引。
4. 封面缩略图缓存。
5. 排序和筛选下沉到 SQL。

---

## 19. 目录结构

## 19.1 前端目录

```text
src/
 ├─ assets/
 ├─ components/
 ├─ features/
 │   ├─ home/
 │   ├─ library/
 │   ├─ search/
 │   ├─ playlist/
 │   ├─ charts/
 │   ├─ daily/
 │   ├─ artist/
 │   ├─ mv/
 │   ├─ player/
 │   ├─ lyric/
 │   ├─ downloads/
 │   ├─ stats/
 │   ├─ feedback/
 │   ├─ messages/
 │   ├─ profile/
 │   ├─ music-source/
 │   └─ settings/
 ├─ routes/
 ├─ stores/
 ├─ themes/
 ├─ lib/
 │   ├─ ipc.ts
 │   ├─ theme.ts
 │   ├─ format.ts
 │   ├─ query.ts
 │   └─ constants.ts
 ├─ types/
 ├─ App.tsx
 └─ main.tsx
```

## 19.2 Rust 目录

```text
src-tauri/
 ├─ capabilities/
 ├─ icons/
 ├─ src/
 │   ├─ main.rs
 │   ├─ lib.rs
 │   ├─ commands/
 │   │   ├─ audio.rs
 │   │   ├─ music_source.rs
 │   │   ├─ astral.rs
 │   │   ├─ library.rs
 │   │   ├─ lyric.rs
 │   │   ├─ playlist.rs
 │   │   ├─ download.rs
 │   │   └─ system.rs
 │   ├─ audio/
 │   ├─ metadata/
 │   ├─ lyric/
 │   ├─ providers/
 │   │   ├─ mod.rs
 │   │   ├─ wyy.rs
 │   │   ├─ qq.rs
 │   │   ├─ kw.rs
 │   │   ├─ kg.rs
 │   │   └─ local.rs
 │   ├─ astral/
 │   │   ├─ client.rs
 │   │   ├─ auth.rs
 │   │   ├─ like_sync.rs
 │   │   ├─ feedback.rs
 │   │   ├─ message.rs
 │   │   └─ stats.rs
 │   ├─ downloads/
 │   ├─ storage/
 │   │   ├─ mod.rs
 │   │   ├─ database.rs
 │   │   ├─ migration.rs
 │   │   └─ cache.rs
 │   ├─ theme/
 │   ├─ windows/
 │   │   └─ desktop_lyric.rs
 │   ├─ tray.rs
 │   ├─ shortcuts.rs
 │   ├─ media_control.rs
 │   ├─ updater.rs
 │   └─ logger.rs
 ├─ Cargo.toml
 └─ tauri.conf.json
```
---

## 20. 测试设计

## 20.1 Rust 单元测试

| 模块 | 测试重点 |
|---|---|
| audio | 播放状态、队列、模式切换 |
| queue | 顺序、循环、随机、边界 |
| metadata | 各格式元数据解析 |
| lyric | LRC 解析、时间轴排序 |
| storage | SQLite 读写、迁移 |
| provider | 音源状态和搜索 |
| theme | 主题校验 |

## 20.2 前端测试

| 模块 | 测试重点 |
|---|---|
| PlayerBar | 控制、进度、音量 |
| TrackTable | 虚拟列表、选择、排序 |
| MusicSourceSwitcher | 音源切换和状态 |
| ThemeStore | 主题应用 |
| LyricView | 当前行计算 |

## 20.3 集成测试

1. 播放 → 暂停 → 恢复。
2. 扫描 → 播放 → 收藏。
3. 创建歌单 → 添加歌曲 → 播放歌单。
4. 切换音源 → 搜索 → 播放。
5. 开启桌面歌词 → 切歌 → 校验同步。
6. 修改主题 → 重启 → 校验持久化。
7. 更新检查 → 下载 → 安装。

## 20.4 性能测试

1. 冷启动时间。
2. 10 万首歌曲滚动。
3. 大目录扫描。
4. 播放时 CPU 和内存。
5. 桌面歌词同步误差。
6. 无缝播放间隙。

---

## 21. 里程碑计划

### 21.0 先跑通一条最小闭环（原文缺失，强烈建议）

原计划 M1–M12 是按模块切的，问题是**要到 M5 才有能听的歌**（M2 的「可播放在线歌曲」依赖 M5 的 Provider 才能取到地址），中间三个里程碑无法验证核心假设。建议先插一个 M0，把最不确定的三件事（Rust 音频链路、流式播放、无边框壳）在一周内验证掉：

| M0 交付 | 验证的风险 |
|---|---|
| Tauri 壳 + 无边框标题栏 + 播放条静态布局 | 无边框窗口的拖动 / 缩放 / Snap 缺失是否可接受 |
| **单一音源（建议 wyy）**的 `search_music` + `get_play_url` + `get_lyric` | Provider 移植的真实难度（签名、请求头、响应归一） |
| Rust 音频核心：`HttpRangeReader` + rodio 播放 / 暂停 / seek / 音量 | 流式播放、seek、FLAC 兼容性——**整个项目最大的技术风险** |
| `position-changed` + 前端插值 + 播放页滚动歌词 | 50ms 同步误差是否可达 |

M0 通过后再按下表推进；M0 不通过就要在架构层面调整（例如改用 `stream-download` crate、或先只支持完整下载后播放）。

### 21.1 里程碑表

| 阶段 | 内容 | 交付物 |
|---|---|---|
| M1 | Tauri 2 + React 项目初始化、基础布局、自定义标题栏、路由 | 可运行壳应用 |
| M2 | Rust 音频核心、播放条、播放队列、播放模式、播放地址 10 分钟失效策略 | 可播放在线歌曲 |
| M3 | Astral HTTP Client、登录、Token 刷新、账号资料 | Astral 账号能力 |
| M4 | 收藏增量同步、本地待同步队列、收藏页 | 多端收藏能力 |
| M5 | 四大音源 Rust Provider：搜索、歌单、榜单、新歌、热词、歌词、封面 | 音源基础能力 |
| M6 | 歌单广场、排行榜、榜单详情、新歌速递、歌手、专辑、MV | 发现与搜索能力 |
| M7 | 本地扫描、下载队列、离线播放、本地歌单、播放历史 | 本地与离线能力 |
| M8 | 主题系统、皮肤自定义、封面取色、播放页 | 视觉定制能力 |
| M9 | 桌面歌词、托盘、快捷键、媒体键、迷你模式 | 桌面体验 |
| M10 | 反馈、消息中心、统计上报、Windows 更新、自启动 | 服务与系统能力 |
| M11 | 频谱、波形、无缝播放、淡入淡出、EQ | 音频增强 |
| M12 | 性能优化、接口回归测试、打包发布 | 正式版本 |
---

## 22. 风险与应对

| 风险 | 等级 | 应对 |
|---|---|---|
| 音频格式兼容不稳定 | 高 | 建立多格式测试集，失败文件明确提示 |
| 桌面歌词窗口在 Windows 上表现异常 | 中 | 优先 Windows 适配，提供普通置顶模式降级 |
| 大目录扫描慢 | 中 | 增量扫描、后台任务、进度展示 |
| 无缝播放实现复杂 | 高 | 先保证稳定切歌，再逐步优化间隙 |
| 主题配置过多导致复杂 | 中 | 提供基础模式和高级模式 |
| WebView 渲染性能差异 | 中 | 关键列表虚拟化，动画可关闭 |
| 在线音源合规风险 | 高 | 第一版仅限个人学习交流，不绕过 DRM 和版权限制；商业发行前替换为官方或授权接口 |

---

## 23. 后续扩展方向

1. WebDAV Provider
2. 自建音乐服务器 Provider
3. 智能歌单
4. 主题市场
5. 歌词编辑器
6. 音频转码工具
7. 移动端联动
8. 多端播放同步
9. 音乐统计报告
10. 插件系统

---

## 24. 工程与交付（原文缺失）

### 24.1 目录与仓库位置

新工程建议放在 `F:\qtMusic\qt-pc\`（与 `qt-uniappx`、`astral` 平级），本文档与需求文档同目录。工程内不修改 `qt-uniappx` 与 `astral` 的任何文件——Provider 是**移植**而非引用，两侧各自演进。

```text
qt-pc/
 ├─ REQUIREMENTS.md
 ├─ DESIGN.md
 ├─ package.json
 ├─ vite.config.ts
 ├─ components.json          # shadcn/ui 配置
 ├─ src/                     # §19.1
 └─ src-tauri/               # §19.2
```

### 24.2 环境与配置分离

对齐移动端 `services/config.ts` 的做法，避免生产地址进仓库：

| 文件 | 是否提交 | 内容 |
|---|---|---|
| `src-tauri/config.dev.toml` | 提交 | 开发环境 Astral 基地址（局域网） |
| `src-tauri/config.local.toml` | **不提交**（加 `.gitignore`） | 生产环境基地址 |
| 运行时覆盖 | — | 设置页提供隐藏入口可临时改基地址，便于联调；改动只存本机 |

基地址由 Rust 持有，前端不感知也不硬编码。

### 24.3 构建与 CI

| 任务 | 命令 |
|---|---|
| 前端类型检查 | `pnpm tsc --noEmit` |
| 前端单测 | `pnpm vitest run` |
| Rust 检查 | `cargo clippy --all-targets -- -D warnings` |
| Rust 单测 | `cargo test`（§20.1 的模块） |
| 本地运行 | `pnpm tauri dev` |
| 出包 | `pnpm tauri build`（产物：`src-tauri/target/release/bundle/nsis/*.exe`） |

CI（GitHub Actions，`windows-latest`）：`checkout → setup node/pnpm → setup rust(msvc) → 缓存 cargo/pnpm → 类型检查 + clippy + 测试 → tauri build → 计算 MD5/大小 → 上传 artifact`。Release 环节保持人工确认，避免自动发布未验证的包。

### 24.4 代码签名与 SmartScreen（发布必须提前决策）

未签名的安装包在 Windows 上会触发 SmartScreen「未知发布者」拦截，用户需点两次「更多信息 → 仍要运行」。这是**发布前必须决策**的成本项：

| 选项 | 成本 | 效果 |
|---|---|---|
| 不签名 | 0 | 首次运行有警告，下载量积累后逐渐减轻 |
| OV 代码签名证书 | 年费 | 去掉「未知发布者」，仍需积累声誉 |
| EV 代码签名证书 | 年费更高 + 硬件密钥 | 立即获得 SmartScreen 信誉 |

第一版按「不签名 + 官网/README 说明 + 提供 MD5 供校验」处理，并在需求文档的验收标准中排除签名相关项。

### 24.5 与移动端的一致性检查清单

发布前逐项核对，避免两端行为漂移：

1. 源 ID 仍为 `wyy / qq / kw / kg`，收藏接口 `platform` 字段一致。
2. 音质枚举仍为 `128 / 320 / flac`。
3. 播放地址有效期仍为 10 分钟。
4. 收藏同步仍以 `updatedSeq` 为游标，last-write-wins。
5. 更新 `type=1103`、消息 `channel=pc`、统计 `ut=app-windows`、反馈 `X-Platform: windows`。
6. 默认皮肤主色与移动端品牌色一致（`#e5484d` / `#ff5c63`）。
