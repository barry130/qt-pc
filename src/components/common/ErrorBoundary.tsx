import { Component, type ErrorInfo, type ReactNode } from "react";
import * as ipc from "@/services/ipc";
import { log } from "@/lib/logger";
import { LAST_ERROR_KEY } from "@/lib/storageKeys";

type AutoResetOptions = {
  /** 出错后等多久自动重试（默认 1000ms） */
  delayMs?: number;
  /** 最多连续自动重试几次（默认 3） */
  maxAttempts?: number;
};

type Props = {
  children: ReactNode;
  /** 出错时的定位标签（路由路径 / 页面名），会写进日志与错误卡片 */
  label?: string;
  /**
   * 变化时自动清空已捕获的错误并重新尝试渲染。
   * 用于「路由/页签切换后自动恢复」——不必让用户手动点重试。
   */
  resetKey?: string;
  /**
   * 无人值守的自愈：捕获错误后等一小会儿自动重试渲染。
   *
   * 为什么重试真的有用：错误边界一旦接住异常，React 会把**整棵子树卸载**，
   * 于是重试等于让子树重新挂载、state 从零开始（对依赖外部状态的视图，比如
   * 桌面歌词窗口，等于重新走一遍初始化与取数）。所以「偶发错误」能靠它自愈，
   * 而用户连「重试」按钮都点不到的场景（无边框透明窗、没人盯着看）尤其需要它。
   *
   * 为什么必须有次数上限：若子树每次渲染都抛同一个错（确定性错误），自动重试
   * 只会把界面反复打回错误卡片、并且刷屏日志。超过 `maxAttempts` 就停在卡片上，
   * 交回用户手动「重试 / 重载界面」。
   */
  autoReset?: boolean | AutoResetOptions;
  /** 自定义兜底 UI；不传则用内置错误卡片 */
  fallback?: (error: Error, reset: () => void) => ReactNode;
};

type State = {
  error: Error | null;
  /** 自动重试额度已用尽（确定性错误），卡片要如实说明不再自动重试 */
  autoRetryExhausted: boolean;
};

/** 自动重试的默认等待：够短，用户几乎察觉不到；又够长，不至于在同一帧里反复炸 */
const AUTO_RESET_DELAY_MS = 1000;
/** 默认重试额度：3 次足够吃掉「偶发一次」的抖动，又不会把确定性错误刷成死循环 */
const AUTO_RESET_MAX_ATTEMPTS = 3;
/**
 * 额度重置窗口：距上次自动重试已过这么久，说明期间界面是好的 —— 这次算**新故障**，
 * 额度重新给满。否则「一天里零散崩几次」会被误判成连续失败而早早放弃自愈。
 */
const AUTO_RESET_BUDGET_MS = 10_000;

/**
 * 错误边界（DESIGN §5.1 健壮性）。
 *
 * 为什么要它：项目原本一个 ErrorBoundary 都没有，而 `main.tsx` 的全局兜底
 * 会直接清空 `#root` —— 任何一处渲染异常或未处理的 Promise 拒绝都会让整个
 * 界面变成一块不可恢复的红字。有了边界之后：
 * - 单个页面/组件崩掉只影响它自己的区域，其余界面照常可用；
 * - 错误与组件栈会写进 `app.lastError`（桌面端没有顺手 devtools，从库里读），
 *   同时落一份进文件日志（设置页「诊断日志」指向的目录）；
 * - 用户可以在原地「重试」，或「重载界面」。
 *
 * 恢复有两条路，按场景选：
 * - `resetKey`：外部状态一变（换路由 / 页签切回来）就自动清错重试。适合有人操作、
 *   且确实存在「状态变了」时机的界面 —— 主窗口那几处边界都走这条。
 * - `autoReset`：没人操作也会自己重试。适合**没有**上面那种时机、又没人会去点按钮的
 *   界面（桌面歌词窗：不换路由、无边框透明窗）。详见 `autoReset` 的字段注释。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, autoRetryExhausted: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const label = this.props.label ? `[${this.props.label}] ` : "";
    const detail = [
      `${label}${error.message}`,
      error.stack ?? "",
      "组件栈：",
      info.componentStack ?? "",
    ].join("\n");
    console.error("[qt][ErrorBoundary]", detail);
    // 写库失败不影响界面（ipc 本身可能就是失败原因）
    void ipc.setSetting(LAST_ERROR_KEY, detail).catch(() => {});
    // 同步落一份进文件日志。设置页「诊断日志」指的是 %APPDATA%/QuietMusic/logs
    // 那个目录，原先这里只写 settings 表 —— 用户按提示去翻日志文件时一条都找不到
    // （2026-10-12 反馈：桌面歌词崩了，诊断日志里没有）。
    void ipc.writeLog("error", detail).catch(() => {});
    this.scheduleAutoReset();
  }

  componentDidUpdate(prevProps: Props): void {
    // 路由/页签切换后自动恢复：错误状态清掉，让子树重新渲染
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      // 已经因 resetKey 恢复了，别再让挂起的那次自动重试重复触发一次重挂载
      this.clearAutoResetTimer();
      this.setState({ error: null, autoRetryExhausted: false });
    }
  }

  componentWillUnmount(): void {
    this.clearAutoResetTimer();
  }

  /** 自动重试的配置：`true` 用默认值，对象可覆盖单项 */
  private autoResetOptions(): Required<AutoResetOptions> | null {
    const { autoReset } = this.props;
    if (autoReset === undefined || autoReset === false) return null;
    const opts = autoReset === true ? {} : autoReset;
    return {
      delayMs: opts.delayMs ?? AUTO_RESET_DELAY_MS,
      maxAttempts: opts.maxAttempts ?? AUTO_RESET_MAX_ATTEMPTS,
    };
  }

  /**
   * 排一次自动重试。
   *
   * 额度按「连续失败」计：距上次自动重试超过 `AUTO_RESET_BUDGET_MS` 视为新故障、
   * 额度重置（见该常量注释）。额度用尽就停在错误卡片上，不再自己动 —— 确定性错误
   * 自动重试是没有意义的，只会掩盖问题、刷屏日志。
   */
  private scheduleAutoReset(): void {
    const opts = this.autoResetOptions();
    if (opts === null || opts.maxAttempts <= 0) return;

    const now = Date.now();
    if (now - this.lastAutoResetAt >= AUTO_RESET_BUDGET_MS) this.autoResetAttempts = 0;
    if (this.autoResetAttempts >= opts.maxAttempts) {
      log.warn(
        `[qt][ErrorBoundary] ${this.props.label ?? "?"} 连续出错 ${this.autoResetAttempts} 次，停止自动重试`,
      );
      // 卡片文案要如实：别让用户盯着「正在自动重试」干等一个不会来的重试
      if (!this.state.autoRetryExhausted) this.setState({ autoRetryExhausted: true });
      return;
    }

    this.autoResetAttempts += 1;
    this.clearAutoResetTimer();
    this.autoResetTimer = setTimeout(() => {
      this.autoResetTimer = null;
      this.lastAutoResetAt = Date.now();
      this.setState({ error: null, autoRetryExhausted: false });
    }, opts.delayMs);
  }

  private clearAutoResetTimer(): void {
    if (this.autoResetTimer !== null) {
      clearTimeout(this.autoResetTimer);
      this.autoResetTimer = null;
    }
  }

  private reset = (): void => {
    // 手动重试视为「用户在场」：额度给满，之后再偶发也能自愈
    this.autoResetAttempts = 0;
    this.lastAutoResetAt = 0;
    this.clearAutoResetTimer();
    this.setState({ error: null, autoRetryExhausted: false });
  };

  /** 自动重试额度与计时（手动重试会清空额度） */
  private autoResetAttempts = 0;
  private lastAutoResetAt = 0;
  private autoResetTimer: ReturnType<typeof setTimeout> | null = null;

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className="flex h-full min-h-0 items-center justify-center overflow-auto p-6">
        <div className="w-full max-w-lg rounded-2xl border border-border bg-card/90 p-5 text-card-foreground shadow-xl backdrop-blur-xl">
          <h2 className="text-sm font-medium">
            这块内容出错了{this.props.label ? `（${this.props.label}）` : ""}
          </h2>
          <p className="mt-2 text-xs text-muted-foreground">
            {this.state.autoRetryExhausted
              ? "自动重试已停止（连续多次失败）。可以点「重试」再试一次，或「重载界面」恢复。"
              : this.autoResetOptions() !== null
                ? "正在自动重试；若持续失败，也可以点「重试」重新渲染，或「重载界面」恢复。"
                : "其余功能不受影响，可以点「重试」重新渲染，或「重载界面」恢复。"}
          </p>
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              错误详情
            </summary>
            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-secondary p-2 text-[11px] leading-relaxed">
              {error.message}
              {error.stack ? `\n\n${error.stack}` : ""}
            </pre>
          </details>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent"
            >
              重载界面
            </button>
            <button
              type="button"
              onClick={this.reset}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              重试
            </button>
          </div>
        </div>
      </div>
    );
  }
}