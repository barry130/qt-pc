import { useEffect, useState } from "react";
import { errMsg } from "@/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import type { Chart } from "@/types";
import * as ipc from "@/services/ipc";
import { CoverCard, CoverGrid } from "./CoverCard";

/**
 * 排行榜（路由 /charts，DESIGN §5.2）。
 * 用四源聚合命令 get_all_charts：单源失败只记日志，其余源照常展示（§6.4 要点 5）。
 */
export function ChartsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [charts, setCharts] = useState<Chart[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const list = await ipc.getAllCharts();
        if (!cancelled) setCharts(Array.isArray(list) ? list : []);
      } catch (err) {
        if (!cancelled) {
          setCharts([]);
          setError(errMsg(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="border-b border-border px-4 py-3">
        <h1 className="text-base font-medium">排行榜</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">
          聚合四个音源的榜单，点击查看详情
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading && (
          <div className="py-10 text-center text-sm text-muted-foreground">
            加载中…
          </div>
        )}
        {!loading && error && (
          <div className="py-10 text-center text-sm text-destructive">
            加载失败：{error}
          </div>
        )}
        {!loading && !error && charts.length === 0 && (
          <div className="py-10 text-center text-sm text-muted-foreground">
            暂无榜单
          </div>
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
