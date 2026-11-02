import { defineFragment } from "@/lib/i18n-fragment";

/**
 * 设置 → 关于（版本、数据目录、诊断包、开源地址）。
 *
 * 键前缀 `settings.about.`；中文与英文必须一一对齐（少一条 `tsc` 会报错）。
 */
export const messages = defineFragment({
  zh: {
    // 版本与更新
    "settings.about.currentVersion": "当前版本",
    "settings.about.appEdition": "轻听 PC 版",
    "settings.about.versionValue": "{name} (versionCode {code})",
    "settings.about.checkUpdate": "检查更新",
    "settings.about.autoCheck": "启动时自动检查",
    "settings.about.checking": "检查中…",
    "settings.about.upToDate": "当前已是最新版本",
    "settings.about.updateFound": "发现新版本 {version}{size}，稍后弹窗确认",
    "settings.about.updateCheckFailed": "检查失败：{error}",
    // 数据目录（§8.2 便携模式）
    "settings.about.dataDir": "数据目录",
    "settings.about.dataDirHint": "曲库、音源包、缓存与日志的本地落点",
    "settings.about.dataDirHintPortable":
      "便携模式：曲库、音源包、缓存与日志都在程序旁边，整个文件夹拷到新机器即可继续用",
    "settings.about.portable": "便携",
    // 诊断包（§18 / B8）
    "settings.about.diagnostics": "诊断包",
    "settings.about.diagnosticsHint":
      "排障用：最近日志 + 脱敏配置 + 数据库版本与设备信息，不含曲库与历史明细",
    "settings.about.exporting": "打包中…",
    "settings.about.exportDiagnostics": "导出诊断包",
    "settings.about.saveDiagnosticsTitle": "保存诊断包",
    "settings.about.exported": "已导出诊断包（{files} 个文件，{size} KB）",
    "settings.about.exportFailed": "导出失败：{error}",
    // 官网入口与免责声明
    "settings.about.projectIntro": "项目介绍与开源地址",
    "settings.about.projectIntroHint": "功能介绍与开源地址",
    "settings.about.openSite": "打开官网",
    "settings.about.agreement": "用户协议",
    "settings.about.agreementHint": "建议先读一遍",
    "settings.about.privacy": "隐私政策",
    "settings.about.privacyHint": "数据收集与保留说明",
    "settings.about.feedback": "意见反馈",
    "settings.about.feedbackHint": "Issue 与 PR 入口",
    "settings.about.goFeedback": "前往反馈",
    "settings.about.view": "查看",
    "settings.about.reopenDisclaimer": "重新查看免责声明",
    "settings.about.firstRunDisclaimer": "首次启动时的声明",
    "settings.about.disclaimerUnavailable": "暂时取不到声明内容，请检查网络后重试",
  },
  en: {
    "settings.about.currentVersion": "Current version",
    "settings.about.appEdition": "QuietMusic for PC",
    "settings.about.versionValue": "{name} (build {code})",
    "settings.about.checkUpdate": "Check for updates",
    "settings.about.autoCheck": "Checked automatically at startup",
    "settings.about.checking": "Checking…",
    "settings.about.upToDate": "You're on the latest version",
    "settings.about.updateFound": "New version {version}{size} found — you'll be asked to confirm",
    "settings.about.updateCheckFailed": "Update check failed: {error}",
    "settings.about.dataDir": "Data folder",
    "settings.about.dataDirHint": "Where the library, source packs, cache and logs are stored",
    "settings.about.dataDirHintPortable":
      "Portable mode: library, source packs, cache and logs live next to the app — copy the whole folder to another machine and carry on",
    "settings.about.portable": "Portable",
    "settings.about.diagnostics": "Diagnostics bundle",
    "settings.about.diagnosticsHint":
      "For troubleshooting: recent logs, redacted settings, database version and device info. Library contents and play history are not included",
    "settings.about.exporting": "Packing…",
    "settings.about.exportDiagnostics": "Export bundle",
    "settings.about.saveDiagnosticsTitle": "Save diagnostics bundle",
    "settings.about.exported": "Diagnostics bundle exported ({files} files, {size} KB)",
    "settings.about.exportFailed": "Export failed: {error}",
    "settings.about.projectIntro": "About the project & source code",
    "settings.about.projectIntroHint": "Feature overview and source repository",
    "settings.about.openSite": "Open website",
    "settings.about.agreement": "Terms of Service",
    "settings.about.agreementHint": "Worth reading once",
    "settings.about.privacy": "Privacy Policy",
    "settings.about.privacyHint": "What we collect and how long we keep it",
    "settings.about.feedback": "Feedback",
    "settings.about.feedbackHint": "Issues and pull requests",
    "settings.about.goFeedback": "Send feedback",
    "settings.about.view": "View",
    "settings.about.reopenDisclaimer": "Review disclaimer",
    "settings.about.firstRunDisclaimer": "The notice shown on first launch",
    "settings.about.disclaimerUnavailable":
      "Couldn't load the disclaimer right now. Check your connection and try again",
  },
});
