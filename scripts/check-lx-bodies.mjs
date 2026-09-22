/**
 * 构建期守卫：逐个执行 bundle 里的 LX 脚本体，检出「同步忙循环挂死」。
 *
 * 为什么必须用 Worker：混淆脚本被 Rollup 重排版后会退化成**同步**忙循环，
 * 同进程内无法打断（这正是 2026091905 上线后全接口不可用的原因，也是线上
 * 不能自愈的原因）。放进 worker_threads 后，父线程可以用看门狗 terminate。
 *
 * 判定：脚本 init 期间调用 lx.on("request", h) 注册 handler 即视为通过；
 * 超时未注册 = 挂死（返回 hang，调用方应中止构建）；init 抛错只告警——沙箱
 * 缺宿主函数也会抛，不构成「打包坏了」的证据。
 *
 * 用法：node scripts/check-lx-bodies.mjs [bundle路径] [超时ms]
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { collectWrappers, readVendoredScripts, matchWrappers } from "./restore-lx-bodies.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUNDLE = join(here, "..", "dist-sources", "source-bundle.js");

/** 指纹：区分「逐字节原文」与「Rollup 重排版」 */
const SELF_CHECK = /jsjiami\.(?:cn|com)\.v7|obfuscated build\(strong\)/;

/** worker 里执行的代码：忠实复刻 bridge.ts 的 createLxHost 宿主面 */
const WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");

function md5Like(s) {
  // 只求长度/字符集合法（脚本 init 阶段只用它做自检占位），真 md5 在宿主里
  let h = 0;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return ("0000000" + h.toString(16)).slice(-8).repeat(4);
}

function bufferFrom(s) {
  return new TextEncoder().encode(String(s));
}
function bufferToString(b, enc) {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b || []);
  if (enc === "hex") return Array.from(bytes).map((x) => x.toString(16).padStart(2, "0")).join("");
  if (enc === "base64") return Buffer.from(bytes).toString("base64");
  return new TextDecoder().decode(bytes);
}

let handler = null;
const lx = {
  EVENT_NAMES: { request: "request", inited: "inited", updateAlert: "updateAlert", showConfigView: "showConfigView" },
  version: "2.0.0",
  apiVersion: "1.3.0",
  env: "desktop",
  on: (name, h) => { if (name === "request") { handler = h; parentPort.postMessage({ ok: true }); } },
  send: () => {},
  request: () => {},
  currentScriptInfo: { name: "guard", description: "build guard", version: "", author: "", rawScript: "" },
  utils: {
    serialize: (v) => { try { return JSON.stringify(v); } catch { return ""; } },
    deserialize: (s) => { try { return JSON.parse(s); } catch { return null; } },
    log: () => {}, toast: () => {}, exit: () => {},
    crypto: {
      md5: (s) => md5Like(s),
      randomBytes: (n) => new Uint8Array(n),
      randomInt: (a, b) => a,
      aesEncrypt: () => "",
      rsaEncrypt: () => "",
    },
    buffer: { from: bufferFrom, bufToString: bufferToString },
  },
};

const overrides = {
  lx,
  SCRIPT_MD5: workerData.scriptMd5,
  setTimeout: (fn, ms) => setTimeout(() => { try { fn(); } catch {} }, ms),
  setInterval: (fn, ms) => setInterval(() => { try { fn(); } catch {} }, ms),
};
const realGlobal = globalThis;
const globalThisMock = new Proxy({}, {
  get: (_t, key) => (typeof key === "symbol" ? realGlobal[key] : (key in overrides ? overrides[key] : realGlobal[key])),
  set: (_t, key, v) => { if (typeof key === "string") overrides[key] = v; return true; },
  has: () => true,
});
const processStub = {
  env: {}, platform: "win32", version: "2.0.0",
  nextTick: (fn) => setTimeout(fn, 0),
  exit: () => { throw new Error("process.exit blocked"); },
};
const silentConsole = new Proxy({}, { get: () => () => {} });

try {
  const fn = new Function(...workerData.params, '"use strict";' + workerData.body);
  fn(globalThisMock, processStub, lx, workerData.scriptMd5, silentConsole, globalThisMock);
} catch (e) {
  parentPort.postMessage({ err: String((e && e.message) || e) });
}
`;

/** 在 worker 里跑一个脚本体；返回 {status, ms} */
function runBody(wrapper, timeoutMs) {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_SRC, {
      eval: true,
      workerData: { params: wrapper.params, body: wrapper.body, scriptMd5: "0".repeat(32) },
    });
    const t0 = Date.now();
    let done = false;
    const finish = (status) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve({ status, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => finish("hang"), timeoutMs);
    worker.on("message", (m) => finish(m && m.ok ? "ok" : "throw:" + String((m && m.err) || "").slice(0, 80)));
    worker.on("error", (e) => finish("throw:" + String(e && e.message ? e.message : e).slice(0, 80)));
    worker.on("exit", () => finish("throw:worker 提前退出（未注册 handler）"));
  });
}

/**
 * 检查 bundle 里所有 LX 脚本体。
 * @returns {{ok: boolean, results: Array<{name: string, form: string, status: string, ms: number}>, hung: string[]}}
 *   hung = 挂死脚本体名（build-sources.mjs 的构建中止判据）
 */
export async function checkLxBodies(bundlePath = DEFAULT_BUNDLE, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20000;
  const log = options.log ?? ((m) => console.log(m));
  const logError = options.logError ?? ((m) => console.error(m));
  const bundle = readFileSync(bundlePath, "utf8");
  const wrappers = collectWrappers(bundle);
  const vendored = readVendoredScripts(options.vendorDir);
  const matched = matchWrappers(wrappers, vendored);
  log(`[check-lx] ${bundlePath}：待检 ${wrappers.length} 个脚本体（超时 ${timeoutMs}ms）`);

  const results = [];
  const hung = [];
  let hangs = 0;
  for (let i = 0; i < wrappers.length; i++) {
    const w = wrappers[i];
    const name = matched.get(i)?.id ?? "?";
    const form = SELF_CHECK.test(w.body) ? "原文" : "Rollup 重排版";
    const r = await runBody(w, timeoutMs);
    results.push({ name, form, status: r.status, ms: r.ms });
    const tag = `wrapper#${String(i).padStart(2)}( ${name}, ${form}, ${w.body.length} 字符)`;
    if (r.status === "ok") {
      log(`[check-lx]   ✅ ${tag} 已注册 handler（${r.ms}ms）`);
    } else if (r.status === "hang") {
      hangs += 1;
      hung.push(`${name}(wrapper#${i})`);
      logError(`[check-lx]   ❌ ${tag} 同步忙循环挂死（${r.ms}ms 未注册 handler）`);
    } else {
      log(`[check-lx]   ⚠️  ${tag} init 抛错（沙箱缺宿主函数，仅告警）：${r.status.slice(6)}`);
    }
  }
  const ok = hangs === 0;
  log(ok ? `[check-lx] 通过：无脚本体挂死` : `[check-lx] 不通过：${hangs} 个脚本体挂死`);
  return { ok, results, hung };
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/check-lx-bodies.mjs");
if (isMain) {
  const args = process.argv.slice(2);
  const bundlePath = args.find((a) => !/^\d+$/.test(a)) ?? DEFAULT_BUNDLE;
  const timeoutMs = Number(args.find((a) => /^\d+$/.test(a)) ?? 20000);
  const r = await checkLxBodies(bundlePath, { timeoutMs });
  process.exit(r.ok ? 0 : 1);
}
