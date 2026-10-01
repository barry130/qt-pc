import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { BackButton } from "@/components/layout/BackButton";
import { usePagedList } from "@/hooks/usePagedList";
import * as ipc from "@/services/ipc";
import {
  FEEDBACK_PAGE_SIZE,
  feedbackStatusClass,
  feedbackStatusLabel,
  feedbackTypeClass,
  feedbackTypeLabel,
  formatFeedbackTime,
  normalizePage,
  type FeedbackItem,
} from "@/lib/feedback";

/**
 * 意见反馈首页（路由 /feedback）：我的反馈 / 公开反馈 两个 Tab 的查询列表。
 *
 * 与移动端 pages/feedback/index 同构：
 * - 「我的」= 全部状态按提交时间倒序；「公开」= 已发布且公开的；
 * - 点条目进详情（/feedback/$id），右上「写反馈」去提交页；
 * - 提交/查询都要求登录，未登录时命令报错，这里如实显示。
 *
 * 表面语言与个人中心一致（壁纸页不做实底）：卡片 bg-card/60 半透明砖，
 * 悬停加深 + 品牌色描边。
 */
const TABS = [
  { key: "mine", label: "我的" },
  { key: "public", label: "公开" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function FeedbackListPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>("mine");

  const { items, loading, loadingMore, error, hasMore, sentinelRef, reload } = usePagedList<
    FeedbackItem
  >({
    resetKey: tab,
    pageSize: FEEDBACK_PAGE_SIZE,
    keyOf: (f) => String(f.id),
    fetchPage: async (page) => {
      const raw =
        tab === "mine"
          ? await ipc.astralMyFeedback(page, FEEDBACK_PAGE_SIZE)
          : await ipc.astralPublicFeedback(page, FEEDBACK_PAGE_SIZE);
      const { records, total } = normalizePage(raw);
      return { list: records, hasMore: records.length < total };
    },
  });

  return (
    <div className="h-full min-w-0 overflow-y-auto">
      <div className="px-5 pb-4 pt-6">
        <div className="mb-4 flex items-center gap-2">
          <BackButton />
          <h1 className="text-base font-semibold">意见反馈</h1>
          <button
            type="button"
            onClick={() => void navigate({ to: "/feedback/submit" })}
            className="ml-auto h-8 rounded-lg bg-primary px-4 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            写反馈
          </button>
        </div>

        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
          <div className="flex gap-1 self-start rounded-lg bg-card/60 p-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`h-7 rounded-md px-4 text-xs transition-colors ${
                  tab === t.key
                    ? "bg-background font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {error ? (
            <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
              <button
                type="button"
                onClick={reload}
                className="ml-2 underline underline-offset-2"
              >
                重试
              </button>
            </div>
          ) : loading ? (
            <div className="py-16 text-center text-sm text-muted-foreground">加载中…</div>
          ) : items.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              {tab === "mine" ? "还没有反馈，说说你的想法吧" : "暂无公开反馈"}
            </div>
          ) : (
            <>
              <ul className="flex flex-col gap-2.5">
                {items.map((f) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      onClick={() =>
                        void navigate({ to: "/feedback/$id", params: { id: String(f.id) } })
                      }
                      className="w-full rounded-xl border border-border bg-card/60 p-3.5 text-left transition-colors hover:border-primary/40 hover:bg-card/80"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${feedbackTypeClass(f.type)}`}
                        >
                          {feedbackTypeLabel(f.type)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {f.title}
                        </span>
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${feedbackStatusClass(f.status)}`}
                        >
                          {feedbackStatusLabel(f.status)}
                        </span>
                      </div>
                      <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                        {f.content}
                      </p>
                      <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
                        <span>{formatFeedbackTime(f.createTime)}</span>
                        {tab === "mine" && f.isPublic && (
                          <span className="text-emerald-500">已公开</span>
                        )}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
              <div ref={sentinelRef} className="py-3 text-center text-xs text-muted-foreground">
                {loadingMore ? "加载中…" : hasMore ? "加载更多" : "没有更多了"}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
