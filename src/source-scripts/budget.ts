/**
 * 取链预算（2026-09-18）。
 *
 * 引擎主导的换歌（自然播完自动切歌、随机下一首、打开流失败后重取）会发
 * `play_url_request` 问前端，前端必须在 playurl_bridge.rs 的 ASK_TIMEOUT
 * （15s）内应答，否则引擎直接判「无可用播放地址」并跳歌——对用户来说，
 * 链路慢和链路错是同一个结果。
 *
 * 聚合链里有两条会无上限吃时间的路径：单条线路请求挂死（代理型 CDN、
 * 第三方直出模板常见），以及跨源多首逐个试。所以整条链带一个总预算，
 * 单条线路再带一个分片上限：分片上限保证挂死的线路不独占预算（后面的
 * 线路还有机会），总预算保证一定按时应答。
 */
export const CHAIN_BUDGET_MS = 12_000;
export const CHAIN_LINE_MS = 6_000;

export class ChainBudget {
  private readonly deadline: number;
  private readonly lineMs: number;

  constructor(totalMs: number = CHAIN_BUDGET_MS, lineMs: number = CHAIN_LINE_MS) {
    this.deadline = Date.now() + totalMs;
    this.lineMs = lineMs;
  }

  /** 剩余总预算（毫秒，可为负） */
  get remainingMs(): number {
    return this.deadline - Date.now();
  }

  get expired(): boolean {
    return this.remainingMs <= 0;
  }

  /** 单条线路可用时长：分片上限与剩余总预算取小 */
  sliceMs(): number {
    return Math.min(this.lineMs, this.remainingMs);
  }

  /**
   * 在分片时长内等待 work；超时或 work 抛错都返回 fallback。
   * 不取消底层请求（无 AbortSignal 通道），只是不再等它——换源语义里
   * 「超时」与「失败」等价，都是继续下一条线路。
   */
  async run<T>(work: Promise<T>, fallback: T): Promise<T> {
    const slice = this.sliceMs();
    if (slice <= 0) return fallback;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work.catch(() => fallback),
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(fallback), slice);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
