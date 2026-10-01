import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowDownCircle, X } from "lucide-react";
import {
  applySourceUpdate,
  kindLabel,
  offerLabel,
} from "@/source-scripts/source-update";
import { useSourceUpdateStore } from "@/stores/source-update";
import { stripErrorUrls } from "@/lib/utils";

/**
 * 音源包更新逐条确认提示（v3，与 qt-uniappx 的更新确认弹窗同口径）。
 *
 * 启动静默发现（useSourceUpdateCheck）拿到 offers 后，这里**逐条**向用户
 * 确认（数据包优先——offers 已由 Rust 排序）：
 * - 「更新」→ applySourceUpdate（下载 + 包头一致性校验 + 安装 + 引擎热切换
 *   /冒烟；失败 Rust 自动回滚 .prev 并把该版本拉黑）；
 * - 「暂不」→ 丢弃这条（4h 探测节流内不会再弹）；
 * - 全部处理完提示自动消失；安装类动作不在提示里做，去设置页。
 */
export function SourceUpdatePrompt(): React.JSX.Element | null {
  const navigate = useNavigate();
  const offers = useSourceUpdateStore((s) => s.offers);
  const dropOffer = useSourceUpdateStore((s) => s.dropOffer);
  const setMessage = useSourceUpdateStore((s) => s.setMessage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const offer = offers[0] ?? null;

  useEffect(() => {
    // 换了一条 offer 就清掉上一条的失败残留
    setError("");
  }, [offer?.targetId, offer?.kind, offer?.newCode]);

  if (!offer) return null;

  const onApply = (): void => {
    if (busy) return;
    setBusy(true);
    void (async () => {
      try {
        const outcome = await applySourceUpdate(offer);
        setMessage(
          `${kindLabel(outcome.kind)}已更新到 v${outcome.pack.versionCode}（${outcome.pack.name}）`,
        );
        dropOffer(offer.targetId, offer.kind);
      } catch (e) {
        setError(stripErrorUrls(String(e)));
      } finally {
        setBusy(false);
      }
    })();
  };

  const onSkip = (): void => {
    if (busy) return;
    dropOffer(offer.targetId, offer.kind);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-4 shadow-lg">
        <div className="flex items-start gap-3">
          <ArrowDownCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">
              {kindLabel(offer.kind)}更新可用
            </div>
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {offerLabel(offer)}
              {offer.notes ? `。${offer.notes}` : ""}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground/70">
              共 {offers.length} 条待确认 ·{" "}
              {offer.channel === "manifest" ? "官方通道" : "包自带更新直链"}
            </div>
          </div>
          <button
            type="button"
            aria-label="暂不更新"
            onClick={onSkip}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {error ? (
          <div className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-[11px] leading-relaxed text-destructive">
            {error}（已自动回滚到原版本）
          </div>
        ) : null}
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              onSkip();
              void navigate({
                to: "/settings/$section",
                params: { section: "source-package" },
              });
            }}
            className="rounded-full px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
          >
            去设置页管理
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onSkip}
            className="rounded-full border border-border px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50"
          >
            暂不
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onApply}
            className="rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? "更新中…" : "更新"}
          </button>
        </div>
      </div>
    </div>
  );
}
