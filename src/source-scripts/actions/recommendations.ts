/**
 * 推荐歌单（契约动作 recommendations）—— 蓝本移植。
 *
 * 逻辑逐段对照 qt-uniappx services/music-api.ts 的 recommendations()（:606）：
 * 相同的上游接口、相同的请求参数、相同的字段解析；UTSJSONObject 改为
 * 普通对象判空读取。kw 分支依赖酷我 Cookie/Secret 鉴权（蓝本 kwRequest），
 * 属于待搬入的加密/Cookie 模块，试点期 kw 不在本文件实现（宿主回落 Rust 通道）。
 */
import type { ContractPlaylist, RequestBuiltin, Source } from "../contract";

const PAGE_SIZE = 30;

export async function recommendations(
  request: RequestBuiltin,
  source: Source,
  category: string | null,
  page: number,
): Promise<ContractPlaylist[]> {
  const pageNo = page > 1 ? page : 1;
  const offset = (pageNo - 1) * PAGE_SIZE;
  if (source === "qq") {
    return qqRecommendations(request, category, offset);
  }
  if (source === "kg") {
    return kgRecommendations(request, category, pageNo);
  }
  if (source === "wyy") {
    return wyyRecommendations(request, category, offset);
  }
  // kw：依赖酷我 Cookie/Secret 内置模块，试点未迁移
  throw new Error("source not supported by script yet: " + source);
}

/** 蓝本 makeHeaders（http.ts:527）各平台的默认请求头 */
function platformHeaders(source: Source): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (source === "qq") headers["Referer"] = "https://y.qq.com/";
  else if (source === "kg") headers["Referer"] = "https://www.kugou.com/";
  else headers["Referer"] = "https://music.163.com/";
  return headers;
}

function buildQuery(params: Record<string, string>): string {
  const parts: string[] = [];
  for (const key of Object.keys(params)) {
    parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(params[key]));
  }
  return parts.length > 0 ? "?" + parts.join("&") : "";
}

/** JSON 响应读取工具（替代蓝本 UTSJSONObject.get 的判空语义） */
function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return value !== null && value !== undefined ? String(value) : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value) || 0;
}

// ---------- wyy（蓝本 :686-701） ----------

async function wyyRecommendations(
  request: RequestBuiltin,
  category: string | null,
  offset: number,
): Promise<ContractPlaylist[]> {
  const url =
    "https://music.163.com/api/playlist/list" +
    buildQuery({
      cat: category !== null && category.length > 0 ? category : "全部",
      limit: String(PAGE_SIZE),
      offset: String(offset),
      total: "true",
    });
  const res = await request(url, { method: "GET", headers: platformHeaders("wyy") });
  const json = asObject(res.body);
  const raw = asArray(json["playlists"]);
  const lists: ContractPlaylist[] = [];
  for (const entry of raw) {
    const item = asObject(entry);
    lists.push({
      id: asString(item["id"]),
      name: asString(item["name"]),
      picUrl: asString(item["coverImgUrl"]),
      playCount: asString(item["playCount"]),
      platform: "wyy",
    });
  }
  return lists;
}

// ---------- qq（蓝本 :611-624，字段映射 playlistFromQQ :229） ----------

async function qqRecommendations(
  request: RequestBuiltin,
  category: string | null,
  offset: number,
): Promise<ContractPlaylist[]> {
  const categoryId = category !== null && category.length > 0 ? category : "10000000";
  const url =
    "https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg" +
    "?picmid=1&g_tk=732560869&loginUin=0&hostUin=0&format=json&inCharset=utf8" +
    "&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0" +
    "&categoryId=" + encodeURIComponent(categoryId) +
    "&sortId=2&sin=" + offset + "&ein=" + (offset + PAGE_SIZE - 1);
  const res = await request(url, { method: "GET", headers: platformHeaders("qq") });
  const json = asObject(res.body);
  const data = asObject(json["data"]);
  const raw = asArray(data["list"]);
  const lists: ContractPlaylist[] = [];
  for (const entry of raw) {
    const item = asObject(entry);
    lists.push({
      id: asString(item["dissid"]),
      name: asString(item["dissname"]),
      picUrl: asString(item["imgurl"]),
      playCount: asString(asNumber(item["listennum"])),
      platform: "qq",
    });
  }
  return lists;
}

// ---------- kg（蓝本 :662-681，字段映射 playlistFromKG :362） ----------

async function kgRecommendations(
  request: RequestBuiltin,
  category: string | null,
  pageNo: number,
): Promise<ContractPlaylist[]> {
  const cat = category !== null && category.length > 0 ? category : "0";
  const url =
    "http://www2.kugou.kugou.com/yueku/v9/special/getSpecial" +
    buildQuery({ c: cat, t: "5", p: String(pageNo), is_ajax: "1", cdn: "cdn" });
  const res = await request(url, { method: "GET", headers: platformHeaders("kg") });
  const json = asObject(res.body);
  const raw = asArray(json["special_db"]);
  const lists: ContractPlaylist[] = [];
  for (const entry of raw) {
    const item = asObject(entry);
    // getSpecial 用 img 字段（无播放量），search/special 用 imgurl/playcount —— 兼容两者
    const picUrl =
      asString(item["imgurl"]) || asString(item["img"]);
    lists.push({
      id: asString(item["specialid"]),
      name: asString(item["specialname"]),
      picUrl: normalizeKgPic(picUrl),
      playCount: asString(item["playcount"]),
      platform: "kg",
    });
  }
  return lists;
}

/** 蓝本 normalizeKgPic（music-api.ts:390）：{size}→300、http→https */
function normalizeKgPic(url: string): string {
  if (url.length === 0) return "";
  let out = url.split("{size}").join("300");
  out = out.split("http://").join("https://");
  return out;
}
