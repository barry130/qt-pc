import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Bell,
  CheckCheck,
  ChevronRight,
  RefreshCw,
  X,
} from "lucide-react";
import { noticeTypeLabel } from "@/lib/notice-data";
import { useMessages, summary, type MessageItem } from "./messages-data";
import { RichText } from "@/lib/richText";
import * as ipc from "@/services/ipc";
import { IconButton } from "@/components/common/IconButton";
import { Popover } from "@/components/common/Popover";

import { EmptyState, RowsSkeleton } from "@/components/ui";
/**
 * 消息中心弹出面板（标题栏「消息中心」图标点开，参考主流播放器的邮件下拉）。
 *
 * 面板自含列表与正文：后端没有单独的详情接口，点开即展示全文（前端切视图，不走路由）。
 * 图标带未读数角标；点面板外或右上角 × 收起。
 */
export function MessagesPopover(): React.JSX.Element {
  const { items, loading, error, reload, markRead, markAllRead } = useMessages();
  const unread = items.filter((it) => !it.read).length;

  return (
    <Popover
      className="relative flex h-full items-center"
      trigger={(t) => (
        <button
          type="button"
          onClick={t.toggle}
          aria-label="消息中心"
          title="消息中心"
          aria-expanded={t.open}
          // 标题栏是拖动区，按钮按下要拦住，防止误触发拖动
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          // 圆角小块 hover，与标题栏右侧其它入口同形状（窗口控制仍为贴边全高矩形）
          className="mx-1 flex h-8 w-9 items-center justify-center rounded-md text-foreground/80 transition-colors hover:bg-secondary hover:text-foreground"
        >
          {/* 铃铛：通知语义比气泡（消息）更准，与标题栏「通知」的定位一致 */}
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            // 角标定位在按钮右上角（外层包裹器 = 按钮 + 左右 4px 边距）
            <span className="absolute right-0 top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-0.5 text-3xs font-medium leading-none text-white">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </button>
      )}
    >
      {(close) => (
        <MessagesPanel
          items={items}
          loading={loading}
          error={error}
          onReload={() => void reload()}
          onMarkRead={markRead}
          onMarkAllRead={markAllRead}
          onClose={close}
        />
      )}
    </Popover>
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
  const navigate = useNavigate();
  const [openId, setOpenId] = useState<number | null>(null);
  const unread = items.filter((it) => !it.read);
  const current =
    openId != null ? items.find((it) => it.id === openId) ?? null : null;
  // 跳转目标由 messages-data 解析好（astral:// 协议 → 路由），这里只做分发
  const currentLink = current?.link ?? null;

  return (
    <div className="absolute right-0 top-full z-50 mt-1 flex max-h-[26rem] w-96 flex-col overflow-hidden rounded-xl border border-border bg-popover/95 backdrop-blur-xl shadow-raised">
      {current ? (
        <>
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
            <IconButton
              label="返回列表"
              hover="secondary"
              onClick={() => setOpenId(null)}
            >
              <ArrowLeft />
            </IconButton>
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
              <p className="mt-1 text-2xs text-muted-foreground">{current.time}</p>
            )}
            <div className="mt-3">
              <RichText text={current.content} />
            </div>
            {/* 跳转入口：只有后端下发了可识别的 astral:// 协议或 http(s) 外链才渲染 */}
            {currentLink?.kind === "external" && (
              <a
                href={currentLink.url}
                onClick={(e) => {
                  e.preventDefault();
                  // Tauri 里 target=_blank 不生效，统一交系统浏览器打开
                  void ipc.openExternalUrl(currentLink.url).catch(() => undefined);
                }}
                className="mt-4 inline-block break-all text-xs text-primary underline underline-offset-2"
              >
                {currentLink.url}
              </a>
            )}
            {currentLink?.kind === "feedback" && (
              <button
                type="button"
                onClick={() => {
                  // 先收面板再跳：面板挂在标题栏，路由切换后仍会残留
                  onClose();
                  void navigate({
                    to: "/feedback/$id",
                    params: { id: String(currentLink.id) },
                  });
                }}
                className="mt-4 inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                查看反馈
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-sm font-semibold">
              消息中心
              {unread.length > 0 && (
                <span className="ml-1.5 text-2xs font-normal text-destructive">
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
              <IconButton
                label="全部标为已读"
                hover="secondary"
                disabled={unread.length === 0}
                onClick={onMarkAllRead}
              >
                <CheckCheck />
              </IconButton>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <RowsSkeleton rows={5} cover="none" />
            ) : error ? (
              <div className="px-4 py-10 text-center">
                <p className="text-sm text-muted-foreground">暂时读不到消息</p>
                <p className="mt-1 text-2xs text-muted-foreground">{error}</p>
              </div>
            ) : items.length === 0 ? (
              <EmptyState title="还没有消息" />
            ) : (
              <ul>
                {items.map((it) => (
                  <li key={it.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onMarkRead(it.id);
                        // 带跳转目标的通知直接跳，不再先展开正文；只有「纯文本通知」才展开详情
                        if (it.link?.kind === "feedback") {
                          onClose();
                          void navigate({
                            to: "/feedback/$id",
                            params: { id: String(it.link.id) },
                          });
                          return;
                        }
                        if (it.link?.kind === "external") {
                          void ipc.openExternalUrl(it.link.url).catch(() => undefined);
                          return;
                        }
                        setOpenId(it.id);
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
                        {/* 类型标签与移动端卡片一致：公告 / 反馈 / 需求 */}
                        <span className="shrink-0 rounded-full bg-secondary px-1.5 py-0.5 text-2xs text-muted-foreground">
                          {noticeTypeLabel(it.noticeType)}
                        </span>
                        <span className="shrink-0 text-2xs text-muted-foreground">
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
