import { defineFragment } from "@/lib/i18n-fragment";

/**
 * 设置 → 听歌上报（Last.fm / ListenBrainz）。
 *
 * 键前缀 `settings.scrobble.`；中文与英文必须一一对齐（少一条 `tsc` 会报错）。
 *
 * 服务名（Last.fm / ListenBrainz）与 API key、Shared secret、User token 这类术语不译，
 * 通过 `{service}` 插值复用；`{who}` / `{user}` 是括号里的用户名片段。
 */
export const messages = defineFragment({
  zh: {
    // 连接状态片段
    "settings.scrobble.statusDisconnected": "未连接",
    "settings.scrobble.statusReporting": "已连接{who} · 上报中",
    "settings.scrobble.statusIdle": "已连接{who} · 未开启上报",
    "settings.scrobble.userSuffix": "（{user}）",
    "settings.scrobble.connectedAs": "已连接{who}",
    // 目标选择
    "settings.scrobble.target": "上报到",
    "settings.scrobble.targetHint": "选一家配置即可；两家都开着时会同时上报",
    "settings.scrobble.targetAria": "上报目标",
    "settings.scrobble.serviceLabel": "{service}：",
    "settings.scrobble.otherReporting": "{service} 也在上报",
    "settings.scrobble.otherReportingHint": "两家同时开着会各报一份；想只报 {keep} 可以关掉 {other}",
    "settings.scrobble.onlyReport": "只上报 {service}",
    // ListenBrainz
    "settings.scrobble.userToken": "User token",
    "settings.scrobble.userTokenHint": "{service} 设置页里可以复制",
    "settings.scrobble.userTokenPlaceholder": "粘贴 user token",
    "settings.scrobble.userTokenAria": "ListenBrainz user token",
    "settings.scrobble.connect": "连接",
    "settings.scrobble.connectedTo": "已连接 {service}：{user}",
    "settings.scrobble.connected": "已连接 {service}",
    "settings.scrobble.connectionStatus": "连接状态",
    "settings.scrobble.disconnect": "断开",
    "settings.scrobble.reportTo": "上报到 {service}",
    "settings.scrobble.reportToHint": "关闭后停止上报，连接与队列保留",
    // Last.fm
    "settings.scrobble.lastfmIntro": "需要你自己的 {service} 应用凭据；secret 只存本机数据库，不上传。",
    "settings.scrobble.apiKey": "API key",
    "settings.scrobble.apiKeyHint": "{service} 应用页里的 API key",
    "settings.scrobble.apiKeyPlaceholder": "粘贴 API key",
    "settings.scrobble.apiKeyAria": "Last.fm API key",
    "settings.scrobble.sharedSecret": "Shared secret",
    "settings.scrobble.sharedSecretHint": "同一应用页里的 Shared secret",
    "settings.scrobble.sharedSecretPlaceholder": "粘贴 Shared secret",
    "settings.scrobble.sharedSecretAria": "Last.fm Shared secret",
    "settings.scrobble.saveCredentials": "保存凭据",
    "settings.scrobble.saveCredentialsHint": "保存后即可发起授权",
    "settings.scrobble.credentialsSaved": "凭据已保存，接着点「连接 {service}」去浏览器授权",
    "settings.scrobble.authOpened": "已打开浏览器：点「允许」后回到这里点「我已完成授权」",
    "settings.scrobble.awaitingAuth": "已发起授权，等你在浏览器点「允许」",
    "settings.scrobble.notConnectedYet": "尚未连接",
    "settings.scrobble.reopenAuth": "重新打开授权页",
    "settings.scrobble.connectService": "连接 {service}",
    "settings.scrobble.authDone": "我已完成授权",
    // 上报队列
    "settings.scrobble.queue": "上报队列",
    "settings.scrobble.queueStats": "待发 {pending} · 已发 {sent} · 放弃 {dead}",
    "settings.scrobble.retryNow": "立即重试",
    "settings.scrobble.lastError": "最近一次失败：{error}",
    "settings.scrobble.recent": "最近上报",
    "settings.scrobble.retried": "已重试：成功 {sent}、待重试 {retrying}、放弃 {dead}",
    "settings.scrobble.errorSuffix": "（{error}）",
  },
  en: {
    "settings.scrobble.statusDisconnected": "Not connected",
    "settings.scrobble.statusReporting": "Connected{who} · scrobbling",
    "settings.scrobble.statusIdle": "Connected{who} · scrobbling off",
    "settings.scrobble.userSuffix": " ({user})",
    "settings.scrobble.connectedAs": "Connected{who}",
    "settings.scrobble.target": "Scrobble to",
    "settings.scrobble.targetHint": "Set up just one — if both are on, both get scrobbled",
    "settings.scrobble.targetAria": "Scrobbling target",
    // 末尾空格是有意的：中文冒号自带间距，英文冒号后面要补一个
    "settings.scrobble.serviceLabel": "{service}: ",
    "settings.scrobble.otherReporting": "{service} is scrobbling too",
    "settings.scrobble.otherReportingHint":
      "Both services are on, so each gets its own copy. To report only to {keep}, turn off {other}",
    "settings.scrobble.onlyReport": "Only scrobble to {service}",
    "settings.scrobble.userToken": "User token",
    "settings.scrobble.userTokenHint": "Copy it from your {service} settings page",
    "settings.scrobble.userTokenPlaceholder": "Paste your user token",
    "settings.scrobble.userTokenAria": "ListenBrainz user token",
    "settings.scrobble.connect": "Connect",
    "settings.scrobble.connectedTo": "Connected to {service}: {user}",
    "settings.scrobble.connected": "Connected to {service}",
    "settings.scrobble.connectionStatus": "Connection status",
    "settings.scrobble.disconnect": "Disconnect",
    "settings.scrobble.reportTo": "Scrobble to {service}",
    "settings.scrobble.reportToHint": "Turning this off stops scrobbling; the connection and queue are kept",
    "settings.scrobble.lastfmIntro":
      "Requires your own {service} API credentials. The secret is stored only in the local database and never uploaded.",
    "settings.scrobble.apiKey": "API key",
    "settings.scrobble.apiKeyHint": "The API key from your {service} API account page",
    "settings.scrobble.apiKeyPlaceholder": "Paste your API key",
    "settings.scrobble.apiKeyAria": "Last.fm API key",
    "settings.scrobble.sharedSecret": "Shared secret",
    "settings.scrobble.sharedSecretHint": "The shared secret from the same API account page",
    "settings.scrobble.sharedSecretPlaceholder": "Paste your shared secret",
    "settings.scrobble.sharedSecretAria": "Last.fm Shared secret",
    "settings.scrobble.saveCredentials": "Save credentials",
    "settings.scrobble.saveCredentialsHint": "Save these, then start authorization",
    "settings.scrobble.credentialsSaved":
      "Credentials saved — click “Connect {service}” to authorize in your browser",
    "settings.scrobble.authOpened":
      "Browser opened: click “Allow”, then come back and click “I've authorized”",
    "settings.scrobble.awaitingAuth":
      "Authorization started — waiting for you to click “Allow” in the browser",
    "settings.scrobble.notConnectedYet": "Not connected yet",
    "settings.scrobble.reopenAuth": "Reopen authorization page",
    "settings.scrobble.connectService": "Connect {service}",
    "settings.scrobble.authDone": "I've authorized",
    "settings.scrobble.queue": "Scrobble queue",
    "settings.scrobble.queueStats": "{pending} pending · {sent} sent · {dead} dropped",
    "settings.scrobble.retryNow": "Retry now",
    "settings.scrobble.lastError": "Last failure: {error}",
    "settings.scrobble.recent": "Recent scrobbles",
    "settings.scrobble.retried": "Retried: {sent} sent, {retrying} still queued, {dead} dropped",
    "settings.scrobble.errorSuffix": " ({error})",
  },
});
