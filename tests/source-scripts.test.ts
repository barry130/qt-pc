/**
 * 音源脚本包（source-scripts）试点测试。
 *
 * 1. 真实网络：用 Node fetch 实现契约 RequestBuiltin（行为对齐 Rust
 *    builtin_request：小写响应头、JSON body 已解析），直接驱动脚本层
 *    recommendations 的 wyy/qq/kg 分支 —— 独立于 Tauri 验证脚本逻辑本身。
 * 2. dispatcher：验证 scheme=rust 走内置通道、scheme=script 走脚本包、
 *    未迁移平台（kw）自动回落内置通道。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestBuiltin, SourceResponse } from "@/source-scripts/contract";
import { recommendations } from "@/source-scripts/actions/recommendations";

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

describe("source-scripts recommendations（真实网络）", () => {
  it("wyy：返回网易推荐歌单且字段完整", { timeout: 30000 }, async () => {
    const list = await recommendations(nodeRequest, "wyy", null, 1);
    expect(list.length).toBeGreaterThan(0);
    const first = list[0]!;
    expect(first.platform).toBe("wyy");
    expect(first.id.length).toBeGreaterThan(0);
    expect(first.name.length).toBeGreaterThan(0);
    expect(first.picUrl.startsWith("http")).toBe(true);
    expect(typeof first.playCount).toBe("string");
  });

  it("qq：返回 QQ 推荐歌单且字段完整", { timeout: 30000 }, async () => {
    const list = await recommendations(nodeRequest, "qq", null, 1);
    expect(list.length).toBeGreaterThan(0);
    const first = list[0]!;
    expect(first.platform).toBe("qq");
    expect(first.id.length).toBeGreaterThan(0);
    expect(first.name.length).toBeGreaterThan(0);
  });

  it("kg：返回酷狗推荐歌单且封面已规范化（https / {size} 已替换）", {
    timeout: 30000,
  }, async () => {
    const list = await recommendations(nodeRequest, "kg", null, 1);
    expect(list.length).toBeGreaterThan(0);
    const first = list[0]!;
    expect(first.platform).toBe("kg");
    expect(first.id.length).toBeGreaterThan(0);
    expect(first.name.length).toBeGreaterThan(0);
    expect(first.picUrl).not.toContain("{size}");
    expect(first.picUrl).not.toContain("http://");
  });

  it("kw：试点未迁移，应显式抛错（由 dispatcher 回落 Rust 通道）", async () => {
    await expect(recommendations(nodeRequest, "kw", null, 1)).rejects.toThrow(
      /not supported/,
    );
  });
});

describe("source-scripts dispatcher（scheme 分发）", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function loadDispatcher(scheme: "rust" | "script") {
    const schemeMod = await import("@/source-scripts/scheme");
    schemeMod.setScheme(scheme);
    return import("@/source-scripts");
  }

  it("scheme=rust：走内置 ipc 通道", async () => {
    const ipc = await import("@/services/ipc");
    const rustSpy = vi
      .spyOn(ipc, "getRecommendations")
      .mockResolvedValue([
        {
          id: "1",
          platform: "wyy",
          name: "内置通道歌单",
          picUrl: "https://example.com/x.jpg",
          playCount: "123",
          description: null,
        },
      ]);
    const { setScheme } = await import("@/source-scripts/scheme");
    setScheme("rust");
    const mod = await import("@/source-scripts");
    const result = await mod.getRecommendations("wyy", null, 1);
    expect(rustSpy).toHaveBeenCalledWith("wyy", null, 1);
    expect(result[0]?.name).toBe("内置通道歌单");
    rustSpy.mockRestore();
  });

  it("scheme=script：wyy 走脚本包并映射为 App Playlist 模型", async () => {
    vi.mock("@/source-scripts/host-request", () => ({
      hostRequest: async () => ({
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
      }),
    }));
    const ipc = await import("@/services/ipc");
    const rustSpy = vi.spyOn(ipc, "getRecommendations").mockResolvedValue([]);
    const mod = await loadDispatcher("script");
    const result = await mod.getRecommendations("wyy", null, 1);
    expect(rustSpy).not.toHaveBeenCalled();
    expect(result[0]?.id).toBe("12345");
    expect(result[0]?.name).toBe("脚本通道歌单");
    expect(result[0]?.platform).toBe("wyy");
    expect(result[0]?.description).toBeNull();
    rustSpy.mockRestore();
    vi.doUnmock("@/source-scripts/host-request");
  });

  it("scheme=script：kw 未迁移自动回落内置通道", async () => {
    const ipc = await import("@/services/ipc");
    const rustSpy = vi
      .spyOn(ipc, "getRecommendations")
      .mockResolvedValue([
        {
          id: "9",
          platform: "kw",
          name: "kw 兜底歌单",
          picUrl: "",
          playCount: "0",
          description: null,
        },
      ]);
    const mod = await loadDispatcher("script");
    const result = await mod.getRecommendations("kw", null, 1);
    expect(rustSpy).toHaveBeenCalledWith("kw", null, 1);
    expect(result[0]?.name).toBe("kw 兜底歌单");
    rustSpy.mockRestore();
  });
});
