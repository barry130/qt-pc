// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AiLocalConfigView, AiProfileInput, AiProfileView } from "@/types";

const mocks = vi.hoisted(() => ({
  aiLocalConfig: vi.fn(),
  aiLocalSaveConfig: vi.fn(),
  aiLocalListModels: vi.fn(),
  aiLocalTest: vi.fn(),
  toast: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/services/ipc", () => ({
  aiLocalConfig: mocks.aiLocalConfig,
  aiLocalSaveConfig: mocks.aiLocalSaveConfig,
  aiLocalListModels: mocks.aiLocalListModels,
  aiLocalTest: mocks.aiLocalTest,
}));

vi.mock("@/stores/toast", () => ({
  toast: mocks.toast,
  toastError: mocks.toastError,
  toastSuccess: mocks.toastSuccess,
}));

import { AiProvidersDialog, AiProvidersPanel } from "@/components/settings/AiProvidersPanel";

/**
 * 「AI 供应商」主从配置的交互测试（2026-10-24，用户要求按截图改造「接口配置」）。
 *
 * 这一组分的是「保存时发给 Rust 的输入形状」：列表展示、进详情、改名保存、
 * 加 Key 用 `addKeys`、删 Key 用 `removeKeyIndexes`、置顶用 `activeKeyIndex`、
 * 列表行切换生效要传新 `activeId`。Rust 侧的增删语义由 `ai_local.rs` 单测负责。
 */
function profile(over: Partial<AiProfileView> & { id: string }): AiProfileView {
  return {
    name: over.id,
    baseUrl: "https://api.openai.com/v1",
    protocol: "openai",
    model: "gpt-4o-mini",
    models: ["gpt-4o-mini"],
    hasKey: true,
    keyMasks: ["••••••ab"],
    keyMask: "••••••ab",
    icon: "",
    skipCertVerify: false,
    ...over,
  };
}

const first = profile({
  id: "p1",
  name: "魔塔",
  baseUrl: "https://api.openai.com/v1",
  models: ["gpt-4o-mini", "gpt-4.1"],
  model: "gpt-4o-mini",
  keyMasks: ["••••••ab", "••••••cd"],
  keyMask: "••••••ab",
});
const second = profile({
  id: "p2",
  name: "AMD",
  baseUrl: "https://api.anthropic.com",
  protocol: "anthropic",
  models: ["claude-3-5-sonnet"],
  model: "claude-3-5-sonnet",
  keyMasks: ["••••••ef"],
  keyMask: "••••••ef",
});

function view(activeId = "p1"): AiLocalConfigView {
  return { activeId, profiles: [first, second] };
}

/** 模拟 Rust 保存：回显 inputs（前端保存后会 applyView 刷回去） */
function echoView(inputs: AiProfileInput[], activeId: string): AiLocalConfigView {
  return {
    activeId,
    profiles: inputs.map((input, index) => {
      const existing = [first, second].find((item) => item.id === input.id);
      return {
        id: input.id,
        name: input.name,
        baseUrl: input.baseUrl,
        protocol: input.protocol,
        model: input.models[0] ?? input.model,
        models: [...input.models],
        hasKey: Boolean(existing?.hasKey || input.addKeys?.length),
        keyMasks: existing?.keyMasks ?? [],
        keyMask: existing?.keyMasks[0] ?? "",
        icon: input.icon,
        skipCertVerify: input.skipCertVerify,
        __index: index,
      } as AiProfileView & { __index: number };
    }),
  };
}

/** 打开某个供应商的详情页 */
async function openDetail(name: string): Promise<void> {
  fireEvent.click(await screen.findByLabelText(`配置 ${name}`));
}

function saveButton(): HTMLElement {
  return screen.getByRole("button", { name: "保存" });
}

function savedInputs(): AiProfileInput[] {
  return mocks.aiLocalSaveConfig.mock.calls[0]?.[0] as AiProfileInput[];
}

beforeEach(() => {
  cleanup();
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.aiLocalConfig.mockResolvedValue(view());
  mocks.aiLocalSaveConfig.mockImplementation(async (inputs: AiProfileInput[], activeId: string) =>
    echoView(inputs, activeId),
  );
  mocks.aiLocalListModels.mockResolvedValue([]);
  mocks.aiLocalTest.mockResolvedValue({ ok: false, error: "nope" });
});

describe("AI 供应商列表", () => {
  it("一屏只列供应商：名称、地址、模型数、掩码 Key、协议、生效开关", async () => {
    render(<AiProvidersPanel />);
    expect(await screen.findByText("魔塔")).toBeTruthy();
    expect(screen.getByText("https://api.openai.com/v1")).toBeTruthy();
    expect(screen.getByText("2 个模型")).toBeTruthy();
    expect(screen.getByText("••••••ab")).toBeTruthy();
    expect(screen.getByText("Anthropic 兼容")).toBeTruthy();
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(2);
    expect(switches[0].getAttribute("aria-checked")).toBe("true");
    expect(switches[1].getAttribute("aria-checked")).toBe("false");
  });

  it("搜索过滤只看名字和地址", async () => {
    render(<AiProvidersPanel />);
    await screen.findByText("魔塔");
    fireEvent.change(screen.getByPlaceholderText("查找供应商"), { target: { value: "anthro" } });
    expect(screen.queryByText("魔塔")).toBeNull();
    expect(screen.getByText("AMD")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("查找供应商"), { target: { value: "不存在" } });
    expect(screen.getByText("没有匹配的供应商")).toBeTruthy();
  });

  it("列表行点开关 = 切生效（传新 activeId）", async () => {
    render(<AiProvidersPanel />);
    await screen.findByText("魔塔");
    fireEvent.click(screen.getAllByRole("switch")[1]);
    await waitFor(() => expect(mocks.aiLocalSaveConfig).toHaveBeenCalledTimes(1));
    expect(mocks.aiLocalSaveConfig.mock.calls[0][1]).toBe("p2");
  });
});

describe("供应商详情", () => {
  it("改名后保存：只替换这个供应商，其它原样回传，生效不变", async () => {
    render(<AiProvidersPanel />);
    await openDetail("魔塔");
    fireEvent.change(screen.getByPlaceholderText("例如 官方 / 中转 / 本机"), {
      target: { value: "魔塔 API" },
    });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.aiLocalSaveConfig).toHaveBeenCalledTimes(1));
    const inputs = savedInputs();
    expect(inputs).toHaveLength(2);
    expect(inputs[0].name).toBe("魔塔 API");
    expect(inputs[0].id).toBe("p1");
    expect(inputs[1].name).toBe("AMD");
    expect(mocks.aiLocalSaveConfig.mock.calls[0][1]).toBe("p1");
  });

  it("新 Key 存进 addKeys，不整份覆盖 keys（前端没有旧明文）", async () => {
    render(<AiProvidersPanel />);
    await openDetail("魔塔");
    fireEvent.change(screen.getByPlaceholderText("输入新 Key（保存后追加）"), {
      target: { value: "sk-a" },
    });
    fireEvent.click(screen.getByText("添加另一个密钥"));
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.aiLocalSaveConfig).toHaveBeenCalledTimes(1));
    const input = savedInputs()[0];
    expect(input.addKeys).toEqual(["sk-a"]);
    expect(input.keys).toBeUndefined();
    expect(input.apiKey).toBeUndefined();
  });

  it("删第 2 把已存 Key 用 removeKeyIndexes，不当成「清空」", async () => {
    render(<AiProvidersPanel />);
    await openDetail("魔塔");
    const trash = screen.getAllByLabelText("删除这把 Key");
    expect(trash).toHaveLength(2);
    fireEvent.click(trash[1]);
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.aiLocalSaveConfig).toHaveBeenCalledTimes(1));
    const input = savedInputs()[0];
    expect(input.removeKeyIndexes).toEqual([1]);
    expect(input.apiKey).toBeUndefined();
  });

  it("第 2 把「设为使用中」→ activeKeyIndex 1", async () => {
    render(<AiProvidersPanel />);
    await openDetail("魔塔");
    fireEvent.click(screen.getByText("设为使用中"));
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.aiLocalSaveConfig).toHaveBeenCalledTimes(1));
    expect(savedInputs()[0].activeKeyIndex).toBe(1);
  });

  it("获取模型列表后点选，保存时进 models（第一项生效）", async () => {
    mocks.aiLocalListModels.mockResolvedValue(["gpt-4o", "gpt-4-mini"]);
    render(<AiProvidersPanel />);
    await openDetail("魔塔");
    fireEvent.click(screen.getByText("获取列表"));
    // chips 是「多选」：默认第一个是生效模型；先清空再点选，正好把点中的放到第一项
    await screen.findByText("gpt-4o");
    fireEvent.click(screen.getByText("全不选"));
    fireEvent.click(screen.getByText("gpt-4o"));
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.aiLocalSaveConfig).toHaveBeenCalledTimes(1));
    const input = savedInputs()[0];
    expect(input.models).toEqual(["gpt-4o"]);
    expect(input.model).toBe("gpt-4o");
  });

  it("Base URL 为空时不允许保存，只弹提示", async () => {
    render(<AiProvidersPanel />);
    await openDetail("魔塔");
    fireEvent.change(screen.getByPlaceholderText("https://api.openai.com/v1"), {
      target: { value: "  " },
    });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.aiLocalSaveConfig).not.toHaveBeenCalled();
  });

  it("测试连接：用当前表单值真发一次，结论就地显示在标题行（不进浮层）", async () => {
    mocks.aiLocalTest.mockResolvedValue({
      ok: true,
      status: 200,
      elapsedMs: 120,
      reply: "你好，我是助手",
      error: null,
    });
    render(<AiProvidersPanel />);
    await openDetail("魔塔");
    fireEvent.click(screen.getByText("测试连接"));
    await waitFor(() => expect(mocks.aiLocalTest).toHaveBeenCalledTimes(1));
    // 只发一次、用当前选中的协议（不是四路探测）
    const call = mocks.aiLocalTest.mock.calls[0];
    expect(call[0]).toBe("https://api.openai.com/v1");
    expect(call[1]).toBe("gpt-4o-mini");
    expect(call[2]).toBeUndefined();
    expect(call[3]).toBe("openai");
    expect(call[4]).toBe(false);
    // 结论留在页内（role=status），不走 toast（浮层几秒就飘走，用户要能一直看着）
    const note = await screen.findByRole("status");
    expect(note.textContent).toContain("连接正常");
    expect(note.textContent).toContain("120ms");
    expect(note.textContent).toContain("你好，我是助手");
    expect(note.className).toContain("text-success");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    // 测试连接不写盘
    expect(mocks.aiLocalSaveConfig).not.toHaveBeenCalled();
  });

  it("测试连接：失败回具体原因（红字留在页内），不写盘", async () => {
    mocks.aiLocalTest.mockResolvedValue({
      ok: false,
      status: null,
      elapsedMs: 300,
      reply: null,
      error: "401 未授权：Key 无效",
    });
    render(<AiProvidersPanel />);
    await openDetail("魔塔");
    fireEvent.click(screen.getByText("测试连接"));
    const note = await screen.findByRole("alert");
    expect(note.textContent).toContain("401 未授权：Key 无效");
    expect(note.className).toContain("text-destructive");
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.aiLocalSaveConfig).not.toHaveBeenCalled();
  });

  it("测试连接后改任何字段，旧结论立刻清掉（不留过期结论）", async () => {
    mocks.aiLocalTest.mockResolvedValue({
      ok: true,
      status: 200,
      elapsedMs: 120,
      reply: "好",
      error: null,
    });
    render(<AiProvidersPanel />);
    await openDetail("魔塔");
    fireEvent.click(screen.getByText("测试连接"));
    expect(await screen.findByRole("status")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("https://api.openai.com/v1"), {
      target: { value: "https://api.openai.com/v1/" },
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("测试连接：还没选模型时先提示，不发请求", async () => {
    render(<AiProvidersPanel />);
    await openDetail("魔塔");
    fireEvent.click(screen.getByText("全不选"));
    fireEvent.click(screen.getByText("测试连接"));
    expect(mocks.toastError).toHaveBeenCalled();
    expect(mocks.aiLocalTest).not.toHaveBeenCalled();
  });

describe("供应商标配弹窗（用户 2026-10-24 要求：不要一页展开，点开弹窗改）", () => {
  it("弹窗带标题与说明，内容还是供应商列表", async () => {
    const onClose = vi.fn();
    render(<AiProvidersDialog onClose={onClose} />);
    const dialog = await screen.findByRole("dialog", { name: "AI 供应商" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(await screen.findByText("魔塔")).toBeTruthy();
    expect(screen.getByText("AMD")).toBeTruthy();
  });

  it("按 Esc 关闭，点右上角也关闭", async () => {
    const onClose = vi.fn();
    render(<AiProvidersDialog onClose={onClose} />);
    await screen.findByRole("dialog", { name: "AI 供应商" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("关闭 AI 供应商设置"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
});
