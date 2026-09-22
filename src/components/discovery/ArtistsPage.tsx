import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import type { Artist, SingerStat, SourceId } from "@/types";
import * as sourceApi from "@/source-scripts";
import * as ipc from "@/services/ipc";
import { useMusicSourceStore } from "@/stores/musicSource";
import { qtresCoverUrl } from "@/lib/lrc";
import { errMsg } from "@/lib/utils";
import { CoverGrid, SectionTitle } from "./CoverCard";

/**
 * 歌手页（路由 /artists，替代原 MV 列表位）。
 *
 * 音源契约里没有「热门歌手列表」接口，只有按关键词的歌手搜索（artistSearch），
 * 所以这页分两段：
 *   - 默认：常听歌手 —— 本地播放统计 get_top_singers，离线可用、不依赖音源
 *   - 输入关键词：当前音源的歌手搜索结果（带真实头像）
 * 两者都进 /artist/$platform/$name；歌手详情本身就是「按歌手名搜歌」的闭环。
 */
export function ArtistsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const activeSourceId = useMusicSourceStore((s) => s.activeSourceId);

  const [keyword, setKeyword] = useState("");
  const [singers, setSingers] = useState<SingerStat[]>([]);
  const [results, setResults] = useState<Artist[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 常听歌手：本地统计，与音源无关；失败就当没有记录，不打断页面
  useEffect(() => {
    let cancelled = false;
    void ipc
      .getTopSingers(60)
      .then((list) => {
        if (!cancelled) setSingers(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled) setSingers([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 歌手搜索：防抖 300ms，避免每敲一个字都打一次音源
  useEffect(() => {
    const q = keyword.trim();
    if (q.length === 0) {
      setResults([]);
      setError(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      void sourceApi
        .searchArtists(activeSourceId, q, 1, 30)
        .then((list) => {
          if (!cancelled) setResults(Array.isArray(list) ? list : []);
        })
        .catch((err) => {
          if (!cancelled) {
            setResults([]);
            setError(errMsg(err));
          }
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [keyword, activeSourceId]);

  const openArtist = (platform: string, name: string): void => {
    void navigate({
      to: "/artist/$platform/$id",
      params: { platform: platform as SourceId, id: encodeURIComponent(name) },
    });
  };

  const inSearch = keyword.trim().length > 0;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="border-b border-border px-4 py-3">
        <h1 className="text-base font-medium">歌手</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">
          常听歌手，或搜索当前音源的歌手
        </p>
        <div className="relative mt-3 max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索歌手"
            aria-label="搜索歌手"
            className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {inSearch ? (
          error ? (
            <div className="py-10 text-center text-sm text-destructive">
              加载失败：{error}
            </div>
          ) : searching ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              搜索中…
            </div>
          ) : results.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              没有找到相关歌手
            </div>
          ) : (
            <CoverGrid>
              {results.map((a) => (
                <ArtistCard
                  key={`${a.platform}-${a.id}`}
                  name={a.name}
                  picUrl={a.picUrl}
                  onClick={() => openArtist(a.platform, a.name)}
                />
              ))}
            </CoverGrid>
          )
        ) : singers.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            还没有听歌记录，搜一个歌手试试
          </div>
        ) : (
          <>
            <SectionTitle title="常听歌手" />
            <CoverGrid>
              {singers.map((s) => (
                <ArtistCard
                  key={s.singer}
                  name={s.singer}
                  picUrl=""
                  subtitle={`播放 ${s.playCount} 次`}
                  onClick={() => openArtist(s.platform, s.singer)}
                />
              ))}
            </CoverGrid>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 歌手卡：圆形头像 + 居中名字。
 * 头像经 qtres:// 代取（带防盗链 Referer）；拿不到就首字兜底，不留空白卡。
 */
function ArtistCard(props: {
  name: string;
  picUrl: string;
  subtitle?: string;
  onClick: () => void;
}): React.JSX.Element {
  const { name, picUrl, subtitle, onClick } = props;
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
      {subtitle ? (
        <div className="mt-0.5 truncate text-center text-xs text-muted-foreground">
          {subtitle}
        </div>
      ) : null}
    </button>
  );
}
