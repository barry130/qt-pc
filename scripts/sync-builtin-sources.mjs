/**
 * 把 dist-sources 构建产物同步为 PC 内置音源包（src-tauri/builtin-sources/）。
 *
 * 用法：npm run sync:builtin（先跑 npm run build:sources 产出 dist-sources）。
 *
 * 版本号单源于 src/source-scripts/source-update.ts 的 BUILTIN_SOURCE_VERSION
 * （镜像后端最新发布的发号，同号同物）：本脚本读出它写入 version.json，
 * Rust 以 include_bytes! 把三个文件编进二进制，引擎页在未安装远程包 /
 * 远程包加载失败时经 qtres /builtin/ 加载。换号必须先改 source-update.ts
 * 再跑本脚本，勿手改产物。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(project, "dist-sources");
const out = path.join(project, "src-tauri", "builtin-sources");

const src = fs.readFileSync(
  path.join(project, "src/source-scripts/source-update.ts"),
  "utf8",
);
const m = src.match(
  /BUILTIN_SOURCE_VERSION\s*=\s*\{\s*code:\s*(\d+),\s*name:\s*"([^"]+)"/,
);
if (!m) throw new Error("source-update.ts 里找不到 BUILTIN_SOURCE_VERSION");
const code = Number(m[1]);
const name = m[2];

fs.mkdirSync(out, { recursive: true });
for (const file of ["source-bundle.js", "chain.json"]) {
  const from = path.join(dist, file);
  if (!fs.existsSync(from)) {
    throw new Error(`缺 dist-sources/${file}：先跑 npm run build:sources`);
  }
  fs.copyFileSync(from, path.join(out, file));
}
fs.writeFileSync(
  path.join(out, "version.json"),
  JSON.stringify({ code, name }, null, 2) + "\n",
);
console.log(`[sync:builtin] 内置音源包已同步: v${name} (code ${code}) → src-tauri/builtin-sources/`);
