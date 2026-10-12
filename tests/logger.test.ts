// @vitest-environment jsdom
/**
 * 前端日志（src/lib/logger.ts）。
 *
 * 这里锁的是**契约**而不是实现：
 * 1. 级别过滤按严重度走：当前档以下的丢掉，以上的落盘；
 * 2. 无论级别如何，console 永远照打（开发期 devtools 是现场，不能被配置掐掉）；
 * 3. 日志永远不会抛 —— IPC 拒绝、甚至 `writeLog` 整个不存在，都不能反过来把
 *    调用方打挂（调用方全是错误回调和事件处理，崩在这里会掩盖真正的故障）；
 * 4. Error 落盘时**保留 stack**：release 下没有 devtools，stack 是唯一定位手段；
 * 5. 落盘文本过一遍 URL 脱敏（stack / 错误串里常带请求地址）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeLog: vi.fn<(level: string, message: string) => Promise<void>>(async () => undefined),
  getLogConfig: vi.fn<() => Promise<{ level: string }>>(async () => ({ level: "debug" })),
}));

vi.mock("@/services/ipc", () => mocks);

import { log, setLogLevel, currentLogLevel, syncLogLevel } from "@/lib/logger";

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;
let debugSpy: ReturnType<typeof vi.spyOn>;

/** 取出最近一次落盘的文本 */
function lastLogged(): string {
  const calls = mocks.writeLog.mock.calls;
  return String(calls[calls.length - 1]?.[1] ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeLog.mockImplementation(async () => undefined);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  // 每个用例自己定档，避免受构建默认值影响
  setLogLevel("debug");
});

afterEach(() => {
  vi.restoreAllMocks();
  setLogLevel("debug");
});

describe("前端日志", () => {
  it("级别够用才落盘：warn 档下 debug/info 被丢掉，warn/error 留下", () => {
    setLogLevel("warn");

    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    expect(mocks.writeLog.mock.calls.map((c) => c[0])).toEqual(["warn", "error"]);
  });

  it("debug 档下四级全部落盘", () => {
    setLogLevel("debug");

    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    expect(mocks.writeLog.mock.calls.map((c) => c[0])).toEqual([
      "debug",
      "info",
      "warn",
      "error",
    ]);
  });

  it("error 档下只有 error 落盘", () => {
    setLogLevel("error");

    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    expect(mocks.writeLog.mock.calls.map((c) => c[0])).toEqual(["error"]);
  });

  it("console 不受级别影响：被过滤掉的也要在 devtools 里看得见", () => {
    setLogLevel("error");

    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    expect(debugSpy).toHaveBeenCalledWith("d");
    expect(infoSpy).toHaveBeenCalledWith("i");
    expect(warnSpy).toHaveBeenCalledWith("w");
    expect(errorSpy).toHaveBeenCalledWith("e");
    // 只有 error 越过了过滤线
    expect(mocks.writeLog.mock.calls.map((c) => c[0])).toEqual(["error"]);
  });

  it("多个参数按顺序拼成一行，与 console 的输出顺序一致", () => {
    log.warn("[queue] 清空队列失败", "boom");

    expect(lastLogged()).toBe("[queue] 清空队列失败 boom");
  });

  it("Error 落盘保留 stack（release 下没有 devtools，stack 是唯一定位手段）", () => {
    const err = new Error("炸了");

    log.error("[x] 失败", err);

    expect(lastLogged()).toContain("炸了");
    expect(lastLogged()).toContain("logger.test.ts");
  });

  it("落盘文本剥掉 http(s) 链接（stack 里常带请求地址）", () => {
    const err = new Error("请求 https://api.example.com/v1/x 失败");

    log.warn("[x]", err);

    expect(lastLogged()).not.toContain("api.example.com");
    expect(lastLogged()).toContain("…");
  });

  it("writeLog 拒绝时自己吞掉，不抛给调用方", () => {
    mocks.writeLog.mockRejectedValue(new Error("ipc down"));

    expect(() => log.error("boom")).not.toThrow();
  });

  it("writeLog 整个不存在时也不抛（单测没 mock 的模块整体 mock 场景）", () => {
    // 模拟 vi.mock("@/services/ipc") 里没给 writeLog：调用即 TypeError
    const mod = mocks as { writeLog?: unknown };
    const saved = mod.writeLog;
    delete mod.writeLog;

    expect(() => log.error("boom")).not.toThrow();

    mod.writeLog = saved;
  });

  it("syncLogLevel 跟后端生效级别对齐（管理员把级别调宽，前端不再被旧档卡住）", async () => {
    setLogLevel("warn");
    mocks.getLogConfig.mockResolvedValueOnce({ level: "debug" });

    await syncLogLevel();

    expect(currentLogLevel()).toBe("debug");
    log.debug("d");
    expect(mocks.writeLog.mock.calls.map((c) => c[0])).toEqual(["debug"]);
  });

  it("syncLogLevel 把 trace 收敛到 debug（前端最细只到 debug）", async () => {
    setLogLevel("warn");
    mocks.getLogConfig.mockResolvedValueOnce({ level: "trace" });

    await syncLogLevel();

    expect(currentLogLevel()).toBe("debug");
  });

  it("syncLogLevel 读不到配置时保持原档，不打扰启动", async () => {
    setLogLevel("info");
    mocks.getLogConfig.mockRejectedValueOnce(new Error("ipc down"));

    await expect(syncLogLevel()).resolves.toBeUndefined();

    expect(currentLogLevel()).toBe("info");
  });
});
