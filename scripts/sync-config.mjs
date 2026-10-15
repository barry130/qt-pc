/**
 * 单一配置源 `app.config.json` → 各工具配置文件的同步器。
 *
 * 用法：
 *   node scripts/sync-config.mjs           # 写入（只改内容真的不一致的文件）
 *   node scripts/sync-config.mjs --check   # 只校验，不一致则退出码 1（CI / 测试用）
 *
 * 设计要点
 * --------
 * 1. **只收重复出现的值**：某个工具独占的配置（tsconfig 编译选项、vite 构建目标、
 *    Cargo 依赖与 profile、NSIS 模板…）留在原文件 —— 那些工具只认自己的文件名与格式，
 *    硬塞进一个文件反而会多一层易错的生成步骤。
 * 2. **写前比对**：内容相同就不落盘。这不只是省事 —— `source-update.ts` /
 *    `chain-config.ts` 属于**音源引擎包**源码（会打进 1.77 MB 的 source-bundle.js，
 *    哈希写进发布说明），值没变时绝不能碰文件，否则包哈希会无意义地变化。
 * 3. **--check 是护栏**：`pnpm build` / `pnpm test` / Rust 单测都会校验，
 *    绕过脚本手改派生文件会直接失败，而不是等到发版才发现版本号对不上。
 * 4. **公开 / 私有两层**：`app.config.json`（**提交**）只放公开值 —— 版本号、产品名、
 *    ID、端口、宿主契约版本，以及**本机联调地址**。自有域名、生产后端地址、官网地址
 *    一律不进仓库，只活在 `app.config.local.json`（**被 .gitignore 忽略**，模板见
 *    `app.config.local.json.example`）。本脚本把它编译成 `src-tauri/src/private_config.rs`
 *    （同样被忽略），运行期还能用同名文件覆盖 —— 见 `src-tauri/src/runtime_config.rs`。
 *    该目标**不参与 --check**：有私有文件时它本来就该和仓库版本不同。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 单一配置源路径（公开，提交进仓库） */
export const CONFIG_FILE = path.join(ROOT, "app.config.json");

/** 私有配置路径（自有域名 / 生产后端地址 / 官网地址；被 .gitignore 忽略，可不存在） */
export const PRIVATE_FILE = path.join(ROOT, "app.config.local.json");

/** 读取并做最基本的形状校验（按 mtime 记忆：同一次进程里反复读不会读到半写状态） */
export function loadConfig() {
  const cfg = readJsonCached(CONFIG_FILE, "app.config.json");
  for (const key of ["product", "version", "sourcePack", "backend", "platform", "devServer"]) {
    if (!cfg[key]) throw new Error(`app.config.json 缺字段: ${key}`);
  }
  if (!["dev", "prod"].includes(cfg.backend.active)) {
    throw new Error(`app.config.json: backend.active 只能是 dev 或 prod，当前 ${cfg.backend.active}`);
  }
  if (!cfg.backend.dev) throw new Error("app.config.json 缺字段: backend.dev");
  return cfg;
}

/**
 * 读 JSON 并按 (mtimeMs, size) 记忆。
 *
 * 为什么需要：`--check` / 测试可能在前一个进程刚写完文件时立刻读，而编辑器的
 * 保存是「先截断再写」——不记忆就会偶发读到空文件报 "Unexpected end of JSON input"。
 */
const jsonCache = new Map();
function readJsonCached(abs, label) {
  const st = fs.statSync(abs);
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = jsonCache.get(abs);
  if (hit && hit.key === key) return hit.value;
  const value = JSON.parse(fs.readFileSync(abs, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 顶层必须是对象`);
  }
  jsonCache.set(abs, { key, value });
  return value;
}

/**
 * 读取私有配置；文件不存在时返回空对象（公开仓库 / CI 裸编译的正常状态）。
 *
 * 字段全部可选，缺省即"仓库里没有这个值"。刻意不在这里做"生产构建必须有值"的
 * 校验：那会让 `pnpm build` 在开发机上直接失败，而开发机本来就不需要生产地址。
 * 真正的护栏在发版流程（`.github/workflows/release.yml` 的「注入私有配置」步骤，
 * 缺 Secret 直接 fail），以及运行期（`runtime_config` 打 ERROR 日志）。
 */
export function loadLocalConfig() {
  if (!fs.existsSync(PRIVATE_FILE)) return {};
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(PRIVATE_FILE, "utf8"));
  } catch (e) {
    throw new Error(`app.config.local.json 不是合法 JSON：${e.message}`, { cause: e });
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("app.config.local.json 顶层必须是对象");
  }
  for (const key of ["backendBaseUrl", "officialSiteUrl"]) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") {
      throw new Error(`app.config.local.json: ${key} 必须是字符串`);
    }
  }
  if (raw.ownDomains !== undefined) {
    if (!Array.isArray(raw.ownDomains) || raw.ownDomains.some((d) => typeof d !== "string")) {
      throw new Error("app.config.local.json: ownDomains 必须是字符串数组");
    }
  }
  return raw;
}

/** 版本名 → 版本号（1.0.7 → 107），与 DESIGN §15.7 的规则一致 */
export function versionCodeOf(name) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(name);
  if (!m) throw new Error(`版本名格式应为 x.y.z，当前 ${name}`);
  return Number(m[1]) * 100 + Number(m[2]) * 10 + Number(m[3]);
}

/** app_config.rs 的完整内容（Rust 侧唯一读取入口） */
function rustSource(c) {
  const active = c.backend.active === "dev" ? "DEV_BASE_URL" : "PROD_BASE_URL";
  return `//! 由 \`scripts/sync-config.mjs\` 从仓库根的 \`app.config.json\` 生成 —— **不要手改**。
//!
//! 重新生成：改完 \`app.config.json\` 跑 \`pnpm config:sync\`。
//! 校验：\`pnpm config:check\`，以及本文件末尾的单测（逐项比对 JSON）。
//!
//! 其它 Rust 模块请从这里取值（\`astral.rs\` 已把对外常量转指到本模块），
//! 不要在别处重新写一遍字面量。

/// 安装包名 / 进程名 / 开始菜单名
pub const PRODUCT_NAME: &str = "${c.product.name}";
/// 界面展示名（窗口标题、快捷方式名）
pub const PRODUCT_DISPLAY_NAME: &str = "${c.product.displayName}";
/// 应用唯一 ID（注册表路径与数据目录由它派生，发布后不可改）
pub const IDENTIFIER: &str = "${c.product.identifier}";

/// 对外版本名（安装包 / 关于页 / 升级接口）
pub const VERSION_NAME: &str = "${c.version.name}";
/// 升级接口比对用的版本号（后端按平台 type 下发的 version 参数）
pub const VERSION_CODE: i64 = ${c.version.code};

/// 宿主契约版本（音源包与本机的接口版本，两端同步抬高）
pub const HOST_API_VERSION: i64 = ${c.sourcePack.hostApiVersion};

/// 本地联调后端
pub const DEV_BASE_URL: &str = "${c.backend.dev}";
/// 生产后端地址：**编译期**取私有配置（\`app.config.local.json\` → \`private_config.rs\`）。
/// 公开仓库里没有真值，\`BACKEND_BASE_URL\` 是空串；运行期还能被同名文件覆盖，
/// 见 \`runtime_config::base_url()\`（那才是真正决定连哪台后端的函数）。
pub const PROD_BASE_URL: &str = crate::private_config::BACKEND_BASE_URL;
/// 当前生效的后端（编译期口径）：由 app.config.json 的 \`backend.active\` 决定（${c.backend.active}）。
///
/// \`runtime_config::base_url()\` 会读这个常量：\`dev\` 时**完全不看**私有配置
/// （联调就该只连本机，本机上那份 \`app.config.local.json\` 是给生产形态用的，
/// 不该在开发时被偷偷读走），\`prod\` 时才走"运行时文件 > 编译期私有常量"。
pub const ACTIVE_BACKEND: &str = "${c.backend.active}";
/// 当前生效的后端地址（编译期口径）
pub const DEFAULT_BASE_URL: &str = ${active};

/// 更新接口的平台号，按编译目标三选一
/// （${c.platform.windows} = Windows / ${c.platform.linux} = Linux / ${c.platform.macos} = macOS）
#[cfg(target_os = "windows")]
pub const UPDATE_TYPE: &str = "${c.platform.windows}";
#[cfg(target_os = "linux")]
pub const UPDATE_TYPE: &str = "${c.platform.linux}";
#[cfg(target_os = "macos")]
pub const UPDATE_TYPE: &str = "${c.platform.macos}";

/// 平台号（数值形态），与 UPDATE_TYPE 同源，供 JSON 请求体 / URL 查询参数使用。
/// 音源包 manifest 与装载上报走这个值：绝不能另写字面量，否则三平台会漂移。
#[cfg(target_os = "windows")]
pub const PLATFORM_CODE: i64 = ${c.platform.windows};
#[cfg(target_os = "linux")]
pub const PLATFORM_CODE: i64 = ${c.platform.linux};
#[cfg(target_os = "macos")]
pub const PLATFORM_CODE: i64 = ${c.platform.macos};

/// 本机 CPU 架构（升级接口 arch 参数，服务端按它挑同版本下的对应安装包）。
/// 取值必须与后端 qt_app_update_artifact.arch 一致（小写）：
/// Windows 出 x64 / x86 / arm64 三份包，macOS 出 x64 / arm64 两份，
/// 拿错架构的安装包会在 MD5 / 大小校验阶段直接失败。
/// 与 UPDATE_TYPE 一样按编译目标取值，不在别处另写字面量。
#[cfg(target_arch = "x86_64")]
pub const ARCH: &str = "x64";
#[cfg(target_arch = "x86")]
pub const ARCH: &str = "x86";
#[cfg(target_arch = "aarch64")]
pub const ARCH: &str = "arm64";

#[cfg(test)]
mod tests {
    //! 一致性护栏：本文件必须与 app.config.json 逐项相等。
    //! 有人绕过同步脚本手改这里（或改了 JSON 忘了跑同步）时，单测直接失败。
    use serde_json::Value;

    const RAW: &str = include_str!("../../app.config.json");

    fn cfg() -> Value {
        serde_json::from_str(RAW).expect("app.config.json 不是合法 JSON")
    }

    fn s(v: &Value) -> &str {
        v.as_str().expect("期望字符串")
    }

    #[test]
    fn matches_app_config_json() {
        let c = cfg();
        assert_eq!(s(&c["product"]["name"]), super::PRODUCT_NAME);
        assert_eq!(s(&c["product"]["displayName"]), super::PRODUCT_DISPLAY_NAME);
        assert_eq!(s(&c["product"]["identifier"]), super::IDENTIFIER);
        assert_eq!(s(&c["version"]["name"]), super::VERSION_NAME);
        assert_eq!(c["version"]["code"].as_i64().unwrap(), super::VERSION_CODE);
        assert_eq!(
            c["sourcePack"]["hostApiVersion"].as_i64().unwrap(),
            super::HOST_API_VERSION
        );
        assert_eq!(s(&c["backend"]["dev"]), super::DEV_BASE_URL);
        // 生产地址不在 app.config.json 里（公开仓库不含自有域名）：只断言编译期
        // 取值确实转指到私有配置，真值由 private_config.rs 持有。
        assert_eq!(super::PROD_BASE_URL, crate::private_config::BACKEND_BASE_URL);
        // UPDATE_TYPE 按编译目标三选一：断言当前目标对应的 JSON 值与常量相等
        let platform_key = if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "linux") {
            "linux"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            panic!("不支持的目标平台：UPDATE_TYPE 未定义");
        };
        assert_eq!(
            c["platform"][platform_key].as_i64().unwrap().to_string(),
            super::UPDATE_TYPE,
            "UPDATE_TYPE 必须等于 platform.{platform_key}（JSON 里是数字，Rust 侧是字符串）"
        );
        assert_eq!(
            c["platform"][platform_key].as_i64().unwrap(),
            super::PLATFORM_CODE,
            "PLATFORM_CODE 必须等于 platform.{platform_key}"
        );
        assert_eq!(
            super::UPDATE_TYPE.parse::<i64>().unwrap(),
            super::PLATFORM_CODE,
            "UPDATE_TYPE 与 PLATFORM_CODE 必须同源（一个字符串一个数值）"
        );
    }

    /// 当前生效的后端必须是 app.config.json 里 active 指定的那一个
    #[test]
    fn default_base_url_follows_active() {
        let c = cfg();
        assert_eq!(s(&c["backend"]["active"]), super::ACTIVE_BACKEND);
        let want = match s(&c["backend"]["active"]) {
            "dev" => super::DEV_BASE_URL,
            "prod" => super::PROD_BASE_URL,
            other => panic!("backend.active 只能是 dev / prod，当前 {other}"),
        };
        assert_eq!(super::DEFAULT_BASE_URL, want);
    }

    /// 版本名与版本号必须自洽（1.0.7 ↔ 107）：只改一个是最容易犯的错
    #[test]
    fn version_code_matches_name() {
        let c = cfg();
        let name = s(&c["version"]["name"]);
        let mut it = name.split('.');
        let code = it.next().unwrap().parse::<i64>().unwrap() * 100
            + it.next().unwrap().parse::<i64>().unwrap() * 10
            + it.next().unwrap().parse::<i64>().unwrap();
        assert_eq!(
            code,
            super::VERSION_CODE,
            "version.name 与 version.code 不一致：{name} 应为 {code}"
        );
    }

    /// Cargo.toml 的版本（env! 取到）必须与配置一致 —— 防止有人只改了 Cargo.toml
    #[test]
    fn cargo_version_matches_config() {
        let c = cfg();
        assert_eq!(env!("CARGO_PKG_VERSION"), s(&c["version"]["name"]));
    }
}
`;
}

/** 把任意值写成 Rust 字符串字面量（私有值是外部输入，必须转义，否则能拼出坏代码） */
function rustStr(v) {
  return JSON.stringify(String(v ?? ""));
}

/** 私有域名后缀规范化：去掉前导点与大小写差异，空项丢弃 */
function normalizeSuffix(raw) {
  return String(raw).trim().replace(/^\.+/, "").toLowerCase();
}

/**
 * `src-tauri/src/private_config.rs` 的完整内容（**不提交**）。
 *
 * 与 `app_config.rs` 分开的理由：那是公开的、提交进仓库、参与 --check；
 * 这个是私有值编译出来的产物，有私有文件时本来就该和仓库版本不同，
 * 所以既不能混在一起（每次同步都会脏工作区），也不该被 --check 拦。
 */
function privateRustSource(local) {
  const base = typeof local.backendBaseUrl === "string" ? local.backendBaseUrl.trim() : "";
  const site = typeof local.officialSiteUrl === "string" ? local.officialSiteUrl.trim() : "";
  const domains = (local.ownDomains ?? []).map(normalizeSuffix).filter(Boolean);
  const list = domains.map((d) => `    ${rustStr(d)},`).join("\n");
  return `//! 由 \`scripts/sync-config.mjs\` 从 \`app.config.local.json\` 生成 —— **不要手改，也不要提交**。
//!
//! 这个文件承载的是**自有域名、生产后端地址、官网地址**。公开仓库里没有真值：
//! 没有 \`app.config.local.json\` 时这里全是空串，编译照常通过，只是线上能力不可用
//! （运行期 \`runtime_config\` 会打出可诊断的 ERROR）。
//!
//! 发布构建由 \`.github/workflows/release.yml\` 用仓库 Secret 生成
//! \`app.config.local.json\` 后再跑 \`pnpm config:sync\`；本地开发复制
//! \`app.config.local.json.example\` 填值即可。

/// 生产后端地址（形如 \`https://<自有域名>/api/v1/\`；空 = 未配置）
pub const BACKEND_BASE_URL: &str = ${rustStr(base)};

/// 官网地址（关于页的教程 / 协议 / 隐私 / 反馈入口；空 = 设置页不显示这几项）
pub const OFFICIAL_SITE_URL: &str = ${rustStr(site)};

/// 自有域名后缀（明文 http 放行的唯一依据；空数组 = 没有任何自有域名，
/// 于是所有明文下载都会被拒 —— 收紧而非放松，正是缺配置时想要的行为）
pub const OWN_DOMAINS: &[&str] = &[
${list}
];

/// 内存中直接覆盖自有域名后缀（调试 / 测试用，逗号分隔；留空则用 OWN_DOMAINS）
pub const OWN_DOMAINS_ENV: &str = "QT_OWN_DOMAINS";
`;
}

/**
 * 私有配置的**运行期护栏**：返回 `{ errors }`。
 *
 * 为什么不在这里 `process.exit(1)`：开发机本来就不需要生产地址，硬拦会让
 * `pnpm build` / `pnpm test` 直接不可用。所以这里只把问题报出来，
 * 由 `main()` 决定在写入模式下打 ERROR 日志、在 `--check` 下保持沉默
 * （`--check` 的语义是「派生文件是否与配置源一致」，与私有值无关）。
 */
export function privateReport(c, local) {
  const base = typeof local.backendBaseUrl === "string" ? local.backendBaseUrl.trim() : "";
  const site = typeof local.officialSiteUrl === "string" ? local.officialSiteUrl.trim() : "";
  const domains = (local.ownDomains ?? []).map(normalizeSuffix).filter(Boolean);
  const errors = [];
  if (String(c?.backend?.active ?? "prod") === "prod") {
    if (!base) {
      errors.push(
        "app.config.local.json 缺少 backendBaseUrl：本次构建没有生产后端地址" +
          "（应用能启动，但在线试听 / 登录 / 云同步全部不可用）。" +
          "补值后重跑 `pnpm config:sync` 并重新编译。",
      );
    }
    if (!site) {
      errors.push("app.config.local.json 缺少 officialSiteUrl：设置页的官网入口不会显示。");
    }
    if (domains.length === 0) {
      errors.push(
        "app.config.local.json 缺少 ownDomains：自有 CDN 的明文 http 下载地址会被拒" +
          "（更新安装包可能装不上）。",
      );
    }
  }
  return {
    errors,
    configured: { backend: !!base, site: !!site, domains: domains.length > 0 },
  };
}

/** 全部派生目标：每个规则 = 正则 + 替换（替换用函数，避免 $ 转义问题） */
function buildTargets(c) {
  return [
    {
      file: "package.json",
      desc: "前端包版本",
      rules: [
        {
          re: /^(\s*"version":\s*)"[^"]*"/m,
          to: (g) => `${g[1]}"${c.version.name}"`,
        },
      ],
    },
    {
      file: "src-tauri/tauri.conf.json",
      desc: "安装包/应用版本、产品名、ID、窗口标题、dev 端口",
      rules: [
        { re: /("productName":\s*)"[^"]*"/, to: (g) => `${g[1]}"${c.product.name}"` },
        { re: /^(\s*"version":\s*)"[^"]*"/m, to: (g) => `${g[1]}"${c.version.name}"` },
        { re: /("identifier":\s*)"[^"]*"/, to: (g) => `${g[1]}"${c.product.identifier}"` },
        { re: /("title":\s*)"[^"]*"/, to: (g) => `${g[1]}"${c.product.displayName}"` },
        {
          re: /("devUrl":\s*)"[^"]*"/,
          to: (g) => `${g[1]}"http://localhost:${c.devServer.port}"`,
        },
      ],
    },
    {
      file: "src-tauri/Cargo.toml",
      desc: "Rust crate 版本（env!(\"CARGO_PKG_VERSION\") 来源）",
      rules: [
        {
          // 只匹配 [package] 段内行首的 version（不会误伤 rust-version）
          re: /(\[package\][\s\S]*?\nversion = )"[^"]*"/,
          to: (g) => `${g[1]}"${c.version.name}"`,
        },
      ],
    },
    {
      file: "src-tauri/Cargo.lock",
      desc: "锁文件里的本包版本（不改会与 Cargo.toml 不一致）",
      rules: [
        {
          re: /(name = "quietmusic"\s*\nversion = )"[^"]*"/,
          to: (g) => `${g[1]}"${c.version.name}"`,
        },
      ],
    },
    {
      file: "src/source-scripts/source-update.ts",
      desc: "宿主契约版本（引擎包源码，值不变则不写盘）",
      rules: [
        {
          re: /(HOST_API_VERSION\s*=\s*)\d+/,
          to: (g) => `${g[1]}${c.sourcePack.hostApiVersion}`,
        },
      ],
    },
    {
      file: "src-tauri/src/app_config.rs",
      desc: "Rust 侧生成文件（常量 + 一致性单测）",
      whole: () => rustSource(c),
    },
    {
      // 私有值（自有域名 / 生产后端地址 / 官网地址）。**不参与 --check**：
      // 有 app.config.local.json 时它本来就与仓库里的版本不同，参与校验
      // 会让每台开发机 / 每次发版都报"不一致"。写入时照样只改真正变化的文件。
      file: "src-tauri/src/private_config.rs",
      desc: "私有配置生成物（自有域名 / 生产后端 / 官网；不校验）",
      skipCheck: true,
      whole: () => privateRustSource(loadLocalConfig()),
    },
  ];
}

/** 对单个目标算出「期望内容」 */
function expected(target, actual) {
  if (target.whole) return target.whole();
  let text = actual;
  for (const rule of target.rules) {
    const m = rule.re.exec(text);
    if (!m) throw new Error(`${target.file}: 找不到要替换的位置（正则未命中），请检查文件是否被改过`);
    text = text.replace(rule.re, (...args) => rule.to(args));
  }
  return text;
}

/** 核心：返回每个目标的状态（不落盘） */
export function plan(config = loadConfig()) {
  return buildTargets(config).map((t) => {
    const abs = path.join(ROOT, t.file);
    const actual = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    const want = expected(t, actual);
    // 行尾不敏感比较：Windows runner 的 git 全局 autocrlf=true 会在 checkout
    // 时把仓库里的 LF 转成 CRLF，内容其实一致——裸比较会让 CI 永远假红
    //（真实内容漂移两份归一后仍不等，照常报红）
    const changed =
      actual !== want &&
      actual.replace(/\r\n/g, "\n") !== want.replace(/\r\n/g, "\n");
    return { ...t, abs, actual, want, changed, missing: !fs.existsSync(abs) };
  });
}

/** 写入所有不一致的目标，返回改动列表 */
export function sync(config = loadConfig()) {
  const changed = [];
  for (const item of plan(config)) {
    if (!item.changed) continue;
    fs.writeFileSync(item.abs, item.want, "utf8");
    changed.push(item);
  }
  return changed;
}

/** 校验模式：返回不一致列表（空数组 = 全部一致；跳过 skipCheck 的私有产物） */
export function check(config = loadConfig()) {
  return plan(config).filter((i) => i.changed && !i.skipCheck);
}

/** `--check` 输出用的解释文案：私有配置缺值时把后果说清楚，而不是只报一个 exit 1 */
function printPrivateHints(config) {
  const { errors } = privateReport(config, loadLocalConfig());
  if (errors.length === 0) return;
  console.warn(`[config] 注意：本次构建没有完整的私有配置（${PRIVATE_FILE} 不存在或缺字段）：`);
  for (const e of errors) console.warn(`  - ${e}`);
}

function main() {
  const isCheck = process.argv.includes("--check");
  const config = loadConfig();
  const expectedCode = versionCodeOf(config.version.name);
  if (expectedCode !== config.version.code) {
    console.error(
      `[config] app.config.json 自相矛盾：version.name ${config.version.name} 对应 ${expectedCode}，` +
        `但 version.code 是 ${config.version.code}`,
    );
    process.exit(1);
  }

  if (isCheck) {
    // 私有配置缺失**不算不一致**：公开仓库 / CI 裸构建本来就该是空的。
    // 只提示后果；真正的强制在发版流程（release.yml 缺 Secret 直接 fail）。
    printPrivateHints(config);
    const bad = check(config);
    if (bad.length === 0) {
      console.log(`[config] 全部一致（版本 ${config.version.name} / ${config.version.code}）`);
      return;
    }
    console.error("[config] 以下派生文件与 app.config.json 不一致，请跑 `pnpm config:sync`：");
    for (const i of bad) console.error(`  - ${i.file}  (${i.desc})`);
    process.exit(1);
  }

  // 写盘顺序要紧：私有配置先生成，后面的 Rust 校验（cargo）才有 private_config.rs 可读。
  const changed = sync(config);
  const { configured } = privateReport(config, loadLocalConfig());
  console.log(
    `[config] 私有配置：后端 ${configured.backend ? "已注入" : "缺失"}` +
      ` / 官网 ${configured.site ? "已注入" : "缺失"}` +
      ` / 自有域名 ${configured.domains ? "已注入" : "缺失"}（源：${
        fs.existsSync(PRIVATE_FILE) ? "app.config.local.json" : "无（公开仓库形态）"
      }）`,
  );
  printPrivateHints(config);
  if (changed.length === 0) {
    console.log(`[config] 已是最新，无需改动（版本 ${config.version.name} / ${config.version.code}）`);
    return;
  }
  console.log(`[config] 已同步 ${changed.length} 个文件：`);
  for (const i of changed) console.log(`  - ${i.file}  (${i.desc})`);
}

// 作为脚本直接运行时才执行（被测试 import 时不执行）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
