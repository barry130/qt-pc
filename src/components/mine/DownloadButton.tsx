import { useState } from "react";
import { Check, Download, Loader2 } from "lucide-react";
import { errMsg } from "@/lib/utils";
import type { Quality, Track } from "@/types";
import * as ipc from "@/services/ipc";
import { useDownloadsStore } from "@/stores/downloads";
import { clampQualityForPlatform } from "@/stores/sourceRegistry";

/**
 * 下载一首歌（DESIGN §5.3）。命令只负责发起，实际下载与进度写库都在 Rust 后台。
 *
 * 音质不传时取设置里的「默认下载音质」（下载与播放音质互相独立），发起前
 * 按该曲目的源收敛（v5 契约：包侧声明了可用档位，如 B 站无真无损、默认
 * flac 会自动落到 320；未声明 = 不钳制）。
 * 本地曲目本来就在磁盘上，不给下载入口。
 * 已下载 / 正在下载的曲目按钮变成状态提示，避免重复点击（后端也会去重）。
 */
export function DownloadButton(props: {
  track: Track;
  /** 省略 = 用设置里的默认下载音质 */
  quality?: Quality;
  /** text = 列表里的文字按钮；icon = 播放条上的圆形图标按钮 */
  variant?: "text" | "icon";
}): React.JSX.Element {
  const { track, quality, variant = "text" } = props;
  const [tip, setTip] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isDownloaded = useDownloadsStore((s) => s.isDownloaded(track));
  const isActive = useDownloadsStore((s) => s.isActive(track));

  const start = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setTip(null);
    try {
      const wanted = quality ?? (await ipc.getDownloadQuality());
      // 默认音质按该曲目所在的源收敛（B 站等无真无损的源自动落到可用档）
      await ipc.startDownload(track, clampQualityForPlatform(track.platform, wanted));
      setTip("已开始");
      window.setTimeout(() => setTip(null), 1200);
    } catch (err) {
      setTip(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  if (track.platform === "local") {
    // 播放条上直接不显示；列表里保留「本地」占位，说明为什么没有下载入口
    return variant === "icon" ? (
      <></>
    ) : (
      <span className="shrink-0 px-2 text-xs text-muted-foreground">本地</span>
    );
  }

  // 已下载 / 下载中：只做状态提示，不可再点
  if (isDownloaded || isActive) {
    const label = isDownloaded ? "已下载" : "下载中";
    return variant === "icon" ? (
      <span
        title={label}
        aria-label={label}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-primary"
      >
        {isDownloaded ? <Check className="h-4 w-4" /> : <Loader2 className="h-4 w-4 animate-spin" />}
      </span>
    ) : (
      <span className="shrink-0 px-2 text-xs text-primary">{label}</span>
    );
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        void start();
      }}
      title={tip ?? "下载"}
      aria-label="下载"
      className={
        variant === "icon"
          ? "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-foreground/80 transition-all hover:bg-secondary/50 hover:text-foreground disabled:opacity-50"
          : "shrink-0 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
      }
    >
      {variant === "icon" ? <Download className="h-4 w-4" /> : (tip ?? "下载")}
    </button>
  );
}
