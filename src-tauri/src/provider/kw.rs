//! kw（酷我）Provider —— 移植自 `qt-uniappx/services/music-api.ts` + `kw-encode.uts`（只读参考，不引用）。
//!
//! 移植范围：
//! - `search_tracks`  ← `search(keyword, "kw", "song", page, size)`：免鉴权老接口
//!   `GET /search/searchMusicBykeyWord`（新版 api/www/search 已废弃，见移动端注释）
//! - `play_url`       ← `fetchKwCore`：`getKwUrlByEncode`（DES-ECB 加密参数）→ `mobi.kuwo.cn/mobi.s`
//!   → 从响应文本提取 URL（`kwExtractMobiUrl` 移植）
//! - `lyric`          ← openapi `getlyric`：lrclist[] → 重建 `[mm:ss.xx]` LRC（`kwFormatTime` 移植）
//! - 发现类（M5）     ← `playlistCategories` / `recommendations` / `latest` / `charts` /
//!   `chartDetail` / `playlistDetail` / `hotWords` / `searchPlaylists` / `searchArtists` /
//!   `searchAlbums` / `artistSongs` 的 kw 分支，统一走 `api/www/...` 接口族。
//!   请求头与移动端 `http.ts` 的 `kwRequest` 一致（FireFox UA + 酷我 Referer + no-cache），
//!   与上面免鉴权老接口的 `Referer: https://music.163.com/` 那套互不干扰。
//!
//! DES 说明：`kw-encode.uts` 的 BigInt 实现即标准 DES（IP/E/S 盒/P/FP/PC1/PC2 均为标准表），
//! 密钥 `ylzsxkwm`，ECB 模式、尾部零填充。Rust 侧用 RustCrypto `des` 逐块加密，行为一致，
//! 由测试向量（用 UTS 原算法在 node 中生成）保证。

use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use serde_json::Value;

use super::types::{
    Album, Artist, Chart, Lyric, Playlist, PlaylistCategory, ProviderError, ProviderResult, Quality,
    SourceId, Track, Video,
};
use super::{check_status, MusicProvider, ProviderCapabilities};

/// 免鉴权老接口（searchMusicBykeyWord / lyric）沿用移动端 `makeHeaders` 的短 UA。
const UA: &str = "Mozilla/5.0";
/// 发现类接口专用 UA（移动端 `http.ts` 的 `kwRequest`）。
const KW_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:82.0) Gecko/20100101 Firefox/82.0";
const KW_REFERER: &str = "https://www.kuwo.cn/";
const SEARCH_URL: &str = "https://www.kuwo.cn/search/searchMusicBykeyWord";
const MOBI_URL: &str = "https://mobi.kuwo.cn/mobi.s?f=kuwo&q=";
const LYRIC_URL: &str = "https://kuwo.cn/openapi/v1/www/lyric/getlyric";
const DES_KEY: &[u8; 8] = b"ylzsxkwm";

// ---------- 发现类接口（对应移动端 music-api.ts 的 kw 分支） ----------
const TAG_LIST_URL: &str = "https://kuwo.cn/api/www/playlist/getTagList";
const TAG_PLAYLIST_URL: &str = "https://kuwo.cn/api/www/classify/playlist/getTagPlayList";
const RCM_PLAYLIST_URL: &str = "https://www.kuwo.cn/api/www/rcm/index/playlist";
const BANG_MUSIC_URL: &str = "https://kuwo.cn/api/www/bang/bang/musicList";
const BANG_MENU_URL: &str = "https://kuwo.cn/api/www/bang/bang/bangMenu";
const PLAYLIST_INFO_URL: &str = "https://www.kuwo.cn/api/www/playlist/playListInfo";
const SEARCH_KEY_URL: &str = "https://www.kuwo.cn/api/www/search/searchKey";
const SEARCH_PLAYLIST_URL: &str = "https://www.kuwo.cn/api/www/search/searchPlayListBykeyWord";
const SEARCH_ARTIST_URL: &str = "https://www.kuwo.cn/api/www/search/searchArtistBykeyWord";
const SEARCH_ALBUM_URL: &str = "https://www.kuwo.cn/api/www/search/searchAlbumBykeyWord";
/// `videos("kw")` MV 列表 (music-api.ts:937-959)
const MV_LIST_URL: &str = "https://www.kuwo.cn/api/www/music/mvList";
/// 酷我「新歌榜」榜 id（`latest("kw")` 用它分页取新歌速递）。
const NEW_SONG_BANG_ID: &str = "17";
/// 发现类接口单页条数（移动端 pageSize 固定 30）。
const RN: u32 = 30;
/// 翻页保护上限（移动端 safePages < 20 / maxPages 默认 30）。
const MAX_PAGES: u32 = 20;

/// 酷我鉴权凭据（移动端 `http.ts` 的 kuwoCookie / kuwoSecret）。
/// 发现类接口必须带 `Cookie` + `Secret` 两个头，否则业务码返回 "The request is illegal!"。
#[derive(Clone)]
struct KuwoAuth {
    /// 全部 cookie 的 `name=value` 用 "; " 拼接
    cookie: String,
    /// 由 `Hm_Iuvt` cookie 计算得到的签名
    secret: String,
}

pub struct KwProvider {
    http: reqwest::Client,
    /// 惰性获取：首次调用发现类接口时才请求 https://www.kuwo.cn/ 取 Cookie 并计算 Secret
    auth: Mutex<Option<KuwoAuth>>,
}

impl Default for KwProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl KwProvider {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(10))
            // 禁用连接池：休眠唤醒后 keep-alive 连接变半死，复用会挂满超时
            .pool_max_idle_per_host(0)
            .build()
            .expect("reqwest client init");
        Self {
            http,
            auth: Mutex::new(None),
        }
    }

    async fn get_json(&self, url: &str) -> ProviderResult<Value> {
        let resp = self
            .http
            .get(url)
            .header("User-Agent", UA)
            .header("Referer", "https://www.kuwo.cn/")
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

    async fn get_text(&self, url: &str, ua: &str) -> ProviderResult<String> {
        let resp = self
            .http
            .get(url)
            .header("User-Agent", ua)
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

    /// 发现类接口统一请求（请求头移植自移动端 `http.ts` 的 `kwRequest`）：
    /// `Referer: https://www.kuwo.cn/` + FireFox UA + `Cache-Control: no-cache`，
    /// 并带上鉴权头 `Cookie` / `Secret`（移动端 http.ts:695-768 的 `kwRequest`）。
    ///
    /// 业务码被拒（code != 200 / success=false）时清空凭据、重新获取、再请求一次
    /// （移动端 http.ts:741-760 的重试行为）。
    async fn get_json_kw(&self, url: &str, params: &[(&str, &str)]) -> ProviderResult<Value> {
        // 取址失败不致命：退化为无鉴权请求，错误由业务码自然暴露
        let auth = self.ensure_auth().await.ok();
        let json = self.request_kw(url, params, auth.as_ref()).await?;
        match assert_kw_ok(&json) {
            Ok(()) => Ok(json),
            Err(first_err) => {
                self.clear_auth();
                let retry_auth = self.ensure_auth().await.ok();
                let retry = self
                    .request_kw(url, params, retry_auth.as_ref())
                    .await
                    .map_err(|_| first_err)?;
                assert_kw_ok(&retry)?;
                Ok(retry)
            }
        }
    }

    /// 单次发现类请求（不带任何业务码判定）。
    async fn request_kw(
        &self,
        url: &str,
        params: &[(&str, &str)],
        auth: Option<&KuwoAuth>,
    ) -> ProviderResult<Value> {
        let mut req = self
            .http
            .get(url)
            .header("User-Agent", KW_UA)
            .header("Referer", KW_REFERER)
            .header("Cache-Control", "no-cache");
        if let Some(a) = auth {
            if !a.cookie.is_empty() {
                req = req.header("Cookie", a.cookie.clone());
            }
            if !a.secret.is_empty() {
                req = req.header("Secret", a.secret.clone());
            }
        }
        // 空参数列表不挂 query（URL 与移动端保持完全一致，不追加多余的 `?`）
        let req = if params.is_empty() { req } else { req.query(params) };
        check_status(
            req.send()
                .await
                .map_err(|e| ProviderError::from_reqwest(&e))?,
        )
        .await?
        .json::<Value>()
        .await
        .map_err(|e| ProviderError::Decode {
            message: e.to_string(),
        })
    }

    /// 取（或复用）酷我鉴权凭据：GET 首页拿 Set-Cookie，用 `Hm_Iuvt` 计算 Secret。
    /// 移植自移动端 `http.ts:428-483`（initKuwoCookie）+ `409-424`（applyKuwoCookie）。
    async fn ensure_auth(&self) -> ProviderResult<KuwoAuth> {
        if let Ok(guard) = self.auth.lock() {
            if let Some(a) = guard.as_ref() {
                return Ok(a.clone());
            }
        }
        let resp = self
            .http
            .get("https://www.kuwo.cn/")
            .header("User-Agent", KW_UA)
            .header("Referer", KW_REFERER)
            .send()
            .await
            .map_err(|e| ProviderError::from_reqwest(&e))?;
        // 响应头里可能有多个 set-cookie，只取 name=value 部分（丢掉 Path/Expires/Domain）
        let mut cookies: Vec<String> = Vec::new();
        for value in resp.headers().get_all("set-cookie").iter() {
            let Ok(raw) = value.to_str() else { continue };
            if let Some(pair) = raw.split(';').next() {
                let pair = pair.trim();
                if !pair.is_empty() {
                    cookies.push(pair.to_string());
                }
            }
        }
        let secret = cookies
            .iter()
            .find(|c| c.contains("Hm_Iuvt"))
            .map(|c| create_kuwo_secret(c))
            .unwrap_or_default();
        let auth = KuwoAuth {
            cookie: cookies.join("; "),
            secret,
        };
        if let Ok(mut guard) = self.auth.lock() {
            *guard = Some(auth.clone());
        }
        Ok(auth)
    }

    fn clear_auth(&self) {
        if let Ok(mut guard) = self.auth.lock() {
            *guard = None;
        }
    }

    /// 榜单单页原始数组：`bang/bang/musicList` 的 `data.musicList[]`。
    ///
    /// 缺失 / 空数组即视为「没有更多」，由调用方决定停在哪里（移动端同口径）。
    async fn bang_music_page(&self, bang_id: &str, page: u32) -> ProviderResult<Vec<Value>> {
        let pn = page.to_string();
        let rn = RN.to_string();
        let json = self
            .get_json_kw(
                BANG_MUSIC_URL,
                &[
                    ("bangId", bang_id),
                    ("pn", pn.as_str()),
                    ("rn", rn.as_str()),
                    ("httpsStatus", "1"),
                ],
            )
            .await?;
        let list = json
            .get("data")
            .and_then(|d| d.get("musicList"))
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "bang/musicList: data.musicList 缺失".into(),
            })?;
        Ok(list.clone())
    }

    /// 歌单详情单页：`playListInfo` 的 `data`（含 name/img/listencnt/total/musicList）。
    async fn playlist_info_page(&self, id: &str, page: u32) -> ProviderResult<Value> {
        let pn = page.to_string();
        let rn = RN.to_string();
        let json = self
            .get_json_kw(
                PLAYLIST_INFO_URL,
                &[
                    ("pid", id),
                    ("pn", pn.as_str()),
                    ("rn", rn.as_str()),
                    ("httpsStatus", "1"),
                ],
            )
            .await?;
        json.get("data")
            .cloned()
            .ok_or_else(|| ProviderError::Decode {
                message: "playListInfo: data 缺失".into(),
            })
    }

    /// 酷我播放核心（fetchKwCore 移植）：构造加密请求 → 提取 URL。
    async fn fetch_mobi_url(&self, rid: &str, quality: Quality) -> ProviderResult<String> {
        let plain = mobi_plain(rid, quality);
        let q = des_ecb_zero_pad_base64(plain.as_bytes());
        let url = format!("{MOBI_URL}{q}");
        let text = self.get_text(&url, "okhttp/3.10.0").await?;
        let extracted = extract_mobi_url(&text);
        if extracted.is_empty() {
            return Err(ProviderError::NoPlayableUrl);
        }
        Ok(extracted)
    }
}

/// 与移动端 `getKwUrlByEncode` 的明文串一致（br=1/2/3 → 128/320/flac）。
fn mobi_plain(rid: &str, quality: Quality) -> String {
    let br: &str = match quality {
        Quality::Standard => "br=128kmp3&format=mp3",
        Quality::High => "br=320kmp3&format=mp3",
        Quality::Lossless => "format=flac|mp3|aac",
    };
    format!(
        "user=0&android_id=0&prod=kwplayer_ar_8.5.5.0&corp=kuwo&newver=3&vipver=8.5.5.0\
&source=kwplayer_ar_5.1.0.0_B_jiakong_vh.apk&p2p=1&notrace=0&type=convert_url2&{br}&sig=0&rid={rid}"
    )
}

/// DES-ECB（密钥 ylzsxkwm）+ 尾部零填充 + 标准 base64 + URL 编码 `+ / =`。
///
/// `kw-encode.uts` 的 BigInt 实现逐行移植（`kw_des_encrypt`），u64 的
/// 截断/异或/移位语义与 BigInt 位运算一致。输出与移动端 `getKwUrlByEncode`
/// 完全一致（见单元测试向量）。
fn des_ecb_zero_pad_base64(data: &[u8]) -> String {
    let out = kw_des_encrypt(data, DES_KEY);
    let b64 = base64::engine::general_purpose::STANDARD.encode(out);
    b64.replace('+', "%2B").replace('/', "%2F").replace('=', "%3D")
}

// ---------- kw-encode.uts 逐行移植（表名与原实现对应） ----------

/// `a(iArr, i2, j2)`：按表置换位（表值为位下标，负数跳过）。
fn pick_bits(tbl: &[i32], v: u64) -> u64 {
    let mut out = 0u64;
    for (i, &idx) in tbl.iter().enumerate() {
        if idx >= 0 && (v >> idx) & 1 == 1 {
            out |= 1u64 << i;
        }
    }
    out
}

const F4898E: &[i32] = &[
    57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5,
    63, 55, 47, 39, 31, 23, 15, 7, 56, 48, 40, 32, 24, 16, 8, 0, 58, 50, 42, 34, 26, 18, 10, 2,
    60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6,
];
const F4899F: &[i32] = &[
    31, 0, 1, 2, 3, 4, -1, -1, 3, 4, 5, 6, 7, 8, -1, -1, 7, 8, 9, 10, 11, 12, -1, -1, 11, 12, 13,
    14, 15, 16, -1, -1, 15, 16, 17, 18, 19, 20, -1, -1, 19, 20, 21, 22, 23, 24, -1, -1, 23, 24,
    25, 26, 27, 28, -1, -1, 27, 28, 29, 30, 31, 30, -1, -1,
];
const F4900G: [[u8; 64]; 8] = [
    [14, 4, 3, 15, 2, 13, 5, 3, 13, 14, 6, 9, 11, 2, 0, 5, 4, 1, 10, 12, 15, 6, 9, 10, 1, 8, 12, 7, 8, 11, 7, 0,
     0, 15, 10, 5, 14, 4, 9, 10, 7, 8, 12, 3, 13, 1, 3, 6, 15, 12, 6, 11, 2, 9, 5, 0, 4, 2, 11, 14, 1, 7, 8, 13],
    [15, 0, 9, 5, 6, 10, 12, 9, 8, 7, 2, 12, 3, 13, 5, 2, 1, 14, 7, 8, 11, 4, 0, 3, 14, 11, 13, 6, 4, 1, 10, 15,
     3, 13, 12, 11, 15, 3, 6, 0, 4, 10, 1, 7, 8, 4, 11, 14, 13, 8, 0, 6, 2, 15, 9, 5, 7, 1, 10, 12, 14, 2, 5, 9],
    [10, 13, 1, 11, 6, 8, 11, 5, 9, 4, 12, 2, 15, 3, 2, 14, 0, 6, 13, 1, 3, 15, 4, 10, 14, 9, 7, 12, 5, 0, 8, 7,
     13, 1, 2, 4, 3, 6, 12, 11, 0, 13, 5, 14, 6, 8, 15, 2, 7, 10, 8, 15, 4, 9, 11, 5, 9, 0, 14, 3, 10, 7, 1, 12],
    [7, 10, 1, 15, 0, 12, 11, 5, 14, 9, 8, 3, 9, 7, 4, 8, 13, 6, 2, 1, 6, 11, 12, 2, 3, 0, 5, 14, 10, 13, 15, 4,
     13, 3, 4, 9, 6, 10, 1, 12, 11, 0, 2, 5, 0, 13, 14, 2, 8, 15, 7, 4, 15, 1, 10, 7, 5, 6, 12, 11, 3, 8, 9, 14],
    [2, 4, 8, 15, 7, 10, 13, 6, 4, 1, 3, 12, 11, 7, 14, 0, 12, 2, 5, 9, 10, 13, 0, 3, 1, 11, 15, 5, 6, 8, 9, 14,
     14, 11, 5, 6, 4, 1, 3, 10, 2, 12, 15, 0, 13, 2, 8, 5, 11, 8, 0, 15, 7, 14, 9, 4, 12, 7, 10, 9, 1, 13, 6, 3],
    [12, 9, 0, 7, 9, 2, 14, 1, 10, 15, 3, 4, 6, 12, 5, 11, 1, 14, 13, 0, 2, 8, 7, 13, 15, 5, 4, 10, 8, 3, 11, 6,
     10, 4, 6, 11, 7, 9, 0, 6, 4, 2, 13, 1, 9, 15, 3, 8, 15, 3, 1, 14, 12, 5, 11, 0, 2, 12, 14, 7, 5, 10, 8, 13],
    [4, 1, 3, 10, 15, 12, 5, 0, 2, 11, 9, 6, 8, 7, 6, 9, 11, 4, 12, 15, 0, 3, 10, 5, 14, 13, 7, 8, 13, 14, 1, 2,
     13, 6, 14, 9, 4, 1, 2, 14, 11, 13, 5, 0, 1, 10, 8, 3, 0, 11, 3, 5, 9, 4, 15, 2, 7, 8, 12, 15, 10, 7, 6, 12],
    [13, 7, 10, 0, 6, 9, 5, 15, 8, 4, 3, 10, 11, 14, 12, 5, 2, 11, 9, 6, 15, 12, 0, 3, 4, 1, 14, 13, 1, 2, 7, 8,
     1, 2, 12, 15, 10, 4, 0, 3, 13, 14, 6, 9, 7, 8, 9, 6, 15, 1, 5, 12, 3, 10, 14, 5, 8, 7, 11, 0, 4, 13, 2, 11],
];
const F4901H: &[i32] = &[
    15, 6, 19, 20, 28, 11, 27, 16, 0, 14, 22, 25, 4, 17, 30, 9, 1, 7, 23, 13, 31, 26, 2, 8, 18,
    12, 29, 5, 21, 10, 3, 24,
];
const F4902I: &[i32] = &[
    39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
    36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26,
    33, 1, 41, 9, 49, 17, 57, 25, 32, 0, 40, 8, 48, 16, 56, 24,
];
const J: &[i32] = &[
    56, 48, 40, 32, 24, 16, 8, 0, 57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2,
    59, 51, 43, 35, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 60, 52, 44, 36,
    28, 20, 12, 4, 27, 19, 11, 3,
];
const KK: &[i32] = &[
    13, 16, 10, 23, 0, 4, -1, -1, 2, 27, 14, 5, 20, 9, -1, -1, 22, 18, 11, 3, 25, 7, -1, -1, 15,
    6, 26, 19, 12, 1, -1, -1, 40, 51, 30, 36, 46, 54, -1, -1, 29, 39, 50, 44, 32, 47, -1, -1, 43,
    48, 38, 55, 33, 52, -1, -1, 45, 41, 49, 35, 28, 31, -1, -1,
];
const L: &[usize] = &[1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const M: [u64; 3] = [0, 1_048_577, 3_145_731];

/// `a1(key, jArr, 0)`：子密钥编排（加密方向，i2=0 不反转子密钥序）。
fn kw_key_schedule(key: u64, jarr: &mut [u64; 16]) {
    let mut v = pick_bits(J, key);
    for (i, slot) in jarr.iter_mut().enumerate() {
        let lshift = L[i];
        let mask = M[lshift];
        v = ((v & !mask) >> lshift) | ((mask & v) << (28 - lshift));
        *slot = pick_bits(KK, v);
    }
}

/// `a2(jArr, j2)`：单块 DES 加密。
fn kw_des_block(jarr: &[u64; 16], j2: u64) -> u64 {
    let mut p = pick_bits(F4898E, j2);
    let mut s0 = p & 0xFFFF_FFFF;
    let mut s1 = (p >> 32) & 0xFFFF_FFFF;
    let mut t = [0u64; 8];
    for subkey in jarr.iter() {
        let mut r = s1;
        r = pick_bits(F4899F, r);
        r ^= *subkey;
        for (k, slot) in t.iter_mut().enumerate() {
            *slot = (r >> (k * 8)) & 0xFF;
        }
        let mut u = 0u64;
        let mut w = 7i64;
        while w >= 0 {
            u <<= 4;
            u |= u64::from(F4900G[w as usize][t[w as usize] as usize]);
            w -= 1;
        }
        r = pick_bits(F4901H, u);
        let q = s0;
        s0 = s1;
        s1 = q ^ r;
    }
    // 原实现的收尾交换（s0↔s1 后拼回 64 位），保持逐行对应
    #[allow(clippy::manual_swap)]
    {
        let v = s0;
        s0 = s1;
        s1 = v;
    }
    p = (s0 & 0xFFFF_FFFF) | ((s1 << 32) & 0xFFFF_FFFF_0000_0000);
    pick_bits(F4902I, p)
}

/// `encrypt2` 移植：ECB 逐块加密，尾部不足 8 字节零填充（含整块时仍补一个全零块，与原实现一致）。
fn kw_des_encrypt(data: &[u8], key_bytes: &[u8]) -> Vec<u8> {
    let mut key = 0u64;
    for (i, b) in key_bytes.iter().take(8).enumerate() {
        key |= u64::from(*b) << (i * 8);
    }
    let n_blocks = data.len() / 8;
    let mut jarr = [0u64; 16];
    kw_key_schedule(key, &mut jarr);
    let mut blocks = Vec::with_capacity(n_blocks + 1);
    for b in 0..n_blocks {
        let mut acc = 0u64;
        for (i8, byte) in data[b * 8..b * 8 + 8].iter().enumerate() {
            acc |= u64::from(*byte) << (i8 * 8);
        }
        blocks.push(kw_des_block(&jarr, acc));
    }
    let tail = data.len() % 8;
    let mut j3 = 0u64;
    for (i13, byte) in data[n_blocks * 8..].iter().take(tail).enumerate() {
        j3 |= u64::from(*byte) << (i13 * 8);
    }
    blocks.push(kw_des_block(&jarr, j3));
    let mut out = Vec::with_capacity(blocks.len() * 8);
    for b in blocks {
        for k in 0..8 {
            out.push((b >> (k * 8)) as u8);
        }
    }
    out
}

/// `kwExtractMobiUrl` 移植：从 mobi.s 响应文本中尽量提取可播放 URL。
fn extract_mobi_url(text: &str) -> String {
    let after = match text.find("url=") {
        Some(i) => &text[i + 4..],
        None => match text.find("\"url\"") {
            Some(i) => match text[i..].find(':') {
                Some(c) => &text[i + c + 1..],
                None => return String::new(),
            },
            None => match text.find("http") {
                Some(i) => &text[i..],
                None => return String::new(),
            },
        },
    };
    let after = after.trim().trim_start_matches(['"', '\'', '{']);
    let end = after
        .find(['?', '&', ' ', '"', '\'', ',', '}', ';'])
        .unwrap_or(after.len());
    let url = &after[..end];
    if url.starts_with("http") {
        url.to_string()
    } else {
        String::new()
    }
}

/// `kwFormatTime` 移植：秒 → `mm:ss.xx`（LRC 时间标签体）。
fn kw_format_time(time: f64) -> String {
    let m = (time / 60.0).floor() as u32;
    let sec = time % 60.0;
    let ss = format!("{sec:.2}");
    let ss = if sec < 10.0 {
        format!("0{ss}")
    } else {
        ss
    };
    format!("{m:02}:{ss}")
}

/// `songFromKWSearch` 移植：老接口 abslist 项（字段全大写）。
fn song_from_kw_search(item: &Value) -> Option<Track> {
    let id = str_val(item.get("DC_TARGETID"))?;
    let name = str_val(item.get("NAME")).unwrap_or_default();
    let singer = str_val(item.get("ARTIST")).unwrap_or_default();
    let album = str_val(item.get("ALBUM")).unwrap_or_default();
    let duration = str_val(item.get("DURATION"))
        .and_then(|d| d.parse::<f64>().ok())
        .unwrap_or(0.0);
    // 封面：web_albumpic_short 形如 "120/s3s94/93/xxx.jpg"，替换为 320 尺寸
    let pic_url = str_val(item.get("web_albumpic_short"))
        .map(|p| format!("https://img1.kuwo.cn/star/albumcover/{}", p.replacen("120/", "320/", 1)))
        .unwrap_or_default();
    let music_id = str_val(item.get("MUSICRID"))
        .filter(|m| m.starts_with("MUSIC_"))
        .map(|m| m[6..].to_string());

    Some(Track {
        id,
        platform: SourceId::Kw,
        title: name,
        singer,
        album,
        pic_url,
        duration,
        music_id,
    })
}

// ---------- 发现类映射（对应移动端 playlistFromKW / songFromKW / chartFromKW / artistFromKW / albumFromKW） ----------

/// 歌单项（`getTagPlayList` / `rcm/index/playlist` / `searchPlayListBykeyWord` 共用）。
fn playlist_from_kw(item: &Value) -> Option<Playlist> {
    let id = id_str(item.get("id"))?;
    let name = str_val(item.get("name")).unwrap_or_default();
    let pic_url = str_val(item.get("img")).unwrap_or_default();
    let play_count = str_val(item.get("listencnt")).unwrap_or_else(|| "0".to_string());
    Some(Playlist {
        id,
        platform: SourceId::Kw,
        name,
        pic_url,
        play_count,
        description: None,
        tracks: None,
    })
}

/// 榜单歌曲（`bang/musicList`、`playListInfo` 的 musicList 项，字段与老搜索接口不同）。
/// `duration` 已是秒，原样使用；`musicrid` 形如 `MUSIC_xxx` 时去前缀另存 `musicId`。
fn song_from_kw(item: &Value) -> Option<Track> {
    let id = id_str(item.get("rid"))?;
    let name = str_val(item.get("name")).unwrap_or_default();
    let singer = str_val(item.get("artist")).unwrap_or_default();
    let album = str_val(item.get("album")).unwrap_or_default();
    let pic_url = str_val(item.get("pic")).unwrap_or_default();
    let duration = num_val(item.get("duration")).unwrap_or(0.0);
    let music_id = str_val(item.get("musicrid"))
        .filter(|m| m.starts_with("MUSIC_"))
        .map(|m| m[6..].to_string());

    Some(Track {
        id,
        platform: SourceId::Kw,
        title: name,
        singer,
        album,
        pic_url,
        duration,
        music_id,
    })
}

/// 榜单项（`bang/bang/bangMenu` 的 `data[].list[]`）。
fn chart_from_kw(item: &Value) -> Option<Chart> {
    let id = id_str(item.get("sourceid"))?;
    let name = str_val(item.get("name")).unwrap_or_default();
    let pic_url = str_val(item.get("pic")).unwrap_or_default();
    // 移动端 intro 缺失时给空串；统一模型里空描述不序列化，这里归一化成 None
    let description = str_val(item.get("intro")).filter(|s| !s.is_empty());
    Some(Chart {
        id,
        platform: SourceId::Kw,
        name,
        pic_url,
        description,
    })
}

/// 歌手项（`searchArtistBykeyWord` 的 `data.list[]`）。
fn artist_from_kw(item: &Value) -> Option<Artist> {
    let id = id_str(item.get("id"))?;
    let name = str_val(item.get("name")).unwrap_or_default();
    let pic_url = str_val(item.get("pic")).unwrap_or_default();
    Some(Artist {
        id,
        platform: SourceId::Kw,
        name,
        pic_url,
    })
}

/// 专辑项（`searchAlbumBykeyWord` 的 `data.albumList[]`，注意不是 data.list）。
fn album_from_kw(item: &Value) -> Option<Album> {
    let id = id_str(item.get("albumid"))?;
    let name = str_val(item.get("album")).unwrap_or_default();
    let artist = str_val(item.get("artist")).unwrap_or_default();
    let pic_url = str_val(item.get("pic")).unwrap_or_default();
    Some(Album {
        id,
        platform: SourceId::Kw,
        name,
        artist,
        pic_url,
    })
}

/// MV 项（`music/mvList` 的 `data.mvlist[]`，music-api.ts:947-957）。
/// id 可能是 number 也可能是 string，走 `id_str` 兼容（移动端 `idValue.toString()`）；
/// 取不到 id 的项直接丢弃。
fn video_from_kw(item: &Value) -> Option<Video> {
    let id = id_str(item.get("id"))?;
    Some(Video {
        id,
        platform: SourceId::Kw,
        name: str_val(item.get("name")).unwrap_or_default(),
        pic_url: str_val(item.get("pic")).unwrap_or_default(),
        singer: str_val(item.get("artist")).unwrap_or_default(),
    })
}

/// 移动端 `assertKwOk` 移植：`code != 200` 或 `success == false` 均视为业务失败。
/// 由酷我 `Hm_Iuvt` cookie 计算 `Secret` 请求头。
/// 逐行移植自 `qt-uniappx/services/http.ts:328-378`（createKuwoSecret）；
/// 入参是**单个** cookie（形如 `Hm_Iuvt_xxxx=abcdef`）。
/// 移动端 `http.ts:297-301`（kwParseInt）：取前导数字段后 parseFloat。
fn kw_parse_int(s: &str) -> f64 {
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return 0.0;
    }
    digits.parse::<f64>().unwrap_or(0.0)
}

/// 移动端 `http.ts:303-305`（kwToNumber）。
fn kw_to_number(s: &str) -> f64 {
    s.parse::<f64>().unwrap_or(0.0)
}

/// 移动端 `http.ts:307-326`（kwNumberToString）：非负整数且 < 1e21 走普通十进制，
/// 否则按 JS `Number.prototype.toString` 的科学计数法形式（小写 e + 带符号指数）。
///
/// 注：源码里 `s.indexOf("E")` 找的是大写 E，而 JS 的 toString 输出小写 e，
/// 因此 mantissa 的 ".0" 清理分支实际上是死代码，这里按等价结果实现。
fn kw_number_to_string(x: f64) -> String {
    if x >= 0.0 && x == x.floor() && x < 1e21 {
        return format!("{x}");
    }
    let s = format!("{x:e}");
    match s.find('e') {
        Some(pos) => {
            let (mantissa, exp) = s.split_at(pos);
            let exp_body = &exp[1..];
            if exp_body.starts_with('-') {
                format!("{mantissa}e{exp_body}")
            } else {
                format!("{mantissa}e+{exp_body}")
            }
        }
        None => s,
    }
}

fn create_kuwo_secret(cookie: &str) -> String {
    // 移动端每次现取随机 seed（round(1e9*random()) % 1e8）
    create_kuwo_secret_with_seed(cookie, (fastrand::u64(..) % 100_000_000) as u128)
}

/// seed 可注入，便于用固定向量核对与移动端算法的一致性（见文件末尾测试）。
fn create_kuwo_secret_with_seed(cookie: &str, seed: u128) -> String {
    let first = cookie.split(';').next().unwrap_or("");
    let Some(sep) = first.find('=') else {
        return String::new();
    };
    if sep == 0 {
        return String::new();
    }
    let key = &first[..sep];
    let value = &first[sep + 1..];
    if key.is_empty() || value.is_empty() {
        return String::new();
    }

    // codeText：cookie 名各字符的码点拼接
    let code_text: String = key.chars().map(|c| (c as u32).to_string()).collect();

    // factor：在 position 的 1~5 倍下标处各取一位数字拼成 5 位数
    let position = code_text.len() / 5;
    let indices = [1usize, 2, 3, 4, 5].map(|m| position * m);
    let factor_text: String = indices
        .iter()
        .filter_map(|&i| code_text.chars().nth(i))
        .collect();
    let Ok(factor) = factor_text.parse::<u128>() else {
        return String::new();
    };
    if factor < 2 {
        return String::new();
    }

    // 4) 状态参数：全部按 JS 的 Number 语义用 f64
    let half_length = (key.chars().count().div_ceil(2)) as f64; // ceil(key.length / 2)
    let max = ((1u64 << 31) - 1) as f64; // 2^31 - 1

    // 折叠到不超过 10 位。
    // ⚠️ 移动端这里走的是**浮点**链路：kwParseInt 对超长数字串用 parseFloat（精度丢失），
    // kwNumberToString 对 >= 1e21 的数给出科学计数法字符串。这一步的「不精确」是算法
    // 本身的一部分，必须忠实复现——用精确大数反而算不出服务端认可的签名。
    let mut seed_text = format!("{code_text}{seed}");
    let mut loop_count = 0;
    while seed_text.len() > 10 {
        let head = kw_parse_int(&seed_text[..10]);
        let tail = kw_parse_int(&seed_text[10..]);
        seed_text = kw_number_to_string(head + tail);
        loop_count += 1;
        if loop_count > 50 {
            break;
        }
    }

    // 5) 逐字符混淆：valueCode ^ floor(state / max * 255)
    let mut state = (factor as f64 * kw_to_number(&seed_text) + half_length) % max;
    let mut secret = String::with_capacity(value.len() * 2);
    for ch in value.chars() {
        let mixed = (ch as u32) ^ (((state / max) * 255.0).floor() as u32);
        secret.push_str(&format!("{mixed:02x}"));
        state = (factor as f64 * state + half_length) % max;
    }

    // 尾缀 8 位 hex 的 seed（JS: Math.trunc(seed).toString(16) 左侧补 0）
    format!("{secret}{seed:08x}")
}

fn assert_kw_ok(json: &Value) -> ProviderResult<()> {
    let code_failed = match json.get("code") {
        Some(Value::Number(n)) => n.as_i64() != Some(200),
        Some(Value::String(s)) => s != "200",
        _ => false,
    };
    let success_failed = json.get("success").and_then(Value::as_bool) == Some(false);
    if code_failed || success_failed {
        let message = str_val(json.get("message"))
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| "酷我接口请求失败".to_string());
        return Err(ProviderError::Decode { message });
    }
    Ok(())
}

/// id 类字段可能是 number 也可能是 string，统一取字符串（优先整数形态）。
fn id_str(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(
            n.as_i64()
                .map(|i| i.to_string())
                .unwrap_or_else(|| n.to_string()),
        ),
        _ => None,
    }
}

/// 数值字段（duration 等）可能是 number 也可能是 string。
fn num_val(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

/// 毫秒时间戳（移动端 `Date.now()`，用于 `rcm/index/playlist` 的 `_` 与搜索的 `reqId`）。
fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn str_val(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

#[async_trait]
impl MusicProvider for KwProvider {
    fn id(&self) -> SourceId {
        SourceId::Kw
    }

    fn name(&self) -> &'static str {
        "kw"
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
            lyric_translation: false,
            play_url: true,
            cover: true,
        }
    }

    /// 对应移动端 `playlistCategories` 的 kw 分支：`playlist/getTagList`
    /// → `data[].data[]`（两层，酷我不带分组，group 恒为 None）。
    async fn playlist_categories(&self) -> ProviderResult<Vec<PlaylistCategory>> {
        let json = self
            .get_json_kw(TAG_LIST_URL, &[("httpsStatus", "1")])
            .await?;
        let groups =
            json.get("data")
                .and_then(Value::as_array)
                .ok_or_else(|| ProviderError::Decode {
                    message: "getTagList: data 缺失".into(),
                })?;
        let mut categories = Vec::new();
        for group in groups {
            let Some(items) = group.get("data").and_then(Value::as_array) else {
                continue;
            };
            for item in items {
                let Some(id) = id_str(item.get("id")) else {
                    continue;
                };
                let name = str_val(item.get("name")).unwrap_or_default();
                if name.is_empty() {
                    continue;
                }
                categories.push(PlaylistCategory {
                    id,
                    name,
                    group: None,
                });
            }
        }
        if categories.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(categories)
    }

    /// 对应移动端 `recommendations` 的 kw 分支：
    /// 有分类走 `classify/playlist/getTagPlayList`（`data.data[]`），
    /// 无分类走 `rcm/index/playlist`（`data.list[]`，带 `_` 时间戳破缓存）。
    async fn recommendations(
        &self,
        category: Option<&str>,
        page: u32,
    ) -> ProviderResult<Vec<Playlist>> {
        let pn = page.max(1).to_string();
        let rn = RN.to_string();
        let (json, key) = match category.filter(|c| !c.is_empty()) {
            Some(cat) => (
                self.get_json_kw(
                    TAG_PLAYLIST_URL,
                    &[
                        ("id", cat),
                        ("rn", rn.as_str()),
                        ("pn", pn.as_str()),
                        ("httpsStatus", "1"),
                    ],
                )
                .await?,
                "data",
            ),
            None => {
                let ts = now_millis().to_string();
                (
                    self.get_json_kw(
                        RCM_PLAYLIST_URL,
                        &[
                            ("rn", rn.as_str()),
                            ("pn", pn.as_str()),
                            ("id", "rec"),
                            ("httpsStatus", "1"),
                            ("_", ts.as_str()),
                        ],
                    )
                    .await?,
                    "list",
                )
            }
        };
        let list = json
            .get("data")
            .and_then(|d| d.get(key))
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: format!("recommendations: data.{key} 缺失"),
            })?;
        let playlists: Vec<Playlist> = list.iter().filter_map(playlist_from_kw).collect();
        if playlists.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(playlists)
    }

    /// 对应移动端 `latest` 的 kw 分支：酷我没有独立新歌接口，用「新歌榜 bangId=17」
    /// 分页取足量（`page = ceil(offset / rn) + 1`，最多 20 页）。
    async fn latest(&self, limit: u32, offset: u32) -> ProviderResult<Vec<Track>> {
        let mut page = if offset > 0 {
            (offset.saturating_add(RN - 1)) / RN + 1
        } else {
            1
        };
        let mut needed = limit;
        let mut songs: Vec<Track> = Vec::new();
        let mut first_error: Option<ProviderError> = None;
        let mut safe_pages = 0;
        while needed > 0 && safe_pages < MAX_PAGES {
            safe_pages += 1;
            let list = match self.bang_music_page(NEW_SONG_BANG_ID, page).await {
                Ok(list) => list,
                Err(e) => {
                    if songs.is_empty() {
                        first_error = Some(e);
                    }
                    break;
                }
            };
            if list.is_empty() {
                break;
            }
            for item in list.iter().take(needed as usize) {
                if let Some(track) = song_from_kw(item) {
                    songs.push(track);
                    needed -= 1;
                }
            }
            page += 1;
        }
        if songs.is_empty() {
            return Err(first_error.unwrap_or(ProviderError::Empty));
        }
        Ok(songs)
    }

    /// 对应移动端 `charts` 的 kw 分支：`bang/bang/bangMenu` → `data[].list[]`。
    async fn charts(&self) -> ProviderResult<Vec<Chart>> {
        let json = self
            .get_json_kw(BANG_MENU_URL, &[("httpsStatus", "1")])
            .await?;
        let groups =
            json.get("data")
                .and_then(Value::as_array)
                .ok_or_else(|| ProviderError::Decode {
                    message: "bangMenu: data 缺失".into(),
                })?;
        let mut charts = Vec::new();
        for group in groups {
            let Some(list) = group.get("list").and_then(Value::as_array) else {
                continue;
            };
            for item in list {
                if let Some(chart) = chart_from_kw(item) {
                    charts.push(chart);
                }
            }
        }
        if charts.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(charts)
    }

    /// 对应移动端 `chartDetail` 的 kw 分支：`bang/bang/musicList?bangId={chart.id}`，
    /// 从 `page` 起连续翻页（单页不足 30 条即停，最多 20 页）。
    async fn chart_detail(
        &self,
        chart: &Chart,
        page: u32,
        size: u32,
    ) -> ProviderResult<Vec<Track>> {
        let _ = size; // 酷我榜单分页条数固定 30，size 不参与请求
        let mut page = page.max(1);
        let mut songs: Vec<Track> = Vec::new();
        let mut first_error: Option<ProviderError> = None;
        let mut safe_pages = 0;
        while safe_pages < MAX_PAGES {
            safe_pages += 1;
            let list = match self.bang_music_page(&chart.id, page).await {
                Ok(list) => list,
                Err(e) => {
                    if songs.is_empty() {
                        first_error = Some(e);
                    }
                    break;
                }
            };
            let count = list.len();
            for item in list.iter() {
                if let Some(track) = song_from_kw(item) {
                    songs.push(track);
                }
            }
            if count < RN as usize {
                break;
            }
            page += 1;
        }
        if songs.is_empty() {
            return Err(first_error.unwrap_or(ProviderError::Empty));
        }
        Ok(songs)
    }

    /// 对应移动端 `playlistDetail` 的 kw 分支：`playlist/playListInfo`，
    /// 首页拿 name/img/listencnt/total，再按 `maxPages = ceil(total / rn)` 补齐（单页失败 break）。
    async fn playlist(&self, id: &str, page: u32, size: u32) -> ProviderResult<Playlist> {
        let _ = size; // 酷我歌单详情分页条数固定 30，size 不参与请求
        let mut page = page.max(1);
        let data = self.playlist_info_page(id, page).await?;
        let name = str_val(data.get("name")).unwrap_or_default();
        let pic_url = str_val(data.get("img")).unwrap_or_default();
        let play_count = str_val(data.get("listencnt")).unwrap_or_else(|| "0".to_string());
        let total = num_val(data.get("total")).unwrap_or(0.0);
        let mut songs: Vec<Track> = Vec::new();
        if let Some(list) = data.get("musicList").and_then(Value::as_array) {
            for item in list {
                if let Some(track) = song_from_kw(item) {
                    songs.push(track);
                }
            }
        }
        let max_pages = if total > 0.0 {
            (total / f64::from(RN)).ceil() as u32
        } else {
            MAX_PAGES
        };
        let mut safe_pages = 0;
        while page < max_pages && safe_pages < MAX_PAGES {
            safe_pages += 1;
            page += 1;
            let Ok(next) = self.playlist_info_page(id, page).await else {
                break;
            };
            let list = next.get("musicList").and_then(Value::as_array);
            match list {
                Some(list) if !list.is_empty() => {
                    for item in list {
                        if let Some(track) = song_from_kw(item) {
                            songs.push(track);
                        }
                    }
                }
                _ => break,
            }
            if total > 0.0 && songs.len() as f64 >= total {
                break;
            }
        }
        Ok(Playlist {
            id: id.to_string(),
            platform: SourceId::Kw,
            name,
            pic_url,
            play_count,
            description: None,
            tracks: Some(songs),
        })
    }

    /// 对应移动端 `hotWords` 的 kw 分支：`search/searchKey`。
    ///
    /// 实测响应里热词就是 `data` 本身（**字符串数组**），不是 `data.list[].keyword`：
    /// `{"code":200,"data":["山风山风等等我","你往南走",...]}`
    async fn hot_words(&self) -> ProviderResult<Vec<String>> {
        let json = self.get_json_kw(SEARCH_KEY_URL, &[]).await?;
        let list = json
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "searchKey: data 缺失或不是数组".into(),
            })?;
        let words: Vec<String> = list
            .iter()
            .filter_map(|item| str_val(Some(item)))
            .filter(|w| !w.is_empty())
            .collect();
        if words.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(words)
    }

    /// 对应移动端 `videos()` 的 kw 分支（music-api.ts:937-959）：
    /// `GET api/www/music/mvList?pn=&rn=&pid=236682871`（走 `get_json_kw` 自带
    /// 酷我 Referer + FireFox UA + no-cache），响应 `data.mvlist[]`
    /// → id / name / pic / artist。
    async fn videos(&self, page: u32, size: u32) -> ProviderResult<Vec<Video>> {
        let page_no = page.max(1);
        let page_size = if size == 0 { 20 } else { size };
        let pn = page_no.to_string();
        let rn = page_size.to_string();
        let json = self
            .get_json_kw(
                MV_LIST_URL,
                &[("pn", pn.as_str()), ("rn", rn.as_str()), ("pid", "236682871")],
            )
            .await?;
        let list = json
            .get("data")
            .and_then(|d| d.get("mvlist"))
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "mvList: data.mvlist 缺失".into(),
            })?;
        let videos: Vec<Video> = list.iter().filter_map(video_from_kw).collect();
        if videos.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(videos)
    }

    /// 对应移动端 `searchPlaylists` 的 kw 分支：`searchPlayListBykeyWord` → `data.list[]`。
    async fn search_playlists(
        &self,
        kw: &str,
        page: u32,
        size: u32,
    ) -> ProviderResult<Vec<Playlist>> {
        let pn = page.max(1).to_string();
        let rn = size.max(1).to_string();
        let ts = now_millis();
        let req_id = format!("{ts}pl");
        let json = self
            .get_json_kw(
                SEARCH_PLAYLIST_URL,
                &[
                    ("key", kw),
                    ("pn", pn.as_str()),
                    ("rn", rn.as_str()),
                    ("httpsStatus", "1"),
                    ("reqId", req_id.as_str()),
                ],
            )
            .await?;
        let list = json
            .get("data")
            .and_then(|d| d.get("list"))
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "searchPlayListBykeyWord: data.list 缺失".into(),
            })?;
        let playlists: Vec<Playlist> = list.iter().filter_map(playlist_from_kw).collect();
        if playlists.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(playlists)
    }

    /// 对应移动端 `searchArtists` 的 kw 分支：`searchArtistBykeyWord` → `data.list[]`。
    async fn search_artists(&self, kw: &str, page: u32, size: u32) -> ProviderResult<Vec<Artist>> {
        let pn = page.max(1).to_string();
        let rn = size.max(1).to_string();
        let ts = now_millis();
        let req_id = format!("{ts}at");
        let json = self
            .get_json_kw(
                SEARCH_ARTIST_URL,
                &[
                    ("key", kw),
                    ("pn", pn.as_str()),
                    ("rn", rn.as_str()),
                    ("httpsStatus", "1"),
                    ("reqId", req_id.as_str()),
                ],
            )
            .await?;
        let list = json
            .get("data")
            .and_then(|d| d.get("list"))
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "searchArtistBykeyWord: data.list 缺失".into(),
            })?;
        let artists: Vec<Artist> = list.iter().filter_map(artist_from_kw).collect();
        if artists.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(artists)
    }

    /// 对应移动端 `searchAlbums` 的 kw 分支：`searchAlbumBykeyWord` → `data.albumList[]`。
    async fn search_albums(&self, kw: &str, page: u32, size: u32) -> ProviderResult<Vec<Album>> {
        let pn = page.max(1).to_string();
        let rn = size.max(1).to_string();
        let ts = now_millis();
        let req_id = format!("{ts}al");
        let json = self
            .get_json_kw(
                SEARCH_ALBUM_URL,
                &[
                    ("key", kw),
                    ("pn", pn.as_str()),
                    ("rn", rn.as_str()),
                    ("httpsStatus", "1"),
                    ("reqId", req_id.as_str()),
                ],
            )
            .await?;
        let list = json
            .get("data")
            .and_then(|d| d.get("albumList"))
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "searchAlbumBykeyWord: data.albumList 缺失".into(),
            })?;
        let albums: Vec<Album> = list.iter().filter_map(album_from_kw).collect();
        if albums.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(albums)
    }

    /// 对应移动端 `artistSongs` 的 kw 分支：酷我没有歌手 id 歌曲接口，
    /// 移动端即「按歌手名搜歌」，这里直接复用免鉴权搜索。
    async fn artist_songs(&self, name: &str, page: u32, size: u32) -> ProviderResult<Vec<Track>> {
        self.search_tracks(name, page, size).await
    }

    async fn search_tracks(
        &self,
        kw: &str,
        page: u32,
        size: u32,
    ) -> ProviderResult<Vec<Track>> {
        let pn = page.saturating_sub(1);
        let url = format!(
            "{SEARCH_URL}?all={}&pn={pn}&rn={size}&vipver=1&client=kt&ft=music\
&cluster=0&strategy=2012&encoding=utf8&rformat=json&mobi=1&issubtitle=1&show_copyright_off=1",
            urlencoded(kw),
        );
        let json = self.get_json(&url).await?;
        let list = json
            .get("abslist")
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                message: "abslist 缺失".into(),
            })?;
        let tracks: Vec<Track> = list.iter().filter_map(song_from_kw_search).collect();
        if tracks.is_empty() {
            return Err(ProviderError::Empty);
        }
        Ok(tracks)
    }

    async fn play_url(&self, track: &Track, quality: Quality) -> ProviderResult<String> {
        self.fetch_mobi_url(&track.id, quality).await
    }

    async fn lyric(&self, track: &Track) -> ProviderResult<Lyric> {
        // openapi 优先用新 DC id（musicrid 数字部分）；占位值 "nohash"/空回退到播放用的 rid
        let raw = track
            .music_id
            .as_deref()
            .filter(|m| !m.is_empty() && !m.eq_ignore_ascii_case("nohash"))
            .unwrap_or(&track.id);
        let music_id = raw.replace("MUSIC_", "");
        if music_id.is_empty() {
            return Ok(Lyric {
                lrc: String::new(),
                translation: String::new(),
            });
        }
        let url = format!("{LYRIC_URL}?musicId={music_id}&httpsStatus=1");
        let json = self.get_json(&url).await?;
        let lines = json
            .get("data")
            .and_then(|d| d.get("lrclist"))
            .and_then(Value::as_array);
        let mut lrc = String::new();
        if let Some(lines) = lines {
            for line in lines {
                // 酷我的 time 字段不固定：可能是数字，也可能是字符串（"2.05"）。
                // 只认 as_f64 的话字符串那一路全被跳过，歌词就永远是空的。
                let Some(time) = line.get("time").and_then(|t| match t {
                    Value::Number(n) => n.as_f64(),
                    Value::String(s) => s.trim().parse::<f64>().ok(),
                    _ => None,
                }) else {
                    continue;
                };
                let Some(text) = line.get("lineLyric").and_then(Value::as_str) else {
                    continue;
                };
                lrc.push_str(&format!("[{}]{text}\n", kw_format_time(time)));
            }
        }
        Ok(Lyric {
            lrc,
            translation: String::new(),
        })
    }

    /// `videoUrl("kw")` 移植：api/v1/www/music/playUrl?type=mv
    /// 该接口与发现类接口同属酷我新 API 族，必须带 `Cookie + Secret` 两个鉴权头
    /// （否则上游固定返回 `{"success":false,"message":"The request is illegal!"}`，
    /// 表现为 MV 播放解析失败 `noPlayableUrl`），因此走 `get_json_kw` 而非 `get_json`。
    async fn video_url(&self, id: &str, _quality: &str) -> ProviderResult<String> {
        let url = format!(
            "https://www.kuwo.cn/api/v1/www/music/playUrl?type=mv&httpsStatus=1&mid={}",
            urlencoded(id)
        );
        let json = self
            .get_json_kw(&url, &[])
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

/// 最小 percent-encode（组件编码：非 unreserved 全编码，与 encodeURIComponent 语义一致）。
fn urlencoded(s: &str) -> String {
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

    /// 酷我 Secret 算法与移动端 `http.ts:328-378` 的逐行一致性：
    /// 固定 seed=12345678 下的期望值由同算法在 node 中复现生成（tools/probe-kw.mjs）。
    #[test]
    fn create_kuwo_secret_matches_mobile_vector() {
        let cookie =
            "Hm_Iuvt_cdb524f42f23cer9b268564v7y735ewrq2324=arhCTtFhZ58AYQNezQHh6PGrd6z3bNxF";
        assert_eq!(
            create_kuwo_secret_with_seed(cookie, 12_345_678),
            "4222e3e145532e43841098d012ebff48729eb9bf01aadb756db601aae4c81dca00bc614e"
        );
    }

    /// 没有 `=` / 空名 / 空值时按移动端约定返回空串（不 panic）。
    #[test]
    fn create_kuwo_secret_rejects_malformed_cookie() {
        assert_eq!(create_kuwo_secret_with_seed("no-equal-sign", 1), "");
        assert_eq!(create_kuwo_secret_with_seed("=", 1), "");
        assert_eq!(create_kuwo_secret_with_seed("name=", 1), "");
    }

    /// 测试向量：把 UTS 原算法（BigInt 版 kw-encode.uts）放在 node 中运行生成。
    /// 保证 Rust DES 实现与移动端逐字节一致。
    #[test]
    fn des_output_matches_uts_reference() {
        assert_eq!(
            des_ecb_zero_pad_base64(
                "user=0&android_id=0&prod=kwplayer_ar_8.5.5.0&corp=kuwo&newver=3&vipver=8.5.5.0&source=kwplayer_ar_5.1.0.0_B_jiakong_vh.apk&p2p=1&notrace=0&type=convert_url2&br=320kmp3&format=mp3&sig=0&rid=193290598".as_bytes()
            ),
            "QTTCEVWADWjGHNKyqOt6peSJECe9IlwYOThEXM42tOPUM09JJgqs4koq6HW%2BDmLo6NvDv%2ByKU0JVRFu8k%2BuReMgqO9c3DBQehRhuLv8hLwiRAcRvUqhAdgBiZRX9VKg7t7Sf1ifeUltlOx%2Btpug%2Fb6UNx5Q0KQ0sYeyB%2B7hVwytiQwGaqszrPdjkO%2F4%2BU6FpNIqiGvqcuusRx4EaZUeU2MNds1XE1IGt9%2BVV2x3j7aqkDMAmDyNsOwoGDzIypD3eSuBXP5l%2BdmI%3D"
        );
        assert_eq!(
            des_ecb_zero_pad_base64("hello des".as_bytes()),
            des_ecb_zero_pad_base64("hello des".as_bytes())
        );
        // 8 字节整块 + 非 8 倍数尾部（零填充路径都要走通）
        // 8 字节 → base64 13 字符（含 1 个 '='）→ '=' 替换为 %3D 后长 14
        assert_eq!(des_ecb_zero_pad_base64(b"abc").len(), 14);
    }

    #[test]
    fn extract_mobi_url_variants() {
        // 与移动端一致：截断到第一个终止符（? & 空格 引号 逗号 花括号 分号）
        assert_eq!(
            extract_mobi_url("...url=http://example.com/a.mp3?k=v..."),
            "http://example.com/a.mp3"
        );
        assert_eq!(
            extract_mobi_url(r#"{"url":"http://example.com/a.mp3"}"#),
            "http://example.com/a.mp3"
        );
        assert_eq!(
            extract_mobi_url("garbage http://example.com/a.mp3 tail"),
            "http://example.com/a.mp3"
        );
        assert_eq!(extract_mobi_url("no url here"), "");
    }

    #[test]
    fn kw_format_time_matches_reference() {
        assert_eq!(kw_format_time(3.2), "00:03.20");
        assert_eq!(kw_format_time(83.456), "01:23.46");
        assert_eq!(kw_format_time(653.0), "10:53.00");
    }

    #[test]
    fn mobi_plain_matches_reference() {
        assert!(mobi_plain("1", Quality::Standard).contains("br=128kmp3&format=mp3"));
        assert!(mobi_plain("1", Quality::High).contains("br=320kmp3&format=mp3"));
        assert!(mobi_plain("1", Quality::Lossless).contains("format=flac|mp3|aac"));
        assert!(mobi_plain("42", Quality::Standard).ends_with("rid=42"));
    }

    #[test]
    fn video_from_kw_maps_fields_and_number_id() {
        let item: Value = serde_json::from_str(
            r#"{
                "id": 123456,
                "name": "海阔天空",
                "pic": "https://img1.kuwo.cn/mv.jpg",
                "artist": "Beyond"
            }"#,
        )
        .unwrap();
        let v = video_from_kw(&item).unwrap();
        // number 形态的 id 也要转字符串
        assert_eq!(v.id, "123456");
        assert_eq!(v.name, "海阔天空");
        assert_eq!(v.pic_url, "https://img1.kuwo.cn/mv.jpg");
        assert_eq!(v.singer, "Beyond");
        assert_eq!(v.platform, SourceId::Kw);
    }

    #[test]
    fn video_from_kw_accepts_string_id_and_rejects_missing() {
        let item: Value = serde_json::from_str(r#"{"id": "789", "name": "x"}"#).unwrap();
        assert_eq!(video_from_kw(&item).unwrap().id, "789");
        let empty: Value = serde_json::from_str(r#"{"name": "x"}"#).unwrap();
        assert!(video_from_kw(&empty).is_none());
    }
}
