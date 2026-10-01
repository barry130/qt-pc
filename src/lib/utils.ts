import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * 报错文案统一剥掉 http(s) 链接：网络层错误串会带上请求地址
 * （含自家后端域名），面向用户展示时不泄露。
 */
export function stripErrorUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'()<>,[\]{}]+/g, "…");
}

/**
 * 从 任意 error / Tauri invoke 拒绝值 中取出人话。
 * Tauri 命令错误经 serde 序列化成 {kind, message} 等对象，直接 String()
 * 会得到 "[object Object]"；这里按 Error → string → .message 逐层兜底。
 */
export function errMsg(err: unknown): string {
  if (err instanceof Error) return stripErrorUrls(err.message);
  if (typeof err === "string") return stripErrorUrls(err);
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return stripErrorUrls(message);
    const msg = (err as { msg?: unknown }).msg;
    if (typeof msg === "string" && msg.length > 0) return stripErrorUrls(msg);
    try {
      const j = JSON.stringify(err);
      if (j && j !== "{}" && j !== "[]") return stripErrorUrls(j.slice(0, 300));
    } catch {
      // 序列化失败就走 String()
    }
    return stripErrorUrls(String(err));
  }
  return stripErrorUrls(String(err));
}

