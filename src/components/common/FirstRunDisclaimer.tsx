import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import * as ipc from "@/services/ipc";
import { useOfficialSiteUrl } from "@/hooks/useOfficialSiteUrl";
import { useDisclaimerStore } from "@/stores/disclaimer";

/**
 * 首次启动的免责声明 + 开源通知（DESIGN §5.5）。
 *
 * 只在安装后第一次启动出现：接受时刻存在 settings 表（disclaimer.acceptedAt），
 * 之后本组件返回 null。设置页「重新查看」可以随时再打开一次（不写标记）。
 *
 * 「我知道了」要**读完 3 秒**才可点：免责声明最怕的就是被顺手点掉，
 * 3 秒足够扫一眼「不得用于商业用途」和「收费即被骗」这两条。
 *
 * 官网地址走私有配置（useOfficialSiteUrl），**不在源码里出现字面量** ——
 * 公开仓库不能带自有域名。未配置时降级为纯文字，不给一个打不开的链接。
 */
const READ_SECONDS = 3;

export function FirstRunDisclaimer(): React.JSX.Element | null {
  const pending = useDisclaimerStore((s) => s.pending);
  const reopened = useDisclaimerStore((s) => s.reopened);
  const accept = useDisclaimerStore((s) => s.accept);
  const siteUrl = useOfficialSiteUrl();
  const [left, setLeft] = useState(READ_SECONDS);

  const open = pending === true || reopened;

  // 每次打开都重新读秒：设置页「重新查看」也要重新读满 3 秒
  useEffect(() => {
    if (!open) return;
    setLeft(READ_SECONDS);
    const timer = window.setInterval(() => {
      setLeft((n) => (n <= 1 ? 0 : n - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="使用前请先阅读"
        className="flex max-h-[85vh] w-[32rem] max-w-[92vw] flex-col rounded-2xl border border-white/20 bg-white/70 p-5 text-card-foreground shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-black/40"
      >
        <h2 className="text-base font-medium">使用前请先阅读</h2>
        <div className="mt-3 flex-1 space-y-3 overflow-y-auto text-sm leading-relaxed text-muted-foreground">
          <section>
            <h3 className="font-medium text-foreground">一、这是什么</h3>
            <p className="mt-1">
              轻听（QuietMusic）是一个个人开发、免费开源的音乐播放器，用来管理并播放你自己的本地音乐，也可以通过你自己安装的音源包在线试听。它按「现状」提供，不承诺随时可用。
            </p>
          </section>
          <section>
            <h3 className="font-medium text-foreground">二、请这样使用</h3>
            <p className="mt-1">
              仅供个人学习与自用，不得用于商业用途；不得用于批量抓取、下载或再分发受版权保护的音乐。通过音源包访问到的第三方内容，其合法性与风险由你自己承担。
            </p>
          </section>
          <section>
            <h3 className="font-medium text-foreground">三、开源与免费</h3>
            <p className="mt-1">
              本软件的全部功能免费，源代码完整开源（Apache-2.0 + 补充条款）。
            </p>
            <p className="mt-1">
              如果你见到任何以本软件名义向你收取费用的版本或服务，那不是本项目，请立即卸载，并到反馈渠道告诉我们。
            </p>
            <p className="mt-1 flex items-center gap-1">
              开源地址、项目介绍与完整协议：
              {siteUrl ? (
                <button
                  type="button"
                  onClick={() => void ipc.openExternalUrl(siteUrl).catch(() => undefined)}
                  className="inline-flex items-center gap-0.5 text-primary underline-offset-2 hover:underline"
                >
                  {siteUrl}
                  <ExternalLink className="h-3 w-3" />
                </button>
              ) : (
                <span>见官网</span>
              )}
            </p>
          </section>
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