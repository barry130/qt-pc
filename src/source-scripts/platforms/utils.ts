/**
 * 平台模块共享工具（蓝本 http.ts / music-api.ts 公共段的移植）。
 * 所有平台模块与动作层共用；禁止引入宿主实现。
 */

import type { RequestBuiltin, Source } from "../contract";

/** 蓝本 makeHeaders（http.ts:527）各平台默认请求头 */
export function platformHeaders(source: Source): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (source === "qq") headers["Referer"] = "https://y.qq.com/";
  else if (source === "kg") headers["Referer"] = "https://www.kugou.com/";
  else if (source === "kw") headers["Referer"] = "https://www.kuwo.cn/";
  else headers["Referer"] = "https://music.163.com/";
  return headers;
}

/** GET 参数拼 query string（蓝本 buildQueryString 同职责） */
export function buildQuery(params: Record<string, string>): string {
  const parts: string[] = [];
  for (const key of Object.keys(params)) {
    parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(params[key]));
  }
  return parts.length > 0 ? "?" + parts.join("&") : "";
}

/** 响应非 2xx 时抛错（蓝本 directRequest 的状态码检查语义） */
export async function requestJson(
  request: RequestBuiltin,
  url: string,
  options?: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string; timeoutMs?: number },
): Promise<Record<string, unknown>> {
  const res = await request(url, options);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error("HTTP " + res.statusCode);
  }
  const body = res.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("平台接口返回非 JSON 对象");
  }
  return body as Record<string, unknown>;
}

/** JSON 读取工具（替代蓝本 UTSJSONObject.get 的判空语义） */
export function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string {
  return value !== null && value !== undefined ? String(value) : "";
}

export function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value) || 0;
}

/** 简单 TTL 缓存（蓝本 urlCache/lyricCache/coverCache 同职责；进程内） */
export class TtlCache {
  private readonly inner = new Map<string, { value: string; at: number }>();
  constructor(private readonly ttlMs: number) {}
  get(key: string): string {
    const entry = this.inner.get(key);
    if (entry === undefined) return "";
    if (Date.now() - entry.at >= this.ttlMs) {
      this.inner.delete(key);
      return "";
    }
    return entry.value;
  }
  set(key: string, value: string): void {
    if (value.length === 0) return;
    this.inner.set(key, { value, at: Date.now() });
  }
}

/** 蓝本 normalizeKgPic（music-api.ts:390）：{size}→300、http→https */
export function normalizeKgPic(url: string): string {
  if (url.length === 0) return "";
  let out = url.split("{size}").join("300");
  out = out.split("http://").join("https://");
  return out;
}
