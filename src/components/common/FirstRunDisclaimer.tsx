import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { RichText } from "@/lib/richText";
import * as ipc from "@/services/ipc";
import { disclaimerVisible, useDisclaimerStore } from "@/stores/disclaimer";

/**
 * 首次启动的免责声明 + 开源通知（DESIGN §5.6）。
 *
 * **文案不在代码里**：正文、标题、读秒时长、条款版本号全部由后端下发，
 * 后台「消息中心 → 通知管理」发一条通知并打开「仅首次启动弹出」开关即可改，
 * 不用发版。开关会自动生成 `termsVersion` 并强制开屏位/App 六端/可关闭，
 * 判定哪个公告是这份声明见 `stores/disclaimer.ts`。
 *
 * 只在安装后第一次启动出现：接受记录存在 SQLite settings 表
 * （`disclaimer.acceptedAt`，JSON：`{termsVersion, acceptedAt}`），之后返回 null。
 * 设置页「重新查看」可以随时再打开一次（不写标记）。
 *
 * 「我知道了」默认要**读满 N 秒**才可点（N 由后端给，0 = 不读秒）：
 * 声明最怕的就是被顺手点掉。读秒时长只是防手滑，不是法律要件，后台可调。
 */
export function FirstRunDisclaimer(): React.JSX.Element | null {
  const pending = useDisclaimerStore((s) => s.pending);
  const reopened = useDisclaimerStore((s) => s.reopened);
  const notice = useDisclaimerStore((s) => s.notice);
  const accept = useDisclaimerStore((s) => s.accept);
  const readSeconds = notice?.readSeconds ?? 0;
  const [left, setLeft] = useState(readSeconds);

  const open = disclaimerVisible({ pending, reopened, notice });

  // 每次打开都重新读秒：设置页「重新查看」也要重新读满
  useEffect(() => {
    if (!open) return;
    setLeft(readSeconds);
    if (readSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setLeft((n) => (n <= 1 ? 0 : n - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [open, readSeconds]);

  if (!open || notice == null) return null;

  const url = notice.url != null && /^https?:\/\//i.test(notice.url) ? notice.url : "";

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={notice.title || "使用前请先阅读"}
        className="flex max-h-[85vh] w-[32rem] max-w-[92vw] flex-col rounded-2xl border border-white/20 bg-white/70 p-5 text-card-foreground shadow-overlay backdrop-blur-xl dark:border-white/10 dark:bg-black/40"
      >
        <h2 className="text-base font-medium">{notice.title || "使用前请先阅读"}</h2>
        <div className="mt-3 flex-1 overflow-y-auto text-muted-foreground">
          <RichText text={notice.content} />
          {url.length > 0 && (
            <p className="mt-3 text-sm">
              <button
                type="button"
                onClick={() => void ipc.openExternalUrl(url).catch(() => undefined)}
                className="inline-flex items-center gap-0.5 text-primary underline-offset-2 hover:underline"
              >
                {url}
                <ExternalLink className="h-3 w-3" />
              </button>
            </p>
          )}
        </div>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            disabled={left > 0}
            onClick={() => void accept()}
            className="rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {left > 0 ? `请阅读（${left}s）` : "我知道了"}
          </button>
        </div>
      </div>
    </div>
  );
}
