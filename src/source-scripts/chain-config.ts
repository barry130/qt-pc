/**
 * chain.json 的类型、校验（parseChainConfig）与默认值（defaultChainConfig）。
 *
 * chain.json 是音源包热更新的「编排层」（几 KB）：线路顺序 / 音质档 / 启停 /
 * parallel / 行级 platforms / 预算 / 声明式线路模板（音源包热更新开发方案 §2.1）。
 * 加载顺序见 chain-store.ts：本地 overlay → 校验失败或不存在 → 回退本文件的
 * defaultChainConfig()（纯数据，与内置 SCRIPT_LINES 时代的链路逐行等价）。
 *
 * 实现约束：
 * - defaultChainConfig 是纯数据（scriptId / impl 都是字符串引用），不 import
 *   play-url.ts —— 执行器在 actions/play-url.ts，避免循环依赖；
 * - parseChainConfig 是热更新三层把关的第①层：坏 JSON / 坏字段在这里抛错，
 *   由 chain-store 丢弃并回退默认，绝不让坏配置进入执行器。
 */
import type { Quality, Source } from "./contract";
import { asArray, asNumber, asObject, asString } from "./platforms/utils";
import { CHAIN_BUDGET_MS, CHAIN_LINE_MS } from "./budget";

/** 平台常量（沿用 astral 口径） */
export const PLATFORMS = { ANDROID: 1101, IOS: 1102, WINDOWS: 1103 } as const;
export type PlatformId = (typeof PLATFORMS)[keyof typeof PLATFORMS];
/** PC 宿主的行级 platforms 过滤基准 */
export const LOCAL_PLATFORM: PlatformId = PLATFORMS.WINDOWS;

export const QUALITY_VALUES: readonly Quality[] = ["128", "320", "flac"];

/** 跨源兜底只支持 kw/wyy 互备（playFromSource 的实现面） */
export const CROSS_SOURCE_VALUES: readonly Source[] = ["kw", "wyy"];

/** 默认预算：与 budget.ts 的常量同源（chain.json 可覆盖） */
export const DEFAULT_CHAIN_BUDGET = { totalMs: CHAIN_BUDGET_MS, lineMs: CHAIN_LINE_MS } as const;
/** 默认档内线路数上限（全灭耗时硬上限） */
export const DEFAULT_MAX_LINES_PER_QUALITY = 5;

/** 取链预算参数（§2.1 budget） */
export interface ChainBudget {
  totalMs: number;
  lineMs: number;
}

/** 响应校验条件：数值 = 相等（如 code===0）；"nonEmpty" = 取值路径非空 */
export type ChainRequire = Record<string, number | "nonEmpty">;

/** 声明式线路的主请求模板 */
export interface ChainHttpRequest {
  url: string;
  /** 模板变量见 lines/declarative.ts；值经 buildQuery 做 URL 编码 */
  query?: Record<string, string>;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** 前置可选请求（统计打卡等） */
export interface ChainPreRequest {
  url: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** 缺省 true：失败不阻断主线；显式 false = 失败即线路失败 */
  optional?: boolean;
  timeoutMs?: number;
}

export interface ChainLineBase {
  id: string;
  name: string;
  kind: "lx" | "http" | "bundle";
  /** 实测验证过的音质档；其他档不参与换源 */
  qualities: Quality[];
  /** 行级平台白名单（缺省 = 全平台；1101 安卓 / 1102 iOS / 1103 Windows） */
  platforms?: PlatformId[];
  /** 与链首并发起跑，到达序位时收割结果（脚本包 qq 链 Stellarwave tx 在用） */
  parallel?: boolean;
  /** false = 停用线路（停死线只改 chain.json 即可） */
  enabled?: boolean;
}

/** kind=lx：调 LX 脚本宿主（scriptId → lx-host 懒注册表） */
export interface LxChainLine extends ChainLineBase {
  kind: "lx";
  scriptId: string;
}

/** kind=http：声明式模板线路（改接口只改这个 JSON，不用重下 bundle） */
export interface HttpChainLine extends ChainLineBase {
  kind: "http";
  request: ChainHttpRequest;
  /** 契约音质 → 上游档位映射；缺省音质原样透传 */
  qualityMap?: Partial<Record<Quality, string>>;
  /** 响应必须满足的条件（不满足 = 线路未命中） */
  require?: ChainRequire;
  /** 取 URL 的点号路径，或按契约音质给路径 */
  pick: string | Partial<Record<Quality, string>>;
  pre?: ChainPreRequest[];
}

/** kind=bundle：复杂实现（多步/加密/分支兜底），chain.json 只写 impl 引用 */
export interface BundleChainLine extends ChainLineBase {
  kind: "bundle";
  /** bundle 内的实现名（play-url.ts 的 BUNDLE_IMPLS） */
  impl: string;
}

export type ChainLine = LxChainLine | HttpChainLine | BundleChainLine;

export interface ChainConfig {
  chainRevision: number;
  maxLinesPerQuality: number;
  crossSources: Partial<Record<Source, Source[]>>;
  budget: ChainBudget;
  chains: Partial<Record<Source, ChainLine[]>>;
}

// ---------- 校验 ----------

function isQuality(value: unknown): value is Quality {
  return value === "128" || value === "320" || value === "flac";
}

function isSource(value: unknown): value is Source {
  return value === "wyy" || value === "qq" || value === "kw" || value === "kg";
}

function isPlatform(value: unknown): value is PlatformId {
  return value === PLATFORMS.ANDROID || value === PLATFORMS.IOS || value === PLATFORMS.WINDOWS;
}

function parseQualities(raw: unknown, where: string): Quality[] {
  const list = asArray(raw);
  const values = list.map(asString).filter(isQuality);
  // 严格校验：未知的音质档（错字 / 本机不认识的新档位）整份配置拒绝，回退内置默认
  if (values.length === 0 || values.length !== list.length) {
    throw new Error(`${where} qualities 含非法取值`);
  }
  return values;
}

function parsePlatforms(raw: unknown, where: string): PlatformId[] | undefined {
  const list = asArray(raw);
  if (list.length === 0) return undefined;
  const values = list.map(asNumber).filter(isPlatform);
  if (values.length !== list.length) throw new Error(`${where} platforms 含非法平台号`);
  return values;
}

function parsePick(raw: unknown, where: string): HttpChainLine["pick"] {
  if (typeof raw === "string") {
    if (raw.length === 0) throw new Error(`${where} pick 为空`);
    return raw;
  }
  const obj = asObject(raw);
  const entries = Object.entries(obj);
  if (entries.length === 0) throw new Error(`${where} pick 为空`);
  const out: Partial<Record<Quality, string>> = {};
  for (const [key, value] of entries) {
    if (!isQuality(key) || typeof value !== "string" || value.length === 0) {
      throw new Error(`${where} pick 的 ${key} 非法`);
    }
    out[key] = value;
  }
  return out;
}

function parseRequire(raw: unknown, where: string): ChainRequire | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = asObject(raw);
  const out: ChainRequire = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "number" || value === "nonEmpty") out[key] = value;
    else throw new Error(`${where} require.${key} 只支持数值或 "nonEmpty"`);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseQualityMap(raw: unknown, where: string): Partial<Record<Quality, string>> | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = asObject(raw);
  const out: Partial<Record<Quality, string>> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!isQuality(key) || typeof value !== "string" || value.length === 0) {
      throw new Error(`${where} qualityMap.${key} 非法`);
    }
    out[key] = value;
  }
  return out;
}

function parseRecordOfStrings(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = asObject(raw);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) out[key] = asString(value);
  return Object.keys(out).length > 0 ? out : undefined;
}

function parsePre(raw: unknown, where: string): ChainPreRequest[] | undefined {
  const list = asArray(raw);
  if (list.length === 0) return undefined;
  return list.map((entry, idx) => {
    const obj = asObject(entry);
    const url = asString(obj["url"]);
    if (!url) throw new Error(`${where} pre[${idx}] 缺少 url`);
    const query = parseRecordOfStrings(obj["query"]);
    const headers = parseRecordOfStrings(obj["headers"]);
    const timeoutMs = asNumber(obj["timeoutMs"]);
    // 只保留声明了的字段（parse(JSON(cfg)) 必须与 cfg 深度相等）；
    // optional 缺省 true、timeoutMs 缺省 8000 的兜底在执行器里做
    return {
      url,
      ...(query !== undefined ? { query } : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(typeof obj["optional"] === "boolean" ? { optional: obj["optional"] } : {}),
      ...(timeoutMs > 0 ? { timeoutMs } : {}),
    };
  });
}

function parseChainLine(raw: unknown, source: Source, idx: number): ChainLine {
  const where = `chains.${source}[${idx}]`;
  const obj = asObject(raw);
  const id = asString(obj["id"]);
  const name = asString(obj["name"]);
  const kind = asString(obj["kind"]);
  if (!id) throw new Error(`${where} 缺少 id`);
  if (!name) throw new Error(`${where} 缺少 name`);
  if (kind !== "lx" && kind !== "http" && kind !== "bundle") {
    throw new Error(`${where} kind 非法: ${kind || "(空)"}`);
  }

  // 可选字段只在声明时带上（undefined 不写入）：parse(JSON.parse(JSON.stringify(cfg)))
  // 必须与 cfg 深度相等（默认配置与远端 chain.json 走同一把关）
  const base = {
    id,
    name,
    kind,
    qualities: parseQualities(obj["qualities"], where),
    ...(parsePlatforms(obj["platforms"], where) !== undefined
      ? { platforms: parsePlatforms(obj["platforms"], where) }
      : {}),
    ...(obj["parallel"] === true ? { parallel: true } : {}),
    ...(obj["enabled"] === false ? { enabled: false } : {}),
  } as ChainLineBase;

  if (kind === "lx") {
    const scriptId = asString(obj["scriptId"]);
    if (!scriptId) throw new Error(`${where} 缺少 scriptId`);
    return { ...base, kind: "lx", scriptId };
  }
  if (kind === "bundle") {
    const impl = asString(obj["impl"]);
    if (!impl) throw new Error(`${where} 缺少 impl`);
    return { ...base, kind: "bundle", impl };
  }

  const requestObj = asObject(obj["request"]);
  const url = asString(requestObj["url"]);
  if (!url) throw new Error(`${where} 缺少 request.url`);
  const timeoutMs = asNumber(requestObj["timeoutMs"]);
  const requestQuery = parseRecordOfStrings(requestObj["query"]);
  const requestHeaders = parseRecordOfStrings(requestObj["headers"]);
  const qualityMap = parseQualityMap(obj["qualityMap"], where);
  const require_ = parseRequire(obj["require"], where);
  const pre = parsePre(obj["pre"], where);
  return {
    ...base,
    kind: "http",
    request: {
      url,
      ...(requestQuery !== undefined ? { query: requestQuery } : {}),
      ...(requestHeaders !== undefined ? { headers: requestHeaders } : {}),
      ...(timeoutMs > 0 ? { timeoutMs } : {}),
    },
    ...(qualityMap !== undefined ? { qualityMap } : {}),
    ...(require_ !== undefined ? { require: require_ } : {}),
    pick: parsePick(obj["pick"], where),
    ...(pre !== undefined ? { pre } : {}),
  };
}

function parseCrossSources(raw: unknown): ChainConfig["crossSources"] {
  const obj = asObject(raw);
  const out: ChainConfig["crossSources"] = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!isSource(key)) throw new Error(`crossSources.${key} 非法平台`);
    if (!Array.isArray(value)) throw new Error(`crossSources.${key} 必须是数组`);
    if (value.length === 0) continue;
    const targets = value.map(asString);
    if (targets.some((target) => !CROSS_SOURCE_VALUES.includes(target as Source))) {
      throw new Error(`crossSources.${key} 只支持 kw/wyy 兜底`);
    }
    out[key as Source] = targets as Source[];
  }
  return out;
}

/** 校验并归一 chain.json 对象；任何字段不合法都抛错（caller 回退默认） */
export function parseChainConfig(raw: unknown): ChainConfig {
  const obj = asObject(raw);
  if (Object.keys(obj).length === 0) throw new Error("chain.json 不是对象");

  const chainRevision = asNumber(obj["chainRevision"]);
  if (!Number.isInteger(chainRevision) || chainRevision < 0) {
    throw new Error("chainRevision 非法");
  }
  const maxLinesPerQuality = asNumber(obj["maxLinesPerQuality"]);
  if (!Number.isInteger(maxLinesPerQuality) || maxLinesPerQuality < 1) {
    throw new Error("maxLinesPerQuality 非法");
  }

  const budgetObj = asObject(obj["budget"]);
  const budget: ChainBudget = {
    totalMs: asNumber(budgetObj["totalMs"]),
    lineMs: asNumber(budgetObj["lineMs"]),
  };
  if (budget.totalMs <= 0 || budget.lineMs <= 0) throw new Error("budget.totalMs/lineMs 必须为正");

  const chainsObj = asObject(obj["chains"]);
  const chains: ChainConfig["chains"] = {};
  for (const source of ["wyy", "qq", "kw", "kg"] as const) {
    const list = asArray(chainsObj[source]);
    // 未声明 / 空数组 = 该平台无内置线路（跨源兜底仍可用）
    if (list.length > 0) chains[source] = list.map((line, idx) => parseChainLine(line, source, idx));
  }

  return {
    chainRevision,
    maxLinesPerQuality,
    crossSources: parseCrossSources(obj["crossSources"]),
    budget,
    chains,
  };
}

// ---------- 默认值（纯数据；与收敛前 SCRIPT_LINES 的链路逐行等价） ----------

/** 内置默认 chain（line id 稳定，作为后续 chain.json 差异的锚点） */
export function defaultChainConfig(): ChainConfig {
  return {
    chainRevision: 1,
    maxLinesPerQuality: DEFAULT_MAX_LINES_PER_QUALITY,
    crossSources: { wyy: ["kw"], kw: ["wyy"], qq: ["kw", "wyy"], kg: ["kw", "wyy"] },
    budget: { totalMs: DEFAULT_CHAIN_BUDGET.totalMs, lineMs: DEFAULT_CHAIN_BUDGET.lineMs },
    chains: {
      wyy: [
        {
          id: "wyy-core",
          name: "网易官方核心（gdstudio 代理 → 官方双线）",
          kind: "bundle",
          impl: "wyyMusicUrlCore",
          qualities: ["128", "320", "flac"],
        },
      ],
      qq: [
        {
          id: "qq-world260809",
          name: "World 260809 a.aa.cab",
          kind: "http",
          qualities: ["128", "320", "flac"],
          request: {
            url: "https://a.aa.cab/qq.music",
            query: { msg: "{name}", n: "1", type: "{quality}" },
            headers: { "User-Agent": "{ua.browser}" },
            timeoutMs: 3000,
          },
          qualityMap: { "128": "0", "320": "1", flac: "4" },
          require: { code: 0 },
          pick: "data.music",
        },
        {
          id: "qq-stellarwave-tx",
          name: "Stellarwave tx",
          kind: "lx",
          scriptId: "stellarwave",
          qualities: ["320", "flac"],
          parallel: true,
        },
        {
          id: "qq-yuningxi-tang",
          name: "玉宁熙 tang.api",
          kind: "http",
          qualities: ["128", "320", "flac"],
          pre: [{ url: "https://www.97abc.com/count.php?id=lx-yuningxi", timeoutMs: 8000 }],
          request: {
            url: "https://tang.api.s01s.cn/music_open_api.php",
            query: { mid: "{id}" },
            headers: { "Content-Type": "application/json", Referer: "https://y.qq.com/" },
          },
          require: { song_mid: "nonEmpty" },
          pick: { "128": "song_play_url_standard", "320": "song_play_url", flac: "song_play_url_sq" },
        },
        {
          id: "qq-native-vkey",
          name: "QQ 原生 vkey",
          kind: "bundle",
          impl: "qqMusicUrlCore",
          qualities: ["128"],
          platforms: [PLATFORMS.WINDOWS],
        },
      ],
      kw: [
        {
          id: "kw-yuningxi-pro",
          name: "玉宁熙 Pro",
          kind: "lx",
          scriptId: "yuningxi-pro",
          qualities: ["128", "320", "flac"],
        },
        {
          id: "kw-yuxi",
          name: "屿溪 · 终章",
          kind: "lx",
          scriptId: "yuxi",
          qualities: ["128", "320", "flac"],
        },
        {
          id: "kw-stellarwave",
          name: "Stellarwave",
          kind: "lx",
          scriptId: "stellarwave",
          qualities: ["128", "320", "flac"],
        },
        {
          id: "kw-quandouyao",
          name: "全豆要",
          kind: "lx",
          scriptId: "quandouyao",
          qualities: ["128", "320", "flac"],
        },
        {
          id: "kw-native-des",
          name: "酷我官方 DES",
          kind: "bundle",
          impl: "kwMusicUrlCore",
          qualities: ["128", "320", "flac"],
        },
      ],
      kg: [
        {
          id: "kg-yuxi",
          name: "屿溪 · 终章",
          kind: "lx",
          scriptId: "yuxi",
          qualities: ["128", "320", "flac"],
        },
        {
          id: "kg-stellarwave",
          name: "Stellarwave",
          kind: "lx",
          scriptId: "stellarwave",
          qualities: ["128", "320", "flac"],
        },
        {
          id: "kg-molan",
          name: "墨澜",
          kind: "lx",
          scriptId: "molan",
          qualities: ["128", "320", "flac"],
        },
        {
          id: "kg-lxv6",
          name: "独家音源 v6",
          kind: "lx",
          scriptId: "lxv6",
          qualities: ["128", "320", "flac"],
        },
        {
          id: "kg-yuningxi-pro",
          name: "玉宁熙 Pro",
          kind: "lx",
          scriptId: "yuningxi-pro",
          qualities: ["flac"],
        },
      ],
    },
  };
}
