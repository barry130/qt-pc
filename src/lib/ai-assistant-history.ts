/**
 * 规则 / 本地模式的会话历史（本地持久化，不经过服务端）。
 *
 * 为什么需要：2026-10-24 用户反馈「规则模式怎么左边不显示历史对话」—— 服务端模式的
 * 会话存在 astral 服务端，规则 / 本地模式压根没有可拉的会话列表。这里用 localStorage
 * 存最近若干条本地对话，结构尽量对齐 `AiConversation`，页面侧栏不用为两种模式写两套渲染。
 *
 * 只存「能重放」的东西：角色、正文、结构化块（`song_list` 里带候选曲目），不存 uid /
 * 请求号这类一次性字段 —— 重新打开时用 `emptyChatMessage` 重建消息壳。
 *
 * 为什么封顶：localStorage 是同步 API、容量有限，而且历史只是「找回来接着聊」的辅助；
 * 留 30 条会话 × 40 条消息已经够用，再多只会拖慢 `useAiChat` 的初始化。
 */
import {
  emptyChatMessage,
  titleOf,
  type AiBlock,
  type AiChatMessage,
  type AiConversation,
} from "@/lib/ai";

const STORAGE_KEY = "quietmusic.ai-assistant.local-history.v1";
const MAX_CONVERSATIONS = 30;
const MAX_MESSAGES_PER_CONVERSATION = 40;

/** 本地会话在侧栏里的展示名（与 astral 智能体区分开） */
const LOCAL_AGENT_CODE = "local";
const LOCAL_AGENT_NAME = "本地助手";

/** 一条可重放的消息（`song_list` 块的曲目都在 `blocks[].data.items` 里） */
export interface LocalHistoryMessage {
  role: string;
  content: string;
  blocks: AiBlock[];
}

interface StoredConversation {
  id: number;
  title: string;
  createTime: string;
  lastMessageTime: string;
  messages: LocalHistoryMessage[];
}

interface StoredHistory {
  nextId: number;
  conversations: StoredConversation[];
}

function emptyStore(): StoredHistory {
  return { nextId: 1, conversations: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toBlock(value: unknown): AiBlock | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  return {
    type: value.type,
    title: typeof value.title === "string" ? value.title : "",
    data: isRecord(value.data) ? value.data : null,
  };
}

function toMessage(value: unknown): LocalHistoryMessage | null {
  if (!isRecord(value) || typeof value.content !== "string") return null;
  const role = value.role === "USER" || value.role === "user" ? "USER" : "ASSISTANT";
  const blocks = Array.isArray(value.blocks)
    ? value.blocks.map(toBlock).filter((block): block is AiBlock => block !== null)
    : [];
  return { role, content: value.content, blocks };
}

function toConversation(value: unknown): StoredConversation | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "number" || value.id <= 0) return null;
  if (typeof value.title !== "string") return null;
  const messages = Array.isArray(value.messages)
    ? value.messages.map(toMessage).filter((message): message is LocalHistoryMessage => message !== null)
    : [];
  return {
    id: value.id,
    title: value.title,
    createTime: typeof value.createTime === "string" ? value.createTime : "",
    lastMessageTime: typeof value.lastMessageTime === "string" ? value.lastMessageTime : "",
    messages: messages.slice(-MAX_MESSAGES_PER_CONVERSATION),
  };
}

function readStore(): StoredHistory {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyStore();
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return emptyStore();
    const conversations = Array.isArray(parsed.conversations)
      ? parsed.conversations
          .map(toConversation)
          .filter((conversation): conversation is StoredConversation => conversation !== null)
      : [];
    const maxId = conversations.reduce((max, conversation) => Math.max(max, conversation.id), 0);
    const nextId =
      typeof parsed.nextId === "number" && parsed.nextId > maxId ? parsed.nextId : maxId + 1;
    return { nextId, conversations };
  } catch {
    // 坏数据（手改过 / 旧版本结构）直接当空，不反复报错
    return emptyStore();
  }
}

function writeStore(store: StoredHistory): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // 存满了 / 隐私模式禁写：历史只是辅助，失败不打断对话
  }
}

/** 侧栏用的会话摘要（按最近更新时间倒序，与服务端列表一致） */
export function listLocalConversations(): AiConversation[] {
  return readStore()
    .conversations.map((conversation) => ({
      id: conversation.id,
      agentCode: LOCAL_AGENT_CODE,
      agentName: LOCAL_AGENT_NAME,
      title: conversation.title,
      status: "ACTIVE",
      messageCount: conversation.messages.length,
      pinned: false,
      lastMessageTime: conversation.lastMessageTime,
      createTime: conversation.createTime,
    }))
    // 时间相同（同一毫秒内连点「新建」/刚建好还没发消息）时按 id 倒序兜底：
    // 否则排序会不稳定，侧栏里最新那条可能被挤到中间
    .sort((a, b) => b.lastMessageTime.localeCompare(a.lastMessageTime) || b.id - a.id);
}

/** 读一条本地会话的消息（用于点侧栏切回去） */
export function loadLocalMessages(id: number): AiChatMessage[] {
  const conversation = readStore().conversations.find((item) => item.id === id);
  if (!conversation) return [];
  return conversation.messages.map((stored) => {
    const message = emptyChatMessage(stored.role, stored.content);
    message.status = "COMPLETED";
    message.blocks = stored.blocks;
    return message;
  });
}

/** 新建一条本地会话（标题取第一句话的前 20 字；空标题给兜底） */
export function createLocalConversation(title: string, now = new Date()): number {
  const store = readStore();
  const time = now.toISOString();
  const id = store.nextId;
  const cleanTitle = titleOf(title) || "新的对话";
  store.conversations.unshift({
    id,
    title: cleanTitle,
    createTime: time,
    lastMessageTime: time,
    messages: [],
  });
  store.nextId = id + 1;
  store.conversations = store.conversations.slice(0, MAX_CONVERSATIONS);
  writeStore(store);
  return id;
}

/** 追加一轮对话（用户 + 助手），返回是否写到已有会话上 */
export function appendLocalMessages(id: number, messages: readonly LocalHistoryMessage[]): boolean {
  const store = readStore();
  const conversation = store.conversations.find((item) => item.id === id);
  if (!conversation) return false;
  conversation.messages = [...conversation.messages, ...messages].slice(
    -MAX_MESSAGES_PER_CONVERSATION,
  );
  conversation.lastMessageTime = new Date().toISOString();
  writeStore(store);
  return true;
}

/** 删一条本地会话，返回是否真删掉 */
export function removeLocalConversation(id: number): boolean {
  const store = readStore();
  const next = store.conversations.filter((conversation) => conversation.id !== id);
  if (next.length === store.conversations.length) return false;
  writeStore({ nextId: store.nextId, conversations: next });
  return true;
}

/** 清空本地历史（设置页的「清空」入口与测试用） */
export function clearLocalHistory(): void {
  writeStore(emptyStore());
}
