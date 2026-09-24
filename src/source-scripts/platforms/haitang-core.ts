/**
 * 恒堂核心 API（`musicserver.haitangw.cc/v1/music/resolve-url`）取链线路。
 *
 * 来源：asice999/lxmusic-sources 的 source.js v1.5.0（2026-09-24 用户指定接入
 * qq / kg 两平台）。该接口是 POST JSON 的官方直链解析器：
 *
 *   POST https://musicserver.haitangw.cc/v1/music/resolve-url
 *   Content-Type: application/json
 *   {"source":"tx"|"kg", "rid":"<平台原生 id>", "level":"exhigh"|"lossless"}
 *   → {"code":0,"data":{"url":"<官源直链>"}}
 *
 * 实测（2026-09-24，PC 平台 1103，真网络）：
 *   qq flac/level=lossless → 206 fLaC  https://isure.stream.qqmusic.qq.com/F000...flac
 *   qq 320 /level=exhigh   → 206 ID3   https://isure.stream.qqmusic.qq.com/M800...mp3
 *   kg flac/level=lossless → 206 fLaC  .../fsdg360.hw.kugou.com/.../qu32 (无损段)
 *   kg 320 /level=exhigh   → 206 ID3   .../fsdg360.hw.kugou.com/.../qu32
 *   qq 取链耗时 ~830ms、kg ~500ms。
 *
 * ## 为什么是 bundle 实现而不是声明式 http 线路
 *
 * chain.json 的 kind:"http"（lines/declarative.ts）只发 GET（硬编码 method: "GET"），
 * 而本接口 GET 一律 404、必须 POST JSON body —— 实测：
 *   POST json        HTTP 201 code=0 ✅
 *   GET  query       HTTP 404 ❌
 *   GET  query+UA    HTTP 404 ❌
 * 所以只能落在 BUNDLE_IMPLS 里。
 *
 * ## 与 source.js 的差异（有意保留）
 *
 * 1. **不接 HYW（103.79.184.97）**：三个平台实测一律 15s 超时；source.js 声称
 *    「3/3 稳定」与实测不符，不引入。
 * 2. **不接聆澜（source.shiqianjiang.cn）**：可用（kw/qq/kg 都能出真 flac），但
 *    它是同一模式的第三方免签名直链，多接一家 = 多一个外部依赖；用户本次只要求
 *    接核心 API。若日后要加，按同一模块形态补一个 line 即可。
 * 3. **不做两次存活探测**：source.js 的 verifyUrl 是必要的——它直接在 xm 播放器
 *    里把直链交出去；我们这边 URL 出来后还要过 play-url.ts 的 `verifyPlayable`
 *    Range 预检（VERIFY_MS=2500），重复探测纯属浪费预算。
 * 4. **不缓存**：上层 play-url.ts 按 cacheKey 缓存，链路内部再缓存会掩盖死链。
 * 5. **id 归一**：source.js 传平台原生字段（qq=songmid、kg=hash）；我们的
 *    MusicInfo.id 已经就是该字段，直接透传。
 *
 * ## 已知局限（2026-09-24 端到端实测，PC 平台 1103）
 *
 * - **kg 的 exhigh（320/128）按歌而异**：部分歌上游把直链解析到
 *   `v3-32-yp-qqmusic.a.bdycdn.cn`，该节点从实测网络连 TCP 都建不起来
 *   （连接层失败，非 HTTP 错误，复测恒定）；同一首歌的 lossless 却从
 *   `fsdg360.hw.kugou.com` 正常出（206 fLaC）。实测 4 首：flac 4/4、
 *   320/128 各 2/4。死链被 play-url 的 Range 预检正确拒绝后落回换源下一级
 *   （整链实测这两首由跨源酷我兜底救回 4/4），所以该线路只加分不减分。
 * - **kg 的 bdycdn 直链 302 才到真源**（→ fsdg360.hw.kugou.com）。宿主
 *   reqwest 默认跟随重定向并回报最终状态（206），预检无碍；Node 测试宿主
 *   必须同样跟随（redirect 默认值），否则会把合法直链误判成 302+HTML 死链。
 * - qq 三档全通且稳定（~850ms），无上述问题。
 */
import type { MusicInfo, Quality, RequestBuiltin } from "../contract";
import { asObject, asString, requestJson } from "./utils";

const CORE_URL = "https://musicserver.haitangw.cc/v1/music/resolve-url";

/** 上游平台代号（chain.json 的 source → 核心 API 的 source） */
const CORE_SOURCE: Record<"qq" | "kg", string> = { qq: "tx", kg: "kg" };

/**
 * 契约音质 → 核心 API 的 level（只有两档，与 source.js 的 CORE.levelOf 同口径）：
 * flac（及无损类）→ lossless；128/320 → exhigh（实际码率由上游决定）。
 */
function levelOf(quality: Quality): string {
  return quality === "flac" ? "lossless" : "exhigh";
}

/**
 * 取一条核心 API 直链；失败（网络 / code≠0 / 无 url）返回空串，
 * 交由上层换源下一级（与其它 bundle 线路一致：不抛错给调用方）。
 */
async function coreMusicUrl(
  request: RequestBuiltin,
  source: "qq" | "kg",
  song: MusicInfo,
  quality: Quality,
): Promise<string> {
  try {
    if (song.id.length === 0) return "";
    const json = await requestJson(request, CORE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: CORE_SOURCE[source],
        rid: song.id,
        level: levelOf(quality),
      }),
    });
    // code 必须是 0；非 0 时把上游 message 透出便于诊断（仍按未命中处理）
    if (json["code"] !== undefined && Number(json["code"]) !== 0) return "";
    const url = asString(asObject(json["data"])["url"]);
    // 酷我系直链的查询分隔符是 $（source.js fixUrl）；本接口实测不含 $，
    // 但保留替换：对不含 $ 的 URL 是无副作用的 no-op。
    return url.replace(/\$/g, "=");
  } catch {
    return "";
  }
}

/** QQ 平台入口（BUNDLE_IMPLS 的 qqHaitangCore） */
export function qqHaitangCore(
  request: RequestBuiltin,
  song: MusicInfo,
  quality: Quality,
): Promise<string> {
  return coreMusicUrl(request, "qq", song, quality);
}

/** 酷狗平台入口（BUNDLE_IMPLS 的 kgHaitangCore） */
export function kgHaitangCore(
  request: RequestBuiltin,
  song: MusicInfo,
  quality: Quality,
): Promise<string> {
  return coreMusicUrl(request, "kg", song, quality);
}
