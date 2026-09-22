/**
 * 构建后处理：把 bundle 里被 Rollup **重新打印**过的「自校验混淆脚本体」恢复为逐字节原文。
 *
 * 为什么必须做（2026-09-19 事故根因）：
 * Vite 库模式用 Rollup 打包时会按自己的 AST 重新打印脚本——解码 `\xNN` 转义、
 * 把 `0x2` 规范化成 `2`、重命名遮蔽参数（globalThis→globalThis2、console→console2、
 * window→window2）并同步改掉函数体里的引用。jsjiami.cn.v7 / jsjiami.com.v7 /
 * obfuscator.io strong 这类混淆件带**源码文本自校验**（字符串数组轮转循环），
 * 文本一变校验永不收敛 → 退化为同步忙循环，冻结整个事件循环（PC 全接口超时、
 * 安卓撞 5s 停转闸门）。恢复逐字节原文后校验通过、初始化正常返回。
 *
 * 只恢复**带自校验指纹**的脚本：实测把 12 个脚本全部恢复会让 kw 链取链退化为
 * 空串（非自校验脚本反而依赖 Rollup 输出），所以按指纹挑选、其余保持不动。
 *
 * 用法：node scripts/restore-lx-bodies.mjs [bundle路径] [--all]
 *   bundle 缺省 dist-sources/source-bundle.js；--all = 不做指纹筛选（仅供排查）
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUNDLE = join(here, "..", "dist-sources", "source-bundle.js");
const VENDOR_DIR = join(here, "..", "src", "source-scripts", "schemes", "lx-host", "vendored");

/** 包装段的收尾调用（Rollup 不改它） */
const CLOSE = "})(deps.globalThis, deps.process, deps.lx, deps.scriptMd5, deps.console, deps.window);";
/** 包装段的开头：参数表里必有 SCRIPT_MD5（脚本体内不会出现这种形参表） */
const OPEN_RE = /\(function\s*\(([^)]*SCRIPT_MD5[^)]*)\)\s*\{/g;
/** 自校验指纹：只有这些混淆器会做源码文本自校验 */
const SELF_CHECK = /jsjiami\.(?:cn|com)\.v7|obfuscated build\(strong\)/;
/** 恢复后的参数表（与 scripts/gen-lx-vendor.mjs 生成的原文包装一致） */
const FIXED_OPEN = "(function (globalThis, process, lx, SCRIPT_MD5, console, window) {";
/**
 * 还原时的分隔空白：与 gen-lx-vendor.mjs 的包装文件逐字对齐
 * （`FIXED_OPEN\n<原文>\n  ` + CLOSE）。语义上新不换行都一样，但对齐后
 * 「重新构建」的产物与线上已验证的 bundle 在这三个脚本体上逐字节相同，
 * 差异只可能出现在本次真正改过的源码里——可被 diff 直接证明。
 */
const BODY_LEAD = "\n";
const BODY_TAIL = "\n  ";

/** 收集 bundle 里所有 LX 包装段 */
export function collectWrappers(bundle) {
  const out = [];
  let from = 0;
  for (;;) {
    const close = bundle.indexOf(CLOSE, from);
    if (close < 0) break;
    OPEN_RE.lastIndex = 0;
    let open = null;
    for (let m = OPEN_RE.exec(bundle); m !== null && m.index < close; m = OPEN_RE.exec(bundle)) {
      open = m;
    }
    if (open !== null) {
      const bodyStart = open.index + open[0].length;
      out.push({
        openStart: open.index,
        openText: open[0],
        bodyStart,
        bodyEnd: close,
        body: bundle.slice(bodyStart, close),
        params: open[1].split(",").map((p) => p.trim()),
      });
    }
    from = close + CLOSE.length;
  }
  return out;
}

/** 读 vendored 原文（gen-lx-vendor.mjs 的逐字节拷贝，SCRIPT_MD5 的真源） */
export function readVendoredScripts(dir = VENDOR_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".js") && !f.endsWith(".wrapped.js"))
    .map((f) => ({ id: f.slice(0, -3), text: readFileSync(join(dir, f), "utf8") }));
}

/** 归一化：把 Rollup 的改写痕迹抹平，便于比对 */
function norm(s) {
  return s
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\bglobalThis2\b/g, "globalThis")
    .replace(/\bconsole2\b/g, "console")
    .replace(/\bwindow2\b/g, "window")
    .replace(/0x([0-9a-fA-F]+)/g, (_, h) => String(parseInt(h, 16)))
    .replace(/"/g, "'")
    .replace(/\s+/g, "");
}

function shingles(s, size = 16, step = 11) {
  const set = new Set();
  for (let i = 0; i + size <= s.length; i += step) set.add(s.slice(i, i + size));
  return set;
}

/** a 的 shingle 落在 b 里的比例 */
function cover(a, b) {
  if (a.size === 0) return 0;
  let hit = 0;
  for (const x of a) if (b.has(x)) hit++;
  return hit / a.size;
}

/**
 * 配对安全阀的第二把尺子：长字符串字面量命中率。
 *
 * 为什么不能只看 16-gram 覆盖率（2026-09-22 实测）：
 * 自校验混淆件**正是**被 Rollup 重排版破坏得最彻底的那批——jsjiami/obfuscator
 * strong 会把整份源码编成一个巨大的字符串数组 + 轮转循环，Rollup 解码 \xNN、
 * 规范化数字进制后，文本层面的重合度掉到 2%~7%。也就是说「相似度低」是这批
 * 文件的**正常状态**，用它当门槛等于永远构建不出来（实测 kulou 5.5% / luoxue 6.8%
 * / molan 6.4%，而这三个恰好就是必须逐字节还原的三个）。
 *
 * 字符串字面量是抗重排的：混淆器保留了字符串数组本身，只有转义与进制被改写。
 * 实测同一批数据下命中率是 kulou 96%(1910/1983)、luoxue 96%(518/540)、
 * molan 98%(2296/2331)，而错误配对一律 <1%。所以用它判「配对了没有」，
 * 用覆盖率判「像不像」。
 */
const LITERAL_MIN = 12;
function literalsOf(s) {
  const out = new Set();
  const re = /'([^'\\]{12,})'/g;
  let m;
  while ((m = re.exec(s)) !== null) out.add(m[1]);
  return out;
}
/** 包装段体里命中的 vendored 长字面量占比 */
function literalHit(body, rawText) {
  const lits = literalsOf(norm(rawText));
  if (lits.size === 0) return { hits: 0, total: 0, ratio: 0 };
  const nb = norm(body);
  let hits = 0;
  for (const l of lits) if (nb.includes(l)) hits++;
  return { hits, total: lits.size, ratio: hits / lits.size };
}
/** 配对是否可信：覆盖率达标，或长字面量命中足够（混淆件的唯一可行判据） */
function pairingTrusted(r, lit) {
  return r >= 0.3 || (lit.ratio >= 0.5 && lit.hits >= 8);
}

/**
 * 把包装段与 vendored 原文配对（全局贪心：先满足相似度最高的配对）。
 * 返回 Map<包装段下标, {id, r, text}>；restore 与 check 共用，保证命名一致。
 */
export function matchWrappers(wrappers, vendored) {
  const vnorm = vendored.map((v) => ({ id: v.id, text: v.text, sh: shingles(norm(v.text)) }));
  const cand = [];
  wrappers.forEach((w, wi) => {
    const wsh = shingles(norm(w.body));
    vnorm.forEach((v, vi) => {
      const r = cover(wsh, v.sh);
      if (r > 0) cand.push({ wi, vi, r });
    });
  });
  cand.sort((a, b) => b.r - a.r);
  const wTaken = new Map();
  const vTaken = new Set();
  for (const c of cand) {
    if (wTaken.has(c.wi) || vTaken.has(c.vi)) continue;
    wTaken.set(c.wi, { id: vnorm[c.vi].id, r: c.r, text: vnorm[c.vi].text });
    vTaken.add(c.vi);
  }
  return wTaken;
}

/**
 * 恢复 bundle 里的自校验脚本体。
 * @returns {{restored: string[], skipped: string[], unmatched: number}}
 */
export function restoreLxBodies(bundlePath = DEFAULT_BUNDLE, options = {}) {
  const log = options.log ?? ((m) => console.log(m));
  const all = options.all === true;
  const only = options.ids ?? null;
  const bundle = readFileSync(bundlePath, "utf8");
  const wrappers = collectWrappers(bundle);
  const vendored = readVendoredScripts(options.vendorDir);
  log(`[restore-lx] ${bundlePath}：包装段 ${wrappers.length} 个，vendored 原文 ${vendored.length} 个`);

  // 每个包装段挑最像的原文（全局贪心配对，见 matchWrappers）
  const wTaken = matchWrappers(wrappers, vendored);
  const vnorm = vendored;

  const restored = [];
  const skipped = [];
  let unmatched = 0;
  let cursor = 0;
  let out = "";
  wrappers.forEach((w, wi) => {
    const m = wTaken.get(wi);
    const raw = m ?? null;
    const already = w.body.trim() === (raw ? raw.text.trim() : "\u0000");
    if (!raw) {
      unmatched += 1;
      out += bundle.slice(cursor, w.bodyEnd + CLOSE.length);
      cursor = w.bodyEnd + CLOSE.length;
      return;
    }
    const wanted = all || SELF_CHECK.test(raw.text);
    if (only !== null && !only.includes(raw.id)) {
      out += bundle.slice(cursor, w.bodyEnd + CLOSE.length);
      cursor = w.bodyEnd + CLOSE.length;
      return;
    }
    if (!wanted) {
      skipped.push(`${raw.id}（无自校验指纹，保持 Rollup 输出）`);
      out += bundle.slice(cursor, w.bodyEnd + CLOSE.length);
      cursor = w.bodyEnd + CLOSE.length;
      return;
    }
    if (already && w.openText.trim() === FIXED_OPEN.trim()) {
      skipped.push(`${raw.id}（已是逐字节原文）`);
      out += bundle.slice(cursor, w.bodyEnd + CLOSE.length);
      cursor = w.bodyEnd + CLOSE.length;
      return;
    }
    const lit = literalHit(w.body, raw.text);
    if (!pairingTrusted(m.r, lit)) {
      throw new Error(
        `[restore-lx] 包装段#${wi} 与 ${raw.id} 的配对不可信：覆盖率 ${(m.r * 100).toFixed(1)}%，` +
          `长字面量命中 ${(lit.ratio * 100).toFixed(1)}%（${lit.hits}/${lit.total}）` +
          `——拒绝写入，请检查 vendored 原文是否与打包输入一致`,
      );
    }
    // 替换：开头参数表 + 函数体（尾随空白归一到 gen-lx-vendor 的形态）
    out += bundle.slice(cursor, w.openStart) + FIXED_OPEN + BODY_LEAD + raw.text.replace(/\s+$/, "") + BODY_TAIL;
    cursor = w.bodyEnd;
    restored.push(
      `${raw.id}（覆盖率 ${(m.r * 100).toFixed(1)}%、长字面量 ${(lit.ratio * 100).toFixed(1)}%` +
        `(${lit.hits}/${lit.total})，${w.body.length} → ${raw.text.length} 字符）`,
    );
  });
  out += bundle.slice(cursor);

  if (restored.length > 0) writeFileSync(bundlePath, out, "utf8");
  for (const r of restored) log(`[restore-lx]   ✅ 恢复 ${r}`);
  for (const s of skipped) log(`[restore-lx]   ·  跳过 ${s}`);
  if (unmatched > 0) log(`[restore-lx]   ⚠️  ${unmatched} 个包装段未匹配到 vendored 原文（保持原样）`);
  log(`[restore-lx] 完成：恢复 ${restored.length} 个，跳过 ${skipped.length} 个`);
  return { restored, skipped, unmatched };
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/restore-lx-bodies.mjs");
if (isMain) {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const bundlePath = args.find((a) => !a.startsWith("--")) ?? DEFAULT_BUNDLE;
  restoreLxBodies(bundlePath, { all });
}
