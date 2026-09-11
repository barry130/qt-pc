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
import { DiscoverPage } from "@/components/discovery/DiscoverPage";
import { PlaylistsPage } from "@/components/discovery/PlaylistsPage";
import { PlaylistDetailPage } from "@/components/discovery/PlaylistDetailPage";
import { ChartsPage } from "@/components/discovery/ChartsPage";
import { ChartDetailPage } from "@/components/discovery/ChartDetailPage";
import { MvPage } from "@/components/discovery/MvPage";
import { MvDetailPage } from "@/components/discovery/MvDetailPage";
import { LibraryPage } from "@/components/library/LibraryPage";
import { DailyPage } from "@/components/discovery/DailyPage";
import { FavoritesPage } from "@/components/mine/FavoritesPage";
import { HistoryPage } from "@/components/mine/HistoryPage";
import { FeedbackPage } from "@/components/mine/FeedbackPage";
import { MyPlaylistsPage } from "@/components/mine/MyPlaylistsPage";
import { MyPlaylistDetailPage } from "@/components/mine/MyPlaylistDetailPage";
import { DownloadsPage } from "@/components/mine/DownloadsPage";
import { LoginPage } from "@/components/mine/LoginPage";
import { ProfilePage } from "@/components/mine/ProfilePage";
import { LibraryFoldersPage } from "@/components/library/LibraryFoldersPage";
import { OnboardingPage } from "@/components/onboarding/OnboardingPage";
import { MessagesPage } from "@/components/mine/MessagesPage";
import { StatsPage } from "@/components/mine/StatsPage";
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
  component: DiscoverPage,
});

const dailyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/daily",
  component: DailyPage,
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
  component: PlaylistsPage,
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
  component: ChartsPage,
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
  component: MvPage,
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
  component: LibraryPage,
});

const libraryFoldersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library/folders",
  component: LibraryFoldersPage,
});

const myPlaylistsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/my/playlists",
  component: MyPlaylistsPage,
});

const myPlaylistDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/my/playlist/$id",
  component: MyPlaylistDetailPage,
});

const favoritesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/favorites",
  component: FavoritesPage,
});

const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/history",
  component: HistoryPage,
});

const downloadsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/downloads",
  component: DownloadsPage,
});

const playingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/playing",
  component: PlayingPage,
});

const statsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/stats",
  component: StatsPage,
});

const messagesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/messages",
  component: MessagesPage,
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
