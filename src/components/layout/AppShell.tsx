import { Suspense, useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import * as ipc from "@/services/ipc";
import { ONBOARDING_KEY } from "@/lib/storageKeys";
import { useAuthStore } from "@/stores/auth";
import { TitleBar } from "@/components/TitleBar";
import { Sidebar } from "@/components/layout/Sidebar";
import { KeepAliveOutlet, isKeepAlivePath } from "@/components/layout/KeepAliveOutlet";
import { ScrollTopLayer } from "@/components/layout/ScrollTopLayer";
import { PlayerBar } from "@/components/PlayerBar";
import { CommandPalette } from "@/components/common/CommandPalette";
import { QueuePanel } from "@/components/player/QueuePanel";
import { useFramelessWindow } from "@/hooks/useFramelessWindow";
import { usePlaybackEvents } from "@/hooks/usePlaybackEvents";
import { usePlayUrlBridge } from "@/hooks/usePlayUrlBridge";
import { useAppearanceEffect } from "@/hooks/useAppearanceEffect";
import { useCoverColor } from "@/hooks/useCoverColor";
import { usePlayingCoverBg } from "@/hooks/usePlayingCoverBg";
import { useLocalTrackOnlineMeta } from "@/hooks/useLocalTrackOnlineMeta";
import { useNowPlayingLocalMedia } from "@/hooks/useNowPlayingLocalMedia";
import { useExternalOpen } from "@/hooks/useExternalOpen";
import { useUpdateCheck } from "@/hooks/useUpdateCheck";
import { useSourceUpdateCheck } from "@/hooks/useSourceUpdateCheck";
import { useSourceAuthKeepalive } from "@/hooks/useSourceAuthKeepalive";
import { PlayPackPrompt } from "@/components/PlayPackPrompt";
import { SourceUpdatePrompt } from "@/components/SourceUpdatePrompt";
import { MetaPackGuide } from "@/components/MetaPackGuide";
import { useAppearanceStore } from "@/stores/appearance";
import { toastError } from "@/stores/toast";
import { usePlayerStore } from "@/stores/player";
import { useSourceRegistryStore } from "@/stores/sourceRegistry";
import { ensureSourceAuthInjected } from "@/lib/source-auth";
import { loadSourceQualities } from "@/lib/source-quality";
import { useDownloadsStore } from "@/stores/downloads";
import { useDislikesStore } from "@/stores/dislikes";
import { useDisclaimerStore } from "@/stores/disclaimer";
import { syncDownloadLyricSidecars } from "@/lib/downloadSidecars";
import { qtresCoverUrl } from "@/lib/lrc";
import { initStat, trackStatPage } from "@/lib/stat";
import { syncLogLevel } from "@/lib/logger";
import { UpdateDialog } from "@/components/update/UpdateDialog";
import { QtNoticeDialog } from "@/components/notice/qt-NoticeDialog";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { ToastHost } from "@/components/common/ToastHost";
import { FirstRunDisclaimer } from "@/components/common/FirstRunDisclaimer";
import { usePageEnter } from "@/hooks/usePageEnter";
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
  // 在播本地文件：内嵌封面优先于在线封面（本地优先命中时 platform 仍是原平台）
  useNowPlayingLocalMedia();
  // 外部打开（拖拽入窗 / 命令行参数 / 第二实例转发）：只挂一次，返回值只用于拖拽提示浮层
  const { dragging: externalDragging, count: externalDragCount } = useExternalOpen();
  // 数据库自愈回执：启动体检发现库损坏、已隔离重建时如实提示一次（Rust 侧取过即消失）。
  // 放在挂载时读一次而不是轮询：这条说明只在本次启动有意义。
  useEffect(() => {
    void ipc
      .takeDbNotice()
      .then((notice) => {
        if (notice) toastError(notice);
      })
      .catch(() => undefined);
  }, []);
  useUpdateCheck();
  // 播放音源包启动静默检查（只更新已装的官方包；未安装时不打扰）
  useSourceUpdateCheck();
  // 音源账号后台保活：启动 20s 后首检 + 每 6h 校验/轮换已登录凭据（静默）
  useSourceAuthKeepalive();
  // 音源/音质注册表：数据包声明的清单是所有音源选项的唯一来源，启动拉一次
  // （幂等；引擎未就绪时保持未加载，后续 ensure/refresh 会再试）
  const ensureRegistry = useSourceRegistryStore((s) => s.ensure);
  useEffect(() => {
    void ensureRegistry();
  }, [ensureRegistry]);

  // 音源账号登录态注入：数据包引擎（重）装载后要把已存凭据重灌给引擎内存副本
  // （引擎每次热切换/换包都从零开始）；引擎未就绪时静默，phase 转 ready 会重放
  useEffect(() => {
    void ensureSourceAuthInjected();
  }, []);

  // 各平台独立音质（音源账号页）：启动读表进缓存并全量推给引擎
  //（engine 的队列播放/无缝预加载按这张表取每首歌的请求音质）
  useEffect(() => {
    void loadSourceQualities();
  }, []);

  const bgImage = useAppearanceStore((s) => s.preference.bgImage);
  // 无封面 URL 的曲目（部分 wyy 曲 picUrl 为空）不渲染背景，避免退化成固定 --primary 色
  const playCoverUrl = usePlayerStore((s) =>
    s.state?.track?.picUrl ? qtresCoverUrl(s.state.track.picUrl) : null,
  );
  const navigate = useNavigate();
  const pathname = useLocation().pathname;
  // 非常驻路由的入场动画（常驻页由 display 切换自然重播，见 usePageEnter）
  const enterClass = usePageEnter(pathname);
  const isPlayingPage = pathname === "/playing";

  // 首次启动免责声明（装完第一次启动弹一次，读完 3 秒才能确认）：只读一次库
  useEffect(() => {
    void useDisclaimerStore.getState().init();
  }, []);

  // 首次启动引导：没完成过就先走引导流程（DESIGN §12）。
  // 等免责声明这一关结清再进：两场首启动流程叠在一起，用户既读不完声明也跳不出引导
  const disclaimerSettled = useDisclaimerStore((s) => s.pending === false);
  useEffect(() => {
    if (!disclaimerSettled) return;
    void (async () => {
      const done = await ipc.getSetting(ONBOARDING_KEY).catch(() => null);
      if (!done) {
        await navigate({ to: "/onboarding" });
      }
    })();
  }, [disclaimerSettled, navigate]);

  // 启动恢复登录态（读 Rust 侧保存的会话并拉用户信息）
  const initAuth = useAuthStore((s) => s.init);
  useEffect(() => {
    void initAuth();
  }, [initAuth]);

  // 使用统计（STATS_DESIGN §4.1/§7）：冷启动 launcher+show，路由变化记 page
  useEffect(() => {
    void initStat();
  }, []);
  // 前端日志级别跟后端的生效级别对齐（qt_admin 改过就按改过的来）
  useEffect(() => {
    void syncLogLevel();
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

  // 歌词补写（2026-11「下载歌曲同时下载封面和歌词」；2026-10 增加存储方式）：
  // 任务翻到「已完成」的那一次串行补取词，经 write_download_lyric 落盘——
  // 「音乐内嵌」时写进音频文件标签，「同目录文件」时写 `<音频文件名>.lrc`
  // （封面与已缓存词由 Rust 侧在下载成功时就地处理，见 download.rs 的
  // save_download_extras）。
  // 订阅 store 而不是 downloads-changed 事件：事件只驱动 refresh，词要等
  // refresh 把新状态写进 store 后才有得看。
  useEffect(() => {
    const off = useDownloadsStore.subscribe((s) => {
      syncDownloadLyricSidecars(s.tasks);
    });
    return off;
  }, []);

  // 屏蔽规则：启动拉一次。它不像下载那样有 Rust 事件驱动 —— 规则只可能由本窗口
  // 的写命令改动，而写命令所在的 store 动作自己会 refresh，这里补上冷启动那一次。
  const refreshDislikes = useDislikesStore((s) => s.refresh);
  useEffect(() => {
    void refreshDislikes();
  }, [refreshDislikes]);

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
              <Suspense fallback={<PageFallback shape="detail" />}>
                {/* 一级页面常驻缓存（切 tab 不再整页重载）；其余路由仍走 Outlet */}
                <KeepAliveOutlet pathname={pathname} />
                {!isKeepAlivePath(pathname) && (
                  // 入场类名由 usePageEnter 一并带出 h-full（页面根节点普遍是 h-full/flex）
                  <div className={enterClass}>
                    <Outlet />
                  </div>
                )}
              </Suspense>
            </ErrorBoundary>
          </div>
          {/* 「回到顶部」浮层（用户 m05249）：统一挂在这里，十几处长列表不必逐个挂 ref。
              位置固定在内容区右下角；播放队列是 main 的兄弟节点，面板展开时按钮
              自动停在面板左侧，不会钻到面板底下。 */}
          <ErrorBoundary label="回到顶部">
            <ScrollTopLayer resetKey={pathname} />
          </ErrorBoundary>
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

      {/* 右上角轻提示（3 秒自动消失）：批量收藏这类「做完了」的一次性回执挂这儿，
          不塞进页头把控件左右挤（用户 m09470）。挂在对话框之前，弹窗盖住它 */}
      <ErrorBoundary label="轻提示">
        <ToastHost />
      </ErrorBoundary>

      <ErrorBoundary label="对话框">
        {/* 首次启动的免责声明 / 开源通知（装完第一次启动弹一次）。
            层内最先挂，且自身用 z-[60] 高过其他 z-50 弹窗，两重保险都留着 */}
        {/* 命令面板（Ctrl/Cmd+K）：页面 / 设置 / 播放操作 / 搜索的统一入口 */}
        <CommandPalette />
        <FirstRunDisclaimer />
        {/* 更新弹窗（启动自动检查发现新版本时弹出，§15.3） */}
        <UpdateDialog />
        <QtNoticeDialog />
        {/* 在线取链缺播放包时的可操作提示（跳设置页安装） */}
        <PlayPackPrompt />
        {/* 音源包更新提示（发现可用更新时逐条确认，数据包优先） */}
        <SourceUpdatePrompt />
        {/* 未装数据包时的首页全屏引导（只指路设置页，不带下载动作） */}
        <MetaPackGuide />
      </ErrorBoundary>

      {/* 拖拽入窗提示：从系统里把音频/文件夹拖到窗口上，松手即开始播放（见 useExternalOpen）。
          整层 pointer-events-none —— 拖拽期间鼠标事件归系统管，这层只是提示 */}
      {externalDragging && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center"
        >
          <div className="absolute inset-3 rounded-xl border-2 border-dashed border-primary/60 bg-background/80" />
          <div className="relative rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-lg">
            {externalDragCount > 0
              ? `松手即播放这 ${externalDragCount} 个条目`
              : "松手即播放"}
          </div>
        </div>
      )}

      {/* 8 向 resize 命中区（fixed 覆盖层，最后挂载保证在最上） */}
      <div aria-hidden className="pointer-events-none">
        {(["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const).map((d) => (
          <div key={d} className={`resize-hit resize-hit-${d} pointer-events-auto`} />
        ))}
      </div>
    </div>
  );
}
