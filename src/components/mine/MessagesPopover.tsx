import { useEffect, useRef, useState } from "react";
import { ArrowLeft, MessageSquare, RefreshCw, X } from "lucide-react";
import { useMessages, summary, type MessageItem } from "./messages-data";
import { RichText } from "@/lib/richText";
import * as ipc from "@/services/ipc";

/**
 * 消息中心弹出面板（标题栏「消息中心」图标点开，参考主流播放器的邮件下拉）。
 *
 * 面板自含列表与正文：后端没有单独的详情接口，点开即展示全文（前端切视图，不走路由）。
 * 图标带未读数角标；点面板外或右上角 × 收起。
 */
export function MessagesPopover(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { items, loading, error, reload, markRead, markAllRead } = useMessages();
  const unread = items.filter((it) => !it.read).length;

  // 点面板外收起（标题栏按钮本体在 rootRef 内，不会误判）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={rootRef} className="relative flex h-full items-center">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="消息中心"
        title="消息中心"
        aria-expanded={open}
        // 标题栏是拖动区，按钮按下要拦住，防止误触发拖动
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        className="flex h-full w-11 items-center justify-center text-foreground/80 transition-colors hover:bg-secondary hover:text-foreground"
      >
        <MessageSquare className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute right-1 top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-0.5 text-[9px] font-medium leading-none text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <MessagesPanel
          items={items}
          loading={loading}
          error={error}
          onReload={() => void reload()}
          onMarkRead={markRead}
          onMarkAllRead={markAllRead}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function MessagesPanel(props: {
  items: MessageItem[];
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onMarkRead: (id: number) => void;
  onMarkAllRead: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const { items, loading, error, onReload, onMarkRead, onMarkAllRead, onClose } = props;
  const [openId, setOpenId] = useState<number | null>(null);
  const unread = items.filter((it) => !it.read);
  const current =
    openId != null ? items.find((it) => it.id === openId) ?? null : null;

  return (
    <div className="absolute right-0 top-full z-50 mt-1 flex max-h-[26rem] w-96 flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-xl">
      {current ? (
        <>
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
            <button
              type="button"
              onClick={() => setOpenId(null)}
              className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              返回列表
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭消息面板"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <h2 className="text-sm font-semibold">{current.title}</h2>
            {current.time && (
              <p className="mt-1 text-[11px] text-muted-foreground">{current.time}</p>
            )}
            <div className="mt-3">
              <RichText text={current.content} />
            </div>
            {current.url && (
              <a
                href={current.url}
                onClick={(e) => {
                  e.preventDefault();
                  // Tauri 里 target=_blank 不生效，统一交系统浏览器打开
                  void ipc.openExternalUrl(current.url ?? "").catch(() => undefined);
                }}
                className="mt-4 inline-block break-all text-xs text-primary underline underline-offset-2"
              >
                {current.url}
              </a>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-sm font-semibold">
              消息中心
              {unread.length > 0 && (
                <span className="ml-1.5 text-[11px] font-normal text-destructive">
                  {unread.length} 条未读
                </span>
              )}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={onReload}
                aria-label="刷新消息"
                title="刷新"
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={onMarkAllRead}
                disabled={unread.length === 0}
                className="rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
              >
                全部已读
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <p className="py-10 text-center text-sm text-muted-foreground">加载中…</p>
            ) : error ? (
              <div className="px-4 py-10 text-center">
                <p className="text-sm text-muted-foreground">暂时读不到消息</p>
                <p className="mt-1 text-[11px] text-muted-foreground">{error}</p>
              </div>
            ) : items.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">还没有消息</p>
            ) : (
              <ul>
                {items.map((it) => (
                  <li key={it.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenId(it.id);
                        onMarkRead(it.id);
                      }}
                      className="w-full border-b border-border/50 px-4 py-3 text-left transition-colors hover:bg-secondary/50"
                    >
                      <div className="flex items-center gap-2">
                        {!it.read && (
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {it.title}
                        </span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {it.time}
                        </span>
                      </div>
                      {/* 列表只给摘要，全文点进去看 */}
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {summary(it.content)}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
