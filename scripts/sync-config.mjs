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
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 单一配置源路径 */
export const CONFIG_FILE = path.join(ROOT, "app.config.json");

/** 读取并做最基本的形状校验 */
export function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  for (const key of ["product", "version", "sourcePack", "backend", "platform", "devServer"]) {
    if (!cfg[key]) throw new Error(`app.config.json 缺字段: ${key}`);
  }
  if (!["dev", "prod"].includes(cfg.backend.active)) {
    throw new Error(`app.config.json: backend.active 只能是 dev 或 prod，当前 ${cfg.backend.active}`);
  }
  return cfg;
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
/// 升级接口比对用的版本号（后端 type=1103 的 version 参数）
pub const VERSION_CODE: i64 = ${c.version.code};

/// 内嵌音源包版本号（镜像后端最新发布号；与 source-update.ts 同源）
pub const SOURCE_PACK_CODE: i64 = ${c.sourcePack.code};
/// 内嵌音源包版本名
pub const SOURCE_PACK_NAME: &str = "${c.sourcePack.name}";
/// 宿主契约版本（音源包与本机的接口版本，两端同步抬高）
pub const HOST_API_VERSION: i64 = ${c.sourcePack.hostApiVersion};

/// 本地联调后端
pub const DEV_BASE_URL: &str = "${c.backend.dev}";
/// 线上后端
pub const PROD_BASE_URL: &str = "${c.backend.prod}";
/// 当前生效的后端地址：由 app.config.json 的 \`backend.active\` 决定（${c.backend.active}）
pub const DEFAULT_BASE_URL: &str = ${active};

/// 更新接口的平台号（1103 = Windows）
pub const UPDATE_TYPE: &str = "${c.platform.windows}";
/// 反馈接口的 X-Platform 头
pub const FEEDBACK_PLATFORM: &str = "${c.feedback.platform}";

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
        assert_eq!(c["sourcePack"]["code"].as_i64().unwrap(), super::SOURCE_PACK_CODE);
        assert_eq!(s(&c["sourcePack"]["name"]), super::SOURCE_PACK_NAME);
        assert_eq!(
            c["sourcePack"]["hostApiVersion"].as_i64().unwrap(),
            super::HOST_API_VERSION
        );
        assert_eq!(s(&c["backend"]["dev"]), super::DEV_BASE_URL);
        assert_eq!(s(&c["backend"]["prod"]), super::PROD_BASE_URL);
        assert_eq!(
            c["platform"]["windows"].as_i64().unwrap().to_string(),
            super::UPDATE_TYPE,
            "UPDATE_TYPE 必须等于 platform.windows（JSON 里是数字，Rust 侧是字符串）"
        );
        assert_eq!(s(&c["feedback"]["platform"]), super::FEEDBACK_PLATFORM);
    }

    /// 当前生效的后端必须是 app.config.json 里 active 指定的那一个
    #[test]
    fn default_base_url_follows_active() {
        let c = cfg();
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
      desc: "音源包内置版本 + 宿主契约版本（引擎包源码，值不变则不写盘）",
      rules: [
        {
          re: /(BUILTIN_SOURCE_VERSION\s*=\s*\{\s*code:\s*)\d+(,\s*name:\s*)"[^"]*"/,
          to: (g) => `${g[1]}${c.sourcePack.code}${g[2]}"${c.sourcePack.name}"`,
        },
        {
          re: /(HOST_API_VERSION\s*=\s*)\d+/,
          to: (g) => `${g[1]}${c.sourcePack.hostApiVersion}`,
        },
      ],
    },
    {
      file: "src-tauri/builtin-sources/version.json",
      desc: "内嵌音源包版本清单（Rust include_str! 读它）",
      whole: () => JSON.stringify({ code: c.sourcePack.code, name: c.sourcePack.name }, null, 2) + "\n",
    },
    {
      file: "src-tauri/src/app_config.rs",
      desc: "Rust 侧生成文件（常量 + 一致性单测）",
      whole: () => rustSource(c),
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
    return { ...t, abs, actual, want, changed: actual !== want, missing: !fs.existsSync(abs) };
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

/** 校验模式：返回不一致列表（空数组 = 全部一致） */
export function check(config = loadConfig()) {
  return plan(config).filter((i) => i.changed);
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
    const bad = check(config);
    if (bad.length === 0) {
      console.log(`[config] 全部一致（版本 ${config.version.name} / ${config.version.code}）`);
      return;
    }
    console.error("[config] 以下派生文件与 app.config.json 不一致，请跑 `pnpm config:sync`：");
    for (const i of bad) console.error(`  - ${i.file}  (${i.desc})`);
    process.exit(1);
  }

  const changed = sync(config);
  if (changed.length === 0) {
    console.log(`[config] 已是最新，无需改动（版本 ${config.version.name} / ${config.version.code}）`);
    return;
  }
  console.log(`[config] 已从 app.config.json 同步 ${changed.length} 个文件：`);
  for (const i of changed) console.log(`  - ${i.file}  (${i.desc})`);
}

// 作为脚本直接运行时才执行（被测试 import 时不执行）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
