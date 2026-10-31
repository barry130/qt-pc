import { useEffect, useState } from "react";
import { ArrowLeft, ChevronRight, Music4, Play } from "lucide-react";
import type { ListenReportEntry, ListenReportKind, ListenReportOrder, ListenReportPage } from "@/types";
import * as ipc from "@/services/ipc";
import { errMsg } from "@/lib/utils";
import { formatReportDate, formatReportDuration, reportSourceLabel } from "@/lib/listen-report";
import { qtresCoverUrl } from "@/lib/lrc";
import { useSourceLabelFn } from "@/stores/sourceRegistry";
import { usePlayerStore } from "@/stores/player";
import { toastError } from "@/stores/toast";
import { IconButton } from "@/components/common/IconButton";
import { SourceTag } from "@/components/common/SourceTag";
import { Button, EmptyState, LoadingState, Modal, Segmented } from "@/components/ui";
import { EntryPicture } from "./ListenReportBits";

const PAGE_SIZE = 30;
const KIND_TITLE: Record<ListenReportKind, string> = { tracks: "歌曲", singers: "歌手", sources: "音源" };

/** 全部排行 → 歌手/音源的歌曲 → 单曲统计；每次读取只取当前页。 */
export function ListenReportDetail(props: {
  kind: ListenReportKind;
  initialEntry?: ListenReportEntry;
  /**
   * 只看最近 N 天（1 = 今天、7、30）；省略 = 全部累计。
   * 与日榜卡片同参进入，才能保证「点进去看到的歌」和卡片上那一行是同一批。
   */
  days?: number | null;
  onClose: () => void;
}): React.JSX.Element {
  const { kind, onClose } = props;
  const days = props.days ?? null;
  const sourceLabel = useSourceLabelFn();
  const play = usePlayerStore((state) => state.play);
  const [path, setPath] = useState<ListenReportEntry[]>(() => props.initialEntry ? [props.initialEntry] : []);
  const [order, setOrder] = useState<ListenReportOrder>("count");
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<ListenReportPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const selected = path.at(-1);
  const group = path.find((entry) => !entry.track);
  const song = selected?.track ?? null;
  const queryKind = selected ? "tracks" : kind;
  const singer = group && kind === "singers" ? group.id : null;
  const platform = group && kind === "sources" ? group.id : null;

  useEffect(() => {
    if (song) return;
    let cancelled = false;
    setLoading(true);
    setPage(null);
    setError(null);
    void ipc.getListenReport({ kind: queryKind, order, offset, limit: PAGE_SIZE, singer, platform, days })
      .then((result) => { if (!cancelled) setPage(result); })
      .catch((reason: unknown) => { if (!cancelled) setError(errMsg(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [queryKind, order, offset, singer, platform, song, days, revision]);

  const nameOf = (entry: ListenReportEntry): string =>
    !entry.track && kind === "sources" ? reportSourceLabel(sourceLabel, entry.id) : entry.name;
  const select = (entry: ListenReportEntry): void => { setPath((value) => [...value, entry]); setOffset(0); };
  const back = (): void => { setPath((value) => value.slice(0, -1)); setOffset(0); };
  const playSelected = (): void => {
    if (song) void play(song).catch((reason: unknown) => toastError(`播放失败：${errMsg(reason)}`));
  };
  const title = selected ? nameOf(selected) : `全部${KIND_TITLE[kind]}`;
  const cover = song ? qtresCoverUrl(song.picUrl, 180) : "";

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={title}
      description={song ? "单曲听歌统计" : selected ? "该分组下听过的歌曲" : days ? `${days === 1 ? "今天" : `近 ${days} 天`}的听歌记录` : "全部累计记录"}
      headerLeft={
        selected ? (
          <IconButton label="返回上一层报告" size="md" onClick={back}>
            <ArrowLeft />
          </IconButton>
        ) : undefined
      }
      closeLabel="关闭报告"
      bodyClassName="px-5 py-0"
      footer={
        !song ? (
          <>
          <span>{!loading && page ? `共 ${page.total} 条 · ${page.items.length ? `${offset + 1}-${offset + page.items.length}` : "暂无"}` : ""}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="xs" disabled={offset === 0 || loading || !!error} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>上一页</Button>
            <Button variant="outline" size="xs" disabled={!page || offset + PAGE_SIZE >= page.total || loading || !!error} onClick={() => setOffset(offset + PAGE_SIZE)}>下一页</Button>
          </div>
          </>
        ) : undefined
      }
      footerClassName="justify-between border-border/60 text-xs text-muted-foreground"
    >
      {selected && <div className="border-b border-border/60 py-5">
        {song && <div className="mb-4 flex items-center gap-4">
          <span className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-secondary">
            {cover ? <img src={cover} alt="" className="h-full w-full object-cover" /> : <Music4 className="h-8 w-8 text-muted-foreground" />}
          </span>
          <div className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
            <p className="truncate">歌手：{song.singer || "未知歌手"}</p>
            <p className="truncate">专辑：{song.album || "未知专辑"}</p>
            <p className="truncate">音源：{reportSourceLabel(sourceLabel, song.platform)}</p>
          </div>
          <IconButton label={`播放 ${song.title}`} variant="primary" size="lg" onClick={playSelected}><Play /></IconButton>
        </div>}
        <div className="grid grid-cols-2 gap-3 rounded-xl bg-secondary/50 p-4">
          <div><p className="text-xs text-muted-foreground">有效播放</p><p className="mt-1 text-xl font-semibold tabular-nums">{selected.playCount} 次</p></div>
          <div><p className="text-xs text-muted-foreground">实际收听时长</p><p className="mt-1 text-xl font-semibold tabular-nums">{formatReportDuration(selected.totalPlayedMs)}</p></div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{song ? "最近播放" : `听过 ${selected.trackCount} 首 · 最近播放`} {formatReportDate(selected.lastPlayedAt)}</p>
      </div>}
      {!song && <>
        <div className="flex items-center justify-between gap-3 py-3">
          <span className="text-xs text-muted-foreground">{selected ? "听过的歌曲" : "排行明细"}</span>
          <Segmented
            value={order}
            options={[{ value: "count", label: "播放次数" }, { value: "duration", label: "收听时长" }]}
            onChange={(value) => { setOrder(value); setOffset(0); }}
            label="报告排序"
          />
        </div>
        {loading ? <LoadingState className="py-16" label="正在读取报告…" /> : error ? (
          <div role="alert" className="flex flex-col items-center gap-3 py-16 text-center text-sm text-destructive">
            <p>{error}</p><Button variant="outline" size="xs" onClick={() => setRevision((value) => value + 1)}>重试</Button>
          </div>
        ) : page?.items.length ? <ul>{page.items.map((entry, index) => <li key={entry.id}>
          <button type="button" className="flex w-full items-center gap-3 border-b border-border/50 py-3 text-left hover:bg-secondary/40" onClick={() => select(entry)}>
            <span className="w-6 shrink-0 text-center text-xs tabular-nums text-muted-foreground">{offset + index + 1}</span>
            <EntryPicture entry={entry} name={nameOf(entry)} kind={kind} />
            <span className="min-w-0 flex-1"><span className="flex min-w-0 items-center gap-1.5 text-sm font-medium"><span className="truncate">{nameOf(entry)}</span>{entry.track ? <SourceTag platform={entry.track.platform} size="xs" /> : null}</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{entry.track ? `${entry.track.singer || "未知歌手"} · ${reportSourceLabel(sourceLabel, entry.platform)}` : `${entry.trackCount} 首歌曲`}</span></span>
            <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground"><span className="block">{entry.playCount} 次</span><span className="mt-0.5 block text-2xs">{formatReportDuration(entry.totalPlayedMs)}</span></span>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        </li>)}</ul> : <EmptyState className="py-16" title="暂无听歌记录" />}
      </>}
    </Modal>
  );
}

// EntryPicture 合并到 `./ListenReportBits`（趋势区块也用它，曾各写一份）。
