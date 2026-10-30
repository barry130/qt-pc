import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { isComposingEnter } from "@/lib/keyboard";
import { useNavigate } from "@tanstack/react-router";
import {
  BarChart3,
  Clock,
  Compass,
  Download,
  KeyRound,
  ListMusic,
  Music,
  Pause,
  Play,
  Radio,
  Search,
  Settings,
  SkipBack,
  SkipForward,
  Sparkles,
  Subtitles,
  Disc3,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { usePlayerStore } from "@/stores/player";
import * as ipc from "@/services/ipc";

/**
 * 命令面板（Ctrl/Cmd + K）。
 *
 * 为什么值得单独做一个入口：这个应用的可达性全靠侧栏 + 顶部按钮，找「下载管理」
 * 要点两层、找「关于」要进设置再选页签。命令面板把这 20 多个目的地压成
 * 「敲两个字 + 回车」，是键盘用户唯一能一次性抵达全站的入口。
 *
 * 三类条目（同一列表、同一优先级排序）：
 * - 页面：与侧栏/设置页签一一对应，纯导航
 * - 操作：播放控制、桌面歌词开关（走 IPC，与标题栏按钮同一份实现）
 * - 搜索：输入没有命中任何条目时，最后一条固定是「搜索 “xxx”」，回车进搜索页
 *
 * 不做的事（刻意）：不在这里直连搜索接口做联想。搜索页有自己的取数、分页与
 * 空态，两套实现必然漂移；面板只负责把词带过去。
 */

type CommandKind = "page" | "action" | "search";

interface Command {
  id: string;
  kind: CommandKind;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  keywords: string;
  run: () => void;
}

interface PageEntry {
  label: string;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  keywords?: string;
}

/** 与 components/layout/Sidebar.tsx 的两个导航组保持一致（改那里时记得同步） */
const PAGES: PageEntry[] = [
  { label: "首页", to: "/", icon: Radio, keywords: "home 推荐" },
  { label: "每日推荐", to: "/daily-recommend", icon: Compass, keywords: "daily" },
  { label: "每日新歌", to: "/daily", icon: Clock, keywords: "daily new" },
  { label: "歌单广场", to: "/playlists", icon: ListMusic, keywords: "playlist" },
  { label: "排行榜", to: "/charts", icon: BarChart3, keywords: "chart rank" },
  { label: "我的歌单", to: "/my/playlists", icon: ListMusic, keywords: "mine 收藏" },
  { label: "音源账号", to: "/source-accounts", icon: KeyRound, keywords: "account login" },
  { label: "本地音乐", to: "/library", icon: Music, keywords: "local" },
  { label: "下载管理", to: "/downloads", icon: Download, keywords: "download task" },
  { label: "最近播放", to: "/history", icon: Clock, keywords: "history" },
  { label: "听歌报告", to: "/stats", icon: BarChart3, keywords: "stats report" },
  { label: "音乐助手", to: "/ai-assistant", icon: Sparkles, keywords: "ai assistant" },
];

/** 设置页各页签（components/SettingsPage.tsx 的 section 键） */
const SETTINGS_SECTIONS: { label: string; section: string }[] = [
  { label: "通用", section: "general" },
  { label: "外观", section: "appearance" },
  { label: "桌面歌词", section: "desktop-lyric" },
  { label: "播放", section: "playback" },
  { label: "播放条", section: "player-bar" },
  { label: "声音", section: "sound" },
  { label: "下载", section: "download" },
  { label: "网络", section: "network" },
  { label: "AI 设置", section: "ai" },
  { label: "屏蔽", section: "dislike" },
  { label: "音源包", section: "source-package" },
  { label: "快捷键", section: "shortcut" },
  { label: "关于", section: "about" },
];

/**
 * 极简匹配：先看标签是否以查询开头（最强），再看是否包含，最后看关键词。
 * 不引入模糊匹配库 —— 条目只有 30 个上下，包含匹配已经足够，且结果可预期
 * （用户不会遇到「打 a 出现一堆不相干条目」那种打分玄学）。
 */
function scoreOf(cmd: Command, query: string): number {
  if (query === "") return 1;
  const label = cmd.label.toLowerCase();
  if (label.startsWith(query)) return 100 - label.length;
  if (label.includes(query)) return 60 - label.indexOf(query);
  if (cmd.keywords.includes(query)) return 30;
  if (cmd.hint !== undefined && cmd.hint.toLowerCase().includes(query)) return 20;
  return 0;
}

const KIND_HINT: Record<CommandKind, string> = {
  page: "页面",
  action: "操作",
  search: "搜索",
};

export function CommandPalette(): React.JSX.Element | null {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    // 查询清零放到关闭时：再次打开应该是干净的面板，而不是上次的残留结果
    setQuery("");
    setActiveIndex(0);
  }, []);

  // Esc / Tab 循环提到 dialog 层：面板自报 aria-modal，就得让焦点真的关在里面，
  // 关闭后焦点回到打开它的元素（评审 2026-10-29）。
  useFocusTrap(dialogRef, open, close);

  // 全局开关键：Ctrl+K / Cmd+K。用 capture 阶段监听，避免被页面里的输入框
  // （搜索页、歌词拖拽等）先吃掉 —— 但输入框内的 Ctrl+K 依然要能关掉面板，
  // 所以 close 的 Esc 不在这里处理，交给面板自己的 onKeyDown。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== "k") return;
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setOpen((prev) => !prev);
      if (!open) setQuery("");
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  // 打开后立刻聚焦输入框（autoFocus 不够：面板是条件渲染，聚焦时机在挂载后）
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(id);
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];

    for (const page of PAGES) {
      list.push({
        id: `page:${page.to}`,
        kind: "page",
        label: page.label,
        icon: page.icon,
        keywords: `${page.label} ${page.keywords ?? ""} ${page.to}`.toLowerCase(),
        run: () => {
          void navigate({ to: page.to });
        },
      });
    }

    for (const section of SETTINGS_SECTIONS) {
      list.push({
        id: `settings:${section.section}`,
        kind: "page",
        label: `设置 · ${section.label}`,
        hint: "设置",
        icon: Settings,
        keywords: `settings 设置 ${section.label} ${section.section}`.toLowerCase(),
        run: () => {
          void navigate({
            to: "/settings/$section",
            params: { section: section.section },
          });
        },
      });
    }

    list.push(
      {
        id: "action:toggle",
        kind: "action",
        label: "播放 / 暂停",
        hint: "空格",
        icon: Play,
        keywords: "play pause 播放 暂停 toggle",
        run: () => {
          void usePlayerStore.getState().toggle();
        },
      },
      {
        id: "action:next",
        kind: "action",
        label: "下一首",
        icon: SkipForward,
        keywords: "next 下一首 切歌",
        run: () => {
          void usePlayerStore.getState().nextTrack();
        },
      },
      {
        id: "action:prev",
        kind: "action",
        label: "上一首",
        icon: SkipBack,
        keywords: "previous prev 上一首",
        run: () => {
          void usePlayerStore.getState().prevTrack();
        },
      },
      {
        id: "action:playing",
        kind: "page",
        label: "正在播放",
        hint: "播放页",
        icon: Disc3,
        keywords: "playing now 播放页 正在播放",
        run: () => {
          void navigate({ to: "/playing" });
        },
      },
      {
        id: "action:desktop-lyric",
        kind: "action",
        label: "开关桌面歌词",
        icon: Subtitles,
        keywords: "desktop lyric 桌面歌词 subtitle",
        run: () => {
          // 与标题栏按钮同一判定：先问状态再决定显隐，避免状态漂移
          void ipc
            .getDesktopLyricState()
            .then((st) => (st.visible ? ipc.hideDesktopLyric() : ipc.showDesktopLyric()))
            .catch(() => undefined);
        },
      },
      {
        id: "action:pause",
        kind: "action",
        label: "暂停",
        icon: Pause,
        keywords: "pause 暂停",
        run: () => {
          void usePlayerStore.getState().toggle();
        },
      },
      {
        id: "action:search",
        kind: "page",
        label: "打开搜索页",
        hint: "Ctrl+F 语义",
        icon: Search,
        keywords: "search 搜索 找歌",
        run: () => {
          void navigate({ to: "/search", search: { q: "", type: "song" } });
        },
      },
    );

    return list;
  }, [navigate]);

  const trimmed = query.trim().toLowerCase();

  const results = useMemo<Command[]>(() => {
    const scored = commands
      .map((cmd) => ({ cmd, score: scoreOf(cmd, trimmed) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.cmd);

    if (trimmed === "") return scored;

    // 自由输入永远有出口：最后一条把词带进搜索页
    scored.push({
      id: "search:free",
      kind: "search",
      label: `搜索 “${query.trim()}”`,
      hint: "在搜索页打开",
      icon: Search,
      keywords: "",
      run: () => {
        void navigate({ to: "/search", search: { q: query.trim(), type: "song" } });
      },
    });
    return scored;
  }, [commands, trimmed, query, navigate]);

  if (!open) return null;

  const runAt = (index: number): void => {
    const cmd = results[index];
    if (cmd === undefined) return;
    close();
    cmd.run();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-sm"
      onClick={close}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-xl overflow-hidden rounded-xl border border-border/60 bg-popover/95 shadow-raised backdrop-blur-xl"
      >
        <div className="flex items-center gap-2 border-b border-border/50 px-3.5">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close();
                return;
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((prev) => (results.length === 0 ? 0 : (prev + 1) % results.length));
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((prev) =>
                  results.length === 0 ? 0 : (prev - 1 + results.length) % results.length,
                );
                return;
              }
              if (event.key === "Enter") {
                // 拼音选字的回车不是「执行」：放过它，否则跳到无关页面
                if (isComposingEnter(event)) return;
                event.preventDefault();
                runAt(activeIndex);
              }
            }}
            placeholder="搜索页面、设置或操作，回车打开…"
            role="combobox"
            aria-expanded
            aria-controls="qt-command-list"
            aria-activedescendant={results[activeIndex] ? `qt-cmd-${results[activeIndex].id}` : undefined}
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-3xs text-muted-foreground">
            Esc
          </kbd>
        </div>

        <div
          id="qt-command-list"
          role="listbox"
          aria-label="命令结果"
          className="max-h-[46vh] overflow-y-auto p-1.5"
        >
          {results.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              没有匹配的页面或操作
            </div>
          ) : (
            results.map((cmd, index) => {
              const Icon = cmd.icon;
              const active = index === activeIndex;
              return (
                <button
                  key={cmd.id}
                  id={`qt-cmd-${cmd.id}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => runAt(index)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors duration-fast",
                    active ? "bg-secondary text-foreground" : "text-muted-foreground",
                  )}
                >
                  <Icon className={cn("h-4 w-4 shrink-0", active ? "text-primary" : "")} />
                  <span className="min-w-0 flex-1 truncate">{cmd.label}</span>
                  {cmd.hint !== undefined ? (
                    <span className="shrink-0 text-3xs text-muted-foreground">{cmd.hint}</span>
                  ) : null}
                  <span className="shrink-0 text-3xs text-muted-foreground/70">
                    {KIND_HINT[cmd.kind]}
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border/50 px-3 py-2 text-3xs text-muted-foreground">
          <span>↑↓ 选择 · ↵ 打开 · Esc 关闭</span>
          <span>{results.length} 项</span>
        </div>
      </div>
    </div>
  );
}
