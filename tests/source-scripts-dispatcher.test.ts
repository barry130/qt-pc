/**
 * 主窗口 facade（src/source-scripts/index.ts）测试。
 *
 * app 侧**不再内置**任何第三方音源实现：数据接口与取链只经音源引擎窗口
 * （engineInvoke / engineResolve），本文件用引擎 mock 断言 payload 映射、
 * 无包/缺接口报错、resolvePlayUrl 回填命令被调用、命中线路与失败死因的记账；
 * local 源的第三方动作直接报错。
 *
 * 音源包**内部**（线路、方案、chain.json、__qtEntries）不随仓库分发，
 * 其实现与测试由独立渠道维护。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

/** 音源引擎 mock：index.ts 已不内置音源实现，app 层数据/取链只经引擎窗口 */
const engineMock = vi.hoisted(() => ({
  phase: "booting" as string | null,
  detail: null as string | null,
  invokeResult: null as Record<string, unknown> | null,
  resolveUrl: "",
  /** 命中线路（bundle getPlayUrl 应答里的 line；null = 未知） */
  resolveLine: null as { id: string; name: string; kind: string } | null,
  /** 失败死因（bundle getPlayUrl 抛出的逐线路 trace） */
  resolveError: "",
  resolveThrows: false,
  calls: [] as Array<{ entry: string; args: Record<string, unknown> }>,
}));
vi.mock("@/source-engine/client", () => ({
  engineInvoke: async (entry: string, args: Record<string, unknown>) => {
    engineMock.calls.push({ entry, args });
    return engineMock.invokeResult;
  },
  engineResolve: async () => {
    if (engineMock.resolveThrows) throw new Error("引擎窗口不可用");
    return {
      url: engineMock.resolveUrl,
      line: engineMock.resolveLine,
      error: engineMock.resolveError,
    };
  },
  engineSnapshot: () => ({
    phase: engineMock.phase,
    code: null,
    detail: engineMock.detail,
  }),
}));

describe("source-scripts dispatcher（纯音源包：app 只经引擎调用）", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    engineMock.phase = "booting";
    engineMock.detail = null;
    engineMock.invokeResult = null;
    engineMock.resolveUrl = "";
    engineMock.resolveThrows = false;
    engineMock.calls.length = 0;
  });

  it("数据接口：引擎 payload 映射为 App Playlist 模型", async () => {
    engineMock.phase = "ready";
    engineMock.invokeResult = {
      list: [
        {
          id: "12345",
          name: "脚本通道歌单",
          platform: "wyy",
          picUrl: "https://p1.music.126.net/x.jpg",
          playCount: "999",
        },
      ],
    };
    const mod = await import("@/source-scripts");
    const result = await mod.getRecommendations("wyy", null, 1);
    expect(result[0]?.id).toBe("12345");
    expect(result[0]?.name).toBe("脚本通道歌单");
    expect(result[0]?.platform).toBe("wyy");
    expect(result[0]?.description).toBeNull();
    expect(engineMock.calls).toContainEqual({
      entry: "recommendations",
      args: { source: "wyy", category: null, page: 1 },
    });
  });

  it("引擎报 error 相位（如未安装音源包）：数据接口抛可操作错误", async () => {
    engineMock.phase = "error";
    engineMock.detail = "未安装音源包";
    engineMock.invokeResult = null;
    const mod = await import("@/source-scripts");
    await expect(mod.getRecommendations("wyy", null, 1)).rejects.toThrow(
      "音源包加载失败",
    );
  });

  it("音源包返回结构不符：抛错而不是静默空结果", async () => {
    engineMock.phase = "ready";
    engineMock.invokeResult = {};
    const mod = await import("@/source-scripts");
    await expect(mod.getRecommendations("wyy", null, 1)).rejects.toThrow(
      "音源包返回结构不符",
    );
  });

  it("local 源：第三方动作直接报错（本地路径由页面单独路由）", async () => {
    const mod = await import("@/source-scripts");
    await expect(mod.getRecommendations("local", null, 1)).rejects.toThrow(
      "local 源不支持该动作",
    );
    await expect(mod.getPlaylistDetail("local", "1")).rejects.toThrow(
      "local 源不支持该动作",
    );
  });

  it("resolvePlayUrl（预解析）：引擎解析成功后回填引擎缓存", async () => {
    engineMock.phase = "ready";
    engineMock.resolveUrl = "http://dl.music.example/song.mp3";
    const ipc = await import("@/services/ipc");
    const backfillSpy = vi.spyOn(ipc, "setResolvedPlayUrl").mockResolvedValue(undefined);
    const mod = await import("@/source-scripts");
    const track = {
      id: "1901371647",
      platform: "wyy" as const,
      title: "孤勇者",
      singer: "陈奕迅",
      album: "",
      picUrl: "",
      duration: 260,
      musicId: null,
    };
    const url = await mod.resolvePlayUrl(track, "128");
    expect(url).toBe("http://dl.music.example/song.mp3");
    expect(backfillSpy).toHaveBeenCalledWith(track, "128", "http://dl.music.example/song.mp3");
    backfillSpy.mockRestore();
  });

  it("resolvePlayUrl（预解析）：命中线路随地址一起记，管理端按曲目+音质读回", async () => {
    const { playUrlLine, clearPlayUrlLines } = await import("@/source-scripts/playurl-line");
    const ipc = await import("@/services/ipc");
    const backfillSpy = vi.spyOn(ipc, "setResolvedPlayUrl").mockResolvedValue(undefined);
    const mod = await import("@/source-scripts");
    const track = {
      id: "000iBXhy1RQDgL",
      platform: "qq" as const,
      title: "微光",
      singer: "任歌飞",
      album: "",
      picUrl: "",
      duration: 161,
      musicId: null,
    };
    clearPlayUrlLines();
    // 未取过链 = 未知
    expect(playUrlLine(track, "320")).toBe("");
    engineMock.phase = "ready";
    engineMock.resolveUrl = "http://dl.music.example/weiguang.mp3";
    engineMock.resolveLine = { id: "qq-demo-line", name: "演示线路（聚合内核）", kind: "lx" };
    await mod.resolvePlayUrl(track, "320");
    // 展示文本与安卓端同口径：名称 · 机制 · 线路 id
    expect(playUrlLine(track, "320")).toBe("演示线路（聚合内核） · lx · qq-demo-line");
    // 另一个音质没有记录（key 含音质）
    expect(playUrlLine(track, "128")).toBe("");
    // 包内缓存命中（line = null）不改写已有记录
    engineMock.resolveLine = null;
    await mod.resolvePlayUrl(track, "320");
    expect(playUrlLine(track, "320")).toBe("演示线路（聚合内核） · lx · qq-demo-line");
    engineMock.resolveLine = null;
    engineMock.resolveUrl = "";
    backfillSpy.mockRestore();
    clearPlayUrlLines();
  });

  it("resolvePlayUrl（预解析）：引擎为空/抛错返回空串且不回填（无内置兜底）", async () => {
    const ipc = await import("@/services/ipc");
    const backfillSpy = vi.spyOn(ipc, "setResolvedPlayUrl").mockResolvedValue(undefined);
    const mod = await import("@/source-scripts");
    const track = {
      id: "1901371647",
      platform: "wyy" as const,
      title: "孤勇者",
      singer: "陈奕迅",
      album: "",
      picUrl: "",
      duration: 260,
      musicId: null,
    };
    engineMock.resolveUrl = "";
    await expect(mod.resolvePlayUrl(track, "128")).resolves.toBe("");
    engineMock.resolveThrows = true;
    await expect(mod.resolvePlayUrl(track, "128")).resolves.toBe("");
    expect(backfillSpy).not.toHaveBeenCalled();
    backfillSpy.mockRestore();
  });

  it("resolvePlayUrl（预解析）：失败死因记进面板，之后成功即清除", async () => {
    const { playUrlMiss, clearPlayUrlLines } = await import("@/source-scripts/playurl-line");
    const ipc = await import("@/services/ipc");
    const backfillSpy = vi.spyOn(ipc, "setResolvedPlayUrl").mockResolvedValue(undefined);
    const mod = await import("@/source-scripts");
    const track = {
      id: "000iBXhy1RQDgL",
      platform: "kg" as const,
      title: "微光",
      singer: "任歌飞",
      album: "",
      picUrl: "",
      duration: 161,
      musicId: null,
    };
    clearPlayUrlLines();
    engineMock.phase = "ready";
    // 失败：trace 落进「上次取链死因」（PC 上以前这条文本被引擎页吞掉）
    engineMock.resolveUrl = "";
    engineMock.resolveError = "kg@320 kg-yuxi=超时未返回; cross:kw=预算耗尽未跑";
    await expect(mod.resolvePlayUrl(track, "320")).resolves.toBe("");
    expect(playUrlMiss(track, "320")).toBe(
      "kg@320 kg-yuxi=超时未返回; cross:kw=预算耗尽未跑",
    );
    // 之后成功：旧死因不该继续挂着
    engineMock.resolveUrl = "http://t/ok.mp3";
    engineMock.resolveError = "";
    engineMock.resolveLine = { id: "kw-yuxi", name: "屿溪", kind: "lx" };
    await expect(mod.resolvePlayUrl(track, "320")).resolves.toBe("http://t/ok.mp3");
    expect(playUrlMiss(track, "320")).toBe("");
    engineMock.resolveLine = null;
    engineMock.resolveUrl = "";
    backfillSpy.mockRestore();
    clearPlayUrlLines();
  });

  it("resolvePlayUrl（预解析）：local 源直接报错不预取链", async () => {
    const ipc = await import("@/services/ipc");
    const backfillSpy = vi.spyOn(ipc, "setResolvedPlayUrl").mockResolvedValue(undefined);
    const mod = await import("@/source-scripts");
    const track = {
      id: "C:/music/a.flac",
      platform: "local" as const,
      title: "x",
      singer: "y",
      album: "",
      picUrl: "",
      duration: 0,
      musicId: null,
    };
    await expect(mod.resolvePlayUrl(track, "128")).rejects.toThrow(
      "local 源不支持该动作",
    );
    expect(backfillSpy).not.toHaveBeenCalled();
    backfillSpy.mockRestore();
  });
});
