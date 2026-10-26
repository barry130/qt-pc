// @vitest-environment jsdom
// 音乐助手的全局 AI 模式：rule / local 走本地回合（不建 astral 会话），server 才走服务端。
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatMessage, AiConversation } from "@/lib/ai";
import type { Track } from "@/types";

const mocks = vi.hoisted(() => ({
  readAiMode: vi.fn(),
  runAssistantTurn: vi.fn(),
  searchAllBatches: vi.fn(),
  astralAiAgents: vi.fn(),
  astralAiCreateConversation: vi.fn(),
  astralAiSendMessage: vi.fn(),
  astralAiEvents: vi.fn(),
  astralAiMessages: vi.fn(),
}));

const historyMocks = vi.hoisted(() => ({
  listLocalConversations: vi.fn(),
  loadLocalMessages: vi.fn(),
  createLocalConversation: vi.fn(),
  appendLocalMessages: vi.fn(),
  removeLocalConversation: vi.fn(),
}));

vi.mock("@/services/ipc", () => ({
  listHistory: vi.fn().mockResolvedValue([]),
  astralAiAgents: mocks.astralAiAgents,
  astralAiCapabilities: vi.fn().mockResolvedValue({}),
  astralAiConversations: vi.fn().mockResolvedValue([]),
  astralAiCreateConversation: mocks.astralAiCreateConversation,
  astralAiSendMessage: mocks.astralAiSendMessage,
  astralAiEvents: mocks.astralAiEvents,
  astralAiMessages: mocks.astralAiMessages,
  astralAiCancelRequest: vi.fn(),
  astralAiDeleteConversation: vi.fn(),
  astralAiFeedback: vi.fn(),
  astralAiExecuteAction: vi.fn(),
}));

vi.mock("@/lib/ai-mode", () => ({
  AI_MODE_HINT: {
    rule: "不联网、不调模型：每日推荐按口味规则排，音乐助手按关键词规则选歌。永远可用。",
    local: "调用下面配置的接口，只让模型在已搜好的候选里挑；模型挂了自动退回规则。",
    server: "走登录后的 astral 音乐助手：每日推荐与音乐助手都按服务端会话生成，需要登录。",
  },
  readAiMode: mocks.readAiMode,
  // hook 现在用 resolveAiMode 把「存过 server 但当前不是管理员」收敛成 rule。
  // 这里给真实现（纯函数），各用例只改 readAiMode 与 auth store 的 profile。
  resolveAiMode: (mode: string, canUseServer: boolean): string =>
    mode === "server" && !canUseServer ? "rule" : mode,
}));

vi.mock("@/lib/ai-assistant-local", () => ({
  runAssistantTurn: mocks.runAssistantTurn,
}));

vi.mock("@/lib/ai-assistant-history", () => historyMocks);

vi.mock("@/source-scripts", () => ({
  searchAllBatches: mocks.searchAllBatches,
}));

vi.mock("@/lib/aggregate-sources", () => ({
  readAggregateSources: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/stores/sourceRegistry", () => ({
  registrySourceIds: () => ["wyy", "qq"],
  useSourceRegistryStore: { getState: () => ({ ensure: vi.fn() }) },
}));

vi.mock("@/stores/player", () => ({
  usePlayerStore: {
    getState: () => ({ state: { track: null }, queue: [], play: vi.fn(), playQueue: vi.fn() }),
  },
}));

import { useAiChat } from "@/hooks/useAiChat";
import { useAuthStore } from "@/stores/auth";

function track(id: string, title: string): Track {
  return { id, platform: "wyy", title, singer: "周杰伦", album: "", picUrl: "", duration: 240 };
}

const songs = [track("a1", "晴天"), track("a2", "稻香")];

function localConversation(id: number, title: string): AiConversation {
  return {
    id,
    agentCode: "local",
    agentName: "本地助手",
    title,
    status: "ACTIVE",
    messageCount: 2,
    pinned: false,
    lastMessageTime: "2026-10-24T10:00:00.000Z",
    createTime: "2026-10-24T09:00:00.000Z",
  };
}

function storedMessage(uid: string, content: string): AiChatMessage {
  return {
    uid,
    id: 0,
    role: "USER",
    content,
    status: "COMPLETED",
    blocks: [],
    citations: [],
    actions: [],
    streaming: false,
    progress: "",
    requestId: 0,
    createTime: "",
    error: "",
  };
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  for (const fn of Object.values(historyMocks)) fn.mockReset();
  // 默认按管理员跑：既有 server 用例要真的进服务端分支；非管理员用例自己覆盖 profile。
  useAuthStore.setState({ profile: { permissions: ["admin:qt:admin"] }, session: null });
  mocks.readAiMode.mockResolvedValue("rule");
  mocks.runAssistantTurn.mockResolvedValue({
    reply: "给你找了几首适合傍晚听的华语歌。",
    songs,
    model: "rule",
  });
  mocks.searchAllBatches.mockResolvedValue([
    { source: "wyy", tracks: songs },
    { source: "qq", tracks: [track("b1", "浮夸")] },
  ]);
  mocks.astralAiAgents.mockResolvedValue([{ agentCode: "music_assistant", name: "小音", agentType: "MUSIC" }]);
  historyMocks.listLocalConversations.mockReturnValue([]);
  historyMocks.loadLocalMessages.mockReturnValue([]);
  historyMocks.createLocalConversation.mockReturnValue(7);
  historyMocks.appendLocalMessages.mockReturnValue(true);
  historyMocks.removeLocalConversation.mockReturnValue(true);
});

describe("音乐助手按全局 AI 模式分流", () => {
  it("rule 模式：init 不拉服务端智能体，发送后直接出歌单块", async () => {
    mocks.readAiMode.mockResolvedValue("rule");
    const { result } = renderHook(() => useAiChat({ agentCode: "music_assistant" }));

    await act(async () => {
      await result.current.init();
    });
    expect(mocks.astralAiAgents).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.send("来点适合傍晚听的中文歌");
    });

    await waitFor(() => expect(result.current.sending).toBe(false));
    const reply = result.current.messages.at(-1);
    expect(reply?.role).toBe("ASSISTANT");
    expect(reply?.status).toBe("COMPLETED");
    expect(reply?.content).toContain("傍晚");
    const block = reply?.blocks[0];
    expect(block?.type).toBe("song_list");
    const items =
      (block?.data as unknown as { items: { songId: string }[] } | null | undefined)?.items ?? [];
    expect(items.map((item) => item.songId)).toEqual(["a1", "a2"]);
    expect(mocks.runAssistantTurn).toHaveBeenCalledTimes(1);
    expect(mocks.astralAiCreateConversation).not.toHaveBeenCalled();
  });

  it("local 模式：本地模型出歌，mode 与 modeHint 跟着设置走", async () => {
    mocks.readAiMode.mockResolvedValue("local");
    const { result } = renderHook(() => useAiChat({ agentCode: "music_assistant" }));
    await act(async () => {
      await result.current.init();
    });

    await act(async () => {
      await result.current.send("想听点新的");
    });
    await waitFor(() => expect(result.current.sending).toBe(false));

    expect(result.current.mode).toBe("local");
    expect(result.current.modeHint).toContain("下面配置的接口");
    const turn = mocks.runAssistantTurn.mock.calls[0]?.[0] as { mode: string };
    expect(turn.mode).toBe("local");
    expect(mocks.astralAiCreateConversation).not.toHaveBeenCalled();
  });

  it("本地引擎一首都没挑出来时不渲染空歌单块", async () => {
    mocks.readAiMode.mockResolvedValue("rule");
    mocks.runAssistantTurn.mockResolvedValue({ reply: "换个说法我再找找？", songs: [], model: "rule" });
    const { result } = renderHook(() => useAiChat({ agentCode: "music_assistant" }));
    await act(async () => {
      await result.current.init();
    });
    await act(async () => {
      await result.current.send("随便");
    });
    await waitFor(() => expect(result.current.sending).toBe(false));
    const reply = result.current.messages.at(-1);
    expect(reply?.content).toContain("换个说法");
    expect(reply?.blocks).toHaveLength(0);
  });

  it("server 模式：init 才去拉服务端智能体（本地模式不碰 astral）", async () => {
    mocks.readAiMode.mockResolvedValue("server");
    const { result } = renderHook(() => useAiChat({ agentCode: "music_assistant" }));
    await act(async () => {
      await result.current.init();
    });
    expect(mocks.astralAiAgents).toHaveBeenCalledTimes(1);
    expect(result.current.mode).toBe("server");
    expect(result.current.modeHint).toContain("需要登录");
  });

  it("非管理员存过 server：按纯规则跑，不拉智能体、不建服务端会话", async () => {
    mocks.readAiMode.mockResolvedValue("server");
    useAuthStore.setState({ profile: { roles: ["APP_USER"], permissions: ["user:ai:music:use"] } });
    const { result } = renderHook(() => useAiChat({ agentCode: "music_assistant" }));

    await act(async () => {
      await result.current.init();
    });
    // 服务端 AI 是管理员专属：非管理员连智能体列表都不该去问
    expect(mocks.astralAiAgents).not.toHaveBeenCalled();
    expect(result.current.mode).toBe("rule");

    await act(async () => {
      await result.current.send("来点适合傍晚听的中文歌");
    });
    await waitFor(() => expect(result.current.sending).toBe(false));

    const reply = result.current.messages.at(-1);
    expect(reply?.role).toBe("ASSISTANT");
    expect(reply?.status).toBe("COMPLETED");
    expect(mocks.runAssistantTurn).toHaveBeenCalledTimes(1);
    expect(mocks.astralAiCreateConversation).not.toHaveBeenCalled();
    expect(result.current.mode).toBe("rule");
    expect(result.current.modeHint).not.toContain("需要登录");
  });

  it("每次发送都以库里的最新模式为准（设置页改完不刷新也生效）", async () => {
    mocks.readAiMode.mockResolvedValue("rule");
    const { result } = renderHook(() => useAiChat({ agentCode: "music_assistant" }));
    await act(async () => {
      await result.current.init();
    });
    expect(result.current.mode).toBe("rule");

    mocks.readAiMode.mockResolvedValue("local");
    await act(async () => {
      await result.current.send("再来一首");
    });
    await waitFor(() => expect(result.current.sending).toBe(false));
    expect(result.current.mode).toBe("local");
  });
});

describe("规则 / 本地模式的本地会话历史", () => {
  it("init 读本地历史填侧栏，且不碰 astral 会话列表", async () => {
    mocks.readAiMode.mockResolvedValue("rule");
    historyMocks.listLocalConversations.mockReturnValue([localConversation(2, "来点古风")]);

    const { result } = renderHook(() => useAiChat({ agentCode: "music_assistant" }));
    await act(async () => {
      await result.current.init();
    });

    expect(result.current.conversations).toHaveLength(1);
    expect(result.current.conversations[0]?.title).toBe("来点古风");
    expect(mocks.astralAiAgents).not.toHaveBeenCalled();
  });

  it("本地回合结束后写回历史：建会话、追加两条、侧栏跟着刷新", async () => {
    mocks.readAiMode.mockResolvedValue("rule");
    historyMocks.createLocalConversation.mockReturnValue(9);
    historyMocks.listLocalConversations.mockReturnValue([localConversation(9, "来点古风")]);

    const { result } = renderHook(() => useAiChat({ agentCode: "music_assistant" }));
    await act(async () => {
      await result.current.init();
    });
    await act(async () => {
      await result.current.send("来点古风");
    });
    await waitFor(() => expect(result.current.sending).toBe(false));

    expect(historyMocks.createLocalConversation).toHaveBeenCalledWith("来点古风");
    expect(historyMocks.appendLocalMessages).toHaveBeenCalledTimes(1);
    const [id, appended] = historyMocks.appendLocalMessages.mock.calls[0] as [
      number,
      { role: string; content: string }[],
    ];
    expect(id).toBe(9);
    expect(appended.map((message) => message.role)).toEqual(["USER", "ASSISTANT"]);
    expect(result.current.conversations[0]?.title).toBe("来点古风");
  });

  it("切换已有会话读本地消息；删除时清本地存储，不调 astral", async () => {
    mocks.readAiMode.mockResolvedValue("local");
    historyMocks.loadLocalMessages.mockReturnValue([storedMessage("local-1", "之前说过的话")]);

    const { result } = renderHook(() => useAiChat({ agentCode: "music_assistant" }));
    await act(async () => {
      await result.current.init();
    });

    await act(async () => {
      await result.current.selectConversation(5);
    });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]?.content).toBe("之前说过的话");
    expect(mocks.astralAiMessages).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.removeConversation(5);
    });
    expect(historyMocks.removeLocalConversation).toHaveBeenCalledWith(5);
  });
});
