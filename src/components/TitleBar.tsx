import { useState } from "react";
import { ArrowLeft, Settings } from "lucide-react";
import { Link, useRouter, useNavigate } from "@tanstack/react-router";
import { useTitleBarDrag } from "@/hooks/useFramelessWindow";
import { WindowControls } from "@/components/WindowControls";
import { MusicSourceSwitcher } from "@/components/music-source/MusicSourceSwitcher";
import { MessagesPopover } from "@/components/mine/MessagesPopover";
import { avatarUrl, displayName, useAuthStore } from "@/stores/auth";
import { useAppearanceStore } from "@/stores/appearance";
import { qtresCoverUrl } from "@/lib/lrc";
import { cn } from "@/lib/utils";

/**
 * 自定义标题栏（DESIGN §5.3）：
 * - 拖动区（按下即 startDragging）+ 双击最大化
 * - 返回 / Logo / 全局搜索框 / 音源切换器 / 消息中心·设置·账号 / 窗口控制
 * - 按钮区 stopPropagation 防止误触发拖动
 */
export function TitleBar(): React.JSX.Element {
  const { ref, onDoubleClick } = useTitleBarDrag();
  const [keyword, setKeyword] = useState("");
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

  const goSearch = (): void => {
    const kw = keyword.trim();
    if (!kw) return;
    void navigate({ to: "/search", search: { q: kw } });
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
          aria-label="返回上一步"
          title="返回"
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-foreground/80 transition-colors hover:bg-secondary hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") goSearch();
          }}
          placeholder="搜索歌曲 / 歌手 / 专辑 / 歌单"
          className="h-7 w-full max-w-72 rounded-full border border-input bg-background px-3 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
        <MusicSourceSwitcher />
      </div>

      {/* 右：消息中心 / 设置 / 账号 + 窗口控制 */}
      <div className="flex h-full items-stretch">
        <MessagesPopover />
        <Link
          to="/settings/$section"
          params={{ section: "appearance" }}
          title="设置"
          aria-label="设置"
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          // 圆角小块 hover，与中间返回键的圆形 hover 同一形状语言；
          // 窗口控制仍是贴边全高矩形（Windows 惯例，命中区到窗沿）
          className="mx-1 flex h-8 w-9 items-center justify-center self-center rounded-md text-foreground/80 transition-colors hover:bg-secondary hover:text-foreground"
        >
          <Settings className="h-4 w-4" />
        </Link>
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
        <WindowControls />
      </div>
    </div>
  );
}
