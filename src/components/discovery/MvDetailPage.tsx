import { useEffect, useState } from "react";
import { errMsg } from "@/lib/utils";
import type { SourceId } from "@/types";
import * as sourceApi from "@/source-scripts";
import { qtresMvUrl } from "@/lib/lrc";
import { BackButton } from "@/components/layout/BackButton";

/** 把 Rust 返回的 ProviderError 系列化成可读文案（避免裸展示 {"kind":"noPlayableUrl"}）。 */
function mvErrorText(err: unknown): string {
  if (err && typeof err === "object") {
    const kind = (err as { kind?: unknown }).kind;
    if (kind === "noPlayableUrl" || kind === "empty") {
      return "这首歌暂时拿不到 MV 地址（音源权限/接口变动），试试换一个音源播放 MV。";
    }
    if (kind === "unsupported") {
      return "这个音源不支持 MV 播放，试试换一个音源。";
    }
  }
  return errMsg(err);
}

/**
 * MV 播放（路由 /mv/$platform/$id，DESIGN §5.2 / §6.13）。
 *
 * 播放地址经 Rust 侧解析后，用 qtres://mv/<base64url> 交给 <video>：
 * 由 Rust 转发并透传 Range 头（上游防盗链 Referer 也由 Rust 补），
 * 前端不直接请求外部 CDN（CSP 不放开外部域名）。
 */
export function MvDetailPage(props: {
  platform: string;
  id: string;
}): React.JSX.Element {
  const { platform, id } = props;
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const url = await sourceApi.getVideoUrl(platform as SourceId, id, "auto");
        if (cancelled) return;
        setSrc(qtresMvUrl(url));
      } catch (err) {
        if (!cancelled) setError(mvErrorText(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [platform, id]);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <BackButton />
        <h1 className="truncate text-base font-medium">MV 播放</h1>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            解析 MV 地址…
          </div>
        ) : error ? (
          <div className="py-10 text-center text-sm text-destructive">
            加载失败：{error}
          </div>
        ) : src ? (
          <video
            src={src}
            controls
            autoPlay
            className="mx-auto w-full max-w-4xl rounded-md bg-black"
          />
        ) : (
          <div className="py-10 text-center text-sm text-muted-foreground">
            无法解析 MV 地址
          </div>
        )}
      </div>
    </div>
  );
}
