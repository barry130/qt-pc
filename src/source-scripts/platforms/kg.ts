/**
 * 酷狗（kg）平台模块 —— 蓝本移植。
 *
 * 逻辑逐段对照 qt-uniappx services/music-api.ts / http.ts：
 * - search            :1146（mobilecdnbj api/v3/search/song）+ songFromKGRankSong :1983
 * - musicUrlCore      :3506 fetchNativeUrl kg 分支（m.kugou.com getSongInfo.php cmd=playInfo，
 *                      返回 url 或 throw "该歌曲暂时无法播放"；quality 不参与 kg 分支）
 * - lyric             :3067（酷狗官方歌词接口不稳定 → 直接用网易云搜索兜底取词，
 *                      失败返回空串）/ lyricTranslation（仅同名兜底词路径返回所配
 *                      网易云 tlyric，原生 krc 无翻译字段恒空串）
 * - playlistCategories :571（yueku/v9/special/getSpecial?is_smarty=1 的 data.tagids 六组）
 * - playlistDetail    :2928（collection_ 收藏歌单 → song_v2 签名接口；gcid_ 全球歌单 →
 *                      m.kugou.com SSR 分享页；含字母短码 → zlist/list chain 接口；
 *                      纯数字 specialid → yueku HTML 解析兜底）
 *                      + kgSongV2Playlist :2533 + kgChainPlaylist :2283 + kgGcidPlaylist :2403
 *                      + songFromKGChain :2361 / songFromKGShare :2461 /
 *                        songFromKGCollection :2597 / songFromKGSingle :2044 /
 *                        isKgCollectionId :2505 / kgMobileUrl :2517
 * - recommendations   :667（getSpecial special_db）+ playlistFromKG :362
 * - latest            :765（api/v3/rank/newsong with_res_tag=1）+ songFromKG :465
 * - charts            :848（api/v3/rank/list）+ chartFromKG :438
 * - chartDetail       :2250（api/v3/rank/song ranktype=2 pagesize=200，空时 throw）
 * - hotWords          :1047（api/v3/search/hot，data.info[].keyword）
 * - playlistSearch    :1473（api/v3/search/special）+ playlistFromKG :362
 * - artistSearch      :1587（api/v3/search/singer，data 顶层数组）+ artistFromKG :1309
 * - albumSearch       :1712（api/v3/search/album）+ albumFromKG :1325
 * - albumDetail       :1831（api/v3/album/info + album/song，albumid 无下划线）
 * - videos            :960（api/v5/video/list，img 的 /{size}/ 替换）
 * - videoUrl          :3585（m.kugou.com/app/i/mv.php cmd=100，mvdata.le.backupdownurl）
 *
 * http.ts 公共段：directRequest kg 分支 :643（KG_TAG_RES 注释剥离 :674-677，见
 * kgRequestJson）/ directText :543 / kgMobileRequest :577（mid/dfid/clienttime 签名头）/
 * KG_MOBILE_UA :540 / makeHeaders :527。
 * 签名模块：qt-uniappx services/kg-sign.ts → ./kg-md5.ts（原样文件级移植）。
 */
import type {
  ContractAlbum,
  ContractArtist,
  ContractChart,
  ContractPlaylist,
  ContractPlaylistCategory,
  ContractPlaylistDetail,
  ContractVideo,
  MusicInfo,
  Quality,
  RequestBuiltin,
} from "../contract";
import { kgSignature } from "./kg-md5";
import {
  asArray,
  asNumber,
  asObject,
  asString,
  buildQuery,
  normalizeKgPic,
  platformHeaders,
  requestJson,
} from "./utils";

const KG_HEADERS = platformHeaders("kg");
/** 蓝本 lyrics kg 分支用网易云兜底（directRequest source="wyy"） */
const WYY_HEADERS = platformHeaders("wyy");

/**
 * 时长字段（`duration` / `timelen`）→ 秒。
 * 酷狗各接口单位不统一：多数给毫秒，少数给秒（实测同一账号下两种都有）。
 * 按数量级归一——正常曲目 60–3600 秒，毫秒值至少 60000，两区间不重叠，
 * 故以 10000 为界：大于它按毫秒换算，否则按秒原样使用。
 */
/**
 * 酷狗 hash 大小写不敏感，但各接口回的大小写不一致（playInfo 回大写、
 * 部分搜索接口回小写），不统一就会把同一首歌存成两条
 * （`kg:37a8f50a…` 与 `kg:37A8F50A…`）。统一大写作为规范形式。
 */
function kgHash(raw: string): string {
  return raw.trim().toUpperCase();
}

function kgDurationSec(value: unknown): number {
  const raw = asNumber(value);
  return raw > 10000 ? raw / 1000 : raw;
}

/**
 * 酷狗原生歌词（m.kugou.com/app/i/krc.php?cmd=100&hash=…&timelength=…）：
 * 按播放键 hash 精确取词，返回明文 LRC（UTF-8 带 BOM）。
 * `timelength` 必须非 0，否则接口回空体（给错值仍能取到，故用曲目时长即可）。
 */
async function kgNativeLyric(
  request: RequestBuiltin,
  song: MusicInfo,
): Promise<string> {
  if (song.id.length === 0) return "";
  const timelength = Math.round(song.interval * 1000);
  if (timelength <= 0) return "";
  const res = await request(
    "https://m.kugou.com/app/i/krc.php" +
      buildQuery({ cmd: "100", hash: song.id, timelength: String(timelength) }),
    { headers: KG_HEADERS },
  );
  if (res.statusCode < 200 || res.statusCode >= 300) return "";
  // LRC 不是 JSON，宿主会原样回字符串；BOM 去掉免得污染首行
  return typeof res.body === "string"
    ? res.body.replace(/^\uFEFF/, "").trim()
    : "";
}

/** kg 歌词 + 翻译成对结果（kgLyricWithTranslation 的返回） */
interface KgLyricPair {
  lyric: string;
  translation: string;
}

/**
 * kg 歌词与翻译成对获取：原生 krc 优先（无翻译字段）；
 * 取不到才回落网易云同名搜索，一次同时拿 lrc + tlyric。
 * 结果按歌曲键缓存——lyric / lyricTranslation 两次入口调用走同一份结果，
 * 保证译文与所显示原文严格配对，也避免搜索重复请求。
 */
let kgLyricPairCache: { key: string; pair: KgLyricPair } | null = null;

async function kgLyricWithTranslation(
  request: RequestBuiltin,
  song: MusicInfo,
): Promise<KgLyricPair> {
  const key = song.id + ":" + song.name + ":" + song.singer;
  const cached = kgLyricPairCache;
  if (cached != null && cached.key === key) return cached.pair;
  const native = await kgNativeLyric(request, song).catch(() => "");
  const pair: KgLyricPair =
    native.length > 0
      ? { lyric: native, translation: "" }
      : await wyyLyricPairBySearch(request, song).catch(() => ({ lyric: "", translation: "" }));
  kgLyricPairCache = { key, pair };
  return pair;
}

/**
 * 网易云搜索兜底（仅酷狗原生取不到时用）：**必须命中同名曲**才采纳。
 * 蓝本原样是取第一条，实测常命中同歌手的另一首，那种歌词比没有更糟。
 * 一次请求同时取 lrc + tlyric 成对返回——译文与所显示的原文严格同曲。
 */
async function wyyLyricPairBySearch(
  request: RequestBuiltin,
  song: MusicInfo,
): Promise<{ lyric: string; translation: string }> {
  const json = await requestJson(
    request,
    "https://music.163.com/api/search/get" +
      buildQuery({
        s: song.name + " " + song.singer,
        type: "1",
        limit: "5",
        offset: "0",
      }),
    { headers: WYY_HEADERS },
  );
  const songs = asArray(asObject(json["result"])["songs"]);
  for (const raw of songs) {
    const hit = asObject(raw);
    if (!sameSongName(asString(hit["name"]), song.name)) continue;
    const id = asString(hit["id"]);
    if (id.length === 0) continue;
    const lyricJson = await requestJson(
      request,
      "https://music.163.com/api/song/lyric" +
        buildQuery({ id, lv: "-1", kv: "-1", tv: "-1" }),
      { headers: WYY_HEADERS },
    );
    const lyric = asString(asObject(lyricJson["lrc"])["lyric"]);
    if (lyric.length === 0) continue;
    return { lyric, translation: asString(asObject(lyricJson["tlyric"])["lyric"]) };
  }
  return { lyric: "", translation: "" };
}

/**
 * 歌名是否同一首：去掉括号补充说明（Live / 女声版 / 翻唱…）与空白后比较。
 * 只要求歌名一致即可——同一首歌在不同平台的歌手串写法差异很大
 * （「大张伟、汪苏泷」vs「大张伟/汪苏泷」），拿歌手比对会误杀。
 */
function sameSongName(a: string, b: string): boolean {
  const norm = (s: string): string =>
    s
      .replace(/[（(][^）)]*[)）]/g, "")
      .replace(/\s+/g, "")
      .toLowerCase();
  const na = norm(a);
  return na.length > 0 && na === norm(b);
}

/**
 * 蓝本 http.ts :540：移动端 UA。酷狗分享页（m.kugou.com/songlist/gcid_xxx/）只对
 * 移动 UA 返回服务端渲染的 window.$output 数据；PC UA 会被 302 到空壳页。
 */
const KG_MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 11_0 like Mac OS X) AppleWebKit/604.1.38 (KHTML, like Gecko) Version/11.0 Mobile/15A372 Safari/604.1";

/**
 * 蓝本 directRequest（http.ts:643-697）source=="kg" 分支的移植。
 * 酷狗 JSON 响应（尤其 with_res_tag=1 的接口）可能被
 * <!--KG_TAG_RES_START--> / <!--KG_TAG_RES_END--> 注释包裹，宿主按 JSON 解析
 * 失败会回退原样字符串，这里剥离后再解析（Rust 基线 provider/kg.rs get_json 同款）。
 */
async function kgRequestJson(
  request: RequestBuiltin,
  url: string,
): Promise<Record<string, unknown>> {
  const res = await request(url, { headers: KG_HEADERS });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error("HTTP " + res.statusCode);
  }
  const body = res.body;
  if (typeof body === "string") {
    let text = body.replace("<!--KG_TAG_RES_START-->", "");
    text = text.replace("<!--KG_TAG_RES_END-->", "");
    if (!text.startsWith("{")) {
      throw new Error("平台接口返回非 JSON 数据");
    }
    try {
      return asObject(JSON.parse(text));
    } catch {
      throw new Error("平台接口数据格式异常");
    }
  }
  return asObject(body);
}

/** 蓝本 directText（http.ts:543）：GET 文本（歌单详情 HTML / SSR 分享页用） */
async function directText(
  request: RequestBuiltin,
  url: string,
  referer?: string,
  userAgent?: string,
): Promise<string> {
  const ref = referer != null && referer.length > 0 ? referer : "https://music.163.com/";
  const ua = userAgent != null && userAgent.length > 0 ? userAgent : "Mozilla/5.0";
  const res = await request(url, { headers: { "User-Agent": ua, "Referer": ref } });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error("HTTP " + res.statusCode);
  }
  // 蓝本 resolve(response.data as string)：HTML 响应宿主 JSON 解析必失败、原样字符串
  return res.body as string;
}

/**
 * 蓝本 kgMobileRequest（http.ts:577）：mobiles.kugou.com 的 v5 签名接口
 * 除 URL 上的 signature 外还强制校验 mid / dfid / clienttime 请求头与分享页
 * Referer，缺任意一项都会返回 errcode:1001「参数不合法」。
 */
async function kgMobileRequest(
  request: RequestBuiltin,
  url: string,
): Promise<Record<string, unknown>> {
  const res = await request(url, {
    headers: {
      mid: "1586163242519",
      dfid: "-",
      clienttime: "1586163242519",
      Referer: "https://m3ws.kugou.com/share/index.php",
      "User-Agent": KG_MOBILE_UA,
    },
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error("HTTP " + res.statusCode);
  }
  const responseData = res.body;
  if (typeof responseData === "string") {
    if (!responseData.startsWith("{")) {
      throw new Error("酷狗接口返回非 JSON 数据");
    }
    try {
      return asObject(JSON.parse(responseData));
    } catch {
      throw new Error("酷狗接口数据格式异常");
    }
  }
  return asObject(responseData);
}

/** 蓝本 playlistFromKG :362（兼容 getSpecial 的 img 与 search/special 的 imgurl/playcount） */
function playlistFromKG(item: Record<string, unknown>): ContractPlaylist {
  // 兼容两种酷狗歌单接口字段：
  //  - 首页推荐 getSpecial: specialid/specialname/img（无播放量）
  //  - 歌单搜索 search/special: specialid/specialname/imgurl/playcount
  const imgurl = asString(item["imgurl"]);
  const img = asString(item["img"]);
  let picUrl = "";
  if (imgurl.length > 0) picUrl = imgurl;
  else if (img.length > 0) picUrl = img;
  return {
    id: asString(item["specialid"]),
    platform: "kg",
    name: asString(item["specialname"]),
    picUrl: normalizeKgPic(picUrl),
    playCount: asString(item["playcount"]),
  };
}

/** 蓝本 chartFromKG :438（imgurl 的 /{size}/ 直接去掉） */
function chartFromKG(item: Record<string, unknown>): ContractChart {
  return {
    id: asString(item["rankid"]),
    platform: "kg",
    name: asString(item["rankname"]),
    picUrl: asString(item["imgurl"]).replace("/{size}/", "/"),
    description: "",
  };
}

/** 蓝本 songFromKG :465（新歌接口 filename 按 " - " 拆歌手/歌名） */
function songFromKG(item: Record<string, unknown>): MusicInfo {
  // 酷狗新歌接口的 album_id 是字符串，不能按 number 强制转换
  const hash = kgHash(asString(item["hash"]));
  const albumId = asString(item["album_id"]);
  const id = hash.length > 0 ? hash : albumId;
  const filename = asString(item["filename"]);
  const cover = asString(item["cover"]);
  const parts = filename.indexOf(" - ") >= 0 ? filename.split(" - ") : null;
  const singer = parts !== null ? parts[0] : "";
  const name = parts !== null ? parts[1] : filename;
  return {
    id,
    name,
    singer,
    album: "",
    picUrl: normalizeKgPic(cover),
    interval: kgDurationSec(item["duration"]),
  };
}

/**
 * 蓝本 songFromKGRankSong :1983（搜索/榜单接口 info[] 结构：
 * hash/album_id/filename/songname/singers；封面优先 trans_param.union_cover）。
 * songname/singers/album_sizable_cover/imgUrl 保留蓝本的「字段存在」判断语义。
 */
function songFromKGRankSong(item: Record<string, unknown>): MusicInfo {
  const hash = kgHash(asString(item["hash"]));
  const albumId = asString(item["album_id"]);
  const id = hash.length > 0 ? hash : albumId;
  const filename = asString(item["filename"]);
  const songnameVal = item["songname"];
  const singersVal = item["singers"];
  const author = asString(item["author"]);
  const parts = filename.indexOf(" - ") >= 0 ? filename.split(" - ") : null;
  const singer =
    singersVal != null
      ? asString(singersVal)
      : parts !== null
        ? parts[0]
        : author;
  const name =
    songnameVal != null
      ? asString(songnameVal)
      : parts !== null
        ? parts[1]
        : filename;
  const cover = asString(item["cover"]);
  const albumSizable = item["album_sizable_cover"];
  // 酷狗歌曲封面 union_cover 位于 trans_param 嵌套对象内（非顶层）
  const transParam = asObject(item["trans_param"]);
  const unionCover = asString(transParam["union_cover"]);
  const albumImg = item["imgUrl"];
  let picUrl = "";
  if (unionCover.length > 0) picUrl = unionCover;
  else if (cover.length > 0) picUrl = cover;
  else if (albumSizable != null) picUrl = asString(albumSizable);
  else if (albumImg != null) picUrl = asString(albumImg);
  picUrl = normalizeKgPic(picUrl);
  return {
    id,
    name,
    singer,
    album: "",
    picUrl,
    interval: kgDurationSec(item["duration"]),
  };
}

/**
 * 蓝本 songFromKGSingle :2044（yueku/v9/special/single HTML 接口 global.data 的歌曲项：
 * songname/singername/album_name，封面在 trans_param.union_cover）。
 */
function songFromKGSingle(item: Record<string, unknown>): MusicInfo {
  const albumId = item["album_id"];
  const hash = kgHash(asString(item["hash"]));
  const id =
    hash.length > 0 ? hash : albumId != null ? String(albumId) : "";
  const songname = asString(item["songname"]);
  const singername = asString(item["singername"]);
  const albumName = asString(item["album_name"]);
  const img = asString(item["img"]);
  const cover = asString(item["cover"]);
  // 酷狗歌曲封面 union_cover 位于 trans_param 嵌套对象内（非顶层）
  const transParam = asObject(item["trans_param"]);
  const unionCover = asString(transParam["union_cover"]);
  const albumImg = item["imgUrl"];
  let picUrl = "";
  if (unionCover.length > 0) picUrl = unionCover;
  else if (cover.length > 0) picUrl = cover;
  else if (img.length > 0) picUrl = img;
  else if (albumImg != null) picUrl = asString(albumImg);
  picUrl = normalizeKgPic(picUrl);
  return {
    id,
    name: songname,
    singer: singername,
    album: albumName,
    picUrl,
    interval: kgDurationSec(item["duration"]),
  };
}

/** 蓝本 songFromKGChain :2361（chain 歌单：name 是「歌手 - 歌名」，hash 是播放键） */
function songFromKGChain(item: Record<string, unknown>): MusicInfo {
  const hash = kgHash(asString(item["hash"]));
  const nameRaw = asString(item["name"]);
  const parts =
    nameRaw.indexOf(" - ") >= 0 ? nameRaw.split(" - ") : null;
  const singer = parts !== null ? parts[0] : "";
  const name = parts !== null && parts.length > 1 ? parts[1] : nameRaw;
  const albumId = asString(item["album_id"]);
  const id = hash.length > 0 ? hash : albumId;
  const duration = kgDurationSec(item["timelen"]);
  let cover = "";
  const trans = asObject(item["trans_param"]);
  const uc = asString(trans["union_cover"]);
  if (uc.length > 0) cover = normalizeKgPic(uc);
  return {
    id,
    name,
    singer,
    album: "",
    picUrl: cover,
    interval: duration,
  };
}

/**
 * 蓝本 songFromKGShare :2461（分享页 $output.info.songs 的歌曲项：name 是
 * 「歌手 - 歌名」、remark 是专辑名、singerinfo 有结构化歌手、timelen 是毫秒）。
 */
function songFromKGShare(item: Record<string, unknown>): MusicInfo {
  const hash = kgHash(asString(item["hash"]));
  const albumId = asString(item["album_id"]);
  const id = hash.length > 0 ? hash : albumId;
  const nameRaw = asString(item["name"]);
  let singer = "";
  let name = nameRaw;
  if (nameRaw.indexOf(" - ") >= 0) {
    const parts = nameRaw.split(" - ");
    singer = parts[0];
    name = parts.length > 1 ? parts[1] : "";
  }
  // singerinfo 是结构化歌手信息，比按「 - 」拆 name 更准，优先用
  const singers = asArray(item["singerinfo"]);
  if (singers.length > 0) {
    const sn = asString(asObject(singers[0])["name"]);
    if (sn.length > 0) singer = sn;
  }
  const remark = asString(item["remark"]);
  // timelen 是毫秒（interval 用秒）
  const duration = Math.round(kgDurationSec(item["timelen"]));
  let cover = "";
  const trans = asObject(item["trans_param"]);
  const unionCover = asString(trans["union_cover"]);
  const coverRaw = asString(item["cover"]);
  if (unionCover.length > 0) cover = unionCover;
  else if (coverRaw.length > 0) cover = coverRaw;
  return {
    id,
    name,
    singer,
    album: remark,
    picUrl: normalizeKgPic(cover),
    interval: duration,
  };
}

/**
 * 蓝本 songFromKGCollection :2597（special/song_v2 的歌曲项：
 * filename("歌手 - 歌名")/hash/album_id/remark(专辑名)，封面链与 songFromKGRankSong 一致）。
 */
function songFromKGCollection(item: Record<string, unknown>): MusicInfo {
  const hash = kgHash(asString(item["hash"]));
  const albumId = asString(item["album_id"]);
  const id = hash.length > 0 ? hash : albumId;
  const filename = asString(item["filename"]);
  let singer = "";
  let name = filename;
  if (filename.indexOf(" - ") >= 0) {
    const parts = filename.split(" - ");
    singer = parts[0];
    name = parts.length > 1 ? parts[1] : "";
  }
  const remark = asString(item["remark"]);
  // special/song_v2 也返回封面，读取 trans_param.union_cover 等字段，避免歌单歌曲无封面
  const cover = asString(item["cover"]);
  const albumSizable = item["album_sizable_cover"];
  const transParam = asObject(item["trans_param"]);
  const unionCover = asString(transParam["union_cover"]);
  const albumImg = item["imgUrl"];
  let picUrl = "";
  if (unionCover.length > 0) picUrl = unionCover;
  else if (cover.length > 0) picUrl = cover;
  else if (albumSizable != null) picUrl = asString(albumSizable);
  else if (albumImg != null) picUrl = asString(albumImg);
  picUrl = normalizeKgPic(picUrl);
  const song: MusicInfo = {
    id,
    name,
    singer,
    album: remark,
    picUrl,
    interval: kgDurationSec(item["duration"]),
  };
  if (hash.length > 0 && hash.toLowerCase() !== "nohash") song.musicId = hash;
  return song;
}

/** 蓝本 artistFromKG :1309（歌手头像按 singerid 规律拼接） */
function artistFromKG(item: Record<string, unknown>): ContractArtist {
  const id = asString(item["singerid"]);
  return {
    id,
    platform: "kg",
    name: asString(item["singername"]),
    // 酷狗歌手头像：singerimg.kugou.com/uploadpic/softhead/{size}/{singerid}.jpg
    picUrl:
      id.length > 0
        ? "https://singerimg.kugou.com/uploadpic/softhead/300/" + id + ".jpg"
        : "",
  };
}

/** 蓝本 albumFromKG :1325 */
function albumFromKG(item: Record<string, unknown>): ContractAlbum {
  return {
    id: asString(item["albumid"]),
    platform: "kg",
    name: asString(item["albumname"]),
    artist: asString(item["singername"]),
    picUrl: normalizeKgPic(asString(item["imgurl"])),
  };
}

/** 蓝本 isKgCollectionId :2505（collection_ 前缀，或含非数字字符即视为 global_specialid） */
function isKgCollectionId(id: string): boolean {
  if (id.length === 0) return false;
  if (id.indexOf("collection_") === 0) return true;
  // 兜底：含非数字字符即认为是 global_specialid
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    if (c < 48 || c > 57) return true;
  }
  return false;
}

/** 蓝本 kgMobileUrl :2517（拼接 mobiles.kugou.com v5 接口地址，自动补 signature） */
function kgMobileUrl(path: string, params: string): string {
  return (
    "https://mobiles.kugou.com/api/v5/" +
    path +
    "?" +
    params +
    "&signature=" +
    kgSignature(params, 5)
  );
}

/**
 * 蓝本 kgChainPlaylist :2283（分享短码 t1.kugou.com/<code> 的 chain 接口分页拉全）。
 * 服务端会把 pagesize 钳到 100，部分节点还会把首页钳到 10 条并把 count 一并改小，
 * 所以只在某页返回空时才认为拉完；同时用首页首条 hash 防卡死（翻页内容没变即止）。
 */
async function kgChainPlaylist(
  request: RequestBuiltin,
  code: string,
): Promise<ContractPlaylistDetail> {
  const songs: MusicInfo[] = [];
  let nameVal = "";
  let picVal = "";
  let desc: string | null = null;
  let count = 0;
  const pageSize = 100;
  let page = 1;
  const maxPages = 100;
  let firstPage = true;
  let prevFirstHash = "";
  while (page <= maxPages) {
    const resp = await kgRequestJson(
      request,
      "https://m3ws.kugou.com/zlist/list" +
        buildQuery({ chain: code, page: String(page), pagesize: String(pageSize) }),
    );
    const infoList = asArray(resp["info"]);
    if (infoList.length === 0) break;
    if (firstPage) {
      firstPage = false;
      // 空页时 info 可能是 {} 而非数组，必须对元素本身判空（蓝本注释同款）
      if (infoList[0] == null) break;
      const first = asObject(infoList[0]);
      nameVal = asString(first["name"]);
      const picRaw = asString(first["pic"]);
      picVal = picRaw.length > 0 ? normalizeKgPic(picRaw) : "";
      const intro = asString(first["intro"]);
      desc = intro.length > 0 ? intro : null;
      count = asNumber(first["count"]);
    }
    const listObj = asObject(resp["list"]);
    const items = asArray(listObj["info"]);
    if (items.length === 0) break;
    // 翻到超出末页时 list.info 可能返回 {}（空对象）：元素判空兜底
    if (items[0] == null) break;
    const fh = asString(asObject(items[0])["hash"]);
    if (!firstPage && fh.length > 0 && fh === prevFirstHash) break;
    prevFirstHash = fh;
    firstPage = false;
    for (const entry of items) songs.push(songFromKGChain(asObject(entry)));
    page++;
  }
  // 有播主把歌单 pic 留空（如分享“喜欢的音乐”），用第一首歌的封面兜底
  if (picVal.length === 0 && songs.length > 0) {
    picVal = songs[0].picUrl;
  }
  if (nameVal.length === 0) throw new Error("酷狗分享歌单解析失败");
  // count 可能被服务端钳小（与分页截断同源），取 count 与实拉数量的较大者
  const playCountVal = count > songs.length ? count : songs.length;
  return {
    id: code,
    platform: "kg",
    name: nameVal,
    picUrl: picVal,
    playCount: String(playCountVal),
    description: desc,
    tracks: songs,
  };
}

/**
 * 蓝本 kgGcidPlaylist :2403（「全球歌单」分享链接 m.kugou.com/songlist/gcid_xxx/）。
 * gcid 不在移动端签名接口入参范围内，但分享页是服务端渲染的，HTML 里内嵌
 * window.$output = { info: { listinfo: {...}, songs: [...] } }，用移动 UA 请求解析。
 * 注意：只包含服务端这一批渲染出来的歌曲，超大歌单可能被截断。
 */
async function kgGcidPlaylist(
  request: RequestBuiltin,
  gcid: string,
): Promise<ContractPlaylistDetail> {
  const html = await directText(
    request,
    "https://m.kugou.com/songlist/" + gcid + "/",
    "https://m.kugou.com/",
    KG_MOBILE_UA,
  );
  // $output 是 JSON 对象字面量，直到 </script> 才结束；非贪婪 + 锚定 </script>，
  // 即使歌名里出现 "};" 也不会提前截断
  const outputRe = /window\.\$output\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/;
  const outputMatch = outputRe.exec(html);
  if (outputMatch == null || outputMatch.length < 2) throw new Error("酷狗分享歌单解析失败");
  const output = asObject(JSON.parse(outputMatch[1]));
  const infoVal = output["info"];
  if (infoVal == null) throw new Error("酷狗分享歌单解析失败");
  const info = asObject(infoVal);
  let nameVal = "";
  let picVal = "";
  let desc: string | null = null;
  let count = 0;
  const listinfo = asObject(info["listinfo"]);
  if (Object.keys(listinfo).length > 0) {
    nameVal = asString(listinfo["name"]);
    const pic = asString(listinfo["pic"]);
    picVal = pic.length > 0 ? normalizeKgPic(pic) : "";
    const intro = asString(listinfo["intro"]);
    desc = intro.length > 0 ? intro : null;
    count = asNumber(listinfo["count"]);
  }
  const songs: MusicInfo[] = [];
  const rawSongs = asArray(info["songs"]);
  // 与 chain 路径同样做元素判空：空页/异常数据下数组元素可能是 undefined
  for (const entry of rawSongs) {
    if (entry == null) continue;
    songs.push(songFromKGShare(asObject(entry)));
  }
  if (nameVal.length === 0) throw new Error("酷狗分享歌单解析失败");
  if (picVal.length === 0 && songs.length > 0) picVal = songs[0].picUrl;
  const playCountVal = count > songs.length ? count : songs.length;
  return {
    id: gcid,
    platform: "kg",
    name: nameVal,
    picUrl: picVal,
    playCount: String(playCountVal),
    description: desc,
    tracks: songs,
  };
}

/**
 * 蓝本 kgSongV2Playlist :2533（special/song_v2 拿歌曲 + special/info_v2 拿名称/封面）。
 * 普通歌单（数字 specialid）与收藏/分享歌单（global_specialid）通用，按 id 类型选参数；
 * 失败返回 null，由调用方决定兜底。
 */
async function kgSongV2Playlist(
  request: RequestBuiltin,
  id: string,
): Promise<ContractPlaylistDetail | null> {
  const isCollection = isKgCollectionId(id);
  const idParam = isCollection
    ? "global_specialid=" + id + "&specialid=0"
    : "specialid=" + id + "&global_specialid=0";
  try {
    const params =
      "appid=1058&" +
      idParam +
      "&plat=0&version=8000&page=1&pagesize=1000&srcappid=2919&clientver=20000&clienttime=1586163263991&mid=1586163263991&uuid=1586163263991&dfid=-";
    const response = await kgMobileRequest(request, kgMobileUrl("special/song_v2", params));
    const status = response["status"];
    if (status == null || String(status) !== "1") return null;
    const data = asObject(response["data"]);
    const songs: MusicInfo[] = [];
    for (const entry of asArray(data["info"])) {
      songs.push(songFromKGCollection(asObject(entry)));
    }
    // 元信息单独取（special/info_v2）
    let nameVal = "";
    let picVal = "";
    let countVal = "0";
    const infoParams =
      "appid=1058&" +
      idParam +
      "&format=jsonp&srcappid=2919&clientver=20000&clienttime=1586163242519&mid=1586163242519&uuid=1586163242519&dfid=-";
    const infoResp = await kgMobileRequest(request, kgMobileUrl("special/info_v2", infoParams));
    const istatus = infoResp["status"];
    if (istatus != null && String(istatus) === "1") {
      const info = asObject(infoResp["data"]);
      const specialname = info["specialname"];
      if (specialname != null) nameVal = asString(specialname);
      picVal = normalizeKgPic(asString(info["imgurl"]));
      const playcount = info["playcount"];
      if (playcount != null) countVal = String(playcount);
    }
    // 收藏歌单的 info_v2 往往不返回 specialname/imgurl：封面用第一首歌兜底
    if (picVal.length === 0 && songs.length > 0) picVal = songs[0].picUrl;
    return {
      id,
      platform: "kg",
      name: nameVal,
      picUrl: picVal,
      playCount: countVal,
      description: null,
      tracks: songs,
    };
  } catch {
    return null;
  }
}

export const kg = {
  /** 蓝本 search kg 分支 :1146 */
  async search(
    request: RequestBuiltin,
    keyword: string,
    page: number,
    size: number,
  ): Promise<MusicInfo[]> {
    const json = await kgRequestJson(
      request,
      "http://mobilecdnbj.kugou.com/api/v3/search/song" +
        buildQuery({
          version: "9108",
          plat: "0",
          keyword,
          page: String(page),
          pagesize: String(size),
        }),
    );
    const data = asObject(json["data"]);
    const out: MusicInfo[] = [];
    for (const entry of asArray(data["info"])) {
      out.push(songFromKGRankSong(asObject(entry)));
    }
    return out;
  },

  /** 蓝本 fetchNativeUrl kg 分支 :3506（getSongInfo.php；quality 不参与 kg 分支） */
  async musicUrlCore(
    request: RequestBuiltin,
    song: MusicInfo,
    _quality: Quality,
  ): Promise<string> {
    const json = await kgRequestJson(
      request,
      "http://m.kugou.com/app/i/getSongInfo.php" + buildQuery({ cmd: "playInfo", hash: song.id }),
    );
    const url = asString(json["url"]);
    if (url.length > 0) return url;
    throw new Error("该歌曲暂时无法播放");
  },

  /**
   * 歌词：**优先酷狗原生**（按播放键 hash 精确取词，与播放同源）。
   *
   * 蓝本 lyrics kg 分支直接用网易云搜索兜底，是因为当时酷狗歌词接口不稳定；
   * 但按歌名+歌手搜网易云再取第一条，实测经常命中同歌手的另一首
   * （《马文才》→《故里逢春》、《挪威的森林》→《泪桥》），歌词与歌曲完全无关。
   * 故改为：原生精确取词 → 取不到才回落网易云，且**必须命中同名曲**。
   */
  async lyric(request: RequestBuiltin, song: MusicInfo): Promise<string> {
    return (await kgLyricWithTranslation(request, song)).lyric;
  },

  /**
   * 酷狗官方歌词接口（krc.php）没有翻译字段，原生词路径恒返回空串；
   * 仅当歌词本文走了网易云同名兜底时，返回同一首的 tlyric——
   * 译文与所显示的原文严格同源同曲，不是跨源兜底。按产品约定不做其他兜底。
   */
  async lyricTranslation(request: RequestBuiltin, song: MusicInfo): Promise<string> {
    return (await kgLyricWithTranslation(request, song)).translation;
  },

  /** 蓝本 playlistCategories kg 分支 :571（tagids 固定六组，id 为数字字符串） */
  async playlistCategories(request: RequestBuiltin): Promise<ContractPlaylistCategory[]> {
    const json = await kgRequestJson(
      request,
      "http://www2.kugou.kugou.com/yueku/v9/special/getSpecial?is_smarty=1",
    );
    const categories: ContractPlaylistCategory[] = [];
    const data = asObject(json["data"]);
    const tagids = asObject(data["tagids"]);
    const groups: string[] = ["主题", "语种", "风格", "年代", "心情", "场景"];
    for (const group of groups) {
      const items = asArray(asObject(tagids[group])["data"]);
      for (const entry of items) {
        const item = asObject(entry);
        const id = item["id"];
        const name = item["name"];
        if (id == null || name == null) continue;
        categories.push({ id: String(id), name: String(name), group: null });
      }
    }
    return categories;
  },

  /**
   * 蓝本 playlist kg 分支（music-api.ts:2928-2984）：
   * - collection_ 收藏歌单（global_specialid）→ song_v2 签名接口（须先于 chain 判断，
   *   它含字母，会被 chain 的正则误吞）
   * - gcid_ 全球歌单 → m.kugou.com SSR 分享页解析
   * - 含字母短码（t1.kugou.com/<code>）→ zlist/list chain 接口
   * - 纯数字 specialid → song_v2 返回空 info，走 yueku HTML 解析兜底
   * （蓝本 :2939 的 isKgCollectionId 复查在本模块语境下不可达：其两个触发条件
   *  collection_ 前缀与「含非数字字符」均已被上面分支先行接住，故不再重复。）
   */
  async playlistDetail(request: RequestBuiltin, id: string): Promise<ContractPlaylistDetail> {
    if (id.indexOf("collection_") === 0) {
      const v2 = await kgSongV2Playlist(request, id);
      if (v2 != null && v2.tracks.length > 0) return v2;
      throw new Error("酷狗歌单加载失败");
    }
    if (id.indexOf("gcid_") === 0) {
      return kgGcidPlaylist(request, id);
    }
    if (!/^[0-9]+$/.test(id)) {
      return kgChainPlaylist(request, id);
    }
    // 普通数字歌单：QTmusic_nuve 项目验证的接口返回 HTML，正则提取 global.data 与元信息
    const html = await directText(
      request,
      "http://www2.kugou.kugou.com/yueku/v9/special/single/" + id + "-6-1084.html",
      "https://www.kugou.com/",
    );
    // 提取 global.data = [...]; 的歌曲数组
    let tracks: MusicInfo[] = [];
    const dataRe = /global\.data\s*=\s*(\[[\s\S]*?\]);/;
    const dataMatch = dataRe.exec(html);
    if (dataMatch != null && dataMatch.length > 1) {
      try {
        const raw = JSON.parse(dataMatch[1]) as unknown[];
        for (const entry of raw) {
          tracks.push(songFromKGSingle(asObject(entry)));
        }
      } catch {
        // 蓝本：JSON 解析失败不阻断，继续提取元信息
      }
    }
    // 提取歌单元信息：全球形变量里有 id/name/pic
    let nameVal = "";
    let picVal = "";
    const infoRe = /global\s*=\s*\{[\s\S]*?id:\s*"([^"]*)"[\s\S]*?name:\s*"([^"]*)"[\s\S]*?pic:\s*"([^"]*)"[\s\S]*?\};/;
    const infoMatch = infoRe.exec(html);
    if (infoMatch != null && infoMatch.length >= 4) {
      nameVal = infoMatch[2] != null ? infoMatch[2] : "";
      picVal = infoMatch[3] != null ? infoMatch[3] : "";
    }
    // 图片 URL 去 {size} 占位
    if (picVal.length > 0) picVal = normalizeKgPic(picVal);
    // 封面兜底：HTML 元信息里 pic 提取不到时，用歌单内第一首歌的封面
    if (picVal.length === 0 && tracks.length > 0 && tracks[0].picUrl.length > 0) {
      picVal = tracks[0].picUrl;
    }
    return {
      id,
      platform: "kg",
      name: nameVal,
      picUrl: picVal,
      playCount: "0",
      description: null,
      tracks,
    };
  },

  /** 蓝本 recommendations kg 分支 :667（getSpecial，c=0 表示全部） */
  async recommendations(
    request: RequestBuiltin,
    category: string | null,
    page: number,
  ): Promise<ContractPlaylist[]> {
    const pageNo = page > 1 ? page : 1;
    const json = await kgRequestJson(
      request,
      "http://www2.kugou.kugou.com/yueku/v9/special/getSpecial" +
        buildQuery({
          c: category != null && category.length > 0 ? category : "0",
          t: "5",
          p: String(pageNo),
          is_ajax: "1",
          cdn: "cdn",
        }),
    );
    const out: ContractPlaylist[] = [];
    for (const entry of asArray(json["special_db"])) {
      out.push(playlistFromKG(asObject(entry)));
    }
    return out;
  },

  /** 蓝本 latest kg 分支 :765（rank/newsong，page 从 offset+1 起） */
  async latest(request: RequestBuiltin, limit: number, offset: number): Promise<MusicInfo[]> {
    const json = await kgRequestJson(
      request,
      "http://mobilecdnbj.kugou.com/api/v3/rank/newsong?version=9108&plat=0&with_cover=1&pagesize=" +
        limit +
        "&type=1&area_code=1&page=" +
        (offset + 1) +
        "&with_res_tag=1",
    );
    const data = asObject(json["data"]);
    const out: MusicInfo[] = [];
    for (const entry of asArray(data["info"])) {
      out.push(songFromKG(asObject(entry)));
    }
    return out;
  },

  /** 蓝本 charts kg 分支 :848（rank/list parentid=0） */
  async charts(request: RequestBuiltin): Promise<ContractChart[]> {
    const json = await kgRequestJson(
      request,
      "http://mobilecdnbj.kugou.com/api/v3/rank/list?version=9108&plat=0&parentid=0&withsong=0",
    );
    const data = asObject(json["data"]);
    const out: ContractChart[] = [];
    for (const entry of asArray(data["info"])) {
      out.push(chartFromKG(asObject(entry)));
    }
    return out;
  },

  /** 蓝本 chartDetail kg 分支 :2250（rank/song ranktype=2 pagesize=200；空时 throw） */
  async chartDetail(request: RequestBuiltin, chart: ContractChart): Promise<MusicInfo[]> {
    const json = await kgRequestJson(
      request,
      "http://mobilecdnbj.kugou.com/api/v3/rank/song" +
        buildQuery({
          version: "9108",
          ranktype: "2",
          plat: "0",
          pagesize: "200",
          area_code: "1",
          page: "1",
          rankid: chart.id,
          with_res_tag: "1",
        }),
    );
    const data = asObject(json["data"]);
    const raw = asArray(data["info"]);
    if (raw.length === 0) throw new Error("酷狗榜单解析失败");
    const out: MusicInfo[] = [];
    for (const entry of raw) {
      out.push(songFromKGRankSong(asObject(entry)));
    }
    return out;
  },

  /** 蓝本 hotWords kg 分支 :1047（search/hot） */
  async hotWords(request: RequestBuiltin): Promise<string[]> {
    const json = await kgRequestJson(
      request,
      "http://mobilecdnbj.kugou.com/api/v3/search/hot?version=9108&plat=0",
    );
    const data = asObject(json["data"]);
    const words: string[] = [];
    for (const entry of asArray(data["info"])) {
      words.push(asString(asObject(entry)["keyword"]));
    }
    return words;
  },

  /** 蓝本 searchPlaylists kg 分支 :1473（search/special）+ playlistFromKG :362 */
  async playlistSearch(
    request: RequestBuiltin,
    keyword: string,
    page: number,
    size: number,
  ): Promise<ContractPlaylist[]> {
    const json = await kgRequestJson(
      request,
      "http://mobilecdnbj.kugou.com/api/v3/search/special" +
        buildQuery({
          version: "9108",
          plat: "0",
          keyword,
          page: String(page),
          pagesize: String(size),
        }),
    );
    const data = asObject(json["data"]);
    const out: ContractPlaylist[] = [];
    for (const entry of asArray(data["info"])) {
      out.push(playlistFromKG(asObject(entry)));
    }
    return out;
  },

  /** 蓝本 searchArtists kg 分支 :1587（search/singer，data 顶层数组）+ artistFromKG :1309 */
  async artistSearch(
    request: RequestBuiltin,
    keyword: string,
    page: number,
    size: number,
  ): Promise<ContractArtist[]> {
    // 酷狗歌手搜索接口是 /api/v3/search/singer（artist 已 404），返回 data 为数组
    const json = await kgRequestJson(
      request,
      "http://mobilecdnbj.kugou.com/api/v3/search/singer" +
        buildQuery({
          version: "9108",
          plat: "0",
          keyword,
          page: String(page),
          pagesize: String(size),
        }),
    );
    const out: ContractArtist[] = [];
    for (const entry of asArray(json["data"])) {
      out.push(artistFromKG(asObject(entry)));
    }
    return out;
  },

  /** 蓝本 searchAlbums kg 分支 :1712（search/album）+ albumFromKG :1325 */
  async albumSearch(
    request: RequestBuiltin,
    keyword: string,
    page: number,
    size: number,
  ): Promise<ContractAlbum[]> {
    const json = await kgRequestJson(
      request,
      "http://mobilecdnbj.kugou.com/api/v3/search/album" +
        buildQuery({
          version: "9108",
          plat: "0",
          keyword,
          page: String(page),
          pagesize: String(size),
        }),
    );
    const data = asObject(json["data"]);
    const out: ContractAlbum[] = [];
    for (const entry of asArray(data["info"])) {
      out.push(albumFromKG(asObject(entry)));
    }
    return out;
  },

  /**
   * 蓝本 albumDetail kg 分支 :1831（v3/album/info + v3/album/song）。
   * 注意参数名是 albumid（无下划线）：写 album_id 会返回 status=0。
   * info.albumname/imgurl/singername → 名称/封面（normalizeKgPic）/描述，
   * song.info → songFromKGCollection，且逐首回填 album 字段。
   */
  async albumDetail(
    request: RequestBuiltin,
    id: string,
  ): Promise<ContractPlaylistDetail> {
    const infoJson = await kgRequestJson(
      request,
      "http://mobilecdnbj.kugou.com/api/v3/album/info" +
        buildQuery({ version: "9108", plat: "0", albumid: id }),
    );
    const info = asObject(infoJson["data"]);
    const songJson = await kgRequestJson(
      request,
      "http://mobilecdnbj.kugou.com/api/v3/album/song" +
        buildQuery({ albumid: id, page: "1", pagesize: "-1" }),
    );
    const songData = asObject(songJson["data"]);
    let nameVal = "";
    let picVal = "";
    let singer = "";
    if (Object.keys(info).length > 0) {
      nameVal = asString(info["albumname"]);
      const img = asString(info["imgurl"]);
      if (img.length > 0) picVal = normalizeKgPic(img);
      singer = asString(info["singername"]);
    }
    const tracks: MusicInfo[] = [];
    for (const entry of asArray(songData["info"])) {
      const song = songFromKGCollection(asObject(entry));
      if (nameVal.length > 0) song.album = nameVal;
      tracks.push(song);
    }
    return {
      id,
      platform: "kg",
      name: nameVal,
      picUrl: picVal,
      playCount: String(tracks.length),
      description: singer.length > 0 ? "艺人：" + singer : null,
      tracks,
    };
  },

  /**
   * 蓝本 videos kg 分支 :960（v5/video/list，img 的 /{size}/ 替换为 /）。
   * 注意：蓝本 directRequest 的形态是「带 query 的 URL + 参数对象」，拼出的是
   * ...plat=0?pagesize=...（双 ?，pagesize 被 plat 吞掉）；PC 基线 provider/kg.rs
   * 按参数对象的本意合成单条 query（?version=9108&plat=0&pagesize=&page=&id=0&sore=4&short=0，
   * sore 拼写照抄蓝本），此处对齐基线。
   */
  async videos(
    request: RequestBuiltin,
    page: number,
    size: number,
  ): Promise<ContractVideo[]> {
    const json = await kgRequestJson(
      request,
      "http://mobilecdnbj.kugou.com/api/v5/video/list" +
        buildQuery({
          version: "9108",
          plat: "0",
          pagesize: String(size),
          page: String(page),
          id: "0",
          sore: "4",
          short: "0",
        }),
    );
    const data = asObject(json["data"]);
    const out: ContractVideo[] = [];
    for (const entry of asArray(data["info"])) {
      const item = asObject(entry);
      out.push({
        id: asString(item["mvhash"]),
        platform: "kg",
        name: asString(item["videoname"]),
        picUrl: asString(item["img"]).replace("/{size}/", "/"),
        singer: asString(item["singername"]),
      });
    }
    return out;
  },

  /**
   * 蓝本 videoUrl kg 分支 :3585（mv.php cmd=100，取 mvdata.le.backupdownurl 首条）。
   * 注意：蓝本 directRequest 把 { hash: id } 拼到带 query 的 URL 后形成双 ?
   * （hash 被 ext 吞掉、永远取不到地址）；PC 基线 provider/kg.rs 合成单条
   * query（?cmd=100&ismp3=1&ext=mp4&hash=<urlencoded>），此处对齐基线。
   */
  async videoUrl(request: RequestBuiltin, id: string, _quality: string): Promise<string> {
    const json = await kgRequestJson(
      request,
      "https://m.kugou.com/app/i/mv.php" +
        buildQuery({ cmd: "100", ismp3: "1", ext: "mp4", hash: id }),
    );
    const mvdata = asObject(json["mvdata"]);
    const le = asObject(mvdata["le"]);
    const urls = asArray(le["backupdownurl"]);
    if (urls.length > 0) return asString(urls[0]);
    throw new Error("该 MV 暂时无法播放");
  },
};
