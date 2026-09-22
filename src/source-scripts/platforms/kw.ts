/**
 * 酷我（kw）平台模块 —— 蓝本移植。
 *
 * 逻辑逐段对照 qt-uniappx services/music-api.ts / http.ts：
 * - search            :1121（www/search/searchMusicBykeyWord 免鉴权老接口，source="wyy" 直连）+ songFromKWSearch :331
 * - musicUrlCore      :3444 fetchKwCore（getKwUrlByEncode → kwMobiText http.ts:620 → kwExtractMobiUrl :78；
 *                      kwBrParam :3354：128→"1"/320→"2"/flac→"3"）
 * - lyric             :3048（musicId 优先，"nohash" 占位/空回退 song.id）+ fetchKwLyricText :2987（openapi lrclist 拼 LRC）
 * - lyricTranslation  :3173（kw 返回空串）
 * - playlistCategories:546（getTagList 两层展开）
 * - playlistDetail    :2844（www/playlist/playListInfo 分页 rn=30 + 封面 img→pic 回退 + nplserver pl.svc 兜底）
 * - recommendations   :625（有 category 走 getTagPlayList，无 category 走 rcm/index/playlist 带 Date.now() 防缓存）
 *                      + playlistFromKW :270
 * - latest            :735（bang/bang/musicList bangId=17 分页取足量）+ songFromKW :301
 * - charts            :827（bang/bang/bangMenu 按 category.list 两层展开）+ chartFromKW :424
 * - chartDetail       :2223（bang/bang/musicList 翻页 rn=30 最多 20 页）
 * - hotWords          :1031（www/search/searchKey）
 * - playlistSearch    :1449（www/search/searchPlayListBykeyWord）
 * - artistSearch      :1563（www/search/searchArtistBykeyWord）+ artistFromKW :1281
 * - albumSearch       :1688（www/search/searchAlbumBykeyWord，data.albumList）+ albumFromKW :1294
 * - albumDetail       :1796（www/album/albumInfo，albumId + reqId abi；musicList → songFromKW）
 * - videos            :937（www/music/mvList pid=236682871）
 * - videoUrl          :3571（www/music/playUrl type=mv，quality 不参与）
 * - assertKwOk :289 / kwNumberValue :61 / kwFormatTime :67
 *
 * 请求分派：蓝本 directRequest(source="kw") 的鉴权请求走 kw-auth.ts 的 kuwoRequest
 * （Cookie/Secret + 失败重试一次）；蓝本传 source="wyy" 的免鉴权请求（歌曲搜索）
 * 走 utils.requestJson + platformHeaders("wyy")。
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
import {
  asArray,
  asNumber,
  asObject,
  asString,
  buildQuery,
  platformHeaders,
  requestJson,
} from "./utils";
import { kuwoRequest } from "./kw-auth";
import { getKwUrlByEncode } from "./kw-des";

/** 蓝本 kwBrParam（quality → mobi.s 明文里的 br 档位）:3354 */
function kwBrParam(quality: Quality): string {
  if (quality === "128") return "1";
  if (quality === "320") return "2";
  return "3";
}

/** 蓝本 kwNumberValue :61 */
function kwNumberValue(value: unknown): number {
  if (value == null) return 0;
  return parseFloat(value.toString()) ?? 0;
}

/** 蓝本 kwFormatTime :67（秒 → mm:ss.xx，与 QTmusic_nuve transformLrc 的 formatTime 一致） */
function kwFormatTime(time: number): string {
  const m: number = Math.floor(time / 60);
  const sec: number = time % 60;
  const seconds: string = sec.toFixed(2);
  let mm = m < 10 ? "0" + m.toString() : m.toString();
  let ss = seconds;
  if (sec < 10) ss = "0" + seconds;
  return mm + ":" + ss;
}

/** 蓝本 kwExtractMobiUrl :78（兼容多种 mobi.s 返回格式，尽可能提取可播放 URL） */
function kwExtractMobiUrl(text: string): string {
  if (text == null) return "";
  let after = "";
  const marker = "url=";
  let start = text.indexOf(marker);
  if (start >= 0) {
    after = text.substring(start + marker.length);
  } else {
    const jsonMarker = '"url"';
    start = text.indexOf(jsonMarker);
    if (start >= 0) {
      const colon = text.indexOf(":", start);
      if (colon < 0) return "";
      after = text.substring(colon + 1);
    } else {
      start = text.indexOf("http");
      if (start < 0) return "";
      after = text.substring(start);
    }
  }
  after = after.trim();
  // 去掉起始引号 / 花括号
  while (after.length > 0 && (after.charAt(0) == '"' || after.charAt(0) == "'" || after.charAt(0) == "{")) {
    after = after.substring(1);
  }
  if (after.length == 0) return "";
  // 截断到第一个终止符（? & 空格 引号 逗号 花括号）
  let end = after.length;
  const terms = ["?", "&", " ", '"', "'", ",", "}", ";"];
  for (let t = 0; t < terms.length; t++) {
    const idx = after.indexOf(terms[t]);
    if (idx >= 0 && idx < end) end = idx;
  }
  const url = after.substring(0, end);
  if (url.indexOf("http") != 0) return "";
  return url;
}

/** 蓝本 kwMobiText（http.ts:620）：mobi.s 文本请求，仅带 okhttp UA */
async function kwMobiText(request: RequestBuiltin, url: string): Promise<string> {
  const response = await request(url, {
    method: "GET",
    headers: { "User-Agent": "okhttp/3.10.0" },
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error("HTTP " + response.statusCode);
  }
  // 蓝本 resolve(response.data as string)：宿主已尝试 JSON 解析、失败才给原样字符串；
  // 若 mobi.s 回了可解析的 JSON 体，蓝本两运行时均拿不到文本（null → 视为失败），此处等价返回 ""
  return typeof response.body == "string" ? response.body : "";
}

/**
 * 蓝本 assertKwOk :289：酷我接口成功返回 { code: 200 }（部分接口另带 success:true），
 * 失败返回 { success: false, message } 或 code != 200，统一在此校验抛错。
 */
function assertKwOk(response: Record<string, unknown>): void {
  const code = response["code"];
  const success = response["success"];
  const failed =
    (code != null && String(code) != "200") ||
    (success != null && !success);
  if (failed) {
    const message = response["message"];
    throw new Error(message != null ? asString(message) : "酷我接口请求失败");
  }
}

/** 蓝本 playlistFromKW :270（img/listencnt 字段） */
function playlistFromKW(item: Record<string, unknown>): ContractPlaylist {
  return {
    id: asString(item["id"]),
    platform: "kw",
    name: asString(item["name"]),
    picUrl: asString(item["img"]),
    playCount: asString(item["listencnt"]),
  };
}

/** 蓝本 songFromKW :301（rid 播放 / musicrid 歌词，双 id 并存单独保存） */
function songFromKW(item: Record<string, unknown>): MusicInfo {
  const id = asString(item["rid"]);
  const name = asString(item["name"]);
  const singer = asString(item["artist"]);
  const album = asString(item["album"]);
  const picUrl = asString(item["pic"]);
  const durationVal = item["duration"];
  const duration = durationVal != null ? asNumber(durationVal) : 0;
  // kuwo 数据同时携带旧 rid 与新 DC 体系的 musicrid（如 "MUSIC_193290598"）。
  // 播放走 mobi.s 用 rid，歌词 openapi 只认 musicrid 对应的新 id，这里单独保存。
  const musicrid = asString(item["musicrid"]);
  const musicId =
    musicrid.indexOf("MUSIC_") == 0 ? musicrid.substring(6) : "";
  const song: MusicInfo = {
    id,
    name,
    singer,
    album,
    picUrl,
    interval: duration,
  };
  if (musicId.length > 0) song.musicId = musicId;
  return song;
}

/**
 * 蓝本 songFromKWSearch :331：老接口 /search/searchMusicBykeyWord 的 abslist 项解析
 * （字段全部大写；封面 web_albumpic_short 把 120 尺寸替换为 320）。
 */
function songFromKWSearch(item: Record<string, unknown>): MusicInfo {
  const id = asString(item["DC_TARGETID"]);
  const name = asString(item["NAME"]);
  const singer = asString(item["ARTIST"]);
  const album = asString(item["ALBUM"]);
  const durationVal = item["DURATION"];
  const duration = durationVal != null ? parseInt(asString(durationVal), 10) || 0 : 0;
  const musicrid = asString(item["MUSICRID"]);
  // 封面：web_albumpic_short 形如 "120/s3s94/93/xxx.jpg"，替换为 320 尺寸
  const picShort = asString(item["web_albumpic_short"]);
  let picUrl = "";
  if (picShort.length > 0) {
    picUrl = "https://img1.kuwo.cn/star/albumcover/" + picShort.replace("120/", "320/");
  }
  const musicId =
    musicrid.indexOf("MUSIC_") == 0 ? musicrid.substring(6) : "";
  const song: MusicInfo = {
    id,
    name,
    singer,
    album,
    picUrl,
    interval: duration,
  };
  if (musicId.length > 0) song.musicId = musicId;
  return song;
}

/** 蓝本 chartFromKW :424（sourceid/pic/intro 字段） */
function chartFromKW(item: Record<string, unknown>): ContractChart {
  return {
    id: asString(item["sourceid"]),
    platform: "kw",
    name: asString(item["name"]),
    picUrl: asString(item["pic"]),
    description: asString(item["intro"]),
  };
}

/** 蓝本 artistFromKW :1281 */
function artistFromKW(item: Record<string, unknown>): ContractArtist {
  return {
    id: asString(item["id"]),
    platform: "kw",
    name: asString(item["name"]),
    picUrl: asString(item["pic"]),
  };
}

/** 蓝本 albumFromKW :1294 */
function albumFromKW(item: Record<string, unknown>): ContractAlbum {
  return {
    id: asString(item["albumid"]),
    platform: "kw",
    name: asString(item["album"]),
    artist: asString(item["artist"]),
    picUrl: asString(item["pic"]),
  };
}

/** 蓝本 fetchKwLyricText :2987（酷我 openapi 歌词，lrclist 拼成 LRC 文本；取不到返回空串） */
async function fetchKwLyricText(
  request: RequestBuiltin,
  musicId: string,
): Promise<string> {
  const response = await kuwoRequest(
    request,
    "https://kuwo.cn/openapi/v1/www/lyric/getlyric" +
      buildQuery({ musicId, httpsStatus: "1" }),
    "GET",
  );
  const data = asObject(response["data"]);
  const lrclist = asArray(data["lrclist"]);
  let text = "";
  for (const entry of lrclist) {
    const item = asObject(entry);
    const time = item["time"];
    const line = item["lineLyric"];
    if (time != null && line != null) {
      text += "[" + kwFormatTime(kwNumberValue(time)) + "]" + asString(line) + "\n";
    }
  }
  return text;
}

export const kw = {
  /** 蓝本 search kw 分支 :1121（免鉴权老接口，蓝本传 source="wyy" 即无鉴权直连） */
  async search(
    request: RequestBuiltin,
    keyword: string,
    page: number,
    size: number,
  ): Promise<MusicInfo[]> {
    // 酷我歌曲搜索走免鉴权老接口（/search/ 路径），
    // 新版 api/www/search/searchMusicBykeyWord 即使带正确 Cookie/Secret 也只返回空壳（无 data），已废弃。
    const query =
      "?all=" +
      encodeURIComponent(keyword) +
      "&pn=" +
      (page - 1) +
      "&rn=" +
      size +
      "&vipver=1&client=kt&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&mobi=1&issubtitle=1&show_copyright_off=1";
    const json = await requestJson(
      request,
      "https://www.kuwo.cn/search/searchMusicBykeyWord" + query,
      { headers: platformHeaders("wyy") },
    );
    const out: MusicInfo[] = [];
    for (const entry of asArray(json["abslist"])) {
      out.push(songFromKWSearch(asObject(entry)));
    }
    return out;
  },

  /** 蓝本 fetchKwCore :3444（DES 生成 mobi.s 链接 → 文本抠 URL；空串 = 失败） */
  async musicUrlCore(
    request: RequestBuiltin,
    song: MusicInfo,
    quality: Quality,
  ): Promise<string> {
    try {
      const mobiUrl = getKwUrlByEncode(song.id, kwBrParam(quality));
      const text = await kwMobiText(request, mobiUrl);
      if (text.length > 0) {
        const songUrl = kwExtractMobiUrl(text);
        if (songUrl.length > 0) return songUrl;
      }
    } catch {
      // 蓝本同语义：解析失败仅返回空串，不抛错（跨源兜底由上层负责）
    }
    return "";
  },

  /** 蓝本 lyrics kw 分支 :3048 */
  async lyric(request: RequestBuiltin, song: MusicInfo): Promise<string> {
    // 酷我播放走 song.id（旧 rid，getKwUrlByEncode 用它能成功），说明 song.id 是正确的。
    // 歌词 openapi 优先用新 DC id（musicrid 数字部分，即 song.musicId）；
    // 但若 musicId 是占位值 "nohash" 或为空，就回退到播放真正能用的 song.id，而不是拿占位值去请求。
    const rawMusicId =
      song.musicId != null &&
      song.musicId.length > 0 &&
      song.musicId.toLowerCase() != "nohash"
        ? song.musicId
        : song.id;
    if (rawMusicId.length == 0) return "";
    const musicId = rawMusicId.replace("MUSIC_", "");
    return fetchKwLyricText(request, musicId);
  },

  /** 蓝本 lyricTranslation kw 分支 :3173（非 wyy/local 一律返回空串） */
  async lyricTranslation(
    _request: RequestBuiltin,
    _song: MusicInfo,
  ): Promise<string> {
    return "";
  },

  /** 蓝本 playlistCategories kw 分支 :546（data 两层展开，id/name 均在才收录） */
  async playlistCategories(request: RequestBuiltin): Promise<ContractPlaylistCategory[]> {
    const json = await kuwoRequest(
      request,
      "https://kuwo.cn/api/www/playlist/getTagList?httpsStatus=1",
      "GET",
    );
    const categories: ContractPlaylistCategory[] = [];
    for (const groupEntry of asArray(json["data"])) {
      for (const itemEntry of asArray(asObject(groupEntry)["data"])) {
        const item = asObject(itemEntry);
        const id = item["id"];
        const name = item["name"];
        if (id == null || name == null) continue;
        categories.push({ id: asString(id), name: asString(name), group: null });
      }
    }
    return categories;
  },

  /** 蓝本 playlist kw 分支 :2844（首页不 catch；翻页每页 catch 即止；封面走 nplserver 兜底） */
  async playlistDetail(
    request: RequestBuiltin,
    id: string,
  ): Promise<ContractPlaylistDetail> {
    const songs: MusicInfo[] = [];
    const rn = 30;
    const first = await kuwoRequest(
      request,
      "https://www.kuwo.cn/api/www/playlist/playListInfo" +
        buildQuery({ pid: id, pn: "1", rn: String(rn), httpsStatus: "1" }),
      "GET",
    );
    const data = asObject(first["data"]);
    const total = asNumber(data["total"]);
    const nameVal = asString(data["name"]);
    // www 接口封面字段为 img（部分歌单/鉴权失败时为空），回退 pic；都空再试 nplserver 兜底
    let picVal = asString(data["img"]);
    if (picVal.length == 0) picVal = asString(data["pic"]);
    let countVal = data["listencnt"] != null ? asString(data["listencnt"]) : "0";
    for (const entry of asArray(data["musicList"])) {
      songs.push(songFromKW(asObject(entry)));
    }
    const maxPages = total > 0 ? Math.ceil(total / rn) : 30;
    let page = 1;
    while (page < maxPages) {
      page++;
      try {
        const resp = await kuwoRequest(
          request,
          "https://www.kuwo.cn/api/www/playlist/playListInfo" +
            buildQuery({ pid: id, pn: String(page), rn: String(rn), httpsStatus: "1" }),
          "GET",
        );
        const d = asObject(resp["data"]);
        const list = asArray(d["musicList"]);
        if (list.length == 0) break;
        for (const entry of list) songs.push(songFromKW(asObject(entry)));
      } catch {
        break;
      }
      if (total > 0 && songs.length >= total) break;
    }
    // 封面兜底：www 接口 img/pic 都为空时，用 nplserver pl.svc 的 pic（老项目方案）
    if (picVal.length == 0) {
      try {
        const npl = await kuwoRequest(
          request,
          "https://nplserver.kuwo.cn/pl.svc?op=getlistinfo&encode=utf8&keyset=pl2012&identity=kuwo&pcmp4=1&vipver=MUSIC_9.0.5.0_W1&newver=1" +
            buildQuery({ pid: id, pn: "0", rn: "1" }),
          "GET",
        );
        if (asString(npl["result"]) == "ok") {
          const npic = asString(npl["pic"]);
          if (npic.length > 0) picVal = npic;
        }
      } catch {
        // 兜底失败不阻塞详情返回
      }
    }
    return {
      id,
      platform: "kw",
      name: nameVal,
      picUrl: picVal,
      playCount: countVal,
      description: null,
      tracks: songs,
    };
  },

  /** 蓝本 recommendations kw 分支 :625（getTagPlayList / rcm+时间戳防缓存）+ assertKwOk */
  async recommendations(
    request: RequestBuiltin,
    category: string | null,
    page: number,
  ): Promise<ContractPlaylist[]> {
    const pageSize = 30;
    const pageNo = page > 1 ? page : 1;
    if (category != null && category.length > 0) {
      const json = await kuwoRequest(
        request,
        "https://kuwo.cn/api/www/classify/playlist/getTagPlayList" +
          buildQuery({
            id: category,
            rn: String(pageSize),
            pn: String(pageNo),
            httpsStatus: "1",
          }),
        "GET",
      );
      assertKwOk(json);
      const data = asObject(json["data"]);
      const out: ContractPlaylist[] = [];
      for (const entry of asArray(data["data"])) {
        out.push(playlistFromKW(asObject(entry)));
      }
      return out;
    }
    // 推荐接口：显式拼接查询字符串，确保 pn 参数一定发送
    // 加时间戳破坏缓存，防止 App 内第二页返回第一页数据
    const recUrl =
      "https://www.kuwo.cn/api/www/rcm/index/playlist?rn=" +
      pageSize +
      "&pn=" +
      pageNo +
      "&id=rec&httpsStatus=1&_=" +
      Date.now();
    const json = await kuwoRequest(request, recUrl, "GET");
    assertKwOk(json);
    const data = asObject(json["data"]);
    const out: ContractPlaylist[] = [];
    for (const entry of asArray(data["list"])) {
      try {
        out.push(playlistFromKW(asObject(entry)));
      } catch {
        // 单条数据解析失败不影响整体分页
      }
    }
    return out;
  },

  /** 蓝本 latest kw 分支 :735（酷我新歌榜：bang/musicList 分页取足量，每榜只给 8 首） */
  async latest(request: RequestBuiltin, limit: number, offset: number): Promise<MusicInfo[]> {
    const songs: MusicInfo[] = [];
    const rn = 30;
    let page = offset > 0 ? Math.ceil(offset / rn) + 1 : 1;
    let needed = limit;
    let safePages = 0;
    while (needed > 0 && safePages < 20) {
      safePages++;
      try {
        const json = await kuwoRequest(
          request,
          "https://kuwo.cn/api/www/bang/bang/musicList?bangId=17&pn=" +
            page +
            "&rn=" +
            rn +
            "&httpsStatus=1",
          "GET",
        );
        const data = asObject(json["data"]);
        const list = asArray(data["musicList"]);
        if (list.length == 0) break;
        for (let index = 0; index < list.length && needed > 0; index++) {
          songs.push(songFromKW(asObject(list[index])));
          needed--;
        }
      } catch {
        break;
      }
      page++;
    }
    return songs;
  },

  /** 蓝本 charts kw 分支 :827（bangMenu 按 category.list 两层展开）+ chartFromKW :424 */
  async charts(request: RequestBuiltin): Promise<ContractChart[]> {
    const json = await kuwoRequest(
      request,
      "https://kuwo.cn/api/www/bang/bang/bangMenu?httpsStatus=1",
      "GET",
    );
    const out: ContractChart[] = [];
    for (const groupEntry of asArray(json["data"])) {
      const category = asObject(groupEntry);
      for (const listEntry of asArray(category["list"])) {
        out.push(chartFromKW(asObject(listEntry)));
      }
    }
    return out;
  },

  /** 蓝本 chartDetail kw 分支 :2223（bang/musicList 翻页 rn=30 最多 20 页，不足一页即止） */
  async chartDetail(request: RequestBuiltin, chart: ContractChart): Promise<MusicInfo[]> {
    const songs: MusicInfo[] = [];
    const rn = 30;
    let page = 1;
    let safe = 0;
    while (safe < 20) {
      safe++;
      try {
        const json = await kuwoRequest(
          request,
          "https://kuwo.cn/api/www/bang/bang/musicList?bangId=" +
            chart.id +
            "&pn=" +
            page +
            "&rn=" +
            rn +
            "&httpsStatus=1",
          "GET",
        );
        const data = asObject(json["data"]);
        const list = asArray(data["musicList"]);
        if (list.length == 0) break;
        for (const entry of list) songs.push(songFromKW(asObject(entry)));
        if (list.length < rn) break;
      } catch {
        break;
      }
      page++;
    }
    return songs;
  },

  /** 蓝本 hotWords kw 分支 :1031（www/search/searchKey，kw 鉴权请求） */
  async hotWords(request: RequestBuiltin): Promise<string[]> {
    const json = await kuwoRequest(
      request,
      "https://www.kuwo.cn/api/www/search/searchKey",
      "GET",
    );
    const data = asObject(json["data"]);
    const words: string[] = [];
    for (const entry of asArray(data["list"])) {
      words.push(asString(asObject(entry)["keyword"]));
    }
    return words;
  },

  /** 蓝本 searchPlaylists kw 分支 :1449（searchPlayListBykeyWord，reqId 带 pl 后缀） */
  async playlistSearch(
    request: RequestBuiltin,
    keyword: string,
    page: number,
    size: number,
  ): Promise<ContractPlaylist[]> {
    const json = await kuwoRequest(
      request,
      "https://www.kuwo.cn/api/www/search/searchPlayListBykeyWord" +
        buildQuery({
          key: keyword,
          pn: String(page),
          rn: String(size),
          httpsStatus: "1",
          reqId: Date.now().toString() + "pl",
        }),
      "GET",
    );
    const data = asObject(json["data"]);
    const out: ContractPlaylist[] = [];
    for (const entry of asArray(data["list"])) {
      out.push(playlistFromKW(asObject(entry)));
    }
    return out;
  },

  /** 蓝本 searchArtists kw 分支 :1563（searchArtistBykeyWord，reqId 带 at 后缀）+ artistFromKW :1281 */
  async artistSearch(
    request: RequestBuiltin,
    keyword: string,
    page: number,
    size: number,
  ): Promise<ContractArtist[]> {
    const json = await kuwoRequest(
      request,
      "https://www.kuwo.cn/api/www/search/searchArtistBykeyWord" +
        buildQuery({
          key: keyword,
          pn: String(page),
          rn: String(size),
          httpsStatus: "1",
          reqId: Date.now().toString() + "at",
        }),
      "GET",
    );
    const data = asObject(json["data"]);
    const out: ContractArtist[] = [];
    for (const entry of asArray(data["list"])) {
      out.push(artistFromKW(asObject(entry)));
    }
    return out;
  },

  /** 蓝本 searchAlbums kw 分支 :1688（searchAlbumBykeyWord，data.albumList，reqId 带 al 后缀）+ albumFromKW :1294 */
  async albumSearch(
    request: RequestBuiltin,
    keyword: string,
    page: number,
    size: number,
  ): Promise<ContractAlbum[]> {
    const json = await kuwoRequest(
      request,
      "https://www.kuwo.cn/api/www/search/searchAlbumBykeyWord" +
        buildQuery({
          key: keyword,
          pn: String(page),
          rn: String(size),
          httpsStatus: "1",
          reqId: Date.now().toString() + "al",
        }),
      "GET",
    );
    const data = asObject(json["data"]);
    const out: ContractAlbum[] = [];
    for (const entry of asArray(data["albumList"])) {
      out.push(albumFromKW(asObject(entry)));
    }
    return out;
  },

  /**
   * 蓝本 albumDetail kw 分支 :1796（www/album/albumInfo，albumId 入参，
   * reqId 带 abi 后缀；data.musicList → songFromKW，描述 = 艺人：{artist}）
   */
  async albumDetail(
    request: RequestBuiltin,
    id: string,
  ): Promise<ContractPlaylistDetail> {
    const json = await kuwoRequest(
      request,
      "https://www.kuwo.cn/api/www/album/albumInfo" +
        buildQuery({
          albumId: id,
          pn: "1",
          rn: "100",
          httpsStatus: "1",
          reqId: Date.now().toString() + "abi",
        }),
      "GET",
    );
    assertKwOk(json);
    const data = asObject(json["data"]);
    if (Object.keys(data).length === 0) throw new Error("专辑信息为空");
    const tracks: MusicInfo[] = [];
    for (const entry of asArray(data["musicList"])) {
      tracks.push(songFromKW(asObject(entry)));
    }
    const artist = asString(data["artist"]);
    return {
      id,
      platform: "kw",
      name: asString(data["name"]),
      picUrl: asString(data["pic"]),
      playCount: String(tracks.length),
      description: artist.length > 0 ? "艺人：" + artist : null,
      tracks,
    };
  },

  /** 蓝本 videos kw 分支 :937（www/music/mvList，固定歌单 pid=236682871） */
  async videos(
    request: RequestBuiltin,
    page: number,
    size: number,
  ): Promise<ContractVideo[]> {
    const json = await kuwoRequest(
      request,
      "https://www.kuwo.cn/api/www/music/mvList" +
        buildQuery({ pn: String(page), rn: String(size), pid: "236682871" }),
      "GET",
    );
    const data = asObject(json["data"]);
    const out: ContractVideo[] = [];
    for (const entry of asArray(data["mvlist"])) {
      const item = asObject(entry);
      out.push({
        id: asString(item["id"]),
        platform: "kw",
        name: asString(item["name"]),
        picUrl: asString(item["pic"]),
        singer: asString(item["artist"]),
      });
    }
    return out;
  },

  /** 蓝本 videoUrl kw 分支 :3571（www/music/playUrl type=mv；kw 不区分清晰度） */
  async videoUrl(
    request: RequestBuiltin,
    id: string,
    _quality: string,
  ): Promise<string> {
    const json = await kuwoRequest(
      request,
      "https://www.kuwo.cn/api/v1/www/music/playUrl?type=mv&httpsStatus=1" +
        buildQuery({ mid: id }),
      "GET",
    );
    const data = asObject(json["data"]);
    const url = asString(data["url"]);
    if (url.length > 0) return url;
    throw new Error("该 MV 暂时无法播放");
  },
};
