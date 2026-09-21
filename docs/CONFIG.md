# 配置修改文档（发布前必读）

本文档列出发布一个新版本前**必须检查/修改**的配置项，以及每项的作用与影响范围。

## 1. 版本号（三处必须同步改）

| 文件 | 字段 | 说明 |
|---|---|---|
| `src-tauri/tauri.conf.json` | `version` | 安装包 / 应用的对外版本号（关于页、升级接口对比用这个） |
| `src-tauri/Cargo.toml` | `[package] version` | Rust crate 版本，**必须与 tauri.conf.json 一致** |
| `package.json` | `version` | 前端包版本，建议同步（不强制，但保持一致可避免困惑） |

> 检查后端升级接口时用 `tauri.conf.json` 的 `version`；`Cargo.toml` 改完会触发全量重编译，耗时更长但必须改。

## 2. 应用基本信息（`src-tauri/tauri.conf.json`）

| 字段 | 当前值 | 说明 | 何时改 |
|---|---|---|---|
| `productName` | `QuietMusic` | 安装包名、开始菜单名、进程名 | 品牌变更时 |
| `identifier` | `com.qt.quietmusic` | 应用唯一 ID（Windows 注册表路径、数据目录派生） | **发布后不要改**，改了等于新应用 |
| `app.windows[0].title` | `轻听` | 主窗口标题 | 随意 |

> 注意：`tauri.conf.json` 里的 `title` 在仓库中显示为转义乱码（`杞诲惉`）时，
> 说明文件被以错误编码保存过。**必须保持 UTF-8 无 BOM**，否则窗口标题会乱码。
> 编辑该文件后用 `Get-Content -Encoding UTF8` 确认中文正常。

## 3. 打包目标（`bundle` 段）

```jsonc
"bundle": {
  "active": true,
  "targets": ["nsis"],            // 当前只出 NSIS 安装包；要出 zip 加 "zip"
  "icon": ["icons/icon.ico"],     // 应用图标；换图标直接替换该文件（256x256.ico）
  "windows": {
    "nsis": {
      "installMode": "currentUser",   // 免管理员安装；改 "both"/"perMachine" 需管理员权限
      "languages": ["SimpChinese"]    // 安装器语言
    },
    "webviewInstallMode": { "type": "downloadBootstrapper" }  // 缺 WebView2 时在线装
  }
}
```

## 4. 后端地址（开发 / 生产环境）

`src-tauri/src/astral.rs` 定义了两个环境常量，`DEFAULT_BASE_URL` 是当前生效值：

| 常量 | 地址 | 用途 |
|---|---|---|
| `DEV_BASE_URL` | `http://localhost:27000/api/v1/` | 本地开发联调（当前默认） |
| `PROD_BASE_URL` | `http://astral.canace.cn/api/v1/` | 线上生产环境 |
| `DEFAULT_BASE_URL` | 上面两者之一 | **当前生效**；发布安装包前切回 `PROD_BASE_URL` |

- 切换方法：改 `DEFAULT_BASE_URL` 的取值（`= DEV_BASE_URL` 或 `= PROD_BASE_URL`）后重新编译。
- 登录页提示文案在 `src/components/mine/LoginPage.tsx`，切换环境时同步更新。
- **不要**把生产密钥/密码写进仓库。

## 5. 数据目录与升级

- 用户数据目录：`%APPDATA%\QuietMusic\`（music.db、astral.session、音频缓存、下载）
- `identifier` 不变的前提下，覆盖安装升级**不会**动用户数据；
  数据库 schema 由启动迁移自动升级（当前 v6），无需手工处理。
- 安装器升级模式：NSIS `installMode: currentUser` 下直接覆盖安装即可。

## 6. 常见坑（本项目实测）

1. **`pnpm tauri build` / `pnpm tauri dev` 在本机不可用** ——
   Tauri CLI 会把 `process.argv[0]` 解析成 `DSH Desktop.exe`，报
   `unrecognized subcommand`。打包走**手动分步**（见《打包文档》）。
2. 打包前**必须关掉正在运行的 QuietMusic 进程**，否则链接 `quietmusic.exe` 报
   `os error 5 拒绝访问`。
3. cargo 命令统一加环境变量：
   `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"; $env:CARGO_HOME = "F:\qtMusic\qt-pc\.cargo-home"`
4. `tauri.conf.json` 保存编码必须 UTF-8 无 BOM，中文才不乱码。
