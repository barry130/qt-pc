/**
 * 取链（musicUrl）动作 —— chain.json 驱动的聚合取链链（P0 起）。
 *
 * 线路不再硬编码在 TS 里：顺序/音质档/启停/parallel/行级 platforms/预算/
 * 声明式线路全部来自 ChainConfig（chain-store.ts：本地 overlay → 内置默认，
 * 见 chain-config.ts 的 defaultChainConfig，与收敛前 SCRIPT_LINES 逐行等价）。
 * 远端 chain.json 更新后（P2 落盘），重启即改链路——不重新发布应用。
 *
 * 三种线路 kind 的执行：
 * - lx    ：scriptId → lx-host 懒注册表（schemes/lx-host/sources.ts）；
 * - http  ：声明式模板 → lines/declarative.ts 的 runHttpLine；
 * - bundle ：复杂实现 → 本文件 BUNDLE_IMPLS（官方核心等多步/加密实现）。
 *
 * 请求音质档内最多尝试 maxLinesPerQuality 条线路（默认 5），档内全灭后按
 * crossSources 跨源（酷我↔网易云）兜底。每条线路的返回值都过 Range 预检
 * （verifyPlayable）——第三方直出模板与代理型 CDN 随时可能返回死链，只有
 * 实测能取到音频字节的地址才被采纳/缓存。整链带取链预算（budget.ts，金额
 * 可被 chain.json 覆盖）：引擎问前端取链只等 15s，挂死的线路必须被分片
 * 上限切断。脚本侧 10 分钟 TTL 缓存与宿主侧 Rust PlayUrlCache 互不冲突。
 */
import type { ChainLine, PlatformId } from "../chain-config";
import { LOCAL_PLATFORM } from "../chain-config";
import type { MusicInfo, Quality, RequestBuiltin, Source } from "../contract";
import { ChainBudget } from "../budget";
import { kg } from "../platforms/kg";
import { kw } from "../platforms/kw";
import { qq } from "../platforms/qq";
import { wyy } from "../platforms/wyy";
import { TtlCache } from "../platforms/utils";
import { runHttpLine } from "../lines/declarative";
import { getChainConfig } from "../chain-store";
import { getLxHost, lxPlayUrl } from "../schemes/lx-host/sources";

const PLAY_URL_TTL_MS = 10 * 60 * 1000;
const urlCache = new TtlCache(PLAY_URL_TTL_MS);

/** 单条线路解析成的执行函数（未命中返回空串；失败抛错也按未命中处理） */
type LineExecutor = (request: RequestBuiltin, song: MusicInfo, quality: Quality) => Promise<string>;

/** bundle 复杂实现注册表：chain.json 的 impl 名 → 执行函数 */
const BUNDLE_IMPLS: Record<string, LineExecutor> = {
  wyyMusicUrlCore: (request, song, quality) => wyy.musicUrlCore(request, song, quality),
  qqMusicUrlCore: (request, song, quality) => qq.musicUrlCore(request, song, quality),
  kwMusicUrlCore: (request, song, quality) => kw.musicUrlCore(request, song, quality),
  kgMusicUrlCore: (request, song, quality) => kg.musicUrlCore(request, song, quality),
};

/** 未知 scriptId/impl 只告警一次（每次取链都会重走构建，避免刷屏） */
const warnedRefs = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warnedRefs.has(key)) return;
  warnedRefs.add(key);
  console.warn(`[play-url] ${message}`);
}

/**
 * 把 chain 线路解析成执行函数；引用失效（scriptId/impl 不存在）返回 null
 * 并跳过该线路（远端配置引用了本机没有的实现时，降级到剩余线路而不是崩）。
 */
function lineExecutor(line: ChainLine, source: Source): LineExecutor | null {
  if (line.kind === "http") {
    return (request, song, quality) => runHttpLine(line, request, song, quality);
  }
  if (line.kind === "bundle") {
    const impl = BUNDLE_IMPLS[line.impl];
    if (impl === undefined) {
      warnOnce(`impl:${line.impl}`, `bundle 实现不存在，线路跳过: ${line.id} (${line.impl})`);
      return null;
    }
    return impl;
  }
  const host = getLxHost(line.scriptId);
  if (host === null) {
    warnOnce(`script:${line.scriptId}`, `lx 脚本不存在，线路跳过: ${line.id} (${line.scriptId})`);
    return null;
  }
  return (request, song, quality) => lxPlayUrl(host, request, source, song, quality);
}

/**
 * 行级过滤（纯函数，测试用）：enabled === false 的线路停用；
 * platforms 白名单缺省 = 全平台，声明了则只在这些平台参与。
 */
export function filterChainLines<T extends ChainLine>(lines: T[], platform: PlatformId): T[] {
  return lines.filter(
    (line) => line.enabled !== false && (line.platforms === undefined || line.platforms.includes(platform)),
  );
}

/**
 * CDN 直链 Range 预检：链路对**每一条**线路的返回值都做实测，只有真能取到
 * 音频字节的地址才被采纳/缓存。原因：第三方线路（免请求直出模板、代理型
 * CDN、按歌名搜索）随时可能返回已失效的直链，而"返回了 URL"本身不代表能播
 * ——死链一旦被采纳就会堵住后面所有线路，并被前端缓存回填给引擎，造成
 * 「作废缓存重取 → 拿到同一条死链 → 再失败」（2026-09-17/18 实测两次）。
 *
 * 判定：连接失败、4xx（403/416 除外，Range 不被支持 ≠ 不可播）、5xx、
 * 以及 JSON/HTML/纯文本响应（错误页）都视为死链；能取到音频字节即通过。
 */
async function verifyPlayable(request: RequestBuiltin, url: string): Promise<boolean> {
  try {
    const res = await request(url, {
      method: "GET",
      headers: { Range: "bytes=0-1" },
      timeoutMs: 5000,
    });
    if (res.statusCode === 403 || res.statusCode === 416) return true;
    const contentType = String(res.headers["content-type"] ?? "");
    return res.statusCode >= 200 && res.statusCode < 400 && !/json|html|text\/plain/i.test(contentType);
  } catch {
    return false;
  }
}

/** 蓝本 playFromSource（music-api.ts:3303）：跨源搜 3 首逐个试核心取链，失败返回空串不抛错。 */
export async function playFromSource(
  request: RequestBuiltin,
  keyword: string,
  target: "kw" | "wyy",
  quality: Quality,
): Promise<string> {
  try {
    const results = await (target === "kw" ? kw : wyy).search(request, keyword, 1, 3);
    for (const hit of results) {
      try {
        const url = await (target === "kw" ? kw : wyy).musicUrlCore(request, hit, quality);
        if (url.length > 0) return url;
      } catch {
        // 单首失败继续尝试
      }
    }
  } catch {
    // 搜索失败按蓝本语义返回空串
  }
  return "";
}

export async function resolvePlayUrl(
  request: RequestBuiltin,
  source: Source,
  song: MusicInfo,
  quality: Quality,
  platform: PlatformId = LOCAL_PLATFORM,
): Promise<string> {
  const config = await getChainConfig();
  const budget = new ChainBudget(config.budget.totalMs, config.budget.lineMs);
  return resolvePlayUrlWithBudget(request, source, song, quality, budget, platform);
}

/**
 * 带预算的取链实现：整链总预算 + 单线路分片上限（金额来自 ChainConfig，
 * 测试可传自定义 budget 覆盖）。
 */
export async function resolvePlayUrlWithBudget(
  request: RequestBuiltin,
  source: Source,
  song: MusicInfo,
  quality: Quality,
  budget: ChainBudget,
  platform: PlatformId = LOCAL_PLATFORM,
): Promise<string> {
  const config = await getChainConfig();
  const cacheKey = source + ":" + song.id + ":" + quality;
  const cached = urlCache.get(cacheKey);
  if (cached.length > 0) return cached;

  // 档内线路：按音质过滤 → 行级 enabled/platforms 过滤 → 封顶 maxLinesPerQuality
  const runners = filterChainLines(config.chains[source] ?? [], platform)
    .filter((line) => line.qualities.includes(quality))
    .slice(0, config.maxLinesPerQuality)
    .map((line) => ({ parallel: line.parallel === true, executor: lineExecutor(line, source) }))
    .filter((runner): runner is { parallel: boolean; executor: LineExecutor } => runner.executor !== null);

  // parallel 线路提前起跑（失败按空串处理），到达序位时直接收割
  const started = new Map<LineExecutor, Promise<string>>();
  for (const runner of runners) {
    if (runner.parallel) {
      started.set(runner.executor, runner.executor(request, song, quality).catch(() => ""));
    }
  }
  for (const runner of runners) {
    if (budget.expired) break;
    // 挂死的线路由分片上限切断，让后面的线路还有机会；整链总时长由预算兜底
    let url = await budget.run(
      started.get(runner.executor) ?? runner.executor(request, song, quality).catch(() => ""),
      "",
    );
    // 每条线路的返回值都实测（见 verifyPlayable 注释）：死链按未命中继续换源
    if (url.length > 0 && !(await budget.run(verifyPlayable(request, url), false))) {
      url = "";
    }
    if (url.length > 0) return settle(cacheKey, url);
  }
  // 档内全灭 → 跨源兜底（同样受预算约束；只认 kw/wyy 互备）
  const keyword = song.name + " " + song.singer;
  for (const target of config.crossSources[source] ?? []) {
    if (target !== "kw" && target !== "wyy") continue;
    if (budget.expired) break;
    const url = await budget.run(playFromSource(request, keyword, target, quality), "");
    if (url.length > 0) return settle(cacheKey, url);
  }
  throw new Error("该歌曲暂时无法播放");
}

function settle(cacheKey: string, url: string): string {
  urlCache.set(cacheKey, url);
  return url;
}
