/**
 * 音源引擎（`@/source-engine/client`）的测试替身 —— 三个 facade 测试文件共用这一份。
 *
 * 这三个文件（`search-many` / `source-filter` / `search-merged`）测的都是「app 侧怎么调
 * 数据包入口」，需要的东西完全一样：记下每次 `engineInvoke(entry, args)`、按入口给应答、
 * 按入口（或精确到关键词）注入错误。曾经每个文件各抄一遍二十多行的 `vi.mock` 工厂，
 * 改一处漏两处 —— 现在 mock 本体只有这里一份，各文件只保留各自用例的数据。
 *
 * 用法（`vi.hoisted` 里只能写字面量，所以状态在测试文件里构造，行为从这里来）：
 * ```ts
 * const engineMock = vi.hoisted<EngineMockState>(() => ({
 *   phase: "ready", detail: null, fallback: null,
 *   payloads: new Map(), errors: new Map(), calls: [],
 * }));
 * vi.mock("@/source-engine/client", () => engineClientModule(engineMock));
 * ```
 */
export interface EngineCall {
  entry: string;
  args: Record<string, unknown>;
}

export interface EngineMockState {
  /** `null` = 引擎没起来（`engineSnapshot().phase`），非 "ready" 时门面拿不到应答 */
  phase: string | null;
  detail: string | null;
  /** 任一入口的缺省应答：只想给「不管哪个入口都回这个」的用例用 */
  fallback: unknown;
  /** 指定入口的应答（优先于 `fallback`） */
  payloads: Map<string, unknown>;
  /**
   * 指定入口抛错。键可以是入口名（`"searchMany"`），
   * 也可以是 `"${entry}:${keyword}"`（只让某个关键词的那次调用失败，测逐词隔离用）。
   */
  errors: Map<string, string>;
  calls: EngineCall[];
}

/** 重置成「刚 mock、还没有任何调用」的状态（`afterEach` / `beforeEach` 各文件自行调用） */
export function resetEngineState(state: EngineMockState): void {
  state.phase = "ready";
  state.detail = null;
  state.fallback = null;
  state.payloads.clear();
  state.errors.clear();
  state.calls.length = 0;
}

/** 交给 `vi.mock("@/source-engine/client", () => engineClientModule(state))` 的模块替身 */
export function engineClientModule(state: EngineMockState) {
  return {
    INVOKE_TIMEOUT_MS: 20_000,
    engineInvoke: async (entry: string, args: Record<string, unknown>) => {
      state.calls.push({ entry, args });
      const keyword = typeof args.keyword === "string" ? args.keyword : "";
      const byKeyword = state.errors.get(`${entry}:${keyword}`);
      if (byKeyword !== undefined) throw new Error(byKeyword);
      const byEntry = state.errors.get(entry);
      if (byEntry !== undefined) throw new Error(byEntry);
      return state.payloads.has(entry) ? state.payloads.get(entry) : state.fallback;
    },
    engineResolve: async () => ({
      url: "",
      line: null,
      error: "",
      stalled: false,
      referer: "",
      size: null,
      actualQuality: "",
    }),
    engineSnapshot: () => ({ phase: state.phase, code: null, detail: state.detail }),
  };
}
