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
 * crossSources 跨源（酷我↔网易云）兜底。跨源有**预算下限**（CROSS_RESERVE_MS，
 * 档内线路不许吃掉最后一段——kg 三条串行线实测能吃满 totalMs，导致跨源一次都
 * 跑不到）；同一平台连续全灭到阈值还会**降级**（DEGRADE_TTL_MS 内先走跨源）。
 * 每条线路的返回值都过 Range 预检（verifyPlayable）——第三方直出模板与代理型
 * CDN 随时可能返回死链，只有实测能取到音频字节的地址才被采纳/缓存。整链带取链
 * 预算（budget.ts，金额可被 chain.json 覆盖）：引擎问前端取链只等 15s，挂死的
 * 线路必须被分片上限切断。脚本侧 10 分钟 TTL 缓存与宿主侧 Rust PlayUrlCache 互不冲突。
 */
import type { ChainLine, PlatformId } from "../chain-config";
import { LOCAL_PLATFORM } from "../chain-config";
import type { MusicInfo, Quality, RequestBuiltin, Source } from "../contract";
import { ChainBudget } from "../budget";
import { kg } from "../platforms/kg";
import { kw } from "../platforms/kw";
import { qq } from "../platforms/qq";
import { wyy } from "../platforms/wyy";
import { kgHaitangCore, qqHaitangCore } from "../platforms/haitang-core";
import { TtlCache } from "../platforms/utils";
import { runHttpLine } from "../lines/declarative";
import { getChainConfig } from "../chain-store";
import { getLxHost, lxPlayUrl } from "../schemes/lx-host/sources";

const PLAY_URL_TTL_MS = 10 * 60 * 1000;
const urlCache = new TtlCache(PLAY_URL_TTL_MS);

/**
 * Range 预检单独的时间片（不吃整条线路的分片）。
 *
 * 预检只是「这条直链还能不能取到音频字节」的校验，代价应当远小于取址本身；
 * 按整条线路的分片计时会出现两个后果（2026-09-21 实测）：
 *   · 一条线路 + 它的预检 = 2×lineMs，足够吃光 totalMs，后面线路全部「预算耗尽未跑」；
 *   · 预检慢过切片时被判成「死链（Range 预检不过）」，把合法直链丢掉——
 *     实测该直链随后返回 206 + 2 字节，按 verifyPlayable 口径本来是通过。
 */
const VERIFY_MS = 2500;

/**
 * 留给跨源兜底的预算下限（档内线路不许吃掉这最后一段）。
 *
 * 背景（2026-09-24 PC 实测）：跨源兜底排在档内线路**之后**、共用同一个 totalMs，
 * 而 kg 三条线全是串行 lx 脚本，分片是 2500+1250+1250 = 正好 5000ms。kg 一慢，
 * 预算在档内就被吃光，跨源那一步直接判「预算耗尽未跑」——用户看到的是
 * 「酷狗取链失败却从不换源到酷我」。真实 trace：
 *   kg@320 kg-yuxi=空; kg-stellarwave=空; kg-molan=空;
 *   cross:kw=预算耗尽未跑; cross:wyy=预算耗尽未跑
 *
 * 实测跨源那一段自己只要 129~617ms（中位 182ms，32 首样本），所以留 1500ms
 * 足够它跑完两个目标；档内线路仍保有 3.5s。总预算很小（测试/收紧档）时按
 * 1/3 收缩，避免预留把档内线路全部挤掉。
 */
const CROSS_RESERVE_MS = 1500;

/**
 * 档内线路之间、跨源目标之间都要给「后面的兄弟」留的时间。
 *
 * 只按「剩余的一半」分摊是不够的：第一条线路慢一点、或它的 Range 预检慢一点，
 * 预算就被吃到只剩跨源预留，后面每条线路都记「预算耗尽未跑」——用户看到的是
 * 「只走了第一条 kw-native-des，失败就跳下一首」（2026-09-24 反馈，kw 4 条线）。
 * 档内 4~5 条线共享 3.5s，所以给后面每条各留 600ms；末尾一条自然拿走全部剩余。
 * 跨源同理：kw 挂死时 wyy 仍要有份额（两个目标都要试，见 runCrossSources）。
 * 实测线路耗时：kw 整链最慢 209ms、qq 1031ms、wyy 1648ms、跨源 129~617ms，
 * 600ms 对「不是第一个的」是够用的。
 */
const MIN_SLOT_MS = 600;

/**
 * 平台级降级：同一平台连续全灭到阈值，就在 DEGRADE_TTL_MS 内**先走跨源**。
 *
 * 治的是「一首接一首报错切歌」：某平台整体坏掉时（kg 实测 20 首里 2 首全灭），
 * 队列里每首都要先烧 2.5~5s 走完档内线路才轮到跨源。降级后跨源（约 0.2s）先跑，
 * 命中即返回，用户侧从「每首卡 5 秒然后跳歌」变成「每首约 0.2 秒正常播放」。
 * 档内线路一次成功即解除；TTL 到期后会再试一次档内，用来探测平台是否恢复。
 */
const DEGRADE_MISSES = 3;
const DEGRADE_TTL_MS = 60_000;

/** 平台健康度（仅内存；进程重启即清空） */
const sourceHealth = new Map<Source, { misses: number; until: number }>();

function isSourceDegraded(source: Source): boolean {
  const health = sourceHealth.get(source);
  return health !== undefined && health.until > Date.now();
}

function noteSourceMiss(source: Source): void {
  const health = sourceHealth.get(source) ?? { misses: 0, until: 0 };
  health.misses += 1;
  if (health.misses >= DEGRADE_MISSES) health.until = Date.now() + DEGRADE_TTL_MS;
  sourceHealth.set(source, health);
}

function noteSourceHit(source: Source): void {
  sourceHealth.delete(source);
}

/** 平台健康度快照（诊断用：管理端/日志可看某平台是否处于降级） */
export function sourceHealthSnapshot(): Record<string, { misses: number; degraded: boolean }> {
  const out: Record<string, { misses: number; degraded: boolean }> = {};
  for (const [source, health] of sourceHealth) {
    out[source] = { misses: health.misses, degraded: isSourceDegraded(source) };
  }
  return out;
}

/** 清空平台健康度（测试用） */
export function resetSourceHealth(): void {
  sourceHealth.clear();
}

/** 单条线路解析成的执行函数（未命中返回空串；失败抛错也按未命中处理） */
type LineExecutor = (request: RequestBuiltin, song: MusicInfo, quality: Quality) => Promise<string>;

/** bundle 复杂实现注册表：chain.json 的 impl 名 → 执行函数 */
const BUNDLE_IMPLS: Record<string, LineExecutor> = {
  wyyMusicUrlCore: (request, song, quality) => wyy.musicUrlCore(request, song, quality),
  qqMusicUrlCore: (request, song, quality) => qq.musicUrlCore(request, song, quality),
  kwMusicUrlCore: (request, song, quality) => kw.musicUrlCore(request, song, quality),
  kgMusicUrlCore: (request, song, quality) => kg.musicUrlCore(request, song, quality),
  // 恒堂核心 API（POST JSON 官源直链解析）—— 只有 qq/kg 两条链在用
  qqHaitangCore,
  kgHaitangCore,
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

/**
 * 蓝本 playFromSource（music-api.ts:3303）：跨源搜 3 首逐个试核心取链，失败返回空串不抛错。
 *
 * **已不再被跨源兜底调用**（2026-09-24 需求改为「每个跨源目标只跑它自己的第 1 条链线路」，
 * 见 crossFirstLineUrl）：本函数按关键词搜索、命中 3 首候选逐个取链，既与「只跑第一条」
 * 不符，也绕开了链配置的音质/平台过滤。保留作为与蓝本对照的实现，勿在取链主链路上调用。
 */
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

/** 最近一次整链全灭的逐线路追踪（诊断用；安卓端会随「未取到播放地址」一并上抛） */
let lastMissTrace = "";
/**
 * 上面这条追踪属于哪次请求（cacheKey = source:song.id:quality）。
 *
 * 没有归属标记时，并发/被外层提前截断的请求会把别的请求的死因报进本次错误文本——
 * 2026-09-21 用户日志里三条不同歌曲的 trace 逐字相同，就是这么来的。
 */
let lastMissKey = "";

/** 读走最近一次全灭追踪（读后即清，避免旧 trace 混进下一次失败）；归属不匹配返回空串 */
export function consumeLastMissTrace(key: string): string {
  if (lastMissKey !== key) return "";
  const t = lastMissTrace;
  lastMissTrace = "";
  lastMissKey = "";
  return t;
}

/**
 * 最近一次取链**命中**的线路（管理端「当前播放地址」要显示「这条地址是音源包里
 * 哪条源取到的」）。
 *
 * 成功路径原本什么都不留（trace 只在全灭时写 lastMissTrace），而取链成功恰恰是
 * 最需要知道命中线路的时候：同一条歌在不同时间可能被不同线路接走（顺序回退 +
 * parallel 抢跑 + 跨源兜底），只看地址看不出是哪个源。
 *
 * 存**对象**（不是 JSON 文本）：它随 getPlayUrl 的应答一起 JSON.stringify 出去，
 * 到了前端就是一个嵌套对象 {id,name,kind}，宿主直接取字段即可。
 * （早先版本存的是字符串化 JSON，宿主还得再 parse 一次——已改掉。）
 */
let lastHitLine: HitLine | null = null;
let lastHitKey = "";

/** 命中线路的形状：{id, name, kind}（kind 额外含 "cross" = 跨源兜底） */
export interface HitLine {
  id: string;
  name: string;
  kind: string;
}

/** 读走最近一次命中线路（读后即清）；归属不匹配返回 null */
export function consumeLastHitLine(key: string): HitLine | null {
  if (lastHitKey !== key) return null;
  const t = lastHitLine;
  lastHitLine = null;
  lastHitKey = "";
  return t;
}

/** 跨源兜底线路的展示名（chain.json 里没有 cross 线路，名字在这里定） */
const CROSS_LINE_NAMES: Record<string, string> = { kw: "酷我（跨源兜底）", wyy: "网易云（跨源兜底）" };

/** 记下命中线路（cacheKey 归属，与 lastMissKey 同一口径） */
function markHitLine(cacheKey: string, id: string, name: string, kind: string): void {
  lastHitLine = { id, name, kind };
  lastHitKey = cacheKey;
}

/** 单条线路的追踪摘要：失败原因截断到 60 字符，防止错误消息撑爆引擎应答 */
function traceEntry(lineId: string, detail: string): string {
  const d = detail.length > 60 ? detail.slice(0, 60) + "…" : detail;
  return `${lineId}=${d}`;
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
  lastMissTrace = "";
  lastMissKey = "";
  // 上一次命中的线路不能留给这一次：两个 key 不一致时 consumeLastHitLine 本来就
  // 读不走它，但同 key 的第二次请求（作废缓存后重取）会读到上一次的旧线路。
  lastHitLine = null;
  lastHitKey = "";

  // 档内线路：按音质过滤 → 行级 enabled/platforms 过滤 → 封顶 maxLinesPerQuality
  // name/kind 一并带进 runner：命中时要回报「是哪条源取到的」（见 markHitLine）
  const runners = filterChainLines(config.chains[source] ?? [], platform)
    .filter((line) => line.qualities.includes(quality))
    .slice(0, config.maxLinesPerQuality)
    .map((line) => ({
      id: line.id,
      name: line.name,
      kind: line.kind as string,
      parallel: line.parallel === true,
      executor: lineExecutor(line, source),
    }))
    .filter(
      (runner): runner is { id: string; name: string; kind: string; parallel: boolean; executor: LineExecutor } =>
        runner.executor !== null,
    );
  const trace: string[] = [];

  // 跨源兜底：只认 kw/wyy 互备（crossFirstLineUrl 的实现面）；没有可走的目标就不预留预算
  const crossTargets = (config.crossSources[source] ?? []).filter(
    (target): target is "kw" | "wyy" => target === "kw" || target === "wyy",
  );
  const reserve =
    crossTargets.length > 0
      ? Math.min(CROSS_RESERVE_MS, Math.floor(budget.totalMs / 3))
      : 0;
  const keyword = song.name + " " + song.singer;

  // 降级中：先花一小段（≤reserve）试跨源，命中即返回；没命中再把剩下的预算给档内线路
  if (reserve > 0 && isSourceDegraded(source)) {
    trace.push("降级中");
    const early = await runCrossSources(request, keyword, crossTargets, song, quality, budget, trace, reserve);
    if (early.target !== null) {
      markHitLine(cacheKey, "cross:" + early.target, CROSS_LINE_NAMES[early.target], "cross");
      return settle(cacheKey, early.url);
    }
  }

  // parallel 线路提前起跑（失败按空串处理），到达序位时直接收割
  const started = new Map<LineExecutor, Promise<string>>();
  for (const runner of runners) {
    if (runner.parallel) {
      started.set(
        runner.executor,
        runner.executor(request, song, quality).catch((e: unknown) => `err:${msgOf(e)}`),
      );
    }
  }
  for (let i = 0; i < runners.length; i++) {
    const runner = runners[i];
    // 档内线路之间也要公平分摊：usable = 扣掉跨源预留后的可用预算，
    // 本线路只能用「给后面每条各留 MIN_SLOT_MS」之后剩下的部分。
    // 不分摊的后果（2026-09-24 反馈）：第一条线路（或它慢过切片的 Range 预检）
    // 就能吃光档内预算，后面每条线路都被记为「预算耗尽未跑」——用户看到的是
    // 「换源只走了第一条 kw-native-des，失败就跳下一首」。
    const restCount = runners.length - 1 - i;
    const usable = Math.max(0, budget.remainingMs - reserve);
    if (usable <= 0) {
      trace.push(traceEntry(runner.id, "预算耗尽未跑"));
      continue;
    }
    const keepForRest = Math.min(usable, MIN_SLOT_MS * restCount);
    const lineSlice = Math.max(1, Math.min(budget.sliceMs(), usable - keepForRest));
    // 挂死的线路由分片上限切断，让后面的线路还有机会；整链总时长由预算兜底
    const outcome = await budget.runTimed(
      started.get(runner.executor) ?? runner.executor(request, song, quality).catch((e: unknown) => `err:${msgOf(e)}`),
      "",
      lineSlice,
    );
    const raw = outcome.value;
    let url = typeof raw === "string" ? raw : "";
    if (typeof raw === "string" && raw.length > 6 && raw.startsWith("err:")) {
      trace.push(traceEntry(runner.id, raw));
      continue;
    }
    // 超时必须与「线路返回空」区分开：否则 trace 里两种死法都是「空」，
    // 事后分不清是线路挂死还是它真没结果（2026-09-24 排查 kg 时就踩过这个）。
    if (url.length === 0 && outcome.timedOut) {
      trace.push(traceEntry(runner.id, "超时未返回"));
      continue;
    }
    // 每条线路的返回值都实测（见 verifyPlayable 注释）：死链按未命中继续换源。
    // 预检单独给 VERIFY_MS，不吃整条线路的分片——它只是校验，不该和取址同价；
    // 且必须区分「超时」与「死链」：超时只说明这档预算不够，记成死链会把好链接判死
    // （2026-09-21 实测：206 + 2 字节的合法直链被记成「死链（Range 预检不过）」）。
    // 预检同样不许吃跨源预留：它按固定 VERIFY_MS 计时的话，三条线各带一次预检
    // 就能把整次取链拖过 totalMs（2026-09-24 实测失败耗时 5251ms、连 trace 都没写回来）。
    if (url.length > 0) {
      // 预检同样只从「本线路的份额」里出：后面的线路各留 MIN_SLOT_MS，
      // 剩下的才是这条线路的预检额度（前面线路答得快，额度自然就大）。
      const usableNow = Math.max(0, budget.remainingMs - reserve);
      const keepForRestNow = Math.min(usableNow, MIN_SLOT_MS * restCount);
      const verifySlice = Math.min(VERIFY_MS, Math.max(0, usableNow - keepForRestNow));
      const verified = await budget.runTimed(verifyPlayable(request, url), false, verifySlice);
      if (!verified.value) {
        trace.push(traceEntry(runner.id, verified.timedOut ? "预检超时" : "死链（Range 预检不过）"));
        url = "";
      }
    }
    if (url.length > 0) {
      trace.push(traceEntry(runner.id, "ok"));
      markHitLine(cacheKey, runner.id, runner.name, runner.kind);
      noteSourceHit(source);
      return settle(cacheKey, url);
    }
    if (!trace.some((t) => t.startsWith(runner.id + "="))) trace.push(traceEntry(runner.id, "空"));
  }
  // 档内全灭 → 跨源兜底（同样受预算约束；只认 kw/wyy 互备）
  const cross = await runCrossSources(request, keyword, crossTargets, song, quality, budget, trace);
  if (cross.target !== null) {
    // 跨源兜底命中：报成 cross:<target>，管理端一眼看出「本档线路全灭、是跨源救回来的」
    markHitLine(cacheKey, "cross:" + cross.target, CROSS_LINE_NAMES[cross.target], "cross");
    return settle(cacheKey, cross.url);
  }
  // 整链全灭才记一次平台失败（降级阈值见 DEGRADE_MISSES）
  noteSourceMiss(source);
  const degraded = isSourceDegraded(source) ? "[降级中]" : "";
  lastMissTrace = `${source}@${quality}${degraded} ${trace.join("; ")}`;
  lastMissKey = cacheKey;
  throw new Error("该歌曲暂时无法播放");
}

/**
 * 跨源取链：跑目标源（kw/wyy）**第 1 条链线路**，只给它一次机会。
 *
 * 「第 1 条」按与档内完全相同的口径选出，否则会出现「档内能跑、跨源却跑不动」：
 *   · `filterChainLines(platform)` —— 行级 enabled 与 platforms 白名单；
 *   · `qualities.includes(quality)` —— 该线路支持本音质；
 *   · `lineExecutor(line, target) !== null` —— 引用失效（lx 脚本 / bundle impl 缺失）的线路跳过，
 *     取第一条**真正能跑**的（chain.json 里第 1 条若是坏引用，就等价于没有第 1 条）。
 * 找不到可跑线路时返回空串即可（记 trace「空」，与线路本身失败同义）。
 *
 * 不再走 playFromSource（搜 3 首逐个 musicUrlCore）：那是"多首候选"的兜底，
 * 与本次需求「每个源只跑第一条音源」不符，且它绕开了链配置（音质/平台过滤全丢）。
 */
async function crossFirstLineUrl(
  request: RequestBuiltin,
  target: "kw" | "wyy",
  song: MusicInfo,
  quality: Quality,
): Promise<string> {
  const config = await getChainConfig();
  const candidates = filterChainLines(config.chains[target] ?? [], LOCAL_PLATFORM)
    .filter((line) => line.qualities.includes(quality))
    .slice(0, config.maxLinesPerQuality);
  for (const line of candidates) {
    const executor = lineExecutor(line, target);
    if (executor === null) continue;
    try {
      const url = await executor(request, song, quality);
      if (url.length > 0) return url;
    } catch {
      // 与 playFromSource 同语义：失败按空串处理，不抛错给上层
    }
    // 只跑第一条：第一条失败（空/抛错）就不再往下看该源的第二条
    break;
  }
  return "";
}

/**
 * 跨源兜底：**每个目标源都试，但每个目标只跑它自己的第 1 条链线路**。
 *
 * 需求（2026-09-24 用户确认）：「kw 和 wyy 鼓励公平分配，但直到 kw 的第一条源和
 * wyy 的第一条源，不会进行到下面的第二条源」。即：
 *   · 两个跨源目标都要参与，并且公平分摊预算（第一个挂死不能饿死第二个）；
 *   · 每个目标内部**只跑第 1 条链线路**（kw → kw-native-des，wyy → wyy-core），
 *     不像档内那样把该源第 2、3、4 条线路也轮一遍——跨源是兜底，一次机会就够；
 *   · 第一个目标失败就换下一个目标，全部目标都失败才判整体失败（客户端下一首）。
 *
 * 注意与档内的区别：档内线路用共享的 totalMs 顺序跑；跨源用预留段
 * （CROSS_RESERVE_MS，档内线路一律不许吃掉它，否则 kg 三条串行线能吃满 5000ms，
 * 跨源那一步会判「预算耗尽未跑」）。给了 capMs 时整段不超过 capMs（平台降级抢先试）。
 * 失败返回空串（不抛错，调用方继续）。
 */
async function runCrossSources(
  request: RequestBuiltin,
  keyword: string,
  targets: Array<"kw" | "wyy">,
  song: MusicInfo,
  quality: Quality,
  budget: ChainBudget,
  trace: string[],
  capMs?: number,
): Promise<{ url: string; target: "kw" | "wyy" | null }> {
  void keyword; // 跨源走链配置（按 song 取链），不再按关键词搜索候选
  const startedAt = Date.now();
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const left = budget.remainingMs;
    const capLeft = capMs === undefined ? left : capMs - (Date.now() - startedAt);
    const usable = Math.min(left, capLeft);
    if (usable <= 0) {
      trace.push(traceEntry("cross:" + target, "预算耗尽未跑"));
      continue;
    }
    // 公平分摊：给后面的跨源目标各留 MIN_SLOT_MS，避免第一个目标挂死饿死第二个
    const restCount = targets.length - 1 - i;
    const keepForRest = Math.min(usable, MIN_SLOT_MS * restCount);
    const slice = Math.max(1, usable - keepForRest);
    const url = await budget.run(crossFirstLineUrl(request, target, song, quality), "", slice);
    trace.push(traceEntry("cross:" + target, url.length > 0 ? "ok" : "空"));
    if (url.length > 0) return { url, target };
  }
  return { url: "", target: null };
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function settle(cacheKey: string, url: string): string {
  urlCache.set(cacheKey, url);
  return url;
}
