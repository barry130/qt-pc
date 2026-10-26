// 全局 AI 模式的收敛函数：三种模式共用一份存储键，坏数据不能挡住任何页面。
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSetting: vi.fn(), setSetting: vi.fn() }));

vi.mock("@/services/ipc", () => ({
  getSetting: mocks.getSetting,
  setSetting: mocks.setSetting,
}));

import {
  AI_MODE_HINT,
  AI_MODE_LABEL,
  AI_MODE_OPTIONS,
  aiModeOptionsFor,
  parseAiMode,
  readAiMode,
  resolveAiMode,
  saveAiMode,
} from "@/lib/ai-mode";
import { DAILY_RECOMMEND_MODE_KEY } from "@/lib/storageKeys";

beforeEach(() => {
  mocks.getSetting.mockReset();
  mocks.setSetting.mockReset();
});

describe("parseAiMode（未知值一律按规则处理）", () => {
  it("三种合法值原样返回", () => {
    expect(parseAiMode("rule")).toBe("rule");
    expect(parseAiMode("local")).toBe("local");
    expect(parseAiMode("server")).toBe("server");
  });

  it("空值与未知值回落 rule，不抛错", () => {
    for (const raw of [null, undefined, "", "bogus", "SERVER", " local ", "server "]) {
      expect(parseAiMode(raw)).toBe("rule");
    }
  });
});

describe("readAiMode（读失败按规则处理）", () => {
  it("读到什么就用什么，键是全局那个", async () => {
    mocks.getSetting.mockResolvedValue("local");
    await expect(readAiMode()).resolves.toBe("local");
    expect(mocks.getSetting).toHaveBeenCalledWith(DAILY_RECOMMEND_MODE_KEY);
  });

  it("设置库读失败时不抛错，回落 rule", async () => {
    mocks.getSetting.mockRejectedValue(new Error("database is locked"));
    await expect(readAiMode()).resolves.toBe("rule");
  });
});

describe("saveAiMode", () => {
  it("写的是全局键（每日推荐与音乐助手共用）", async () => {
    mocks.setSetting.mockResolvedValue(undefined);
    await saveAiMode("server");
    expect(mocks.setSetting).toHaveBeenCalledWith(DAILY_RECOMMEND_MODE_KEY, "server");
  });
});

describe("设置页数据源", () => {
  it("AI_MODE_OPTIONS 与 AI_MODE_LABEL 一一对应，顺序 rule → local → server", () => {
    expect(AI_MODE_OPTIONS.map((option) => option.value)).toEqual(["rule", "local", "server"]);
    for (const option of AI_MODE_OPTIONS) {
      expect(option.label).toBe(AI_MODE_LABEL[option.value]);
    }
  });

  it("每个模式都有非空说明，且三句互不相同", () => {
    const hints = AI_MODE_OPTIONS.map((option) => AI_MODE_HINT[option.value]);
    for (const hint of hints) expect(hint.length).toBeGreaterThan(10);
    expect(new Set(hints).size).toBe(3);
  });
});

describe("resolveAiMode（服务端 AI 仅管理员，2026-10-24）", () => {
  it("管理员三种模式原样保留", () => {
    expect(resolveAiMode("rule", true)).toBe("rule");
    expect(resolveAiMode("local", true)).toBe("local");
    expect(resolveAiMode("server", true)).toBe("server");
  });

  it("非管理员选不到 server：存过 server 也按 rule 执行", () => {
    expect(resolveAiMode("server", false)).toBe("rule");
  });

  it("规则 / 本地模型不受身份影响（管理员闸只盯 server）", () => {
    expect(resolveAiMode("rule", false)).toBe("rule");
    expect(resolveAiMode("local", false)).toBe("local");
  });
});

describe("aiModeOptionsFor（设置页按钮组按身份过滤）", () => {
  it("管理员看到三段，顺序与 AI_MODE_OPTIONS 一致", () => {
    expect(aiModeOptionsFor(true)).toEqual(AI_MODE_OPTIONS);
  });

  it("非管理员看不到 server，也没有任何等价入口", () => {
    const values = aiModeOptionsFor(false).map((option) => option.value);
    expect(values).toEqual(["rule", "local"]);
    expect(values).not.toContain("server");
  });

  it("返回新数组，调用方改了也不会污染 AI_MODE_OPTIONS", () => {
    const options = aiModeOptionsFor(false);
    options.pop();
    expect(AI_MODE_OPTIONS.map((option) => option.value)).toEqual(["rule", "local", "server"]);
  });
});
