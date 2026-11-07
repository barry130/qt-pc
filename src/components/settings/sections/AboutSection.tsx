import { useEffect, useState } from "react";
import { useOfficialSiteUrl } from "@/hooks/useOfficialSiteUrl";
import { runCheck } from "@/hooks/useUpdateCheck";
import { useT } from "@/lib/i18n";
import { OFFICIAL_AGREEMENT_PATH, OFFICIAL_FEEDBACK_PATH, OFFICIAL_PRIVACY_PATH, officialSitePath } from "@/lib/official-site";
import { stripErrorUrls } from "@/lib/utils";
import { getAppPaths, getAppVersion, buildDiagnostics, pickSavePath, saveBinaryFile } from "@/services/ipc";
import { useAuthStore } from "@/stores/auth";
import { useDisclaimerStore } from "@/stores/disclaimer";
import { toast, toastError, toastSuccess } from "@/stores/toast";
import { useUpdateStore } from "@/stores/update";
import { type AppPaths, type AppVersion } from "@/types";
import { ExternalLinkButton, SettingRow } from "../controls";
import { Badge, buttonClass } from "@/components/ui";

export function AboutSection(): React.JSX.Element {
  const tr = useT();
  const [version, setVersion] = useState<AppVersion | null>(null);
  /** 数据目录快照（§8.2 便携模式）：拿不到就不显示路径，不留空行 */
  const [paths, setPaths] = useState<AppPaths | null>(null);
  const [checking, setChecking] = useState(false);
  /** 诊断包正在打包（读日志 + 组 zip，几百毫秒级，给个忙碌态防连点） */
  const [exporting, setExporting] = useState(false);
  const setUpdate = useUpdateStore((s) => s.setUpdate);
  /** 官网根地址（未配置时为空串 → 下面四行整块不渲染） */
  const siteUrl = useOfficialSiteUrl();
  /** 重新打开首次启动的免责声明（只展示，不改已记录的接受时刻） */
  const reopenDisclaimer = useDisclaimerStore((s) => s.reopen);
  /**
   * 登录态（S03）：系统安全仓库不可用时后端只能把会话放在内存里，重启即失效。
   * 这种情况下在「关于」里明确告诉用户，而不是让他们重启后才发现被登出。
   */
  const session = useAuthStore((s) => s.session);

  /**
   * 声明正文由后端下发，离线 / 后台还没发布时点「查看」不会有任何反应。
   * 那种情况下必须给一句话，否则用户只会觉得按钮坏了。
   */
  const handleReopenDisclaimer = async (): Promise<void> => {
    const shown = await reopenDisclaimer();
    if (!shown) toast(tr("settings.about.disclaimerUnavailable"));
  };

  useEffect(() => {
    void getAppVersion().then(setVersion).catch(() => {});
    void getAppPaths().then(setPaths).catch(() => {});
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
        toast(tr("settings.about.updateFound", { version: update.versionName, size: sizeStr }));
      } else {
        toastSuccess(tr("settings.about.upToDate"));
      }
    } catch (e) {
      toastError(tr("settings.about.updateCheckFailed", { error: stripErrorUrls(String(e)) }));
      setUpdate(null);
    } finally {
      setChecking(false);
    }
  };

  /**
   * 导出诊断包（§18 / B8）：先打包、再让用户选路径 —— 用户点取消时一个字节都不落盘。
   */
  const exportDiagnostics = async (): Promise<void> => {
    setExporting(true);
    try {
      const bundle = await buildDiagnostics();
      const path = await pickSavePath(bundle.fileName, tr("settings.about.saveDiagnosticsTitle"), ["zip"]);
      if (path === null) return;
      await saveBinaryFile(path, bundle.base64);
      toastSuccess(
        tr("settings.about.exported", {
          files: bundle.files,
          size: (bundle.bytes / 1024).toFixed(1),
        }),
      );
    } catch (e) {
      toastError(tr("settings.about.exportFailed", { error: stripErrorUrls(String(e)) }));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="max-w-4xl divide-y divide-border">
      {/* 凭据安全状态（S03）：只在本机确实没持久化时出现，不打扰正常用户 */}
      {session?.persistence === "memory-only" ? (
        <SettingRow
          title={tr("settings.about.sessionMemoryOnly")}
          description={tr("settings.about.sessionMemoryOnlyHint")}
        >
          <Badge tone="outline">
            {tr("settings.about.sessionMemoryOnlyBadge")}
          </Badge>
        </SettingRow>
      ) : null}
      <SettingRow
        title={tr("settings.about.currentVersion")}
        description={tr("settings.about.appEdition")}
      >
        <span className="font-mono text-xs text-muted-foreground">
          {version
            ? tr("settings.about.versionValue", {
                name: version.versionName,
                code: version.versionCode,
              })
            : "…"}
        </span>
      </SettingRow>
      <SettingRow
        title={tr("settings.about.checkUpdate")}
        description={tr("settings.about.autoCheck")}
      >
        <button
          type="button"
          onClick={() => void checkUpdate()}
          disabled={checking}
          className={buttonClass({ variant: "outline" })}
        >
          {checking ? tr("settings.about.checking") : tr("settings.about.checkUpdate")}
        </button>
      </SettingRow>
      {/* 数据目录（§8.2）：便携版下就在程序旁边，换机直接整个文件夹拷走 */}
      <SettingRow
        title={tr("settings.about.dataDir")}
        description={
          paths?.portable
            ? tr("settings.about.dataDirHintPortable")
            : tr("settings.about.dataDirHint")
        }
      >
        <div className="flex flex-col items-end gap-1">
          {paths?.portable ? (
            <span className="rounded border border-border px-1.5 py-0.5 text-2xs text-muted-foreground">
              {tr("settings.about.portable")}
            </span>
          ) : null}
          <span className="max-w-80 break-all text-right font-mono text-2xs text-muted-foreground">
            {paths?.dataRoot ?? "…"}
          </span>
        </div>
      </SettingRow>
      {/* 诊断包（§18 / B8）：排障时让用户一键把日志与配置发过来，不用一步步教抓文件。
          不含曲库路径清单与历史明细；凭据在 Rust 侧替换成 *** */}
      <SettingRow
        title={tr("settings.about.diagnostics")}
        description={tr("settings.about.diagnosticsHint")}
      >
        <button
          type="button"
          onClick={() => void exportDiagnostics()}
          disabled={exporting}
          className={buttonClass({ variant: "outline" })}
        >
          {exporting ? tr("settings.about.exporting") : tr("settings.about.exportDiagnostics")}
        </button>
      </SettingRow>
      {/* 官网条款与开源信息：协议正文、隐私说明与仓库地址都只在官网维护一份，
          客户端只保留入口，避免两边各写一份然后慢慢对不上。
          官网地址是自有地址（只在 Rust 侧持有）：未配置时整块不渲染，
          不给打不开的链接 */}
      {siteUrl ? (
        <>
          <SettingRow
            title={tr("settings.about.projectIntro")}
            description={tr("settings.about.projectIntroHint")}
          >
            <ExternalLinkButton label={tr("settings.about.openSite")} url={siteUrl} />
          </SettingRow>
          <SettingRow
            title={tr("settings.about.agreement")}
            description={tr("settings.about.agreementHint")}
          >
            <ExternalLinkButton
              label={tr("settings.about.view")}
              url={officialSitePath(siteUrl, OFFICIAL_AGREEMENT_PATH)}
            />
          </SettingRow>
          <SettingRow
            title={tr("settings.about.privacy")}
            description={tr("settings.about.privacyHint")}
          >
            <ExternalLinkButton
              label={tr("settings.about.view")}
              url={officialSitePath(siteUrl, OFFICIAL_PRIVACY_PATH)}
            />
          </SettingRow>
          <SettingRow
            title={tr("settings.about.feedback")}
            description={tr("settings.about.feedbackHint")}
          >
            <ExternalLinkButton
              label={tr("settings.about.goFeedback")}
              url={officialSitePath(siteUrl, OFFICIAL_FEEDBACK_PATH)}
            />
          </SettingRow>
        </>
      ) : null}
      {/* 免责声明正文由后端下发（后台「消息管理」的开屏公告），所以这一行不受 siteUrl 约束 */}
      <SettingRow
        title={tr("settings.about.reopenDisclaimer")}
        description={tr("settings.about.firstRunDisclaimer")}
      >
        <button
          type="button"
          onClick={() => void handleReopenDisclaimer()}
          className={buttonClass({ variant: "outline" })}
        >
          {tr("settings.about.view")}
        </button>
      </SettingRow>
    </div>
  );
}

/** 打开官网页面的按钮：统一走 openExternalUrl（系统默认浏览器），失败静默不打断设置页 */
