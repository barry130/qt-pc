/**
 * 音源脚本包（source-scripts）全量测试。
 *
 * 1. 真实网络：Node fetch 实现契约 RequestBuiltin（对齐 Rust builtin_request：
 *    小写响应头、无视 content-type 直接尝试 JSON 解析），驱动脚本层四平台的
 *    搜索 / 推荐歌单 / 取链 / 歌词——独立于 Tauri 验证脚本逻辑本身。
 * 2. dispatcher：scheme=script 走脚本包聚合链、premium 只承载剩余线路、
 *    local 源在 script 模式下回落内置通道、resolvePlayUrl 回填命令被调用。
 * 3. 方案收敛：第三方线路按「音质高→低、每档 ≤5 条、末级跨源」收进默认
 *    ChainConfig（chain.json 驱动，见 chain-config.ts），放不下的剩余线路进 premium；
 *    插件层已取消，**方案只指定一个**（2026-09-18 起取消方案间换源顺序）：
 *    选中方案不支持该平台或自身链全灭时返回空串由引擎兜底，不再横向切到别的方案。
 * 4. chain.json（音源包热更新 P0）：parseChainConfig 校验、本地 overlay 回退、
 *    声明式 http 线路契约（a.aa.cab / tang.api 的请求形态与取值路径）、
 *    行级 platforms 过滤与 enabled 停用。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestBuiltin, SourceResponse } from "@/source-scripts/contract";
import { recommendations } from "@/source-scripts/actions/recommendations";
import { search } from "@/source-scripts/actions/aggregate";
import { resolvePlayUrl } from "@/source-scripts/actions/play-url";
import { resolvePlayUrlPremium } from "@/source-scripts/schemes/premium/play-url";
import {
  defaultChainConfig,
  parseChainConfig,
  PLATFORMS,
  type ChainLine,
  type HttpChainLine,
} from "@/source-scripts/chain-config";
import { runHttpLine } from "@/source-scripts/lines/declarative";
import { setChainConfigCache } from "@/source-scripts/chain-store";
import { filterChainLines as filterChainLinesImpl } from "@/source-scripts/actions/play-url";

/** 受控 host-request mock：vitest 会把文件内所有 vi.mock 提升到顶部，
 * 两个用例各自注册工厂会互相覆盖，因此统一为一个按状态切换的工厂 */
const hostRequestMock = vi.hoisted(() => ({
  active: false,
  impl: null as null | ((url: string) => unknown),
}));
vi.mock("@/source-scripts/host-request", () => ({
  hostRequest: async (url: string) => {
    if (hostRequestMock.active && hostRequestMock.impl !== null) {
      return hostRequestMock.impl(url);
    }
    throw new Error("hostRequest 在未配置 mock 的用例中被调用");
  },
}));

/** Node 版 request builtin：模拟 Rust builtin_request 的行为契约 */
const nodeRequest: RequestBuiltin = async (url, options) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 15000);
  try {
    const res = await fetch(url, {
      method: options?.method ?? "GET",
      headers: options?.headers,
      body: options?.body,
      signal: controller.signal,
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const text = await res.text();
    // 对齐 Rust builtin_request：不看 content-type 直接尝试解析
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    const response: SourceResponse = {
      statusCode: res.status,
      headers,
      body,
    };
    return response;
  } finally {
    clearTimeout(timer);
  }
};

/** 取链返回的 URL 做实际播放校验（Range + Content-Type） */
async function verifyAudio(url: string): Promise<boolean> {
  const res = await fetch(url, { headers: { Range: "bytes=0-1" } });
  const contentType = res.headers.get("content-type") || "";
  return res.status >= 200 && res.status < 400 && !/json|html|text\/plain/i.test(contentType);
}

describe("source-scripts 四平台真实网络", () => {
  const songs: Record<string, { id: string; name: string; singer: string }> = {
    wyy: { id: "1901371647", name: "孤勇者", singer: "陈奕迅" },
    kw: { id: "228908", name: "晴天", singer: "周杰伦" },
  };

  for (const source of ["wyy", "qq", "kw", "kg"] as const) {
    it(`${source}：搜索返回结果且字段完整`, { timeout: 30000 }, async () => {
      const list = await search(nodeRequest, source, "晴天 周杰伦", 1, 10);
      expect(list.length).toBeGreaterThan(0);
      const first = list[0]!;
      expect(first.id.length).toBeGreaterThan(0);
      expect(first.name.length).toBeGreaterThan(0);
      expect(first.singer.length).toBeGreaterThan(0);
      expect(first.interval).toBeGreaterThanOrEqual(0);
    });

    it(`${source}：推荐歌单返回且字段完整`, { timeout: 30000 }, async () => {
      const list = await recommendations(nodeRequest, source, null, 1);
      expect(list.length).toBeGreaterThan(0);
      const first = list[0]!;
      expect(first.platform).toBe(source);
      expect(first.id.length).toBeGreaterThan(0);
      expect(first.name.length).toBeGreaterThan(0);
    });
  }

  it("wyy：取链成功且 URL 实际可播放（免费歌）", { timeout: 45000 }, async () => {
    const url = await resolvePlayUrl(nodeRequest, "wyy", {
      id: songs.wyy.id,
      name: songs.wyy.name,
      singer: songs.wyy.singer,
      album: "",
      picUrl: "",
      interval: 0,
    }, "128");
    expect(url.length).toBeGreaterThan(0);
    expect(await verifyAudio(url)).toBe(true);
  });

  it("kw：聚合链取链成功且 URL 实际可播放（玉宁熙 Pro → 屿溪 → … → 官方 DES）", { timeout: 45000 }, async () => {
    const url = await resolvePlayUrl(nodeRequest, "kw", {
      id: songs.kw.id,
      name: songs.kw.name,
      singer: songs.kw.singer,
      album: "",
      picUrl: "",
      interval: 0,
    }, "128");
    expect(url.length).toBeGreaterThan(0);
    expect(await verifyAudio(url)).toBe(true);
  });

  it("kg：聚合链取链（屿溪/Stellarwave/墨澜/v6 → 失败跨源酷我/网易云兜底）", { timeout: 60000 }, async () => {
    const url = await resolvePlayUrl(nodeRequest, "kg", {
      // 真实酷狗 hash（蓝本酷狗新歌接口口径）
      id: "b3a52a7a958bf0aed0ebfba2e9a818b7",
      name: "晴天",
      singer: "周杰伦",
      album: "",
      picUrl: "",
      interval: 0,
    }, "128");
    expect(url.length).toBeGreaterThan(0);
    expect(await verifyAudio(url)).toBe(true);
  });

  it("wyy：歌词返回非空或空串（不抛错）", { timeout: 30000 }, async () => {
    const { getLyric } = await import("@/source-scripts/actions/lyric");
    const lyric = await getLyric(nodeRequest, "wyy", {
      id: songs.wyy.id,
      name: songs.wyy.name,
      singer: songs.wyy.singer,
      album: "",
      picUrl: "",
      interval: 0,
    });
    expect(typeof lyric.lyric).toBe("string");
    expect(typeof lyric.translation).toBe("string");
  });
});

describe("script 聚合链 / premium 剩余链真实网络", () => {
  const freeSong = { id: "003UkWuI0E8U0l", name: "孤勇者", singer: "陈奕迅", album: "孤勇者", picUrl: "", interval: 0 };

  it("tx：免费歌取链（a.aa.cab → Stellarwave → 玉宁熙 tang.api 兜底）", { timeout: 60000 }, async () => {
    const url = await resolvePlayUrl(nodeRequest, "qq", freeSong, "320");
    expect(url.length).toBeGreaterThan(0);
    expect(await verifyAudio(url)).toBe(true);
  });

  it("tx：VIP 歌 flac（a.aa.cab / Stellarwave 出 QQ VIP FLAC；失败则跨源酷我兜底）", { timeout: 90000 }, async () => {
    const url = await resolvePlayUrl(nodeRequest, "qq", {
      id: "0039MnYB0qdYPV", name: "晴天", singer: "周杰伦", album: "叶惠美", picUrl: "", interval: 0,
    }, "flac");
    expect(url.length).toBeGreaterThan(0);
    expect(await verifyAudio(url)).toBe(true);
  });

  it("tx：VIP 歌 tang.api 返回空 → vkey → 跨源兜底链", { timeout: 90000 }, async () => {
    // 晴天（QQ VIP）：tang.api 拿不到 → QQ vkey 大概率失败 → 跨源酷我/网易云
    const url = await resolvePlayUrl(nodeRequest, "qq", {
      id: "0039MnYB0qdYPV", name: "晴天", singer: "周杰伦", album: "叶惠美", picUrl: "", interval: 0,
    }, "128");
    expect(url.length).toBeGreaterThan(0);
    expect(await verifyAudio(url)).toBe(true);
  });

  it("premium kw：剩余链（墨澜 → 独家 v6 → 洛雪）", { timeout: 90000 }, async () => {
    const url = await resolvePlayUrlPremium(nodeRequest, "kw", {
      id: "228908", name: "晴天", singer: "周杰伦", album: "叶惠美", picUrl: "", interval: 0,
    }, "128");
    expect(url.length).toBeGreaterThan(0);
    expect(await verifyAudio(url)).toBe(true);
  });

  it("premium 未声明 wyy/qq：无剩余线路直接抛错（主力线路已并入脚本包）", async () => {
    await expect(
      resolvePlayUrlPremium(nodeRequest, "wyy", freeSong, "128"),
    ).rejects.toThrow("premium 无该平台剩余线路");
    await expect(
      resolvePlayUrlPremium(nodeRequest, "qq", freeSong, "128"),
    ).rejects.toThrow("premium 无该平台剩余线路");
  });
});

describe("声明式 http 线路（chain.json kind:http）+ script qq 链", () => {
  /** 记录调用的 stub request：按 URL 片段返回预设 body，未预设则抛错 */
  function stubRequest(routes: { match: string; body: unknown }[]): {
    request: RequestBuiltin;
    calls: string[];
  } {
    const calls: string[] = [];
    const request: RequestBuiltin = async (url) => {
      calls.push(url);
      const hit = routes.find((route) => url.includes(route.match));
      if (hit === undefined) throw new Error("未预设的请求: " + url);
      return { statusCode: 200, headers: {}, body: hit.body };
    };
    return { request, calls };
  }

  const song = {
    id: "003UkWuI0E8U0l",
    name: "孤勇者",
    singer: "陈奕迅",
    album: "孤勇者",
    picUrl: "",
    interval: 0,
  };

  /** 默认 chain 里按 line id 取声明式线路（远端 chain.json 与此同构） */
  async function httpLineById(id: string): Promise<HttpChainLine> {
    const line = (defaultChainConfig().chains.qq ?? []).find((l) => l.id === id);
    if (line === undefined || line.kind !== "http") {
      throw new Error(`默认 chain 缺少 http 线路 ${id}`);
    }
    return line;
  }

  it("a.aa.cab 请求形态：msg=歌名(URL编码)、n=1、type 按音质映射（128→0 / 320→1 / flac→4）", async () => {
    const line = await httpLineById("qq-world260809");
    for (const [quality, type] of [["128", "0"], ["320", "1"], ["flac", "4"]] as const) {
      const { request, calls } = stubRequest([
        { match: "a.aa.cab", body: { code: 0, data: { music: "http://t/" + quality + ".mp3" } } },
      ]);
      const url = await runHttpLine(line, request, song, quality);
      expect(url).toBe("http://t/" + quality + ".mp3");
      expect(calls[0]).toContain("msg=" + encodeURIComponent("孤勇者"));
      expect(calls[0]).toContain("n=1");
      expect(calls[0]).toContain("type=" + type);
    }
  });

  it("a.aa.cab：code 非 0（未搜索到相关内容）→ 空串，不重试不抛错", async () => {
    const line = await httpLineById("qq-world260809");
    const { request, calls } = stubRequest([
      { match: "a.aa.cab", body: { code: 1, msg: "未搜索到相关内容" } },
    ]);
    expect(await runHttpLine(line, request, song, "flac")).toBe("");
    expect(calls).toHaveLength(1);
  });

  it("a.aa.cab：请求抛错 → 按失败处理返回空串（交给下一级兜底）", async () => {
    const line = await httpLineById("qq-world260809");
    const request: RequestBuiltin = async () => {
      throw new Error("network down");
    };
    expect(await runHttpLine(line, request, song, "128")).toBe("");
  });

  it("模板含未知变量 → 空串且不发请求（坏模板按线路失败处理）", async () => {
    const line = await httpLineById("qq-world260809");
    const broken: HttpChainLine = {
      ...line,
      request: { ...line.request, url: "https://a.aa.cab/qq.music/{bogus}" },
    };
    const request = vi.fn();
    expect(await runHttpLine(broken, request, song, "128")).toBe("");
    expect(request).not.toHaveBeenCalled();
  });

  it("tang.api 请求形态：pre 打卡 + mid={id} + song_mid 非空 + 按音质 pick", async () => {
    const line = await httpLineById("qq-yuningxi-tang");
    const { request, calls } = stubRequest([
      { match: "97abc.com", body: {} },
      {
        match: "tang.api.s01s.cn",
        body: {
          song_mid: song.id,
          song_play_url_standard: "http://t/128.mp3",
          song_play_url: "http://t/320.mp3",
          song_play_url_sq: "http://t/flac.flac",
        },
      },
    ]);
    expect(await runHttpLine(line, request, song, "128")).toBe("http://t/128.mp3");
    expect(await runHttpLine(line, request, song, "320")).toBe("http://t/320.mp3");
    expect(await runHttpLine(line, request, song, "flac")).toBe("http://t/flac.flac");
    expect(calls.some((c) => c.includes("97abc.com"))).toBe(true);
    expect(calls.some((c) => c.includes("mid=" + encodeURIComponent(song.id)))).toBe(true);
  });

  it("tang.api：VIP 歌 song_mid 为空 → 空串（require nonEmpty 未命中）", async () => {
    const line = await httpLineById("qq-yuningxi-tang");
    const { request } = stubRequest([
      { match: "97abc.com", body: {} },
      { match: "tang.api.s01s.cn", body: { song_mid: null, song_play_url: null } },
    ]);
    expect(await runHttpLine(line, request, song, "320")).toBe("");
  });

  it("script qq：a.aa.cab 命中时直接用其地址，不再走玉宁熙", async () => {
    const { request, calls } = stubRequest([
      { match: "a.aa.cab", body: { code: 0, data: { music: "http://t/world.flac" } } },
      // 链路对每条线路的返回值都做 Range 预检，CDN 直链路由需返回可播响应
      { match: "t/world.flac", body: "" },
    ]);
    const url = await resolvePlayUrl(request, "qq", { ...song, id: "u-world-hit" }, "flac");
    expect(url).toBe("http://t/world.flac");
    expect(calls.some((item) => item.includes("tang.api.s01s.cn"))).toBe(false);
  });

  it("script qq：a.aa.cab 失败时兜底到玉宁熙 tang.api", async () => {
    const { request } = stubRequest([
      { match: "a.aa.cab", body: { code: 1 } },
      { match: "97abc.com", body: {} },
      {
        match: "tang.api.s01s.cn",
        body: { song_mid: "003UkWuI0E8U0l", song_play_url_standard: "http://t/tang.mp3" },
      },
      // tang.api 命中后同样要过 Range 预检
      { match: "t/tang.mp3", body: "" },
    ]);
    const url = await resolvePlayUrl(request, "qq", { ...song, id: "u-world-miss" }, "128");
    expect(url).toBe("http://t/tang.mp3");
  });

  it("方案收敛：默认 ChainConfig 锁定链路组成 + premium 剩余链 + 插件层取消", async () => {
    const registry = await import("@/source-scripts/schemes/registry");
    const { PREMIUM_LINES } = await import("@/source-scripts/schemes/premium/play-url");
    const cfg = defaultChainConfig();

    // 可选方案清单 = 脚本包 + premium，二者都只有单一选择（无换源顺序）
    expect(registry.listSchemes().map((scheme) => scheme.id)).toEqual(["script", "premium"]);
    expect(registry.isKnownSchemeId("script")).toBe(true);
    expect(registry.isKnownSchemeId("premium")).toBe(true);
    // 插件层已取消：第三方线路去重后整体并入脚本包/premium
    for (const id of [
      "yuningxi-pro", "yuxi", "stellarwave", "molan", "luoxue", "gdstudio",
      "quandouyao", "lx-v6", "world260809", "kulou", "suyin", "yuningxi", "shouji",
    ]) {
      expect(registry.getRegisteredScheme(id), `已并入/未建方案 ${id}`).toBeUndefined();
    }
    // premium 只剩 kw/kg 剩余链，不声明 wyy/qq
    const premium = registry.getRegisteredScheme("premium");
    expect(premium).toBeDefined();
    expect(registry.getPlayUrlHandler(premium!, "wyy")).toBeUndefined();
    expect(registry.getPlayUrlHandler(premium!, "qq")).toBeUndefined();
    expect(typeof registry.getPlayUrlHandler(premium!, "kw")).toBe("function");
    expect(typeof registry.getPlayUrlHandler(premium!, "kg")).toBe("function");

    // premium 剩余链组成（音质高→低，不跨源）
    expect(PREMIUM_LINES.kw!.map((line) => line.name)).toEqual(["墨澜", "独家音源 v6", "洛雪 v2-fix"]);
    expect(PREMIUM_LINES.kg!.map((line) => line.name)).toEqual(["酷狗官方（上游失效占位）"]);

    // 默认 chain 组成（id 锁定；远端 chain.json 以此为锚点做差异）
    expect(cfg.maxLinesPerQuality).toBe(5);
    expect(cfg.budget).toEqual({ totalMs: 12000, lineMs: 6000 });
    expect(cfg.crossSources).toEqual({
      wyy: ["kw"], kw: ["wyy"], qq: ["kw", "wyy"], kg: ["kw", "wyy"],
    });
    expect(cfg.chains.wyy!.map((line) => line.id)).toEqual(["wyy-core"]);
    expect(cfg.chains.qq!.map((line) => line.id)).toEqual([
      "qq-world260809", "qq-stellarwave-tx", "qq-yuningxi-tang", "qq-native-vkey",
    ]);
    expect(cfg.chains.kw!.map((line) => line.id)).toEqual([
      "kw-yuningxi-pro", "kw-yuxi", "kw-stellarwave", "kw-quandouyao", "kw-native-des",
    ]);
    expect(cfg.chains.kg!.map((line) => line.id)).toEqual([
      "kg-yuxi", "kg-stellarwave", "kg-molan", "kg-lxv6", "kg-yuningxi-pro",
    ]);
    // kg 末位玉宁熙 Pro 只实测过 flac；QQ 原生 vkey 只有 128 且仅 Windows 参与
    const kgLast = cfg.chains.kg![cfg.chains.kg!.length - 1]!;
    expect(kgLast.qualities).toEqual(["flac"]);
    const qqLast = cfg.chains.qq![cfg.chains.qq!.length - 1]!;
    expect(qqLast.qualities).toEqual(["128"]);
    expect(qqLast.platforms).toEqual([PLATFORMS.WINDOWS]);
    // 每音质档参与换源的线路 ≤上限（全灭耗时上限）
    for (const lines of Object.values(cfg.chains)) {
      for (const quality of ["128", "320", "flac"] as const) {
        expect(lines!.filter((line) => line.qualities.includes(quality)).length)
          .toBeLessThanOrEqual(cfg.maxLinesPerQuality);
      }
    }
    // 默认配置自身必须通过 schema 校验（与远端 chain.json 同一把关）
    expect(parseChainConfig(JSON.parse(JSON.stringify(cfg)))).toEqual(cfg);
    // lx 线路的 scriptId 都能解析到实际宿主
    const { getLxHost } = await import("@/source-scripts/schemes/lx-host/sources");
    for (const lines of Object.values(cfg.chains)) {
      for (const line of lines!) {
        if (line.kind === "lx") {
          expect(getLxHost(line.scriptId), `宿主存在: ${line.scriptId}`).not.toBeNull();
        }
      }
    }
  });

  it("lxPlayUrlSet：handler 返回值原样透传，空串按失败抛错（纯桩）", async () => {
    const { lxPlayUrlSet } = await import("@/source-scripts/schemes/lx-host/sources");
    const getUrl = vi.fn().mockResolvedValueOnce("http://x/a.mp3").mockResolvedValueOnce("");
    const fakeHost = { getUrl } as unknown as Parameters<typeof lxPlayUrlSet>[0];
    const set = lxPlayUrlSet(fakeHost, "测试源", ["kw", "kg"]);
    const request = vi.fn();
    await expect(set.kw!(request, song, "128")).resolves.toBe("http://x/a.mp3");
    await expect(set.kg!(request, song, "128")).rejects.toThrow("测试源 kg 线路未取到播放地址");
  });

  it("全豆要 kw 免请求直出链（长青 SVIP 模板）：请求桩全灭仍返回 haitangw URL（契约锁定，脚本更新后需复核）", { timeout: 30000 }, async () => {
    // 注意：kw 链首位玉宁熙 Pro 的 kw 线路同样是免请求直出链
    // （175.27.166.236:8928/kwstream），全灭 mock 下轮不到全豆要，
    // 因此契约直接锁定全豆要宿主本体。
    const { lxPlayUrl, quandouyaoHost } = await import("@/source-scripts/schemes/lx-host/sources");
    const request = vi.fn().mockRejectedValue(new Error("mock 线路不可用"));
    const url = await lxPlayUrl(quandouyaoHost, request, "kw", { ...song, id: "kw-1" }, "128");
    expect(url).toContain("haitangw.net");
  });

  it("a.aa.cab 真实网络（声明式线路）：命中则 URL 可播（约六成成功率，返回空串也是合法结果）", { timeout: 60000 }, async () => {
    const line = await httpLineById("qq-world260809");
    const url = await runHttpLine(line, nodeRequest, song, "flac");
    if (url.length > 0) {
      expect(url).toContain("qqmusic.qq.com");
      expect(await verifyAudio(url)).toBe(true);
    }
  });
});

describe("chain.json 校验（parseChainConfig：热更新三层把关的第①层）", () => {
  function minimal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      chainRevision: 1,
      maxLinesPerQuality: 5,
      crossSources: {},
      budget: { totalMs: 1000, lineMs: 500 },
      chains: {},
      ...overrides,
    };
  }

  it("chain-store：无 overlay（Node 无 Tauri IPC）回退内置默认", async () => {
    const { getChainConfig } = await import("@/source-scripts/chain-store");
    expect(await getChainConfig()).toEqual(defaultChainConfig());
  });

  it("非法字段逐项拒绝（任一字段坏 → 整份配置丢弃回退）", async () => {
    expect(parseChainConfig(minimal())).toBeDefined();
    expect(() => parseChainConfig(minimal({ chainRevision: -1 }))).toThrow("chainRevision");
    expect(() => parseChainConfig(minimal({ maxLinesPerQuality: 0 }))).toThrow("maxLinesPerQuality");
    expect(() => parseChainConfig(minimal({ budget: { totalMs: 0, lineMs: 500 } }))).toThrow("budget");
    expect(() => parseChainConfig(minimal({ crossSources: { qq: "kw" } }))).toThrow("数组");
    expect(() => parseChainConfig(minimal({ crossSources: { qq: ["kg"] } }))).toThrow("kw/wyy");
    expect(() =>
      parseChainConfig(minimal({ chains: { kw: [{ id: "x", name: "x", kind: "magic", qualities: ["128"] }] } })),
    ).toThrow("kind");
    expect(() =>
      parseChainConfig(minimal({ chains: { kw: [{ id: "x", name: "x", kind: "lx", scriptId: "s", qualities: ["hifi"] }] } })),
    ).toThrow("qualities");
    expect(() =>
      parseChainConfig(minimal({ chains: { kw: [{ id: "x", name: "x", kind: "lx", scriptId: "s", qualities: ["128"], platforms: [9999] }] } })),
    ).toThrow("platforms");
    expect(() =>
      parseChainConfig(minimal({ chains: { qq: [{ id: "x", name: "x", kind: "http", qualities: ["128"], request: {}, pick: "u" }] } })),
    ).toThrow("request.url");
    expect(() =>
      parseChainConfig(minimal({ chains: { qq: [{ id: "x", name: "x", kind: "http", qualities: ["128"], request: { url: "https://x/" } }] } })),
    ).toThrow("pick");
    expect(() =>
      parseChainConfig(minimal({ chains: { qq: [{ id: "x", name: "x", kind: "http", qualities: ["128"], request: { url: "https://x/" }, pick: { hifi: "u" } }] } })),
    ).toThrow("pick");
  });
});

describe("chain 行级 platforms 过滤与 enabled 停用（P0）", () => {
  const song = {
    id: "u-pf",
    name: "孤勇者",
    singer: "陈奕迅",
    album: "",
    picUrl: "",
    interval: 0,
  };

  afterEach(async () => {
    setChainConfigCache(null);
  });

  it("filterChainLines：platforms 缺省 = 全平台参与，enabled:false 停用", () => {
    const lines: ChainLine[] = [
      { id: "a", name: "a", kind: "http", qualities: ["128"], request: { url: "https://a/" }, pick: "u" },
      { id: "b", name: "b", kind: "http", qualities: ["128"], platforms: [PLATFORMS.WINDOWS], request: { url: "https://b/" }, pick: "u" },
      { id: "c", name: "c", kind: "http", qualities: ["128"], enabled: false, request: { url: "https://c/" }, pick: "u" },
    ];
    expect(filterChainLinesImpl(lines, PLATFORMS.WINDOWS).map((line) => line.id)).toEqual(["a", "b"]);
    expect(filterChainLinesImpl(lines, PLATFORMS.ANDROID).map((line) => line.id)).toEqual(["a"]);
  });

  it("platforms:[1102] 的线路在 Windows(1103) 被跳过、在 iOS(1102) 参与（端到端）", async () => {
    const { resolvePlayUrlWithBudget } = await import("@/source-scripts/actions/play-url");
    const { ChainBudget } = await import("@/source-scripts/budget");
    setChainConfigCache({
      chainRevision: 99,
      maxLinesPerQuality: 5,
      crossSources: { qq: [] },
      budget: { totalMs: 5000, lineMs: 2000 },
      chains: {
        qq: [
          {
            id: "ios-only", name: "iOS 专属", kind: "http", qualities: ["128"], platforms: [PLATFORMS.IOS],
            request: { url: "https://ios.example/u", query: { q: "{id}" } }, pick: "u",
          },
          {
            id: "any", name: "全平台", kind: "http", qualities: ["128"],
            request: { url: "https://any.example/u", query: { q: "{id}" } }, pick: "u",
          },
        ],
      },
    });
    const request: RequestBuiltin = async (url) => ({
      statusCode: 200,
      headers: {},
      body: { u: "http://t/" + (url.includes("ios.example") ? "ios.mp3" : "any.mp3") },
    });
    // Windows：iOS 专属线被行级过滤，命中全平台线
    const win = await resolvePlayUrlWithBudget(
      request, "qq", { ...song, id: "u-win" }, "128", new ChainBudget(5000, 2000),
    );
    expect(win).toBe("http://t/any.mp3");
    // iOS：命中 iOS 专属线
    const ios = await resolvePlayUrlWithBudget(
      request, "qq", { ...song, id: "u-ios" }, "128", new ChainBudget(5000, 2000), PLATFORMS.IOS,
    );
    expect(ios).toBe("http://t/ios.mp3");
  });

  it("enabled:false 停用线路（停死线只改 chain.json，不发包）", async () => {
    const { resolvePlayUrlWithBudget } = await import("@/source-scripts/actions/play-url");
    const { ChainBudget } = await import("@/source-scripts/budget");
    setChainConfigCache({
      chainRevision: 99,
      maxLinesPerQuality: 5,
      crossSources: { qq: [] },
      budget: { totalMs: 5000, lineMs: 2000 },
      chains: {
        qq: [
          {
            id: "dead", name: "死线", kind: "http", qualities: ["128"], enabled: false,
            request: { url: "https://dead.example/u" }, pick: "u",
          },
          {
            id: "alive", name: "活线", kind: "http", qualities: ["128"],
            request: { url: "https://alive.example/u" }, pick: "u",
          },
        ],
      },
    });
    const calls: string[] = [];
    const request: RequestBuiltin = async (url) => {
      calls.push(url);
      return { statusCode: 200, headers: {}, body: { u: "http://t/alive.mp3" } };
    };
    const url = await resolvePlayUrlWithBudget(
      request, "qq", { ...song, id: "u-enabled" }, "128", new ChainBudget(5000, 2000),
    );
    expect(url).toBe("http://t/alive.mp3");
    expect(calls.some((c) => c.includes("dead.example"))).toBe(false);
  });
});

describe("source-scripts dispatcher（scheme 分发）", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    hostRequestMock.active = false;
    hostRequestMock.impl = null;
  });

  it("script 方案：wyy 走脚本包并映射为 App Playlist 模型", async () => {
    hostRequestMock.active = true;
    hostRequestMock.impl = () => ({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: {
        playlists: [
          {
            id: 12345,
            name: "脚本通道歌单",
            coverImgUrl: "https://p1.music.126.net/x.jpg",
            playCount: 999,
          },
        ],
      },
    });
    const schemeMod = await import("@/source-scripts/scheme");
    schemeMod.setScheme("script");
    const mod = await import("@/source-scripts");
    const result = await mod.getRecommendations("wyy", null, 1);
    expect(result[0]?.id).toBe("12345");
    expect(result[0]?.name).toBe("脚本通道歌单");
    expect(result[0]?.platform).toBe("wyy");
    expect(result[0]?.description).toBeNull();
  });

  it("local 源：第三方动作直接报错（本地路径由页面单独路由）", async () => {
    const schemeMod = await import("@/source-scripts/scheme");
    schemeMod.setScheme("script");
    const mod = await import("@/source-scripts");
    await expect(mod.getRecommendations("local", null, 1)).rejects.toThrow(
      "local 源不支持该动作",
    );
    await expect(mod.getPlaylistDetail("local", "1", 1, 30)).rejects.toThrow(
      "local 源不支持该动作",
    );
  });

  it("resolvePlayUrl（预解析）：script 模式解析成功后回填引擎缓存", async () => {
    hostRequestMock.active = true;
    hostRequestMock.impl = (url: string) => {
      // gdstudio 代理路径：直接返回可用 URL
      if (String(url).includes("gdstudio")) {
        return {
          statusCode: 200,
          headers: {},
          body: { url: "http://dl.music.example/song.mp3" },
        };
      }
      return {
        statusCode: 200,
        headers: {},
        body: {},
      };
    };
    const ipc = await import("@/services/ipc");
    const backfillSpy = vi.spyOn(ipc, "setResolvedPlayUrl").mockResolvedValue(undefined);
    const schemeMod = await import("@/source-scripts/scheme");
    schemeMod.setScheme("script");
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

  it("resolvePlayUrl（预解析）：local 源直接报错不预取链", async () => {
    const ipc = await import("@/services/ipc");
    const backfillSpy = vi.spyOn(ipc, "setResolvedPlayUrl").mockResolvedValue(undefined);
    const schemeMod = await import("@/source-scripts/scheme");
    schemeMod.setScheme("script");
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
describe("音源方案指定（单一选择，无方案间优先级）", () => {
  const TEST_IDS = ["t-wyy-only", "t-kw-a", "t-kw-b", "t-fail"];

  /** 注意：前面的 describe afterEach 里有 vi.resetModules()，会把模块注册表
   *  清空重评估——本组测试必须全部用例内动态 import，保证与 dispatcher
   *  （动态 import("@/source-scripts")）拿到同一个模块实例。 */

  const kwTrack = {
    id: "1",
    platform: "kw" as const,
    title: "x",
    singer: "y",
    album: "",
    picUrl: "",
    duration: 0,
    musicId: null,
  };

  afterEach(async () => {
    // 动态 import：与用例内注册的是同一个（未被重置的）模块实例
    const registry = await import("@/source-scripts/schemes/registry");
    const schemeMod = await import("@/source-scripts/scheme");
    for (const id of TEST_IDS) registry.unregisterScheme(id);
    schemeMod.setScheme("script");
    hostRequestMock.active = false;
    hostRequestMock.impl = null;
  });

  it("指定方案：只走选中的方案，注册表里其他方案不参与", async () => {
    const registry = await import("@/source-scripts/schemes/registry");
    registry.registerScheme({
      id: "t-wyy-only",
      name: "仅网易云",
      playUrl: { wyy: async () => "http://t/wyy.mp3" },
    });
    registry.registerScheme({
      id: "t-kw-a",
      name: "源A",
      playUrl: { kw: async () => "http://t/a.mp3" },
    });
    const schemeMod = await import("@/source-scripts/scheme");
    schemeMod.setScheme("t-kw-a");
    const ipc = await import("@/services/ipc");
    const backfillSpy = vi.spyOn(ipc, "setResolvedPlayUrl").mockResolvedValue(undefined);
    const mod = await import("@/source-scripts");
    const url = await mod.resolvePlayUrl(kwTrack, "128");
    expect(url).toBe("http://t/a.mp3");
    expect(backfillSpy).toHaveBeenCalledWith(kwTrack, "128", "http://t/a.mp3");
    backfillSpy.mockRestore();
  });

  it("指定方案不支持该平台：返回空串，不再横向换源到别的方案", async () => {
    const registry = await import("@/source-scripts/schemes/registry");
    registry.registerScheme({
      id: "t-wyy-only",
      name: "仅网易云",
      playUrl: { wyy: async () => "http://t/wyy.mp3" },
    });
    registry.registerScheme({
      id: "t-kw-a",
      name: "源A",
      playUrl: { kw: async () => "http://t/a.mp3" },
    });
    const schemeMod = await import("@/source-scripts/scheme");
    schemeMod.setScheme("t-wyy-only");
    const ipc = await import("@/services/ipc");
    const backfillSpy = vi.spyOn(ipc, "setResolvedPlayUrl").mockResolvedValue(undefined);
    const mod = await import("@/source-scripts");
    const url = await mod.resolvePlayUrl(kwTrack, "128");
    expect(url).toBe("");
    expect(backfillSpy).not.toHaveBeenCalled();
    backfillSpy.mockRestore();
  });

  it("指定方案自身取链失败：返回空串，不再落到其他方案", async () => {
    const registry = await import("@/source-scripts/schemes/registry");
    registry.registerScheme({
      id: "t-fail",
      name: "失败源",
      playUrl: {
        kw: async () => {
          throw new Error("线路不可用");
        },
      },
    });
    registry.registerScheme({
      id: "t-kw-a",
      name: "源A",
      playUrl: { kw: async () => "http://t/a.mp3" },
    });
    const schemeMod = await import("@/source-scripts/scheme");
    schemeMod.setScheme("t-fail");
    const ipc = await import("@/services/ipc");
    const backfillSpy = vi.spyOn(ipc, "setResolvedPlayUrl").mockResolvedValue(undefined);
    const mod = await import("@/source-scripts");
    const url = await mod.resolvePlayUrl(kwTrack, "128");
    expect(url).toBe("");
    backfillSpy.mockRestore();
  });

  it("切换指定方案后下一次取址走新方案", async () => {
    const registry = await import("@/source-scripts/schemes/registry");
    registry.registerScheme({
      id: "t-kw-a",
      name: "源A",
      playUrl: { kw: async () => "http://t/a.mp3" },
    });
    registry.registerScheme({
      id: "t-kw-b",
      name: "源B",
      playUrl: { kw: async () => "http://t/b.mp3" },
    });
    const schemeMod = await import("@/source-scripts/scheme");
    const ipc = await import("@/services/ipc");
    const backfillSpy = vi.spyOn(ipc, "setResolvedPlayUrl").mockResolvedValue(undefined);
    const mod = await import("@/source-scripts");
    schemeMod.setScheme("t-kw-a");
    await expect(mod.resolvePlayUrl(kwTrack, "128")).resolves.toBe("http://t/a.mp3");
    schemeMod.setScheme("t-kw-b");
    await expect(mod.resolvePlayUrl(kwTrack, "128")).resolves.toBe("http://t/b.mp3");
    backfillSpy.mockRestore();
  });

  it("方案内全灭：返回空串由引擎兜底（真实脚本包 qq 链 + 跨源全失败）", async () => {
    const schemeMod = await import("@/source-scripts/scheme");
    schemeMod.setScheme("script");
    // 用 qq 曲目：脚本包 qq 链与跨源兜底全部是请求型线路，全灭 mock 下必失败
    hostRequestMock.active = true;
    hostRequestMock.impl = () => {
      throw new Error("mock 线路不可用");
    };
    const qqTrack = { ...kwTrack, platform: "qq" as const };
    const ipc = await import("@/services/ipc");
    const backfillSpy = vi.spyOn(ipc, "setResolvedPlayUrl").mockResolvedValue(undefined);
    const mod = await import("@/source-scripts");
    const url = await mod.resolvePlayUrl(qqTrack, "128");
    expect(url).toBe("");
    expect(backfillSpy).not.toHaveBeenCalled();
    backfillSpy.mockRestore();
  });
});

/**
 * 取链预算（budget.ts）：引擎问前端取链只等 15s（playurl_bridge.rs
 * ASK_TIMEOUT），挂死的线路必须被切断，否则整首歌被判「无可用播放地址」。
 * 2026-09-18 线上事故：gdstudio 上游挂死（连接挂 ~20s 才回 522）把 wyy 核心
 * 线与跨源链全部拖过预算，25 次引擎取链连续超时。
 */
describe("取链预算（挂死线路不拖垮整链）", () => {
  /** 桩：hang=true 的路由永不 resolve，模拟挂死的第三方线路 */
  function budgetStub(routes: { match: string; body?: unknown; hang?: boolean }[]): RequestBuiltin {
    return async (url) => {
      const hit = routes.find((route) => url.includes(route.match));
      if (hit === undefined) throw new Error("未预设的请求: " + url);
      if (hit.hang === true) return new Promise<never>(() => {});
      return { statusCode: 200, headers: {}, body: hit.body };
    };
  }

  const song = {
    id: "003UkWuI0E8U0l",
    name: "孤勇者",
    singer: "陈奕迅",
    album: "孤勇者",
    picUrl: "",
    interval: 0,
  };

  it("ChainBudget：work 快于分片时取结果，慢于分片时取 fallback", async () => {
    const { ChainBudget } = await import("@/source-scripts/budget");
    const budget = new ChainBudget(5000, 100);
    expect(await budget.run(Promise.resolve("ok"), "")).toBe("ok");
    expect(await budget.run(new Promise<never>(() => {}), "")).toBe("");
    // work 抛错与超时同义：都按 fallback 处理，继续下一条线路
    expect(await budget.run(Promise.reject(new Error("boom")), "")).toBe("");
  });

  it("ChainBudget：分片取「单线路上限」与「剩余总预算」的较小值，耗尽后 expired", async () => {
    const { ChainBudget } = await import("@/source-scripts/budget");
    const budget = new ChainBudget(300, 1000);
    expect(budget.sliceMs()).toBe(300);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(budget.expired).toBe(true);
    expect(budget.sliceMs()).toBeLessThanOrEqual(0);
  });

  it("挂死的首条线路被分片切断，后续线路照常取到地址（qq 链 128 档）", async () => {
    const { resolvePlayUrlWithBudget } = await import("@/source-scripts/actions/play-url");
    const { ChainBudget } = await import("@/source-scripts/budget");
    const request = budgetStub([
      { match: "a.aa.cab", hang: true },
      { match: "97abc.com", body: {} },
      {
        match: "tang.api.s01s.cn",
        body: { song_mid: "u-budget-hit", song_play_url_standard: "http://t/tang.mp3" },
      },
      { match: "t/tang.mp3", body: "" },
    ]);
    const startedAt = Date.now();
    const url = await resolvePlayUrlWithBudget(
      request,
      "qq",
      { ...song, id: "u-budget-hit" },
      "128",
      new ChainBudget(3000, 200),
    );
    expect(url).toBe("http://t/tang.mp3");
    // 首线挂死只吃掉分片（200ms），不会独占整链
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });

  it("全链挂死：总预算内抛错收场（不无限等，也不越过引擎 15s 预算）", async () => {
    const { resolvePlayUrlWithBudget } = await import("@/source-scripts/actions/play-url");
    const { ChainBudget } = await import("@/source-scripts/budget");
    const request = budgetStub([
      { match: "a.aa.cab", hang: true },
      { match: "tang.api.s01s.cn", hang: true },
      { match: "u.qq.com", hang: true },
      { match: "97abc.com", hang: true },
      { match: "c.y.qq.com", hang: true },
    ]);
    const startedAt = Date.now();
    await expect(
      resolvePlayUrlWithBudget(
        request,
        "qq",
        { ...song, id: "u-budget-dead" },
        "128",
        new ChainBudget(600, 150),
      ),
    ).rejects.toThrow("该歌曲暂时无法播放");
    const elapsed = Date.now() - startedAt;
    // 总预算 600ms：分片 150ms × 线路数后即过期，跨源不再起跑
    expect(elapsed).toBeLessThan(1500);
  });

  it("wyy 官方核心：gdstudio 代理带短超时，挂死后官方接口仍能出链", async () => {
    const { wyy } = await import("@/source-scripts/platforms/wyy");
    const timeouts: Array<number | undefined> = [];
    const request: RequestBuiltin = async (url, options) => {
      if (url.includes("gdstudio")) {
        timeouts.push(options?.timeoutMs);
        throw new Error("gdstudio 挂死");
      }
      return {
        statusCode: 200,
        headers: {},
        body: { data: [{ url: "http://t/wyy-core.mp3" }] },
      };
    };
    expect(await wyy.musicUrlCore(request, song, "128")).toBe("http://t/wyy-core.mp3");
    // 上限必须远小于引擎 15s 取链预算（实测挂死 20s 才回 522）
    expect(timeouts[0]).toBeGreaterThan(0);
    expect(timeouts[0]).toBeLessThanOrEqual(5000);
  });
});
