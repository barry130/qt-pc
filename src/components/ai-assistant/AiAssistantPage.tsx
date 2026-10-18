import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  Loader2,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useAiChat } from "@/hooks/useAiChat";
import type { AiAction } from "@/lib/ai";
import { statusText } from "@/lib/ai";
import { errMsg, cn } from "@/lib/utils";
import { toastError, toastSuccess } from "@/stores/toast";
import { usePlayerStore } from "@/stores/player";
import * as ipc from "@/services/ipc";
import type { Track } from "@/types";
import { MessageBubble } from "./MessageBubble";

/**
 * 音乐助手页（路由 `/ai-assistant`，侧边栏「音乐助手」）。
 *
 * 与移动端 `pages/ai-assistant/index.uvue` 是同一套功能：同样的会话列表、
 * 同样的候选卡与动作、同样的停止/反馈。差别只在呈现 —— 桌面宽屏能一次
 * 摊开会话列表，所以这里做成左右两栏而不是抽屉。
 *
 * 没有自己实现任何「理解」逻辑：意图、排序、推荐理由全在后端智能体里，
 * 本页只负责三件事 —— 把用户的话送上去、把事件折成气泡、把动作变成播放。
 * 这样后台换 Prompt / 换模型 / 换工具，这一页一行都不用改。
 */
export function AiAssistantPage(): React.JSX.Element {
  const chat = useAiChat({ agentCode: "music_assistant" });
  const [draft, setDraft] = useState("");
  const [historyOpen, setHistoryOpen] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const { init } = chat;

  useEffect(() => {
    void init();
  }, [init]);

  // 贴底才滚动：用户往上翻历史时不该被拽回来
  useEffect(() => {
    const box = scrollRef.current;
    if (box === null) return;
    const distance = box.scrollHeight - box.scrollTop - box.clientHeight;
    if (distance > 220) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [chat.messages]);

  const empty = chat.messages.length === 0;
  const canSend = draft.trim().length > 0 && !chat.sending;

  const submit = (): void => {
    if (!canSend) return;
    const text = draft;
    setDraft("");
    void chat.send(text);
  };

  const playTrack = (track: Track): void => {
    void usePlayerStore
      .getState()
      .play(track)
      .catch((err: unknown) => toastError(errMsg(err)));
  };

  const queueTrack = (track: Track): void => {
    void ipc
      .queueAppend([track])
      .then(() => toastSuccess(`已加入队列：${track.title}`))
      .catch((err: unknown) => toastError(errMsg(err)));
  };

  const playBlock = (tracks: Track[]): void => {
    if (tracks.length === 0) return;
    void usePlayerStore
      .getState()
      .playQueue(tracks, 0)
      .catch((err: unknown) => toastError(errMsg(err)));
  };

  const runAction = (messageUid: string, action: AiAction): void => {
    void chat.runAction(messageUid, action).then((result) => {
      if (result.ok) toastSuccess(result.note);
      else toastError(result.note);
    });
  };

  return (
    <div className="flex h-full min-w-0">
      {/* 会话列表：桌面宽屏常驻，窄屏折叠 */}
      <aside
        className={cn(
          "flex shrink-0 flex-col border-r border-border bg-card/30 transition-[width]",
          historyOpen ? "w-[200px]" : "w-0 overflow-hidden border-r-0",
        )}
      >
        <div className="flex items-center gap-1.5 px-2.5 py-2.5">
          <span className="text-xs font-medium">会话</span>
          <button
            type="button"
            title="新建对话"
            aria-label="新建对话"
            onClick={() => {
              chat.newConversation();
              setDraft("");
            }}
            className="ml-auto rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {chat.conversations.length === 0 ? (
            <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">
              还没有会话
            </div>
          ) : (
            chat.conversations.map((item) => (
              <ConversationRow
                key={item.id}
                active={item.id === chat.activeConversationId}
                title={item.title.length > 0 ? item.title : "未命名会话"}
                count={item.messageCount}
                onSelect={() => void chat.selectConversation(item.id)}
                onRemove={() => void chat.removeConversation(item.id)}
              />
            ))
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <button
            type="button"
            title={historyOpen ? "收起会话列表" : "展开会话列表"}
            aria-label={historyOpen ? "收起会话列表" : "展开会话列表"}
            onClick={() => setHistoryOpen((v) => !v)}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            {historyOpen ? (
              <PanelLeftClose className="h-4 w-4" />
            ) : (
              <PanelLeftOpen className="h-4 w-4" />
            )}
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              <span className="truncate text-sm font-semibold">{chat.agentName}</span>
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              说一句想听什么，我来找歌并介绍；歌单与播放都在本机完成
            </div>
          </div>
          <span className="ml-auto shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">
            {chat.agent?.agentCode ?? "music_assistant"}
          </span>
        </div>

        {chat.error.length > 0 ? (
          <div className="mx-4 mt-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {chat.error}
          </div>
        ) : null}

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            {chat.loading ? (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>正在准备…</span>
              </div>
            ) : empty ? (
              <EmptyState
                title="想听点什么？"
                hint="说个歌手、心情或场景都行。我会从已安装的音源里找歌，再挑几首说明理由。"
                suggestions={chat.suggestions}
                onPick={(text) => void chat.send(text)}
              />
            ) : (
              <>
                {chat.messages.map((message) => (
                  <MessageBubble
                    key={message.uid}
                    message={message}
                    canRun={chat.canRun}
                    onAction={(action) => runAction(message.uid, action)}
                    onPlayTrack={playTrack}
                    onQueueTrack={queueTrack}
                    onPlayBlock={playBlock}
                    feedbackEnabled={chat.capabilities.feedbackEnabled}
                    onFeedback={(good) => void chat.feedback(message.uid, good)}
                  />
                ))}
                {chat.loadingMessages ? (
                  <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>正在载入历史…</span>
                  </div>
                ) : null}
              </>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="border-t border-border px-4 py-3">
          <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={1}
              placeholder="想听什么？Enter 发送，Shift+Enter 换行"
              className="max-h-32 min-h-9 flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/60"
            />
            {chat.sending ? (
              <button
                type="button"
                title="停止生成"
                aria-label="停止生成"
                onClick={() => void chat.stop()}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-background text-foreground transition-colors hover:bg-secondary"
              >
                <Pause className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                title="发送"
                aria-label="发送"
                disabled={!canSend}
                onClick={submit}
                className={cn(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-opacity",
                  canSend
                    ? "bg-primary text-primary-foreground hover:opacity-90"
                    : "cursor-not-allowed bg-secondary text-muted-foreground",
                )}
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            )}
          </div>
          <div className="mx-auto mt-1.5 w-full max-w-3xl text-[10px] text-muted-foreground">
            回答由后台配置的智能体生成，推荐结果请以自己的听感为准。
          </div>
        </div>
      </div>
    </div>
  );
}

function ConversationRow(props: {
  active: boolean;
  title: string;
  count: number;
  onSelect: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-lg px-2 py-1.5 transition-colors",
        props.active ? "bg-primary/10 text-primary" : "hover:bg-secondary/60",
      )}
    >
      <button
        type="button"
        onClick={props.onSelect}
        title={props.title}
        className="min-w-0 flex-1 truncate text-left text-xs"
      >
        {props.title}
      </button>
      {props.count > 0 ? (
        <span className="shrink-0 text-[10px] text-muted-foreground group-hover:hidden">
          {props.count}
        </span>
      ) : null}
      <button
        type="button"
        title="删除会话"
        aria-label={`删除会话：${props.title}`}
        onClick={props.onRemove}
        className="hidden shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive group-hover:block"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

function EmptyState(props: {
  title: string;
  hint: string;
  suggestions: string[];
  onPick: (text: string) => void;
}): React.JSX.Element {
  const picks = useMemo(() => props.suggestions.slice(0, 4), [props.suggestions]);
  return (
    <div className="flex flex-col items-center gap-4 py-14 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <Sparkles className="h-6 w-6" />
      </div>
      <div>
        <div className="text-base font-semibold">{props.title}</div>
        <div className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
          {props.hint}
        </div>
      </div>
      <div className="flex w-full max-w-lg flex-col gap-1.5">
        {picks.map((text) => (
          <button
            key={text}
            type="button"
            onClick={() => props.onPick(text)}
            className="flex items-center gap-2 rounded-xl border border-border bg-card/50 px-3 py-2 text-left text-xs transition-colors hover:border-primary/40 hover:bg-card/80"
          >
            <Check className="h-3.5 w-3.5 shrink-0 text-primary/70" />
            <span className="min-w-0 flex-1 truncate">{text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** 供页面顶部展示状态用（当前未使用，保留以免 statusText 变成死导出） */
export const aiStatusText = statusText;
