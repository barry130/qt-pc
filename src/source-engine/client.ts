/**
 * 音源引擎窗口 RPC 封装（音源包热更新方案 P1）。
 *
 * 引擎窗口（label "source-engine"，见 src-tauri/src/source_window.rs）加载
 * qtres:// 内嵌引擎页，动态 import 音源包脚本（已装远程包与应用内嵌内置包
 * 谁新用谁，失败互为回落）并跑 createSourceLayer。
 * 主窗口与它只走事件（source-engine-request → source-engine-response）：
 *   - kind "status"：查询引擎生命周期（booting/ready/error，builtin 仅为
 *     兼容保留）——引擎启动早于主窗口前端，boot 时推送的状态事件会错过，
 *     绑定后主动查询；
 *   - kind "resolve"：取链（url "" = 失败/无可用层；line = 本次命中的音源线路，
 *     null = 未知，见 PlayUrlLine）；
 *   - kind "invoke"：数据接口（搜索/歌单/专辑/歌手/榜单/歌词/封面/热词/MV），
 *     bundle 的 `__qtEntries` 入口名 + JSON 参数，result 为 JSON 文本。
 *
 * 约定：
 * - 引擎未就绪 / 加载失败 / 超时 / 返回空串 → 一律返回空值（"" / null），
 *   调用方给出可操作报错（应用不内置第三方实现，无静默回退）；
 * - source-applied（Rust 在「立即应用 / 回滚」后广播）→ 状态复位，下次
 *   取链前重新查询（引擎页重启后重新上报）。
 */
import { emitTo, listen } from "@tauri-apps/api/event";
import { stripErrorUrls } from "@/lib/utils";
import type { Quality } from "@/types";
import type { MusicInfo, Source } from "@/source-scripts/contract";

/** 引擎页生命周期：booting=启动中 ready=可用 error=失败；builtin=兼容保留值 */
export type EnginePhase = "booting" | "builtin" | "ready" | "error";

interface EngineReply {
  url?: string;
  /** 本次取链命中的音源线路（bundle 的 getPlayUrl 应答里的 line） */
  line?: unknown;
  phase?: EnginePhase;
  code?: number | null;
  detail?: string | null;
  /** kind=invoke 的返回值（bundle 入口的 JSON 文本） */
  result?: string | null;
  error?: string | null;
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
}

/**
 * 取链 RPC 超时：引擎侧链预算默认 12s（chain.json budget.totalMs），
 * 留 3s 余量；超时即回退内置，不等引擎慢尾。
 */
const RESOLVE_TIMEOUT_MS = 15_000;
/**
 * 数据接口 RPC 超时：搜索/聚合类要打多平台 HTTP（单请求上限 15s），
 * 比取链宽松；超时同样回退内置实现。
 */
const INVOKE_TIMEOUT_MS = 20_000;
/** 状态查询单次超时 / 重试上限（引擎启动毫秒级，上限只为防呆） */
const STATUS_QUERY_TIMEOUT_MS = 2_500;
const STATUS_QUERY_MAX_FAILURES = 2;

let bound = false;
let binding: Promise<void> | null = null;
/** null = 尚未查询过（绑定后/resets 后由 refreshPhase 填充） */
let phase: EnginePhase | null = null;
let remoteCode: number | null = null;
let engineDetail: string | null = null;

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
    return answer.phase;
  }
  return null;
}

/**
 * 刷新引擎生命周期：引擎启动中（booting）轮询直到终态；引擎不可达时
 * 有限重试后置 error（避免每次取链都空等）。
 */
async function refreshPhase(): Promise<void> {
  let failures = 0;
  for (;;) {
    const p = await queryPhaseOnce();
    if (p === "booting") {
      await new Promise((r) => window.setTimeout(r, 400));
      continue;
    }
    if (p !== null) {
      phase = p;
      return;
    }
    failures += 1;
    if (failures >= STATUS_QUERY_MAX_FAILURES) {
      phase = "error";
      return;
    }
    await new Promise((r) => window.setTimeout(r, 300));
  }
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
      // 音源包应用/回滚后引擎窗口被重建，状态复位待重新查询
      await listen("source-applied", () => {
        phase = null;
        remoteCode = null;
        engineDetail = null;
        for (const [, resolve] of pending) resolve({});
        pending.clear();
      });
      bound = true;
    })().catch(() => {
      binding = null;
      phase = "error";
      engineDetail = "event listen failed";
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
  };
}

/**
 * 经引擎窗口解析播放地址。
 * url "" = 引擎不可用/解析失败/超时（调用方按本次取链失败处理）；
 * line = 本次命中的音源线路（管理端「当前播放地址」显示走的是哪条源），
 * null = 未知（包内 10 分钟缓存命中，或引擎页比宿主旧没有这个字段）；
 * error = 失败时的逐线路 trace（成功为空串）。
 */
export async function engineResolve(
  source: Source,
  song: MusicInfo,
  quality: Quality,
): Promise<EngineResolved> {
  await ensureBound();
  if (phase !== "ready") return { url: "", line: null, error: "" };
  const requestId = ++seq;
  const reply = new Promise<EngineReply>((resolve) => pending.set(requestId, resolve));
  try {
    await emitRequest({ requestId, kind: "resolve", source, song, quality });
  } catch {
    pending.delete(requestId);
    return { url: "", line: null, error: "" };
  }
  const answer = await withTimeout(reply, RESOLVE_TIMEOUT_MS)
    .finally(() => pending.delete(requestId))
    .catch(() => null);
  if (!answer) return { url: "", line: null, error: "" };
  const url = String(answer.url ?? "");
  const error = typeof answer.error === "string" ? answer.error : "";
  // 死因落控制台：面板只在 qt_admin 打开时才看得到，日志是排障的第一现场
  if (url.length === 0 && error.length > 0) {
    console.warn(`[playurl] 取链失败 ${source}:${song.id}@${quality} — ${error}`);
  }
  return { url, line: normalizeLine(answer.line), error };
}

/** 引擎当前状态快照（设置页展示用） */
export function engineSnapshot(): {
  phase: EnginePhase | null;
  code: number | null;
  detail: string | null;
} {
  return { phase, code: remoteCode, detail: engineDetail };
}

/**
 * 经引擎窗口调用音源包数据接口（搜索/歌单/专辑/歌手/榜单/歌词/封面/热词/MV）。
 *
 * 入口名与参数对齐 bundle 的 `__qtEntries`（qt-entries.ts），返回已解析的
 * JSON 对象（如 `{list}` / `{detail}` / `{url}`）。应用侧没有内置实现可回退，
 * 因此失败语义分两级：
 * - **null** = 引擎未就绪 / 发不出去 / 超时 / 返回结构不是对象（调用方按
 *   引擎生命周期给「未安装音源包」这类可操作报错）；
 * - **抛错** = bundle 明确报错（入口不存在、入口内部失败），错误串已转成
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
    // 入口不存在 = 已装音源包比宿主旧，属可操作状态，单独给话术
    if (answer.error.includes("入口不存在")) {
      throw new Error(`当前音源包缺少「${entry}」接口，请到「设置 → 音源包」更新后再试`);
    }
    throw new Error(`音源包接口执行失败：${stripErrorUrls(answer.error)}`);
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
