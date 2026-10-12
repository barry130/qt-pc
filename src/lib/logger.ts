import { errMsg, stripErrorUrls } from "@/lib/utils";
import * as ipc from "@/services/ipc";
import type { LogLevel } from "@/services/ipc";

/**
 * 前端日志（四级：error / warn / info / debug）。
 *
 * 与 Rust 侧 `file_logger` 同一套口径：
 * - **error**：功能已经不可用、数据可能损坏，需要有人介入；
 * - **warn**：降级但自愈（回落、重试、离线排队、跳过清理），用户还能继续用；
 * - **info**：低频状态变化与用户主动操作的结果；
 * - **debug**：高频的逐曲/逐请求细节与决策轨迹。
 *
 * 每次调用做两件事：
 * 1. 原样打给 `console` —— 开发期 devtools 的现场，**不受级别影响**（否则把
 *    `log.level` 调成 error 之后，开发时连 warn 都看不见了）；
 * 2. 级别够用时转写一份进文件日志（`write_log` → 诊断日志目录）。
 *
 * 默认级别跟构建走：编译包 debug、发行包 warn，与 Rust 侧 `default_level()` 一致；
 * qt_admin 在设置页改过之后由 `setLogLevel()` 同步过来。
 *
 * 契约：**日志永远不会抛**。IPC 不可用（含单测里没 mock `writeLog`）只是这条日志
 * 丢了，绝不能反过来把调用方打挂；而记录「记录失败」本身也不再写一条日志，
 * 否则就是自己把自己刷爆。
 */

/** 数字越小越严重，`emit` 用它和 `minLevel` 比 */
const SEVERITY: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/**
 * 是否 debug 构建 —— 与 Rust 侧 `default_level()` 的 `cfg!(debug_assertions)` 对齐：
 * `DEV` 覆盖 `vite dev`（含 `tauri dev` 的前端），`TAURI_ENV_DEBUG` 覆盖
 * `tauri build --debug` 打出来的包（那时 `DEV` 已经是 false）。
 */
const DEBUG_BUILD = Boolean(import.meta.env.DEV || import.meta.env.TAURI_ENV_DEBUG);

/** 当前生效的最低级别：比它轻的不再落盘（默认跟构建走，与后端 default_level 一致） */
let minLevel: LogLevel = DEBUG_BUILD ? "debug" : "warn";

/** 与后端生效级别对齐（设置页改级别 / 启动时读配置后调用） */
export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

/**
 * 启动时从后端读一次生效级别。
 *
 * 后端级别是按构建定的默认档（编译包 debug / 发行包 warn），qt_admin 改过之后
 * 存在 settings 表里。前端这份过滤必须跟着走，否则管理员把级别调到 debug 了，
 * 前端那半边的日志还是被自己的 warn 卡住 —— 看起来「改了没用」。
 *
 * 读不到（后端没起 / 单测没 mock）就按构建默认走，不打扰启动。
 */
export async function syncLogLevel(): Promise<void> {
  try {
    const cfg = await ipc.getLogConfig();
    // trace 是 log crate 的能力，前端最细只到 debug
    setLogLevel(cfg.level === "trace" ? "debug" : cfg.level);
  } catch {
    // 保持构建默认
  }
}

/** 当前前端生效级别：排查「为什么没有日志」时先看这一条 */
export function currentLogLevel(): LogLevel {
  return minLevel;
}

/**
 * 单个参数转文本。
 *
 * 特意不用 `errMsg` 一条路走到底：它会**丢掉 stack**，而文件日志的价值恰恰在
 * 事后复盘——release 下没有 devtools，stack 是唯一能定位到行的东西。所以 Error
 * 优先取 `stack`（没有才退回 `message`），并且照旧过一遍 `stripErrorUrls`
 * （stack 里常带请求地址，含自家后端域名）。
 */
function formatOne(arg: unknown): string {
  if (arg instanceof Error) {
    const text = arg.stack ?? `${arg.name}: ${arg.message}`;
    return stripErrorUrls(text);
  }
  return errMsg(arg);
}

/** 参数拼成一行，与 console 的输出顺序一致 */
function toText(args: unknown[]): string {
  return args.map(formatOne).join(" ");
}

function emit(level: LogLevel, args: unknown[]): void {
  if (level === "debug") console.debug(...args);
  else if (level === "warn") console.warn(...args);
  else if (level === "error") console.error(...args);
  else console.info(...args);

  if (SEVERITY[level] > SEVERITY[minLevel]) return;
  try {
    // 不 await：调用方都在同步路径上（错误回调、事件处理），落盘慢不该拖住界面
    void ipc.writeLog(level, toText(args)).catch(() => {});
  } catch {
    // 见文件头契约：这一条丢了就算了
  }
}

/** 四级日志入口。用法：`log.warn("[queue] 清空队列失败", err)` */
export const log = {
  error: (...args: unknown[]): void => emit("error", args),
  warn: (...args: unknown[]): void => emit("warn", args),
  info: (...args: unknown[]): void => emit("info", args),
  debug: (...args: unknown[]): void => emit("debug", args),
};
