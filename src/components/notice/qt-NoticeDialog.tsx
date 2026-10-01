import { useEffect, useMemo, useState } from "react";
import { RichText } from "@/lib/richText";
import * as ipc from "@/services/ipc";
import { useAuthStore } from "@/stores/auth";

const DISPLAY_SPLASH = 1;
const FIRST_LOGIN_KEY = "quietmusic.notice.first-login";

interface NoticeItem {
  id: number;
  title: string;
  content: string;
  url?: string;
  dialogClosable: boolean;
  firstLoginOnly: boolean;
  isTop: boolean;
  createTime: string;
}

export function QtNoticeDialog(): React.JSX.Element | null {
  const session = useAuthStore((s) => s.session);
  const [notices, setNotices] = useState<NoticeItem[]>([]);
  const [index, setIndex] = useState(0);
  const [hideToday, setHideToday] = useState(false);

  useEffect(() => {
    let disposed = false;
    void ipc.astralActiveMessages().then((data) => {
      if (disposed) return;
      setNotices(normalizeSplashNotices(data, session != null));
      setIndex(0);
    }).catch(() => {
      if (!disposed) setNotices([]);
    });
    return () => {
      disposed = true;
    };
  }, [session]);

  const notice = notices[index] ?? null;
  const hiddenToday = useMemo(
    () => notice != null && readHiddenDate(notice.id) === todayStr(),
    [notice],
  );

  useEffect(() => {
    setHideToday(false);
  }, [notice?.id]);

  useEffect(() => {
    if (notice && hiddenToday) setIndex((value) => value + 1);
  }, [notice, hiddenToday]);

  if (!notice || hiddenToday) return null;

  const close = (): void => {
    if (!notice.dialogClosable) return;
    if (hideToday) writeHiddenDate(notice.id, todayStr());
    if (notice.firstLoginOnly) {
      try {
        localStorage.setItem(FIRST_LOGIN_KEY, "shown");
      } catch {
        // Storage failure only affects future display suppression.
      }
    }
    setIndex((value) => value + 1);
  };

  const jump = (): void => {
    if (!notice.url || !/^https?:\/\//i.test(notice.url)) return;
    void ipc.openExternalUrl(notice.url).catch(() => undefined);
    if (notice.dialogClosable) close();
  };

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
        className="flex max-h-[min(680px,calc(100vh-48px))] w-[560px] max-w-full flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
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
          {notice.url && /^https?:\/\//i.test(notice.url) && (
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

function normalizeSplashNotices(data: unknown, loggedIn: boolean): NoticeItem[] {
  if (!Array.isArray(data)) return [];
  const firstLoginShown = readFirstLoginShown();
  const seen = new Set<string>();
  return data
    .filter((item) => {
      const o = (item ?? {}) as Record<string, unknown>;
      if ((numberValue(o.display) & DISPLAY_SPLASH) === 0) return false;
      const audience = stringValue(o.audience || "ALL");
      if (audience === "LOGGED_IN" && !loggedIn) return false;
      if (audience === "NOT_LOGGED_IN" && loggedIn) return false;
      if (numberValue(o.firstLoginOnly) === 1 && (!loggedIn || firstLoginShown)) return false;
      return true;
    })
    .map((item) => {
      const o = (item ?? {}) as Record<string, unknown>;
      return {
        id: numberValue(o.id),
        title: stringValue(o.title),
        content: stringValue(o.content),
        url: stringValue(o.url) || undefined,
        dialogClosable: numberValue(o.dialogClosable ?? 1) === 1,
        firstLoginOnly: numberValue(o.firstLoginOnly) === 1,
        isTop: numberValue(o.isTop) === 1,
        createTime: stringValue(o.createTime),
      };
    })
    .sort((a, b) => Number(b.isTop) - Number(a.isTop) || b.createTime.localeCompare(a.createTime))
    .filter((notice) => {
      const key = `${notice.title}\n${notice.content}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function numberValue(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
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

function readFirstLoginShown(): boolean {
  try {
    return localStorage.getItem(FIRST_LOGIN_KEY) === "shown";
  } catch {
    return false;
  }
}
