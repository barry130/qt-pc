import { useState } from "react";
import { errMsg } from "@/lib/utils";
import type { Playlist, SourceId } from "@/types";
import { SOURCE_DISPLAY } from "@/types";
import { importPlaylist } from "@/lib/playlist-import";

/** 可导入的四个在线源（与 SOURCE_DISPLAY 同序） */
const PLATFORMS: Exclude<SourceId, "local">[] = ["wyy", "qq", "kg", "kw"];

/**
 * 导入歌单弹窗：粘贴四源分享链接/歌单 ID → 收藏进「我的歌单」。
 * 识别不出平台（纯数字 ID）时可手动指定；成功后由调用方负责刷新与跳转。
 */
export function ImportPlaylistDialog(props: {
  onClose: () => void;
  onImported: (playlist: Playlist, already: boolean) => void;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const [platform, setPlatform] = useState<"" | Exclude<SourceId, "local">>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const input = text.trim();
    if (!input || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { playlist, already } = await importPlaylist(
        input,
        platform === "" ? undefined : platform,
      );
      props.onImported(playlist, already);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) props.onClose();
      }}
    >
      <div className="w-[26rem] rounded-2xl border border-white/20 bg-white/70 p-5 text-card-foreground shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-black/40">
        <h2 className="text-base font-medium">导入歌单</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          粘贴分享链接、分享文案或歌单 ID，导入后进入「收藏的在线歌单」
        </p>

        <textarea
          autoFocus
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={"例：https://music.163.com/#/playlist?id=123456\n或直接输入歌单 ID"}
          className="mt-3 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />

        <div className="mt-2 flex items-center gap-2">
          <span className="shrink-0 text-xs text-muted-foreground">平台</span>
          <select
            value={platform}
            onChange={(e) =>
              setPlatform(e.target.value as "" | Exclude<SourceId, "local">)
            }
            className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">自动识别（链接）</option>
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {SOURCE_DISPLAY[p]}
              </option>
            ))}
          </select>
        </div>

        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={props.onClose}
            disabled={busy}
            className="h-8 rounded-md border border-border px-3 text-xs hover:bg-accent disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !text.trim()}
            className="h-8 rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "导入中…" : "导入"}
          </button>
        </div>
      </div>
    </div>
  );
}
