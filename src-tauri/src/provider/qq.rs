//! qq（QQ音乐）Provider —— 移植自 `qt-uniappx/services/music-api.ts`（只读参考，不引用）。
//!
//! 移植范围：
//! - `search_tracks` ← `search(keyword, "qq", "song", page, size)`：
//!   `GET c.y.qq.com/soso/fcgi-bin/client_search_cp`（platform=yqq, g_tk=5381）
//! - `play_url`      ← `fetchNativeUrl("qq")`：musicu.fcg + vkey.GetVkeyServer/CgiGetVkey
//!   （M500=128K mp3 / M800=320K mp3 / F000=flac；guid 与移动端一致）
//! - `lyric`         ← `lyrics("qq")`：fcg_query_lyric_new.fcg（nobase64=1）
//! - 发现类（M5）    ← `playlistCategories / recommendations / latest / charts / chartDetail /
//!   playListDetail / hotWords / searchPlaylists / searchArtists / searchAlbums / artistSongs`
//!   的 qq 分支
//!
//! 请求头与移动端 `makeHeaders("qq")` 一致：Referer https://y.qq.com/、Content-Type json

use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::types::{
    Album, Artist, Chart, Lyric, Playlist, PlaylistCategory, ProviderError, ProviderResult, Quality,
    SourceId, Track, Video,
};
use super::{check_status, MusicProvider, ProviderCapabilities};

const UA: &str = "Mozilla/5.0";
/// 桌面端搜索接口（`DoSearchForQQMusicDesktop`）只认 IE 内核 UA，否则不返回数据
/// （移动端 `qqMusicSearch` 同款注释）。
const IE_UA: &str = "Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)";
const REFERER: &str = "https://y.qq.com/";
const SEARCH_URL: &str = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp";
const MUSICU_URL: &str = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const LYRIC_URL: &str = "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg";
/// 歌单分类（移动端 playlistCategories 的 qq 分支）
const CATEGORY_URL: &str = "https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_tag_conf.fcg";
/// 分类/推荐歌单（移动端 recommendations 的 qq 分支）
const RECOMMEND_URL: &str = "https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg";
/// 排行榜列表（移动端 charts 的 qq 分支）
const TOPLIST_URL: &str = "https://c.y.qq.com/v8/fcg-bin/fcg_myqq_toplist.fcg";
/// 榜单详情（移动端 chartDetail 的 qq 分支）
const TOPLIST_DETAIL_URL: &str = "https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg";
/// 歌单详情（移动端 playListDetail 的 qq 分支）
const PLAYLIST_URL: &str = "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg";
/// 搜索热词（移动端 hotWords 的 qq 分支）
// 实测：`hotcgi.qq.com/splcloud/...` 已 404，去掉多余主机名后正常返回数据
const HOTKEY_URL: &str = "https://c.y.qq.com/splcloud/fcgi-bin/gethotkey.fcg";
/// 专辑/歌曲封面前缀（移动端 songFromQQ 同款拼接）
const PIC_ALBUM: &str = "https://y.qq.com/music/photo_new/T002R300x300M000";
/// 歌手头像前缀（移动端 albumFromQQ / artistFromQQ 同款拼接）
const PIC_SINGER: &str = "https://y.qq.com/music/photo_new/T001R300x300M000";
/// 与移动端一致的固定 guid（vkey 接口不校验其真实性）
const GUID: &str = "6f7a1c3c8a2b4d5e6f7a";

pub struct QqProvider {
    http: reqwest::Client,
}

impl Default for QqProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl QqProvider {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("reqwest client init");
        Self { http }
    }

    async fn get_json(&self, url: &str) -> ProviderResult<Value> {
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
            .json::<Value>()
            .await
            .map_err(|e| ProviderError::Decode {
                message: e.to_string(),
            })
    }

    /// 发现类接口统一走这里：GET + query 数组（由 reqwest 负责编码，中文关键词不会出错）。
    async fn get_query(&self, url: &str, params: &[(&str, &str)]) -> ProviderResult<Value> {
        let resp = self
            .http
            .get(url)
            .query(params)
            .header("User-Agent", UA)
            .header("Referer", REFERER)
            .header("Content-Type", "application/json")
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

    async fn post_json(&self, url: &str, body: &Value) -> ProviderResult<Value> {
        self.post_json_ua(url, body, UA).await
    }

    /// 指定 UA 的 POST（仅桌面端搜索需要 IE 内核 UA）。
    async fn post_json_ua(&self, url: &str, body: &Value, ua: &str) -> ProviderResult<Value> {
        let resp = self
            .http
            .post(url)
            .header("User-Agent", ua)
            .header("Referer", REFERER)
            .header("Content-Type", "application/json")
            .json(body)
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

    /// 跨源兜底：kw → wyy（与移动端 resolvePlayUrl 的 qq 分支一致）
    async fn cross_fallback(&self, track: &Track, quality: Quality) -> ProviderResult<String> {
        let kw = super::KwProvider::new();
        if let Some(url) = super::play_via_source(&kw, &track.title, &track.singer, quality).await {
            return Ok(url);
        }
        let wyy = super::WyyProvider::new();
        if let Some(url) =
            super::play_via_source(&wyy, &track.title, &track.singer, quality).await
        {
            return Ok(url);
        }
        Err(ProviderError::NoPlayableUrl)
    }

    /// vkey 取址（`fetchNativeUrl("qq")` 移植）：sip[0] + midurlinfo[0].purl。
    async fn fetch_vkey_url(&self, songmid: &str, quality: Quality) -> ProviderResult<String> {        // 音质映射：M500=128K mp3、M800=320K mp3、F000=flac 无损
        let (prefix, ext) = match quality {
            Quality::Standard => ("M500", "mp3"),
            Quality::High => ("M800", "mp3"),
            Quality::Lossless => ("F000", "flac"),
        };
        let filename = format!("{prefix}{songmid}.{ext}");
        let body = json!({
            "req_0": {
                "module": "vkey.GetVkeyServer",
                "method": "CgiGetVkey",
                "param": {
                    "guid": GUID,
                    "songmid": [songmid],
                    "songtype": [0],
                    "uin": "0",
                    "loginflag": 1,
                    "platform": "20",
                    "filename": [filename],
                },
            },
            "comm": { "uin": 0, "format": "json", "ct": 24, "cv": 0 },
        });
        let json = self.post_json(MUSICU_URL, &body).await?;
        let data = json
            .get("req_0")
            .and_then(|r| r.get("data"))
            .ok_or(ProviderError::NoPlayableUrl)?;
        let sip = data
            .get("sip")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(Value::as_str)
            .unwrap_or_default();
        let purl = data
            .get("midurlinfo")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(|i| i.get("purl"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if sip.is_empty() || purl.is_empty() {
            // QQ 拿不到所选音质（VIP/无权限）；换源兜底属于播放页换源逻辑（DESIGN §6.8）
            return Err(ProviderError::NoPlayableUrl);
        }
        Ok(format!("{sip}{purl}"))
    }
}

/// `songFromQQSearch` 移植：client_search_cp 歌曲项。
fn song_from_qq_search(item: &Value) -> Option<Track> {
    let id = item
        .get("songmid")
        .and_then(Value::as_str)
        .or_else(|| item.get("mid").and_then(Value::as_str))?;
    // client_search_cp 歌名字段是 songname（顶层）
    let name = item
        .get("songname")
        .and_then(Value::as_str)
        .or_else(|| item.get("name").and_then(Value::as_str))
        .unwrap_or_default();
    let singer = item
        .get("singer")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(|s| s.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let album = item
        .get("albumname")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let pic_url = item
        .get("albummid")
        .and_then(Value::as_str)
        .map(|mid| format!("https://y.qq.com/music/photo_new/T002R300x300M000{mid}.jpg"))
        .unwrap_or_default();
    let duration = item.get("interval").and_then(Value::as_f64).unwrap_or(0.0);

    Some(Track {
        id: id.to_string(),
        platform: SourceId::Qq,
        title: name.to_string(),
        singer: singer.to_string(),
        album: album.to_string(),
        pic_url,
        duration,
        music_id: None,
    })
}

// ---------- 发现类字段 / 实体映射（与移动端 playlistFromQQ / songFromQQ / songFromQQDetail
// ---------- / albumFromQQ 一一对应）----------

/// QQ 各接口的「数字」字段可能是 number 也可能是 string（dissid / categoryId / listen_num 都
/// 见过两种形态），统一取字符串，缺失或 null 返回空串。
fn as_string(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// 取字段并转字符串（缺失返回空串）。
fn str_of(item: &Value, key: &str) -> String {
    as_string(item.get(key))
}

/// 取数值字段（number 或数字字符串），取不到返回 0。
fn num_of(item: &Value, key: &str) -> f64 {
    match item.get(key) {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// 取 `singer[0].name`（新歌 / 榜单 / 详情三种结构共用）。
fn first_singer(item: &Value) -> String {
    item.get("singer")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .map(|s| str_of(s, "name"))
        .unwrap_or_default()
}

/// 专辑封面：albummid 为空时返回空串（与移动端 songFromQQ 一致）。
fn album_pic(item: &Value, mid_key: &str) -> String {
    let mid = str_of(item, mid_key);
    if mid.is_empty() {
        String::new()
    } else {
        format!("{PIC_ALBUM}{mid}.jpg")
    }
}

/// QQ 各接口对「封面」的字段名不统一（imgurl / picurl / picUrl / dir_pic_url / logo…），
/// 逐个取第一个非空值；全空时返回空串，由调用方决定是否回退到曲目封面。
fn first_non_empty(item: &Value, keys: &[&str]) -> String {
    for key in keys {
        let v = str_of(item, key);
        if !v.is_empty() {
            return v;
        }
    }
    String::new()
}

/// `playlistFromQQ` 移植：dissid / dissname / imgurl / listennum。
/// 推荐歌单列表与搜索歌单结果同构，因此两处共用（移动端两处也是同一套字段）。
fn playlist_from_qq(item: &Value) -> Option<Playlist> {
    let id = str_of(item, "dissid");
    if id.is_empty() {
        return None;
    }
    let play_count = str_of(item, "listennum");
    Some(Playlist {
        id,
        platform: SourceId::Qq,
        name: str_of(item, "dissname"),
        pic_url: first_non_empty(item, &["imgurl", "picurl", "picUrl", "imgurl_640"]),
        play_count: if play_count.is_empty() {
            "0".to_string()
        } else {
            play_count
        },
        description: None,
        tracks: None,
    })
}

/// `songFromQQ` 移植：新歌速递（newsong.NewSongServer）结构 ——
/// mid / name / album.name / album.mid / singer[0].name，interval 单位**已是秒**（不除 1000）。
fn song_from_qq_new(item: &Value) -> Option<Track> {
    let mut id = str_of(item, "mid");
    if id.is_empty() {
        id = str_of(item, "songmid");
    }
    if id.is_empty() {
        return None;
    }
    let name = str_of(item, "name");
    let album = item.get("album");
    Some(Track {
        id,
        platform: SourceId::Qq,
        title: if name.is_empty() {
            str_of(item, "songname")
        } else {
            name
        },
        singer: first_singer(item),
        album: album.map(|a| str_of(a, "name")).unwrap_or_default(),
        pic_url: album.map(|a| album_pic(a, "mid")).unwrap_or_default(),
        duration: num_of(item, "interval"),
        music_id: None,
    })
}

/// `songFromQQDetail` 移植：榜单 / 歌单详情结构 ——
/// songmid / songname / albumname / albummid / singer[0].name，interval 单位**已是秒**。
fn song_from_qq_detail(item: &Value) -> Option<Track> {
    let id = str_of(item, "songmid");
    if id.is_empty() {
        return None;
    }
    let name = str_of(item, "songname");
    Some(Track {
        id,
        platform: SourceId::Qq,
        title: if name.is_empty() {
            str_of(item, "name")
        } else {
            name
        },
        singer: first_singer(item),
        album: str_of(item, "albumname"),
        pic_url: album_pic(item, "albummid"),
        duration: num_of(item, "interval"),
        music_id: None,
    })
}

/// `videos()` 的 qq 项映射（music-api.ts:923-934）：
/// vid / title / picurl / singers[0].name（singers 缺失或空数组时歌手为空串）。
/// vid 为空的项直接丢弃 —— 前端按 id 换播放地址，空 id 无法播放。
fn video_from_qq(item: &Value) -> Option<Video> {
    let id = str_of(item, "vid");
    if id.is_empty() {
        return None;
    }
    Some(Video {
        id,
        platform: SourceId::Qq,
        name: str_of(item, "title"),
        pic_url: str_of(item, "picurl"),
        singer: item
            .get("singers")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .map(|s| str_of(s, "name"))
            .unwrap_or_default(),
    })
}

#[async_trait]
impl MusicProvider for QqProvider {
    fn id(&self) -> SourceId {
        SourceId::Qq
    }

    fn name(&self) -> &'static str {
        "qq"
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            // 发现类（M5）：分类 / 推荐歌单 / 新歌 / 榜单 / 榜单详情 / 歌单详情
            playlist_categories: true,
            recommendations: true,
            latest: true,
            charts: true,
            chart_detail: true,
            playlist_detail: true,
            // 搜索：歌曲（M0 已有）+ 歌单 / 歌手 / 专辑
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

    /// 对应移动端 `playlistCategories` 的 qq 分支：
    /// `GET splcloud/fcg_get_diss_tag_conf.fcg` → `data.categories[].items[]`。
    /// 移动端不分组（只有 categoryId / categoryName），因此 `group` 恒为 None。
    async fn playlist_categories(&self) -> ProviderResult<Vec<PlaylistCategory>> {
        let json = self
            .get_query(
                CATEGORY_URL,
                &[("format", "json"), ("inCharset", "utf8"), ("outCharset", "utf-8")],
            )
            .await?;
        let groups = json
            .get("data")
            .and_then(|d| d.get("categories"))
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "data.categories 缺失".into(),
            })?;
        let mut out = Vec::new();
        for group in groups {
            let Some(items) = group.get("items").and_then(Value::as_array) else {
                continue;
            };
            for item in items {
                let id = as_string(item.get("categoryId"));
                let name = as_string(item.get("categoryName"));
                if id.is_empty() || name.is_empty() {
                    continue;
                }
                out.push(PlaylistCategory {
                    id,
                    name,
                    group: None,
                });
            }
        }
        if out.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(out)
    }

    /// 对应移动端 `recommendations` 的 qq 分支：`GET splcloud/fcg_get_diss_by_tag.fcg`。
    /// page 从 1 开始，pageSize 固定 30，映射为 sin/ein（闭区间）。
    async fn recommendations(
        &self,
        category: Option<&str>,
        page: u32,
    ) -> ProviderResult<Vec<Playlist>> {
        const PAGE_SIZE: u32 = 30;
        let page_no = page.max(1);
        let offset = (page_no - 1) * PAGE_SIZE;
        // 空分类取「全部」（移动端默认 10000000）
        let category_id = category.filter(|c| !c.is_empty()).unwrap_or("10000000");
        let sin = offset.to_string();
        let ein = (offset + PAGE_SIZE - 1).to_string();
        let json = self
            .get_query(
                RECOMMEND_URL,
                &[
                    ("picmid", "1"),
                    ("g_tk", "732560869"),
                    ("loginUin", "0"),
                    ("hostUin", "0"),
                    ("format", "json"),
                    ("inCharset", "utf8"),
                    ("outCharset", "utf-8"),
                    ("notice", "0"),
                    ("platform", "yqq.json"),
                    ("needNewCode", "0"),
                    ("categoryId", category_id),
                    ("sortId", "2"),
                    ("sin", &sin),
                    ("ein", &ein),
                ],
            )
            .await?;
        let data = json.get("data").ok_or_else(|| ProviderError::Decode {
            message: "data 缺失".into(),
        })?;
        // 翻到末页时 data.list 可能不存在，按「没更多」处理
        let Some(list) = data.get("list").and_then(Value::as_array) else {
            return Err(ProviderError::Empty);
        };
        let playlists: Vec<Playlist> = list.iter().filter_map(playlist_from_qq).collect();
        if playlists.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(playlists)
    }

    /// 对应移动端 `latest` 的 qq 分支：POST musicu.fcg + `newsong.NewSongServer`。
    /// 该接口不支持分页（移动端同样忽略 offset 只按 limit 截断），因此 offset 仅保留签名。
    async fn latest(&self, limit: u32, offset: u32) -> ProviderResult<Vec<Track>> {
        let _ = offset;
        let body = json!({
            "comm": { "ct": 24, "cv": 0 },
            "new_song": {
                "module": "newsong.NewSongServer",
                "method": "get_new_song_info",
                "param": { "type": 5 },
            },
        });
        let json = self.post_json(MUSICU_URL, &body).await?;
        // 部分网关把模块包在 response 下，两种形态都兼容
        let songlist = json
            .get("response")
            .and_then(|r| r.get("new_song"))
            .or_else(|| json.get("new_song"))
            .and_then(|n| n.get("data"))
            .and_then(|d| d.get("songlist"))
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "new_song.data.songlist 缺失".into(),
            })?;
        let tracks: Vec<Track> = songlist
            .iter()
            .take(limit as usize)
            .filter_map(song_from_qq_new)
            .collect();
        if tracks.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(tracks)
    }

    /// 对应移动端 `charts` 的 qq 分支：`GET v8/fcg_myqq_toplist.fcg` → `data.topList[]`。
    async fn charts(&self) -> ProviderResult<Vec<Chart>> {
        let json = self
            .get_query(TOPLIST_URL, &[("format", "json"), ("g_tk", "5381"), ("uin", "0")])
            .await?;
        let list = json
            .get("data")
            .and_then(|d| d.get("topList"))
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "data.topList 缺失".into(),
            })?;
        let charts: Vec<Chart> = list
            .iter()
            .map(|item| Chart {
                id: as_string(item.get("id")),
                platform: SourceId::Qq,
                name: str_of(item, "topTitle"),
                pic_url: str_of(item, "picUrl"),
                // 移动端 chartFromQQ 恒为空简介
                description: Some(String::new()),
            })
            .filter(|c| !c.id.is_empty())
            .collect();
        if charts.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(charts)
    }

    /// 对应移动端 `chartDetail` 的 qq 分支：`GET v8/fcg_v8_toplist_cp.fcg`。
    /// 接口固定返回 200 首，无分页参数，因此忽略 page / size。
    async fn chart_detail(
        &self,
        chart: &Chart,
        page: u32,
        size: u32,
    ) -> ProviderResult<Vec<Track>> {
        let _ = (page, size);
        let json = self
            .get_query(
                TOPLIST_DETAIL_URL,
                &[
                    ("topid", chart.id.as_str()),
                    ("format", "json"),
                    ("page", "1"),
                    ("type", "top"),
                    ("song_begin", "0"),
                    ("song_num", "200"),
                    ("g_tk", "5381"),
                ],
            )
            .await?;
        let list = json
            .get("songlist")
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "songlist 缺失".into(),
            })?;
        // 每项再取 .data 才是歌曲本体
        let tracks: Vec<Track> = list
            .iter()
            .filter_map(|item| item.get("data"))
            .filter_map(song_from_qq_detail)
            .collect();
        if tracks.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(tracks)
    }

    /// 对应移动端 `playListDetail` 的 qq 分支：`GET qzone/fcg_ucc_getcdinfo_byids_cp.fcg`。
    /// 接口一次返回全量歌曲，无分页，因此忽略 page / size。
    async fn playlist(&self, id: &str, page: u32, size: u32) -> ProviderResult<Playlist> {
        let _ = (page, size);
        let json = self
            .get_query(
                PLAYLIST_URL,
                &[
                    ("type", "1"),
                    ("json", "1"),
                    ("utf8", "1"),
                    ("onlysong", "0"),
                    ("disstid", id),
                    ("format", "json"),
                    ("g_tk", "5381"),
                ],
            )
            .await?;
        // cdlist 为空 = 歌单不存在 / 无权限 / 隐私歌单（实测会回
        // {"code":0,"subcode":4000,"msg":"check privacy error!"}）。
        // 有 msg 就把上游原因透传给前端，别只报「无结果」。
        let cd = match json
            .get("cdlist")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
        {
            Some(cd) => cd,
            None => {
                let msg = str_of(&json, "msg");
                if msg.is_empty() {
                    return Err(ProviderError::Empty);
                }
                return Err(ProviderError::Decode {
                    message: format!("歌单为隐私或暂不可访问（{msg}）"),
                });
            }
        };
        let songs: Vec<Track> = cd
            .get("songlist")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(song_from_qq_detail).collect())
            .unwrap_or_default();
        let play_count = str_of(cd, "listen_num");
        Ok(Playlist {
            id: id.to_string(),
            platform: SourceId::Qq,
            name: str_of(cd, "dissname"),
            // 榜单/歌单详情有时不给封面字段，回退用第一首歌的封面，不至于整卡空白
            pic_url: {
                let p = first_non_empty(cd, &["dir_pic_url", "logo", "picurl", "picUrl", "headurl"]);
                if p.is_empty() {
                    songs.first().map(|t| t.pic_url.clone()).unwrap_or_default()
                } else {
                    p
                }
            },
            play_count: if play_count.is_empty() {
                "0".to_string()
            } else {
                play_count
            },
            description: None,
            tracks: Some(songs),
        })
    }

    /// 对应移动端 `hotWords` 的 qq 分支：`GET gethotkey.fcg` → `data.hotkey[].k`。
    async fn hot_words(&self) -> ProviderResult<Vec<String>> {
        let json = self
            .get_query(HOTKEY_URL, &[("format", "json"), ("g_tk", "5381")])
            .await?;
        let list = json
            .get("data")
            .and_then(|d| d.get("hotkey"))
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "data.hotkey 缺失".into(),
            })?;
        let words: Vec<String> = list
            .iter()
            .map(|item| str_of(item, "k"))
            .filter(|w| !w.is_empty())
            .collect();
        if words.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(words)
    }

    /// 对应移动端 `videos()` 的 qq 分支（music-api.ts:899-936）：
    /// POST musicu.fcg + `MvService.MvInfoProServer / GetAllocMvInfo`，
    /// 分页按 `start = (page - 1) * size` + `size`（version_id=8 / area_id=15 / order=1），
    /// 响应 `mv_list.data.list[]` → vid / title / picurl / singers[0].name。
    async fn videos(&self, page: u32, size: u32) -> ProviderResult<Vec<Video>> {
        let page_no = page.max(1);
        let page_size = if size == 0 { 20 } else { size };
        let start = (page_no - 1).saturating_mul(page_size);
        let body = json!({
            "comm": { "ct": 24, "cv": 0 },
            "mv_list": {
                "module": "MvService.MvInfoProServer",
                "method": "GetAllocMvInfo",
                "param": {
                    "start": start,
                    "size": page_size,
                    "version_id": 8,
                    "area_id": 15,
                    "order": 1,
                },
            },
        });
        let json = self.post_json(MUSICU_URL, &body).await?;
        let list = json
            .get("mv_list")
            .and_then(|m| m.get("data"))
            .and_then(|d| d.get("list"))
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "mv_list.data.list 缺失".into(),
            })?;
        let videos: Vec<Video> = list.iter().filter_map(video_from_qq).collect();
        if videos.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(videos)
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
            "{SEARCH_URL}?format=json&w={}&p={page_str}&n={size_str}&platform=yqq&g_tk=5381",
            urlencode(kw),
        );
        let json = self.get_json(&url).await?;
        let list = json
            .get("data")
            .and_then(|d| d.get("song"))
            .and_then(|s| s.get("list"))
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "data.song.list 缺失".into(),
            })?;
        let tracks: Vec<Track> = list.iter().filter_map(song_from_qq_search).collect();
        if tracks.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(tracks)
    }

    /// 对应移动端 `searchPlaylists` 的 qq 分支：musicu.fcg +
    /// `music.search.SearchCgiService / DoSearchForQQMusicDesktop`（search_type=3）。
    /// 必须带 IE 内核 UA，否则接口不返回数据。
    async fn search_playlists(
        &self,
        kw: &str,
        page: u32,
        size: u32,
    ) -> ProviderResult<Vec<Playlist>> {
        let body = json!({
            "comm": { "ct": "19", "cv": "1859", "uin": "0" },
            "req": {
                "module": "music.search.SearchCgiService",
                "method": "DoSearchForQQMusicDesktop",
                "param": {
                    "grp": 1,
                    "num_per_page": size,
                    "page_num": page,
                    "query": kw,
                    "search_type": 3,
                },
            },
        });
        let json = self.post_json_ua(MUSICU_URL, &body, IE_UA).await?;
        // 顶层 code !== 0 视为接口拒绝（风控 / 参数异常）
        let code = json.get("code").and_then(Value::as_i64).unwrap_or(0);
        if code != 0 {
            return Err(ProviderError::Decode {
                message: format!("QQ 搜索失败 code={code}"),
            });
        }
        // 结果体在 req.data.body.songlist.list[]；移动端这里是 try/catch 吞异常返回 []，
        // 因此结构缺失按「无结果」处理而不是 Decode
        let Some(list) = json
            .get("req")
            .and_then(|r| r.get("data"))
            .and_then(|d| d.get("body"))
            .and_then(|b| b.get("songlist"))
            .and_then(|s| s.get("list"))
            .and_then(Value::as_array)
        else {
            return Err(ProviderError::Empty);
        };
        let playlists: Vec<Playlist> = list.iter().filter_map(playlist_from_qq).collect();
        if playlists.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(playlists)
    }

    /// 对应移动端 `searchArtists` 的 qq 分支：`GET client_search_cp`（t=2，catZhida=1）。
    /// 歌手只在 `data.zhida.zhida_singer` 里给**单个**直达对象，因此最多返回 1 条。
    async fn search_artists(&self, kw: &str, page: u32, size: u32) -> ProviderResult<Vec<Artist>> {
        let page_str = page.to_string();
        let size_str = size.to_string();
        let json = self
            .get_query(
                SEARCH_URL,
                &[
                    ("format", "json"),
                    ("w", kw),
                    ("t", "2"),
                    ("p", &page_str),
                    ("n", &size_str),
                    ("platform", "yqq"),
                    ("g_tk", "5381"),
                    ("remoteplace", "txt.yqq.search"),
                    ("catZhida", "1"),
                ],
            )
            .await?;
        let Some(singer) = json
            .get("data")
            .and_then(|d| d.get("zhida"))
            .and_then(|z| z.get("zhida_singer"))
        else {
            return Err(ProviderError::Empty);
        };
        let id = str_of(singer, "singerMID");
        if id.is_empty() {
            return Err(ProviderError::Empty);
        }
        let pic = str_of(singer, "singerPic");
        Ok(vec![Artist {
            id: id.clone(),
            platform: SourceId::Qq,
            name: str_of(singer, "singerName"),
            pic_url: if pic.is_empty() {
                format!("{PIC_SINGER}{id}.jpg")
            } else {
                pic
            },
        }])
    }

    /// 对应移动端 `searchAlbums` 的 qq 分支：`GET client_search_cp`（t=8）。
    /// 注意该接口返回的字段是**大写**：albumMID / albumName / albumPic / singerName。
    async fn search_albums(&self, kw: &str, page: u32, size: u32) -> ProviderResult<Vec<Album>> {
        let page_str = page.to_string();
        let size_str = size.to_string();
        let json = self
            .get_query(
                SEARCH_URL,
                &[
                    ("format", "json"),
                    ("w", kw),
                    ("t", "8"),
                    ("p", &page_str),
                    ("n", &size_str),
                    ("platform", "yqq"),
                    ("g_tk", "5381"),
                ],
            )
            .await?;
        let Some(list) = json
            .get("data")
            .and_then(|d| d.get("album"))
            .and_then(|a| a.get("list"))
            .and_then(Value::as_array)
        else {
            return Err(ProviderError::Empty);
        };
        let albums: Vec<Album> = list
            .iter()
            .filter_map(|item| {
                let mut id = str_of(item, "albumMID");
                if id.is_empty() {
                    id = as_string(item.get("albumID"));
                }
                if id.is_empty() {
                    return None;
                }
                let pic = str_of(item, "albumPic");
                Some(Album {
                    id: id.clone(),
                    platform: SourceId::Qq,
                    name: str_of(item, "albumName"),
                    artist: str_of(item, "singerName"),
                    pic_url: if pic.is_empty() {
                        format!("{PIC_ALBUM}{id}.jpg")
                    } else {
                        pic
                    },
                })
            })
            .collect();
        if albums.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(albums)
    }

    /// 对应移动端 `artistSongs` 的 qq 分支：QQ 没有按歌手 id 取歌曲的接口，
    /// 移动端也是「按歌手名搜索歌曲 + 单独取头像」拼装，这里按同样口径降级为按名搜歌
    /// （头像由前端另行调用 `search_artists` 获取）。
    async fn artist_songs(&self, name: &str, page: u32, size: u32) -> ProviderResult<Vec<Track>> {
        self.search_tracks(name, page, size).await
    }

    async fn play_url(&self, track: &Track, quality: Quality) -> ProviderResult<String> {
        // 与移动端 resolvePlayUrl 一致：320/flac 直接跳过 QQ 原生（QQ 原生拿不到
        // 高音质/无损），128 先原生、失败后按 kw → wyy 兜底
        if quality != Quality::Standard {
            return self.cross_fallback(track, quality).await;
        }
        if let Ok(url) = self.fetch_vkey_url(&track.id, quality).await {
            return Ok(url);
        }
        self.cross_fallback(track, quality).await
    }

    async fn lyric(&self, track: &Track) -> ProviderResult<Lyric> {
        let url = format!(
            "{LYRIC_URL}?format=json&nobase64=1&g_tk=5381&songmid={}",
            track.id
        );
        let json = self.get_json(&url).await?;
        let retcode = json.get("retcode").and_then(Value::as_i64).unwrap_or(-1);
        let lrc = if retcode != 0 {
            String::new()
        } else {
            json.get("lyric")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        Ok(Lyric {
            lrc,
            translation: String::new(),
        })
    }

    /// `videoUrl("qq")` 移植：musicu.fcg + gosrf.Stream.MvUrlProxy/GetMvUrls。
    /// mp4 清单按清晰度选（low→首个、hd→第二个、auto→最高），取 freeflow_url。
    async fn video_url(&self, id: &str, quality: &str) -> ProviderResult<String> {
        let body = json!({
            "getMvUrl": {
                "module": "gosrf.Stream.MvUrlProxy",
                "method": "GetMvUrls",
                "param": { "vids": [id], "request_typet": 10001 },
            },
        });
        let json = self.post_json(MUSICU_URL, &body).await?;
        let mp4 = json
            .get("getMvUrl")
            .and_then(|c| c.get("data"))
            .and_then(|d| d.get(id))
            .and_then(|m| m.get("mp4"))
            .and_then(Value::as_array)
            .ok_or(ProviderError::NoPlayableUrl)?;
        if mp4.is_empty() {
            return Err(ProviderError::NoPlayableUrl);
        }
        let index = match quality {
            "low" => 0,
            "hd" if mp4.len() > 1 => 1,
            _ => mp4.len() - 1,
        };
        let urls = mp4[index]
            .get("freeflow_url")
            .and_then(Value::as_array)
            .ok_or(ProviderError::NoPlayableUrl)?;
        urls.get(1)
            .or_else(|| urls.first())
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

/// 与移动端 buildQueryString 一致的组件编码。
pub(crate) fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn song_from_qq_search_maps_fields() {
        let item: Value = serde_json::from_str(
            r#"{
                "songmid": "0039MnYb0qxYhV",
                "songname": "海阔天空",
                "singer": [{"name": "Beyond"}],
                "albumname": "乐与怒",
                "albummid": "002eFUFm2XYZ7z",
                "interval": 324
            }"#,
        )
        .unwrap();
        let t = song_from_qq_search(&item).unwrap();
        assert_eq!(t.id, "0039MnYb0qxYhV");
        assert_eq!(t.title, "海阔天空");
        assert_eq!(t.singer, "Beyond");
        assert_eq!(t.album, "乐与怒");
        assert_eq!(
            t.pic_url,
            "https://y.qq.com/music/photo_new/T002R300x300M000002eFUFm2XYZ7z.jpg"
        );
        assert_eq!(t.duration, 324.0);
    }

    #[test]
    fn song_without_mid_is_rejected() {
        let item: Value = serde_json::from_str(r#"{"songname": "x"}"#).unwrap();
        assert!(song_from_qq_search(&item).is_none());
    }

    #[test]
    fn as_string_accepts_number_and_string() {
        let item: Value =
            serde_json::from_str(r#"{"n": 1024, "s": "abc", "null": null}"#).unwrap();
        assert_eq!(as_string(item.get("n")), "1024");
        assert_eq!(as_string(item.get("s")), "abc");
        assert_eq!(as_string(item.get("null")), "");
        assert_eq!(as_string(item.get("missing")), "");
    }

    #[test]
    fn playlist_from_qq_maps_fields() {
        let item: Value = serde_json::from_str(
            r#"{
                "dissid": 8205732195,
                "dissname": "华语经典",
                "imgurl": "https://p.qpic.cn/x.jpg",
                "listennum": 120000
            }"#,
        )
        .unwrap();
        let p = playlist_from_qq(&item).unwrap();
        assert_eq!(p.id, "8205732195");
        assert_eq!(p.name, "华语经典");
        assert_eq!(p.play_count, "120000");
        assert!(p.description.is_none());
        assert!(p.tracks.is_none());
    }

    #[test]
    fn playlist_from_qq_defaults_play_count() {
        let item: Value = serde_json::from_str(r#"{"dissid": "1", "dissname": "x"}"#).unwrap();
        assert_eq!(playlist_from_qq(&item).unwrap().play_count, "0");
    }

    #[test]
    fn song_from_qq_new_keeps_seconds_and_album_object() {
        let item: Value = serde_json::from_str(
            r#"{
                "mid": "004Z8Ie70wSjPN",
                "name": "起风了",
                "singer": [{"name": "买辣椒也用券"}],
                "album": {"name": "起风了", "mid": "001Xc0vL0KzGwv"},
                "interval": 325
            }"#,
        )
        .unwrap();
        let t = song_from_qq_new(&item).unwrap();
        assert_eq!(t.id, "004Z8Ie70wSjPN");
        assert_eq!(t.title, "起风了");
        assert_eq!(t.album, "起风了");
        assert_eq!(
            t.pic_url,
            "https://y.qq.com/music/photo_new/T002R300x300M000001Xc0vL0KzGwv.jpg"
        );
        // interval 单位已是秒，不做 /1000
        assert_eq!(t.duration, 325.0);
    }

    #[test]
    fn song_from_qq_detail_maps_flat_fields() {
        let item: Value = serde_json::from_str(
            r#"{
                "songmid": "0039MnYb0qxYhV",
                "songname": "海阔天空",
                "singer": [{"name": "Beyond"}],
                "albumname": "乐与怒",
                "albummid": "002eFUFm2XYZ7z",
                "interval": "324"
            }"#,
        )
        .unwrap();
        let t = song_from_qq_detail(&item).unwrap();
        assert_eq!(t.id, "0039MnYb0qxYhV");
        assert_eq!(t.singer, "Beyond");
        assert_eq!(t.album, "乐与怒");
        // interval 为字符串形态也要解析成秒
        assert_eq!(t.duration, 324.0);
    }

    #[test]
    fn song_from_qq_detail_without_mid_is_rejected() {
        let item: Value = serde_json::from_str(r#"{"songname": "x"}"#).unwrap();
        assert!(song_from_qq_detail(&item).is_none());
    }

    #[test]
    fn video_from_qq_maps_fields_and_first_singer() {
        let item: Value = serde_json::from_str(
            r#"{
                "vid": "m0035k1qabc",
                "title": "海阔天空",
                "picurl": "https://p.qpic.cn/mv.jpg",
                "singers": [{"name": "Beyond"}, {"name": "beyond"}]
            }"#,
        )
        .unwrap();
        let v = video_from_qq(&item).unwrap();
        assert_eq!(v.id, "m0035k1qabc");
        assert_eq!(v.name, "海阔天空");
        assert_eq!(v.pic_url, "https://p.qpic.cn/mv.jpg");
        // 只取 singers[0].name
        assert_eq!(v.singer, "Beyond");
        assert_eq!(v.platform, SourceId::Qq);
    }

    #[test]
    fn video_from_qq_rejects_empty_vid_and_tolerates_missing_singers() {
        assert!(video_from_qq(&serde_json::from_str(r#"{"title": "x"}"#).unwrap()).is_none());
        let item: Value = serde_json::from_str(r#"{"vid": "v1", "title": "x"}"#).unwrap();
        let v = video_from_qq(&item).unwrap();
        assert_eq!(v.singer, "");
        assert_eq!(v.pic_url, "");
    }
}
