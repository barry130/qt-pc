import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  BarChart3,
  ChevronsLeft,
  ChevronsRight,
  Clock,
  Compass,
  Download,
  KeyRound,
  ListMusic,
  Music,
  Podcast,
  Radio,
  RadioTower,
  Sparkles,
} from "lucide-react";
import { useMusicSourceStore } from "@/stores/musicSource";
import { useAppearanceStore } from "@/stores/appearance";
import { useSourceLabel, useSourceSupports, useAnySourceSupports } from "@/stores/sourceRegistry";
import { cn } from "@/lib/utils";
import { migrateLegacyStorageKey } from "@/lib/legacy-storage";
import { useT, type MessageKey } from "@/lib/i18n";

/**
 * 侧边栏（DESIGN §5.4）：两组导航，可折叠为 64px 图标条（持久化）。
 * 音源是全局状态，这里只展示当前音源名，不提供切换入口。
 * 消息中心 / 设置 / 账号已上移到标题栏（DESIGN §5.3），不再放这里。
 */

type Item = {
  /** 词条键（B6）：文案在 lib/i18n 里，渲染时才按当前语言取 */
  labelKey: MessageKey;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  params?: Record<string, string>;
};

/** 已取好文案的导航项（NavLink 只认这个） */
type NavItem = Item & { label: string };

const ONLINE_ITEMS: Item[] = [
  { labelKey: "nav.home", to: "/", icon: Radio },
  // 「每日推荐」与「每日新歌」是两个功能，入口刻意相邻但分开：
  // 每日新歌 = 当前音源的最新流（谁发新歌就有什么）；每日推荐 = 按你自己的播放历史挑的。
  { labelKey: "nav.dailyRecommend", to: "/daily-recommend", icon: Compass },
  { labelKey: "nav.dailyNew", to: "/daily", icon: Clock },
  { labelKey: "nav.playlists", to: "/playlists", icon: ListMusic },
  { labelKey: "nav.charts", to: "/charts", icon: BarChart3 },
];

const MINE_ITEMS: Item[] = [
  // 「我的歌单」与「收藏」已合成一页（/my/playlists），不再分两个入口
  { labelKey: "nav.myPlaylists", to: "/my/playlists", icon: ListMusic },
  // 音源平台管理（合三为一：账号登录、音乐源启用/优先级、聚合搜索都在该页），紧跟我的歌单（用户指定位置）
  { labelKey: "nav.sourceAccounts", to: "/source-accounts", icon: KeyRound },
  // 私人 FM 依赖的是本地画像（收藏/歌单/历史），本地模式一样能用，所以放「我的」组
  { labelKey: "nav.radio", to: "/radio", icon: RadioTower },
  // 播客是本地订阅（RSS），不依赖任何在线音源，同样归「我的」
  { labelKey: "nav.podcast", to: "/podcast", icon: Podcast },
  { labelKey: "nav.library", to: "/library", icon: Music },
  { labelKey: "nav.downloads", to: "/downloads", icon: Download },
  { labelKey: "nav.history", to: "/history", icon: Clock },
  { labelKey: "nav.stats", to: "/stats", icon: BarChart3 },
];

/**
 * 音乐助手单独一组，不混进「在线」也不混进「我的」：
 * 它既依赖在线音源搜索，又产生本机会话历史；挂哪边都会误导。
 * 与移动端「我的 → 音乐助手」是同一个智能体（music_assistant）。
 *
 * 2026-10-24 起这一组对全部用户开放（含未登录）：音乐助手不再需要管理员/专用权限码，
 * 后端 `APP_USER` 角色本来就有 `user:ai:music:use`，前端再按权限显隐只会把入口藏错。
 * 「服务端 AI」模式才是管理员专属，那条闸在设置页与执行层（`isAdmin`），不在入口这里。
 */
const ASSISTANT_ITEMS: Item[] = [{ labelKey: "nav.assistant", to: "/ai-assistant", icon: Sparkles }];

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
  // 有背景图时侧栏底色半透明（见 --sidebar-surface），此时去掉 backdrop-blur-sm：
  // 那层 8px 模糊会把侧栏里的壁纸糊掉，与内容区之间出现一条明显的模糊分界。
  const hasBgImage = useAppearanceStore((s) => Boolean(s.preference.bgImage));
  const sourceName = useSourceLabel(activeSourceId);

  // 导航始终保留相同顺序，本地模式和不支持的功能显示禁用态，避免切源时布局跳动。
  // 未声明功能面的旧包仍按支持处理；本地模式单独禁用全部在线入口。
  const isLocal = activeSourceId === "local";
  const supportsDaily = useSourceSupports(activeSourceId, "latest");
  const supportsPlaylists = useSourceSupports(activeSourceId, "playlists");
  // 榜单页内可以切换音源，只要还有其他源支持榜单，在线模式就保留可用入口。
  const supportsCharts = useAnySourceSupports("charts");
  const t = useT();
  const withLabel = (item: Item): NavItem => ({ ...item, label: t(item.labelKey) });
  const onlineItems = ONLINE_ITEMS.map((item) => {
    const nav = withLabel(item);
    let disabledReason: string | undefined;
    if (isLocal) {
      disabledReason = "本地模式下不可用，请切换在线音源";
    } else if (
      (nav.to === "/daily" && !supportsDaily) ||
      (nav.to === "/playlists" && !supportsPlaylists)
    ) {
      disabledReason = `当前音源不支持${nav.label}`;
    } else if (nav.to === "/charts" && !supportsCharts) {
      disabledReason = "当前音源均不支持排行榜";
    }
    return { ...nav, disabledReason };
  });

  useEffect(() => {
    writeCollapsed(collapsed);
  }, [collapsed]);

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 select-none flex-col border-r border-border bg-[color:var(--sidebar-surface)] transition-[width]",
        !hasBgImage && "backdrop-blur-sm",
        collapsed ? "w-[64px]" : "w-[208px]",
      )}
    >
      {/* flex-1：导航整体撑满侧边栏高度，折叠按钮跟在「我的」最后一项后面，
          不再单独一节 + 横向隔离线。内容超出时靠 overflow 滚动。 */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-3">
        <NavGroup
          title={
            isLocal
              ? t("sidebar.group.onlineUnavailable")
              : t("sidebar.group.online", { source: sourceName })
          }
          collapsed={collapsed}
        >
          {onlineItems.map((item) => (
            <NavLink key={item.to} item={item} collapsed={collapsed} disabledReason={item.disabledReason} />
          ))}
        </NavGroup>
        <NavGroup title={t("sidebar.group.mine")} collapsed={collapsed}>
          {MINE_ITEMS.map(withLabel).map((item) => (
            <NavLink key={item.to} item={item} collapsed={collapsed} />
          ))}
        </NavGroup>
        <NavGroup title={t("sidebar.group.assistant")} collapsed={collapsed}>
          {ASSISTANT_ITEMS.map(withLabel).map((item) => (
            <NavLink key={item.to} item={item} collapsed={collapsed} />
          ))}
        </NavGroup>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
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
        <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          {props.title}
        </span>
        {props.action}
      </div>
      <div className="flex flex-col gap-0.5">{props.children}</div>
    </div>
  );
}

function NavLink(props: { item: NavItem; collapsed: boolean; disabledReason?: string }): React.JSX.Element {
  const { item, collapsed, disabledReason } = props;
  const Icon = item.icon;
  const className = cn(
    "flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm transition-colors",
    collapsed && "justify-center px-0",
  );
  if (disabledReason) {
    return (
      <span
        role="link"
        aria-disabled="true"
        aria-label={`${item.label}（不可用）：${disabledReason}`}
        title={`${item.label} · ${disabledReason}`}
        className={cn(className, "cursor-not-allowed text-muted-foreground/55")}
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden />
        {!collapsed && (
          <>
            <span className="truncate">{item.label}</span>
            <span aria-hidden className="ml-auto shrink-0 text-3xs">不可用</span>
          </>
        )}
      </span>
    );
  }
  return (
    <Link
      to={item.to}
      params={item.params}
      // 选中态用主色轻量 tint（浅底胶囊）而非实心主色：侧边栏是常驻区，
      // 实心靛蓝视觉权重过大，会让主色稀释到每屏多处；
      // hover 类挂在 inactiveProps 上，避免 hover 灰底盖过选中态的主色 tint
      activeProps={{ className: "bg-primary/10 text-primary font-medium" }}
      inactiveProps={{
        className: "text-foreground/80 hover:bg-secondary/60 hover:text-foreground",
      }}
      activeOptions={{ exact: item.to === "/" }}
      title={collapsed ? item.label : undefined}
      className={className}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );
}
