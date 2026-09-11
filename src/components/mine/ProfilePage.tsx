import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { displayName, useAuthStore } from "@/stores/auth";

/**
 * 个人中心（路由 /profile，DESIGN §5.3）。
 * 未登录时给登录入口；已登录显示账号与退出。
 * 登录依赖 Astral 后端，未启动也不影响下面的本地功能入口。
 */
const LINKS = [
  { label: "我的歌单", to: "/my/playlists" },
  { label: "下载管理", to: "/downloads" },
  { label: "本地音乐", to: "/library" },
  { label: "意见反馈", to: "/feedback" },
] as const;

export function ProfilePage(): React.JSX.Element {
  const navigate = useNavigate();
  const session = useAuthStore((s) => s.session);
  const profile = useAuthStore((s) => s.profile);
  const logout = useAuthStore((s) => s.logout);
  const [busy, setBusy] = useState(false);

  const doLogout = async (): Promise<void> => {
    setBusy(true);
    try {
      await logout();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full min-w-0 overflow-y-auto">
      <section className="border-b border-border px-5 py-6">
        <div className="flex items-center gap-4">
          <div
            className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-lg font-medium ${
              session
                ? "bg-primary/15 text-primary"
                : "bg-secondary text-muted-foreground"
            }`}
          >
            {session ? displayName(profile, "用").slice(0, 1) : "游"}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-medium">
              {session ? displayName(profile, "已登录") : "未登录"}
            </div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {session ? "轻听账号" : "登录后可同步收藏、消息与反馈"}
            </div>
          </div>
          {session ? (
            <button
              type="button"
              onClick={() => void doLogout()}
              disabled={busy}
              className="h-8 shrink-0 rounded-md border border-border px-3 text-xs transition-colors hover:bg-secondary disabled:opacity-50"
            >
              {busy ? "退出中…" : "退出登录"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void navigate({ to: "/login" })}
              className="h-8 shrink-0 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              去登录
            </button>
          )}
        </div>
      </section>

      <section className="px-5 py-4">
        <h2 className="mb-2 text-xs text-muted-foreground">常用</h2>
        <ul>
          {LINKS.map((item) => (
            <li key={item.to}>
              <button
                type="button"
                onClick={() => void navigate({ to: item.to })}
                className="flex w-full items-center justify-between border-b border-border/50 py-2.5 text-left text-sm transition-colors hover:text-primary"
              >
                {item.label}
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
