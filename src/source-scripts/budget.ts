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
 *
 * 为什么是 5000 而不是更大的值：chain.json 是**四端共用**的一份编排，
 * 预算必须同时满足两侧的应答上限，取更紧的那个——
 *   · PC/Tauri：playurl_bridge.rs 的 ASK_TIMEOUT = 15s（宽松）；
 *   · App：stores/player.ts 的 URL_FETCH_BUDGET_MS = **6000ms**（硬上限）。
 * 总预算 5000 + 整链宽限 250 = 5250 < 6000，保证取链在 App 放弃**之前**
 * 给出确定答复并带上逐线路 trace；写 12000 时实测出现过单次取链 10495ms，
 * 在 App 上会被直接掐断、日志只剩超时。V8 引擎下健康取链通常 1~3s，
 * 5000 对成功率没有影响。
 */
export const CHAIN_BUDGET_MS = 5_000;
export const CHAIN_LINE_MS = 5_000;

/**
 * 整链兜底比内层多让出的宽限（见 ChainBudget.runChain）。
 * 只用于「让内层的失败与追踪先落定」，必须远小于引擎侧应答预算。
 */
export const CHAIN_GRACE_MS = 250;

export class ChainBudget {
  private readonly deadline: number;
  private readonly lineMs: number;
  /**
   * 整链总预算（毫秒）。取链链用它按比例收缩「留给跨源兜底的预留」
   * （play-url.ts 的 CROSS_RESERVE_MS）：总预算被 chain.json 调小时，
   * 预留不能大到把档内线路全挤掉。
   */
  readonly totalMs: number;

  constructor(totalMs: number = CHAIN_BUDGET_MS, lineMs: number = CHAIN_LINE_MS) {
    this.totalMs = totalMs;
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
   *
   * @param sliceOverrideMs 显式指定等待时长（缺省 = 单线路分片）。
   */
  async run<T>(work: Promise<T>, fallback: T, sliceOverrideMs?: number): Promise<T> {
    return (await this.runTimed(work, fallback, sliceOverrideMs)).value;
  }

  /**
   * 同 run，但额外告知「是不是等超时了」。
   *
   * 预检必须区分这两者：Range 预检超时只说明这一档预算不够，**不等于链接是死的**。
   * 2026-09-21 实测：`206 + 2 字节`（按 verifyPlayable 口径属于通过）的合法直链，
   * 因为预检慢过切片被判成「死链（Range 预检不过）」，好链接被丢掉。
   */
  async runTimed<T>(
    work: Promise<T>,
    fallback: T,
    sliceOverrideMs?: number,
  ): Promise<{ value: T; timedOut: boolean }> {
    const slice = sliceOverrideMs !== undefined ? sliceOverrideMs : this.sliceMs();
    if (slice <= 0) return { value: fallback, timedOut: true };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const value = await Promise.race([
        work.catch(() => fallback),
        new Promise<T>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve(fallback);
          }, slice);
        }),
      ]);
      return { value, timedOut };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * 整链兜底等待：按**剩余总预算**而不是单线路分片。
   *
   * layer.ts 的外层包装必须用它。用 run() 的后果（2026-09-21 实测，可复现）：
   * 外层只等 lineMs，而 lineMs 总不大于 totalMs，于是外层永远在内层跑完之前截断——
   *   · 内层的 totalMs 预算整段不可达（totalMs=12000/lineMs=6000 时，实测无论内层
   *     需要多久，外层都在 6000ms 返回空串）；
   *   · 外层截断时内层还没写回追踪，错误文本永远拿不到本次请求的 trace，
   *     用户看到的逐线路追踪其实是别的请求残留的（见 play-url.ts 的 lastMissTrace）。
   */
  async runChain<T>(work: Promise<T>, fallback: T): Promise<T> {
    // 比内层多让 CHAIN_GRACE_MS：外层与内层共用 totalMs，两个定时器同时到点，
    // 而外层先注册先触发，会在内层写回追踪之前就返回空串（实测 100% 命中），
    // 错误文本因此永远拿不到本次请求的 trace。多等一点点，让内层的失败先落定。
    // 宽限很小，仍在引擎应答预算内（安卓侧取链预算 12s、App 侧 6s）。
    return await this.run(work, fallback, this.remainingMs + CHAIN_GRACE_MS);
  }
}
