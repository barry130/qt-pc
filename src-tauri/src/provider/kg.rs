//! kg（酷狗）Provider —— 移植自 `qt-uniappx/services/music-api.ts`（只读参考，不引用）。
//!
//! 移植范围：
//! - `search_tracks` ← `search(keyword, "kg", "song", page, size)`：
//!   `GET mobilecdnbj.kugou.com/api/v3/search/song`（免签名）
//! - `play_url`      ← `fetchNativeUrl("kg")`：`GET m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=…`
//! - `lyric`         ← `lyrics("kg")`：酷狗官方歌词接口不稳定，按移动端行为走
//!   网易云 `api/search/get`（s=歌手 歌名, limit=1）→ `api/song/lyric` 兜底
//! - 发现类（M5）：`playlist_categories` / `recommendations` / `latest` / `charts` /
//!   `chart_detail` / `playlist` / `hot_words` / `search_playlists` / `search_artists` /
//!   `search_albums` / `artist_songs`，均免签名，字段映射与移动端同名私有方法一致。
//!
//! 请求头与移动端 `makeHeaders("kg")` 一致：Referer https://www.kugou.com/
//!
//! 例外是 `mobiles.kugou.com/api/v5/*`：收藏/分享歌单（global_specialid）只能走这条，
//! 它强制校验 signature 与 mid/dfid/clienttime/UA/Referer，见下方 `get_json_mobile`。

use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;

use super::md5::md5_hex;
use super::types::{
    Album, Artist, Chart, Lyric, Playlist, PlaylistCategory, ProviderError, ProviderResult, Quality,
    SourceId, Track, Video,
};
use super::{check_status, MusicProvider, ProviderCapabilities};

const UA: &str = "Mozilla/5.0";
const REFERER: &str = "https://www.kugou.com/";
/// 酷狗分享短码歌单接口（music-api.ts:2283-2339 `kgChainPlaylist`）
const CHAIN_URL: &str = "https://m3ws.kugou.com/zlist/list";
/// 酷狗移动端签名接口基址（music-api.ts:2388-2397 `kgMobileUrl`）
const MOBILE_V5_URL: &str = "https://mobiles.kugou.com/api/v5/";
/// apiver=5 的签名密钥（kg-sign.ts:194）
const KG_SIGN_KEY: &str = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt";
/// 签名接口专用 UA / Referer（http.ts:571-575），缺了会返回 errcode:1001
const MOBILE_UA: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 11_0 like Mac OS X) AppleWebKit/604.1.38 (KHTML, like Gecko) Version/11.0 Mobile/15A372 Safari/604.1";
const MOBILE_REFERER: &str = "https://m3ws.kugou.com/share/index.php";
/// 签名接口要求的固定 clienttime/mid/uuid（music-api.ts:2411-2413 与 2430-2433 原样照搬）
const MOBILE_CLIENTTIME_SONG: &str = "1586163263991";
const MOBILE_CLIENTTIME_INFO: &str = "1586163242519";
const SEARCH_URL: &str = "http://mobilecdnbj.kugou.com/api/v3/search/song";
const PLAY_INFO_URL: &str = "http://m.kugou.com/app/i/getSongInfo.php";
const WYY_SEARCH_URL: &str = "https://music.163.com/api/search/get";
const WYY_LYRIC_URL: &str = "https://music.163.com/api/song/lyric";

// ---------- 发现类接口（M5，免签名） ----------
/// `playlistCategories("kg")` (music-api.ts:571-598)
const CATEGORIES_URL: &str = "http://www2.kugou.kugou.com/yueku/v9/special/getSpecial?is_smarty=1";
/// `recommendations("kg")` (music-api.ts:667-685)
const SPECIAL_URL: &str = "http://www2.kugou.kugou.com/yueku/v9/special/getSpecial";
/// `playlist("kg")` 普通歌单详情 HTML (music-api.ts:2398-2433)
const SINGLE_URL: &str = "http://www2.kugou.kugou.com/yueku/v9/special/single";
/// `latest("kg")` 新歌速递 (music-api.ts:765-782)
const NEW_SONG_URL: &str = "http://mobilecdnbj.kugou.com/api/v3/rank/newsong";
/// `charts("kg")` 排行榜 (music-api.ts:848-860)
const RANK_LIST_URL: &str =
    "http://mobilecdnbj.kugou.com/api/v3/rank/list?version=9108&plat=0&parentid=0&withsong=0";
/// `chartDetail("kg")` 榜单详情 (music-api.ts:2078-2100)
const RANK_SONG_URL: &str = "http://mobilecdnbj.kugou.com/api/v3/rank/song";
/// `hotWords("kg")` 搜索热词 (music-api.ts:1047-1060)
const HOT_URL: &str = "http://mobilecdnbj.kugou.com/api/v3/search/hot?version=9108&plat=0";
/// `searchPlaylist("kg")` 搜歌单 (music-api.ts:1473-1492)
const SEARCH_SPECIAL_URL: &str = "http://mobilecdnbj.kugou.com/api/v3/search/special";
/// `searchArtist("kg")` 搜歌手（响应 data 本身为数组，music-api.ts:1587-1608）
const SEARCH_SINGER_URL: &str = "http://mobilecdnbj.kugou.com/api/v3/search/singer";
/// `searchAlbum("kg")` 搜专辑 (music-api.ts:1712-1731)
const SEARCH_ALBUM_URL: &str = "http://mobilecdnbj.kugou.com/api/v3/search/album";
/// `videos("kg")` MV 列表 (music-api.ts:960-988)。
/// 注意：源码这条走的是 **v5**（不是其它 kg 接口常用的 v3）。
const MV_LIST_URL: &str = "http://mobilecdnbj.kugou.com/api/v5/video/list";
/// 酷狗歌手头像模板 `artistFromKG` (music-api.ts:1316-1320)
const SINGER_PIC_URL: &str = "https://singerimg.kugou.com/uploadpic/softhead/300/";

pub struct KgProvider {
    http: reqwest::Client,
}

impl Default for KgProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl KgProvider {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(10))
            // 禁用连接池：休眠唤醒后 keep-alive 连接变半死，复用会挂满超时
            .pool_max_idle_per_host(0)
            .build()
            .expect("reqwest client init");
        Self { http }
    }

    /// 酷狗的 JSON 响应被 `<!--KG_TAG_RES_START-->` / `<!--KG_TAG_RES_END-->` 包裹
    /// （content-type 还是 text/html），直接 `.json()` 会解析失败。
    /// 移植移动端 http.ts:634-688 对 `source == "kg"` 的统一剥离。
    async fn get_json(&self, url: &str) -> ProviderResult<Value> {
        let text = self.get_text(url).await?;
        let cleaned = text
            .replace("<!--KG_TAG_RES_START-->", "")
            .replace("<!--KG_TAG_RES_END-->", "");
        serde_json::from_str(&cleaned).map_err(|e| ProviderError::Decode {
            message: e.to_string(),
        })
    }

    /// 文本响应（歌单详情 HTML 用，移动端 `directText`）。
    async fn get_text(&self, url: &str) -> ProviderResult<String> {
        let resp = self
            .http
            .get(url)
            .header("User-Agent", UA)
            .header("Referer", REFERER)
            .send()
            .await
            .map_err(|e| ProviderError::from_reqwest(&e))?;
        check_status(resp)
            .await?
            .text()
            .await
            .map_err(|e| ProviderError::Decode {
                message: e.to_string(),
            })
    }

    /// 酷狗移动端签名接口（http.ts:560-575 `kgMobileRequest`）：
    /// 除了 URL 上的 signature，服务端还校验 mid / dfid / clienttime 请求头与分享页 Referer，
    /// 缺任一项都返回 errcode:1001「参数不合法」，所以不能复用 `get_json`。
    async fn get_json_mobile(&self, url: &str) -> ProviderResult<Value> {
        let resp = self
            .http
            .get(url)
            .header("User-Agent", MOBILE_UA)
            .header("Referer", MOBILE_REFERER)
            .header("mid", MOBILE_CLIENTTIME_INFO)
            .header("dfid", "-")
            .header("clienttime", MOBILE_CLIENTTIME_INFO)
            .send()
            .await
            .map_err(|e| ProviderError::from_reqwest(&e))?;
        let text = check_status(resp)
            .await?
            .text()
            .await
            .map_err(|e| ProviderError::Decode {
                message: e.to_string(),
            })?;
        serde_json::from_str(&text).map_err(|e| ProviderError::Decode {
            message: e.to_string(),
        })
    }

    /// 分享短码歌单（`t1.kugou.com/<code>` 的 code，如 `tJnW20zxV3`）
    /// 移植 music-api.ts:2283-2339：m3ws.kugou.com/zlist/list 的 chain 接口，
    /// 元信息在 `info[0]`（name/pic/intro/count），歌曲在 `list.info[]`。
    /// 服务端把 pagesize 钳到 100，所以按 100 分页拉全。
    async fn chain_playlist(&self, code: &str) -> ProviderResult<Playlist> {
        const PAGE_SIZE: usize = 100;
        const MAX_PAGES: u32 = 30;

        let mut songs: Vec<Track> = Vec::new();
        let mut name = String::new();
        let mut pic_url = String::new();
        let mut description: Option<String> = None;
        let mut count: usize = 0;
        let mut page = 1u32;

        while page <= MAX_PAGES {
            let url = format!(
                "{CHAIN_URL}?chain={}&page={page}&pagesize={PAGE_SIZE}",
                crate::provider::qq::urlencode(code)
            );
            let resp = self.get_json(&url).await?;
            let info = resp.get("info").and_then(Value::as_array);
            if info.map(|a| a.is_empty()).unwrap_or(true) {
                break;
            }
            if page == 1 {
                if let Some(first) = info.and_then(|a| a.first()) {
                    name = first
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    pic_url = normalize_kg_pic(
                        first.get("pic").and_then(Value::as_str).unwrap_or_default(),
                    );
                    description = first
                        .get("intro")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string);
                    count = first.get("count").and_then(Value::as_u64).unwrap_or(0) as usize;
                }
            }
            let items = resp.pointer("/list/info").and_then(Value::as_array);
            let Some(items) = items.filter(|a| !a.is_empty()) else {
                break;
            };
            songs.extend(items.iter().filter_map(song_from_kg_chain));
            if count > 0 && songs.len() >= count {
                break;
            }
            if items.len() < PAGE_SIZE {
                break;
            }
            page += 1;
        }

        if name.is_empty() {
            return Err(ProviderError::Decode {
                message: "酷狗分享歌单解析失败".into(),
            });
        }
        // 播主可能把歌单 pic 留空（分享「喜欢的音乐」常见），用第一首歌的封面兜底
        if pic_url.is_empty() {
            if let Some(first) = songs.first() {
                pic_url = first.pic_url.clone();
            }
        }

        Ok(Playlist {
            id: code.to_string(),
            platform: SourceId::Kg,
            name,
            pic_url,
            play_count: count.to_string(),
            description,
            tracks: Some(songs),
        })
    }

    /// 收藏/分享歌单（`global_specialid`，形如 `tJnW20zxV3` / `collection_3_2004554843_3_0`）
    /// 移植 music-api.ts:2404-2456：special/song_v2 拿歌曲 + special/info_v2 拿名称/封面，
    /// 两个请求都必须带 signature（见 `kg_signature`），否则回 errcode:1001。
    async fn collection_playlist(&self, id: &str) -> ProviderResult<Playlist> {
        let id_param = format!("global_specialid={id}&specialid=0");
        let song_params = format!(
            "appid=1058&{id_param}&plat=0&version=8000&page=1&pagesize=1000&srcappid=2919&clientver=20000&clienttime={MOBILE_CLIENTTIME_SONG}&mid={MOBILE_CLIENTTIME_SONG}&uuid={MOBILE_CLIENTTIME_SONG}&dfid=-"
        );
        let songs = self
            .get_json_mobile(&kg_mobile_url("special/song_v2", &song_params))
            .await?;
        if !status_is_one(&songs) {
            return Err(ProviderError::Decode {
                message: format!(
                    "special/song_v2 status={}",
                    songs.get("status").unwrap_or(&Value::Null)
                ),
            });
        }
        let tracks: Vec<Track> = songs
            .pointer("/data/info")
            .and_then(Value::as_array)
            .map(|arr| arr.iter().filter_map(song_from_kg_collection).collect())
            .unwrap_or_default();
        if tracks.is_empty() {
            return Err(ProviderError::Empty);
        }

        // 元信息单独取一次；失败不拖累歌曲，标题为空由 UI 兜底文案
        let info_params = format!(
            "appid=1058&{id_param}&format=jsonp&srcappid=2919&clientver=20000&clienttime={MOBILE_CLIENTTIME_INFO}&mid={MOBILE_CLIENTTIME_INFO}&uuid={MOBILE_CLIENTTIME_INFO}&dfid=-"
        );
        let (name, pic_url, play_count) = self
            .get_json_mobile(&kg_mobile_url("special/info_v2", &info_params))
            .await
            .ok()
            .filter(status_is_one)
            .and_then(|info| info.pointer("/data").cloned())
            .map(|data| {
                let name = data
                    .get("specialname")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let pic = normalize_kg_pic(
                    data.get("imgurl").and_then(Value::as_str).unwrap_or_default(),
                );
                let count = match data.get("playcount") {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Number(n)) => n.to_string(),
                    _ => "0".to_string(),
                };
                (name, pic, count)
            })
            .unwrap_or_else(|| (String::new(), String::new(), "0".to_string()));

        Ok(Playlist {
            id: id.to_string(),
            platform: SourceId::Kg,
            name,
            pic_url,
            play_count,
            description: None,
            tracks: Some(tracks),
        })
    }

    /// `lyrics("kg")` 移植：网易云按「歌手 歌名」搜 1 首后取其歌词。
    async fn lyric_via_wyy(&self, track: &Track) -> String {
        let keyword = format!("{} {}", track.singer, track.title);
        let url = format!(
            "{WYY_SEARCH_URL}?s={}&type=1&limit=1&offset=0",
            crate::provider::qq::urlencode(&keyword)
        );
        let Ok(json) = self.get_json_wyy(&url).await else {
            return String::new();
        };
        let matched = json
            .get("result")
            .and_then(|r| r.get("songs"))
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(|s| s.get("id"))
            .and_then(Value::as_u64);
        let Some(id) = matched else {
            return String::new();
        };
        let lyric_url = format!("{WYY_LYRIC_URL}?id={id}&lv=-1&kv=-1&tv=-1");
        let Ok(lyric_json) = self.get_json_wyy(&lyric_url).await else {
            return String::new();
        };
        lyric_json
            .get("lrc")
            .and_then(|l| l.get("lyric"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    }

    /// 网易云兜底请求（Referer 与 makeHeaders("wyy") 一致）
    async fn get_json_wyy(&self, url: &str) -> ProviderResult<Value> {
        let resp = self
            .http
            .get(url)
            .header("User-Agent", UA)
            .header("Referer", "https://music.163.com/")
            .send()
            .await
            .map_err(|e| ProviderError::from_reqwest(&e))?;
        check_status(resp)
            .await?
            .json::<Value>()
            .await
            .map_err(|e| ProviderError::Decode {
                message: e.to_string(),
            })
    }
}

/// `normalizeKgPic` 移植：{size} → 300，明文 http 统一 https。
fn normalize_kg_pic(url: &str) -> String {
    if url.is_empty() {
        return String::new();
    }
    let u = url.replace("{size}", "300");
    match u.strip_prefix("http://") {
        Some(rest) => format!("https://{rest}"),
        None => u,
    }
}

// ---------- 发现类字段取值辅助（无 regex，纯字符串 + serde_json） ----------

/// 字段容错取字符串：number / string / bool 都按移动端 `xxx.toString()` 处理，缺省空串。
fn field_str(item: &Value, key: &str) -> String {
    match item.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Null) | Some(Value::Array(_)) | Some(Value::Object(_)) | None => String::new(),
    }
}

/// 数值字段取 f64：酷狗偶发把 duration 写成字符串，这里两者都兼容（单位：秒，移动端同口径）。
fn field_f64(item: &Value, key: &str) -> f64 {
    match item.get(key) {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// 按优先级取首个非空字符串字段（封面 if/else if 链的字符串版）。
fn first_str<'a>(item: &'a Value, keys: &[&str]) -> &'a str {
    for key in keys {
        if let Some(s) = item.get(*key).and_then(Value::as_str) {
            if !s.is_empty() {
                return s;
            }
        }
    }
    ""
}

/// `data.info[]`：酷狗 v3 接口的统一数组结构（music-api.ts 各 kg 分支均取 data.info）。
fn data_info(json: &Value) -> Option<&Vec<Value>> {
    json.get("data")
        .and_then(|d| d.get("info"))
        .and_then(Value::as_array)
}

/// 酷狗 v3 搜索接口统一拼参（version/plat/keyword/page/pagesize，页码从 1 起）。
fn kg_search_url(base: &str, kw: &str, page: u32, size: u32) -> String {
    let page_no = if page == 0 { 1 } else { page };
    let page_size = if size == 0 { 20 } else { size };
    format!(
        "{base}?version=9108&plat=0&keyword={}&page={page_no}&pagesize={page_size}",
        crate::provider::qq::urlencode(kw)
    )
}

/// `songFromKGRankSong` 移植：info[] 项（hash/album_id/filename/songname/singers 等）。
fn song_from_kg(item: &Value) -> Option<Track> {
    let hash = item.get("hash").and_then(Value::as_str).unwrap_or_default();
    let album_id = item
        .get("album_id")
        .map(|v| match v {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => String::new(),
        })
        .unwrap_or_default();
    let id = if !hash.is_empty() {
        hash
    } else if !album_id.is_empty() {
        album_id.as_str()
    } else {
        return None;
    };

    // 歌手：singers → filename「A - B」前段 → author
    let filename = item.get("filename").and_then(Value::as_str).unwrap_or("");
    let parts: Option<Vec<&str>> = if filename.contains(" - ") {
        Some(filename.splitn(2, " - ").collect())
    } else {
        None
    };
    let singer = item
        .get("singers")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| parts.as_ref().and_then(|p| p.first().map(|s| s.to_string())))
        .or_else(|| {
            item.get("author")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();
    let name = item
        .get("songname")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| parts.as_ref().and_then(|p| p.get(1).map(|s| s.to_string())))
        .unwrap_or_else(|| filename.to_string());

    // 封面优先级：trans_param.union_cover → cover → album_sizable_cover → imgUrl
    let union_cover = item
        .get("trans_param")
        .and_then(|t| t.get("union_cover"))
        .and_then(Value::as_str);
    let cover = item.get("cover").and_then(Value::as_str);
    let sizable = item.get("album_sizable_cover").and_then(Value::as_str);
    let img = item.get("imgUrl").and_then(Value::as_str);
    let pic = union_cover
        .filter(|s| !s.is_empty())
        .or_else(|| cover.filter(|s| !s.is_empty()))
        .or(sizable)
        .or(img)
        .unwrap_or_default();
    let duration = item.get("duration").and_then(Value::as_f64).unwrap_or(0.0);

    Some(Track {
        id: id.to_string(),
        platform: SourceId::Kg,
        title: name,
        singer,
        album: String::new(),
        pic_url: normalize_kg_pic(pic),
        duration,
        music_id: None,
    })
}

// ---------- 发现类结构映射（与移动端同名私有方法一一对应） ----------

/// `songFromKGSingle` 移植 (music-api.ts:1872-1905)：
/// 酷狗歌单详情 HTML 的 `global.data[]` 项（album_id/hash/songname/singername/album_name），
/// 封面优先级 trans_param.union_cover → cover → img → imgUrl。
fn song_from_kg_single(item: &Value) -> Option<Track> {
    let hash = field_str(item, "hash");
    let album_id = field_str(item, "album_id");
    let id = if !hash.is_empty() {
        hash
    } else if !album_id.is_empty() {
        album_id
    } else {
        return None;
    };
    let union_cover = item
        .get("trans_param")
        .and_then(|t| t.get("union_cover"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let pic = if !union_cover.is_empty() {
        union_cover
    } else {
        first_str(item, &["cover", "img", "imgUrl"])
    };
    Some(Track {
        id,
        platform: SourceId::Kg,
        title: field_str(item, "songname"),
        singer: field_str(item, "singername"),
        album: field_str(item, "album_name"),
        pic_url: normalize_kg_pic(pic),
        duration: field_f64(item, "duration"),
        music_id: None,
    })
}

/// `playlistFromKG` 移植 (music-api.ts:362-384)：specialid/specialname/imgurl|img/playcount。
fn playlist_from_kg(item: &Value) -> Option<Playlist> {
    let id = field_str(item, "specialid");
    if id.is_empty() {
        return None;
    }
    Some(Playlist {
        id,
        platform: SourceId::Kg,
        name: field_str(item, "specialname"),
        pic_url: normalize_kg_pic(first_str(item, &["imgurl", "img"])),
        play_count: field_str(item, "playcount"),
        description: None,
        tracks: None,
    })
}

/// `chartFromKG` 移植 (music-api.ts:438-449)：imgurl 先去掉 `/{size}/` 段再规范化。
fn chart_from_kg(item: &Value) -> Option<Chart> {
    let id = field_str(item, "rankid");
    if id.is_empty() {
        return None;
    }
    let image = field_str(item, "imgurl").replace("/{size}/", "/");
    Some(Chart {
        id,
        platform: SourceId::Kg,
        name: field_str(item, "rankname"),
        pic_url: normalize_kg_pic(&image),
        description: Some(String::new()),
    })
}

/// `artistFromKG` 移植 (music-api.ts:1309-1323)：头像按 singerid 拼 singerimg 模板。
fn artist_from_kg(item: &Value) -> Option<Artist> {
    let id = field_str(item, "singerid");
    if id.is_empty() {
        return None;
    }
    Some(Artist {
        id: id.clone(),
        platform: SourceId::Kg,
        name: field_str(item, "singername"),
        pic_url: format!("{SINGER_PIC_URL}{id}.jpg"),
    })
}

/// `albumFromKG` 移植 (music-api.ts:1325-1338)：albumid/albumname/singername/imgurl。
fn album_from_kg(item: &Value) -> Option<Album> {
    let id = field_str(item, "albumid");
    if id.is_empty() {
        return None;
    }
    Some(Album {
        id,
        platform: SourceId::Kg,
        name: field_str(item, "albumname"),
        artist: field_str(item, "singername"),
        pic_url: normalize_kg_pic(&field_str(item, "imgurl")),
    })
}

/// `playlist("kg")` 的 HTML 解析：提取 `global.data = [...]` 数组（music-api.ts:2403-2413）。
/// 移动端用正则 `/global\.data\s*=\s*(\[[\s\S]*?\]);/`，这里用 find + serde_json 等价实现。
fn extract_global_data(html: &str) -> Option<Vec<Value>> {
    const KEY: &str = "global.data = [";
    let start = html.find(KEY)? + KEY.len();
    let rest = &html[start..];
    let end = rest.find("];")?;
    serde_json::from_str::<Vec<Value>>(&format!("[{}]", &rest[..end])).ok()
}

/// 歌单元信息（music-api.ts:2414-2424）：`global = {` 之后顺序取 `id:"…"` / `name:"…"` / `pic:"…"`。
/// 移动端靠正则非贪婪匹配，这里用 find + 引号切分，同样属于尽力而为的解析。
fn extract_global_meta(html: &str) -> (String, String) {
    let scope = match html.find("global = {") {
        Some(i) => &html[i..],
        None => html,
    };
    // 实测 HTML 里是 `name: "乡村之旅…",`（键与值之间有空格，值用双引号），
    // 所以按「键 → 跳过空白 → 吃掉开头引号 → 取到下一个引号」提取，不要写死 `name:"`。
    let quoted_after = |key: &str| -> String {
        let Some(i) = scope.find(key) else {
            return String::new();
        };
        let rest = &scope[i + key.len()..];
        let Some(rest) = rest.trim_start().strip_prefix('"') else {
            return String::new();
        };
        match rest.find('"') {
            Some(end) => rest[..end].to_string(),
            None => String::new(),
        }
    };
    let name = quoted_after("name:");
    let pic = quoted_after("pic:");
    (name, normalize_kg_pic(&pic))
}

/// 酷狗「收藏/分享歌单」id 判定（music-api.ts:2106-2115）：非纯数字即走签名接口。
fn is_kg_collection_id(id: &str) -> bool {
    id.is_empty() || id.starts_with("collection_") || !id.bytes().all(|b| b.is_ascii_digit())
}

// ---------- 签名 v5 接口（收藏/分享歌单专用） ----------

/// 酷狗 v5 接口签名（kg-sign.ts:192-199，apiver=5）：
/// `md5(key + 按 & 拆分后字典序排序并**直接拼接** + key)`。
fn kg_signature(params: &str) -> String {
    let mut list: Vec<&str> = params.split('&').collect();
    list.sort_unstable();
    md5_hex(&format!("{KG_SIGN_KEY}{}{KG_SIGN_KEY}", list.concat()))
}

/// 拼接带签名的 v5 接口地址（music-api.ts:2388-2397 `kgMobileUrl`）
fn kg_mobile_url(path: &str, params: &str) -> String {
    format!(
        "{MOBILE_V5_URL}{path}?{params}&signature={}",
        kg_signature(params)
    )
}

/// v5 接口统一用 `status` 判成功，它可能是数字也可能是字符串
fn status_is_one(json: &Value) -> bool {
    match json.get("status") {
        Some(Value::Number(n)) => n.as_i64() == Some(1),
        Some(Value::String(s)) => s == "1",
        _ => false,
    }
}

/// `songFromKGCollection` 移植（music-api.ts:2466-2509）：special/song_v2 的歌曲项。
/// `filename` 是「歌手 - 歌名」，专辑名在 `remark`，hash 可用时同时作为 musicId。
fn song_from_kg_collection(item: &Value) -> Option<Track> {
    let hash = field_str(item, "hash");
    let album_id = field_str(item, "album_id");
    let id = if !hash.is_empty() {
        hash
    } else if !album_id.is_empty() {
        album_id
    } else {
        return None;
    };

    let filename = item.get("filename").and_then(Value::as_str).unwrap_or("");
    let (singer, title) = match filename.split_once(" - ") {
        Some((s, n)) => (s.to_string(), n.to_string()),
        None => (String::new(), filename.to_string()),
    };

    // 封面优先级与 song_from_kg 一致：union_cover → cover → album_sizable_cover → imgUrl
    let union_cover = item
        .get("trans_param")
        .and_then(|t| t.get("union_cover"))
        .and_then(Value::as_str);
    let cover = item.get("cover").and_then(Value::as_str);
    let sizable = item.get("album_sizable_cover").and_then(Value::as_str);
    let img = item.get("imgUrl").and_then(Value::as_str);
    let pic = union_cover
        .filter(|s| !s.is_empty())
        .or_else(|| cover.filter(|s| !s.is_empty()))
        .or(sizable)
        .or(img)
        .unwrap_or_default();

    let music_id = (!id.is_empty() && !id.eq_ignore_ascii_case("nohash")).then(|| id.clone());

    Some(Track {
        id,
        platform: SourceId::Kg,
        title,
        singer,
        album: item
            .get("remark")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        pic_url: normalize_kg_pic(pic),
        duration: item.get("duration").and_then(Value::as_f64).unwrap_or(0.0),
        music_id,
    })
}

/// `songFromKGChain` 移植（music-api.ts:2345-2374）：zlist/list 的歌曲项。
/// `name` 是「歌手 - 歌名」，hash 即播放键，封面在 `trans_param.union_cover`。
/// 与 collection 项的差别：专辑名留空、时长字段叫 `timelen`、不额外带 musicId。
fn song_from_kg_chain(item: &Value) -> Option<Track> {
    let hash = field_str(item, "hash");
    let album_id = field_str(item, "album_id");
    let id = if !hash.is_empty() {
        hash
    } else if !album_id.is_empty() {
        album_id
    } else {
        return None;
    };

    let name_raw = item.get("name").and_then(Value::as_str).unwrap_or("");
    let (singer, title) = match name_raw.split_once(" - ") {
        Some((s, n)) => (s.to_string(), n.to_string()),
        None => (String::new(), name_raw.to_string()),
    };

    let pic = item
        .get("trans_param")
        .and_then(|t| t.get("union_cover"))
        .and_then(Value::as_str)
        .unwrap_or_default();

    // 注意：chain 接口的 `timelen` 是**毫秒**，而 Track.duration 约定是秒
    // （移动端 songFromKGChain 直接取了 timelen 没换算，属于它的既有问题）。
    let duration = item.get("timelen").and_then(Value::as_f64).unwrap_or(0.0) / 1000.0;

    Some(Track {
        id,
        platform: SourceId::Kg,
        title,
        singer,
        album: String::new(),
        pic_url: normalize_kg_pic(pic),
        duration,
        music_id: None,
    })
}

/// `videos()` 的 kg 项映射（music-api.ts:976-986）：
/// mvhash / videoname / img（把尺寸占位段 `/{size}/` 去掉）/ singername，
/// 封面再过 `normalize_kg_pic`（http → https，残留 `{size}` → 300）。
/// mvhash 为空的项直接丢弃 —— 它是 `video_url` 的入参。
fn video_from_kg(item: &Value) -> Option<Video> {
    let id = field_str(item, "mvhash");
    if id.is_empty() {
        return None;
    }
    let pic = field_str(item, "img").replace("/{size}/", "/");
    Some(Video {
        id,
        platform: SourceId::Kg,
        name: field_str(item, "videoname"),
        pic_url: normalize_kg_pic(&pic),
        singer: field_str(item, "singername"),
    })
}

#[async_trait]
impl MusicProvider for KgProvider {
    fn id(&self) -> SourceId {
        SourceId::Kg
    }

    fn name(&self) -> &'static str {
        "kg"
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            playlist_categories: true,
            recommendations: true,
            latest: true,
            charts: true,
            chart_detail: true,
            playlist_detail: true,
            search_playlist: true,
            search_artist: true,
            search_album: true,
            artist_songs: true,
            mv_list: true,
            mv_url: true,
            search_song: true,
            lyric: true,
            lyric_translation: false,
            play_url: true,
            cover: true,
        }
    }

    /// `playlistCategories("kg")` 移植（music-api.ts:571-598）：`getSpecial?is_smarty=1` 的
    /// `data.tagids` 按固定组名顺序展开，组名写入 `PlaylistCategory.group`。
    async fn playlist_categories(&self) -> ProviderResult<Vec<PlaylistCategory>> {
        let json = self.get_json(CATEGORIES_URL).await?;
        let tagids = json
            .get("data")
            .and_then(|d| d.get("tagids"))
            .ok_or_else(|| ProviderError::Decode {
                message: "data.tagids 缺失".into(),
            })?;
        let groups = ["主题", "语种", "风格", "年代", "心情", "场景"];
        let mut out: Vec<PlaylistCategory> = Vec::new();
        for group in groups {
            let Some(items) = tagids
                .get(group)
                .and_then(|g| g.get("data"))
                .and_then(Value::as_array)
            else {
                continue;
            };
            for item in items {
                let id = field_str(item, "id");
                let name = field_str(item, "name");
                if id.is_empty() || name.is_empty() {
                    continue;
                }
                out.push(PlaylistCategory {
                    id,
                    name,
                    group: Some(group.to_string()),
                });
            }
        }
        if out.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(out)
    }

    /// `recommendations("kg")` 移植（music-api.ts:667-685）：`special_db[]` → playlists。
    async fn recommendations(
        &self,
        category: Option<&str>,
        page: u32,
    ) -> ProviderResult<Vec<Playlist>> {
        let c = category.filter(|s| !s.is_empty()).unwrap_or("0");
        let page_no = if page == 0 { 1 } else { page };
        let url = format!(
            "{SPECIAL_URL}?c={}&t=5&p={page_no}&is_ajax=1&cdn=cdn",
            crate::provider::qq::urlencode(c),
        );
        let json = self.get_json(&url).await?;
        let list = json
            .get("special_db")
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "special_db 缺失".into(),
            })?;
        let items: Vec<Playlist> = list.iter().filter_map(playlist_from_kg).collect();
        if items.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(items)
    }

    /// `latest("kg")` 移植（music-api.ts:765-782）：`rank/newsong`，offset 从 0 起，接口页码 +1。
    async fn latest(&self, limit: u32, offset: u32) -> ProviderResult<Vec<Track>> {
        let page = offset.saturating_add(1);
        let url = format!(
            "{NEW_SONG_URL}?version=9108&plat=0&with_cover=1&pagesize={limit}&type=1\
             &area_code=1&page={page}&with_res_tag=1"
        );
        let json = self.get_json(&url).await?;
        let list = data_info(&json).ok_or_else(|| ProviderError::Decode {
            message: "data.info 缺失".into(),
        })?;
        let tracks: Vec<Track> = list.iter().filter_map(song_from_kg).collect();
        if tracks.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(tracks)
    }

    /// `charts("kg")` 移植（music-api.ts:848-860）：`rank/list?parentid=0&withsong=0`。
    async fn charts(&self) -> ProviderResult<Vec<Chart>> {
        let json = self.get_json(RANK_LIST_URL).await?;
        let list = data_info(&json).ok_or_else(|| ProviderError::Decode {
            message: "data.info 缺失".into(),
        })?;
        let items: Vec<Chart> = list.iter().filter_map(chart_from_kg).collect();
        if items.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(items)
    }

    /// `chartDetail("kg")` 移植（music-api.ts:2078-2100）：酷狗榜单接口固定一次性取 200 首，
    /// 故 page/size 参数不参与请求（与移动端一致）。
    async fn chart_detail(
        &self,
        chart: &Chart,
        page: u32,
        size: u32,
    ) -> ProviderResult<Vec<Track>> {
        let _ = (page, size);
        let url = format!(
            "{RANK_SONG_URL}?version=9108&ranktype=2&plat=0&pagesize=200&area_code=1&page=1\
             &rankid={}&with_res_tag=1",
            crate::provider::qq::urlencode(&chart.id),
        );
        let json = self.get_json(&url).await?;
        let list = data_info(&json).ok_or_else(|| ProviderError::Decode {
            message: "data.info 缺失".into(),
        })?;
        let tracks: Vec<Track> = list.iter().filter_map(song_from_kg).collect();
        if tracks.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(tracks)
    }

    /// `playlist("kg")` 移植（music-api.ts:2390-2456）：
    /// 纯数字 specialid 走 HTML 接口；收藏/分享歌单（global_specialid）走带签名的 v5 接口。
    async fn playlist(&self, id: &str, page: u32, size: u32) -> ProviderResult<Playlist> {
        let _ = (page, size);
        if is_kg_collection_id(id) {
            // 非数字 id 分两种（music-api.ts:2791-2802）：
            // `collection_3_...` 是 global_specialid → 签名 v5 接口；
            // 其余（如 tJnW20zxV3）是分享短码 → chain 接口，用 song_v2 只会拿到空 info。
            if id.starts_with("collection_") {
                return self.collection_playlist(id).await;
            }
            return self.chain_playlist(id).await;
        }
        let url = format!("{SINGLE_URL}/{id}-6-1084.html");
        let html = self.get_text(&url).await?;
        let raw = extract_global_data(&html).ok_or_else(|| ProviderError::Decode {
            message: "global.data 解析失败".into(),
        })?;
        let tracks: Vec<Track> = raw.iter().filter_map(song_from_kg_single).collect();
        if tracks.is_empty() {
            return Err(ProviderError::Empty);
        }
        let (name, pic) = extract_global_meta(&html);
        Ok(Playlist {
            id: id.to_string(),
            platform: SourceId::Kg,
            name,
            pic_url: pic,
            play_count: "0".to_string(),
            description: None,
            tracks: Some(tracks),
        })
    }

    /// `hotWords("kg")` 移植（music-api.ts:1047-1060）：`search/hot` 的 data.info[].keyword。
    async fn hot_words(&self) -> ProviderResult<Vec<String>> {
        let json = self.get_json(HOT_URL).await?;
        let list = data_info(&json).ok_or_else(|| ProviderError::Decode {
            message: "data.info 缺失".into(),
        })?;
        let words: Vec<String> = list
            .iter()
            .map(|item| field_str(item, "keyword"))
            .filter(|w| !w.is_empty())
            .collect();
        if words.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(words)
    }

    /// 对应移动端 `videos()` 的 kg 分支 (music-api.ts:960-988)：
    /// `GET api/v5/video/list?version=9108&plat=0&pagesize={size}&page={page}&id=0&sore=4&short=0`
    /// （`sore` 是源码里排序参数的写法，照抄不改），响应 `data.info[]`
    /// → mvhash / videoname / img（去 `/{size}/`）/ singername。
    async fn videos(&self, page: u32, size: u32) -> ProviderResult<Vec<Video>> {
        let page_no = page.max(1);
        let page_size = if size == 0 { 20 } else { size };
        let url = format!(
            "{MV_LIST_URL}?version=9108&plat=0&pagesize={page_size}&page={page_no}\
             &id=0&sore=4&short=0"
        );
        let json = self.get_json(&url).await?;
        let list = data_info(&json).ok_or_else(|| ProviderError::Decode {
            message: "video/list: data.info 缺失".into(),
        })?;
        let videos: Vec<Video> = list.iter().filter_map(video_from_kg).collect();
        if videos.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(videos)
    }

    /// `searchPlaylist("kg")` 移植（music-api.ts:1473-1492）：`search/special`。
    async fn search_playlists(
        &self,
        kw: &str,
        page: u32,
        size: u32,
    ) -> ProviderResult<Vec<Playlist>> {
        let json = self
            .get_json(&kg_search_url(SEARCH_SPECIAL_URL, kw, page, size))
            .await?;
        let list = data_info(&json).ok_or_else(|| ProviderError::Decode {
            message: "data.info 缺失".into(),
        })?;
        let items: Vec<Playlist> = list.iter().filter_map(playlist_from_kg).collect();
        if items.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(items)
    }

    /// `searchArtist("kg")` 移植（music-api.ts:1587-1608）：`search/singer`，响应 data 本身即数组。
    async fn search_artists(&self, kw: &str, page: u32, size: u32) -> ProviderResult<Vec<Artist>> {
        let json = self
            .get_json(&kg_search_url(SEARCH_SINGER_URL, kw, page, size))
            .await?;
        let list =
            json.get("data")
                .and_then(Value::as_array)
                .ok_or_else(|| ProviderError::Decode {
                    message: "data 缺失".into(),
                })?;
        let items: Vec<Artist> = list.iter().filter_map(artist_from_kg).collect();
        if items.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(items)
    }

    /// `searchAlbum("kg")` 移植（music-api.ts:1712-1731）：`search/album`。
    async fn search_albums(&self, kw: &str, page: u32, size: u32) -> ProviderResult<Vec<Album>> {
        let json = self
            .get_json(&kg_search_url(SEARCH_ALBUM_URL, kw, page, size))
            .await?;
        let list = data_info(&json).ok_or_else(|| ProviderError::Decode {
            message: "data.info 缺失".into(),
        })?;
        let items: Vec<Album> = list.iter().filter_map(album_from_kg).collect();
        if items.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(items)
    }

    /// `artistSongs("kg")` 移植：移动端无歌手歌曲接口，按歌手名搜歌（music-api.ts 同口径）。
    async fn artist_songs(&self, name: &str, page: u32, size: u32) -> ProviderResult<Vec<Track>> {
        self.search_tracks(name, page, size).await
    }

    async fn search_tracks(
        &self,
        kw: &str,
        page: u32,
        size: u32,
    ) -> ProviderResult<Vec<Track>> {
        let page_str = page.to_string();
        let size_str = size.to_string();
        let url = format!(
            "{SEARCH_URL}?version=9108&plat=0&keyword={}&page={page_str}&pagesize={size_str}",
            crate::provider::qq::urlencode(kw),
        );
        let json = self.get_json(&url).await?;
        let list = json
            .get("data")
            .and_then(|d| d.get("info"))
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "data.info 缺失".into(),
            })?;
        let tracks: Vec<Track> = list.iter().filter_map(song_from_kg).collect();
        if tracks.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(tracks)
    }

    async fn play_url(&self, track: &Track, quality: Quality) -> ProviderResult<String> {
        // getSongInfo.php 不带音质参数（与移动端一致），返回什么音质播什么；
        // 原生失败（VIP/无版权）后按 kw → wyy 兜底（移动端 resolvePlayUrl 的 kg 分支）
        let url = format!(
            "{PLAY_INFO_URL}?cmd=playInfo&hash={}",
            crate::provider::qq::urlencode(&track.id)
        );
        if let Ok(json) = self.get_json(&url).await {
            if let Some(u) = json.get("url").and_then(Value::as_str) {
                if !u.is_empty() {
                    return Ok(u.to_string());
                }
            }
        }
        let kw = super::KwProvider::new();
        if let Some((u, matched)) = super::play_via_source(&kw, &track.title, &track.singer, quality).await {
            super::record_source_fallback(&u, &matched);
            return Ok(u);
        }
        let wyy = super::WyyProvider::new();
        if let Some((u, matched)) = super::play_via_source(&wyy, &track.title, &track.singer, quality).await {
            super::record_source_fallback(&u, &matched);
            return Ok(u);
        }
        Err(ProviderError::NoPlayableUrl)
    }

    async fn lyric(&self, track: &Track) -> ProviderResult<Lyric> {
        Ok(Lyric {
            lrc: self.lyric_via_wyy(track).await,
            translation: String::new(),
        })
    }

    /// `videoUrl("kg")` 移植：m.kugou.com/app/i/mv.php（取 le.backupdownurl[0]）
    async fn video_url(&self, id: &str, _quality: &str) -> ProviderResult<String> {
        let url = format!(
            "https://m.kugou.com/app/i/mv.php?cmd=100&ismp3=1&ext=mp4&hash={}",
            crate::provider::qq::urlencode(id)
        );
        let json = self.get_json(&url).await?;
        json.get("mvdata")
            .and_then(|m| m.get("le"))
            .and_then(|l| l.get("backupdownurl"))
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(Value::as_str)
            .filter(|u| !u.is_empty())
            .map(str::to_string)
            .ok_or(ProviderError::NoPlayableUrl)
    }

    async fn cover(&self, track: &Track) -> ProviderResult<String> {
        if !track.pic_url.is_empty() {
            return Ok(track.pic_url.clone());
        }
        let kw = if track.singer.is_empty() {
            track.title.clone()
        } else {
            format!("{} {}", track.title, track.singer)
        };
        let results = self.search_tracks(&kw, 1, 8).await?;
        for hit in results {
            if !hit.pic_url.is_empty() {
                return Ok(hit.pic_url);
            }
        }
        Err(ProviderError::Empty)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真实歌单详情页（id 3339907）里 `global` 块的形态：键值之间有空格、值带注释。
    #[test]
    fn extract_global_meta_reads_name_and_pic() {
        let html = r#"<html><script>
        global = {
            // 域名
            kg_domain: '/yueku/v9',
            id: "3339907", //精选集ID
            name: "乡村之旅：安静惬意·与自然同在", //精选集名字
            pic: "http://c1.kgimg.com/custom/240/20201207/20201207134716994336.jpg", //歌单图片
        };
        </script></html>"#;
        let (name, pic) = extract_global_meta(html);
        assert_eq!(name, "乡村之旅：安静惬意·与自然同在");
        // 封面统一走 normalize_kg_pic（http → https）
        assert_eq!(
            pic,
            "https://c1.kgimg.com/custom/240/20201207/20201207134716994336.jpg"
        );
    }

    /// 没有 global 块 / 没有 name 字段时返回空串而不是 panic。
    #[test]
    fn extract_global_meta_is_defensive() {
        assert_eq!(extract_global_meta("<html></html>").0, "");
        assert_eq!(extract_global_meta("global = { id: \"1\" };").0, "");
    }

    #[test]
    fn normalize_kg_pic_replaces_size_and_https() {
        assert_eq!(
            normalize_kg_pic("http://imge.kugou.com/stdmusic/{size}/20200101/a.jpg"),
            "https://imge.kugou.com/stdmusic/300/20200101/a.jpg"
        );
        assert_eq!(normalize_kg_pic(""), "");
        assert_eq!(
            normalize_kg_pic("https://a.b/c.jpg"),
            "https://a.b/c.jpg"
        );
    }

    #[test]
    fn song_from_kg_maps_fields() {
        let item: Value = serde_json::from_str(
            r#"{
                "hash": "ABC123",
                "filename": "Beyond - 海阔天空",
                "songname": "海阔天空",
                "singers": "Beyond",
                "duration": 324,
                "cover": "http://imge.kugou.com/stdmusic/{size}/a.jpg"
            }"#,
        )
        .unwrap();
        let t = song_from_kg(&item).unwrap();
        assert_eq!(t.id, "ABC123");
        assert_eq!(t.title, "海阔天空");
        assert_eq!(t.singer, "Beyond");
        assert_eq!(
            t.pic_url,
            "https://imge.kugou.com/stdmusic/300/a.jpg"
        );
        assert_eq!(t.duration, 324.0);
    }

    #[test]
    fn song_without_hash_falls_back_to_album_id() {
        let item: Value =
            serde_json::from_str(r#"{"album_id": 99, "songname": "x"}"#).unwrap();
        let t = song_from_kg(&item).unwrap();
        assert_eq!(t.id, "99");
        let empty: Value = serde_json::from_str(r#"{"songname": "x"}"#).unwrap();
        assert!(song_from_kg(&empty).is_none());
    }

    #[test]
    fn playlist_from_kg_maps_fields() {
        let item: Value = serde_json::from_str(
            r#"{
                "specialid": 12345,
                "specialname": "华语精选",
                "img": "http://imge.kugou.com/stdmusic/{size}/a.jpg",
                "playcount": 9999
            }"#,
        )
        .unwrap();
        let p = playlist_from_kg(&item).unwrap();
        assert_eq!(p.id, "12345");
        assert_eq!(p.name, "华语精选");
        assert_eq!(p.pic_url, "https://imge.kugou.com/stdmusic/300/a.jpg");
        assert_eq!(p.play_count, "9999");
        assert!(p.tracks.is_none());
        // 歌单搜索返回 imgurl、推荐返回 img，两者都兼容
        let with_imgurl: Value =
            serde_json::from_str(r#"{"specialid": 1, "imgurl": "https://x/y.jpg"}"#).unwrap();
        assert_eq!(
            playlist_from_kg(&with_imgurl).unwrap().pic_url,
            "https://x/y.jpg"
        );
        let bad: Value = serde_json::from_str(r#"{"specialname": "x"}"#).unwrap();
        assert!(playlist_from_kg(&bad).is_none());
    }

    #[test]
    fn chart_from_kg_strips_size_segment() {
        let item: Value = serde_json::from_str(
            r#"{
                "rankid": 8888,
                "rankname": "热歌榜",
                "imgurl": "http://imge.kugou.com/stdmusic/{size}/2020.jpg"
            }"#,
        )
        .unwrap();
        let c = chart_from_kg(&item).unwrap();
        assert_eq!(c.id, "8888");
        assert_eq!(c.name, "热歌榜");
        assert_eq!(c.pic_url, "https://imge.kugou.com/stdmusic/2020.jpg");
        assert_eq!(c.description.as_deref(), Some(""));
    }

    #[test]
    fn artist_and_album_from_kg_map_fields() {
        let singer: Value =
            serde_json::from_str(r#"{"singerid": 3520, "singername": "周杰伦"}"#).unwrap();
        let a = artist_from_kg(&singer).unwrap();
        assert_eq!(a.id, "3520");
        assert_eq!(a.name, "周杰伦");
        assert_eq!(
            a.pic_url,
            "https://singerimg.kugou.com/uploadpic/softhead/300/3520.jpg"
        );

        let album: Value = serde_json::from_str(
            r#"{
                "albumid": 77123,
                "albumname": "叶惠美",
                "singername": "周杰伦",
                "imgurl": "http://imge.kugou.com/stdmusic/{size}/b.jpg"
            }"#,
        )
        .unwrap();
        let al = album_from_kg(&album).unwrap();
        assert_eq!(al.id, "77123");
        assert_eq!(al.name, "叶惠美");
        assert_eq!(al.artist, "周杰伦");
        assert_eq!(al.pic_url, "https://imge.kugou.com/stdmusic/300/b.jpg");
    }

    #[test]
    fn song_from_kg_single_prefers_union_cover() {
        let item: Value = serde_json::from_str(
            r#"{
                "hash": "H1",
                "songname": "晴天",
                "singername": "周杰伦",
                "album_name": "叶惠美",
                "duration": 269,
                "trans_param": { "union_cover": "http://imge.kugou.com/stdmusic/{size}/u.jpg" },
                "cover": "http://x/c.jpg"
            }"#,
        )
        .unwrap();
        let t = song_from_kg_single(&item).unwrap();
        assert_eq!(t.id, "H1");
        assert_eq!(t.title, "晴天");
        assert_eq!(t.singer, "周杰伦");
        assert_eq!(t.album, "叶惠美");
        assert_eq!(t.pic_url, "https://imge.kugou.com/stdmusic/300/u.jpg");
        assert_eq!(t.duration, 269.0);

        // 无 union_cover 时回落到 cover；duration 写成字符串也能解析
        let plain: Value = serde_json::from_str(
            r#"{"album_id": "A1", "cover": "http://x/c.jpg", "duration": "200"}"#,
        )
        .unwrap();
        let t2 = song_from_kg_single(&plain).unwrap();
        assert_eq!(t2.id, "A1");
        assert_eq!(t2.pic_url, "https://x/c.jpg");
        assert_eq!(t2.duration, 200.0);

        let empty: Value = serde_json::from_str(r#"{"songname": "x"}"#).unwrap();
        assert!(song_from_kg_single(&empty).is_none());
    }

    #[test]
    fn kg_signature_matches_reference_implementation() {
        // 基准值用 Node（crypto/md5）按 kg-sign.ts 同款算法算出，
        // 保证 Rust 与移动端签名逐字节一致（签名错一个字符酷狗就回 errcode:1001）
        let id = "tJnW20zxV3";
        let song = format!(
            "appid=1058&global_specialid={id}&specialid=0&plat=0&version=8000&page=1&pagesize=1000&srcappid=2919&clientver=20000&clienttime={MOBILE_CLIENTTIME_SONG}&mid={MOBILE_CLIENTTIME_SONG}&uuid={MOBILE_CLIENTTIME_SONG}&dfid=-"
        );
        let info = format!(
            "appid=1058&global_specialid={id}&specialid=0&format=jsonp&srcappid=2919&clientver=20000&clienttime={MOBILE_CLIENTTIME_INFO}&mid={MOBILE_CLIENTTIME_INFO}&uuid={MOBILE_CLIENTTIME_INFO}&dfid=-"
        );
        assert_eq!(kg_signature(&song), "0d50ed3394d065bd8748204a7e00dc68");
        assert_eq!(kg_signature(&info), "53139a00cfe34ffee0e43dd0647aff66");
    }

    #[test]
    fn kg_mobile_url_appends_signature() {
        let params = "appid=1058&specialid=0";
        assert_eq!(
            kg_mobile_url("special/song_v2", params),
            format!(
                "https://mobiles.kugou.com/api/v5/special/song_v2?{params}&signature={}",
                kg_signature(params)
            )
        );
    }

    #[test]
    fn song_from_kg_collection_splits_filename() {
        let item: Value = serde_json::from_str(
            r#"{"hash":"H1","filename":"周杰伦 - 晴天","remark":"叶惠美","duration":269,
                "trans_param":{"union_cover":"http://imge.kugou.com/stdmusic/{size}/u.jpg"}}"#,
        )
        .unwrap();
        let t = song_from_kg_collection(&item).unwrap();
        assert_eq!(t.id, "H1");
        assert_eq!(t.singer, "周杰伦");
        assert_eq!(t.title, "晴天");
        assert_eq!(t.album, "叶惠美");
        assert_eq!(t.pic_url, "https://imge.kugou.com/stdmusic/300/u.jpg");
        assert_eq!(t.duration, 269.0);
        assert_eq!(t.music_id.as_deref(), Some("H1"));

        // 无 hash 回落到 album_id；filename 没有「 - 」时整串当歌名
        let plain: Value =
            serde_json::from_str(r#"{"album_id":"A1","filename":"晴天","duration":200}"#).unwrap();
        let t2 = song_from_kg_collection(&plain).unwrap();
        assert_eq!(t2.id, "A1");
        assert_eq!(t2.title, "晴天");
        assert_eq!(t2.singer, "");

        // 既无 hash 也无 album_id 的项直接丢弃
        let no_id: Value = serde_json::from_str(r#"{"filename":"x"}"#).unwrap();
        assert!(song_from_kg_collection(&no_id).is_none());

        // nohash 不是可用的播放键
        let nohash: Value =
            serde_json::from_str(r#"{"hash":"nohash","filename":"a - b"}"#).unwrap();
        assert_eq!(song_from_kg_collection(&nohash).unwrap().music_id, None);
    }

    #[test]
    fn song_from_kg_chain_splits_name() {
        let item: Value = serde_json::from_str(
            r#"{"hash":"H1","name":"周杰伦 - 晴天","timelen":269000,
                "trans_param":{"union_cover":"http://imge.kugou.com/stdmusic/{size}/u.jpg"}}"#,
        )
        .unwrap();
        let t = song_from_kg_chain(&item).unwrap();
        assert_eq!(t.id, "H1");
        assert_eq!(t.singer, "周杰伦");
        assert_eq!(t.title, "晴天");
        assert_eq!(t.album, "");
        assert_eq!(t.pic_url, "https://imge.kugou.com/stdmusic/300/u.jpg");
        // timelen 是毫秒，Track.duration 是秒
        assert_eq!(t.duration, 269.0);
        assert_eq!(t.music_id, None);

        // 无 hash 回落 album_id；没有「 - 」时整串当歌名
        let plain: Value =
            serde_json::from_str(r#"{"album_id":"A1","name":"晴天","timelen":200000}"#).unwrap();
        let t2 = song_from_kg_chain(&plain).unwrap();
        assert_eq!(t2.id, "A1");
        assert_eq!(t2.title, "晴天");
        assert_eq!(t2.singer, "");
        assert_eq!(t2.duration, 200.0);

        let no_id: Value = serde_json::from_str(r#"{"name":"x"}"#).unwrap();
        assert!(song_from_kg_chain(&no_id).is_none());
    }

    /// 线上那个收藏歌单能否打开（真实网络请求，默认不跑）：
    /// `cargo test --lib -- --ignored kg_collection_playlist_live`
    #[tokio::test]
    #[ignore]
    async fn kg_collection_playlist_live() {
        let provider = KgProvider::new();
        let playlist = provider.playlist("tJnW20zxV3", 1, 100).await.unwrap();
        let count = playlist.tracks.as_ref().map(|t| t.len()).unwrap_or(0);
        println!(
            "name={} pic={} play_count={} tracks={}",
            playlist.name, playlist.pic_url, playlist.play_count, count
        );
        if let Some(first) = playlist.tracks.as_ref().and_then(|t| t.first()) {
            println!(
                "first: {} / {} / {} / duration={} / pic={}",
                first.id, first.title, first.singer, first.duration, first.pic_url
            );
        }
        assert!(count > 0, "应至少解析出一首歌");
    }

    #[test]
    fn html_playlist_parsing_without_regex() {
        let html = r#"<html><script>
var global = {id:"12345",name:"我的歌单",pic:"http://imge.kugou.com/stdmusic/{size}/cover.jpg"};
var global.data = [{"hash":"H1","songname":"晴天","singername":"周杰伦","duration":269}];
</script></html>"#;
        let raw = extract_global_data(html).expect("global.data 应解析成功");
        assert_eq!(raw.len(), 1);
        assert_eq!(song_from_kg_single(&raw[0]).unwrap().id, "H1");
        let (name, pic) = extract_global_meta(html);
        assert_eq!(name, "我的歌单");
        assert_eq!(pic, "https://imge.kugou.com/stdmusic/300/cover.jpg");
        assert!(extract_global_data("<html>nothing</html>").is_none());
    }

    #[test]
    fn collection_id_detection_and_search_url() {
        assert!(is_kg_collection_id("collection_3_2004554843_3_0"));
        assert!(is_kg_collection_id("12ab"));
        assert!(is_kg_collection_id(""));
        assert!(!is_kg_collection_id("1084"));

        let url = kg_search_url(SEARCH_SINGER_URL, "周杰伦 晴天", 2, 30);
        assert!(url.starts_with(
            "http://mobilecdnbj.kugou.com/api/v3/search/singer?version=9108&plat=0&keyword="
        ));
        assert!(url.contains("%E5%91%A8%E6%9D%B0%E4%BC%A6"));
        assert!(url.ends_with("&page=2&pagesize=30"));
        // 页码 / 页大小传 0 时归一（页码从 1 起）
        assert!(kg_search_url(SEARCH_ALBUM_URL, "x", 0, 0).ends_with("&page=1&pagesize=20"));
    }

    #[test]
    fn video_from_kg_maps_fields_and_strips_size_segment() {
        let item: Value = serde_json::from_str(
            r#"{
                "mvhash": "ABC123",
                "videoname": "海阔天空",
                "img": "http://imge.kugou.com/stdmusic/{size}/20200101/mv.jpg",
                "singername": "Beyond"
            }"#,
        )
        .unwrap();
        let v = video_from_kg(&item).unwrap();
        assert_eq!(v.id, "ABC123");
        assert_eq!(v.name, "海阔天空");
        assert_eq!(v.singer, "Beyond");
        assert_eq!(v.platform, SourceId::Kg);
        // 先去掉 `/{size}/`，再过 normalize_kg_pic（http → https）
        assert_eq!(v.pic_url, "https://imge.kugou.com/stdmusic/20200101/mv.jpg");
    }

    #[test]
    fn video_from_kg_rejects_empty_mvhash_and_missing_img() {
        assert!(video_from_kg(&serde_json::from_str(r#"{"videoname": "x"}"#).unwrap()).is_none());
        let item: Value = serde_json::from_str(r#"{"mvhash": "H1", "videoname": "x"}"#).unwrap();
        let v = video_from_kg(&item).unwrap();
        assert_eq!(v.pic_url, "");
        assert_eq!(v.singer, "");
    }
}
