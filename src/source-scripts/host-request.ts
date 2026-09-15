/**
 * PC 宿主注入的 request builtin。
 *
 * 前端不直接发外部网络（CSP 不放开外部域名），经 Rust 内置命令 builtin_request
 * 用 reqwest 执行 —— 与方案 v3 的"请求不修改"约束一致（复用 Rust HTTP 栈）。
 * qt-uniappx 接入时写自己的 host-request（包装 http.ts directRequest），
 * 出入参以 contract.ts 为准。
 */
import { invoke } from "@tauri-apps/api/core";
import type { RequestBuiltin, SourceResponse } from "./contract";

export const hostRequest: RequestBuiltin = async (url, options) => {
  return invoke<SourceResponse>("builtin_request", {
    url,
    options: {
      method: options?.method ?? "GET",
      headers: options?.headers ?? null,
      body: options?.body ?? null,
      timeoutMs: options?.timeoutMs ?? 15000,
    },
  });
};
