/**
 * bundle 入口冒烟（手动跑：node scripts/smoke-entries.mjs）。
 *
 * 在 Node 里模拟宿主 request（契约：状态码 / 小写响应头 / body 先试 JSON 解析），
 * 装载 dist-sources/source-bundle.js 后逐个调用 __qtEntries 的数据接口，
 * 只验证「入口存在 + 请求可达 + 返回形状对」，不做业务正确性断言。
 * 需要联网（走真实平台接口），失败项单独打 ❌ 不中断。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function hostRequest(url, options = {}) {
  const method = options.method ?? "GET";
  const headers = options.headers ?? {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: options.body,
      signal: controller.signal,
      redirect: "follow",
    });
    const h = {};
    res.headers.forEach((v, k) => {
      h[k.toLowerCase()] = v;
    });
    const text = await res.text();
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* 非 JSON 原样字符串 */
    }
    return { statusCode: res.status, headers: h, body };
  } finally {
    clearTimeout(timer);
  }
}

globalThis.__qtHost = { request: hostRequest, platform: 1103 };
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
await import(pathToFileURL(path.join(root, "dist-sources/source-bundle.js")).href);

const E = globalThis.__qtEntries;
console.log("入口数:", Object.keys(E).length);
console.log("入口:", Object.keys(E).join(", "));

const chainJson = fs.readFileSync(path.join(root, "dist-sources/chain.json"), "utf8");
console.log("loadChain:", E.loadChain(chainJson));

const cases = [
  ["search", { source: "kw", keyword: "晴天", page: 1, size: 3 }, (r) => `list=${r.list.length} first=${r.list[0]?.name}/${r.list[0]?.singer}`],
  ["searchAll", { keyword: "晴天", page: 1, size: 2 }, (r) => `batches=${r.batches.map((b) => b.source + ":" + b.list.length).join(",")}`],
  ["searchPlaylists", { source: "wyy", keyword: "周杰伦", page: 1, size: 3 }, (r) => `list=${r.list.length} first=${r.list[0]?.name}`],
  ["searchArtists", { source: "qq", keyword: "周杰伦", page: 1, size: 3 }, (r) => `list=${r.list.length} first=${r.list[0]?.name} pic=${(r.list[0]?.picUrl || "").slice(0, 30)}`],
  ["searchAlbums", { source: "kw", keyword: "周杰伦", page: 1, size: 3 }, (r) => `list=${r.list.length} first=${r.list[0]?.name}`],
  ["playlistCategories", { source: "wyy" }, (r) => `list=${r.list.length} first=${r.list[0]?.name}`],
  ["charts", { source: "wyy" }, (r) => `list=${r.list.length} first=${r.list[0]?.name}`],
  ["allCharts", {}, (r) => `list=${r.list.length} platforms=${[...new Set(r.list.map((c) => c.platform))].join(",")}`],
  ["hotWords", { source: "kg" }, (r) => `list=${r.list.length} first=${r.list[0]}`],
  ["allHotWords", {}, (r) => `list=${r.list.length} first=${r.list[0]}`],
  ["latest", { source: "kw", limit: 5, offset: 0 }, (r) => `list=${r.list.length} first=${r.list[0]?.name}`],
  ["allLatest", { limit: 8, offset: 0 }, (r) => `list=${r.list.length} first=${r.list[0]?.name}`],
  ["recommendations", { source: "wyy", category: null, page: 1 }, (r) => `list=${r.list.length} first=${r.list[0]?.name}`],
  ["videos", { source: "wyy", page: 1, size: 3 }, (r) => `list=${r.list.length} first=${r.list[0]?.name}`],
  ["lyric", { source: "kw", song: { id: "271636581", name: "晴天", singer: "周杰伦" } }, (r) => `lyric=${(r.lyric || "").length}chars translation=${(r.translation || "").length}chars`],
  ["cover", { source: "kw", song: { id: "271636581", name: "晴天", singer: "周杰伦" } }, (r) => `url=${(r.url || "").slice(0, 60)}`],
];

let failed = 0;
for (const [name, args, fmt] of cases) {
  try {
    const raw = await E[name](args);
    const parsed = JSON.parse(raw);
    console.log(`✅ ${name}: ${fmt(parsed)}`);
  } catch (e) {
    failed++;
    console.log(`❌ ${name}: ${e && e.message ? e.message : e}`);
  }
}
console.log(failed === 0 ? "全部入口可达" : `${failed} 个入口失败`);
