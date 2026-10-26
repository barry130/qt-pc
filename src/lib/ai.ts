/**
 * AI 音乐助手数据层（类型 / 规整 / 纯函数）。
 *
 * 对齐后端 astral-plugin AI 模块的 App 端接口（`/api/v1/app/ai/**`）：
 * - Rust 的 `AstralClient` 已经把 `QtRestResp` 外壳剥掉，这里拿到的是 `data`；
 * - 字段可空的位置一律规整成带默认值的完整对象，页面免空判断；
 * - 与移动端（qt-uniappx types/ai.ts + services/ai.ts）同一套口径，**字段名不许
 *   分叉**：两端看的是同一份后端事件与消息体。
 *
 * 两条由后端实现决定的硬约束（不是取舍，详见 `AiChatOrchestrator`）：
 *
 * 1. **App 端没有 SSE**。`AiAppController` 只给 `GET /requests/{id}/events`，
 *    推进方式是短轮询 + 游标 `nextSequence`，收到 `terminal=true` 停止。
 *
 * 2. **模型看不到真实候选**。`MusicToolProvider` 的四个搜索工具返回
 *    `NEED_CLIENT` 计划，但编排器把 `isOk()==true` 的结果按 SUCCEEDED 收尾并继续
 *    下一轮模型调用 —— 既不挂起请求，也不把计划写进事件，更没有回传候选的端点。
 *    所以客户端必须在**提交之前**自己搜索，把候选放进 `context.musicCandidates`。
 */
import type { Track } from "@/types";
import {
  asArray as arr,
  asBoolean as bool,
  asNumber as num,
  asRecord,
  asRecordOrNull as objOrNull,
  asString as str,
} from "@/lib/coerce";

/** 默认拉取的历史消息条数（后端 AiConversationService.DEFAULT_PAGE_SIZE = 30） */
export const AI_MESSAGE_PAGE_SIZE = 30;

/** 单轮事件批量上限（后端 AiAppDtos.MAX_EVENT_BATCH = 500；太小会让轮询次数暴涨） */
export const AI_EVENT_BATCH = 100;

/** 消息正文软上限（后端 MAX_MESSAGE_CHARS = 200000，这里卡在更友好的长度） */
export const AI_MESSAGE_MAX_CHARS = 4000;

/** 回传候选上限（后端 MusicToolProvider.MAX_CANDIDATES_TO_MODEL = 30） */
export const AI_CANDIDATE_MAX = 30;

// ==================== 类型 ====================

/** 智能体能力（`AiAppDtos.Capabilities`） */
export interface AiCapabilities {
  conversationEnabled: boolean;
  feedbackEnabled: boolean;
  fileContextEnabled: boolean;
  userContextEnabled: boolean;
  citationRequired: boolean;
  musicActionsEnabled: boolean;
  clientType: string;
}

/** 客户端可见的智能体卡片（`AiAppDtos.AgentCard`） */
export interface AiAgentCard {
  agentCode: string;
  name: string;
  agentType: string;
  description: string;
  icon: string;
  entryConfig: Record<string, unknown> | null;
  capabilities: AiCapabilities;
}

/** 会话（`AiAppDtos.ConversationVo`） */
export interface AiConversation {
  id: number;
  agentCode: string;
  agentName: string;
  title: string;
  status: string;
  messageCount: number;
  pinned: boolean;
  lastMessageTime: string;
  createTime: string;
}

/** 引用来源（`AiAppDtos.Citation`） */
export interface AiCitation {
  sourceId: number;
  sourceType: string;
  title: string;
  path: string;
  section: string;
  version: string;
  matchedText: string;
}

/** 结构化块（`AiAppDtos.Block`）：type 是后端登记的类型，data 是原样落库的对象 */
export interface AiBlock {
  type: string;
  title: string;
  data: Record<string, unknown> | null;
}

/** 白名单动作（`AiAppDtos.ActionVo`）：type 只可能是后端 9 个之一 */
export interface AiAction {
  actionId: string;
  type: string;
  payload: Record<string, unknown> | null;
}

/** 后端消息（`AiAppDtos.MessageVo`） */
export interface AiMessage {
  id: number;
  conversationId: number;
  requestId: number;
  role: string;
  content: string;
  contentType: string;
  status: string;
  blocks: AiBlock[];
  citations: AiCitation[];
  modelName: string;
  createTime: string;
}

/** 历史消息分页（`AiAppDtos.MessagePage`） */
export interface AiMessagePage {
  items: AiMessage[];
  nextCursor: number;
  hasMore: boolean;
}

/** 发消息受理结果（`AiAppDtos.SendMessageResp`） */
export interface AiSendResult {
  requestId: number;
  userMessageId: number;
  assistantMessageId: number;
  status: string;
  stream: boolean;
}

/** 单条事件（`AiAppDtos.EventVo`） */
export interface AiEvent {
  requestId: number;
  sequence: number;
  type: string;
  data: Record<string, unknown> | null;
  createdAt: string;
}

/** 一轮事件（`AiAppDtos.EventBatch`） */
export interface AiEventBatch {
  requestId: number;
  status: string;
  events: AiEvent[];
  nextSequence: number;
  terminal: boolean;
}

/**
 * 回传给后端的候选（`AiAppDtos.MusicCandidate`）。
 *
 * `duration` 是**秒**（后端按数字取，不做单位换算）；`sourceId` 是音源 id，
 * `songId` 是音源内 id —— 两者合起来才唯一。
 */
export interface AiMusicCandidate {
  sourceId: string;
  songId: string;
  name: string;
  artist: string;
  album: string;
  duration: number;
  coverUrl: string;
  quality: string;
  extra: Record<string, unknown> | null;
}

/**
 * 页面用的消息（后端消息 + 本地流式态）。
 *
 * `uid` 是本地稳定键：流式期间消息还没拿到后端 id，用它定位要改哪一条，
 * 避免「按下标改」在并发/切会话时改错气泡。
 */
export interface AiChatMessage {
  uid: string;
  id: number;
  role: string;
  content: string;
  status: string;
  blocks: AiBlock[];
  citations: AiCitation[];
  actions: AiAction[];
  streaming: boolean;
  progress: string;
  requestId: number;
  createTime: string;
  error: string;
}

// ==================== 规整工具 ====================
// str/num/bool/asRecord/objOrNull/arr 的实现已合并到 `@/lib/coerce`
// （strict 族：只认 typeof，不认就给默认值）。这里只留别名，调用处不用改。

/** 取对象里的字符串字段（事件 data 用） */
export function strOf(source: Record<string, unknown> | null, key: string): string {
  if (source === null) return "";
  return str(source[key]);
}

/** 取对象里的数字字段（事件 data 用） */
export function numOf(source: Record<string, unknown> | null, key: string): number {
  if (source === null) return 0;
  return num(source[key]);
}

// ==================== 规整函数 ====================

export function normalizeCapabilities(raw: unknown): AiCapabilities {
  const r = asRecord(raw);
  return {
    conversationEnabled: bool(r.conversationEnabled, true),
    feedbackEnabled: bool(r.feedbackEnabled, false),
    fileContextEnabled: bool(r.fileContextEnabled, false),
    userContextEnabled: bool(r.userContextEnabled, true),
    citationRequired: bool(r.citationRequired, false),
    musicActionsEnabled: bool(r.musicActionsEnabled, false),
    clientType: str(r.clientType, "QT_PC"),
  };
}

export function emptyCapabilities(): AiCapabilities {
  return {
    conversationEnabled: true,
    feedbackEnabled: false,
    fileContextEnabled: false,
    userContextEnabled: true,
    citationRequired: false,
    musicActionsEnabled: false,
    clientType: "QT_PC",
  };
}

export function normalizeAgentCard(raw: unknown): AiAgentCard {
  const r = asRecord(raw);
  return {
    agentCode: str(r.agentCode),
    name: str(r.name),
    agentType: str(r.agentType),
    description: str(r.description),
    icon: str(r.icon),
    entryConfig: objOrNull(r.entryConfig),
    capabilities: normalizeCapabilities(r.capabilities),
  };
}

export function normalizeConversation(raw: unknown): AiConversation {
  const r = asRecord(raw);
  return {
    id: num(r.id),
    agentCode: str(r.agentCode),
    agentName: str(r.agentName),
    title: str(r.title),
    status: str(r.status),
    messageCount: num(r.messageCount),
    pinned: bool(r.pinned, false),
    lastMessageTime: str(r.lastMessageTime),
    createTime: str(r.createTime),
  };
}

export function normalizeCitation(raw: unknown): AiCitation {
  const r = asRecord(raw);
  return {
    sourceId: num(r.sourceId),
    sourceType: str(r.sourceType),
    title: str(r.title),
    path: str(r.path),
    section: str(r.section),
    version: str(r.version),
    matchedText: str(r.matchedText),
  };
}

export function normalizeBlock(raw: unknown): AiBlock {
  const r = asRecord(raw);
  return {
    type: str(r.type),
    title: str(r.title),
    data: objOrNull(r.data),
  };
}

export function normalizeAction(raw: unknown): AiAction {
  const r = asRecord(raw);
  return {
    actionId: str(r.actionId),
    type: str(r.type),
    payload: objOrNull(r.payload),
  };
}

export function normalizeMessage(raw: unknown): AiMessage {
  const r = asRecord(raw);
  return {
    id: num(r.id),
    conversationId: num(r.conversationId),
    requestId: num(r.requestId),
    role: str(r.role),
    content: str(r.content),
    contentType: str(r.contentType),
    status: str(r.status),
    blocks: arr(r.blocks).map(normalizeBlock),
    citations: arr(r.citations).map(normalizeCitation),
    modelName: str(r.modelName),
    createTime: str(r.createTime),
  };
}

export function normalizeMessagePage(raw: unknown): AiMessagePage {
  const r = asRecord(raw);
  return {
    items: arr(r.items).map(normalizeMessage),
    nextCursor: num(r.nextCursor),
    hasMore: bool(r.hasMore, false),
  };
}

export function normalizeSendResult(raw: unknown): AiSendResult {
  const r = asRecord(raw);
  return {
    requestId: num(r.requestId),
    userMessageId: num(r.userMessageId),
    assistantMessageId: num(r.assistantMessageId),
    status: str(r.status),
    // App 端没有 SSE，`stream` 只表示「后端会流式落库」，不是「本端能收流」
    stream: bool(r.stream, true),
  };
}

export function normalizeEvent(raw: unknown): AiEvent {
  const r = asRecord(raw);
  return {
    requestId: num(r.requestId),
    sequence: num(r.sequence),
    type: str(r.type),
    data: objOrNull(r.data),
    createdAt: str(r.createdAt),
  };
}

export function normalizeEventBatch(raw: unknown): AiEventBatch {
  const r = asRecord(raw);
  return {
    requestId: num(r.requestId),
    status: str(r.status),
    events: arr(r.events).map(normalizeEvent),
    nextSequence: num(r.nextSequence),
    terminal: bool(r.terminal, false),
  };
}

/** 数组型响应：直接数组，或被包在 `data` 里（不同网关行为）都认 */
export function listOf<T>(raw: unknown, map: (item: unknown) => T): T[] {
  if (Array.isArray(raw)) return raw.map(map);
  const inner = asRecord(raw).data;
  return Array.isArray(inner) ? inner.map(map) : [];
}

// ==================== 候选 ↔ Track ====================

/**
 * 本端 `Track` → 后端候选。
 *
 * 字段名与后端 `MusicToolProvider.candidates()` 严格一致：`sourceId` ← 音源 id，
 * `songId` ← 音源内 id。PC 端曲目字段是 `title`（移动端是 `name`），别搞混。
 */
export function candidateFromTrack(track: Track, quality = ""): AiMusicCandidate {
  return {
    sourceId: track.platform,
    songId: track.id,
    name: track.title,
    artist: track.singer,
    album: track.album,
    duration: typeof track.duration === "number" ? track.duration : 0,
    coverUrl: track.picUrl,
    quality,
    extra: null,
  };
}

/** 候选 → 本端 `Track`（动作里只带 songId/sourceId，播放时要还原成完整对象） */
export function trackFromCandidate(c: AiMusicCandidate): Track {
  return {
    id: c.songId,
    platform: c.sourceId,
    title: c.name,
    singer: c.artist,
    album: c.album,
    picUrl: c.coverUrl,
    duration: c.duration > 0 ? c.duration : 0,
  };
}

/** 块里的 item（候选对象）→ Track；缺 songId 视为无效 */
function trackOfItem(item: unknown): Track | null {
  const r = asRecord(item);
  const songId = str(r.songId);
  if (songId.length === 0) return null;
  return trackFromCandidate({
    sourceId: str(r.sourceId),
    songId,
    name: str(r.name),
    artist: str(r.artist),
    album: str(r.album),
    duration: num(r.duration),
    coverUrl: str(r.coverUrl),
    quality: str(r.quality),
    extra: objOrNull(r.extra),
  });
}

/**
 * 把 `song_list` 块的 `data.items` 还原成 Track 列表。
 *
 * 块的 data 是后端原样落库的候选对象；不认识的块类型返回空数组，
 * 页面就只显示标题，不会渲染出半截卡片。
 */
export function songsOfBlock(block: AiBlock): Track[] {
  const data = block.data;
  if (data === null) return [];
  const items = arr(data.items);
  const out: Track[] = [];
  for (const item of items) {
    const track = trackOfItem(item);
    if (track !== null) out.push(track);
  }
  return out;
}

/** 某条消息里所有 song_list 块的曲目（按出现顺序，用于「播放全部」） */
export function songsOfMessage(message: AiChatMessage): Track[] {
  const out: Track[] = [];
  for (const block of message.blocks) {
    if (block.type !== "song_list") continue;
    for (const track of songsOfBlock(block)) out.push(track);
  }
  return out;
}

/**
 * 在**本条消息**的候选里按 songId（+可选 sourceId）找歌。
 *
 * 不跨消息找：拿历史会话里的旧对象去播会播到一个可能已下架的条目，
 * 而且模型给的 songId 本来也只属于它自己那轮候选。
 */
export function findSong(
  message: AiChatMessage,
  songId: string,
  sourceId: string,
): Track | null {
  if (songId.length === 0) return null;
  for (const block of message.blocks) {
    if (block.type !== "song_list") continue;
    const data = block.data;
    if (data === null) continue;
    for (const item of arr(data.items)) {
      const r = asRecord(item);
      if (str(r.songId) !== songId) continue;
      const candidateSource = str(r.sourceId);
      if (sourceId.length > 0 && candidateSource !== sourceId) continue;
      return trackOfItem(item);
    }
  }
  return null;
}

// ==================== 纯函数（页面与 hook 共用） ====================

let uidSeq = 0;

/** 造一条本地消息壳（uid 自增且进程内唯一） */
export function emptyChatMessage(role: string, content: string): AiChatMessage {
  uidSeq += 1;
  return {
    uid: `local-${uidSeq}`,
    id: 0,
    role,
    content,
    status: "PENDING",
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

/** 后端消息 → 本地消息 */
export function toChatMessage(m: AiMessage): AiChatMessage {
  const out = emptyChatMessage(m.role, m.content);
  out.id = m.id;
  out.status = m.status;
  out.blocks = m.blocks;
  out.citations = m.citations;
  out.requestId = m.requestId;
  out.createTime = m.createTime;
  return out;
}

/** 会话标题：用户第一句话的前 20 字 */
export function titleOf(content: string): string {
  const t = content.replace(/\s+/g, " ").trim();
  return t.length > 20 ? t.substring(0, 20) : t;
}

/** 搜索词清洗用的意图词：留在关键词里只会拉低命中率 */
const FILLER_WORDS: string[] = [
  "帮我",
  "帮忙",
  "给我",
  "我要",
  "我想",
  "想听",
  "推荐",
  "来一首",
  "来几首",
  "来点",
  "几首",
  "一首",
  "播放",
  "放一首",
  "找一下",
  "找找",
  "搜索",
  "搜一下",
  "有没有",
  "什么歌",
  "的歌",
  "歌曲",
  "听听",
  "适合",
];

/**
 * 从自然语言里抽搜索词。
 *
 * 不做分词（没有可靠的中文分词器，引一个只为切词的依赖不值）：先去标点，
 * 再摘掉常见意图词，剩下的是「歌手 / 风格 / 心情」这些真正进搜索引擎的词。
 * 全被摘空时回落原文 —— 宁可搜得宽，也不能不搜。
 */
export function searchKeyword(content: string): string {
  let text = content.replace(/[，。！？、,.!?~～;；:：\-—()（）"“”'‘’]+/g, " ");
  for (const word of FILLER_WORDS) {
    text = text.split(word).join(" ");
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text.length === 0) text = content.replace(/\s+/g, " ").trim();
  return text.length > 40 ? text.substring(0, 40) : text;
}

/**
 * 追问检测：用户这轮话里有没有新的音乐主题词。
 *
 * 「再来点」「换一批」「还有吗」「多来几首」这类追问抽不出主题词
 * （searchKeyword 后只剩「再/一批/更多」这种量词），继续用它们搜索只会
 * 捞回与上一轮主题无关的垃圾结果。此时应复用上一轮的搜索词拉更多候选，
 * 而不是用退化词重新搜。返回 true 表示该沿用上一轮主题。
 */
export function isFollowUpWithoutTopic(content: string, keyword: string): boolean {
  const original = content.replace(/\s+/g, "");
  if (original.length > 8) return false;
  const followUps = [
    "再来点",
    "再来几首",
    "再找点",
    "再推荐",
    "换一批",
    "换一组",
    "还有吗",
    "多来点",
    "多来几首",
    "继续",
    "更多",
    "不够",
    "就这些吗",
    "还有别的吗",
  ];
  for (const phrase of followUps) {
    if (original.includes(phrase)) return true;
  }
  // 抽出来的词只剩量词/数字（「来20首」→「20首」）也算追问
  const stripped = keyword.replace(/[0-90-9０-９首fdsb]+/gi, "").trim();
  return stripped.length === 0 && keyword.length > 0;
}

/** 工具编码 → 进行中的中文提示 */
export function toolProgressLabel(toolCode: string): string {
  if (
    toolCode === "search_music" ||
    toolCode === "search_artist" ||
    toolCode === "search_album" ||
    toolCode === "search_playlist"
  ) {
    return "正在搜索音乐…";
  }
  if (toolCode === "get_song_detail") return "正在看这首歌的详情…";
  if (toolCode === "get_current_song" || toolCode === "get_current_playlist") {
    return "正在读当前播放…";
  }
  if (toolCode === "get_user_likes" || toolCode === "get_play_history") {
    return "正在参考你的口味…";
  }
  return "正在处理…";
}

/** 动作类型中文（后端 `AiConstants.ActionType` 的 9 个白名单值） */
export function actionLabel(type: string): string {
  switch (type) {
    case "PLAY_SONG":
      return "播放";
    case "PLAY_LIST":
      return "播放全部";
    case "ADD_TO_QUEUE":
      return "加入队列";
    case "ADD_TO_FAVORITE":
      return "收藏";
    case "OPEN_SONG":
      return "查看歌曲";
    case "OPEN_ARTIST":
      return "查看歌手";
    case "OPEN_ALBUM":
      return "查看专辑";
    case "OPEN_PLAYLIST":
      return "查看歌单";
    case "SEARCH_MUSIC":
      return "换个搜索";
    default:
      return "操作";
  }
}

/** 请求/消息状态中文（与后台字典 ai_request_status 的 value 对应） */
export function statusText(status: string): string {
  switch (status) {
    case "QUEUED":
      return "排队中";
    case "RUNNING":
      return "思考中";
    case "WAITING_TOOL":
      return "等待工具";
    case "WAITING_APPROVAL":
      return "等待确认";
    case "SUCCEEDED":
      return "已完成";
    case "FAILED":
      return "失败";
    case "CANCELLED":
      return "已停止";
    default:
      return "";
  }
}
