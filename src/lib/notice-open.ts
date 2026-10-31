/**
 * 通知跳转的执行层：把 `parseNoticeLink` 解析出来的目标变成真正的动作。
 *
 * 三类目标（见 lib/notice-link）：
 * - `external`：系统浏览器打开（历史行为）；
 * - `feedback`：应用内跳到反馈详情页 `/feedback/$id`；
 * - `notice`：**PC 端没有落地页**。移动端有公告列表页 `pages/notice/list`，
 *   桌面端故意不搬：正文已经能在消息中心/通告栏里看全，跳一个"只有这一条"的
 *   列表页反而多一步。因此这类链接在桌面端不可点（`isNoticeLinkOpenable`
 *   让按钮就不渲染成可点样式），也不静默落到详情视图。
 */
import { useCallback } from "react";
import { useRouter, type AnyRouter } from "@tanstack/react-router";
import type { NoticeLink } from "@/lib/notice-link";
import * as ipc from "@/services/ipc";

/** 这个目标在桌面端点得动吗（决定要不要渲染成可点按钮） */
export function isNoticeLinkOpenable(link?: NoticeLink): boolean {
  return link?.kind === "external" || link?.kind === "feedback";
}

/**
 * 返回一个「打开通知链接」的回调。
 *
 * 用 `useRouter({ warn: false })` 而不是 `useNavigate()`：后者没有路由上下文会抛错，
 * 把「单测里单独渲染弹窗/通告栏」和「迷你窗、桌面歌词窗这类不挂路由的小窗」一起弄挂。
 * 拿不到 router 时外链照常能开，只是内跳静默跳过——这比整块 UI 崩掉好。
 */
export function useOpenNoticeLink(): (link?: NoticeLink) => void {
  const router = useRouter({ warn: false }) as AnyRouter | undefined;
  return useCallback(
    (link?: NoticeLink): void => {
      if (link === undefined) return;
      if (link.kind === "external") {
        void ipc.openExternalUrl(link.url).catch(() => undefined);
        return;
      }
      if (link.kind === "feedback" && router !== undefined) {
        void router.navigate({ to: "/feedback/$id", params: { id: String(link.id) } });
      }
      // notice：桌面端无落地页，见文件头注释
    },
    [router],
  );
}
