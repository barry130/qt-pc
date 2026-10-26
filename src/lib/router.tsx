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
import { parseSearchType, type SearchType } from "@/lib/search-params";
import { LOCAL_PLATFORM } from "@/services/ipc";

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
const PlaylistDetailPage = lazyPage<{ platform: string; id: string; kind?: "playlist" | "chart" }>(
  () => import("@/components/discovery/PlaylistDetailPage"),
  "PlaylistDetailPage",
);
const FeedbackListPage = lazyPage(
  () => import("@/components/mine/FeedbackListPage"),
  "FeedbackListPage",
);
const FeedbackSubmitPage = lazyPage(
  () => import("@/components/mine/FeedbackSubmitPage"),
  "FeedbackSubmitPage",
);
const FeedbackDetailPage = lazyPage(
  () => import("@/components/mine/FeedbackDetailPage"),
  "FeedbackDetailPage",
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
const AudioChartPage = lazyPage<{ platform: string; id: string }>(
  () => import("@/components/discovery/AudioChartPage"),
  "AudioChartPage",
);
const AudioProgramPage = lazyPage<{ platform: string; id: string }>(
  () => import("@/components/discovery/AudioProgramPage"),
  "AudioProgramPage",
);
const LocalMixPage = lazyPage<{ mixKey: string }>(() => import("@/components/mine/LocalMixPage"), "LocalMixPage");
/** 音源账号：每源独立管理登录与「数据/播放是否使用登录态」（二级页，直接渲染） */
const SourceAccountsPage = lazyPage(
  () => import("@/components/mine/SourceAccountsPage"),
  "SourceAccountsPage",
);

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

const dailyRecommendRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/daily-recommend",
  // 一级页面由 AppShell 的 KeepAliveOutlet 常驻渲染（切 tab 不重载），
  // 这里只保留路由用于匹配与导航，组件渲染 null。
  component: () => null,
});

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/search",
  // 页签进 URL 是必须的：搜索页不常驻（见 KeepAliveOutlet 头注），从详情页
  // 返回时组件是重新挂载的，页签留在 state 里会被打回「歌曲」
  // —— 用户从「歌单」点进去的歌单，返回却看到歌曲列表（见 lib/search-params.ts）
  validateSearch: (search: Record<string, unknown>): { q: string; type: SearchType } => ({
    q: typeof search.q === "string" ? search.q : "",
    type: parseSearchType(search.type),
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
  // 具名函数表达式：路由组件在属性位上调 Hook，rules-of-hooks 只认
  // 大写开头的组件名，匿名箭头会被 lint 拦下。
  component: function PlaylistDetailRoutePage() {
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
  component: function ChartDetailRoutePage() {
    const { platform, id } = useParams({ strict: false }) as {
      platform: string;
      id: string;
    };
    return <PlaylistDetailPage platform={platform} id={id} kind="chart" />;
  },
});

const audioChartRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/audio-chart/$platform/$id",
  component: function AudioChartRoutePage() {
    const { platform, id } = useParams({ strict: false }) as { platform: string; id: string };
    return <AudioChartPage platform={platform} id={id} />;
  },
});

const audioProgramRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/audio-program/$platform/$id",
  component: function AudioProgramRoutePage() {
    const { platform, id } = useParams({ strict: false }) as { platform: string; id: string };
    return <AudioProgramPage platform={platform} id={id} />;
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
  // 本地歌单详情与在线歌单详情**共用同一个页面组件**（见 PlaylistDetailPage 模块头）：
  // 本地歌单只是把 platform 传成 "local"，页面内据此分叉。
  component: function MyPlaylistDetailRoutePage() {
    const { id } = useParams({ strict: false }) as { id: string };
    return <PlaylistDetailPage platform={LOCAL_PLATFORM} id={id} />;
  },
});

const localMixRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mix/$key",
  component: function LocalMixRoutePage() {
    const { key } = useParams({ strict: false }) as { key: string };
    return <LocalMixPage mixKey={key} />;
  },
});

/** 音源账号（侧边栏「我的」组）：每源登录 + 按源独立的 meta/play 开关 */
const sourceAccountsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/source-accounts",
  component: SourceAccountsPage,
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

const aiAssistantRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ai-assistant",
  // 音乐助手也走常驻：用户问完歌常常要切去别的页听，切回来会话还在。
  component: () => null,
});

const feedbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/feedback",
  component: FeedbackListPage,
});

const feedbackSubmitRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/feedback/submit",
  component: FeedbackSubmitPage,
});

const feedbackDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/feedback/$id",
  component: FeedbackDetailPage,
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
  component: function SettingsRoutePage() {
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
  dailyRecommendRoute,
  searchRoute,
  playlistsRoute,
  playlistDetailRoute,
  chartsRoute,
  chartDetailRoute,
  audioChartRoute,
  audioProgramRoute,
  artistRoute,
  albumRoute,
  libraryRoute,
  libraryFoldersRoute,
  myPlaylistsRoute,
  myPlaylistDetailRoute,
  sourceAccountsRoute,
  localMixRoute,
  historyRoute,
  downloadsRoute,
  playingRoute,
  statsRoute,
  aiAssistantRoute,
  feedbackRoute,
  feedbackSubmitRoute,
  feedbackDetailRoute,
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
