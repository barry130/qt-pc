import { Suspense, useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import * as ipc from "@/services/ipc";
import { ONBOARDING_KEY } from "@/lib/storageKeys";
import { useAuthStore } from "@/stores/auth";
import { TitleBar } from "@/components/TitleBar";
import { Sidebar } from "@/components/layout/Sidebar";
import { KeepAliveOutlet, isKeepAlivePath } from "@/components/layout/KeepAliveOutlet";
import { PlayerBar } from "@/components/PlayerBar";
import { QueuePanel } from "@/components/player/QueuePanel";
import { useFramelessWindow } from "@/hooks/useFramelessWindow";
import { usePlaybackEvents } from "@/hooks/usePlaybackEvents";
import { usePlayUrlBridge } from "@/hooks/usePlayUrlBridge";
import { useAppearanceEffect } from "@/hooks/useAppearanceEffect";
import { useCoverColor } from "@/hooks/useCoverColor";
import { usePlayingCoverBg } from "@/hooks/usePlayingCoverBg";
import { useLocalTrackOnlineMeta } from "@/hooks/useLocalTrackOnlineMeta";
import { useUpdateCheck } from "@/hooks/useUpdateCheck";
import { useSourceUpdateCheck } from "@/hooks/useSourceUpdateCheck";
import { PlayPackPrompt } from "@/components/PlayPackPrompt";
import { useAppearanceStore } from "@/stores/appearance";
import { usePlayerStore } from "@/stores/player";
import { useDownloadsStore } from "@/stores/downloads";
import { qtresCoverUrl } from "@/lib/lrc";
import { initStat, trackStatPage } from "@/lib/stat";
import { UpdateDialog } from "@/components/update/UpdateDialog";
import { QtNoticeDialog } from "@/components/notice/qt-NoticeDialog";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { PageFallback } from "@/lib/lazyPage";

/**
 * 全局布局（DESIGN §5.1）：标题栏 + 侧边栏 + 内容区 + 播放条。
 * 无边框窗口的 8 向 resize 命中区挂在最外层。
 */
export function AppShell(): React.JSX.Element {
  useFramelessWindow();
  usePlaybackEvents();
  // 引擎→前端取链桥：聚合/脚本方案覆盖引擎主导的换歌（自动切歌/随机/重取）
  usePlayUrlBridge();
  useAppearanceEffect();
  useCoverColor();
  usePlayingCoverBg();
  useLocalTrackOnlineMeta();
  useUpdateCheck();
  // 播放音源包启动静默检查（只更新已装的官方包；未安装时不打扰）
  useSourceUpdateCheck();

  const bgImage = useAppearanceStore((s) => s.preference.bgImage);
  // 无封面 URL 的曲目（部分 wyy 曲 picUrl 为空）不渲染背景，避免退化成固定 --primary 色
  const playCoverUrl = usePlayerStore((s) =>
    s.state?.track?.picUrl ? qtresCoverUrl(s.state.track.picUrl) : null,
  );
  const navigate = useNavigate();
  const pathname = useLocation().pathname;
  const isPlayingPage = pathname === "/playing";

  // 首次启动引导：没完成过就先走引导流程（DESIGN §12）
  useEffect(() => {
    void (async () => {
      const done = await ipc.getSetting(ONBOARDING_KEY).catch(() => null);
      if (!done) {
        await navigate({ to: "/onboarding" });
      }
    })();
  }, [navigate]);

  // 启动恢复登录态（读 Rust 侧保存的会话并拉用户信息）
  const initAuth = useAuthStore((s) => s.init);
  useEffect(() => {
    void initAuth();
  }, [initAuth]);

  // 使用统计（STATS_DESIGN §4.1/§7）：冷启动 launcher+show，路由变化记 page
  useEffect(() => {
    void initStat();
  }, []);
  useEffect(() => {
    trackStatPage(pathname);
  }, [pathname]);

  // 桌面歌词工具条上的「歌词设置」：Rust 唤起主窗口后发事件，这里负责跳转
  useEffect(() => {
    let off: (() => void) | null = null;
    let disposed = false;
    void ipc.onLyricOpenSettings(() => {
      void navigate({
        to: "/settings/$section",
        params: { section: "desktop-lyric" },
      });
    }).then((u) => {
      if (disposed) u();
      else off = u;
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, [navigate]);

  // 下载状态全局镜像（DESIGN §5.3 下载 2.0）：启动拉一次，
  // 之后由 Rust 的 downloads-changed 事件驱动刷新，曲目行的「已下载」标随之更新
  const refreshDownloads = useDownloadsStore((s) => s.refresh);
  useEffect(() => {
    void refreshDownloads();
    let off: (() => void) | null = null;
    let disposed = false;
    void ipc.onDownloadsChanged(() => {
      void refreshDownloads();
    }).then((u) => {
      if (disposed) u();
      else off = u;
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, [refreshDownloads]);

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      {bgImage && (
        <div
          className="pointer-events-none absolute inset-0 z-0 bg-cover bg-center opacity-40"
          style={{ backgroundImage: `url(${bgImage})` }}
        />
      )}

      {isPlayingPage && playCoverUrl && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
        >
          {/* 底色：背景色 + 封面色调轻铺（不糊照片，只借色调） */}
          <div
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(135deg, color-mix(in srgb, var(--playing-cover-accent, var(--primary)) 18%, var(--background)) 0%, var(--background) 60%, color-mix(in srgb, var(--playing-cover-accent, var(--primary)) 7%, var(--background)) 100%)",
            }}
          />
          {/* 主光斑：左上，落在唱片后方 */}
          <div
            className="absolute -left-[15%] -top-[35%] h-[75%] w-[60%]"
            style={{
              background:
                "radial-gradient(closest-side, color-mix(in srgb, var(--playing-cover-accent, var(--primary)) 34%, transparent) 0%, transparent 72%)",
            }}
          />
          {/* 副光斑：右下，增加纵深 */}
          <div
            className="absolute -right-[10%] -bottom-[45%] h-[80%] w-[55%]"
            style={{
              background:
                "radial-gradient(closest-side, color-mix(in srgb, var(--playing-cover-accent, var(--primary)) 16%, transparent) 0%, transparent 72%)",
            }}
          />
          {/* 封面纹理：极淡，只为曲目辨识度，不参与配色 */}
          <div
            className="absolute inset-0 bg-cover bg-center opacity-10 blur-3xl dark:opacity-20"
            style={{ backgroundImage: "var(--playing-cover)", transform: "scale(1.4)" }}
          />
          {/* 暗角：四角向背景色收拢，画面聚焦中央 */}
          <div
            className="absolute inset-0"
            style={{
              background:
                "radial-gradient(120% 90% at 50% 42%, transparent 45%, color-mix(in srgb, var(--background) 55%, transparent) 100%)",
            }}
          />
          {/* 底部收拢到背景色，保证播放条与底部歌词可读 */}
          <div
            className="absolute inset-x-0 bottom-0 h-[176px]"
            style={{ background: "linear-gradient(to top, var(--background), transparent)" }}
          />
        </div>
      )}

      {!isPlayingPage && <TitleBar />}

      <div className="relative z-10 flex min-h-0 flex-1">
        {!isPlayingPage && <Sidebar />}
        <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className="relative z-10 h-full">
            {/* 内容区独立边界：页面崩掉不连累侧边栏/播放条，切路由会自动重试一次 */}
            <ErrorBoundary label="内容区" resetKey={pathname}>
              {/* 页面路由是懒加载的（见 lib/lazyPage）：这里给 Outlet 兜一层，
                  否则首次进入未下载完的路由会同步挂起报错。常驻页各自在
                  KeepAliveOutlet 内部有自己的兜底。 */}
              <Suspense fallback={<PageFallback />}>
                {/* 一级页面常驻缓存（切 tab 不再整页重载）；其余路由仍走 Outlet */}
                <KeepAliveOutlet pathname={pathname} />
                {!isKeepAlivePath(pathname) && <Outlet />}
              </Suspense>
            </ErrorBoundary>
          </div>
        </main>
        {!isPlayingPage && (
          <ErrorBoundary label="播放队列">
            <QueuePanel />
          </ErrorBoundary>
        )}
      </div>

      <ErrorBoundary label="播放条">
        <PlayerBar />
      </ErrorBoundary>

      <ErrorBoundary label="对话框">
        {/* 更新弹窗（启动自动检查发现新版本时弹出，§15.3） */}
        <UpdateDialog />
        <QtNoticeDialog />
        {/* 在线取链缺播放包时的可操作提示（跳设置页安装） */}
        <PlayPackPrompt />
      </ErrorBoundary>

      {/* 8 向 resize 命中区（fixed 覆盖层，最后挂载保证在最上） */}
      <div aria-hidden className="pointer-events-none">
        {(["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const).map((d) => (
          <div key={d} className={`resize-hit resize-hit-${d} pointer-events-auto`} />
        ))}
      </div>
    </div>
  );
}
