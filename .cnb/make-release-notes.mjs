#!/usr/bin/env node
/**
 * 生成 CNB Release 的描述文件（镜像 GitHub Release 时用）。
 *
 * 用法：
 *   node .cnb/make-release-notes.mjs <安装包目录> <输出文件>
 *   例：node .cnb/make-release-notes.mjs artifacts release-notes.md
 *
 * 为什么要有这个脚本
 * ------------------
 * 应用内更新走的是后端 `astral` 的 `app_update`，后台「版本更新」记录需要手填
 * downloadUrl / MD5 / fileSize 三个字段。GitHub 侧的 release.yml 是把这三项写进
 * Release 描述里，发布时对照着填；CNB 侧沿用同一约定。
 *
 * 输入目录里应当是从 GitHub Release 原样下载下来的全部产物（镜像流水线
 * .cnb.yml 的 v* tag_push 会这么做），所以 MD5 / fileSize 与 GitHub 侧一致。
 *
 * 下载地址用 CNB 的公开直链模板：
 *   https://cnb.cool/<仓库 slug>/-/releases/download/<tag>/<文件名>
 * （该路径由 CNB Release 附件提供，安装包与同名的 .sig 必须在同一地址，
 *   宿主 `commands.rs` 里是直接 `format!("{}.sig", final_url)` 拼出来的。）
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [, , artifactsDir = "artifacts", outFile = "release-notes.md"] = process.argv;

const slug = process.env.CNB_REPO_SLUG || "canace/qt-pc";
const tag = process.env.CNB_BRANCH || process.env.CNB_TAG || process.env.TAG || "";

/** 从产物名 `QuietMusic_1.1.0_x64-setup.exe` 里取架构后缀 */
function archOf(name) {
  const m = /_(x64|x86|arm64)-setup\.exe$/.exec(name);
  if (!m) return "";
  return m[1];
}

/** 从产物名 `QuietMusic_1.1.0_aarch64.dmg` 里取 macOS 架构后缀（无后缀即 x64） */
function macArchOf(name) {
  if (!name.endsWith(".dmg")) return "";
  const m = /_(aarch64|x64)\.dmg$/.exec(name);
  return m ? m[1] : "";
}

const ARCH_LABEL = {
  x64: "x64（64 位 Intel／AMD，绝大多数电脑）",
  x86: "x86（32 位，老机器）",
  arm64: "ARM64（骁龙 X 等 ARM 笔记本）",
};

const dir = resolve(artifactsDir);
let names = [];
let linuxNames = [];
let macNames = [];
try {
  const all = readdirSync(dir);
  names = all.filter((f) => f.endsWith("-setup.exe"));
  linuxNames = all.filter((f) => f.endsWith(".deb") || f.endsWith(".AppImage"));
  macNames = all.filter((f) => f.endsWith(".dmg"));
} catch (err) {
  console.error(`读取产物目录失败：${dir}\n${err.message}`);
  process.exit(1);
}

// 固定 x64 → x86 → arm64 的顺序，别让文件系统顺序影响阅读
const ORDER = ["x64", "x86", "arm64"];
names.sort((a, b) => ORDER.indexOf(archOf(a)) - ORDER.indexOf(archOf(b)));
macNames.sort();

if (names.length === 0) {
  console.error(`产物目录里没有 *-setup.exe：${dir}`);
  process.exit(1);
}

/** 列出「下载地址 / MD5 / fileSize」三件套 */
function assetBlock(name) {
  const path = join(dir, name);
  const buf = readFileSync(path);
  const md5 = createHash("md5").update(buf).digest("hex");
  const size = statSync(path).size;
  return [
    `- 文件：\`${name}\``,
    `- 下载地址：https://cnb.cool/${slug}/-/releases/download/${tag}/${name}`,
    `- MD5：${md5}`,
    `- fileSize：${size}`,
  ];
}

const hasExtra = linuxNames.length > 0 || macNames.length > 0;
const lines = [
  hasExtra
    ? `# 轻听安装包（Windows / Linux / macOS）${tag}`
    : `# 轻听 Windows 安装包 ${tag}`,
  "",
  "> 本 Release 的安装包由 GitHub Actions 构建（`.github/workflows/release.yml`），",
  "> CNB 只做镜像，两侧文件逐字节相同：",
  `> <https://github.com/${process.env.GITHUB_REPO || "barry130/qt-pc"}/releases/tag/${tag}>`,
  "",
  "## 安装包信息（建后端更新记录用）",
  "",
];

for (const name of names) {
  const arch = archOf(name);
  lines.push(
    `### ${ARCH_LABEL[arch] || arch || name}`,
    "",
    ...assetBlock(name),
    "",
  );
}

lines.push(
  "## 说明",
  "",
  "- 每个安装包都有一个同名的 `.sig` 签名文件，**必须一起下载／上传**；",
  "  应用内更新会在安装前强制验签（ed25519），缺 `.sig` 或签名不符会直接拒绝。",
  "- 后台「版本更新」新增记录时：`type` 填 `1103`（Windows），",
  "  `versionCode` / `versionName` 与本次 tag 一致，其余三项照抄上面。",
  "",
);

// Linux 原生包（无 .sig：不做应用内自装，浏览器下载手动安装）
if (linuxNames.length > 0) {
  lines.push(
    "## Linux 包（amd64）",
    "",
    "- 不参与应用内自装更新（Linux 端从浏览器下载手动安装），没有 `.sig`；",
    "- `deb` 适配 Debian / Ubuntu / 深度等；`AppImage` 免安装，下载后 `chmod +x` 直接运行；",
    "- deb 在 ubuntu-22.04 上构建，glibc 下限比 Debian 系发行版友好；",
    "- 后台「版本更新」新增记录时：`type` 填 `1104`（Linux），downloadUrl / MD5 /",
    "  fileSize 照抄下面对应条目（若后端暂未开通 Linux 更新记录可先不建）。",
    "",
  );
  for (const name of linuxNames) {
    lines.push(`### ${name}`, "", ...assetBlock(name), "");
  }
}

// macOS dmg（无签名无公证：不做应用内自装，首次打开需手动放行）
if (macNames.length > 0) {
  lines.push(
    "## macOS 包",
    "",
    "- **无签名、无公证**（决策：不公签），且不参与应用内自装更新；",
    "- 首次打开会报「已损坏，无法打开」/「无法验证开发者」，这是预期的：",
    "  下载后右键 App →「打开」→ 再点「打开」；",
    "  或终端执行 `xattr -dr com.apple.quarantine /Applications/QuietMusic.app`；",
    "- CI 产出的 dmg 是 Apple Silicon（aarch64）。Intel（x64）机器需要 `_<x64>.dmg`，",
    "  请在 Intel Mac 上本地执行 `pnpm exec tauri build --runner cargo --bundles app,dmg` 打包。",
    "",
  );
  for (const name of macNames) {
    const a = macArchOf(name);
    lines.push(
      `### ${a ? (a === "aarch64" ? "aarch64（Apple Silicon）" : "x64（Intel）") : name}`,
      "",
      ...assetBlock(name),
      "",
    );
  }
}

writeFileSync(outFile, lines.join("\n"), "utf8");
console.log(
  `已写出 ${outFile}（Windows ${names.length} 个安装包` +
    (linuxNames.length > 0 ? ` + Linux ${linuxNames.length} 个包` : "") +
    (macNames.length > 0 ? ` + macOS ${macNames.length} 个 dmg` : "") +
    "）",
);
