/**
 * 音源引擎窗口 RPC 封装（音源包热更新方案 P1）。
 *
 * 引擎窗口（label "source-engine"，见 src-tauri/src/source_window.rs）加载
 * qtres:// 内嵌引擎页，动态 import 远程音源包脚本并跑 createSourceLayer。
 * 主窗口与它只走事件（source-engine-request → source-engine-response）：
 *   - kind "status"：查询引擎生命周期（booting/builtin/ready/error）——
 *     引擎启动早于主窗口前端，boot 时推送的状态事件会错过，绑定后主动查询；
 *   - kind "resolve"：取链（url "" = 失败/无可用层）。
 *
 * 约定：
 * - 引擎未就绪 / 加载失败 / 超时 / 返回空串 → 一律返回 ""，调用方回退
 *   主窗口内置实现（resolvePlayUrl 内置层），任何情况都不阻塞播放；
 * - source-applied（Rust 在「立即应用 / 回滚」后广播）→ 状态复位，下次
 *   取链前重新查询（引擎页重启后重新上报）。
 */
import { emitTo, listen } from "@tauri-apps/api/event";
import type { Quality } from "@/types";
import type { MusicInfo, Source } from "@/source-scripts/contract";

/** 引擎页生命周期：booting=启动中 builtin=无远程包 ready=可用 error=失败 */
export type EnginePhase = "booting" | "builtin" | "ready" | "error";

interface EngineReply {
  url?: string;
  phase?: EnginePhase;
  code?: number | null;
  detail?: string | null;
}

/**
 * 取链 RPC 超时：引擎侧链预算默认 12s（chain.json budget.totalMs），
 * 留 3s 余量；超时即回退内置，不等引擎慢尾。
 */
const RESOLVE_TIMEOUT_MS = 15_000;
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
 * 经引擎窗口解析播放地址。
 * 返回直链；"" = 引擎不可用/解析失败/超时（调用方应回退内置实现）。
 */
export async function engineResolve(
  source: Source,
  song: MusicInfo,
  quality: Quality,
): Promise<string> {
  await ensureBound();
  if (phase !== "ready") return "";
  const requestId = ++seq;
  const reply = new Promise<EngineReply>((resolve) => pending.set(requestId, resolve));
  try {
    await emitRequest({ requestId, kind: "resolve", source, song, quality });
  } catch {
    pending.delete(requestId);
    return "";
  }
  const answer = await withTimeout(reply, RESOLVE_TIMEOUT_MS)
    .finally(() => pending.delete(requestId))
    .catch(() => null);
  return String(answer?.url ?? "");
}

/** 引擎当前状态快照（设置页展示用） */
export function engineSnapshot(): {
  phase: EnginePhase | null;
  code: number | null;
  detail: string | null;
} {
  return { phase, code: remoteCode, detail: engineDetail };
}
