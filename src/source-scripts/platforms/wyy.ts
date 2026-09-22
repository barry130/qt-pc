/**
 * 网易云（wyy）平台模块 —— 蓝本移植。
 *
 * 逻辑逐段对照 qt-uniappx services/music-api.ts：
 * - search         :1090（cloudsearch/pc）+ songFromWyy :194 / songFromWyyDetail :2079
 * - musicUrlCore   :3381 fetchWyyCore（gdstudio 代理 → 官方 enhance/player/url）
 * - lyric          :3012（api/song/lyric）/ lyricTranslation :3173
 * - playlistCategories :494（highquality/tags）
 * - playlistDetail :2752（v6/playlist/detail + v3/song/detail 批量）
 * - recommendations :686（api/playlist/list）
 * - latest         :786（v1/discovery/new/songs）
 * - charts         :798（api/toplist）+ chartFromWyy :397
 * - chartDetail    :2183（v6/playlist/detail n=500）
 * - hotWords       :1052（api/search/hot）
 * - playlistSearch :1488（api/search/get type=1000）
 * - artistSearch   :1585（api/search/get type=100）
 * - albumSearch    :1725（api/search/get type=10）
 * - albumDetail     :1888（api/v1/album/{id}；album.name/picUrl/briefDesc + songs）
 * - videos         :984（interface.music.163.com/api/mv/all）
 * - videoUrl       :3604（song/enhance/play/mv/url，http→https）
 */
import type {
  ContractAlbum,
  ContractArtist,
  ContractArtistPage,
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

const WYY_HEADERS = platformHeaders("wyy");

/** gdstudio 代理单次请求上限：挂死时快速放行给官方接口（见 musicUrlCore 注释） */
const GDSTUDIO_TIMEOUT_MS = 4000;

/** 蓝本 wyyBrValue（quality → enhance/player/url 的 br） */
function wyyBrValue(quality: Quality): number {
  if (quality === "128") return 128000;
  if (quality === "flac") return 999000;
  return 320000;
}

/** 蓝本 wyyBrParam（quality → gdstudio 代理的 br：128/320/999） */
function wyyBrParam(quality: Quality): string {
  if (quality === "128") return "128";
  if (quality === "320") return "320";
  return "999";
}

/** 蓝本 songFromWyy :194（cloudsearch：ar/al 字段，兼容老接口 artists/album） */
function songFromWyy(item: Record<string, unknown>): MusicInfo {
  const songData = asObject(item["song"]);
  const merged = Object.keys(songData).length > 0 ? songData : item;
  const artistList = asArray(merged["artists"]);
  const arList = asArray(merged["ar"]);
  const finalArtists = artistList.length > 0 ? artistList : arList;
  const albumData = asObject(merged["album"]).id !== undefined ? asObject(merged["album"]) : asObject(merged["al"]);
  const firstArtist = finalArtists.length > 0 ? asObject(finalArtists[0]) : {};
  const albumObj = Object.keys(albumData).length > 0 ? albumData : {};
  const cover = asString(item["picUrl"]);
  const albumCover = asString(albumObj["picUrl"]);
  return {
    id: asString(item["id"]),
    name: asString(item["name"]),
    singer: asString(firstArtist["name"]),
    album: asString(albumObj["name"]),
    picUrl: cover.length > 0 ? cover : albumCover,
    interval:
      merged["duration"] !== undefined
        ? asNumber(merged["duration"]) / 1000
        : merged["dt"] !== undefined
          ? asNumber(merged["dt"]) / 1000
          : 0,
  };
}

/** 蓝本 songFromWyyDetail :2079（detail 接口 ar/al/dt 字段） */
function songFromWyyDetail(item: Record<string, unknown>): MusicInfo {
  const arList = asArray(item["ar"]);
  const al = asObject(item["al"]);
  const firstArtist = arList.length > 0 ? asObject(arList[0]) : {};
  return {
    id: asString(item["id"]),
    name: asString(item["name"]),
    singer: asString(firstArtist["name"]),
    album: asString(al["name"]),
    picUrl: asString(al["picUrl"]),
    interval: item["dt"] !== undefined ? asNumber(item["dt"]) / 1000 : 0,
  };
}

/** 蓝本 wyySongDetail :2129（v3/song/detail，POST c=[{id}]，>300 拆批） */
async function wyySongDetail(request: RequestBuiltin, ids: string[]): Promise<MusicInfo[]> {
  const batchSize = 300;
  const all: MusicInfo[] = [];
  for (let start = 0; start < ids.length; start += batchSize) {
    const batch = ids.slice(start, start + batchSize);
    const c = batch.map((x) => '{"id":' + x + "}").join(",");
    const body = await requestJson(
      request,
      "https://music.163.com/api/v3/song/detail",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: "https://music.163.com/",
        },
        body: "c=[" + c + "]",
      },
    ).catch(() => null);
    if (body === null) continue;
    for (const entry of asArray(body["songs"])) {
      all.push(songFromWyyDetail(asObject(entry)));
    }
  }
  return all;
}

export const wyy = {
  /** 蓝本 search wyy 分支 :1180 */
  async search(
    request: RequestBuiltin,
    keyword: string,
    page: number,
    size: number,
  ): Promise<MusicInfo[]> {
    const json = await requestJson(
      request,
      "https://music.163.com/api/cloudsearch/pc" +
        buildQuery({
          s: keyword,
          type: "1",
          offset: String((page - 1) * size),
          limit: String(size),
        }),
      { headers: WYY_HEADERS },
    );
    const result = asObject(json["result"]);
    const out: MusicInfo[] = [];
    for (const entry of asArray(result["songs"])) {
      out.push(songFromWyy(asObject(entry)));
    }
    return out;
  },

  /** 蓝本 fetchWyyCore :3381（gdstudio 代理 → 官方接口；空串 = 失败） */
  async musicUrlCore(
    request: RequestBuiltin,
    song: MusicInfo,
    quality: Quality,
  ): Promise<string> {
    // QTmusic_nuve 同款第三方网易云接口（gdstudio），能获取 VIP/无版权歌的播放地址。
    // 必须自带短超时：该站上游挂掉时是「连接挂死 ~20s 才回 522」（2026-09-18 实测），
    // 而官方接口只要 0.2s——不设超时会把整条链拖过引擎 15s 取链预算，
    // 免费歌也变成「无可用播放地址」。
    try {
      const proxyUrl =
        "https://music-api.gdstudio.xyz/api.php?types=url&source=netease&id=" +
        encodeURIComponent(song.id) +
        "&br=" +
        wyyBrParam(quality);
      const proxyRes = await request(proxyUrl, {
        headers: WYY_HEADERS,
        timeoutMs: GDSTUDIO_TIMEOUT_MS,
      });
      const proxyBody = asObject(proxyRes.body);
      const proxyUrlValue = asString(proxyBody["url"]);
      if (proxyUrlValue.length > 0) return proxyUrlValue;
    } catch {
      // 代理失败继续官方
    }
    // 官方接口（仅对未限制歌曲有效）
    try {
      const json = await requestJson(
        request,
        "https://music.163.com/api/song/enhance/player/url" +
          buildQuery({
            id: song.id,
            ids: "[" + song.id + "]",
            br: String(wyyBrValue(quality)),
          }),
        { headers: WYY_HEADERS },
      );
      const data = asArray(json["data"]);
      if (data.length > 0) {
        const url = asString(asObject(data[0])["url"]);
        if (url.length > 0) return url;
      }
    } catch {
      // 官方也失败
    }
    return "";
  },

  /** 蓝本 lyrics wyy 分支 :3012 */
  async lyric(request: RequestBuiltin, song: MusicInfo): Promise<string> {
    const json = await requestJson(
      request,
      "https://music.163.com/api/song/lyric" +
        buildQuery({ id: song.id, lv: "-1", kv: "-1", tv: "-1" }),
      { headers: WYY_HEADERS },
    );
    return asString(asObject(json["lrc"])["lyric"]);
  },

  /** 蓝本 lyricTranslation wyy 分支 :3173（tlyric） */
  async lyricTranslation(request: RequestBuiltin, song: MusicInfo): Promise<string> {
    const json = await requestJson(
      request,
      "https://music.163.com/api/song/lyric" +
        buildQuery({ id: song.id, lv: "-1", kv: "-1", tv: "-1" }),
      { headers: WYY_HEADERS },
    );
    return asString(asObject(json["tlyric"])["lyric"]);
  },

  /** 蓝本 playlistCategories wyy 分支 :494（按分类名筛选，id 即名称） */
  async playlistCategories(request: RequestBuiltin): Promise<ContractPlaylistCategory[]> {
    const json = await requestJson(
      request,
      "https://music.163.com/api/playlist/highquality/tags",
      { headers: WYY_HEADERS },
    );
    const categories: ContractPlaylistCategory[] = [];
    for (const entry of asArray(json["tags"])) {
      const name = asString(asObject(entry)["name"]);
      if (name.length === 0) continue;
      categories.push({ id: name, name, group: null });
    }
    return categories;
  },

  /** 蓝本 playlist wyy 分支 :2752（trackIds 全量 + 1000/批 detail；回退 tracks） */
  async playlistDetail(
    request: RequestBuiltin,
    id: string,
  ): Promise<ContractPlaylistDetail> {
    const json = await requestJson(
      request,
      "https://music.163.com/api/v6/playlist/detail" + buildQuery({ id, n: "100000" }),
      { headers: WYY_HEADERS },
    );
    const pl = asObject(json["playlist"]);
    const songIds: string[] = [];
    for (const entry of asArray(pl["trackIds"])) {
      const sid = asString(asObject(entry)["id"]);
      if (sid.length > 0) songIds.push(sid);
    }
    let tracks: MusicInfo[] = [];
    if (songIds.length > 0) {
      tracks = await wyySongDetail(request, songIds);
    }
    if (tracks.length === 0) {
      for (const entry of asArray(pl["tracks"])) {
        tracks.push(songFromWyyDetail(asObject(entry)));
      }
    }
    return {
      id,
      platform: "wyy",
      name: asString(pl["name"]),
      picUrl: asString(pl["coverImgUrl"]),
      playCount: pl["playCount"] !== undefined ? asString(pl["playCount"]) : "0",
      description: null,
      tracks,
    };
  },

  /** 蓝本 recommendations wyy 分支 :686 */
  async recommendations(
    request: RequestBuiltin,
    category: string | null,
    page: number,
  ): Promise<ContractPlaylist[]> {
    const json = await requestJson(
      request,
      "https://music.163.com/api/playlist/list" +
        buildQuery({
          cat: category !== null && category.length > 0 ? category : "全部",
          limit: "30",
          offset: String((page - 1) * 30),
          total: "true",
        }),
      { headers: WYY_HEADERS },
    );
    const out: ContractPlaylist[] = [];
    for (const entry of asArray(json["playlists"])) {
      const item = asObject(entry);
      out.push({
        id: asString(item["id"]),
        platform: "wyy",
        name: asString(item["name"]),
        picUrl: asString(item["coverImgUrl"]),
        playCount: asString(item["playCount"]),
      });
    }
    return out;
  },

  /** 蓝本 latest wyy 分支 :786 */
  async latest(request: RequestBuiltin, limit: number, offset: number): Promise<MusicInfo[]> {
    const json = await requestJson(
      request,
      "https://music.163.com/api/v1/discovery/new/songs" +
        buildQuery({ limit: String(limit), offset: String(offset), total: "true", areaId: "0" }),
      { headers: WYY_HEADERS },
    );
    const out: MusicInfo[] = [];
    for (const entry of asArray(json["data"])) {
      out.push(songFromWyy(asObject(entry)));
    }
    return out;
  },

  /** 蓝本 charts wyy 分支 :798 + chartFromWyy :397 */
  async charts(request: RequestBuiltin): Promise<ContractChart[]> {
    const json = await requestJson(
      request,
      "https://music.163.com/api/toplist",
      { headers: WYY_HEADERS },
    );
    const out: ContractChart[] = [];
    for (const entry of asArray(json["list"])) {
      const item = asObject(entry);
      const desc = asString(item["description"]);
      out.push({
        id: asString(item["id"]),
        platform: "wyy",
        name: asString(item["name"]),
        picUrl: asString(item["coverImgUrl"]),
        description: desc.length > 0 ? desc : null,
      });
    }
    return out;
  },

  /** 蓝本 chartDetail wyy 分支 :2183（v6/playlist/detail n=500） */
  async chartDetail(request: RequestBuiltin, chart: ContractChart): Promise<MusicInfo[]> {
    const json = await requestJson(
      request,
      "https://music.163.com/api/v6/playlist/detail" + buildQuery({ id: chart.id, n: "500" }),
      { headers: WYY_HEADERS },
    );
    const playlistData = asObject(json["playlist"]);
    const out: MusicInfo[] = [];
    for (const entry of asArray(playlistData["tracks"])) {
      out.push(songFromWyyDetail(asObject(entry)));
    }
    return out;
  },

  /** 蓝本 hotWords wyy 分支 :1052 */
  async hotWords(request: RequestBuiltin): Promise<string[]> {
    const json = await requestJson(
      request,
      "https://music.163.com/api/search/hot",
      { headers: WYY_HEADERS },
    );
    const result = asObject(json["result"]);
    const words: string[] = [];
    for (const entry of asArray(result["hots"])) {
      words.push(asString(asObject(entry)["first"]));
    }
    return words;
  },

  /** 蓝本 searchPlaylists wyy 分支 :1488（type=1000）+ playlistFromWyySearch :1201 */
  async playlistSearch(
    request: RequestBuiltin,
    keyword: string,
    page: number,
    size: number,
  ): Promise<ContractPlaylist[]> {
    const json = await requestJson(
      request,
      "https://music.163.com/api/search/get" +
        buildQuery({
          s: keyword,
          type: "1000",
          limit: String(size),
          offset: String((page - 1) * size),
        }),
      { headers: WYY_HEADERS },
    );
    const result = asObject(json["result"]);
    const out: ContractPlaylist[] = [];
    for (const entry of asArray(result["playlists"])) {
      const item = asObject(entry);
      out.push({
        id: asString(item["id"]),
        platform: "wyy",
        name: asString(item["name"]),
        picUrl: asString(item["coverImgUrl"]),
        playCount: asString(item["playCount"]),
      });
    }
    return out;
  },

  /** 蓝本 searchArtists wyy 分支 :1585（type=100）+ artistFromWyy :1226 */
  async artistSearch(
    request: RequestBuiltin,
    keyword: string,
    page: number,
    size: number,
  ): Promise<ContractArtist[]> {
    const json = await requestJson(
      request,
      "https://music.163.com/api/search/get" +
        buildQuery({
          s: keyword,
          type: "100",
          limit: String(size),
          offset: String((page - 1) * size),
        }),
      { headers: WYY_HEADERS },
    );
    const result = asObject(json["result"]);
    const out: ContractArtist[] = [];
    for (const entry of asArray(result["artists"])) {
      const item = asObject(entry);
      out.push({
        id: asString(item["id"]),
        platform: "wyy",
        name: asString(item["name"]),
        picUrl: asString(item["picUrl"]),
      });
    }
    return out;
  },

  /**
   * 歌手列表（热门）。wyy 的 artist/list 只有 initial=0（热门）实测有数据，
   * 字母档（1..27）在该接口上恒空，所以 initialSupported 为 false。
   * 翻页靠响应里的 more 标志，比按条数猜准。
   */
  async artistList(
    request: RequestBuiltin,
    _initial: string,
    page: number,
    size: number,
  ): Promise<ContractArtistPage> {
    const json = await requestJson(
      request,
      "https://music.163.com/api/artist/list" +
        buildQuery({
          type: "1",
          area: "-1",
          initial: "0",
          limit: String(size),
          offset: String((page - 1) * size),
        }),
      { headers: WYY_HEADERS },
    );
    const out: ContractArtist[] = [];
    for (const entry of asArray(json["artists"])) {
      const item = asObject(entry);
      out.push({
        id: asString(item["id"]),
        platform: "wyy",
        name: asString(item["name"]),
        picUrl: asString(item["picUrl"]),
      });
    }
    return { list: out, initialSupported: false, hasMore: json["more"] === true };
  },

  /** 蓝本 searchAlbums wyy 分支 :1725（type=10）+ albumFromWyy :1240 */
  async albumSearch(
    request: RequestBuiltin,
    keyword: string,
    page: number,
    size: number,
  ): Promise<ContractAlbum[]> {
    const json = await requestJson(
      request,
      "https://music.163.com/api/search/get" +
        buildQuery({
          s: keyword,
          type: "10",
          limit: String(size),
          offset: String((page - 1) * size),
        }),
      { headers: WYY_HEADERS },
    );
    const result = asObject(json["result"]);
    const out: ContractAlbum[] = [];
    for (const entry of asArray(result["albums"])) {
      const item = asObject(entry);
      out.push({
        id: asString(item["id"]),
        platform: "wyy",
        name: asString(item["name"]),
        artist: asString(asObject(item["artist"])["name"]),
        picUrl: asString(item["picUrl"]),
      });
    }
    return out;
  },

  /**
   * 蓝本 albumDetail wyy 分支 :1888（api/v1/album/{id}）：
   * album.name/picUrl/briefDesc → 名称/封面/描述，songs → songFromWyy。
   */
  async albumDetail(
    request: RequestBuiltin,
    id: string,
  ): Promise<ContractPlaylistDetail> {
    const json = await requestJson(
      request,
      "https://music.163.com/api/v1/album/" + encodeURIComponent(id),
      { headers: WYY_HEADERS },
    );
    const album = asObject(json["album"]);
    const descVal = asString(album["briefDesc"]);
    const tracks: MusicInfo[] = [];
    for (const entry of asArray(json["songs"])) {
      tracks.push(songFromWyy(asObject(entry)));
    }
    return {
      id,
      platform: "wyy",
      name: asString(album["name"]),
      picUrl: asString(album["picUrl"]),
      playCount: String(tracks.length),
      description: descVal.length > 0 ? descVal : null,
      tracks,
    };
  },

  /** 蓝本 videos wyy 分支 :984（interface.music.163.com/api/mv/all） */
  async videos(
    request: RequestBuiltin,
    page: number,
    size: number,
  ): Promise<ContractVideo[]> {
    const json = await requestJson(
      request,
      "https://interface.music.163.com/api/mv/all" +
        buildQuery({
          tags: JSON.stringify({ 地区: "全部", 类型: "全部", 排序: "上升最快" }),
          limit: String(size),
          offset: String((page - 1) * size),
          total: "true",
        }),
      { headers: WYY_HEADERS },
    );
    const out: ContractVideo[] = [];
    for (const entry of asArray(json["data"])) {
      const item = asObject(entry);
      out.push({
        id: asString(item["id"]),
        platform: "wyy",
        name: asString(item["name"]),
        picUrl: asString(item["cover"]),
        singer: asString(item["artistName"]),
      });
    }
    return out;
  },

  /** 蓝本 videoUrl wyy 分支 :3604（r 按清晰度；http→https） */
  async videoUrl(
    request: RequestBuiltin,
    id: string,
    quality: string,
  ): Promise<string> {
    let r = 1080;
    if (quality === "low") r = 240;
    else if (quality === "hd") r = 720;
    const json = await requestJson(
      request,
      "https://music.163.com/api/song/enhance/play/mv/url" + buildQuery({ id, r: String(r) }),
      { headers: WYY_HEADERS },
    );
    const data = asObject(json["data"]);
    const url = asString(data["url"]);
    if (url.length > 0) {
      // vod.126.net 支持 https（蓝本实测），明文 http 在部分组件上不稳定
      return url.split("http://").join("https://");
    }
    throw new Error("该 MV 可能为 VIP 内容，暂时无法播放");
  },
};
