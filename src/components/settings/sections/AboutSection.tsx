import { useEffect, useState } from "react";
import { useOfficialSiteUrl } from "@/hooks/useOfficialSiteUrl";
import { runCheck } from "@/hooks/useUpdateCheck";
import { OFFICIAL_AGREEMENT_PATH, OFFICIAL_FEEDBACK_PATH, OFFICIAL_PRIVACY_PATH, officialSitePath } from "@/lib/official-site";
import { stripErrorUrls } from "@/lib/utils";
import { getAppVersion } from "@/services/ipc";
import { useDisclaimerStore } from "@/stores/disclaimer";
import { toast, toastError, toastSuccess } from "@/stores/toast";
import { useUpdateStore } from "@/stores/update";
import { type AppVersion } from "@/types";
import { ExternalLinkButton, SettingRow } from "../controls";
import { buttonClass } from "@/components/ui";

export function AboutSection(): React.JSX.Element {
  const [version, setVersion] = useState<AppVersion | null>(null);
  const [checking, setChecking] = useState(false);
  const setUpdate = useUpdateStore((s) => s.setUpdate);
  /** 官网根地址（未配置时为空串 → 下面四行整块不渲染） */
  const siteUrl = useOfficialSiteUrl();
  /** 重新打开首次启动的免责声明（只展示，不改已记录的接受时刻） */
  const reopenDisclaimer = useDisclaimerStore((s) => s.reopen);

  /**
   * 声明正文由后端下发，离线 / 后台还没发布时点「查看」不会有任何反应。
   * 那种情况下必须给一句话，否则用户只会觉得按钮坏了。
   */
  const handleReopenDisclaimer = async (): Promise<void> => {
    const shown = await reopenDisclaimer();
    if (!shown) toast("暂时取不到声明内容，请检查网络后重试");
  };

  useEffect(() => {
    void getAppVersion().then(setVersion).catch(() => {});
  }, []);

  const checkUpdate = async (): Promise<void> => {
    setChecking(true);
    try {
      // 手动检查：无条件查一次。复用 runCheck：把结果写入全局 update store
      // → UpdateDialog 会弹出。
      const update = await runCheck(setUpdate);
      if (update && update.versionName) {
        const sizeStr =
          update.fileSize > 0
            ? ` · ${(update.fileSize / 1024 / 1024).toFixed(1)} MB`
            : "";
        // 发现新版本走 UpdateDialog 弹窗，这里只留一条 toast 说明更新说明在哪看
        toast(`发现新版本 ${update.versionName}${sizeStr}，稍后弹窗确认`);
      } else {
        toastSuccess("当前已是最新版本");
      }
    } catch (e) {
      toastError(`检查失败：${stripErrorUrls(String(e))}`);
      setUpdate(null);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="max-w-4xl divide-y divide-border">
      <SettingRow title="当前版本" description="轻听 PC 版">
        <span className="font-mono text-xs text-muted-foreground">
          {version ? `${version.versionName} (versionCode ${version.versionCode})` : "…"}
        </span>
      </SettingRow>
      <SettingRow title="检查更新" description="启动时自动检查">
        <button
          type="button"
          onClick={() => void checkUpdate()}
          disabled={checking}
          className={buttonClass({ variant: "outline" })}
        >
          {checking ? "检查中…" : "检查更新"}
        </button>
      </SettingRow>
      {/* 官网条款与开源信息：协议正文、隐私说明与仓库地址都只在官网维护一份，
          客户端只保留入口，避免两边各写一份然后慢慢对不上。
          官网地址是自有地址（只在 Rust 侧持有）：未配置时整块不渲染，
          不给打不开的链接 */}
      {siteUrl ? (
        <>
          <SettingRow title="项目介绍与开源地址" description="功能介绍与开源地址">
            <ExternalLinkButton label="打开官网" url={siteUrl} />
          </SettingRow>
          <SettingRow title="用户协议" description="建议先读一遍">
            <ExternalLinkButton
              label="查看"
              url={officialSitePath(siteUrl, OFFICIAL_AGREEMENT_PATH)}
            />
          </SettingRow>
          <SettingRow title="隐私政策" description="数据收集与保留说明">
            <ExternalLinkButton
              label="查看"
              url={officialSitePath(siteUrl, OFFICIAL_PRIVACY_PATH)}
            />
          </SettingRow>
          <SettingRow title="意见反馈" description="Issue 与 PR 入口">
            <ExternalLinkButton
              label="前往反馈"
              url={officialSitePath(siteUrl, OFFICIAL_FEEDBACK_PATH)}
            />
          </SettingRow>
        </>
      ) : null}
      {/* 免责声明正文由后端下发（后台「消息管理」的开屏公告），所以这一行不受 siteUrl 约束 */}
      <SettingRow title="重新查看免责声明" description="首次启动时的声明">
        <button
          type="button"
          onClick={() => void handleReopenDisclaimer()}
          className={buttonClass({ variant: "outline" })}
        >
          查看
        </button>
      </SettingRow>
    </div>
  );
}

/** 打开官网页面的按钮：统一走 openExternalUrl（系统默认浏览器），失败静默不打断设置页 */
