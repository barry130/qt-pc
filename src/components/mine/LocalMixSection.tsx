import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import type { LocalMixSummary } from "@/types";
import * as ipc from "@/services/ipc";
import { cn } from "@/lib/utils";
import { useKeepAliveActive } from "@/components/layout/keepAliveActive";
import { SectionTitle } from "@/components/discovery/CoverCard";
import { LocalMixCard } from "./LocalMixCard";

/**
 * 「为你整理」整区出场所需的最小合辑数。
 *
 * 刻意不按「五类全齐」判定：五类各有各的门槛（新用户还没在深夜听过歌、旧歌没攒够
 * 30 天、收藏还没归进现存歌单……），硬凑五类会让这一区长期消失，攒了半年的记录也
 * 换不来一张卡片；反过来只出一类又像数据坏了。折中取 2：凑够两类就展示，凑不满
 * 就整区不渲染，不摆半成品区域。
 */
const MIN_SHOWN_MIXES = 2;

/** 首页的本机合辑独立取数，切换在线音源不会影响它。 */
export function LocalMixSection(): React.JSX.Element | null {
  const active = useKeepAliveActive();
  const navigate = useNavigate();
  const [mixes, setMixes] = useState<LocalMixSummary[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    void ipc.listLocalMixes().then((list) => {
      if (!cancelled) setMixes(Array.isArray(list) ? list : []);
    }).catch(() => {
      // 首页允许旁路数据为空；无记录、数据库不可用时都不占推荐位。
      if (!cancelled) setMixes([]);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [active, refreshKey]);

  if (mixes.length < MIN_SHOWN_MIXES) return null;
  return (
    <section className="mt-6 px-5" aria-label="为你整理">
      <SectionTitle
        title="为你整理"
        action={
          <button
            type="button"
            aria-label="刷新本地合辑"
            title="根据本机收听记录和收藏重新整理"
            disabled={loading}
            onClick={() => setRefreshKey((key) => key + 1)}
            className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </button>
        }
      />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
        {mixes.map((mix) => (
          <LocalMixCard
            key={mix.key}
            title={mix.title}
            subtitle={mix.subtitle}
            coverUrls={mix.coverUrls}
            onOpen={() => void navigate({ to: "/mix/$key", params: { key: mix.key } })}
          />
        ))}
      </div>
    </section>
  );
}
