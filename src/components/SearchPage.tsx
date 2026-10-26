import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Play, Search, SearchX, Trash2, X } from "lucide-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { Album, Artist, Playlist, Track } from "@/types";
import {
  useSearchPageMax,
  useSourceRegistryStore,
  useSourceSupports,
} from "@/stores/sourceRegistry";
import * as sourceApi from "@/source-scripts";
import { usePagedList, type PageResult } from "@/hooks/usePagedList";
import { parseSearchType, type SearchType } from "@/lib/search-params";
import { usePlayerStore } from "@/stores/player";
import { useMusicSourceStore } from "@/stores/musicSource";
import {
  addSearchHistory,
  clearSearchHistory,
  getSearchHistory,
  removeSearchHistoryItem,
} from "@/lib/search-history";
import { qtresCoverUrl, formatTime } from "@/lib/lrc";
import { readAggregateSources } from "@/lib/aggregate-sources";
import { songKey } from "@/lib/song-key";
import { formatPlayCount } from "@/lib/format";
import { CoverCard, CoverGrid } from "./discovery/CoverCard";
import { TrackRowsSkeleton } from "./discovery/Skeletons";
import { BackButton } from "@/components/layout/BackButton";
import { IconButton } from "@/components/common/IconButton";
import { SourceTag } from "@/components/common/SourceTag";

/**
 * 搜索页（路由 /search?q=，DESIGN §5.2：关键字走 URL query，前进 / 后退可复现）。
 *
 * 四类结果对应脚本层四个动作（DESIGN §6.5）：
 * - 歌曲   searchMusic（聚合模式走 data 包 searchMerged：包内打全部音源并合并成一条
 *          去重、按相关性排序的列表；不按源分段，见 lib/song-key.ts 与 DESIGN §1.2）
 * - 歌单   searchPlaylists → 跳歌单详情
 * - 歌手   searchArtists   → 跳歌手详情
 * - 专辑   searchAlbums    → 跳专辑详情
 *
 * 输入区还有三件配套事：
 * - 落地页（无 q）= **搜索首页**：搜索历史（settings 持久化）+ 多源聚合热门搜索
 *   （allHotWords，不跟随当前音源）；进来就把光标放进输入框，标题栏那个搜索入口点一下就落到这里
 * - 输入中：按历史 + 热搜词前缀/包含联想（音源包没有 suggest 接口，取自本地数据）
 * - 聚合开关只作用于「歌曲」页签（歌单/歌手/专辑保持当前源）
 *
 * 翻页（2026-10）：四类结果与聚合模式都走 `usePagedList` 滚动续页，哨兵挂在
 * 列表末尾。搜索类接口没有 total/hasMore 返回位，收尾只能靠「满页 = 可能还有
 * 下一页」推断（见 fetchPage），所以每页条数必须等于音源包自述的 searchPageMax。
 *
 * 页签（`?type=`）进 URL（2026-10）：搜索页不在 KeepAliveOutlet 的常驻名单里，
 * 从歌单 / 歌手 / 专辑详情页返回时本组件是重新挂载的 —— 页签留在 useState 里
 * 就会被打回默认的「歌曲」，用户从「歌单」点进去的歌单，返回看到的是歌曲列表。
 * 详见 lib/search-params.ts。
 */
type Tab = SearchType;

const TABS: { key: Tab; label: string }[] = [
  { key: "song", label: "歌曲" },
  { key: "playlist", label: "歌单" },
  { key: "artist", label: "歌手" },
  { key: "album", label: "专辑" },
];

/**
 * 分页命中的判别联合：**一个页签一种 kind**，而 resetKey 里带页签 ⇒ 列表里
 * 只会出现一种 kind。包一层是因为 usePagedList 只吃单一元素类型，而四个页签
 * 的结果模型不同（Track / Playlist / Artist / Album）——比堆四份分页状态干净，
 * 也让「聚合模式的行内源标」能直接从 track.platform 还原（searchAllBatches 已把
 * platform 归属到每首曲目）。
 */
type SearchHit =
  | { kind: "song"; track: Track }
  | { kind: "playlist"; playlist: Playlist }
  | { kind: "artist"; artist: Artist }
  | { kind: "album"; album: Album };

/** 翻页去重键：四个模型都有 platform + id，kind 前缀防跨页签串味 */
function hitKey(hit: SearchHit): string {
  switch (hit.kind) {
    case "song":
      return `song:${hit.track.platform}:${hit.track.id}`;
    case "playlist":
      return `playlist:${hit.playlist.platform}:${hit.playlist.id}`;
    case "artist":
      return `artist:${hit.artist.platform}:${hit.artist.id}`;
    case "album":
      return `album:${hit.album.platform}:${hit.album.id}`;
  }
}

/** 引擎侧结构不符时 sourceCall 会抛；这里再兜一层非数组，避免整页白屏 */
function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

export function SearchPage(): React.JSX.Element {
  const urlParams = useSearch({ strict: false }) as { q?: string; type?: string };
  const navigate = useNavigate();
  const activeSourceId = useMusicSourceStore((s) => s.activeSourceId);
  const aggregateMode = useMusicSourceStore((s) => s.aggregateMode);
  const setAggregateMode = useMusicSourceStore((s) => s.setAggregateMode);

  // 功能面门控（v4 契约）：数据包声明当前源有没有歌单载体/歌手页/专辑，
  // 不支持的结果页签直接不渲染（这三类按当前源搜索，搜了也永远是空列表）；
  // 未声明（旧包）一律按支持处理。「歌曲」恒在——单曲搜索是所有源的必备能力。
  const supportsPlaylists = useSourceSupports(activeSourceId, "playlists");
  const supportsArtist = useSourceSupports(activeSourceId, "artist");
  const supportsAlbum = useSourceSupports(activeSourceId, "album");
  const tabs = useMemo(
    () =>
      TABS.filter((t) => {
        if (t.key === "playlist") return supportsPlaylists;
        if (t.key === "artist") return supportsArtist;
        if (t.key === "album") return supportsAlbum;
        return true;
      }),
    [supportsPlaylists, supportsArtist, supportsAlbum],
  );

  const [keyword, setKeyword] = useState(urlParams.q ?? "");
  const [history, setHistory] = useState<string[]>([]);
  const [hotWords, setHotWords] = useState<string[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const play = usePlayerStore((s) => s.play);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const currentTrackId = usePlayerStore((s) => s.state?.trackId ?? null);

  /** 稳定回调：搜索结果行 memo 的前提（行内只把 track 递回来） */
  const playTrack = useCallback(
    (track: Track): void => {
      void play(track);
    },
    [play],
  );

  // URL 上的 q / type 是本次搜索的唯一真源（前进 / 后退 / 从详情页返回可复现，
  // DESIGN §5.2）。**页签不能用 useState**：本页不常驻，返回时会重新挂载，
  // 本地 state 会被初始化成默认值 —— 从「歌单」进详情再返回就变回歌曲列表。
  const q = urlParams.q?.trim() ?? "";
  const tab = parseSearchType(urlParams.type);

  /**
   * 每页条数必须**等于音源包自述的 searchPageMax**：搜索类接口没有 total/hasMore
   * 返回位，「满页 = 可能还有下一页」是唯一的收尾依据。传超限值会在第 1 页就被
   * 判成到底 —— 酷狗恒给 30、QQ 要 100 直接返回 0 条（见 AlbumPage 同名注释）。
   *
   * 聚合模式一次请求打四源、只能有一个 size，取**所有在线源的最小值**：只要一个
   * 源的上限低于它，那个源就会恒定返回不满页，所以整轮的「还有下一页」按「任一
   * 源满页」判（见 fetchPage），而不是看合并后的总条数。
   */
  const sourcePageMax = useSearchPageMax(activeSourceId);
  const registrySources = useSourceRegistryStore((s) => s.sources);
  const aggPageSize = useMemo(() => {
    const maxes = registrySources
      .map((s) => s.searchPageMax)
      .filter((n): n is number => typeof n === "number" && n > 0);
    return maxes.length > 0 ? Math.min(...maxes) : sourcePageMax;
  }, [registrySources, sourcePageMax]);
  const pageSize = tab === "song" && aggregateMode ? aggPageSize : sourcePageMax;

  /**
   * 重置键：换词 / 换页签 / 切聚合开关 / 换音源 / 换每页条数（注册表异步到位）
   * 都回第一页重拉。**activeSourceId 也进键**：聚合模式下它其实不影响取数，但
   * 换源即重搜的语义要和单源一致，不能只在单源路径生效。
   */
  const resetKey = `${q}|${tab}|${aggregateMode ? "agg" : "one"}|${activeSourceId}|${pageSize}`;

  /**
   * 「上游分页参数不生效」的兜底：部分音源会无视 page 反复返回同一页，而
   * hasMore 按「满页 = 还有」恒为真 → 哨兵一相交就无限续页、把上游打爆。
   * 记一份本轮已见 id：一整页全是被去重掉的重复条目 ⇒ 立即收尾。
   */
  const seenRef = useRef<{ key: string; ids: Set<string>; songs: Set<string> }>({
    key: "",
    ids: new Set(),
    songs: new Set(),
  });

  /**
   * 取第 page 页。**显式回 `{ list, hasMore }`**（而不是让 usePagedList 按
   * `list.length >= pageSize` 推断）有两个理由：
   * - 聚合模式的合并总数 = 源数 × 每页条数，拿它比 pageSize 会在最后一页把
   *   「四源各剩几条」误判成还满一页，白打一轮请求；
   * - 顺手带上「本页是否真有新条目」的收尾判定。
   */
  const fetchPage = async (page: number): Promise<PageResult<SearchHit>> => {
    if (!q) return { list: [], hasMore: false };
    if (seenRef.current.key !== resetKey) {
      seenRef.current = { key: resetKey, ids: new Set<string>(), songs: new Set<string>() };
    }
    let hits: SearchHit[];
    let full: boolean;
    if (tab === "song" && aggregateMode) {
      // 聚合音源由设置决定（设置 → 音源包 → 聚合搜索音源；null = 全部）
      const aggSources = (await readAggregateSources()) ?? undefined;
      // **合并去重与相关性排序在数据包里做**（`searchMerged`，META_REVISION 7）：
      // 多源的标题写法、版本后缀、元数据完整度都是音源层的知识，各端各写一份必然
      // 漂移。宿主只负责「拿一条已经排好的列表」；旧数据包没有该入口时，门面会
      // 自动退回「拉分批 + 本地合并」，结果形状一致。
      const page1 = await sourceApi.searchMergedPage(q, page, pageSize, {
        sources: aggSources,
        preferSource: activeSourceId,
      });
      const merged = asArray(page1.tracks);
      // 跨页去重按「同一首歌」而不是「同一源的同一个 id」：翻第 2 页时，第 1 页
      // 已经出现过的歌往往会在**另一个源**再搜到一次，只比 platform:id 会漏掉它。
      const songKeys = seenRef.current.songs;
      const fresh = merged.filter((track) => {
        const key = songKey(track);
        if (songKeys.has(key)) return false;
        songKeys.add(key);
        return true;
      });
      hits = fresh.map((track) => ({ kind: "song" as const, track }));
      // 「还有下一页」由数据包按**合并前的各源原始条数**判定（`full`）：合并去重
      // 后的条数必然少于各源之和，拿它比 pageSize 会在第 1 页就误判到底。
      full = page1.full;
    } else if (tab === "song") {
      const list = asArray(await sourceApi.searchMusic(q, activeSourceId, page, pageSize));
      hits = list.map((track) => ({ kind: "song" as const, track }));
      full = list.length >= pageSize;
    } else if (tab === "playlist") {
      const list = asArray(await sourceApi.searchPlaylists(activeSourceId, q, page, pageSize));
      hits = list.map((playlist) => ({ kind: "playlist" as const, playlist }));
      full = list.length >= pageSize;
    } else if (tab === "artist") {
      const list = asArray(await sourceApi.searchArtists(activeSourceId, q, page, pageSize));
      hits = list.map((artist) => ({ kind: "artist" as const, artist }));
      full = list.length >= pageSize;
    } else {
      const list = asArray(await sourceApi.searchAlbums(activeSourceId, q, page, pageSize));
      hits = list.map((album) => ({ kind: "album" as const, album }));
      full = list.length >= pageSize;
    }
    const ids = seenRef.current.ids;
    const fresh = hits.filter((hit) => !ids.has(hitKey(hit)));
    for (const hit of hits) ids.add(hitKey(hit));
    return { list: hits, hasMore: full && fresh.length > 0 };
  };

  // 搜索代际、请求去重、追加去重全部交给 usePagedList：resetKey 一变（换词 /
  // 换页签 / 换源 / 切聚合）就在同一帧回第一页重拉，旧请求的应答被丢弃
  const { items, loading, loadingMore, error, hasMore, sentinelRef, reload } =
    usePagedList<SearchHit>({
      fetchPage,
      keyOf: hitKey,
      resetKey,
      pageSize,
    });

  // 有 q 才算「搜过」：落地页（历史 + 热搜）只在没有关键词时展示
  const searched = q.length > 0;
  const searching = searched && loading;
  // 失败只让出「首屏」：续页失败时 error 有值，但已加载的结果必须继续展示
  // （usePagedList 在非首页失败时保留 items），否则用户会以为列表被清空了
  const showResults = error === null || items.length > 0;

  // 当前页签被功能面挤掉（切音源/换包后）时回退「歌曲」，否则内容区会停在
  // 一个已不渲染的页签上。页签在 URL 里 ⇒ 回退也必须改写 URL（replace，
  // 不留历史），不能只改本地 state
  useEffect(() => {
    if (tabs.some((t) => t.key === tab)) return;
    void navigate({ to: "/search", search: { q, type: "song" }, replace: true });
  }, [tabs, tab, q, navigate]);

  // 搜索历史只在挂载时读一次（增删在本地改完同步落盘）
  useEffect(() => {
    void getSearchHistory().then(setHistory).catch(() => {});
  }, []);

  /**
   * 落地页（没有关键词）是**搜索的入口**而不是一张空列表：进来就把光标放进
   * 输入框，用户从标题栏点「搜索」之后可以直接打字。
   *
   * 只在落地页抢焦点：带着 `?q=` 进来（前进 / 后退 / 从详情页返回）时焦点
   * 不该跳走 —— 那时用户要看的是结果，而不是准备输入下一句。
   */
  useEffect(() => {
    if (!searched) inputRef.current?.focus();
  }, [searched]);

  // 热搜榜是跨源聚合（allHotWords：多源并发合并去重），与当前音源无关，
  // 挂载时拉一次即可；接口失败静默隐藏（热搜是锦上添花，不该打扰搜索）。
  // sources 与聚合搜索共用同一份白名单勾选（readAggregateSources）。
  useEffect(() => {
    let cancelled = false;
    void readAggregateSources()
      .then((sources) => sourceApi.getAllHotWords(sources ?? undefined))
      .then((words) => {
        if (!cancelled) setHotWords(Array.isArray(words) ? words : []);
      })
      .catch(() => {
        if (!cancelled) setHotWords([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = useCallback(
    (kw: string): void => {
      const trimmed = kw.trim();
      if (!trimmed) return;
      setKeyword(trimmed);
      setSuggestOpen(false);
      // 历史只记「主动发起的搜索」：前进/后退复现 URL 不算，避免污染历史
      void addSearchHistory(trimmed).then(() => getSearchHistory()).then(setHistory).catch(() => {});
      // 正常只负责导航：q 变了 resetKey 就变，usePagedList 自己回第一页重拉，
      // 这里再取一次数只会对同一次提交打两遍引擎请求。
      // 例外：提交的词与当前 URL 相同时 navigate 不产生新的 q、resetKey 不动，
      // 主动 reload 一次，保证「重复回车 = 重新搜索」的手感。
      if (trimmed === q) {
        reload();
      } else {
        // type 必须显式带上：不传的话 validateSearch 会把它落回默认的「歌曲」，
        // 用户正停在「歌单」页签搜同一个词就被踢回歌曲列表
        void navigate({ to: "/search", search: { q: trimmed, type: tab } });
      }
    },
    [navigate, q, reload, tab],
  );

  // 联想：历史 + 热搜词里按包含关系筛（无 suggest 接口，本地数据够用且零成本）
  const suggestions = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const word of [...history, ...hotWords]) {
      const w = word.trim();
      if (!w || seen.has(w)) continue;
      seen.add(w);
      if (w.toLowerCase().includes(kw) && w.toLowerCase() !== kw) out.push(w);
      if (out.length >= 8) break;
    }
    return out;
  }, [keyword, history, hotWords]);

  /**
   * 切页签 = 改 URL（replace，不新增历史条目）。用 replace 的理由：页签是
   * 同一个搜索视图的切换，不该让「返回」变成在页签之间来回跳 —— 从详情页
   * 返回时 history 里最新那条就是当前页签，返回的是上一页而不是上一个页签。
   */
  const switchTab = (t: Tab): void => {
    if (t === tab) return;
    void navigate({ to: "/search", search: { q, type: t }, replace: true });
  };

  const removeHistory = (kw: string): void => {
    setHistory((h) => h.filter((k) => k !== kw));
    void removeSearchHistoryItem(kw).catch(() => {});
  };

  const clearHistory = (): void => {
    setHistory([]);
    void clearSearchHistory().catch(() => {});
  };

  /**
   * 歌手 / 专辑都跳各自的详情页（路由 /artist、/album），不再直接取歌播放：
   * 详情页能先看清单再决定播不播，也和歌单的交互保持一致。
   * 2026-10-06：歌手页已支持按真实 id 取作品，这里把 id 放 `?id=`、名字放 `?name=`，
   * `$id` 位置仍放（encode 过的）名字 —— 详情页没有 `?name=` 时会把它当名字用，
   * 老书签和只有名字的跳转（TrackList）照样能进，见 ArtistPage 注释。
   */
  const openArtist = useCallback(
    (a: Artist): void => {
      void navigate({
        to: "/artist/$platform/$id",
        params: { platform: a.platform, id: encodeURIComponent(a.name) },
        search: { id: a.id, name: a.name },
      });
    },
    [navigate],
  );

  const openAlbum = useCallback(
    (a: Album): void => {
      void navigate({
        to: "/album/$platform/$id",
        params: { platform: a.platform, id: encodeURIComponent(a.name) },
      });
    },
    [navigate],
  );

  /** 歌单卡片的稳定回调（封面卡 memo 的前提，见 CoverCard 注释） */
  const pickPlaylist = useCallback(
    (p: Playlist): void => {
      void navigate({
        to: "/playlist/$platform/$id",
        params: { platform: p.platform, id: p.id },
      });
    },
    [navigate],
  );

  const empty = items.length === 0;

  // 四个页签共用一份分页列表（resetKey 里带页签 ⇒ 列表里只有一种 kind），
  // 渲染前按 kind 摊平成各自的模型；只有当前页签那一路非空。
  const songs = useMemo(
    () => items.flatMap((hit) => (hit.kind === "song" ? [hit.track] : [])),
    [items],
  );
  const playlists = useMemo(
    () => items.flatMap((hit) => (hit.kind === "playlist" ? [hit.playlist] : [])),
    [items],
  );
  const artists = useMemo(
    () => items.flatMap((hit) => (hit.kind === "artist" ? [hit.artist] : [])),
    [items],
  );
  const albums = useMemo(
    () => items.flatMap((hit) => (hit.kind === "album" ? [hit.album] : [])),
    [items],
  );

  /**
   * 聚合模式也渲染**同一份** `songs` 列表（合并去重已在 fetchPage 里做完），
   * 行尾只多一个源标告诉用户这首歌是从哪个源来的 —— 不再按源分段：同一首歌
   * 在四个源各出现一次、还顶着「网易云音乐 60 首」这种分组头，比没有聚合还难用。
   */

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="relative flex items-center gap-2 border-b border-border px-4 py-3">
        <BackButton />
        <Search className="h-4 w-4 text-muted-foreground" />
        <div className="relative flex-1">
          <input
            ref={inputRef}
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value);
              setSuggestOpen(true);
            }}
            onFocus={() => setSuggestOpen(true)}
            onBlur={() => {
              // 延迟收起：给联想项的 mousedown 一拍时间先触发
              window.setTimeout(() => setSuggestOpen(false), 120);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit(keyword);
              if (e.key === "Escape") setSuggestOpen(false);
            }}
            placeholder="搜索歌曲 / 歌单 / 歌手 / 专辑"
            className="h-9 w-full rounded-md border border-input bg-background pl-3 pr-9 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          {keyword && (
            <button
              type="button"
              aria-label="清空输入"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setKeyword("");
                setSuggestOpen(false);
                inputRef.current?.focus();
              }}
              className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-secondary hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => submit(keyword)}
          disabled={searching || !keyword.trim()}
          className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {searching ? "搜索中…" : "搜索"}
        </button>

        {suggestOpen && suggestions.length > 0 && (
          <div className="absolute left-14 right-32 top-full z-20 mt-1 overflow-hidden rounded-lg border border-border bg-popover py-1 text-popover-foreground shadow-lg">
            {suggestions.map((w) => (
              <button
                key={w}
                type="button"
                // mousedown 抢在输入框 onBlur 之前完成填充，避免点击落空
                onMouseDown={(e) => {
                  e.preventDefault();
                  submit(w);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-secondary"
              >
                <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{w}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 页签栏只在**搜过之后**出现：落地页（历史 / 热搜）上没有结果可
          切，摆一排灰按钮只会让人以为「搜索已经开始但没结果」。 */}
      {searched && (
      <div className="flex items-center gap-1 border-b border-border px-4 py-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => switchTab(t.key)}
            className={`h-7 rounded-md px-3 text-xs transition-colors ${
              tab === t.key
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
        {tab === "song" && (
          <button
            type="button"
            onClick={() => setAggregateMode(!aggregateMode)}
            aria-pressed={aggregateMode}
            title="同时搜索全部音源，自动去重后合并成一条列表"
            className={`ml-auto flex h-7 items-center gap-1.5 rounded-md px-3 text-xs transition-colors ${
              aggregateMode
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            聚合搜索
          </button>
        )}
        {tab === "song" && songs.length > 0 && (
          // 搜索是一页一页往下拉的（usePagedList），「全部」只能是**已加载**的这批；
          // 文案与 title 都写清楚条数，避免用户以为只放了屏幕里那几首。
          <button
            type="button"
            onClick={() => void playQueue(songs, 0)}
            title={`把已加载的 ${songs.length} 首加入队列，从第一首开始播放`}
            className="flex h-7 items-center gap-1.5 rounded-md px-3 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Play className="h-3.5 w-3.5 fill-current" />
            播放全部
          </button>
        )}
      </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && empty && (
          <div className="p-6 text-center text-sm text-destructive">
            搜索失败：{error}
          </div>
        )}
        {!error && searched && empty && !searching && (
          // 空状态给出口（UX 审查：No Results 不能是死胡同）
          <div className="flex flex-col items-center gap-2 py-14 text-center">
            <SearchX className="h-8 w-8 text-muted-foreground/50" aria-hidden />
            <p className="text-sm text-muted-foreground">没有找到相关内容</p>
            <p className="text-xs text-muted-foreground/70">
              换个关键词试试，或用标题栏切换音源再搜
            </p>
          </div>
        )}
        {!error && searching && empty && <TrackRowsSkeleton rows={6} />}

        {/* 落地页 = 搜索首页：历史 / 热门搜索（只在还没搜过时展示） */}
        {!searched && !searching && (
          <SearchLanding
            history={history}
            hotWords={hotWords}
            onPick={submit}
            onRemoveHistory={removeHistory}
            onClearHistory={clearHistory}
          />
        )}

        {/* 歌曲页签：单源与聚合都是一条列表，每行歌名右侧标出平台简称
            （聚合去重后「它来自哪个源」仍然是有用信息） */}
        {showResults &&
          tab === "song" &&
          songs.map((t) => (
            <TrackRow
              key={`${t.platform}:${t.id}`}
              track={t}
              active={currentTrackId === t.id}
              onPlayTrack={playTrack}
            />
          ))}

        {tab === "playlist" && playlists.length > 0 && (
          <div className="p-4">
            <CoverGrid>
              {playlists.map((p) => (
                <CoverCard
                  key={p.id}
                  name={p.name}
                  picUrl={p.picUrl}
                  subtitle={p.playCount ? `${formatPlayCount(p.playCount)}次播放` : undefined}
                  item={p}
                  onPick={pickPlaylist}
                />
              ))}
            </CoverGrid>
          </div>
        )}

        {tab === "artist" && artists.length > 0 && (
          <div className="p-4">
            <CoverGrid>
              {artists.map((a) => (
                <CoverCard
                  key={a.id}
                  name={a.name}
                  picUrl={a.picUrl}
                  item={a}
                  onPick={openArtist}
                />
              ))}
            </CoverGrid>
          </div>
        )}

        {tab === "album" && albums.length > 0 && (
          <div className="p-4">
            <CoverGrid>
              {albums.map((a) => (
                <CoverCard
                  key={a.id}
                  name={a.name}
                  picUrl={a.picUrl}
                  subtitle={a.artist}
                  item={a}
                  onPick={openAlbum}
                />
              ))}
            </CoverGrid>
          </div>
        )}

        {/* 翻页哨兵（提前一屏触发，见 usePagedList）+ 底部提示。
            续页失败时 error 有值但列表还在，这里给一个「重试」出口，
            否则滚到底只剩一行红字、没有任何自救路径。 */}
        {searched && <div ref={sentinelRef} className="h-1" aria-hidden />}
        {searched && items.length > 0 && (
          <div className="py-3 text-center text-xs text-muted-foreground">
            {loadingMore ? (
              "加载中…"
            ) : error !== null ? (
              <button
                type="button"
                onClick={reload}
                className="text-destructive underline-offset-2 hover:underline"
              >
                加载更多失败，点此重试
              </button>
            ) : hasMore ? (
              "继续下拉加载更多"
            ) : (
              "已经到底了"
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 落地页 = 搜索的首页：**搜索历史 / 热门搜索**。
 *
 * 只在没有关键词时渲染（见上面的 `searched`）。用户口径是「历史搜索、热门搜索
 * 等等」，热门搜索取跨源聚合的 `allHotWords`（多源合并去重，不跟随当前音源）。
 * 这里不放「热门歌单」—— 用户明确说过要的是热门**搜索**；歌单推荐在「歌单广场」
 * 里已经有整页，塞进搜索首页只会把用户真正要的入口挤下去。
 */
function SearchLanding(props: {
  history: string[];
  hotWords: string[];
  onPick: (kw: string) => void;
  onRemoveHistory: (kw: string) => void;
  onClearHistory: () => void;
}): React.JSX.Element {
  const nothing = props.history.length === 0 && props.hotWords.length === 0;

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-7">
      {nothing && (
        <p className="py-10 text-center text-sm text-muted-foreground">
          输入歌名、歌手或专辑名开始搜索；搜过和听过的歌会自动出现在这里。
        </p>
      )}

      {props.history.length > 0 && (
        <LandingSection
          title="搜索历史"
          action={
            <IconButton label="清空搜索历史" danger onClick={props.onClearHistory}>
              <Trash2 />
            </IconButton>
          }
        >
          <div className="flex flex-wrap gap-2">
            {props.history.map((kw) => (
              <span
                key={kw}
                className="group flex h-7 items-center gap-1 rounded-full bg-secondary/60 pl-3 pr-1.5 text-xs"
              >
                <button
                  type="button"
                  onClick={() => props.onPick(kw)}
                  className="max-w-40 truncate transition-colors hover:text-primary"
                  title={kw}
                >
                  {kw}
                </button>
                <button
                  type="button"
                  aria-label={`删除历史 ${kw}`}
                  onClick={() => props.onRemoveHistory(kw)}
                  className="rounded-full p-0.5 text-muted-foreground/60 transition-colors hover:bg-background hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        </LandingSection>
      )}

      {props.hotWords.length > 0 && (
        <LandingSection
          title="热门搜索"
          hint="多源聚合"
          className="mt-7"
        >
          <ol className="mt-1 grid grid-cols-2 gap-x-8">
            {props.hotWords.slice(0, 14).map((word, i) => (
              <li key={word}>
                <button
                  type="button"
                  onClick={() => props.onPick(word)}
                  className="flex w-full items-center gap-2.5 py-1.5 text-left text-sm transition-colors hover:text-primary"
                >
                  <span
                    className={`w-4 shrink-0 text-right text-xs tabular-nums ${
                      i < 3 ? "font-semibold text-primary" : "text-muted-foreground/60"
                    }`}
                  >
                    {i + 1}
                  </span>
                  <span className="truncate">{word}</span>
                </button>
              </li>
            ))}
          </ol>
        </LandingSection>
      )}
    </div>
  );
}

/** 落地页的一个区块：标题 +（可选）右侧动作 / 说明 */
function LandingSection(props: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className={props.className}>
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          {props.title}
          {props.hint ? (
            <span className="text-muted-foreground/60">· {props.hint}</span>
          ) : null}
        </h3>
        {props.action}
      </div>
      <div className="mt-2">{props.children}</div>
    </section>
  );
}

/**
 * 搜索结果里的单曲行（#11 / #34）。
 *
 * memo + 稳定回调：输入框每次击键都会重渲整个页面，若行内联 `onPlay={() => play(t)}`
 * 则每行都是新 props，数百行结果跟着全量重渲。改为父级传稳定函数、行内自己把
 * `track` 递回去，比较器就能挡住无关重渲（与 `TrackList` 同一套 latest-ref 写法）。
 *
 * `cv-row`：复用曲目列表的 `content-visibility: auto`（见 index.css），视口外的行
 * 跳过布局与绘制，长结果列表滚动更稳。
 */
const TrackRow = memo(function TrackRow(props: {
  track: Track;
  active: boolean;
  onPlayTrack: (track: Track) => void;
}): React.JSX.Element {
  const { track, active, onPlayTrack } = props;
  const cover = qtresCoverUrl(track.picUrl);
  return (
    <button
      type="button"
      onClick={() => onPlayTrack(track)}
      className={`cv-row flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-secondary ${
        active ? "bg-secondary/60" : ""
      }`}
    >
      <span className="flex h-5 w-6 shrink-0 items-center justify-center text-muted-foreground">
        {active ? (
          <Play className="h-3 w-3 fill-current text-primary" aria-hidden />
        ) : null}
      </span>
      <div className="h-9 w-9 shrink-0 overflow-hidden rounded bg-secondary">
        {cover && (
          <img src={cover} alt="" className="h-full w-full object-cover" loading="lazy" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm">{track.title}</span>
          <SourceTag platform={track.platform} size="xs" />
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {track.singer}
          {track.album ? ` · ${track.album}` : ""}
        </div>
      </div>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {track.duration > 0 ? formatTime(track.duration * 1000) : ""}
      </span>
    </button>
  );
});
