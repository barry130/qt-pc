import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronRight,
  Download,
  ListMusic,
  LogOut,
  MessageSquareText,
  Music,
  UserRound,
} from "lucide-react";
import { avatarUrl, displayName, useAuthStore } from "@/stores/auth";
import { qtresCoverUrl } from "@/lib/lrc";
import * as ipc from "@/services/ipc";

/**
 * 个人中心（路由 /profile，DESIGN §5.3）。
 *
 * 表面语言跟全站一致：正文用实底卡片 + 极淡品牌色渐变（同首页 hero 卡），
 * 玻璃态只留给标题栏 / 播放条 / 弹层这类「浮在内容之上」的层。
 * 资料卡下面是三格本地统计与常用入口卡片网格，颜色全部走语义令牌。
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
  // 昵称优先、其次用户名；都不给就中性称呼（不出现「已登录」字样）
  const name = session ? displayName(profile, "") || "轻听用户" : "未登录";
  const account = session ? subLine(profile) : "登录后可同步收藏、消息与反馈";

  return (
    <div className="h-full min-w-0 overflow-y-auto">
      <div className="px-5 pb-2 pt-6">
        {/* 正文内容卡：与首页 hero 卡同一配方——不做实底（壁纸下会变成整块白板），
            用极淡品牌色渐变直接铺在壁纸上；卡内次级面用 bg-card/xx 半透明砖，
            与发现页胶囊（bg-card/60）同一表面语言。 */}
        <section className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-5">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-transparent"
          />

          <div className="relative flex items-center gap-4">
            {/* 头像：真实头像优先，拿不到回退应用 logo（与标题栏口径一致） */}
            <div className="shrink-0 rounded-full ring-1 ring-border">
              <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-full bg-secondary">
                <img
                  src={avatarSrc ?? "/static/icon/xxxhdpi.png"}
                  alt=""
                  className="h-full w-full object-cover"
                  draggable={false}
                />
              </div>
            </div>

            <div className="min-w-0 flex-1">
              <div className="truncate text-lg font-semibold tracking-tight">
                {name}
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                {session && (
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
                className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 text-xs text-muted-foreground transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
              >
                <LogOut className="h-3.5 w-3.5" />
                {busy ? "退出中…" : "退出登录"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void navigate({ to: "/login" })}
                className="h-8 shrink-0 cursor-pointer rounded-lg bg-primary px-4 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                登录 / 注册
              </button>
            )}
          </div>

          {/* 本地统计：登录与否都能看 */}
          <div className="relative mt-5 grid grid-cols-3 gap-2.5">
            <Stat label="歌单" value={stats.playlists} />
            <Stat label="本地歌曲" value={stats.tracks} />
            <Stat label="已下载" value={stats.downloads} />
          </div>

          {/* 编辑资料入口：只在登录后出现（未登录时没有可改的资料） */}
          {session ? (
            <button
              type="button"
              onClick={() => void navigate({ to: "/profile/edit" })}
              className="group relative mt-3 flex w-full cursor-pointer items-center gap-2.5 rounded-xl border border-border bg-card/50 px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-card/70"
            >
              <UserRound className="h-4 w-4 shrink-0 text-primary" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">编辑资料</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  昵称、邮箱与密码
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
            </button>
          ) : null}
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
                className="group flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-card/60 p-3 text-left transition-colors hover:border-primary/40 hover:bg-card/80"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
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
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/** 统计格：bg-card 半透明砖，壁纸/深浅模式下都和卡内其他次级面同语言 */
function Stat(props: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="rounded-xl bg-card/50 px-3 py-2.5">
      <div className="text-lg font-semibold tabular-nums leading-tight">
        {props.value}
      </div>
      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
        {props.label}
      </div>
    </div>
  );
}

/** 账号副标题：邮箱 / 手机，拿不到就给中性说明（不重复展示名，也不写「已登录」） */
function subLine(profile: Record<string, unknown> | null): string {
  const keys = ["email", "mobile", "phone"];
  const user = profile?.user as Record<string, unknown> | null | undefined;
  for (const source of [profile, user]) {
    if (!source) continue;
    for (const key of keys) {
      const v = source[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return "轻听账号";
}
