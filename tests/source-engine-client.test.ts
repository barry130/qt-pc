// @vitest-environment jsdom
/**
 * 引擎生命周期不再「一次超时即本次会话永久失效」。
 *
 * 背景（审查报告 P1-3）：音源脚本的 init 是同步执行且没有超时
 * （bridge.ts 的 spec.run），脚本里一个同步忙循环就能冻住引擎页；
 * 两次 status 查询超时（2×2.5s）之后 phase 被置成 "error" —— 而这是**终态**，
 * engineResolve / engineInvoke 之后一直短路返回空值，脚本恢复正常了第三方源
 * 也回不来（唯一复位是 source-applied 事件）。
 *
 * 这个用例证明：置 error 之后，后台重探能在**没有任何 source-applied 事件**的
 * 情况下把 phase 拉回 ready。去掉 client.ts 里的 scheduleReprobe() 调用，
 * 本用例的最后一条断言会失败（phase 永远停在 error）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** 捕获宿主注册的 source-engine-response 处理器（模拟引擎页应答） */
  handler: null as null | ((e: { payload: unknown }) => void),
  /** "none" = 引擎页被冻住（不回应）；"ready" = 恢复响应 */
  answers: "none" as "none" | "ready",
  emits: [] as Record<string, unknown>[],
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    if (name === "source-engine-response") h.handler = cb;
    return () => {};
  }),
  emitTo: vi.fn(async (_label: string, _event: string, payload: Record<string, unknown>) => {
    h.emits.push(payload);
    if (h.answers === "ready" && payload.kind === "status") {
      h.handler?.({ payload: { requestId: payload.requestId, phase: "ready" } });
    }
  }),
}));

const song = {
  id: "000iBXhy1RQDgL",
  name: "微光",
  singer: "佚名",
  album: "",
  picUrl: "",
  interval: 161,
  musicId: null,
};

describe("source-engine client 生命周期恢复", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.handler = null;
    h.answers = "none";
    h.emits.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("引擎无响应置 error 后，后台重探自动恢复（无需 source-applied）", async () => {
    vi.resetModules();
    const client = await import("@/source-engine/client");

    // 1) 首次取链：status 查询两次超时（各 2.5s）→ phase 锁死 error，取链按失败回退
    // （stalled=true：引擎无响应属环境问题，不计入熔断，2026-10-03 弱网修复）
    const first = client.engineResolve("qq", song, "128");
    await vi.advanceTimersByTimeAsync(2_600); // 第 1 次 status 超时
    await vi.advanceTimersByTimeAsync(400); // 重试间隔
    await vi.advanceTimersByTimeAsync(2_600); // 第 2 次 status 超时 → error
    await expect(first).resolves.toEqual({
      url: "",
      line: null,
      error: "",
      stalled: true,
    });
    expect(client.engineSnapshot().phase).toBe("error");

    // error 期间不再真的发取链请求（短路回退，不空等）
    const before = h.emits.filter((e) => e.kind === "resolve").length;
    await expect(client.engineResolve("qq", song, "128")).resolves.toEqual({
      url: "",
      line: null,
      error: "",
      stalled: true,
    });
    expect(h.emits.filter((e) => e.kind === "resolve").length).toBe(before);

    // 2) 引擎页"解冻"、恢复应答 → 后台重探（15s）应把 phase 拉回 ready
    h.answers = "ready";
    await vi.advanceTimersByTimeAsync(15_100);
    expect(client.engineSnapshot().phase).toBe("ready");
  });
});
