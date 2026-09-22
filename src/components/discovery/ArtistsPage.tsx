import { useCallback, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { Artist, SourceId } from "@/types";
import * as sourceApi from "@/source-scripts";
import { useMusicSourceStore } from "@/stores/musicSource";
import { usePagedList } from "@/hooks/usePagedList";
import { qtresCoverUrl } from "@/lib/lrc";
import { CoverGrid } from "./CoverCard";
import { CoverGridSkeleton, ErrorRetry } from "./Skeletons";

/** 每页歌手数（酷我网页端用 60；这里 40，一屏铺满又不至于一次拉太多） */
const PAGE_SIZE = 40;

/** 首字母档：空串 = 热门，A-Z = 该字母，「#」= 非字母档 */
const INITIALS: string[] = ["", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""), "#"];

/**
 * 首字母索引的能力模式（由音源如实决定，见 ContractArtistPage）：
 * - server：音源支持按字母查询（酷我）→ 点字母重新拉该字母的列表
 * - client：音源不支持按字母查，但条目带首字母（QQ 的 Findex）
 *           → 字母只筛选**已加载**的歌手，继续下拉会补进新的匹配
 * - none  ：两者都没有（网易云 / 酷狗）→ 字母档置灰并提示改用搜索
 */
type IndexMode = "server" | "client" | "none";

/**
 * 歌手页（路由 /artists，替代原 MV 列表位）。
 *
 * 内容 = 当前音源的真实歌手列表（音源包 artistList，翻页加载）。
 * 首字母索引按音源能力降级：只有酷我有服务端的字母查询接口，
 * 其余音源要么按已加载条目筛（QQ），要么置灰（网易云 / 酷狗）——
 * 不做「假装能筛」的假索引。
 */
export function ArtistsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const activeSourceId = useMusicSourceStore((s) => s.activeSourceId);
  const [initial, setInitial] = useState("");
  /** 该音源是否支持服务端字母查询；null = 首页还没回来 */
  const [serverIndex, setServerIndex] = useState<boolean | null>(null);

  const fetchPage = useCallback(
    async (page: number): Promise<Artist[]> => {
      const res = await sourceApi.getArtistList(activeSourceId, initial, page, PAGE_SIZE);
      // 能力与音源绑定，第一页拿到就定下来（后续页同源同能力）
      if (page <= 1) setServerIndex(res.initialSupported);
      return res.list;
    },
    [activeSourceId, initial],
  );

  const {
    items,
    loading,
    loadingMore,
    error,
    hasMore,
    sentinelRef,
    reload,
  } = usePagedList<Artist>({
    fetchPage,
    keyOf: (a) => `${a.platform}-${a.id}`,
    resetKey: `${activeSourceId}|${initial}`,
  });

  const mode: IndexMode =
    serverIndex === true
      ? "server"
      : items.some((a) => (a.initial ?? "").length > 0)
        ? "client"
        : "none";

  const shown =
    mode === "client" && initial !== ""
      ? items.filter((a) => matchInitial(a.initial, initial))
      : items;

  const openArtist = (platform: string, name: string): void => {
    void navigate({
      to: "/artist/$platform/$id",
      params: { platform: platform as SourceId, id: encodeURIComponent(name) },
    });
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-base font-medium">歌手</h1>
          <p className="min-w-0 truncate text-xs text-muted-foreground">{hintText(mode, items.length, initial, hasMore)}</p>
        </div>

        {/* 首字母索引：热门 + A-Z + 非字母档 */}
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {INITIALS.map((value) => {
            const disabled = value !== "" && mode === "none";
            const active = initial === value;
            return (
              <button
                key={value === "" ? "hot" : value}
                type="button"
                disabled={disabled}
                aria-pressed={active}
                title={disabled ? "该音源不支持按字母查询" : undefined}
                onClick={() => setInitial(value)}
                className={`h-6 rounded-full border text-xs transition-colors ${
                  value === "" ? "px-2.5" : "w-6"
                } ${
                  active
                    ? "border-primary bg-primary/10 text-primary"
                    : disabled
                      ? "cursor-not-allowed border-border/60 text-muted-foreground/40"
                      : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {value === "" ? "热门" : value}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error ? (
          <ErrorRetry message={`加载失败：${error}`} onRetry={reload} />
        ) : loading ? (
          <CoverGridSkeleton count={12} />
        ) : shown.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            {mode === "client" && initial !== ""
              ? `已加载的 ${items.length} 位歌手里没有「${initial}」开头的，继续下拉加载更多`
              : "这个音源暂时没有返回歌手"}
          </div>
        ) : (
          <>
            <CoverGrid>
              {shown.map((a) => (
                <ArtistCard
                  key={`${a.platform}-${a.id}`}
                  name={a.name}
                  picUrl={a.picUrl}
                  onClick={() => openArtist(a.platform, a.name)}
                />
              ))}
            </CoverGrid>
            {/* 哨兵：进入视口就拉下一页 */}
            <div ref={sentinelRef} className="h-1" />
            <div className="py-4 text-center text-xs text-muted-foreground">
              {loadingMore ? "加载中…" : hasMore ? "继续下拉加载更多" : "已经到底了"}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** 客户端按首字母筛选：「#」档收非 A-Z（含音源没给首字母的） */
function matchInitial(value: string | undefined, want: string): boolean {
  const letter = (value ?? "").toUpperCase();
  if (want === "#") return !/^[A-Z]$/.test(letter);
  return letter === want;
}

/** 头部说明：把「能筛 / 只能筛已加载 / 不能筛」如实写出来 */
function hintText(
  mode: IndexMode,
  loaded: number,
  initial: string,
  hasMore: boolean,
): string {
  if (mode === "none") return "该音源不支持按字母查询，用顶部搜索按名字找";
  if (mode === "client") {
    return initial === ""
      ? `已加载 ${loaded} 位${hasMore ? "，继续下拉加载更多" : ""}`
      : `按已加载的 ${loaded} 位筛选${hasMore ? "，继续下拉会补进新的匹配" : ""}`;
  }
  const scope = initial === "" ? "热门歌手" : `「${initial}」开头`;
  return `${scope} · 已加载 ${loaded} 位${hasMore ? "，继续下拉加载更多" : ""}`;
}

/**
 * 歌手卡：圆形头像 + 居中名字。
 * 头像经 qtres:// 代取（带防盗链 Referer）；拿不到就首字兜底，不留空白卡。
 */
function ArtistCard(props: {
  name: string;
  picUrl: string;
  onClick: () => void;
}): React.JSX.Element {
  const { name, picUrl, onClick } = props;
  const cover = qtresCoverUrl(picUrl);
  const [loadFailed, setLoadFailed] = useState(false);

  return (
    <button
      type="button"
      onClick={onClick}
      className="group block w-full text-left transition-transform duration-150 active:scale-[0.98]"
    >
      <div className="relative aspect-square w-full overflow-hidden rounded-full shadow-md transition-shadow duration-200 group-hover:shadow-xl">
        {cover && !loadFailed ? (
          <img
            src={cover}
            alt=""
            className="h-full w-full object-cover transition-transform duration-300 motion-safe:group-hover:scale-105"
            loading="lazy"
            onError={() => setLoadFailed(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-secondary via-muted to-secondary">
            <span className="select-none text-4xl font-semibold text-muted-foreground/50">
              {name.slice(0, 1)}
            </span>
          </div>
        )}
      </div>
      <div className="mt-2 truncate text-center text-sm font-medium">{name}</div>
    </button>
  );
}
