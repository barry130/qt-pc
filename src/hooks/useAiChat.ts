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
  AiBlock,
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
  isFollowUpWithoutTopic,
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
  trackFromCandidate,
} from "@/lib/ai";
import { errMsg } from "@/lib/utils";
import { AI_MODE_HINT, readAiMode, resolveAiMode, type AiEngineMode } from "@/lib/ai-mode";
import { runAssistantTurn, type LocalAssistantMode } from "@/lib/ai-assistant-local";
import {
  appendLocalMessages,
  createLocalConversation,
  listLocalConversations,
  loadLocalMessages,
  removeLocalConversation,
} from "@/lib/ai-assistant-history";
import { searchAllBatches } from "@/source-scripts";
import { readAggregateSources } from "@/lib/aggregate-sources";
import * as ipc from "@/services/ipc";
import { registrySourceIds, useSourceRegistryStore } from "@/stores/sourceRegistry";
import { isAdmin, useAuthStore } from "@/stores/auth";
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
  /** 全局 AI 模式（`rule` / `local` 走本地回合，`server` 走 astral 会话） */
  mode: AiEngineMode;
  /** 当前模式的说明，页面横幅用 */
  modeHint: string;
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
  // context 单独解构出来做依赖：options 是每渲染的新字面量，整个对象进 deps
  // 会让 buildContext（连带 send）每渲染重建。当前唯一调用方
  // AiAssistantPage 不传 context（恒为 undefined），身份天然稳定。
  const { agentCode, context } = options;
  const [agent, setAgent] = useState<AiAgentCard | null>(null);
  const [capabilities, setCapabilities] = useState<AiCapabilities>(emptyCapabilities());
  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState(0);
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  /**
   * `sending` 的同步影子。state 要等下一次渲染才生效，而 `send` 在置位之前还要
   * `await readAiMode()`：连按两次回车（或按钮双击）会两条一起穿过 `if (sending)`
   * 的检查，发出两遍同样的消息（P1 缺陷，2026-10-29 修）。所有改 sending 的地方
   * 统一走 `commitSending`，保证 ref 与 state 不脱节。
   */
  const sendingRef = useRef(false);
  const commitSending = useCallback((next: boolean): void => {
    sendingRef.current = next;
    setSending(next);
  }, []);
  const [error, setError] = useState("");
  /** 全局 AI 模式：每次发送前从库里重读，设置页改了不用重进页面 */
  const [mode, setMode] = useState<AiEngineMode>("rule");
  /**
   * 当前账号能不能用「服务端 AI」（2026-10-24 起管理员专属）。
   *
   * 订阅 store 而不是只在 send 时取快照：AppShell 恢复登录态是异步的，
   * profile 从 null 变成管理员时 `init` 的依赖会变，页面里的 `useEffect(init)`
   * 会自己重跑一次 —— 否则管理员会一直停在「纯规则」直到手动刷新。
   */
  const profile = useAuthStore((s) => s.profile);
  const canUseServer = isAdmin(profile);

  const pollTimer = useRef<number | null>(null);
  const pollStartedAt = useRef(0);
  /** 切会话竞态：请求回来时若已切到别的会话，结果直接丢 */
  const loadSeq = useRef(0);
  /** 上一轮候选搜索用的关键词与页码：追问（「再来点」）时沿用主题、往后翻页 */
  const lastSearchKeyword = useRef("");
  const lastSearchPage = useRef(1);
  /** 本地回合序号：停止/重发/切会话时递增，让在途结果回来时自己作废（本地没有
   * 请求 id 可以取消，模型调用也不一定响应 abort） */
  const localSeq = useRef(0);
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

  /** 当前会话 id 的镜像：`sendLocal` 的闭包里拿不到最新 state，用它把这一轮写回历史 */
  const activeConversationRef = useRef(0);

  useEffect(() => {
    activeConversationRef.current = activeConversationId;
  }, [activeConversationId]);

  /**
   * messages 的镜像（与 activeConversationRef 同款）：sendLocal / stop / runAction /
   * feedback 只读「最近几条」，若 deps 直接含 messages，流式期间每 300ms 一批
   * delta 就把四个 useCallback 全部重建，消费它们的 memo 组件跟着一起失效。
   */
  const messagesRef = useRef<AiChatMessage[]>([]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

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
      // 库里可能存着「服务端 AI」但当前账号不是管理员（老版本或换号登录）：
      // 统一收敛成有效模式，非管理员不会走到下面拉 astral 智能体的分支。
      const nextMode = resolveAiMode(await readAiMode(), canUseServer);
      if (!alive.current) return;
      setMode(nextMode);
      // rule / local 不碰服务端：不拉智能体、不拉远端会话；侧栏改读本地历史
      if (nextMode !== "server") {
        if (alive.current) setConversations(listLocalConversations());
        return;
      }
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
      // 能力与会话列表互不依赖（各自内部都有 alive/try-catch 兜底）：并行拉，
      // 不再串行各等一遍
      const loadCaps = async (): Promise<void> => {
        try {
          const capRaw = await ipc.astralAiCapabilities(picked.agentCode);
          if (!alive.current) return;
          setCapabilities(normalizeCapabilities(capRaw));
        } catch {
          // 能力接口失败就按默认能力走：少个引用/反馈按钮，不该让整页打不开
          setCapabilities(picked.capabilities);
        }
      };
      await Promise.all([loadCaps(), loadConversations()]);
    } catch (err) {
      if (alive.current) setError(errMsg(err));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [agentCode, canUseServer, loadConversations]);

  /** 打开某个会话并拉最近一页消息 */
  const selectConversation = useCallback(
    async (id: number): Promise<void> => {
      stopPolling();
      commitSending(false);
      const seq = loadSeq.current + 1;
      loadSeq.current = seq;
      setActiveConversationId(id);
      if (id <= 0) {
        setMessages([]);
        return;
      }
      // 规则 / 本地模式的历史在 localStorage 里：同步读，不走 IPC
      if (mode !== "server") {
        setLoadingMessages(false);
        setMessages(loadLocalMessages(id));
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
    [commitSending, mode, stopPolling],
  );

  /** 新建：只清本地，真正建会话推迟到首次发送（避免堆一串空会话） */
  const newConversation = useCallback((): void => {
    stopPolling();
    commitSending(false);
    setActiveConversationId(0);
    setMessages([]);
    setError("");
  }, [commitSending, stopPolling]);

  const removeConversation = useCallback(
    async (id: number): Promise<void> => {
      // 本地历史没有远端会话可删：直接清 localStorage 并刷新侧栏
      if (mode !== "server") {
        removeLocalConversation(id);
        if (id === activeConversationId) newConversation();
        setConversations(listLocalConversations());
        return;
      }
      try {
        await ipc.astralAiDeleteConversation(id);
        if (id === activeConversationId) newConversation();
        await loadConversations();
      } catch (err) {
        setError(errMsg(err));
      }
    },
    [activeConversationId, loadConversations, mode, newConversation],
  );

  /**
   * 先在本地搜一轮候选。
   *
   * 这是「AI 排序 + 真能播」的关键：后端只负责意图理解与排序，音频与曲库在客户端。
   * 搜索失败不当成错误 —— 模型仍能靠上下文给建议，只是候选为空。
   */
  const prepareCandidates = useCallback(async (content: string): Promise<AiMusicCandidate[]> => {
    try {
      const keyword = searchKeyword(content);
      // 「再来点/换一批」这类追问没有新主题词：用退化词（如「来20首」）重搜只会
      // 捞回与上一轮主题无关的垃圾候选。沿用上一轮搜索词，把候选池往前翻页。
      const isFollowUp = isFollowUpWithoutTopic(content, keyword);
      const effective = isFollowUp && lastSearchKeyword.current.length > 0
        ? lastSearchKeyword.current
        : keyword;
      if (effective.length === 0) return [];
      const page = isFollowUp ? lastSearchPage.current + 1 : 1;
      if (!isFollowUp) {
        lastSearchKeyword.current = keyword;
      }
      lastSearchPage.current = page;
      // 聚合音源由设置决定（null = 全部）；AI 找歌和搜索页共用同一份选择。
      // 它与音源注册表 ensure() 互不依赖：并行等待，不再串行各等一遍
      const [aggSources] = await Promise.all([
        readAggregateSources(),
        useSourceRegistryStore.getState().ensure(),
      ]);
      const batches = await searchAllBatches(effective, page, AI_CANDIDATE_MAX, aggSources ?? undefined);
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
      // 翻页翻到底（没有新歌）：退回第 1 页补齐，宁多勿空
      if (out.length === 0 && page > 1) {
        lastSearchPage.current = 1;
        const first = await searchAllBatches(effective, 1, AI_CANDIDATE_MAX, aggSources ?? undefined);
        for (const batch of first) {
          for (const track of batch.tracks) {
            const key = `${track.platform}:${track.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(candidateFromTrack(track));
            if (out.length >= AI_CANDIDATE_MAX) return out;
          }
        }
      }
      return out;
    } catch {
      return [];
    }
  }, []);

  /**
   * 本地回合：`rule` / `local` 共用。
   *
   * 与 server 模式的区别只有「谁挑歌」：候选仍由本地搜（`prepareCandidates`），
   * 但不再创建 astral 会话、不轮询事件。本地回合没有请求 id 可取消，用 `localSeq`
   * 让「停止 / 重发 / 切会话」之后回来的结果自己作废。
   */
  const sendLocal = useCallback(
    async (localMode: LocalAssistantMode, text: string): Promise<void> => {
      commitSending(true);
      setError("");
      const seq = localSeq.current + 1;
      localSeq.current = seq;
      const userMsg = emptyChatMessage("USER", text);
      userMsg.status = "COMPLETED";
      const assistantMsg = emptyChatMessage("ASSISTANT", "");
      assistantMsg.streaming = true;
      assistantMsg.status = "STREAMING";
      assistantMsg.progress =
        localMode === "local" ? "正在让本地模型挑歌…" : "正在按规则挑歌…";
      const uid = assistantMsg.uid;
      // 历史快照在本轮两条消息入列**之前**取：与原先读闭包 messages 等价（text 已
      // 单独传给模型，不能把当前问题再塞进 history 重复一遍）。改读 messagesRef
      // 是为了让 deps 摆脱 messages —— 流式期间每 300ms 一批 delta 都会重建本回调
      const history = messagesRef.current
        .slice(-6)
        .map((m) => ({
          role: (m.role === "USER" ? "user" : "assistant") as "user" | "assistant",
          content: m.content,
        }))
        .filter((item) => item.content.trim().length > 0);
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      try {
        const candidates = await prepareCandidates(text);
        if (!alive.current || localSeq.current !== seq) return;
        patch(uid, (m) => ({ ...m, progress: "正在整理歌单…" }));
        const result = await runAssistantTurn({
          mode: localMode,
          text,
          history,
          candidates: candidates.map(trackFromCandidate),
          // 口味画像在这里留空：助手的主任务是听懂「这句话要找什么」，每条消息再读
          // 一遍收藏 / 歌单 / 收听统计太重；要按口味排有每日推荐页。
          profile: null,
        });
        if (!alive.current || localSeq.current !== seq) return;
        // 助手页的播放条依赖 `song_list` 块（MessageBubble 从 `data.items` 还原 Track），
        // 所以本地结果也必须造成这个形状，而不是直接塞 Track[]。
        const blocks: AiBlock[] =
          result.songs.length > 0
            ? [
                {
                  type: "song_list",
                  title: "为你找到的歌",
                  data: {
                    items: result.songs.map((track) => candidateFromTrack(track)),
                    total: result.songs.length,
                  },
                },
              ]
            : [];
        patch(uid, (m) => ({
          ...m,
          content: result.reply,
          blocks,
          streaming: false,
          progress: "",
          status: "COMPLETED",
        }));
        // 规则 / 本地模式没有服务端会话：把这一轮写进本地历史，左侧「历史对话」才有内容
        const conversationId =
          activeConversationRef.current > 0
            ? activeConversationRef.current
            : createLocalConversation(text);
        if (activeConversationRef.current !== conversationId) {
          activeConversationRef.current = conversationId;
          setActiveConversationId(conversationId);
        }
        appendLocalMessages(conversationId, [
          { role: "USER", content: text, blocks: [] },
          { role: "ASSISTANT", content: result.reply, blocks },
        ]);
        setConversations(listLocalConversations());
      } catch (err) {
        const message = errMsg(err);
        patch(uid, (m) => ({
          ...m,
          streaming: false,
          progress: "",
          status: "FAILED",
          error: message,
          content: m.content.length > 0 ? m.content : `出错了：${message}`,
        }));
      } finally {
        if (alive.current && localSeq.current === seq) commitSending(false);
      }
    },
    [commitSending, patch, prepareCandidates],
  );

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
      const extra = context?.();
      if (extra !== undefined) {
        for (const [key, value] of Object.entries(extra)) ctx[key] = value;
      }
      return ctx;
    },
    [context],
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

  /**
   * 终态兜底：拿服务端落库的最终消息覆盖本地气泡。
   *
   * <p>正常路径下 {@code message.completed} 已经把 answer 与 blocks 带回来了。
   * 但事件是分批拉的，任何原因导致终态事件没读到时，气泡里剩下的就是流式增量
   * 拼出来的半截原始 JSON —— 文案与歌曲卡片全无，用户只会看到一坨括号。
   * 服务端 `ai_message` 里存的一定是解析后的干净结果，所以终态后回读一次最保险。</p>
   *
   * <p>只在「内容像 JSON」或「有回答却没有任何块」时回读，避免每条消息多打一次请求。</p>
   */
  const reconcile = useCallback(
    async (conversationId: number, assistantMessageId: number, uid: string): Promise<void> => {
      if (conversationId <= 0 || assistantMessageId <= 0) return;
      try {
        const raw = await ipc.astralAiMessages(conversationId, undefined, AI_MESSAGE_PAGE_SIZE);
        if (!alive.current) return;
        const page = normalizeMessagePage(raw);
        const saved = page.items.find((item) => item.id === assistantMessageId);
        if (saved === undefined) return;
        patch(uid, (m) => {
          const content = saved.content.length > 0 ? saved.content : m.content;
          // 服务端存的是解析后的正文；本地若还是原始 JSON，一律以服务端为准
          return {
            ...m,
            content,
            blocks: saved.blocks.length > 0 ? saved.blocks : m.blocks,
            citations: saved.citations.length > 0 ? saved.citations : m.citations,
          };
        });
      } catch {
        // 回读失败不影响已经显示的内容
      }
    },
    [patch],
  );

  const startPolling = useCallback(
    (requestId: number, uid: string, conversationId: number, assistantMessageId: number): void => {
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
          commitSending(false);
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
            commitSending(false);
            // 终态后回读落库消息：万一终态事件没读到，本地还是半截 JSON
            void reconcile(conversationId, assistantMessageId, uid).then(() => loadConversations());
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
    [applyEvent, commitSending, finalize, loadConversations, patch, reconcile, stopPolling],
  );

  const send = useCallback(
    async (content: string): Promise<void> => {
      const text = content.trim();
      // 用同步 ref 判重：`sending` state 在这一刻可能还是 false（上一条刚发出、
      // 渲染尚未提交），光看 state 挡不住连击。
      if (text.length === 0 || sendingRef.current) return;
      if (text.length > AI_MESSAGE_MAX_CHARS) {
        setError(`消息太长了（上限 ${AI_MESSAGE_MAX_CHARS} 字），请分几次说`);
        return;
      }
      // 立刻落闩：下面 `await readAiMode()` 期间第二次回车会直接返回。
      // 复位由 sendLocal 的 finally / 服务端分支的 catch / stop 统一负责。
      sendingRef.current = true;
      // 设置页可能刚改过模式：每次发送都以库里的值为准，用户不用重进页面。
      // 但「服务端 AI」是管理员专属，非管理员一律降级成纯规则（本地回合）。
      let currentMode: AiEngineMode;
      try {
        currentMode = resolveAiMode(await readAiMode(), canUseServer);
      } catch (err) {
        // 读设置失败不能让门闩一直锁着：否则之后再点发送全都被静默吞掉。
        sendingRef.current = false;
        setError(errMsg(err));
        return;
      }
      if (!alive.current) {
        sendingRef.current = false;
        return;
      }
      setMode(currentMode);
      if (currentMode !== "server") {
        await sendLocal(currentMode, text);
        return;
      }
      commitSending(true);
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
        // 候选搜索（全源聚合，链路最慢）与建会话互不依赖：并行发出，AI 首字
        // 等待从两者之和降到 max(两者)。buildContext 合并 ctx.musicCandidates
        // 时才需要候选结果，仍排在 Promise.all 之后 —— 消息流与错误语义不变
        // （prepareCandidates 内部自 catch 永不 reject；建会话失败照旧走外层 catch）
        const candidatesPromise = prepareCandidates(text);
        const conversationIdPromise =
          activeConversationId > 0
            ? Promise.resolve(activeConversationId)
            : ipc.astralAiCreateConversation(agentCode, titleOf(text)).then((raw) => {
                const created = normalizeConversation(raw);
                if (created.id <= 0) throw new Error("会话创建失败，请重试");
                setActiveConversationId(created.id);
                return created.id;
              });
        const [candidates, conversationId] = await Promise.all([
          candidatesPromise,
          conversationIdPromise,
        ]);
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
        startPolling(sent.requestId, uid, conversationId, sent.assistantMessageId);
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
        commitSending(false);
      }
    },
    [
      activeConversationId,
      agentCode,
      buildContext,
      canUseServer,
      commitSending,
      loadConversations,
      patch,
      prepareCandidates,
      sendLocal,
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
    const streaming = [...messagesRef.current].reverse().find((m) => m.streaming);
    stopPolling();
    // 本地回合没有可取消的远端请求：递增序号，在途结果回来时直接丢掉
    localSeq.current += 1;
    commitSending(false);
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
  }, [commitSending, patch, stopPolling]);

  /** 执行播放类动作；回报后端只报真执行了的（不支持的不报，否则采纳率是假的） */
  const runAction = useCallback(
    async (messageUid: string, action: AiAction): Promise<AiActionResult> => {
      const message = messagesRef.current.find((m) => m.uid === messageUid);
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

      // 只有服务端模式才有采纳回报：本地模式没有会话，回报无处可去
      if (result.ok && mode === "server") {
        try {
          await ipc.astralAiExecuteAction(action.actionId, action.type, true, result.note);
        } catch {
          // 回报失败不影响用户已经听到的歌
        }
      }
      return result;
    },
    [mode],
  );

  const feedback = useCallback(
    async (messageUid: string, good: boolean): Promise<void> => {
      const message = messagesRef.current.find((m) => m.uid === messageUid);
      if (message === undefined || message.id <= 0) return;
      try {
        await ipc.astralAiFeedback(message.id, good ? "LIKE" : "DISLIKE", "", "");
      } catch (err) {
        setError(errMsg(err));
      }
    },
    [],
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
    mode,
    modeHint: AI_MODE_HINT[mode],
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
