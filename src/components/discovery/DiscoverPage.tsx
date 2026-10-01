import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { BarChart3, ChevronRight, Disc3, FileMusic, Flame, PackageOpen, Sparkles } from "lucide-react";
import type { Chart, Playlist, Track } from "@/types";
import { SOURCE_DISPLAY } from "@/types";
import * as sourceApi from "@/source-scripts";
import { getRecommendations } from "@/source-scripts";
import { engineSnapshot } from "@/source-engine/client";
import { useMusicSourceStore } from "@/stores/musicSource";
import { usePlayerStore } from "@/stores/player";
import { CoverCard, CoverGrid, SectionTitle } from "./CoverCard";
import { HorizontalScroller } from "./HorizontalScroller";
import { TrackCard } from "./TrackCard";

/**
 * 首页 / 发现（路由 /，DESIGN §5.2 / §5.3）。
 *
 * 布局自上而下：Hero（当前音源 + 快捷入口）→ 热门榜单（横向大卡）→
 * 新歌速递（横向歌曲卡）→ 推荐歌单（网格）。
 * 榜单用四源聚合命令，新歌与推荐歌单跟随全局音源（§6.4 要点 5）。
 * 任一区块失败只降级为空区块，不弹全局错误（首页是聚合视图，允许部分为空）。
 */

const QUICK_LINKS = [
  {
    label: "每日新歌",
    to: "/daily",
    icon: Sparkles,
  },
  {
    label: "歌单广场",
    to: "/playlists",
    icon: Disc3,
  },
  {
    label: "热门榜单",
    to: "/charts",
    icon: Flame,
  },
  {
    label: "本地音乐",
    to: "/library",
    icon: FileMusic,
  },
] as const;

export function DiscoverPage(): React.JSX.Element {
  const navigate = useNavigate();
  const activeSourceId = useMusicSourceStore((s) => s.activeSourceId);
  const playQueue = usePlayerStore((s) => s.playQueue);

  const [songs, setSongs] = useState<Track[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [charts, setCharts] = useState<Chart[]>([]);
  // 引擎相位（error = 未装/加载失败，此时给「去安装音源包」引导卡，而不是静默空区块）
  const [enginePhase, setEnginePhase] = useState<string | null>("booting");

  // 引擎启动与包安装都是异步的，快照轮询最简单；只影响一张卡的显隐
  useEffect(() => {
    const tick = (): void => setEnginePhase(engineSnapshot().phase);
    tick();
    const timer = window.setInterval(tick, 3000);
    return () => window.clearInterval(timer);
  }, []);

  // 新歌速递 + 推荐歌单（跟随音源）
  useEffect(() => {
    let cancelled = false;
    setSongs([]);
    setPlaylists([]);
    void (async () => {
      const [s, p] = await Promise.all([
        sourceApi.getLatestSongs(activeSourceId, 20, 0).catch(() => [] as Track[]),
        // 插件化试点：推荐歌单经 source-scripts 统一入口分发
        // （scheme=script 走共享脚本包，否则原 Rust 通道），其余调用不变
        getRecommendations(activeSourceId, null, 1).catch(() => [] as Playlist[]),
      ]);
      // IPC 在测试/异常环境下可能返回非数组，这里统一兜底（页面只做展示，允许区块为空）
      if (cancelled) return;
      setSongs(Array.isArray(s) ? s : []);
      // 多取一些，配合 CoverGrid 的 fillRows 裁剪后正好铺满整数排
      setPlaylists(Array.isArray(p) ? p.slice(0, 30) : []);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSourceId]);

  // 热门榜单（四源聚合，不随音源变化）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const c = await sourceApi.getAllCharts().catch(() => [] as Chart[]);
      if (!cancelled) setCharts(Array.isArray(c) ? c.slice(0, 10) : []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const sourceLabel =
    activeSourceId === "local" ? "本地音乐" : SOURCE_DISPLAY[activeSourceId];

  return (
    <div className="h-full min-w-0 overflow-y-auto pb-6">
      {/* Hero：当前音源 + 快捷入口 */}
      <section className="px-5 pt-5">
        <div className="rounded-2xl border border-border bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-6">
          <h1 className="text-2xl font-bold">发现音乐</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            当前音源：{sourceLabel} · 榜单聚合四个音源，新歌与推荐歌单随音源切换
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {QUICK_LINKS.map((item) => (
              <button
                key={item.to}
                type="button"
                onClick={() => void navigate({ to: item.to })}
                className="flex items-center gap-1.5 rounded-full border border-border bg-card/60 px-3.5 py-2 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <item.icon className="h-3.5 w-3.5" />
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* 未安装音源包引导：在线区块会全部为空，这里给一条可操作的出口 */}
      {enginePhase === "error" && (
        <section className="mt-4 px-5">
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card/70 px-4 py-3">
            <PackageOpen className="h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
              在线功能暂不可用：还没有安装音源包（或加载失败）。本地音乐不受影响；
              想启用在线试听，可到「设置 → 音源包」从链接安装。
            </div>
            <button
              type="button"
              onClick={() =>
                void navigate({ to: "/settings/$section", params: { section: "source-package" } })
              }
              className="rounded-full border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              去安装
            </button>
          </div>
        </section>
      )}

      {/* 热门榜单 */}
      <section className="mt-6 px-5">
        <SectionTitle
          title="热门榜单"
          action={
            <button
              type="button"
              onClick={() => void navigate({ to: "/charts" })}
              className="flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              全部榜单
              <ChevronRight className="h-3 w-3" />
            </button>
          }
        />
        {charts.length === 0 ? (
          <EmptyBlock icon={BarChart3} text="暂无榜单" />
        ) : (
          <HorizontalScroller>
            {charts.map((c) => (
              <div
                key={`${c.platform}-${c.id}`}
                className="w-32 shrink-0 snap-start"
              >
                <CoverCard
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
              </div>
            ))}
          </HorizontalScroller>
        )}
      </section>

      {/* 新歌速递 */}
      <section className="mt-6 px-5">
        <SectionTitle
          title="新歌速递"
          action={
            <button
              type="button"
              onClick={() => void navigate({ to: "/daily" })}
              className="flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              更多新歌
              <ChevronRight className="h-3 w-3" />
            </button>
          }
        />
        {songs.length === 0 ? (
          <EmptyBlock icon={Sparkles} text="暂无新歌" />
        ) : (
          <HorizontalScroller>
            {songs.map((t, i) => (
              <TrackCard
                key={`${t.id}-${i}`}
                track={t}
                onPlay={() => void playQueue(songs, i)}
              />
            ))}
          </HorizontalScroller>
        )}
      </section>

      {/* 推荐歌单 */}
      <section className="mt-6 px-5">
        <SectionTitle
          title="推荐歌单"
          action={
            <button
              type="button"
              onClick={() => void navigate({ to: "/playlists" })}
              className="flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              歌单广场
              <ChevronRight className="h-3 w-3" />
            </button>
          }
        />
        {playlists.length === 0 ? (
          <EmptyBlock icon={Disc3} text="暂无推荐歌单" />
        ) : (
          <CoverGrid fillRows>
            {playlists.map((p) => (
              <CoverCard
                key={p.id}
                name={p.name}
                picUrl={p.picUrl}
                subtitle={p.playCount ? `${p.playCount} 次播放` : undefined}
                onClick={() =>
                  void navigate({
                    to: "/playlist/$platform/$id",
                    params: { platform: p.platform, id: p.id },
                  })
                }
              />
            ))}
          </CoverGrid>
        )}
      </section>
    </div>
  );
}

/**
 * 区块空态：图标 + 一句话说明，虚线框轻量占位。
 * 替换此前的裸文本 <p>——空态与正常内容共用同一版式骨架（圆角容器），
 * 数据到达后切换不会产生明显的排版跳变。
 */
function EmptyBlock(props: {
  icon: React.ComponentType<{ className?: string }>;
  text: string;
}): React.JSX.Element {
  const Icon = props.icon;
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/80 py-8 text-muted-foreground">
      <Icon className="h-6 w-6 opacity-50" />
      <span className="text-xs">{props.text}</span>
    </div>
  );
}
