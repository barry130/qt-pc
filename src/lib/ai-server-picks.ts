/**
 * 每日推荐的「服务端 AI」取数：借音乐助手的 astral 会话跑一次就扔。
 *
 * 为什么单独一个文件：
 * 1. `daily-recommend.ts` 只关心「候选池 → 挑中哪几首」，会话这个动作不是推荐逻辑；
 * 2. 这里只依赖 `@/services/ipc` 与 `@/lib/ai`，不反向 import 推荐模块（否则两者
 *    循环引用，打包/测试都会踩坑）。提示词与回执解析仍由 `daily-recommend.ts` 负责。
 *
 * 一轮的流程与 `useAiChat` 的发送完全一致：建会话 → 发一条消息 → 轮询事件到终态
 * → 后台会话用完即删。首次进入要建会话，多几次网络往返是可预期的。
 */

import * as ipc from "@/services/ipc";
import {
  candidateFromTrack,
  listOf,
  normalizeAgentCard,
  normalizeConversation,
  normalizeEventBatch,
  normalizeSendResult,
  songsOfBlock,
  type AiAgentCard,
} from "@/lib/ai";
import type { Track } from "@/types";
import { isAdmin, useAuthStore } from "@/stores/auth";

/** 一次服务端精选最多等多久（服务端回答通常十几秒，留足余量） */
export const SERVER_PICK_TIMEOUT_MS = 90_000;
/** 轮询间隔：与音乐助手保持一致 */
export const SERVER_PICK_POLL_MS = 600;

export interface ServerPickRequest {
  /** 候选池：既回传给后端做上下文，也用于把 `song_list` 块还原成曲目 */
  pool: Track[];
  /** `buildPrompt()` 的产物（system + user），按顺序拼成一条消息发出去 */
  messages: { role: "system" | "user"; content: string }[];
  timeoutMs?: number;
}

export interface ServerPickReply {
  /** 助手终态正文（可能是 JSON，也可能是人话 —— 解析在调用方做） */
  content: string;
  /** 助手在 `song_list` 块里实际给出的曲目（正文解析失败时用） */
  tracks: Track[];
  /** 智能体名字，给页面显示「服务端 AI · xxx」 */
  model: string;
}

/** 取一个可用的音乐助手（后台可能配了多个，列表顺序是运营意图，取第一个） */
async function pickAgent(): Promise<AiAgentCard> {
  const raw = await ipc.astralAiAgents();
  const agents = listOf(raw, normalizeAgentCard);
  const agent =
    agents.find((item) => item.agentType === "MUSIC") ??
    agents.find((item) => item.agentCode === "music_assistant") ??
    null;
  if (agent === null) throw new Error("后台没有可用的音乐助手");
  return agent;
}

/**
 * 跑一轮服务端精选。
 *
 * 失败一律抛错，由 `generateDailyRecommend` 决定是否退回规则 —— 这里不做静默兜底，
 * 否则「服务端 AI」到底有没有生效用户根本看不出来。
 */
export async function askServerForPicks(request: ServerPickRequest): Promise<ServerPickReply> {
  // 最后一道闸（defense in depth）：「服务端 AI」只对管理员开放（2026-10-24）。
  // 调用方（每日推荐 / 设置页 / hook）已经各自降级过一次，但这里是真正建会话、
  // 花服务端额度的地方，所以再判一次 —— 不靠 UI 的显隐当权限。
  if (!isAdmin(useAuthStore.getState().profile)) {
    throw new Error("服务端 AI 仅管理员可用");
  }
  const session = await ipc.astralSession();
  if (session === null) throw new Error("还没有登录服务端，请先登录再试");

  const agent = await pickAgent();
  const created = normalizeConversation(
    await ipc.astralAiCreateConversation(agent.agentCode, "每日推荐"),
  );
  if (created.id <= 0) throw new Error("会话创建失败");

  try {
    const content = request.messages
      .map((message) =>
        message.role === "system" ? `【系统设定】${message.content}` : message.content,
      )
      .join("\n\n");
    const context: Record<string, unknown> = {
      // 后端按白名单取候选（`MusicToolProvider.candidates()` 同款字段），
      // 与音乐助手 `buildContext` 用同一个转换，别手搓字段名。
      musicCandidates: request.pool.slice(0, 150).map((track) => candidateFromTrack(track)),
    };
    const sent = normalizeSendResult(
      await ipc.astralAiSendMessage(
        created.id,
        content,
        context,
        `pc-daily-${Date.now()}-${created.id}`,
      ),
    );

    const timeoutMs = request.timeoutMs ?? SERVER_PICK_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let cursor = 0;
    let reply = "";
    let tracks: Track[] = [];

    while (Date.now() < deadline) {
      const batch = normalizeEventBatch(await ipc.astralAiEvents(sent.requestId, cursor, 100));
      if (batch.nextSequence > cursor) cursor = batch.nextSequence;
      for (const event of batch.events) {
        const data = event.data;
        if (event.type === "request.failed") {
          throw new Error(typeof data?.message === "string" ? data.message : "服务端处理失败");
        }
        if (event.type === "request.cancelled") throw new Error("服务端取消了这次请求");
        if (event.type === "message.completed") {
          reply = typeof data?.content === "string" ? data.content : reply;
          const blocks = data?.blocks;
          if (Array.isArray(blocks)) {
            tracks = blocks.flatMap((block) => songsOfBlock(block));
          }
        } else if (event.type === "message.delta" && typeof data?.delta === "string") {
          reply += data.delta;
        }
      }
      if (batch.terminal) {
        if (batch.status === "FAILED") throw new Error("服务端处理失败");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, SERVER_PICK_POLL_MS));
    }

    if (reply.trim().length === 0 && tracks.length === 0) {
      throw new Error("服务端没有返回内容（可能超时）");
    }
    return { content: reply, tracks, model: agent.name || "服务端 AI" };
  } finally {
    // 会话是一次性的：不删会在用户的音乐助手会话列表里堆一坨「每日推荐」
    await ipc.astralAiDeleteConversation(created.id).catch(() => undefined);
  }
}
