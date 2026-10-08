import { useEffect, useState } from "react";
import { errMsg } from "@/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import type { Chart, SourceId } from "@/types";
import * as sourceApi from "@/source-scripts";
import { useMusicSourceStore } from "@/stores/musicSource";
import { useSourceLabel, useSourceRegistryStore } from "@/stores/sourceRegistry";
import { CoverCard, CoverGrid } from "./CoverCard";

/**
 * 排行榜（路由 /charts，DESIGN §5.2）。
 *
 * **按指定音源展示，不做全源聚合** —— 聚合版把四个源的榜单拼成一屏，同源榜单
 * 被其它源的榜单隔开、顺序随注册表漂移，且任一源失败都会让整屏缺项。
 * 改成单源后：**跟随全局「音源设置」里选中的音源，页面本身不再放音源切换器**
 * （2026-10-06：顶部那排「网易云音乐/QQ音乐…」tag 删掉了——全局切换器已经在
 * 侧边栏/标题栏统一出口，页面里再放一排是重复入口，且两处状态容易打架）。
 * 换音源在全局切换即可，本页随之刷新。
 *
 * 本音源没有榜单时显示「该音源暂无榜单」，不再预先做 features.charts 过滤——
 * 跟随全局的情况下，用户看到的空缺原因必须真实：是这个源没有榜单，而不是
 * 不知道去哪里找。
 */
export function ChartsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const activeSourceId = useMusicSourceStore((s) => s.activeSourceId);
  const sourceLabel = useSourceLabel(activeSourceId);
  // 注册表世代：装/卸/换数据包后 +1。本页 keep-alive 常驻，不盯世代的话，
  // 卸载包后旧榜单会一直残留（activeSourceId 不变，effect 永不重跑）。
  const metaGeneration = useSourceRegistryStore((s) => s.generation);

  const [charts, setCharts] = useState<Chart[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const list = await sourceApi.getCharts(activeSourceId as SourceId);
        if (cancelled) return;
        setCharts(Array.isArray(list) ? list : []);
      } catch (err) {
        if (cancelled) return;
        setCharts([]);
        setError(errMsg(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSourceId, metaGeneration]);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="border-b border-border px-4 py-3">
        <h1 className="text-base font-medium">排行榜</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">
          跟随当前音源（{sourceLabel}），点击查看详情
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading && (
          <div className="py-10 text-center text-sm text-muted-foreground">加载中…</div>
        )}
        {!loading && error && (
          <div className="py-10 text-center text-sm text-destructive">加载失败：{error}</div>
        )}
        {!loading && !error && charts.length === 0 && (
          <div className="py-10 text-center text-sm text-muted-foreground">该音源暂无榜单</div>
        )}
        {charts.length > 0 && (
          <CoverGrid>
            {charts.map((c) => (
              <CoverCard
                key={`${c.platform}-${c.id}`}
                name={c.name}
                picUrl={c.picUrl}
                subtitle={c.description || undefined}
                onClick={() =>
                  void navigate({
                    to: "/chart/$platform/$id",
                    params: { platform: c.platform, id: c.id },
                  })
                }
              />
            ))}
          </CoverGrid>
        )}
      </div>
    </div>
  );
}
