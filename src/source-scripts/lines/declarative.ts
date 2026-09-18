/**
 * 声明式 http 线路执行器（chain.json kind:"http"）。
 *
 * 把「请求形态 + 音质映射 + 响应取值」写成 JSON 模板，改第三方接口只改
 * chain.json，不用重下 bundle（音源包热更新开发方案 §2.1）。替代收敛前的
 * TS 直写线路 hw260809.ts（a.aa.cab）与 yuningxi-tx.ts（tang.api）。
 *
 * 模板变量：
 * - {name} / {singer} / {album} / {id} —— 歌曲字段（url 内嵌变量做 URL 编码，
 *   query 值由 buildQuery 统一编码）；
 * - {quality} —— 经 qualityMap 映射后的上游档位（如 128→"0"），无映射用原值；
 * - {quality:raw} —— 契约音质原值（"128"/"320"/"flac"）；
 * - {ua.browser} —— 标准浏览器 UA（上游对 UA 敏感时用）。
 *
 * 语义对齐被替代的直写线路：require 不满足 / pick 取不到 / 模板含未知变量 /
 * 请求抛错一律返回空串（= 线路未命中，交给换源下一级），不抛错不重试。
 * 响应体不校验状态码与 content-type：宿主已按契约「无条件尝试 JSON 解析」，
 * 非对象体在 require/pick 处自然失败。
 */
import type { ChainPreRequest, HttpChainLine } from "../chain-config";
import type { MusicInfo, Quality, RequestBuiltin, SourceResponse } from "../contract";
import { asObject, asString, buildQuery } from "../platforms/utils";

/** 标准浏览器 UA（a.aa.cab 实测对 UA 敏感，沿用 World 260809 脚本同款） */
export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export interface TemplateVars {
  song: MusicInfo;
  /** qualityMap 映射后的档位（无映射 = 原值） */
  quality: string;
  /** 契约音质原值 */
  qualityRaw: Quality;
}

function varValue(key: string, vars: TemplateVars): string {
  if (key === "name") return vars.song.name;
  if (key === "singer") return vars.song.singer;
  if (key === "album") return vars.song.album;
  if (key === "id") return vars.song.id;
  if (key === "quality") return vars.quality;
  if (key === "quality:raw") return vars.qualityRaw;
  if (key === "ua.browser") return BROWSER_UA;
  throw new Error(`未知模板变量: {${key}}`);
}

/**
 * 解析模板串：{key} 替换为变量值；encode=true 时值做 URL 编码（仅用于 url
 * 内嵌变量；query 值由 buildQuery 统一编码，这里保持原值）。headers 用
 * encode=false。未知变量抛错（caller 按线路失败处理）。
 */
function resolveTemplate(template: string, vars: TemplateVars, encode: boolean): string {
  return template.replace(/\{([^{}]+)\}/g, (_match, key: string) => {
    const value = varValue(key.trim(), vars);
    return encode ? encodeURIComponent(value) : value;
  });
}

function resolveRecord(
  record: Record<string, string> | undefined,
  vars: TemplateVars,
  encode: boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (record === undefined) return out;
  for (const [key, value] of Object.entries(record)) {
    out[key] = resolveTemplate(value, vars, encode);
  }
  return out;
}

/** 点号路径取值（"data.music"）；中间层不是对象或取不到返回 undefined */
function pickPath(body: unknown, path: string): unknown {
  let current: unknown = body;
  for (const segment of path.split(".")) {
    current = asObject(current)[segment];
    if (current === undefined || current === null) return undefined;
  }
  return current;
}

function checkRequire(line: HttpChainLine, body: unknown): boolean {
  if (line.require === undefined) return true;
  for (const [path, expected] of Object.entries(line.require)) {
    const value = pickPath(body, path);
    if (expected === "nonEmpty") {
      if (asString(value).length === 0) return false;
    } else if (Number(value) !== expected) {
      return false;
    }
  }
  return true;
}

function pickUrl(line: HttpChainLine, body: unknown, quality: Quality): string {
  const path = typeof line.pick === "string" ? line.pick : line.pick[quality];
  if (path === undefined) return "";
  return asString(pickPath(body, path));
}

/**
 * 前置请求（统计打卡等）：每步独立 try/catch；optional（缺省 true）失败静默
 * 继续，显式 false = 失败即整条线路失败。
 */
async function runPre(
  request: RequestBuiltin,
  steps: ChainPreRequest[],
  vars: TemplateVars,
): Promise<boolean> {
  for (const step of steps) {
    try {
      const url = resolveTemplate(step.url, vars, true);
      const query = resolveRecord(step.query, vars, false);
      const headers = resolveRecord(step.headers, vars, false);
      await request(url + buildQuery(query), {
        method: "GET",
        headers,
        timeoutMs: step.timeoutMs ?? 8000,
      });
    } catch {
      // optional 缺省 = true：失败静默继续；显式 false 才判整条线路失败
      if (step.optional === false) return false;
    }
  }
  return true;
}

/**
 * 执行一条声明式 http 线路：返回可播 URL（交由上层做 Range 预检），
 * 未命中 / 失败一律空串。
 */
export async function runHttpLine(
  line: HttpChainLine,
  request: RequestBuiltin,
  song: MusicInfo,
  quality: Quality,
): Promise<string> {
  const vars: TemplateVars = {
    song,
    quality: line.qualityMap?.[quality] ?? quality,
    qualityRaw: quality,
  };
  try {
    if (line.pre !== undefined && !(await runPre(request, line.pre, vars))) return "";

    const url = resolveTemplate(line.request.url, vars, true);
    const query = resolveRecord(line.request.query, vars, false);
    const headers = resolveRecord(line.request.headers, vars, false);
    const res: SourceResponse = await request(url + buildQuery(query), {
      method: "GET",
      headers,
      timeoutMs: line.request.timeoutMs,
    });
    const body = asObject(res.body);
    if (!checkRequire(line, body)) return "";
    return pickUrl(line, body, quality);
  } catch {
    return "";
  }
}
