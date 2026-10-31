import { ArrowLeft, Palette, Search, Settings } from "lucide-react";
import { Link, useRouter, useNavigate } from "@tanstack/react-router";
import { useTitleBarDrag } from "@/hooks/useFramelessWindow";
import { WindowControls } from "@/components/WindowControls";
import { MusicSourceSwitcher } from "@/components/music-source/MusicSourceSwitcher";
import { useHint } from "@/components/common/Hint";
import { MessagesPopover } from "@/components/mine/MessagesPopover";
import { avatarUrl, displayName, useAuthStore } from "@/stores/auth";
import { useAppearanceStore } from "@/stores/appearance";
import { qtresCoverUrl } from "@/lib/lrc";
import { cn } from "@/lib/utils";

/**
 * 自定义标题栏（DESIGN §5.3）：
 * - 拖动区（按下即 startDragging）+ 双击最大化
 * - 返回 / Logo / 搜索入口（点击打开独立的搜索页）/ 音源切换器 / 账号·通知·设置·皮肤 / 窗口控制
 * - 按钮区 stopPropagation 防止误触发拖动
 */
export function TitleBar(): React.JSX.Element {
  const { ref, onDoubleClick } = useTitleBarDrag();
  const navigate = useNavigate();
  const router = useRouter();
  const session = useAuthStore((s) => s.session);
  const profile = useAuthStore((s) => s.profile);
  // 有背景图时标题栏底色半透明（见 --sidebar-surface），此时去掉 backdrop-blur-sm：
  // 那层 8px 模糊会把标题栏里的壁纸糊掉，与内容区之间出现一条明显的模糊分界。
  const hasBgImage = useAppearanceStore((s) => Boolean(s.preference.bgImage));
  // 头像地址：CSP 不放开外部域名，远程头像经 qtres 代理（Rust 代取）加载
  const avatar = avatarUrl(profile);
  const avatarSrc = avatar ? qtresCoverUrl(avatar) : null;

  /**
   * 标题栏不再自己收关键词：搜索是一个**独立页面**（/search，含搜索历史 /
   * 热门搜索 / 热门歌单 / 结果页签），标题栏只做「打开它」的入口。
   *
   * 为什么不做成「标题栏输入 + 回车跳结果页」：那样输入框要重复实现一遍联想、
   * 清空、防抖，而落地页（历史 + 热搜）只有整页才有地方摆 —— 用户点开搜索
   * 却看到一张空列表，等于每次都在盲搜。
   */
  // 两个圆形/方块图标按钮走自绘 tooltip：悬停 380ms 即出，深色皮肤下不再是系统白框
  const backHint = useHint("返回上一步");
  const settingsHint = useHint("设置");
  const skinHint = useHint("皮肤");
  const goSearch = (): void => {
    void navigate({ to: "/search", search: { q: "", type: "song" } });
  };

  return (
    <div
      ref={ref}
      onDoubleClick={onDoubleClick}
      // relative + z-20 不能省：标题栏有 backdrop-blur，会自成层叠上下文，
      // 而它本身是非定位元素 —— 后面内容区的 `relative z-10` 会盖在它上面，
      // 把音源切换的下拉（z-50 被关在这个层叠上下文内）整个遮住，
      // 表现就是「点了没反应」。给标题栏一个高于内容区的层级即可。
      className={cn(
        "relative z-20 flex h-[40px] shrink-0 select-none items-center justify-between border-b border-border bg-[color:var(--sidebar-surface)] pr-0",
        !hasBgImage && "backdrop-blur-sm",
      )}
    >
      {/* 左：Logo + 应用名 */}
      <div className="flex h-full items-center gap-2 pl-3">
        <img src="/app-icon.png" alt="" className="h-5 w-5" draggable={false} />
        <span className="text-sm font-semibold">轻听</span>
      </div>

      {/* 中：返回 + 全局搜索框 + 音源切换器 */}
      <div className="flex h-full min-w-0 flex-1 items-center justify-center gap-2 px-6">
        {/* 返回：路由用的是 memory history，必须走 router.history（window.history 无效） */}
        <button
          type="button"
          onClick={() => router.history.back()}
          {...backHint.hintProps}
          aria-label="返回上一步"
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-foreground/80 transition-colors hover:bg-secondary hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        {backHint.hintLayer}
        <button
          type="button"
          onClick={goSearch}
          title="打开搜索页：搜索历史 · 热门搜索 · 热门歌单"
          aria-label="搜索"
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          className="flex h-7 w-full max-w-72 items-center gap-1.5 rounded-full border border-input bg-background px-3 text-xs text-muted-foreground transition-colors hover:border-ring/60 hover:text-foreground"
        >
          <Search className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">搜索歌曲 / 歌手 / 专辑 / 歌单</span>
          <kbd className="ml-auto hidden shrink-0 rounded border border-border/60 px-1 text-3xs text-muted-foreground sm:inline">
            Ctrl K
          </kbd>
        </button>
        <MusicSourceSwitcher />
      </div>

      {/* 右：账号 / 通知 / 设置 / 皮肤 + 窗口控制
          （顺序按用户 2026-10-31 要求：头像在最内、窗口控制贴右沿） */}
      <div className="flex h-full items-stretch">
        <Link
          to={session ? "/profile" : "/login"}
          title={session ? displayName(profile, "账号") : "登录"}
          aria-label={session ? "个人中心" : "登录"}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          className="mx-1 flex h-8 w-9 items-center justify-center self-center rounded-md transition-colors hover:bg-secondary"
        >
          {/* 真实头像优先，拿不到（未登录/无头像字段/代理转换失败）回退应用 logo */}
          <img
            src={avatarSrc ?? "/static/icon/xxxhdpi.png"}
            alt=""
            className="h-5 w-5 rounded-full object-cover"
            draggable={false}
          />
        </Link>
        <MessagesPopover />
        <Link
          to="/settings/$section"
          params={{ section: "general" }}
          {...settingsHint.hintProps}
          aria-label="设置"
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          // 圆角小块 hover，与中间返回键的圆形 hover 同一形状语言；
          // 窗口控制仍是贴边全高矩形（Windows 惯例，命中区到窗沿）
          className="mx-1 flex h-8 w-9 items-center justify-center self-center rounded-md text-foreground/80 transition-colors hover:bg-secondary hover:text-foreground"
        >
          <Settings className="h-4 w-4" />
        </Link>
        {settingsHint.hintLayer}
        {/* 皮肤：原先藏在「设置 → 外观」两跳之后，换肤是高频操作，直接给一级入口 */}
        <Link
          to="/appearance"
          {...skinHint.hintProps}
          aria-label="皮肤"
          title="皮肤与外观"
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          className="mx-1 flex h-8 w-9 items-center justify-center self-center rounded-md text-foreground/80 transition-colors hover:bg-secondary hover:text-foreground"
        >
          <Palette className="h-4 w-4" />
        </Link>
        {skinHint.hintLayer}
        <WindowControls />
      </div>
    </div>
  );
}
