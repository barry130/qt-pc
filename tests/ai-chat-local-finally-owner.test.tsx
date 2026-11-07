// @vitest-environment jsdom
// C04/R33: real hook, mode reader, local model helper, search facade and history.
// Only the final Tauri command/event boundary supplies owned synthetic responses;
// Storage is an owned in-memory fixture, never the host/browser persisted store.
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { AiLocalMessage, AiLocalReply } from "@/types";
import { installMemoryStorage } from "./helpers/memory-storage";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  emitTo: vi.fn(),
  emit: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: native.invoke,
}));

vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  listen: native.listen,
  emitTo: native.emitTo,
  emit: native.emit,
}));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function modelReply(reply: string): AiLocalReply {
  return {
    content: JSON.stringify({ reply, picks: [1] }),
    model: "owned-local-model",
    elapsedMs: 1,
    promptTokens: null,
    completionTokens: null,
  };
}

it("an old conversation's local completion cannot admit another send while the selected conversation is reading its mode", async () => {
  const storageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  installMemoryStorage();
  const settings = new Map<string, string>([["dailyRecommend.mode", "local"]]);
  const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
  const pendingModeReads: ReturnType<typeof deferred<string | null>>[] = [];
  const modelRequests: { messages: AiLocalMessage[] }[] = [];
  const firstModel = deferred<AiLocalReply>();
  const turns: Promise<void>[] = [];
  let holdModeReads = false;
  let unmount: (() => void) | undefined;

  const releaseModeReads = (): void => {
    holdModeReads = false;
    for (const pending of pendingModeReads) pending.resolve("local");
  };

  native.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "get_setting") {
      const key = String(args?.key);
      if (key === "dailyRecommend.mode" && holdModeReads) {
        const pending = deferred<string | null>();
        pendingModeReads.push(pending);
        return pending.promise;
      }
      return settings.get(key) ?? null;
    }
    if (command === "ai_local_chat") {
      modelRequests.push({ messages: args?.messages as AiLocalMessage[] });
      return modelRequests.length === 1 ? firstModel.promise : modelReply("answer for B");
    }
    throw new Error(`Unexpected native command in owned AI fixture: ${command}`);
  });
  native.listen.mockImplementation(async (
    name: string,
    callback: (event: { payload: unknown }) => void,
  ) => {
    const handlers = listeners.get(name) ?? new Set();
    handlers.add(callback);
    listeners.set(name, handlers);
    return () => { handlers.delete(callback); };
  });
  native.emit.mockResolvedValue(undefined);
  native.emitTo.mockImplementation(async (
    _label: string,
    event: string,
    request: Record<string, unknown>,
  ) => {
    if (event !== "source-engine-request") {
      throw new Error(`Unexpected native event in owned AI fixture: ${event}`);
    }
    let response: Record<string, unknown>;
    if (request.kind === "status") {
      response = { requestId: request.requestId, phase: "ready", pack: null };
    } else if (request.kind === "invoke" && request.entry === "sourceRegistry") {
      // No installed source/quality configuration is borrowed from the host.
      response = {
        requestId: request.requestId,
        result: JSON.stringify({ sources: [], qualities: [] }),
      };
    } else if (request.kind === "invoke" && request.entry === "searchAll") {
      // The real local helper requires a candidate to reach ai_local_chat.
      // This is a synthetic external engine reply, not a search/helper mock.
      response = {
        requestId: request.requestId,
        result: JSON.stringify({
          batches: [{
            source: "wyy",
            list: [{
              id: "owned-candidate-1",
              name: "Owned fixture song",
              singer: "Owned fixture artist",
              album: "Owned fixture album",
              picUrl: "",
              interval: 180,
            }],
          }],
        }),
      };
    } else {
      throw new Error(`Unexpected engine request in owned AI fixture: ${String(request.entry)}`);
    }
    for (const callback of listeners.get("source-engine-response") ?? []) {
      callback({ payload: response });
    }
  });

  const modeReadCount = (): number => native.invoke.mock.calls.filter(
    ([command, args]) => command === "get_setting" && args?.key === "dailyRecommend.mode",
  ).length;

  try {
    // Import the production graph only after installing the synthetic Storage:
    // its real persisted stores must never hydrate from host/browser storage.
    const { useAiChat } = await import("@/hooks/useAiChat");
    const { createLocalConversation, appendLocalMessages, loadLocalMessages } = await import(
      "@/lib/ai-assistant-history"
    );
    const aId = createLocalConversation("A");
    const bId = createLocalConversation("B");
    appendLocalMessages(bId, [{ role: "USER", content: "saved history B", blocks: [] }]);
    const hook = renderHook(() => useAiChat({ agentCode: "music_assistant" }));
    unmount = hook.unmount;
    const { result } = hook;

    await act(async () => { await result.current.init(); });
    await act(async () => { await result.current.selectConversation(aId); });
    let sendingA!: Promise<void>;
    await act(async () => {
      sendingA = result.current.send("old prompt from A");
      turns.push(sendingA);
    });
    await waitFor(() => expect(modelRequests).toHaveLength(1));
    expect(modelRequests[0]?.messages.find((message) => message.role === "user")?.content)
      .toContain("old prompt from A");
    expect(modelRequests[0]?.messages.find((message) => message.role === "user")?.content)
      .toContain("Owned fixture song");

    await act(async () => { await result.current.selectConversation(bId); });
    holdModeReads = true;
    let sendingB!: Promise<void>;
    await act(async () => {
      sendingB = result.current.send("new prompt from B");
      turns.push(sendingB);
    });
    await waitFor(() => expect(pendingModeReads).toHaveLength(1));
    expect(modeReadCount()).toBe(3); // init, A send, and the now-pending B send
    expect(modelRequests).toHaveLength(1); // B has not reached the actual model RPC

    await act(async () => {
      firstModel.resolve(modelReply("old answer for A"));
      await sendingA;
    });
    expect(loadLocalMessages(aId).map((message) => message.content)).toEqual([
      "old prompt from A", "old answer for A",
    ]);
    expect(result.current.activeConversationId).toBe(bId);
    expect(result.current.messages.map((message) => message.content)).toEqual(["saved history B"]);

    let thirdSend!: Promise<void>;
    await act(async () => {
      thirdSend = result.current.send("duplicate prompt for B");
      turns.push(thirdSend);
    });
    // The selected conversation already owns this send. A's completion must not
    // let a third public send reach even the native mode-read boundary.
    expect(modeReadCount()).toBe(3);
    expect(pendingModeReads).toHaveLength(1);

    await act(async () => {
      releaseModeReads();
      await Promise.all([sendingB, thirdSend]);
    });
    expect(modelRequests).toHaveLength(2);
    expect(result.current.activeConversationId).toBe(bId);
    expect(result.current.messages.map((message) => message.content)).toEqual([
      "saved history B", "new prompt from B", "answer for B",
    ]);
    expect(loadLocalMessages(bId).map((message) => message.content)).toEqual([
      "saved history B", "new prompt from B", "answer for B",
    ]);
    expect(result.current.sending).toBe(false);
  } finally {
    // RED assertions must still finish A, B and an accidentally admitted third
    // turn. Release mode gates BEFORE joining, and auto-answer later model RPCs.
    try {
      await act(async () => {
        firstModel.resolve(modelReply("old answer for A"));
        releaseModeReads();
        await Promise.allSettled(turns);
      });
    } finally {
      unmount?.();
      listeners.clear();
      vi.restoreAllMocks();
      if (storageDescriptor) Object.defineProperty(window, "localStorage", storageDescriptor);
      else Reflect.deleteProperty(window, "localStorage");
    }
  }
});
