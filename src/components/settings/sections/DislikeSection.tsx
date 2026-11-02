import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { errMsg } from "@/lib/utils";
import { useDislikesStore } from "@/stores/dislikes";
import { SettingRow } from "../controls";
import { Ban, X } from "lucide-react";

export function DislikeSection(): React.JSX.Element {
  const tr = useT();
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
        title={tr("settings.dislike.rules.title")}
        description={tr("settings.dislike.rules.description")}
      >
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{loaded ? tr("settings.dislike.count", { n: rules.length }) : "…"}</span>
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
              {confirming ? tr("settings.dislike.clearConfirm") : tr("settings.dislike.clear")}
            </button>
          )}
        </div>
      </SettingRow>
      <div className="py-3">
        {!loaded ? (
          <p className="text-xs text-muted-foreground">{tr("common.loading")}</p>
        ) : rules.length === 0 ? (
          <p className="text-xs text-muted-foreground">{tr("settings.dislike.empty")}</p>
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
                  className="shrink-0 rounded bg-secondary px-1 py-px text-3xs text-muted-foreground"
                  title={
                    r.kind === "singer"
                      ? tr("settings.dislike.kindTitle.singer")
                      : tr("settings.dislike.kindTitle.song")
                  }
                >
                  {r.kind === "singer"
                    ? tr("settings.dislike.kind.singer")
                    : tr("settings.dislike.kind.song")}
                </span>
                <button
                  type="button"
                  aria-label={tr("settings.dislike.unbanAria", { name: r.nameRaw })}
                  title={tr("settings.dislike.unban")}
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
          {tr("settings.dislike.clearHint")}
        </p>
      )}
      {error && <p className="py-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}
