/**
 * 音源账号网页登录流程（src/lib/source-web-login.ts）单测。
 * 依赖全部注入 mock，不触 ipc/引擎；计时用真实定时器 + 毫秒级小间隔。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 顶层 import 的三个依赖模块按仓库测试惯例 mock 掉（全注入时不触默认实现）
vi.mock("@/services/ipc", () => ({ sourceWebLoginOpen: vi.fn(), sourceWebLoginCapture: vi.fn(), sourceWebLoginClose: vi.fn() }));
vi.mock("@/source-scripts", () => ({ authImportCookie: vi.fn() }));
vi.mock("@/lib/source-auth", () => ({ saveSourceAuthAccount: vi.fn() }));

import { mergeCookies, runWebLoginFlow } from "@/lib/source-web-login";

const WEBLOGIN = {
  url: "https://y.qq.com/n/ryqq/login",
  cookieMarkers: ["qm_keyst="],
  note: "用 QQ 扫码登录",
};

/** 组装一套可断言的依赖桩 */
function makeDeps() {
  return {
    openWindow: vi.fn().mockResolvedValue(undefined),
    capture: vi.fn().mockResolvedValue({ closed: false, chunks: [] }),
    validateImport: vi.fn().mockResolvedValue({ ok: false, user: null }),
    save: vi.fn().mockResolvedValue(undefined),
    closeWindow: vi.fn().mockResolvedValue(undefined),
  };
}

describe("mergeCookies", () => {
  it("合并各 URL 的 Cookie 并按 name 去重（先到先得）", () => {
    expect(
      mergeCookies([
        "uin=o123; qm_keyst=AAA",
        "qm_keyst=BBB; t=1", // qm_keyst 已见过，保留 AAA
        "invalid-no-eq; =novalue; valid=x",
      ]),
    ).toBe("uin=o123; qm_keyst=AAA; t=1; valid=x");
  });
});

describe("runWebLoginFlow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("marker 命中 → 校验通过 → 保存 → 关窗，返回 ok", async () => {
    const deps = makeDeps();
    deps.capture.mockResolvedValue({ closed: false, chunks: ["uin=o123; qm_keyst=AAA"] });
    deps.validateImport.mockResolvedValue({ ok: true, user: { id: "u1", nickname: "小明", avatar: "", vip: true, vipLabel: "豪华VIP" } });

    const outcome = await runWebLoginFlow(
      { source: "qq", webLogin: WEBLOGIN, domains: ["y.qq.com"] },
      { ...deps, intervalMs: 1, timeoutMs: 1000 },
    );

    expect(outcome).toBe("ok");
    expect(deps.openWindow).toHaveBeenCalledWith(WEBLOGIN.url);
    // WEBLOGIN 未声明 captureUrls：正确回退按 domains 拼 https://{domain}/
    expect(deps.capture).toHaveBeenCalledWith(["https://y.qq.com/"]);
    expect(deps.validateImport).toHaveBeenCalledWith("qq", "uin=o123; qm_keyst=AAA");
    expect(deps.save).toHaveBeenCalledTimes(1);
    expect(deps.save).toHaveBeenCalledWith("qq", "uin=o123; qm_keyst=AAA", expect.objectContaining({ id: "u1" }));
    expect(deps.closeWindow).toHaveBeenCalledTimes(1);
  });

  it("captureUrls 缺省时回退按 domains 拼 https://{domain}/", async () => {
    const deps = makeDeps();
    deps.capture.mockResolvedValue({ closed: false, chunks: [] });

    await runWebLoginFlow(
      { source: "qq", webLogin: { url: WEBLOGIN.url, cookieMarkers: [] }, domains: ["y.qq.com", "qq.com"] },
      { ...deps, intervalMs: 1, timeoutMs: 20 },
    );

    expect(deps.capture).toHaveBeenCalledWith(["https://y.qq.com/", "https://qq.com/"]);
  });

  it("markers 空数组：有任意 Cookie 即触发校验", async () => {
    const deps = makeDeps();
    deps.capture.mockResolvedValue({ closed: false, chunks: ["somecookie=1"] });
    deps.validateImport.mockResolvedValue({ ok: true, user: { id: "u2", nickname: "小红", avatar: "", vip: false, vipLabel: "" } });

    const outcome = await runWebLoginFlow(
      { source: "kw", webLogin: { url: "https://m.kuwo.cn/login", cookieMarkers: [] }, domains: ["kuwo.cn"] },
      { ...deps, intervalMs: 1, timeoutMs: 1000 },
    );

    expect(outcome).toBe("ok");
    expect(deps.validateImport).toHaveBeenCalledTimes(1);
  });

  it("校验失败继续轮询，最终成功", async () => {
    const deps = makeDeps();
    deps.capture.mockResolvedValue({ closed: false, chunks: ["qm_keyst=AAA"] });
    deps.validateImport
      .mockResolvedValueOnce({ ok: false, user: null })
      .mockResolvedValueOnce({ ok: false, user: null })
      .mockResolvedValue({ ok: true, user: { id: "u3", nickname: "小刚", avatar: "", vip: false, vipLabel: "" } });

    const outcome = await runWebLoginFlow(
      { source: "qq", webLogin: WEBLOGIN, domains: ["y.qq.com"] },
      { ...deps, intervalMs: 1, timeoutMs: 2000 },
    );

    expect(outcome).toBe("ok");
    expect(deps.validateImport.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(deps.save).toHaveBeenCalledTimes(1);
    expect(deps.closeWindow).toHaveBeenCalledTimes(1);
  });

  it("总时长超限仍未命中/校验不过 → 关窗返回 timeout", async () => {
    const deps = makeDeps();
    deps.capture.mockResolvedValue({ closed: false, chunks: [] });

    const outcome = await runWebLoginFlow(
      { source: "qq", webLogin: WEBLOGIN, domains: ["y.qq.com"] },
      { ...deps, intervalMs: 2, timeoutMs: 30 },
    );

    expect(outcome).toBe("timeout");
    expect(deps.save).not.toHaveBeenCalled();
    expect(deps.closeWindow).toHaveBeenCalledTimes(1);
  });

  it("capture 抛错（用户手动关窗）→ 兜底关窗返回 cancelled", async () => {
    const deps = makeDeps();
    deps.capture.mockRejectedValue(new Error("window destroyed"));
    // 兜底关窗自身失败也不影响返回 cancelled
    deps.closeWindow.mockRejectedValue(new Error("already gone"));

    const outcome = await runWebLoginFlow(
      { source: "qq", webLogin: WEBLOGIN, domains: ["y.qq.com"] },
      { ...deps, intervalMs: 1, timeoutMs: 1000 },
    );

    expect(outcome).toBe("cancelled");
    expect(deps.save).not.toHaveBeenCalled();
    expect(deps.closeWindow).toHaveBeenCalledTimes(1);
  });

  it("capture 返回 closed=true（用户手动关窗）→ 立即 cancelled，不空转到超时", async () => {
    const deps = makeDeps();
    deps.capture.mockResolvedValue({ closed: true, chunks: [] });

    const outcome = await runWebLoginFlow(
      { source: "qq", webLogin: WEBLOGIN, domains: ["y.qq.com"] },
      { ...deps, intervalMs: 1, timeoutMs: 60_000 },
    );

    expect(outcome).toBe("cancelled");
    expect(deps.validateImport).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
    // 只在首轮 capture 就发现已关：不应拖到 60s 超时（真实耗时 < 1s）
    expect(deps.capture).toHaveBeenCalledTimes(1);
    expect(deps.openWindow).toHaveBeenCalledTimes(1);
  });
});
