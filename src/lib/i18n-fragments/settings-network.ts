import { defineFragment } from "@/lib/i18n-fragment";

/**
 * 设置 → 网络（代理、超时、并发）。
 *
 * 键前缀 `settings.network.`；中文与英文必须一一对齐（少一条 `tsc` 会报错）。
 */
export const messages = defineFragment({
  zh: {
    // 代理模式：跟随系统 / 直连 / 自定义
    "settings.network.proxyMode.system": "跟随系统",
    "settings.network.proxyMode.none": "直连",
    "settings.network.custom": "自定义",
    "settings.network.loadFailed": "读取网络设置失败：{error}",
    "settings.network.customNeedsUrl": "填入代理地址后应用自定义代理",
    "settings.network.timeoutNotNumber": "超时秒数需要是数字",
    "settings.network.proxyMode.title": "代理模式",
    "settings.network.proxyMode.description": "音源、播放、封面、下载与账号请求都走此代理",
    "settings.network.proxyUrl.title": "代理地址",
    "settings.network.proxyUrl.description":
      "支持 http / https / socks5，可带账号密码（回车即保存）",
    "settings.network.timeout.title": "单源超时",
    "settings.network.timeout.description": "单请求默认超时；音源脚本声明优先",
    "settings.network.timeoutSeconds": "{n} 秒",
    "settings.network.secondsUnit": "秒",
    "settings.network.test.title": "测试连接",
    "settings.network.test.description": "按当前填写的代理试连（不保存）",
    "settings.network.testing": "测试中…",
    "settings.network.test": "测试",
    "settings.network.testOk": "连通 · {status}{ms} ms",
    "settings.network.testFailed": "失败 · {error}",
    "settings.network.unknownError": "未知错误",
  },
  en: {
    "settings.network.proxyMode.system": "Follow system",
    "settings.network.proxyMode.none": "Direct",
    "settings.network.custom": "Custom",
    "settings.network.loadFailed": "Failed to load network settings: {error}",
    "settings.network.customNeedsUrl": "Enter a proxy address to apply the custom proxy",
    "settings.network.timeoutNotNumber": "Timeout must be a number of seconds",
    "settings.network.proxyMode.title": "Proxy mode",
    "settings.network.proxyMode.description":
      "Source, playback, cover art, download and account requests all use this proxy",
    "settings.network.proxyUrl.title": "Proxy address",
    "settings.network.proxyUrl.description":
      "Supports http / https / socks5, with optional credentials (press Enter to save)",
    "settings.network.timeout.title": "Per-source timeout",
    "settings.network.timeout.description":
      "Default timeout for each request; a source script's own setting wins",
    "settings.network.timeoutSeconds": "{n}s",
    "settings.network.secondsUnit": "s",
    "settings.network.test.title": "Test connection",
    "settings.network.test.description":
      "Try connecting with the proxy as entered (nothing is saved)",
    "settings.network.testing": "Testing…",
    "settings.network.test": "Test",
    "settings.network.testOk": "Connected · {status}{ms} ms",
    "settings.network.testFailed": "Failed · {error}",
    "settings.network.unknownError": "Unknown error",
  },
});
