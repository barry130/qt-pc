import { useEffect, useState } from "react";
import { errMsg } from "@/lib/utils";
import { useDislikesStore } from "@/stores/dislikes";
import { SettingRow } from "../controls";
import { Ban, X } from "lucide-react";

export function DislikeSection(): React.JSX.Element {
  const rules = useDislikesStore((s) => s.rules);
  const loaded = useDislikesStore((s) => s.loaded);
  const refresh = useDislikesStore((s) => s.refresh);
  const unbanById = useDislikesStore((s) => s.unbanById);
  const clearAll = useDislikesStore((s) => s.clearAll);
  const [busy, setBusy] = useState(false);
  // 「清空全部」不可恢复，沿用全项目唯一的二次确认手法：原地换文案再点第二下
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const unban = async (id: number): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await unbanById(id);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const removeAll = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await clearAll();
      setConfirming(false);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-4xl divide-y divide-border">
      <SettingRow
        title="屏蔽规则"
        description="屏蔽后，这些歌 / 这个人的歌不会再出现在列表与自动播放里（手动点播仍可播放）。"
      >
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{loaded ? `${rules.length} 条` : "…"}</span>
          {rules.length > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (confirming) {
                  void removeAll();
                } else {
                  setConfirming(true);
                }
              }}
              className={`rounded-md border px-2 py-1 text-xs transition-colors disabled:opacity-50 ${
                confirming
                  ? "border-destructive text-destructive hover:bg-destructive/10"
                  : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              {confirming ? "确认清空全部？" : "清空"}
            </button>
          )}
        </div>
      </SettingRow>
      <div className="py-3">
        {!loaded ? (
          <p className="text-xs text-muted-foreground">加载中…</p>
        ) : rules.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            还没有屏蔽任何歌曲。在曲目行悬停时的「屏蔽」按钮可以加进来。
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {rules.map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-2 py-2 text-xs"
                data-testid="dislike-rule"
              >
                <Ban className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">
                  {r.kind === "song" && r.singerRaw
                    ? `${r.nameRaw} · ${r.singerRaw}`
                    : r.nameRaw}
                </span>
                <span
                  className="shrink-0 rounded bg-secondary px-1 py-px text-[10px] text-muted-foreground"
                  title={
                    r.kind === "singer"
                      ? "这位歌手的所有歌都不会自动出现"
                      : "这首歌（含同名不同版本）不会自动出现"
                  }
                >
                  {r.kind === "singer" ? "歌手" : "歌曲"}
                </span>
                <button
                  type="button"
                  aria-label={`取消屏蔽 ${r.nameRaw}`}
                  title="取消屏蔽"
                  disabled={busy}
                  onClick={() => void unban(r.id)}
                  className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {confirming && (
        <p className="pb-2 text-xs text-muted-foreground">
          清空后全部规则不可恢复；点空白处切换到别的分区会自动取消这次确认。
        </p>
      )}
      {error && <p className="py-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}
