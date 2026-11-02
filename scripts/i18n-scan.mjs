#!/usr/bin/env node
/**
 * 中文硬编码扫描（B6 第二轮，DESIGN R84）。
 *
 * 为什么要有这个脚本：i18n 第一轮只覆盖了侧边栏/播放条/窗口按钮，正文页面里
 * 还散着大量中文。靠人眼一条条找不可靠，也没有「别再新增」的闸门。这个脚本做两件事：
 *
 * 1. `npm run i18n:scan`   — 打印每个文件还有多少行面向用户的中文（含前 20 名）。
 * 2. `npm run i18n:check`  — 对基线 `scripts/i18n-baseline.json` 做棘轮检查：
 *                            只允许变少，不允许变多；新增文件若带中文也算回归。
 *
 * 计数口径（故意保守）：
 * - 只算「非注释行里含汉字」的行；整行注释、块注释里的中文是写给开发者看的，不算。
 * - 字典文件 `src/lib/i18n.ts` 与 `src/lib/i18n-fragments/**` 本身不计（那里当然全是中文）。
 * - 行内尾注释 `const a = 1; // 中文` 会被算进去 —— 宁可高估，不要漏。
 *
 * 基线更新：`node scripts/i18n-scan.mjs --write`（翻译掉一批之后跑一次，把闸门跟上去）。
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const BASELINE = join(ROOT, "scripts", "i18n-baseline.json");
const DICTIONARY = join(SRC, "lib", "i18n.ts");
const FRAGMENT_DIR = join(SRC, "lib", "i18n-fragments") + sep;

const HAN = /\p{Script=Han}/u;

/** 递归列出 src 下所有 ts/tsx（跳过字典文件与分片字典） */
function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      out.push(...collectFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (full === DICTIONARY) continue;
    // 分片字典（B6 续）：和 i18n.ts 同性质，词条本来就得是中文
    if (full.startsWith(FRAGMENT_DIR)) continue;
    out.push(full);
  }
  return out;
}

/** 统计一个文件里「面向用户的中文行数」 */
function countChineseLines(file) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  let count = 0;
  let inBlockComment = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (HAN.test(line)) count += 1;
  }
  return count;
}

function scan() {
  const files = {};
  let total = 0;
  for (const file of collectFiles(SRC)) {
    const count = countChineseLines(file);
    if (count === 0) continue;
    const key = relative(ROOT, file).split(sep).join("/");
    files[key] = count;
    total += count;
  }
  return { files, total };
}

function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE, "utf8"));
  } catch {
    return null;
  }
}

const args = process.argv.slice(2);
const current = scan();
const sorted = Object.entries(current.files).sort((a, b) => b[1] - a[1]);

if (args.includes("--write")) {
  const payload = {
    generatedAt: new Date().toISOString(),
    total: current.total,
    files: Object.fromEntries(Object.entries(current.files).sort()),
  };
  writeFileSync(BASELINE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`已写入基线：${relative(ROOT, BASELINE)}（${current.total} 行 / ${sorted.length} 个文件）`);
  process.exit(0);
}

if (args.includes("--json")) {
  console.log(JSON.stringify({ total: current.total, files: current.files }, null, 2));
  process.exit(0);
}

if (args.includes("--check")) {
  const baseline = readBaseline();
  if (!baseline) {
    console.error(`找不到基线 ${relative(ROOT, BASELINE)}，先跑一次 --write`);
    process.exit(1);
  }
  const regressions = [];
  for (const [file, count] of Object.entries(current.files)) {
    const before = baseline.files[file] ?? 0;
    if (count > before) regressions.push(`${file}: ${before} → ${count}（+${count - before}）`);
  }
  if (current.total > baseline.total) {
    regressions.push(`总计: ${baseline.total} → ${current.total}（+${current.total - baseline.total}）`);
  }
  if (regressions.length > 0) {
    console.error("i18n 硬编码中文变多了（新增文案请走 lib/i18n 词条）：");
    for (const line of regressions) console.error(`  · ${line}`);
    process.exit(1);
  }
  const improved = baseline.total - current.total;
  console.log(
    improved > 0
      ? `i18n 检查通过：比基线少 ${improved} 行（${current.total} / ${baseline.total}），可以跑 --write 收紧基线`
      : `i18n 检查通过：${current.total} 行，与基线持平`,
  );
  process.exit(0);
}

console.log(`面向用户的中文硬编码：${current.total} 行，分布在 ${sorted.length} 个文件`);
for (const [file, count] of sorted.slice(0, 20)) {
  console.log(`  ${String(count).padStart(5)}  ${file}`);
}
if (sorted.length > 20) console.log(`  …另外 ${sorted.length - 20} 个文件`);
const baseline = readBaseline();
if (baseline) {
  const delta = current.total - baseline.total;
  console.log(delta === 0 ? "与基线持平" : delta > 0 ? `比基线多 ${delta} 行` : `比基线少 ${-delta} 行`);
}
