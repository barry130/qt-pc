/**
 * bundle 冒烟：Node 直连驱动 source-bundle.js（不经 Tauri），验证
 * ① bundle 可导入；② createSourceLayer + hostRequest 注入形态可取链；
 * ③ 声明式线路（a.aa.cab）与 lx 宿主（quandouyao 免请求直出链）真的工作；
 * ④ 安卓形态：宿主注入 __qtHost 时 bundle 顶层注册 __qtEntries（平台 1101、
 *    行级 platforms 过滤、loadChain/getPlayUrl/verifyPlayable 契约）。
 *
 * 用法：node scripts/smoke-bundle.mjs [真实网络]
 * 默认只做离线断言；传 `net` 走真实取链（wyy 128 免费歌）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = path.join(project, "dist-sources", "source-bundle.js");

if (!fs.existsSync(bundlePath)) {
  console.error("先跑 npm run build:sources");
  process.exit(1);
}

// 安卓宿主形态：prelude 的 __qtHost 必须在 import 之前装好——入口注册发生在
// bundle 顶层执行时。stub 与 Rust builtin_request 同契约（响应头小写、body 已解析）。
globalThis.__qtHost = {
  request: async (url, options) => {
    if (options?.headers?.Range !== undefined) {
      return {
        statusCode: 206,
        headers: { "content-type": "audio/mpeg", "content-length": "2" },
        body: "",
      };
    }
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: { data: { url: "https://cdn.example/" + url.split("/").pop() + ".mp3" } },
    };
  },
  log: () => {},
};

const layer_mod = await import("file://" + bundlePath.split(path.sep).join("/"));
const { createSourceLayer, defaultChainConfig, parseChainConfig, PLATFORMS } = layer_mod;

// ---- 离线断言 ----
const cfg = defaultChainConfig();
const parsed = parseChainConfig(JSON.parse(JSON.stringify(cfg)));
if (parsed.chainRevision !== 2 || parsed.chains.kw.length !== 5) {
  throw new Error("默认链断言失败");
}
const layer = createSourceLayer({
  request: async () => {
    throw new Error("离线冒烟不发请求");
  },
  platform: PLATFORMS.WINDOWS,
});
if (typeof layer.resolvePlayUrl !== "function") throw new Error("layer.resolvePlayUrl 缺失");

// scheme 依赖 localStorage（Node 无）——resolveScheme 走内置 script 兜底，
// 注入的 request 会抛错 → 预算内返回空串（而不是挂死）
const url = await layer.resolvePlayUrl("wyy", { id: "x", name: "x", singer: "x", album: "", picUrl: "", interval: 0 }, "128");
if (url !== "") throw new Error("离线取链应返回空串");

console.log("[smoke-bundle] 离线断言通过");

// ---- 真实网络（可选） ----
if (process.argv[2] === "net") {
  const nodeRequest = async (url, options) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 15000);
    try {
      const res = await fetch(url, {
        method: options?.method ?? "GET",
        headers: options?.headers,
        body: options?.body,
        signal: controller.signal,
      });
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      const headers = {};
      res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      return { statusCode: res.status, headers, body };
    } finally {
      clearTimeout(timer);
    }
  };
  const netLayer = createSourceLayer({ request: nodeRequest, platform: PLATFORMS.WINDOWS });
  const song = { id: "1901371647", name: "孤勇者", singer: "陈奕迅", album: "", picUrl: "", interval: 0 };
  const real = await netLayer.resolvePlayUrl("wyy", song, "128");
  if (real.length === 0) throw new Error("真实取链失败（wyy 128）");
  const head = await fetch(real, { headers: { Range: "bytes=0-1" } });
  const contentType = head.headers.get("content-type") ?? "";
  if (!/json|html|text\/plain/i.test(contentType) === false) throw new Error("取到的是错误页");
  console.log("[smoke-bundle] 真实取链通过:", real.slice(0, 80) + "…");
}

// ---- 安卓形态（__qtEntries；放在最后：loadChain 会覆盖 chain-store 缓存）----
const entries = globalThis.__qtEntries;
const CHAIN_ENTRY_NAMES = ["bundleInfo", "loadChain", "getPlayUrl", "verifyPlayable"];
if (
  entries === undefined || entries === null ||
  CHAIN_ENTRY_NAMES.some((name) => typeof entries[name] !== "function")
) {
  throw new Error("bundle 未注册 __qtEntries（安卓引擎装载会失败）");
}
const info = JSON.parse(entries.bundleInfo());
if (info.hostApiVersion !== 1 || !info.platforms.includes(PLATFORMS.ANDROID)) {
  throw new Error("bundleInfo 契约不符: " + JSON.stringify(info));
}
const androidChain = {
  chainRevision: 900,
  maxLinesPerQuality: 5,
  crossSources: {},
  budget: { totalMs: 5000, lineMs: 2000 },
  chains: {
    kw: [
      {
        id: "pc-only", name: "PC 专属", kind: "http", qualities: ["128"], platforms: [PLATFORMS.WINDOWS],
        request: { url: "https://pc.example/pc" }, pick: "data.url",
      },
      {
        id: "android-only", name: "安卓专属", kind: "http", qualities: ["128"], platforms: [PLATFORMS.ANDROID],
        request: { url: "https://android.example/android" }, pick: "data.url",
      },
    ],
  },
};
const loaded = JSON.parse(entries.loadChain(JSON.stringify(androidChain)));
if (!loaded.ok || loaded.lines !== 2) throw new Error("loadChain 失败: " + JSON.stringify(loaded));
const out = JSON.parse(
  await entries.getPlayUrl({ platform: "kw", id: "1", name: "x", singer: "y", album: "", quality: "128", duration: 0 }),
);
if (out.url !== "https://cdn.example/android.mp3") {
  throw new Error("安卓取链/行级 platforms 过滤失败: " + JSON.stringify(out));
}
const verify = JSON.parse(await entries.verifyPlayable({ url: out.url }));
if (verify.ok !== true) throw new Error("verifyPlayable 判定失败: " + JSON.stringify(verify));
console.log("[smoke-bundle] 安卓入口（__qtEntries）断言通过");
