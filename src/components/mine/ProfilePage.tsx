import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronRight,
  Download,
  ListMusic,
  LogOut,
  MessageSquareText,
  Music,
} from "lucide-react";
import { avatarUrl, displayName, useAuthStore } from "@/stores/auth";
import { qtresCoverUrl } from "@/lib/lrc";
import * as ipc from "@/services/ipc";

/**
 * 个人中心（路由 /profile，DESIGN §5.3）。
 *
 * 视觉走「玻璃拟态 + 品牌渐变」：资料卡是半透明玻璃面，背后垫一层品牌渐变光晕，
 * 头像用渐变描边，下面是三格本地统计与常用入口卡片。
 * 颜色全部来自语义令牌（--brand-from/--brand-to 跟着运行时皮肤走），组件里不写死 hex。
 *
 * 未登录时同一张卡给登录入口；已登录显示账号与退出。
 * 登录依赖 Astral 后端，未启动也不影响统计与下面的本地功能入口。
 */
const LINKS = [
  {
    label: "我的歌单",
    hint: "自建与收藏的歌单",
    to: "/my/playlists",
    icon: ListMusic,
  },
  { label: "本地音乐", hint: "扫描本机音频文件", to: "/library", icon: Music },
  { label: "下载管理", hint: "离线缓存的歌曲", to: "/downloads", icon: Download },
  { label: "意见反馈", hint: "问题与建议", to: "/feedback", icon: MessageSquareText },
] as const;

export function ProfilePage(): React.JSX.Element {
  const navigate = useNavigate();
  const session = useAuthStore((s) => s.session);
  const profile = useAuthStore((s) => s.profile);
  const logout = useAuthStore((s) => s.logout);
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState({ playlists: 0, tracks: 0, downloads: 0 });

  // 三格统计都是本地库查询，与登录态无关；任一失败就当 0，不打断页面
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [playlists, tracks, downloads] = await Promise.all([
        ipc.listMyPlaylists().catch(() => []),
        ipc.getLocalTracks().catch(() => []),
        ipc.listDownloads().catch(() => []),
      ]);
      if (!alive) return;
      setStats({
        playlists: Array.isArray(playlists) ? playlists.length : 0,
        tracks: Array.isArray(tracks) ? tracks.length : 0,
        downloads: Array.isArray(downloads) ? downloads.length : 0,
      });
    })();
    return () => {
      alive = false;
    };
  }, []);

  const doLogout = async (): Promise<void> => {
    setBusy(true);
    try {
      await logout();
    } finally {
      setBusy(false);
    }
  };

  const avatar = avatarUrl(profile);
  const avatarSrc = avatar ? qtresCoverUrl(avatar) : null;
  const name = session ? displayName(profile, "已登录") : "未登录";
  const account = session ? accountLine(profile) : "登录后可同步收藏、消息与反馈";

  return (
    <div className="h-full min-w-0 overflow-y-auto">
      <div className="px-5 pb-2 pt-6">
        <section className="relative">
          {/* 卡背后垫一层品牌渐变光晕：纯装饰，不接收指针事件 */}
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-x-4 -top-4 bottom-2 rounded-[32px] opacity-25 blur-2xl"
            style={{
              background:
                "linear-gradient(120deg, var(--brand-from), var(--brand-to))",
            }}
          />

          <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-card/70 p-5 shadow-xl shadow-black/5 backdrop-blur-xl">
            {/* 顶边一道渐变高光，玻璃质感的点睛 */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-10 top-0 h-px"
              style={{
                background:
                  "linear-gradient(90deg, transparent, var(--brand-to), transparent)",
              }}
            />

            <div className="flex items-center gap-4">
              {/* 头像：渐变描边 + 玻璃底；有真实头像就用真图 */}
              <div
                className="shrink-0 rounded-full p-[2px] shadow-lg"
                style={{
                  background:
                    "linear-gradient(135deg, var(--brand-from), var(--brand-to))",
                }}
              >
                <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-full bg-card">
                  {avatarSrc ? (
                    <img
                      src={avatarSrc}
                      alt=""
                      className="h-full w-full object-cover"
                      draggable={false}
                    />
                  ) : (
                    <span
                      className="bg-clip-text text-2xl font-semibold text-transparent"
                      style={{
                        backgroundImage:
                          "linear-gradient(135deg, var(--brand-from), var(--brand-to))",
                      }}
                    >
                      {session ? name.slice(0, 1) : "游"}
                    </span>
                  )}
                </div>
              </div>

              <div className="min-w-0 flex-1">
                <div className="truncate text-lg font-semibold tracking-tight">
                  {name}
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  {session && (
                    // 在线态用主色点，不引硬编码的绿色
                    <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                  )}
                  <span className="truncate">{account}</span>
                </div>
              </div>

              {session ? (
                <button
                  type="button"
                  onClick={() => void doLogout()}
                  disabled={busy}
                  className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-border/60 bg-card/60 px-3 text-xs text-muted-foreground backdrop-blur transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  {busy ? "退出中…" : "退出登录"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void navigate({ to: "/login" })}
                  className="h-9 shrink-0 cursor-pointer rounded-lg px-4 text-xs font-medium text-primary-foreground shadow-lg transition-transform hover:-translate-y-0.5"
                  style={{
                    background:
                      "linear-gradient(135deg, var(--brand-from), var(--brand-to))",
                  }}
                >
                  登录 / 注册
                </button>
              )}
            </div>

            {/* 本地统计：登录与否都能看 */}
            <div className="mt-5 grid grid-cols-3 gap-2.5">
              <Stat label="歌单" value={stats.playlists} />
              <Stat label="本地歌曲" value={stats.tracks} />
              <Stat label="已下载" value={stats.downloads} />
            </div>
          </div>
        </section>
      </div>

      <section className="px-5 py-4">
        <h2 className="mb-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          常用
        </h2>
        <div className="grid grid-cols-2 gap-2.5">
          {LINKS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.to}
                type="button"
                onClick={() => void navigate({ to: item.to })}
                className="group flex cursor-pointer items-center gap-3 rounded-xl border border-border/60 bg-card/60 p-3 text-left backdrop-blur-md transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:bg-card hover:shadow-lg"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {item.label}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {item.hint}
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/** 统计格：玻璃底 + 大号数字 */
function Stat(props: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="rounded-xl border border-border/50 bg-secondary/40 px-3 py-2.5 backdrop-blur">
      <div className="text-lg font-semibold tabular-nums leading-tight">
        {props.value}
      </div>
      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
        {props.label}
      </div>
    </div>
  );
}

/** 账号副标题：优先用户名 / 邮箱，拿不到就给一句说明 */
function accountLine(profile: Record<string, unknown> | null): string {
  const keys = ["username", "account", "email", "mobile", "phone"];
  const user = profile?.user as Record<string, unknown> | null | undefined;
  for (const source of [profile, user]) {
    if (!source) continue;
    for (const key of keys) {
      const v = source[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return "轻听账号 · 已登录";
}
