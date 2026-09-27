import { Component, type ErrorInfo, type ReactNode } from "react";
import * as ipc from "@/services/ipc";
import { LAST_ERROR_KEY } from "@/lib/storageKeys";

type Props = {
  children: ReactNode;
  /** 出错时的定位标签（路由路径 / 页面名），会写进日志与错误卡片 */
  label?: string;
  /**
   * 变化时自动清空已捕获的错误并重新尝试渲染。
   * 用于「路由/页签切换后自动恢复」——不必让用户手动点重试。
   */
  resetKey?: string;
  /** 自定义兜底 UI；不传则用内置错误卡片 */
  fallback?: (error: Error, reset: () => void) => ReactNode;
};

type State = { error: Error | null };

/**
 * 错误边界（DESIGN §5.1 健壮性）。
 *
 * 为什么要它：项目原本一个 ErrorBoundary 都没有，而 `main.tsx` 的全局兜底
 * 会直接清空 `#root` —— 任何一处渲染异常或未处理的 Promise 拒绝都会让整个
 * 界面变成一块不可恢复的红字。有了边界之后：
 * - 单个页面/组件崩掉只影响它自己的区域，其余界面照常可用；
 * - 错误与组件栈会写进 `app.lastError`（桌面端没有顺手 devtools，从库里读）；
 * - 用户可以在原地「重试」，或「重载界面」。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
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
  }

  componentDidUpdate(prevProps: Props): void {
    // 路由/页签切换后自动恢复：错误状态清掉，让子树重新渲染
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className="flex h-full min-h-0 items-center justify-center overflow-auto p-6">
        <div className="w-full max-w-lg rounded-2xl border border-border bg-card p-5 text-card-foreground shadow-xl">
          <h2 className="text-sm font-medium">
            这块内容出错了{this.props.label ? `（${this.props.label}）` : ""}
          </h2>
          <p className="mt-2 text-xs text-muted-foreground">
            其余功能不受影响，可以点「重试」重新渲染，或「重载界面」恢复。
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