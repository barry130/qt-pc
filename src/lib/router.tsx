import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useParams,
} from "@tanstack/react-router";
import { AppShell } from "@/components/layout/AppShell";
import { PlaceholderPage } from "@/components/layout/PlaceholderPage";
import { lazyPage } from "@/lib/lazyPage";

/**
 * 路由表（DESIGN §5.2）。壳内使用 memory history：Tauri 无地址栏，
 * 前进 / 后退语义保留即可。
 *
 * 所有页面组件都是**懒加载**（`lazyPage`）：进应用只加载壳 + 首屏那一页，
 * 其余页面在首次导航到时才拉自己的 chunk。壳内的 `Suspense`（AppShell）
 * 与常驻页各自的 `Suspense`（KeepAliveOutlet）负责兜底。
 */

const SearchPage = lazyPage(() => import("@/components/SearchPage"), "SearchPage");
const PlayingPage = lazyPage(() => import("@/components/PlayingPage"), "PlayingPage");
const SettingsPage = lazyPage<{ section: string }>(
  () => import("@/components/SettingsPage"),
  "SettingsPage",
);
const PlaylistDetailPage = lazyPage<{ platform: string; id: string }>(
  () => import("@/components/discovery/PlaylistDetailPage"),
  "PlaylistDetailPage",
);
const ChartDetailPage = lazyPage<{ platform: string; id: string }>(
  () => import("@/components/discovery/ChartDetailPage"),
  "ChartDetailPage",
);
const FeedbackPage = lazyPage(() => import("@/components/mine/FeedbackPage"), "FeedbackPage");
const MyPlaylistDetailPage = lazyPage(
  () => import("@/components/mine/MyPlaylistDetailPage"),
  "MyPlaylistDetailPage",
);
const LoginPage = lazyPage(() => import("@/components/mine/LoginPage"), "LoginPage");
const ForgotPasswordPage = lazyPage(
  () => import("@/components/mine/ForgotPasswordPage"),
  "ForgotPasswordPage",
);
const ProfileEditPage = lazyPage(
  () => import("@/components/mine/ProfileEditPage"),
  "ProfileEditPage",
);
const ProfilePage = lazyPage(() => import("@/components/mine/ProfilePage"), "ProfilePage");
const OnboardingPage = lazyPage(
  () => import("@/components/onboarding/OnboardingPage"),
  "OnboardingPage",
);
const ArtistPage = lazyPage(() => import("@/components/discovery/ArtistPage"), "ArtistPage");
const AlbumPage = lazyPage(() => import("@/components/discovery/AlbumPage"), "AlbumPage");

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

/** 找回密码：邮箱验证码重置（后端 app/user/email + app/user/changePass） */
const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/forgot-password",
  component: ForgotPasswordPage,
});

/** 修改个人信息（后端 app/user/update，全量替换 + 改完踢下线） */
const profileEditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/profile/edit",
  component: ProfileEditPage,
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
  libraryRoute,
  libraryFoldersRoute,
  myPlaylistsRoute,
  myPlaylistDetailRoute,
  historyRoute,
  downloadsRoute,
  playingRoute,
  statsRoute,
  feedbackRoute,
  profileRoute,
  profileEditRoute,
  loginRoute,
  forgotPasswordRoute,
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
