//! wyy（网易云音乐）Provider —— 移植自 `qt-uniappx/services/music-api.ts`（只读参考，不引用）。
//!
//! 移植范围（M0）：
//! - `search_tracks`  ← `search(keyword, "wyy", "song", page, size)`：`GET /api/cloudsearch/pc`
//! - `play_url`       ← `fetchWyyCore`：gdstudio 代理（br=128/320/999）→ 官方 `enhance/player/url`（br=128000/320000/999000）
//! - `lyric`          ← `lyrics` + `lyricTranslation`：`GET /api/song/lyric`（lv/kv/tv=-1，tv=1 取翻译）
//! - 请求头与移动端 `makeHeaders("wyy")` 一致：Referer https://music.163.com/，UA "Mozilla/5.0"
//! - 音源歌曲字段映射与移动端 `songFromWyy` 一致（ar|artists、al|album、dt|duration）

use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;

use super::types::{
    Album, Artist, Chart, Lyric, Playlist, PlaylistCategory, ProviderError, ProviderResult, Quality,
    SourceId, Track, Video,
};
use super::{MusicProvider, ProviderCapabilities};

const UA: &str = "Mozilla/5.0";
const REFERER: &str = "https://music.163.com/";
const SEARCH_URL: &str = "https://music.163.com/api/cloudsearch/pc";
/// 歌单/歌手/专辑搜索走 `/api/search/get`（与歌曲搜索的 cloudsearch/pc 不同）
const SEARCH_GET_URL: &str = "https://music.163.com/api/search/get";
const HOT_WORDS_URL: &str = "https://music.163.com/api/search/hot";
const PLAYLIST_TAGS_URL: &str = "https://music.163.com/api/playlist/highquality/tags";
const PLAYLIST_LIST_URL: &str = "https://music.163.com/api/playlist/list";
const NEW_SONGS_URL: &str = "https://music.163.com/api/v1/discovery/new/songs";
const TOPLIST_URL: &str = "https://music.163.com/api/toplist";
const PLAYLIST_DETAIL_URL: &str = "https://music.163.com/api/v6/playlist/detail";
const SONG_DETAIL_URL: &str = "https://music.163.com/api/v3/song/detail";
const PLAY_URL_OFFICIAL: &str = "https://music.163.com/api/song/enhance/player/url";
const PLAY_URL_PROXY: &str = "https://music-api.gdstudio.xyz/api.php";
const LYRIC_URL: &str = "https://music.163.com/api/song/lyric";
const MV_URL: &str = "https://music.163.com/api/song/enhance/play/mv/url";
/// MV 列表（与取址接口不同域：interface.music.163.com）
const MV_LIST_URL: &str = "https://interface.music.163.com/api/mv/all";

/// 歌单广场分页大小（移动端 recommendations 硬编码 30）
const RECOMMEND_PAGE_SIZE: u32 = 30;

pub struct WyyProvider {
    http: reqwest::Client,
}

impl Default for WyyProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl WyyProvider {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            // 单音源请求默认超时 10s（REQUIREMENTS §4.1）
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("reqwest client init");
        Self { http }
    }

    async fn get_json(&self, url: &str, params: &[(&str, &str)]) -> ProviderResult<Value> {
        let resp = self
            .http
            .get(url)
            .query(params)
            .header("User-Agent", UA)
            .header("Referer", REFERER)
            .send()
            .await
            .map_err(|e| ProviderError::from_reqwest(&e))?;
        let status = resp.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(ProviderError::RateLimited);
        }
        if !status.is_success() {
            return Err(ProviderError::Network {
                message: format!("HTTP {status}"),
            });
        }
        resp.json::<Value>()
            .await
            .map_err(|e| ProviderError::Decode {
                message: e.to_string(),
            })
    }

    /// 与移动端 `wyySongDetail` 一致：POST `/api/v3/song/detail`，
    /// `Content-Type: application/x-www-form-urlencoded`，body `c=[{"id":1},...]`，每批 300。
    async fn song_detail(&self, ids: &[u64]) -> ProviderResult<Vec<Track>> {
        const BATCH: usize = 300;
        let mut out: Vec<Track> = Vec::with_capacity(ids.len());
        for chunk in ids.chunks(BATCH) {
            let payload: Vec<Value> = chunk
                .iter()
                .map(|id| serde_json::json!({ "id": id }))
                .collect();
            let c = serde_json::to_string(&payload).map_err(|e| ProviderError::Decode {
                message: e.to_string(),
            })?;
            let resp = self
                .http
                .post(SONG_DETAIL_URL)
                .header("User-Agent", UA)
                .header("Referer", REFERER)
                .header("Content-Type", "application/x-www-form-urlencoded")
                .form(&[("c", c.as_str())])
                .send()
                .await
                .map_err(|e| ProviderError::from_reqwest(&e))?;
            let status = resp.status();
            if !status.is_success() {
                return Err(ProviderError::Network {
                    message: format!("HTTP {status}"),
                });
            }
            let json = resp
                .json::<Value>()
                .await
                .map_err(|e| ProviderError::Decode {
                    message: e.to_string(),
                })?;
            if let Some(songs) = json.get("songs").and_then(Value::as_array) {
                out.extend(songs.iter().filter_map(song_from_wyy_detail));
            }
        }
        Ok(out)
    }
}

/// 与移动端 `songFromWyy` 一致：兼容 cloudsearch（ar/al/dt）与老接口（artists/album/duration）。
fn song_from_wyy(item: &Value) -> Option<Track> {
    let id = item.get("id").and_then(Value::as_u64)?;
    let name = item
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let song = item.get("song").unwrap_or(item);

    // artists 或 ar
    let artists = song
        .get("artists")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
        .or_else(|| song.get("ar").and_then(Value::as_array));
    let singer = artists
        .and_then(|a| a.first())
        .and_then(|a| a.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    // album 或 al
    let album = song
        .get("album")
        .filter(|v| !v.is_null())
        .or_else(|| song.get("al").filter(|v| !v.is_null()));
    let album_name = album
        .and_then(|a| a.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    // 封面：顶层 picUrl → al.picUrl
    let pic_url = item
        .get("picUrl")
        .and_then(Value::as_str)
        .or_else(|| album.and_then(|a| a.get("picUrl")).and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();

    // 时长：duration(ms, 老接口) 或 dt(ms, cloudsearch) → 秒
    let duration_ms = song
        .get("duration")
        .and_then(Value::as_f64)
        .or_else(|| song.get("dt").and_then(Value::as_f64))
        .unwrap_or(0.0);

    Some(Track {
        id: id.to_string(),
        platform: SourceId::Wyy,
        title: name,
        singer,
        album: album_name,
        pic_url,
        duration: duration_ms / 1000.0,
        music_id: None,
    })
}

/// 与移动端 `songFromWyyDetail` 一致：`/api/v3/song/detail` 与 `v6/playlist/detail` 的
/// songs[] / tracks[] 结构（ar[]、al{}、dt 毫秒）。
fn song_from_wyy_detail(item: &Value) -> Option<Track> {
    let id = item.get("id").and_then(Value::as_u64)?;
    let album = item.get("al").filter(|v| !v.is_null());
    Some(Track {
        id: id.to_string(),
        platform: SourceId::Wyy,
        title: item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        singer: item
            .get("ar")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(|a| a.get("name"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        album: album
            .and_then(|a| a.get("name"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        pic_url: album
            .and_then(|a| a.get("picUrl"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        duration: item.get("dt").and_then(Value::as_f64).unwrap_or(0.0) / 1000.0,
        music_id: None,
    })
}

/// 各接口对同一字段时而返回 number 时而返回 string（id / playCount），统一转 String。
fn num_to_string(v: &Value) -> String {
    match v {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        _ => String::new(),
    }
}

/// 歌单映射：列表（recommendations）与搜索（searchPlaylists）字段一致
/// （coverImgUrl / playCount），对应移动端 `playlistFromWyySearch`。
fn playlist_from_wyy(item: &Value) -> Option<Playlist> {
    let id = item
        .get("id")
        .map(num_to_string)
        .filter(|s| !s.is_empty())?;
    Some(Playlist {
        id,
        platform: SourceId::Wyy,
        name: item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        pic_url: item
            .get("coverImgUrl")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        play_count: item.get("playCount").map(num_to_string).unwrap_or_default(),
        description: None,
        tracks: None,
    })
}

/// 歌手映射（对应移动端 `artistFromWyy`）
fn artist_from_wyy(item: &Value) -> Option<Artist> {
    let id = item
        .get("id")
        .map(num_to_string)
        .filter(|s| !s.is_empty())?;
    Some(Artist {
        id,
        platform: SourceId::Wyy,
        name: item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        pic_url: item
            .get("picUrl")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

/// 专辑映射（对应移动端 `albumFromWyy`，歌手在 artist.name）
fn album_from_wyy(item: &Value) -> Option<Album> {
    let id = item
        .get("id")
        .map(num_to_string)
        .filter(|s| !s.is_empty())?;
    Some(Album {
        id,
        platform: SourceId::Wyy,
        name: item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        artist: item
            .get("artist")
            .and_then(|a| a.get("name"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        pic_url: item
            .get("picUrl")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

#[async_trait]
impl MusicProvider for WyyProvider {
    fn id(&self) -> SourceId {
        SourceId::Wyy
    }

    fn name(&self) -> &'static str {
        "wyy"
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            playlist_categories: true,
            recommendations: true,
            latest: true,
            charts: true,
            chart_detail: true,
            playlist_detail: true,
            search_song: true,
            search_playlist: true,
            search_artist: true,
            search_album: true,
            artist_songs: true,
            mv_list: true,
            mv_url: true,
            lyric: true,
            lyric_translation: true,
            play_url: true,
            cover: true,
        }
    }

    async fn search_tracks(
        &self,
        kw: &str,
        page: u32,
        size: u32,
    ) -> ProviderResult<Vec<Track>> {
        let offset = page.saturating_sub(1).saturating_mul(size);
        let json = self
            .get_json(
                SEARCH_URL,
                &[
                    ("s", kw),
                    ("type", "1"),
                    ("offset", &offset.to_string()),
                    ("limit", &size.to_string()),
                ],
            )
            .await?;
        let songs = json
            .get("result")
            .and_then(|r| r.get("songs"))
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "result.songs 缺失".into(),
            })?;
        let tracks: Vec<Track> = songs.iter().filter_map(song_from_wyy).collect();
        if tracks.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(tracks)
    }

    // ---------- 发现类（M5）：对应移动端 music-api.ts 的 wyy 分支 ----------

    async fn playlist_categories(&self) -> ProviderResult<Vec<PlaylistCategory>> {
        let json = self.get_json(PLAYLIST_TAGS_URL, &[]).await?;
        let tags = json
            .get("tags")
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "tags 缺失".into(),
            })?;
        let out: Vec<PlaylistCategory> = tags
            .iter()
            .filter_map(|t| {
                let name = t.get("name").and_then(Value::as_str)?;
                // 移动端注释：网易云按分类名 cat 筛选，故 id 直接用名称
                Some(PlaylistCategory {
                    id: name.to_string(),
                    name: name.to_string(),
                    group: None,
                })
            })
            .collect();
        if out.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(out)
    }

    async fn recommendations(
        &self,
        category: Option<&str>,
        page: u32,
    ) -> ProviderResult<Vec<Playlist>> {
        let cat = category.filter(|s| !s.is_empty()).unwrap_or("全部");
        let offset = page.max(1).saturating_sub(1) * RECOMMEND_PAGE_SIZE;
        let json = self
            .get_json(
                PLAYLIST_LIST_URL,
                &[
                    ("cat", cat),
                    ("limit", "30"),
                    ("offset", &offset.to_string()),
                    ("total", "true"),
                ],
            )
            .await?;
        let list = json
            .get("playlists")
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "playlists 缺失".into(),
            })?;
        let out: Vec<Playlist> = list.iter().filter_map(playlist_from_wyy).collect();
        if out.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(out)
    }

    async fn latest(&self, limit: u32, offset: u32) -> ProviderResult<Vec<Track>> {
        let limit = limit.clamp(1, 50);
        let json = self
            .get_json(
                NEW_SONGS_URL,
                &[
                    ("limit", &limit.to_string()),
                    ("offset", &offset.to_string()),
                    ("total", "true"),
                    ("areaId", "0"),
                ],
            )
            .await?;
        let data = json
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "data 缺失".into(),
            })?;
        // data[] 每项形如 { song: {...} }，songFromWyy 已兼容两种形态
        let tracks: Vec<Track> = data.iter().filter_map(song_from_wyy).collect();
        if tracks.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(tracks)
    }

    async fn charts(&self) -> ProviderResult<Vec<Chart>> {
        let json = self.get_json(TOPLIST_URL, &[]).await?;
        let list = json
            .get("list")
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "list 缺失".into(),
            })?;
        let out: Vec<Chart> = list
            .iter()
            .filter_map(|c| {
                let id = c.get("id").map(num_to_string).filter(|s| !s.is_empty())?;
                Some(Chart {
                    id,
                    platform: SourceId::Wyy,
                    name: c
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    pic_url: c
                        .get("coverImgUrl")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    description: c
                        .get("description")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string()),
                })
            })
            .collect();
        if out.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(out)
    }

    /// 榜单详情：榜单即特殊歌单，走 `/api/v6/playlist/detail`（移动端固定 n=500，无分页）
    async fn chart_detail(
        &self,
        chart: &Chart,
        page: u32,
        size: u32,
    ) -> ProviderResult<Vec<Track>> {
        let _ = (page, size);
        let json = self
            .get_json(
                PLAYLIST_DETAIL_URL,
                &[("id", chart.id.as_str()), ("n", "500")],
            )
            .await?;
        let tracks = json
            .get("playlist")
            .and_then(|p| p.get("tracks"))
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "playlist.tracks 缺失".into(),
            })?;
        let out: Vec<Track> = tracks.iter().filter_map(song_from_wyy_detail).collect();
        if out.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(out)
    }

    /// 歌单详情：trackIds → 分批 song_detail；缺失时回退 playlist.tracks（移动端 2277-2283 行）
    async fn playlist(&self, id: &str, page: u32, size: u32) -> ProviderResult<Playlist> {
        let _ = (page, size);
        let json = self
            .get_json(PLAYLIST_DETAIL_URL, &[("id", id), ("n", "100000")])
            .await?;
        let pl = json.get("playlist").ok_or_else(|| ProviderError::Decode {
            message: "playlist 缺失".into(),
        })?;

        let ids: Vec<u64> = pl
            .get("trackIds")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| t.get("id").and_then(Value::as_u64))
                    .collect()
            })
            .unwrap_or_default();
        let mut songs = if ids.is_empty() {
            Vec::new()
        } else {
            self.song_detail(&ids).await.unwrap_or_default()
        };
        if songs.is_empty() {
            songs = pl
                .get("tracks")
                .and_then(Value::as_array)
                .map(|arr| arr.iter().filter_map(song_from_wyy_detail).collect())
                .unwrap_or_default();
        }

        Ok(Playlist {
            id: id.to_string(),
            platform: SourceId::Wyy,
            name: pl
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            pic_url: pl
                .get("coverImgUrl")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            play_count: pl.get("playCount").map(num_to_string).unwrap_or_default(),
            description: pl
                .get("description")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string()),
            tracks: Some(songs),
        })
    }

    async fn hot_words(&self) -> ProviderResult<Vec<String>> {
        // 实测：不带 type 参数会返回 {"msg":"参数错误","code":400}
        let json = self.get_json(HOT_WORDS_URL, &[("type", "1")]).await?;
        let hots = json
            .get("result")
            .and_then(|r| r.get("hots"))
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "result.hots 缺失".into(),
            })?;
        let out: Vec<String> = hots
            .iter()
            .filter_map(|h| h.get("first").and_then(Value::as_str))
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect();
        if out.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(out)
    }

    /// 搜索歌单：`/api/search/get` type=1000（对应移动端 searchPlaylists 的 wyy 分支）
    async fn search_playlists(
        &self,
        kw: &str,
        page: u32,
        size: u32,
    ) -> ProviderResult<Vec<Playlist>> {
        let offset = page.max(1).saturating_sub(1).saturating_mul(size);
        let json = self
            .get_json(
                SEARCH_GET_URL,
                &[
                    ("s", kw),
                    ("type", "1000"),
                    ("limit", &size.to_string()),
                    ("offset", &offset.to_string()),
                ],
            )
            .await?;
        let list = json
            .get("result")
            .and_then(|r| r.get("playlists"))
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "result.playlists 缺失".into(),
            })?;
        let out: Vec<Playlist> = list.iter().filter_map(playlist_from_wyy).collect();
        if out.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(out)
    }

    /// 搜索歌手：type=100
    async fn search_artists(
        &self,
        kw: &str,
        page: u32,
        size: u32,
    ) -> ProviderResult<Vec<Artist>> {
        let offset = page.max(1).saturating_sub(1).saturating_mul(size);
        let json = self
            .get_json(
                SEARCH_GET_URL,
                &[
                    ("s", kw),
                    ("type", "100"),
                    ("limit", &size.to_string()),
                    ("offset", &offset.to_string()),
                ],
            )
            .await?;
        let list = json
            .get("result")
            .and_then(|r| r.get("artists"))
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "result.artists 缺失".into(),
            })?;
        let out: Vec<Artist> = list.iter().filter_map(artist_from_wyy).collect();
        if out.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(out)
    }

    /// 搜索专辑：type=10
    async fn search_albums(&self, kw: &str, page: u32, size: u32) -> ProviderResult<Vec<Album>> {
        let offset = page.max(1).saturating_sub(1).saturating_mul(size);
        let json = self
            .get_json(
                SEARCH_GET_URL,
                &[
                    ("s", kw),
                    ("type", "10"),
                    ("limit", &size.to_string()),
                    ("offset", &offset.to_string()),
                ],
            )
            .await?;
        let list = json
            .get("result")
            .and_then(|r| r.get("albums"))
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "result.albums 缺失".into(),
            })?;
        let out: Vec<Album> = list.iter().filter_map(album_from_wyy).collect();
        if out.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(out)
    }

    /// 歌手歌曲：移动端只有「按歌手名搜歌」的拼装实现（无按 id 取热门歌曲的接口）
    async fn artist_songs(&self, name: &str, page: u32, size: u32) -> ProviderResult<Vec<Track>> {
        self.search_tracks(name, page, size).await
    }

    /// MV 列表（对应移动端 videos() 的 wyy 分支，music-api.ts:1002-1012）。
    /// tags 是 JSON 字符串参数（地区/类型/排序），移动端原样传「全部 / 上升最快」。
    async fn videos(&self, page: u32, size: u32) -> ProviderResult<Vec<Video>> {
        let size = size.clamp(1, 30);
        let offset = page.max(1).saturating_sub(1).saturating_mul(size);
        let tags = r#"{"地区":"全部","类型":"全部","排序":"上升最快"}"#;
        let json = self
            .get_json(
                MV_LIST_URL,
                &[
                    ("limit", &size.to_string()),
                    ("offset", &offset.to_string()),
                    ("total", "true"),
                    ("tags", tags),
                ],
            )
            .await?;
        let data = json
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "data 缺失".into(),
            })?;
        let out: Vec<Video> = data
            .iter()
            .filter_map(|v| {
                let id = v.get("id").map(num_to_string).filter(|s| !s.is_empty())?;
                Some(Video {
                    id,
                    platform: SourceId::Wyy,
                    name: v
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    pic_url: v
                        .get("cover")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    singer: v
                        .get("artistName")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                })
            })
            .collect();
        if out.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(out)
    }

    async fn play_url(&self, track: &Track, quality: Quality) -> ProviderResult<String> {
        // 1) gdstudio 代理（与移动端 wyyProxyUrl 一致，能取到 VIP/无版权歌的地址）
        let proxy_url = format!("{PLAY_URL_PROXY}?types=url&source=netease&id={}&br={}", track.id, quality.wyy_br_param());
        if let Ok(json) = self.get_json(&proxy_url, &[]).await {
            if let Some(u) = json.get("url").and_then(Value::as_str) {
                if !u.is_empty() {
                    return Ok(u.to_string());
                }
            }
        }

        // 2) 官方 enhance/player/url（与移动端 fetchWyyCore 一致）
        let ids = format!("[{}]", track.id);
        let br = quality.wyy_br_value().to_string();
        let json = self
            .get_json(
                PLAY_URL_OFFICIAL,
                &[("id", track.id.as_str()), ("ids", ids.as_str()), ("br", br.as_str())],
            )
            .await?;
        if let Some(data) = json.get("data").and_then(Value::as_array) {
            if let Some(first) = data.first() {
                if let Some(u) = first.get("url").and_then(Value::as_str) {
                    if !u.is_empty() {
                        return Ok(u.to_string());
                    }
                }
            }
        }

        // 3) 兜底：酷我（与移动端 fetchWyyUrl 一致，网易云失败仅兜酷我）
        let kw = super::KwProvider::new();
        if let Some(u) = super::play_via_source(&kw, &track.title, &track.singer, quality).await {
            return Ok(u);
        }
        Err(ProviderError::NoPlayableUrl)
    }

    async fn lyric(&self, track: &Track) -> ProviderResult<Lyric> {
        // 主歌词 tv=-1；翻译 tv=1（与移动端 lyrics / lyricTranslation 一致）
        let main = self
            .get_json(
                LYRIC_URL,
                &[("id", track.id.as_str()), ("lv", "-1"), ("kv", "-1"), ("tv", "-1")],
            )
            .await?;
        let lrc = main
            .get("lrc")
            .and_then(|l| l.get("lyric"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        let translation = match self
            .get_json(
                LYRIC_URL,
                &[("id", track.id.as_str()), ("lv", "-1"), ("kv", "-1"), ("tv", "1")],
            )
            .await
        {
            Ok(json) => json
                .get("tlyric")
                .and_then(|l| l.get("lyric"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            Err(_) => String::new(), // 翻译失败不阻塞主歌词
        };

        Ok(Lyric { lrc, translation })
    }

    /// `videoUrl("wyy")` 移植：enhance/play/mv/url（r=1080 auto / 720 hd / 240 low）
    async fn video_url(&self, id: &str, quality: &str) -> ProviderResult<String> {
        let r = match quality {
            "low" => 240,
            "hd" => 720,
            _ => 1080,
        };
        let json = self
            .get_json(
                MV_URL,
                &[("id", id), ("r", r.to_string().as_str())],
            )
            .await?;
        json.get("data")
            .and_then(|d| d.get("url"))
            .and_then(Value::as_str)
            .filter(|u| !u.is_empty())
            .map(str::to_string)
            .ok_or(ProviderError::NoPlayableUrl)
    }

    async fn cover(&self, track: &Track) -> ProviderResult<String> {
        if !track.pic_url.is_empty() {
            return Ok(track.pic_url.clone());
        }
        // 与移动端 songCover 一致：按 歌名+歌手 搜索取第一张有图的结果
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
