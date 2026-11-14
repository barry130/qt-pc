// @vitest-environment jsdom
/**
 * 回归（2026-11-14）：引擎应答从「emit_to 只回主窗口」改为全窗口广播后，
 * requestId 必须跨窗口唯一——这是桌面歌词恒显「间奏」的根因修复的第二半。
 *
 * 背景：桌面歌词窗口（独立 WebView）发出的 getLyric 等 RPC 请求此前永远等
 * 不到应答（引擎页 emitToMain 定向主窗口），getPlaybackLyric 超时失败 →
 * LyricWindow catch 后 applyLines([]) → 桌面歌词恒显「… 间奏 …」。
 * 广播修复要求（本文件逐条锁住）：
 *  ① client 发出的 requestId 是 `<窗口label>#<序号>` 字符串（每窗口独立计数，
 *     广播后靠前缀防串号）；
 *  ② 应答按 requestId 对账——别的窗口同序号（如 main#2 vs lyrics#2）的应答
 *     不得串音；
 *  ③ number 型 requestId（账号面沿用的负数 id 协议）漂进广播时不进 client 的
 *     pending，被安全忽略。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** 当前窗口 label：getCurrentWebviewWindow mock 的返回源 */
  label: "main",
  /** 所有窗口注册的 source-engine-response listener（共享=模拟广播到达所有窗口） */
  handlers: new Set<(e: { payload: unknown }) => void>(),
  /** emitTo 引擎窗口捕获的请求（原样记录 requestId/kind） */
  emits: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, cb: (e: { payload: unknown }) => void) => {
    h.handlers.add(cb);
    return () => h.handlers.delete(cb);
  }),
  emitTo: vi.fn(async (_label: string, _event: string, payload: Record<string, unknown>) => {
    h.emits.push(payload);
    // status 查询即时回 ready（引擎应答通道由测试手动广播驱动）
    if (payload.kind === "status") {
      broadcast({ requestId: payload.requestId, phase: "ready", code: 1, pack: null, meta: null });
    }
  }),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: h.label }),
}));

/** 引擎页的「广播应答」：所有窗口的 listener 都收到同一份 payload */
function broadcast(payload: Record<string, unknown>) {
  for (const cb of [...h.handlers]) cb({ payload });
}

const song = {
  id: "000iBXhy1RQDgL",
  name: "微光",
  singer: "佚名",
  album: "",
  picUrl: "",
  interval: 161,
  musicId: null,
};

/** 已 settle 则返回其值，否则返回 "pending"（不消费原 promise 的失败态） */
function probe<T>(p: Promise<T>): Promise<T | "pending"> {
  return Promise.race([p, new Promise<"pending">((r) => setTimeout(() => r("pending"), 25))]);
}

/** 放行若干宏任务：engineResolve 是 async（内部有 ensureBound/emitRequest 链），
 *  调用后立刻断言 emits 会抢在请求真正发出之前 */
function flushAsync(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("source-engine client：广播应答 + 窗口前缀 requestId", () => {
  beforeEach(() => {
    h.handlers.clear();
    h.emits.length = 0;
    h.label = "main";
  });

  it("① requestId 为 `<label>#<seq>` 字符串（引擎页校验 string 后才能放行）", async () => {
    vi.resetModules();
    const client = await import("@/source-engine/client");
    await client.queryEngineMeta(); // status（含后台重探）：main#1...
    const p = client.engineResolve("wyy", song, "128");
    await flushAsync();
    const req = h.emits.find((e) => e.kind === "resolve");
    expect(req).toBeTruthy();
    expect(typeof req?.requestId).toBe("string");
    expect(req?.requestId).toMatch(/^main#\d+$/);
    const ids = h.emits.map((e) => e.requestId);
    expect(ids.every((id) => typeof id === "string")).toBe(true);
    broadcast({ requestId: req?.requestId, url: "http://a.example/x", line: null, referer: "" });
    await expect(p).resolves.toMatchObject({ url: "http://a.example/x", stalled: false });
  });

  it("② 跨窗口同序号不串音：lyrics 只能应桌面歌词窗口，main 只能应主窗口", async () => {
    // 窗口 A（主窗口）与窗口 B（桌面歌词）是两个独立模块实例（各自 seq/pending）。
    // rpcOrigin 在首次 RPC 时固化——必须先让 A 完成一次查询再切 label，否则
    // A 的窗口前缀会错误地固化成 B 的 label。
    h.label = "main";
    vi.resetModules();
    const modA = await import("@/source-engine/client");
    await modA.queryEngineMeta(); // 固化 originCache = "main"
    h.label = "lyrics";
    vi.resetModules();
    const modB = await import("@/source-engine/client");
    await modB.queryEngineMeta(); // 固化 originCache = "lyrics"

    // 两窗口各自发起 resolve → 请求序号各自独立计数，前缀不同
    const pA = modA.engineResolve("wyy", song, "128");
    const pB = modB.engineResolve("wyy", song, "128");
    await flushAsync();
    const resolveIds = h.emits
      .filter((e) => e.kind === "resolve")
      .map((e) => String(e.requestId));
    expect(resolveIds).toHaveLength(2);
    const [idA, idB] = resolveIds;
    expect(idA.startsWith("main#")).toBe(true);
    expect(idB.startsWith("lyrics#")).toBe(true);
    expect(idA).not.toBe(idB);

    // B 的应答先广播：A 不得串音吃掉它
    broadcast({ requestId: idB, url: "http://b.example/x", line: null, referer: "" });
    await expect(pB).resolves.toMatchObject({ url: "http://b.example/x" });
    expect(await probe(pA)).toBe("pending");

    // A 的应答随后到达，A 才完成
    broadcast({ requestId: idA, url: "http://a.example/x", line: null, referer: "" });
    await expect(pA).resolves.toMatchObject({ url: "http://a.example/x" });
  });

  it("③ number 型 requestId（账号面负数 id）漂进广播被忽略，不误中 pending", async () => {
    vi.resetModules();
    const client = await import("@/source-engine/client");
    await client.queryEngineMeta();
    const p = client.engineResolve("wyy", song, "128");
    await flushAsync();
    const req = h.emits.find((e) => e.kind === "resolve");
    expect(req).toBeTruthy();
    // 账号面协议的负数 id（number）先漂进广播：client 只对账 string id
    broadcast({ requestId: -1, url: "http://account.example/x", line: null, referer: "" });
    broadcast({ requestId: 2, url: "http://number.example/x", line: null, referer: "" });
    expect(await probe(p)).toBe("pending");
    // 正主应答（string）到达后才完成
    broadcast({ requestId: req?.requestId, url: "http://real.example/x", line: null, referer: "" });
    await expect(p).resolves.toMatchObject({ url: "http://real.example/x" });
  });
});
