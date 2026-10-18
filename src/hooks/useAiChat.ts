/**
 * AI 音乐助手的会话状态机（PC 端）。
 *
 * 与移动端 `qt-uniappx/composables/use-ai-chat.ts` 是同一套行为，只换了运行环境：
 * 移动端直接 `apiRequest`，本端每个动作都是一次 `invoke`（CSP 不允许前端直连后端）。
 *
 * 三个由后端实现决定的硬事实，决定了这个 hook 的形状：
 *
 * 1. **没有 SSE**。`AiAppController` 只给 `GET /requests/{id}/events`，所以推进
 *    方式是按 `nextSequence` 游标的短轮询，直到 `batch.terminal`。轮询间隔取 700ms：
 *    后端事件是 300ms 节奏落库的，再密只是空转 IPC。
 *
 * 2. **模型看不到真实候选**。后端四个搜索工具返回 `NEED_CLIENT` 计划，但编排器
 *    把 `isOk()==true` 的结果按 SUCCEEDED 收尾并继续下一轮模型调用 —— 既不挂起
 *    请求，也不把计划写进事件，更没有回传候选的端点。所以必须在**提交之前**自己
 *    搜索，把候选塞进 `context.musicCandidates`，否则模型只能空谈。
 *
 * 3. **消息先落空壳再流式写入**。`send` 拿到的 `assistantMessageId` 是个空消息，
 *    正文全靠事件填。所以本地气泡要用自己的 `uid` 定位 —— 用下标会在「发完又切
 *    会话」时改错一条。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AiAction,
  AiAgentCard,
  AiCapabilities,
  AiChatMessage,
  AiConversation,
  AiMusicCandidate,
} from "@/lib/ai";
import {
  AI_CANDIDATE_MAX,
  AI_EVENT_BATCH,
  AI_MESSAGE_MAX_CHARS,
  AI_MESSAGE_PAGE_SIZE,
  actionLabel,
  candidateFromTrack,
  emptyCapabilities,
  emptyChatMessage,
  findSong,
  normalizeAgentCard,
  normalizeCapabilities,
  normalizeConversation,
  normalizeEventBatch,
  normalizeMessagePage,
  normalizeSendResult,
  numOf,
  searchKeyword,
  songsOfBlock,
  songsOfMessage,
  strOf,
  titleOf,
  toChatMessage,
  toolProgressLabel,
} from "@/lib/ai";
import { errMsg } from "@/lib/utils";
import { searchAllBatches } from "@/source-scripts";
import * as ipc from "@/services/ipc";
import { registrySourceIds, useSourceRegistryStore } from "@/stores/sourceRegistry";
import { usePlayerStore } from "@/stores/player";
import type { Track } from "@/types";

/** 轮询间隔：后端事件 300ms 节奏落库，再密只是空转 */
const POLL_INTERVAL_MS = 700;

/** 单轮兜底超时：超过就不等了，让用户自己重试（后端 SSE 的超时也是 180s） */
const POLL_MAX_MS = 180_000;

/** 后端事件里 9 个白名单动作中，本 hook 直接执行的那三种 */
const PLAYBACK_ACTIONS: readonly string[] = ["PLAY_SONG", "PLAY_LIST", "ADD_TO_QUEUE"];

/** 智能体没配 suggestions 时的兜底。写法要像用户会说的话，不要像功能说明 */
const DEFAULT_SUGGESTIONS: string[] = [
  "随便来点适合晚上写代码的歌",
  "推荐几首最近很火的国风",
  "我想听周杰伦，但不要情歌",
  "来点适合跑步的快歌",
];

/** 动作执行结果：页面据此决定 toast 什么，以及要不要回报采纳 */
export interface AiActionResult {
  ok: boolean;
  note: string;
}

export interface UseAiChatOptions {
  /** 智能体编码。音乐助手固定 `music_assistant`，但仍由页面传，避免写死 */
  agentCode: string;
  /** 额外上下文（会被后端白名单过滤，塞不进去的键模型看不到） */
  context?: () => Record<string, unknown> | undefined;
}

export interface UseAiChatResult {
  agent: AiAgentCard | null;
  agentName: string;
  capabilities: AiCapabilities;
  conversations: AiConversation[];
  activeConversationId: number;
  messages: AiChatMessage[];
  suggestions: string[];
  loading: boolean;
  loadingMessages: boolean;
  sending: boolean;
  error: string;
  /** 该动作是否由本 hook 直接执行（播放类）；false 的交给页面 */
  canRun: (type: string) => boolean;
  init: () => Promise<void>;
  send: (content: string) => Promise<void>;
  stop: () => Promise<void>;
  newConversation: () => void;
  selectConversation: (id: number) => Promise<void>;
  removeConversation: (id: number) => Promise<void>;
  runAction: (messageUid: string, action: AiAction) => Promise<AiActionResult>;
  feedback: (messageUid: string, good: boolean) => Promise<void>;
}

/** Track → 上下文里的曲目快照（字段与后端 `MusicToolProvider` 读的键一致） */
function trackJson(track: Track): Record<string, unknown> {
  return {
    songId: track.id,
    sourceId: track.platform,
    name: track.title,
    artist: track.singer,
    album: track.album,
    duration: track.duration,
    coverUrl: track.picUrl,
  };
}

export function useAiChat(options: UseAiChatOptions): UseAiChatResult {
  const { agentCode } = options;
  const [agent, setAgent] = useState<AiAgentCard | null>(null);
  const [capabilities, setCapabilities] = useState<AiCapabilities>(emptyCapabilities());
  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState(0);
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const pollTimer = useRef<number | null>(null);
  const pollStartedAt = useRef(0);
  /** 切会话竞态：请求回来时若已切到别的会话，结果直接丢 */
  const loadSeq = useRef(0);
  /** 卸载后不再 setState（轮询回调可能还在飞） */
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (pollTimer.current !== null) {
        window.clearTimeout(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, []);

  /** 按 uid 改某一条气泡；找不到就原样返回（消息可能已被切会话清空） */
  const patch = useCallback((uid: string, fn: (m: AiChatMessage) => AiChatMessage): void => {
    if (!alive.current) return;
    setMessages((prev) => prev.map((m) => (m.uid === uid ? fn(m) : m)));
  }, []);

  const stopPolling = useCallback((): void => {
    if (pollTimer.current !== null) {
      window.clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const loadConversations = useCallback(async (): Promise<void> => {
    try {
      const raw = await ipc.astralAiConversations(agentCode);
      if (!alive.current) return;
      setConversations(listOfConversations(raw));
    } catch {
      // 会话列表拉不到不阻断聊天：发第一条消息时会自动建会话
    }
  }, [agentCode]);

  const init = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError("");
    try {
      const raw = await ipc.astralAiAgents();
      if (!alive.current) return;
      const agents = listOfAgents(raw);
      // 优先按 agentType 找，其次按编码精确匹配 —— 后台可能配了多个音乐助手，
      // 这时列表顺序就是后台的 sort，取第一个即可（顺序是运营意图）
      const picked =
        agents.find((a) => a.agentType === "MUSIC") ??
        agents.find((a) => a.agentCode === agentCode) ??
        null;
      if (picked === null) {
        setError("后台还没有可用的音乐助手，请联系管理员在「AI 助手 → 智能体」里发布");
        setLoading(false);
        return;
      }
      setAgent(picked);
      try {
        const capRaw = await ipc.astralAiCapabilities(picked.agentCode);
        if (!alive.current) return;
        setCapabilities(normalizeCapabilities(capRaw));
      } catch {
        // 能力接口失败就按默认能力走：少个引用/反馈按钮，不该让整页打不开
        setCapabilities(picked.capabilities);
      }
      await loadConversations();
    } catch (err) {
      if (alive.current) setError(errMsg(err));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [agentCode, loadConversations]);

  /** 打开某个会话并拉最近一页消息 */
  const selectConversation = useCallback(
    async (id: number): Promise<void> => {
      stopPolling();
      setSending(false);
      const seq = loadSeq.current + 1;
      loadSeq.current = seq;
      setActiveConversationId(id);
      if (id <= 0) {
        setMessages([]);
        return;
      }
      setLoadingMessages(true);
      setError("");
      try {
        const raw = await ipc.astralAiMessages(id, undefined, AI_MESSAGE_PAGE_SIZE);
        if (!alive.current || loadSeq.current !== seq) return;
        const page = normalizeMessagePage(raw);
        setMessages(page.items.map(toChatMessage));
      } catch (err) {
        if (alive.current && loadSeq.current === seq) setError(errMsg(err));
      } finally {
        if (alive.current && loadSeq.current === seq) setLoadingMessages(false);
      }
    },
    [stopPolling],
  );

  /** 新建：只清本地，真正建会话推迟到首次发送（避免堆一串空会话） */
  const newConversation = useCallback((): void => {
    stopPolling();
    setSending(false);
    setActiveConversationId(0);
    setMessages([]);
    setError("");
  }, [stopPolling]);

  const removeConversation = useCallback(
    async (id: number): Promise<void> => {
      try {
        await ipc.astralAiDeleteConversation(id);
        if (id === activeConversationId) newConversation();
        await loadConversations();
      } catch (err) {
        setError(errMsg(err));
      }
    },
    [activeConversationId, loadConversations, newConversation],
  );

  /**
   * 先在本地搜一轮候选。
   *
   * 这是「AI 排序 + 真能播」的关键：后端只负责意图理解与排序，音频与曲库在客户端。
   * 搜索失败不当成错误 —— 模型仍能靠上下文给建议，只是候选为空。
   */
  const prepareCandidates = useCallback(async (content: string): Promise<AiMusicCandidate[]> => {
    try {
      await useSourceRegistryStore.getState().ensure();
      const keyword = searchKeyword(content);
      if (keyword.length === 0) return [];
      const batches = await searchAllBatches(keyword, 1, AI_CANDIDATE_MAX);
      const out: AiMusicCandidate[] = [];
      const seen = new Set<string>();
      for (const batch of batches) {
        for (const track of batch.tracks) {
          const key = `${track.platform}:${track.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(candidateFromTrack(track));
          if (out.length >= AI_CANDIDATE_MAX) return out;
        }
      }
      return out;
    } catch {
      return [];
    }
  }, []);

  /** 组装上下文：只放后端白名单里的键，放了别的会被 `sanitizeContext` 丢掉 */
  const buildContext = useCallback(
    async (candidates: AiMusicCandidate[]): Promise<Record<string, unknown>> => {
      const ctx: Record<string, unknown> = {};
      const player = usePlayerStore.getState();
      const current = player.state?.track ?? null;
      if (current !== null) ctx.currentSong = trackJson(current);
      const queue = player.queue.slice(0, 10).map(trackJson);
      if (queue.length > 0) ctx.currentQueue = queue;
      const sourceIds = registrySourceIds();
      if (sourceIds.length > 0) ctx.installedSourceRegistry = sourceIds;
      try {
        const history = await ipc.listHistory(8);
        if (Array.isArray(history) && history.length > 0) {
          ctx.recentlyPlayedSummary = history
            .slice(0, 8)
            .map((item) => `${item.track.singer} - ${item.track.title}`);
        }
      } catch {
        // 历史读不到就算了，模型少一点口味参考而已
      }
      if (candidates.length > 0) ctx.musicCandidates = candidates;
      const extra = options.context?.();
      if (extra !== undefined) {
        for (const [key, value] of Object.entries(extra)) ctx[key] = value;
      }
      return ctx;
    },
    [options],
  );

  const applyEvent = useCallback(
    (uid: string, type: string, data: Record<string, unknown> | null): void => {
      switch (type) {
        case "message.started":
          patch(uid, (m) => ({ ...m, streaming: true, status: "STREAMING" }));
          break;
        case "message.delta": {
          // 增量字段是 `delta`，不是 content —— 后端 `ChatResult.StreamListener`
          // 一层层透传下来就这个名字
          const delta = strOf(data, "delta");
          if (delta.length === 0) break;
          patch(uid, (m) => ({
            ...m,
            content: m.content + delta,
            streaming: true,
            progress: "",
          }));
          break;
        }
        case "tool.planned":
        case "tool.started":
          patch(uid, (m) => ({
            ...m,
            progress: toolProgressLabel(strOf(data, "toolCode")),
          }));
          break;
        case "tool.completed":
          patch(uid, (m) => ({ ...m, progress: "" }));
          break;
        case "message.citation":
          patch(uid, (m) => ({ ...m, citations: citeList(data?.citations) }));
          break;
        case "recommendation.updated":
          patch(uid, (m) => ({ ...m, actions: actList(data?.actions) }));
          break;
        case "message.completed":
          patch(uid, (m) => ({
            ...m,
            content: strOf(data, "content"),
            blocks: blockList(data?.blocks),
            actions: actList(data?.actions),
            streaming: false,
            progress: "",
            status: "COMPLETED",
            id: numOf(data, "messageId") > 0 ? numOf(data, "messageId") : m.id,
          }));
          break;
        case "request.failed":
          patch(uid, (m) => ({
            ...m,
            streaming: false,
            progress: "",
            status: "FAILED",
            error: strOf(data, "message"),
          }));
          break;
        case "request.cancelled":
          patch(uid, (m) => ({
            ...m,
            streaming: false,
            progress: "",
            status: "CANCELLED",
            content: m.content.length > 0 ? m.content : "已停止",
          }));
          break;
        default:
          break;
      }
    },
    [patch],
  );

  /** 终态收尾：空回答也要给一句人话，别留个空气泡 */
  const finalize = useCallback(
    (uid: string, status: string): void => {
      patch(uid, (m) => {
        const next = { ...m, streaming: false, progress: "" };
        if (status.length > 0 && status !== "FAILED" && status !== "CANCELLED") {
          next.status = status;
        }
        if (next.content.length === 0 && next.blocks.length === 0) {
          if (next.status === "CANCELLED") next.content = "已停止";
          else if (next.status === "FAILED") next.content = next.error || "这次没有跑通，再试一次看看";
          else next.content = "没有拿到回答，换个说法再试试";
        }
        return next;
      });
    },
    [patch],
  );

  const startPolling = useCallback(
    (requestId: number, uid: string): void => {
      stopPolling();
      pollStartedAt.current = Date.now();
      let cursor = 0;
      const tick = async (): Promise<void> => {
        pollTimer.current = null;
        if (!alive.current) return;
        if (Date.now() - pollStartedAt.current > POLL_MAX_MS) {
          patch(uid, (m) => ({
            ...m,
            streaming: false,
            progress: "",
            status: "FAILED",
            error: "等待超时，请稍后重试",
          }));
          finalize(uid, "FAILED");
          setSending(false);
          return;
        }
        try {
          const raw = await ipc.astralAiEvents(requestId, cursor, AI_EVENT_BATCH);
          if (!alive.current) return;
          const batch = normalizeEventBatch(raw);
          if (batch.nextSequence > cursor) cursor = batch.nextSequence;
          for (const event of batch.events) {
            applyEvent(uid, event.type, event.data);
          }
          if (batch.terminal) {
            finalize(uid, batch.status);
            setSending(false);
            void loadConversations();
            return;
          }
        } catch (err) {
          // 单次轮询失败不终止：网络抖一下不该把正在生成的回答作废
          if (alive.current) setError(errMsg(err));
        }
        pollTimer.current = window.setTimeout(() => {
          void tick();
        }, POLL_INTERVAL_MS);
      };
      void tick();
    },
    [applyEvent, finalize, loadConversations, patch, stopPolling],
  );

  const send = useCallback(
    async (content: string): Promise<void> => {
      const text = content.trim();
      if (text.length === 0 || sending) return;
      if (text.length > AI_MESSAGE_MAX_CHARS) {
        setError(`消息太长了（上限 ${AI_MESSAGE_MAX_CHARS} 字），请分几次说`);
        return;
      }
      setSending(true);
      setError("");
      const userMsg = emptyChatMessage("USER", text);
      userMsg.status = "COMPLETED";
      const assistantMsg = emptyChatMessage("ASSISTANT", "");
      assistantMsg.streaming = true;
      assistantMsg.status = "STREAMING";
      assistantMsg.progress = "正在理解你的需求…";
      const uid = assistantMsg.uid;
      setMessages((prev) => [...prev, userMsg, assistantMsg]);

      try {
        const candidates = await prepareCandidates(text);
        let conversationId = activeConversationId;
        if (conversationId <= 0) {
          const raw = await ipc.astralAiCreateConversation(agentCode, titleOf(text));
          const created = normalizeConversation(raw);
          conversationId = created.id;
          if (conversationId <= 0) throw new Error("会话创建失败，请重试");
          setActiveConversationId(conversationId);
        }
        const ctx = await buildContext(candidates);
        const idempotencyKey = `pc-${Date.now()}-${uid}`;
        const sent = normalizeSendResult(
          await ipc.astralAiSendMessage(conversationId, text, ctx, idempotencyKey),
        );
        patch(uid, (m) => ({
          ...m,
          requestId: sent.requestId,
          id: sent.assistantMessageId,
          progress: "正在生成回答…",
        }));
        void loadConversations();
        startPolling(sent.requestId, uid);
      } catch (err) {
        const message = errMsg(err);
        patch(uid, (m) => ({
          ...m,
          streaming: false,
          progress: "",
          status: "FAILED",
          error: message,
          content: m.content.length > 0 ? m.content : `请求失败：${message}`,
        }));
        setSending(false);
      }
    },
    [
      activeConversationId,
      agentCode,
      buildContext,
      loadConversations,
      patch,
      prepareCandidates,
      sending,
      startPolling,
    ],
  );

  /**
   * 停止生成。
   *
   * 后端 `cancel` 是幂等的（已终态直接回现状），所以这里不判状态直接发；
   * 本地立刻停轮询并置 CANCELLED，不干等下一轮事件 —— 用户按了停止就该马上停。
   */
  const stop = useCallback(async (): Promise<void> => {
    const streaming = [...messages].reverse().find((m) => m.streaming);
    stopPolling();
    setSending(false);
    if (streaming === undefined) return;
    patch(streaming.uid, (m) => ({
      ...m,
      streaming: false,
      progress: "",
      status: "CANCELLED",
      content: m.content.length > 0 ? m.content : "已停止",
    }));
    if (streaming.requestId > 0) {
      try {
        await ipc.astralAiCancelRequest(streaming.requestId, "用户停止");
      } catch {
        // 已终态或网络抖动都不影响本地已经停下的状态
      }
    }
  }, [messages, patch, stopPolling]);

  /** 执行播放类动作；回报后端只报真执行了的（不支持的不报，否则采纳率是假的） */
  const runAction = useCallback(
    async (messageUid: string, action: AiAction): Promise<AiActionResult> => {
      const message = messages.find((m) => m.uid === messageUid);
      if (message === undefined) return { ok: false, note: "这条消息已经不在当前会话里了" };
      const payload = action.payload;
      const songId = strOf(payload, "songId");
      const sourceId = strOf(payload, "sourceId");

      let result: AiActionResult;
      if (action.type === "PLAY_SONG") {
        const track = findSong(message, songId, sourceId);
        if (track === null) {
          result = { ok: false, note: "推荐里没有这首歌的可用条目" };
        } else {
          await usePlayerStore.getState().play(track);
          result = { ok: true, note: `正在播放《${track.title}》` };
        }
      } else if (action.type === "PLAY_LIST") {
        const songs = songsOfMessage(message);
        if (songs.length === 0) {
          result = { ok: false, note: "这条推荐里没有可播放的歌曲" };
        } else {
          await usePlayerStore.getState().playQueue(songs, 0);
          result = { ok: true, note: `已开始播放 ${songs.length} 首` };
        }
      } else if (action.type === "ADD_TO_QUEUE") {
        const track = findSong(message, songId, sourceId);
        if (track === null) {
          result = { ok: false, note: "推荐里没有这首歌的可用条目" };
        } else {
          await ipc.queueAppend([track]);
          result = { ok: true, note: `已加入队列：${track.title}` };
        }
      } else {
        result = { ok: false, note: `这个操作请在界面上完成：${actionLabel(action.type)}` };
      }

      if (result.ok) {
        try {
          await ipc.astralAiExecuteAction(action.actionId, action.type, true, result.note);
        } catch {
          // 回报失败不影响用户已经听到的歌
        }
      }
      return result;
    },
    [messages],
  );

  const feedback = useCallback(
    async (messageUid: string, good: boolean): Promise<void> => {
      const message = messages.find((m) => m.uid === messageUid);
      if (message === undefined || message.id <= 0) return;
      try {
        await ipc.astralAiFeedback(message.id, good ? "LIKE" : "DISLIKE", "", "");
      } catch (err) {
        setError(errMsg(err));
      }
    },
    [messages],
  );

  const canRun = useCallback((type: string): boolean => PLAYBACK_ACTIONS.includes(type), []);

  const suggestions = ((): string[] => {
    const entry = agent?.entryConfig ?? null;
    if (entry !== null) {
      const raw = entry.suggestions;
      if (Array.isArray(raw)) {
        const out = raw.filter((item): item is string => typeof item === "string" && item.length > 0);
        if (out.length > 0) return out.slice(0, 6);
      }
    }
    return DEFAULT_SUGGESTIONS;
  })();

  return {
    agent,
    agentName: agent?.name ?? "音乐助手",
    capabilities,
    conversations,
    activeConversationId,
    messages,
    suggestions,
    loading,
    loadingMessages,
    sending,
    error,
    canRun,
    init,
    send,
    stop,
    newConversation,
    selectConversation,
    removeConversation,
    runAction,
    feedback,
  };
}

// ---------- 下面几个小工具只服务于本文件 ----------

function listOfAgents(raw: unknown): AiAgentCard[] {
  const list = Array.isArray(raw) ? raw : [];
  return list.map(normalizeAgentCard);
}

function listOfConversations(raw: unknown): AiConversation[] {
  const list = Array.isArray(raw) ? raw : [];
  return list.map(normalizeConversation);
}

function citeList(raw: unknown): AiChatMessage["citations"] {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((item) => {
    const r = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return {
      sourceId: numOf(r, "sourceId"),
      sourceType: strOf(r, "sourceType"),
      title: strOf(r, "title"),
      path: strOf(r, "path"),
      section: strOf(r, "section"),
      version: strOf(r, "version"),
      matchedText: strOf(r, "matchedText"),
    };
  });
}

function blockList(raw: unknown): AiChatMessage["blocks"] {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((item) => {
    const r = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const data = r.data;
    return {
      type: strOf(r, "type"),
      title: strOf(r, "title"),
      data:
        data !== null && typeof data === "object" && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : null,
    };
  });
}

function actList(raw: unknown): AiAction[] {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((item) => {
    const r = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const payload = r.payload;
    return {
      actionId: strOf(r, "actionId"),
      type: strOf(r, "type"),
      payload:
        payload !== null && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : null,
    };
  });
}

/** 取某一块候选里的曲目（页面「播放这一块」用） */
export function songsOfBlockAt(message: AiChatMessage, blockIndex: number): Track[] {
  const block = message.blocks[blockIndex];
  if (block === undefined) return [];
  return songsOfBlock(block);
}
