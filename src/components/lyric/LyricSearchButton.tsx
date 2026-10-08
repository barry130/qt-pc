import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";

import {
  applyPickedLyric,
  findLyricCandidates,
  peekLyricCandidates,
  type CrossSourceHit,
  type LyricCandidate,
} from "@/lib/localOnline";
import { useMusicSourceStore } from "@/stores/musicSource";
import { useSourceLabelFn, useSourceRegistryStore } from "@/stores/sourceRegistry";
import { useDismissOnOutside } from "@/hooks/useDismissOnOutside";
import { cn, errMsg } from "@/lib/utils";
import type { Lyric, SourceId, Track } from "@/types";

/**
 * 播放页「搜索歌词」入口（2026-10-07，用户 m09160：方案同换源一样）。
 *
 * 形态照搬换源按钮（PlayerBar 的 SourceSwitchButton）：点开向上/向下弹一个
 * 自绘 popover，点外面 / Esc 收起，结果带进程内缓存 + 「重新搜索」，点选就地生效。
 * 之前的 LyricSearchDialog 是全屏模态且只在「暂无歌词」空态里才有入口 —— 源站
 * 把词挂在 live / 翻唱 / 专辑版上时，自动链路拿到的空词没法从播放页纠错，
 * 而词不对版（有词但错版本）时压根没有入口。现在入口常驻偏移旁边，两种都能修。
 *
 * 复用既有链路，不新增后端能力：搜索 = sourceApi.searchMusic、取词 =
 * sourceApi.getLyric（都串在 localOnline.searchLyricCandidates 里），
 * 落库 = cmd_save_lyric（applyPickedLyric），不碰 lyric_settings.lyric_path。
 */
export function LyricSearchButton(props: {
  track: Track | null;
  /** 当前跨源兜底命中（换源在播时，选词结果要写进这条线路对应的缓存键） */
  cross: CrossSourceHit | null;
  /** 受控开关：播放页还有一个空态入口（「暂无歌词」里的大按钮）共用这一个弹层 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 用户选定后回调：调用方直接用这份歌词渲染（不必再走一次取词） */
  onPicked: (lyric: Lyric) => void;
}): React.JSX.Element {
  const { track, cross, open, onOpenChange, onPicked } = props;
  const boxRef = useRef<HTMLDivElement | null>(null);
  useDismissOnOutside(boxRef, open, () => onOpenChange(false));

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        data-testid="lyric-search-toggle"
        aria-label="搜索歌词"
        aria-expanded={open}
        title="搜索歌词（自动取词拿错版本/没有词时手动挑一份）"
        disabled={track === null}
        onClick={() => onOpenChange(!open)}
        className={cn(
          "flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors",
          track === null
            ? "cursor-not-allowed text-foreground/40"
            : "text-foreground/80 hover:bg-foreground/10",
          open && "bg-foreground/10 text-foreground",
        )}
      >
        <Search className="h-3.5 w-3.5" />
        搜索歌词
      </button>

      {open && track !== null && (
        <div
          data-testid="lyric-search-panel"
          className="absolute right-0 z-20 mt-1 w-[380px] max-w-[80vw] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"
        >
          <LyricSearchPanel
            track={track}
            cross={cross}
            onPicked={(lyric) => {
              onOpenChange(false);
              onPicked(lyric);
            }}
          />
        </div>
      )}
    </div>
  );
}

/** 弹层内容：关键字 + 音源 + 候选列表（挂载即搜，命中缓存不进 loading） */
function LyricSearchPanel(props: {
  track: Track;
  cross: CrossSourceHit | null;
  onPicked: (lyric: Lyric) => void;
}): React.JSX.Element {
  const { track, cross, onPicked } = props;
  const registrySources = useSourceRegistryStore((s) => s.sources);
  const ensureRegistry = useSourceRegistryStore((s) => s.ensure);
  const activeSourceId = useMusicSourceStore((s) => s.activeSourceId);
  const sourceLabel = useSourceLabelFn();

  /** 在线源 id 清单：本地源不在候选里（"local" 没有搜索面） */
  const sourceIds = useMemo(
    () => registrySources.map((s) => s.id).filter((id) => id !== "local"),
    [registrySources],
  );

  // 默认音源：曲目自己的源；本地曲目没有平台 id，退回当前激活源。曲目的源可能
  // 已下线（旧缓存曲目），那就退回清单里的第一个，避免一上来就搜一个不存在的源。
  const defaultSource = useMemo<SourceId>(() => {
    const want = track.platform === "local" ? activeSourceId : track.platform;
    if (sourceIds.includes(want)) return want;
    return sourceIds[0] ?? want;
  }, [track.platform, activeSourceId, sourceIds]);

  const defaultKeyword = useMemo(
    () => `${track.title} ${track.singer}`.trim(),
    [track.title, track.singer],
  );

  // effect 只认稳定 key：track 对象每次播放心跳都会换成字段全等的新对象，
  // 按对象引用依赖会无限重搜（换源面板踩过同一个坑）。
  const trackKey = `${track.platform}:${track.id}`;

  const [keyword, setKeyword] = useState(defaultKeyword);
  const [source, setSource] = useState<SourceId>(defaultSource);
  const [items, setItems] = useState<LyricCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [picking, setPicking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 搜索触发计数：点「搜索」/「重新搜索」时 +1（effect 依赖里参与触发） */
  const [attempt, setAttempt] = useState(0);

  // 换歌：关键字/音源回到新曲目的默认值。用**渲染期对齐**（而不是 effect 里
  // setState）：effect 里改要等下一轮渲染才生效，而搜索 effect 在同一轮已经用
  // 旧关键字跑了 —— 那样换歌后第一次搜的是上一首的歌名。
  const [keyFor, setKeyFor] = useState(trackKey);
  if (keyFor !== trackKey) {
    setKeyFor(trackKey);
    setKeyword(defaultKeyword);
    setSource(defaultSource);
  }

  // 搜索入参读最新值（换歌/改关键字后直接用新的），但**不进 effect 依赖**
  const latest = useRef({ track, cross });
  latest.current = { track, cross };
  const keywordRef = useRef(keyword);
  keywordRef.current = keyword;

  useEffect(() => {
    void ensureRegistry();
  }, [ensureRegistry]);

  useEffect(() => {
    let disposed = false;
    setError(null);
    const cached = peekLyricCandidates(source, keywordRef.current);
    if (cached !== null) {
      setItems(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    findLyricCandidates(source, keywordRef.current)
      .then((res) => {
        if (disposed) return;
        setItems(res);
      })
      .catch((err: unknown) => {
        if (disposed) return;
        setItems([]);
        setError(errMsg(err));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
    // keyword 故意不进依赖：边打字边搜会把源站打成筛子，只在点搜索/换源时重搜
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackKey, source, attempt]);

  const submit = (): void => {
    if (loading) return;
    setAttempt((n) => n + 1);
  };

  /** 忽略缓存重搜（「重新搜索」）：force 会覆盖缓存条目 */
  const refresh = (): void => {
    setError(null);
    setLoading(true);
    findLyricCandidates(source, keywordRef.current, undefined, true)
      .then((res) => setItems(res))
      .catch((err: unknown) => setError(errMsg(err)))
      .finally(() => setLoading(false));
  };

  const pick = async (candidate: LyricCandidate): Promise<void> => {
    const key = `${candidate.source}:${candidate.track.id}`;
    if (picking !== null) return;
    setPicking(key);
    setError(null);
    try {
      // 刷播放页缓存 + 落库都在这里（见 localOnline.applyPickedLyric 的注释：
      // 不刷缓存的话用户选完再进播放页命中的还是「暂无歌词」那条旧 Promise）
      await applyPickedLyric(latest.current.track, latest.current.cross, candidate);
      onPicked(candidate.lyric);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setPicking(null);
    }
  };

  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Search className="h-3 w-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">给「{track.title}」找歌词</span>
        {/* 结果有缓存（10 分钟内重开弹层直接复用），这里给一条强制重搜的路 */}
        <button
          type="button"
          disabled={loading}
          onClick={refresh}
          title="忽略缓存重新搜索"
          className={cn(
            "shrink-0 rounded px-1 py-0.5 transition-colors",
            loading ? "opacity-50" : "hover:bg-secondary/60 hover:text-foreground",
          )}
        >
          重新搜索
        </button>
      </div>

      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={keyword}
          onChange={(event) => setKeyword(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
          placeholder="歌名 歌手"
          aria-label="歌词搜索关键字"
          data-testid="lyric-search-keyword"
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <select
          value={source}
          onChange={(event) => setSource(event.currentTarget.value as SourceId)}
          aria-label="歌词搜索音源"
          className="h-8 shrink-0 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {sourceIds.map((id) => (
            <option key={id} value={id}>
              {sourceLabel(id)}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={submit}
          disabled={loading || keyword.trim().length === 0}
          className={cn(
            "flex h-8 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-xs transition-colors",
            loading || keyword.trim().length === 0 ? "opacity-50" : "hover:bg-accent",
          )}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Search className="h-3.5 w-3.5" />
          )}
          搜索
        </button>
      </div>

      {/* 本地曲目的 id 是文件路径，不能拿它去搜；提示一句用户才知道搜的是「歌名 + 歌手」 */}
      <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
        按「歌名 + 歌手」在其他版本里找词，选中后只用于当前这首
        {track.platform === "local" ? "本地曲目" : "歌"}，不会改动原文件。
      </p>

      {error !== null && (
        <div className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
          搜索失败：{error}
        </div>
      )}

      <div className="mt-2 max-h-72 overflow-y-auto">
        {loading ? (
          <div className="py-4 text-center text-xs text-muted-foreground">正在搜索歌词…</div>
        ) : items.length === 0 ? (
          <div className="py-4 text-center text-xs text-muted-foreground">
            没有找到带歌词的结果，试试去掉括号里的版本说明，或换个音源
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {items.map((item) => {
              const key = `${item.source}:${item.track.id}`;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => void pick(item)}
                  disabled={picking !== null}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                    picking !== null ? "opacity-50" : "hover:bg-secondary/60",
                  )}
                >
                  <span className="shrink-0 rounded bg-secondary/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {sourceLabel(item.source)}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-xs text-foreground/90">{item.track.title}</span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {item.track.singer}
                      {item.track.album.length > 0 ? ` · ${item.track.album}` : ""}
                    </span>
                  </span>
                  {/* 逐字 / 罗马音有没有，直接标出来：这是用户挑版本的实际依据之一 */}
                  {((item.lyric.wordByWord ?? "").length > 0 ||
                    (item.lyric.romanization ?? "").length > 0) && (
                    <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                      {(item.lyric.wordByWord ?? "").length > 0 ? "逐字" : ""}
                      {(item.lyric.wordByWord ?? "").length > 0 &&
                      (item.lyric.romanization ?? "").length > 0
                        ? "·"
                        : ""}
                      {(item.lyric.romanization ?? "").length > 0 ? "罗马音" : ""}
                    </span>
                  )}
                  {picking === key && (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
