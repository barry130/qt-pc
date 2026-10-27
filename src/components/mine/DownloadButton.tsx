import { useState } from "react";
import { Check, Download, HardDrive, Loader2 } from "lucide-react";
import { cn, errMsg } from "@/lib/utils";
import type { Quality, Track } from "@/types";
import * as ipc from "@/services/ipc";
import { useDownloadsStore } from "@/stores/downloads";
import { toastError, toastSuccess } from "@/stores/toast";
import { clampQualityForPlatform } from "@/stores/sourceRegistry";
import { sourceDownloadQualityOf } from "@/lib/source-quality";
import { IconButton } from "@/components/common/IconButton";

/**
 * 下载一首歌（DESIGN §5.3）。命令只负责发起，实际下载与进度写库都在 Rust 后台。
 *
 * 音质不传时取该平台的下载音质（音源账号页按平台设置；未配置的平台回落旧
 * 全局键/320），发起前按该曲目的源收敛（v5 契约：包侧声明了可用档位，如
 * B 站无真无损、默认 flac 会自动落到 320；未声明 = 不钳制）。
 * 本地曲目本来就在磁盘上，不给下载入口。
 * 已下载 / 正在下载的曲目按钮变成状态提示，避免重复点击（后端也会去重）。
 *
 * 点击后的「加入下载队列成功 / 失败原因」走右上角 Toast（图标按钮没有可写的
 * 文字位，就地气泡又受行高挤压会互相遮挡）；错误也不能只留在 title 里。
 * 下载是纯入队（§13.4）：真正的取址与下载由后台并发闸门轮着来，这里的回执
 * 只说「进队了」，不说「开始下了」。
 */

/** 列表行内的状态图标：与 IconButton 的 sm 档同尺寸，只提示不可点 */
function StatusIcon(props: {
  label: string;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      title={props.label}
      aria-label={props.label}
      className={cn(
        "flex shrink-0 items-center justify-center p-1 [&_svg]:h-3.5 [&_svg]:w-3.5",
        props.className,
      )}
    >
      {props.children}
    </span>
  );
}

export function DownloadButton(props: {
  track: Track;
  /** 省略 = 用设置里的默认下载音质 */
  quality?: Quality;
  /** list = 列表行内的图标按钮（默认）；icon = 播放条上的圆形图标按钮 */
  variant?: "list" | "icon";
}): React.JSX.Element {
  const { track, quality, variant = "list" } = props;
  const [busy, setBusy] = useState(false);
  const isDownloaded = useDownloadsStore((s) => s.isDownloaded(track));
  const isActive = useDownloadsStore((s) => s.isActive(track));

  const start = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const wanted = quality ?? sourceDownloadQualityOf(track.platform);
      // 默认音质按该曲目所在的源收敛（B 站等无真无损的源自动落到可用档）
      await ipc.startDownload(track, clampQualityForPlatform(track.platform, wanted));
      toastSuccess("加入下载队列成功");
    } catch (err) {
      toastError(`下载发起失败：${errMsg(err)}`);
    } finally {
      setBusy(false);
    }
  };

  if (track.platform === "local") {
    // 本地文件本来就在磁盘上，没有下载入口。两种形态都保留占位（而不是直接
    // 不渲染）：播放条上按钮是左右分列排的，少一个会让其余按钮整体位移，
    // 在线/本地来回切时看得见跳动（用户口径：「本地音乐播放控制栏也正常
    // 展示，不过不允许点击」）。图标沿用下载同形，只是置灰。
    return variant === "icon" ? (
      <span
        title="本地文件（已在磁盘上，无需下载）"
        aria-label="本地文件（已在磁盘上，无需下载）"
        aria-disabled="true"
        className="flex h-9 w-9 shrink-0 cursor-default items-center justify-center rounded-full text-muted-foreground/40"
      >
        <Download className="h-4 w-4" />
      </span>
    ) : (
      <StatusIcon label="本地文件" className="text-muted-foreground">
        <HardDrive />
      </StatusIcon>
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
      <StatusIcon label={label} className="text-primary">
        {isDownloaded ? <Check /> : <Loader2 className="animate-spin" />}
      </StatusIcon>
    );
  }

  if (variant === "icon") {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          void start();
        }}
        title="下载"
        aria-label="下载"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-foreground/80 transition-colors hover:bg-secondary/50 hover:text-foreground disabled:opacity-50"
      >
        <Download className="h-4 w-4" />
      </button>
    );
  }

  return (
    <IconButton
      label="下载"
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        void start();
      }}
    >
      <Download />
    </IconButton>
  );
}
