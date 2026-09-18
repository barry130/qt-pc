/**
 * 酷我（kw）鉴权模块 —— 蓝本 qt-uniappx services/http.ts 移植。
 *
 * 逐段对照：
 * - normalizeCookie :279 / kwLeadingDigits :284 / kwParseInt :297 / kwToNumber :303
 * - kwNumberToString :307 / createKuwoSecret（XOR 生成 Secret 头）:328
 * - findHmIuvtCookie :401 / applyKuwoCookie :409
 * - initKuwoCookie（kuwo.cn 首页 Set-Cookie 提取 kw_token/Hm_* 等）:428
 * - kwRequest（Referer/UA/Cookie/Secret 头 + 鉴权失败清缓存重初始化重试一次）:704
 * - directRequest 的 kw 分支 :651（先等 kuwoReady 再 kwRequest）折入 kuwoRequest
 *
 * 与蓝本的差异（环境所致，语义不变）：
 * - 蓝本 Cookie/Secret 持久化在 uni storage（KUWO_STORAGE_KEY "qt-kuwo-cookie"）；
 *   脚本包契约只注入 request，无存储 builtin，故状态仅存于模块级内存
 *   （进程存活期内复用，与蓝本 loadKuwoFromStorage 命中后的行为一致）。
 * - 蓝本 App.uvue:40 启动时调用 initKuwoCookie 预热；此处改为惰性：
 *   ensureKuwoReady 首次调用初始化，之后直接返回 kuwoReady 单飞 Promise
 *   （并发防抖语义与蓝本一致，见 kuwoReady）。
 * - Set-Cookie 读取：蓝本优先 response.cookies（uni-app 解析数组）、回退
 *   response.header["set-cookie"]；契约只透传小写 headers，故直接读
 *   headers["set-cookie"]，逗号拆分逻辑照搬蓝本回退分支。
 */
import type { RequestBuiltin } from "../contract";

let kuwoCookie = "";
let kuwoSecret = "";

/** 蓝本 normalizeCookie :279（取首段 name=value，丢弃属性段） */
function normalizeCookie(cookie: string): string {
  const separator = cookie.indexOf(";");
  return separator >= 0 ? cookie.substring(0, separator) : cookie;
}

/** 蓝本 kwLeadingDigits :284（取前导整数部分，容忍正负号） */
function kwLeadingDigits(s: string): string {
  let i = 0;
  const len = s.length;
  if (i < len && (s.charAt(i) == "+" || s.charAt(i) == "-")) i++;
  const start = i;
  while (i < len) {
    const c: number = s.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  return i > start ? s.substring(start, i) : "";
}

/** 蓝本 kwParseInt :297 */
function kwParseInt(s: string): number {
  const digits = kwLeadingDigits(s);
  if (digits.length == 0) return 0;
  return parseFloat(digits) ?? 0;
}

/** 蓝本 kwToNumber :303 */
function kwToNumber(s: string): number {
  return parseFloat(s) ?? 0;
}

/**
 * 蓝本 kwNumberToString :307（JS 大数 toString 的科学计数法转定点拼接）。
 * JS 引擎 toString 输出小写 e+，indexOf("E") 不命中直接原样返回（蓝本同逻辑，
 * 大写 E 分支服务 UTS/Kotlin 运行时，保留以维持逐行一致）。
 */
function kwNumberToString(x: number): string {
  if (x >= 0 && x == Math.floor(x) && x < 1e21) {
    return x.toString();
  }
  // JS prints >= 1e21 as scientific like "1.7118116959910099e+102"
  let s = x.toString();
  const eIdx = s.indexOf("E");
  if (eIdx < 0) return s;
  let mantissa = s.substring(0, eIdx);
  const exp: number = parseInt(s.substring(eIdx + 1), 10) ?? 0;
  if (
    mantissa.length >= 2 &&
    mantissa.charAt(mantissa.length - 2) == "." &&
    mantissa.charAt(mantissa.length - 1) == "0"
  ) {
    mantissa = mantissa.substring(0, mantissa.length - 2);
  }
  if (exp >= 0) return mantissa + "e+" + Math.trunc(exp).toString();
  return mantissa + "e-" + Math.trunc(-exp).toString();
}

/** 蓝本 createKuwoSecret :328（对首个 cookie 的 value 逐字符 XOR，尾接 8 位十六进制种子） */
function createKuwoSecret(cookie: string): string {
  const firstCookie = cookie.split(";")[0];
  const separator = firstCookie.indexOf("=");
  if (separator <= 0) return "";

  const key = firstCookie.substring(0, separator);
  const value = firstCookie.substring(separator + 1);
  if (value.length == 0 || key.length == 0) return "";

  let codeText = "";
  for (let index = 0; index < key.length; index++) {
    codeText += key.charCodeAt(index).toString();
  }
  const position: number = Math.floor(codeText.length / 5.0) ?? 0;
  const factor: number = parseInt(
    codeText.charAt(position) +
      codeText.charAt(position * 2) +
      codeText.charAt(position * 3) +
      codeText.charAt(position * 4) +
      codeText.charAt(position * 5),
    10
  ) ?? 0;
  if (factor < 2) return "";

  const halfLength: number = Math.ceil(key.length / 2.0) ?? 0;
  const max: number = (Math.pow(2, 31) ?? 0) - 1;
  let seed: number = (Math.round(1000000000 * Math.random()) ?? 0) % 100000000;
  let seedText = codeText + Math.trunc(seed).toString();
  let loopCount = 0;
  while (seedText.length > 10) {
    const first: number = kwParseInt(seedText.substring(0, 10));
    const remain: number = kwParseInt(seedText.substring(10));
    seedText = kwNumberToString(first + remain);
    loopCount++;
    if (loopCount > 50) break;
  }

  let state: number = (factor * kwToNumber(seedText) + halfLength) % max;
  let secret = "";
  for (let index = 0; index < value.length; index++) {
    const valueCode: number = value.charCodeAt(index);
    const encrypted = valueCode ^ Math.floor((state / max) * 255);
    const hex = encrypted.toString(16);
    secret += hex.length < 2 ? "0" + hex : hex;
    state = (factor * state + halfLength) % max;
  }

  let suffix = Math.trunc(seed).toString(16);
  while (suffix.length < 8) suffix = "0" + suffix;
  return secret + suffix;
}

/** 蓝本 findHmIuvtCookie :401（Secret 只认 Hm_Iuvt* cookie） */
function findHmIuvtCookie(cookies: string[]): string {
  for (let index = 0; index < cookies.length; index++) {
    const c = cookies[index];
    if (c.indexOf("Hm_Iuvt") >= 0) return normalizeCookie(c);
  }
  return "";
}

/**
 * 蓝本 applyKuwoCookie :409：Hm_Iuvt cookie 生成 Secret，全部 cookie 归一化后
 * 以 "; " 拼成 Cookie 头。蓝本随后 saveKuwoToStorage()，此处无存储 builtin，
 * 仅保留在模块内存（见文件头注释）。
 */
function applyKuwoCookie(cookies: string[]): void {
  const hm = findHmIuvtCookie(cookies);
  if (hm.length > 0) {
    kuwoSecret = createKuwoSecret(hm);
  }
  let combined = "";
  for (let index = 0; index < cookies.length; index++) {
    const c = normalizeCookie(cookies[index]);
    if (c.length == 0) continue;
    if (combined.length > 0) combined += "; ";
    combined += c;
  }
  kuwoCookie = combined;
}

/**
 * 蓝本 kuwoReady :426 单飞 Promise：并发初始化防抖——首个调用创建 Promise，
 * 后续调用直接复用同一个；鉴权失败重试时置 null 重新拉取。
 */
let kuwoReady: Promise<void> | null = null;

/**
 * 蓝本 initKuwoCookie :428：请求 kuwo.cn 首页，从 Set-Cookie 提取 kw_token 等。
 * 网络/解析失败也 resolve（不 reject）——后续请求以无 Cookie 状态发出，
 * 由 kwRequest 的鉴权失败重试语义兜底。
 */
function initKuwoCookie(request: RequestBuiltin): Promise<void> {
  kuwoCookie = "";
  kuwoSecret = "";

  const promise = new Promise<void>((resolve) => {
    request("https://www.kuwo.cn/", {
      method: "GET",
      headers: {
        Referer: "https://www.kuwo.cn/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:82.0) Gecko/20100101 Firefox/82.0",
      },
    })
      .then((response) => {
        try {
          // 契约 header 名统一小写；蓝本回退分支：逗号拆分 Set-Cookie 再逐段取 name=value
          const setCookie = response.headers["set-cookie"];
          if (setCookie != null && setCookie.length > 0) {
            const parts: string[] = setCookie.split(",");
            const parsed: string[] = [];
            for (let index = 0; index < parts.length; index++) {
              const trimmed = parts[index].split(";")[0].trim();
              if (trimmed.length > 0) parsed.push(trimmed);
            }
            if (parsed.length > 0) applyKuwoCookie(parsed);
          }
        } catch {
          // 蓝本同语义：applyKuwoCookie 异常不阻塞 resolve，按无 Cookie 继续
        }
        resolve();
      })
      .catch(() => {
        resolve();
      });
  });
  kuwoReady = promise;
  return promise;
}

/**
 * 确保酷我 Cookie/Secret 就绪：首次调用初始化，之后直接返回已有 Promise
 * （蓝本 App.uvue:40 启动预热的惰性等价物）。
 */
export function ensureKuwoReady(request: RequestBuiltin): Promise<void> {
  if (kuwoReady === null) {
    return initKuwoCookie(request);
  }
  return kuwoReady;
}

/**
 * 蓝本 kwRequest :704 的等价（含 directRequest kw 分支 :651 的 kuwoReady 等待）。
 * 带 Referer/UA/Cache-Control/Cookie/Secret 头请求；响应 code != 200 或
 * success:false 视为鉴权失败——清空缓存、重新初始化 Cookie 后重试一次；
 * 重试后仍失败则原样返回响应体（由 assertKwOk 一类调用方判定抛错）。
 * 非 2xx 或响应体不可解析为 JSON 对象时 throw。
 * @param retried 本次是否已是重试
 */
async function kwRequest(
  request: RequestBuiltin,
  url: string,
  method: "GET" | "POST",
  body: string | undefined,
  retried: number
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    Referer: "https://www.kuwo.cn/",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:82.0) Gecko/20100101 Firefox/82.0",
    // 强制绕过缓存，防止推荐接口返回旧数据
    "Cache-Control": "no-cache",
  };
  if (method == "POST" && body != null) {
    // 蓝本经 uni.request 传对象体，wire 上自动带 application/json，此处对齐
    headers["Content-Type"] = "application/json";
  }
  if (kuwoCookie.length > 0) headers["Cookie"] = kuwoCookie;
  if (kuwoSecret.length > 0) headers["Secret"] = kuwoSecret;

  const response = await request(url, {
    method,
    headers,
    body: method == "GET" ? undefined : body,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error("HTTP " + response.statusCode);
  }

  // 蓝本 kwRequest 的响应体解析：字符串须以 "{" 开头再 parse，对象直接用
  const responseData = response.body;
  let parsed: Record<string, unknown>;
  if (typeof responseData == "string") {
    const text = responseData;
    if (!text.startsWith("{")) {
      throw new Error("平台接口返回非 JSON 数据");
    }
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error("平台接口数据格式异常");
    }
  } else if (
    responseData !== null &&
    typeof responseData == "object" &&
    !Array.isArray(responseData)
  ) {
    parsed = responseData as Record<string, unknown>;
  } else {
    // 蓝本对非字符串响应体直接 as UTSJSONObject 使用；空体/数组等按非 JSON 处理
    throw new Error("平台接口返回非 JSON 数据");
  }

  // 鉴权失败（如 "The request is illegal!"）：清缓存、重取 Cookie、重试一次
  const code = parsed["code"];
  const success = parsed["success"];
  const failed =
    (code != null && String(code) != "200") ||
    (success != null && !success);
  if (failed && retried == 0) {
    kuwoCookie = "";
    kuwoSecret = "";
    kuwoReady = null;
    // 蓝本：先等新 Cookie 就绪（失败也继续），再发起重试请求
    await initKuwoCookie(request).catch(() => {});
    return kwRequest(request, url, method, body, 1);
  }
  return parsed;
}

/**
 * 酷我鉴权请求入口（蓝本 directRequest(url, data, method, "kw") 的等价）：
 * 先保证 Cookie/Secret 就绪，再走 kwRequest；GET 的 query 由调用方拼在 url 上。
 */
export function kuwoRequest(
  request: RequestBuiltin,
  url: string,
  method: "GET" | "POST",
  body?: string
): Promise<Record<string, unknown>> {
  return ensureKuwoReady(request).then(() =>
    kwRequest(request, url, method, body, 0),
  );
}
