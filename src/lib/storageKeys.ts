/**
 * 本地设置（`ipc.getSetting/setSetting`）里用到的键名集中在这里。
 *
 * 为什么单独一个模块：键名原本散落在各页面里，且 `AppShell` 为了判断"是否走过首次
 * 引导"静态 import 了 `OnboardingPage` —— 于是整页引导流程（含全部图标与文案）被绑进
 * 主 chunk，页面懒加载也就失效了。键名是纯字符串常量，抽出来两边共用即可解耦。
 */

/** 是否已完成首次启动引导（onboarding） */
export const ONBOARDING_KEY = "onboarded";

/** 应用级最近一次未捕获错误（ErrorBoundary 落盘，便于事后排查闪退/白屏） */
export const LAST_ERROR_KEY = "app.lastError";
