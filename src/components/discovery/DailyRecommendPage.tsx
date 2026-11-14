import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { listen } from "@tauri-apps/api/event";
import { SOURCE_META_CHANGED_EVENT, SOURCE_PACK_CHANGED_EVENT } from "@/services/ipc";
import { onAccountRecommendationContextChange } from "@/lib/account-recommendation";
import { safeAccountRecommendationError } from "@/lib/account-recommendation-error";
import { RefreshCw, SlidersHorizontal } from "lucide-react";
import type { Track } from "@/types";
import { usePlayerStore } from "@/stores/player";
import { useRecommendationSourceStore } from "@/stores/recommendation-source";
import { useSourceRegistryStore } from "@/stores/sourceRegistry";
import { RecommendationSourceControl } from "@/components/common/RecommendationSourceControl";
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
import { DetailHero, HeroCover, HeroEyebrow, HeroPlayButton } from "@/components/ui";
import {
  DAILY_HISTORY_DAYS,
  DAILY_MODE_LABEL,
  DAILY_STYLE_SEED_MAX,
  DAILY_TASTE_HINT,
  DAILY_TASTE_LABEL,
  DAILY_TASTE_ORDER,
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
  const dailySource = useRecommendationSourceStore((s) => s.daily);
  const accountMode = dailySource.origin === "account";
  const selectionRevision = useRecommendationSourceStore((s) => s.dailyRevision);
  const sourceName = useSourceRegistryStore((s) => s.sources.find((source) => source.id === dailySource.sourceId)?.name ?? dailySource.sourceId);

  const [result, setResult] = useState<DailyRecommendResult | null>(null);
  const [mode, setMode] = useState<DailyRecommendMode>("rule");
  const [taste, setTaste] = useState<DailyTaste>("heart");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 冷启动里勾选的风格（点「按这些风格生成」才落库，避免每点一下就搜一轮网络） */
  const [stylePicked, setStylePicked] = useState<string[]>([]);
  const [sortValue, setSortValue] = useState(DEFAULT_TRACK_SORT);
  const [providerRefresh, setProviderRefresh] = useState(0);

  const runningRef = useRef(false);
  const aliveRef = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  const providerEpochRef = useRef(0);
  const requestIdRef = useRef(0);
  const initialEngineNoticeRef = useRef(false);
  const playAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      providerEpochRef.current += 1;
      requestIdRef.current += 1;
      runningRef.current = false;
      playAbortRef.current?.abort();
    };
  }, []);

  const invalidate = useCallback((clearResult = true): void => {
    providerEpochRef.current += 1;
    requestIdRef.current += 1;
    runningRef.current = false;
    playAbortRef.current?.abort();
    playAbortRef.current = null;
    if (!aliveRef.current) return;
    setLoading(false);
    setProgress("");
    setError(null);
    if (clearResult) {
      setResult(null);
      setSelected(new Set());
      setStylePicked([]);
      setSortValue(DEFAULT_TRACK_SORT);
    }
  }, []);

  // Revocation is subscribed while hidden too; initial engine readiness is not a pack replacement.
  useEffect(() => {
    const refresh = (): void => {
      invalidate();
      if (aliveRef.current) setProviderRefresh((value) => value + 1);
    };
    const stopSelection = useRecommendationSourceStore.subscribe((state, previous) => {
      if (state.dailyRevision !== previous.dailyRevision || state.daily.origin !== previous.daily.origin || state.daily.sourceId !== previous.daily.sourceId) invalidate();
    });
    const stopContext = onAccountRecommendationContextChange((feature) => {
      if (feature === "fm" || useRecommendationSourceStore.getState().daily.origin !== "account") return;
      if (feature === undefined && !initialEngineNoticeRef.current) { initialEngineNoticeRef.current = true; return; }
      refresh();
    });
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const onPackChanged = (event: { payload: unknown }): void => {
      const payload = event.payload;
      if (payload !== null && typeof payload === "object" && "kind" in payload && payload.kind === "play") return;
      if (useRecommendationSourceStore.getState().daily.origin !== "account") return;
      initialEngineNoticeRef.current = true;
      refresh();
    };
    for (const event of [SOURCE_META_CHANGED_EVENT, SOURCE_PACK_CHANGED_EVENT]) {
      void listen(event, onPackChanged).then((unlisten) => {
        if (disposed) unlisten(); else unlisteners.push(unlisten);
      }).catch(() => undefined);
    }
    return () => { disposed = true; stopSelection(); stopContext(); for (const unlisten of unlisteners) unlisten(); };
  }, [invalidate]);

  /** Cache, progress, errors and finally all belong to the same request/provider epoch. */
  const runRequest = useCallback(async (force: boolean, tasteOverride?: DailyTaste, checkCache = false): Promise<void> => {
    if (!activeRef.current || (runningRef.current && !checkCache)) return;
    const requestId = ++requestIdRef.current;
    const epoch = providerEpochRef.current;
    let provider: { origin: string; sourceId: string; revision: number } | null = null;
    const isCurrent = (): boolean => {
      const snapshot = useRecommendationSourceStore.getState();
      return aliveRef.current && activeRef.current && requestId === requestIdRef.current && epoch === providerEpochRef.current &&
        (!provider || (snapshot.daily.origin === provider.origin && snapshot.daily.sourceId === provider.sourceId && snapshot.dailyRevision === provider.revision));
    };
    runningRef.current = true;
    setLoading(true); setError(null); setProgress(force ? "重新获取中…" : "准备中…");
    try {
      await useRecommendationSourceStore.getState().load();
      if (!isCurrent()) return;
      const snapshot = useRecommendationSourceStore.getState();
      provider = { ...snapshot.daily, revision: snapshot.dailyRevision };
      let currentMode: DailyRecommendMode | undefined;
      let currentTaste = tasteOverride;
      // Account requests never read or alter the application/global AI and local taste settings.
      if (provider.origin === "app") {
        const preferences = await Promise.all([readMode(), currentTaste === undefined ? readTaste() : Promise.resolve(currentTaste)]);
        if (!isCurrent()) return;
        [currentMode, currentTaste] = preferences;
        setMode(currentMode); setTaste(currentTaste);
      }
      let next = checkCache ? await loadTodayResult(currentMode, currentTaste) : null;
      if (!isCurrent()) return;
      initialEngineNoticeRef.current = true;
      if (!next) {
        next = await generateDailyRecommend({ force, mode: currentMode, taste: currentTaste, isCurrent,
          onProgress: (text) => { if (isCurrent()) setProgress(text); } });
      }
      if (!isCurrent()) return;
      setResult(next); setSelected(new Set());
      if (next.origin === "account") setSortValue(DEFAULT_TRACK_SORT);
      if (next.notice) toast(next.notice);
    } catch (err) {
      if (isCurrent()) setError(provider?.origin === "account" ? safeAccountRecommendationError(err).message : errMsg(err));
    } finally {
      if (isCurrent()) { runningRef.current = false; setLoading(false); setProgress(""); }
    }
  }, []);

  const generate = useCallback((force: boolean, tasteOverride?: DailyTaste): Promise<void> => runRequest(force, tasteOverride), [runRequest]);
  const load = useCallback((): Promise<void> => runRequest(false, undefined, true), [runRequest]);

  const pickTaste = useCallback(async (next: DailyTaste): Promise<void> => {
    if (useRecommendationSourceStore.getState().daily.origin === "account" || next === taste || runningRef.current) return;
    const epoch = providerEpochRef.current;
    setTaste(next);
    try { await saveTaste(next); } catch { /* The explicit taste still applies to this generation. */ }
    if (aliveRef.current && activeRef.current && epoch === providerEpochRef.current) await generate(true, next);
  }, [taste, generate]);

  const applyStyleSeeds = useCallback(async (names: string[]): Promise<void> => {
    if (useRecommendationSourceStore.getState().daily.origin === "account" || runningRef.current || names.length === 0) return;
    const epoch = providerEpochRef.current;
    try { await saveStyleSeeds(names); }
    catch (err) { if (aliveRef.current && activeRef.current && epoch === providerEpochRef.current) toastError(errMsg(err)); return; }
    // Force already bypasses today's app cache; never clear a newly selected account cache.
    if (aliveRef.current && activeRef.current && epoch === providerEpochRef.current) await generate(true);
  }, [generate]);

  useEffect(() => {
    if (!active) { invalidate(false); return; }
    void load();
    return () => { requestIdRef.current += 1; runningRef.current = false; };
  }, [active, dailySource.origin, dailySource.sourceId, selectionRevision, providerRefresh, load, invalidate]);

  const songs = useMemo(() => result?.items.map((item) => item.track) ?? [], [result]);
  /** 应用推荐允许显示排序；账号推荐始终保留平台原始顺序。 */
  /** 排序作用在「可见列表」上，所以播放全部 / 批量管理 / TrackList 拿的都是这个顺序 */
  const { key: sortKey, desc: sortDesc } = parseTrackSort(sortValue);
  const sortedTracks = useMemo(() => accountMode ? songs : sortTracks(songs, sortKey, sortDesc), [accountMode, songs, sortKey, sortDesc]);
  const playAll = useCallback((): void => {
    const epoch = providerEpochRef.current;
    playAbortRef.current?.abort();
    const controller = new AbortController();
    playAbortRef.current = controller;
    const isCurrent = (): boolean => aliveRef.current && activeRef.current && epoch === providerEpochRef.current && !controller.signal.aborted;
    void playQueue(sortedTracks, 0, undefined, isCurrent, controller.signal)
      .catch((err) => { if (isCurrent()) toastError(accountMode ? safeAccountRecommendationError(err).message : errMsg(err)); })
      .finally(() => { if (playAbortRef.current === controller) playAbortRef.current = null; });
  }, [playQueue, sortedTracks, accountMode]);
  useEffect(() => { if (accountMode) setSortValue(DEFAULT_TRACK_SORT); }, [accountMode, dailySource.sourceId]);
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
      <div className="shrink-0 border-b border-border px-6 py-3">
        <RecommendationSourceControl feature="daily" />
      </div>
      {/* hero 与歌单 / 榜单详情页同一套；**不能加 overflow-hidden**（批量条面板是
          absolute 展开的，裁切只加在铺底图那一层） */}
      
        <DetailHero coverUrl={coverUrl}>

        <div className="relative flex gap-5 px-6 pb-6 pt-6">
          {/* 封面（h-44，176px）定义整块 hero 的高度：右侧内容必须塞进这个高度里，
              不能把页头撑得比封面高（用户 2026-10-24：「高度不要超过图片，内容
              全部往右边搭」）。比歌单/专辑页的 144px 大一号 —— 这页右侧信息更多。 */}
          <HeroCover src={coverUrl} fallback="推" size="lg" />

          <div className="flex min-w-0 flex-1 flex-col justify-end">
            {/* 元信息与「共 N 首」并成一行：hero 高度由封面定死，右侧每多一行就会
                把页头撑得比封面高（用户 2026-10-24）。模型名长的时候靠 truncate 收住。 */}
            <HeroEyebrow className="truncate text-2xs">{/* 本地模型精选时把模型名也写出来：用户要能看出「这次真的是哪个模型在挑」 */}
              {accountMode
                ? `${result?.date ? `${result.date} · ` : ""}${sourceName || "平台账号"} · 平台账号 · ${loading ? progress || "获取中…" : `共 ${songs.length} 首`}`
                : result
                  ? `${result.date} · ${modeLabel}${result.model ? ` · ${result.model}` : ""} · ${tasteLabel} · ${loading ? progress || "生成中…" : `共 ${songs.length} 首`}`
                  : "全部已装音源"}</HeroEyebrow>
            <h1 className="mt-1 truncate text-2xl font-bold tracking-tight">
              {result?.title || "每日推荐"}
            </h1>
            {/* 摘要只给两行：hero 高度由封面定死，多一行就会把页头撑高 */}
            <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
              {result?.summary || (accountMode ? "仅使用所选平台账号的每日推荐，保留平台返回顺序。" : "按你的播放记录挑的，每天换一批")}
            </p>
            {/* 口味画像 + 本期风格线并排一行：页头高度由封面定死，右侧内容不能
                再多占一行（用户 2026-10-24：「高度不要超过图片，内容全部往右边搭」）。
                画像文字可截断（全文放 title），风格线 chip 不换行。
                - 口味画像：用户 2026-10-23 反馈推荐不该只看歌手，那就要让他能验证按什么推。
                - 本期风格线：用户 2026-10-24 反馈「风格能再多变一点、推荐维度再多一点」，
                  候选池搜宽后要把「这期覆盖了哪几条线」摊开；老缓存没有 styleLanes、
                  或这次没有风格线证据（空数组）→ chips 部分整块不渲染。 */}
            <div className="mt-2 flex min-w-0 items-center gap-2">
              {!accountMode && result?.profileText ? (
                <p
                  className="min-w-0 truncate text-xs text-muted-foreground/80"
                  title={`口味画像：${result.profileText}`}
                >
                  口味画像：{result.profileText}
                </p>
              ) : null}
              {!accountMode && result?.styleLanes?.length ? (
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="text-2xs text-muted-foreground">本期风格</span>
                  <ul role="list" aria-label="本期风格" className="flex items-center gap-1.5">
                    {result.styleLanes.map((lane) => (
                      <li
                        key={lane.label}
                        title={`本期歌单里来自「${lane.label}」这条风格线的歌曲数`}
                        className="whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-2xs text-muted-foreground"
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
              {!accountMode ? <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="推荐口味">
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
              </div> : null}

              {!accountMode ? <span className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden /> : null}

              <HeroPlayButton disabled={songs.length === 0} onClick={playAll} />
              <IconButton
                label={accountMode ? "刷新平台推荐" : "换一批"}
                variant="outline"
                size="lg"
                disabled={loading}
                onClick={() => void generate(true)}
              >
                <RefreshCw className={loading ? "animate-spin" : undefined} />
              </IconButton>
              {!accountMode ? <IconButton
                label="AI 模式设置"
                variant="outline"
                size="lg"
                onClick={() => void navigate({ to: "/settings/$section", params: { section: "ai" } })}
              >
                <SlidersHorizontal />
              </IconButton> : null}
            </div>
          </div>

          {!loading && songs.length > 0 ? (
            <div className="relative flex shrink-0 flex-col items-end justify-end gap-2 pb-1">
              {!accountMode ? <TrackSortSelect value={sortValue} onChange={setSortValue} /> : null}
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
      </DetailHero>

      {/* 冷启动：没有播放历史/收藏/风格种子时，先让用户点几个风格当画像起点。
          不选也能看下面这批平台新歌 —— 等于自动兜底"先给内容"，不让新用户对着空页面。 */}
      {!accountMode && result?.coldStart ? (
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
          <ErrorRetry message={`${accountMode ? "获取失败" : "生成失败"}：${error}`} onRetry={() => void generate(true)} />
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
              {accountMode ? `按平台原始顺序显示，共 ${songs.length} 首；不使用应用曲库补齐或重排。` : <>
                候选来自全部已装音源；心动模式优先收藏（含收藏歌单）；近 {DAILY_HISTORY_DAYS}{" "}
                天推过的歌会排到后面，同一歌手不会连着排
              </>}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
