import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Play, RefreshCw, SlidersHorizontal } from "lucide-react";
import type { Track } from "@/types";
import { usePlayerStore } from "@/stores/player";
import { useKeepAliveActive } from "@/components/layout/keepAliveActive";
import { qtresCoverUrl } from "@/lib/lrc";
import { retainTrackSelection, trackSelectionKey } from "@/lib/track-selection";
import { errMsg } from "@/lib/utils";
import { toast, toastError } from "@/stores/toast";
import { IconButton } from "@/components/common/IconButton";
import { TrackList } from "./TrackList";
import { TrackSortSelect } from "@/components/TrackSortSelect";
import { DEFAULT_TRACK_SORT, parseTrackSort, sortTracks } from "@/lib/track-sort";
import { BatchBar } from "./BatchBar";
import { ErrorRetry, TrackRowsSkeleton } from "./Skeletons";
import {
  DAILY_HISTORY_DAYS,
  DAILY_MODE_LABEL,
  DAILY_STYLE_SEED_MAX,
  DAILY_TASTE_HINT,
  DAILY_TASTE_LABEL,
  DAILY_TASTE_ORDER,
  clearTodayResult,
  generateDailyRecommend,
  loadTodayResult,
  parseDailyRecommendMode,
  readMode,
  readTaste,
  saveStyleSeeds,
  saveTaste,
  type DailyRecommendMode,
  type DailyRecommendResult,
  type DailyTaste,
} from "@/lib/daily-recommend";

/**
 * 每日推荐（路由 /daily-recommend）。
 *
 * 与「每日新歌」（/daily）是两个功能，刻意分成两个入口：
 * - 每日新歌 = 当前音源的**最新歌曲流**，跟"你"没关系，谁发新歌就有什么；
 * - 每日推荐 = 按**你自己的播放历史**挑的，跨天变化、屏蔽生效、可 AI 精选。
 *
 * ---------------------------------------------------------------------------
 * 为什么整条链路都在客户端
 * ---------------------------------------------------------------------------
 * 要读的偏好全在本机（`play_stats` 累计播放、`liked_songs` 收藏、屏蔽规则），
 * "推荐没听过的歌"又必须走音源搜索 —— 音源脚本跑在 Tauri 侧，只有客户端能搜。
 * 所以：本地偏好 → 多路音源搜索 → 规则筛选 → （可选）客户端直连模型精选。
 * 细节见 `@/lib/daily-recommend` 的文件头。
 *
 * ---------------------------------------------------------------------------
 * 三件必须做对的事（都踩过坑）
 * ---------------------------------------------------------------------------
 * 1. **命中当天缓存就不重算**：搜索要打十几个音源请求，每次进页面都重算既慢
 *    又会让"今天的推荐"每点一次就变一批。缓存按 `日期 + 模式 + 规则版本` 命中。
 * 2. **keep-alive 重新激活要重校验**：本页是常驻页（切走不卸载），只在挂载时
 *    加载会让"昨天生成的结果"在跨天后还挂在页面上。用 `useKeepAliveActive()`。
 * 3. **AI 只排序不决定歌曲**：交给模型的候选池是客户端搜好、过滤好的，
 *    模型只回序号 + 理由；越界/重复的序号直接丢，模型挂了退回规则结果。
 *    —— 所以模型编不出歌，也编不出 id。
 */
export function DailyRecommendPage(): React.JSX.Element {
  const navigate = useNavigate();
  const active = useKeepAliveActive();
  const playQueue = usePlayerStore((s) => s.playQueue);

  const [result, setResult] = useState<DailyRecommendResult | null>(null);
  const [mode, setMode] = useState<DailyRecommendMode>("rule");
  const [taste, setTaste] = useState<DailyTaste>("heart");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 冷启动里勾选的风格（点「按这些风格生成」才落库，避免每点一下就搜一轮网络） */
  const [stylePicked, setStylePicked] = useState<string[]>([]);

  /** 同一时刻只允许一次生成；切页/重进不能叠着跑两遍搜索 */
  const runningRef = useRef(false);
  /** 卸载后不再 setState（搜索要十几秒，用户可能早就切走了） */
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  /**
   * 生成一版。
   *
   * `taste` 显式传进来（而不是让底层去读设置）：刚点完口味按钮时设置可能还没落盘，
   * 显式传值能保证这次一定按用户刚点的口味算。
   */
  const generate = useCallback(
    async (force: boolean, tasteOverride?: DailyTaste): Promise<void> => {
      if (runningRef.current) return;
      runningRef.current = true;
      setLoading(true);
      setError(null);
      setProgress(force ? "重新生成中…" : "准备中…");
      try {
        const next = await generateDailyRecommend({
          force,
          taste: tasteOverride,
          onProgress: (text) => {
            if (aliveRef.current) setProgress(text);
          },
        });
        if (!aliveRef.current) return;
        setResult(next);
        setSelected(new Set());
        // 降级 / 候选不足之类的说明：右上角说一句就走，不占列表区
        if (next.notice) toast(next.notice);
      } catch (err) {
        if (aliveRef.current) setError(errMsg(err));
      } finally {
        runningRef.current = false;
        if (aliveRef.current) {
          setLoading(false);
          setProgress("");
        }
      }
    },
    [],
  );

  /** 点口味标签：立刻存设置并按新口味重算一批（不满足于只改设置不重算） */
  const pickTaste = useCallback(
    async (next: DailyTaste): Promise<void> => {
      if (next === taste || runningRef.current) return;
      setTaste(next);
      try {
        await saveTaste(next);
      } catch {
        // 存不进库不影响本次生成：下面的 generate 会显式带上口味
      }
      await generate(true, next);
    },
    [taste, generate],
  );

  /**
   * 冷启动：用户点完风格 → 存成画像种子 → 清掉当天的冷启动缓存 → 立刻按风格重算。
   *
   * 必须清缓存：不清的话 `loadTodayResult` 会把刚才那份冷启动结果原样还回来，
   * 用户点了风格却发现列表没变，会以为按钮坏了。
   */
  const applyStyleSeeds = useCallback(
    async (names: string[]): Promise<void> => {
      if (runningRef.current || names.length === 0) return;
      try {
        await saveStyleSeeds(names);
        await clearTodayResult();
      } catch (err) {
        toastError(errMsg(err));
        return;
      }
      await generate(true);
    },
    [generate],
  );

  /** 首次挂载 + 每次重新可见时跑一次。
   *
   * 先看缓存：命中就直接展示（不闪骨架、不打搜索请求）；没命中才生成。
   * 跨天时 `loadTodayResult` 返回 null，于是自动重算 —— 这就是"每天第一次进来生成"。
   * 缓存命中判定交给 `loadTodayResult(mode, taste)`（它内部用 effectiveMode 归一，
   * 所以设成「服务端 AI」时不会每次都重搜一遍）。
   */
  const load = useCallback(async (): Promise<void> => {
    try {
      const [currentMode, currentTaste] = await Promise.all([readMode(), readTaste()]);
      if (!aliveRef.current) return;
      setMode(currentMode);
      setTaste(currentTaste);
      const cached = await loadTodayResult(currentMode, currentTaste);
      if (!aliveRef.current) return;
      if (cached) {
        setResult(cached);
        return;
      }
      await generate(false, currentTaste);
    } catch (err) {
      if (aliveRef.current) setError(errMsg(err));
    }
  }, [generate]);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load]);

  const songs = useMemo(() => result?.items.map((item) => item.track) ?? [], [result]);
  /** 排序（默认顺序）：只改显示顺序，不改数据本身；下拉选项与 uniappx 一致 */
  const [sortValue, setSortValue] = useState(DEFAULT_TRACK_SORT);
  /** 排序作用在「可见列表」上，所以播放全部 / 批量管理 / TrackList 拿的都是这个顺序 */
  const { key: sortKey, desc: sortDesc } = parseTrackSort(sortValue);
  const sortedTracks = useMemo(() => sortTracks(songs, sortKey, sortDesc), [songs, sortKey, sortDesc]);
  const styleOptions = result?.coldStart ? (result.styleOptions ?? []) : [];

  // 新结果到手就清空勾选（此刻的 coldStart 状态已经变了，旧勾选没有意义）
  useEffect(() => {
    setStylePicked([]);
  }, [result?.generatedAt]);

  const toggleStyle = useCallback((name: string): void => {
    setStylePicked((prev) => {
      if (prev.includes(name)) return prev.filter((item) => item !== name);
      if (prev.length >= DAILY_STYLE_SEED_MAX) return prev;
      return [...prev, name];
    });
  }, []);

  // 换一批后列表整体换了，勾选集里残留的旧 id 会让「已选 N 首」虚高；
  // 这里只做收窄、不清空（与 DailyPage 同口径）。
  useEffect(() => {
    const tracks = result?.items.map((item) => item.track) ?? [];
    setSelected((prev) => retainTrackSelection(tracks, prev));
  }, [result]);

  // 行内推荐理由的索引：`TrackList` 逐行调用，若每行现做 `items.find` 就是
  // O(n²)（50 行 × 50 项，近万次比较/每次重渲）。这里按 platform:id 建一次 Map。
  const reasonByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of result?.items ?? []) {
      map.set(`${item.track.platform}:${item.track.id}`, item.reason);
    }
    return map;
  }, [result]);

  /** 行内推荐理由：`TrackList` 每行调用一次，用 useCallback 保住引用稳定 */
  const reasonOf = useCallback(
    (track: Track): string | undefined => reasonByKey.get(`${track.platform}:${track.id}`),
    [reasonByKey],
  );

  /** 行首复选框切换：必须 useCallback 稳定，否则每次渲染换新函数会让 TrackList 的 memo 全失效 */
  const toggleSelect = useCallback((key: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const cover = songs.find((track) => track.picUrl)?.picUrl;
  const coverUrl = cover ? qtresCoverUrl(cover) : null;

  // 小标签显示**实际生效**的模式（设成「服务端 AI」时结果是规则，就如实写规则）
  const modeLabel = DAILY_MODE_LABEL[parseDailyRecommendMode(result?.mode ?? mode)];
  // 结果里带的口味优先（老缓存没有这个字段 → 回落当前设置）
  const tasteLabel = DAILY_TASTE_LABEL[result?.taste ?? taste];

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* hero 与歌单 / 榜单详情页同一套；**不能加 overflow-hidden**（批量条面板是
          absolute 展开的，裁切只加在铺底图那一层） */}
      <header className="relative shrink-0 border-b border-border">
        {coverUrl ? (
          <div className="absolute inset-0 overflow-hidden">
            <img
              src={coverUrl}
              alt=""
              aria-hidden
              draggable={false}
              className="absolute inset-0 h-full w-full scale-125 select-none object-cover opacity-45 blur-3xl saturate-150"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-background/10 to-[color:var(--page-fade)]" />
          </div>
        ) : null}

        <div className="relative flex gap-5 px-6 pb-6 pt-6">
          {/* 封面（h-44，176px）定义整块 hero 的高度：右侧内容必须塞进这个高度里，
              不能把页头撑得比封面高（用户 2026-10-24：「高度不要超过图片，内容
              全部往右边搭」）。比歌单/专辑页的 144px 大一号 —— 这页右侧信息更多。 */}
          <div className="h-44 w-44 shrink-0 overflow-hidden rounded-2xl bg-secondary shadow-xl ring-1 ring-border">
            {coverUrl ? (
              <img src={coverUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-4xl font-bold text-muted-foreground/50">
                推
              </span>
            )}
          </div>

          <div className="flex min-w-0 flex-1 flex-col justify-end">
            {/* 元信息与「共 N 首」并成一行：hero 高度由封面定死，右侧每多一行就会
                把页头撑得比封面高（用户 2026-10-24）。模型名长的时候靠 truncate 收住。 */}
            <p className="truncate text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
              {/* 本地模型精选时把模型名也写出来：用户要能看出「这次真的是哪个模型在挑」 */}
              {result
                ? `${result.date} · ${modeLabel}${result.model ? ` · ${result.model}` : ""} · ${tasteLabel} · ${
                    loading ? progress || "生成中…" : `共 ${songs.length} 首`
                  }`
                : "全部已装音源"}
            </p>
            <h1 className="mt-1 truncate text-2xl font-bold tracking-tight">
              {result?.title || "每日推荐"}
            </h1>
            {/* 摘要只给两行：hero 高度由封面定死，多一行就会把页头撑高 */}
            <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
              {result?.summary || "按你的播放记录挑的，每天换一批"}
            </p>
            {/* 口味画像 + 本期风格线并排一行：页头高度由封面定死，右侧内容不能
                再多占一行（用户 2026-10-24：「高度不要超过图片，内容全部往右边搭」）。
                画像文字可截断（全文放 title），风格线 chip 不换行。
                - 口味画像：用户 2026-10-23 反馈推荐不该只看歌手，那就要让他能验证按什么推。
                - 本期风格线：用户 2026-10-24 反馈「风格能再多变一点、推荐维度再多一点」，
                  候选池搜宽后要把「这期覆盖了哪几条线」摊开；老缓存没有 styleLanes、
                  或这次没有风格线证据（空数组）→ chips 部分整块不渲染。 */}
            <div className="mt-2 flex min-w-0 items-center gap-2">
              {result?.profileText ? (
                <p
                  className="min-w-0 truncate text-xs text-muted-foreground/80"
                  title={`口味画像：${result.profileText}`}
                >
                  口味画像：{result.profileText}
                </p>
              ) : null}
              {result?.styleLanes?.length ? (
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground">本期风格</span>
                  <ul role="list" aria-label="本期风格" className="flex items-center gap-1.5">
                    {result.styleLanes.map((lane) => (
                      <li
                        key={lane.label}
                        title={`本期歌单里来自「${lane.label}」这条风格线的歌曲数`}
                        className="whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground"
                      >
                        {`${lane.label} ${lane.count}`}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>

            {/* 口味（推荐策略）与操作按钮并排一行：hero 高度已经被封面定死，
                多一行就把页头撑得比封面高，右侧会空出一大块（这页信息本来就多）。 */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="推荐口味">
                {DAILY_TASTE_ORDER.map((item) => {
                  const on = item === taste;
                  return (
                    <button
                      key={item}
                      type="button"
                      aria-pressed={on}
                      title={DAILY_TASTE_HINT[item]}
                      disabled={loading}
                      onClick={() => void pickTaste(item)}
                      className={`h-7 rounded-full border px-3 text-xs transition-colors disabled:opacity-40 ${
                        on
                          ? "border-primary bg-primary/15 font-medium text-primary"
                          : "border-border text-muted-foreground hover:border-primary hover:text-foreground"
                      }`}
                    >
                      {DAILY_TASTE_LABEL[item]}
                    </button>
                  );
                })}
              </div>

              <span className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden />

              <IconButton
                label="播放全部"
                variant="primary"
                size="lg"
                disabled={songs.length === 0}
                className="h-9 w-9 rounded-lg shadow-lg shadow-primary/25"
                onClick={() => void playQueue(sortedTracks, 0)}
              >
                <Play className="h-4 w-4 fill-current" />
              </IconButton>
              <IconButton
                label="换一批"
                variant="outline"
                size="lg"
                disabled={loading}
                onClick={() => void generate(true)}
              >
                <RefreshCw className={loading ? "animate-spin" : undefined} />
              </IconButton>
              <IconButton
                label="AI 模式设置"
                variant="outline"
                size="lg"
                onClick={() => void navigate({ to: "/settings/$section", params: { section: "ai" } })}
              >
                <SlidersHorizontal />
              </IconButton>
            </div>
          </div>

          {!loading && songs.length > 0 ? (
            <div className="relative flex shrink-0 flex-col items-end justify-end gap-2 pb-1">
              <TrackSortSelect value={sortValue} onChange={setSortValue} />
              <BatchBar
                embedded
                tracks={sortedTracks}
                selected={selected}
                selectionKey={trackSelectionKey}
                onSelectedChange={setSelected}
                onError={(text) => {
                  // BatchBar 传 null 表示「清掉上一次的提示」；浮层自己会走，不用管
                  if (text) toastError(text);
                }}
              />
            </div>
          ) : null}
        </div>
      </header>

      {/* 冷启动：没有播放历史/收藏/风格种子时，先让用户点几个风格当画像起点。
          不选也能看下面这批平台新歌 —— 等于自动兜底"先给内容"，不让新用户对着空页面。 */}
      {result?.coldStart ? (
        <section className="shrink-0 border-b border-border bg-secondary/30 px-6 py-4">
          <p className="text-sm font-medium">你爱听什么风格？</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            还没有你的播放记录。选 1–{DAILY_STYLE_SEED_MAX} 个风格，我按这些风格来挑；不选也行，先听下面这批。
          </p>
          {styleOptions.length > 0 ? (
            <>
              <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="选择风格">
                {styleOptions.map((option) => {
                  const on = stylePicked.includes(option.name);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={on}
                      disabled={loading}
                      onClick={() => toggleStyle(option.name)}
                      className={`h-7 rounded-full border px-3 text-xs transition-colors disabled:opacity-40 ${
                        on
                          ? "border-primary bg-primary/15 font-medium text-primary"
                          : "border-border text-muted-foreground hover:border-primary hover:text-foreground"
                      }`}
                    >
                      {option.name}
                    </button>
                  );
                })}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={loading || stylePicked.length === 0}
                  onClick={() => void applyStyleSeeds(stylePicked)}
                  className="h-8 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  按这些风格生成
                  {stylePicked.length > 0 ? `（${stylePicked.length}）` : ""}
                </button>
                {stylePicked.length >= DAILY_STYLE_SEED_MAX ? (
                  <span className="text-xs text-muted-foreground">
                    最多选 {DAILY_STYLE_SEED_MAX} 个
                  </span>
                ) : null}
              </div>
            </>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              当前音源没有提供风格分类，先听下面这批；听几首之后推荐就会开始像你。
            </p>
          )}
        </section>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <ErrorRetry message={`生成失败：${error}`} onRetry={() => void generate(true)} />
        ) : loading && songs.length === 0 ? (
          <TrackRowsSkeleton rows={8} />
        ) : songs.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="max-w-md text-sm text-muted-foreground">
              {result?.summary || "还没有可以推荐的歌。"}
            </p>
            <button
              type="button"
              onClick={() => void generate(true)}
              className="h-8 rounded-md border border-border px-4 text-sm transition-colors hover:bg-secondary"
            >
              再试一次
            </button>
          </div>
        ) : (
          <>
            {loading ? (
              <div className="px-6 pt-4 text-xs text-muted-foreground">{progress || "生成中…"}</div>
            ) : null}
            <TrackList
              tracks={sortedTracks}
              showIndex
              showCollect
              showDownload
              reasonOf={reasonOf}
              selection={{ ids: selected, onToggle: toggleSelect, onChange: setSelected }}
            />
            <p className="py-4 text-center text-xs text-muted-foreground">
              候选来自全部已装音源；心动模式优先收藏（含收藏歌单）；近 {DAILY_HISTORY_DAYS}{" "}
              天推过的歌会排到后面，同一歌手不会连着排
            </p>
          </>
        )}
      </div>
    </div>
  );
}
