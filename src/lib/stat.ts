import { listen } from "@tauri-apps/api/event";
import * as ipc from "@/services/ipc";

/**
 * 桌面端使用统计上报（STATS_DESIGN.md §4.1 事件模型 / §7 采集行为）。
 *
 * 后端契约：POST /api/v1/app/stat/report（匿名免登录），事件字段见后端 StatEventDTO：
 * evt/ts/deviceId/appVersion/model/os/page/duration/ch/errorType/message/stack/release/extra。
 * ut 不用客户端管——Rust 侧 report_stats 按编译目标强制
 * app-windows / app-linux / app-macos（见 astral.rs CLIENT_UT）。
 *
 * 行为对齐移动端 qt-stat 插件（§7.1）：
 * - deviceId：localStorage 持久化的随机 UUID，禁止采集硬件标识；
 * - 队列：满批/定时触发（10s 或 50 条），失败重试 ≤3 次后丢批，
 *   队列上限 500 条（超出丢最旧），窗口收进托盘时持久化防丢；
 * - 生命周期：launcher（冷启动）/ show / hide（带 duration=now-上次 show）/ page / error；
 * - 所有入口 try/catch 包裹，统计异常绝不影响主流程。
 */

/** 队列持久化 key；deviceId 同 §7.1 的存储约定 */
const QUEUE_KEY = "qt-stat-queue";
const DEVICE_KEY = "qt-stat-device-id";

/** 单批上限：后端 StatReportRequest 强校验 ≤200 */
const MAX_BATCH = 200;
/** 队列上限，超出丢最旧（§7.1） */
const MAX_QUEUE = 500;
/** 定时冲队列间隔（§7.1 默认 10s） */
const FLUSH_INTERVAL_MS = 10_000;
/** 失败重试次数上限，超过丢掉当前批 */
const MAX_RETRY = 3;

interface StatEvent {
  evt: "launcher" | "show" | "hide" | "page" | "error" | "custom";
  ts: number;
  deviceId: string;
  appVersion: string;
  model: string;
  os: string;
  page?: string;
  duration?: number;
  errorType?: string;
  message?: string;
  stack?: string;
  ch?: string;
  release?: string;
  extra?: Record<string, unknown> | null;
}

let started = false;
/** init 完成信号：埋点入口等它就绪再建事件，保证 appVersion/os 已填好 */
let ready: Promise<void> = Promise.resolve();
let deviceId = "";
let appVersion = "";
let os = "Unknown";
let queue: StatEvent[] = [];
let attempts = 0;
let inFlight = false;
let timer: ReturnType<typeof setInterval> | null = null;
let lastShowTs: number | null = null;

// localStorage 在部分环境（老 webview、隐私模式）会抛异常，统一走安全包装
function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 存不了就只当本次会话生效
  }
}

function newDeviceId(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && "randomUUID" in c) return c.randomUUID();
  // 兜底：够随机即可，不做密码学要求
  return `pc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** OS 版本从 UA 里粗解析；解析不出就给个宽泛值，仅作维度用 */
function osOf(ua: string): string {
  // 三平台 webview UA 都带平台关键字；Windows 顺带解析 NT 版本
  // （NT 10.0 同时覆盖 Win10/Win11，UA 不区分，够用作统计维度）
  const win = /Windows NT ([\d.]+)/.exec(ua);
  if (win) return win[1].startsWith("10.") ? "Windows 10/11" : `Windows NT ${win[1]}`;
  // macOS：WebKit UA 是 "Macintosh; Intel Mac OS X 10_15_7" 这种
  const mac = /Mac OS X ([\d_.]+)/.exec(ua);
  if (mac) return `macOS ${mac[1].replace(/_/g, ".")}`;
  // Linux：WebKitGTK UA 就是裸 "X11; Linux x86_64"，没有发行版信息
  if (/Linux/i.test(ua)) return "Linux";
  // 兜底：老 webview / 隐私模式下的怪 UA
  return "Unknown";
}

function baseEvent(evt: StatEvent["evt"]): StatEvent {
  return {
    evt,
    ts: Date.now(),
    deviceId,
    appVersion,
    model: "PC",
    os,
    ch: "official",
    release: appVersion,
  };
}

function loadQueue(): void {
  const raw = storageGet(QUEUE_KEY);
  if (!raw) return;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      queue = parsed.filter(
        (e): e is StatEvent => !!e && typeof e === "object" && "evt" in e,
      );
    }
  } catch {
    queue = [];
  }
}

function persistQueue(): void {
  storageSet(QUEUE_KEY, JSON.stringify(queue));
}

function enqueue(event: StatEvent): void {
  queue.push(event);
  if (queue.length > MAX_QUEUE) {
    queue = queue.slice(queue.length - MAX_QUEUE);
  }
}

/** 立即冲一批（≤200 条）出去；失败按 §7.1 重试 ≤3 次后丢批，绝不抛出 */
export async function flushStat(): Promise<void> {
  if (inFlight || queue.length === 0 || !deviceId) return;
  inFlight = true;
  const batch = queue.slice(0, MAX_BATCH);
  try {
    await ipc.astralReportStats(batch as unknown as Record<string, unknown>[]);
    queue = queue.slice(batch.length);
    attempts = 0;
    persistQueue();
  } catch (err) {
    attempts += 1;
    if (attempts >= MAX_RETRY) {
      // 连续失败 3 次：丢掉这批，避免一条坏数据把队列永久堵死
      queue = queue.slice(batch.length);
      attempts = 0;
    }
    console.warn("[stat] 上报失败，稍后重试", err);
    persistQueue();
  } finally {
    inFlight = false;
  }
}

function enqueueAndTryFlush(event: StatEvent): void {
  enqueue(event);
  void flushStat();
}

/** 窗口重新可见（托盘「显示主窗口」）：开始新一轮停留计时 */
function onWindowShown(): void {
  lastShowTs = Date.now();
  enqueueAndTryFlush(baseEvent("show"));
}

/** 窗口收进托盘 / 应用退出：结算停留时长、冲队列并持久化 */
function onWindowHidden(): void {
  if (lastShowTs != null) {
    const event = baseEvent("hide");
    event.duration = Math.max(0, Date.now() - lastShowTs);
    lastShowTs = null;
    enqueue(event);
  }
  persistQueue();
  void flushStat();
}

/** 页面访问埋点（路由变化时调）。init 未完成时先等就绪，事件不会带上空版本号 */
export function trackStatPage(page: string): void {
  void ready.then(() => {
    if (!started || !page) return;
    const event = baseEvent("page");
    event.page = page;
    enqueueAndTryFlush(event);
  });
}

/** 运行期错误（window error / unhandledrejection 时调） */
export function trackStatError(
  errorType: string,
  message: string,
  stack?: string,
): void {
  void ready.then(() => {
    if (!started) return;
    const event = baseEvent("error");
    // 对齐后端字段限制：message ≤1024、stack ≤16KB
    event.errorType = errorType.slice(0, 16);
    event.message = message.slice(0, 1024);
    if (stack) event.stack = stack.slice(0, 16 * 1024);
    enqueueAndTryFlush(event);
  });
}

function installErrorHooks(): void {
  window.addEventListener("error", (e) => {
    try {
      trackStatError("js", e.message || "Script error.", e.error?.stack);
    } catch {
      // 统计自身异常静默
    }
  });
  window.addEventListener("unhandledrejection", (e) => {
    try {
      const reason = e.reason as { message?: string; stack?: string } | null;
      trackStatError(
        "js",
        reason?.message || String(reason ?? "Unhandled rejection"),
        reason?.stack,
      );
    } catch {
      // 同上
    }
  });
}

/**
 * 应用启动时调用（AppShell 挂载后一次）：发 launcher + show，起定时冲队列，
 * 订阅 Rust 侧的窗口可见性事件并挂 JS 错误钩子。幂等。
 */
export async function initStat(): Promise<void> {
  if (started) return;
  started = true;
  ready = doInit();
  await ready;
}

async function doInit(): Promise<void> {
  try {
    deviceId = storageGet(DEVICE_KEY) ?? newDeviceId();
    storageSet(DEVICE_KEY, deviceId);
    loadQueue();

    const version = await ipc.getAppVersion().catch(() => null);
    appVersion = version?.versionName ?? "";
    os = osOf(navigator.userAgent);

    lastShowTs = Date.now();
    enqueue(baseEvent("launcher"));
    enqueue(baseEvent("show"));
    void flushStat();

    timer = setInterval(() => void flushStat(), FLUSH_INTERVAL_MS);

    // 窗口可见性由 Rust 侧发事件：收进托盘 / 托盘恢复 / 托盘退出
    void listen("stat_window_hidden", () => {
      try {
        onWindowHidden();
      } catch {
        // 静默
      }
    });
    void listen("stat_window_shown", () => {
      try {
        onWindowShown();
      } catch {
        // 静默
      }
    });

    installErrorHooks();
  } catch (err) {
    // 统计初始化失败不影响主流程，但置回未启动便于排查
    console.warn("[stat] 初始化失败", err);
    started = false;
  }
}

/** 测试专用：清空全部模块状态 */
export function __resetStatForTest(): void {
  started = false;
  ready = Promise.resolve();
  deviceId = "";
  appVersion = "";
  os = "Unknown";
  queue = [];
  attempts = 0;
  inFlight = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  lastShowTs = null;
  try {
    window.localStorage.clear();
  } catch {
    // 忽略
  }
}

/** 测试专用：当前队列长度（验证 500 上限用） */
export function __queueSizeForTest(): number {
  return queue.length;
}
