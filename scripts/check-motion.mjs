#!/usr/bin/env node
/**
 * UI 令牌守卫：防止字号 / 动效 / 阴影三套令牌被"随手写死的样式"慢慢蚕食。
 *
 * 为什么需要它：一次性写死的小字号与时长单看都无害，但它们会各写各的数值 ——
 * 同一个"次级说明"在十个文件里能长出十个字号，动效时长从 120ms 到 400ms
 * 随机分布，全局观感就成了"拼起来的"。令牌化之后（text-2xs / duration-base /
 * ease-soft），必须有机器看守，否则下一次加页面又被复制粘贴的旧写法带回去。
 *
 * 规则（只扫 src 下的 .ts/.tsx）：
 *   1. 禁止任意值字号  text-[NNpx]  → 用 text-3xs / text-2xs / text-xs 及以上
 *   2. 禁止裸写时长    duration-NNN → 用 duration-fast / duration-base / duration-slow
 *   3. 禁止裸写缓动    ease-in-out / ease-in / ease-out → 用 ease-soft / ease-expo
 *
 * 输出：违规逐条列出（文件:行 + 片段），有违规退出码 1。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");

/** 只扫这些扩展名 */
const EXTENSIONS = new Set([".ts", ".tsx"]);

const RULES = [
  {
    id: "raw-text-size",
    pattern: /text-\[[0-9.]+px\]/g,
    hint: "字号用令牌：字号用令牌：text-3xs",
  },
  {
    id: "raw-duration",
    pattern: /\bduration-(?:[1-9][0-9]{1,2}|1[0-9]{3})\b/g,
    hint: "时长用令牌：duration-fast / duration-base / duration-slow",
  },
  {
    id: "raw-easing",
    pattern: /\bease-(?:in-out|in|out)\b/g,
    hint: "缓动用令牌：ease-soft（入场）/ ease-expo（位移）",
  },
];

const violations = [];

/** 递归收集待扫文件 */
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walk(full);
      continue;
    }
    if (!EXTENSIONS.has(path.extname(entry.name))) continue;
    checkFile(full);
  }
}

function checkFile(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const rule of RULES) {
    lines.forEach((line, index) => {
      // 注释行整行跳过：注释里举反例是正常的表达方式
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      // 正则带 g，逐行使用前必须重置 lastIndex，否则第二行起会漏匹配
      rule.pattern.lastIndex = 0;
      const match = rule.pattern.exec(line);
      if (match === null) return;
      violations.push({
        file: path.relative(ROOT, file).split(path.sep).join("/"),
        line: index + 1,
        snippet: match[0],
        rule: rule.id,
        hint: rule.hint,
      });
    });
  }
}

walk(SRC);

if (violations.length === 0) {
  console.log("[check-motion] 字号/动效令牌检查通过（0 违规）");
  process.exit(0);
}

console.error(`[check-motion] 发现 ${violations.length} 处硬编码样式，请改用设计令牌：`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  ${v.snippet}  →  ${v.hint}`);
}
process.exit(1);
