/**
 * QQ 音乐（qq）平台模块 —— 蓝本移植。
 *
 * 逻辑逐段对照 qt-uniappx services/music-api.ts：
 * - search         :1098（client_search_cp format/w/p/n/platform/g_tk）+ songFromQQSearch :1923
 * - musicUrlCore   :3463 fetchNativeUrl qq 分支（musicu.fcg vkey.GetVkeyServer/CgiGetVkey，
 *                    M500/M800/F000 音质前缀；拿不到 vkey 抛"该歌曲暂时无法播放"由调用方兜底）
 * - lyric          :3025（fcg_query_lyric_new.fcg nobase64=1，retcode!=0 返回空串）
 * - lyricTranslation    （musicu.fcg PlayLyricInfo.GetPlayLyricInfo 的 trans，官方翻译；无则空串）
 * - playlistCategories :512（fcg_get_diss_tag_conf.fcg，data.categories[].items[] 分组）
 * - playlistDetail :2826（fcg_ucc_getcdinfo_byids_cp.fcg）+ songFromQQDetail :1958
 *                    （封面读 logo 回退 dir_pic_url，playCount 读 listen_num）
 * - recommendations :611（fcg_get_diss_by_tag.fcg，sin/ein 分页）+ playlistFromQQ :229
 * - latest         :717（musicu.fcg newsong.get_new_song_info；QQ 恒取第一页，不用 offset）+ songFromQQ :243
 * - charts         :824（fcg_myqq_toplist.fcg）+ chartFromQQ :411
 * - chartDetail    :2203（fcg_v8_toplist_cp.fcg topid，songlist[i].data → songFromQQDetail）
 * - hotWords       :1019（gethotkey.fcg，data.hotkey[].k）
 * - playlistSearch :1413（qqMusicSearch :1345：musicu.fcg DoSearchForQQMusicDesktop
 *                    search_type=3 → body.songlist.list；整体 try/catch 失败返回空数组）
 * - artistSearch   :1512（client_search_cp t=2，data.zhida.zhida_singer 单个直达歌手）
 * - albumSearch    :1671（client_search_cp t=8）+ albumFromQQ :1255（大写字段）
 * - albumDetail     :1758（fcg_v8_album_info_cp.fcg，albummid；list → songFromQQSearch）
 * - videos         :895（musicu.fcg MvService.MvInfoProServer GetAllocMvInfo）
 * - videoUrl      :3541（musicu.fcg gosrf.Stream.MvUrlProxy GetMvUrls，
 *                    mp4 档位从目标往下找 freeflow_url/url）
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
  decodeBase64Utf8,
  platformHeaders,
  requestJson,
} from "./utils";

const QQ_HEADERS = platformHeaders("qq");

/** 蓝本 playlistFromQQ :229（dissid/dissname/imgurl/listennum 字段） */
function playlistFromQQ(item: Record<string, unknown>): ContractPlaylist {
  return {
    id: asString(item["dissid"]),
    platform: "qq",
    name: asString(item["dissname"]),
    picUrl: asString(item["imgurl"]),
    playCount: asString(item["listennum"]),
  };
}

/** 蓝本 songFromQQ :243（新歌接口：mid/name/album/singer/interval 字段） */
function songFromQQ(item: Record<string, unknown>): MusicInfo {
  const singers = asArray(item["singer"]);
  const singerItem = singers.length > 0 ? asObject(singers[0]) : {};
  const album = asObject(item["album"]);
  const albumMid = album["mid"];
  return {
    id: asString(item["mid"]),
    name: asString(item["name"]),
    singer: asString(singerItem["name"]),
    album: asString(album["name"]),
    picUrl:
      albumMid != null
        ? "https://y.qq.com/music/photo_new/T002R300x300M000" + asString(albumMid) + ".jpg"
        : "",
    interval: item["interval"] != null ? asNumber(item["interval"]) : 0,
  };
}

/** 蓝本 chartFromQQ :411（topTitle/picUrl；description 恒空串） */
function chartFromQQ(item: Record<string, unknown>): ContractChart {
  const pic = item["picUrl"];
  return {
    id: asString(item["id"]),
    platform: "qq",
    name: asString(item["topTitle"]),
    picUrl: pic != null ? asString(pic) : "",
    description: "",
  };
}

/**
 * 蓝本 albumFromQQ :1255（client_search_cp t=8 返回的字段是大写：
 * albumMID/albumName/albumPic/singerName；id 优先 albumMID 回退 albumID）
 */
function albumFromQQ(item: Record<string, unknown>): ContractAlbum {
  const mid = asString(item["albumMID"]);
  const idVal = item["albumID"];
  const albumPic = asString(item["albumPic"]);
  const id = mid.length > 0 ? mid : idVal != null ? asString(idVal) : "";
  const cover =
    albumPic.length > 0
      ? albumPic
      : "https://y.qq.com/music/photo_new/T002R300x300M000" + mid + ".jpg";
  return {
    id,
    platform: "qq",
    name: asString(item["albumName"]),
    artist: asString(item["singerName"]),
    picUrl: cover,
  };
}

/**
 * 蓝本 qqMusicSearch :1345（musicu.fcg + DoSearchForQQMusicDesktop，QTmusic_nuve 同款）。
 * 返回响应体 body；该接口需要 IE 内核的 User-Agent，否则不返回数据。
 */
async function qqMusicSearch(
  request: RequestBuiltin,
  keyword: string,
  searchType: number,
  page: number,
  size: number,
): Promise<Record<string, unknown>> {
  const header: Record<string, string> = { "Content-Type": "application/json" };
  header["User-Agent"] =
    "Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)";
  const json = await requestJson(request, "https://u.y.qq.com/cgi-bin/musicu.fcg", {
    method: "POST",
    headers: header,
    body: JSON.stringify({
      comm: { ct: "19", cv: "1859", uin: "0" },
      req: {
        module: "music.search.SearchCgiService",
        method: "DoSearchForQQMusicDesktop",
        param: {
          grp: 1,
          num_per_page: size,
          page_num: page,
          query: keyword,
          search_type: searchType,
        },
      },
    }),
  });
  const code = json["code"];
  if (code != null && code !== 0) {
    throw new Error("QQ 搜索失败");
  }
  return asObject(asObject(asObject(json["req"])["data"])["body"]);
}

/**
 * 蓝本 songFromQQSearch :1923（client_search_cp：歌名字段是顶层 songname，
 * 没有 name / album 对象；id 读 songmid 回退 mid）
 */
function songFromQQSearch(item: Record<string, unknown>): MusicInfo {
  const idText = asString(item["songmid"]);
  const fallbackMid = asString(item["mid"]);
  const name1 = asString(item["songname"]);
  const name2 = asString(item["name"]);
  const singers = asArray(item["singer"]);
  const singerItem = singers.length > 0 ? asObject(singers[0]) : {};
  const albumMid = item["albummid"];
  return {
    id: idText.length > 0 ? idText : fallbackMid,
    name: name1.length > 0 ? name1 : name2,
    singer: asString(singerItem["name"]),
    album: asString(item["albumname"]),
    picUrl:
      albumMid != null
        ? "https://y.qq.com/music/photo_new/T002R300x300M000" + asString(albumMid) + ".jpg"
        : "",
    interval: item["interval"] != null ? asNumber(item["interval"]) : 0,
  };
}

/** 蓝本 songFromQQDetail :1958（歌单/榜单详情：songmid/songname/albumname/albummid/singer/interval） */
function songFromQQDetail(item: Record<string, unknown>): MusicInfo {
  const singers = asArray(item["singer"]);
  const singerItem = singers.length > 0 ? asObject(singers[0]) : {};
  const albumMid = item["albummid"];
  return {
    id: asString(item["songmid"]),
    name: asString(item["songname"]),
    singer: asString(singerItem["name"]),
    album: asString(item["albumname"]),
    picUrl:
      albumMid != null
        ? "https://y.qq.com/music/photo_new/T002R300x300M000" + asString(albumMid) + ".jpg"
        : "",
    interval: item["interval"] != null ? asNumber(item["interval"]) : 0,
  };
}

export const qq = {
  /** 蓝本 search qq 分支 :1098 */
  async search(
    request: RequestBuiltin,
    keyword: string,
    page: number,
    size: number,
  ): Promise<MusicInfo[]> {
    const json = await requestJson(
      request,
      "https://c.y.qq.com/soso/fcgi-bin/client_search_cp" +
        buildQuery({
          format: "json",
          w: keyword,
          p: String(page),
          n: String(size),
          platform: "yqq",
          g_tk: "5381",
        }),
      { headers: QQ_HEADERS },
    );
    const data = asObject(json["data"]);
    const song = asObject(data["song"]);
    const out: MusicInfo[] = [];
    for (const entry of asArray(song["list"])) {
      out.push(songFromQQSearch(asObject(entry)));
    }
    return out;
  },

  /** 蓝本 fetchNativeUrl qq 分支 :3463（取 vkey；拿不到所选音质抛错，由调用方跨源兜底） */
  async musicUrlCore(
    request: RequestBuiltin,
    song: MusicInfo,
    quality: Quality,
  ): Promise<string> {
    // QQ 音质映射：M500=128K mp3、M800=320K mp3、F000=flac 无损
    let prefix = "M500";
    let ext = "mp3";
    if (quality === "320") {
      prefix = "M800";
      ext = "mp3";
    } else if (quality === "flac") {
      prefix = "F000";
      ext = "flac";
    }
    const filename = prefix + song.id + "." + ext;
    const json = await requestJson(
      request,
      "https://u.y.qq.com/cgi-bin/musicu.fcg",
      {
        method: "POST",
        headers: QQ_HEADERS,
        body: JSON.stringify({
          req_0: {
            module: "vkey.GetVkeyServer",
            method: "CgiGetVkey",
            param: {
              guid: "6f7a1c3c8a2b4d5e6f7a",
              songmid: [song.id],
              songtype: [0],
              uin: "0",
              loginflag: 1,
              platform: "20",
              filename: [filename],
            },
          },
          comm: { uin: 0, format: "json", ct: 24, cv: 0 },
        }),
      },
    );
    const req0 = asObject(json["req_0"]);
    const data = asObject(req0["data"]);
    const sip = asArray(data["sip"]);
    const infos = asArray(data["midurlinfo"]);
    if (sip.length > 0 && infos.length > 0) {
      const base = asString(sip[0]);
      const purl = asObject(infos[0])["purl"];
      if (purl != null && asString(purl).length > 0) {
        return base + asString(purl);
      }
    }
    // QQ 拿不到所选音质（VIP/无权限），走兜底（调用方切酷我/网易云）
    throw new Error("该歌曲暂时无法播放");
  },

  /** 蓝本 lyrics qq 分支 :3025（retcode != 0 返回空串） */
  async lyric(request: RequestBuiltin, song: MusicInfo): Promise<string> {
    const json = await requestJson(
      request,
      "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?format=json&nobase64=1&g_tk=5381&songmid=" +
        song.id,
      { headers: QQ_HEADERS },
    );
    const retcode = json["retcode"];
    if (retcode != null && asNumber(retcode) !== 0) return "";
    return asString(json["lyric"]);
  },

  /**
   * QQ 官方翻译（musicu.fcg PlayLyricInfo.GetPlayLyricInfo 的 trans 字段，
   * base64 LRC）。实测老 fcg_query_lyric_new 端点 trans 恒为空（2026-09-19），
   * 该模块化端点才有官方翻译数据；国内歌多数无翻译 → 返回空串，不做跨源兜底。
   */
  async lyricTranslation(request: RequestBuiltin, song: MusicInfo): Promise<string> {
    if (song.id.length === 0) return "";
    const json = await requestJson(request, "https://u.y.qq.com/cgi-bin/musicu.fcg", {
      method: "POST",
      headers: { ...QQ_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        comm: { uin: 0, format: "json", ct: 24, cv: 0 },
        request: {
          module: "music.musichallSong.PlayLyricInfo",
          method: "GetPlayLyricInfo",
          param: { songMID: song.id, songID: 0, qrc: 1, ipc: 1, trans: 1 },
        },
      }),
    });
    const payload = asObject(json["request"]);
    if (asNumber(payload["code"]) !== 0) return "";
    const decoded = decodeBase64Utf8(asString(asObject(payload["data"])["trans"]));
    // 官方 trans 里 kana 注音行的时间行内容是 "//"（无翻译价值），滤掉避免界面显示占位符
    return decoded
      .split("\n")
      .filter((line) => line.replace(/^\[[^\]]*\]/, "").trim() !== "//")
      .join("\n");
  },

  /** 蓝本 playlistCategories qq 分支 :512（categories 分组的 items，id=categoryId） */
  async playlistCategories(request: RequestBuiltin): Promise<ContractPlaylistCategory[]> {
    const json = await requestJson(
      request,
      "https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_tag_conf.fcg?format=json&inCharset=utf8&outCharset=utf-8",
      { headers: QQ_HEADERS },
    );
    const categories: ContractPlaylistCategory[] = [];
    const data = asObject(json["data"]);
    for (const groupEntry of asArray(data["categories"])) {
      const items = asArray(asObject(groupEntry)["items"]);
      for (const itemEntry of items) {
        const item = asObject(itemEntry);
        const id = item["categoryId"];
        const name = item["categoryName"];
        if (id == null || name == null) continue;
        categories.push({ id: asString(id), name: asString(name), group: null });
      }
    }
    return categories;
  },

  /** 蓝本 playlist qq 分支 :2826（封面 logo 回退 dir_pic_url；playCount 读 listen_num） */
  async playlistDetail(
    request: RequestBuiltin,
    id: string,
  ): Promise<ContractPlaylistDetail> {
    const json = await requestJson(
      request,
      "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg" +
        buildQuery({
          type: "1",
          json: "1",
          utf8: "1",
          onlysong: "0",
          disstid: id,
          format: "json",
          g_tk: "5381",
        }),
      { headers: QQ_HEADERS },
    );
    const cdlist = asArray(json["cdlist"]);
    const pl = cdlist.length > 0 ? asObject(cdlist[0]) : {};
    const tracks: MusicInfo[] = [];
    for (const entry of asArray(pl["songlist"])) {
      tracks.push(songFromQQDetail(asObject(entry)));
    }
    // QQ 详情接口封面在 logo（dir_pic_url 实测已不再返回，老项目同样读 logo）
    let picVal = pl["logo"];
    if (picVal == null || asString(picVal).length == 0) picVal = pl["dir_pic_url"];
    const countVal = pl["listen_num"];
    return {
      id,
      platform: "qq",
      name: asString(pl["dissname"]),
      picUrl: picVal != null ? asString(picVal) : "",
      playCount: countVal != null ? asString(countVal) : "0",
      description: null,
      tracks,
    };
  },

  /** 蓝本 recommendations qq 分支 :611（categoryId 空=10000000；sin/ein 分页）+ playlistFromQQ :229 */
  async recommendations(
    request: RequestBuiltin,
    category: string | null,
    page: number,
  ): Promise<ContractPlaylist[]> {
    const pageSize = 30;
    const offset = (page - 1) * pageSize;
    const categoryId = category != null && category.length > 0 ? category : "10000000";
    const json = await requestJson(
      request,
      "https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg?picmid=1&g_tk=732560869&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0&categoryId=" +
        categoryId +
        "&sortId=2&sin=" +
        offset +
        "&ein=" +
        (offset + pageSize - 1),
      { headers: QQ_HEADERS },
    );
    const data = asObject(json["data"]);
    const out: ContractPlaylist[] = [];
    for (const entry of asArray(data["list"])) {
      out.push(playlistFromQQ(asObject(entry)));
    }
    return out;
  },

  /** 蓝本 latest qq 分支 :717（musicu.fcg new_song.get_new_song_info；QQ 不使用 offset）+ songFromQQ :243 */
  async latest(
    request: RequestBuiltin,
    limit: number,
    _offset: number,
  ): Promise<MusicInfo[]> {
    const json = await requestJson(
      request,
      "https://u.y.qq.com/cgi-bin/musicu.fcg",
      {
        method: "POST",
        headers: QQ_HEADERS,
        body: JSON.stringify({
          comm: { ct: 24, cv: 0 },
          new_song: {
            module: "newsong.NewSongServer",
            method: "get_new_song_info",
            param: { type: 5 },
          },
        }),
      },
    );
    const container = asObject(json["new_song"]);
    const data = asObject(container["data"]);
    const raw = asArray(data["songlist"]);
    const out: MusicInfo[] = [];
    for (let index = 0; index < raw.length && index < limit; index++) {
      out.push(songFromQQ(asObject(raw[index])));
    }
    return out;
  },

  /** 蓝本 charts qq 分支 :824（fcg_myqq_toplist.fcg）+ chartFromQQ :411 */
  async charts(request: RequestBuiltin): Promise<ContractChart[]> {
    const json = await requestJson(
      request,
      "https://c.y.qq.com/v8/fcg-bin/fcg_myqq_toplist.fcg?format=json&g_tk=5381&uin=0",
      { headers: QQ_HEADERS },
    );
    const data = asObject(json["data"]);
    const out: ContractChart[] = [];
    for (const entry of asArray(data["topList"])) {
      out.push(chartFromQQ(asObject(entry)));
    }
    return out;
  },

  /** 蓝本 chartDetail qq 分支 :2203（fcg_v8_toplist_cp.fcg topid；songlist[i].data → songFromQQDetail） */
  async chartDetail(request: RequestBuiltin, chart: ContractChart): Promise<MusicInfo[]> {
    const json = await requestJson(
      request,
      "https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg" +
        buildQuery({
          topid: chart.id,
          format: "json",
          page: "1",
          type: "top",
          song_begin: "0",
          song_num: "200",
          g_tk: "5381",
        }),
      { headers: QQ_HEADERS },
    );
    const out: MusicInfo[] = [];
    for (const entry of asArray(json["songlist"])) {
      out.push(songFromQQDetail(asObject(asObject(entry)["data"])));
    }
    return out;
  },

  /** 蓝本 hotWords qq 分支 :1019（gethotkey.fcg，data.hotkey[].k） */
  async hotWords(request: RequestBuiltin): Promise<string[]> {
    const json = await requestJson(
      request,
      "https://c.y.qq.com/hotcgi.qq.com/splcloud/fcgi-bin/gethotkey.fcg?format=json&g_tk=5381",
      { headers: QQ_HEADERS },
    );
    const data = asObject(json["data"]);
    const words: string[] = [];
    for (const entry of asArray(data["hotkey"])) {
      words.push(asString(asObject(entry)["k"]));
    }
    return words;
  },

  /**
   * 蓝本 searchPlaylists qq 分支 :1413（qqMusicSearch search_type=3 → body.songlist.list；
   * 整体 try/catch，失败返回空数组）
   */
  async playlistSearch(
    request: RequestBuiltin,
    keyword: string,
    page: number,
    size: number,
  ): Promise<ContractPlaylist[]> {
    // QQ 歌单搜索走 musicu.fcg + DoSearchForQQMusicDesktop（search_type=3 -> body.songlist.list）
    try {
      const qqBody = await qqMusicSearch(request, keyword, 3, page, size);
      const lists: ContractPlaylist[] = [];
      for (const entry of asArray(asObject(qqBody["songlist"])["list"])) {
        const item = asObject(entry);
        const idVal = item["dissid"];
        const countVal = item["listennum"];
        lists.push({
          id: idVal != null ? asString(idVal) : "",
          platform: "qq",
          name: asString(item["dissname"]),
          picUrl: asString(item["imgurl"]),
          playCount: countVal != null ? asString(countVal) : "0",
        });
      }
      return lists;
    } catch {
      return [];
    }
  },

  /** 蓝本 searchArtists qq 分支 :1512（client_search_cp t=2；data.zhida.zhida_singer 单个直达歌手） */
  async artistSearch(
    request: RequestBuiltin,
    keyword: string,
    page: number,
    size: number,
  ): Promise<ContractArtist[]> {
    const json = await requestJson(
      request,
      "https://c.y.qq.com/soso/fcgi-bin/client_search_cp" +
        buildQuery({
          format: "json",
          w: keyword,
          t: "2",
          p: String(page),
          n: String(size),
          platform: "yqq",
          g_tk: "5381",
          remoteplace: "txt.yqq.search",
          catZhida: "1",
        }),
      { headers: QQ_HEADERS },
    );
    const data = asObject(json["data"]);
    // 歌手搜索结果位于 data.zhida.zhida_singer（单个直达歌手对象）
    const zhida = asObject(data["zhida"]);
    const singerObj = asObject(zhida["zhida_singer"]);
    const mid = asString(singerObj["singerMID"]);
    const pic = asString(singerObj["singerPic"]);
    const artists: ContractArtist[] = [];
    if (mid.length > 0) {
      artists.push({
        id: mid,
        platform: "qq",
        name: asString(singerObj["singerName"]),
        picUrl:
          pic.length > 0
            ? pic
            : "https://y.qq.com/music/photo_new/T001R300x300M000" + mid + ".jpg",
      });
    }
    return artists;
  },

  /** 蓝本 searchAlbums qq 分支 :1671（client_search_cp t=8）+ albumFromQQ :1255 */
  async albumSearch(
    request: RequestBuiltin,
    keyword: string,
    page: number,
    size: number,
  ): Promise<ContractAlbum[]> {
    const json = await requestJson(
      request,
      "https://c.y.qq.com/soso/fcgi-bin/client_search_cp" +
        buildQuery({
          format: "json",
          w: keyword,
          t: "8",
          p: String(page),
          n: String(size),
          platform: "yqq",
          g_tk: "5381",
        }),
      { headers: QQ_HEADERS },
    );
    const data = asObject(json["data"]);
    const album = data["album"];
    const albums: ContractAlbum[] = [];
    if (album != null) {
      for (const entry of asArray(asObject(album)["list"])) {
        albums.push(albumFromQQ(asObject(entry)));
      }
    }
    return albums;
  },

  /** 蓝本 videos qq 分支 :895（musicu.fcg MvService.MvInfoProServer GetAllocMvInfo） */
  async videos(
    request: RequestBuiltin,
    page: number,
    size: number,
  ): Promise<ContractVideo[]> {
    const json = await requestJson(
      request,
      "https://u.y.qq.com/cgi-bin/musicu.fcg",
      {
        method: "POST",
        headers: QQ_HEADERS,
        body: JSON.stringify({
          comm: { ct: 24, cv: 0 },
          mv_list: {
            module: "MvService.MvInfoProServer",
            method: "GetAllocMvInfo",
            param: {
              start: (page - 1) * size,
              size,
              version_id: 8,
              area_id: 15,
              order: 1,
            },
          },
        }),
      },
    );
    const container = asObject(json["mv_list"]);
    const data = asObject(container["data"]);
    const out: ContractVideo[] = [];
    for (const entry of asArray(data["list"])) {
      const item = asObject(entry);
      const singers = asArray(item["singers"]);
      const first = singers.length > 0 ? asObject(singers[0]) : null;
      out.push({
        id: asString(item["vid"]),
        platform: "qq",
        name: asString(item["title"]),
        picUrl: asString(item["picurl"]),
        singer: first != null ? asString(first["name"]) : "",
      });
    }
    return out;
  },

  /**
   * 蓝本 videoUrl qq 分支 :3541（musicu.fcg gosrf.Stream.MvUrlProxy GetMvUrls；
   * mp4 档位从目标往下找 freeflow_url/url）
   */
  async videoUrl(
    request: RequestBuiltin,
    id: string,
    quality: string,
  ): Promise<string> {
    const json = await requestJson(
      request,
      "https://u.y.qq.com/cgi-bin/musicu.fcg",
      {
        method: "POST",
        headers: QQ_HEADERS,
        body: JSON.stringify({
          getMvUrl: {
            module: "gosrf.Stream.MvUrlProxy",
            method: "GetMvUrls",
            param: {
              vids: [id],
              request_typet: 10001,
            },
          },
        }),
      },
    );
    const container = json["getMvUrl"];
    const data = container != null ? asObject(container)["data"] : null;
    const mv = data != null ? asObject(data)[id] : null;
    if (mv == null) throw new Error("该音源 MV 暂不可用，请切换音源后重试");
    // QQ 部分清晰度档位（无权限）返回空 URL 数组，从目标档位往下找第一个有地址的档
    const mp4 = asArray(asObject(mv)["mp4"]);
    if (mp4.length > 0) {
      let index = mp4.length - 1;
      if (quality === "low") index = 0;
      else if (quality === "hd" && mp4.length > 1) index = 1;
      while (index >= 0) {
        const target = asObject(mp4[index]);
        const urls = asArray(target["freeflow_url"]);
        if (urls.length > 0) return asString(urls[0]);
        const alt = asArray(target["url"]);
        if (alt.length > 0) return asString(alt[0]);
        index--;
      }
    }
    throw new Error("该音源 MV 需要权限或暂不可用，请切换音源后重试");
  },

  /**
   * 蓝本 albumDetail qq 分支 :1760（fcg_v8_album_info_cp.fcg，albummid 入参；
   * data.list → songFromQQSearch；封面 = T002R500x500M000{albummid}.jpg）
   */
  async albumDetail(
    request: RequestBuiltin,
    id: string,
  ): Promise<ContractPlaylistDetail> {
    const json = await requestJson(
      request,
      "https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg" +
        buildQuery({
          albummid: id,
          format: "json",
          platform: "yqq",
          g_tk: "5381",
        }),
      { headers: QQ_HEADERS },
    );
    const data = asObject(json["data"]);
    const tracks: MusicInfo[] = [];
    for (const entry of asArray(data["list"])) {
      tracks.push(songFromQQSearch(asObject(entry)));
    }
    const mid = asString(data["albummid"]);
    return {
      id,
      platform: "qq",
      name: asString(data["name"]),
      picUrl:
        mid.length > 0
          ? "https://y.qq.com/music/photo_new/T002R500x500M000" + mid + ".jpg"
          : "",
      playCount: String(tracks.length),
      description: null,
      tracks,
    };
  },
};
