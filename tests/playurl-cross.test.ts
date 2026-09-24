// 跨源兜底的预算下限 + 平台级降级（2026-09-24）。
//
// 为什么单独一个文件：这组用例靠 setChainConfigCache 注入一条「档内全挂死」的链路，
// 而 source-scripts.test.ts 里静态/动态混着导入 play-url 与 chain-store，vitest 的模块图
// 会让解析器拿到另一个 chain-store 实例（注入不生效、用例被默认链路"蒙对"）。
// 独立文件模块图干净，注入必定生效；生产不受影响（src 内部一律相对路径导入）。
//
// 事故：PC 上酷狗取链失败却从不换源到酷我，一首接一首报错切歌。根因不是没配跨源
// （chain.json 里 kg: ["kw","wyy"] 一直在），而是跨源排在档内线路**之后**、共用同一个
// totalMs：kg 三条串行线分片 2500+1250+1250 正好吃满 5000ms，跨源那一步判「预算耗尽未跑」。
// 真实 trace（本机真网络复现）：
//   kg@320 kg-yuxi=空; kg-stellarwave=空; kg-molan=空; cross:kw=预算耗尽未跑
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestBuiltin, SourceResponse } from "@/source-scripts/contract";
import type { ChainConfig } from "@/source-scripts/chain-config";
import { setChainConfigCache } from "@/source-scripts/chain-store";

/**
 * 跨源兜底的预算下限 + 平台级降级（2026-09-24）。
 *
 * 事故：PC 上酷狗取链失败却从不换源到酷我，一首接一首报错切歌。根因不是没配
 * 跨源（chain.json 里 `kg: ["kw","wyy"]` 一直在），而是跨源排在档内线路**之后**、
 * 共用同一个 totalMs：kg 三条串行线分片 2500+1250+1250 正好吃满 5000ms，跨源那一步
 * 判「预算耗尽未跑」。真实 trace（本机真网络复现）：
 *   kg@320 kg-yuxi=空; kg-stellarwave=空; kg-molan=空; cross:kw=预算耗尽未跑
 */
describe("跨源兜底：预算下限与平台降级", () => {
  const song = {
    id: "u-cross",
    name: "孤勇者",
    singer: "陈奕迅",
    album: "",
    picUrl: "",
    interval: 0,
  };

  /**
   * 桩：档内线路（a.example/lineN）请求永久挂死；其余（跨源 kw/wyy 端点）立即抛错
   * = 跨源也拿不到。注意匹配要锚在 a.example/line 上——跨源线路的 url 里也有 "line"
   * （a.example/kw-line1），宽松匹配会把跨源线路也一起挂死，用例就永远等不到结果。
   */
  function crossStub(calls: string[]): RequestBuiltin {
    return async (url) => {
      calls.push(url);
      if (url.includes("a.example/line")) return new Promise<never>(() => {});
      throw new Error("跨源端点在测试里不实现: " + url);
    };
  }

  /**
   * 三线档内链（模拟 kg：全部挂死）+ 跨源 kw（kw 侧也配一条线，这样降级抢先试时
   * 真的会向 kw 发请求——"第一笔请求就是跨源"才可断言）。
   */
  function setKgChain(budgetMs: number, lineCount: number): void {
    setChainConfigCache({
      chainRevision: 99,
      maxLinesPerQuality: 5,
      crossSources: { kg: ["kw"] },
      budget: { totalMs: budgetMs, lineMs: budgetMs },
      chains: {
        kg: Array.from({ length: lineCount }, (_, i) => ({
          id: `kg-l${i + 1}`,
          name: `挂死线${i + 1}`,
          kind: "http" as const,
          qualities: ["320" as const],
          request: { url: `https://a.example/line${i + 1}` },
          pick: "u",
        })),
        kw: [
          {
            id: "cross-kw-1",
            name: "酷我第1条",
            kind: "http" as const,
            qualities: ["320" as const],
            request: { url: "https://a.example/kw-line1" },
            pick: "u",
          },
        ],
      },
    });
  }

  /**
   * 通用：给某平台注入一条「档内线路全挂死」的链，并给每个跨源目标定义 2 条线路
   * （用来验证「跨源只跑第 1 条」——第 2 条的存在让断言有意义）。
   */
  function setChain(
    source: "kg" | "kw",
    budgetMs: number,
    lineCount: number,
    cross: Array<"kw" | "wyy">,
  ): void {
    const lines = Array.from({ length: lineCount }, (_, i) => ({
      id: `${source}-l${i + 1}`,
      name: `挂死线${i + 1}`,
      kind: "http" as const,
      qualities: ["320" as const],
      request: { url: `https://a.example/line${i + 1}` },
      pick: "u",
    }));
    // 每个跨源目标都配 2 条线：跨源阶段只该跑第 1 条（cross-kw-1 / cross-wyy-1），
    // 第 2 条（cross-kw-2 / cross-wyy-2）连请求都不该发
    const chains: Record<string, unknown> = { [source]: lines };
    for (const target of cross) {
      chains[target] = [1, 2].map((n) => ({
        id: `cross-${target}-${n}`,
        name: `${target}第${n}条`,
        kind: "http" as const,
        qualities: ["320" as const],
        request: { url: `https://a.example/${target}-line${n}` },
        pick: "u",
      }));
    }
    setChainConfigCache({
      chainRevision: 99,
      maxLinesPerQuality: 5,
      crossSources: { [source]: cross } as ChainConfig["crossSources"],
      budget: { totalMs: budgetMs, lineMs: budgetMs },
      chains: chains as ChainConfig["chains"],
    });
  }

  beforeEach(async () => {
    const { resetSourceHealth } = await import("@/source-scripts/actions/play-url");
    resetSourceHealth();
  });
  afterEach(async () => {
    const { resetSourceHealth } = await import("@/source-scripts/actions/play-url");
    resetSourceHealth();
  });

  it("档内三条线全挂死：跨源仍然跑得到（不再「预算耗尽未跑」），且不越过总预算", async () => {
    const { resolvePlayUrlWithBudget, consumeLastMissTrace } = await import(
      "@/source-scripts/actions/play-url"
    );
    const { ChainBudget } = await import("@/source-scripts/budget");
    setKgChain(5000, 3);
    const calls: string[] = [];
    const startedAt = Date.now();
    await expect(
      resolvePlayUrlWithBudget(
        crossStub(calls), "kg", song, "320", new ChainBudget(5000, 5000),
      ),
    ).rejects.toThrow("该歌曲暂时无法播放");
    const trace = consumeLastMissTrace("kg:u-cross:320");
    // 关键断言：档内确实是注入的三条挂死线（防止用例被默认链路"蒙对"）
    expect(trace).toContain("kg-l1=");
    // 跨源那一步真的跑了（修复前这里是 cross:kw=预算耗尽未跑）
    expect(trace).toContain("cross:kw=");
    expect(trace).not.toContain("cross:kw=预算耗尽未跑");
    // 档内挂死的线不许把跨源预留吃掉：整链仍在总预算内收场
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it("trace 区分「超时未返回」与线路返回空（以前两种死法都记成「空」）", async () => {
    const { resolvePlayUrlWithBudget, consumeLastMissTrace } = await import(
      "@/source-scripts/actions/play-url"
    );
    const { ChainBudget } = await import("@/source-scripts/budget");
    setChainConfigCache({
      chainRevision: 99,
      maxLinesPerQuality: 5,
      crossSources: { kg: ["kw"] },
      budget: { totalMs: 3000, lineMs: 3000 },
      chains: {
        kg: [
          {
            id: "kg-hang", name: "挂死线", kind: "http", qualities: ["320"],
            request: { url: "https://a.example/line-hang" }, pick: "u",
          },
          {
            id: "kg-empty", name: "空返回线", kind: "http", qualities: ["320"],
            request: { url: "https://a.example/line-empty" }, pick: "u",
          },
        ],
      },
    });
    const request: RequestBuiltin = async (url) => {
      if (url.includes("line-hang")) return new Promise<never>(() => {});
      if (url.includes("line-empty")) return { statusCode: 200, headers: {}, body: { u: "" } };
      throw new Error("跨源端点在测试里不实现");
    };
    await expect(
      resolvePlayUrlWithBudget(request, "kg", song, "320", new ChainBudget(3000, 3000)),
    ).rejects.toThrow("该歌曲暂时无法播放");
    const trace = consumeLastMissTrace("kg:u-cross:320");
    expect(trace).toContain("kg-hang=超时未返回");
    expect(trace).not.toContain("kg-hang=空");
    expect(trace).toContain("kg-empty=空");
  });

  it("同平台连续全灭到阈值：下一次先走跨源（不再每首烧满预算）", async () => {
    const {
      resolvePlayUrlWithBudget,
      consumeLastMissTrace,
      sourceHealthSnapshot,
    } = await import("@/source-scripts/actions/play-url");
    const { ChainBudget } = await import("@/source-scripts/budget");
    setKgChain(600, 1);
    const calls: string[] = [];
    const request = crossStub(calls);
    // 连打三次全灭 → 触发降级
    for (let i = 0; i < 3; i++) {
      await expect(
        resolvePlayUrlWithBudget(
          request, "kg", { ...song, id: `u-degrade-${i}` }, "320", new ChainBudget(600, 600),
        ),
      ).rejects.toThrow("该歌曲暂时无法播放");
    }
    expect(sourceHealthSnapshot()["kg"]?.degraded).toBe(true);
    // 第四次：跨源排在档内线路之前（trace 里 cross 先于 kg-l1）
    calls.length = 0;
    await expect(
      resolvePlayUrlWithBudget(
        request, "kg", { ...song, id: "u-degrade-3" }, "320", new ChainBudget(600, 600),
      ),
    ).rejects.toThrow("该歌曲暂时无法播放");
    const trace = consumeLastMissTrace("kg:u-degrade-3:320");
    expect(trace).toContain("降级中");
    expect(trace.indexOf("cross:kw=")).toBeGreaterThanOrEqual(0);
    expect(trace.indexOf("cross:kw=")).toBeLessThan(trace.indexOf("kg-l1="));
    // 降级后第一笔请求就是跨源端点（档内线路根本没抢跑）
    expect(calls[0]).not.toContain("a.example/line");
  });

  it("档内线路一次成功即解除降级（平台恢复后不再绕跨源）", async () => {
    const {
      resolvePlayUrlWithBudget,
      sourceHealthSnapshot,
      resetSourceHealth,
    } = await import("@/source-scripts/actions/play-url");
    const { ChainBudget } = await import("@/source-scripts/budget");
    resetSourceHealth();
    setKgChain(600, 1);
    const request = crossStub([]);
    for (let i = 0; i < 3; i++) {
      await expect(
        resolvePlayUrlWithBudget(
          request, "kg", { ...song, id: `u-recover-${i}` }, "320", new ChainBudget(600, 600),
        ),
      ).rejects.toThrow("该歌曲暂时无法播放");
    }
    expect(sourceHealthSnapshot()["kg"]?.degraded).toBe(true);
    // 档内线路活过来（返回可用地址）→ 降级记录清空。
    // 注意 Range 预检会去 GET 这个地址，桩必须也能应答它（否则被记成死链）
    const alive: RequestBuiltin = async (url) => {
      const line: SourceResponse = { statusCode: 200, headers: {}, body: { u: "http://t/alive.mp3" } };
      if (url.includes("a.example/line")) return line;
      const audio: SourceResponse = { statusCode: 206, headers: { "content-type": "audio/mpeg" }, body: "" };
      if (url.includes("t/alive.mp3")) return audio;
      throw new Error("不该走到跨源");
    };
    await expect(
      resolvePlayUrlWithBudget(
        alive, "kg", { ...song, id: "u-recover-ok" }, "320", new ChainBudget(600, 600),
      ),
    ).resolves.toBe("http://t/alive.mp3");
    expect(sourceHealthSnapshot()["kg"]).toBeUndefined();
  });

  /**
   * 用户反馈（2026-09-24，第一次）：「只走第一条 kw-native-des，失败了就跳下一首」。
   * 根因：档内线路按「剩余的一半」分摊，第一条线路（或它慢过切片的 Range 预检）
   * 就能把预算吃到只剩跨源预留，后面每条都记「预算耗尽未跑」。
   */
  it("四线档内链：第一条挂死不再吃掉后面三条（kw 4 条线必须条条都跑）", async () => {
    const { resolvePlayUrlWithBudget, consumeLastMissTrace } = await import(
      "@/source-scripts/actions/play-url"
    );
    const { ChainBudget } = await import("@/source-scripts/budget");
    setChain("kw", 5000, 4, ["wyy"]);
    const calls: string[] = [];
    await expect(
      resolvePlayUrlWithBudget(
        crossStub(calls), "kw", song, "320", new ChainBudget(5000, 5000),
      ),
    ).rejects.toThrow("该歌曲暂时无法播放");
    const trace = consumeLastMissTrace("kw:u-cross:320");
    for (const id of ["kw-l1", "kw-l2", "kw-l3", "kw-l4"]) {
      expect(trace).toContain(id + "=");
      expect(trace).not.toContain(id + "=预算耗尽未跑");
    }
    // 四条线路真的都发过请求（不是只有第一条）
    expect(calls.filter((u) => u.includes("a.example/line")).length).toBe(4);
    // 档内全灭后跨源照样跑得到（kw 的跨源只有 wyy 一个目标）
    expect(trace).toContain("cross:wyy=");
    expect(trace).not.toContain("cross:wyy=预算耗尽未跑");
  });

  it("第一条的 Range 预检挂死，也不许吃掉后面线路的份额", async () => {
    const { resolvePlayUrlWithBudget, consumeLastMissTrace } = await import(
      "@/source-scripts/actions/play-url"
    );
    const { ChainBudget } = await import("@/source-scripts/budget");
    setChain("kw", 5000, 4, ["wyy"]);
    const request: RequestBuiltin = async (url) => {
      if (url.includes("a.example/line1")) {
        const hit: SourceResponse = { statusCode: 200, headers: {}, body: { u: "http://t/dead.mp3" } };
        return hit;
      }
      if (url.includes("a.example/line")) return new Promise<never>(() => {});
      if (url.includes("t/dead.mp3")) return new Promise<never>(() => {});
      throw new Error("跨源端点在测试里不实现");
    };
    const startedAt = Date.now();
    await expect(
      resolvePlayUrlWithBudget(request, "kw", song, "320", new ChainBudget(5000, 5000)),
    ).rejects.toThrow("该歌曲暂时无法播放");
    const trace = consumeLastMissTrace("kw:u-cross:320");
    // 第一条死在自己的预检上（超时，不是死链），后面三条照样跑
    expect(trace).toContain("kw-l1=预检超时");
    for (const id of ["kw-l2", "kw-l3", "kw-l4"]) {
      expect(trace).toContain(id + "=");
      expect(trace).not.toContain(id + "=预算耗尽未跑");
    }
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  /**
   * 用户反馈（2026-09-24，确认版）：「kw 和 wyy 鼓励公平分配，但直到 kw 的第一条源
   * 和 wyy 的第一条源，不会进行到下面的第二条源」。即：
   *   · 两个跨源目标都要试，第一个失败要换下一个（公平分摊，不许饿死 wyy）；
   *   · 每个目标内部只跑它自己的第 1 条线路，第 2 条不发起请求。
   * 这条测试同时钉住这两点：kw/wyy 都被试过，但各自的 -line2 一次都没请求。
   */
  it("跨源两个目标都试，但每个目标只跑它自己的第 1 条线路", async () => {
    const { resolvePlayUrlWithBudget, consumeLastMissTrace } = await import(
      "@/source-scripts/actions/play-url"
    );
    const { ChainBudget } = await import("@/source-scripts/budget");
    setChain("kg", 5000, 3, ["kw", "wyy"]);
    const calls: string[] = [];
    const request = crossStub(calls);
    await expect(
      resolvePlayUrlWithBudget(request, "kg", song, "320", new ChainBudget(5000, 5000)),
    ).rejects.toThrow("该歌曲暂时无法播放");
    const trace = consumeLastMissTrace("kg:u-cross:320");
    // 三条档内线路都跑过（公平分摊仍然成立）
    for (const id of ["kg-l1", "kg-l2", "kg-l3"]) {
      expect(trace).toContain(id + "=");
      expect(trace).not.toContain(id + "=预算耗尽未跑");
    }
    // 两个跨源目标都被试过（kw 失败 → 轮到 wyy），不是只试第一个
    expect(trace).toContain("cross:kw=空");
    expect(trace).toContain("cross:wyy=空");
    expect(trace).not.toContain("cross:wyy=预算耗尽未跑");
    // 每个目标只跑了第 1 条线路：-line1 发过请求，-line2 一次都没有
    expect(calls.some((u) => u.includes("kw-line1"))).toBe(true);
    expect(calls.some((u) => u.includes("wyy-line1"))).toBe(true);
    expect(calls.some((u) => u.includes("kw-line2"))).toBe(false);
    expect(calls.some((u) => u.includes("wyy-line2"))).toBe(false);
  });

  /**
   * 跨源第 1 条命中即返回，**不再**去看该源第 2 条、也不再去试下一个跨源目标。
   */
  it("跨源第 1 条命中即返回：同源第 2 条与后续跨源目标都不请求", async () => {
    const { resolvePlayUrlWithBudget } = await import("@/source-scripts/actions/play-url");
    const { ChainBudget } = await import("@/source-scripts/budget");
    setChain("kg", 5000, 3, ["kw", "wyy"]);
    const calls: string[] = [];
    const request: RequestBuiltin = async (url) => {
      calls.push(url);
      if (url.includes("a.example/line")) return new Promise<never>(() => {});
      if (url.includes("t/cross-ok.mp3")) {
        const audio: SourceResponse = {
          statusCode: 206,
          headers: { "content-type": "audio/mpeg" },
          body: "",
        };
        return audio;
      }
      // 跨源 kw 的第 1 条命中
      if (url.includes("kw-line1")) {
        const hit: SourceResponse = { statusCode: 200, headers: {}, body: { u: "http://t/cross-ok.mp3" } };
        return hit;
      }
      throw new Error("不该被请求: " + url);
    };
    await expect(
      resolvePlayUrlWithBudget(request, "kg", song, "320", new ChainBudget(5000, 5000)),
    ).resolves.toBe("http://t/cross-ok.mp3");
    expect(calls.some((u) => u.includes("kw-line1"))).toBe(true);
    expect(calls.some((u) => u.includes("kw-line2"))).toBe(false);
    expect(calls.some((u) => u.includes("wyy-line1"))).toBe(false);
  });
});
