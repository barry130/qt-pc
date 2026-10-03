/**
 * 音源引擎窗口 RPC 封装（双音源包架构）。
 *
 * 引擎窗口（label "source-engine"，见 src-tauri/src/source_window.rs）加载
 * qtres:// 内嵌引擎页：先装载用户安装的数据包（install/<id>/meta-bundle.js，
 * 数据接口：搜索/歌单/专辑/歌手/榜单/歌词/封面；未装 = 数据面下线），
 * 再按本地状态装配用户安装的播放音源包（play-bundle.js，取链）。主窗口与
 * 它只走事件（source-engine-request → source-engine-response）：
 *   - kind "status"：查询引擎生命周期（booting/ready/error）与当前生效播放包
 *     ——引擎启动早于主窗口前端，boot 时推送的状态事件会错过，绑定后主动查询；
 *   - kind "resolve"：取链（url "" = 失败/无可用层；line = 本次命中的音源线路，
 *     null = 未知，见 PlayUrlLine）；
 *   - kind "invoke"：数据接口，meta-bundle 的 `__qtEntries` 入口名 + JSON
 *     参数，result 为 JSON 文本。
 *
 * 约定：
 * - 引擎未就绪 / 加载失败 / 超时 / 返回空串 → 一律返回空值（"" / null），
 *   调用方给出可操作报错（在线播放缺播放包时引导去设置页安装）；
 * - source-pack-changed（Rust 在安装/切换/卸载播放包后广播）→ 引擎页同一
 *   上下文热切换播放包、不重建窗口，主窗口侧只复位生命周期缓存待重新查询。
 */
import { emitTo, listen } from "@tauri-apps/api/event";
import { stripErrorUrls } from "@/lib/utils";
import type { Quality } from "@/types";
import type { MusicInfo, Source } from "@/source-scripts/qt-contract/contract";

/** 引擎页生命周期：booting=启动中 ready=可用 error=失败 */
export type EnginePhase = "booting" | "ready" | "error";

interface EngineReply {
  url?: string;
  /** 本次取链命中的音源线路（bundle 的 getPlayUrl 应答里的 line） */
  line?: unknown;
  phase?: EnginePhase;
  code?: number | null;
  detail?: string | null;
  /** kind=status 附带：当前生效播放包（null = 未装配播放包） */
  pack?: EnginePackSnapshot | null;
  /** kind=invoke 的返回值（bundle 入口的 JSON 文本） */
  result?: string | null;
  error?: string | null;
}

/** 引擎当前装配的播放包快照（status 应答附带；数据包不在引擎侧装配，不在此列） */
export interface EnginePackSnapshot {
  id: string;
  code: number;
  name: string;
  version: string;
}

/**
 * 取链命中的音源线路：音源包 chain.json 里那条真正给出地址的源。
 * kind 取值 lx / http / bundle，另有 "cross" = 本档线路全灭、跨源兜底救回。
 * （安卓端同名字段见 qt-uniappx/services/source-engine.uts 的 PlayUrlLine。）
 */
export interface PlayUrlLine {
  id: string;
  name: string;
  kind: string;
  /** 仅跨源兜底命中时有值：目标平台上实际命中的那首歌（旧引擎页/缓存命中为 null） */
  targetSong: MusicInfo | null;
}

/** 取链结果：地址 + 命中线路（line null = 未知，不是失败）+ 失败死因（trace） */
export interface EngineResolved {
  url: string;
  line: PlayUrlLine | null;
  /**
   * 取链失败时 bundle 抛出的逐线路 trace（`kg@320 kg-yuxi=超时未返回; …;
   * cross:kw=预算耗尽未跑`）；成功或引擎页较旧时为空串。
   * 用途：管理端面板显示「上次取链死因」+ 控制台告警——以前这条文本被吞掉，
   * 「酷狗失败却不换源」只能靠猜。
   */
  error: string;
  /**
   * 本次失败是**环境问题**（引擎未就绪 / 应答超时）而非「音源没这首」。
   *
   * 2026-10-03 弱网修复：弱网时 trace 里全是「超时未返回」，与「音源线路
   * 确实答不出地址」在 url 上都表现为空串。上面这个区分让调用方能把
   * 「等网络」与「换下一首」分开，不再把弱网当成歌坏从而打满熔断。
   */
  stalled: boolean;
}

/**
 * 取链 RPC 超时：**8s**。
 *
 * 引擎侧链预算是 `CHAIN_BUDGET_MS = 5s`（chain.json budget.totalMs，
 * 见 qt-sources/src/budget.ts），所以 8s = 5s 预算 + 3s 调度余量已经覆盖
 * 「链跑满」的最坏情况。超时即按本次取链失败处理（没有内置实现可回退）。
 *
 * 为什么不再留 15s（2026-10-03 弱网修复）：弱网下链内 5s 预算必然烧光，
 * 此时外层多等的每一秒都是纯白等——用户看到的是「每首卡十几秒才失败」，
 * 连挂 5 首就凑满熔断，弱网被放大成「疯狂不可用」。收到 8s 让单首失败
 * 更快落地，配合「超时不计入熔断、原地重试」才是正确的组合。
 *
 * 与引擎→前端取链桥的关系（不变量）：引擎主导换歌时，前端是被 Rust 的
 * `ask_frontend` 叫起来应答的，它的应答路径包含本超时常程 + 两次 IPC 往返。
 * 所以 `playurl_bridge.rs` 的 ASK_TIMEOUT 必须**严格大于**本值
 * （现为 12s = 8s + 4s 余量）；两边相等就是零余量，跑满链预算的慢取链
 * 会被桥判超时丢弃。改这里必须同步复核那边。
 */
const RESOLVE_TIMEOUT_MS = 8_000;
/**
 * 数据接口 RPC 超时：搜索/聚合类要打多平台 HTTP（单请求上限 15s），
 * 比取链宽松；超时按"引擎叫不动"处理（同样没有内置实现可回退）。
 */
export const INVOKE_TIMEOUT_MS = 20_000;
/** 状态查询单次超时 / 重试上限（引擎启动毫秒级，上限只为防呆） */
const STATUS_QUERY_TIMEOUT_MS = 2_500;
const STATUS_QUERY_MAX_FAILURES = 2;
/**
 * booting 轮询总时长上限。引擎页活着但卡死在 boot（某个 bundle init 的
 * await 永不落定）时，refreshPhase 会无限轮询，engineResolve/engineInvoke
 * 里的 `await ensureBound()` 永不返回 —— 点歌、搜索全部静默挂死且没有任何
 * 报错路径（Rust 桥 12s 兜底只覆盖取链应答路径，UI 直调的数据接口没有）。
 * 到上限置 error（挂后台重探），调用方立刻拿到明确的失败。
 */
const BOOTING_POLL_MAX_MS = 10_000;
const BOOTING_POLL_INTERVAL_MS = 400;

/**
 * 引擎置 error 后的后台重探间隔（指数退避，封顶 ERROR_REPROBE_MAX_MS）。
 *
 * 为什么需要它：`phase` 一旦变成 "error" 就是**终态** —— `ensureBound()` 只在
 * `phase === null` 时才重新查询，于是 `engineResolve` / `engineInvoke` 会一直
 * 短路返回空值，第三方源在本次会话里永久失效（唯一的复位是安装/回滚音源包触发的
 * source-applied 事件）。
 *
 * 而引擎页是会被**临时冻住**的：音源脚本 init 走同步执行且没有超时
 * （bridge.ts 的 spec.run），脚本里一个同步忙循环就能让引擎页几十秒不响应；
 * 两次 status 查询超时（2×2.5s）之后 phase 就锁死在 error —— 脚本恢复正常了，
 * 音源也回不来了。2026091905 事故正是这个形状（脚本自校验退化成同步忙循环）。
 *
 * 所以置 error 时挂一个后台重探：**不占用户关键路径**（resolve/invoke 不会因此
 * 变慢，仍然走既有短路逻辑立刻回退），探到 ready 就自动恢复。退避是为了引擎
 * 确实不存在时（未装音源包 / 窗口未创建）不做无意义的高频查询。
 */
const ERROR_REPROBE_BASE_MS = 15_000;
const ERROR_REPROBE_MAX_MS = 120_000;
let reprobeTimer: number | null = null;
let reprobeDelay = ERROR_REPROBE_BASE_MS;

/** 停掉后台重探并复位退避（引擎已恢复，或即将由 source-applied 重新查询） */
function cancelReprobe(): void {
  if (reprobeTimer !== null) {
    window.clearTimeout(reprobeTimer);
    reprobeTimer = null;
  }
  reprobeDelay = ERROR_REPROBE_BASE_MS;
}

/** 置 error 后安排一次后台重探；重复调用是安全的（已有计时器就直接返回） */
function scheduleReprobe(): void {
  if (reprobeTimer !== null) return;
  reprobeTimer = window.setTimeout(() => {
    reprobeTimer = null;
    // 期间可能已被 source-applied 复位成 null 或查询成 ready，那就不必再探
    if (phase !== "error") {
      reprobeDelay = ERROR_REPROBE_BASE_MS;
      return;
    }
    void refreshPhase().then(() => {
      if (phase === "error") {
        reprobeDelay = Math.min(reprobeDelay * 2, ERROR_REPROBE_MAX_MS);
        scheduleReprobe();
      } else {
        reprobeDelay = ERROR_REPROBE_BASE_MS;
      }
    });
  }, reprobeDelay);
}

let bound = false;
let binding: Promise<void> | null = null;
/** null = 尚未查询过（绑定后/resets 后由 refreshPhase 填充） */
let phase: EnginePhase | null = null;

/** 引擎相位变化订阅（组件/Store 用，返回取消函数）。引擎 error 后经后台重探
 *  自愈回 ready 不广播 source-pack-changed——注册表 Store 等依赖方借此补取。 */
type PhaseListener = (phase: EnginePhase | null) => void;
const phaseListeners = new Set<PhaseListener>();

export function onEnginePhaseChange(fn: PhaseListener): () => void {
  phaseListeners.add(fn);
  return () => phaseListeners.delete(fn);
}

/** 相位唯一写入口：变化时通知订阅方（订阅方异常不拖垮引擎层） */
function setPhase(next: EnginePhase | null): void {
  if (phase === next) return;
  phase = next;
  for (const fn of phaseListeners) {
    try {
      fn(next);
    } catch {
      // ignore
    }
  }
}

let remoteCode: number | null = null;
let engineDetail: string | null = null;
let enginePack: EnginePackSnapshot | null = null;

let seq = 0;
const pending = new Map<number, (reply: EngineReply) => void>();

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("engine timeout")), ms);
    p.then(
      (v) => {
        window.clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function onResponse(payload: EngineReply & { requestId?: number }): void {
  const requestId = payload?.requestId;
  if (typeof requestId !== "number") return;
  const resolve = pending.get(requestId);
  if (!resolve) return;
  pending.delete(requestId);
  resolve(payload);
}

async function emitRequest(payload: Record<string, unknown>): Promise<void> {
  await emitTo("source-engine", "source-engine-request", payload);
}

/** 查一次引擎生命周期；查不到（引擎窗口不在/超时）返回 null */
async function queryPhaseOnce(): Promise<EnginePhase | null> {
  const requestId = ++seq;
  const reply = new Promise<EngineReply>((resolve) => pending.set(requestId, resolve));
  try {
    await emitRequest({ requestId, kind: "status" });
  } catch {
    pending.delete(requestId);
    return null;
  }
  const answer = await withTimeout(reply, STATUS_QUERY_TIMEOUT_MS)
    .finally(() => pending.delete(requestId))
    .catch(() => null);
  if (!answer) return null;
  if (typeof answer.phase === "string") {
    remoteCode = typeof answer.code === "number" ? answer.code : null;
    engineDetail = answer.detail ?? null;
    enginePack = normalizeEnginePack(answer.pack);
    return answer.phase;
  }
  return null;
}

/** status 应答里的 pack 只信形状正确的（旧引擎页没有该字段 → null = 未装配） */
function normalizeEnginePack(raw: unknown): EnginePackSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.length === 0) return null;
  return {
    id: obj.id,
    code: typeof obj.code === "number" ? obj.code : 0,
    name: typeof obj.name === "string" ? obj.name : "",
    version: typeof obj.version === "string" ? obj.version : "",
  };
}

/**
 * 刷新引擎生命周期：引擎启动中（booting）轮询直到终态（总时长封顶，见
 * BOOTING_POLL_MAX_MS）；引擎不可达时有限重试后置 error（避免每次取链都空等）。
 * 并发调用共享同一次轮询（refreshing 去重）：否则每个并发调用者各起一个
 * 轮询循环并持续叠加，引擎卡 boot 时循环数量随调用次数增长。
 */
let refreshing: Promise<void> | null = null;

async function refreshPhase(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    let failures = 0;
    const startedAt = Date.now();
    for (;;) {
      const p = await queryPhaseOnce();
      if (p === "booting") {
        if (Date.now() - startedAt >= BOOTING_POLL_MAX_MS) {
          setPhase("error");
          // 终态会一直短路所有调用 → 挂后台重探，等引擎页就绪后自动恢复
          scheduleReprobe();
          return;
        }
        await new Promise((r) => window.setTimeout(r, BOOTING_POLL_INTERVAL_MS));
        continue;
      }
      if (p !== null) {
        setPhase(p);
        return;
      }
      failures += 1;
      if (failures >= STATUS_QUERY_MAX_FAILURES) {
        setPhase("error");
        // 终态会一直短路所有调用 → 挂后台重探，等引擎页解冻/就绪后自动恢复
        scheduleReprobe();
        return;
      }
      await new Promise((r) => window.setTimeout(r, 300));
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function ensureBound(): Promise<void> {
  if (bound) {
    if (phase === null) await refreshPhase();
    return;
  }
  if (!binding) {
    binding = (async () => {
      await listen<EngineReply & { requestId?: number }>(
        "source-engine-response",
        (e) => onResponse(e.payload),
      );
      // 播放包安装/切换/卸载后引擎页热切换（窗口不重建）：复位生命周期缓存，
      // 下次取链前重新查询；在途请求不拆——引擎页 onRequest 全程在线，应答
      // 要么来自旧包（已发出的取链）要么等新包装好后正常返回。
      await listen("source-pack-changed", () => {
        setPhase(null);
        remoteCode = null;
        engineDetail = null;
        enginePack = null;
        // 之前若因引擎 error 挂了后台重探，现在马上就能重新查询，重探作废
        cancelReprobe();
      });
      bound = true;
    })().catch(() => {
      binding = null;
      setPhase("error");
      engineDetail = "event listen failed";
      scheduleReprobe();
    });
  }
  await binding;
  if (bound && phase === null) await refreshPhase();
}

/**
 * 应答里的 line 只信形状正确的：{id: string, name?: string, kind?: string}。
 * 引擎页可能比宿主旧（没有这个字段）、也可能是别的形状，一律按「未知」处理。
 */
function normalizeLine(raw: unknown): PlayUrlLine | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : "";
  if (id.length === 0) return null;
  return {
    id,
    name: typeof obj.name === "string" ? obj.name : "",
    kind: typeof obj.kind === "string" ? obj.kind : "",
    targetSong: normalizeTargetSong(obj.targetSong),
  };
}

/** targetSong 只信形状正确的：跨源兜底在目标平台命中的那首歌（字段缺失按空串兜底） */
function normalizeTargetSong(raw: unknown): MusicInfo | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : "";
  if (id.length === 0) return null;
  return {
    id,
    name: typeof obj.name === "string" ? obj.name : "",
    singer: typeof obj.singer === "string" ? obj.singer : "",
    album: typeof obj.album === "string" ? obj.album : "",
    picUrl: typeof obj.picUrl === "string" ? obj.picUrl : "",
    interval: typeof obj.interval === "number" ? obj.interval : 0,
    musicId: typeof obj.musicId === "string" ? obj.musicId : null,
  };
}

/**
 * 经引擎窗口解析播放地址。
 * url "" = 引擎不可用/解析失败/超时（调用方按本次取链失败处理）；
 * line = 本次命中的音源线路（管理端「当前播放地址」显示走的是哪条源），
 * null = 未知（包内 10 分钟缓存命中，或引擎页比宿主旧没有这个字段）；
 * error = 失败时的逐线路 trace（成功为空串）；
 * stalled = 本次失败是环境问题（引擎未就绪/发不出去/超时）而非「音源没这首」。
 */
export async function engineResolve(
  source: Source,
  song: MusicInfo,
  quality: Quality,
): Promise<EngineResolved> {
  await ensureBound();
  // 引擎未就绪：环境问题（弱网下引擎页可能被冻住），不是这首歌没地址
  if (phase !== "ready") return { url: "", line: null, error: "", stalled: true };
  const requestId = ++seq;
  const reply = new Promise<EngineReply>((resolve) => pending.set(requestId, resolve));
  try {
    await emitRequest({ requestId, kind: "resolve", source, song, quality });
  } catch {
    pending.delete(requestId);
    return { url: "", line: null, error: "", stalled: true };
  }
  const answer = await withTimeout(reply, RESOLVE_TIMEOUT_MS)
    .finally(() => pending.delete(requestId))
    .catch(() => null);
  // 应答超时：链预算 5s 都烧光了还没回，判环境问题
  if (!answer) return { url: "", line: null, error: "", stalled: true };
  const url = String(answer.url ?? "");
  const error = typeof answer.error === "string" ? answer.error : "";
  // 死因落控制台：面板只在 qt_admin 打开时才看得到，日志是排障的第一现场
  if (url.length === 0 && error.length > 0) {
    console.warn(`[playurl] 取链失败 ${source}:${song.id}@${quality} — ${error}`);
  }
  // 音源包在 trace 前缀打 `[网络]` 表示「整链没有一条线路拿到过响应」，
  // 即本次全灭是弱网/引擎卡造成的环境问题，而不是这个音源没这首歌
  // （见 qt-sources/src/actions/play-url.ts 的 noteSourceMissFiltered）。
  // 据此让 stalled=true，引擎不把曲目拉黑、不计入熔断。
  const stalled = url.length === 0 && /\[网络\]/.test(error);
  return { url, line: normalizeLine(answer.line), error, stalled };
}

/** 引擎当前状态快照（设置页展示用） */
export function engineSnapshot(): {
  phase: EnginePhase | null;
  code: number | null;
  detail: string | null;
  pack: EnginePackSnapshot | null;
} {
  return { phase, code: remoteCode, detail: engineDetail, pack: enginePack };
}

/**
 * 经引擎窗口调用内置数据包接口（搜索/歌单/专辑/歌手/榜单/歌词/封面）。
 *
 * 入口名与参数对齐 meta-bundle 的 `__qtEntries`（meta-entries.ts），返回已
 * 解析的 JSON 对象（如 `{list}` / `{detail}` / `{url}`）。应用侧没有内置
 * 实现可回退，因此失败语义分两级：
 * - **null** = 引擎未就绪 / 发不出去 / 超时 / 返回结构不是对象（调用方按
 *   引擎生命周期给「引擎未启动」这类可操作报错）；
 * - **抛错** = 数据包明确报错（入口不存在、入口内部失败），错误串已转成
 *   面向用户的话术（不含任何 URL），调用方原样带出即可。
 */
export async function engineInvoke(
  entry: string,
  args: Record<string, unknown>,
  timeoutMs: number = INVOKE_TIMEOUT_MS,
): Promise<Record<string, unknown> | null> {
  await ensureBound();
  if (phase !== "ready") return null;
  const requestId = ++seq;
  const reply = new Promise<EngineReply>((resolve) => pending.set(requestId, resolve));
  try {
    await emitRequest({ requestId, kind: "invoke", entry, args });
  } catch {
    pending.delete(requestId);
    return null;
  }
  const answer = await withTimeout(reply, timeoutMs)
    .finally(() => pending.delete(requestId))
    .catch(() => null);
  if (!answer) return null;
  if (answer.error) {
    // 入口不存在 = 当前生效的数据包（meta 包，可独立于应用更新）缺少该入口，
    // 提示更新/重装数据包——旧话术「升级应用」只适用于内置包时代，已失真
    if (answer.error.includes("入口不存在")) {
      throw new Error(`当前数据包缺少「${entry}」接口，请到「设置 → 音源包」更新数据包`);
    }
    throw new Error(`音源接口执行失败：${stripErrorUrls(answer.error)}`);
  }
  if (typeof answer.result !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(answer.result);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
