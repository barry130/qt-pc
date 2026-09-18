import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useParams,
} from "@tanstack/react-router";
import { AppShell } from "@/components/layout/AppShell";
import { SearchPage } from "@/components/SearchPage";
import { PlayingPage } from "@/components/PlayingPage";
import { PlaceholderPage } from "@/components/layout/PlaceholderPage";
import { SettingsPage } from "@/components/SettingsPage";
import { PlaylistDetailPage } from "@/components/discovery/PlaylistDetailPage";
import { ChartDetailPage } from "@/components/discovery/ChartDetailPage";
import { MvDetailPage } from "@/components/discovery/MvDetailPage";
import { FeedbackPage } from "@/components/mine/FeedbackPage";
import { MyPlaylistDetailPage } from "@/components/mine/MyPlaylistDetailPage";
import { LoginPage } from "@/components/mine/LoginPage";
import { ProfilePage } from "@/components/mine/ProfilePage";
import { OnboardingPage } from "@/components/onboarding/OnboardingPage";
import { ArtistPage } from "@/components/discovery/ArtistPage";
import { AlbumPage } from "@/components/discovery/AlbumPage";

/**
 * 路由表（DESIGN §5.2）。M1 阶段除搜索 / 播放页外均为占位页，
 * 各 feature 在后续里程碑逐个落地为真实实现。
 * 壳内使用 memory history：Tauri 无地址栏，前进 / 后退语义保留即可。
 */

const rootRoute = createRootRoute({ component: AppShell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  // 一级页面由 AppShell 的 KeepAliveOutlet 常驻渲染（切 tab 不重载），
  // 这里只保留路由用于匹配与导航，组件渲染 null。
  component: () => null,
});

const dailyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/daily",
  // 一级页面由 AppShell 的 KeepAliveOutlet 常驻渲染（切 tab 不重载），
  // 这里只保留路由用于匹配与导航，组件渲染 null。
  component: () => null,
});

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/search",
  validateSearch: (search: Record<string, unknown>): { q: string } => ({
    q: typeof search.q === "string" ? search.q : "",
  }),
  component: SearchPage,
});

const playlistsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/playlists",
  // 一级页面由 AppShell 的 KeepAliveOutlet 常驻渲染（切 tab 不重载），
  // 这里只保留路由用于匹配与导航，组件渲染 null。
  component: () => null,
});

const playlistDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/playlist/$platform/$id",
  component: () => {
    const { platform, id } = useParams({ strict: false }) as {
      platform: string;
      id: string;
    };
    return <PlaylistDetailPage platform={platform} id={id} />;
  },
});

const chartsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/charts",
  // 一级页面由 AppShell 的 KeepAliveOutlet 常驻渲染（切 tab 不重载），
  // 这里只保留路由用于匹配与导航，组件渲染 null。
  component: () => null,
});

const chartDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chart/$platform/$id",
  component: () => {
    const { platform, id } = useParams({ strict: false }) as {
      platform: string;
      id: string;
    };
    return <ChartDetailPage platform={platform} id={id} />;
  },
});

const artistRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/artist/$platform/$id",
  component: ArtistPage,
});

const albumRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/album/$platform/$id",
  component: AlbumPage,
});

const mvRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mv",
  // 一级页面由 AppShell 的 KeepAliveOutlet 常驻渲染（切 tab 不重载），
  // 这里只保留路由用于匹配与导航，组件渲染 null。
  component: () => null,
});

const mvDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mv/$platform/$id",
  component: () => {
    const { platform, id } = useParams({ strict: false }) as {
      platform: string;
      id: string;
    };
    return <MvDetailPage platform={platform} id={id} />;
  },
});

const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library",
  // 一级页面由 AppShell 的 KeepAliveOutlet 常驻渲染（切 tab 不重载），
  // 这里只保留路由用于匹配与导航，组件渲染 null。
  component: () => null,
});

const libraryFoldersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library/folders",
  // 一级页面由 AppShell 的 KeepAliveOutlet 常驻渲染（切 tab 不重载），
  // 这里只保留路由用于匹配与导航，组件渲染 null。
  component: () => null,
});

const myPlaylistsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/my/playlists",
  // 一级页面由 AppShell 的 KeepAliveOutlet 常驻渲染（切 tab 不重载），
  // 这里只保留路由用于匹配与导航，组件渲染 null。
  component: () => null,
});

const myPlaylistDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/my/playlist/$id",
  component: MyPlaylistDetailPage,
});

const favoritesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/favorites",
  // 一级页面由 AppShell 的 KeepAliveOutlet 常驻渲染（切 tab 不重载），
  // 这里只保留路由用于匹配与导航，组件渲染 null。
  component: () => null,
});

const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/history",
  // 一级页面由 AppShell 的 KeepAliveOutlet 常驻渲染（切 tab 不重载），
  // 这里只保留路由用于匹配与导航，组件渲染 null。
  component: () => null,
});

const downloadsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/downloads",
  // 一级页面由 AppShell 的 KeepAliveOutlet 常驻渲染（切 tab 不重载），
  // 这里只保留路由用于匹配与导航，组件渲染 null。
  component: () => null,
});

const playingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/playing",
  component: PlayingPage,
});

const statsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/stats",
  // 一级页面由 AppShell 的 KeepAliveOutlet 常驻渲染（切 tab 不重载），
  // 这里只保留路由用于匹配与导航，组件渲染 null。
  component: () => null,
});

const messagesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/messages",
  // 一级页面由 AppShell 的 KeepAliveOutlet 常驻渲染（切 tab 不重载），
  // 这里只保留路由用于匹配与导航，组件渲染 null。
  component: () => null,
});

const feedbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/feedback",
  component: FeedbackPage,
});

const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/profile",
  component: ProfilePage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/$section",
  component: () => {
    const { section } = useParams({ strict: false }) as { section: string };
    return <SettingsPage section={section} />;
  },
});

const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  component: OnboardingPage,
});

const lyricsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/lyrics",
  component: () => (
    <PlaceholderPage
      title="桌面歌词"
      description="该路由仅供桌面歌词窗口加载，不在主窗口导航中出现"
    />
  ),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  dailyRoute,
  searchRoute,
  playlistsRoute,
  playlistDetailRoute,
  chartsRoute,
  chartDetailRoute,
  artistRoute,
  albumRoute,
  mvRoute,
  mvDetailRoute,
  libraryRoute,
  libraryFoldersRoute,
  myPlaylistsRoute,
  myPlaylistDetailRoute,
  favoritesRoute,
  historyRoute,
  downloadsRoute,
  playingRoute,
  statsRoute,
  messagesRoute,
  feedbackRoute,
  profileRoute,
  loginRoute,
  settingsRoute,
  onboardingRoute,
  lyricsRoute,
]);

export const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ["/"] }),
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
