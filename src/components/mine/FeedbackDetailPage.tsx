import { useEffect, useRef, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { BackButton } from "@/components/layout/BackButton";
import * as ipc from "@/services/ipc";
import { errMsg } from "@/lib/utils";
import {
  feedbackAvatarChar,
  feedbackStatusClass,
  feedbackStatusLabel,
  feedbackTypeClass,
  feedbackTypeLabel,
  formatFeedbackTime,
  normalizeFeedback,
  normalizeReply,
  type FeedbackItem,
  type FeedbackReplyItem,
} from "@/lib/feedback";

/**
 * 反馈详情（路由 /feedback/$id）：反馈主体 + 回复时间线 + 底部回复框。
 *
 * 与移动端 pages/feedback/detail 同构：官方回复（userType=ADMIN）带「官方」徽标；
 * 已公开的反馈所有人可见，不再开放追加回复（输入框换成只读提示）——
 * 补充内容会随公开列表一并暴露。
 */
export function FeedbackDetailPage(): React.JSX.Element {
  const { id } = useParams({ strict: false }) as { id: string };
  const feedbackId = Number.parseInt(id, 10) || 0;

  const [fb, setFb] = useState<FeedbackItem | null>(null);
  const [replies, setReplies] = useState<FeedbackReplyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    void (async () => {
      try {
        const detail = normalizeFeedback(await ipc.astralFeedbackDetail(feedbackId));
        const reps = await ipc.astralFeedbackReplies(feedbackId);
        if (cancelled) return;
        setFb(detail);
        setReplies(Array.isArray(reps) ? reps.map((r) => normalizeReply(r)) : []);
      } catch {
        if (!cancelled) setNotFound(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [feedbackId]);

  /** 公开反馈不可回复（与移动端 canReply 同口径） */
  const canReply = fb !== null && !fb.isPublic;

  const sendReply = async (): Promise<void> => {
    const text = replyText.trim();
    if (text.length === 0 || sending || feedbackId <= 0) return;
    setReplyError(null);
    setSending(true);
    try {
      const created = normalizeReply(await ipc.astralReplyFeedback(feedbackId, text));
      setReplies((prev) => [...prev, created]);
      setReplyText("");
      requestAnimationFrame(() =>
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }),
      );
    } catch (err) {
      setReplyError(errMsg(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-center gap-2 px-5 pb-2 pt-6">
        <BackButton />
        <h1 className="text-base font-semibold">反馈详情</h1>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <div className="mx-auto w-full max-w-2xl space-y-3">
          {loading ? (
            <div className="py-16 text-center text-sm text-muted-foreground">加载中…</div>
          ) : notFound || fb === null ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              反馈不存在或无权查看
            </div>
          ) : (
            <>
              {/* 反馈主体 */}
              <div className="rounded-2xl border border-border bg-card/60 p-5">
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${feedbackTypeClass(fb.type)}`}
                  >
                    {feedbackTypeLabel(fb.type)}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${feedbackStatusClass(fb.status)}`}
                  >
                    {feedbackStatusLabel(fb.status)}
                  </span>
                </div>
                <h2 className="mt-2 text-sm font-medium">{fb.title}</h2>
                <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                  {fb.content}
                </p>
                <div className="mt-2.5 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                  {fb.createTime.length > 0 && <span>{fb.createTime}</span>}
                  {fb.device.length > 0 && (
                    <span>{[fb.device, fb.os].filter((s) => s.length > 0).join(" · ")}</span>
                  )}
                  {fb.appVersion.length > 0 && <span>版本 {fb.appVersion}</span>}
                </div>
              </div>

              {/* 回复时间线 */}
              <div className="rounded-2xl border border-border bg-card/60 p-5">
                <p className="text-xs font-medium text-muted-foreground">回复（{replies.length}）</p>
                {replies.length === 0 ? (
                  <p className="py-6 text-center text-xs text-muted-foreground">
                    暂无回复，官方会尽快处理
                  </p>
                ) : (
                  <ul className="mt-3 flex flex-col gap-3">
                    {replies.map((r) => {
                      const official = r.userType === "ADMIN";
                      return (
                        <li key={r.id} className="flex gap-2.5">
                          <span
                            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
                              official
                                ? "bg-primary text-primary-foreground"
                                : "bg-secondary text-secondary-foreground"
                            }`}
                          >
                            {feedbackAvatarChar(r.nickname, r.userType)}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-medium">
                                {r.nickname.length > 0 ? r.nickname : "用户"}
                              </span>
                              {official && (
                                <span className="rounded bg-primary/10 px-1 py-px text-[10px] text-primary">
                                  官方
                                </span>
                              )}
                              <span className="text-[11px] text-muted-foreground">
                                {formatFeedbackTime(r.replyTime)}
                              </span>
                            </div>
                            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">
                              {r.content}
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* 底部回复框：公开反馈只读 */}
      {fb !== null && !notFound && (
        <div className="border-t border-border bg-card/60 p-3">
          <div className="mx-auto w-full max-w-2xl">
            {canReply ? (
              <div className="flex gap-2">
                <input
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void sendReply();
                  }}
                  maxLength={2000}
                  placeholder="回复…"
                  className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                />
                <button
                  type="button"
                  onClick={() => void sendReply()}
                  disabled={replyText.trim().length === 0 || sending}
                  className="h-9 shrink-0 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {sending ? "发送中…" : "发送"}
                </button>
              </div>
            ) : (
              <p className="text-center text-xs text-muted-foreground">公开反馈不支持回复</p>
            )}
            {replyError && (
              <p className="mt-2 text-center text-xs text-destructive">回复失败：{replyError}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
