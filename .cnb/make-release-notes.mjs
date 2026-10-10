#!/usr/bin/env node
/**
 * 生成 Release 描述文件（GitHub 发版和 CNB 镜像共用这一份，保证两边描述一致）。
 *
 * 用法：
 *   node .cnb/make-release-notes.mjs <安装包目录> <输出文件>
 *   例：node .cnb/make-release-notes.mjs artifacts release-notes.md
 *
 * 描述是写给普通用户看的，只回答一个问题：**我该下载哪个文件**。
 * 所以刻意不写这些东西：
 *   - 后台「版本更新」记录要填的 type / versionCode / downloadUrl / MD5 / fileSize
 *     （那是运营自己的活，不该出现在用户面前；需要时从 GitHub API 拉资产列表即可）
 *   - 每个文件的完整下载直链（页面上点一下就是，写一遍只是噪音）
 *   - 每个 .sig 的单独说明（只在最后提一句它是干嘛的）
 *
 * 输入目录里应当是本次构建的全部产物（GitHub 侧是 publish job 下载的 artifacts/，
 * CNB 侧是镜像流水线下载的 artifacts/），所以文件名两边完全一致。
 *
 * 环境变量：
 *   CNB_REPO_SLUG  有值 = 在 CNB 侧生成（默认 slug）
 *   GITHUB_REPOSITORY  在 GitHub Actions 里生成
 *   CNB_BRANCH / GITHUB_REF_NAME  tag
 */
import { readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [, , artifactsDir = "artifacts", outFile = "release-notes.md"] = process.argv;

const tag = (process.env.CNB_BRANCH || process.env.GITHUB_REF_NAME || process.env.GITHUB_TAG || "").trim();
const version = tag.replace(/^v/, "");
const cnbSlug = process.env.CNB_REPO_SLUG || "canace/qt-pc";
const ghRepo = process.env.GITHUB_REPOSITORY || "barry130/qt-pc";
const onCnb = Boolean(process.env.CNB_REPO_SLUG);

const dir = resolve(artifactsDir);
let all = [];
try {
  all = readdirSync(dir).filter((f) => !f.startsWith(".") && !f.endsWith(".part"));
} catch (err) {
  console.error(`读取产物目录失败：${dir}\n${err.message}`);
  process.exit(1);
}

/** 在本次产物里按后缀挑文件，取第一个；没有就返回空串 */
function pick(suffix) {
  return all.find((f) => f.endsWith(suffix)) || "";
}

const winExes = all.filter((f) => f.endsWith("-setup.exe"));
if (winExes.length === 0) {
  console.error(`产物目录里没有 *-setup.exe：${dir}`);
  process.exit(1);
}

/** `QuietMusic_1.1.2_x64-setup.exe` → `x64` */
function archOf(name) {
  return /_(x64|x86|arm64)-setup\.exe$/.exec(name)?.[1] || "";
}
const exe = (arch) => winExes.find((f) => archOf(f) === arch) || "";
const deb = pick(".deb");
const appImage = pick(".AppImage");
const dmg = pick(".dmg");

const WINDOWS_ROWS = [
  ["64 位 Intel／AMD（绝大多数电脑）", exe("x64")],
  ["32 位老机器", exe("x86")],
  ["ARM 笔记本（骁龙 X 等）", exe("arm64")],
].filter(([, f]) => f);

const LINUX_ROWS = [
  ["Debian / Ubuntu / 深度等", deb],
  ["任何 x86_64 Linux（免安装）", appImage],
].filter(([, f]) => f);

function table(rows) {
  return [
    "| 你的系统 | 下载这个 |",
    "|---|---|",
    ...rows.map(([k, f]) => `| ${k} | \`${f}\` |`),
    "",
  ];
}

const lines = [`# 轻听 ${version}`, ""];

// 镜像提示：GitHub 那边提醒换 CNB，CNB 这边就别自我指涉了。
if (!onCnb) {
  lines.push(
    `> 下载慢的话换 [CNB 镜像](https://cnb.cool/${cnbSlug}/-/releases/tag/${tag})，` +
      `两边文件完全相同（安装包由 GitHub Actions 构建，CNB 只做镜像）。`,
    "",
  );
}

lines.push(
  "## 该下载哪个",
  "",
  "在下面的「附件（Assets）」里点文件名即可。",
  "",
);

if (WINDOWS_ROWS.length) {
  lines.push(
    "### Windows",
    "",
    ...table(WINDOWS_ROWS),
    "不知道架构？按 `Win + Pause` 打开「系统」页，看「系统类型」。",
    "",
  );
}

if (dmg) {
  lines.push(
    "### macOS",
    "",
    ...table([["Apple Silicon（M 系列）", dmg]]),
    "Intel Mac 暂时没有现成的包，需要在 Intel Mac 上本地打包。",
    "",
  );
}

if (LINUX_ROWS.length) {
  lines.push("### Linux", "", ...table(LINUX_ROWS));
}

lines.push(
  "## 其它",
  "",
  "- 每个 Windows 安装包旁边还有一个同名的 `.sig` 文件，那是给**应用内自动更新**验签用的。" +
    "你手动下载安装的话不用管它。",
  "- macOS 的 dmg **没有签名也没有公证**，所以第一次打开会提示「已损坏，无法打开」，这是正常的：" +
    "在访达里右键点 App →「打开」，再点一次「打开」；" +
    "或者终端执行 `xattr -dr com.apple.quarantine /Applications/QuietMusic.app`。",
  "- Linux 的包不支持应用内自动更新，下载后手动安装。deb 需要 glibc 2.32 及以上" +
    "（Ubuntu 22.04 / Debian 12 都没问题），发行版太老就用 AppImage。",
  "",
);

writeFileSync(outFile, lines.join("\n"), "utf8");
console.log(
  `已写出 ${outFile}（Windows ${winExes.length} 个安装包` +
    (LINUX_ROWS.length ? ` + Linux ${LINUX_ROWS.length} 个包` : "") +
    (dmg ? " + macOS 1 个 dmg" : "") +
    "）",
);