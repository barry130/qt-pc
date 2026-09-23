/**
 * 逐线路裁决表 —— 把 diag-live-rank.mjs 的原始 JSON 汇总成「该不该删这条线路」的依据。
 *
 * diag-live-rank.mjs 每跑一批源就写一份 diag-live-rank-<标签>.json（标签默认是平台号，
 * 传了自定义源列表时是 <平台号>-<源1>-<源2>）。本脚本可一次读多份并合并，例如：
 *
 *   node diag-live-rank.mjs dist-sources/source-bundle.js dist-sources/chain.json 1101 12 qq,kg
 *   node diag-live-rank.mjs dist-sources/source-bundle.js dist-sources/chain.json 1101 12 kw,wyy
 *   node diag-line-verdict.mjs 1101 1101-kw-wyy
 *
 * 判据只看「独立单链」结果（lineRows）：把每条线路单独放进一条只有它自己的链里跑
 * 12 首 × 3 档，因此不受其它线路和跨源兜底影响，反映的是这条线路自身的健康度。
 * 输出按可播率升序，末尾直接列出「明显失败（可播 0）」与「偏低（< 50%）」。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tags = process.argv.slice(2);
if (tags.length === 0) {
  console.error("用法：node diag-line-verdict.mjs <标签> [更多标签...]");
  console.error("  例：node diag-line-verdict.mjs 1101 1101-kw-wyy");
  process.exit(2);
}

const rows = [];
for (const tag of tags) {
  const file = path.join(HERE, `diag-live-rank-${tag}.json`);
  if (!fs.existsSync(file)) {
    console.error(`找不到 ${path.basename(file)}，跳过`);
    continue;
  }
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(
    `读入 ${path.basename(file)}：平台 ${data.platform}  chainRevision ${data.chainRevision}  ${(data.lineRows ?? []).length} 格`,
  );
  rows.push(...(data.lineRows ?? []));
}
if (rows.length === 0) {
  console.error("没有可用的原始数据");
  process.exit(1);
}
console.log(`合计 ${rows.length} 格\n`);

const byLine = new Map();
for (const r of rows) {
  const key = `${r.source}/${r.line}`;
  if (!byLine.has(key)) {
    byLine.set(key, { source: r.source, line: r.line, name: r.lineName, kind: r.kind, cells: [] });
  }
  byLine.get(key).cells.push(r);
}

/** 中位数 */
function med(xs) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const table = [];
for (const [, v] of byLine) {
  const total = v.cells.length;
  const gotUrl = v.cells.filter((c) => c.ok).length;
  const playable = v.cells.filter((c) => c.playable).length;
  const ms = med(v.cells.filter((c) => c.playable).map((c) => c.ms));
  const errs = new Map();
  for (const c of v.cells) {
    if (c.playable) continue;
    const raw = c.err && c.err.length > 0 ? c.err : c.ok ? `探测不过 HTTP ${c.probe?.status}` : "无地址";
    const short = String(raw).replace(/\s+/g, " ").slice(0, 60);
    errs.set(short, (errs.get(short) || 0) + 1);
  }
  const top = [...errs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
  table.push({ ...v, total, gotUrl, playable, rate: total ? playable / total : 0, ms, top });
}

table.sort((a, b) => a.rate - b.rate || a.line.localeCompare(b.line));

console.log("可播率  线路                        类型   可播/总  取到地址  中位ms  主要失败原因");
console.log("-".repeat(118));
for (const t of table) {
  const rate = `${(t.rate * 100).toFixed(0)}%`.padStart(5);
  const id = `${t.source}/${t.line}`.padEnd(28);
  const kind = String(t.kind).padEnd(6);
  const pl = `${t.playable}/${t.total}`.padStart(8);
  const gu = String(t.gotUrl).padStart(8);
  const ms = `${t.ms.toFixed(0)}`.padStart(6);
  const why = t.top.length ? t.top.map(([k, n]) => `${k}${n > 1 ? `×${n}` : ""}`).join(" | ") : "—";
  console.log(`${rate}  ${id}${kind}${pl}${gu}${ms}  ${why}`);
}

const section = (title, list) => {
  console.log(`\n=== ${title} ===`);
  if (list.length === 0) {
    console.log("  （无）");
    return;
  }
  for (const t of list) {
    console.log(
      `  ${t.source}/${t.line}  [${t.kind}]  ${t.playable}/${t.total} = ${(t.rate * 100).toFixed(0)}%  中位 ${t.ms.toFixed(0)}ms  ${t.top.map(([k, n]) => `${k}×${n}`).join(" | ")}`,
    );
  }
};

section("明显失败（可播 0）", table.filter((t) => t.playable === 0));
section("偏低（可播率 < 50%）", table.filter((t) => t.playable > 0 && t.rate < 0.5));
section("健康（可播率 ≥ 50%）", table.filter((t) => t.rate >= 0.5));
