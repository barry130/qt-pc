/**
 * 单项（单音源 / 单请求）超时工具。
 *
 * 与 `budget.ts` 的分工：budget 管"整条取链链路的预算"，这里管"多个音源并发时，
 * 单个音源不许拖住整体"。音源包侧（`actions/aggregate.ts`）与宿主侧
 * （`index.ts` 的聚合入口）都要用，所以单独成模块，避免各写一份。
 *
 * 语义：超时后**不再等待**（蓝本同款 `Promise.race`），但底层请求不会被取消 ——
 * 宿主侧还没有把 AbortSignal 贯通到 Rust 的通道（见 budget.ts 的说明），
 * 被丢弃的那次请求仍会在后台跑完，结果没人用。
 *
 * `Promise.race` 会给两个分支都挂上处理函数，所以底层请求"之后才失败"也不会
 * 冒泡成 unhandledrejection（那会触发 main.tsx 的全局兜底、弹一条致命错误）。
 */

/** 聚合动作里单个音源的时间上限 */
export const PER_SOURCE_TIMEOUT_MS = 4000;

export function withTimeoutMs<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} 超时（${ms}ms）`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
