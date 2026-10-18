import { useMemo, useState } from "react";
import { Heart, ListPlus, Loader2, MoreHorizontal, Play, Sparkles, ThumbsDown, ThumbsUp } from "lucide-react";
import type { AiAction, AiBlock, AiChatMessage, AiCitation } from "@/lib/ai";
import { actionLabel, songsOfBlock, statusText } from "@/lib/ai";
import { qtresCoverUrl } from "@/lib/lrc";
import { useFavoritesStore } from "@/stores/favorites";
import { useFavoriteFlags } from "@/hooks/useFavoriteFlags";
import { CollectMenu } from "@/components/mine/CollectMenu";
import { Popover } from "@/components/common/Popover";
import { cn } from "@/lib/utils";
import type { Track } from "@/types";
import { AnswerText } from "./AnswerText";

/**
 * 一条消息气泡。
 *
 * 三件事刻意分开：
 * - 用户在右、助手在左（一眼分清谁说的，不用读头像）
 * - 正文 / 候选卡 / 引用 / 动作按后端给的顺序渲染，不猜结构
 * - 动作按钮只负责「emit 出去」，播放与会话状态都在 hook 里 —— 气泡本身无副作用
 */
export function MessageBubble(props: {
  message: AiChatMessage;
  /** 能否执行某个动作类型（不支持时按钮置灰并给 title 说明） */
  canRun: (type: string) => boolean;
  onAction: (action: AiAction) => void;
  onPlayTrack: (track: Track) => void;
  onQueueTrack: (track: Track) => void;
  onPlayBlock: (tracks: Track[]) => void;
  onFeedback?: (good: boolean) => void;
  feedbackEnabled: boolean;
}): React.JSX.Element {
  const { message } = props;
  const mine = message.role === "USER";
  const [voted, setVoted] = useState<"" | "LIKE" | "DISLIKE">("");
  const status = statusText(message.status);

  if (mine) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[min(560px,85%)] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-sm leading-relaxed text-primary-foreground">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2.5">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Sparkles className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="rounded-2xl rounded-tl-md border border-border bg-card/70 px-3.5 py-2.5">
          {message.content.length > 0 ? (
            <AnswerText content={message.content} />
          ) : message.streaming ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>{message.progress.length > 0 ? message.progress : "正在思考…"}</span>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">（没有内容）</div>
          )}

          {message.streaming && message.content.length > 0 && message.progress.length > 0 ? (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>{message.progress}</span>
            </div>
          ) : null}

          {message.blocks.length > 0 ? (
            <div className="mt-3 flex flex-col gap-3">
              {message.blocks.map((block, i) => (
                <BlockView
                  key={i}
                  block={block}
                  onPlayTrack={props.onPlayTrack}
                  onQueueTrack={props.onQueueTrack}
                  onPlayBlock={props.onPlayBlock}
                />
              ))}
            </div>
          ) : null}

          {message.citations.length > 0 ? (
            <div className="mt-3 border-t border-border/70 pt-2">
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">来源</div>
              <div className="flex flex-col gap-1">
                {message.citations.map((citation, i) => (
                  <CitationRow key={i} index={i + 1} citation={citation} />
                ))}
              </div>
            </div>
          ) : null}

          {message.error.length > 0 ? (
            <div className="mt-2 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
              {message.error}
            </div>
          ) : null}
        </div>

        <div className="mt-1.5 flex items-center gap-1.5 pl-1">
          {message.actions.map((action) => (
            <ActionButton
              key={action.actionId}
              action={action}
              enabled={props.canRun(action.type)}
              onRun={() => props.onAction(action)}
            />
          ))}
          {status.length > 0 ? (
            <span className="text-[11px] text-muted-foreground">{status}</span>
          ) : null}
          {props.feedbackEnabled && message.id > 0 && !message.streaming ? (
            <div className="ml-auto flex items-center gap-0.5">
              <VoteButton
                active={voted === "LIKE"}
                title="这条回答有用"
                onClick={() => {
                  setVoted("LIKE");
                  props.onFeedback?.(true);
                }}
              >
                <ThumbsUp className="h-3 w-3" />
              </VoteButton>
              <VoteButton
                active={voted === "DISLIKE"}
                title="这条回答不行"
                onClick={() => {
                  setVoted("DISLIKE");
                  props.onFeedback?.(false);
                }}
              >
                <ThumbsDown className="h-3 w-3" />
              </VoteButton>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function VoteButton(props: {
  active: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      aria-pressed={props.active}
      onClick={props.onClick}
      className={cn(
        "rounded p-1 transition-colors",
        props.active
          ? "text-primary"
          : "text-muted-foreground hover:bg-secondary hover:text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}

function ActionButton(props: {
  action: AiAction;
  enabled: boolean;
  onRun: () => void;
}): React.JSX.Element {
  const label = actionLabel(props.action.type);
  return (
    <button
      type="button"
      onClick={props.onRun}
      disabled={!props.enabled}
      title={props.enabled ? label : `${label}（这个入口在电脑端不可用）`}
      className={cn(
        "rounded-full border border-border bg-background px-2.5 py-1 text-[11px] transition-colors",
        props.enabled
          ? "hover:border-primary/50 hover:bg-primary/5 hover:text-primary"
          : "cursor-not-allowed text-muted-foreground/60",
      )}
    >
      {label}
    </button>
  );
}

/** 一块结构化内容：认识的类型渲染成卡片，不认识就只显示标题（不猜结构） */
function BlockView(props: {
  block: AiBlock;
  onPlayTrack: (track: Track) => void;
  onQueueTrack: (track: Track) => void;
  onPlayBlock: (tracks: Track[]) => void;
}): React.JSX.Element | null {
  const { block } = props;
  const songs = useMemo(() => (block.type === "song_list" ? songsOfBlock(block) : []), [block]);

  if (block.type === "song_list" && songs.length > 0) {
    return (
      <div className="overflow-hidden rounded-xl border border-border bg-background/60">
        <div className="flex items-center gap-2 border-b border-border/70 px-2.5 py-1.5">
          <span className="text-xs font-medium">
            {block.title.length > 0 ? block.title : "推荐歌曲"}
          </span>
          <span className="text-[11px] text-muted-foreground">{songs.length} 首</span>
          <button
            type="button"
            onClick={() => props.onPlayBlock(songs)}
            className="ml-auto flex items-center gap-1 rounded-full bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            <Play className="h-3 w-3 fill-current" />
            播放全部
          </button>
        </div>
        <div className="flex flex-col">
          {songs.map((track, i) => (
            <SongRow
              key={`${track.platform}:${track.id}:${i}`}
              track={track}
              index={i + 1}
              onPlay={() => props.onPlayTrack(track)}
              onQueue={() => props.onQueueTrack(track)}
            />
          ))}
        </div>
      </div>
    );
  }

  if (block.title.length === 0 && block.data === null) return null;
  return (
    <div className="rounded-xl border border-border/70 bg-background/50 px-2.5 py-2">
      <div className="text-xs font-medium">{block.title.length > 0 ? block.title : block.type}</div>
    </div>
  );
}

/** 候选歌曲行：点行播放，行尾收藏（与列表页同一套 CollectMenu 语义） */
function SongRow(props: {
  track: Track;
  index: number;
  onPlay: () => void;
  onQueue: () => void;
}): React.JSX.Element {
  const { track } = props;
  const cover = qtresCoverUrl(track.picUrl, 96);
  const version = useFavoritesStore((s) => s.version);
  const flags = useFavoriteFlags(useMemo(() => [track], [track]), version);
  const favorited = flags[0] === true;
  const [open, setOpen] = useState(false);
  const [liked, setLiked] = useState(favorited);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={props.onPlay}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onPlay();
        }
      }}
      className="group flex cursor-pointer items-center gap-2.5 px-2.5 py-1.5 transition-colors hover:bg-secondary/60"
    >
      <span className="w-4 shrink-0 text-center text-[11px] text-muted-foreground">{props.index}</span>
      {cover !== null ? (
        <img src={cover} alt="" loading="lazy" className="h-8 w-8 shrink-0 rounded object-cover" />
      ) : (
        <span className="h-8 w-8 shrink-0 rounded bg-secondary" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{track.title}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {track.singer}
          {track.album.length > 0 ? ` · ${track.album}` : ""}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <Popover
          open={open}
          onOpenChange={setOpen}
          className="relative"
          trigger={(t) => (
            <button
              type="button"
              title={liked ? "已收藏，点击管理收藏" : "收藏"}
              aria-label={liked ? "已收藏，点击管理收藏" : "收藏"}
              aria-expanded={t.open}
              aria-haspopup="menu"
              onClick={(e) => {
                e.stopPropagation();
                t.toggle();
              }}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
            >
              <Heart className={liked ? "h-3.5 w-3.5 fill-current text-primary" : "h-3.5 w-3.5"} />
            </button>
          )}
        >
          {() => (
            <CollectMenu
              track={track}
              onLikedChange={setLiked}
              onClose={() => setOpen(false)}
              className="absolute right-0 top-full z-20 mt-1 w-56 rounded-md border border-border bg-popover p-1 shadow-md"
            />
          )}
        </Popover>
        <button
          type="button"
          title="加入队列"
          aria-label="加入队列"
          onClick={(e) => {
            e.stopPropagation();
            props.onQueue();
          }}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
        >
          <ListPlus className="h-3.5 w-3.5" />
        </button>
      </span>
      <MoreHorizontal className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40 group-hover:hidden" />
    </div>
  );
}

function CitationRow(props: { index: number; citation: AiCitation }): React.JSX.Element {
  const { citation, index } = props;
  const [expanded, setExpanded] = useState(false);
  const where = [citation.path, citation.section].filter((part) => part.length > 0).join(" · ");
  return (
    <div className="rounded-md bg-secondary/50 px-2 py-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start gap-1.5 text-left"
      >
        <span className="shrink-0 text-[11px] text-muted-foreground">[{index}]</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11px] font-medium">{citation.title}</span>
          {where.length > 0 ? (
            <span className="block truncate text-[10px] text-muted-foreground">{where}</span>
          ) : null}
        </span>
        {citation.matchedText.length > 0 ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {expanded ? "收起" : "展开"}
          </span>
        ) : null}
      </button>
      {expanded && citation.matchedText.length > 0 ? (
        <div className="mt-1 border-t border-border/60 pt-1 text-[11px] leading-relaxed text-muted-foreground">
          {citation.matchedText}
        </div>
      ) : null}
    </div>
  );
}
