// 每日推荐「服务端 AI」取数：会话一次性、轮询认终态、失败必须抛错（不静默兜底）。
// 应答形状以 `@/lib/ai` 的规整函数读的字段为准，这里只构造最小可识别对象。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/types";

const ipcMock = vi.hoisted(() => ({
  astralSession: vi.fn(),
  astralAiAgents: vi.fn(),
  astralAiCreateConversation: vi.fn(),
  astralAiSendMessage: vi.fn(),
  astralAiEvents: vi.fn(),
  astralAiDeleteConversation: vi.fn(),
}));

vi.mock("@/services/ipc", () => ipcMock);

import { SERVER_PICK_POLL_MS, askServerForPicks } from "@/lib/ai-server-picks";
import { useAuthStore } from "@/stores/auth";

function track(id: string, title: string, singer = "周杰伦"): Track {
  return { id, platform: "wyy", title, singer, album: "", picUrl: "", duration: 240 };
}

const session = { token: "token", refreshToken: "refresh", expiresAt: 0 };
const agent = { agentCode: "music_assistant", name: "小音", agentType: "MUSIC" };

function candidate(id: string, name: string) {
  return {
    sourceId: "wyy",
    songId: id,
    name,
    artist: "周杰伦",
    album: "",
    duration: 240,
    coverUrl: "",
    quality: "",
    extra: null,
  };
}

function terminalBatch(content: string, items: unknown[] = []) {
  return {
    requestId: 7,
    status: "COMPLETED",
    events: [
      {
        type: "message.completed",
        data: {
          content,
          blocks:
            items.length > 0
              ? [{ type: "song_list", title: "精选", data: { items } }]
              : [],
        },
      },
    ],
    nextSequence: 1,
    terminal: true,
  };
}

const request = () => ({
  pool: [track("a1", "晴天"), track("a2", "稻香")],
  messages: [
    { role: "system" as const, content: "你是选歌助手" },
    { role: "user" as const, content: "候选清单..." },
  ],
});

beforeEach(() => {
  for (const fn of Object.values(ipcMock)) fn.mockReset();
  // 默认按管理员跑：「服务端 AI」只对管理员开放（2026-10-24），
  // 下面所有成功路径用例都要先过这道身份闸；非管理员用例自己覆盖 profile。
  useAuthStore.setState({ profile: { permissions: ["admin:qt:admin"] }, session: null });
  ipcMock.astralSession.mockResolvedValue(session);
  ipcMock.astralAiAgents.mockResolvedValue({ data: [agent] });
  ipcMock.astralAiCreateConversation.mockResolvedValue({ id: 12 });
  ipcMock.astralAiSendMessage.mockResolvedValue({ requestId: 7, status: "RUNNING" });
  ipcMock.astralAiEvents.mockResolvedValue(terminalBatch(""));
  ipcMock.astralAiDeleteConversation.mockResolvedValue(undefined);
});

describe("askServerForPicks", () => {
  it("非管理员直接拒绝：不建会话、不发消息（最后一道闸）", async () => {
    useAuthStore.setState({ profile: { roles: ["APP_USER"], permissions: ["user:ai:music:use"] } });
    await expect(askServerForPicks(request())).rejects.toThrow("服务端 AI 仅管理员可用");
    expect(ipcMock.astralSession).not.toHaveBeenCalled();
    expect(ipcMock.astralAiCreateConversation).not.toHaveBeenCalled();
    expect(ipcMock.astralAiSendMessage).not.toHaveBeenCalled();
  });

  it("没登录时立刻报错，不去建会话", async () => {
    ipcMock.astralSession.mockResolvedValue(null);
    await expect(askServerForPicks(request())).rejects.toThrow("还没有登录服务端");
    expect(ipcMock.astralAiCreateConversation).not.toHaveBeenCalled();
  });

  it("后台没有音乐助手时报错", async () => {
    ipcMock.astralAiAgents.mockResolvedValue({
      data: [{ agentCode: "coder", agentType: "CODE" }],
    });
    await expect(askServerForPicks(request())).rejects.toThrow("后台没有可用的音乐助手");
    expect(ipcMock.astralAiCreateConversation).not.toHaveBeenCalled();
  });

  it("会话创建失败时报错，且不会发消息", async () => {
    ipcMock.astralAiCreateConversation.mockResolvedValue({ id: 0 });
    await expect(askServerForPicks(request())).rejects.toThrow("会话创建失败");
    expect(ipcMock.astralAiSendMessage).not.toHaveBeenCalled();
  });

  it("成功路径：拼系统设定、回传候选、取正文与 song_list、用完删会话", async () => {
    ipcMock.astralAiEvents.mockResolvedValue(
      terminalBatch('{"title":"华语古风","summary":"s","picks":[]}', [candidate("a1", "晴天")]),
    );
    const reply = await askServerForPicks(request());

    expect(reply.content).toContain("华语古风");
    expect(reply.tracks).toHaveLength(1);
    expect(reply.tracks[0].id).toBe("a1");
    expect(reply.tracks[0].title).toBe("晴天");
    expect(reply.model).toBe("小音");

    const content = String(ipcMock.astralAiSendMessage.mock.calls[0]?.[1] ?? "");
    expect(content.startsWith("【系统设定】你是选歌助手")).toBe(true);
    expect(content).toContain("候选清单...");

    const context = ipcMock.astralAiSendMessage.mock.calls[0]?.[2] as {
      musicCandidates: { songId: string }[];
    };
    expect(context.musicCandidates.map((item) => item.songId)).toEqual(["a1", "a2"]);

    expect(ipcMock.astralAiDeleteConversation).toHaveBeenCalledWith(12);
  });

  it("候选池超过 150 首时只回传前 150 首", async () => {
    ipcMock.astralAiEvents.mockResolvedValue(terminalBatch("ok"));
    const pool = Array.from({ length: 160 }, (_, i) => track(`t${i}`, `候选${i}`));
    await askServerForPicks({ ...request(), pool });
    const context = ipcMock.astralAiSendMessage.mock.calls[0]?.[2] as {
      musicCandidates: unknown[];
    };
    expect(context.musicCandidates).toHaveLength(150);
  });

  it("request.failed 事件里的原因要带出来，并仍删除会话", async () => {
    ipcMock.astralAiEvents.mockResolvedValue({
      requestId: 7,
      status: "FAILED",
      events: [{ type: "request.failed", data: { message: "额度用完了" } }],
      nextSequence: 1,
      terminal: true,
    });
    await expect(askServerForPicks(request())).rejects.toThrow("额度用完了");
    expect(ipcMock.astralAiDeleteConversation).toHaveBeenCalled();
  });

  it("message.delta 拼出的正文也算数（增量落库场景）", async () => {
    ipcMock.astralAiEvents.mockResolvedValue({
      requestId: 7,
      status: "COMPLETED",
      events: [
        { type: "message.delta", data: { delta: '{"picks":' } },
        { type: "message.delta", data: { delta: "[]}" } },
      ],
      nextSequence: 2,
      terminal: true,
    });
    const reply = await askServerForPicks(request());
    expect(reply.content).toBe('{"picks":[]}');
  });

  it("终态但什么也没回：报「没有返回内容」，不当成成功", async () => {
    ipcMock.astralAiEvents.mockResolvedValue(terminalBatch(""));
    await expect(askServerForPicks(request())).rejects.toThrow("服务端没有返回内容");
  });

  it("轮询间隔保持 600ms（回归：别把常量改没了）", () => {
    expect(SERVER_PICK_POLL_MS).toBe(600);
  });
});
