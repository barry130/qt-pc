import { useEffect, useMemo, useState } from "react";
import { markFirstLoginShown, migrateLegacyFirstLogin, readFirstLoginShown } from "@/lib/noticeFirstLogin";
import { isNoticeLinkOpenable, useOpenNoticeLink } from "@/lib/notice-open";
import {
  DISPLAY_SPLASH,
  hasDisplay,
  pickSplashNotices,
  useActiveNotices,
  type ActiveNotice,
} from "@/lib/notice-data";
import { RichText } from "@/lib/richText";
import { useAuthStore } from "@/stores/auth";

/**
 * 通用公告弹窗（后端展示位 `display & 1`）。
 *
 * 取数与过滤搬到 `lib/notice-data`（与首页通告栏共用一次请求），这里只负责：
 * 一条一条弹、按 id 记「今天不显示」、按 id 记「首次登录已弹」、把 url 变成跳转。
 * 跳转目标认 `astral://` 内跳（见 lib/notice-open），不再只认 http(s)。
 */
export function QtNoticeDialog(): React.JSX.Element | null {
  const session = useAuthStore((s) => s.session);
  const { notices } = useActiveNotices();
  const openLink = useOpenNoticeLink();
  const [index, setIndex] = useState(0);
  const [hideToday, setHideToday] = useState(false);

  const loggedIn = session != null;

  const splash = useMemo(() => {
    // 老版本用一个全局布尔记「已弹过首次登录公告」：升级后先把它迁移成按条标记，
    // 否则老用户明明看过，新发布的公告也会因为老标记而永远不弹。
    migrateLegacyFirstLogin(
      notices
        .filter((notice) => hasDisplay(notice.display, DISPLAY_SPLASH) && notice.firstLoginOnly)
        .map((notice) => notice.id),
    );
    return pickSplashNotices(notices, {
      loggedIn,
      isFirstLoginShown: readFirstLoginShown,
    });
  }, [notices, loggedIn]);

  // 列表换了（刷新/换账号）就从头开始弹
  useEffect(() => {
    setIndex(0);
  }, [splash]);

  const notice: ActiveNotice | null = splash[index] ?? null;
  const hiddenToday = useMemo(
    () => notice !== null && readHiddenDate(notice.id) === todayStr(),
    [notice],
  );

  useEffect(() => {
    setHideToday(false);
  }, [notice?.id]);

  // 今天已选过"不显示"的那条直接跳过，接着弹下一条
  useEffect(() => {
    if (notice !== null && hiddenToday) setIndex((value) => value + 1);
  }, [notice, hiddenToday]);

  if (notice === null || hiddenToday) return null;

  const close = (): void => {
    if (!notice.dialogClosable) return;
    if (hideToday) writeHiddenDate(notice.id, todayStr());
    if (notice.firstLoginOnly) {
      // 按公告 id 单独记：新发布的「仅首次登录」公告不受旧公告的已弹标记影响
      markFirstLoginShown(notice.id);
    }
    setIndex((value) => value + 1);
  };

  const jump = (): void => {
    openLink(notice.link);
    if (notice.dialogClosable) close();
  };

  const jumpable = isNoticeLinkOpenable(notice.link);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="qt-notice-title"
        className="flex max-h-[min(680px,calc(100vh-48px))] w-[560px] max-w-full flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-overlay"
      >
        {notice.title && (
          <div className="shrink-0 px-6 pb-2 pt-6 text-center">
            <h2 id="qt-notice-title" className="text-lg font-semibold">{notice.title}</h2>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <RichText text={notice.content} />
        </div>
        <div className="shrink-0 px-6 pb-5">
          <button
            type="button"
            onClick={close}
            className="w-full rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            {notice.dialogClosable ? "我知道了" : "请阅读公告"}
          </button>
          {jumpable && (
            <button
              type="button"
              onClick={jump}
              className="mt-2 w-full rounded-full bg-secondary px-4 py-2.5 text-sm text-secondary-foreground transition-colors hover:bg-accent"
            >
              点击跳转
            </button>
          )}
          {notice.dialogClosable && (
            <label className="mt-3 flex cursor-pointer items-center justify-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={hideToday}
                onChange={(event) => setHideToday(event.currentTarget.checked)}
              />
              今天不显示
            </label>
          )}
        </div>
      </div>
    </div>
  );
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function hiddenKey(id: number): string {
  return `quietmusic.notice.splash-hidden-${id}`;
}

function readHiddenDate(id: number): string | null {
  try {
    return localStorage.getItem(hiddenKey(id));
  } catch {
    return null;
  }
}

function writeHiddenDate(id: number, value: string): void {
  try {
    localStorage.setItem(hiddenKey(id), value);
  } catch {
    // Storage failure only affects today's suppression.
  }
}
