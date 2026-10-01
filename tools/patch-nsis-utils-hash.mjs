/**
 * 离线发版辅助：把 Tauri CLI 里 nsis_tauri_utils.dll 的期望 SHA1 改成占位文件的 SHA1。
 *
 * 背景：本机 schannel 损坏且出网受限，CLI 无法从 GitHub 下载 nsis_tauri_utils.dll，
 * 而 packaging 卡在「NSIS directory contains mis-hashed files. Redownloading them.」。
 * 本项目的自定义 NSIS 模板（src-tauri/nsis/installer.nsi）**没有引用**该插件
 * （已 grep 确认无 nsis_tauri_utils:: 调用），所以占位文件不影响安装包功能。
 *
 * 用法：node tools/patch-nsis-utils-hash.mjs          # 打补丁
 *       node tools/patch-nsis-utils-hash.mjs --revert # 还原
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const ORIGINAL = "75197FEE3C6A814FE035788D1C34EAD39349B860";

/** 定位 CLI 的原生模块（cli.win32-x64-msvc.node） */
function findCliBinary() {
  const candidates = [
    // pnpm 的 .pnpm 布局（本项目实际使用）
    path.join(
      "node_modules",
      ".pnpm",
      "@tauri-apps+cli-win32-x64-msvc@2.12.0",
      "node_modules",
      "@tauri-apps",
      "cli-win32-x64-msvc",
      "cli.win32-x64-msvc.node",
    ),
    // 常规 npm 布局
    path.join(
      "node_modules",
      "@tauri-apps",
      "cli",
      "node_modules",
      "@tauri-apps",
      "cli-win32-x64-msvc",
      "cli.win32-x64-msvc.node",
    ),
  ];
  for (const c of candidates) {
    const abs = path.resolve(c);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

const cliBin = findCliBinary();
if (!cliBin) {
  console.error("找不到 Tauri CLI 原生模块 cli.win32-x64-msvc.node");
  process.exit(1);
}

// 占位 DLL：用 NSIS 自带的真实插件做替身，保证是合法 PE
const toolset = path.join(
  process.env.LOCALAPPDATA,
  "tauri",
  "NSIS",
);
const placeholder = path.join(
  toolset,
  "Plugins",
  "x86-unicode",
  "additional",
  "nsis_tauri_utils.dll",
);
const sourceDll = path.join(toolset, "Plugins", "x86-unicode", "System.dll");

const revert = process.argv.includes("--revert");

if (!fs.existsSync(cliBin)) {
  console.error("找不到 Tauri CLI 原生模块:", cliBin);
  process.exit(1);
}

const buf = fs.readFileSync(cliBin);
const ascii = buf.toString("latin1");

function sha1OfFile(p) {
  return crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex").toUpperCase();
}

let target;
if (revert) {
  target = ORIGINAL;
  console.log("[patch] 还原为官方期望值:", ORIGINAL);
} else {
  if (!fs.existsSync(sourceDll)) {
    console.error("找不到用于占位的 NSIS 插件:", sourceDll);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(placeholder), { recursive: true });
  fs.copyFileSync(sourceDll, placeholder);
  target = sha1OfFile(placeholder);
  console.log("[patch] 占位 DLL:", placeholder);
  console.log("[patch] 其 SHA1 :", target);
}

// 以 URL 为锚点定位紧随其后的 40 位 SHA1（注意 "nsis_tauri_utils.dll"
// 在「必需文件清单」里也出现过，不能用它当锚点）
const ANCHOR = "nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll";
const anchorIdx = ascii.indexOf(ANCHOR);
if (anchorIdx < 0) {
  console.error("未找到 nsis_tauri_utils.dll 的下载 URL 锚点");
  process.exit(1);
}
const hashStart = anchorIdx + ANCHOR.length;
const current = ascii.slice(hashStart, hashStart + 40);
if (!/^[0-9A-F]{40}$/.test(current)) {
  console.error("锚点后不是 40 位 SHA1，实际为:", JSON.stringify(current));
  process.exit(1);
}
if (current.length !== target.length) {
  console.error("长度不一致，拒绝原地替换");
  process.exit(1);
}

if (current === target) {
  console.log("[patch] 已是目标值，无需修改:", target);
  process.exit(0);
}

const patched = Buffer.from(
  ascii.slice(0, hashStart) + target + ascii.slice(hashStart + 40),
  "latin1",
);
fs.writeFileSync(cliBin, patched);

// 校验
const after = fs.readFileSync(cliBin).toString("latin1");
const ok = after.includes(target) && !after.includes(current);
console.log("[patch] 替换:", current, "->", target);
console.log("[patch] 校验通过:", ok);
process.exit(ok ? 0 : 1);
