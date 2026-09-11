import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  BarChart3,
  ChevronsLeft,
  ChevronsRight,
  Clock,
  Download,
  Heart,
  ListMusic,
  MessageSquare,
  Mic2,
  Music,
  Radio,
  Settings,
  UserRound,
} from "lucide-react";
import { useMusicSourceStore } from "@/stores/musicSource";
import { displayName, useAuthStore } from "@/stores/auth";
import { SOURCE_DISPLAY } from "@/types";
import { cn } from "@/lib/utils";

/**
 * 侧边栏（DESIGN §5.4）：四分组导航，可折叠为 64px 图标条（持久化）。
 * 音源是全局状态，这里只展示当前音源名，不提供切换入口。
 */

type Item = {
  label: string;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  params?: Record<string, string>;
};

const ONLINE_ITEMS: Item[] = [
  { label: "首页", to: "/", icon: Radio },
  { label: "每日新歌", to: "/daily", icon: Clock },
  { label: "歌单广场", to: "/playlists", icon: ListMusic },
  { label: "排行榜", to: "/charts", icon: BarChart3 },
  { label: "MV", to: "/mv", icon: Mic2 },
];

const MINE_ITEMS: Item[] = [
  { label: "收藏", to: "/favorites", icon: Heart },
  { label: "本地音乐", to: "/library", icon: Music },
  { label: "下载管理", to: "/downloads", icon: Download },
  { label: "最近播放", to: "/history", icon: Clock },
  { label: "听歌报告", to: "/stats", icon: BarChart3 },
];

const BOTTOM_ITEMS: Item[] = [
  { label: "消息中心", to: "/messages", icon: MessageSquare },
  { label: "设置", to: "/settings/$section", icon: Settings, params: { section: "appearance" } },
  { label: "账号", to: "/login", icon: UserRound },
];

const COLLAPSE_KEY = "lightlisten.sidebar-collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage?.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage?.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
  } catch {
    // 存储不可用时仅本次会话生效
  }
}

export function Sidebar(): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const activeSourceId = useMusicSourceStore((s) => s.activeSourceId);
  const session = useAuthStore((s) => s.session);
  const profile = useAuthStore((s) => s.profile);
  const sourceName =
    activeSourceId === "local" ? "本地" : SOURCE_DISPLAY[activeSourceId];

  useEffect(() => {
    writeCollapsed(collapsed);
  }, [collapsed]);

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 select-none flex-col border-r border-border bg-sidebar backdrop-blur-sm transition-[width]",
        collapsed ? "w-[64px]" : "w-[208px]",
      )}
    >
      {/* 不用 flex-1：否则这一区会被撑满，底部项被顶到窗口最下沿，
          中间空一大块。内容超出时靠 flex 收缩 + overflow 滚动。 */}
      <div className="flex min-h-0 flex-col overflow-y-auto px-2 py-3">
        <NavGroup title={`在线 · ${sourceName}`} collapsed={collapsed}>
          {ONLINE_ITEMS.map((item) => (
            <NavLink key={item.to} item={item} collapsed={collapsed} />
          ))}
        </NavGroup>
        <NavGroup title="我的" collapsed={collapsed}>
          {MINE_ITEMS.map((item) => (
            <NavLink key={item.to} item={item} collapsed={collapsed} />
          ))}
        </NavGroup>
      </div>

      <div className="shrink-0 border-t border-border px-2 py-2">
        {BOTTOM_ITEMS.map((item) => {
          // 账号项随登录态变：未登录进登录页，已登录显示昵称并进个人中心
          const resolved =
            item.to === "/login"
              ? {
                  ...item,
                  to: session ? "/profile" : "/login",
                  label: session ? displayName(profile, "账号") : "登录",
                }
              : item;
          return (
            <NavLink key={resolved.to} item={resolved} collapsed={collapsed} />
          );
        })}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
          className="mt-1 flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          {collapsed ? (
            <ChevronsRight className="h-4 w-4 shrink-0" />
          ) : (
            <>
              <ChevronsLeft className="h-4 w-4 shrink-0" />
              <span>折叠</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}

function NavGroup(props: {
  title: string;
  collapsed: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  if (props.collapsed) {
    return <div className="mb-3 border-b border-border pb-3 last:border-b-0">{props.children}</div>;
  }
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between px-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {props.title}
        </span>
        {props.action}
      </div>
      <div className="flex flex-col gap-0.5">{props.children}</div>
    </div>
  );
}

function NavLink(props: { item: Item; collapsed: boolean }): React.JSX.Element {
  const { item, collapsed } = props;
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      params={item.params}
      activeProps={{ className: "bg-primary text-primary-foreground font-medium" }}
      activeOptions={{ exact: item.to === "/" }}
      title={collapsed ? item.label : undefined}
      className={cn(
        "flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-foreground/80 transition-colors hover:bg-secondary/60 hover:text-foreground",
        collapsed && "justify-center px-0",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );
}
