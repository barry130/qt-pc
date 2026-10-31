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
import { toastSuccess } from "@/stores/toast";
import { Button, IconButton, Modal } from "@/components/ui";

/**
 * 音源包更新逐条确认提示（v3，与 qt-uniappx 的更新确认弹窗同口径）。
 *
 * 启动静默发现（useSourceUpdateCheck）拿到 offers 后，这里**逐条**向用户
 * 确认（数据包优先——offers 已由 Rust 排序）：
 * - 「更新」→ applySourceUpdate（下载 + 包头一致性校验 + 安装 + 引擎热切换
 *   /冒烟；失败 Rust 自动回滚 .prev 并把该版本拉黑）；
 * - 「暂不」→ 丢弃这条（4h 探测节流内不会再弹）；
 * - 全部处理完提示自动消失；安装类动作不在提示里做，去设置页。
 *
 * 外壳用统一的 `Modal`（不可通过 Esc/遮罩关闭：这条提示只应该由「更新 / 暂不」
 * 推进，误触关掉会让用户以为已经处理过）。
 */
export function SourceUpdatePrompt(): React.JSX.Element | null {
  const navigate = useNavigate();
  const offers = useSourceUpdateStore((s) => s.offers);
  const dropOffer = useSourceUpdateStore((s) => s.dropOffer);
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
        // 确认后提示自动消失，安装结果用户看不见 → 右上角绿勾兜底
        toastSuccess(
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
    <Modal
      open
      onClose={onSkip}
      size="sm"
      dismissible={false}
      closeOnBackdrop={false}
      className="bg-card/90"
      bodyClassName="p-4"
    >
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
          <div className="mt-1 text-2xs text-muted-foreground/70">
            共 {offers.length} 条待确认 ·{" "}
            {offer.channel === "manifest" ? "官方通道" : "包自带更新直链"}
          </div>
        </div>
        <IconButton label="暂不更新" onClick={onSkip}>
          <X />
        </IconButton>
      </div>
      {error ? (
        <div className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-2xs leading-relaxed text-destructive">
          {error}（已自动回滚到原版本）
        </div>
      ) : null}
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          shape="pill"
          disabled={busy}
          onClick={() => {
            onSkip();
            void navigate({
              to: "/settings/$section",
              params: { section: "source-package" },
            });
          }}
        >
          去设置页管理
        </Button>
        <Button variant="outline" shape="pill" disabled={busy} onClick={onSkip}>
          暂不
        </Button>
        <Button variant="primary" shape="pill" loading={busy} onClick={onApply}>
          {busy ? "更新中…" : "更新"}
        </Button>
      </div>
    </Modal>
  );
}
