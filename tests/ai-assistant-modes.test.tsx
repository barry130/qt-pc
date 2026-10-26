// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AI_MODE_HINT, type AiEngineMode } from "@/lib/ai-mode";

/**
 * 音乐助手页 · 全局 AI 模式（设置 → AI，存储键 `dailyRecommend.mode`）。
 *
 * 2026-10-24 用户原话「这个需要完全支持音乐助手，每日推荐。选择哪个全局都得使用这个
 * 模式」：音乐助手页不再固定走 astral 服务端，而是跟着全局模式换一套说法。本文件只
 * 守「每种模式该显示什么、不该显示什么」，不测选歌（在 `useAiChat` 与 Rust 侧，
 * 这里整段替身，见下面的 mock）：
 *   1. 非 server 模式挂模式横幅（该模式说明 + 「设置 → AI 可切换」）；
 *   2. 左侧历史对话三种模式都渲染（server 读服务端会话，rule / local 读本地历史）；
 *   3. server 模式不挂横幅，会话列表照旧；
 *   4. agentCode 徽标只在 server 模式出现；
 *   5. 底部脚注按模式换说法，三种互不相同；
 *   6. 顶栏副标题按模式换说法（server 保持原文案）。
 */

// 页面经 @/services/ipc 间接加载 Tauri IPC（设置/会话都在 Rust 侧），jsdom 下没有
// internals，先把这两个入口替身掉（与 daily-recommend-page.test.tsx 同口径）。
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));

// 曲目播放/入队与气泡里的候选卡各自拖着播放器、收藏、下载一长串依赖，与本文件
// 要断言的「模式换皮」无关：整块替身，让渲染只受 useAiChat 返回值影响。
vi.mock("@/stores/player", () => ({
  usePlayerStore: {
    getState: () => ({
      play: vi.fn(async () => undefined),
      playQueue: vi.fn(async () => undefined),
    }),
  },
}));
vi.mock("@/components/ai-assistant/MessageBubble", () => ({ MessageBubble: () => null }));

// 页面状态整段替身：用例只改 `mode`，其余字段给一份够渲染的固定值。
// 用 hoisted 持有可变量，避免 mock 工厂被提前调用时读到未初始化的 `chat`。
const mocks = vi.hoisted(() => ({ chat: {} as ReturnType<typeof makeChat> }));
vi.mock("@/hooks/useAiChat", () => ({ useAiChat: () => mocks.chat }));

/** 页面用到的 `useAiChat` 返回值（字段名与真实 hook 一致，只保留页面读的那些） */
function makeChat(mode: AiEngineMode) {
  return {
    mode,
    modeHint: AI_MODE_HINT[mode],
    agent: { agentCode: "music_assistant", name: "音乐助手" },
    agentName: "音乐助手",
    capabilities: { feedbackEnabled: false },
    conversations: [{ id: 1, title: "会话一", messageCount: 2 }],
    activeConversationId: 1,
    messages: [],
    suggestions: ["来点古风"],
    loading: false,
    loadingMessages: false,
    sending: false,
    error: "",
    canRun: vi.fn(() => true),
    init: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    newConversation: vi.fn(),
    selectConversation: vi.fn(async () => undefined),
    removeConversation: vi.fn(async () => undefined),
    runAction: vi.fn(async () => ({ ok: true, note: "" })),
    feedback: vi.fn(async () => undefined),
  };
}

/** 模式横幅右侧那句「去哪改」 */
const SWITCH_HINT = "设置 → AI 可切换";

/** 底部脚注：三种模式各一句（与页面里的常量一一对应） */
const FOOTNOTE: Record<AiEngineMode, string> = {
  rule: "回答由本地规则生成，推荐结果请以自己的听感为准。",
  local: "回答由本机模型生成，推荐结果请以自己的听感为准。",
  server: "回答由后台配置的智能体生成，推荐结果请以自己的听感为准。",
};

async function renderPage(mode: AiEngineMode): Promise<void> {
  mocks.chat = makeChat(mode);
  const { AiAssistantPage } = await import("@/components/ai-assistant/AiAssistantPage");
  render(<AiAssistantPage />);
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom 没实现 scrollIntoView，而页面「贴底才滚动」的 effect 会调到它
  Element.prototype.scrollIntoView = vi.fn();
});

describe("音乐助手页 · 全局 AI 模式", () => {
  it("rule：挂出模式横幅（规则说明 + 去设置切换的入口）", async () => {
    await renderPage("rule");
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText(AI_MODE_HINT.rule)).toBeTruthy();
    expect(screen.getByText(SWITCH_HINT)).toBeTruthy();
  });

  it("local：横幅换成 local 说明，左侧历史对话照常渲染", async () => {
    await renderPage("local");
    expect(screen.getByText(AI_MODE_HINT.local)).toBeTruthy();
    // 规则 / 本地模式没有服务端会话，但本地历史（localStorage）照样进侧栏
    expect(screen.getByText("历史对话")).toBeTruthy();
    expect(screen.getByText("会话一")).toBeTruthy();
  });

  it("server：不挂模式横幅，会话列表照旧显示", async () => {
    await renderPage("server");
    expect(screen.queryByText(SWITCH_HINT)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("历史对话")).toBeTruthy();
    expect(screen.getByText("会话一")).toBeTruthy();
  });

  it("rule / local：agentCode 徽标不渲染，但折叠按钮要在（侧栏本地也有）", async () => {
    await renderPage("rule");
    expect(screen.queryByText("music_assistant")).toBeNull();
    expect(screen.getByLabelText("收起历史对话")).toBeTruthy();
  });

  it("server：顶栏的 agentCode 徽标与折叠按钮都在", async () => {
    await renderPage("server");
    expect(screen.getByText("music_assistant")).toBeTruthy();
    expect(screen.getByLabelText("收起历史对话")).toBeTruthy();
  });

  it("脚注 · rule：说是本地规则生成的，不冒充模型/智能体", async () => {
    await renderPage("rule");
    expect(screen.getByText(FOOTNOTE.rule)).toBeTruthy();
    expect(screen.queryByText(FOOTNOTE.local)).toBeNull();
    expect(screen.queryByText(FOOTNOTE.server)).toBeNull();
  });

  it("脚注 · local：说是本机模型生成的", async () => {
    await renderPage("local");
    expect(screen.getByText(FOOTNOTE.local)).toBeTruthy();
    expect(screen.queryByText(FOOTNOTE.rule)).toBeNull();
    expect(screen.queryByText(FOOTNOTE.server)).toBeNull();
  });

  it("脚注 · server：保持原文案（后台配置的智能体）", async () => {
    await renderPage("server");
    expect(screen.getByText(FOOTNOTE.server)).toBeTruthy();
    expect(screen.queryByText(FOOTNOTE.rule)).toBeNull();
    expect(screen.queryByText(FOOTNOTE.local)).toBeNull();
  });

  it("顶栏副标题 · local：本机模型只在已搜好的候选里挑", async () => {
    await renderPage("local");
    expect(
      screen.getByText("本机模型在已搜好的候选里挑歌，歌单与播放都在本机完成"),
    ).toBeTruthy();
  });

  it("顶栏副标题 · rule：按关键词规则选歌，不联网", async () => {
    await renderPage("rule");
    expect(screen.getByText("按关键词规则选歌，不联网、不调模型")).toBeTruthy();
  });

  it("顶栏副标题 · server：保持原文案", async () => {
    await renderPage("server");
    expect(
      screen.getByText("说一句想听什么，我来找歌并介绍；歌单与播放都在本机完成"),
    ).toBeTruthy();
  });
});
