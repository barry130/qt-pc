import { useState } from "react";
import { errMsg } from "@/lib/utils";
import * as ipc from "@/services/ipc";
import { BackButton } from "@/components/layout/BackButton";

/**
 * 意见反馈提交页（路由 /feedback/submit，入口在反馈列表页右上「写反馈」）。
 * 提交走 Astral 后端（`astral_submit_feedback`），未登录时命令会报错，这里如实提示。
 * 类型值 = 后端 Feedback 实体的枚举常量（TYPE_ISSUE / TYPE_REQUEST），
 * 后端 normalizeType 只认这两个，其他值一律 320「非法类型」。
 */
const KINDS = [
  { value: "issue", label: "问题反馈" },
  { value: "request", label: "功能建议" },
] as const;

export function FeedbackSubmitPage(): React.JSX.Element {
  const [kind, setKind] = useState<string>("issue");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [contact, setContact] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (): Promise<void> => {
    setError(null);
    setDone(false);
    if (!title.trim() || !content.trim()) {
      setError("标题和内容不能为空");
      return;
    }
    setSubmitting(true);
    try {
      await ipc.astralSubmitFeedback(kind, title.trim(), content.trim(), contact.trim());
      setDone(true);
      setTitle("");
      setContent("");
      setContact("");
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="h-full min-w-0 overflow-y-auto">
      <div className="px-5 pb-4 pt-6">
      <div className="mb-4 flex items-center gap-2">
        <BackButton />
        <h1 className="text-base font-semibold">意见反馈</h1>
      </div>

      {/* 表单装进玻璃卡：壁纸页不做实底，与个人中心/资料编辑同一表面语言 */}
      <div className="max-w-xl space-y-4 rounded-2xl border border-border bg-card/60 p-5">
        <div>
          <div className="mb-1 text-xs text-muted-foreground">反馈类型</div>
          <div className="flex gap-2">
            {KINDS.map((k) => (
              <button
                key={k.value}
                type="button"
                onClick={() => setKind(k.value)}
                className={`h-8 rounded-md border px-3 text-xs transition-colors ${
                  kind === k.value
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border hover:bg-secondary"
                }`}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-1 text-xs text-muted-foreground">标题</div>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="一句话描述"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <div>
          <div className="mb-1 text-xs text-muted-foreground">详细描述</div>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={6}
            placeholder="复现步骤、期望结果等"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <div>
          <div className="mb-1 text-xs text-muted-foreground">联系方式（选填）</div>
          <input
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            placeholder="邮箱 / QQ，方便回访"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            提交失败：{error}
          </div>
        )}
        {done && (
          <div className="rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm">
            感谢反馈，已提交成功
          </div>
        )}

        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting}
          className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? "提交中…" : "提交反馈"}
        </button>
      </div>
      </div>
    </div>
  );
}
