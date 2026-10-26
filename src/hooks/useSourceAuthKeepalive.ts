import { useEffect } from "react";
import { refreshAllSourceAccounts } from "@/lib/source-auth";

/** 首次校验延迟（ms）：等引擎装载 + 首屏渲染稳定后再跑 */
const FIRST_RUN_DELAY_MS = 20_000;
/** 后台保活周期（ms）：6 小时 */
const KEEPALIVE_INTERVAL_MS = 21_600_000;

/**
 * 音源账号后台保活（应用启动 + 每 6 小时自动校验 + 轮换）：
 * QQ musickey 等短期凭据靠包侧 refreshCredential 续期，用户不常开
 * 「音源账号」页，错过打开页面的校验窗口凭据就会过期——这里补上
 * 启动后 20s 首跑 + 6h 定时两道兜底，逐源校验并落库轮换出的新凭据。
 * 失败（网络断 / 旧包缺入口）只 console.warn，绝不打扰用户。
 */
export function useSourceAuthKeepalive(): void {
  useEffect(() => {
    const run = (reason: string): void => {
      // refreshAllSourceAccounts 内部已逐源容错；这里再兜一层总失败（读库等）
      void refreshAllSourceAccounts(reason).catch((err) => {
        console.warn(`[source-auth] 后台保活失败（${reason}）`, err);
      });
    };
    const firstTimer = window.setTimeout(() => run("启动首检"), FIRST_RUN_DELAY_MS);
    const intervalTimer = window.setInterval(() => run("6h 定时保活"), KEEPALIVE_INTERVAL_MS);
    return () => {
      window.clearTimeout(firstTimer);
      window.clearInterval(intervalTimer);
    };
  }, []);
}
