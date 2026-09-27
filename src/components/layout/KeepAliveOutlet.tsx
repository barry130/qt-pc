/**
 * 主页面常驻缓存（keep-alive）——侧边栏一级页面切换不再整页重载。
 *
 * 背景：TanStack Router 只渲染当前匹配路由，切 tab 会卸载旧页、挂载新页，
 * 于是每次都要重新拉数据，且本地状态（分类筛选、已加载分页、滚动位置）全丢。
 * 这里把一级页面按首次访问缓存下来，非当前页只做隐藏（display:none），
 * 切回来时组件实例、数据与滚动位置都还在（Chromium 隐藏不会重置 scrollTop）。
 *
 * 只缓存**无参数的一级列表页**：详情页（/playlist/$id 等）每次都要按 id 重新
 * 拉数据，搜索页依赖 q 查询参数、设置页依赖 section，都不能缓存。
 * 缓存页的路由组件在 router.tsx 里渲染 null，由本组件负责渲染。
 *
 * 两个必须遵守的约束（否则常驻会变成坑）：
 * 1. **数据要在「重新激活」时重校验**：页面只在首次挂载跑一次加载的话，
 *    切回来看到的永远是旧数据（听完歌进统计、别端改完歌单进"我的歌单"）。
 *    缓存页统一用 `useKeepAliveActive()` 拿到"我当前是否可见"，把加载 effect
 *    写成 `useEffect(() => { if (active) void load(); }, [active, load])`，
 *    并按需在不可见时停掉轮询。
 * 2. **每个缓存页各自包一层 ErrorBoundary**：10 个页面常驻在一起，一个页面
 *    渲染崩溃不应该连累其余页面与整个主界面。
 */
import { Suspense, useRef } from "react";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { KeepAliveActiveContext } from "@/components/layout/keepAliveActive";
import { PageFallback, lazyPage } from "@/lib/lazyPage";

/**
 * 一级页面的懒加载组件：页面模块只在首次访问该 tab 时才下载。
 * 10 个页面常驻意味着它们**永远**都在，但如果用户从没点过"统计"，
 * 那一页的代码就没必要进首帧。lazy 组件在模块作用域创建，引用稳定，
 * 所以 KeepAliveOutlet 缓存元素节点的做法不受影响。
 */
const DiscoverPage = lazyPage(() => import("@/components/discovery/DiscoverPage"), "DiscoverPage");
const DailyPage = lazyPage(() => import("@/components/discovery/DailyPage"), "DailyPage");
const PlaylistsPage = lazyPage(
  () => import("@/components/discovery/PlaylistsPage"),
  "PlaylistsPage",
);
const ChartsPage = lazyPage(() => import("@/components/discovery/ChartsPage"), "ChartsPage");
const LibraryPage = lazyPage(() => import("@/components/library/LibraryPage"), "LibraryPage");
const LibraryFoldersPage = lazyPage(
  () => import("@/components/library/LibraryFoldersPage"),
  "LibraryFoldersPage",
);
const DownloadsPage = lazyPage(() => import("@/components/mine/DownloadsPage"), "DownloadsPage");
const HistoryPage = lazyPage(() => import("@/components/mine/HistoryPage"), "HistoryPage");
const StatsPage = lazyPage(() => import("@/components/mine/StatsPage"), "StatsPage");
const MyPlaylistsPage = lazyPage(
  () => import("@/components/mine/MyPlaylistsPage"),
  "MyPlaylistsPage",
);

/** 一级页面清单：pathname → 页面元素工厂（新增一级页时在此登记） */
export const KEEP_ALIVE_PAGES: Record<string, () => React.JSX.Element> = {
  "/": () => <DiscoverPage />,
  "/daily": () => <DailyPage />,
  "/playlists": () => <PlaylistsPage />,
  "/charts": () => <ChartsPage />,
  "/library": () => <LibraryPage />,
  "/library/folders": () => <LibraryFoldersPage />,
  "/downloads": () => <DownloadsPage />,
  "/history": () => <HistoryPage />,
  "/stats": () => <StatsPage />,
  "/my/playlists": () => <MyPlaylistsPage />,
};

/** 当前路径是否为常驻缓存页（AppShell 据此决定是否再渲染 <Outlet />） */
export function isKeepAlivePath(pathname: string): boolean {
  return pathname in KEEP_ALIVE_PAGES;
}

/**
 * 渲染全部已访问的一级页面：当前页可见，其余隐藏。
 * 首次访问才挂载（懒挂载），之后一直存活到应用退出。
 */
export function KeepAliveOutlet(props: { pathname: string }): React.JSX.Element {
  const cacheRef = useRef<Map<string, React.ReactNode>>(new Map());
  const factory = KEEP_ALIVE_PAGES[props.pathname];
  if (factory !== undefined && !cacheRef.current.has(props.pathname)) {
    cacheRef.current.set(props.pathname, factory());
  }
  return (
    <>
      {[...cacheRef.current.entries()].map(([path, node]) => {
        const active = path === props.pathname;
        return (
          // 内联 display：页面根节点自带 flex/h-full，用 hidden 属性会被类样式盖掉
          <div
            key={path}
            className="h-full"
            style={active ? undefined : { display: "none" }}
            aria-hidden={!active}
          >
            {/* resetKey 跟着可见性变：切回来时自动清掉上次的错误状态重试一次 */}
            <ErrorBoundary label={path} resetKey={active ? `${path}:active` : `${path}:idle`}>
              {/* 每个常驻页自己的 Suspense：本页懒加载 chunk 还没到时只让这一页
                  显示占位，不影响其它常驻页与外面的内容区边界 */}
              <Suspense fallback={<PageFallback />}>
                <KeepAliveActiveContext.Provider value={active}>
                  {node}
                </KeepAliveActiveContext.Provider>
              </Suspense>
            </ErrorBoundary>
          </div>
        );
      })}
    </>
  );
}