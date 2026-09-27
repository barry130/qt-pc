/**
 * 内置音源包体检（**只读**，不写任何文件）。
 *
 * 用法：npm run builtin:check
 *
 * 为什么需要一个"只读"的检查而不是又一个写入器：`version.json` 是
 * `scripts/sync-config.mjs` 的 7 个派生文件之一，`pnpm config:sync` 已经会写它。
 * 再写一遍只是重复，而且掩盖了真正会出问题的地方 —— **产物本身可能在、也可能不在**：
 * 内置包由独立工程 `../qt-sources` 构建后交付进来，忘了跑构建就会出现
 * "version.json 指着一个不存在的包"或"包是上一版的内容、号却是新号"的状态。
 * 这两种情况都不会被 `config:check` 发现（它只管配置文件之间是否自洽），
 * 而它们正好是发布前最容易漏、代价最大的一步（同号换内容 / 号物不符）。
 *
 * 检查项：
 * 1. 三个文件都在（source-bundle.js / chain.json / version.json）
 * 2. version.json ↔ src/source-scripts/source-update.ts 的 BUILTIN_SOURCE_VERSION
 * 3. version.json ↔ src-tauri/src/app_config.rs 的 SOURCE_PACK_CODE / NAME
 * 4. chain.json 能解析（报 chainRevision，便于和发布说明比对）
 * 5. 打印 bundle 的 SHA256 与字节数（发布说明里要记的就是这两个值）
 *
 * 失败即非零退出，可直接挂进 CI 或 `pnpm test`。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(project, "src-tauri", "builtin-sources");

const errors = [];
const notes = [];

function read(rel) {
  const p = path.join(project, rel);
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    errors.push(`读不到 ${rel}`);
    return "";
  }
}

// ---- 1. 三个文件都在 ----
const ARTIFACTS = ["source-bundle.js", "chain.json", "version.json"];
const missing = ARTIFACTS.filter((f) => !fs.existsSync(path.join(dir, f)));
if (missing.length > 0) {
  errors.push(
    `内置音源包不完整，缺 ${missing.join(" / ")}：先到 ../qt-sources 跑 pnpm build` +
      `（或在本仓跑 pnpm sources:build），它会交付 source-bundle.js 与 chain.json`,
  );
}

// ---- 2. version.json ↔ source-update.ts ----
const versionJson = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "version.json"), "utf8"));
  } catch {
    errors.push("src-tauri/builtin-sources/version.json 不是合法 JSON");
    return null;
  }
})();

const updateSrc = read("src/source-scripts/source-update.ts");
const updateMatch = updateSrc.match(
  /BUILTIN_SOURCE_VERSION\s*=\s*\{\s*code:\s*(\d+),\s*name:\s*"([^"]+)"/,
);
if (!updateMatch) {
  errors.push("source-update.ts 里找不到 BUILTIN_SOURCE_VERSION（正则未命中，文件被改得不像样了？）");
} else if (versionJson !== null) {
  const code = Number(updateMatch[1]);
  const name = updateMatch[2];
  if (versionJson.code !== code || versionJson.name !== name) {
    errors.push(
      `号不一致：version.json = ${versionJson.code}/${versionJson.name}，` +
        `source-update.ts = ${code}/${name}（跑 pnpm config:sync 对齐）`,
    );
  }
}

// ---- 3. version.json ↔ app_config.rs ----
const appConfigRs = read("src-tauri/src/app_config.rs");
const codeMatch = appConfigRs.match(/SOURCE_PACK_CODE:\s*i64\s*=\s*(\d+)/);
const nameMatch = appConfigRs.match(/SOURCE_PACK_NAME:\s*&str\s*=\s*"([^"]+)"/);
if (!codeMatch || !nameMatch) {
  errors.push("app_config.rs 里找不到 SOURCE_PACK_CODE / SOURCE_PACK_NAME");
} else if (versionJson !== null) {
  if (versionJson.code !== Number(codeMatch[1]) || versionJson.name !== nameMatch[1]) {
    errors.push(
      `号不一致：version.json = ${versionJson.code}/${versionJson.name}，` +
        `app_config.rs = ${codeMatch[1]}/${nameMatch[1]}（跑 pnpm config:sync 对齐）`,
    );
  }
}

// ---- 4. chain.json 可解析 ----
let chainRevision = null;
try {
  const chain = JSON.parse(fs.readFileSync(path.join(dir, "chain.json"), "utf8"));
  chainRevision = chain.chainRevision;
  if (typeof chainRevision !== "number") errors.push("chain.json 缺 chainRevision");
} catch {
  errors.push("src-tauri/builtin-sources/chain.json 不是合法 JSON");
}

// ---- 5. 指纹（发布说明要记的值）----
let bundleInfo = null;
try {
  const buf = fs.readFileSync(path.join(dir, "source-bundle.js"));
  bundleInfo = {
    bytes: buf.length,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    md5: crypto.createHash("md5").update(buf).digest("hex"),
  };
} catch {
  // 文件缺失已在上面的 errors 里报过，这里不再重复
}

// ---- 输出 ----
if (errors.length > 0) {
  console.error("[builtin:check] ❌ 内置音源包体检未通过：");
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}

if (bundleInfo !== null) {
  notes.push(`source-bundle.js  ${(bundleInfo.bytes / 1024).toFixed(0)} KB`);
  notes.push(`  sha256  ${bundleInfo.sha256}`);
  notes.push(`  md5     ${bundleInfo.md5}`);
}
notes.push(`chainRevision  ${chainRevision}`);

console.log(
  `[builtin:check] ✅ 内置音源包齐备且同号：v${versionJson.name} (code ${versionJson.code})`,
);
for (const n of notes) console.log("[builtin:check]   " + n);
console.log(
  "[builtin:check] 上面两个哈希就是发布说明里要记的产物指纹；换号后它们必须变。",
);
