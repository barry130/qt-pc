// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  appendLocalMessages,
  clearLocalHistory,
  createLocalConversation,
  listLocalConversations,
  loadLocalMessages,
  removeLocalConversation,
  type LocalHistoryMessage,
} from "@/lib/ai-assistant-history";
import { installMemoryStorage } from "./helpers/memory-storage";

/**
 * 规则 / 本地模式的本地会话历史（`localStorage`）。
 *
 * 2026-10-24 用户反馈「规则模式怎么左边不显示历史对话」：服务端模式有 astral 会话，
 * 本地两种模式没有。这里只守「存得进、读得回、坏数据不炸」这几件与传输无关的事，
 * 真正的侧栏渲染在 `ai-assistant-modes.test.tsx`，hook 集成在 `use-ai-chat-modes.test.tsx`。
 */

const STORAGE_KEY = "quietmusic.ai-assistant.local-history.v1";

const USER_MESSAGE: LocalHistoryMessage = { role: "USER", content: "我想听周杰伦的歌", blocks: [] };
const ASSISTANT_MESSAGE: LocalHistoryMessage = {
  role: "ASSISTANT",
  content: "先挑了 20 首周杰伦的歌。",
  blocks: [
    {
      type: "song_list",
      title: "为你找到的歌",
      data: {
        items: [
          {
            sourceId: "wyy",
            songId: "1",
            name: "晴天",
            artist: "周杰伦",
            album: "叶惠美",
            duration: 269,
            coverUrl: "",
            quality: "",
            extra: {},
          },
        ],
        total: 1,
      },
    },
  ],
};

beforeEach(() => {
  installMemoryStorage();
});

describe("ai-assistant-history（本地会话历史）", () => {
  it("新建会话：返回递增 id，标题取第一句前 20 字", () => {
    const first = createLocalConversation("我想听周杰伦的歌，随便来点古风也行");
    const second = createLocalConversation("换点轻快的");
    expect(first).toBe(1);
    expect(second).toBe(2);
    const [latest, older] = listLocalConversations();
    expect(latest.id).toBe(2);
    expect(older.id).toBe(1);
    // titleOf 压平空白后截到 20 字
    expect(older.title).toBe("我想听周杰伦的歌，随便来点古风也行");
  });

  it("标题为空时给兜底名", () => {
    const id = createLocalConversation("   ");
    expect(listLocalConversations()[0]).toMatchObject({ id, title: "新的对话" });
  });

  it("追加一轮对话后，侧栏条数与最近更新时间跟着变", () => {
    const id = createLocalConversation("来点古风");
    expect(appendLocalMessages(id, [USER_MESSAGE, ASSISTANT_MESSAGE])).toBe(true);
    const [conversation] = listLocalConversations();
    expect(conversation.messageCount).toBe(2);
    expect(conversation.lastMessageTime).not.toBe("");
    expect(conversation.agentCode).toBe("local");
    expect(conversation.agentName).toBe("本地助手");
  });

  it("追加到不存在的会话返回 false，且不写脏数据", () => {
    expect(appendLocalMessages(99, [USER_MESSAGE])).toBe(false);
    expect(listLocalConversations()).toHaveLength(0);
  });

  it("读回消息：重建消息壳（COMPLETED）并保留 song_list 块", () => {
    const id = createLocalConversation("周杰伦");
    appendLocalMessages(id, [USER_MESSAGE, ASSISTANT_MESSAGE]);
    const messages = loadLocalMessages(id);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("USER");
    expect(messages[0].content).toBe("我想听周杰伦的歌");
    expect(messages[0].status).toBe("COMPLETED");
    expect(messages[1].blocks).toHaveLength(1);
    expect(messages[1].blocks[0].type).toBe("song_list");
    const items = (messages[1].blocks[0].data as { items: { name: string }[] }).items;
    expect(items[0].name).toBe("晴天");
  });

  it("读不存在的会话返回空数组", () => {
    expect(loadLocalMessages(42)).toEqual([]);
  });

  it("删除会话：删得掉返回 true，删不存在的返回 false", () => {
    const id = createLocalConversation("古风");
    expect(removeLocalConversation(id)).toBe(true);
    expect(listLocalConversations()).toHaveLength(0);
    expect(removeLocalConversation(id)).toBe(false);
  });

  it("清空历史", () => {
    createLocalConversation("一");
    createLocalConversation("二");
    clearLocalHistory();
    expect(listLocalConversations()).toHaveLength(0);
    // 清空之后新建的 id 重新从 1 起算（避免 localStorage 残留 nextId）
    expect(createLocalConversation("三")).toBe(1);
  });

  it("坏 JSON / 旧结构当空，不抛错", () => {
    window.localStorage.setItem(STORAGE_KEY, "{oops");
    expect(listLocalConversations()).toEqual([]);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ conversations: [{ id: "x" }] }));
    expect(listLocalConversations()).toEqual([]);
  });

  it("会话条数封顶 30 条，只留最近的", () => {
    for (let index = 0; index < 35; index += 1) {
      createLocalConversation(`第 ${index} 条`);
    }
    const conversations = listLocalConversations();
    expect(conversations).toHaveLength(30);
    // 最新的排最前
    expect(conversations[0].title).toBe("第 34 条");
  });

  it("单条会话消息封顶 40 条，只留最后 40 条", () => {
    const id = createLocalConversation("很长的一段");
    const messages = Array.from({ length: 45 }, (_, index) => ({
      role: index % 2 === 0 ? "USER" : "ASSISTANT",
      content: `第 ${index} 条`,
      blocks: [],
    }));
    appendLocalMessages(id, messages);
    const loaded = loadLocalMessages(id);
    expect(loaded).toHaveLength(40);
    expect(loaded[0].content).toBe("第 5 条");
    expect(loaded[39].content).toBe("第 44 条");
  });
});
