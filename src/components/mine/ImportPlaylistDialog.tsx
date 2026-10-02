import { useEffect, useState } from "react";
import { errMsg } from "@/lib/utils";
import type { Playlist } from "@/types";
import {
  useSourceRegistryStore,
  useSourceLabelFn,
} from "@/stores/sourceRegistry";
import {
  importPlaylist,
  importPlaylistSongs,
} from "@/lib/playlist-import";
import { parsePlaylistInput } from "@/lib/playlist-link";
import * as sourceApi from "@/source-scripts";
import * as ipc from "@/services/ipc";

/**
 * 导入歌单弹窗（对齐 qt-uniappx 歌单导入页的两个去向）：
 * - 导入歌曲：解析链接 → 拉全量曲目预览 → 新建/选一个我方歌单整单拷入；
 * - 收藏歌单：解析链接 → 收藏在线歌单（只落元数据，曲目打开详情时再取）。
 * 识别不出平台（纯数字 ID）时可手动指定；完成后由调用方负责刷新与跳转。
 * 可选平台来自数据包注册表（未就绪时只剩自动识别）。
 */
export function ImportPlaylistDialog(props: {
  onClose: () => void;
  /** 收藏歌单模式完成（含已收藏过的情况） */
  onImported: (playlist: Playlist, already: boolean) => void;
  /** 导入歌曲模式完成（targetId = 我方歌单 pid） */
  onSongsImported?: (targetId: string) => void;
}): React.JSX.Element {
  const sources = useSourceRegistryStore((s) => s.sources);
  const ensureRegistry = useSourceRegistryStore((s) => s.ensure);
  const sourceLabel = useSourceLabelFn();
  const [mode, setMode] = useState<"songs" | "collect">("songs");
  const [text, setText] = useState("");
  const [platform, setPlatform] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 导入歌曲模式：解析出的预览（含全量曲目）与目标选择
  const [preview, setPreview] = useState<Playlist | null>(null);
  const [targetChoice, setTargetChoice] = useState(0); // 0 = 新建，N = myPlaylists[N-1]
  const [newName, setNewName] = useState("");
  const [myPlaylists, setMyPlaylists] = useState<
    { id: string; name: string }[]
  >([]);
  const [result, setResult] = useState<string | null>(null);

  const forced = platform === "" ? undefined : platform;

  // 平台清单来自数据包注册表：挂载时拉一次（幂等），加载后选项自动出现
  useEffect(() => {
    void ensureRegistry();
  }, [ensureRegistry]);

  /** 解析输入 → 拉详情预览（导入歌曲模式做全量预览） */
  const parse = async (): Promise<void> => {
    const input = text.trim();
    if (!input || busy) return;
    setBusy(true);
    setError(null);
    setPreview(null);
    setResult(null);
    try {
      const parsed = parsePlaylistInput(input, forced);
      if (!parsed) {
        throw new Error("无法识别歌单链接或 ID，可试试手动选择平台");
      }
      const detail = await sourceApi.getPlaylistDetail(parsed.platform, parsed.id);
      if (!detail?.name) {
        throw new Error("该歌单不存在或暂时无法访问");
      }
      setPreview(detail);
      if (mode === "songs") {
        // 导入目标只列本地自建歌单：收藏的在线歌单是引用（详情按音源重取），
        // 导进去的歌看不见。且定位键必须用 pid（云端收藏/落库都按它走），
        // 不是本地行 id
        const all = await ipc.listMyPlaylists();
        setMyPlaylists(
          all
            .filter((p) => p.platform === ipc.LOCAL_PLATFORM)
            .map((p) => ({ id: p.pid, name: p.name })),
        );
        setTargetChoice(0);
        setNewName("");
      }
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  /** 导入歌曲：建/选目标歌单 → 整单拷入 */
  const importSongs = async (): Promise<void> => {
    if (!preview || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await importPlaylistSongs(text.trim(), forced, (() => {
        if (targetChoice === 0) return { kind: "new" as const, name: newName };
        const pl = myPlaylists[targetChoice - 1];
        return { kind: "existing" as const, id: pl.id, name: pl.name };
      })());
      setResult(`已导入 ${res.added} / ${res.total} 首到「${res.targetName}」`);
      props.onSongsImported?.(res.targetId);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  /** 收藏歌单：老路径（解析 → 详情 → 收藏引用） */
  const collect = async (): Promise<void> => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { playlist, already } = await importPlaylist(text.trim(), forced);
      props.onImported(playlist, already);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const canParse = Boolean(text.trim()) && !busy;
  // 导入歌曲：解析出预览后才能导入；收藏歌单：有输入即可一步走完
  const primaryDisabled = mode === "songs" ? !preview || busy : !text.trim() || busy;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) props.onClose();
      }}
    >
      <div className="w-[30rem] rounded-2xl border border-white/20 bg-white/70 p-5 text-card-foreground shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-black/40">
        <h2 className="text-base font-medium">导入歌单</h2>
        <div className="mt-2 flex gap-1 rounded-md bg-muted p-0.5 text-xs">
          {(
            [
              ["songs", "导入歌曲"],
              ["collect", "收藏歌单"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              disabled={busy}
              onClick={() => {
                setMode(key);
                setPreview(null);
                setResult(null);
                setError(null);
              }}
              className={
                mode === key
                  ? "flex-1 rounded bg-background px-3 py-1.5 font-medium shadow-sm"
                  : "flex-1 rounded px-3 py-1.5 text-muted-foreground hover:text-foreground"
              }
            >
              {label}
            </button>
          ))}
        </div>

        <textarea
          autoFocus
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void parse();
            }
          }}
          placeholder={"例：https://music.163.com/#/playlist?id=123456\n或直接输入歌单 ID"}
          className="mt-3 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />

        <div className="mt-2 flex items-center gap-2">
          <span className="shrink-0 text-xs text-muted-foreground">平台</span>
          <select
            value={sources.some((s) => s.id === platform) ? platform : ""}
            onChange={(e) => setPlatform(e.target.value)}
            className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">自动识别（链接）</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void parse()}
            disabled={!canParse}
            className="h-8 rounded-md border border-border px-3 text-xs hover:bg-accent disabled:opacity-50"
          >
            {busy && mode === "songs" ? "解析中…" : "解析"}
          </button>
        </div>

        {mode === "songs" && preview && (
          <div className="mt-3 rounded-md border border-border p-3">
            <div className="flex items-center gap-3">
              {preview.picUrl ? (
                <img
                  src={preview.picUrl}
                  alt=""
                  className="h-14 w-14 shrink-0 rounded-md object-cover"
                />
              ) : null}
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{preview.name}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {sourceLabel(preview.platform)}
                  {preview.tracks ? ` · ${preview.tracks.length} 首` : ""}
                </p>
              </div>
            </div>

            <div className="mt-3 space-y-2">
              <label className="flex items-start gap-2 text-xs">
                <input
                  type="radio"
                  checked={targetChoice === 0}
                  onChange={() => setTargetChoice(0)}
                  className="mt-0.5 accent-primary"
                />
                <span className="flex-1">
                  新建歌单
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder={`默认用「${preview.name}」`}
                    className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </span>
              </label>
              {myPlaylists.length > 0 && (
                <label className="flex items-start gap-2 text-xs">
                  <input
                    type="radio"
                    checked={targetChoice !== 0}
                    onChange={() => setTargetChoice(1)}
                    className="mt-0.5 accent-primary"
                  />
                  <span className="flex-1">
                    导入现有歌单
                    <select
                      value={targetChoice > 0 ? targetChoice : ""}
                      onChange={(e) =>
                        setTargetChoice(Number(e.target.value) || 1)
                      }
                      disabled={targetChoice === 0}
                      className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    >
                      <option value="" disabled>
                        选择歌单
                      </option>
                      {myPlaylists.map((pl, idx) => (
                        <option key={pl.id} value={idx + 1}>
                          {pl.name}
                        </option>
                      ))}
                    </select>
                  </span>
                </label>
              )}
            </div>
          </div>
        )}

        {result && <p className="mt-2 text-xs text-primary">{result}</p>}
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={props.onClose}
            disabled={busy}
            className="h-8 rounded-md border border-border px-3 text-xs hover:bg-accent disabled:opacity-50"
          >
            {result ? "完成" : "取消"}
          </button>
          {mode === "songs" ? (
            <button
              type="button"
              onClick={() => void importSongs()}
              disabled={primaryDisabled}
              className="h-8 rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "导入中…" : "导入歌曲"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void collect()}
              disabled={primaryDisabled}
              className="h-8 rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "导入中…" : "收藏歌单"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
