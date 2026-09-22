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
 */
import { useRef } from "react";
import { DiscoverPage } from "@/components/discovery/DiscoverPage";
import { DailyPage } from "@/components/discovery/DailyPage";
import { PlaylistsPage } from "@/components/discovery/PlaylistsPage";
import { ChartsPage } from "@/components/discovery/ChartsPage";
import { LibraryPage } from "@/components/library/LibraryPage";
import { LibraryFoldersPage } from "@/components/library/LibraryFoldersPage";
import { DownloadsPage } from "@/components/mine/DownloadsPage";
import { HistoryPage } from "@/components/mine/HistoryPage";
import { StatsPage } from "@/components/mine/StatsPage";
import { MyPlaylistsPage } from "@/components/mine/MyPlaylistsPage";

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
            {node}
          </div>
        );
      })}
    </>
  );
}
