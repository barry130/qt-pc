/**
 * 通用 LX 自定义源脚本宿主 —— 把 vendored 的 LX 脚本包成一条取链线路。
 *
 * 原理（与 lx-source-tester harness 同款，已在 Node 沙箱全量验证过；v6 插件
 * 已按本模式在线上稳定运行）：
 * - 提供符合 LX 自定义源协议的 lx mock（EVENT_NAMES/on/send/request/
 *   currentScriptInfo/utils）；
 * - request 回调把宿主 RequestBuiltin 的响应转交给脚本（宿主侧已按契约
 *   "无条件尝试 JSON 解析"，符合脚本对已解析对象的期望）；
 * - 脚本通过 lx.on(EVENT_NAMES.request) 注册 handler，本桥持有它并按
 *   {action:'musicUrl', source, info:{musicInfo, type}} 调用取链；
 * - lx.send(inited) 上报的 sources/qualitys 被记录，供测试探测宣称面。
 *
 * 依赖面（12 个可用脚本逐个 grep 实测收敛，见 sources.ts）：
 * - SCRIPT_MD5 = md5(脚本原文)，currentScriptInfo.rawScript = 脚本原文
 *   （零宽字符完整性自检依赖二者与原文逐字节一致）；
 * - utils.crypto：md5 + aesEncrypt（stellarwave/墨澜 网易 eapi 用
 *   aes-128-ecb，key 'e82ckenh8dichen8'，NIST 向量测试保证正确性）；
 *   rsaEncrypt 恒空串（只有「配置上报」类路径调用）；
 * - utils.buffer：from(utf8) / bufToString(utf8|hex|base64)——stellarwave/
 *   墨澜 的 buf2hex 走 bufToString(buffer, "hex")；
 * - process 用桩（多脚本有 process.exit 反调试，真实 process 会被静默退出）；
 * - window 遮蔽为同一个 globalThis Proxy（洛雪 v2-fix 的环境探测
 *   `typeof window === 'object' ? window : …`，不遮蔽会落到真实 window，
 *   把反调试定时器/console 补丁挂到应用全局上）；
 * - setTimeout/setInterval 包 try/catch：混淆类脚本（洛雪 v2-fix、裤佬）
 *   有定时器反调试回调，长期运行的应用里异常不能外抛。
 *
 * 脚本原文以 ?raw 引入（vite/client 提供 `*?raw` 类型），执行体走
 * vendored/<id>.wrapped.js（scripts/gen-lx-vendor.mjs 生成：脚本本体放进
 * 带同名遮蔽参数的函数，globalThis/process/lx/SCRIPT_MD5/console/window
 * 解析到注入对象，其余落真实全局；不污染真实全局，CSP 安全无 eval）。
 */
import type { MusicInfo, Quality, RequestBuiltin } from "../../contract";
import { md5Hex as kgMd5 } from "../../platforms/kg-md5";
import { aesEncrypt, bufferFrom, bufferToString } from "./crypto";

/** gen-lx-vendor.mjs 生成的包装执行器入参（与 <id>.wrapped.d.ts 对应） */
export interface LxRunDeps {
  globalThis: object;
  process: object;
  lx: object;
  scriptMd5: string;
  console: object;
  window: object;
}

export interface LxScriptSpec {
  /** 脚本原文（?raw 引入；必须与 vendored 的 .js 逐字节一致） */
  rawScript: string;
  /** 生成的静态包装执行器 */
  run: (deps: LxRunDeps) => void;
  /** 覆盖展示名（缺省用脚本 @name 头） */
  name?: string;
}

/** 脚本 init 时 send(inited) 上报的单平台注册信息 */
interface LxSourceInfo {
  actions?: string[];
  qualitys?: string[];
  qualities?: string[];
}

interface LxInitedData {
  status?: boolean;
  sources?: Record<string, LxSourceInfo>;
}

/** LX 自定义源协议的 handler 入参（musicUrl 动作） */
interface LxMusicUrlRequest {
  action: "musicUrl";
  source: string;
  info: {
    musicInfo: Record<string, unknown>;
    type: string;
  };
}

type LxHandler = (info: LxMusicUrlRequest) => Promise<string> | string;

/** lx.request 的 options 形状（LX 协议） */
interface LxRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  form?: Record<string, unknown>;
  timeout?: number;
  [key: string]: unknown;
}

/** 从脚本头解析 @name/@description/@version/@author（与 harness 同款） */
function parseHeader(rawScript: string): {
  name: string;
  description: string;
  version: string;
  author: string;
} {
  const get = (re: RegExp): string => {
    const m = rawScript.match(re);
    return m ? m[1]!.trim() : "";
  };
  return {
    name: get(/@name\s+(.+)/),
    description: get(/@description\s+(.+)/),
    version: get(/@version\s+(.+)/),
    author: get(/@author\s+(.+)/),
  };
}

function cryptoGetRandomValues(arr: Uint8Array): void {
  const c = (globalThis.crypto ?? {}) as Crypto;
  if (typeof c.getRandomValues === "function") {
    c.getRandomValues(arr);
  } else {
    for (let i = 0; i < arr.length; i++) {
      arr[i] = Math.floor(Math.random() * 256);
    }
  }
}

export interface LxHost {
  /** 取播放地址；失败/超时 reject，由方案动作层兜底 */
  getUrl(request: RequestBuiltin, source: string, song: MusicInfo, quality: Quality): Promise<string>;
  /** 懒初始化（探测/测试用；getUrl 也会自动触发） */
  ensureReady(request: RequestBuiltin): Promise<void>;
  /** init 上报的注册平台（wy/tx/kw/kg/mg…） */
  registeredSources(): string[];
  /** 某平台宣称的音质列表（"128k"/"320k"/"flac"/"flac24bit"） */
  claimedQualities(source: string): string[];
}

/** 单飞创建一个 LX 脚本宿主（每个 vendored 脚本一份） */
export function createLxHost(spec: LxScriptSpec): LxHost {
  let readyPromise: Promise<void> | null = null;
  let handler: LxHandler | null = null;
  let initedData: LxInitedData | null = null;

  function init(request: RequestBuiltin): void {
    const header = parseHeader(spec.rawScript);
    const scriptMd5 = kgMd5(spec.rawScript);
    const lx = {
      EVENT_NAMES: { request: "request", inited: "inited", updateAlert: "updateAlert", showConfigView: "showConfigView" },
      version: "2.0.0",
      apiVersion: "1.3.0",
      env: "desktop",
      on: (name: string, h: LxHandler) => {
        if (name === "request") handler = h;
      },
      send: (name: string, data: LxInitedData) => {
        if (name === "inited") initedData = data;
      },
      request: (url: string, options: LxRequestOptions | null, cb: (err: unknown, res?: unknown) => void) => {
        void (async () => {
          try {
            const opts: LxRequestOptions = options ?? {};
            const method = typeof opts.method === "string" ? opts.method.toUpperCase() : "GET";
            const body =
              typeof opts.body === "string"
                ? opts.body
                : opts.body !== undefined
                  ? JSON.stringify(opts.body)
                  : opts.form
                    ? new URLSearchParams(Object.entries(opts.form).map(([k, v]) => [k, String(v)])).toString()
                    : undefined;
            const res = await request(url, {
              method: method === "POST" ? "POST" : "GET",
              headers: opts.headers,
              body,
              timeoutMs: typeof opts.timeout === "number" ? opts.timeout : 15000,
            });
            cb(null, { statusCode: res.statusCode, headers: res.headers, body: res.body });
          } catch (err) {
            cb(err);
          }
        })();
      },
      currentScriptInfo: {
        name: spec.name ?? header.name,
        description: header.description || "vendored by QuietMusic",
        version: header.version,
        author: header.author,
        rawScript: spec.rawScript,
      },
      utils: {
        serialize: (v: unknown) => {
          try { return JSON.stringify(v); } catch { return ""; }
        },
        deserialize: (s: string) => {
          try { return JSON.parse(s); } catch { return null; }
        },
        log: () => {},
        toast: () => {},
        exit: () => {},
        crypto: {
          md5: (s: unknown) => kgMd5(String(s)),
          randomBytes: (n: number) => {
            const arr = new Uint8Array(n);
            cryptoGetRandomValues(arr);
            return arr;
          },
          randomInt: (a: number, b: number) => a + Math.floor(Math.random() * (b - a)),
          aesEncrypt: (data: string | Uint8Array, mode: string, key: string | Uint8Array, iv?: string | Uint8Array) =>
            aesEncrypt(data, mode, key, iv),
          rsaEncrypt: () => "",
        },
        buffer: {
          from: (s: string) => bufferFrom(s),
          bufToString: (b: Uint8Array, encoding?: string) => bufferToString(b, encoding),
        },
      },
    };

    // 遮蔽的 globalThis：未知标识符透传真实全局，已知标识符走覆盖表。
    // window 也用同一个 Proxy（洛雪 v2-fix 的环境探测会选中它）。
    const overrides: Record<string, unknown> = {
      lx,
      SCRIPT_MD5: scriptMd5,
      // 定时器回调包 try/catch：反调试回调（无限递归/debugger）不外抛
      setTimeout: (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
        setTimeout(() => {
          try { fn(...args); } catch { /* 反调试/脚本异常不外抛 */ }
        }, ms),
      setInterval: (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        const id = setInterval(() => {
          try { fn(...args); } catch { /* 同上 */ }
        }, ms);
        return id;
      },
    };
    const realGlobal: Record<string | symbol, unknown> = globalThis as unknown as Record<string | symbol, unknown>;
    const globalThisMock = new Proxy({} as Record<string, unknown>, {
      get(_t, key: string | symbol) {
        if (typeof key === "symbol") return realGlobal[key];
        if (key in overrides) return overrides[key];
        return realGlobal[key];
      },
      set(_t, key: string | symbol, value: unknown) {
        if (typeof key === "string") overrides[key] = value;
        return true;
      },
      has() {
        return true;
      },
    });

    // 反调试：真实 process 下部分脚本会静默 exit(1)——用桩阻断
    const processStub = {
      env: {},
      platform: "win32",
      version: "2.0.0",
      nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => {
        setTimeout(() => fn(...args), 0);
      },
      exit: () => {
        throw new Error("process.exit blocked by lx-host bridge");
      },
    };
    const silentConsole = {
      log: () => {},
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      group: () => {},
      groupEnd: () => {},
      groupCollapsed: () => {},
      trace: () => {},
      table: () => {},
      dir: () => {},
      time: () => {},
      timeEnd: () => {},
      assert: () => {},
    };

    spec.run({
      globalThis: globalThisMock,
      process: processStub,
      lx,
      scriptMd5,
      console: silentConsole,
      window: globalThisMock,
    });
    void request; // init 阶段不发请求；参数仅为对齐 ensureReady 签名
  }

  function ensureReady(request: RequestBuiltin): Promise<void> {
    if (readyPromise === null) {
      readyPromise = (async () => {
        init(request);
        // 等待脚本注册 handler（同步注册为主，混淆脚本可能有异步初始化）
        const deadline = Date.now() + 8000;
        while (handler === null) {
          if (Date.now() > deadline) {
            throw new Error(`lx 脚本「${spec.name ?? "?"}」未注册 request handler`);
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      })();
    }
    return readyPromise;
  }

  return {
    async getUrl(request, source, song, quality) {
      await ensureReady(request);
      const h = handler;
      if (!h) throw new Error("lx handler 未注册");
      return Promise.resolve(
        h({
          action: "musicUrl",
          source,
          info: {
            musicInfo: {
              // 各平台脚本解构的 id 字段不同：tx/wy 用 songmid、kg 用 hash、
              // kw 用 rid/songmid、mg 用 copyrightId——本项目各平台 id 恰好同值
              songmid: song.id,
              id: song.id,
              hash: song.id,
              rid: song.id,
              copyrightId: song.id,
              name: song.name,
              singer: song.singer,
              albumName: song.album,
            },
            // 契约音质 "128"/"320"/"flac" → LX 口径 "128k"/"320k"/"flac"
            type: quality === "flac" ? "flac" : quality + "k",
          },
        }),
      );
    },
    ensureReady,
    registeredSources: () => Object.keys(initedData?.sources ?? {}),
    claimedQualities: (source: string) => {
      const s = initedData?.sources?.[source];
      const q = s?.qualitys ?? s?.qualities ?? [];
      return Array.isArray(q) ? q : [];
    },
  };
}
