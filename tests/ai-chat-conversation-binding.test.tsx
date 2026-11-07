// @vitest-environment jsdom
// C04：本地回合的落库/回填目标必须是「发起时」的会话；等模型期间切会话或点
// 「新对话」，回复不能写进用户此刻停留的那条会话，也不能把界面拽回旧会话。
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatMessage, AiConversation } from "@/lib/ai";

const mocks = vi.hoisted(() => ({
  readAiMode: vi.fn(),
  runAssistantTurn: vi.fn(),
  searchAllBatches: vi.fn(),
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
  astralAiAgents: vi.fn().mockResolvedValue([]),
  astralAiCapabilities: vi.fn().mockResolvedValue({}),
  astralAiConversations: vi.fn().mockResolvedValue([]),
  astralAiCreateConversation: vi.fn(),
  astralAiSendMessage: vi.fn(),
  astralAiEvents: vi.fn(),
  astralAiMessages: vi.fn(),
  astralAiCancelRequest: vi.fn(),
  astralAiDeleteConversation: vi.fn(),
  astralAiFeedback: vi.fn(),
  astralAiExecuteAction: vi.fn(),
}));

vi.mock("@/lib/ai-mode", () => ({
  AI_MODE_HINT: { rule: "rule", local: "local", server: "server" },
  readAiMode: mocks.readAiMode,
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
  registrySourceIds: () => [],
  useSourceRegistryStore: { getState: () => ({ ensure: vi.fn() }) },
}));

vi.mock("@/stores/player", () => ({
  usePlayerStore: {
    getState: () => ({ state: null, queue: [], play: vi.fn(), playQueue: vi.fn() }),
  },
}));

import { useAiChat } from "@/hooks/useAiChat";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

function conversation(id: number, title: string): AiConversation {
  return {
    id,
    agentCode: "local",
    agentName: "本地助手",
    title,
    status: "ACTIVE",
    messageCount: 0,
    pinned: false,
    lastMessageTime: "",
    createTime: "",
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

/** 让出几轮微任务：send 在 await readAiMode / 候选搜索之后才挂到 runAssistantTurn 上 */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  for (const fn of Object.values(historyMocks)) fn.mockReset();
  mocks.readAiMode.mockResolvedValue("local");
  mocks.searchAllBatches.mockResolvedValue([]);
  historyMocks.listLocalConversations.mockReturnValue([
    conversation(5, "A"),
    conversation(8, "B"),
  ]);
  historyMocks.loadLocalMessages.mockImplementation((id: number) => [
    storedMessage(`history-${id}`, `history ${id}`),
  ]);
  historyMocks.createLocalConversation.mockReturnValue(9);
  historyMocks.appendLocalMessages.mockReturnValue(true);
  historyMocks.removeLocalConversation.mockReturnValue(true);
});

describe("本地回合与会话绑定", () => {
  it("等读取模式期间切会话：取消旧回合，不借用新会话历史或写入新界面", async () => {
    const mode = deferred<string>();
    mocks.runAssistantTurn.mockResolvedValue({ reply: "stale answer", songs: [], model: "local" });
    const { result } = renderHook(() => useAiChat({ agentCode: "music_assistant" }));
    await act(async () => {
      await result.current.init();
      await result.current.selectConversation(5);
    });
    mocks.readAiMode.mockReturnValueOnce(mode.promise);

    let sending!: Promise<void>;
    await act(async () => {
      sending = result.current.send("old prompt from A");
      await drain();
    });
    expect(mocks.runAssistantTurn).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.selectConversation(8);
    });
    await act(async () => {
      mode.resolve("local");
      await sending;
    });

    expect(result.current.activeConversationId).toBe(8);
    expect(result.current.messages.map((m) => m.content)).toEqual(["history 8"]);
    expect(mocks.runAssistantTurn).not.toHaveBeenCalled();
    expect(historyMocks.appendLocalMessages).not.toHaveBeenCalled();
  });

  it("旧模式读取失败：不写新会话错误，也不释放新回合的发送门闩", async () => {
    const mode = deferred<string>();
    const turn = deferred<{ reply: string; songs: never[]; model: string }>();
    mocks.runAssistantTurn.mockReturnValue(turn.promise);
    const { result } = renderHook(() => useAiChat({ agentCode: "music_assistant" }));
    await act(async () => {
      await result.current.init();
      await result.current.selectConversation(5);
    });
    mocks.readAiMode.mockReturnValueOnce(mode.promise);
    let sendingA!: Promise<void>;
    await act(async () => {
      sendingA = result.current.send("old prompt from A");
      await drain();
    });
    let sendingB!: Promise<void>;
    await act(async () => {
      await result.current.selectConversation(8);
      sendingB = result.current.send("new prompt from B");
      await drain();
    });
    expect(mocks.runAssistantTurn).toHaveBeenCalledTimes(1);
    await act(async () => {
      mode.reject(new Error("old mode failure"));
      await sendingA;
    });
    const errorAfterOldFailure = result.current.error;
    let duplicate!: Promise<void>;
    await act(async () => {
      duplicate = result.current.send("duplicate prompt for B");
      await drain();
    });
    const startedTurns = mocks.runAssistantTurn.mock.calls.length;
    await act(async () => {
      turn.resolve({ reply: "answer for B", songs: [], model: "local" });
      await Promise.all([sendingB, duplicate]);
    });

    expect(errorAfterOldFailure).toBe("");
    expect(startedTurns).toBe(1);
    expect(result.current.activeConversationId).toBe(8);
    expect(result.current.messages.at(-1)?.content).toBe("answer for B");
  });

  it("等模型期间切到别的会话：回复写回发起时的会话，界面留在新会话", async () => {
    const turn = deferred<{ reply: string; songs: never[]; model: string }>();
    mocks.runAssistantTurn.mockReturnValue(turn.promise);
    const { result } = renderHook(() => useAiChat({ agentCode: "music_assistant" }));

    await act(async () => {
      await result.current.init();
    });
    await act(async () => {
      await result.current.selectConversation(5);
    });
    expect(result.current.activeConversationId).toBe(5);

    let sending!: Promise<void>;
    await act(async () => {
      sending = result.current.send("old prompt from A");
      await drain();
    });
    expect(result.current.sending).toBe(true);

    await act(async () => {
      await result.current.selectConversation(8);
    });
    expect(result.current.activeConversationId).toBe(8);
    expect(result.current.sending).toBe(false);

    await act(async () => {
      turn.resolve({ reply: "old answer for A", songs: [], model: "local" });
      await sending;
    });

    expect(historyMocks.appendLocalMessages).toHaveBeenCalledTimes(1);
    const [writtenId, writtenMessages] = historyMocks.appendLocalMessages.mock
      .calls[0] as [number, { content: string }[]];
    expect(writtenId).toBe(5);
    expect(writtenMessages[0]?.content).toBe("old prompt from A");

    // 用户仍停在会话 8：activeId 不被拽回 5，展示的也只有 8 自己的历史
    expect(result.current.activeConversationId).toBe(8);
    expect(result.current.messages.map((m) => m.content)).toEqual(["history 8"]);
  });

  it("等模型期间点「新对话」：回复仍写回原会话，不接管空白会话", async () => {
    const turn = deferred<{ reply: string; songs: never[]; model: string }>();
    mocks.runAssistantTurn.mockReturnValue(turn.promise);
    const { result } = renderHook(() => useAiChat({ agentCode: "music_assistant" }));

    await act(async () => {
      await result.current.init();
    });
    await act(async () => {
      await result.current.selectConversation(5);
    });

    let sending!: Promise<void>;
    await act(async () => {
      sending = result.current.send("prompt from A");
      await drain();
    });

    await act(async () => {
      result.current.newConversation();
    });
    expect(result.current.activeConversationId).toBe(0);

    await act(async () => {
      turn.resolve({ reply: "answer for A", songs: [], model: "local" });
      await sending;
    });

    expect(historyMocks.appendLocalMessages).toHaveBeenCalledTimes(1);
    expect(historyMocks.appendLocalMessages.mock.calls[0]?.[0]).toBe(5);
    expect(historyMocks.createLocalConversation).not.toHaveBeenCalled();
    expect(result.current.activeConversationId).toBe(0);
    expect(result.current.messages).toEqual([]);
  });

  it("没有切会话时：回复写回当前会话并展示出来", async () => {
    const turn = deferred<{ reply: string; songs: never[]; model: string }>();
    mocks.runAssistantTurn.mockReturnValue(turn.promise);
    const { result } = renderHook(() => useAiChat({ agentCode: "music_assistant" }));

    await act(async () => {
      await result.current.init();
    });
    await act(async () => {
      await result.current.selectConversation(5);
    });

    let sending!: Promise<void>;
    await act(async () => {
      sending = result.current.send("prompt from A");
      await drain();
    });
    await act(async () => {
      turn.resolve({ reply: "answer for A", songs: [], model: "local" });
      await sending;
    });

    expect(historyMocks.appendLocalMessages.mock.calls[0]?.[0]).toBe(5);
    expect(result.current.activeConversationId).toBe(5);
    const last = result.current.messages.at(-1);
    expect(last?.content).toBe("answer for A");
    expect(last?.status).toBe("COMPLETED");
  });

  it("新建后同一事件内发送：不借用上个会话的引用或历史", async () => {
    const turn = deferred<{ reply: string; songs: never[]; model: string }>();
    mocks.runAssistantTurn.mockReturnValue(turn.promise);
    const { result } = renderHook(() => useAiChat({ agentCode: "music_assistant" }));
    await act(async () => {
      await result.current.init();
      await result.current.selectConversation(5);
    });

    let sending!: Promise<void>;
    await act(async () => {
      result.current.newConversation();
      sending = result.current.send("new conversation prompt");
      await drain();
    });
    await act(async () => {
      turn.resolve({ reply: "new conversation answer", songs: [], model: "local" });
      await sending;
    });

    expect(historyMocks.createLocalConversation).toHaveBeenCalledWith("new conversation prompt");
    expect(historyMocks.appendLocalMessages.mock.calls[0]?.[0]).toBe(9);
    expect(result.current.activeConversationId).toBe(9);
    expect(result.current.messages.map((m) => m.content)).toEqual([
      "new conversation prompt", "new conversation answer",
    ]);
  });

  it("从「新对话」发出：落库时新建会话并接管 activeId", async () => {
    const turn = deferred<{ reply: string; songs: never[]; model: string }>();
    mocks.runAssistantTurn.mockReturnValue(turn.promise);
    const { result } = renderHook(() => useAiChat({ agentCode: "music_assistant" }));

    await act(async () => {
      await result.current.init();
    });
    expect(result.current.activeConversationId).toBe(0);

    let sending!: Promise<void>;
    await act(async () => {
      sending = result.current.send("first prompt");
      await drain();
    });
    await act(async () => {
      turn.resolve({ reply: "first answer", songs: [], model: "local" });
      await sending;
    });

    expect(historyMocks.createLocalConversation).toHaveBeenCalledWith("first prompt");
    expect(historyMocks.appendLocalMessages.mock.calls[0]?.[0]).toBe(9);
    expect(result.current.activeConversationId).toBe(9);
  });
});
