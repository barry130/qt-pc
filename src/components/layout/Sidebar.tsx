import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  BarChart3,
  ChevronsLeft,
  ChevronsRight,
  Clock,
  Download,
  ListMusic,
  Mic2,
  Music,
  Radio,
} from "lucide-react";
import { useMusicSourceStore } from "@/stores/musicSource";
import { SOURCE_DISPLAY } from "@/types";
import { cn } from "@/lib/utils";
import { migrateLegacyStorageKey } from "@/lib/legacy-storage";

/**
 * 侧边栏（DESIGN §5.4）：两组导航，可折叠为 64px 图标条（持久化）。
 * 音源是全局状态，这里只展示当前音源名，不提供切换入口。
 * 消息中心 / 设置 / 账号已上移到标题栏（DESIGN §5.3），不再放这里。
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
  // 「我的歌单」与「收藏」已合成一页（/my/playlists），不再分两个入口
  { label: "我的歌单", to: "/my/playlists", icon: ListMusic },
  { label: "本地音乐", to: "/library", icon: Music },
  { label: "下载管理", to: "/downloads", icon: Download },
  { label: "最近播放", to: "/history", icon: Clock },
  { label: "听歌报告", to: "/stats", icon: BarChart3 },
];

/** 更名前的前缀是 lightlisten.*（见 lib/legacy-storage） */
const COLLAPSE_KEY = "quietmusic.sidebar-collapsed";
migrateLegacyStorageKey(COLLAPSE_KEY);

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
      {/* flex-1：导航整体撑满侧边栏高度，折叠按钮跟在「我的」最后一项后面，
          不再单独一节 + 横向隔离线。内容超出时靠 overflow 滚动。 */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-3">
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
