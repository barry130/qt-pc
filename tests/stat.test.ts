// @vitest-environment jsdom
// 桌面端统计采集（src/lib/stat.ts）核心行为：launcher/show 启动事件、
// deviceId 持久化、托盘 hide 结算时长、失败重试 ≤3 次丢批、字段截断、队列上限。
// 注意：trackStatError 会触发自动 flush，断言前必须 settle（微任务排空）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 事件监听 mock：把 handlers 存起来，测试里直接触发 Rust 侧发来的可见性事件
const listenHandlers: Record<string, () => void> = {};
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: () => void) => {
    listenHandlers[event] = handler;
    return () => delete listenHandlers[event];
  }),
}));

vi.mock("@/services/ipc", () => ({
  getAppVersion: vi.fn(async () => ({ versionName: "1.0.0", versionCode: 100 })),
  astralReportStats: vi.fn(async () => {}),
  // stat.ts 的失败路径会经 @/lib/logger 落一份进文件日志
  writeLog: vi.fn(async () => {}),
}));

import * as ipc from "@/services/ipc";
import {
  flushStat,
  initStat,
  trackStatError,
  trackStatPage,
  __queueSizeForTest,
  __resetStatForTest,
} from "@/lib/stat";

// 这套 jsdom 环境的 localStorage 是残缺的（getNode 限制），换成一个内存实现
const memStore: Record<string, string> = {};
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string): string | null => (k in memStore ? memStore[k] : null),
    setItem: (k: string, v: string): void => {
      memStore[k] = String(v);
    },
    clear: (): void => {
      for (const k of Object.keys(memStore)) delete memStore[k];
    },
  },
});

const reportMock = vi.mocked(ipc.astralReportStats);

function sentEvents(): Array<Record<string, unknown>> {
  return reportMock.mock.calls.flatMap((call) => call[0] as never);
}

/** 排空自动 flush 的微任务链 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  __resetStatForTest();
  reportMock.mockReset();
  reportMock.mockResolvedValue();
});

afterEach(() => {
  __resetStatForTest();
});

async function boot(): Promise<void> {
  await initStat();
  await settle();
}

describe("统计采集", () => {
  it("启动时上报 launcher + show，deviceId 持久化且重启不变", async () => {
    await boot();
    const events = sentEvents();
    expect(events.map((e) => e.evt)).toEqual(["launcher", "show"]);
    const deviceId = events[0].deviceId as string;
    expect(deviceId).toBeTruthy();
    expect(events[0].appVersion).toBe("1.0.0");

    // 模拟重启：保留 localStorage 里的 deviceId 再初始化一次
    const saved = window.localStorage.getItem("qt-stat-device-id");
    __resetStatForTest();
    window.localStorage.setItem("qt-stat-device-id", saved ?? "");
    reportMock.mockClear();
    await boot();
    const again = sentEvents();
    expect(again.map((e) => e.evt)).toEqual(["launcher", "show"]);
    expect(again.every((e) => e.deviceId === deviceId)).toBe(true);
  });

  it("hide 事件结算 duration 并冲出队列", async () => {
    await boot();
    reportMock.mockClear();
    // fake timers 会连带 mock Date.now：前进 5s 模拟窗口在托盘外停留了 5 秒
    vi.useFakeTimers();
    vi.advanceTimersByTime(5_000);
    listenHandlers["stat_window_hidden"]?.();
    vi.useRealTimers();
    await settle();
    await flushStat(); // 若 show 的在途上报占了 inFlight，这里补冲

    const hide = sentEvents().find((e) => e.evt === "hide");
    expect(hide).toBeTruthy();
    expect(hide?.duration).toBeGreaterThanOrEqual(5_000);
    expect(hide?.duration).toBeLessThan(10_000);
  });

  it("上报失败重试 3 次后丢批，成功后队列继续可用", async () => {
    await boot();
    reportMock.mockRejectedValue(new Error("network down"));
    trackStatError("js", "boom", "at x");
    await settle(); // 自动 flush 失败（第 1 次）
    await flushStat(); // 第 2 次
    await flushStat(); // 第 3 次 → 丢批
    await flushStat(); // 队列已空

    reportMock.mockClear();
    reportMock.mockResolvedValue();
    await flushStat();
    // 丢批后不残留：恢复网络也不会把坏数据再发一遍
    expect(reportMock).not.toHaveBeenCalled();

    trackStatError("js", "fresh");
    await settle();
    const events = sentEvents();
    expect(events).toHaveLength(1);
    expect(events[0].message).toBe("fresh");
  });

  it("init 未完成时触发的埋点也要等到就绪后才建事件（不带空版本号）", async () => {
    // 不 await initStat：模拟首帧路由 effect 跑在 getAppVersion 返回之前
    void initStat();
    trackStatPage("/first");
    await settle();

    const page = sentEvents().find((e) => e.evt === "page");
    expect(page?.page).toBe("/first");
    expect(page?.appVersion).toBe("1.0.0");
  });

  it("error 事件截断超长字段", async () => {
    await boot();
    reportMock.mockClear();
    trackStatError("js", "x".repeat(2000), "s".repeat(20_000));
    await settle();

    const events = sentEvents();
    expect(events).toHaveLength(1);
    expect((events[0].message as string).length).toBe(1024);
    expect((events[0].stack as string).length).toBe(16 * 1024);
    expect(events[0].errorType).toBe("js");
  });

  it("队列超过 500 条丢最旧", async () => {
    await boot();
    // 首条错误的上报永远挂起，占住 inFlight，其余事件只能在队列里堆积
    reportMock.mockImplementation(() => new Promise(() => {}));
    trackStatError("js", "hang");
    for (let i = 0; i < 600; i += 1) {
      trackStatError("js", `e${i}`);
    }
    expect(__queueSizeForTest()).toBeLessThanOrEqual(500);
  });
});

// 队列持久化 schema（#30）：v2 起带版本号，且按**字符**封顶而不只按条数——
// error 事件的 stack 最长 16KB，500 条能到 8MB，超 localStorage 配额后 setItem
// 抛错、队列再也存不下，冷启动丢批。
describe("统计队列持久化", () => {
  /** 读回落盘内容（持久化只在 flush / hide 结算时发生） */
  function storedQueue(): { v?: number; queue: Array<Record<string, unknown>> } {
    const raw = window.localStorage.getItem("qt-stat-queue");
    expect(raw).toBeTruthy();
    return JSON.parse(raw as string) as {
      v?: number;
      queue: Array<Record<string, unknown>>;
    };
  }

  it("落盘格式带 schema 版本号（v2），不再是裸数组", async () => {
    await boot();
    await flushStat();
    const stored = storedQueue();
    expect(stored.v).toBe(2);
    expect(Array.isArray(stored.queue)).toBe(true);
  });

  it("能读回老版本（v1 裸数组）的待发队列，不丢历史事件", async () => {
    window.localStorage.setItem(
      "qt-stat-queue",
      JSON.stringify([
        {
          evt: "page",
          ts: 1,
          deviceId: "legacy",
          appVersion: "1.0.0",
          model: "PC",
          os: "Windows 10/11",
          ch: "official",
          release: "1.0.0",
          page: "/legacy",
        },
      ]),
    );
    // 让上报永远挂起，队列才能留在内存里被检查
    await boot();
    const legacy = sentEvents().find((e) => e.page === "/legacy");
    expect(legacy).toBeTruthy();
    expect(legacy?.deviceId).toBe("legacy");
  });

  it("序列化超过字符上限时丢最旧，落盘不超配额", async () => {
    await boot();
    // 首条上报挂起占住 inFlight，后续事件全部堆在队列里
    reportMock.mockImplementation(() => new Promise(() => {}));
    trackStatError("js", "hang");
    const bigStack = "s".repeat(16 * 1024);
    for (let i = 0; i < 200; i += 1) {
      trackStatError("js", `big${i}`, bigStack);
    }
    await settle();
    // 1 条 hang + 200 条 16KB 错误 ≈ 3.3MB，已越过 2MB 字符上限
    expect(__queueSizeForTest()).toBe(201);

    // hide 结算会 persistQueue：超限部分应被裁掉
    listenHandlers["stat_window_hidden"]?.();
    const raw = window.localStorage.getItem("qt-stat-queue") as string;
    expect(raw.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    const stored = storedQueue();
    expect(stored.v).toBe(2);
    expect(stored.queue.length).toBeLessThan(200);
    // 丢的是最旧那批：最后一条（big199）必须还在
    expect(
      stored.queue.some((e) => String(e.message).startsWith("big19")),
    ).toBe(true);
  });
});
